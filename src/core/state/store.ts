import type {
  CouncilTopologyEntry,
  NetworkEvent,
} from "@/core/events/types.ts";

/**
 * In-memory snapshot of network state. No persistence — cold-start
 * re-derives from council-platform `/public/*` + a 24h Soroban scan.
 *
 * Single-writer assumption: only the sync + watcher layers mutate the
 * store; WS handlers only read. Methods return shallow clones (or
 * snapshot-shaped objects) so consumers never accidentally mutate
 * internal arrays.
 */

const RING_BUFFER_SIZE = 20;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

type EventsAt = { id: string; occurredAt: number };

export class NetworkStateStore {
  private councils = new Map<string, CouncilTopologyEntry>();
  /** assetContractId → councilId for asset_registered dedup + linkage. */
  private assetContractToCouncil = new Map<string, string>();
  /** channelContractId → councilId for deposit/settlement linkage. */
  private channelContractToCouncil = new Map<string, string>();
  /** Ring buffer of most-recent events for the activity feed. */
  private recent: NetworkEvent[] = [];
  /** Sliding 24h timestamps for the EVENTS/24h counter. */
  private windowEvents: EventsAt[] = [];

  // ── council topology ───────────────────────────────────────────────

  /**
   * Replace the entire topology atomically (used at cold start + hourly
   * re-sync). Rebuilds the linkage maps from the supplied entries. Does
   * NOT touch the event ring buffer or the rolling counter window.
   */
  replaceTopology(entries: CouncilTopologyEntry[]): void {
    this.councils.clear();
    this.assetContractToCouncil.clear();
    this.channelContractToCouncil.clear();
    for (const e of entries) {
      this.councils.set(e.id, e);
      for (const c of e.channels) {
        this.channelContractToCouncil.set(c.contractId, e.id);
        if (c.assetContractId) {
          this.assetContractToCouncil.set(c.assetContractId, e.id);
        }
      }
    }
  }

  hasCouncil(id: string): boolean {
    return this.councils.has(id);
  }

  getCouncilName(id: string): string | null {
    return this.councils.get(id)?.name ?? null;
  }

  getCouncilIds(): string[] {
    return Array.from(this.councils.keys());
  }

  getChannelContractIds(): string[] {
    return Array.from(this.channelContractToCouncil.keys());
  }

  getAssetContractIds(): string[] {
    return Array.from(this.assetContractToCouncil.keys());
  }

  resolveChannelToCouncil(channelContractId: string): string | undefined {
    return this.channelContractToCouncil.get(channelContractId);
  }

  resolveAssetToCouncil(assetContractId: string): string | undefined {
    return this.assetContractToCouncil.get(assetContractId);
  }

  topologySnapshot(): CouncilTopologyEntry[] {
    return Array.from(this.councils.values()).map((c) => ({
      ...c,
      providers: [...c.providers],
      channels: c.channels.map((ch) => ({ ...ch })),
      jurisdictions: [...c.jurisdictions],
    }));
  }

  // ── events + counters ──────────────────────────────────────────────

  /**
   * Record an observed event: push to the ring buffer (newest first),
   * trim to capacity, and add to the rolling 24h counter window. Idempotent
   * by event id — re-publishing the same event id is a no-op.
   */
  recordEvent(event: NetworkEvent): boolean {
    if (this.recent.some((e) => e.id === event.id)) {
      return false;
    }
    this.recent.unshift(event);
    if (this.recent.length > RING_BUFFER_SIZE) {
      this.recent.length = RING_BUFFER_SIZE;
    }

    const occurredMs = Date.parse(event.occurredAt);
    if (!Number.isNaN(occurredMs)) {
      this.windowEvents.push({ id: event.id, occurredAt: occurredMs });
    }
    return true;
  }

  /** Drop windowEvents older than 24h. Called by the minute-sweep. */
  sweepWindow(now: number = Date.now()): number {
    const cutoff = now - ROLLING_WINDOW_MS;
    const before = this.windowEvents.length;
    this.windowEvents = this.windowEvents.filter((e) => e.occurredAt >= cutoff);
    return before - this.windowEvents.length;
  }

  /** Replace the rolling window wholesale (used by the 24h cold-start scan). */
  seedWindow(events: NetworkEvent[]): void {
    this.windowEvents = [];
    for (const e of events) {
      const ts = Date.parse(e.occurredAt);
      if (!Number.isNaN(ts)) {
        this.windowEvents.push({ id: e.id, occurredAt: ts });
      }
    }
  }

  /** Seed the ring buffer at cold start (newest entries first). */
  seedRecent(events: NetworkEvent[]): void {
    this.recent = events.slice(0, RING_BUFFER_SIZE);
  }

  recentEvents(): NetworkEvent[] {
    return [...this.recent];
  }

  countEventsLast24h(now: number = Date.now()): number {
    const cutoff = now - ROLLING_WINDOW_MS;
    let n = 0;
    for (const e of this.windowEvents) {
      if (e.occurredAt >= cutoff) n++;
    }
    return n;
  }

  /** Sum of active providers across all councils. */
  countActiveProviders(): number {
    let total = 0;
    for (const c of this.councils.values()) total += c.providers.length;
    return total;
  }

  /** Distinct assetContractIds across all councils' channels. */
  countAssetsRegistered(): number {
    return this.assetContractToCouncil.size;
  }

  /** Test-only seam to reset all state. */
  __resetForTests(): void {
    this.councils.clear();
    this.assetContractToCouncil.clear();
    this.channelContractToCouncil.clear();
    this.recent = [];
    this.windowEvents = [];
  }
}

export const RING_BUFFER_CAPACITY = RING_BUFFER_SIZE;
export const ROLLING_WINDOW_DURATION_MS = ROLLING_WINDOW_MS;

/** Process-wide singleton. */
export const networkState = new NetworkStateStore();
