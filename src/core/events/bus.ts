import type { Logger } from "@/utils/logger/index.ts";
import type { StructuredErrorShape } from "@/error/structured-error.ts";
import type { NetworkEvent } from "./types.ts";

type Listener = (event: NetworkEvent) => void;
type ErrorListener = (error: StructuredErrorShape) => void;

/**
 * In-process pub/sub for the public network-dashboard event stream.
 *
 * Single-instance per env by design (one Fly machine per app), so an
 * in-process bus is sufficient — no Postgres LISTEN/NOTIFY or external
 * broker. If we ever scale horizontally, this is the layer that gets
 * replaced.
 *
 * A misbehaving listener must never break the publish loop — every
 * delivery is wrapped in a try/catch and reported via the injected logger.
 */
export class NetworkEventBus {
  private listeners = new Set<Listener>();
  private errorListeners = new Set<ErrorListener>();
  private log: Logger;

  constructor(deps: { log: Logger }) {
    this.log = deps.log.scope("NetworkEventBus");
  }

  subscribe(listener: Listener): () => void {
    this.log.info("subscribe");
    this.listeners.add(listener);
    this.log.debug("listenerCount", this.listeners.size);
    return () => {
      this.log.info("unsubscribe");
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe to structured error broadcasts (topology refresh failures and
   * the like) — a separate channel from the event stream so a subscriber can
   * surface a degraded-data banner without it landing in the activity feed.
   */
  subscribeErrors(listener: ErrorListener): () => void {
    this.log.info("subscribeErrors");
    this.errorListeners.add(listener);
    this.log.debug("errorListenerCount", this.errorListeners.size);
    return () => {
      this.log.info("unsubscribeErrors");
      this.errorListeners.delete(listener);
    };
  }

  publish(event: NetworkEvent): void {
    this.log.info("publish");
    this.log.debug("eventKind", event.kind);
    this.log.debug("listenerCount", this.listeners.size);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.error(err, "listener threw during publish");
      }
    }
  }

  /**
   * Broadcast a client-safe structured error to error subscribers. Same
   * listener-isolation guarantee as `publish`: one bad listener never breaks
   * the fan-out.
   */
  publishError(error: StructuredErrorShape): void {
    this.log.info("publishError");
    this.log.debug("errorCode", error.code);
    this.log.debug("errorListenerCount", this.errorListeners.size);
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch (err) {
        this.log.error(err, "error listener threw during publishError");
      }
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  errorListenerCount(): number {
    return this.errorListeners.size;
  }
}
