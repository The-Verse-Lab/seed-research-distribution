/**
 * Is the player's line a QUESTION rather than a commitment?
 *
 * This is a deterministic floor under a model judgment, and the asymmetry is the whole argument for
 * it. `trade.inquiry` decides whether the engine quotes a price or moves goods and coin, and the
 * classifier sets it from the same sentence twice with different answers — measured live in r11:
 *
 *   "Sergeant Veil, would you take my mage hat for three copper?"
 *     pass 1 ⇒ "You sell the Wide-Brimmed Mage Hat to Sergeant Veil for 7 sp 5 cp."  (worn, unasked)
 *     pass 2 ⇒ "Sergeant Veil looks the Wide-Brimmed Mage Hat over and would give 7 sp 5 cp for it."
 *
 *   "I ask Sergeant Veil if she'll take my extra ration for three copper."
 *     ⇒ classified `dialogueToNpc`, and the freeform coin channel took the number out of the
 *       sentence: "You hand over 3 cp to Sergeant Veil." The player OFFERED to sell and was charged.
 *
 * The two failure directions are not equal. Reading a commitment as a question costs a turn and the
 * player says "I buy it"; reading a question as a commitment spends their coin or takes the hat off
 * their head with no confirmation. So this floor may only ever push TOWARD the question — it never
 * turns an inquiry into a purchase — and it defers to any explicit commitment the line also carries.
 *
 * The regex-audit rule (07-27) says a regex over a PERSON's text is a bug waiting to happen. It is
 * respected here by scope: this never decides WHAT was traded, WITH whom, or for how much — the
 * classifier still owns all of that. It decides one bit, in the safe direction, on the most
 * mechanical signal in written English.
 *
 * @author Runkai Zhang
 */

/** Trailing quotes/brackets/whitespace a real sentence ends with after its punctuation. */
const TRAILING = /["'”’)\]\s]+$/;

/**
 * Question-shaped OPENERS for a trade line that carries no "?" — the reported-question form the
 * classifier missed live ("I ask her if she'll take…"), and the bare modal ask ("would you take…").
 * Anchored at a clause start so "he asked for gold and I paid" is not an ask.
 */
const ASK_OPENER =
  /(?:^|[.;,]\s*|\band\s+|\bthen\s+)i\s+(?:ask|asked|enquire|enquired|inquire|inquired|wonder|wondered)\b/i;
/** A reported question needs its complementizer — "I ask if/whether/what/how much…". */
const REPORTED_QUESTION = /\b(?:if|whether|what|how|whose|which|when|where|why)\b/i;
/** A bare modal offer put to the other party: "would you take", "will you buy", "any chance you'd". */
const MODAL_ASK =
  /(?:^|[.;,"“]\s*)(?:so\s+)?(?:would|will|could|can|do|does|did|is|are|have|has|any\s+chance)\s+(?:you|he|she|they|[A-Z][\w'’-]*)\b/;

/**
 * An explicit COMMITMENT anywhere in the line wins: the player who writes "I'll take the spear —
 * how much?" has already decided. Present/future first-person only; a question ABOUT buying
 * ("would you sell me") is not a commitment to buy.
 */
const COMMITMENT =
  /\bi(?:'|’)?(?:ll|\s+will)?\s*(?:buy|take|purchase|pay|sell|hand\s+over|give\s+you)\b|\bi\s+(?:buy|bought|take|took|pay|paid|sell|sold|purchase|purchased)\b|\b(?:sold|deal|agreed|done)\b\s*[.!]?$|\bhere(?:'|’)?s\s+(?:the|my|your)\s+(?:coin|money|silver|gold|copper)\b/i;

/**
 * True when this line ASKS. See the module doc for why the bit is decided here and not by the model.
 *
 * A line asks when its final sentence ends in "?", or when it takes a reported-question or bare
 * modal-ask shape — UNLESS it also states a commitment, which always wins.
 */
export function isAskedNotCommitted(input: string): boolean {
  const line = input.trim();
  if (!line) return false;
  if (COMMITMENT.test(line)) return false;
  if (line.replace(TRAILING, "").endsWith("?")) return true;
  if (ASK_OPENER.test(line) && REPORTED_QUESTION.test(line)) return true;
  return MODAL_ASK.test(line);
}
