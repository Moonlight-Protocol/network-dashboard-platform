import { Server } from "stellar-sdk/rpc";
import type { Api } from "stellar-sdk/rpc";
import { Address, xdr } from "stellar-sdk";
import type { Logger } from "@/utils/logger/index.ts";
import { getStellarRpcUrl } from "@/config/env.ts";
import { networkState } from "@/core/state/store.ts";
import type { NetworkEventBus } from "@/core/events/bus.ts";
import { mapChainEvent, type RawChainEvent } from "./event-mapper.ts";
import {
  CONTRACT_INITIALIZED_TOPIC_PATTERN,
  drainPendingAdoptions,
  evaluateUnknownContract,
} from "./contract-init-listener.ts";
import { refreshTopology } from "./topology-refresh.ts";

const POLL_INTERVAL_MS = 5_000;
const LOOKBACK_LEDGERS_24H = 17_280; // ~5s ledgers × 24h
const PAGE_LIMIT = 100;
/** Soroban RPC caps `contractIds` per filter (5 in stellar-soroban-rpc). */
const MAX_CONTRACT_IDS_PER_FILTER = 5;
/** Soroban RPC caps topic patterns per filter (5). */
const MAX_TOPIC_PATTERNS_PER_FILTER = 5;
/**
 * Ledger span per windowed getEvents request. RPC providers bound the
 * work a single request may do — Quasar returns `-32001 request exceeded
 * processing limit threshold` on wide scans, and the cost multiplies per
 * FILTER in the call (a combined councils+SAC call failed at a 2 000
 * window where each filter alone handles 4 000+; measured on mainnet).
 * Hence one filter per call, `endLedger`-bounded windows, and halving on
 * a processing-limit rejection down to MIN_SCAN_WINDOW_LEDGERS.
 */
const INITIAL_SCAN_WINDOW_LEDGERS = 4_000;
const MIN_SCAN_WINDOW_LEDGERS = 250;
/**
 * Per-call request budget for one forward-poll tick. A tick normally
 * resumes at the head cursor and drains in a single request; the budget
 * only matters when catching up after degradation (windowed walk: ~5
 * requests per 24h of gap). On exhaustion the drain stops at a safe
 * cursor and the next tick resumes from it — nothing is skipped.
 */
const FORWARD_REQUEST_CAP = 20;
/**
 * Per-call request budget for the cold-start / back-fill walks. This is
 * a runaway guard, not a coverage bound: a sparse 24h walk costs ~5
 * windowed requests, so 200 covers pathological density and window
 * halving. When it fires we log loudly — anything past the cap is left
 * for the forward poll to pick up from the returned cursor.
 */
const SCAN_REQUEST_CAP = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** RPC client — picked up from env via the lazy getter so tests can stub. */
let rpcServer: Server | null = null;
function getServer(): Server {
  if (!rpcServer) {
    const url = getStellarRpcUrl();
    rpcServer = new Server(url, {
      allowHttp: url.startsWith("http://"),
    });
  }
  return rpcServer;
}

/**
 * Forward-poll position. `lastCursor` is the RPC event cursor everything
 * up to which has been consumed — the resume point for the next tick.
 * `lastLedgerSeen` tracks the RPC head for /health (`armed`) and as the
 * startLedger fallback when no cursor exists yet (fresh boot with a
 * failed cold-start scan).
 */
let lastCursor: string | null = null;
let lastLedgerSeen: number | null = null;
let pollTimer: number | null = null;
let running = false;
/**
 * Consecutive `pollTick`s that found the watcher armed (`running`) but with no
 * forward position (`lastCursor` and `lastLedgerSeen` both null). This is the
 * "stranded" state: `bootstrap()` swallows a failed `coldStartScan` and starts
 * the watcher anyway, so the poll then no-ops silently forever — the dashboard
 * freezes with a green `/health` and no logs. Tracked so the strand is
 * observable (loud log + `/health`) instead of invisible. Reset to 0 on any
 * armed tick.
 */
