/**
 * Party — the membership/leadership slice value types and default (Phase 2, Stage A).
 *
 * Membership itself stays a fact ON the entity (`Entity.partyMember` — one registry, one flag);
 * this slice holds what has no per-entity home: WHO leads and which members have an outstanding
 * denied leave request (the contested leave-gate's bookkeeping). Because this is MUTABLE state it
 * lives on the `WorldModel` at `model.modules.party` and flows through the reducer as typed,
 * replayable deltas that carry the ABSOLUTE post-state slice — exactly like the npc-memory slice
 * (the canonical template). This file is the math-leaf sibling: pure value types + the single
 * source of the slice default. No IO, no model, no RNG, no wall-clock — `snapshot == fold(deltas)`
 * must hold.
 *
 * Party membership is mechanically neutral: joining applies no disposition or relationship bonus
 * and rewrites nothing about the NPC. An abusive leader remains possible; the leave-gate below is
 * the machinery that makes refusing a departure playable, not a moral filter.
 *
 * @author Runkai Zhang
 */
import type { AgendaAbility, AgendaStance } from "./agenda.ts";

/**
 * One member's outstanding leave request the current leader refused. `deniedAtSeq` is the bus seq
 * of the refusal turn when the enqueuer passed it (deterministic — recorded verbatim from the
 * command, never derived in the reducer); absent when unknown. Presence of the key alone is the
 * fact "this member asked to leave and was denied" (feeds the contested-escape flow).
 */
export interface PartyLeaveRequest {
  deniedAtSeq?: number;
}

/**
 * The full runtime slice stored at `model.modules.party`. Declared ONCE here so it is the single
 * shape shared by the mutable world-layer accessor (the reducer/replay writer,
 * `src/world/module-slices.ts partySlice`) and any read-only consumer. Both build a typed
 * `PartySlice` literal, so adding a field is a compile error in every accessor rather than a
 * silent `snapshot == fold(deltas)` divergence.
 */
export interface PartySlice {
  /**
   * The entity currently leading the party. `null` means NO explicit leader is set and the PC
   * leads by default (the pre-slice behaviour — every old save folds to this). Non-null values
   * are validated by the reducer to be a current party member or the PC.
   */
  leaderId: string | null;
  /** Outstanding denied leave requests, keyed by member entity id. Absent key ⇒ none pending. */
  pendingLeave: Record<string, PartyLeaveRequest>;
}

/** A fresh, defaulted party slice — the single source of the slice's default value. */
export function defaultPartySlice(): PartySlice {
  return { leaderId: null, pendingLeave: {} };
}

/** Deep-copy a slice (defensive — deltas carry copies, never the live model state). */
export function clonePartySlice(s: PartySlice): PartySlice {
  const pendingLeave: Record<string, PartyLeaveRequest> = {};
  for (const [id, req] of Object.entries(s.pendingLeave)) {
    pendingLeave[id] = req.deniedAtSeq !== undefined ? { deniedAtSeq: req.deniedAtSeq } : {};
  }
  return { leaderId: s.leaderId, pendingLeave };
}

// --- Read-only slice views (Stage C) ----------------------------------------------------------
// Pure lookups over a `WorldModel.modules` record (the same shape `GameState.modules` persists).
// Unlike the world-layer `partySlice` accessor these NEVER write a default back onto the model,
// so readers (engine resolution, the autonomy Director) stay outside the reducer chokepoint.

/** Who currently leads the party; `null` means no explicit leader — the PC leads by default. */
export function partyLeaderOf(modules: Record<string, unknown>): string | null {
  const slice = modules.party as Partial<PartySlice> | undefined;
  return slice?.leaderId ?? null;
}

/** Outstanding denied leave requests, keyed by member entity id (empty when none recorded). */
export function pendingLeaveOf(modules: Record<string, unknown>): Record<string, PartyLeaveRequest> {
  const slice = modules.party as Partial<PartySlice> | undefined;
  return slice?.pendingLeave ?? {};
}

// --- Invite decision (Stage C) ----------------------------------------------------------------

/**
 * Why an NPC says yes to joining the party — surfaced so the narration/reply can carry the hook.
 *  - "genuine":     they come because they want to (devoted/helpful/neutral, or a warm bond).
 *  - "guarded":     wary/transactional — they come, but for their own reasons or price.
 *  - "opportunist": a exploitative or hostile NPC joining to exploit, feed, or collect from within.
 */
export type InviteMotive = "genuine" | "guarded" | "opportunist";

export interface InviteDecision {
  accept: boolean;
  motive: InviteMotive;
}

/** Chance an exploitative or hostile NPC accepts an invite for self-serving reasons. */
export const OPPORTUNISTIC_JOIN_CHANCE = 0.5;
/** At or below this relationship the NPC is treated as hostile to the asker. */
export const HOSTILE_RELATIONSHIP_MAX = -40;
/** At or above this relationship the NPC joins gladly regardless of temperament. */
export const WARM_RELATIONSHIP_MIN = 40;

/**
 * The CODE decision for "will you join my party?" — the model only phrases the answer.
 * Derived from the asker-directed agenda stance (disposition + relationship); `roll` is one
 * pre-drawn `rng()` value in [0,1) so the caller controls the RNG stream (seeded, testable).
 *
 * Membership is mechanically neutral and morally unfiltered. An exploitative or hostile NPC is
 * not hard-blocked: the seeded roll can let them join for their own reasons. No disposition is
 * softened.
 */
