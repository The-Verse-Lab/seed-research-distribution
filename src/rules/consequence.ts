/**
 * Consequence table (Phase 3 — the consequence floor) — the PURE mapping from a classified turn's
 * IMPACT (domain × severity × outcome, plus whether it was witnessed / had a victim) to the set of
 * persistent EFFECTS the world should carry forward. No model, no rng, no state: a plain key → effect
 * list, the `opportunity.ts` / `exploitation.ts` idiom. The engine's `bindConsequences` grounds each
 * effect to an EXISTING reducer command (setFlag / adjustRelationship / adjustFactionStanding /
 * recordNpcMemory) so the Continuity Judge ledger and the narrator agree — success stops being
 * indistinguishable from failure (playtest #1: outside scripted quest rails the engine produced varied
 * prose around UNCHANGED state).
 *
 * Effect payloads that need the concrete action (a memory's summary, an ask's kind) are MARKERS here;
 * the engine fills them from the turn's input at grounding time. Magnitudes scale with severity so a
 * shoplift and a stabbing don't land the same weight.
 *
 * @author Runkai Zhang
 */

/** What kind of harm/benefit the action carried — set by the LLM classifier on the TurnPlan. */
export type ConsequenceDomain = "social" | "property" | "violence" | "deception" | "none";
/** How serious it was (drives the magnitude of every effect). */
export type ConsequenceSeverity = "none" | "minor" | "serious" | "grave";
/** How the turn resolved — a check verdict, or `flavor` for a no-stakes beat. */
export type ConsequenceOutcome = "success" | "failure" | "refused" | "flavor";

/** The full key the table is memoized on (all fields precomputed by the engine call site). */
export interface ConsequenceKey {
  domain: ConsequenceDomain;
  severity: ConsequenceSeverity;
  outcome: ConsequenceOutcome;
  /** A living NPC (besides any victim) was present to see it. */
  witnessed: boolean;
  /** The action landed on a specific present entity (impact.victimId grounded). */
  hasVictim: boolean;
}

/**
 * One persistent effect. `memory`/`grantAsk` are MARKERS — the engine fills the summary/ask from the
 * turn's input at grounding time; `notoriety`/`disposition`/`faction` carry their signed magnitude.
 */
export type ConsequenceEffect =
  | { kind: "witnessFlag" }
  | { kind: "notoriety"; by: number }
  | { kind: "disposition"; who: "victim" | "witnesses"; by: number }
  | { kind: "faction"; by: number }
  | { kind: "memory" }
  | { kind: "grantAsk" };

/** Notoriety thresholds — a running regional count crossing these flips the tier (authored events key on it). */
export const NOTORIETY_MARKED = 3;
export const NOTORIETY_WANTED = 6;

/** The tier a regional notoriety count falls in. */
export function notorietyTier(n: number): "clear" | "marked" | "wanted" {
  if (n >= NOTORIETY_WANTED) return "wanted";
  if (n >= NOTORIETY_MARKED) return "marked";
  return "clear";
}

/** Flag-key helpers — a running regional notoriety count, a wanted-track marker, a per-location witness. */
export function notorietyFlagKey(scope: string): string {
  return `notoriety.${scope}`;
}
export function wantedFlagKey(scope: string): string {
  return `wanted.${scope}`;
}
export function witnessedFlagKey(locationId: string): string {
  return `witnessed.${locationId}`;
}

/** Magnitude weight per severity — 0 (none) / 1 (minor) / 2 (serious) / 3 (grave). */
const SEVERITY_WEIGHT: Record<ConsequenceSeverity, number> = { none: 0, minor: 1, serious: 2, grave: 3 };

/**
 * The effects a turn earns. A neutral turn (`domain === "none"` or `severity === "none"`) earns NOTHING
 * — looking around, waiting, or an emote leaves no trace, so the world isn't polluted and neutral turns
 * stay byte-identical. Every other (meaningful) turn earns ≥1 effect (the FLOOR the engine also
 * back-stops with a can't-reject setFlag), so success and failure can never fold to the same state.
 *
 *  - SOCIAL (a concrete ask — persuade/intimidate/bribe): a WON ask grants the asked-for thing +
 *    warms the target; a LOST ask cools them a little; anything else with a target is a small cool.
 *  - TRANSGRESSION (violence/property/deception): regional notoriety (scaled), a disposition + faction
 *    hit on the victim, a remembered beat in the victim's journal, and a smaller cool on witnesses.
 *    A `failure` still leaves a trace (you were SEEN trying) — only lighter than a success.
 */
export function consequencesFor(key: ConsequenceKey): ConsequenceEffect[] {
  const { domain, severity, outcome, witnessed, hasVictim } = key;
  if (domain === "none" || severity === "none" || outcome === "flavor") {
    // A truly neutral turn leaves no persistent trace (only a witnessed action would, handled below).
    return outcome === "flavor" && witnessed && domain !== "none" ? [{ kind: "witnessFlag" }] : [];
  }
  const w = SEVERITY_WEIGHT[severity];

  if (domain === "social") {
    if (outcome === "refused") return hasVictim ? [{ kind: "disposition", who: "victim", by: -2 }] : [];
    if (outcome === "success" && hasVictim) {
      return [{ kind: "grantAsk" }, { kind: "disposition", who: "victim", by: 2 }];
    }
    if (outcome === "failure" && hasVictim) {
      return [{ kind: "disposition", who: "victim", by: -2 }];
    }
    // A social attempt with no concrete target: nothing to bind (the engine's floor still back-stops).
    return [];
  }

  // TRANSGRESSION — violence / property / deception. A failure is lighter (seen trying, not landed).
  const landed = outcome === "success";
  const scale = landed ? w : Math.max(1, w - 1);
  const effects: ConsequenceEffect[] = [{ kind: "notoriety", by: scale }];
  if (hasVictim) {
    effects.push({ kind: "disposition", who: "victim", by: -(5 + 5 * scale) }); // −10 / −15 / −20 landed
    effects.push({ kind: "faction", by: -(5 * scale) });
    effects.push({ kind: "memory" });
  }
  if (witnessed) effects.push({ kind: "disposition", who: "witnesses", by: -(2 + scale) });
  return effects;
}

/**
 * The floor invariant, exposed for the test: a MEANINGFUL turn (a real domain + severity that isn't
 * pure flavor) always earns at least one effect, so the binder can never fold a success and a failure
 * to the same state. (A neutral / flavor turn legitimately earns none.)
 */
export function isMeaningful(key: ConsequenceKey): boolean {
  return key.domain !== "none" && key.severity !== "none" && key.outcome !== "flavor";
}
