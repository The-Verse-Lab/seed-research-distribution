/**
 * Status effects — temporary, replay-safe mechanical modifiers.
 *
 * The durable truth lives in `WorldModel.modules.statusEffects` and folds through the existing
 * `modulePatched` delta. The user-facing tag is mirrored onto `entity.stats.conditions[]` by the
 * reducer command that applies/expires an effect, so existing condition projections stay
 * unchanged.
 */
import type { WorldModel } from "../world/model.ts";
import { attireStateOf, WARDROBE_MODULE, type WardrobeSlice, type WardrobeSlotId } from "./wardrobe.ts";

export interface StatusEffectMods {
  check?: number;
  attack?: number;
  ac?: number;
  energy?: number;
  advantage?: boolean;
  disadvantage?: boolean;
}

export interface StatusEffect {
  kind: string;
  turnsRemaining: number;
  mods: StatusEffectMods;
  source?: string;
}

export interface StatusEffectSlice {
  active: Record<string, StatusEffect[]>;
}

export type ResolvedStatusMods = Required<StatusEffectMods>;

export function defaultStatusEffectSlice(): StatusEffectSlice {
  return { active: {} };
}

export function cloneStatusEffect(effect: StatusEffect): StatusEffect {
  return {
    kind: effect.kind,
    turnsRemaining: effect.turnsRemaining,
    mods: { ...effect.mods },
    ...(effect.source !== undefined ? { source: effect.source } : {}),
  };
}

export function cloneStatusEffectSlice(slice: StatusEffectSlice): StatusEffectSlice {
  const active: Record<string, StatusEffect[]> = {};
  for (const [entityId, effects] of Object.entries(slice.active)) {
    active[entityId] = effects.map(cloneStatusEffect);
  }
  return { active };
}

/**
 * Any holder of the namespaced module runtime: the WorldModel itself, or its projected GameState
 * (`toGameState` structuredClones `model.modules`, so both carry identical slices). Structural so
 * pure GameState consumers (the brief builder) can read active kinds without holding a model.
 */
export interface ModuleRuntimeSource {
  modules?: Record<string, unknown>;
}

/** The `chilled` exposure effect's kind tag — shared by its phrase entry, its canonical shape, and the module's refresh check, so all three never drift apart. */
const CHILLED_KIND = "chilled";

/** The `cowed` discipline effect's kind tag (Feature 3) — shared by its phrase + canonical shape. */
const COWED_KIND = "cowed";

/**
 * Narrative display phrase per status kind — what a bystander SEES, not the mechanics. A kind
 * without an entry stays mechanics-only (the condition tag still mirrors it) and never reaches
 * the narrator's `Visibly:` line; a new kind opts in by adding one entry here.
 */
const STATUS_EFFECT_PHRASES: Record<string, string> = {
  maimed: "hobbled by a crippling wound",
  [CHILLED_KIND]: "shivering with cold",
  [COWED_KIND]: "cowed and flinching",
};

export function statusEffectPhrase(kind: string): string | undefined {
  return STATUS_EFFECT_PHRASES[kind];
}

export function statusMods(model: WorldModel, entityId: string): ResolvedStatusMods {
  const slice = model.modules.statusEffects as Partial<StatusEffectSlice> | undefined;
  const effects = slice?.active?.[entityId] ?? [];
  const mods: ResolvedStatusMods = { check: 0, attack: 0, ac: 0, energy: 0, advantage: false, disadvantage: false };
  for (const effect of effects) {
    mods.check += effect.mods.check ?? 0;
    mods.attack += effect.mods.attack ?? 0;
    mods.ac += effect.mods.ac ?? 0;
    mods.energy += effect.mods.energy ?? 0;
    mods.advantage ||= effect.mods.advantage === true;
    mods.disadvantage ||= effect.mods.disadvantage === true;
  }
  return mods;
}

export function activeStatusKinds(model: ModuleRuntimeSource, entityId: string): string[] {
  const slice = model.modules?.statusEffects as Partial<StatusEffectSlice> | undefined;
  const effects = slice?.active?.[entityId] ?? [];
  return [...new Set(effects.map((effect) => effect.kind))];
}

/**
 * The `chilled` exposure effect's canonical shape — one source of truth for its duration/mods so
 * the tick module's ensure/refresh always (re)applies the same thing. A fresh object per call
 * (mirrors `cloneStatusEffect`'s no-shared-reference rule).
 */
export function chilledEffect(): StatusEffect {
  return { kind: CHILLED_KIND, turnsRemaining: 2, mods: { check: -1, energy: -1 }, source: "exposure" };
}

/**
 * The `cowed` discipline effect's canonical shape (Feature 3) — a bounded, brief debuff a cruel
 * leader inflicts by cowing the PC into line (checks at disadvantage while shaken). One source of
 * truth for its duration/mods; a fresh object per call (mirrors `chilledEffect`).
 */
export function cowedEffect(): StatusEffect {
  return { kind: COWED_KIND, turnsRemaining: 2, mods: { check: -1, disadvantage: true }, source: "discipline" };
}

/**
 * Whether a PC should be carrying the `chilled` exposure effect right now — the same
 * `attireStateOf` read the narrator brief's `Attire:` line uses, including occupancy: a caller
 * that resolves the PC's `Character` sheet (the tick module, from `ctx.services.campaign`) passes
 * its `occupiedCoverageOf` result so this agrees with the brief exactly — e.g. a character whose
 * prose names no garment reads bare once the paper-doll's baseline top/bottoms are removed, not
 * only once all six coverage slots are. Omitting `occupied` (a caller with no campaign data, e.g.
 * a lightweight test) falls back to `attireStateOf`'s conservative all-slots read. Deliberately no
 * location/weather signal (v1 is "bare this tick or not," not a general environmental-exposure
 * system).
 */
export function exposureEffectFor(
  model: WorldModel,
  pcId: string,
  occupied?: ReadonlySet<WardrobeSlotId>,
): boolean {
  const wardrobe = model.modules[WARDROBE_MODULE] as WardrobeSlice | undefined;
  return attireStateOf(wardrobe?.[pcId], occupied) === "bare";
}
