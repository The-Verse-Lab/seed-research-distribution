/**
 * The canonical "is this character a minor?" predicate — the atom of the minor-safety guardrail.
 *
 * Extracted to its own dependency-free leaf so both the prose guard (`src/llm/safety.ts`) and any
 * gameplay gate can import the same definition rather than re-deriving `age < 18`. Homed here
 * (not under `src/llm/`) on purpose: the rules leaf can reuse it
 * without dragging the llm/normalize layer into the math. `safety.ts` re-exports both names, so
 * existing `from "../llm/safety.ts"` call sites are unchanged.
 *
 * @author Runkai Zhang
 */

/** A present character whose age the engine knows — lets a declared minor be protected by id. */
export interface SafetyCharacter {
  /** Entity id, if known — lets a caller gate a specific participant by id. */
  id?: string;
  name?: string;
  /** Declared age in years, if known. */
  age?: number;
  /** Explicit minor flag (supplements age; either being a minor protects the character). */
  isMinor?: boolean;
  /**
   * Explicit author-declared 18+ flag. Consulted ONLY by the text guard's narrow judge-demotion
   * path (`src/llm/safety.ts`) — it never feeds {@link isMinor} and never overrides a declared
   * minor or an assault-coded match.
   */
  ageIsAdult?: boolean;
}

/**
 * The ONE canonical "is this a minor?" predicate: a character is a minor iff explicitly flagged
 * OR has a declared age under 18 (unknown age is NOT a minor here — the text detector + judge
 * remain the backstop for textual/ambiguous minor signals). This is the single definition every
 * gate must reuse instead of re-deriving `age < 18`, so callers can never drift (the old base
 * carried two slightly different copies; this collapses them).
 */
export function isMinor(c: SafetyCharacter): boolean {
  return c.isMinor === true || (typeof c.age === "number" && c.age < 18);
}
