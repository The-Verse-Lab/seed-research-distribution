/**
 * Exit-state — value shapes + pure helpers for the mutable exit-state overlay (Workstream H).
 *
 * CONTENT authors the obstacle (`Exit.barrier`, src/content/schema.ts); the MODEL owns the
 * mutable answer to "is it passable right now?" in the `exitState` module slice — a sparse
 * overlay keyed by the directed exit (`from->to`) and written ONLY by the reducer's
 * `setExitState` (absolute post-state deltas, so a lock change persists and replays like every
 * other fact). Where the overlay is silent, the state derives from content: a barrier starts
 * "blocked" (rubble — force is the only way through) or "locked"; legacy `Exit.locked` stays a
 * hard lock; everything else is open.
 *
 * @author Runkai Zhang
 */
import type { Exit, ExitBarrier } from "../content/schema.ts";

/** The runtime state of one directed exit. "broken" is passable, permanently (a forced door). */
export type ExitRuntimeState = "open" | "locked" | "blocked" | "broken";

/** The durable overlay slice (`model.modules.exitState`): directed exit key → runtime state. */
export interface ExitStateSlice {
  states: Record<string, ExitRuntimeState>;
}

export function defaultExitStateSlice(): ExitStateSlice {
  return { states: {} };
}

/** The overlay key for a directed exit. Ids are frozen (frontier exits are keyed only AFTER the
 *  retarget makes `to` a real location id), so the key is stable for the life of the campaign. */
export function exitKey(from: string, to: string): string {
  return `${from}->${to}`;
}

/** The content-derived state of an exit no overlay entry has touched yet. */
export function initialExitState(exit: Exit): ExitRuntimeState {
  if (exit.barrier) return exit.barrier.kind === "rubble" ? "blocked" : "locked";
  return exit.locked ? "locked" : "open";
}

/** Whether a state lets bodies through. */
export function isPassable(state: ExitRuntimeState): boolean {
  return state === "open" || state === "broken";
}

const BARRIER_KIND_TEXT: Record<ExitBarrier["kind"], string> = {
  door: "a locked door",
  gate: "a locked gate",
  rubble: "a fall of rubble",
  magical: "a shimmering ward",
};

/** Player-facing description of an obstacle — the authored line, else a default by kind. */
export function barrierDescription(barrier: ExitBarrier | undefined): string {
  if (barrier?.description && barrier.description.trim().length > 0) return barrier.description.trim();
  return barrier ? BARRIER_KIND_TEXT[barrier.kind] : "barred fast";
}

/** The short state tag surfaces append to an exit's display name ("" for plain open). */
export function exitStateTag(state: ExitRuntimeState): string {
  switch (state) {
    case "locked":
      return " (locked)";
    case "blocked":
      return " (blocked)";
    case "broken":
      return " (broken open)";
    case "open":
      return "";
  }
}
