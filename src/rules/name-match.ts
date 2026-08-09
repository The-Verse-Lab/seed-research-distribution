/**
 * Distinctive-token name matching — the ONE place that decides whether a stretch of text names a
 * particular PERSON. Pure: no RNG, no IO, no state.
 *
 * WHY THIS EXISTS: the repo already solved this bug class once, for destinations
 * (`matchExitInProse`, `src/world/exit-match.ts`, the r6-part-2 wave): a spoken plan grounds a move
 * only on a UNIQUE, DISTINCTIVE token match, because a lone shared place-word ("hall", "road") names
 * a KIND of place, not a place. That rule was never propagated to PEOPLE, and eight separate sites
 * re-derived the same broken "any ≥3-char token of the name appears in the text" test. Executed
 * against the former bundled roster (66 NPCs) that test scored, among others:
 *
 *   "You step back onto the coast road. One of the drovers spits into the dust and says the old
 *    ferry has not run in a year. A nightjar calls from the reeds."
 *     → five absent people named on the narrator's `Not present` line: Coast Farmhand ("coast"),
 *       Nightjar ("nightjar"), Old Corle ("old"), Old Wenna ("old"), One of the Standing ("one").
 *   "I hitch the dray and load the crates."           → a sighting recorded for the NPC "Dray".
 *   "The room goes quiet as the tide turns."          → a cast-presence violation for "Lys the
 *                                                       Quiet", and the sentence DELETED from the
 *                                                       player's screen by the absence floor.
 *   "I attack the wight before it reaches Oda."       → "Oda the Wayfarer" bound on the bare article
 *                                                       "the", so the friendly-fire guard read the
 *                                                       line as deliberate betrayal: companion
 *                                                       dropped from the party, −100 both ways, HP
 *                                                       damage. 12 of the 66 regression names carry
 *                                                       a stop-word token.
 *
 * THE RULE, in preference order — a name binds on its most specific available handle, and the less
 * specific the handle, the more evidence the text must supply:
 *
 *   1. DISTINCTIVE tokens — ≥3 chars, not name-noise (articles/quantifiers/honorifics/ranks), and
 *      not an ordinary English dictionary word. "Corle", "Wenna", "Oda", "Lys". These bind on their
 *      own, in any casing, unless the caller's `surface` says capitals are evidence.
 *   2. ORDINARY tokens — ≥3 chars, not name-noise, but a plain English word ("Dray", "Coast",
 *      "Farmhand", "Standing"). Consulted only when the name has NO distinctive token, and then only
 *      where the text CAPITALIZES the occurrence. Capitalization is the only remaining evidence
 *      that a dictionary word is being used as somebody's name, so it is required even for casual
 *      player input.
 *   3. The FULL NAME as a phrase — for a name built entirely out of noise tokens, which has no
 *      handle of its own at all. Capitalized, except on the `player-query` surface (below).
 *
 * And two mechanical rules that are not negotiable:
 *   - WORD BOUNDARIES and `matchAll`, never `indexOf`. `indexOf` produced a false NEGATIVE as well
 *     as false positives: "The pagoda burned; Oda said so." found only the FIRST "oda" — the one
 *     inside "pagoda" — saw it was not word-bounded, and reported that Oda was never mentioned.
 *   - A miss is always safer than a wrong hit. Every fallback here narrows; none widens.
 *
 * The token tables below are CLOSED and code-owned, and the honorific/rank half was derived from a
 * broad authored regression corpus rather than guessed. Neutral fixtures in `tests/name-match.test.ts`
 * pin the distinction between names, titles, and ordinary words.
 *
 * @author Runkai Zhang
 */
import { escapeRegExp } from "../util/text.ts";

/** Shorter than this and a token identifies nobody, however unusual it looks ("Al", "Ka"). */
const MIN_HANDLE_LEN = 3;

/** Articles, connectives and prepositions that sit inside authored names. */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "at", "on", "for", "with", "von", "van", "de",
]);

