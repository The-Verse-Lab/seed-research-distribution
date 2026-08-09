/**
 * Visible state — everything a bystander can SEE about an entity right now, derived in one place.
 *
 * `visibleStateOf` is the extension seam: each perceivable is its own clearly-separated source
 * block appending `VisibleFact`s (attire today, status effects today; wounds/gear/weather join as
 * new blocks later). Consumers — the narrator brief's `Attire:`/`Visibly:` lines, the social read,
 * the NPC memory beat — render or key off facts; they never re-derive them.
 *
 * @author Runkai Zhang
 */
import type { Character } from "../content/schema.ts";
import { activeStatusKinds, statusEffectPhrase, type ModuleRuntimeSource } from "./status-effects.ts";
import {
  attireDescriptor,
  attireStateOf,
  BASELINE_COVERAGE_SLOT_IDS,
  occupiedSlotsOf,
  stripNegatedGarments,
  WARDROBE_MODULE,
  type WardrobeSlice,
  type WardrobeSlotId,
} from "./wardrobe.ts";

/** One thing anyone looking at the entity can see. */
export interface VisibleFact {
  /** Stable source id (`"attire"`, `"status:<kind>"`) so consumers can tell facts apart. */
  id: string;
  /** Short narrative phrase, ready to render into a brief line. */
  brief: string;
  /** Lowercase trait-style keywords for the social read (same register as TARGET_TRAIT_TABLE). */
  socialKeywords: string[];
  /** An episodic-memory seed for observers, when a fact is worth remembering. */
  memory?: { kind: string; summary: string };
}

/** The attire fact's id — the brief's `Attire:` line owns it; `Visibly:` renders everything else. */
export const ATTIRE_FACT_ID = "attire";

/**
 * The coverage-occupancy baseline "bare" is judged against: the slots this character's own
 * appearance prose dresses, unioned with the paper-doll's guaranteed fallback pair (without it, a
 * garmentless or coat-only prose would let a strip of the doll's visible top/bottoms go
 * unreported). `undefined` (no character sheet) keeps the conservative all-slots read downstream.
 *
 * The prose is passed through {@link stripNegatedGarments} first (regex audit §10e). Garment words
 * in identity prose are incidental, and a DENIED one ("with no coat to speak of") must not dress a
 * character in a coat they are explicitly described as not owning. Mentions that are not denied
 * still count, exactly as before.
 */
export function occupiedCoverageOf(character: Character | undefined): Set<WardrobeSlotId> | undefined {
  if (!character) return undefined;
  const prose = [character.description, ...(character.appearanceTags ?? [])].join(" ").toLowerCase();
  return new Set([...occupiedSlotsOf(stripNegatedGarments(prose)), ...BASELINE_COVERAGE_SLOT_IDS]);
}

/**
 * Everything visibly notable about one entity. `source` is the WorldModel or its projected
 * GameState (identical module slices — see {@link ModuleRuntimeSource}); `character` is the
 * entity's authored sheet when one exists, for the attire occupancy baseline. Returns `[]` for an
 * unremarkable entity, so consumers render nothing and stay byte-identical to before this existed.
 */
export function visibleStateOf(
  source: ModuleRuntimeSource,
  entityId: string,
  character?: Character,
): VisibleFact[] {
  const facts: VisibleFact[] = [];

  // ── Attire (paper-doll wardrobe vs. this character's occupancy baseline) ──────────────────────
  // ONE fact for the whole coverage band, never per-slot: a single garment can occupy several
  // slots (a "robe" is over-upper+upper+lower), so slot-wise facts would report one robe thrice.
  const wardrobe = source.modules?.[WARDROBE_MODULE] as WardrobeSlice | undefined;
  const attire = attireStateOf(wardrobe?.[entityId], occupiedCoverageOf(character));
  if (attire) {
    facts.push({
      id: ATTIRE_FACT_ID,
      brief: `${attire} — ${attireDescriptor(attire)}`,
      socialKeywords: ["disheveled"],
      // A co-located NPC witnessing this is memorable enough to journal (src/modules/npc-memory) —
      // "attireObserved" ties the fragment back to npc-memory.ts's salience table by the same kind tag.
      memory: { kind: "attireObserved", summary: attire === "bare" ? "wore no clothing" : "was not fully dressed" },
    });
  }

  // ── Status effects (kinds that carry a narrative phrase) ──────────────────────────────────────
  // Mechanics-only kinds stay invisible here: surfacing is opted into per kind via
  // STATUS_EFFECT_PHRASES (src/rules/status-effects.ts), so a new kind lands with its phrase.
  for (const kind of activeStatusKinds(source, entityId)) {
    const phrase = statusEffectPhrase(kind);
    if (!phrase) continue;
    facts.push({ id: `status:${kind}`, brief: phrase, socialKeywords: [kind] });
  }

  return facts;
}
