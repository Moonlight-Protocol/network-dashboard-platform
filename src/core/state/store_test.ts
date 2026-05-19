import { assertEquals } from "@std/assert";
import {
  NetworkStateStore,
  RING_BUFFER_CAPACITY,
  ROLLING_WINDOW_DURATION_MS,
} from "./store.ts";
import type {
  CouncilTopologyEntry,
  NetworkEvent,
} from "@/core/events/types.ts";

function makeStore() {
  const s = new NetworkStateStore();
  s.__resetForTests();
  return s;
}

function council(
  id: string,
  channels: Array<{ contractId: string; assetContractId?: string | null }> = [],
  providers: string[] = [],
): CouncilTopologyEntry {
  return {
    id,
    name: `Council ${id.slice(0, 4)}`,
    providers: providers.map((p) => ({ publicKey: p, label: null })),
    channels: channels.map((c) => ({
      contractId: c.contractId,
      assetCode: "XLM",
      assetContractId: c.assetContractId ?? null,
    })),
    jurisdictions: [],
  };
}

function event(
  id: string,
  kind: NetworkEvent["kind"] = "provider_added",
  offsetMs = 0,
): NetworkEvent {
  return {
    id,
    kind,
    councilId: "COUNCIL",
    councilName: "Council",
    ledger: 1,
    occurredAt: new Date(Date.now() - offsetMs).toISOString(),
    payload: {},
  };
}

Deno.test("replaceTopology rebuilds linkage maps", () => {
  const s = makeStore();
  s.replaceTopology([
    council("CA", [{ contractId: "CH1", assetContractId: "SAC1" }], ["GA"]),
    council("CB", [{ contractId: "CH2", assetContractId: "SAC2" }], ["GB"]),
  ]);
  assertEquals(s.getCouncilIds().sort(), ["CA", "CB"]);
  assertEquals(s.getChannelContractIds().sort(), ["CH1", "CH2"]);
  assertEquals(s.getAssetContractIds().sort(), ["SAC1", "SAC2"]);
  assertEquals(s.resolveChannelToCouncil("CH1"), "CA");
  assertEquals(s.resolveAssetToCouncil("SAC2"), "CB");
});

Deno.test("countActiveProviders sums across councils", () => {
  const s = makeStore();
  s.replaceTopology([
    council("CA", [], ["GA1", "GA2"]),
    council("CB", [], ["GB1"]),
  ]);
  assertEquals(s.countActiveProviders(), 3);
});

Deno.test("countAssetsRegistered is distinct assetContractIds", () => {
  const s = makeStore();
  s.replaceTopology([
    council("CA", [
      { contractId: "CH1", assetContractId: "SAC1" },
      { contractId: "CH2", assetContractId: "SAC2" },
    ]),
    // Same SAC shared across councils → still distinct count.
    council("CB", [{ contractId: "CH3", assetContractId: "SAC1" }]),
  ]);
  assertEquals(s.countAssetsRegistered(), 2);
});

Deno.test("recordEvent prepends, caps at RING_BUFFER_CAPACITY, dedups", () => {
  const s = makeStore();
  for (let i = 0; i < RING_BUFFER_CAPACITY + 5; i++) {
    s.recordEvent(event(`e${i}`));
  }
  const recent = s.recentEvents();
  assertEquals(recent.length, RING_BUFFER_CAPACITY);
  // newest first
  assertEquals(recent[0].id, `e${RING_BUFFER_CAPACITY + 4}`);
  // dedup
  assertEquals(s.recordEvent(event(`e${RING_BUFFER_CAPACITY + 4}`)), false);
});

Deno.test("countEventsLast24h reflects in-window events", () => {
  const s = makeStore();
  s.recordEvent(event("fresh", "provider_added", 60_000));
  s.recordEvent(event("old", "provider_added", ROLLING_WINDOW_DURATION_MS + 1));
  assertEquals(s.countEventsLast24h(), 1);
});

Deno.test("sweepWindow drops stale entries", () => {
  const s = makeStore();
  s.recordEvent(event("fresh", "provider_added", 60_000));
  s.recordEvent(event("old", "provider_added", ROLLING_WINDOW_DURATION_MS + 1));
  const purged = s.sweepWindow();
  assertEquals(purged, 1);
  assertEquals(s.countEventsLast24h(), 1);
});

Deno.test("seedRecent caps at RING_BUFFER_CAPACITY", () => {
  const s = makeStore();
  const events = Array.from(
    { length: RING_BUFFER_CAPACITY + 10 },
    (_, i) => event(`e${i}`),
  );
  s.seedRecent(events);
  assertEquals(s.recentEvents().length, RING_BUFFER_CAPACITY);
});
