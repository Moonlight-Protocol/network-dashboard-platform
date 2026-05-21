import { networkState } from "@/core/state/store.ts";
import type { SnapshotFrame } from "@/core/events/types.ts";

/**
 * Build the initial snapshot frame for a newly-connected WS client.
 *
 * Carries everything the SPA needs to paint the 5-section layout without
 * any further round-trips: counters (×6), council topology, recent
 * activity ring buffer, 60-min sparklines, 24h asset breakdown, and
 * per-council rolling metrics keyed by council id.
 */
export function buildSnapshotFrame(): SnapshotFrame {
  const now = Date.now();
  return {
    type: "snapshot",
    counters: {
      councils: networkState.getCouncilIds().length,
      activePPs: networkState.countActiveProviders(),
      eventsLast24h: networkState.countEventsLast24h(now),
      assetsRegistered: networkState.countAssetsRegistered(),
      throughputPerMin: networkState.throughputPerMin(now),
      latencyMs: networkState.avgLatencyMs(now),
    },
    topology: networkState.topologySnapshot(),
    recent: networkState.recentEvents(),
    sparklines: networkState.sparklines(now),
    assetBreakdown: networkState.assetBreakdown24h(now),
    councilRolling: networkState.councilRollingMetrics(now),
    generatedAt: new Date(now).toISOString(),
  };
}
