/**
 * Grievance — a leader's accumulated resentment of the player (Feature 3).
 *
 * A leader bumps its grievance when the PC crosses it (declines/overrides a proposal, resists a
 * demand) and it fades over quiet real-time. Grievance raises the odds + severity of the leader's
 * disciplinary response (`chooseLeaderDiscipline`, src/rules/agenda.ts). Kept in its own math-leaf so
 * both the writer (the engine's proposal-answer / pressure-resist resolvers) and the reader (the
 * autonomy Director) share ONE decay rule — no drift. Pure: operates on an `AutonomyRuntime` value,
 * no model, no RNG. The bump is written through the reducer's `modulePatch` (replay-safe), carrying
 * the ABSOLUTE post-value like the sibling autonomy pacing stamps (`lastProposedAt`/`lastPressedAt`).
 *
 * @author Runkai Zhang
 */
import type { AutonomyRuntime } from "../state/types.ts";

/** A grievance never climbs past this — a leader can be aggrieved, not infinitely vengeful. */
export const GRIEVANCE_CAP = 3;

/** A grudge drains one point per this many ms of real play — several quiet beats and it's gone. */
const GRIEVANCE_DECAY_MS = 240_000;

/** This leader's grievance right now, decayed from its last bump by elapsed real time (0 if none). */
export function decayedGrievance(rt: AutonomyRuntime | undefined, now: number): number {
  const base = rt?.grievance ?? 0;
  if (base <= 0) return 0;
  const drained = Math.floor((now - (rt?.grievanceAt ?? 0)) / GRIEVANCE_DECAY_MS);
  return Math.max(0, base - drained);
}

/**
 * The autonomy runtime with one fresh grievance bump recorded: decay the prior value to now, add 1,
 * clamp to {@link GRIEVANCE_CAP}, and stamp `grievanceAt`. Returns the FULL runtime (spread of the
 * existing one) so it drops straight into a `modulePatch` `{ [npcId]: <this> }`, mirroring the
 * `lastProposedAt` bump. A missing runtime starts from the shared default.
 */
export function grievanceBump(rt: AutonomyRuntime | undefined, now: number): AutonomyRuntime {
  const base: AutonomyRuntime = rt ?? { talking: false, replyDepth: 0, lastActedAt: 0 };
  return { ...base, grievance: Math.min(GRIEVANCE_CAP, decayedGrievance(base, now) + 1), grievanceAt: now };
}
