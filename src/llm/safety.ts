/**
 * Minor-safety guardrail — the ONE hard line this engine will not cross.
 *
 * Seed delegates general content policy to the configured model. This module enforces one
 * non-negotiable exception: sexual or sexualized content involving
 * a MINOR (a character under 18, or described/implied as a child or adolescent) is never
 * generated — regardless of model, config, world data, or any unlock prefix.
 *
 * Properties this file guarantees:
 *  - MODEL-INDEPENDENT: pure functions over text + known character ages. No model required for
 *    the deterministic layer (an optional model judge only ADDS blocking, never removes it).
 *  - FAIL-CLOSED: when sexual content co-occurs with a minor signal whose status is ambiguous,
 *    the policy is to BLOCK (and, with a judge configured, block when the judge is unreachable).
 *  - DOES NOT OVER-BLOCK: adults-only sexual content and gore/violence return allowed.
 *  - OBFUSCATION-RESISTANT: the term lists run over `normalize.ts`-folded text, so homoglyph /
 *    leetspeak / zero-width / spaced-out disguises ("ch1ld", "c h i l d") are caught.
 *
 * Keep this file small, pure, and unit-tested. The term lists below are the surface to harden
 * over time; review any change with care. This is a safety control, not a legal guarantee —
 * the operator remains responsible for lawful use.
 *
 * ⚠ DO NOT MODIFY WITHOUT EXPLICIT OWNER INSTRUCTION. This module is the project's one hard
 * safety line. Future agents: do not weaken, remove, bypass, add disable switches/env vars to,
 * or "refactor" the enforcement semantics of this guardrail on your own initiative — including
 * the term lists, the fail-closed policy, the never-demote paths, or the judge layer. Any change
 * here requires the owner (Runkai Zhang) to have explicitly asked for that exact change.
 *
 * @author Runkai Zhang
 */
import type { LlmGateway } from "./gateway.ts";
import type { ChatMessage } from "./types.ts";
import { foldLeetspeak, foldLeetspeakAlt, normalizeForSafetyBase } from "./normalize.ts";
import { isMinor, type SafetyCharacter } from "../safety/minor.ts";

/** Result of a deterministic safety screen. */
export interface SafetyVerdict {
  /** False ⇒ a hard, deterministic block (no model can override an allow into this). */
  allowed: boolean;
  /** Generic reason for the audit log / OOC refusal. Never a graphic restatement. */
  reason?: string;
  /** A sexual-context signal was detected anywhere in the screened text. */
  sexual?: boolean;
  /** A minor signal was detected (text descriptor, sub-18 age, or a flagged ctx participant). */
  minor?: boolean;
  /**
   * The minor signal was UNAMBIGUOUS — a declared sub-18 participant, or a STRONG text descriptor
   * (child/toddler/schoolgirl/grade/"twelve-year-old"), as opposed to a WEAK one ("girl", "lad",
   * "young"). Only used to decide whether the judge is worth consulting when the deterministic
   * layer found no sexual signal; it never blocks on its own.
   */
  minorStrong?: boolean;
}

// The canonical minor predicate + its character shape live in the dependency-free safety leaf
// (src/safety/minor.ts) so gameplay gates can share them without importing the
// llm layer. Re-exported here so existing `from "../llm/safety.ts"` call sites are unchanged.
export { isMinor };
export type { SafetyCharacter };

/**
 * Is ANY present character a minor? With `targetIds`, restrict the check to those ids (so a
 * gate can ask about specific participants); without it, checks every present character.
 */
export function anyPresentMinor(ctx: SafetyContext | undefined, targetIds?: string[]): boolean {
  const chars = ctx?.characters ?? [];
  const pool = targetIds ? chars.filter((c) => c.id !== undefined && targetIds.includes(c.id)) : chars;
  return pool.some(isMinor);
}

/** Optional out-of-band context: who is present and how old they are. */
export interface SafetyContext {
  /** Present characters (PC + companions + NPCs/foes) with any declared ages. */
  characters?: SafetyCharacter[];
}

/**
 * A model judge: returns true to BLOCK, false to ALLOW; throws if unreachable. Used as a
 * second, semantic layer over the deterministic detector — it can only ADD a block. The optional
 * `ctx` lets the judge be told which present participants are CONFIRMED ADULTS, so it does not
 * fail-closed on adult prose that merely reads young/small ("a small, trembling woman"); it never
 * masks a minor — a declared minor is hard-blocked deterministically before the judge is consulted.
 */
export type SafetyJudge = (text: string, ctx?: SafetyContext) => Promise<boolean>;

/** Generic, non-graphic reasons (kept out of the player's face; surfaced only as audit). */
const REASON = "Blocked: sexual content involving a minor is never generated.";
const REASON_FAILCLOSED =
  "Blocked (fail-closed): possible minor-sexual content and the safety judge was unreachable.";

