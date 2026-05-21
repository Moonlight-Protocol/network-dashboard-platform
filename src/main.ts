import { Application } from "@oak/oak";

import apiV1 from "@/http/v1/v1.routes.ts";
import { corsMiddleware } from "@/http/middleware/cors.ts";
import { PORT } from "@/config/env.ts";
import { LOG } from "@/config/logger.ts";
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
  try {
    try {
      await refreshWasmRegistry();
    } catch (err) {
      LOG.error("Initial WASM registry fetch failed (continuing degraded)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const topology = await fetchCouncilTopology();
      networkState.replaceTopology(topology);
    } catch (err) {
      LOG.error("Initial council-platform fetch failed (continuing degraded)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await coldStartScan();
    } catch (err) {
      LOG.error("Cold-start scan failed (continuing degraded)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    startSorobanWatcher();
    startScheduler();

    const app = new Application();
    app.use(corsMiddleware);
    app.use(apiV1.routes());
    app.use(apiV1.allowedMethods());

    LOG.info(`network-dashboard-platform running on http://localhost:${PORT}`);

    const shutdown = () => {
      LOG.info("Shutting down...");
      stopSorobanWatcher();
      stopScheduler();
      Deno.exit(0);
    };
    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);

    await app.listen({ port: PORT });
  } catch (err) {
    LOG.fatal("Failed to start", {
      error: err instanceof Error ? err.message : String(err),
    });
    stopSorobanWatcher();
    stopScheduler();
    Deno.exit(1);
  }
}

bootstrap();
