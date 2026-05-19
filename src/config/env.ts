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
 */
import { load } from "@std/dotenv";

const fileEnv = await load();

function get(key: string): string | undefined {
  const fromFile = fileEnv[key];
  if (fromFile !== undefined) return fromFile;
  return Deno.env.get(key);
}

function require(key: string): string {
  const value = get(key);
  if (value === undefined || value === "") {
    throw new Error(`${key} is required but was not set`);
  }
  return value;
}

export const PORT = Number(get("PORT") ?? "8080");
export const MODE = get("MODE") ?? "development";
export const NETWORK = require("NETWORK");
export const STELLAR_RPC_URL = require("STELLAR_RPC_URL");
export const COUNCIL_PLATFORM_URL = require("COUNCIL_PLATFORM_URL");
export const LOG_LEVEL = get("LOG_LEVEL") ?? "INFO";

/** Origins allowed to open WS / hit HTTP endpoints. Comma-separated. */
export const ALLOWED_ORIGINS = (get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (NETWORK !== "testnet" && NETWORK !== "mainnet" && NETWORK !== "local") {
  throw new Error(
    `NETWORK must be 'testnet' | 'mainnet' | 'local' (got: ${NETWORK})`,
  );
}

export const IS_DEV = MODE === "development";
