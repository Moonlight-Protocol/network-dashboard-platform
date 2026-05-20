import { Server } from "stellar-sdk/rpc";
import { LOG } from "@/config/logger.ts";
import { STELLAR_RPC_URL } from "@/config/env.ts";
import { networkState } from "@/core/state/store.ts";
import { networkEventBus } from "@/core/events/bus.ts";
import { mapChainEvent, type RawChainEvent } from "./event-mapper.ts";
import {
  CONTRACT_INITIALIZED_TOPIC_PATTERN,
  drainPendingAdoptions,
  evaluateUnknownContract,
  isContractInitListenerEnabled,
} from "./contract-init-listener.ts";

const POLL_INTERVAL_MS = 5_000;
const LOOKBACK_LEDGERS_24H = 17_280; // ~5s ledgers × 24h
const PAGE_LIMIT = 100;
/**
 * Soroban RPC caps `contractIds` per filter (5 in stellar-soroban-rpc as
 * of writing). We split the watched-contracts set into chunks of this size
 * and issue one getEvents call per chunk — both for the forward poll and
 * the cold-start scan.
 */
const CONTRACT_IDS_PER_FILTER = 5;

function chunkContractIds(ids: string[]): string[][] {
  if (ids.length === 0) return [];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += CONTRACT_IDS_PER_FILTER) {
    out.push(ids.slice(i, i + CONTRACT_IDS_PER_FILTER));
  }
  return out;
}

/** RPC client — picked up from env via the lazy getter so tests can stub. */
let rpcServer: Server | null = null;
function getServer(): Server {
  if (!rpcServer) {
    rpcServer = new Server(STELLAR_RPC_URL, {
      allowHttp: STELLAR_RPC_URL.startsWith("http://"),
    });
  }
  return rpcServer;
}

/**
 * Cursor tracking. We forward-poll a union of (Channel Auth contracts) +
 * (SAC contracts) — the SAC set may grow as the topology gains new
 * channels, so we recompute the contractIds filter from networkState on
 * every tick.
 */
let lastLedgerSeen: number | null = null;
let pollTimer: number | null = null;
let running = false;

function watchedContractIds(): string[] {
  const ids = new Set<string>();
  for (const c of networkState.getCouncilIds()) ids.add(c);
  for (const a of networkState.getAssetContractIds()) ids.add(a);
  return Array.from(ids);
}

function publish(
  event: ReturnType<typeof mapChainEvent>,
  ledgerClosedAtMs: number | null,
): void {
  if (!event) return;
  const latencyMs = ledgerClosedAtMs === null
    ? null
    : Math.max(0, Date.now() - ledgerClosedAtMs);
  const wasNew = networkState.recordEvent(event, latencyMs);
  if (!wasNew) return;
  networkEventBus.publish(event);
}

/**
 * Map a batch of raw chain events with per-tx dedup applied:
 *
 *   - The SAC `fee` topic fires once or twice per bundle execution. We
 *     surface "a bundle happened" at most once per txHash.
 *   - If the same tx also produced a deposit/settlement event, drop the
 *     bundle entirely — the money-flow card already conveys "a bundle
 *     happened, and crossed the channel boundary."
 *
 * Returns events in their original ledger order.
 */
type ProcessedEvent = {
  event: NonNullable<ReturnType<typeof mapChainEvent>>;
  ledgerClosedAtMs: number | null;
};

function processRawEventBatch(raws: RawChainEvent[]): ProcessedEvent[] {
  const byTx = new Map<string, ProcessedEvent[]>();
  const txOrder: string[] = [];
  for (const raw of raws) {
    const mapped = mapChainEvent(raw);
    if (!mapped) continue;
    const key = raw.txHash || `__no_tx_${txOrder.length}`;
    if (!byTx.has(key)) {
      byTx.set(key, []);
      txOrder.push(key);
    }
    const bucket = byTx.get(key);
    if (bucket) {
      bucket.push({ event: mapped, ledgerClosedAtMs: raw.ledgerClosedAtMs });
    }
  }
  const out: ProcessedEvent[] = [];
  for (const key of txOrder) {
    const entries = byTx.get(key);
    if (!entries) continue;
    const hasMoneyFlow = entries.some(
      (p) =>
        p.event.kind === "channel_deposit" ||
        p.event.kind === "channel_settlement",
    );
    let bundleEmitted = false;
    for (const p of entries) {
      if (p.event.kind === "channel_bundle") {
        if (hasMoneyFlow) continue;
        if (bundleEmitted) continue;
        bundleEmitted = true;
      }
      out.push(p);
    }
  }
  return out;
}

