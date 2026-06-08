import { assertEquals } from "@std/assert";
import type { NetworkEvent } from "@/core/events/types.ts";

// `soroban-watcher.ts` transitively imports `src/config/env.ts`, which
// `require("NETWORK")`s at module-load time. In CI those env vars are
// not set (locally they leak in from the shell), so a static `import`
// throws before any test runs. Static `import` can't be guarded; set the
// env vars first and dynamically import.
Deno.env.set("NETWORK", "testnet");
Deno.env.set(
  "STELLAR_RPC_URL",
  "https://soroban-testnet.stellar.org",
);
Deno.env.set(
  "COUNCIL_PLATFORM_URL",
  "https://council-api-testnet.moonlightprotocol.io",
);

const { publishMappedEvent } = await import("./soroban-watcher.ts");
const { networkState } = await import("@/core/state/store.ts");
const { NetworkEventBus } = await import("@/core/events/bus.ts");
const { newNoop } = await import("@/utils/logger/index.ts");

const COUNCIL = "CCVYCJF7ONC4DHYKI34XINUVBBISAMFOD7N4SRRZS2JE2IFBWNUDVMRI";
const PP = "GAR2WBIXBOXP3GA7XNVOSEIB3QL2OZJRT2QSX24UJFTDVI26M23MEP25";

function providerAddedEvent(
  councilId: string,
  providerPk: string,
): NetworkEvent {
  return {
    id: `0000000123-0000000001`,
    kind: "provider_added",
    councilId,
    councilName: "Test Council",
    ledger: 123,
    occurredAt: new Date(Date.now() - 100).toISOString(),
    payload: { providerPublicKey: providerPk },
  };
}

Deno.test(
  "publishMappedEvent on provider_added triggers refreshTopology (channel-side sync piggyback)",
  async () => {
    networkState.__resetForTests();
    const bus = new NetworkEventBus({ log: newNoop() });

    // Stub globalThis.fetch — the only network call refreshTopology makes
    // is `fetch(${COUNCIL_PLATFORM_URL}/api/v1/public/councils)`.
    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    try {
      publishMappedEvent(
        providerAddedEvent(COUNCIL, PP),
        /* ledgerClosedAtMs */ Date.now() - 200,
        bus,
        newNoop(),
      );

      // refreshTopology fires fire-and-forget inside publishMappedEvent.
      // Yield to the event loop so its fetch() call lands before we assert.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const refreshCalls = fetchCalls.filter((u) =>
        u.includes("/api/v1/public/councils")
      );
      assertEquals(
        refreshCalls.length >= 1,
        true,
        `expected at least one fetch to /api/v1/public/councils; got: ${
          fetchCalls.join(", ") || "(none)"
        }`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "publishMappedEvent on provider_removed does NOT trigger refreshTopology (removal needs no new state)",
  async () => {
    networkState.__resetForTests();
    const bus = new NetworkEventBus({ log: newNoop() });

    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    try {
      const removedEvent: NetworkEvent = {
        ...providerAddedEvent(COUNCIL, PP),
        id: `0000000124-0000000001`,
        kind: "provider_removed",
      };
      publishMappedEvent(
        removedEvent,
        Date.now() - 200,
        bus,
        newNoop(),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      const refreshCalls = fetchCalls.filter((u) =>
        u.includes("/api/v1/public/councils")
      );
      assertEquals(
        refreshCalls.length,
        0,
        `expected no refresh on provider_removed; got: ${
          fetchCalls.join(", ")
        }`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
