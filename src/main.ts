import { Application } from "@oak/oak";

import { buildApiRouter } from "@/http/v1/v1.routes.ts";
import { corsMiddleware } from "@/http/middleware/cors.ts";
import { PORT } from "@/config/env.ts";
import { createLogger } from "@/config/logger.ts";
import { NetworkEventBus } from "@/core/events/bus.ts";
import { networkState } from "@/core/state/store.ts";
import { fetchCouncilTopology } from "@/core/sync/council-fetch.ts";
import {
  coldStartScan,
  startSorobanWatcher,
  stopSorobanWatcher,
} from "@/core/sync/soroban-watcher.ts";
import { startScheduler, stopScheduler } from "@/core/sync/scheduler.ts";
import { refreshWasmRegistry } from "@/core/sync/wasm-registry.ts";

/**
 * Bootstrap order:
 *   1. Fetch the Channel Auth WASM hash registry from soroban-core's
 *      GitHub releases. The new-council listener short-circuits to a
 *      no-op until this returns a non-empty set, so we do it before the
 *      Soroban watcher starts.
 *   2. Fetch council-platform topology → populate linkage maps so the
 *      Soroban watcher knows which contractIds to subscribe to.
 *   3. Cold-start scan: walk trailing 24h on those contracts to seed the
 *      rolling counter window + activity-feed ring buffer.
 *   4. Start the forward poller (Soroban watcher).
 *   5. Start the scheduler (hourly re-sync + minute window sweep).
 *   6. Start the HTTP server.
 *
 * Steps 1–3 are best-effort: a failure logs + continues so the service
 * still serves a (degraded) snapshot rather than refusing to boot. The
 * hourly re-sync re-fetches both the WASM registry and the topology so
 * a boot-time outage self-heals.
 */
async function bootstrap() {
  const rootLog = createLogger();
  const log = rootLog.scope("bootstrap");
  log.info("bootstrap");

  const bus = new NetworkEventBus({ log: rootLog });
  const deps = { log: rootLog, bus };

  try {
    try {
      await refreshWasmRegistry({ log: rootLog });
    } catch (err) {
      log.error(
        err,
        "initial WASM registry fetch failed (continuing degraded)",
      );
    }

    try {
      const topology = await fetchCouncilTopology({ log: rootLog });
      networkState.replaceTopology(topology);
    } catch (err) {
      log.error(
        err,
        "initial council-platform fetch failed (continuing degraded)",
      );
    }

    try {
      await coldStartScan(deps);
    } catch (err) {
      log.error(err, "cold-start scan failed (continuing degraded)");
    }

    startSorobanWatcher(deps);
    startScheduler(deps);

    const app = new Application();
    app.use(corsMiddleware);
    const apiV1 = buildApiRouter(deps);
    app.use(apiV1.routes());
    app.use(apiV1.allowedMethods());

    log.debug("port", PORT);
    log.event(`network-dashboard-platform running on http://localhost:${PORT}`);

    const shutdown = () => {
      log.event("shutting down");
      stopSorobanWatcher({ log: rootLog });
      stopScheduler({ log: rootLog });
      Deno.exit(0);
    };
    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);

    await app.listen({ port: PORT });
  } catch (err) {
    log.error(err, "failed to start");
    stopSorobanWatcher({ log: rootLog });
    stopScheduler({ log: rootLog });
    Deno.exit(1);
  }
}

bootstrap();