/**
 * Cold-start scan: walk trailing 24h on the current contractId set,
 * map events, and seed the rolling window + ring buffer in chronological
 * order. Sets the forward cursor to one past the latest ledger seen.
 */
function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Parse Soroban's `ledgerClosedAt` (ISO string) to ms-since-epoch. Older
 * SDK responses may omit it; in that case latency stays null for the event.
 */
function parseLedgerClosedAt(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Extract the minimum valid ledger from Soroban RPC's "out of range" error
 * (`startLedger must be within the ledger range: <min> - <max>`). Returns
 * null if the error doesn't match that pattern.
 */
function parseValidRangeFloor(err: unknown): number | null {
  const msg = describeErr(err);
  const match = msg.match(/ledger range:\s*(\d+)\s*-\s*\d+/);
  return match ? Number(match[1]) : null;
}

export async function coldStartScan(): Promise<void> {
  const server = getServer();
  const latest = await server.getLatestLedger();
  const lookback = Math.min(
    LOOKBACK_LEDGERS_24H,
    Math.max(1, latest.sequence - 1),
  );
  const initialStart = Math.max(1, latest.sequence - lookback);
  const contractIds = watchedContractIds();

  if (contractIds.length === 0) {
    lastLedgerSeen = latest.sequence;
    LOG.info(
      "Cold-start scan skipped — no contracts to watch yet (no councils registered).",
      { latestLedger: latest.sequence },
    );
    return;
  }

  // Set the forward cursor up front so a scan failure doesn't strand
  // the forward poller with a null cursor.
  lastLedgerSeen = latest.sequence;

  LOG.info("Cold-start scan starting", {
    startLedger: initialStart,
    latestLedger: latest.sequence,
    contractCount: contractIds.length,
  });

  const rawBatch: RawChainEvent[] = [];

  // Walk forward in ledger ranges for each contractIds chunk independently.
  // Each chunk holds at most CONTRACT_IDS_PER_FILTER contracts; getEvents
  // pages until a partial page indicates "caught up to head" for that
  // chunk. The page cap (50) is per-chunk and only fires on pathological
  // event volume.
  let totalPages = 0;
  for (const chunk of chunkContractIds(contractIds)) {
    let nextLedger = initialStart;
    let page = 0;
    while (true) {
      let res;
      try {
        res = await server.getEvents({
          startLedger: nextLedger,
          filters: [{ type: "contract", contractIds: chunk }],
          limit: PAGE_LIMIT,
        });
      } catch (err) {
        // First-page out-of-range failure: retry once at the RPC's valid floor.
        const floor = page === 0 ? parseValidRangeFloor(err) : null;
        if (floor !== null && floor > nextLedger) {
          LOG.warn("Cold-start scan startLedger below retention; retrying", {
            requestedStartLedger: nextLedger,
            retentionFloor: floor,
          });
          nextLedger = floor;
          try {
            res = await server.getEvents({
              startLedger: nextLedger,
              filters: [{ type: "contract", contractIds: chunk }],
              limit: PAGE_LIMIT,
            });
          } catch (err2) {
            LOG.warn("Cold-start scan retry at retention floor failed", {
              startLedger: nextLedger,
              error: describeErr(err2),
            });
            break;
          }
        } else {
          LOG.warn("Cold-start scan page failed (stopping chunk)", {
            page,
            startLedger: nextLedger,
            chunkSize: chunk.length,
            error: describeErr(err),
          });
          break;
        }
      }
      page++;
      totalPages++;
      for (const ev of res.events) {
        rawBatch.push({
          contractId: ev.contractId?.toString() ?? "",
          ledger: ev.ledger,
          topics: ev.topic,
          value: ev.value,
          txHash: ev.txHash ?? "",
          ledgerClosedAtMs: parseLedgerClosedAt(ev.ledgerClosedAt),
        });
      }
      lastLedgerSeen = res.latestLedger;
      if (res.events.length < PAGE_LIMIT) break;
      const lastLedgerInPage = res.events[res.events.length - 1].ledger;
      nextLedger = lastLedgerInPage + 1;
      if (page >= 50) {
        LOG.warn("Cold-start scan hit page cap (50) for chunk; stopping", {
          eventsSoFar: rawBatch.length,
          chunkSize: chunk.length,
        });
        break;
      }
    }
  }
  const page = totalPages;

  // Process the whole accumulated batch with per-tx dedup, then seed.
  // Back-fill records carry null latency — the store only computes the
  // avg-latency counter from live observations. Chunked scans return
  // events grouped per chunk, so re-sort by ledger here to keep the
  // ring-buffer chronological.
  rawBatch.sort((a, b) => a.ledger - b.ledger);
  const chronological = processRawEventBatch(rawBatch).map((p) => p.event);
  networkState.seedWindow(chronological);
  // Recent ring buffer: keep newest at index 0.
  const newestFirst = [...chronological].reverse();
  networkState.seedRecent(newestFirst);
  LOG.info("Cold-start scan complete", {
    pagesWalked: page,
    eventsSeeded: chronological.length,
    lastLedgerSeen,
  });
}

async function pollTick(): Promise<void> {
  if (!running || lastLedgerSeen === null) return;
  const contractIds = watchedContractIds();

  // Soroban's getEvents intersects multiple filter entries within a single
  // call: combining `contractIds: [...]` with a separate topic-only filter
  // restricts the response to the contractIds — the topic-only filter is
  // effectively ignored. So we issue two independent calls per tick:
  //   A) known contracts (the existing behaviour)
  //   B) network-wide `contract_initialized` for new-council discovery
  // and merge their result sets.
  const server = getServer();
  const startLedger = lastLedgerSeen + 1;
  let nextLastLedger = lastLedgerSeen;
  const rawBatch: RawChainEvent[] = [];
  const unknownCandidates = new Set<string>();
  const knownIds = new Set(contractIds);

  // Soroban caps contractIds-per-filter at 5; once the network grows past
  // that we have to split the known-contracts subscription into multiple
  // getEvents calls. One call per chunk per tick.
  for (const chunk of chunkContractIds(contractIds)) {
    try {
      const res = await server.getEvents({
        startLedger,
        filters: [{ type: "contract", contractIds: chunk }],
        limit: PAGE_LIMIT,
      });
      nextLastLedger = Math.max(nextLastLedger, res.latestLedger);
      for (const ev of res.events) {
        rawBatch.push({
          contractId: ev.contractId?.toString() ?? "",
          ledger: ev.ledger,
          topics: ev.topic,
          value: ev.value,
          txHash: ev.txHash ?? "",
          ledgerClosedAtMs: parseLedgerClosedAt(ev.ledgerClosedAt),
        });
      }
    } catch (err) {
      LOG.warn("Soroban poll (known contracts) failed", {
        chunkSize: chunk.length,
        error: describeErr(err),
      });
    }
  }

  if (isContractInitListenerEnabled()) {
    try {
      const res = await server.getEvents({
        startLedger,
        filters: [{
          type: "contract",
          topics: [CONTRACT_INITIALIZED_TOPIC_PATTERN],
        }],
        limit: PAGE_LIMIT,
      });
      nextLastLedger = Math.max(nextLastLedger, res.latestLedger);
      for (const ev of res.events) {
        const cid = ev.contractId?.toString() ?? "";
        if (!cid) continue;
        // Already-known contracts are handled by the contractIds-filter
        // call above (which carries full event data); skip the duplicate.
        if (knownIds.has(cid)) continue;
        unknownCandidates.add(cid);
      }
    } catch (err) {
      LOG.warn("Soroban poll (contract_initialized) failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const processed of processRawEventBatch(rawBatch)) {
    publish(processed.event, processed.ledgerClosedAtMs);
  }
  for (const cid of unknownCandidates) {
    evaluateUnknownContract(cid).catch((err) => {
      LOG.warn("evaluateUnknownContract failed", {
        contractId: cid,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  // Retry any matched-but-not-yet-registered contracts. No-op when nothing
  // is pending, so this is cheap when council-platform is caught up.
  drainPendingAdoptions().catch((err) => {
    LOG.warn("drainPendingAdoptions failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  lastLedgerSeen = nextLastLedger;
}

function scheduleNext(): void {
  if (!running) return;
  pollTimer = setTimeout(async () => {
    await pollTick();
    scheduleNext();
  }, POLL_INTERVAL_MS) as unknown as number;
}

export function startSorobanWatcher(): void {
  if (running) return;
  running = true;
  LOG.info("Soroban watcher started", {
    intervalMs: POLL_INTERVAL_MS,
    lastLedgerSeen,
  });
  scheduleNext();
}

export function stopSorobanWatcher(): void {
  running = false;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  LOG.info("Soroban watcher stopped");
}

/** Re-anchor the rolling 24h counter window after the hourly re-sync. */
export async function rescanRollingWindow(): Promise<void> {
  await coldStartScan();
}
