/**
 * Fuzzy exit matching — ground a movement's destination against the real exits.
 *
 * The classifier grounds a move's destination by EXACT id membership; a wrong LLM guess (or a
 * player naming a place by its prose name / a direction) degrades to an honest miss. This helper
 * adds a conservative fuzzy step BEFORE the miss is recorded: it tries an exact id, then a
 * normalized name/direction equality, then a unique token-overlap match. It NEVER guesses — an
 * ambiguous tie returns null so the engine can narrate the honest "no route" refusal (listing the
 * real exits) rather than sending the player somewhere the map can't back.
 *
 * Out of scope: materializing prose-only place names (e.g. "Tanner's Bridge") into real exits —
 * those still fall through to null and the honest miss.
 *
 * @author Runkai Zhang
 */

/** The minimal exit shape this matcher reads (a superset-compatible ClassifierEntityRef). */
export interface ExitCandidate {
  /** The destination location id. */
  id: string;
  /** The display name — MAY carry a trailing runtime state tag ("(locked)", "(broken open)", …). */
  name: string;
  /** Optional compass/relative direction ("north", "down") when the exit is authored with one. */
  direction?: string;
}

/** Whole-token direction words we treat as directional handles for a move. */
const DIRECTION_WORDS = new Set([
  "north",
  "south",
  "east",
  "west",
  "northeast",
  "northwest",
  "southeast",
  "southwest",
  "up",
  "down",
  "left",
  "right",
  "in",
  "out",
  "inside",
  "outside",
  "back",
  "forward",
]);

const MIN_TOKEN_LEN = 2;

/** Place-word tokens so common they identify a KIND of place, not a place — a shared "hall" or
 *  "road" must never bind a named destination to an unrelated exit on its own. (r4 playtest:
 *  "the muster hall" matched the Freelance Hall on the lone token "hall" and silently teleported
 *  the party to the wrong district.) A generic token still counts when the WHOLE query matched —
 *  "the square" binding the Square is exactly right. */
const GENERIC_PLACE_TOKENS = new Set([
  "hall",
  "house",
  "road",
  "gate",
  "market",
  "square",
  "bridge",
  "street",
  "inn",
  "tavern",
  "shop",
  "tower",
  "temple",
  "yard",
  "lane",
  "alley",
  "dock",
  "docks",
  "quarter",
  "district",
  "door",
  "camp",
  "hill",
]);

/** Common function words that carry no place-identity — dropped so they never create a false
 *  overlap ("the mill" vs "the docks") or a spurious tie. Not a language model, just noise removal. */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "at",
  "of",
  "and",
  "or",
  "go",
  "goto",
  "head",
  "walk",
  "move",
  "travel",
  "let",
  "lets",
  "into",
  "toward",
  "towards",
  "over",
  "past",
  "for",
]);

