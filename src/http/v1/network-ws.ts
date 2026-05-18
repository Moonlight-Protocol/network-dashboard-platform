import type { Context } from "@oak/oak";
import { Router } from "@oak/oak";
import { LOG } from "@/config/logger.ts";
import { networkEventBus } from "@/core/events/bus.ts";
import { buildSnapshotFrame } from "@/core/state/snapshot.ts";
import {
  NETWORK_WS_SUBPROTOCOL,
  type ServerFrame,
} from "@/core/events/types.ts";

const IDLE_TIMEOUT_SECONDS = 30;

/**
 * Public WebSocket for the network-dashboard ticker.
 *
 * Path: `/api/v1/network/ws` (documented in README).
 * No auth — by design (dashboard is public, anonymous).
 *
 * Frame protocol (server → client):
 *   { type: "snapshot", counters, topology, recent, generatedAt }
 *     — sent once on open, captures current network state for an instant
 *     SPA paint.
 *   { type: "event", event: NetworkEvent }
 *     — sent for each live event after the snapshot.
 *
 * No client → server frames. Clients reconnect rather than keep-alive.
 */
export function networkWsHandler(ctx: Context): void {
  if (!ctx.isUpgradable) {
    ctx.response.status = 426;
    ctx.response.body = { error: "WebSocket upgrade required" };
    return;
  }

  const socket = ctx.upgrade({
    protocol: NETWORK_WS_SUBPROTOCOL,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
  });

  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const sendFrame = (frame: ServerFrame): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch (err) {
      LOG.warn("Failed to send network WS frame", {
        type: frame.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  socket.onopen = () => {
    sendFrame(buildSnapshotFrame());
    unsubscribe = networkEventBus.subscribe((event) => {
      sendFrame({ type: "event", event });
    });
    LOG.info("Network WS opened", {
      subscribers: networkEventBus.listenerCount(),
    });
  };

  socket.onclose = () => {
    cleanup();
    LOG.info("Network WS closed");
  };

  socket.onerror = (event) => {
    LOG.warn("Network WS error", {
      message: event instanceof ErrorEvent ? event.message : "unknown",
    });
    cleanup();
  };
}

export const networkWsRouter = new Router();
networkWsRouter.get("/network/ws", networkWsHandler);
