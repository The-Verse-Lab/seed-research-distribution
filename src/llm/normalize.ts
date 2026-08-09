/**
 * Safety normalization — the obfuscation-closing layer in front of the minor-safety detector.
 *
 * The deterministic detector in `safety.ts` matches term lists against text. A naive matcher is
 * trivially bypassed by writing the very words it looks for in disguised forms: homoglyphs (a
 * Cyrillic "с" for "c"), leetspeak ("ch1ld", "t33n"), zero-width splits, accents ("chïld"), or
 * letters spaced apart ("c h i l d", "c.h.i.l.d", "ch_ild"). Every such bypass is a FAIL-OPEN
 * minor-safety hole, so this module folds those disguises back to plain ASCII *before* the
 * regexes run.
 *
 * Two views matter to the caller (see `safety.ts.analyze`):
 *  - `normalizeForSafetyBase(text)` — the de-obfuscated text with DIGITS PRESERVED. Age regexes
 *    ("12 years old", "8th grader") need the digits, so they run against this.
 *  - `foldLeetspeak(base)` — a strictly 1:1 (position-preserving) fold of leet digits/symbols to
 *    letters, so "ch1ld" → "child". Letter term lists run against this. Because the fold is 1:1,
 *    a match offset in the folded view lines up with the same offset in the base view, so the
 *    proximity logic can mix age offsets (base) with term offsets (folded) safely.
 *  - `normalizeForSafety(text)` = `foldLeetspeak(normalizeForSafetyBase(text))` — the full
 *    one-shot pipeline, exported for direct testing and reuse.
 *
 * Design rule: closing a bypass must NEVER manufacture a match in benign text. The collapse of
 * spaced-out letters only fires on runs of THREE-OR-MORE single characters (so "I am a kid" and
 * "U.S." are untouched), leetspeak digits are folded only into the letter view (never the age
 * view, so real ages survive), and word-internal hyphens are preserved (so "twelve-year-old"
 * still parses). The tests assert both directions: bypasses caught, benign text unchanged.
 *
 * @author Runkai Zhang
 */

/**
 * Confusable letters NFKC does NOT fold — chiefly Cyrillic and Greek lookalikes that render
 * identically to a Latin letter. NFKC already handles fullwidth / styled / circled forms, so this
 * table is intentionally just the cross-script homoglyphs. Mapped to lowercase ASCII; the term
 * regexes are case-insensitive, so case is irrelevant downstream.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic (lower + upper) → Latin
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y",
  "х": "x", "к": "k", "м": "m", "т": "t", "н": "h", "в": "b",
  "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ո": "n",
  "А": "a", "Е": "e", "О": "o", "Р": "p", "С": "c", "У": "y",
  "Х": "x", "К": "k", "М": "m", "Т": "t", "Н": "h", "В": "b",
  "І": "i", "Ј": "j", "Ѕ": "s",
  // Greek (lower + upper) → Latin
  "α": "a", "ο": "o", "ρ": "p", "ε": "e", "ι": "i", "ν": "v",
  "κ": "k", "τ": "t", "υ": "u", "χ": "x",
  "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i",
  "Κ": "k", "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t",
  "Υ": "y", "Χ": "x",
};

const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");

/**
 * Leetspeak / symbol substitutions. STRICTLY single-char → single-char, so applying this is
 * position-preserving (offsets are identical between the base and folded views). Digits are folded
 * ONLY here (the letter view), never in the base view — so genuine ages keep their digits.
 */
const LEET: Record<string, string> = {
  "0": "o", "1": "i", "2": "z", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t", "8": "b", "9": "g",
  "@": "a", $: "s", "!": "i", "|": "i", "+": "t", "(": "c",
};

/**
 * The SECOND value each ambiguous glyph stands for. A single-valued fold is a fail-open bypass:
 * "1" and "|" are the two most common leet substitutions for BOTH "i" and "l", so folding them only
 * to "i" turns "chi1d" into "chiid" and the term lists miss it. Every entry here is 1:1 like
 * {@link LEET}, so the alternate view is also position-preserving and its offsets stay aligned with
 * the base view — the proximity math in safety.ts unions offsets across views and needs that.
 * Glyphs with only one plausible reading are absent; safety.ts folds this view IN ADDITION to
 * {@link LEET}, never instead of it, so nothing the primary fold caught can be lost.
 */
const LEET_ALT: Record<string, string> = {
  "1": "l", "|": "l", "!": "l", "0": "d", "5": "z", "6": "b", "9": "q", "(": "g",
};

