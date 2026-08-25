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
    assertEquals(mapped?.txHash, "tx-fee-1");
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
  "mapChainEvent carries the raw txHash through to council events (top-level, not payload)",
  () => {
    networkState.__resetForTests();
    const raw: RawChainEvent = {
      id: "0000000456-0000000001",
      contractId: COUNCIL_1,
      ledger: 456,
      topics: [
        xdr.ScVal.scvSymbol("provider_added"),
        Address.fromString(PP_A).toScVal(),
      ],
      value: xdr.ScVal.scvVoid(),
      txHash: "tx-council-1",
      ledgerClosedAtMs: 1_700_000_000_000,
    };
    const mapped = mapChainEvent(raw);
    assertEquals(mapped?.kind, "provider_added");
    assertEquals(mapped?.txHash, "tx-council-1");
    assertEquals("txHash" in (mapped?.payload ?? {}), false);
  },
);

// ── SAC transfer amount decoding ─────────────────────────────────────
//
// Vectors below are real testnet XLM-SAC events (contract
// CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC), captured via
// getEvents on 2026-07-31. The `value` fields are the verbatim on-chain
// ScVal XDR.

/** Council Felix channel, deposit target of the real event below. */
const FELIX_CHANNEL =
  "CD5MZC6UZMCMWBRXPLCS64KGRSR3JNS7AMNMXKSH54U67ES2A5EYKPF2";
const FELIX_COUNCIL =
  "CA7PXPUF6F7IQS7WNKVSFXMGN3K4RH7CCRZAGW7YDMEEN6NAPCF6HGCB";
const DEPOSITOR = "GDKSTZ3625774QCMTEK3OEE22I56AJNQP7WFW7TQ62SR5PUMGSL4OBEF";
const SETTLE_TARGET =
  "GBCDULBXJ4W4Y2YT63ZWPJTKSMXDEAXW65FSALO5LGXUE2YWCEUFQXU7";

/** Event 0016589233871425536-0000000000, ledger 3862482: 1000500000 stroops. */
const DEPOSIT_VALUE_XDR = "AAAACgAAAAAAAAAAAAAAADuiayA=";
/** Event 0016589324065746944-0000000000, ledger 3862503: 200000000 stroops. */
const SETTLEMENT_VALUE_XDR = "AAAACgAAAAAAAAAAAAAAAAvrwgA=";
/**
 * Event 0016589229576450048-0000000000, ledger 3862481: CAP-67 muxed
 * shape — scvMap {"amount": i128(1), "to_muxed_id": bytes}. Pre-fix,
 * decodeI128 rejected this shape and the amount mapped to null.
 */
const MUXED_VALUE_XDR =
  "AAAAEQAAAAEAAAACAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAAAAAABAAAADwAAAAt0b19tdXhlZF9pZAAAAAANAAAAIKrVu6zZFi/PWS6FlvvvFihDN7XI1REOcBA7gVy4JubM";

function sacTransferEvent(
  from: string,
  to: string,
  valueXdr: string,
  ledgerClosedAtMs: number | null = 1_700_000_000_000,
): RawChainEvent {
  return {
    id: "0016589233871425536-0000000000",
    contractId: SAC,
    ledger: 3862482,
    topics: [
      xdr.ScVal.scvSymbol("transfer"),
      Address.fromString(from).toScVal(),
      Address.fromString(to).toScVal(),
      xdr.ScVal.scvString("native"),
    ],
    value: xdr.ScVal.fromXDR(valueXdr, "base64"),
    txHash: "tx-transfer-1",
    ledgerClosedAtMs,
  };
}

function felixTopology() {
  networkState.__resetForTests();
  networkState.replaceTopology([
    {
      id: FELIX_COUNCIL,
      name: "Council Felix",
      providers: [],
      channels: [{
        contractId: FELIX_CHANNEL,
        assetCode: "XLM",
        assetContractId: SAC,
      }],
      jurisdictions: [],
    },
  ]);
}

Deno.test(
  "mapSacTransferEvent decodes the amount of a real on-chain deposit (plain i128 value)",
  () => {
    felixTopology();
    const mapped = mapChainEvent(
      sacTransferEvent(DEPOSITOR, FELIX_CHANNEL, DEPOSIT_VALUE_XDR),
    );
    assertEquals(mapped?.kind, "channel_deposit");
    assertEquals(mapped?.councilId, FELIX_COUNCIL);
    assertEquals(mapped?.txHash, "tx-transfer-1");
    assertEquals(mapped?.payload.amount, "1000500000");
    assertEquals(mapped?.payload.assetContractId, SAC);
  },
);

Deno.test(
  "mapSacTransferEvent decodes the amount of a real on-chain settlement (plain i128 value)",
  () => {
    felixTopology();
    const mapped = mapChainEvent(
      sacTransferEvent(FELIX_CHANNEL, SETTLE_TARGET, SETTLEMENT_VALUE_XDR),
    );
    assertEquals(mapped?.kind, "channel_settlement");
    assertEquals(mapped?.payload.amount, "200000000");
  },
);

Deno.test(
  "mapSacTransferEvent decodes the CAP-67 muxed map value shape (amount + to_muxed_id)",
  () => {
    felixTopology();
    const mapped = mapChainEvent(
      sacTransferEvent(DEPOSITOR, FELIX_CHANNEL, MUXED_VALUE_XDR),
    );
    assertEquals(mapped?.kind, "channel_deposit");
    assertEquals(mapped?.payload.amount, "1");
  },
);

Deno.test(
  "mapSacTransferEvent reassembles i128 amounts above 2^64 into a plain decimal string",
  () => {
    felixTopology();
    // hi=1, lo=1 → 2^64 + 1. Pre-fix this decoded to the unparseable "1:1".
    const big = xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: new xdr.Int64(1n),
        lo: new xdr.Uint64(1n),
      }),
    );
    const raw = sacTransferEvent(DEPOSITOR, FELIX_CHANNEL, DEPOSIT_VALUE_XDR);
    raw.value = big;
    const mapped = mapChainEvent(raw);
    assertEquals(mapped?.payload.amount, "18446744073709551617");
  },
);

Deno.test(
  "a real deposit event flows through the store into sparkline volume and the 24h asset breakdown",
  () => {
    felixTopology();
    const closedAtMs = 1_700_000_000_000;
    const mapped = mapChainEvent(
      sacTransferEvent(DEPOSITOR, FELIX_CHANNEL, DEPOSIT_VALUE_XDR, closedAtMs),
    );
    if (!mapped) throw new Error("expected mapped deposit event");
    assertEquals(networkState.recordEvent(mapped, 1200), true);

    const sp = networkState.sparklines(closedAtMs);
    // 1000500000 stroops = 100.05 XLM, landing in the newest bucket.
    assertEquals(sp.volume[sp.volume.length - 1], 100.05);

    const breakdown = networkState.assetBreakdown24h(closedAtMs);
    assertEquals(breakdown.length, 1);
    assertEquals(breakdown[0].assetContractId, SAC);
    assertEquals(breakdown[0].amountStroops, "1000500000");
    assertEquals(breakdown[0].percent, 100);
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
