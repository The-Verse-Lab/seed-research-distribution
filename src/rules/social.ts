/**
 * Social-read resolver — how an observer's tastes + a target's perceived signals bend disposition.
 *
 * PURE and deterministic: no RNG, no IO, no model calls, no world writes. An observer NPC's authored
 * `preferences`/`boundaries`/`socialTraits` are matched (case-insensitive, WHOLE WORDS — see
 * `text-match.ts`) against a target's perceived `appearanceTags`/`presentationTags`/`socialTraits`
 * to produce BOUNDED `SocialModifier`s, each carrying a human-readable `reason`. Appearance
 * influences probability and tone; it NEVER forces an outcome — every delta is clamped to
 * `[-SOCIAL_MODIFIER_MAX, +MAX]` and the agenda fold turns the net into a small nudge on stance
 * intensity, nothing more.
 *
 * THE FIELD NAME IS NOT THE POLARITY. `preferences`/`boundaries` are authored as free PROSE, and
 * shipped content puts aversions in `preferences` (npc.freelance-clerk: "dislikes swagger and
 * hard-luck stories"; npc.sela: "No patience for heroics") and affinities in `boundaries`
 * (npc.hollis: "warms to honest work faster than to fine words"). Trusting the field name inverted
 * the read on real content, so a hit's SIGN comes from the polarity marker nearest the matched
 * words (`clausePolarityAt`), and the field only supplies the fallback for an unmarked clause.
 *
 * KNOWN LIMIT (deliberate, needs a content migration to close): these fields also hold self-CONDUCT
 * rules ("will not hire children for flood-work"), which are statements about the NPC's own
 * behavior, not a read on whoever stands in front of them. No amount of matching makes a sentence
 * into a tag — the honest fix is a schema split into closed `likes`/`dislikes` tag lists plus a
 * separate prose `conduct` field, and a migration of `worlds/*.json`. Until then such a clause reads
 * as an aversion (its leading "will not"/"never" marker), which is what it did before this change
 * too, so nothing regresses; the marker layer only stops the SIGN from inverting where an author
 * actually stated one.
 *
 * @author Runkai Zhang
 */

import { isNegatedAt, phraseIndexIn, runIsDistinctive, runMatchesAt, wordsOf } from "./text-match.ts";

/** The disposition axes a social read can move. */
export type SocialAxis = "trust" | "fear" | "hostility" | "respect";

/** One bounded, reasoned nudge on a single axis. */
export interface SocialModifier {
  axis: SocialAxis;
  delta: number;
  reason: string;
}

/** The perceived signals a target presents to an observer. */
export interface TargetSignals {
  appearanceTags?: string[];
  presentationTags?: string[];
  socialTraits?: string[];
  /**
   * Perceived-right-now signals from `visibleStateOf` (for example "disheveled") — same lowercase
   * register as `socialTraits`. Unioned into the TARGET_TRAIT_TABLE intrinsic read only (step 3);
   * NOT added to the preference/boundary affinity match, which stays authored-tag-only.
   */
  visibleKeywords?: string[];
}

/** The observer's authored tastes and reactions. */
export interface ObserverSignals {
  preferences?: string[];
  boundaries?: string[];
  socialTraits?: string[];
}

/** No modifier may push an axis past this in either direction — appearance never forces an outcome. */
export const SOCIAL_MODIFIER_MAX = 20;

/**
 * Social traits a TARGET may carry → the axes they move on any observer, with the per-hit delta.
 * The keyword is a STEM matched case-insensitively against WHOLE WORDS of each target socialTrait
 * (`stemMatches`): "intimidat" still hits "intimidating"/"intimidation", but "warm" no longer hits
 * "warmonger" (was: trust +5) and "sly" no longer hits "grisly" (was: trust −4).
 */
