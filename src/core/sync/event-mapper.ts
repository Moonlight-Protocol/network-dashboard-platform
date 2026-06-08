import { Address, type xdr } from "stellar-sdk";
import { networkState } from "@/core/state/store.ts";
import type { NetworkEvent, NetworkEventKind } from "@/core/events/types.ts";

/**
 * Raw event we accept from the Soroban watcher — a normalized projection
 * of `rpc.Server.getEvents` output. We carry both topics + values as
 * decoded XDR ScVals so mappers can inspect kind-specific structure.
 */
export type RawChainEvent = {
  /**
   * Soroban's own event id (e.g. "0000000123-0000000001"). Stable across
   * live-poll vs cold-start observations of the same on-chain event, so
   * downstream dedup actually works.
   */
  id: string;
  contractId: string;
  ledger: number;
  /** Topics as raw ScVals (preserve XDR fidelity for value decoding). */
  topics: xdr.ScVal[];
  /** The event value (also a ScVal). */
  value: xdr.ScVal;
  /** Soroban transaction hash — used to dedupe per-tx fee fan-out. */
  txHash: string;
  /**
   * Ledger close time in ms (when Soroban verified the transaction on-chain).
   * Null when the watcher couldn't extract it (older SDK responses or
   * cold-start back-fill). Drives the submitted→verified latency metric.
   */
  ledgerClosedAtMs: number | null;
};

const COUNCIL_TOPICS = new Set([
  "contract_initialized",
  "provider_added",
  "provider_removed",
]);

const SAC_TRANSFER_TOPIC = "transfer";
/**
 * SAC `fee` events fire once per bundle execution and the `from` topic
 * carries the executing PP's address. Used to surface bundle activity on
 * the dashboard without compromising the privacy of the internal sender
 * and receiver.
 */
const SAC_FEE_TOPIC = "fee";

function decodeSymbol(val: xdr.ScVal): string | null {
  return val.switch().name === "scvSymbol" ? val.sym().toString() : null;
}

function decodeAddress(val: xdr.ScVal): string | null {
  try {
    return Address.fromScVal(val).toString();
  } catch {
    return null;
  }
}

function decodeI128(val: xdr.ScVal): string | null {
  if (val.switch().name !== "scvI128") return null;
  const parts = val.i128();
  const hi = parts.hi().toString();
  const lo = parts.lo().toString();
  // Best-effort string representation; full i128 math isn't needed for
  // a display-layer ticker.
  if (hi === "0") return lo;
  return `${hi}:${lo}`;
}

/**
 * Translate a raw Soroban event into a NetworkEvent (or null if the event
 * is irrelevant to the dashboard). The mapper consults the in-memory
 * linkage maps to resolve SAC↔council and channel↔council.
 *
 * `now` is injectable for tests; defaults to `new Date()`.
 */
export function mapChainEvent(
  raw: RawChainEvent,
  now: Date = new Date(),
): NetworkEvent | null {
  if (raw.topics.length === 0) return null;
  const topicSymbol = decodeSymbol(raw.topics[0]);
  if (!topicSymbol) return null;

  if (COUNCIL_TOPICS.has(topicSymbol)) {
    return mapCouncilEvent(raw, topicSymbol, now);
  }
  if (topicSymbol === SAC_TRANSFER_TOPIC) {
    return mapSacTransferEvent(raw, now);
  }
  if (topicSymbol === SAC_FEE_TOPIC) {
    return mapSacFeeEvent(raw, now);
  }
  return null;
}

/**
 * SAC fee events fire on every bundle execution. We surface them as
 * `channel_bundle` only when the payer is a known PP — that filters out
 * unrelated fee activity (admin/friendbot/etc.). Attribution is to the
 * PP's council, not the SAC's.
 *
 * We deliberately do NOT look up the council via the SAC contract. Assets
 * are shared across councils — every council on a given network registers
 * the same native XLM SAC, and `assetContractToCouncil` is a
 * `Map<string, string>` whose last-write-wins overwrite silently drops the
 * `channel_bundle` for every council except whichever one was iterated
 * last in `replaceTopology`. The PP-side resolver is the precise filter:
 * if the payer is a registered PP, this fee is from that PP's bundle on
 * that PP's council, full stop.
 */