/**
 * The firm, deliberately generic out-of-character line the engine surfaces to the player when a
 * generation is blocked. Never a restatement of what was blocked.
 */
export const MINOR_SAFETY_REFUSAL =
  "That crosses the one hard line this engine won't cross (anything sexual involving minors). Nothing was generated.";

// ---------------------------------------------------------------------------
// Term lists — the deterministic detector's surface. Clinical and minimal on purpose.
// ---------------------------------------------------------------------------

/**
 * Proximity window (characters). A minor signal and a sexual signal within this many chars of
 * each other are a hard block. Wider co-occurrence (e.g. a child NPC described in distant world
 * lore, far from an adults-only request) is NOT a hard block — it raises suspicion for the judge
 * / fail-closed path, so benign mentions don't kill legitimate adult scenes. ~200 chars ≈ a
 * sentence or two: tight enough to mean "the same beat", loose enough to catch split phrasing.
 */
const PROXIMITY_CHARS = 200;

/** Escape a literal token for inclusion in a regex alternation. */
const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * STRONG minor signals — unambiguous child/adolescent descriptors (person forms). Co-occurring
 * (proximate) with a sexual signal ⇒ hard block. Word-boundaried; "eighteen"/"nineteen" do NOT
 * match `\bteen\b` (they are single tokens), so adults aren't caught by the substring.
 *
 * Deliberately NOT here (demoted to WEAK to avoid over-blocking, since they routinely describe
 * adults / non-minors): bare "minor"/"minors" (= small/lesser: a minor wound, minor noble) and
 * "juvenile" (= childish: juvenile humor). Place/institution forms ("high school", "preschool",
 * "kindergarten" as buildings) are excluded too — only the *person* forms ("high schooler",
 * "preschooler", "kindergartner") are unambiguous minors.
 */
const STRONG_MINOR_RAW = [
  "child", "children", "kid", "kids", "underage", "under-age", "underaged",
  "preteen", "pre-teen", "prepubescent", "pubescent", "toddler", "toddlers", "infant", "infants",
  "newborn", "schoolgirl", "schoolboy", "schoolchild", "schoolkid", "schoolkids",
  "adolescent", "adolescents", "teen", "teens", "teenage", "teenaged", "teenager", "teenagers",
  "little girl", "little boy", "little girls", "little boys",
  "young girl", "young boy", "young girls", "young boys", "young child", "small child",
  "middle schooler", "middle-schooler", "grade schooler", "grade-schooler", "elementary schooler",
  "high schooler", "high-schooler", "highschooler", "preschooler", "pre-schooler",
  "kindergartner", "kindergartener", "minor-aged", "minor-age",
  // Jargon that names a minor and nothing else — absent from ordinary prose, so no over-block risk.
  "loli", "lolicon", "shota", "shotacon", "jailbait", "tween",
];
const STRONG_MINOR = STRONG_MINOR_RAW.map(esc);

/**
 * The `(?:e?s)?` tail is load-bearing, not cosmetic. With a bare trailing `\b`, every plural that
 * was not hand-listed fell straight through — "He rapes the schoolgirl" hard-blocked while "He rapes
 * the schoolgirls" returned `{allowed:true, minor:false}`, because the plural also defeats the WEAK
 * backstop (`\bgirls\b` does not match inside "schoolgirls"). Pluralising a noun cannot turn a
 * child descriptor into a benign word, so the tail adds no false-positive surface — whereas
 * hand-maintaining a plural for each of ~50 terms is exactly the list that rotted.
 */
const STRONG_MINOR_RE = new RegExp(`\\b(?:${STRONG_MINOR.join("|")})(?:e?s)?\\b`, "i");

/**
 * Grade/year-of-school signals that imply a minor (person forms only: "sixth grader", "8th
 * grader", "third grade student"). Bare "third grade" (a reading level) is intentionally NOT
 * matched. Treated as a STRONG minor signal.
 */
const GRADE_RE =
  /\b(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)|(?:[1-9]|1[0-2])(?:st|nd|rd|th))[- ]grad(?:ers?|e\s+(?:students?|kids?|girls?|boys?|child|children))\b/gi;

/**
 * WEAK minor signals — ambiguous tokens ("girl"/"boy"/"young" routinely describe adults, e.g.
 * "good girl", "the stable boy", "young woman"; "minor" = lesser; "juvenile" = childish;
 * "freshman"/"sophomore" can be college adults). These DO NOT hard-block on their own — that
 * would over-block adult content and break the pillar. They raise suspicion only, so the model
 * judge (which is good at "is this a minor?") adjudicates, and declared ctx ages stay
 * authoritative. Deliberately omitted: "baby"/"babe" (overwhelmingly adult endearments).
 */
