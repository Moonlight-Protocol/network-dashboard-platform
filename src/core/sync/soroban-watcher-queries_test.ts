import { assertEquals } from "@std/assert";
import { Address, xdr } from "stellar-sdk";
import type { Server } from "stellar-sdk/rpc";
import {
  __resetWatcherStateForTests,
  __setServerForTests,
  buildWatchQueryCalls,
  drainEvents,
  ledgerOfCursor,
  minCursor,
} from "./soroban-watcher.ts";
import { networkState } from "@/core/state/store.ts";
import { newNoop } from "@/utils/logger/index.ts";
import type { CouncilTopologyEntry } from "@/core/events/types.ts";

const COUNCIL = "CCVYCJF7ONC4DHYKI34XINUVBBISAMFOD7N4SRRZS2JE2IFBWNUDVMRI";
const CHANNEL = "CCLTT2ZJMMSKMUFTMDGZRRT76LFXK6INYM35VFKVZF5ZB4S7LQVEDZZ7";
const SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const PP = "GAR2WBIXBOXP3GA7XNVOSEIB3QL2OZJRT2QSX24UJFTDVI26M23MEP25";

const sym = (s: string) => xdr.ScVal.scvSymbol(s).toXDR("base64");
const addr = (a: string) => new Address(a).toScVal().toXDR("base64");

/** Real-format RPC cursor for a ledger (`<ledger << 32>-<eventIndex>`). */
const cursorAt = (ledger: number, eventIndex = 0) =>
  `${(BigInt(ledger) << 32n).toString()}-${eventIndex}`;

function topology(): CouncilTopologyEntry[] {
  return [{
    id: COUNCIL,
    name: "Council",
    providers: [{ publicKey: PP, label: null }],
    channels: [{
      contractId: CHANNEL,
      assetCode: "XLM",
      assetContractId: SAC,
    }],
    jurisdictions: ["AU"],
  }];
}

Deno.test("buildWatchQueryCalls: councils by contractId, SAC by topic pattern, one filter per call", () => {
  networkState.__resetForTests();
  networkState.replaceTopology(topology());

  const calls = buildWatchQueryCalls();
  assertEquals(calls.length, 2);

  assertEquals(calls[0].filter, { type: "contract", contractIds: [COUNCIL] });
  // The SAC is never watched raw — only via channel/PP topic patterns.
  assertEquals(calls[1].filter.contractIds, [SAC]);
  assertEquals(calls[1].filter.topics, [
    [sym("transfer"), "*", addr(CHANNEL), "*"], // deposit
    [sym("transfer"), addr(CHANNEL), "*", "*"], // settlement
    [sym("fee"), addr(PP)], // bundle fee
  ]);

  networkState.__resetForTests();
});

Deno.test("buildWatchQueryCalls: no councils → no calls; no channels/PPs → no SAC filter", () => {
  networkState.__resetForTests();
  assertEquals(buildWatchQueryCalls(), []);

  networkState.replaceTopology([{
    id: COUNCIL,
    name: "Council",
    providers: [],
    channels: [],
    jurisdictions: [],
  }]);
  const calls = buildWatchQueryCalls();
  assertEquals(calls.length, 1);
  assertEquals(calls[0].filter, { type: "contract", contractIds: [COUNCIL] });

  networkState.__resetForTests();
});

// ── drainEvents ───────────────────────────────────────────────────────

type StubPage =
  | {
    events: number;
    cursor: string;
    latestLedger: number;
    startId?: number;
  }
  | { throws: string | { message: string } };

function stubServer(pages: StubPage[]) {
  const requests: Array<Record<string, unknown>> = [];
  let call = 0;
  const server = {
    // deno-lint-ignore require-await
    getEvents: async (request: Record<string, unknown>) => {
      requests.push(request);
      const page = pages[call++];
      if (!page) throw new Error("stub exhausted");
      if ("throws" in page) throw page.throws;
      const base = page.startId ?? 0;
      return {
        events: Array.from({ length: page.events }, (_, i) => ({
          id: `evt-${base + i}`,
          ledger: 100 + base + i,
          ledgerClosedAt: "2026-07-30T12:00:00Z",
          topic: [],
          value: xdr.ScVal.scvVoid(),
          txHash: `tx-${base + i}`,
          contractId: undefined,
        })),
        cursor: page.cursor,
        latestLedger: page.latestLedger,
      };
    },
  };
  __setServerForTests(server as unknown as Server);
  return { requests };
}

const FILTERS = [{ type: "contract" as const, contractIds: [COUNCIL] }];

Deno.test("drainEvents: full page → cursor continuation; head when cursor reaches latestLedger", async () => {
  __resetWatcherStateForTests();
  const { requests } = stubServer([
    { events: 100, cursor: cursorAt(150, 7), latestLedger: 500 },
    { events: 100, cursor: cursorAt(300, 2), latestLedger: 500, startId: 100 },
    { events: 3, cursor: cursorAt(500), latestLedger: 500, startId: 200 },
  ]);
  try {
    const out = await drainEvents({ startLedger: 42 }, FILTERS, 10, newNoop());
    assertEquals(out.raws.length, 203);
    assertEquals(out.cursor, cursorAt(500));
    assertEquals(out.latestLedger, 500);
    assertEquals(out.complete, true);
    // Request 1 windowed by ledger; requests 2-3 by the previous cursor.
    assertEquals(requests[0].startLedger, 42);
    assertEquals(requests[0].endLedger, 42 + 4000 - 1);
    assertEquals(requests[1].cursor, cursorAt(150, 7));
    assertEquals(requests[2].cursor, cursorAt(300, 2));
  } finally {
    __setServerForTests(null);
    __resetWatcherStateForTests();
  }
});

