import type { Context } from "@oak/oak";
import { Router, Status } from "@oak/oak";
import type { Logger } from "@/utils/logger/index.ts";
import {
  getPublicRpcRateLimit,
  getPublicRpcRateWindowMs,
  getStellarRpcUrl,
} from "@/config/env.ts";

/**
 * Public, read-only Soroban JSON-RPC passthrough proxy.
 *
 * Path: `POST /api/v1/public/rpc`. No auth — by design. The browser-wallet
 * extension points its network-level RPC URL here so the RPC-Pro token never
 * ships in the extension bundle; the token is injected server-side from
 * `STELLAR_RPC_URL`. Reads of public chain data are sybil-able, so JWT/keypair
 * gating buys nothing here — per-IP rate-limiting is the abuse control.
 *
 * Allowlist: READ-ONLY methods only — the wallet's chain reads + simulations.
 * No `sendTransaction`, no writes (the wallet submits bundles through its PP,
 * not RPC). Unknown methods are rejected with a JSON-RPC error, not a 500.
 */
const ALLOWED_METHODS = new Set<string>([
  "getAccount",
  "getLedgerEntries",
  "simulateTransaction",
  "getLatestLedger",
]);

type JsonRpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown };

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function firstId(payload: unknown): unknown {
  if (Array.isArray(payload)) return null;
  const id = (payload as JsonRpcRequest | null)?.id;
  return id ?? null;
}

/**
 * Resolve the real client IP. Behind Fly, `Fly-Client-IP` carries the true
 * origin; `X-Forwarded-For`'s first hop is the fallback; the socket address
 * is the last resort for local/direct connections.
 */
function clientIp(ctx: Context): string {
  const fly = ctx.request.headers.get("fly-client-ip");
  if (fly) return fly.trim();
  const xff = ctx.request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return ctx.request.ip || "unknown";
}

type Bucket = { count: number; resetAt: number };

/**
 * Fixed-window per-IP limiter. In-process (per Fly machine) — adequate for the
 * single-instance dashboard backend; if this is ever scaled horizontally the
 * window becomes per-instance (flag for a shared store at that point).
 */
function makeRateLimiter() {
  const buckets = new Map<string, Bucket>();
  return function allow(ip: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    // Opportunistic prune so the map can't grow without bound.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
    }
    const b = buckets.get(ip);
    if (!b || now >= b.resetAt) {
      buckets.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (b.count >= limit) return false;
    b.count++;
    return true;
  };
}

export function handlePublicRpc(
  deps: { log: Logger },
): (ctx: Context) => Promise<void> {
  const log = deps.log.scope("publicRpc");
  const allow = makeRateLimiter();

  return async (ctx) => {
    if (
      !allow(clientIp(ctx), getPublicRpcRateLimit(), getPublicRpcRateWindowMs())
    ) {
      log.debug("status", Status.TooManyRequests);
      ctx.response.status = Status.TooManyRequests;
      ctx.response.body = jsonRpcError(null, -32005, "Rate limit exceeded");
      return;
    }

    let payload: unknown;
    try {
      payload = await ctx.request.body.json();
    } catch {
      ctx.response.status = Status.BadRequest;
      ctx.response.body = jsonRpcError(null, -32700, "Parse error");
      return;
    }

    // Soroban RPC sends single requests; tolerate a JSON-RPC batch (array)
    // defensively — every method in it must be allowlisted.
    const entries: JsonRpcRequest[] = Array.isArray(payload)
      ? payload as JsonRpcRequest[]
      : [payload as JsonRpcRequest];

    for (const entry of entries) {
      const method = typeof entry?.method === "string" ? entry.method : "";
      if (!ALLOWED_METHODS.has(method)) {
        log.debug("rejected method", method || "(none)");
        ctx.response.status = Status.OK;
        ctx.response.body = jsonRpcError(
          entry?.id ?? null,
          -32601,
          `Method not allowed: ${method || "(none)"}`,
        );
        return;
      }
    }

    let upstream: Response;
    try {
      upstream = await fetch(getStellarRpcUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      log.error(error, "upstream RPC fetch failed");
      ctx.response.status = Status.BadGateway;
      ctx.response.body = jsonRpcError(
        firstId(payload),
        -32603,
        "Upstream RPC unreachable",
      );
      return;
    }

    const text = await upstream.text();
    // Method + status only — never request/response bodies.
    log.debug("method", entries.map((e) => e?.method ?? "").join(","));
    log.debug("status", upstream.status);

    ctx.response.status = upstream.status;
    try {
      ctx.response.body = JSON.parse(text);
    } catch {
      ctx.response.body = text;
    }
  };
}

export function buildPublicRpcRouter(deps: { log: Logger }): Router {
  const router = new Router();
  router.post("/public/rpc", handlePublicRpc(deps));
  return router;
}
