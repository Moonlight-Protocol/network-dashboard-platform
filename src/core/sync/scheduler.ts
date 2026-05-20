import { LOG } from "@/config/logger.ts";
import { networkState } from "@/core/state/store.ts";
import { refreshTopology } from "./topology-refresh.ts";

const HOURLY_RESYNC_MS = 60 * 60 * 1000;
const MINUTE_SWEEP_MS = 60 * 1000;

let hourlyTimer: number | null = null;
let minuteTimer: number | null = null;
let running = false;

function hourlyResync(): Promise<void> {
  return refreshTopology("hourly resync");
}

function minuteSweep(): void {
  const purged = networkState.sweepWindow();
  if (purged > 0) {
    LOG.debug("Minute sweep dropped stale window entries", { purged });
  }
}

export function startScheduler(): void {
  if (running) return;
  running = true;
  hourlyTimer = setInterval(
    () => {
      hourlyResync().catch((err) => {
        LOG.error("Hourly re-sync threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    HOURLY_RESYNC_MS,
  ) as unknown as number;
  minuteTimer = setInterval(minuteSweep, MINUTE_SWEEP_MS) as unknown as number;
  LOG.info("Scheduler started", {
    hourlyResyncMs: HOURLY_RESYNC_MS,
    minuteSweepMs: MINUTE_SWEEP_MS,
  });
}

export function stopScheduler(): void {
  running = false;
  if (hourlyTimer !== null) {
    clearInterval(hourlyTimer);
    hourlyTimer = null;
  }
  if (minuteTimer !== null) {
    clearInterval(minuteTimer);
    minuteTimer = null;
  }
  LOG.info("Scheduler stopped");
}
