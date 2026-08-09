/**
 * replay (test re-export) — the fold now lives in PRODUCTION at src/world/replay.ts (promoted for
 * the engine's bounded rewind, 2026-07-12). This thin shim keeps the many `tests/support/replay.ts`
 * importers (and the `snapshot == fold(deltas)` invariant test) pointed at one place, so the
 * invariant now proves the shipped fold rather than a test-only copy.
 *
 * @author Runkai Zhang
 */
export { applyDelta, reduceDeltas, isDelta } from "../../src/world/replay.ts";