let strandedTickCount = 0;

// ── event query specs ─────────────────────────────────────────────────

const TRANSFER_TOPIC = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
const FEE_TOPIC = xdr.ScVal.scvSymbol("fee").toXDR("base64");

/** Address → base64 ScVal XDR, cached (topology entries repeat every tick). */
const addressTopicCache = new Map<string, string>();
function addressTopic(address: string): string {
  let encoded = addressTopicCache.get(address);
  if (!encoded) {
    encoded = new Address(address).toScVal().toXDR("base64");
    addressTopicCache.set(address, encoded);
  }
  return encoded;
}

export type WatchQueryCall = {
  label: string;
  filter: Api.EventFilter;
};

/**
 * Build the getEvents subscriptions for the current topology — ONE filter
 * per call, because the RPC's per-request processing limit multiplies with
 * each filter in a call (see INITIAL_SCAN_WINDOW_LEDGERS).
 *
 * Channel Auth (council) contracts are low-volume, so they get plain
 * contractIds filters. SAC contracts are NOT watched raw: the mainnet
 * XLM SAC emits hundreds of `transfer`/`fee` events per LEDGER, which
 * drowned any unfiltered subscription (a 100-event page didn't even span
 * one ledger). Instead we subscribe by topic:
 *
 *   - deposit:    ["transfer", *, <channel address>, *]
 *   - settlement: ["transfer", <channel address>, *, *]
 *   - bundle fee: ["fee", <PP public key>]
 *
 * Topic filters are exact-length positional (SAC `transfer` carries 4
 * topics, `fee` carries 2 — verified against mainnet), so each pattern
 * matches only its event shape. Within a filter the patterns are OR'd;
 * RPC caps (5 contractIds / 5 patterns per filter) drive the chunking.
 */
export function buildWatchQueryCalls(): WatchQueryCall[] {
  const councilIds = [...networkState.getCouncilIds()].sort();
  const channelIds = [...networkState.getChannelContractIds()].sort();
  const sacIds = [...networkState.getAssetContractIds()].sort();
  const providerKeys = [...networkState.getProviderPublicKeys()].sort();

  const filters: Api.EventFilter[] = [];
  for (const ids of chunk(councilIds, MAX_CONTRACT_IDS_PER_FILTER)) {
    filters.push({ type: "contract", contractIds: ids });
  }

  const patterns: string[][] = [];
  for (const channel of channelIds) {
    patterns.push([TRANSFER_TOPIC, "*", addressTopic(channel), "*"]);
    patterns.push([TRANSFER_TOPIC, addressTopic(channel), "*", "*"]);
  }
  for (const pp of providerKeys) {
    patterns.push([FEE_TOPIC, addressTopic(pp)]);
  }
  if (sacIds.length > 0 && patterns.length > 0) {
    for (const sacs of chunk(sacIds, MAX_CONTRACT_IDS_PER_FILTER)) {
      for (const pats of chunk(patterns, MAX_TOPIC_PATTERNS_PER_FILTER)) {
        filters.push({ type: "contract", contractIds: sacs, topics: pats });
      }
    }
  }

  return filters.map((filter, i) => ({ label: `watch:${i}`, filter }));
}

// ── cursor-paged drain ────────────────────────────────────────────────

export type DrainOutcome = {
  raws: RawChainEvent[];
  /**
   * RPC cursor after the last consumed page. Everything at or before it
   * has been returned in `raws`, so advancing the poll position to it
   * never skips an event. Null when not even the first page succeeded.
   */
  cursor: string | null;
  latestLedger: number | null;
  /** True when the drain reached the RPC head (a partial page). */
  complete: boolean;
};

function toRawChainEvent(ev: Api.EventResponse): RawChainEvent {
  return {
    id: ev.id,
    contractId: ev.contractId?.toString() ?? "",
    ledger: ev.ledger,
    topics: ev.topic,
    value: ev.value,
    txHash: ev.txHash ?? "",
    ledgerClosedAtMs: parseLedgerClosedAt(ev.ledgerClosedAt),
  };
}

