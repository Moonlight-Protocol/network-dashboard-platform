import type { Logger } from "@/utils/logger/index.ts";
import { networkState } from "@/core/state/store.ts";
import type { NetworkEventBus } from "@/core/events/bus.ts";
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

export function refreshTopology(
  reason: string,
  deps: { log: Logger; bus: NetworkEventBus },
): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = run(reason, deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(
  reason: string,
  deps: { log: Logger; bus: NetworkEventBus },
): Promise<void> {
  const log = deps.log.scope("topologyRefresh");
  log.info("refreshTopology");
  log.debug("reason", reason);

  try {
    // Re-fetch the wasm-hash registry alongside the topology so any new
    // soroban-core release becomes recognised within an hour without a
    // dashboard-backend restart. Errors are absorbed by the registry
    // itself — they don't block the topology refresh.
    log.event("refreshing WASM registry");
    await refreshWasmRegistry({ log });
    log.event("fetching council topology");
    const topology = await fetchCouncilTopology({ log });
    networkState.replaceTopology(topology);
    log.event("topology replaced in network state");
    await rescanRollingWindow({ log, bus: deps.bus });
    log.debug("councils", networkState.getCouncilIds().length);
    log.debug("providers", networkState.countActiveProviders());
    log.debug("assets", networkState.countAssetsRegistered());
    log.event("topology refreshed");
  } catch (err) {
    log.error(err, "topology refresh failed");
  }
}
