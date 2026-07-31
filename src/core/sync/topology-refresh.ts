import type { Logger } from "@/utils/logger/index.ts";
import { networkState } from "@/core/state/store.ts";
import type { NetworkEventBus } from "@/core/events/bus.ts";
import { StructuredError } from "@/error/structured-error.ts";
import { fetchCouncilTopology } from "./council-fetch.ts";

/**
 * Single-flight topology refresh: pull the latest council list from
 * council-platform and replace the in-memory topology.
 *
 * The caller is responsible for any catch-up of historical events for
 * newly-adopted contracts (via `backfillFromLedger` in `soroban-watcher`).
 * We deliberately do NOT re-run the cold-start scan here: it `seedRecent`s
 * the ring buffer with cold-scanned events, and `publishMappedEvent`'s
 * dedup would then skip every back-filled event before it could reach the
 * bus. The contract-init-listener path relies on `backfillFromLedger` to
 * fan out the historical-but-newly-relevant events live.
 *
 * Concurrent calls coalesce — the contract-init listener can fire several
 * candidates from a single poll tick and we don't want a thundering herd
 * of council-platform fetches.
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
    log.event("fetching council topology");
    const topology = await fetchCouncilTopology({ log });
    networkState.replaceTopology(topology);
    log.event("topology replaced in network state");
    log.debug("councils", networkState.getCouncilIds().length);
    log.debug("providers", networkState.countActiveProviders());
    log.debug("assets", networkState.countAssetsRegistered());
    log.event("topology refreshed");
  } catch (err) {
    // Add this layer's context as a NEW outer error (not the idempotent
    // `from`, which would pass an inner StructuredError through unchanged and
    // drop the topology-level framing) while keeping the council-fetch error
    // as the cause so the log shows the full chain. Broadcast the client-safe
    // frame so connected dashboards can flag that the live view may be stale.
    const structured = new StructuredError({
      code: "TOPOLOGY_REFRESH_FAILED",
      source: "network-dashboard-platform/topology-refresh",
      message: "Failed to refresh network topology from council-platform",
      cause: err,
    });
    log.error(structured, "topology refresh failed");
    deps.bus.publishError(structured.toWire());
  }
}
