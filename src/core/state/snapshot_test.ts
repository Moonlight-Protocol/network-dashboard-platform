import { assertEquals } from "@std/assert";
import { networkState } from "./store.ts";
import { buildSnapshotFrame } from "./snapshot.ts";

Deno.test("buildSnapshotFrame collects counters + topology + recent", () => {
  networkState.__resetForTests();
  networkState.replaceTopology([
    {
      id: "CA",
      name: "Alpha",
      providers: [{ publicKey: "G1", label: null }],
      channels: [{
        contractId: "CH1",
        assetCode: "XLM",
        assetContractId: "SAC1",
      }],
      jurisdictions: ["US"],
    },
  ]);
  networkState.recordEvent({
    id: "e1",
    kind: "provider_added",
    councilId: "CA",
    councilName: "Alpha",
    ledger: 1,
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    payload: {},
  });

  const frame = buildSnapshotFrame();
  assertEquals(frame.type, "snapshot");
  assertEquals(frame.counters.councils, 1);
  assertEquals(frame.counters.activePPs, 1);
  assertEquals(frame.counters.assetsRegistered, 1);
  assertEquals(frame.counters.eventsLast24h, 1);
  assertEquals(frame.topology.length, 1);
  assertEquals(frame.recent.length, 1);
  assertEquals(frame.recent[0].id, "e1");
});
