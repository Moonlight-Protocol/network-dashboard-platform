import { assert, assertEquals } from "@std/assert";
import { StructuredError } from "./structured-error.ts";

Deno.test("toWire projects only the client-safe { code, source, message }", () => {
  const e = new StructuredError({
    code: "COUNCIL_PLATFORM_HTTP_ERROR",
    source: "network-dashboard-platform/council-fetch",
    message: "council-platform returned HTTP 503",
    cause: new Error("connection reset"),
  });
  assertEquals(e.toWire(), {
    code: "COUNCIL_PLATFORM_HTTP_ERROR",
    source: "network-dashboard-platform/council-fetch",
    message: "council-platform returned HTTP 503",
  });
  // The cause is preserved on the instance but never leaks through the wire.
  assert(e.cause instanceof Error);
  assertEquals((e.cause as Error).message, "connection reset");
});

Deno.test("from wraps an arbitrary error, preserving it as the cause", () => {
  const root = new Error("getaddrinfo ENOTFOUND council");
  const wrapped = StructuredError.from(root, {
    code: "COUNCIL_PLATFORM_UNREACHABLE",
    source: "network-dashboard-platform/council-fetch",
    message: "council-platform request failed",
  });
  assertEquals(wrapped.code, "COUNCIL_PLATFORM_UNREACHABLE");
  assertEquals(wrapped.message, "council-platform request failed");
  assertEquals(wrapped.cause, root);
});

Deno.test("from is idempotent — an existing StructuredError passes through untouched", () => {
  const original = new StructuredError({
    code: "COUNCIL_PLATFORM_HTTP_ERROR",
    source: "network-dashboard-platform/council-fetch",
    message: "council-platform returned HTTP 500",
  });
  const rewrapped = StructuredError.from(original, {
    code: "TOPOLOGY_REFRESH_FAILED",
    source: "network-dashboard-platform/topology-refresh",
  });
  // Same instance, original code retained — re-wrapping up the stack must not
  // bury the inner code.
  assert(rewrapped === original);
  assertEquals(rewrapped.code, "COUNCIL_PLATFORM_HTTP_ERROR");
});

Deno.test("from defaults message to the wrapped error's message when none given", () => {
  const wrapped = StructuredError.from(new Error("boom"), {
    code: "TOPOLOGY_REFRESH_FAILED",
    source: "network-dashboard-platform/topology-refresh",
  });
  assertEquals(wrapped.message, "boom");
});

Deno.test("from stringifies non-Error causes", () => {
  const wrapped = StructuredError.from("plain string failure", {
    code: "TOPOLOGY_REFRESH_FAILED",
    source: "network-dashboard-platform/topology-refresh",
  });
  assertEquals(wrapped.message, "plain string failure");
  assertEquals(wrapped.cause, "plain string failure");
});
