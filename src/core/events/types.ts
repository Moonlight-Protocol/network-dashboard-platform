/**
 * Wire-frame + internal types for the network-dashboard event stream.
 *
 * NetworkEventKind mirrors the design sketch's six event taxonomy entries.
 * The SPA renders each kind with its own activity-card colour and pulse
 * colour. Adding a kind requires SPA changes — keep this union narrow.
 */

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
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type CouncilTopologyEntry = {
  id: string;
  name: string | null;
  providers: Array<{ publicKey: string; label: string | null }>;
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
};

export type SnapshotFrame = {
  type: "snapshot";
  counters: Counters;
  topology: CouncilTopologyEntry[];
  recent: NetworkEvent[];
  generatedAt: string;
};

export type LiveFrame = {
  type: "event";
  event: NetworkEvent;
};

export type ServerFrame = SnapshotFrame | LiveFrame;

/**
 * Subprotocol echoed back to clients. Bump the suffix on a wire-incompatible
 * frame-shape change so old SPAs can't silently mis-render.
 */
export const NETWORK_WS_SUBPROTOCOL = "moonlight.network.v1";