const WEAK_MINOR_RAW = [
  "girl", "girls", "boy", "boys", "youngster", "youngsters", "youth", "lad", "lass",
  "lads", "lasses", "minor", "minors", "juvenile", "juveniles", "freshman", "sophomore",
];
const WEAK_MINOR = WEAK_MINOR_RAW.map(esc);

// "young" is a weak minor signal EXCEPT when it qualifies an adult noun ("young woman/man/lord")
// — so dark adult content ("the young woman was assaulted") isn't over-blocked.
const YOUNG_RE =
  /\byoung\b(?!\s+(?:wom[ae]n|m[ae]n|lady|ladies|lord|lords|gentl\w+|wife|wives|husband\w*|widow\w*|knight\w*|soldier\w*|recruit\w*|mistress|master|adult\w*|couple\w*|lover\w*|stallion|mare|buck|stag|bull|oak|wine|vine))/gi;

// Same plural tail as STRONG_MINOR_RE, for the same reason — "youths" used to miss.
const WEAK_MINOR_RE = new RegExp(`\\b(?:${WEAK_MINOR.join("|")})(?:e?s)?\\b`, "i");

/**
 * MINOR-CODED sexual-ASSAULT verbs. These are minor-coded enough that co-occurrence with ANY minor
 * signal (including a WEAK one like "boy"/"girl"/"young") is a hard block, never demoted — closing
 * weak-signal abuse phrasings ("molests the boy", "incest with his young daughter") that generic
 * explicit-act terms leave to the judge. ("sodomi" avoids the place name "Sodom"; "young woman/man"
 * is excluded above.)
 *
 * Deliberately NOT here (moved out to stop over-blocking ADULTS — the pillar): "grope"/"fondle".
 * Unlike molest/rape/incest, groping and fondling are ORDINARY adult sexual acts; a consensual or
 * coerced ADULT scene ("he gropes her, the girl gasping") routinely puts them a few words from a
 * WEAK minor token ("girl"/"lass"/"young"), and the never-demote assault path hard-blocked every
 * such scene — a direct pillar violation ("DOES NOT OVER-BLOCK: adults-only sexual content"). They
 * remain full SEXUAL signals (grope* is in SEXUAL_WORDS, fondl in SEXUAL_STEMS), and {@link
 * SOFT_ASSAULT_RE} still hard-blocks them (never demoted, judge-independent) next to a STRONG minor
 * signal ("gropes the child / the twelve-year-old"); a declared-minor participant still blocks
 * distance-independently. ONLY the WEAK-signal proximity — the exact over-block — now falls through
 * to the declared-adult demotion + model judge.
 */
const ASSAULT_RE =
  /\b(?:molest\w*|rapes?|raped|raping|rapist|rapists|sodomy|sodomi\w*|incest\w*|deflower\w*)\b/gi;

/**
 * SOFT sexual-assault verbs — ordinary adult acts (grope/fondle) that ALSO name assault when the
 * object is a child. They must NOT hard-block on a WEAK minor token (that is the adult over-block
 * this whole split exists to fix), but they MUST still hard-block — never demoted, no judge needed —
 * next to a STRONG minor signal (an unambiguous child descriptor / grade / sub-18 age), so "gropes
 * the child" / "fondles the twelve-year-old" stays a deterministic block even with no judge wired.
 */
const SOFT_ASSAULT_RE = /\b(?:grop(?:e|ed|es|ing)|fondl\w*)\b/gi;

/**
 * Explicit sexual-context signals. A sexual signal ALONE never blocks (adults are allowed) — it
 * only matters in co-occurrence with a minor signal, or to trigger the judge. Built from:
 *  - STEMS: roots with NO benign English prefix, matched as `root\w*` so EVERY inflection is
 *    covered (the load-bearing fix: "molest" must also catch "molests"/"molester", "sexual" must
 *    catch "sexualizing", "penetrat" must catch "penetrated"/"penetration"). A missed inflection
 *    is a fail-open minor-safety bypass, because every block path AND the judge are gated on a
 *    sexual signal.
 *  - WORDS: genuinely-ambiguous tokens kept whole-word (BOTH boundaries) so "cock"≠"cockpit",
 *    "cum"≠"cumulative"/"cumin".
 *  - SPECIALS: "sex"/"aroused"/"erection" with a narrow negative lookahead, so the non-sexual
 *    senses ("sex of the child" = gender, "aroused suspicion", "erection of the tower") don't fire
 *    while the sexual senses still do.
 * Note: assault verbs (rape/molest/sodomy/incest/penetrate) hard-block when proximate to a minor
 * — fail-closed by design. That can over-block a rare gore scene where a minor merely WITNESSES
 * adult sexual violence; child-safety takes precedence and the operator can rephrase.
 */
