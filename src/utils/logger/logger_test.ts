import { assert, assertEquals } from "@std/assert";
import { Level, newLogger, type Writer } from "./index.ts";
import { StructuredError } from "@/error/structured-error.ts";

function captureWriter(): { writer: Writer; lines: string[] } {
  const lines: string[] = [];
  return { writer: { write: (line) => lines.push(line) }, lines };
}

Deno.test("error() flattens the native cause chain into an A <- B <- C string", () => {
  const { writer, lines } = captureWriter();
  const log = newLogger(Level.Info, { writer });

  // Mirrors the real layering: council-fetch wraps the raw transport error,
  // then topology-refresh adds its own outer layer keeping that as the cause.
  const root = new Error("getaddrinfo ENOTFOUND council");
  const mid = StructuredError.from(root, {
    code: "COUNCIL_PLATFORM_UNREACHABLE",
    source: "council-fetch",
    message: "council-platform request failed",
  });
  const outer = new StructuredError({
    code: "TOPOLOGY_REFRESH_FAILED",
    source: "topology-refresh",
    message: "Failed to refresh network topology from council-platform",
    cause: mid,
  });

  log.error(outer, "topology refresh failed");

  assertEquals(lines.length, 1);
  const line = lines[0];
  assert(
    line.includes(
      "Failed to refresh network topology from council-platform <- " +
        "council-platform request failed <- getaddrinfo ENOTFOUND council",
    ),
    `expected flattened cause chain, got: ${line}`,
  );
});

Deno.test("error() handles a single (unwrapped) error without a trailing arrow", () => {
  const { writer, lines } = captureWriter();
  const log = newLogger(Level.Info, { writer });
  log.error(new Error("solo failure"), "boom");
  assert(lines[0].includes('error="solo failure"'));
  assert(!lines[0].includes("<-"));
});

Deno.test("error() always emits even when the level would suppress it", () => {
  const { writer, lines } = captureWriter();
  const log = newLogger(Level.Disabled, { writer });
  log.error(new Error("still logged"), "boom");
  assertEquals(lines.length, 1);
});
