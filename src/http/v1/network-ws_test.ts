import { assert, assertEquals } from "@std/assert";
import { newNoop } from "@/utils/logger/index.ts";
import { NetworkEventBus } from "@/core/events/bus.ts";
import {
  NETWORK_WS_SUBPROTOCOL,
  type NetworkEvent,
} from "@/core/events/types.ts";
import { handleNetworkWs } from "./network-ws.ts";

/**
 * Deterministic unit tests for `handleNetworkWs` — the public network ticker
 * WebSocket — mirroring provider-platform's `ws-handler_test.ts`.
 *
 * The handler is exercised with a fully MOCKED WebSocket and a real
 * `NetworkEventBus`, so we assert the server's own behaviour without a live
 * socket, random port, or wall-clock timing:
 *   - non-upgradable request short-circuits with 426 and never upgrades
 *   - the upgrade is configured with our subprotocol + idle-timeout (the
 *     keep-alive knob that keeps the connection alive across the quiet gaps
 *     between chain events — the property the deployed harness depends on)
 *   - a snapshot frame is sent on open
 *   - events published on the bus AFTER open are delivered to the socket
 *   - the not-OPEN drop guard
 *   - unsubscribe on close (no delivery after the socket closes)
 *
 * This is the local, deterministic analogue of "did the server actually
 * deliver events to a connected client?" — the question the deployed
 * events-capture `network` stream answers black-box.
 */

class MockSocket {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  triggerOpen() {
    this.onopen?.();
  }
  triggerClose() {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
}

interface MockCtx {
  ctx: unknown;
  res: { status: number; body: unknown };
  upgradeArgs: { protocol?: string; idleTimeout?: number } | null;
}

function mockCtx(opts: {
  upgradable?: boolean;
  socket?: MockSocket;
}): MockCtx {
  const res = { status: 0, body: undefined as unknown };
  const state: MockCtx = { ctx: null, res, upgradeArgs: null };
  state.ctx = {
    isUpgradable: opts.upgradable ?? true,
    response: res,
    upgrade(args: { protocol?: string; idleTimeout?: number }) {
      state.upgradeArgs = args;
      return opts.socket;
    },
  };
  return state;
}

let evSeq = 0;
function mkEvent(kind: NetworkEvent["kind"]): NetworkEvent {
  evSeq += 1;
  return {
    id: `ev-${evSeq}`,
    kind,
    councilId: "CCOUNCIL0000000000000000000000000000000000000000000000",
    councilName: "Test Council",
    ledger: evSeq,
    occurredAt: new Date(0).toISOString(),
    payload: {},
  };
}

const deps = () => ({
  log: newNoop(),
  bus: new NetworkEventBus({ log: newNoop() }),
});

Deno.test("rejects non-upgradable request with 426", () => {
  const d = deps();
  const m = mockCtx({ upgradable: false });
  handleNetworkWs(d)(m.ctx as never);
  assertEquals(m.res.status, 426);
  assertEquals(m.upgradeArgs, null);
});

Deno.test("upgrades with subprotocol + idle-timeout, sends snapshot, delivers live events, drops when not OPEN, unsubscribes on close", () => {
  const d = deps();
  const socket = new MockSocket();
  const m = mockCtx({ socket });

  handleNetworkWs(d)(m.ctx as never);

  // upgraded with our subprotocol + the keep-alive idle timeout
  assert(m.upgradeArgs !== null, "expected ctx.upgrade to be called");
  assertEquals(m.upgradeArgs!.protocol, NETWORK_WS_SUBPROTOCOL);
  assert(
    typeof m.upgradeArgs!.idleTimeout === "number" &&
      m.upgradeArgs!.idleTimeout > 0,
    "expected a positive idleTimeout (the keep-alive knob)",
  );

  // snapshot is sent on open, and the bus subscription is registered
  socket.triggerOpen();
  assertEquals(socket.sent.length, 1);
  assertEquals(
    (JSON.parse(socket.sent[0]) as { type: string }).type,
    "snapshot",
  );
  assertEquals(d.bus.listenerCount(), 1);

  // an event published AFTER open is delivered as a live event frame
  d.bus.publish(mkEvent("council_formed"));
  assertEquals(socket.sent.length, 2);
  const frame = JSON.parse(socket.sent[1]) as {
    type: string;
    event: NetworkEvent;
  };
  assertEquals(frame.type, "event");
  assertEquals(frame.event.kind, "council_formed");

  // a second event also flows (delivery is durable, not one-shot)
  d.bus.publish(mkEvent("provider_added"));
  assertEquals(socket.sent.length, 3);

  // drop guard: not delivered when the socket isn't OPEN
  socket.readyState = WebSocket.CLOSING;
  d.bus.publish(mkEvent("channel_deposit"));
  assertEquals(socket.sent.length, 3);

  // unsubscribe on close: nothing delivered afterwards, listener removed
  socket.triggerClose();
  assertEquals(d.bus.listenerCount(), 0);
  d.bus.publish(mkEvent("channel_settlement"));
  assertEquals(socket.sent.length, 3);
});
