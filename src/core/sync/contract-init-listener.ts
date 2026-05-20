import { Address, xdr } from "stellar-sdk";
import { Server } from "stellar-sdk/rpc";
import { LOG } from "@/config/logger.ts";
import { STELLAR_RPC_URL } from "@/config/env.ts";
import { networkState } from "@/core/state/store.ts";
import { refreshTopology } from "./topology-refresh.ts";
import {
  isKnownChannelAuthHash,
  isReady as isWasmRegistryReady,
} from "./wasm-registry.ts";

/**
 * Listens for `contract_initialized` events from unfamiliar contractIds.
 *
 * Soroban's `getEvents` filter for the watcher already covers all events
 * from contracts we know about. To discover *new* Channel Auth contracts
 * (i.e. new councils deployed since the last hourly topology resync), the
 * watcher passes us each `contract_initialized` from a contractId outside
 * its watched set. We read that contract's instance ledger entry, pull
 * its WASM hash, and if it matches any hash registered by the
 * `wasm-registry` (sourced from soroban-core's GitHub releases) we
 * trigger a topology refresh so the new council appears within one poll
 * tick.
 *
 * The Channel Auth `contract_initialized` event fires at deploy time,
 * which is several seconds *before* setup-c.sh (or the council-console
 * UI) calls council-platform to register the council. We can't rely on
 * council-platform knowing the contract on the first refresh — instead,
 * once we've confirmed the WASM match, we keep the contractId in a
 * `pendingAdoption` set and retry refreshTopology each subsequent poll
 * tick until council-platform reports it. Contracts whose WASM doesn't
 * match are cached as not-ours so a chatty unrelated contract can't drag
 * us into repeated RPC calls.
 */

const notMoonlight = new Set<string>();
const pendingAdoption = new Set<string>();

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
 * Soroban event filter pattern matching `contract_initialized` events with
 * 2 topics: the `Symbol("contract_initialized")` itself plus an arbitrary
 * second topic (Channel Auth emits the admin address there). Soroban's
 * topic filter is exact-length positional, so the wildcard slot is what
 * lets the same matcher catch any deployer address.
 *
 * If a future Channel Auth release emits a different topic count, add a
 * second pattern to the watcher's filter array.
 */
export const CONTRACT_INITIALIZED_TOPIC_PATTERN: string[] = [
  xdr.ScVal.scvSymbol("contract_initialized").toXDR("base64"),
  "*",
];

export function isContractInitListenerEnabled(): boolean {
  return isWasmRegistryReady();
}

/**
 * Inspect the contract whose `contract_initialized` we just observed. If
 * its WASM hash matches the configured Channel Auth hash, fire a
 * topology refresh.
 *
 * Idempotent + safe to invoke from a poll tick fan-out.
 */
export async function evaluateUnknownContract(
  contractId: string,
): Promise<void> {
  if (!isContractInitListenerEnabled()) return;
  if (!contractId) return;
  if (pendingAdoption.has(contractId)) return;
  if (notMoonlight.has(contractId)) return;
  if (networkState.hasCouncil(contractId)) return;

  const wasmHash = await fetchWasmHash(contractId);
  if (wasmHash === null) return;
  if (!isKnownChannelAuthHash(wasmHash)) {
    notMoonlight.add(contractId);
    LOG.debug("Ignored contract_initialized from non-Moonlight contract", {
      contractId,
      wasmHash,
    });
    return;
  }
  pendingAdoption.add(contractId);
  LOG.info("Detected new Channel Auth deploy via contract_initialized", {
    contractId,
    wasmHash,
  });
  await drainPendingAdoptions();
}

/**
 * Retry topology refresh while we still have contracts whose Channel Auth
 * WASM hash matched but which council-platform hasn't yet registered.
 * Called once per pollTick — no-op when nothing is pending.
 */
export async function drainPendingAdoptions(): Promise<void> {
  if (pendingAdoption.size === 0) return;
  await refreshTopology(`pending=${pendingAdoption.size}`);
  for (const cid of [...pendingAdoption]) {
    if (networkState.hasCouncil(cid)) {
      pendingAdoption.delete(cid);
      LOG.info("Pending Channel Auth contract adopted into topology", {
        contractId: cid,
      });
    }
  }
}

/** Test-only seam to drop cached decisions between unit tests. */
export function __resetForTests(): void {
  notMoonlight.clear();
  pendingAdoption.clear();
}

async function fetchWasmHash(contractId: string): Promise<string | null> {
  try {
    const server = getServer();
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const res = await server.getLedgerEntries(key);
    if (res.entries.length === 0) return null;
    const val = res.entries[0].val.contractData().val();
    if (val.switch().name !== "scvContractInstance") return null;
    const exec = val.instance().executable();
    if (exec.switch().name !== "contractExecutableWasm") return null;
    const hashBytes = new Uint8Array(exec.wasmHash());
    return Array.from(hashBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch (err) {
    LOG.debug("fetchWasmHash failed", {
      contractId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
