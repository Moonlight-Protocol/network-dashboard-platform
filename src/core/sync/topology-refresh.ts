import { LOG } from "@/config/logger.ts";
import { networkState } from "@/core/state/store.ts";
import { fetchCouncilTopology } from "./council-fetch.ts";
import { rescanRollingWindow } from "./soroban-watcher.ts";
import { refreshWasmRegistry } from "./wasm-registry.ts";

/**
 * Single-flight topology refresh: pull the latest council list from
 * council-platform, replace the in-memory topology, then re-walk the
 * trailing 24h with the new contractId filter so any historical events
 * from the new councils land in the rolling window + ring buffer.
 *
 * Concurrent calls coalesce — the contract-init listener can fire several
 * candidates from a single poll tick and we don't want a thundering herd
 * of council-platform fetches or overlapping Soroban scans.
 */

let inFlight: Promise<void> | null = null;

export function refreshTopology(reason: string): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = run(reason).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(reason: string): Promise<void> {
  try {
    // Re-fetch the wasm-hash registry alongside the topology so any new
    // soroban-core release becomes recognised within an hour without a
    // dashboard-backend restart. Errors are absorbed by the registry
    // itself — they don't block the topology refresh.
    await refreshWasmRegistry();
    const topology = await fetchCouncilTopology();
    networkState.replaceTopology(topology);
    await rescanRollingWindow();
    LOG.info("Topology refreshed", {
      reason,
      councils: networkState.getCouncilIds().length,
      providers: networkState.countActiveProviders(),
      assets: networkState.countAssetsRegistered(),
    });
  } catch (err) {
    LOG.warn("Topology refresh failed", {
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
