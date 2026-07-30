import type { Logger } from "@/utils/logger/index.ts";
import type { NetworkEventBus } from "@/core/events/bus.ts";
import { networkState } from "@/core/state/store.ts";
import { refreshTopology } from "./topology-refresh.ts";

/**
 * Background scheduler — rolling-window sweep + periodic topology re-sync.
 *
 * The periodic re-sync exists because parts of the topology change with NO
 * chain event to react to: channel and jurisdiction registration are
 * council-platform DB operations (POST /council/channels), and provider
 * labels are metadata. The event-driven paths (boot fetch, the
 * `contract_initialized` watcher in `contract-init-listener.ts`, the
 * `provider_added` piggyback) cover the chain-visible transitions, but a
 * council whose channels were registered after its last refresh stayed
 * frozen — on mainnet that left a council name-only (no channels, no
 * providers, no jurisdictions) for hours. One council-platform fetch per
 * minute is the completeness backstop; `refreshTopology` is single-flight,
 * so overlap with the event-driven refreshes coalesces.
 *
 * `sweepWindow` drops stale entries from the 24-hour rolling counter
 * window so memory stays bounded. Keeping it on a 60-second cadence.
 */
const MINUTE_SWEEP_MS = 60 * 1000;
const TOPOLOGY_RESYNC_MS = 60 * 1000;

let minuteTimer: number | null = null;
let resyncTimer: number | null = null;
let running = false;

export function startScheduler(
  deps: { log: Logger; bus: NetworkEventBus },
): void {
  if (running) return;
  running = true;
  const log = deps.log.scope("scheduler");

  function minuteSweep(): void {
    const purged = networkState.sweepWindow();
    if (purged > 0) {
      log.debug("purged", purged);
      log.event("minute sweep dropped stale window entries");
    }
  }

  function topologyResync(): void {
    refreshTopology("periodic-resync", deps).catch((err) => {
      log.error(err, "periodic topology re-sync failed");
    });
  }

  minuteTimer = setInterval(minuteSweep, MINUTE_SWEEP_MS) as unknown as number;
  resyncTimer = setInterval(
    topologyResync,
    TOPOLOGY_RESYNC_MS,
  ) as unknown as number;

  log.debug("minuteSweepMs", MINUTE_SWEEP_MS);
  log.debug("topologyResyncMs", TOPOLOGY_RESYNC_MS);
  log.event("scheduler started");
}

export function stopScheduler(deps: { log: Logger }): void {
  running = false;
  if (minuteTimer !== null) {
    clearInterval(minuteTimer);
    minuteTimer = null;
  }
  if (resyncTimer !== null) {
    clearInterval(resyncTimer);
    resyncTimer = null;
  }
  deps.log.scope("scheduler").event("scheduler stopped");
}
