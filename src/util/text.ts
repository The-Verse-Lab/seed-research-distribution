/**
 * Shared text helpers.
 *
 * @author Runkai Zhang
 */

/** Split into words + whitespace tokens so streaming preserves spacing. */
export function chunkWords(text: string): string[] {
  return text.split(/(\s+)/).filter((s) => s.length > 0);
}

/**
 * Escape a literal string so it can be spliced into a `RegExp` source and match itself.
 *
 * This helper was pruned as "dead code" once and then re-created byte-identically in five separate
 * files (continuity, combat, narrator context, client prose handling, and safety
 * screen). It lives here because `src/rules`, `src/agents`, `src/modules`, `src/world` and `src/llm`
 * all need it and `src/util` is the only layer every one of them may import without a cycle.
 *
 * NOTE for callers: the escaped result is safe as a regex PATTERN, but it is NOT safe as a
 * `String.prototype.replace` REPLACEMENT string — `$&`, `` $` ``, `$'` and `$1` stay special there,
 * so a name carrying a dollar sign would splice the surrounding source into itself. Pass a replacer
 * FUNCTION when substituting an escaped literal into a regex template.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace DOUBLE-quoted spans (straight + curly) with a space, so a test that is about the
 * NARRATOR's own assertions is not applied to in-character dialogue.
 *
 * Lives here, next to `escapeRegExp`, for the same reason: `src/llm/refusal.ts` had the only copy
 * and `src/rules/continuity.ts` needed exactly the same predicate (`checkPhaseDrift` was reading
 * time-of-day out of quoted NPC speech), which is how this repo grows six byte-identical copies of a
 * one-liner. SINGLE quotes are deliberately not stripped — prose is full of apostrophes, and one
 * possessive would swallow the rest of the paragraph.
 */
export function stripQuotedSpans(text: string): string {
  return text.replace(/"[^"]*"|“[^”]*”/g, " ");
}
