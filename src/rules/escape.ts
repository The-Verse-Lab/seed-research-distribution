/**
 * Disengage — the price of walking out of a live fight, and what becomes of the people left in it.
 *
 * Playtest r11 F-5: a movement line spoken mid-fight moved the party, ended the encounter and
 * despawned both hostiles with **no `diceRolled` on the turn** — no check, no parting blow, no cost.
 * The exploit-sweep row "flee with no consequence" was open, and an ALLY who had just joined the
 * fight on the party's side was deleted along with the encounter, her outcome never determined while
 * the prose kept her swinging.
 *
 * Owner decision (2026-08-01, from the r11 design pass):
 *  - a disengage is a **contested escape check** — pass and the break is clean, fail and the party
 *    stays and loses the turn (the other side then acts). Movement is never silently free again.
 *  - a non-party ally left on the field **resolves their own outcome**: they get out with the party,
 *    they get out hurt, or they go down where they stood. Real state, reflected by the next scene.
 *
 * Pure and deterministic given an RNG — the numbers live here, the narrator only phrases them.
 *
 * @author Runkai Zhang
 */
import { abilityModifier, rollD20, type Rng } from "./dice.ts";

/** One living enemy standing between the party and the door. */
export interface EscapeFoe {
  id: string;
  name: string;
  /** Combatant level; 1 when the entity carries no stat block. */
  level: number;
}

/** Which ability carries the break-away, and the score it rolls with. */
export interface EscapeAbility {
  ability: "str" | "dex";
  score: number;
  /** SRD-flavoured skill name, so the DiceCard says which stat it used (r7 convention). */
  skill: "Athletics" | "Acrobatics";
}

/** The floor and ceiling of an escape DC — level-1 anchored, same bands as the r7 recalibration. */
export const ESCAPE_DC_MIN = 8;
export const ESCAPE_DC_MAX = 16;

/**
 * The DC to break away. Base 8 + the toughest foe's level, +1 for every foe past the first (a
 * circle is harder to leave than a duel), clamped to the level-1 band. One level-1 foe ⇒ DC 9, so a
 * PC with any DEX at all usually gets out — the point is that it is ROLLED, not that it is refused.
 */
export function escapeDc(foes: readonly EscapeFoe[]): number {
  if (foes.length === 0) return ESCAPE_DC_MIN;
  const worst = Math.max(...foes.map((f) => f.level));
  const crowd = Math.max(0, foes.length - 1);
  return Math.min(ESCAPE_DC_MAX, Math.max(ESCAPE_DC_MIN, ESCAPE_DC_MIN + worst + crowd));
}

/**
 * The better of shoving through (STR/Athletics) and slipping out (DEX/Acrobatics) — and the check
 * NAMES the one it used, because "STR/DEX should name the stat it uses" was itself an r7 finding.
 * Ties go to DEX: getting away is footwork before it is force.
 */
export function escapeAbility(str: number, dex: number): EscapeAbility {
  return str > dex
    ? { ability: "str", score: str, skill: "Athletics" }
    : { ability: "dex", score: dex, skill: "Acrobatics" };
}

/** What happened to a helper the party left behind. */
export type AllyFate = "escaped" | "wounded" | "downed";

export interface AllyOutcome {
  fate: AllyFate;
  roll: number;
  total: number;
  dc: number;
  /** For `wounded`: the HP the ally is left on (never below 1). Undefined otherwise. */
  hpAfter?: number;
}

/**
 * Roll out the fate of ONE ally the party abandoned in the fight. Their own level is the modifier
 * against the same escape DC the player faced:
 *
 *  - beat it by 5+ ⇒ they get clear with the party, unhurt;
 *  - beat it      ⇒ they get clear, but they took it in the retreat (down to a third of their max);
 *  - miss it      ⇒ they go down where they stood, and they are still there when you come back.
 *
 * Deterministic given the RNG. The narrator is handed the result, never the choice.
 */
export function resolveAllyFate(
  allyLevel: number,
  maxHp: number,
  currentHp: number,
  dc: number,
  rng: Rng = Math.random,
): AllyOutcome {
  const d20 = rollD20({ modifier: Math.max(0, allyLevel) }, rng);
  if (d20.total >= dc + 5) return { fate: "escaped", roll: d20.picked, total: d20.total, dc };
  if (d20.total >= dc) {
    const hpAfter = Math.max(1, Math.min(currentHp, Math.floor(maxHp / 3)));
    return { fate: "wounded", roll: d20.picked, total: d20.total, dc, hpAfter };
  }
  return { fate: "downed", roll: d20.picked, total: d20.total, dc };
}

/** The ally's own line in the mechanical ledger — one sentence, no engine dialect. */
export function allyFateSummary(name: string, outcome: AllyOutcome): string {
  switch (outcome.fate) {
    case "escaped":
      return `${name} breaks off with you and gets clear.`;
    case "wounded":
      return `${name} gets clear, but takes a beating covering the retreat.`;
    case "downed":
      return `${name} goes down covering your retreat, and is left behind.`;
  }
}

/** Ability modifier for an escape roll — re-exported so callers need only this module. */
export function escapeModifier(score: number): number {
  return abilityModifier(score);
}
