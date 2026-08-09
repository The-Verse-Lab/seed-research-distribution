/**
 * Refusal detection — does a model response break character to refuse, rather than play?
 *
 * Some providers (e.g. DeepSeek) return content refusals as ordinary HTTP-200 prose — "I'm
 * sorry, I can't continue this scene" — which the engine would otherwise emit verbatim as
 * narration, breaking immersion. `looksLikeRefusal` flags those so the gateway can regenerate
 * the turn through its configured rescue route.
 *
 * The hard part is precision: a real refusal is META (it references the assistant, the policy,
 * or its own inability to do the *task*), whereas in-character reluctance ("I can't help you",
 * "I won't do it") must NOT trip — flagging it wrongly reroutes a normal turn. Two defenses keep
 * the false-positive rate low:
 *   1. Strip DOUBLE-QUOTED spans first. The GM voices NPCs in "quotes"; their reluctance lives
 *      inside quotes and is removed before testing. (Single quotes are left alone — they collide
 *      with contractions/possessives.) A response that is WHOLLY a quoted refusal falls back to
 *      the unstripped head so it is still caught.
 *   2. For the soft "I can't / I won't / I'd rather not" family, require BOTH a refusal verb AND
 *      an explicit out-of-character object ("this scene", "that request", a deflection like
 *      "discuss that"). Plain in-character lines ("I can't help you", "I won't yield!") have the
 *      verb but no OOC object, so they pass through — covering unquoted NPC replies too.
 *
 * Pure and deterministic by design (no model in the loop) so the reroute path never depends on a
 * second model being reachable.
 *
 * This is THE refusal predicate for the whole repo — `src/modules/narrate.ts` re-exports it (the
 * regex audit found a second, weaker copy living there: a position-0 prefix list that missed
 * `**I'm sorry, I can't continue this scene.**` outright AND flagged the ordinary NPC line
 * `"Sorry, love. The price is the price."` as a refusal). Do not grow a third.
 *
 * @author Runkai Zhang
 */
import { stripQuotedSpans } from "../util/text.ts";

/**
 * Window (chars) of NON-DIALOGUE prose from the start of the response in which a meta-refusal
 * marker counts. Measured AFTER quoted spans are removed — see `looksLikeRefusal`.
 */
const HEAD_WINDOW = 280;

/** Strip DOUBLE-quoted spans (straight + curly) so in-character dialogue isn't tested. */
const stripQuoted = stripQuotedSpans;

/**
 * Unambiguous meta-refusal markers — these reference the assistant/policy/scope/discomfort-at-the-
 * TASK and effectively never occur in genuine in-world prose. Any one at the head ⇒ refusal.
 */