const TARGET_TRAIT_TABLE: ReadonlyArray<{ keyword: string; effects: ReadonlyArray<{ axis: SocialAxis; delta: number }> }> = [
  { keyword: "intimidat", effects: [{ axis: "fear", delta: 6 }, { axis: "trust", delta: -3 }] },
  { keyword: "threaten", effects: [{ axis: "fear", delta: 6 }, { axis: "hostility", delta: 3 }] },
  { keyword: "menac", effects: [{ axis: "fear", delta: 5 }, { axis: "hostility", delta: 2 }] },
  { keyword: "charismat", effects: [{ axis: "trust", delta: 5 }, { axis: "respect", delta: 3 }] },
  { keyword: "warm", effects: [{ axis: "trust", delta: 5 }, { axis: "respect", delta: 2 }] },
  { keyword: "earnest", effects: [{ axis: "trust", delta: 4 }, { axis: "respect", delta: 2 }] },
  { keyword: "sly", effects: [{ axis: "trust", delta: -4 }] },
  { keyword: "aloof", effects: [{ axis: "trust", delta: -3 }] },
  { keyword: "disheveled", effects: [{ axis: "respect", delta: -1 }] },
];

function lower(tags: string[] | undefined): string[] {
  return (tags ?? []).map((t) => t.toLowerCase());
}

// ---------------------------------------------------------------------------
// Polarity — what an authored clause actually SAYS about the thing it names.
// ---------------------------------------------------------------------------

/** +1 = the clause states an affinity for the matched words; −1 = an aversion. */
type Polarity = 1 | -1;

/** Verbs/phrases that state an AFFINITY. Stems (`text-match.ts` inflections) — "warm to" covers
 *  "warms to"/"warmed to". */
const LIKE_MARKERS: readonly string[] = [
  "like", "love", "enjoy", "prefer", "respect", "admire", "value", "appreciate", "trust", "favor",
  "favour", "welcome", "delight", "warm to", "warm fast", "warm slowly", "warms fast",
  "warms slowly", "fond of", "partial to", "keen on", "drawn to", "soft on",
];

/** Verbs/phrases that state an AVERSION — including the bare negators, so "will not X"/"never X"
 *  read as the refusals they are rather than as the field name's default. */
const DISLIKE_MARKERS: readonly string[] = [
  "dislike", "hate", "loathe", "despise", "detest", "resent", "scorn", "disdain", "contempt",
  "contemptuous", "distrust", "distrustful", "wary", "suspicious", "avoid", "refuse", "reject",
  "balk", "bristle", "flinch", "insult", "unmoved", "no patience", "no time", "cannot stand",
  "not stand", "sick of", "tired of", "cold to", "goes cold", "go cold", "turns cold",
  "goes quiet", "backs off", "back off", "backs down", "back down", "turns away", "turn away",
  "not", "never", "no", "nothing",
];

/** One polarity marker found in a clause, at a token index. */
interface PolarityMarker {
  index: number;
  polarity: Polarity;
}

/** The marker table, pre-tokenized and LONGEST-FIRST so "no patience" wins over the bare "no". */
const POLARITY_TABLE: ReadonlyArray<{ words: string[]; polarity: Polarity }> = [
  ...LIKE_MARKERS.map((phrase) => ({ words: wordsOf(phrase), polarity: 1 as Polarity })),
  ...DISLIKE_MARKERS.map((phrase) => ({ words: wordsOf(phrase), polarity: -1 as Polarity })),
].sort((a, b) => b.words.length - a.words.length);

/**
 * Every polarity marker in a clause, in ascending token order (one — the longest — per index).
 *
 * A NEGATED marker flips: npc.hollis's "never trusts twice anyone careless with the weak" carries
 * both "never" and "trusts", and reading the nearer "trusts" straight made a careless target read as
 * TRUSTED. A marker preceded by a negator states the opposite of itself, so "never trusts" is an
 * aversion and "never refuses" is an affinity.
 */
function markersIn(words: string[]): PolarityMarker[] {
  const out: PolarityMarker[] = [];
  for (let i = 0; i < words.length; i++) {
    const hit = POLARITY_TABLE.find((row) => runMatchesAt(words, i, row.words));
    if (!hit) continue;
    const polarity: Polarity = isNegatedAt(words, i) ? ((hit.polarity * -1) as Polarity) : hit.polarity;
    out.push({ index: i, polarity });
  }
  return out;
}

