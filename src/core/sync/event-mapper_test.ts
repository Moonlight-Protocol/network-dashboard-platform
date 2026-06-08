import { assertEquals } from "@std/assert";
import { Address, xdr } from "stellar-sdk";
import { mapChainEvent, type RawChainEvent } from "./event-mapper.ts";
import { networkState } from "@/core/state/store.ts";

const SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CHANNEL_1 = "CCX23VXKYHACMDGMYH7JPWNW3A3TUG3CRU5DOW2AZNF4DQCRUEVKTWXB";
const CHANNEL_2 = "CCNT53ASIH65LPWR6FXT6WCGXOF4O6JSSV6KCEQBYUSQHY4LPNWMP6LU";
const COUNCIL_1 = "CCVYCJF7ONC4DHYKI34XINUVBBISAMFOD7N4SRRZS2JE2IFBWNUDVMRI";
const COUNCIL_2 = "CAT2NAELSY7DNQTZAYQI3K4VNVP3JYOEYTSGKYEBXS2IZKARS35EC6TD";
const PP_A = "GAR2WBIXBOXP3GA7XNVOSEIB3QL2OZJRT2QSX24UJFTDVI26M23MEP25";

function feeEvent(
  payerStrKey: string,
  sacContractId: string = SAC,
): RawChainEvent {
  return {
    id: "0000000123-0000000001",
    contractId: sacContractId,
    ledger: 123,
    topics: [
      xdr.ScVal.scvSymbol("fee"),
      Address.fromString(payerStrKey).toScVal(),
    ],
    value: xdr.ScVal.scvVoid(),
    txHash: "tx-fee-1",
    ledgerClosedAtMs: 1_700_000_000_000,
  };
}

Deno.test(
  "mapSacFeeEvent attributes channel_bundle to PP's council (shared SAC, council_1 iterated first)",
  () => {
    networkState.__resetForTests();
    networkState.replaceTopology([
      {
        id: COUNCIL_1,
        name: "Council 1",
        providers: [{ publicKey: PP_A, label: null }],
        channels: [{
          contractId: CHANNEL_1,
          assetCode: "XLM",
          assetContractId: SAC,
        }],
        jurisdictions: [],
      },
      {
        id: COUNCIL_2,
        name: "Council 2",
        providers: [],
        channels: [{
          contractId: CHANNEL_2,
          assetCode: "XLM",
          assetContractId: SAC,
        }],
        jurisdictions: [],
      },
    ]);

    const mapped = mapChainEvent(feeEvent(PP_A));
    assertEquals(mapped?.kind, "channel_bundle");
    assertEquals(mapped?.councilId, COUNCIL_1);
    assertEquals(
      (mapped?.payload as { providerPublicKey: string }).providerPublicKey,
      PP_A,
    );
  },
);

Deno.test(
  "mapSacFeeEvent attributes to PP's council even when another council was iterated LAST for the same SAC (regression: assetContractToCouncil last-write-wins must not silence channel_bundle)",
  () => {
    networkState.__resetForTests();
    networkState.replaceTopology([
      {
        id: COUNCIL_1,
        name: "Council 1",
        providers: [{ publicKey: PP_A, label: null }],
        channels: [{
          contractId: CHANNEL_1,
          assetCode: "XLM",
          assetContractId: SAC,
        }],
        jurisdictions: [],
      },
      // Iterated LAST → assetContractToCouncil[SAC] = COUNCIL_2 under the
      // old code. Pre-fix this overwrote COUNCIL_1's attribution and the
      // sacCouncilId !== ppCouncilId check dropped PP_A's bundle event.
      {
        id: COUNCIL_2,
        name: "Council 2",
        providers: [],
        channels: [{
          contractId: CHANNEL_2,
          assetCode: "XLM",
          assetContractId: SAC,
        }],
        jurisdictions: [],
      },
    ]);

    const mapped = mapChainEvent(feeEvent(PP_A));
    assertEquals(mapped?.kind, "channel_bundle");
    assertEquals(mapped?.councilId, COUNCIL_1);
  },
);

