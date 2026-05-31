import { type Logger, newLogger, parseLevel } from "@/utils/logger/index.ts";

/**
 * Creates the root logger from `LOG_LEVEL` env var. Called once in main.ts;
 * the returned logger is threaded through to every service and free function
 * via dependency injection. There is no module-level singleton.
 */
export function createLogger(): Logger {
  return newLogger(parseLevel(Deno.env.get("LOG_LEVEL")));
}
