# Troubleshooting

## Failed Deploys

### Symptoms

- Deploy workflow shows "Deployment Complete" but the app is unreachable
  (502/503)
- Machines show `stopped` state in Fly.io dashboard
- `fly logs` shows crash-loop: repeated start → exit with code 1

### Diagnosis

```bash
# Check machine states (testnet)
fly status -a moonlight-beta-network-dashboard-platform

# Check machine states (mainnet)
fly status -a moonlight-mainnet-network-dashboard

# Check recent logs (requires FLY_API_TOKEN or fly auth login)
fly logs -a moonlight-beta-network-dashboard-platform

# Check machine events via API
curl -s -H "Authorization: Bearer $FLY_API_TOKEN" \
  "https://api.machines.dev/v1/apps/moonlight-beta-network-dashboard-platform/machines" \
  | python3 -c "import sys,json; [print(f'{m[\"id\"]} | {m[\"state\"]} | {m[\"updated_at\"]}') for m in json.load(sys.stdin)]"
```

### Common Causes

#### Missing Environment Variable

**Error**: `Uncaught (in promise) Error: <VAR_NAME> is not loaded`

This service has no database and no application state — councils/PPs/channels
are discovered at runtime from `council-platform` and Soroban. All required
config is either in `fly.{testnet,mainnet}.toml` `[env]` or set via Fly secrets.

**Required env vars** (set in `fly.{testnet,mainnet}.toml` `[env]`):

- `NETWORK` — `testnet` | `mainnet`
- `PORT` — HTTP port (default 8080)
- `MODE` — `production` in deployed envs
- `OTEL_DENO`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL` —
  OpenTelemetry config

**Required secrets** (set via `fly secrets set`):

- `STELLAR_RPC_URL` — Soroban RPC URL (mainnet uses a paid endpoint with
  embedded token; that's why it's a secret, not in `[env]`)
- `COUNCIL_PLATFORM_URL` — URL of `council-platform` (no trailing `/api/v1`)
- `SERVICE_DOMAIN` — public hostname for this service
- `ALLOWED_ORIGINS` — comma-separated CORS allowlist for the dashboard frontend
- `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` — OTel exporter
  destination + auth

**Fix**:

```bash
# Check which secrets exist
fly secrets list -a moonlight-beta-network-dashboard-platform

# Set missing secret
fly secrets set VAR_NAME=value -a moonlight-beta-network-dashboard-platform
```

Note: setting a secret triggers an automatic redeploy.

#### Crash Loop (max restart count reached)

**Error in logs**: `machine has reached its max restart count of 10`

The machine crashed 10 times and gave up. After fixing the root cause, you need
to either:

- Set a secret (triggers redeploy automatically), or
- Manually redeploy: `fly deploy -a moonlight-beta-network-dashboard-platform`

#### Health Check Passes But App Crashes Later

Blue/green deploy can mark a deployment as successful if the health check passes
during the grace period, but the app crashes afterward (e.g., a deferred
initialization fails). The deploy logs will show "Deployment Complete" while the
machines are actually crash-looping.

**How to detect**: Check `fly status` or `fly logs` after deploy, not just the
CI workflow result.

#### Stray Machines

Debug machines (e.g., `fly machine run ubuntu`) left running consume resources
and can confuse deploy strategies.

**Check for strays**:

```bash
fly machines list -a moonlight-beta-network-dashboard-platform
```

Look for machines with no process group or unexpected images. Destroy with:

```bash
fly machine destroy <machine-id> --force -a moonlight-beta-network-dashboard-platform
```

## Cold-Start Sync Failures

Cold start fetches `council-platform/api/v1/public/councils` and walks the
trailing 24h on every watched contract via Soroban `rpc.getEvents`. If either
upstream is unavailable at start, the service crashes.

### Symptoms

- App boots, immediately exits with an error about HTTP fetch or RPC call
- Health check never passes after deploy

### Diagnosis

```bash
# Confirm council-platform is reachable from the network-dashboard-platform machine
fly ssh console -a moonlight-beta-network-dashboard-platform \
  -C 'curl -sS https://council-api-testnet.moonlightprotocol.io/api/v1/public/councils | head -c 200'

# Confirm Soroban RPC is reachable
fly ssh console -a moonlight-beta-network-dashboard-platform \
  -C 'curl -sS -X POST -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getNetwork\"}" \
        https://soroban-testnet.stellar.org | head -c 200'
```

### Fix

- If `council-platform` is down, the dashboard cannot start until it returns.
  Wait or restart `council-platform`.
- If Soroban RPC is throttling or down, switch `STELLAR_RPC_URL` to a fallback
  endpoint via `fly secrets set` and redeploy.

## WebSocket / Live Stream Issues

### Symptoms

- WebSocket clients connect but never receive frames after the initial snapshot
- Snapshot arrives but `recent` events feed is empty

### Diagnosis

- Check Soroban polling: the forward poll runs every 5s after cold-start. If the
  upstream is slow, frames may lag.
- Check `LOG_LEVEL=DEBUG` to inspect per-poll cursor advancement and event
  parsing.
- Check the OTel exporter — sustained 5xx from the OTLP endpoint can back-
  pressure the runtime.

## Logs

### Current: Fly CLI

```bash
# Real-time logs (testnet)
fly logs -a moonlight-beta-network-dashboard-platform

# Real-time logs (mainnet)
fly logs -a moonlight-mainnet-network-dashboard

# Logs for a specific machine
fly logs -a moonlight-beta-network-dashboard-platform -i <machine-id>
```

Limitation: logs are only available while machines are running or recently
stopped. Crash logs from long-stopped machines may be unavailable.

### Persistent Logs: Fly.io Log Shipper

Fly.io has built-in log shipping (`fly logs ship`) that can send to various
destinations (Logtail, Datadog, S3, etc.). For persistent logs that survive
machine crashes, configure a log drain:

```bash
# Example with Logtail (free tier: 1 GB/month)
fly logs ship --logtail-token=<token> -a moonlight-beta-network-dashboard-platform
```

Not needed yet — `fly logs` via CLI or dashboard is sufficient for current
testnet usage. Consider adding when debugging becomes harder (more frequent
deploys, multiple team members).
