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

function publish(raw: RawChainEvent): void {
  const mapped = mapChainEvent(raw);
  if (!mapped) return;
  const wasNew = networkState.recordEvent(mapped);
  if (!wasNew) return;
  networkEventBus.publish(mapped);
}

/**
 * Cold-start scan: walk trailing 24h on the current contractId set,
 * map events, and seed the rolling window + ring buffer in chronological
 * order. Sets the forward cursor to one past the latest ledger seen.
 */
export async function coldStartScan(): Promise<void> {
  const server = getServer();
  const latest = await server.getLatestLedger();
  const startLedger = Math.max(1, latest.sequence - LOOKBACK_LEDGERS_24H);
  const contractIds = watchedContractIds();

  if (contractIds.length === 0) {
    lastLedgerSeen = latest.sequence;
    LOG.info(
      "Cold-start scan skipped — no contracts to watch yet (no councils registered).",
      { latestLedger: latest.sequence },
    );
    return;
  }

  LOG.info("Cold-start scan starting", {
    startLedger,
    latestLedger: latest.sequence,
    contractCount: contractIds.length,
  });

  let nextLedger = startLedger;
  let page = 0;
  const mapped: ReturnType<typeof mapChainEvent>[] = [];

  // Walk forward in ledger ranges. The Soroban RPC orders events by ledger
  // ascending; when a page fills, the last event's `ledger + 1` is the
  // next startLedger. Loop terminates when a page returns fewer events
  // than the page limit (i.e., caught up to head).
  while (true) {
    const res = await server.getEvents({
      startLedger: nextLedger,
      filters: [{ type: "contract", contractIds }],
      limit: PAGE_LIMIT,
    });
    page++;
    for (const ev of res.events) {
      const raw: RawChainEvent = {
        contractId: ev.contractId?.toString() ?? "",
        ledger: ev.ledger,
        topics: ev.topic,
        value: ev.value,
      };
      const m = mapChainEvent(raw);
      if (m) mapped.push(m);
    }
    lastLedgerSeen = res.latestLedger;
    if (res.events.length < PAGE_LIMIT) break;
    const lastLedgerInPage = res.events[res.events.length - 1].ledger;
    nextLedger = lastLedgerInPage + 1;
    if (page >= 50) {
      LOG.warn("Cold-start scan hit page cap (50); stopping early", {
        eventsSoFar: mapped.length,
      });
      break;
    }
  }

  // Seed in chronological order so the activity-feed ring buffer holds
  // the most-recent at the front (`unshift` ordering matches).
  const chronological = mapped.flatMap((e) => e ? [e] : []);
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
    for (const ev of res.events) {
      publish({
        contractId: ev.contractId?.toString() ?? "",
        ledger: ev.ledger,
        topics: ev.topic,
        value: ev.value,
      });
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
