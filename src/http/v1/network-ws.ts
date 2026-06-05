import type { Context } from "@oak/oak";
import { Router } from "@oak/oak";
import type { Logger } from "@/utils/logger/index.ts";
import type { NetworkEventBus } from "@/core/events/bus.ts";
import { buildSnapshotFrame } from "@/core/state/snapshot.ts";
import {
  NETWORK_WS_SUBPROTOCOL,
  type ServerFrame,
} from "@/core/events/types.ts";

/**
 * Deno's `idleTimeout` closes the WebSocket when neither side has sent
 * data for this many seconds. The SPA receives the snapshot frame
 * immediately on open, then nothing until the first chain event maps
 * to a NetworkEvent — which can easily exceed 30 s on a quiet network
 * or during a fresh deploy that does most of its work before the first
 * SAC event lands.
 *
 * 30 s caused programmatic subscribers (the events-capture harness in
 * `local-dev/testnet/events-capture/`) to lose the back-fill burst that
 * follows a new-council adoption: `council_formed` and `provider_added`
 * publish 25-40 s after deploy, so the WS was already closed by the
 * time `bus.publish` fired.
 *
 * 300 s gives plenty of headroom for slow flows. SPA reconnect-on-close
 * behaviour stays unchanged — this only widens the inactivity window.
 */
const IDLE_TIMEOUT_SECONDS = 300;

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
export function handleNetworkWs(
  deps: { log: Logger; bus: NetworkEventBus },
): (ctx: Context) => void {
  const log = deps.log.scope("networkWs");

  return (ctx: Context) => {
    log.info("handleNetworkWs");

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
        log.debug("type", frame.type);
        log.error(err, "failed to send network WS frame");
      }
    };

    socket.onopen = () => {
      sendFrame(buildSnapshotFrame());
      unsubscribe = deps.bus.subscribe((event) => {
        sendFrame({
          type: "event",
          event,
          counters: buildSnapshotFrame().counters,
        });
      });
      log.debug("subscribers", deps.bus.listenerCount());
      log.event("network WS opened");
    };

    socket.onclose = () => {
      cleanup();
      log.event("network WS closed");
    };

    socket.onerror = (event) => {
      log.debug(
        "message",
        event instanceof ErrorEvent ? event.message : "unknown",
      );
      log.error(event, "network WS error");
      cleanup();
    };
  };
}

export function buildNetworkWsRouter(
  deps: { log: Logger; bus: NetworkEventBus },
): Router {
  const router = new Router();
  router.get("/network/ws", handleNetworkWs(deps));
  return router;
}
