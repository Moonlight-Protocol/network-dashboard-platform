# network-dashboard-platform

Public, anonymous backend for
[`network-dashboard`](https://github.com/Moonlight-Protocol/network-dashboard).
One Fly app per env; no DB; no auth.

## What it does

Streams a live view of the Moonlight network over WebSocket. Cold-start
self-syncs from `council-platform`'s public endpoints and Soroban RPC; no
persistence.

Six event kinds drive the dashboard (see
[design sketch](../pm-theahaco/network-dashboard-design-sketch.md)):

| Kind                 | Chain source                                                          |
| -------------------- | --------------------------------------------------------------------- |
| `council_formed`     | Channel Auth `contract_initialized` event                             |
| `provider_added`     | Channel Auth `provider_added` event                                   |
| `provider_removed`   | Channel Auth `provider_removed` event                                 |
| `asset_registered`   | New `assetContractId` appearing in `council-platform/public/channels` |
| `channel_deposit`    | SAC `transfer` event TO a known channel address                       |
| `channel_settlement` | SAC `transfer` event FROM a known channel address                     |

## Endpoints

| Path                     | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `GET /api/v1/health`     | Liveness — `{status,service,version}`                          |
| `GET /api/v1/network/ws` | Public WebSocket. Subprotocol `moonlight.network.v1`. No auth. |

### WebSocket frame protocol

Server → client, JSON-encoded:

```jsonc
// Sent once on open.
{
  "type": "snapshot",
  "counters": {
    "councils": 4,
    "activePPs": 7,
    "eventsLast24h": 31,
    "assetsRegistered": 2
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

No client → server frames in v1. Clients reconnect rather than ping; on
reconnect they receive a fresh snapshot.

## Architecture

```
council-platform /public/* ─┐
                            ├─►  in-memory state ─►  WS clients
Soroban /getEvents (poll) ──┘         ▲
                                       │
        hourly re-sync + minute window sweep
```

- **Cold start**: fetch `council-platform/api/v1/public/councils` (one call
  carries councils + channels + providers + jurisdictions), walk trailing 24h on
  every watched contract via `rpc.getEvents`, seed the rolling counter window +
  activity-feed ring buffer.
- **Forward poll**: 5s cursor-based poll on the same contractId set.
- **Hourly re-sync**: refresh topology + re-anchor the rolling counter window.
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