/** Ledger encoded in an RPC event cursor (`<toid>-<eventIndex>`). */
export function ledgerOfCursor(cursor: string): number {
  return Number(BigInt(cursor.split("-")[0]) >> 32n);
}

/**
 * Message of a getEvents failure. The SDK's JSON-RPC layer throws the raw
 * `{code, message}` error object (not an Error), which stringifies to
 * `[object Object]` — extract the message so error classification and
 * logs stay useful.
 */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** Quasar rejects over-wide scans with `-32001 ... processing limit`. */
function isProcessingLimit(err: unknown): boolean {
  return /processing limit/i.test(errMessage(err));
}

/**
 * Page through getEvents from `base` until the RPC head or the request
 * budget. Two RPC behaviours shape the loop (both measured on mainnet
 * Quasar):
 *
 *   - A response may cover only a SLICE of the requested range (bounded
 *     scan work), returning a partial/empty page whose cursor sits well
 *     below `latestLedger`. "Partial page" therefore does NOT mean
 *     "caught up" — head is reached only when the cursor's ledger
 *     reaches `latestLedger`.
 *   - An over-wide request fails outright with a processing-limit error
 *     instead of slicing. Sparse stretches are walked with
 *     `endLedger`-bounded windows (halved on rejection); a full page
 *     switches to cursor continuation, which resumes mid-ledger and
 *     stops cheaply at the page limit.
 *
 * Consumption is gap-free: every position advance is either the RPC's own
 * scan cursor or `scannedTo + 1`. A processing-limit rejection of a
 * cursor request falls back to a window starting at the cursor's ledger
 * (re-reading that ledger's tail; dedup by event id absorbs it).
 */
export async function drainEvents(
  base: { startLedger: number } | { cursor: string },
  filters: Api.EventFilter[],
  requestCap: number,
  log: Logger,
): Promise<DrainOutcome> {
  const server = getServer();
  const out: DrainOutcome = {
    raws: [],
    cursor: null,
    latestLedger: null,
    complete: false,
  };
  let position: { startLedger: number } | { cursor: string } = base;
  let window = INITIAL_SCAN_WINDOW_LEDGERS;
  let retriedAtFloor = false;

  for (let requests = 0; requests < requestCap; requests++) {
    const request: Api.GetEventsRequest = "cursor" in position
      ? { cursor: position.cursor, filters, limit: PAGE_LIMIT }
      : {
        startLedger: position.startLedger,
        endLedger: position.startLedger + window - 1,
        filters,
        limit: PAGE_LIMIT,
      };
    let res: Api.GetEventsResponse;
    try {
      res = await server.getEvents(request);
    } catch (err) {
      if (isProcessingLimit(err)) {
        if ("cursor" in position) {
          // Cursor scans carry no endLedger bound; re-anchor to a window.
          position = { startLedger: ledgerOfCursor(position.cursor) };
          continue;
        }
        if (window > MIN_SCAN_WINDOW_LEDGERS) {
          window = Math.max(MIN_SCAN_WINDOW_LEDGERS, Math.floor(window / 2));
          log.debug("window", window);
          log.event("processing-limit rejection; halving scan window");
          continue;
        }
      }
      if (!retriedAtFloor && "startLedger" in position) {
        const floor = parseValidRangeFloor(err);
        if (floor !== null && floor > position.startLedger) {
          retriedAtFloor = true;
          log.debug("requestedStartLedger", position.startLedger);
          log.debug("retentionFloor", floor);
          log.event("startLedger below retention; retrying at floor");
          position = { startLedger: floor };
          continue;
        }
      }
      log.debug("requests", requests);
      log.error(
        new Error(errMessage(err)),
        "getEvents failed (drain incomplete)",
      );
      return out;
    }

    out.cursor = res.cursor;
    out.latestLedger = res.latestLedger;
    for (const ev of res.events) {
      out.raws.push(toRawChainEvent(ev));
    }

    if (res.events.length === PAGE_LIMIT) {
      // Dense stretch — continue mid-ledger from the exact cursor.
      position = { cursor: res.cursor };
      continue;
    }
    const scannedTo = ledgerOfCursor(res.cursor);
    if (scannedTo >= res.latestLedger) {
      out.complete = true;
      return out;
    }
    // Partial/empty page below head: the RPC bounded its scan (or our
    // window ended) — step the window forward from where scanning stopped.
    position = { startLedger: scannedTo + 1 };
  }

  log.debug("requestCap", requestCap);
  log.debug("eventsDrained", out.raws.length);
  log.event(
    "drain hit request cap before reaching head; resuming from cursor next pass",
  );
  return out;
}