/**
 * The function-word half of the tier-1 table, exported on its own because the ITEM matcher
 * (`matchItemLoosely`) needs exactly this much and no more: an item's identity IS an ordinary
 * English word ("rope", "lantern", "rations") and its ids are lowercase slugs, so neither the
 * dictionary tier nor the capitalization rule can apply there — but "flask of oil" must still not
 * bind "vial of acid" on the shared token "of".
 */
export const NAME_FUNCTION_WORDS = FUNCTION_WORDS;

/**
 * Tier 1 — tokens that can NEVER identify a person: articles, connectives, quantifiers, scale/age
 * descriptors, and the honorifics/ranks/offices an authored name carries. Every entry that is a
 * title is taken from an authored regression name ("Sergeant Veil", "Captain Reyd Voss", "Master
 * Vench", "Madame Selis Corr", "Mother Quist", "Sister Lian", "Grandmother Aud", "Keeper Itha",
 * "Foreman Kesh", "Overseer Marsk", "Harbormaster Dell", "The Widow of the Tor", "Alda Umber, the
 * Countess of Umberwick", "Osric, the Tithe-Clerk"), plus the sibling ranks a future world would
 * plausibly author in the same series. A line containing one of these has named NOBODY.
 */
const NAME_NOISE_TOKENS: ReadonlySet<string> = new Set([
  ...FUNCTION_WORDS,
  // quantifiers ("One of the Standing")
  "one", "two", "three", "four", "five", "some", "any", "each", "every", "all", "both", "few",
  "many", "several", "none", "half", "most",
  // scale / age descriptors ("Old Corle", "Old Wenna", "The Half-Frozen")
  "old", "young", "elder", "eldest", "little", "big", "great", "new", "lesser", "greater",
  // honorifics, ranks and offices (regression roster + siblings)
  "sergeant", "captain", "corporal", "lieutenant", "commander", "marshal", "constable",
  "master", "mistress", "madame", "madam", "lady", "lord", "sir", "dame",
  "mother", "grandmother", "father", "grandfather", "sister", "brother", "aunt", "uncle",
  "keeper", "foreman", "overseer", "harbormaster", "dockmaster", "quartermaster", "gatewarden",
  "widow", "widower", "countess", "count", "baron", "baroness", "earl", "duke", "duchess",
  "clerk", "warden", "priest", "priestess", "doctor", "goodwife", "goodman", "steward", "reeve",
]);

/**
 * Tier 2 — ordinary English words. A roster name may be spelled with one ("Dray", "Coast Farmhand",
 * "Plains Drover", "Lys the Quiet"), so these are not noise; they simply cannot bind a person off a
 * lowercase occurrence, because in lowercase they are the thing, not the person.
 *
 * The list is CLOSED on purpose, the same discipline as `text-match.ts`'s inflection table: a word
 * that is missing is merely treated as distinctive (and then still gated by the caller's
 * `surface`), never as a wildcard. It covers the roster's own dictionary tokens plus the
 * common nouns/adjectives GM prose actually reaches for — scenery, bodies, weather, roles, trades.
 *
 * ENTRY CRITERION: a word belongs here only when its COMMON-NOUN reading dominates its use as a
 * name. "Farmhand", "drover", "dockhand", "dray" are things and jobs nobody is called; "Smith",
 * "Wren", "Sorrel", "Dell", "Veil" are names first, and demoting them would cost a real match every
 * time a player types their companion's name in lower case. Coined or archaic world-words
 * ("reaver", "wayfarer", "gatewright", "saltmother") are absent for the same reason.
 */
