/**
 * Whole-word matching over free text — the shared primitive for reading AUTHORED prose (an NPC's
 * `preferences`/`boundaries`, a world item's name) and PLAYER free text (a PC's appearance tags)
 * against code-owned keyword lists. PURE: no RNG, no IO, no state.
 *
 * WHY THIS EXISTS: `String.includes` over free text INVERTS meaning. Executed against authored
 * regression content, the old substring guards scored
 *   - a target tagged "old" as violating `boundaries: ["goes quiet and cold around casual cruelty"]`
 *     — "cold" contains "old";
 *   - the social trait "warmonger" as trust +5 ("warm") and "grisly" as trust −4 ("sly");
 *   - a PC who described themselves as "unattractive" as more appealing to an observer
 *     ("unattractive" contains "attractive"), i.e. the exact inverse of the intent.
 * A PC's appearance/presentation tags are author-provided free text, so
 * this matcher is written against ADVERSARIAL input: a tag of "the" or "not" must never match every
 * authored sentence in the world, and a tag that NEGATES a keyword must not score as that keyword.
 *
 * Three rules, all of them deliberately conservative — a miss is always safer than a wrong hit:
 *  1. WHOLE WORDS. A needle matches a contiguous run of whole word tokens, never a fragment inside
 *     one. Stems still work (`"intimidat"` hits "intimidating") but only through a CLOSED list of
 *     inflectional endings, so "warm" stops hitting "warmonger".
 *  2. NEGATION. A hit whose first token is preceded by a negator ("not naive", "never bares skin",
 *     "far from striking") is not a hit.
 *  3. DISTINCTIVENESS. A run made only of function words is not evidence of anything — the
 *     `matchExitInProse` idiom (`src/world/exit-match.ts`), where a generic token may never bind a
 *     destination on its own.
 *
 * @author Runkai Zhang
 */

/** `n't` is folded to a separate `not` token BEFORE tokenizing, so "won't" negates like "will not". */
const CONTRACTED_NOT = /n['’]t\b/g;

/** Lowercase word tokens (letters/digits); punctuation, hyphens and apostrophes are separators. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(CONTRACTED_NOT, " not").match(/[a-z0-9]+/g) ?? [];
}

/**
 * The CLOSED set of inflectional endings a keyword stem may carry. Closed on purpose: an open
 * "starts with" rule is just a substring match wearing a hat, and it is what let "warm" score
 * "warmonger". A word not spelled by stem+ending simply does not match — if a real inflection is
 * missing, the fix is to add the word to the (code-owned) keyword list, not to loosen this.
 */
const INFLECTIONS: ReadonlySet<string> = new Set([
  "",
  "s",
  "es",
  "e",
  "d",
  "ed",
  "er",
  "ers",
  "est",
  "ing",
  "ion",
  "ions",
  "ic",
  "ical",
  "al",
  "ly",
  "ness",
  "th",
  "y",
]);

/**
 * Stems shorter than this must match EXACTLY. A 2–3 letter stem plus a one-letter inflection lands
 * on unrelated words ("no" + "d" = "nod", "go" + "es" = "goes"), which is the same class of bug the
 * whole-word rule exists to kill.
 */
const MIN_STEM_FOR_INFLECTION = 4;

/** Whether one word token IS the keyword, or the keyword plus one closed-list inflection. */
export function stemMatches(word: string, stem: string): boolean {
  if (word === stem) return true;
  if (stem.length < MIN_STEM_FOR_INFLECTION) return false;
  if (!word.startsWith(stem)) return false;
  return INFLECTIONS.has(word.slice(stem.length));
}

/** Whether `needle` matches the run of tokens starting at `start` (each token stem-matched). */
export function runMatchesAt(words: readonly string[], start: number, needle: readonly string[]): boolean {
  if (needle.length === 0 || start + needle.length > words.length) return false;
  for (let k = 0; k < needle.length; k++) {
    if (!stemMatches(words[start + k]!, needle[k]!)) return false;
  }
  return true;
}

/** Index of the first token of the earliest whole-word run of `needle` in `words`, else −1. */
export function phraseIndexIn(words: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return -1;
  for (let i = 0; i + needle.length <= words.length; i++) {
    if (runMatchesAt(words, i, needle)) return i;
  }
  return -1;
}

/** Words that flip the sense of what follows them. */
const NEGATORS: ReadonlySet<string> = new Set([
  "not",
  "never",
  "no",
  "nor",
  "none",
  "nothing",
  "without",
  "hardly",
  "barely",
  "scarcely",
  "rarely",
  "seldom",
  "anything",
  "far",
  "un",
  "less",
]);

/** Words a negator may reach ACROSS ("not at all naive", "anything but meek", "far from striking"). */
const NEGATION_FILLERS: ReadonlySet<string> = new Set([
  "at",
  "all",
  "but",
  "from",
  "very",
  "really",
  "that",
  "too",
  "so",
  "particularly",
  "especially",
  "the",
  "a",
  "an",
  "much",
  "is",
  "was",
  "been",
  "looks",
  "look",
  "seems",
  "seem",
  "reads",
]);

/** How far back a negator may reach across fillers before we stop looking. */
const NEGATION_LOOKBACK = 3;

/** Whether the token at `index` is negated by a preceding negator (fillers may sit between). */
export function isNegatedAt(words: readonly string[], index: number): boolean {
  for (let i = index - 1, hops = 0; i >= 0 && hops < NEGATION_LOOKBACK; i--, hops++) {
    const w = words[i]!;
    if (NEGATORS.has(w)) return true;
    if (!NEGATION_FILLERS.has(w)) return false;
  }
  return false;
}

/** Shorter than this and a token identifies nothing on its own, however unusual it looks. */
const MIN_DISTINCTIVE_LEN = 3;

/**
 * Function words that carry no identity. A tag made only of these ("not", "the", "will not") is
 * player noise that would otherwise match nearly every authored sentence in the world.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by", "for", "with",
  "from", "into", "onto", "over", "under", "as", "is", "are", "was", "were", "be", "been", "being",
  "am", "do", "does", "did", "done", "have", "has", "had", "will", "would", "shall", "should",
  "can", "could", "may", "might", "must", "not", "no", "nor", "never", "it", "its", "he", "she",
  "they", "them", "him", "her", "his", "hers", "their", "theirs", "you", "your", "yours", "i",
  "me", "my", "mine", "we", "us", "our", "ours", "who", "whom", "whose", "which", "that", "this",
  "these", "those", "what", "when", "where", "why", "how", "any", "all", "some", "one", "two",
  "too", "very", "more", "most", "than", "then", "so", "such", "own", "same", "just", "also",
  "about", "after", "before", "up", "down", "out", "off", "again", "ever", "every", "anyone",
  "anything", "someone", "something", "else", "other", "others", "per", "via", "upon", "unto",
  "while", "whatever", "whoever", "however", "without", "within", "there", "here", "yet", "still",
]);

/** Whether a single token is specific enough to carry a match on its own. */
export function isDistinctive(word: string): boolean {
  return word.length >= MIN_DISTINCTIVE_LEN && !STOPWORDS.has(word);
}

/** Whether a matched RUN carries at least one token that identifies something. */
export function runIsDistinctive(words: readonly string[], start: number, length: number): boolean {
  for (let i = start; i < start + length && i < words.length; i++) {
    if (isDistinctive(words[i]!)) return true;
  }
  return false;
}