/**
 * Numeric compare of RPC event cursors (`<toid>-<eventIndex>`). Used to
 * advance the shared poll position to the LOWEST drain point across the
 * tick's calls — never past a call that consumed less. The overlap this
 * re-reads on the faster calls is deduped by event id in the store.
 */
export function minCursor(cursors: string[]): string | null {
  let min: string | null = null;
  let minParts: [bigint, bigint] | null = null;
  for (const c of cursors) {
    const [a, b] = c.split("-");
    const parts: [bigint, bigint] = [BigInt(a), BigInt(b ?? "0")];
    if (
      minParts === null ||
      parts[0] < minParts[0] ||
      (parts[0] === minParts[0] && parts[1] < minParts[1])
    ) {
      min = c;
      minParts = parts;
    }
  }
  return min;
}

export function publishMappedEvent(
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
    // Channels have NO chain event analogue to `provider_added` — the
    // privacy_channel contract emits nothing on construction and channel
    // registration is a council-platform-only DB operation
    // (POST /council/channels). `add_provider` on-chain is a deterministic
    // signal that council-platform has the council's channels persisted by
    // now (the flow always adds channels before any PP can join), so
    // piggyback a topology refresh here for a fast channel-linkage update;
    // the periodic re-sync (scheduler) is the completeness backstop.
    // `refreshTopology` is single-flight (topology-refresh.ts) so
    // concurrent fires coalesce. Fire-and-forget; failures log inside.
    refreshTopology(`provider_added:${event.councilId}`, { log, bus }).catch(
      (err) => log.error(err, "refreshTopology on provider_added failed"),
    );
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
  const match = errMessage(err).match(/ledger range:\s*(\d+)\s*-\s*\d+/);
  return match ? Number(match[1]) : null;
}

