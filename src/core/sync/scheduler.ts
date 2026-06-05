import type { Logger } from "@/utils/logger/index.ts";
import { networkState } from "@/core/state/store.ts";

/**
 * Background scheduler — rolling-window sweep only.
 *
 * The previous hourly topology re-sync is gone. Topology updates happen on
 * the hot path: boot does the initial fetch (see `main.ts:bootstrap`), and
 * new councils are discovered via the Soroban `contract_initialized`
 * watcher (`contract-init-listener.ts`), which triggers a fresh
 * `refreshTopology` the moment a new Channel Auth deploy is observed.
 * Mirrors `provider-platform`'s event-watcher pattern: sync at boot, set
 * listeners, react to events.
 *
 * `sweepWindow` is unrelated to topology — it drops stale entries from the
 * 24-hour rolling counter window so memory stays bounded. Keeping it on
 * a 60-second cadence.
 */
const MINUTE_SWEEP_MS = 60 * 1000;

let minuteTimer: number | null = null;
let running = false;

export function startScheduler(
  deps: { log: Logger },
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

  minuteTimer = setInterval(minuteSweep, MINUTE_SWEEP_MS) as unknown as number;

  log.debug("minuteSweepMs", MINUTE_SWEEP_MS);
  log.event("scheduler started");
}

export function stopScheduler(deps: { log: Logger }): void {
  running = false;
  if (minuteTimer !== null) {
    clearInterval(minuteTimer);
    minuteTimer = null;
  }
  deps.log.scope("scheduler").event("scheduler stopped");
}
