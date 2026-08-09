/**
 * Progression — deterministic level advancement and spell acquisition.
 *
 * The mechanical analogue of `combat.ts` / `magic.ts`: pure, state-free, and the single source of
 * the XP curve. Nothing here mutates the world — the reducer (`grantXp` / `learnSpell`) is the one
 * writer; this module only computes what a grant *should* do, so the reducer and the narrator can
 * agree on the numbers without a second implementation.
 *
 * A character's authored {@link StatBlock} (level, abilities, maxHp, spells) is static campaign
 * content and is never mutated. Everything a character *earns* in play lives in the persisted
 * `progression` module slice — an absolute `{ xp, level, learned, credits }` per entity — and is
 * overlaid onto the authored block by {@link effectiveStatBlock} at the two stat chokepoints
 * (`castStatBlockFor` for casting, `CombatModule.statBlockFor` for fighting). Raising the effective
 * `level` scales the proficiency bonus (better attack rolls and spell DCs) for free; `learned`
 * unions into the known-spell list so a taught spell is castable exactly like an innate one.
 *
 * @author Runkai Zhang
 */
import type { StatBlock } from "../content/schema.ts";

/** Hard ceiling on advancement (mirrors the SRD 1–20 band the proficiency table tops out at). */
export const MAX_LEVEL = 20;

/** Hit points gained per level above the character's starting level (flat — no class/con dice yet). */
export const HP_PER_LEVEL = 6;

/** One typed advancement entry, persisted absolutely in `model.modules.progression[entityId]`. */
export interface ProgressionEntry {
  /** Total experience accumulated (monotonic, never spent). */
  xp: number;
  /** Current character level — absolute, seeded from the authored level on first grant. */
  level: number;
  /** Spell ids learned in play (union with the authored `spells` = the effective known list). */
  learned: string[];
  /** Unspent "study" credits — one earned per level-up, spent to learn a spell of one's own choosing. */
  credits: number;
}

export type ProgressionSlice = Record<string, ProgressionEntry>;

export const PROGRESSION_MODULE = "progression";

/** Read the progression slice off a modules bag (defaults to empty — pre-progression saves parse clean). */
export function readProgressionSlice(modules: Record<string, unknown> | undefined): ProgressionSlice {
  const slice = modules?.[PROGRESSION_MODULE];
  return (slice && typeof slice === "object" ? (slice as ProgressionSlice) : {});
}

/**
 * The entity's progression entry, or a fresh one seeded from its authored level. `baseLevel` is the
 * authored `StatBlock.level`; a never-advanced entity reads as `{ xp: cumulativeXp(baseLevel), level:
 * baseLevel, learned: [], credits: 0 }` so the very first grant has a coherent starting point.
 */
export function progressionOf(
  modules: Record<string, unknown> | undefined,
  entityId: string,
  baseLevel: number,
): ProgressionEntry {
  const existing = readProgressionSlice(modules)[entityId];
  if (existing) return existing;
  const level = clampLevel(Math.round(baseLevel) || 1);
  return { xp: cumulativeXpToReach(level), level, learned: [], credits: 0 };
}

function clampLevel(level: number): number {
  return Math.max(1, Math.min(MAX_LEVEL, level));
}

/**
 * Incremental XP required to advance FROM `level` to `level + 1`. A compressed curve (100 × level)
 * so a handful of fair fights or a quest turns a level — the SRD's 300/900/2700 table is tuned for
 * far longer campaigns than a self-hosted sandbox session.
 */
export function xpToNext(level: number): number {
  return 100 * clampLevel(level);
}

/** Cumulative XP needed to BE `level` (0 at level 1). */
export function cumulativeXpToReach(level: number): number {
  const l = clampLevel(level);
  // Σ 100k for k = 1..l-1  =  50·l·(l-1)
  return 50 * l * (l - 1);
}

/** XP awarded for defeating a foe of the given challenge level (min level 1 counts). */
export function xpForDefeat(foeLevel: number): number {
  return 15 + 20 * Math.max(1, Math.round(foeLevel));
}