/**
 * Cold-start scan: walk trailing 24h on the current subscription set,
 * map events, and seed the rolling window + ring buffer in chronological
 * order. Arms the forward poller with the drain cursor (or, degraded,
 * the head ledger).
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
  // 0 events without erroring on some providers, so probe with
  // progressively smaller lookbacks until events appear. Long-retention
  // providers (testnet / mainnet) typically return events on the first
  // try; the quickstart container needs a closer startLedger. (Providers
  // that ERROR below the floor instead are handled by the drain's
  // retry-at-floor.)
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

  // Arm the forward poller up front so a scan failure doesn't strand it.
  lastLedgerSeen = latest.sequence;

  const calls = buildWatchQueryCalls();
  if (calls.length === 0) {
    log.debug("latestLedger", latest.sequence);
    log.event(
      "cold-start scan skipped — no contracts to watch yet (no councils registered)",
    );
    return;
  }

  log.debug("startLedger", initialStart);
  log.debug("latestLedger", latest.sequence);
  log.debug("callCount", calls.length);
  log.event("cold-start scan starting");

  const rawBatch: RawChainEvent[] = [];
  const advances: (string | null)[] = [];
  for (const call of calls) {
    const drained = await drainEvents(
      { startLedger: initialStart },
      [call.filter],
      SCAN_REQUEST_CAP,
      log.scope(call.label),
    );
    rawBatch.push(...drained.raws);
    advances.push(drained.cursor);
    if (drained.latestLedger !== null) {
      lastLedgerSeen = Math.max(lastLedgerSeen, drained.latestLedger);
    }
  }

  // Process the whole accumulated batch with per-tx dedup, then seed.
  // Back-fill records carry null latency — the store only computes the
  // avg-latency counter from live observations. Per-call drains return
  // events grouped per call, so re-sort by ledger here to keep the
  // ring-buffer chronological.
  rawBatch.sort((a, b) => a.ledger - b.ledger);
  const chronological = processRawEventBatch(rawBatch, log).map((p) => p.event);
  networkState.seedWindow(chronological);
  // Recent ring buffer: keep newest at index 0.
  const newestFirst = [...chronological].reverse();
  networkState.seedRecent(newestFirst);

  if (advances.length > 0 && advances.every((c) => c !== null)) {
    lastCursor = minCursor(advances as string[]);
  } else {
    // A call failed before its first page: no gap-free cursor exists, so
    // the forward poll starts at head (lastLedgerSeen + 1). Loud — the
    // window between the failed call's coverage and head is lost.
    log.event(
      "cold-start drain incomplete; forward poll starts at head (some history may be missing)",
    );
  }

  log.debug("eventsSeeded", chronological.length);
  log.debug("lastCursor", lastCursor);
  log.debug("lastLedgerSeen", lastLedgerSeen);
  log.event("cold-start scan complete");
}

async function pollTick(
  deps: { log: Logger; bus: NetworkEventBus },
): Promise<void> {
  if (!running) return;
  if (lastCursor === null && lastLedgerSeen === null) {
    // Armed but no position — cold-start threw before establishing one
    // (its error is caught + swallowed in `bootstrap()`) yet the watcher
    // was started. Every tick then no-ops SILENTLY, freezing the dashboard
    // while `/health` stays green. Make it loud (rate-limited to
    // ~once/5min at a 5s interval) and observable via `getWatcherHealth()`
    // so the strand surfaces instead of hiding.
    strandedTickCount += 1;
    if (strandedTickCount === 1 || strandedTickCount % 60 === 0) {
      deps.log.scope("pollTick").error(
        new Error("forward poller stranded: no cursor and no ledger position"),
        "watcher armed but has no position — cold-start did not complete; NO events will be ingested until cold-start succeeds (restart/redeploy)",
      );
    }
    return;
  }
  strandedTickCount = 0;
  const log = deps.log.scope("pollTick");

  const base: { startLedger: number } | { cursor: string } = lastCursor !== null
    ? { cursor: lastCursor }
    : { startLedger: (lastLedgerSeen as number) + 1 };

  const rawBatch: RawChainEvent[] = [];
  const advances: (string | null)[] = [];

  // Known-topology subscriptions (councils by contractId, SAC by topic).
  for (const call of buildWatchQueryCalls()) {
    const drained = await drainEvents(
      base,
      [call.filter],
      FORWARD_REQUEST_CAP,
      log.scope(call.label),
    );
    rawBatch.push(...drained.raws);
    advances.push(drained.cursor);
    if (drained.latestLedger !== null) {
      lastLedgerSeen = Math.max(lastLedgerSeen ?? 0, drained.latestLedger);
    }
  }

  // Network-wide `contract_initialized` poll for new-council discovery —
  // contracts outside the subscription set feed the adoption pipeline.
  const discovery = await drainEvents(
    base,
    [{ type: "contract", topics: [CONTRACT_INITIALIZED_TOPIC_PATTERN] }],
    FORWARD_REQUEST_CAP,
    log.scope("discovery"),
  );
  advances.push(discovery.cursor);
  if (discovery.latestLedger !== null) {
    lastLedgerSeen = Math.max(lastLedgerSeen ?? 0, discovery.latestLedger);
  }
  for (const raw of discovery.raws) {
    // Already-known councils are handled by the subscription calls above
    // (which carry full event data); skip the duplicate.
    if (!raw.contractId) continue;
    if (networkState.hasCouncil(raw.contractId)) continue;
    evaluateUnknownContract(raw.contractId, raw.ledger, deps);
  }

  rawBatch.sort((a, b) => a.ledger - b.ledger);
  for (const processed of processRawEventBatch(rawBatch, log)) {
    publishMappedEvent(
      processed.event,
      processed.ledgerClosedAtMs,
      deps.bus,
      log,
    );
  }
  // Refresh topology if there's anything pending, then adopt (or cache as
  // not-ours) each unknown. On adoption, back-fill from the earliest
  // observed-at-ledger across the freshly-adopted contracts so events
  // emitted between deploy and adoption (e.g. provider_added) are still
  // published live.
  drainPendingAdoptions({
    ...deps,
    backfillFromLedger,
  }).catch((err) => {
    log.error(err, "drainPendingAdoptions failed");
  });

  // Advance the shared position to the lowest safe cursor across all
  // calls — never past a call that consumed less, and not at all if any
  // call failed outright (its events would be skipped). Re-reads on the
  // faster calls are deduped by event id in the store.
  if (advances.length > 0 && advances.every((c) => c !== null)) {
    lastCursor = minCursor(advances as string[]);
  }
}

function scheduleNext(deps: { log: Logger; bus: NetworkEventBus }): void {
  if (!running) return;
  pollTimer = setTimeout(async () => {
    await pollTick(deps);
    scheduleNext(deps);
  }, POLL_INTERVAL_MS) as unknown as number;
}

/**
 * Liveness snapshot of the forward poller for `/health`.
 *
 * `running && !armed` is the stranded state (cold-start failed, watcher
 * started with no forward position) — the poller ingests nothing. Surfacing
 * it lets `/health` report degraded so the strand is caught by monitoring /
 * the Fly health check instead of silently freezing the dashboard for weeks.
 */