const ORDINARY_WORD_TOKENS: ReadonlySet<string> = new Set([
  // --- dictionary tokens derived from the original regression corpus ---
  "ash", "cairn", "citizen", "coast", "cutpurse", "dockhand", "dray", "drifter", "drover",
  "drowned", "farmhand", "fen", "ford", "frozen", "glass", "hand", "hunter", "indenture", "isles",
  "knives", "lantern", "local", "marches", "night", "nightjar", "plains", "prowler", "quiet",
  "quill", "road", "runner", "sable", "salt", "shadow", "stalker", "standing", "street",
  "taker", "thing", "tor", "vale", "walker", "waste", "wrecker",
  // --- land, water, weather ---
  "hill", "hills", "wood", "woods", "forest", "field", "fields", "moor", "marsh", "mire", "bog",
  "river", "creek", "brook", "stream", "lake", "pond", "sea", "ocean", "shore", "beach", "sand",
  "stone", "stones", "rock", "cliff", "ridge", "valley", "peak", "mountain", "cave", "pit",
  "rain", "snow", "ice", "frost", "wind", "storm", "fog", "mist", "cloud", "sun", "moon", "star",
  "stars", "sky", "dawn", "dusk", "day", "morning", "evening", "noon", "midnight", "light", "dark",
  "shade", "fire", "flame", "smoke", "ember", "ashes", "water", "mud", "dust", "earth", "grass",
  "reed", "reeds", "tree", "trees", "root", "branch", "leaf", "leaves", "thorn", "vine", "moss",
  // --- built things ---
  "town", "city", "village", "hamlet", "gate", "gates", "wall", "walls", "door", "doors", "roof",
  "floor", "stair", "stairs", "bridge", "tower", "keep", "hall", "house", "hut", "shed", "barn",
  "inn", "tavern", "shop", "stall", "market", "square", "yard", "lane", "alley", "dock", "docks",
  "pier", "quay", "harbor", "harbour", "port", "camp", "tent", "fence", "well", "mill", "forge",
  "temple", "shrine", "chapel", "tomb", "grave", "crypt", "cellar", "attic", "room", "chamber",
  "bed", "table", "chair", "bench", "hearth", "fireplace", "window", "path", "track", "trail",
  // --- body, person, clothing ---
  "head", "face", "eye", "eyes", "mouth", "lip", "lips", "hair", "arm", "arms", "leg", "legs",
  "foot", "feet", "hands", "finger", "back", "chest", "heart", "blood", "bone", "bones", "skin",
  "voice", "breath", "throat", "shoulder", "knee", "man", "woman", "boy", "girl", "child",
  "children", "folk", "person", "people", "crowd", "stranger", "friend", "enemy", "body",
  "cloak", "coat", "boot", "boots", "hat", "hood", "belt", "glove", "gloves", "shirt", "dress",
  "robe", "scarf", "ring", "chain", "mask",
  // --- trades and roles ---
  "guard", "guards", "soldier", "baker", "miller", "farmer", "fisher", "sailor", "cook",
  "porter", "carter", "trader", "merchant", "peddler", "beggar", "thief", "bandit", "raider",
  "scout", "ranger", "healer", "singer", "piper", "digger", "miner", "tanner", "weaver",
  "boss", "chief", "leader", "servant", "slave", "worker", "hired", "prisoner", "captive",
  // --- goods and gear ---
  "cart", "wagon", "crate", "crates", "barrel", "sack", "rope", "chain", "knife", "blade",
  "sword", "axe", "bow", "arrow", "spear", "club", "shield", "armor", "armour", "coin", "coins",
  "silver", "gold", "copper", "iron", "steel", "cloth", "leather", "bread", "meat",
  "waterskin", "wine", "ale", "beer", "grain", "seed", "torch", "candle",
  "letter", "paper", "book", "map", "key", "lock", "bag", "pack", "purse", "pouch", "cup", "bowl",
  // --- adjectives / participles that show up capitalized at a sentence head ---
  "cold", "warm", "hot", "wet", "dry", "sharp", "dull", "hard", "soft", "loud", "still", "silent",
  "quick", "slow", "long", "short", "tall", "thin", "thick", "heavy", "deep", "high",
  "low", "far", "near", "open", "closed", "broken", "empty", "full", "clean", "dirty", "black",
  "white", "grey", "gray", "red", "blue", "green", "brown", "pale", "bright", "sick", "dead",
  "alive", "lost", "found", "free", "true", "false", "good", "bad", "kind", "cruel", "brave",
  "afraid", "tired", "hungry", "thirsty", "burned", "burning", "waiting", "running", "walking",
  // --- common verbs / abstractions ---
  "work", "trade", "watch", "wait", "hunt", "sing", "call", "cry", "run", "walk", "ride", "sleep",
  "rest", "eat", "drink", "fight", "kill", "die", "death", "life", "war", "peace", "law", "debt",
  "price", "cost", "toll", "tithe", "oath", "word", "words", "name", "names", "story", "tale",
  "song", "news", "truth", "lie", "fear", "hope", "luck", "time", "year", "years", "month", "week",
  "hour", "hours", "place", "way", "ways", "end", "start", "side", "part", "line", "turn", "hold",
]);