/** The result of folding an XP gain into an entry — what the reducer commits and the narrator reports. */
export interface XpGainResult {
  /** The new entry (fresh object; the input is never mutated). */
  next: ProgressionEntry;
  /** Levels crossed by this grant (0 = no level-up). */
  levelsGained: number;
  /** Total maxHp/currentHp to add for those levels. */
  hpGain: number;
  /** Study credits earned (== levelsGained; inert for non-casters). */
  creditsGained: number;
  /** The level values reached, in order (for the level-up beat, e.g. [4, 5]). */
  reached: number[];
}

/**
 * Fold `by` experience into `entry`, cascading as many level-ups as the total crosses (capped at
 * {@link MAX_LEVEL}). Pure — returns a fresh entry and the deltas the caller applies/narrates.
 */
export function applyXpGain(entry: ProgressionEntry, by: number): XpGainResult {
  const gain = Math.max(0, Math.round(by));
  const xp = entry.xp + gain;
  let level = entry.level;
  const reached: number[] = [];
  while (level < MAX_LEVEL && xp >= cumulativeXpToReach(level + 1)) {
    level += 1;
    reached.push(level);
  }
  const levelsGained = reached.length;
  const hpGain = levelsGained * HP_PER_LEVEL;
  const next: ProgressionEntry = {
    xp,
    level,
    learned: entry.learned,
    credits: entry.credits + levelsGained,
  };
  return { next, levelsGained, hpGain, creditsGained: levelsGained, reached };
}

/** XP still needed to reach the next level (0 at the cap). */
export function xpToNextFrom(entry: ProgressionEntry): number {
  if (entry.level >= MAX_LEVEL) return 0;
  return Math.max(0, cumulativeXpToReach(entry.level + 1) - entry.xp);
}

/** Progress into the current level as a 0..1 fraction (1 at the cap) for read-only display. */
export function levelProgress(entry: ProgressionEntry): number {
  if (entry.level >= MAX_LEVEL) return 1;
  const floor = cumulativeXpToReach(entry.level);
  const ceil = cumulativeXpToReach(entry.level + 1);
  if (ceil <= floor) return 1;
  return Math.max(0, Math.min(1, (entry.xp - floor) / (ceil - floor)));
}

/**
 * Overlay a character's earned progression onto their authored stat block. Raises `level` (⇒
 * proficiency), materializes the learned-spell union, and reflects the earned maxHp. Returns the
 * base object UNCHANGED (same reference) when there is nothing to overlay, so callers that compare
 * by identity (the AC copy-on-diff idiom) keep working and content blocks are never mutated.
 *
 * `liveMaxHp` is the entity's live `stats.maxHp` (already inclusive of the HP bonus, materialized in
 * `fromGameState` and kept current by the reducer); pass it so the effective block's maxHp is the
 * truthful, level-raised value rather than the authored floor.
 */
export function effectiveStatBlock(
  base: StatBlock,
  entry: ProgressionEntry | undefined,
  liveMaxHp?: number,
): StatBlock {
  if (!entry) return liveMaxHp !== undefined && liveMaxHp !== base.maxHp ? { ...base, maxHp: liveMaxHp } : base;
  const level = Math.max(base.level, entry.level);
  const learned = entry.learned.filter((id) => !base.spells.includes(id));
  const maxHp = liveMaxHp ?? base.maxHp;
  if (level === base.level && learned.length === 0 && maxHp === base.maxHp) return base;
  return {
    ...base,
    level,
    maxHp,
    spells: learned.length > 0 ? [...base.spells, ...learned] : base.spells,
  };
}

/** The maxHp bonus an entry confers over the authored `baseLevel` (materialized in `fromGameState`). */
export function progressionBonusHp(entry: ProgressionEntry | undefined, baseLevel: number): number {
  if (!entry) return 0;
  return Math.max(0, entry.level - clampLevel(Math.round(baseLevel) || 1)) * HP_PER_LEVEL;
}