Deno.test("drainEvents: sparse bounded scans step windows from scannedTo + 1", async () => {
  __resetWatcherStateForTests();
  // The RPC may cover only a slice of the requested range: an empty page
  // whose cursor sits below latestLedger means "scanned this far", NOT
  // "caught up" — the drain must keep walking.
  const { requests } = stubServer([
    { events: 0, cursor: cursorAt(4999, 4294967295), latestLedger: 20000 },
    { events: 1, cursor: cursorAt(8999, 4294967295), latestLedger: 20000 },
    { events: 0, cursor: cursorAt(20000, 4294967295), latestLedger: 20000 },
  ]);
  try {
    const out = await drainEvents(
      { startLedger: 1000 },
      FILTERS,
      10,
      newNoop(),
    );
    assertEquals(out.raws.length, 1);
    assertEquals(out.complete, true);
    assertEquals(requests[0].startLedger, 1000);
    assertEquals(requests[1].startLedger, 5000);
    assertEquals(requests[2].startLedger, 9000);
  } finally {
    __setServerForTests(null);
    __resetWatcherStateForTests();
  }
});

Deno.test("drainEvents: processing-limit rejection halves the window; cursor requests re-anchor to a window", async () => {
  __resetWatcherStateForTests();
  const limitErr = {
    message: "[-32001] request exceeded processing limit threshold",
  };
  const { requests } = stubServer([
    { throws: limitErr },
    { events: 0, cursor: cursorAt(2999, 4294967295), latestLedger: 3000 },
    { events: 0, cursor: cursorAt(3000, 4294967295), latestLedger: 3000 },
  ]);
  try {
    const out = await drainEvents(
      { startLedger: 1000 },
      FILTERS,
      10,
      newNoop(),
    );
    assertEquals(out.complete, true);
    assertEquals(requests[0].endLedger, 1000 + 4000 - 1);
    assertEquals(requests[1].endLedger, 1000 + 2000 - 1); // halved
  } finally {
    __setServerForTests(null);
    __resetWatcherStateForTests();
  }

  // Cursor-based request hitting the limit falls back to a bounded window
  // at the cursor's ledger (tail re-read is deduped downstream).
  const second = stubServer([
    { throws: limitErr },
    { events: 0, cursor: cursorAt(700, 4294967295), latestLedger: 700 },
  ]);
  try {
    const out = await drainEvents(
      { cursor: cursorAt(650, 12) },
      FILTERS,
      10,
      newNoop(),
    );
    assertEquals(out.complete, true);
    assertEquals(second.requests[0].cursor, cursorAt(650, 12));
    assertEquals(second.requests[1].startLedger, 650);
    assertEquals(second.requests[1].endLedger, 650 + 4000 - 1);
  } finally {
    __setServerForTests(null);
    __resetWatcherStateForTests();
  }
});

Deno.test("drainEvents: first-request failure yields no cursor; later failure keeps progress", async () => {
  __resetWatcherStateForTests();
  stubServer([{ throws: "boom" }]);
  try {
    const failed = await drainEvents(
      { cursor: cursorAt(1) },
      FILTERS,
      5,
      newNoop(),
    );
    assertEquals(failed.raws.length, 0);
    assertEquals(failed.cursor, null);
    assertEquals(failed.complete, false);

    stubServer([
      { events: 100, cursor: cursorAt(150), latestLedger: 500 },
      { throws: "boom" },
    ]);
    const partial = await drainEvents(
      { cursor: cursorAt(1) },
      FILTERS,
      5,
      newNoop(),
    );
    assertEquals(partial.raws.length, 100);
    assertEquals(partial.cursor, cursorAt(150));
    assertEquals(partial.complete, false);
  } finally {
    __setServerForTests(null);
    __resetWatcherStateForTests();
  }
});

Deno.test("drainEvents retries once at the RPC retention floor (raw error object)", async () => {
  __resetWatcherStateForTests();
  const { requests } = stubServer([
    // The SDK throws the raw JSON-RPC error object, not an Error.
    {
      throws: {
        message: "startLedger must be within the ledger range: 700 - 1000",
      },
    },
    { events: 1, cursor: cursorAt(1000, 4294967295), latestLedger: 1000 },
  ]);
  try {
    const out = await drainEvents({ startLedger: 5 }, FILTERS, 5, newNoop());
    assertEquals(out.raws.length, 1);
    assertEquals(out.complete, true);
    assertEquals(requests[1].startLedger, 700);
  } finally {
    __setServerForTests(null);
    __resetWatcherStateForTests();
  }
});

Deno.test("minCursor picks the lowest position numerically", () => {
  assertEquals(
    minCursor([
      "0273690485927157760-0000000000",
      "0273685443634651136-0000000157",
      "0273685443634651136-0000000020",
    ]),
    "0273685443634651136-0000000020",
  );
  assertEquals(minCursor([]), null);
});

Deno.test("ledgerOfCursor decodes the toid ledger", () => {
  assertEquals(ledgerOfCursor(cursorAt(63722358, 42)), 63722358);
  // Real mainnet cursor of the Salem channel deposit (ledger 63722358).
  assertEquals(ledgerOfCursor("0273685443634651136-0000000000"), 63722358);
});
