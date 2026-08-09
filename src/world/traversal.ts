/**
 * Traversal — the one place that answers "can a body pass through this exit RIGHT NOW?".
 *
 * Folds the mutable exit-state overlay (`model.modules.exitState`, written only by the
 * reducer's `setExitState`) over the content-derived initial state (`Exit.barrier` /
 * `Exit.locked` — src/rules/exit-state.ts). The reducer's `moveEntity`/`moveParty` enforce it,
 * so the player, NPCs, and the Director all obey the same physics; the engine and every
 * player-facing surface (brief `Exits:`, classifier destinations, flee) read the same verdict.
 *
 * READ-ONLY by design: these helpers never create the overlay slice. Materializing it on a
 * read would let a live model and a delta-fold diverge in shape and silently break
 * `snapshot == fold(deltas)` — only `setExitState` (reducer + replay, in lockstep) writes it.
 *
 * @author Runkai Zhang
 */
import type { Exit } from "../content/schema.ts";
import {
  exitKey,
  initialExitState,
  isPassable,
  type ExitRuntimeState,
  type ExitStateSlice,
} from "../rules/exit-state.ts";
import { exitsFrom } from "./map.ts";
import type { WorldModel } from "./model.ts";

/** Overlay entry for a directed exit, or undefined when no runtime change has been recorded. */
export function overlayExitState(
  modules: Record<string, unknown>,
  from: string,
  to: string,
): ExitRuntimeState | undefined {
  const slice = modules.exitState as Partial<ExitStateSlice> | undefined;
  return slice?.states?.[exitKey(from, to)];
}

/** The effective runtime state of one directed exit: the overlay wins, else content derives it. */
export function effectiveExitState(model: WorldModel, from: string, exit: Exit): ExitRuntimeState {
  return overlayExitState(model.modules, from, exit.to) ?? initialExitState(exit);
}

/** One directed exit + its effective state, resolved from a location toward a destination. */
export interface ExitVerdict {
  exit: Exit;
  state: ExitRuntimeState;
}

/**
 * Resolve the exit from → to with its effective state; undefined when no such exit exists.
 * With PARALLEL edges to the same destination, a passable one wins (matching the old
 * `canReach` semantics: reachable if ANY unlocked exit exists) — a barred verdict is only
 * returned when every parallel edge is barred.
 */
export function exitVerdict(model: WorldModel, from: string, to: string): ExitVerdict | undefined {
  let first: ExitVerdict | undefined;
  for (const exit of exitsFrom(model.map, from)) {
    if (exit.to !== to) continue;
    const state = effectiveExitState(model, from, exit);
    if (isPassable(state)) return { exit, state };
    first ??= { exit, state };
  }
  return first;
}

/** Whether a body can pass from → to (the exit exists AND its effective state is passable). */
export function canTraverse(model: WorldModel, from: string, to: string): boolean {
  const v = exitVerdict(model, from, to);
  return v !== undefined && isPassable(v.state);
}

/** Every barred (locked/blocked) exit out of a location, with its effective state. */
export function barredExitsAt(model: WorldModel, from: string): ExitVerdict[] {
  const out: ExitVerdict[] = [];
  for (const exit of exitsFrom(model.map, from)) {
    const state = effectiveExitState(model, from, exit);
    if (!isPassable(state)) out.push({ exit, state });
  }
  return out;
}