function mapSacFeeEvent(raw: RawChainEvent, now: Date): NetworkEvent | null {
  if (raw.topics.length < 2) return null;
  const payer = decodeAddress(raw.topics[1]);
  if (!payer) return null;
  const ppCouncilId = networkState.resolveProviderToCouncil(payer);
  if (!ppCouncilId) return null;
  return makeEvent(
    "channel_bundle",
    ppCouncilId,
    networkState.getCouncilName(ppCouncilId),
    raw,
    now,
    { providerPublicKey: payer, assetContractId: raw.contractId },
  );
}

function mapCouncilEvent(
  raw: RawChainEvent,
  topicSymbol: string,
  now: Date,
): NetworkEvent | null {
  // The contractId IS the Channel Auth contract / council id. If we don't
  // know about this council yet, it's outside our universe (off-grid).
  const councilId = raw.contractId;
  const councilName = networkState.getCouncilName(councilId);

  if (topicSymbol === "contract_initialized") {
    return makeEvent("council_formed", councilId, councilName, raw, now, {});
  }

  const address = raw.topics.length > 1 ? decodeAddress(raw.topics[1]) : null;
  if (!address) return null;

  if (topicSymbol === "provider_added") {
    return makeEvent("provider_added", councilId, councilName, raw, now, {
      providerPublicKey: address,
    });
  }
  if (topicSymbol === "provider_removed") {
    return makeEvent("provider_removed", councilId, councilName, raw, now, {
      providerPublicKey: address,
    });
  }
  return null;
}

function mapSacTransferEvent(
  raw: RawChainEvent,
  now: Date,
): NetworkEvent | null {
  // Standard SAC transfer event topics: ["transfer", from, to, asset?]
  if (raw.topics.length < 3) return null;
  const from = decodeAddress(raw.topics[1]);
  const to = decodeAddress(raw.topics[2]);
  if (!from || !to) return null;

  const amount = decodeI128(raw.value);

  // Deposit: transfer TO a known channel address.
  const depositCouncilId = networkState.resolveChannelToCouncil(to);
  if (depositCouncilId) {
    return makeEvent(
      "channel_deposit",
      depositCouncilId,
      networkState.getCouncilName(depositCouncilId),
      raw,
      now,
      { channelContractId: to, assetContractId: raw.contractId, amount },
    );
  }

  // Settlement: transfer FROM a known channel address.
  const settlementCouncilId = networkState.resolveChannelToCouncil(from);
  if (settlementCouncilId) {
    return makeEvent(
      "channel_settlement",
      settlementCouncilId,
      networkState.getCouncilName(settlementCouncilId),
      raw,
      now,
      { channelContractId: from, assetContractId: raw.contractId, amount },
    );
  }

  return null;
}

function makeEvent(
  kind: NetworkEventKind,
  councilId: string,
  councilName: string | null,
  raw: RawChainEvent,
  now: Date,
  payload: Record<string, unknown>,
): NetworkEvent {
  // Prefer the ledger close time over wall-clock so back-filled events
  // distribute over the real chain timeline (throughput, sparklines,
  // rolling windows are all bucketed by this). Fallback to `now` is only
  // for the rare case the watcher couldn't extract `ledgerClosedAt`.
  const occurredAt = raw.ledgerClosedAtMs !== null
    ? new Date(raw.ledgerClosedAtMs).toISOString()
    : now.toISOString();
  return {
    // Reuse Soroban's stable event id so the same on-chain event lands
    // on the same NetworkEvent id whether observed live or via the
    // cold-start scan — the store's dedup-by-id relies on this.
    id: raw.id,
    kind,
    councilId,
    councilName,
    ledger: raw.ledger,
    occurredAt,
    payload,
  };
}
