import { Server } from "stellar-sdk/rpc";
import type { Logger } from "@/utils/logger/index.ts";
import { STELLAR_RPC_URL } from "@/config/env.ts";
import { networkState } from "@/core/state/store.ts";
import type { NetworkEventBus } from "@/core/events/bus.ts";
import { mapChainEvent, type RawChainEvent } from "./event-mapper.ts";
import {
  CONTRACT_INITIALIZED_TOPIC_PATTERN,
  drainPendingAdoptions,
  evaluateUnknownContract,
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

function publishMappedEvent(
  event: ReturnType<typeof mapChainEvent>,
  ledgerClosedAtMs: number | null,
  bus: NetworkEventBus,
  log: Logger,
): void {
  log.info("publishMappedEvent");
  if (!event) return;
  log.debug("kind", event.kind);
  const latencyMs = ledgerClosedAtMs === null
    ? null
    : Math.max(0, Date.now() - ledgerClosedAtMs);
  const wasNew = networkState.recordEvent(event, latencyMs);
  if (!wasNew) {
    log.event("event already seen, skipping publish");
    return;
  }
  // Surgically reflect membership-changing chain events into the
  // in-memory linkage maps so the very next downstream lookup
  // (e.g. `mapSacFeeEvent` resolving the payer's council on the
  // immediately-following send bundle) sees the new state. The next
  // topology refresh will overwrite with the same value — safe.
  if (event.kind === "provider_added") {
    const pp = event.payload.providerPublicKey;
    if (typeof pp === "string") {
      networkState.registerProvider(pp, event.councilId);
    }
  } else if (event.kind === "provider_removed") {
    const pp = event.payload.providerPublicKey;
    if (typeof pp === "string") {
      networkState.unregisterProvider(pp);
    }
  }
  log.event("publishing event to bus");
  bus.publish(event);
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

function processRawEventBatch(
  raws: RawChainEvent[],
  log: Logger,
): ProcessedEvent[] {
  log.info("processRawEventBatch");
  log.debug("rawCount", raws.length);
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
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/ledger range:\s*(\d+)\s*-\s*\d+/);
  return match ? Number(match[1]) : null;
}

/**
 * Cold-start scan: walk trailing 24h on the current contractId set,
 * map events, and seed the rolling window + ring buffer in chronological
 * order. Sets the forward cursor to one past the latest ledger seen.
 */
export async function coldStartScan(
  deps: { log: Logger; bus: NetworkEventBus },
): Promise<void> {
  const log = deps.log.scope("coldStartScan");
  log.info("coldStartScan");

  const server = getServer();
  const latest = await server.getLatestLedger();
  // Soroban's *event* retention is much shorter than its ledger retention
  // (getHealth.oldestLedger). Querying below the events floor returns
  // 0 events without erroring, so probe with progressively smaller
  // lookbacks until events appear. Long-retention providers (testnet /
  // mainnet) typically return events on the first try; the quickstart
  // container needs a closer startLedger.
  const desiredStart = Math.max(
    1,
    latest.sequence - LOOKBACK_LEDGERS_24H,
  );
  let initialStart = desiredStart;
  const probeLookbacks = [LOOKBACK_LEDGERS_24H, 10000, 5000, 2000, 500, 100];
  for (const back of probeLookbacks) {
    const tryStart = Math.max(1, latest.sequence - back);
    try {
      const probe = await server.getEvents({
        startLedger: tryStart,
        filters: [{ type: "contract" }],
        limit: 1,
      });
      if (probe.events.length > 0) {
        initialStart = tryStart;
        if (back !== LOOKBACK_LEDGERS_24H) {
          log.debug("desiredStart", desiredStart);
          log.debug("workingStart", tryStart);
          log.debug("lookbackLedgers", back);
          log.event("cold-start scan clamped to events retention floor");
        }
        break;
      }
    } catch (err) {
      log.debug("back", back);
      log.error(err, "cold-start probe failed at lookback");
    }
  }
  const contractIds = watchedContractIds();

  if (contractIds.length === 0) {
    lastLedgerSeen = latest.sequence;
    log.debug("latestLedger", latest.sequence);
    log.event(
      "cold-start scan skipped — no contracts to watch yet (no councils registered)",
    );
    return;
  }

  // Set the forward cursor up front so a scan failure doesn't strand
  // the forward poller with a null cursor.
  lastLedgerSeen = latest.sequence;

  log.debug("startLedger", initialStart);
  log.debug("latestLedger", latest.sequence);
  log.debug("contractCount", contractIds.length);
  log.event("cold-start scan starting");

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
          log.debug("requestedStartLedger", nextLedger);
          log.debug("retentionFloor", floor);
          log.event(
            "cold-start scan startLedger below retention; retrying at floor",
          );
          nextLedger = floor;
          try {
            res = await server.getEvents({
              startLedger: nextLedger,
              filters: [{ type: "contract", contractIds: chunk }],
              limit: PAGE_LIMIT,
            });
          } catch (err2) {
            log.debug("startLedger", nextLedger);
            log.error(err2, "cold-start scan retry at retention floor failed");
            break;
          }
        } else {
          log.debug("page", page);
          log.debug("startLedger", nextLedger);
          log.debug("chunkSize", chunk.length);
          log.error(err, "cold-start scan page failed (stopping chunk)");
          break;
        }
      }
      page++;
      totalPages++;
      for (const ev of res.events) {
        rawBatch.push({
          id: ev.id,
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
        log.debug("eventsSoFar", rawBatch.length);
        log.debug("chunkSize", chunk.length);
        log.event("cold-start scan hit page cap (50) for chunk; stopping");
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
  const chronological = processRawEventBatch(rawBatch, log).map((p) => p.event);
  networkState.seedWindow(chronological);
  // Recent ring buffer: keep newest at index 0.
  const newestFirst = [...chronological].reverse();
  networkState.seedRecent(newestFirst);

  log.debug("pagesWalked", page);
  log.debug("eventsSeeded", chronological.length);
  log.debug("lastLedgerSeen", lastLedgerSeen);
  log.event("cold-start scan complete");
}

async function pollTick(
  deps: { log: Logger; bus: NetworkEventBus },
): Promise<void> {
  if (!running || lastLedgerSeen === null) return;
  const log = deps.log.scope("pollTick");

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
          id: ev.id,
          contractId: ev.contractId?.toString() ?? "",
          ledger: ev.ledger,
          topics: ev.topic,
          value: ev.value,
          txHash: ev.txHash ?? "",
          ledgerClosedAtMs: parseLedgerClosedAt(ev.ledgerClosedAt),
        });
      }
    } catch (err) {
      log.debug("chunkSize", chunk.length);
      log.error(err, "Soroban poll (known contracts) failed");
    }
  }

  // Always poll for fresh `contract_initialized` events from contracts
  // outside the watched set. This is the event-driven new-council
  // discovery path — the listener no longer gates on a WASM-hash
  // registry, so local-dev environments without GitHub access for the
  // soroban-core releases listing still discover new councils as they
  // deploy.
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
    log.error(err, "Soroban poll (contract_initialized) failed");
  }

  for (const processed of processRawEventBatch(rawBatch, log)) {
    publishMappedEvent(
      processed.event,
      processed.ledgerClosedAtMs,
      deps.bus,
      log,
    );
  }
  for (const cid of unknownCandidates) {
    evaluateUnknownContract(cid, startLedger, deps);
  }
  // Refresh topology once if there's anything pending, then adopt
  // (or cache as not-ours) each unknown. On adoption, back-fill from the
  // earliest observed-at-ledger across the freshly-adopted contracts so
  // events emitted between deploy and adoption (e.g. provider_added) are
  // still published live.
  drainPendingAdoptions({
    ...deps,
    backfillFromLedger,
  }).catch((err) => {
    log.error(err, "drainPendingAdoptions failed");
  });
  lastLedgerSeen = nextLastLedger;
}