/** Lowercase alphanumeric tokens of a name — the raw surface, nothing dropped. */
export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Whether a lowercase token is tier-1 noise: it names a KIND of person, never a person. */
export function isNameNoiseToken(token: string): boolean {
  return token.length < MIN_HANDLE_LEN || NAME_NOISE_TOKENS.has(token);
}

/** Whether a lowercase token is an ordinary English word (tier 2 — binds only when capitalized). */
export function isOrdinaryWord(token: string): boolean {
  return ORDINARY_WORD_TOKENS.has(token);
}

/**
 * Every token of `name` that could serve as a handle — tier-1 noise dropped. This is the
 * over-inclusive set: use it where a MISS is the expensive direction (deciding two roster stylings
 * are the same person, or reading a player's own attack line), never where a wrong hit is.
 */
export function nameHandleTokens(name: string): string[] {
  return nameTokens(name).filter((t) => !isNameNoiseToken(t));
}

/**
 * The tokens that bind `name` on their own, in any casing — tier-1 noise AND ordinary English words
 * dropped. Empty for a name spelled entirely out of common words ("Coast Farmhand", "Plains
 * Drover"), which is the honest answer: nothing in that name is distinctive, so `findNameMention`
 * falls back to demanding a capitalized occurrence.
 */
export function distinctiveNameTokens(name: string): string[] {
  return nameHandleTokens(name).filter((t) => !isOrdinaryWord(t));
}

/** Whether two names share a handle token — the "one person under two stylings" test. */
export function sharesNameToken(a: string, b: string): boolean {
  const bt = new Set(nameHandleTokens(b));
  return nameHandleTokens(a).some((t) => bt.has(t));
}

export interface NameMention {
  /** The handle that bound — a single token, or the whole normalized name. */
  handle: string;
  /** Offset of the handle's first character in the ORIGINAL text. */
  index: number;
  /** Which tier bound it, for callers that want to weigh the evidence. */
  tier: "distinctive" | "ordinary" | "fullName";
}

/**
 * WHAT THE CALLER CAN VOUCH FOR about the text it is handing in. Not "who wrote it" — what EVIDENCE
 * is available — because the two are not the same at every site (`prose-entities.ts` reads model
 * prose but owns the capitalization argument itself, so it wants `uncased` even though nobody typed
 * the passage).
 *
 * The ladder only ever loosens by ONE handle at a time, and the loosest rung still refuses to read a
 * lone dictionary word as a person.
 */