const SEXUAL_STEMS = [
  "copulat", "fornicat", "masturbat", "ejaculat", "fondl", "molest", "sexual", "orgasm",
  "incest", "fellat", "cunnilingu", "deflower", "sodomi",
];
const SEXUAL_WORDS = [
  "intercourse", "coitus", "coital", "genital", "genitals", "genitalia",
  "blowjob", "blow job", "handjob", "hand job", "oral sex", "anal sex", "foreplay",
  "penis", "penises", "vagina", "vaginal", "vaginas", "vulva", "clitoris", "clitoral", "clit",
  "testicle", "testicles", "scrotum", "nipple", "nipples", "cock", "cocks", "pussy",
  "cum", "cumming", "cumshot", "cumshots", "cunt", "cunts", "semen", "sperm", "labia", "anus",
  "tits", "twat", "twats", "creampie", "creampies", "gangbang", "gangbangs", "dick", "dicks",
  "grope", "groped", "groping", "gropes",
  "rape", "raped", "raping", "rapes", "rapist", "rapists", "sodomy",
  "make love", "making love", "made love", "have sex", "having sex", "had sex",
  "sex act", "sex acts",
];
/** Abstract nouns that make "arouse" non-sexual, in either grammatical direction. */
const AROUSAL_OBJECTS =
  "suspicion|suspicions|curiosity|interest|anger|concern|alarm|pity|fear|doubt|envy|sympathy";

const SEXUAL_RE = new RegExp(
  [
    `\\b(?:${SEXUAL_STEMS.join("|")})\\w*`,
    `\\b(?:${SEXUAL_WORDS.map(esc).join("|")})\\b`,
    // bare "sex" (the act) — not "sex of <X>" (gender) / "sex appeal"
    `\\bsex\\b(?!\\s+(?:of\\b|appeal))`,
    // sexual "penetration" — but NOT piercing armor/flesh/defenses (combat), so a child combatant
    // isn't over-blocked while "penetrated the twelve-year-old" still is. The token class includes
    // possessives/hyphens so "the child's shield" / "twelve-year-old" parse as single tokens.
    `\\bpenetrat\\w*\\b(?!(?:\\s+[\\w'’-]+){0,3}\\s+(?:armou?r|shield|defen[cs]\\w*|mail|plate|gauntlet|breastplate|chainmail|guard|barrier|wall|line|veil|hide|skin|flesh|membrane|gloom|fog|mist|darkness))`,
    // anatomical "erection" — not "erection of the tower/monument"
    `\\berection\\b(?!\\s+of\\b)`,
    // "aroused"/"arousal" — the block comment above has claimed these were covered since this file
    // was written, but they were on NO list. "The twelve-year-old is aroused" returned
    // {sexual:false} ⇒ allowed AND the judge skipped. Excludes the non-sexual transitive senses.
    // The abstract-noun senses read in BOTH directions ("aroused suspicion" / "her suspicion was
    // aroused"), so the carve-out needs a lookbehind as well as a lookahead — a lookahead alone
    // blocked "Her suspicion was aroused by the child's silence."
    `(?<!\\b(?:${AROUSAL_OBJECTS})\\b(?:\\s+[\\w'’]+){0,2}\\s)\\barous\\w*\\b(?!(?:\\s+[\\w'’]+){0,2}\\s+(?:${AROUSAL_OBJECTS})\\b)(?!\\s+the\\s+(?:camp|household|guard|village|town|hall)\\b)`,
    // adjectival "erect" (the noun is handled above) — not "erect a tent / the scaffold".
    `\\berect\\b(?!\\s+(?:a|an|the|his|her|their|its|two|three|new)\\b)`,
    // THE load-bearing gap. The most common explicit sexual verb in English was in NEITHER
    // SEXUAL_STEMS nor SEXUAL_WORDS, so "He shoves her down and f‍ucks her; the twelve-year-old
    // sobs" screened {sexual:false} — and because applyJudge early-returns when `sexual` is false,
    // the model judge never ran either. One missing stem bypassed BOTH layers.
    //
    // The lookahead/lookbehind carve out the expletive frames ("fuck off/you/it/this/that/all",
    // "fuck up", "fuck with", "for fuck's sake", "what the fuck") so ordinary profanity is not a
    // sexual signal. The bare intensifier ("the fucking kid") is NOT excludable by frame and stays
    // a match: that is a deliberate fail-CLOSED residue, consistent with the "child-safety takes
    // precedence and the operator can rephrase" note above — and it only ever blocks when a STRONG
    // minor signal sits within PROXIMITY_CHARS, never on its own.
    `(?<!\\bthe\\s)\\bfuck(?:s|ed|ing|er|ers)?\\b(?!(?:['’]s\\s+sake)|\\s+(?:off|you|it|this|that|these|those|all|up|with|around|sake|no|yes|me\\s+sideways)\\b)`,
  ].join("|"),
  "i",
);

