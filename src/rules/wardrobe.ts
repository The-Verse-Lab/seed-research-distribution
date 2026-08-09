/**
 * Wardrobe slots for the paper-doll character view. This is deliberately a small runtime slice:
 * inventory/equipment remains item truth, while `modules.wardrobe` records how visible clothing
 * slots are arranged for the UI.
 *
 * @author Runkai Zhang
 */

export const WARDROBE_MODULE = "wardrobe";

export const WARDROBE_SLOT_IDS = [
  "head",
  "face",
  "neck",
  "over-upper",
  "upper",
  "under-upper",
  "hands",
  "over-lower",
  "lower",
  "under-lower",
  "feet",
] as const;

export type WardrobeSlotId = (typeof WARDROBE_SLOT_IDS)[number];
export type WardrobeSlotState = "worn" | "displaced" | "removed";
export type WardrobeSlice = Record<string, Partial<Record<WardrobeSlotId, WardrobeSlotState>>>;

/** The authoritative gate for no-turn paper-doll wardrobe adjustments. */
export interface WardrobeLock {
  locked: boolean;
  reason?: string;
}

/** The shared structural surface present on both the live WorldModel and its GameState projection. */
interface WardrobeLockSource {
  modules?: Readonly<Record<string, unknown>>;
}

const SLOT_ID_SET = new Set<string>(WARDROBE_SLOT_IDS);
const SLOT_STATE_SET = new Set<string>(["worn", "displaced", "removed"]);

export function isWardrobeSlotId(value: string): value is WardrobeSlotId {
  return SLOT_ID_SET.has(value);
}

export function isWardrobeSlotState(value: unknown): value is WardrobeSlotState {
  return typeof value === "string" && SLOT_STATE_SET.has(value);
}

export function wardrobeSlotLabel(slotId: WardrobeSlotId): string {
  switch (slotId) {
    case "head":
      return "headwear";
    case "face":
      return "facewear";
    case "neck":
      return "neckwear";
    case "over-upper":
      return "outer top";
    case "upper":
      return "top";
    case "under-upper":
      return "upper underlayer";
    case "hands":
      return "handwear";
    case "over-lower":
      return "outer lower";
    case "lower":
      return "bottoms";
    case "under-lower":
      return "lower underlayer";
    case "feet":
      return "footwear";
  }
}

/**
 * Slots that determine whether a body reads as clothed, for narrative purposes. Accessories
 * (head/face/neck/hands/feet) are excluded — pulling off gloves and boots doesn't make someone
 * "bare"; only torso/leg coverage does.
 */
const COVERAGE_SLOT_IDS: readonly WardrobeSlotId[] = [
  "over-upper",
  "upper",
  "under-upper",
  "over-lower",
  "lower",
  "under-lower",
];

export type AttireState = "bare" | "disheveled";

/**
 * The coverage pair every character is assumed to dress even when their appearance prose names no
 * garment: the paper-doll always renders toggleable fallback garments ("Everyday top/bottoms") in
 * exactly these two slots, so an occupancy read that dropped them would let a strip of what the
 * player can actually see and toggle go unreported.
 */
export const BASELINE_COVERAGE_SLOT_IDS: readonly WardrobeSlotId[] = ["upper", "lower"];

/**
 * Coarse narrative attire state from a wardrobe row's coverage slots — `undefined` when every
 * coverage slot is worn (the common case), so a fully-dressed character adds nothing to the brief.
 *
 * `occupied` (from {@link occupiedSlotsOf} over the character's appearance text) narrows "bare" to
 * the coverage slots this character actually has clothing in: a two-garment character who removes
 * both IS bare — without it, the four never-occupied slots default to "worn" and bare is
 * unreachable. No/empty occupancy signal keeps the conservative all-slots read; an occupancy that
 * names NO coverage slot at all (accessories only) has nothing to remove, so no attire to report.
 */
export function attireStateOf(
  row: Partial<Record<WardrobeSlotId, WardrobeSlotState>> | undefined,
  occupied?: ReadonlySet<WardrobeSlotId>,
): AttireState | undefined {
  if (!row) return undefined;
  const coverage =
    occupied && occupied.size > 0 ? COVERAGE_SLOT_IDS.filter((id) => occupied.has(id)) : COVERAGE_SLOT_IDS;
  if (coverage.length === 0) return undefined;
  const states = coverage.map((id) => row[id] ?? "worn");
  if (states.every((s) => s === "removed")) return "bare";
  if (states.some((s) => s !== "worn")) return "disheveled";
  return undefined;
}

/**
 * A whole-coverage-band wardrobe row at one state, used when captivity confiscation writes through
 * to `modules.wardrobe`. Comprehensive by design, so occupancy does not gate the write.
 */
export function coverageRow(state: WardrobeSlotState): Partial<Record<WardrobeSlotId, WardrobeSlotState>> {
  const row: Partial<Record<WardrobeSlotId, WardrobeSlotState>> = {};
  for (const id of COVERAGE_SLOT_IDS) row[id] = state;
  return row;
}