export type NameSurface =
  /**
   * The default and the safe branch. Capitals ARE evidence and are required at every tier: a
   * narrator capitalizes the people it stages, so a lowercase hit is a common noun.
   */
  | "prose"
  /**
   * Casing carries no signal — player-typed input ("i attack oda"), or prose whose capitalization
   * the caller judges with its own gate. A DISTINCTIVE token binds in any casing; tiers 2 and 3
   * still demand a capital, because for a dictionary word capitalization is the only evidence left
   * that it is being used as somebody's name.
   */
  | "uncased"
  /**
   * `uncased`, PLUS one extra handle: the FULL NAME as a phrase, uncapitalized. The caller is
   * vouching — from code-side evidence, never from the text — that this line is ASKING ABOUT a
   * person, which is the disambiguating fact the text itself cannot supply ("dray" is both a
   * quartermaster and a cart).
   *
   * What it deliberately does NOT do is relax tier 2. A multi-handle name still never binds on ONE
   * of its ordinary words: "give me a hand" is not "Isles Hand", "what's the thing in the water" is
   * not "A Drowned Thing", and "a nightjar calls from the reeds" is not the innkeeper — the player
   * has to name them the way the world does. That is the whole difference between this and the
   * REVERTED "just drop the capital rule for player text", which re-bound the quartermaster off "I
   * hitch the dray and load the crates" (see `findNameMention`).
   */
  | "player-query";

export interface NameMentionOptions {
  /** What the caller can vouch for about `text`. Defaults to `prose` — the strictest rung. */
  surface?: NameSurface;
  /**
   * The world's PLACE vocabulary (`placeTokensOf`) — tokens that name somewhere, so they may not
   * bind somebody ON THEIR OWN. A `<Place> <Role>` name whose role half is noise keeps only the
   * place as a handle, and then every mention of the map is a mention of the person: live r11,
   * "You reach Anchorfall by dusk." bound the absent "Anchorfall Local" and, through the absence
   * floor, deleted the sentence. Suppressing the token does NOT make the person unnameable — the
   * whole name, spelled out, still binds at the `fullName` tier.
   */
  placeTokens?: ReadonlySet<string>;
}

/** Whether the character at `index` in `text` is an upper-case letter. */
function capitalizedAt(text: string, index: number): boolean {
  const ch = text[index];
  if (ch === undefined) return false;
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/** Every word-bounded occurrence of `token` in `text` (case-insensitive), as start offsets. */
function occurrencesOf(text: string, token: string): number[] {
  // `matchAll`, never `indexOf`: `indexOf` finds the FIRST substring hit and stops, so a needle
  // buried in a longer word ("oda" inside "pagoda") masks the real, word-bounded mention later in
  // the same sentence — a silent false NEGATIVE on top of the false positives.
  const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, "gi");
  return [...text.matchAll(re)].map((m) => m.index);
}

/** The whole name as a phrase: tokens in order, separated by any run of non-alphanumerics. */
function phraseOccurrences(text: string, tokens: string[]): number[] {
  if (tokens.length === 0) return [];
  const source = tokens.map((t) => escapeRegExp(t)).join("[^A-Za-z0-9]+");
  return [...text.matchAll(new RegExp(`\\b${source}\\b`, "gi"))].map((m) => m.index);
}

