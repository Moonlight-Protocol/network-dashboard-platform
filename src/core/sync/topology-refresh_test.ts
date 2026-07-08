import { assertEquals } from "@std/assert";
import { newNoop } from "@/utils/logger/index.ts";
import { NetworkEventBus } from "@/core/events/bus.ts";
import type { StructuredErrorShape } from "@/error/structured-error.ts";
import { __resetEnvCacheForTests } from "@/config/env.ts";
import { refreshTopology } from "./topology-refresh.ts";

/**
 * Exercises the council-fetch → topology-refresh error path end to end: an
 * upstream failure must be wrapped with context and broadcast as a
 * client-safe structured error frame on the bus (the signal a connected
 * dashboard turns into a "data may be stale" banner).
 */

function withStubbedFetch(
  impl: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function captureErrors(bus: NetworkEventBus): StructuredErrorShape[] {
  const errors: StructuredErrorShape[] = [];
  bus.subscribeErrors((e) => errors.push(e));
  return errors;
}

Deno.test("refreshTopology broadcasts TOPOLOGY_REFRESH_FAILED when council-platform returns non-OK", async () => {
  Deno.env.set("COUNCIL_PLATFORM_URL", "http://council.test");
  __resetEnvCacheForTests();

  const bus = new NetworkEventBus({ log: newNoop() });
  const errors = captureErrors(bus);

  await withStubbedFetch(
    () => Promise.resolve(new Response("nope", { status: 503 })),
    () => refreshTopology("test", { log: newNoop(), bus }),
  );

  assertEquals(errors.length, 1);
  assertEquals(errors[0].code, "TOPOLOGY_REFRESH_FAILED");
  assertEquals(errors[0].source, "network-dashboard-platform/topology-refresh");

  __resetEnvCacheForTests();
});

Deno.test("refreshTopology broadcasts TOPOLOGY_REFRESH_FAILED when the request itself throws", async () => {
  Deno.env.set("COUNCIL_PLATFORM_URL", "http://council.test");
  __resetEnvCacheForTests();

  const bus = new NetworkEventBus({ log: newNoop() });
  const errors = captureErrors(bus);

  await withStubbedFetch(
    () => Promise.reject(new TypeError("error sending request")),
    () => refreshTopology("test", { log: newNoop(), bus }),
  );

  assertEquals(errors.length, 1);
  assertEquals(errors[0].code, "TOPOLOGY_REFRESH_FAILED");

  __resetEnvCacheForTests();
});