export function getWatcherHealth(): {
  running: boolean;
  armed: boolean;
  strandedTickCount: number;
} {
  return {
    running,
    armed: lastCursor !== null || lastLedgerSeen !== null,
    strandedTickCount,
  };
}

export function startSorobanWatcher(
  deps: { log: Logger; bus: NetworkEventBus },
): void {
  if (running) return;
  running = true;
  const log = deps.log.scope("sorobanWatcher");
  log.debug("intervalMs", POLL_INTERVAL_MS);
  log.debug("lastCursor", lastCursor);
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

/**
 * Back-fill scan invoked after a newly-discovered Channel Auth contract is
 * adopted into the topology. Walks the current subscription set from
 * `fromLedger` forward, maps each event, and publishes via the bus.
 * Dedup is handled by `networkState.recordEvent` in `publishMappedEvent` —
 * events the forward poller has already published are skipped, so calling
 * this concurrently with `pollTick` is safe.
 *
 * The scan covers the WHOLE subscription set (not just the newly-adopted
 * council) because some events involving a fresh council fire on a SHARED
 * contract — e.g. the XLM SAC `transfer`/`fee` events are matched via the
 * channel/PP topic patterns that `refreshTopology` just installed.
 */
export async function backfillFromLedger(
  fromLedger: number,
  deps: { log: Logger; bus: NetworkEventBus },
): Promise<void> {
  const log = deps.log.scope("backfillFromLedger");
  log.info("backfillFromLedger");
  log.debug("fromLedger", fromLedger);

  const calls = buildWatchQueryCalls();
  if (calls.length === 0) {
    log.event("back-fill skipped — no contracts watched");
    return;
  }

  const rawBatch: RawChainEvent[] = [];
  for (const call of calls) {
    const drained = await drainEvents(
      { startLedger: fromLedger },
      [call.filter],
      SCAN_REQUEST_CAP,
      log.scope(call.label),
    );
    rawBatch.push(...drained.raws);
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

/** Test-only seams. */
export function __setServerForTests(server: Server | null): void {
  rpcServer = server;
}

export function __resetWatcherStateForTests(): void {
  lastCursor = null;
  lastLedgerSeen = null;
  strandedTickCount = 0;
  addressTopicCache.clear();
}
