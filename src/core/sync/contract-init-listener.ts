import type { Logger } from "@/utils/logger/index.ts";
import { networkState } from "@/core/state/store.ts";
import { refreshTopology } from "./topology-refresh.ts";
import type { NetworkEventBus } from "@/core/events/bus.ts";

/**
 * Discover new Channel Auth deploys via Soroban `contract_initialized`
 * events from contractIds the watcher does not yet know about.
 *
 * Flow:
 *   1. The watcher's `pollTick` accumulates contractIds that emitted
 *      `contract_initialized` but are not in `watchedContractIds()`.
 *   2. Each unknown is registered via `evaluateUnknownContract`; once
 *      per tick the watcher calls `drainPendingAdoptions`, which fires
 *      ONE `refreshTopology` for the whole batch.
 *   3. After the refresh, any unknown that council-platform now
 *      acknowledges is adopted into `networkState` and the next poll
 *      tick will start watching its contracts. Unknowns that
 *      council-platform doesn't recognise are cached in `notMoonlight`
 *      so a chatty unrelated contract can't drag us into repeated
 *      topology refreshes.
 *
 * This is the event-driven analogue of `provider-platform`'s
 * `addCouncilWatcher` hot-path: chain events trigger an immediate state
 * update, no periodic re-sync required. The previous WASM-hash gate is
 * gone — local-dev environments without GitHub access for the
 * soroban-core releases listing no longer no-op silently.
 */

/**
 * `contract_initialized` fires at deploy time, which precedes the
 * council-platform `PUT /council/metadata` call by some window — script
 * flows register within seconds, but a HUMAN-driven flow (console/CLI,
 * the mainnet demo path) can take many minutes. We keep an unknown
 * contract in `pendingAdoption` for up to PENDING_TTL_MS so a council
 * registered well after its on-chain deploy still gets adopted (adoption
 * is what triggers the historical back-fill; the periodic topology
 * re-sync would surface the council's topology either way, but not its
 * pre-adoption events). Past the TTL we cache as notMoonlight so an
 * unrelated contract doesn't stay pending forever. The previous 120s TTL
 * permanently blacklisted the mainnet demo councils — their platform
 * registration landed minutes after deploy.
 *
 * Refreshes for pending unknowns are throttled to REFRESH_MIN_INTERVAL_MS
 * (except when a NEW unknown just arrived, which refreshes immediately) so
 * a chatty unrelated contract costs at most a couple of council-platform
 * fetches per minute during its pending hour.
 */
const PENDING_TTL_MS = 60 * 60 * 1000;
const REFRESH_MIN_INTERVAL_MS = 30_000;

interface PendingEntry {
  firstSeenMs: number;
  /** Ledger the contract_initialized event was observed in — back-fill start. */
  observedAtLedger: number;
}

const notMoonlight = new Set<string>();
const pendingAdoption = new Map<string, PendingEntry>();
/** Set when an unknown was JUST registered — bypasses the refresh throttle. */
let hasFreshPending = false;
let lastPendingRefreshMs = 0;

/**
 * Soroban event filter pattern matching `contract_initialized` events with
 * 2 topics: the `Symbol("contract_initialized")` itself plus an arbitrary
 * second topic (Channel Auth emits the admin address there). Soroban's
 * topic filter is exact-length positional, so the wildcard slot is what
 * lets the same matcher catch any deployer address.
 *
 * If a future Channel Auth release emits a different topic count, add a
 * second pattern to the watcher's filter array.
 */
import { xdr } from "stellar-sdk";
export const CONTRACT_INITIALIZED_TOPIC_PATTERN: string[] = [
  xdr.ScVal.scvSymbol("contract_initialized").toXDR("base64"),
  "*",
];

/**
 * Register a fresh `contract_initialized` from a contractId the watcher
 * doesn't already track. Idempotent — repeated registrations of the same
 * id are coalesced into a single pending adoption.
 */