/** Sub-18 age stated in digits ("12 years old", "15-year-old", "aged 16", "age: 14"). */
const AGE_RE =
  /\b(\d{1,2})\s*[- ]?\s*(?:years?\s*[- ]?\s*olds?|y(?:rs?)?\.?\s*olds?|yo\b|y\/o)\b|\baged?\s*[:\s]\s*(\d{1,2})\b|\b(\d{1,2})\s*[- ]?\s*year[- ]olds?\b/gi;

/**
 * An explicit numeric age RANGE whose upper bound is an adult ("14 to 25", "aged 16-30",
 * "between 15 and 40"). When the upper bound is ≥18 and the lower is <18, the operative subject is
 * the adult band, so the lower bound is NOT, on its own, a standalone minor signal — this is the
 * "14 to 25 year old" false positive. The connector must sit IMMEDIATELY between the two numbers
 * (only whitespace) so two distinct ages ("the 14 year old and the 25 year old") are NOT merged
 * into a range. The lower bound is only actually suppressed when no sexual signal is proximate
 * (see analyze) — a range that reaches into minor ages NEXT TO sexual content stays fail-closed.
 */
const AGE_RANGE_RE =
  /\b(?:aged?\s*[:\s]?\s*|between\s+)?(\d{1,2})\s*(?:years?\s*(?:[- ]?old)?\s*)?(?:to|through|thru|and|or|[–—-]|\.\.+)\s*(\d{1,2})\b/gi;

/**
 * Sub-18 age written in words ("twelve-year-old", "a girl of fourteen"). Treated as a STRONG
 * sub-18 minor signal like the digit path. Two narrowed alternatives:
 *  - "<num>-year-old" but NOT when it ages an object ("twelve-year-old whisky/cheese/oak").
 *  - "<person> of <num>" only when the number reads as an age (clause-end / age cue), so fantasy
 *    epithets like "lass of seven sorrows" don't fabricate a minor signal.
 */
const NUMWORD = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen";
const NUMWORD_RE = new RegExp(
  // `olds?` — the plural ("the twelve-year-olds") used to fall through the trailing \b.
  `\\b(${NUMWORD})[\\s-]+years?[\\s-]?olds?\\b(?!\\s+(?:whisk\\w*|scotch|bourbon|brandy|rum|wine|ale|mead|port\\b|cheese|cheddar|oak|barrel|vintage))` +
    `|\\b(?:girl|boy|child|kid|son|daughter)\\s+of\\s+(${NUMWORD})\\b`,
  "gi",
);

/**
 * The raw term lists, exposed READ-ONLY for the coverage regression gate.
 *
 * This is not an enforcement surface — nothing reads it at runtime. It exists because the previous
 * regression sweep hand-wrote its probe sentences, so it only ever tested the terms someone
 * remembered to write a sentence for: it reported all-green while four verified fail-opens were
 * live, including the single most common English sexual verb. A gate over hand-picked examples
 * cannot detect a MISSING list entry. `tests/safety.test.ts` iterates these lists and asserts every
 * entry blocks in both singular and plural, so a dropped inflection fails CI instead of shipping.
 */
export const SAFETY_TERMS = Object.freeze({
  strongMinor: Object.freeze([...STRONG_MINOR_RAW]),
  weakMinor: Object.freeze([...WEAK_MINOR_RAW]),
  sexualStems: Object.freeze([...SEXUAL_STEMS]),
  sexualWords: Object.freeze([...SEXUAL_WORDS]),
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Char offsets of every match of `re` across `text` (the regex may be global or not). */
function offsetsOf(text: string, source: RegExp): number[] {
  const re = new RegExp(source.source, source.flags.includes("g") ? source.flags : `${source.flags}g`);
  const out: number[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width loops
  }
  return out;
}

/** Char offsets of every stated sub-18 digit age (AGE_RE, group 1/2/3). */
function digitAgeOffsets(text: string): number[] {
  const out: number[] = [];
  AGE_RE.lastIndex = 0;
  for (let m = AGE_RE.exec(text); m; m = AGE_RE.exec(text)) {
    const n = Number(m[1] ?? m[2] ?? m[3]);
    if (Number.isFinite(n) && n < 18) out.push(m.index);
    if (m.index === AGE_RE.lastIndex) AGE_RE.lastIndex++;
  }
  return out;
}

/** Char spans [start,end) of adult-majority numeric ranges whose sub-18 lower bound may be benign. */
function adultRangeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  AGE_RANGE_RE.lastIndex = 0;
  for (let m = AGE_RANGE_RE.exec(text); m; m = AGE_RANGE_RE.exec(text)) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo < 18 && hi >= 18) {
      spans.push([m.index, m.index + m[0].length]);
    }
    if (m.index === AGE_RANGE_RE.lastIndex) AGE_RANGE_RE.lastIndex++;
  }
  return spans;
}