const LEET_RE = /[0-9@$!|+(]/g;

/**
 * Zero-width and invisible separators an attacker can splice inside a word to dodge a match: soft
 * hyphen (U+00AD), the zero-width space / (non-)joiner family (U+200B–U+200D), the word-joiner /
 * invisible-operator block (U+2060–U+2064), and the BOM / zero-width no-break space (U+FEFF).
 *
 * The BIDI format controls are here for the same reason and were the gap: the marks (U+200E–200F),
 * the embedding/override family (U+202A–U+202E) and the isolates (U+2066–U+2069) all render as
 * nothing, survive a copy-paste, and split a word for any regex just as effectively as a zero-width
 * space — "chi‮ld" is invisible to a reader and invisible to `\bchild\b`.
 */
const INVISIBLE_RE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Combining marks left after NFD decomposition (accents/diacritics): "chïld" → "child". */
const COMBINING_RE = /\p{M}/gu;

/**
 * Underscores spliced INSIDE a word ("ch_ild"). Underscores effectively never occur inside real
 * prose words, so removing those that sit between two alphanumerics is safe and closes the
 * single-separator bypass without touching word spacing.
 */
const INWORD_UNDERSCORE_RE = /(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu;

/**
 * A run of single characters spaced apart by separators — "c h i l d", "c.h.i.l.d", "c-h-i-l-d".
 * Requires THREE-OR-MORE single chars (a leading single char + at least two more, each its own
 * single char) so benign two-letter abbreviations ("a.m.", "e.g.") and ordinary word spacing are
 * left alone. Hyphen is included as a separator here (every-letter spacing is obfuscation), but
 * word-internal hyphens are otherwise preserved because a real word's letters aren't single.
 *
 * The separator RUN is `{1,4}`, not a single character: a one-char class let "c  h  i  l  d" (any
 * doubled separator) walk straight through the whole fold. The run is consumed atomically via the
 * `(?=(group))\k<group>` idiom — JS has no possessive quantifiers, and a bare `{1,4}` inside a
 * `{2,}` group is a nested quantifier that backtracks exponentially on an adversarial near-miss
 * ("a  a  a  …!!!"). Capturing the run in a lookahead and re-consuming it by backreference pins one
 * partition per iteration, so matching stays linear (measured flat to 200 iterations).
 */
const SPREAD_RE =
  /(?<![\p{L}\p{N}])[\p{L}\p{N}](?:(?=(?<sep>[\s.\-']{1,4}))\k<sep>[\p{L}\p{N}](?![\p{L}\p{N}])){2,}/gu;

/** Single-letter words ("a", "I", "O") that can sit next to a spaced-out word in normal prose. */
const ARTICLE_RE = /[aioAIO]/;

/**
 * Collapse one matched spread run ("c h i l d" → "child"), but PEEL a single leading/trailing
 * standalone article letter first so "a c h i l d" → "a child" (keeps the word boundary) instead
 * of "achild" (which would hide the word). Only peels when ≥4 chars remain to peel from and ≥3
 * remain after, so short genuine words ("k i d") are never mangled; if peeling would leave <3
 * letters the run is returned unchanged (no collapse, no false match).
 */
function collapseSpread(run: string): string {
  const chars = run.match(/[\p{L}\p{N}]/gu) ?? [];
  let lead = "";
  let tail = "";
  if (chars.length >= 4 && ARTICLE_RE.test(chars[0]!)) lead = `${chars.shift()!} `;
  if (chars.length >= 4 && ARTICLE_RE.test(chars[chars.length - 1]!)) tail = ` ${chars.pop()!}`;
  if (chars.length < 3) return run;
  return `${lead}${chars.join("")}${tail}`;
}

/**
 * The de-obfuscation pipeline WITHOUT leetspeak folding — digits are preserved so age regexes
 * still see "12 years old". Order matters: compose compatibility forms, drop invisibles, strip
 * accents, fold homoglyphs, then close the two letter-spacing bypasses.
 */
export function normalizeForSafetyBase(text: string): string {
  let s = text.normalize("NFKC");
  s = s.replace(INVISIBLE_RE, "");
  s = s.normalize("NFD").replace(COMBINING_RE, "").normalize("NFC");
  s = s.replace(CONFUSABLE_RE, (ch) => CONFUSABLES[ch] ?? ch);
  s = s.replace(INWORD_UNDERSCORE_RE, "");
  s = s.replace(SPREAD_RE, collapseSpread);
  return s;
}

/**
 * Fold leetspeak digits/symbols to ASCII letters. Strictly 1:1 (position-preserving): every
 * replaced code unit maps to exactly one letter, so a string and its fold have identical length
 * and aligned offsets. Run this over the base view to get the letter view for term matching.
 */
export function foldLeetspeak(text: string): string {
  return text.replace(LEET_RE, (ch) => LEET[ch] ?? ch);
}

/**
 * The ALTERNATE letter view: same 1:1 discipline as {@link foldLeetspeak}, but every glyph that
 * stands for two different letters takes its second reading ("1"/"|"/"!" → "l", "0" → "d", …).
 * Glyphs with a single reading fall through to {@link LEET} so this view is a superset, not a
 * substitute. Callers must screen BOTH letter views: "chi1d" only resolves to "child" here, while
 * "g1rl" only resolves in the primary view — neither view alone closes the leetspeak bypass.
 */
export function foldLeetspeakAlt(text: string): string {
  return text.replace(LEET_RE, (ch) => LEET_ALT[ch] ?? LEET[ch] ?? ch);
}

/** Full pipeline: de-obfuscate AND fold leetspeak. The headline normalizer. */
export function normalizeForSafety(text: string): string {
  return foldLeetspeak(normalizeForSafetyBase(text));
}