/** Strip a trailing runtime state tag, lowercase, and collapse whitespace. Exported so the engine's
 *  open-world reach can match a requested place name against existing locations / gazetteer entries
 *  with the SAME normalization the exit matcher uses (no drift between grounding and reach). */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*\((?:locked|blocked|broken open|open)\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content tokens (min length gated, stop-words dropped) plus any whole-token direction words
 *  (kept even when short). Direction words survive the stop-word filter — they ARE the signal.
 *  Exported for the engine's open-world reach (unique token-overlap fallback vs existing places). */
export function tokensOf(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of norm(s).split(/[^a-z0-9]+/i)) {
    if (!raw) continue;
    if (DIRECTION_WORDS.has(raw)) {
      out.add(raw);
      continue;
    }
    if (raw.length < MIN_TOKEN_LEN || STOP_WORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** The searchable token surface for one exit: its normalized name plus its direction word. */
function exitTokens(exit: ExitCandidate): Set<string> {
  const toks = tokensOf(exit.name);
  if (exit.direction) {
    for (const d of tokensOf(exit.direction)) toks.add(d);
  }
  return toks;
}

/**
 * Ground a movement destination against the real exits, in order of confidence:
 *  1. exact id membership (preserves the classifier's prior behavior);
 *  2. normalized name/direction EQUALITY vs the model's guess (id guess or named destination);
 *  3. token overlap of the model's guesses vs each exit's name+direction — a UNIQUE best non-zero
 *     match wins; a tie (or nothing) returns null (stay honest, never guess). The RAW player line
 *     only joins the token pool when the model named NO destination at all (a bare "head west"):
 *     when the model DID name one, the line's incidental tokens must not outvote it — "walk the
 *     glass-road west to the dry wash" names the dry wash, and the road tokens silently snapping
 *     the party to the road's far end was the r2 playtest's teleport bug.
 *
 * `currentLocationId` (when given) is never returned — a move never resolves to the room you're in.
 */
export function matchExit(
  destGuess: string | null | undefined,
  rawInput: string,
  exits: ExitCandidate[],
  currentLocationId?: string,
  destName?: string | null,
): string | null {
  const candidates = exits.filter((e) => e.id !== currentLocationId);
  if (candidates.length === 0) return null;

  // 1) Exact id membership — the classifier already grounds these; keep the fast path.
  if (destGuess) {
    const exact = candidates.find((e) => e.id === destGuess);
    if (exact) return exact.id;
  }

  // 2) Normalized name/direction equality vs the model's guesses.
  for (const guess of [norm(destGuess ?? ""), norm(destName ?? "")]) {
    if (!guess) continue;
    const nameEq = candidates.filter((e) => norm(e.name) === guess);
    if (nameEq.length === 1) return nameEq[0]!.id;
    const dirEq = candidates.filter((e) => e.direction && norm(e.direction) === guess);
    if (dirEq.length === 1) return dirEq[0]!.id;
  }

  // 3) Token overlap — the model's guesses first; the raw line only as a last resort when the
  //    model named nothing (see the doc comment). A UNIQUE best non-zero score wins.
  const guessTokens = new Set<string>([...tokensOf(destGuess ?? ""), ...tokensOf(destName ?? "")]);
  const queryTokens = guessTokens.size > 0 ? guessTokens : tokensOf(rawInput);
  if (queryTokens.size === 0) return null;

  let best: { id: string; score: number; matched: string[] } | null = null;
  let tied = false;
  for (const exit of candidates) {
    const toks = exitTokens(exit);
    const matched: string[] = [];
    for (const q of queryTokens) if (toks.has(q)) matched.push(q);
    const score = matched.length;
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { id: exit.id, score, matched };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }
  if (!best || tied) return null;
  // Generic-token guard — MODEL-GUESS pool only (the raw-line last resort keeps its old shape:
  // a bare "head west" has nothing distinctive by construction). A unique best binds only when
  // the whole query matched (subset rule: "the square" → the Square) or at least one matched
  // token is distinctive; a query with an unmatched distinctive token riding a generic-only
  // overlap ("muster" unmatched, only "hall" shared) stays an honest miss.
  if (guessTokens.size > 0) {
    const allMatched = best.score === queryTokens.size;
    const hasDistinctive = best.matched.some((t) => !GENERIC_PLACE_TOKENS.has(t) && !DIRECTION_WORDS.has(t));
    if (!allMatched && !hasDistinctive) return null;
  }
  return best.id;
}

/**
 * Ground a destination named inside a PROSE line — an NPC's spoken plan ("the bond's held by the
 * River Guild salvage office — we'll pull the paper"), never a classifier's destination guess.
 *
 * A whole sentence is a far noisier query than a guess: every incidental noun is a candidate token,
 * so `matchExit`'s raw-line last resort (which deliberately skips the generic-token guard, because a
 * bare "head west" has nothing distinctive by construction) is exactly the wrong shape here. The r5
 * playtest: a companion proposed the salvage office, the party AGREED, and a lone shared token bound
 * the plan to the Dockmire — a flooded work-dock with no office in it.
 *
 * So this is the strict sibling: a unique best still wins, but the generic-token guard applies to the
 * PROSE pool too — the match binds only when at least one matched token is distinctive, or when the
 * whole query matched (a terse "move to the square" is still the Square). A tie, or an overlap made
 * of nothing but shared place-words, returns null and the caller keeps the line as speech: a plan
 * that never named a reachable place must not move anyone. Under-matching costs a beat of banter;
 * over-matching walks the party somewhere they never agreed to go.
 */
export function matchExitInProse(text: string, exits: ExitCandidate[], currentLocationId?: string): string | null {
  const candidates = exits.filter((e) => e.id !== currentLocationId);
  if (candidates.length === 0) return null;
  const query = tokensOf(text);
  if (query.size === 0) return null;

  let best: { id: string; score: number; matched: string[] } | null = null;
  let tied = false;
  for (const exit of candidates) {
    const toks = exitTokens(exit);
    const matched: string[] = [];
    for (const q of query) if (toks.has(q)) matched.push(q);
    if (matched.length === 0) continue;
    if (!best || matched.length > best.score) {
      best = { id: exit.id, score: matched.length, matched };
      tied = false;
    } else if (matched.length === best.score) {
      tied = true;
    }
  }
  if (!best || tied) return null;
  const allMatched = best.score === query.size;
  const hasDistinctive = best.matched.some((t) => !GENERIC_PLACE_TOKENS.has(t) && !DIRECTION_WORDS.has(t));
  return allMatched || hasDistinctive ? best.id : null;
}
