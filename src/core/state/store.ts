import type {
  AssetBreakdownRow,
  CouncilRollingMetrics,
  CouncilTopologyEntry,
  NetworkEvent,
  NetworkEventKind,
  Sparklines,
} from "@/core/events/types.ts";

/**
 * In-memory snapshot of network state. No persistence — cold-start
 * re-derives from council-platform `/public/*` + a 24h Soroban scan.
 *
 * Single-writer assumption: only the sync + watcher layers mutate the
 * store; WS handlers only read. Methods return shallow clones (or
 * snapshot-shaped objects) so consumers never accidentally mutate
 * internal arrays.
 *
 * The store also keeps a derived per-event metric record (amount, asset,
 * latency) covering the trailing 24h so the snapshot builder can compute
 * throughput / latency / sparklines / asset breakdown / per-council
 * rolling totals without holding parallel bucket structures.
 */

const RING_BUFFER_SIZE = 20;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const THROUGHPUT_WINDOW_MS = MINUTE_MS;
const LATENCY_WINDOW_MS = 5 * MINUTE_MS;
const SPARKLINE_BUCKETS = 60;

type MetricEvent = {
  id: string;
  occurredAt: number;
  kind: NetworkEventKind;
  councilId: string;
  assetContractId: string | null;
  amountStroops: bigint | null;
  latencyMs: number | null;
};

/**
 * Parse a decoded amount string back to bigint stroops.
 * `decodeI128` returns either a plain decimal string (when the high
 * 64 bits are zero — the common case for normal asset amounts) or
 * `<hi>:<lo>` for true 128-bit values. Only the plain form is sortable
 * arithmetic; the colon form is dropped from metric aggregates but kept
 * in the wire payload for display.
 */