function scheduleNext(deps: { log: Logger; bus: NetworkEventBus }): void {
  if (!running) return;
  pollTimer = setTimeout(async () => {
    await pollTick(deps);
    scheduleNext(deps);
  }, POLL_INTERVAL_MS) as unknown as number;
}

export function startSorobanWatcher(
  deps: { log: Logger; bus: NetworkEventBus },
): void {
  if (running) return;
  running = true;
  const log = deps.log.scope("sorobanWatcher");
  log.debug("intervalMs", POLL_INTERVAL_MS);
  log.debug("lastLedgerSeen", lastLedgerSeen);
  log.event("soroban watcher started");
  scheduleNext(deps);
}

export function stopSorobanWatcher(deps: { log: Logger }): void {
  running = false;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  deps.log.scope("sorobanWatcher").event("soroban watcher stopped");
}

/** Re-anchor the rolling 24h counter window after the hourly re-sync. */
export async function rescanRollingWindow(
  deps: { log: Logger; bus: NetworkEventBus },
): Promise<void> {
  await coldStartScan(deps);
}

/**
 * Back-fill scan invoked after a newly-discovered Channel Auth contract is
 * adopted into the topology. Walks the current `watchedContractIds()` set
 * from `fromLedger` forward, maps each event, and publishes via the bus.
 * Dedup is handled by `networkState.recordEvent` in `publishMappedEvent` —
 * events the forward poller has already published are skipped, so calling
 * this concurrently with `pollTick` is safe.
 *
 * The scan covers ALL watched contracts (not just the newly-adopted ones)
 * because some events involving a fresh council fire on a SHARED contract
 * — e.g. the XLM SAC `transfer` and `fee` events fan out across every
 * council and need to be mapped via the contract-id linkage that
 * `refreshTopology` just installed.
 */
