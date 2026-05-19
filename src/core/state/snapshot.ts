import { networkState } from "@/core/state/store.ts";
import type { SnapshotFrame } from "@/core/events/types.ts";

/**
 * Build the initial snapshot frame for a newly-connected WS client. The
 * frame contains the four counters, the council topology, and the recent
 * activity ring buffer — enough for the SPA to render all 3 zones without
 * any further round-trips.
 */
export function buildSnapshotFrame(): SnapshotFrame {
  return {
    type: "snapshot",
    counters: {
      councils: networkState.getCouncilIds().length,
      activePPs: networkState.countActiveProviders(),
      eventsLast24h: networkState.countEventsLast24h(),
      assetsRegistered: networkState.countAssetsRegistered(),
    },
    topology: networkState.topologySnapshot(),
    recent: networkState.recentEvents(),
    generatedAt: new Date().toISOString(),
  };
}