function parseAmount(raw: unknown): bigint | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (!/^-?\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function readPayload(event: NetworkEvent): {
  assetContractId: string | null;
  amountStroops: bigint | null;
} {
  const p = event.payload;
  const assetContractId = typeof p.assetContractId === "string"
    ? p.assetContractId
    : null;
  const amountStroops = parseAmount(p.amount);
  return { assetContractId, amountStroops };
}

export class NetworkStateStore {
  private councils = new Map<string, CouncilTopologyEntry>();
  /** assetContractId → councilId for asset_registered dedup + linkage. */
  private assetContractToCouncil = new Map<string, string>();
  /** channelContractId → councilId for deposit/settlement linkage. */
  private channelContractToCouncil = new Map<string, string>();
  /** assetContractId → assetCode (XLM, USDC, …) for asset breakdown labels. */
  private assetCodeByContract = new Map<string, string>();
  /** providerPublicKey → councilId for channel_bundle attribution. */
  private providerToCouncil = new Map<string, string>();
  /** Ring buffer of most-recent events for the activity feed. */
  private recent: NetworkEvent[] = [];
  /**
   * Sliding 24h metric records (one per event observed within the window).
   * Newest at the end; the cold-start scan seeds in chronological order.
   */
  private metrics: MetricEvent[] = [];

  // ── council topology ───────────────────────────────────────────────

  /**
   * Replace the topology snapshot used for derived linkage. Rebuilds the
   * council registry + channel/asset linkage maps from the supplied
   * entries. Does NOT touch the event ring buffer or the rolling counter
   * window.
   *
   * `providerToCouncil` is the one map we intentionally do NOT clear here.
   * It is also written by `registerProvider` / `unregisterProvider` —
   * those are the canonical, chain-event-driven writers from
   * `soroban-watcher.publishMappedEvent`. When the contract-init listener
   * fires `refreshTopology` (or the provider-added piggyback does), the
   * fetched topology MAY lag the on-chain state: council-platform's own
   * EventWatcher runs at a 30 s cadence per Channel Auth contract, so
   * council-platform's `/public/councils` can return a council whose
   * providers list still omits a PP that has already fired `provider_added`
   * on-chain. Clearing this map then re-populating from the fetched
   * topology silently wiped any `registerProvider` value the watcher had
   * just set for that PP — the next SAC-fee event from that PP then
   * dropped `channel_bundle` until council-platform caught up and a later
   * refresh re-added the entry.
   *
   * Instead we union: keep prior writes, set the entries from the
   * fetched topology. Removal of a PP from `providerToCouncil` is the
   * responsibility of `unregisterProvider` (driven by `provider_removed`
   * on chain).
   */
  replaceTopology(entries: CouncilTopologyEntry[]): void {
    this.councils.clear();
    this.assetContractToCouncil.clear();
    this.channelContractToCouncil.clear();
    this.assetCodeByContract.clear();
    for (const e of entries) {
      this.councils.set(e.id, e);
      for (const c of e.channels) {
        this.channelContractToCouncil.set(c.contractId, e.id);
        if (c.assetContractId) {
          this.assetContractToCouncil.set(c.assetContractId, e.id);
          this.assetCodeByContract.set(c.assetContractId, c.assetCode);
        }
      }
      for (const p of e.providers) {
        this.providerToCouncil.set(p.publicKey, e.id);
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

  resolveProviderToCouncil(publicKey: string): string | undefined {
    return this.providerToCouncil.get(publicKey);
  }

  /**
   * Surgical, idempotent insert into the providerToCouncil map. Called by
   * the watcher when a `provider_added` chain event is observed, so a PP
   * that joins a council AFTER the last `replaceTopology` is still
   * resolvable on the next SAC-fee event (otherwise `mapSacFeeEvent`
   * drops the bundle for the entire window between PP join and the next
   * topology refresh). Re-running `replaceTopology` later overwrites with
   * the same value — safe.
   */
  registerProvider(publicKey: string, councilId: string): void {
    this.providerToCouncil.set(publicKey, councilId);
  }

  /**
   * Counterpart to `registerProvider` — called on `provider_removed`. A
   * later `replaceTopology` will not re-add the PP because
   * council-platform's `/public/councils` only lists active providers
   * (`providerRepo.listActive`).
   */
  unregisterProvider(publicKey: string): void {
    this.providerToCouncil.delete(publicKey);
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
   * trim to capacity, and append a metric record for the rolling window.
   * Idempotent by event id — re-publishing the same event id is a no-op.
   * `latencyMs` is the wall-clock observation delay vs the chain ledger
   * close time; pass null when the watcher couldn't determine it.
   */
  recordEvent(event: NetworkEvent, latencyMs: number | null = null): boolean {
    if (this.recent.some((e) => e.id === event.id)) {
      return false;
    }
    this.recent.unshift(event);
    if (this.recent.length > RING_BUFFER_SIZE) {
      this.recent.length = RING_BUFFER_SIZE;
    }

    const occurredMs = Date.parse(event.occurredAt);
    if (!Number.isNaN(occurredMs)) {
      const { assetContractId, amountStroops } = readPayload(event);
      this.metrics.push({
        id: event.id,
        occurredAt: occurredMs,
        kind: event.kind,
        councilId: event.councilId,
        assetContractId,
        amountStroops,
        latencyMs,
      });
    }
    return true;
  }

  /** Drop metric records older than 24h. Called by the minute-sweep. */
  sweepWindow(now: number = Date.now()): number {
    const cutoff = now - ROLLING_WINDOW_MS;
    const before = this.metrics.length;
    this.metrics = this.metrics.filter((m) => m.occurredAt >= cutoff);
    return before - this.metrics.length;
  }

  /**
   * Merge a back-fill batch into the rolling window (used by the 24h
   * cold-start scan + hourly re-sync). Events whose id is already in the
   * window are LEFT ALONE — that preserves live-captured `latencyMs`
   * samples the forward poller recorded since the previous seed. Only
   * truly new events from the back-fill (with null latency) get added.
   *
   * Without this merge, every topology refresh wiped the throughput +
   * latency observations, leaving the snapshot's `latencyMs` at null
   * even during active workloads.
   */
  seedWindow(events: NetworkEvent[]): void {
    const existing = new Set(this.metrics.map((m) => m.id));
    for (const e of events) {
      if (existing.has(e.id)) continue;
      const ts = Date.parse(e.occurredAt);
      if (Number.isNaN(ts)) continue;
      const { assetContractId, amountStroops } = readPayload(e);
      this.metrics.push({
        id: e.id,
        occurredAt: ts,
        kind: e.kind,
        councilId: e.councilId,
        assetContractId,
        amountStroops,
        latencyMs: null,
      });
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
    for (const m of this.metrics) {
      if (m.occurredAt >= cutoff) n++;
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

  /** Network-wide event count over the trailing 60s. */
  throughputPerMin(now: number = Date.now()): number {
    const cutoff = now - THROUGHPUT_WINDOW_MS;
    let n = 0;
    for (const m of this.metrics) {
      if (m.occurredAt >= cutoff) n++;
    }
    return n;
  }

  /**
   * Average observed latency (ms) over the trailing 5 min, considering
   * only events that carry a non-null latency sample. Returns null when
   * no samples are in window — back-fill records have null latency, so
   * a freshly-booted service correctly reports "no samples" instead of 0.
   */
  avgLatencyMs(now: number = Date.now()): number | null {
    const cutoff = now - LATENCY_WINDOW_MS;
    let sum = 0;
    let count = 0;
    for (const m of this.metrics) {
      if (m.occurredAt < cutoff) continue;
      if (m.latencyMs === null) continue;
      sum += m.latencyMs;
      count++;
    }
    if (count === 0) return null;
    return Math.round(sum / count);
  }

  /**
   * Build 60-minute rolling sparklines: throughput (count/min), latency
   * (avg ms/min, or null where no samples), volume (sum of deposit +
   * settlement amounts in whole-asset units, stroops / 1e7, per minute).
   */
  sparklines(now: number = Date.now()): Sparklines {
    // Bucket [0] covers (now - 60m, now - 59m]; bucket [59] covers
    // (now - 1m, now]. Aligning `start` to (SPARKLINE_BUCKETS - 1)
    // minutes ago means an event at exactly `now` lands in the
    // last bucket and an event one full minute earlier lands in
    // the bucket before it, matching how the SPA renders the line.
    const start = now - (SPARKLINE_BUCKETS - 1) * MINUTE_MS;
    const throughput = new Array<number>(SPARKLINE_BUCKETS).fill(0);
    const volumeStroops = new Array<bigint>(SPARKLINE_BUCKETS).fill(0n);
    const latencySum = new Array<number>(SPARKLINE_BUCKETS).fill(0);
    const latencyCount = new Array<number>(SPARKLINE_BUCKETS).fill(0);

    for (const m of this.metrics) {
      const idx = Math.floor((m.occurredAt - start) / MINUTE_MS);
      if (idx < 0 || idx >= SPARKLINE_BUCKETS) continue;
      throughput[idx]++;
      if (
        m.amountStroops !== null &&
        (m.kind === "channel_deposit" || m.kind === "channel_settlement")
      ) {
        volumeStroops[idx] += m.amountStroops;
      }
      if (m.latencyMs !== null) {
        latencySum[idx] += m.latencyMs;
        latencyCount[idx]++;
      }
    }

    const latency = latencyCount.map((c, i) =>
      c > 0 ? Math.round(latencySum[i] / c) : null
    );
    // Stroops → whole units (1e7 stroops per 1.0 asset). Sparkline values
    // are display-only so the lossy Number conversion is fine.
    const volume = volumeStroops.map((s) =>
      Number(s / 10_000_000n) + Number(s % 10_000_000n) / 10_000_000
    );
    return { throughput, latency, volume };
  }

  /**
   * Per-asset volume settled (deposit + settlement) over the trailing 24h,
   * sorted by share descending. Stroop totals stay exact (string-encoded).
   */
  assetBreakdown24h(now: number = Date.now()): AssetBreakdownRow[] {
    const cutoff = now - ROLLING_WINDOW_MS;
    const totals = new Map<string, bigint>();
    for (const m of this.metrics) {
      if (m.occurredAt < cutoff) continue;
      if (m.assetContractId === null) continue;
      if (m.amountStroops === null) continue;
      if (m.kind !== "channel_deposit" && m.kind !== "channel_settlement") {
        continue;
      }
      const prev = totals.get(m.assetContractId) ?? 0n;
      totals.set(m.assetContractId, prev + m.amountStroops);
    }
    let grand = 0n;
    for (const v of totals.values()) grand += v;
    const rows: AssetBreakdownRow[] = [];
    for (const [assetContractId, amount] of totals) {
      const code = this.assetCodeByContract.get(assetContractId) ?? "???";
      const percent = grand > 0n ? Number((amount * 10_000n) / grand) / 100 : 0;
      rows.push({
        assetContractId,
        assetCode: code,
        amountStroops: amount.toString(),
        percent,
      });
    }
    rows.sort((a, b) => b.percent - a.percent);
    return rows;
  }

  /**
   * Per-council rolling metrics for the trailing 1 hour. Every known
   * council appears in the result map, even with all zeroes, so the SPA
   * can render the panel for any council without a missing-key check.
   */
  councilRollingMetrics(
    now: number = Date.now(),
  ): Record<string, CouncilRollingMetrics> {
    const cutoff = now - HOUR_MS;
    const eventCounts = new Map<string, number>();
    const bundleCounts = new Map<string, number>();
    const depositTotals = new Map<string, bigint>();
    const settlementTotals = new Map<string, bigint>();

    for (const m of this.metrics) {
      if (m.occurredAt < cutoff) continue;
      eventCounts.set(m.councilId, (eventCounts.get(m.councilId) ?? 0) + 1);
      if (m.kind === "channel_bundle") {
        bundleCounts.set(m.councilId, (bundleCounts.get(m.councilId) ?? 0) + 1);
      }
      if (m.amountStroops === null) continue;
      if (m.kind === "channel_deposit") {
        depositTotals.set(
          m.councilId,
          (depositTotals.get(m.councilId) ?? 0n) + m.amountStroops,
        );
      } else if (m.kind === "channel_settlement") {
        settlementTotals.set(
          m.councilId,
          (settlementTotals.get(m.councilId) ?? 0n) + m.amountStroops,
        );
      }
    }

    const out: Record<string, CouncilRollingMetrics> = {};
    for (const id of this.councils.keys()) {
      const total = eventCounts.get(id) ?? 0;
      out[id] = {
        bundlesLastHour: bundleCounts.get(id) ?? 0,
        eventsLastHour: total,
        ratePerMin: Math.round((total / 60) * 10) / 10,
        depositVolumeStroops: (depositTotals.get(id) ?? 0n).toString(),
        settlementVolumeStroops: (settlementTotals.get(id) ?? 0n).toString(),
      };
    }
    return out;
  }

  /** Test-only seam to reset all state. */
  __resetForTests(): void {
    this.councils.clear();
    this.assetContractToCouncil.clear();
    this.channelContractToCouncil.clear();
    this.assetCodeByContract.clear();
    this.providerToCouncil.clear();
    this.recent = [];
    this.metrics = [];
  }
}

export const RING_BUFFER_CAPACITY = RING_BUFFER_SIZE;
export const ROLLING_WINDOW_DURATION_MS = ROLLING_WINDOW_MS;
export const SPARKLINE_BUCKET_COUNT = SPARKLINE_BUCKETS;
export const SPARKLINE_BUCKET_MS = MINUTE_MS;

/** Process-wide singleton. */
export const networkState = new NetworkStateStore();