/** Ordered severity of a coverage slot's state — a strip only ever ESCALATES (never re-dresses). */
export const SLOT_STATE_RANK: Record<WardrobeSlotState, number> = { worn: 0, displaced: 1, removed: 2 };

/** Return whichever slot state is at least as undressed. */
export function strongerSlotState(a: WardrobeSlotState, b: WardrobeSlotState): WardrobeSlotState {
  return SLOT_STATE_RANK[a] >= SLOT_STATE_RANK[b] ? a : b;
}

/**
 * A whole-coverage-band row escalated to `state`, but MONOTONE: any coverage slot already at or past
 * `state`'s severity keeps its stronger value, so applying `displaced` over an already-`removed`
 * row never visually re-dresses the character. From an EMPTY row this is exactly
 * {@link coverageRow} (every absent slot escalates to `state`).
 */
export function escalateCoverageRow(
  row: Partial<Record<WardrobeSlotId, WardrobeSlotState>>,
  state: WardrobeSlotState,
): Partial<Record<WardrobeSlotId, WardrobeSlotState>> {
  const out: Partial<Record<WardrobeSlotId, WardrobeSlotState>> = {};
  for (const id of COVERAGE_SLOT_IDS) {
    out[id] = strongerSlotState(row[id] ?? "worn", state);
  }
  return out;
}

/**
 * One source of truth for whether a no-turn clothing action is allowed. The helper reads only
 * namespaced module flags, so the live engine model and read-only projection receive the same
 * decision and player-facing reason. Priority preserves the engine's established combat-first gate.
 */
export function wardrobeLockOf(model: WardrobeLockSource): WardrobeLock {
  const modules = model.modules;
  if ((modules?.combat as { active?: boolean } | undefined)?.active === true) {
    return {
      locked: true,
      reason: "Not while blades are out — sort your clothing after the fight.",
    };
  }
  if ((modules?.captivity as { active?: boolean } | undefined)?.active === true) {
    return {
      locked: true,
      reason: "Your clothing is out of reach while you are held captive.",
    };
  }
  return { locked: false };
}

/** One-line factual descriptor for an `AttireState`, for the narrator/NPC brief. */
export function attireDescriptor(state: AttireState): string {
  return state === "bare" ? "no clothing worn" : "clothing displaced or removed, not fully dressed";
}

function clothingTermRe(...terms: string[]): RegExp {
  return new RegExp(`\\b(?:${terms.join("|")})\\b`);
}

const CLOTHING_LIKE_RE = clothingTermRe(
  "clothes",
  "outfits?",
  "garbs?",
  "attires?",
  "cloaks?",
  "coats?",
  "robes?",
  "gowns?",
  "dress(?:es)?",
  "shirts?",
  "tunics?",
  "wraps?",
  "boots?",
  "shoes?",
  "sandals?",
  "gloves?",
  "gauntlets?",
  "masks?",
  "veils?",
  "hoods?",
  "hats?",
  "helms?",
  "helmets?",
  "caps?",
  "scar(?:f|fs|ves)",
  "amulets?",
  "necklaces?",
  "skirts?",
  "trousers?",
  "pants",
  "breeches",
  "corsets?",
  "chemises?",
  "underwear",
  "briefs",
);

// Per-slot term lists. Kept as ARRAYS (not inline regex literals) for one reason: the negated-mention
// stripper below builds its alternation from their UNION, so a garment term added to a slot is a
// garment term the "no coat" guard already knows about.
const HEAD_TERMS = ["hoods?", "hats?", "helms?", "helmets?", "caps?", "crowns?"];
const FACE_TERMS = ["masks?", "veils?", "blindfolds?"];
const NECK_TERMS = ["scar(?:f|fs|ves)", "amulets?", "necklaces?", "chokers?", "collars?"];
const OVER_UPPER_TERMS = ["cloaks?", "coats?", "robes?", "gowns?", "wraps?", "mantles?", "jackets?"];
const UPPER_TERMS = [
  "shirts?",
  "tunics?",
  "bodices?",
  "blouses?",
  "vests?",
  "dress(?:es)?",
  "robes?",
  "gowns?",
  "clothes",
  "outfits?",
  "garbs?",
  "attires?",
];
const UNDER_UPPER_TERMS = ["bras?", "corsets?", "chemises?", "undershirts?", "underclothes"];
const HANDS_TERMS = ["gloves?", "gauntlets?"];
const OVER_LOWER_TERMS = ["aprons?", "overskirts?", "sarongs?"];
const LOWER_TERMS = [
  "skirts?",
  "trousers?",
  "pants",
  "breeches",
  "dress(?:es)?",
  "robes?",
  "gowns?",
  "clothes",
  "outfits?",
  "garbs?",
  "attires?",
];
const UNDER_LOWER_TERMS = ["underwear", "briefs", "drawers", "loincloths?", "underclothes"];
const FEET_TERMS = ["boots?", "shoes?", "sandals?", "slippers?", "clothes", "outfits?", "travelers?"];