/**
 * The sign the clause states about the words matched at `atIndex`. The marker NEAREST-BEFORE the
 * match governs, so "likes A but dislikes B" reads B as an aversion and A as an affinity; a match
 * that sits at or before every marker takes the clause's leading marker ("swagger is something she
 * dislikes"); an unmarked clause falls back to the field default.
 */
function clausePolarityAt(
  markers: readonly PolarityMarker[],
  atIndex: number,
  fallback: Polarity,
  words: readonly string[] = [],
): Polarity {
  let nearest: PolarityMarker | undefined;
  for (const m of markers) {
    if (m.index >= atIndex) break; // ascending order — everything after this is past the match
    nearest = m;
  }
  const stated = nearest?.polarity ?? markers[0]?.polarity ?? fallback;
  // A COMPARATIVE pivot between the marker and the match names the DISPREFERRED side, so the
  // marker's own sign is the wrong one to hand it. npc.hollis's shipped boundary — "warms to honest
  // work faster than to fine words" — scored a "fine words" tag as a positive read off the leading
  // "warms to", i.e. exactly the inversion the polarity layer exists to prevent, just one clause
  // further along. Only the span BETWEEN the two is examined, so "I'd rather be warm than cold"
  // still reads its own halves correctly.
  const from = nearest ? nearest.index : 0;
  for (let i = from; i < atIndex && i < words.length; i++) {
    if (words[i] === "than" || words[i] === "over" || words[i] === "instead") {
      return (stated * -1) as Polarity;
    }
  }
  return stated;
}

/**
 * Whether an authored clause and a perceived tag share a WHOLE-WORD run — the shorter side wholly
 * contained in the longer, in either direction. Returns the run's index in the CLAUSE (what
 * `clausePolarityAt` needs) or null. Two rejections carry the adversarial-input guard: a run of
 * nothing but function words is not evidence (a player tag of "the" must not match every sentence
 * in the world), and a tag that NEGATES the shared words ("not striking") is not a hit for them.
 */
function affinityHitIndex(clauseWords: string[], tagWords: string[]): number | null {
  const inClause = phraseIndexIn(clauseWords, tagWords);
  if (inClause >= 0) {
    if (!runIsDistinctive(clauseWords, inClause, tagWords.length)) return null;
    if (isNegatedAt(tagWords, 0)) return null;
    return inClause;
  }
  const inTag = phraseIndexIn(tagWords, clauseWords);
  if (inTag >= 0) {
    if (!runIsDistinctive(tagWords, inTag, clauseWords.length)) return null;
    if (isNegatedAt(tagWords, inTag)) return null;
    return 0;
  }
  return null;
}

/** Merge modifiers that share an axis (summing) and clamp each axis's total to ±SOCIAL_MODIFIER_MAX. */
function mergeAndClamp(mods: SocialModifier[]): SocialModifier[] {
  const byAxis = new Map<SocialAxis, SocialModifier>();
  for (const m of mods) {
    const existing = byAxis.get(m.axis);
    if (existing) {
      existing.delta += m.delta;
      existing.reason = `${existing.reason}; ${m.reason}`;
    } else {
      byAxis.set(m.axis, { axis: m.axis, delta: m.delta, reason: m.reason });
    }
  }
  const out: SocialModifier[] = [];
  for (const m of byAxis.values()) {
    const clamped = Math.max(-SOCIAL_MODIFIER_MAX, Math.min(SOCIAL_MODIFIER_MAX, m.delta));
    if (clamped === 0) continue;
    out.push({ axis: m.axis, delta: clamped, reason: m.reason });
  }
  return out;
}

/**
 * Pure: the observer's tastes/boundaries + the target's perceived signals → bounded, reasoned
 * modifiers. Appearance influences probability/tone, NEVER forces outcomes; deltas are clamped to
 * [-MAX, +MAX] per axis. Returns `[]` when nothing matches (the zero-signal case — the agenda fold
 * then nudges by exactly 0, so stance is byte-identical to the pre-F world).
 */
