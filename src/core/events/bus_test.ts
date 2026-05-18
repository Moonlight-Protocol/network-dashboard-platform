import { assertEquals } from "@std/assert";
import { networkEventBus } from "./bus.ts";
import type { NetworkEvent } from "./types.ts";

function ev(id: string): NetworkEvent {
  return {
    id,
    kind: "provider_added",
    councilId: "C",
    councilName: null,
    ledger: 1,
    occurredAt: new Date(0).toISOString(),
    payload: {},
  };
}

Deno.test("subscribe delivers, unsubscribe stops delivery", () => {
  const received: string[] = [];
  const unsub = networkEventBus.subscribe((e) => received.push(e.id));
  networkEventBus.publish(ev("a"));
  networkEventBus.publish(ev("b"));
  unsub();
  networkEventBus.publish(ev("c"));
  assertEquals(received, ["a", "b"]);
});

Deno.test("publish survives a throwing listener", () => {
  const received: string[] = [];
  const u1 = networkEventBus.subscribe(() => {
    throw new Error("boom");
  });
  const u2 = networkEventBus.subscribe((e) => received.push(e.id));
  networkEventBus.publish(ev("x"));
  u1();
  u2();
  assertEquals(received, ["x"]);
});

Deno.test("listenerCount reflects subscriptions", () => {
  const u1 = networkEventBus.subscribe(() => {});
  const u2 = networkEventBus.subscribe(() => {});
  assertEquals(networkEventBus.listenerCount(), 2);
  u1();
  u2();
  assertEquals(networkEventBus.listenerCount(), 0);
});
