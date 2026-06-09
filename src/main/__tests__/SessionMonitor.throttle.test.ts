import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { SessionMonitor } from "../SessionMonitor.js";

/**
 * Validates the throttle + guaranteed-trailing behavior of schedulePump()
 * (the leading-edge-to-throttle fix). We reach the private method and stub the
 * private pump() so no real file I/O happens — we only observe the scheduling.
 *
 * Contract under test (SessionMonitor.ts schedulePump):
 *  - leading edge: the first event fires a pump after ~120ms
 *  - events during the in-flight window are coalesced (pumpPending) into exactly
 *    ONE trailing pump, never stranded until the 3s tick
 *  - while paused/stopped, schedulePump is a no-op
 */

interface Internals {
  schedulePump(): void;
  pump(): Promise<void>;
  paused: boolean;
  stopped: boolean;
  pumpPending: boolean;
}

function makeMonitor(): { mon: SessionMonitor; internals: Internals; pumpSpy: ReturnType<typeof mock.fn> } {
  const mon = new SessionMonitor(() => {});
  const internals = mon as unknown as Internals;
  const pumpSpy = mock.fn(() => Promise.resolve());
  internals.pump = pumpSpy as unknown as () => Promise<void>;
  return { mon, internals, pumpSpy };
}

test("THROTTLE_WINDOW: a single burst of events fires exactly one pump after the window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { internals, pumpSpy } = makeMonitor();

  // 5 rapid events within the throttle window
  for (let i = 0; i < 5; i++) internals.schedulePump();
  assert.equal(pumpSpy.mock.callCount(), 0, "no pump yet, still inside the throttle window");

  t.mock.timers.tick(120);
  assert.equal(pumpSpy.mock.callCount(), 1, "leading pump fires once after 120ms");
});

test("TRAILING: an event during the in-flight window guarantees one extra trailing pump", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { internals, pumpSpy } = makeMonitor();

  internals.schedulePump(); // arms the timer
  // a second event arrives while the timer is pending -> sets pumpPending
  internals.schedulePump();
  assert.equal(internals.pumpPending, true, "event during the window marks a trailing pump pending");

  t.mock.timers.tick(120); // first pump fires, then re-arms for the tail
  assert.equal(pumpSpy.mock.callCount(), 1, "leading pump");

  t.mock.timers.tick(120); // trailing pump fires
  assert.equal(pumpSpy.mock.callCount(), 2, "guaranteed trailing pump caught the tail of the burst");
});

test("QUIESCE: no further events -> no extra pumps after the trailing one", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { internals, pumpSpy } = makeMonitor();

  internals.schedulePump();
  internals.schedulePump(); // one pending
  t.mock.timers.tick(120); // leading
  t.mock.timers.tick(120); // trailing
  t.mock.timers.tick(1000); // long idle
  assert.equal(pumpSpy.mock.callCount(), 2, "no runaway re-scheduling once the burst is drained");
});

test("PAUSED: schedulePump is a no-op while paused", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { internals, pumpSpy } = makeMonitor();
  internals.paused = true;
  internals.schedulePump();
  t.mock.timers.tick(500);
  assert.equal(pumpSpy.mock.callCount(), 0, "no pump scheduled while the panel is hidden");
});

test("STOPPED: schedulePump is a no-op once stopped", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { internals, pumpSpy } = makeMonitor();
  internals.stopped = true;
  internals.schedulePump();
  t.mock.timers.tick(500);
  assert.equal(pumpSpy.mock.callCount(), 0, "no pump after stop()");
});