export function resolveSocialModifiers(observer: ObserverSignals, target: TargetSignals): SocialModifier[] {
  const raw: SocialModifier[] = [];
  const push = (axis: SocialAxis, delta: number, reason: string): void => {
    raw.push({ axis, delta, reason });
  };

  const appearance = lower(target.appearanceTags);
  const presentation = lower(target.presentationTags);
  const targetTraits = lower(target.socialTraits);
  // Every perceived tag an observer preference/boundary can match against.
  const perceived = [
    ...appearance.map((t) => ({ tag: t, kind: "appearance" as const })),
    ...presentation.map((t) => ({ tag: t, kind: "presentation" as const })),
    ...targetTraits.map((t) => ({ tag: t, kind: "trait" as const })),
  ].map((row) => ({ ...row, words: wordsOf(row.tag) }));

  // 1+2) Observer PREFERENCES / BOUNDARIES that share whole words with a perceived tag. The SIGN is
  //      the polarity the clause states about those words, not the field it was authored in (see the
  //      header: shipped content puts dislikes in `preferences` and affinities in `boundaries`); the
  //      field only supplies the fallback for a clause that states no polarity at all. A positive
  //      read leans respect + trust; a negative read is distrust plus a little hostility.
  const clauseSets: ReadonlyArray<{ clauses: readonly string[]; fallback: Polarity }> = [
    { clauses: observer.preferences ?? [], fallback: 1 },
    { clauses: observer.boundaries ?? [], fallback: -1 },
  ];
  for (const { clauses, fallback } of clauseSets) {
    for (const clause of clauses) {
      const clauseWords = wordsOf(clause);
      const markers = markersIn(clauseWords);
      for (const { tag, kind, words } of perceived) {
        const at = affinityHitIndex(clauseWords, words);
        if (at === null) continue;
        if (clausePolarityAt(markers, at, fallback, clauseWords) > 0) {
          push("respect", kind === "trait" ? 4 : 6, `${tag} ${kind} (observer likes '${clause}') → respect +${kind === "trait" ? 4 : 6}`);
          push("trust", kind === "trait" ? 3 : 4, `${tag} ${kind} (observer likes '${clause}') → trust +${kind === "trait" ? 3 : 4}`);
        } else {
          push("trust", -6, `${tag} (observer dislikes '${clause}') → trust -6`);
          push("hostility", 4, `${tag} (observer dislikes '${clause}') → hostility +4`);
        }
      }
    }
  }

  // 3) The target's own social TRAITS carry an intrinsic read on any observer (fear/trust/respect) —
  //    unioned with what the observer can currently see from `visibleStateOf`, so
  //    live attire state reads the same way an authored trait would, without treating visibility as
  //    an affinity-matchable tag in steps 1/2 above.
  const visibleTraits = [...targetTraits, ...lower(target.visibleKeywords)];
  for (const trait of visibleTraits) {
    const traitWords = wordsOf(trait);
    for (const row of TARGET_TRAIT_TABLE) {
      // Whole-word stem, and never through a negation: "not warm"/"never menacing" is not the trait.
      const at = phraseIndexIn(traitWords, [row.keyword]);
      if (at < 0 || isNegatedAt(traitWords, at)) continue;
      for (const eff of row.effects) {
        const sign = eff.delta >= 0 ? "+" : "";
        push(eff.axis, eff.delta, `'${trait}' social trait → ${eff.axis} ${sign}${eff.delta}`);
      }
    }
  }

  return mergeAndClamp(raw);
}

/** One-line trace summary of a modifier set, e.g. `"trust +6, fear -4"` (empty ⇒ ""). */
export function summarizeModifiers(mods: SocialModifier[]): string {
  return mods.map((m) => `${m.axis} ${m.delta >= 0 ? "+" : ""}${m.delta}`).join(", ");
}
