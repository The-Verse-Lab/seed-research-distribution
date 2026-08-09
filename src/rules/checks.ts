/**
 * Checks — ability checks and saving throws resolved against a DC.
 *
 * Deterministic given an RNG. The narrator describes success/failure; the verdict is
 * computed here so it can never be argued with by the model.
 *
 * @author Runkai Zhang
 */
import { abilityModifier, rollD20, type Rng } from "./dice.ts";

export interface CheckInput {
  /** The relevant ability score (e.g. Dexterity 14). */
  abilityScore: number;
  /** Difficulty class to beat (meet-or-exceed succeeds). */
  dc: number;
  /** Added on top of the ability modifier (proficiency, expertise, situational). */
  bonus?: number;
  advantage?: boolean;
  disadvantage?: boolean;
}

export interface CheckResult {
  rolls: number[];
  picked: number;
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
  /** Natural 20 / natural 1 on the selected die, for crit narration. */
  critical: "success" | "failure" | null;
}

export interface ContestResult {
  /** "a" if side A wins the opposed roll; "b" otherwise — TIES go to B (the holder/defender). */
  winner: "a" | "b";
  aRoll: number;
  bRoll: number;
  aTotal: number;
  bTotal: number;
}

/**
 * Resolve an OPPOSED check: each side rolls d20 + its modifier; the higher total wins, ties to side
 * B (the contested-grapple convention — the one keeping their hold wins a tie). Deterministic given
 * the RNG. Used for struggles with no fixed DC, e.g. a PC trying to break free of a grab.
 */
export function resolveContest(aModifier: number, bModifier: number, rng: Rng = Math.random): ContestResult {
  const a = rollD20({ modifier: aModifier }, rng);
  const b = rollD20({ modifier: bModifier }, rng);
  return { winner: a.total > b.total ? "a" : "b", aRoll: a.picked, bRoll: b.picked, aTotal: a.total, bTotal: b.total };
}

/** Resolve an ability check or saving throw against a DC. */
export function resolveCheck(input: CheckInput, rng: Rng = Math.random): CheckResult {
  const { abilityScore, dc, bonus = 0, advantage, disadvantage } = input;
  const modifier = abilityModifier(abilityScore) + bonus;
  const d20 = rollD20({ modifier, advantage, disadvantage }, rng);

  const critical =
    d20.picked === 20 ? "success" : d20.picked === 1 ? "failure" : null;

  return {
    rolls: d20.rolls,
    picked: d20.picked,
    modifier,
    total: d20.total,
    dc,
    success: d20.total >= dc,
    critical,
  };
}
