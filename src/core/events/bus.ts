import type { Logger } from "@/utils/logger/index.ts";
import type { NetworkEvent } from "./types.ts";

type Listener = (event: NetworkEvent) => void;

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

  listenerCount(): number {
    return this.listeners.size;
  }
}