const HEAD_CLOTHING_RE = clothingTermRe(...HEAD_TERMS);
const FACE_CLOTHING_RE = clothingTermRe(...FACE_TERMS);
const NECK_CLOTHING_RE = clothingTermRe(...NECK_TERMS);
const OVER_UPPER_CLOTHING_RE = clothingTermRe(...OVER_UPPER_TERMS);
const UPPER_CLOTHING_RE = clothingTermRe(...UPPER_TERMS);
const UNDER_UPPER_CLOTHING_RE = clothingTermRe(...UNDER_UPPER_TERMS);
const HANDS_CLOTHING_RE = clothingTermRe(...HANDS_TERMS);
const OVER_LOWER_CLOTHING_RE = clothingTermRe(...OVER_LOWER_TERMS);
const LOWER_CLOTHING_RE = clothingTermRe(...LOWER_TERMS);
const UNDER_LOWER_CLOTHING_RE = clothingTermRe(...UNDER_LOWER_TERMS);
const FEET_CLOTHING_RE = clothingTermRe(...FEET_TERMS);

/**
 * A garment mention that is explicitly DENIED, so the occupancy read can drop it before counting.
 *
 * WHY (regex audit §10e, 2026-07-28). `occupiedCoverageOf` decides which coverage slots a character
 * has clothing in by term-matching their prose — and a term match cannot tell "in a salt-stained
 * coat" from "no coat to speak of". Reproduced on shipped content: `npc.sorrel-runaway`, whose
 * authored description ends "…three days on the open road with no coat to speak of", scored the
 * `over-upper` slot as OCCUPIED. With her top and bottoms removed she therefore read "disheveled"
 * where an identically-stripped character with no garment in her prose read "bare" — the same
 * wardrobe state, two different answers, decided by a word that says she owns nothing.
 *
 * Deliberately TIGHT, because a false strip is as wrong as a false wear:
 *  - the denial must be one of a closed set of negators, and
 *  - it must sit within two words of the garment, with no clause break between them
 *    ("no coat", "no proper coat", "no proper winter coat" — but not "no fear in her, and her coat").
 * Anything looser and an ordinary sentence starts undressing people.
 */
const NEGATED_GARMENT_RE = new RegExp(
  `\\b(?:no|without(?:\\s+(?:an?|any))?|lacking|lacks|missing|bereft\\s+of|devoid\\s+of)\\s+` +
    `(?:[a-z][a-z-]*\\s+){0,2}` +
    `(?:${[
      ...HEAD_TERMS,
      ...FACE_TERMS,
      ...NECK_TERMS,
      ...OVER_UPPER_TERMS,
      ...UPPER_TERMS,
      ...UNDER_UPPER_TERMS,
      ...HANDS_TERMS,
      ...OVER_LOWER_TERMS,
      ...LOWER_TERMS,
      ...UNDER_LOWER_TERMS,
      ...FEET_TERMS,
    ].join("|")})\\b`,
  "g",
);

/**
 * Blank out every DENIED garment mention in a character's own appearance prose, so a description
 * that says what someone is NOT wearing can't dress them. Lowercase in, lowercase out; a text with
 * no denial comes back byte-identical (so every existing character's occupancy is unchanged).
 * Character prose only — an ITEM's name/description never denies itself, and {@link isClothingText}
 * deliberately does not use this.
 */
export function stripNegatedGarments(lowercaseText: string): string {
  return lowercaseText.replace(NEGATED_GARMENT_RE, " ");
}

/** Whether a text blob mentions any garment at all — the "is this item clothing?" gate. */
export function isClothingText(text: string): boolean {
  return CLOTHING_LIKE_RE.test(text.toLowerCase());
}

/**
 * The wardrobe slots a text blob's clothing terms cover — an item's id+name+description, or a
 * character's appearance prose. Term-match only: an empty result is a legitimate "no signal", and
 * any defaulting belongs to callers who know their domain (the paper-doll assumes a slotless
 * clothing ITEM covers `upper`; an occupancy read treats no-signal as occupancy-unknown).
 */
export function occupiedSlotsOf(text: string): Set<WardrobeSlotId> {
  const t = text.toLowerCase();
  const slots = new Set<WardrobeSlotId>();
  if (HEAD_CLOTHING_RE.test(t)) slots.add("head");
  if (FACE_CLOTHING_RE.test(t)) slots.add("face");
  if (NECK_CLOTHING_RE.test(t)) slots.add("neck");
  if (OVER_UPPER_CLOTHING_RE.test(t)) slots.add("over-upper");
  if (UPPER_CLOTHING_RE.test(t)) slots.add("upper");
  if (UNDER_UPPER_CLOTHING_RE.test(t)) slots.add("under-upper");
  if (HANDS_CLOTHING_RE.test(t)) slots.add("hands");
  if (OVER_LOWER_CLOTHING_RE.test(t)) slots.add("over-lower");
  if (LOWER_CLOTHING_RE.test(t)) slots.add("lower");
  if (UNDER_LOWER_CLOTHING_RE.test(t)) slots.add("under-lower");
  if (FEET_CLOTHING_RE.test(t)) slots.add("feet");
  return slots;
}