const inSpans = (at: number, spans: Array<[number, number]>): boolean =>
  spans.some(([s, e]) => at >= s && at < e);

/** Are any minor-offset and sexual-offset within PROXIMITY_CHARS of each other? */
function proximate(minorAt: number[], sexAt: number[]): boolean {
  for (const a of minorAt) {
    for (const b of sexAt) {
      if (Math.abs(a - b) <= PROXIMITY_CHARS) return true;
    }
  }
  return false;
}

/** A participant with an explicit, affirmative adult declaration (flag OR a real age ≥ 18). */
function declaredAdult(c: SafetyCharacter): boolean {
  return c.ageIsAdult === true || (typeof c.age === "number" && c.age >= 18);
}

/**
 * True only when EVERY present character has an explicit, affirmative adult declaration — silence
 * (no `ctx`, no characters, or any one undeclared participant) does NOT count. This is deliberately
 * a narrower bar than "not a minor": `isMinor` treats unknown age as not-minor so ordinary play
 * isn't over-blocked, but the STRONG-term judge-demotion below needs authors to have actually
 * opted a character in, not merely to have left age unset.
 */
function allPresentDeclaredAdult(ctx?: SafetyContext): boolean {
  const chars = ctx?.characters ?? [];
  return chars.length > 0 && chars.every(declaredAdult);
}

/**
 * The deterministic core. Examines `text` (plus any known participant ages) and returns a
 * verdict. Hard block (allowed:false) when:
 *   - a declared-minor participant is present AND the text is sexual (the minor is established
 *     by context, so distance in the prose is irrelevant — fail closed), OR
 *   - a STRONG minor descriptor / grade signal / sub-18 age sits in PROXIMITY to a sexual signal —
 *     UNLESS `allowAdultDemotion` is set and every present character is an explicitly declared
 *     adult, in which case that one condition demotes to `allowed:true` (still `sexual`+`minor`
 *     flagged) so the caller's judge layer adjudicates the actual text instead of an instant block.
 *     A STRONG-text hit doesn't know which entity a matched word grammatically refers to, so this
 *     is deliberately NOT a bypass: the declared-minor path (1) and the assault-verb path (2) are
 *     never affected by it, and the judge's own instruction is "ambiguous age ⇒ BLOCK".
 * Otherwise allowed, but `sexual`/`minor` are reported so the caller can run the judge layer.
 *
 * Term lists run over the obfuscation-folded views from `normalize.ts`: `base` (digits preserved,
 * for the age regexes) and `letters` (leetspeak folded, for the word regexes). Both views are the
 * same length, so offsets are mutually consistent and the proximity logic is sound. Word regexes
 * run over BOTH views and union their offsets, so a leet fold that happens to break a word
 * boundary (e.g. "sex!" → "sexi") can never hide a match the base view would have caught.
 */
function analyze(text: string, ctx?: SafetyContext, opts?: { allowAdultDemotion?: boolean }): SafetyVerdict {
  const base = normalizeForSafetyBase(text); // digits intact (age regexes)
  const letters = foldLeetspeak(base); // leet → letters, same length (word regexes)
  // The ambiguous leet glyphs read a second way: "1"/"|" are "l" as often as "i". With only the
  // primary view, "g1rl" resolved but "chi1d" folded to "chiid" and missed every term list — a
  // verified bypass. Both folds are 1:1 with `base`, so all three views share offsets and the
  // proximity math below is unaffected.
  const lettersAlt = foldLeetspeakAlt(base);
  const views = [base, letters, lettersAlt];

  // Word regexes over ALL folded views (union): catches plain + both leet-disguised readings.
  const onAll = (re: RegExp): number[] => views.flatMap((v) => offsetsOf(v, re));

  const sexual = views.some((v) => SEXUAL_RE.test(v));
  const ctxMinor = (ctx?.characters ?? []).some(isMinor);

  const sexAt = onAll(SEXUAL_RE);
  const assaultAt = onAll(ASSAULT_RE);
  const softAssaultAt = onAll(SOFT_ASSAULT_RE);

  // Digit ages, with the adult-range lower bound suppressed UNLESS a sexual/assault signal is
  // proximate (then keep it — a range reaching into minor ages next to sex stays fail-closed).
  const rangeSpans = adultRangeSpans(base);
  const sexishAt = [...sexAt, ...assaultAt];
  const ageHits = digitAgeOffsets(base).filter(
    (at) => !(inSpans(at, rangeSpans) && !sexishAt.some((x) => Math.abs(x - at) <= PROXIMITY_CHARS)),
  );

  const strongAt = [...onAll(STRONG_MINOR_RE), ...onAll(GRADE_RE), ...onAll(NUMWORD_RE), ...ageHits];
  const weakAt = [...onAll(WEAK_MINOR_RE), ...onAll(YOUNG_RE)];
  const strong = strongAt.length > 0;
  const weak = weakAt.length > 0;
  const minor = ctxMinor || strong || weak;

  // 1) Any sexual signal + a declared-minor participant (distance-independent — fail closed).
  //    Never demoted — a declared minor is established by structured data, not a text guess.
  if (sexual && ctxMinor) {
    return { allowed: false, reason: REASON, sexual: true, minor: true };
  }
  // 2) A sexual-assault verb (minor-coded) proximate to ANY minor signal — including WEAK ones,
  //    which the generic sexual path deliberately leaves to the judge. Never demoted — the matched
  //    word may not even refer to a present (declared-adult) participant.
  if (assaultAt.length > 0 && proximate([...strongAt, ...weakAt], assaultAt)) {
    return { allowed: false, reason: REASON, sexual: true, minor: true };
  }
  // 2b) A SOFT-assault verb (grope/fondle — an ordinary adult act) proximate to a STRONG minor
  //    signal ONLY. Never demoted, judge-independent, so "gropes the child / the twelve-year-old"
  //    stays a hard block. A WEAK signal ("girl"/"lass"/"young") near grope/fondle is deliberately
  //    NOT blocked here — that was the adult over-block; it falls to the demotion + judge below.
  if (softAssaultAt.length > 0 && proximate(strongAt, softAssaultAt)) {
    return { allowed: false, reason: REASON, sexual: true, minor: true };
  }
  // 3) An explicit sexual signal proximate to a STRONG minor signal (descriptor / grade / age).
  if (sexual && strong && proximate(strongAt, sexAt)) {
    if (opts?.allowAdultDemotion && allPresentDeclaredAdult(ctx)) {
      return { allowed: true, sexual: true, minor: true }; // → judge adjudicates the real text
    }
    return { allowed: false, reason: REASON, sexual: true, minor: true };
  }
  return { allowed: true, sexual, minor, minorStrong: ctxMinor || strong };
}