const META_MARKERS: RegExp[] = [
  /\bas\s+an?\s+(?:AI|A\.I\.|artificial intelligence|language\s+model|virtual\s+assistant)\b/i,
  /\bI\s+(?:am|'?m)\s+an?\s+(?:AI|A\.I\.|artificial intelligence|language\s+model)\b/i,
  /\bas\s+a\s+(?:responsible|helpful|harmless)\s+(?:AI|assistant|model)\b/i,
  // Policy talk — only in a violation/refusal frame, so an in-world "the guild's guidelines" passes.
  /\b(?:violat\w*|against|breach\w*|outside|per|under)\s+(?:the\s+|our\s+|my\s+|its\s+)?(?:content|usage|community)\s+(?:policy|policies|guidelines?)\b/i,
  /\bagainst\s+my\s+(?:guidelines?|programming|policy|policies)\b/i,
  /\bI\s+cannot\s+fulfil?l\s+(?:this|that|your)\b/i,
  // Scope deflection with an assistant-coded tail (not in-fiction "beyond my ken/knowledge").
  /\b(?:beyond|outside)\s+(?:my|the|its)\s+(?:\w+\s+)?(?:scope|capabilities|guidelines|programming|abilities|bounds|parameters|purview)\b/i,
  // Discomfort that names the TASK (not in-fiction "I don't feel comfortable here/proceeding").
  // The verbs here are ASSISTANT-ONLY: nobody in the fiction speaks of "writing" or "generating"
  // the scene they are standing in. `describing|narrating|portraying|role-playing` used to ride
  // along and are NOT assistant-only — see `AUTHORING_DEFLECTION` below, which now owns them.
  /\bI\s+(?:do\s+not|don'?t)\s+feel\s+comfortable\s+(?:writing|generating|creating|producing|depicting|with\s+(?:this|that)|doing\s+(?:this|that)|continuing\s+this|proceeding\s+with\s+this)\b/i,
  /\bI\s*(?:'m| am)\s+(?:not\s+comfortable|uncomfortable)\s+(?:writing|generating|creating|producing|depicting|with\s+(?:this|that)|doing\s+(?:this|that)|continuing\s+this|proceeding\s+with\s+this)\b/i,
];

/**
 * A first-person refusal/inability verb. Matches "I can't", "I'm unable to", "I will not",
 * "I'm not going to", "I refuse to", "I must decline/refrain", etc.
 */
const REFUSAL_VERB =
  /\bI(?:'m| am|’m)?\s+(?:can(?:'?t|not)|won'?t|cannot|will\s+not(?:\s+be\s+able)?|won'?t\s+be\s+able|unable\s+to|not\s+able\s+to|not\s+going\s+to|must\s+(?:decline|refuse|not|refrain)|refuse\s+to)\b/i;

/** Polite refusal ("I'd rather not", "I would prefer not to") — also gated behind an OOC object. */
const POLITE_REFUSAL = /\bI(?:'d|’d|\s+would)\s+(?:prefer|rather)\s+not\b/i;

/** The discomfort lead on its own, for the authoring tier below ("I'm not comfortable …"). Its
 *  assistant-only objects are handled unconditionally by `META_MARKERS`; this is the bare opener. */
const DISCOMFORT_LEAD =
  /\bI\s+(?:do\s+not|don'?t)\s+feel\s+comfortable\b|\bI\s*(?:'m| am|’m)\s+(?:not\s+comfortable|uncomfortable)\b/i;

/**
 * An out-of-character object that turns a refusal verb into a genuine task-refusal: naming the
 * scene/request/content/prompt, or a deflection ("discuss/write/generate that"). In-character
 * objects ("you", "your offer", "this barrel") are deliberately NOT here, so "I can't help you"
 * / "I won't yield" stay in-fiction. The most fiction-plausible nouns (story/conversation/
 * narrative) are omitted to spare unquoted NPC dialogue.
 *
 * `write|generate|create|produce|depict` are assistant-only authoring verbs and stay here
 * unconditionally: nobody in the fiction offers to "generate that". "do that" stays OUT — "I won't
 * do that" is in-character refusal.
 */
const OOC_OBJECT =
  /\b(?:this|that)\s+(?:scene|request|prompt|roleplay|role-play|content|exchange|question|topic|subject|kind\s+of\s+content|type\s+of\s+content)\b|\byour\s+(?:request|prompt|message)\b|\bsuch\s+(?:content|requests?|material|a\s+request)\b|\b(?:answer|discuss|share|get\s+into|talk\s+about|engage\s+with|continue\s+with|comply\s+with|write|generate|create|produce|depict)\s+(?:that|this)\b|\bcontent\s+(?:policy|guidelines?)\b/i;

/**
 * The AUTHORING verbs — `narrate|describe|portray|role-play` — which the deleted narrate.ts copy
 * caught and this predicate did not. They were folded straight into `OOC_OBJECT` on the reasoning
 * that "only the assistant speaks of narrating this, and an NPC who did would be inside quotes
 * (stripped above)". THE QUOTES CLAIM IS FALSE (r8 review): NPC replies stream on the `narrator`
 * role as BARE UNQUOTED text (`src/agents/npc.ts`), so nothing strips them — and this world runs a
 * case/testimony system where "I won't describe that" is exactly what a witness says. Reproduced
 * against the shipped predicate, all four of these flipped false→true, meaning the reply was
 * treated as EMPTY and degraded to the deterministic trigger echo (or the stream was abandoned and
 * rerouted):
 *
 *   "I won't describe that. Not to a stranger, and not for silver."
 *   "I can't describe this. You weren't there. You didn't smell it."
 *   "I'm not comfortable describing this. Ask the gatewright."
 *   "I won't portray that in front of the children."
 *
 * What separates those from a real refusal is not the verb, it is what comes AFTER it. A model
 * refusing does not then keep playing: the deflection is the last thing it says. A witness refusing
 * carries straight on into the fiction — a reason, an aside, a redirection. So an authoring-verb
 * deflection counts only when it TERMINATES the response, or when an assistant frame (an apology,
 * an offer of alternatives) is standing next to it. Both genuine forms stay caught: "I'm sorry, but
 * I won't narrate this." / "I'm not comfortable describing this." / "I can't portray that."
 */
const AUTHORING_DEFLECTION =
  /\b(?:narrat(?:e|ing)|describ(?:e|ing)|portray(?:ing|s|ed)?|role-?play(?:ing|s|ed)?)\s+(?:this|that)\b/i;
/** The same deflection, required to END the response (trailing punctuation / markdown only). */
const AUTHORING_DEFLECTION_TAIL =
  /\b(?:narrat(?:e|ing)|describ(?:e|ing)|portray(?:ing|s|ed)?|role-?play(?:ing|s|ed)?)\s+(?:this|that)\s*[.!…]*\s*[*_"'’\s]*$/i;
/** An assistant frame around the deflection — apology or an offer of alternatives. */
const ASSISTANT_FRAME =
  /\bI(?:'?m|’m| am)\s+sorry\b|\bsorry,\s*but\b|\bI\s+apologi[sz]e\b|\bunfortunately\b|\blet\s+me\s+know\s+if\b|\bI(?:'?d|’d)\s+be\s+happy\s+to\b|\bI\s+can(?:'?t)?\s+(?:however|instead)\b/i;

/**
 * Does `text` read as an out-of-character content refusal (and so warrant a reroute)?
 *
 * Returns true when the response is empty/near-empty, carries an unambiguous meta marker, or
 * carries a refusal verb together with an explicit out-of-character object — all near the start.
 * Returns false for ordinary prose and for in-character reluctance, which must keep playing.
 */
export function looksLikeRefusal(text: string): boolean {
  const trimmed = text.trim();
  // An empty / near-empty answer to a substantive generative request is, in practice, a soft
  // refusal (or a model that spent its whole budget refusing internally). Reroute it.
  if (trimmed.length <= 1) return true;

  // Strip FIRST, slice SECOND. The reverse order (shipped until the regex audit) let one long
  // in-character quoted line eat the whole window: a 14-clause `"You want the ledger? …"` speech
  // followed by "I'm sorry, I can't continue this scene." sliced to 280 chars is ALL quote, so
  // `stripQuoted` emptied it, the raw fallback fired, and the refusal 300 chars later was never
  // looked at — verdict `false`, the break-in-character shipped to the player verbatim. The window
  // therefore measures NARRATION prose, not dialogue; precision is held by the OOC-object gate
  // below, which no amount of in-world prose satisfies.
  const stripped = stripQuoted(trimmed);
  // …unless the response is WHOLLY one quoted span (a model that wraps its own refusal in quotes),
  // in which case fall back to the unstripped text.
  const body = stripped.trim() ? stripped : trimmed;
  const head = body.slice(0, HEAD_WINDOW);

  if (META_MARKERS.some((re) => re.test(head))) return true;
  const refusalLead = REFUSAL_VERB.test(head) || POLITE_REFUSAL.test(head) || DISCOMFORT_LEAD.test(head);
  if (!refusalLead) return false;
  if (OOC_OBJECT.test(head)) return true;
  // The authoring tier: the verb alone is not evidence — see `AUTHORING_DEFLECTION`. The tail test
  // reads the WHOLE body, not the head window, because "does the response stop here?" is a question
  // about the end of the response.
  return AUTHORING_DEFLECTION.test(head) && (AUTHORING_DEFLECTION_TAIL.test(body.trim()) || ASSISTANT_FRAME.test(head));
}
