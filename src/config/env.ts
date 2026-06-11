/**
 * Env loader for network-dashboard-platform.
 *
 * Source of truth: iac/env-registry.yaml (testnet.dashboard / mainnet.dashboard).
 * Values arrive as Fly env vars + the per-env fly.{testnet,mainnet}.toml
 * `[env]` block. `.env` is consulted for local development.
 *
 * Rule (inherited from council-platform): only INFRASTRUCTURE + OPERATIONAL
 * config goes here. There is no application state — councils/PPs/channels
 * are discovered at runtime from council-platform + Soroban.
 *
 * Loading is lazy. The required-vars validation fires the first time a
 * getter is called, not at module-import. That keeps tests that don't
 * exercise the env-touching paths (e.g. pure unit tests of event mappers,
 * state stores, watcher dedup) from having to set env vars they don't use.
 *
 * Lookup precedence: process env (`Deno.env.get`) FIRST, `.env` file
 * SECOND. Process env represents the deployed reality (Fly secrets, CI,
 * test overrides); `.env` is the local-dev default. The previous order
 * (file first) silently overrode test/CI overrides on machines with a
 * populated `.env`.
 */
import { loadSync } from "@std/dotenv";

let fileEnvCache: Record<string, string> | null = null;
function fileEnv(): Record<string, string> {
  if (fileEnvCache === null) {
    try {
      fileEnvCache = loadSync();
    } catch {
      fileEnvCache = {};
    }
  }
  return fileEnvCache;
}

function get(key: string): string | undefined {
  const fromProcess = Deno.env.get(key);
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  const fromFile = fileEnv()[key];
  if (fromFile !== undefined && fromFile !== "") return fromFile;
  return undefined;
}

function requireEnv(key: string): string {
  const value = get(key);
  if (value === undefined) {
    throw new Error(`${key} is required but was not set`);
  }
  return value;
}

let networkCache: string | undefined;
export function getNetwork(): string {
  if (networkCache !== undefined) return networkCache;
  const v = requireEnv("NETWORK");
  if (v !== "testnet" && v !== "mainnet" && v !== "local") {
    throw new Error(
      `NETWORK must be 'testnet' | 'mainnet' | 'local' (got: ${v})`,
    );
  }
  networkCache = v;
  return v;
}

let stellarRpcUrlCache: string | undefined;
export function getStellarRpcUrl(): string {
  if (stellarRpcUrlCache === undefined) {
    stellarRpcUrlCache = requireEnv("STELLAR_RPC_URL");
  }
  return stellarRpcUrlCache;
}

let councilPlatformUrlCache: string | undefined;
export function getCouncilPlatformUrl(): string {
  if (councilPlatformUrlCache === undefined) {
    councilPlatformUrlCache = requireEnv("COUNCIL_PLATFORM_URL");
  }
  return councilPlatformUrlCache;
}

export function getPort(): number {
  return Number(get("PORT") ?? "8080");
}

/**
 * IP rate-limit for the public Soroban RPC proxy (`POST /api/v1/public/rpc`).
 * The proxy is an open, JWT-less read relay, so per-IP rate-limiting is the
 * abuse control. Both are optional with sane defaults — no iac registration
 * needed; override via Fly env if a deployment needs tighter/looser limits.
 * Default: 120 requests per 60s per client IP.
 */
export function getPublicRpcRateLimit(): number {
  return Number(get("PUBLIC_RPC_RATE_LIMIT") ?? "120");
}

export function getPublicRpcRateWindowMs(): number {
  return Number(get("PUBLIC_RPC_RATE_WINDOW_MS") ?? "60000");
}

export function getMode(): string {
  return get("MODE") ?? "development";
}

export function getLogLevel(): string {
  return get("LOG_LEVEL") ?? "INFO";
}

/** Origins allowed to open WS / hit HTTP endpoints. Comma-separated. */
export function getAllowedOrigins(): string[] {
  return (get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function isDev(): boolean {
  return getMode() === "development";
}

/**
 * Test-only seam. Resets the cached values so a test can change env vars
 * and observe the new behavior without re-importing the module.
 */
export function __resetEnvCacheForTests(): void {
  fileEnvCache = null;
  networkCache = undefined;
  stellarRpcUrlCache = undefined;
  councilPlatformUrlCache = undefined;
}