export async function backfillFromLedger(
  fromLedger: number,
  deps: { log: Logger; bus: NetworkEventBus },
): Promise<void> {
  const log = deps.log.scope("backfillFromLedger");
  log.info("backfillFromLedger");
  log.debug("fromLedger", fromLedger);

  const contractIds = watchedContractIds();
  if (contractIds.length === 0) {
    log.event("back-fill skipped — no contracts watched");
    return;
  }

  const server = getServer();
  const rawBatch: RawChainEvent[] = [];
  for (const chunk of chunkContractIds(contractIds)) {
    let nextLedger = fromLedger;
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
        log.debug("chunkSize", chunk.length);
        log.debug("startLedger", nextLedger);
        log.error(err, "back-fill page failed");
        break;
      }
      page++;
      for (const ev of res.events) {
        rawBatch.push({
          id: ev.id,
          contractId: ev.contractId?.toString() ?? "",
          ledger: ev.ledger,
          topics: ev.topic,
          value: ev.value,
          txHash: ev.txHash ?? "",
          ledgerClosedAtMs: parseLedgerClosedAt(ev.ledgerClosedAt),
        });
      }
      if (res.events.length < PAGE_LIMIT) break;
      nextLedger = res.events[res.events.length - 1].ledger + 1;
      if (page >= 50) {
        log.debug("eventsSoFar", rawBatch.length);
        log.event("back-fill page cap (50) reached for chunk; stopping");
        break;
      }
    }
  }

  rawBatch.sort((a, b) => a.ledger - b.ledger);
  log.debug("rawCount", rawBatch.length);
  for (const processed of processRawEventBatch(rawBatch, log)) {
    publishMappedEvent(
      processed.event,
      processed.ledgerClosedAtMs,
      deps.bus,
      log,
    );
  }
  log.event("back-fill scan complete");
}