Deno.test("mapSacFeeEvent returns null when payer is not a registered PP", () => {
  networkState.__resetForTests();
  networkState.replaceTopology([
    {
      id: COUNCIL_1,
      name: "Council 1",
      providers: [{ publicKey: PP_A, label: null }],
      channels: [{
        contractId: CHANNEL_1,
        assetCode: "XLM",
        assetContractId: SAC,
      }],
      jurisdictions: [],
    },
  ]);

  // Unknown account (admin / friendbot / random) — must be dropped.
  const STRANGER = "GBMRAWZT3QKLWKW4OWEEHIM3RHYXDA5QVF4JHUYRHSXAOXOSWYAECCOR";
  const mapped = mapChainEvent(feeEvent(STRANGER));
  assertEquals(mapped, null);
});

Deno.test(
  "registerProvider makes a late-joining PP visible to mapSacFeeEvent without a topology refresh",
  () => {
    networkState.__resetForTests();
    // Boot-time topology has the council but no providers yet — exactly
    // the state n-d-p is in when the test's PP joins AFTER the
    // contract-init listener's refresh.
    networkState.replaceTopology([
      {
        id: COUNCIL_1,
        name: "Council 1",
        providers: [],
        channels: [{
          contractId: CHANNEL_1,
          assetCode: "XLM",
          assetContractId: SAC,
        }],
        jurisdictions: [],
      },
    ]);

    // Pre-condition: SAC-fee event from the PP is dropped — PP unknown.
    assertEquals(mapChainEvent(feeEvent(PP_A)), null);

    // Watcher observes `provider_added` on-chain and calls this.
    networkState.registerProvider(PP_A, COUNCIL_1);

    // Now the immediately-following send bundle's SAC-fee event lands.
    const mapped = mapChainEvent(feeEvent(PP_A));
    assertEquals(mapped?.kind, "channel_bundle");
    assertEquals(mapped?.councilId, COUNCIL_1);
  },
);

Deno.test(
  "unregisterProvider drops a removed PP from mapSacFeeEvent attribution",
  () => {
    networkState.__resetForTests();
    networkState.replaceTopology([
      {
        id: COUNCIL_1,
        name: "Council 1",
        providers: [{ publicKey: PP_A, label: null }],
        channels: [{
          contractId: CHANNEL_1,
          assetCode: "XLM",
          assetContractId: SAC,
        }],
        jurisdictions: [],
      },
    ]);

    // Pre-condition: registered PP → channel_bundle lands.
    assertEquals(mapChainEvent(feeEvent(PP_A))?.kind, "channel_bundle");

    // Watcher observes `provider_removed` and calls this.
    networkState.unregisterProvider(PP_A);

    // Now SAC-fee events for the removed PP are dropped.
    assertEquals(mapChainEvent(feeEvent(PP_A)), null);
  },
);

Deno.test(
  "registerProvider is idempotent — a later replaceTopology overwriting the same value is safe",
  () => {
    networkState.__resetForTests();
    networkState.replaceTopology([
      {
        id: COUNCIL_1,
        name: "Council 1",
        providers: [],
        channels: [{
          contractId: CHANNEL_1,
          assetCode: "XLM",
          assetContractId: SAC,
        }],
        jurisdictions: [],
      },
    ]);

    networkState.registerProvider(PP_A, COUNCIL_1);
    assertEquals(mapChainEvent(feeEvent(PP_A))?.kind, "channel_bundle");

    // Council-platform catches up; the scheduled topology refresh runs.
    networkState.replaceTopology([
      {
        id: COUNCIL_1,
        name: "Council 1",
        providers: [{ publicKey: PP_A, label: null }],
        channels: [{
          contractId: CHANNEL_1,
          assetCode: "XLM",
          assetContractId: SAC,
        }],
        jurisdictions: [],
      },
    ]);

    // Still works — the refresh wrote the same value.
    assertEquals(mapChainEvent(feeEvent(PP_A))?.kind, "channel_bundle");
  },
);
