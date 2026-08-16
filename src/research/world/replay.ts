import type { ResearchWorldDelta } from "./deltas";
import { applyResearchDeltaInPlace } from "./deltas";
import { cloneResearchWorldState, type ResearchWorldState } from "./state";

export function applyResearchDelta(state: ResearchWorldState, delta: ResearchWorldDelta): ResearchWorldState {
  const next = cloneResearchWorldState(state);
  applyResearchDeltaInPlace(next, delta);
  return next;
}

/** Deterministically reconstruct a snapshot from a seed and an ordered delta stream. */
export function foldResearchDeltas(
  seed: ResearchWorldState,
  deltas: readonly ResearchWorldDelta[],
): ResearchWorldState {
  const state = cloneResearchWorldState(seed);
  for (const delta of deltas) applyResearchDeltaInPlace(state, delta);
  return state;
}