/**
 * Screen the INPUT (player intent + assembled context) before any model is called. Never demotes
 * the STRONG-term path: a request that reads as minor-sexual is refused before spending a
 * generation on it, and this path has no judge fallback downstream (unlike the output screen).
 */
export function screenInput(messages: ChatMessage[], ctx?: SafetyContext): SafetyVerdict {
  return analyze(messages.map((m) => m.content).join("\n\n"), ctx);
}

/**
 * Screen generated OUTPUT (works the same regardless of which model produced it). Allows the
 * STRONG-term judge-demotion (see `analyze`) — `GuardedGateway.finish()` always runs the result
 * through `applyJudge` afterward, so a demoted verdict here still gets adjudicated, never a bare
 * pass-through.
 */
export function screenOutput(text: string, ctx?: SafetyContext): SafetyVerdict {
  return analyze(text, ctx, { allowAdultDemotion: true });
}

// ---------------------------------------------------------------------------
// Judge layer (optional, additive) — fail-closed orchestration
// ---------------------------------------------------------------------------

/**
 * Combine a deterministic verdict with an optional model judge. The judge only ever ADDS a
 * block; it can never turn a hard deterministic block back into an allow.
 *
 * Policy:
 *  - hard block already? → stays blocked.
 *  - neither a sexual signal NOR an unambiguous minor → nothing to adjudicate; the allow stands.
 *  - sexual signal + judge present → ask the judge: BLOCK ⇒ block; ALLOW ⇒ allow.
 *      judge unreachable (throws): fail closed (block) IFF a minor signal co-occurred;
 *      otherwise (sexual-only) allow, so a judge outage can't nuke all adult content.
 *  - NO sexual signal but an unambiguous minor (declared sub-18 participant or a STRONG descriptor)
 *    → still ask the judge. This is defense in depth, added because the term lists were shown to be
 *    holed: a missing stem made `sexual` false, and the old `if (!verdict.sexual) return` meant the
 *    judge — the layer that exists to catch what the lists miss — was skipped on exactly the text it
 *    was needed for. One list gap silently disabled both layers at once. A judge OUTAGE on this path
 *    does NOT fail closed: nothing sexual was detected, so blocking every mention of a child
 *    whenever the utility endpoint is down would break ordinary play for no safety gain.
 *    Gated on `minorStrong`, not `minor`, so the weak tokens ("girl", "lad", "young") — which appear
 *    constantly in adult prose — do not spend a judge call on every turn.
 *  - sexual signal + no judge configured → the deterministic verdict stands (proximity/ctx
 *    already caught the clear minor cases; bare co-occurrence is left to the deterministic layer).
 */
