# network-dashboard-platform

Public, anonymous backend for
[`network-dashboard`](https://github.com/Moonlight-Protocol/network-dashboard).
One Fly app per env; no DB; no auth.

## What it does

Streams a live view of the Moonlight network over WebSocket. Cold-start
self-syncs from `council-platform`'s public endpoints and Soroban RPC; no
persistence.

Seven event kinds drive the dashboard (see
[design sketch](../pm-theahaco/network-dashboard-design-sketch.md)):

| Kind                 | Chain source                                                          |
| -------------------- | --------------------------------------------------------------------- |
| `council_formed`     | Channel Auth `contract_initialized` event                             |
| `provider_added`     | Channel Auth `provider_added` event                                   |
| `provider_removed`   | Channel Auth `provider_removed` event                                 |
| `asset_registered`   | New `assetContractId` appearing in `council-platform/public/channels` |
| `channel_deposit`    | SAC `transfer` event TO a known channel address                       |
| `channel_settlement` | SAC `transfer` event FROM a known channel address                     |
| `channel_bundle`     | SAC `fee` event whose payer is a registered PP                        |

## Endpoints

| Path                     | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `GET /api/v1/health`     | Liveness — `{status,service,version}`                          |
| `GET /api/v1/network/ws` | Public WebSocket. Subprotocol `moonlight.network.v2`. No auth. |

### WebSocket frame protocol

Server → client, JSON-encoded:

```jsonc
// Sent once on open. (v2 additions over v1: throughputPerMin + latencyMs
// counters, sparklines, assetBreakdown, councilRolling.)
{
  "type": "snapshot",
  "counters": {
    "councils": 4,
    "activePPs": 7,
    "eventsLast24h": 31,
    "assetsRegistered": 2,
    "throughputPerMin": 3,
    "latencyMs": 4200
  },
  "sparklines": {
    "throughput": [/* 60 per-minute counts, oldest first */],
    "latency": [/* 60 per-minute avg ms (null where no samples) */],
    "volume": [/* 60 per-minute deposit+settlement totals (whole units) */]
  },
  "assetBreakdown": [
    { "assetContractId": "CDMLF…", "assetCode": "XLM", "amountStroops": "12000000", "percent": 100 }
  ],
  "councilRolling": {
    "CBPHGAJ4F7…": {
      "bundlesLastHour": 2,
      "eventsLastHour": 5,
      "ratePerMin": 0.1,
      "depositVolumeStroops": "200500000",
      "settlementVolumeStroops": "100000000"
    }
  },
  "topology": [
    {
      "id": "CBPHGAJ4F7...",         // Channel Auth contract id == council id
      "name": "Council A",
      "providers": [{ "publicKey": "GA...", "label": null }],
      "channels": [{ "contractId": "CALR6...", "assetCode": "XLM", "assetContractId": "CDMLF..." }],
      "jurisdictions": ["US"]
    }
  ],
  "recent": [/* up to ~20 NetworkEvents, newest first */],
  "generatedAt": "2026-05-18T17:00:00.000Z"
}

// Sent for each live event after the snapshot.
{
  "type": "event",
  "event": {
    "id": "8a3b…",
    "kind": "provider_added",
    "councilId": "CBPHGAJ4F7…",
    "councilName": "Council A",
    "ledger": 12345,
    "occurredAt": "2026-05-18T17:00:05.000Z",
    "payload": { "providerPublicKey": "GA…" }
  }
}
```

No client → server frames. Clients reconnect rather than ping; on reconnect they
receive a fresh snapshot.

## Architecture

```
council-platform /public/* ─┐
                            ├─►  in-memory state ─►  WS clients
Soroban /getEvents (poll) ──┘         ▲
                                       │
        minute topology re-sync + minute window sweep
```

- **Cold start**: fetch `council-platform/api/v1/public/councils` (one call
  carries councils + channels + providers + jurisdictions), walk trailing 24h on
  the subscription set via `rpc.getEvents`, seed the rolling counter window and
  the activity-feed ring buffer.
- **Subscriptions**: Channel Auth (council) contracts are watched by contractId.
  SAC contracts are watched by TOPIC only — `transfer` patterns pinned to known
  channel addresses (deposit/settlement) and `fee` patterns pinned to registered
  PP keys (bundles). The mainnet XLM SAC emits hundreds of events per ledger; an
  unfiltered contractId subscription drowns in them.
- **Forward poll**: 5s poll over the subscription set, paged via the RPC event
  cursor so consumption is gap-free even mid-ledger; the shared poll position
  only advances across fully-consumed pages (re-read overlap is deduped by event
  id).
- **New-council discovery**: network-wide `contract_initialized` poll feeds the
  adoption pipeline (topology refresh + historical back-fill per adopted
  council).
- **Minute topology re-sync**: refresh topology from council-platform — the
  backstop for DB-only registrations (channels, jurisdictions, labels), which
  emit no chain event.
- **Minute sweep**: drop window entries older than 24h.

## Running locally

```bash
cp .env.example .env
# Edit .env — set COUNCIL_PLATFORM_URL to your running council-platform.
deno task serve
```

`local-dev/` notes: the canonical `local-dev` parallel-stack guide applies here.
Set `PORT=<your-port>` to avoid collisions with other services on the same host.

## Configuration

| Env                    | Required                   | Description                                       |
| ---------------------- | -------------------------- | ------------------------------------------------- |
| `PORT`                 | no (default 8080)          | HTTP port                                         |
| `MODE`                 | no (default `development`) | `development` relaxes CORS to localhost           |
| `LOG_LEVEL`            | no (default `INFO`)        | `FATAL`/`ERROR`/`WARN`/`INFO`/`DEBUG`/`TRACE`     |
| `NETWORK`              | yes                        | `testnet` \| `mainnet` \| `local`                 |
| `STELLAR_RPC_URL`      | yes                        | Soroban RPC URL                                   |
| `COUNCIL_PLATFORM_URL` | yes                        | URL of `council-platform` (no trailing `/api/v1`) |
| `ALLOWED_ORIGINS`      | recommended                | Comma-separated CORS allowlist                    |

## Deploy

| Env     | Fly app                                     | Config             |
| ------- | ------------------------------------------- | ------------------ |
| testnet | `moonlight-beta-network-dashboard-platform` | `fly.testnet.toml` |
| mainnet | `moonlight-mainnet-network-dashboard`       | `fly.mainnet.toml` |

Tagged main pushes trigger `.github/workflows/deploy-{testnet,mainnet}.yml`.

## Versioning

`deno.json` `version` is the source of truth — bump it on every PR.