export function evaluateUnknownContract(
  contractId: string,
  observedAtLedger: number,
  deps: { log: Logger },
): void {
  const log = deps.log.scope("evaluateUnknownContract");
  log.info("evaluateUnknownContract");
  log.debug("contractId", contractId);
  log.debug("observedAtLedger", observedAtLedger);

  if (!contractId) return;
  if (pendingAdoption.has(contractId)) return;
  if (notMoonlight.has(contractId)) return;
  if (networkState.hasCouncil(contractId)) return;

  pendingAdoption.set(contractId, {
    firstSeenMs: Date.now(),
    observedAtLedger,
  });
  hasFreshPending = true;
  log.event("registered unknown contractId for topology adoption");
}

/**
 * Refresh topology if we have unknowns; for each pending id, either
 * adopt it (council-platform now recognises it) or cache as not-ours.
 * Called once per poll tick after `evaluateUnknownContract` registrations.
 */
export async function drainPendingAdoptions(
  deps: {
    log: Logger;
    bus: NetworkEventBus;
    /**
     * Back-fill scan invoked once per newly-adopted contract: walks the
     * council's contractIds from `fromLedger` to current head and publishes
     * each mapped event on the bus. Lets us catch on-chain events emitted
     * BEFORE adoption (e.g. `provider_added` fires several seconds before
     * council-platform learns about the deploy).
     */
    backfillFromLedger: (
      fromLedger: number,
      deps: { log: Logger; bus: NetworkEventBus },
    ) => Promise<void>;
  },
): Promise<void> {
  if (pendingAdoption.size === 0) return;
  const log = deps.log.scope("drainPendingAdoptions");
  log.info("drainPendingAdoptions");
  log.debug("pendingCount", pendingAdoption.size);

  // Refresh immediately for a brand-new unknown (fast adoption of real
  // councils); otherwise throttle — the periodic topology re-sync also
  // updates `networkState`, so waiting pendings still get their
  // `hasCouncil` check against fresh state below.
  const refreshNow = hasFreshPending ||
    Date.now() - lastPendingRefreshMs >= REFRESH_MIN_INTERVAL_MS;
  if (refreshNow) {
    hasFreshPending = false;
    lastPendingRefreshMs = Date.now();
    await refreshTopology(`pending=${pendingAdoption.size}`, deps);
  }

  const now = Date.now();
  /** Earliest observed ledger across freshly-adopted contracts in this drain pass. */
  let minAdoptedLedger: number | null = null;

  for (const [cid, entry] of pendingAdoption) {
    if (networkState.hasCouncil(cid)) {
      pendingAdoption.delete(cid);
      log.debug("contractId", cid);
      log.event("contractId adopted into topology");
      if (
        minAdoptedLedger === null || entry.observedAtLedger < minAdoptedLedger
      ) {
        minAdoptedLedger = entry.observedAtLedger;
      }
    } else if (now - entry.firstSeenMs > PENDING_TTL_MS) {
      pendingAdoption.delete(cid);
      notMoonlight.add(cid);
      log.debug("contractId", cid);
      log.event(
        "PENDING_TTL exceeded without council-platform recognition; caching as notMoonlight",
      );
    }
    // else keep waiting — council-platform may register it shortly
  }

  if (minAdoptedLedger !== null) {
    log.debug("backfillFromLedger", minAdoptedLedger);
    log.event("back-fill scan starting for freshly-adopted contracts");
    try {
      await deps.backfillFromLedger(minAdoptedLedger, {
        log: deps.log,
        bus: deps.bus,
      });
    } catch (err) {
      log.error(err, "back-fill scan failed");
    }
  }
}

/** Test-only seam to drop cached decisions between unit tests. */
export function __resetForTests(): void {
  notMoonlight.clear();
  pendingAdoption.clear();
  hasFreshPending = false;
  lastPendingRefreshMs = 0;
}