export async function applyJudge(
  verdict: SafetyVerdict,
  text: string,
  judge: SafetyJudge | null,
  ctx?: SafetyContext,
): Promise<SafetyVerdict> {
  if (!verdict.allowed) return verdict;
  const backstop = !verdict.sexual && verdict.minorStrong === true;
  if (!verdict.sexual && !backstop) return verdict;
  if (!judge) return verdict;
  try {
    const block = await judge(text, ctx);
    if (!block) return verdict;
    return { allowed: false, reason: REASON, sexual: verdict.sexual, minor: true };
  } catch {
    // Fail closed only where a sexual signal was actually detected; see the policy note above.
    if (!backstop && verdict.minor) {
      return { allowed: false, reason: REASON_FAILCLOSED, sexual: true, minor: true };
    }
    return verdict;
  }
}

/** The strict classifier prompt the model judge runs. Narrow, single-purpose, deterministic. */
const JUDGE_SYSTEM =
  "You are a strict content-safety classifier with ONE job: decide whether the text depicts, " +
  "sexualizes, or sexually involves a minor (anyone under 18 years old, or described/implied as " +
  "a child or adolescent). Sexual content between adults, and non-sexual content involving " +
  "minors, are both ALLOW. Only minor + sexual is BLOCK. When a sexual scene's participant ages " +
  "are ambiguous or unstated, answer BLOCK. If the message begins with a 'CONFIRMED ADULTS' note, " +
  "treat every character named there as an adult (18+) even when the prose calls them 'small', " +
  "'young', 'girl', or 'boy' — those are not, for a named confirmed adult, a minor signal. Still " +
  "BLOCK if the text sexualizes a DIFFERENT character who is not on that list and reads as a minor. " +
  "Reply with exactly one word: BLOCK or ALLOW.";

/**
 * The judge preamble that names the CONFIRMED-ADULT participants so the classifier does not
 * fail-closed on adult prose that merely reads young/small. Lists ONLY genuinely declared adults
 * (`declaredAdult`); a declared minor is never listed (and is already hard-blocked before the judge
 * runs), and when any present character is undeclared the note says so, keeping the ambiguous⇒BLOCK
 * rule live for them. Empty string when nothing is declared — the historic text-only judge behavior.
 */
export function judgeAdultPreamble(ctx?: SafetyContext): string {
  const chars = ctx?.characters ?? [];
  const adults = chars.filter(declaredAdult).map((c) => c.name?.trim()).filter((n): n is string => !!n);
  if (adults.length === 0) return "";
  const someUndeclared = chars.some((c) => !declaredAdult(c));
  const undeclaredNote = someUndeclared
    ? " Any character NOT named here has an unstated age — apply the ambiguous⇒BLOCK rule to them."
    : "";
  return `CONFIRMED ADULTS (18+), treat as adults regardless of how the prose describes them: ${adults.join(", ")}.${undeclaredNote}\n\n`;
}

/** Per-call ceiling on the judge so it can never hang a turn; a timeout fails closed. */
export const JUDGE_TIMEOUT_MS = 8000;

/**
 * Token budget for the judge completion. Generous ON PURPOSE: the production models are REASONING
 * models that spend hundreds of tokens thinking before they emit the verdict word. A tiny budget
 * (the old 16) returns an EMPTY completion — the model is still mid-reasoning — which parses as an
 * unparseable verdict → a spurious fail-closed BLOCK on every sexual+minor co-occurrence (a benign
 * "lad"/"young" NPC in a scene with any sexual signal was enough). 1024 lets the verdict survive
 * (matches the narrator budget, same rationale); the timeout still bounds latency, and a genuinely
 * empty/starved answer still fails closed.
 */
export const JUDGE_MAX_TOKENS = 1024;

/** Reject `p` after `ms` so a stalled judge surfaces as "unreachable" (→ fail closed). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("safety judge timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Build a SafetyJudge backed by a gateway's UTILITY role (the cheap, non-narrator model — a judge
 * should be selected for reliable policy classification). The call
 * is cheap (a single token) and only fires when a sexual signal is present. Throws on transport
 * error OR timeout so `applyJudge` can fail closed.
 */
export function makeGatewayJudge(gateway: LlmGateway, timeoutMs: number = JUDGE_TIMEOUT_MS): SafetyJudge {
  return async (text: string, ctx?: SafetyContext): Promise<boolean> => {
    const res = await withTimeout(
      gateway.complete("utility", {
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: `${judgeAdultPreamble(ctx)}${text}` },
        ],
        temperature: 0,
        maxTokens: JUDGE_MAX_TOKENS,
      }),
      timeoutMs,
    );
    // Default-safe parse: only an explicit ALLOW (with no BLOCK) is treated as allow.
    const verdict = res.text.toUpperCase();
    if (verdict.includes("BLOCK")) return true;
    if (verdict.includes("ALLOW")) return false;
    // Unparseable judge output is treated as a non-answer → throw so the caller fails closed
    // exactly as it would for an unreachable judge (only matters once a sexual signal is present).
    throw new Error("safety judge returned an unparseable verdict");
  };
}
