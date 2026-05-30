import { assertEquals } from "@std/assert";
import { NetworkEventBus } from "./bus.ts";
import { newNoop } from "@/utils/logger/index.ts";
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

function newBus(): NetworkEventBus {
  return new NetworkEventBus({ log: newNoop() });
}

Deno.test("subscribe delivers, unsubscribe stops delivery", () => {
  const bus = newBus();
  const received: string[] = [];
  const unsub = bus.subscribe((e) => received.push(e.id));
  bus.publish(ev("a"));
  bus.publish(ev("b"));
  unsub();
  bus.publish(ev("c"));
  assertEquals(received, ["a", "b"]);
});

Deno.test("publish survives a throwing listener", () => {
  const bus = newBus();
  const received: string[] = [];
  const u1 = bus.subscribe(() => {
    throw new Error("boom");
  });
  const u2 = bus.subscribe((e) => received.push(e.id));
  bus.publish(ev("x"));
  u1();
  u2();
  assertEquals(received, ["x"]);
});

Deno.test("listenerCount reflects subscriptions", () => {
  const bus = newBus();
  const u1 = bus.subscribe(() => {});
  const u2 = bus.subscribe(() => {});
  assertEquals(bus.listenerCount(), 2);
  u1();
  u2();
  assertEquals(bus.listenerCount(), 0);
});
