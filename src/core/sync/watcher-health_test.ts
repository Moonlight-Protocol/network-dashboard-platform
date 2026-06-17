import { assertEquals } from "@std/assert";
import { newNoop } from "@/utils/logger/index.ts";
import { NetworkEventBus } from "@/core/events/bus.ts";
import {
  getWatcherHealth,
  startSorobanWatcher,
  stopSorobanWatcher,
} from "./soroban-watcher.ts";

/**
 * Guards the stranded-watcher detection that `/health` relies on.
 *
 * The failure this makes observable: `bootstrap()` swallows a failed
 * `coldStartScan` and starts the watcher anyway, so the forward poller runs
 * with a null cursor and silently ingests nothing while `/health` stays
 * green — the mode that froze the deployed dashboard for weeks. The
 * `running && !armed` state must be reportable so `/health` can return 503.
 */
Deno.test("getWatcherHealth: idle is not stranded; running-without-a-cursor is", () => {
  // Fresh module state (no other test arms the cursor): idle, not stranded.
  assertEquals(getWatcherHealth(), {
    running: false,
    armed: false,
    strandedTickCount: 0,
  });

  // Mimic bootstrap()'s swallowed-cold-start path: watcher started, never
  // armed with a cursor. The scheduled tick is cleared by stop before it
  // fires, so no real Soroban call / timer leaks.
  startSorobanWatcher({
    log: newNoop(),
    bus: new NetworkEventBus({ log: newNoop() }),
  });
  try {
    const h = getWatcherHealth();
    assertEquals(h.running, true);
    assertEquals(h.armed, false); // running && !armed === stranded → /health 503
  } finally {
    stopSorobanWatcher({ log: newNoop() });
  }

  assertEquals(getWatcherHealth().running, false);
});
