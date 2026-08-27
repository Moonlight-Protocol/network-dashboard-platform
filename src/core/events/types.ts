/**
 * Wire-frame + internal types for the network-dashboard event stream.
 *
 * NetworkEventKind mirrors the design sketch's six event taxonomy entries.
 * The SPA renders each kind with its own activity-card colour and pulse
 * colour. Adding a kind requires SPA changes — keep this union narrow.
 */
import type { StructuredErrorShape } from "@/error/structured-error.ts";

export const NETWORK_EVENT_KINDS = [
  "council_formed",
  "provider_added",
  "provider_removed",
  "asset_registered",
  "channel_deposit",
  "channel_settlement",
  "channel_bundle",
] as const;

export type NetworkEventKind = typeof NETWORK_EVENT_KINDS[number];

/**
 * Server-side network event. Carries enough context to render a card and
 * animate the right pulse without a second fetch.
 *
 * `occurredAt` is an ISO timestamp — wall-clock now() at the point the
 * watcher dispatched the event. Drift vs chain ledger close time is
 * bounded by the polling interval.
 */
export type NetworkEvent = {
  id: string;
  kind: NetworkEventKind;
  councilId: string;
  councilName: string | null;
  ledger: number;
  /**
   * Hash of the transaction that emitted the event. Top-level (not in the
   * per-kind payloads) so every kind can link out to a chain explorer.
   */
  txHash: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type CouncilTopologyEntry = {
  id: string;
  name: string | null;
  providers: Array<{
    publicKey: string;
    label: string | null;
    /**
     * Self-reported provider base URL from council-platform (nullable —
     * providers registered before self-reporting send nothing). Additive
     * field: older SPAs ignore it, no subprotocol bump.
     */
    providerUrl?: string | null;
  }>;
  channels: Array<{
    contractId: string;
    assetCode: string;
    assetContractId: string | null;
  }>;
  jurisdictions: string[];
};

export type Counters = {
  councils: number;
  activePPs: number;
  eventsLast24h: number;
  assetsRegistered: number;
  /** Network-wide event count over the trailing 60s. */
  throughputPerMin: number;
  /** Avg submitted→verified latency in ms over the trailing 5min. Null if no samples. */
  latencyMs: number | null;
};

/**
 * 60-minute rolling sparklines, one entry per minute (oldest first).
 * Each array has length 60 — bucket [0] = 59 min ago, bucket [59] = the
 * current minute. Latency entries may be null where the bucket has no
 * observed events.
 */
export type Sparklines = {
  throughput: number[];
  latency: Array<number | null>;
  volume: number[];
};

/**
 * 24h volume per asset, ordered by share descending.
 *
 * `amountStroops` is the precise stroop-denominated total expressed as a
 * decimal string so int64 ranges survive the JSON encode. The SPA divides
 * by 1e7 for display.
 */
export type AssetBreakdownRow = {
  assetContractId: string;
  assetCode: string;
  amountStroops: string;
  percent: number;
};

/**
 * Per-council rolling metrics for the §3 Council Details panel.
 * Counts + volume sums over the trailing 1 hour.
 */
export type CouncilRollingMetrics = {
  bundlesLastHour: number;
  eventsLastHour: number;
  ratePerMin: number;
  depositVolumeStroops: string;
  settlementVolumeStroops: string;
};

export type SnapshotFrame = {
  type: "snapshot";
  counters: Counters;
  topology: CouncilTopologyEntry[];
  recent: NetworkEvent[];
  sparklines: Sparklines;
  assetBreakdown: AssetBreakdownRow[];
  councilRolling: Record<string, CouncilRollingMetrics>;
  generatedAt: string;
};

export type LiveFrame = {
  type: "event";
  event: NetworkEvent;
  /**
   * Current counter values at the moment of broadcast. Lets the SPA
   * refresh the counter strip on every event instead of only at snapshot
   * time — adding 1 small object per event is cheaper than periodic
   * snapshot pushes.
   */
  counters: Counters;
};

/**
 * Client-safe structured error surfaced to WS subscribers (e.g. a
 * council-platform topology refresh failed, so the live view may be stale).
 * Matches the error-bubbling standard's `{ code, source, message }` shape;
 * carries no internal cause chain or stack. See `@/error/structured-error.ts`.
 */
export type ErrorFrame = {
  type: "error";
  error: StructuredErrorShape;
};

export type ServerFrame = SnapshotFrame | LiveFrame | ErrorFrame;

/**
 * Subprotocol echoed back to clients. Bump the suffix on a wire-incompatible
 * frame-shape change so old SPAs can't silently mis-render.
 *
 * v1 → v2: snapshot gained sparklines, asset breakdown, per-council
 * rolling metrics. Counters gained throughputPerMin + latencyMs.
 *
 * The additive `error` frame does NOT bump the suffix: it is a new frame
 * TYPE, not a shape change to an existing frame, so older SPAs simply drop
 * it via `parseServerFrame` rather than mis-rendering — which keeps a
 * platform-first deploy from disconnecting not-yet-updated clients.
 *
 * `NetworkEvent.txHash` also does NOT bump the suffix: purely additive
 * field, older SPAs ignore unknown keys when narrowing frames.
 */
export const NETWORK_WS_SUBPROTOCOL = "moonlight.network.v2";
