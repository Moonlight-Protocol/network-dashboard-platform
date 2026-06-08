import { Application } from "@oak/oak";

import { buildApiRouter } from "@/http/v1/v1.routes.ts";
import { corsMiddleware } from "@/http/middleware/cors.ts";
import { getPort } from "@/config/env.ts";
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

/**
 * Bootstrap order:
 *   1. Fetch council-platform topology → populate linkage maps so the
 *      Soroban watcher knows which contractIds to subscribe to.
 *   2. Cold-start scan: walk trailing 24h on those contracts to seed the
 *      rolling counter window + activity-feed ring buffer.
 *   3. Start the forward poller (Soroban watcher). It also polls
 *      Soroban-wide for `contract_initialized` events from unknown
 *      contracts and feeds them to the contract-init-listener, which
 *      triggers an immediate topology refresh on each unknown — this
 *      replaces the hourly periodic re-sync.
 *   4. Start the scheduler (minute window sweep only).
 *   5. Start the HTTP server.
 *
 * Steps 1-2 are best-effort: a failure logs + continues so the service
 * still serves a (degraded) snapshot rather than refusing to boot. The
 * event-driven new-council path self-heals as soon as Soroban polling
 * succeeds.
 */
async function bootstrap() {
  const rootLog = createLogger();
  const log = rootLog.scope("bootstrap");
  log.info("bootstrap");

  const bus = new NetworkEventBus({ log: rootLog });
  const deps = { log: rootLog, bus };

  try {
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

    const port = getPort();
    log.debug("port", port);
    log.event(`network-dashboard-platform running on http://localhost:${port}`);

    const shutdown = () => {
      log.event("shutting down");
      stopSorobanWatcher({ log: rootLog });
      stopScheduler({ log: rootLog });
      Deno.exit(0);
    };
    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);

    await app.listen({ port });
  } catch (err) {
    log.error(err, "failed to start");
    stopSorobanWatcher({ log: rootLog });
    stopScheduler({ log: rootLog });
    Deno.exit(1);
  }
}

bootstrap();