export function decideInvite(
  stance: Pick<AgendaStance, "disposition" | "relationship">,
  roll: number,
): InviteDecision {
  const hostile = stance.relationship <= HOSTILE_RELATIONSHIP_MAX;
  if (stance.disposition === "exploitative" || hostile) {
    return { accept: roll < OPPORTUNISTIC_JOIN_CHANCE, motive: "opportunist" };
  }
  if (
    stance.relationship >= WARM_RELATIONSHIP_MIN ||
    stance.disposition === "devoted" ||
    stance.disposition === "helpful"
  ) {
    return { accept: true, motive: "genuine" };
  }
  if (stance.disposition === "wary" || stance.disposition === "transactional") {
    return { accept: true, motive: "guarded" };
  }
  return { accept: true, motive: "genuine" }; // neutral — "pretty much any NPC can be asked"
}

// --- Contested escape (Stage C) ---------------------------------------------------------------

/** Relationship hit the leader takes toward a member who breaks free of a refused leave. */
export const ESCAPE_GRUDGE = -8;

/**
 * Which ability the player's contested escape rolls, read from their phrasing: fighting free is
 * Strength, talking/tricking a way out is Charisma, and slipping away (the default) is Dexterity.
 * Mirrors `PendingAgendaPressure.resist`'s ability shape — the DC comes from the leader's stance
 * (`pressureDc`, src/rules/agenda.ts).
 *
 * PROSE FLOOR ONLY (r8 regex audit). Verb lists cannot see which verb governs the escape: "I force
 * a smile and sweet-talk my way out" hits the `force` arm and rolls STRENGTH for a Charisma
 * character's talk-out — and the failure branch applies the leader's consequence (reproduced
 * against the shipped regex). `escapeAbilityFrom` puts the classifier's closed answer in front.
 */
/**
 * Clauses in which a verb is DISCLAIMED rather than used, dropped before either arm is tested.
 *
 * Two shapes, both reproduced against the shipped ordering (r8 review), both scoring `cha` for what
 * is plainly a physical break-out — and a misread here is not cosmetic, because the failure branch
 * applies the leader's consequence:
 *
 *   "I shove him aside, no more talk"                            => cha, on the refused "talk"
 *   "I break his grip and shove past, refusing to beg or plead"  => cha, on the refused "plead"
 *   "I overpower him before he can charm me"                     => cha, on HIS charm, not the PC's
 *
 * The first is a disclaimer ("no more X", "refusing to X", "without X", "instead of X"); the second
 * is ATTRIBUTION — a subordinate clause whose subject is the other person, so the verb in it is
 * something being done TO the escaping player. Each span runs to the end of its clause and no
 * further, so a disclaimer can never reach across punctuation into the verb the player did use
 * ("I refuse to wait, so I sweet-talk the guard" keeps its sweet-talk).
 *
 * Bare "no" is deliberately absent from the disclaimer list: "I have no choice but to talk my way
 * out" is a genuine Charisma escape, and "no more"/"not" carry the reproduced line anyway.
 */
const DISCLAIMED_CLAUSE_RE =
  /\b(?:no more|no further|not|never|without|refus\w+|declin\w+|instead of|rather than)\b[^.,;!?]*/gi;
const OTHER_ACTOR_CLAUSE_RE =
  /\b(?:before|until|unless|so)\s+(?:he|she|they|it|you)\b[^.,;!?]*/gi;

export function escapeAbility(text: string): AgendaAbility {
  // The CHA arm is tested FIRST, and `force` no longer counts when its object is a facial
  // expression or a manner. Both changes serve the reproduced line: "I force a smile and sweet-talk
  // my way out" carries an unambiguous verbal escape ("sweet-talk", "my way out") and only an
  // idiomatic `force`, so ordering alone fixes it — while "I force the door and shove past him",
  // which has no verbal cue at all, still rolls Strength. But ordering alone INVERTED the other
  // direction: one verbal token anywhere won, including a token the line explicitly refuses or
  // attributes to the captor (see the two regexes above). Both arms therefore read the line with
  // its disclaimed/foreign clauses removed.
  const used = text.replace(DISCLAIMED_CLAUSE_RE, " ").replace(OTHER_ACTOR_CLAUSE_RE, " ");
  if (/\b(talk|trick|deceive|distract|bluff|charm|persuade|sweet-?talk|wheedle|plead)\b/i.test(used)) {
    return "cha";
  }
  if (
    /\b(fight|break|shove|push|wrestle|overpower|batter)\b/i.test(used) ||
    /\bforce\b(?!\s+(?:a|my|his|her|their|the)\s+(?:smile|laugh|grin|calm|cheer|nod|word))/i.test(used)
  ) {
    return "str";
  }
  return "dex";
}

/**
 * The contested-escape ability: the classifier's CLOSED `TurnPlan.escapeAbility` when it named one,
 * otherwise the prose floor above (whose own default is `dex`). The floor is kept — rather than
 * defaulting straight to `dex` — because a plainly physical or plainly verbal escape should still
 * roll the right ability when the model says nothing. It is NOT frozen: it has been corrected twice
 * (the CHA-first reorder, then the disclaimed/foreign-clause strip), so any change here changes what
 * a classifier miss rolls, and `tests/party-flows.test.ts` pins both directions.
 */
export function escapeAbilityFrom(named: AgendaAbility | null | undefined, text: string): AgendaAbility {
  return named ?? escapeAbility(text);
}
