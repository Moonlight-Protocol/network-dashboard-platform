import { Server } from "stellar-sdk/rpc";
import { LOG } from "@/config/logger.ts";
import { STELLAR_RPC_URL } from "@/config/env.ts";
import { networkState } from "@/core/state/store.ts";
import { networkEventBus } from "@/core/events/bus.ts";
import { mapChainEvent, type RawChainEvent } from "./event-mapper.ts";

const POLL_INTERVAL_MS = 5_000;
const LOOKBACK_LEDGERS_24H = 17_280; // ~5s ledgers × 24h
const PAGE_LIMIT = 100;

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

function publish(event: ReturnType<typeof mapChainEvent>): void {
  if (!event) return;
  const wasNew = networkState.recordEvent(event);
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
function processRawEventBatch(
  raws: RawChainEvent[],
): Array<NonNullable<ReturnType<typeof mapChainEvent>>> {
  const byTx = new Map<
    string,
    Array<NonNullable<ReturnType<typeof mapChainEvent>>>
  >();
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
    if (bucket) bucket.push(mapped);
  }
  const out: Array<NonNullable<ReturnType<typeof mapChainEvent>>> = [];
  for (const key of txOrder) {
    const events = byTx.get(key);
    if (!events) continue;
    const hasMoneyFlow = events.some(
      (e) => e.kind === "channel_deposit" || e.kind === "channel_settlement",
    );
    let bundleEmitted = false;
    for (const e of events) {
      if (e.kind === "channel_bundle") {
        if (hasMoneyFlow) continue;
        if (bundleEmitted) continue;
        bundleEmitted = true;
      }
      out.push(e);
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

  let nextLedger = initialStart;
  let page = 0;
  const rawBatch: RawChainEvent[] = [];

  // Walk forward in ledger ranges. The Soroban RPC orders events by ledger
  // ascending; when a page fills, the last event's `ledger + 1` is the
  // next startLedger. Loop terminates when a page returns fewer events
  // than the page limit (i.e., caught up to head).
  while (true) {
    let res;
    try {
      res = await server.getEvents({
        startLedger: nextLedger,
        filters: [{ type: "contract", contractIds }],
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
            filters: [{ type: "contract", contractIds }],
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
        LOG.warn("Cold-start scan page failed (stopping)", {
          page,
          startLedger: nextLedger,
          error: describeErr(err),
        });
        break;
      }
    }
    page++;
    for (const ev of res.events) {
      rawBatch.push({
        contractId: ev.contractId?.toString() ?? "",
        ledger: ev.ledger,
        topics: ev.topic,
        value: ev.value,
        txHash: ev.txHash ?? "",
      });
    }
    lastLedgerSeen = res.latestLedger;
    if (res.events.length < PAGE_LIMIT) break;
    const lastLedgerInPage = res.events[res.events.length - 1].ledger;
    nextLedger = lastLedgerInPage + 1;
    if (page >= 50) {
      LOG.warn("Cold-start scan hit page cap (50); stopping early", {
        eventsSoFar: rawBatch.length,
      });
      break;
    }
  }

  // Process the whole accumulated batch with per-tx dedup, then seed.
  const chronological = processRawEventBatch(rawBatch);
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
  if (contractIds.length === 0) return;
  try {
    const server = getServer();
    const res = await server.getEvents({
      startLedger: lastLedgerSeen + 1,
      filters: [{ type: "contract", contractIds }],
      limit: PAGE_LIMIT,
    });
    const rawBatch: RawChainEvent[] = res.events.map((ev) => ({
      contractId: ev.contractId?.toString() ?? "",
      ledger: ev.ledger,
      topics: ev.topic,
      value: ev.value,
      txHash: ev.txHash ?? "",
    }));
    for (const mapped of processRawEventBatch(rawBatch)) {
      publish(mapped);
    }
    lastLedgerSeen = Math.max(lastLedgerSeen, res.latestLedger);
  } catch (err) {
    LOG.warn("Soroban poll failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
