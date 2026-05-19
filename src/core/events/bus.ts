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
 * delivery is wrapped in a try/catch.
 */
class NetworkEventBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: NetworkEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn("[network-event-bus] listener threw:", err);
      }
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

export const networkEventBus = new NetworkEventBus();