/**
 * Where (and how) `name` is named in `text`, or null. See the module header for the tier order.
 *
 * The tiers are tried in sequence and, ON PROSE, the search STOPS at the first tier that has any
 * handle at all: a name with a distinctive token is never rescued by one of its ordinary tokens,
 * because "Coast" appearing in "the Coast Road" must not stand in for "Coast Farmhand" while
 * "Farmhand" is nowhere in the text.
 *
 * THE LIMIT THIS USED TO CARRY, and how `player-query` closes it. On PLAYER-typed text there is no
 * capital to lean on, so a name whose every token is an ordinary word was reachable only when the
 * player capitalized it: "Where can I find Dray?" bound, "where can i find dray" did not. That was
 * measured at 17 of the 66 names in the original regression corpus — though only THREE of the 17 ("Dray",
 * "Nightjar", "The Widow of the Tor") stand on a location roster with a schedule, and the other 14
 * are ambient crowd templates the two affected sites skip anyway.
 *
 * Simply relaxing the tier stop for player text was tried and REVERTED, and must not be retried: it
 * re-opened the exact false positives this module exists to close — "I hitch the dray and load the
 * crates" bound the quartermaster again, and a scenery word in a bystander line addressed the fight
 * again (three pinned specs went red; they are still in `tests/name-match.test.ts`). The two
 * readings are genuinely indistinguishable from the text alone — "dray" is both a person and a cart
 * — so the disambiguating evidence has to come from the CALLER. A false positive here corrupts
 * state (a bogus sighting, a suppressed parley); the false negative only degrades a convenience.
 *
 * So `player-query` is deliberately NOT that revert. It adds exactly one handle — the WHOLE name,
 * uncapitalized — and only for a caller that can prove the line is asking about somebody:
 *   - "where can i find dray?"  ⇒ the phrase "dray" IS the whole name        ⇒ binds
 *   - "i hitch the dray"        ⇒ same phrase, but the caller is a narrative-action site that never
 *                                 asks for this surface                       ⇒ nobody
 *   - "give me a hand"          ⇒ "Isles Hand" needs BOTH its words           ⇒ nobody, on every surface
 * A name that HAS a distinctive token is unaffected by the extra tier, because the phrase contains
 * that token: if tier 1 missed it, the phrase cannot match either.
 */
export function findNameMention(
  text: string,
  name: string,
  options: NameMentionOptions = {},
): NameMention | null {
  if (!text || !name.trim()) return null;
  const surface = options.surface ?? "prose";
  const query = surface === "player-query";
  // A place token is never a lone handle (see `NameMentionOptions.placeTokens`). Dropping it can
  // empty a tier, and an empty tier FALLS THROUGH — "Anchorfall Local" keeps nothing distinctive
  // and nothing ordinary, so the only handle left is the whole capitalized phrase, which is exactly
  // the sentence that really does name the man rather than the harbor.
  const notAPlace = (token: string): boolean => !options.placeTokens?.has(token);

  const distinctive = distinctiveNameTokens(name).filter(notAPlace);
  if (distinctive.length > 0) {
    for (const token of distinctive) {
      for (const index of occurrencesOf(text, token)) {
        if (surface === "prose" && !capitalizedAt(text, index)) continue;
        return { handle: token, index, tier: "distinctive" };
      }
    }
    // No fall-through even on `player-query`: the full-name phrase CONTAINS this token, so a phrase
    // hit is impossible where the token itself was not found. Stopping here also preserves the tier
    // stop — "Coast" in "the Coast Road" must never stand in for "Coast Farmhand".
    return null;
  }

  const ordinary = nameHandleTokens(name).filter(notAPlace);
  if (ordinary.length > 0) {
    for (const token of ordinary) {
      for (const index of occurrencesOf(text, token)) {
        if (!capitalizedAt(text, index)) continue;
        return { handle: token, index, tier: "ordinary" };
      }
    }
    // A LONE ordinary word stays capital-gated on every surface, `player-query` included. Only the
    // whole name below may bind uncased, so an asked-about "Isles Hand" needs "isles hand", never
    // the "hand" in "give me a hand".
    if (!query) return null;
  }

  // Nothing but noise tokens ("The One", "A Thing of the Deep" once its nouns are stripped): the
  // whole phrase is the only handle left. Capitalized — except for a caller vouching that the line
  // ASKS ABOUT somebody, where the whole name spelled out is evidence enough on its own.
  const tokens = nameTokens(name);
  for (const index of phraseOccurrences(text, tokens)) {
    if (!query && !capitalizedAt(text, index)) continue;
    return { handle: tokens.join(" "), index, tier: "fullName" };
  }
  return null;
}

/** Whether `text` names the person called `name`. See `findNameMention`. */
export function nameMentionedIn(text: string, name: string, options: NameMentionOptions = {}): boolean {
  return findNameMention(text, name, options) !== null;
}
