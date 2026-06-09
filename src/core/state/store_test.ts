import { assertEquals } from "@std/assert";
import {
  NetworkStateStore,
  RING_BUFFER_CAPACITY,
  ROLLING_WINDOW_DURATION_MS,
  SPARKLINE_BUCKET_COUNT,
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
  channels: Array<
    { contractId: string; assetContractId?: string | null; assetCode?: string }
  > = [],
  providers: string[] = [],
): CouncilTopologyEntry {
  return {
    id,
    name: `Council ${id.slice(0, 4)}`,
    providers: providers.map((p) => ({ publicKey: p, label: null })),
    channels: channels.map((c) => ({
      contractId: c.contractId,
      assetCode: c.assetCode ?? "XLM",
      assetContractId: c.assetContractId ?? null,
    })),
    jurisdictions: [],
  };
}

function event(
  id: string,
  kind: NetworkEvent["kind"] = "provider_added",
  offsetMs = 0,
  payload: Record<string, unknown> = {},
  councilId = "COUNCIL",
): NetworkEvent {
  return {
    id,
    kind,
    councilId,
    councilName: "Council",
    ledger: 1,
    occurredAt: new Date(Date.now() - offsetMs).toISOString(),
    payload,
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

Deno.test(
  "replaceTopology does NOT wipe providerToCouncil entries set by registerProvider — eliminates the race where a refresh after registerProvider drops the PP because council-platform hasn't caught up",
  () => {
    const s = makeStore();
    // Initial topology: council CA exists with channel + asset, no
    // providers yet — exactly the state when a fresh council was just
    // created on council-platform but its EventWatcher hasn't yet
    // processed the on-chain provider_added.
    s.replaceTopology([
      council("CA", [{ contractId: "CH1", assetContractId: "SAC1" }], []),
    ]);
    assertEquals(s.resolveProviderToCouncil("GA"), undefined);

    // Watcher observes provider_added on chain → registerProvider.
    s.registerProvider("GA", "CA");
    assertEquals(s.resolveProviderToCouncil("GA"), "CA");

    // refreshTopology fires; council-platform's `/public/councils`
    // hasn't yet listed GA as ACTIVE for CA. Pre-fix this clobbered
    // the registerProvider value.
    s.replaceTopology([
      council("CA", [{ contractId: "CH1", assetContractId: "SAC1" }], []),
    ]);
    assertEquals(
      s.resolveProviderToCouncil("GA"),
      "CA",
      "registerProvider write must survive a subsequent replaceTopology that omits the PP",
    );
  },
);

Deno.test(
  "replaceTopology overrides providerToCouncil when the fetched topology DOES list the PP (eventual consistency after council-platform catches up)",
  () => {
    const s = makeStore();
    s.registerProvider("GA", "CA");
    s.replaceTopology([
      council("CA", [{ contractId: "CH1", assetContractId: "SAC1" }], ["GA"]),
      council("CB", [{ contractId: "CH2", assetContractId: "SAC2" }], []),
    ]);
    assertEquals(s.resolveProviderToCouncil("GA"), "CA");
  },
);

Deno.test(
  "unregisterProvider still removes a PP that was added via replaceTopology",
  () => {
    const s = makeStore();
    s.replaceTopology([
      council("CA", [], ["GA"]),
    ]);
    assertEquals(s.resolveProviderToCouncil("GA"), "CA");
    s.unregisterProvider("GA");
    assertEquals(s.resolveProviderToCouncil("GA"), undefined);
  },
);

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

Deno.test("throughputPerMin counts only events within the trailing 60s", () => {
  const s = makeStore();
  s.recordEvent(event("a", "provider_added", 0));
  s.recordEvent(event("b", "provider_added", 30_000));
  s.recordEvent(event("old", "provider_added", 70_000));
  assertEquals(s.throughputPerMin(), 2);
});

Deno.test("avgLatencyMs averages live samples, null when none in window", () => {
  const s = makeStore();
  assertEquals(s.avgLatencyMs(), null);
  s.recordEvent(event("a", "provider_added", 30_000), 100);
  s.recordEvent(event("b", "provider_added", 60_000), 300);
  // Back-fill (latency null) doesn't pollute the average.
  s.recordEvent(event("c", "provider_added", 90_000), null);
  assertEquals(s.avgLatencyMs(), 200);
});

Deno.test("sparklines return 60 buckets, count events in the right bucket", () => {
  const s = makeStore();
  const now = Date.now();
  s.recordEvent(event("a", "provider_added", 0));
  s.recordEvent(event("b", "provider_added", 60_000));
  s.recordEvent(event("c", "provider_added", 60_000));
  // Out-of-window event must not contribute.
  s.recordEvent(event("old", "provider_added", 70 * 60_000));
  const sp = s.sparklines(now);
  assertEquals(sp.throughput.length, SPARKLINE_BUCKET_COUNT);
  // Most recent bucket holds the now-event; previous bucket holds the two
  // events offset by 60s.
  assertEquals(sp.throughput[SPARKLINE_BUCKET_COUNT - 1], 1);
  assertEquals(sp.throughput[SPARKLINE_BUCKET_COUNT - 2], 2);
  assertEquals(sp.volume[SPARKLINE_BUCKET_COUNT - 1], 0);
});

Deno.test("sparklines volume sums deposit + settlement amounts in whole units", () => {
  const s = makeStore();
  s.replaceTopology([
    council("CA", [{ contractId: "CH1", assetContractId: "SAC1" }]),
  ]);
  s.recordEvent(
    event("d", "channel_deposit", 0, {
      channelContractId: "CH1",
      assetContractId: "SAC1",
      amount: "15000000", // 1.5 in whole units
    }, "CA"),
  );
  s.recordEvent(
    event("s", "channel_settlement", 0, {
      channelContractId: "CH1",
      assetContractId: "SAC1",
      amount: "5000000", // 0.5 in whole units
    }, "CA"),
  );
  const sp = s.sparklines();
  assertEquals(sp.volume[SPARKLINE_BUCKET_COUNT - 1], 2);
});

Deno.test("assetBreakdown24h aggregates per-asset and sorts by percent", () => {
  const s = makeStore();
  s.replaceTopology([
    council("CA", [
      { contractId: "CH1", assetContractId: "SAC_XLM", assetCode: "XLM" },
      { contractId: "CH2", assetContractId: "SAC_USDC", assetCode: "USDC" },
    ]),
  ]);
  s.recordEvent(
    event("d1", "channel_deposit", 0, {
      channelContractId: "CH1",
      assetContractId: "SAC_XLM",
      amount: "300",
    }, "CA"),
  );
  s.recordEvent(
    event("d2", "channel_deposit", 0, {
      channelContractId: "CH1",
      assetContractId: "SAC_XLM",
      amount: "300",
    }, "CA"),
  );
  s.recordEvent(
    event("d3", "channel_deposit", 0, {
      channelContractId: "CH2",
      assetContractId: "SAC_USDC",
      amount: "400",
    }, "CA"),
  );
  const rows = s.assetBreakdown24h();
  assertEquals(rows.length, 2);
  assertEquals(rows[0].assetCode, "XLM");
  assertEquals(rows[0].amountStroops, "600");
  assertEquals(rows[0].percent, 60);
  assertEquals(rows[1].assetCode, "USDC");
  assertEquals(rows[1].percent, 40);
});

Deno.test("councilRollingMetrics returns zero rows for known but quiet councils", () => {
  const s = makeStore();
  s.replaceTopology([
    council("CA", [{ contractId: "CH1", assetContractId: "SAC1" }]),
    council("CB"),
  ]);
  s.recordEvent(
    event("d", "channel_deposit", 0, {
      channelContractId: "CH1",
      assetContractId: "SAC1",
      amount: "1000",
    }, "CA"),
  );
  s.recordEvent(event("b", "channel_bundle", 0, {}, "CA"));
  const rolling = s.councilRollingMetrics();
  assertEquals(rolling["CA"].bundlesLastHour, 1);
  assertEquals(rolling["CA"].depositVolumeStroops, "1000");
  assertEquals(rolling["CA"].settlementVolumeStroops, "0");
  assertEquals(rolling["CA"].eventsLastHour, 2);
  // Unknown councils don't appear, quiet known councils still do.
  assertEquals(rolling["CB"].bundlesLastHour, 0);
  assertEquals(rolling["CB"].eventsLastHour, 0);
});
