import type { Logger } from "@/utils/logger/index.ts";
import type { NetworkEventBus } from "@/core/events/bus.ts";
import { networkState } from "@/core/state/store.ts";
import { refreshTopology } from "./topology-refresh.ts";

const HOURLY_RESYNC_MS = 60 * 60 * 1000;
const MINUTE_SWEEP_MS = 60 * 1000;

let hourlyTimer: number | null = null;
let minuteTimer: number | null = null;
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

  hourlyTimer = setInterval(
    () => {
      refreshTopology("hourly resync", deps).catch((err) => {
        log.error(err, "hourly re-sync threw");
      });
    },
    HOURLY_RESYNC_MS,
  ) as unknown as number;
  minuteTimer = setInterval(minuteSweep, MINUTE_SWEEP_MS) as unknown as number;

  log.debug("hourlyResyncMs", HOURLY_RESYNC_MS);
  log.debug("minuteSweepMs", MINUTE_SWEEP_MS);
  log.event("scheduler started");
}

export function stopScheduler(deps: { log: Logger }): void {
  running = false;
  if (hourlyTimer !== null) {
    clearInterval(hourlyTimer);
    hourlyTimer = null;
  }
  if (minuteTimer !== null) {
    clearInterval(minuteTimer);
    minuteTimer = null;
  }
  deps.log.scope("scheduler").event("scheduler stopped");
}
