/**
 * Dice — deterministic, seedable rolling.
 *
 * Mechanics live in code, never in the model. The LLM may decide that a roll should
 * happen and narrate its result, but the number comes from here. A seedable RNG keeps
 * tests deterministic and makes replays reproducible.
 *
 * @author Runkai Zhang
 */

/** A pseudo-random generator returning a float in [0, 1). */
export type Rng = () => number;

/** mulberry32 — small, fast, seedable PRNG. Good enough for dice; not cryptographic. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a over a string key → a uint32. The stable per-id seed for `mulberry32`: derive a PRIVATE
 * stream with `mulberry32(fnv1a(id))` and it consumes ZERO draws from any shared seeded stream, so
 * the same id yields the same picks forever without perturbing draw order elsewhere. Hosted here
 * (the rng home) and re-exported by `worldsmith/seeded` for its existing importers.
 */
export function fnv1a(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Roll a single die with the given number of sides. */
export function rollDie(sides: number, rng: Rng = Math.random): number {
  if (!Number.isInteger(sides) || sides < 1) {
    throw new Error(`die must have a positive integer number of sides, got ${sides}`);
  }
  return 1 + Math.floor(rng() * sides);
}

export interface RollResult {
  notation: string;
  rolls: number[];
  modifier: number;
  total: number;
}

const DICE_RE = /^\s*(\d*)d(\d+)\s*([+-]\s*\d+)?\s*$/i;

/**
 * Roll standard dice notation: `XdY`, `dY`, with an optional `+Z` / `-Z` modifier.
 * Examples: "2d6+3", "d20", "4d8-1".
 */
export function roll(notation: string, rng: Rng = Math.random): RollResult {
  const m = DICE_RE.exec(notation);
  if (!m) throw new Error(`invalid dice notation: "${notation}"`);

  const count = m[1] && m[1].length > 0 ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2] ?? "", 10);
  const modifier = m[3] ? parseInt(m[3].replace(/\s+/g, ""), 10) : 0;

  if (count < 1 || count > 1000) throw new Error(`unreasonable dice count: ${count}`);

  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(rollDie(sides, rng));
  const total = rolls.reduce((sum, r) => sum + r, 0) + modifier;

  return { notation, rolls, modifier, total };
}

export interface D20Options {
  modifier?: number;
  advantage?: boolean;
  disadvantage?: boolean;
}

export interface D20Result {
  rolls: number[];
  /** The die actually used after advantage/disadvantage selection. */
  picked: number;
  modifier: number;
  total: number;
}

/**
 * Roll a d20 with optional advantage/disadvantage. If both are set they cancel (one die),
 * matching 5e. The modifier is added to the selected die.
 */
export function rollD20(opts: D20Options = {}, rng: Rng = Math.random): D20Result {
  const { modifier = 0, advantage = false, disadvantage = false } = opts;
  const twoDice = advantage !== disadvantage; // exactly one of them → roll two
  const rolls = twoDice ? [rollDie(20, rng), rollDie(20, rng)] : [rollDie(20, rng)];

  let picked: number;
  if (advantage && !disadvantage) picked = Math.max(...rolls);
  else if (disadvantage && !advantage) picked = Math.min(...rolls);
  else picked = rolls[0] ?? 0;

  return { rolls, picked, modifier, total: picked + modifier };
}

/** 5e ability modifier from an ability score. */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}
