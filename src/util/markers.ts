/**
 * Brief section markers — the shared prompt-protocol headers used to assemble and screen the
 * narrator brief.
 *
 * These literals cross module boundaries: `agents/context` and `agents/npc` PRODUCE them,
 * `llm/providers/offline` keys its deterministic stubs on them, and `llm/guarded-gateway`'s input
 * screen scans for them to isolate the player's current action from the surrounding
 * transcript/lore. Defining them ONCE here keeps those four sites from drifting — a stale copy in
 * the guard previously listed a marker (`# AUTONOMOUS BEAT`) that no producer ever emitted.
 *
 * @author Runkai Zhang
 */

/** The named brief headers shared across the brief builder, the agents, the offline stub, and the guard. */
export const BRIEF_MARKERS = {
  /**
   * The current player action. ALWAYS present in an assembled brief, emitted AFTER `# RECENT`, so
   * it doubles as the guard's reliable cut point: everything from `# NOW` onward is the current
   * action (which excludes the recent transcript / world lore — those must not over-block).
   */
  now: "# NOW",
  /** Introduces a companion's direct-address reply prompt (reactive dialogue). */
  directAddress: "# DIRECT ADDRESS",
  /** Introduces an autonomous NPC's decide prompt (a proactive beat). */
  autonomousBeat: "# WHAT DO YOU WANT TO DO?",
} as const;

/**
 * The headers that begin the current-action region within a brief. The guard's input screen cuts
 * from the EARLIEST of these onward. In practice every current brief embeds `# NOW` (the ubiquity
 * invariant noted above), so it is the operative anchor; the others are valid fallback anchors for
 * any future action-only prompt that omits `# NOW`.
 */
export const ACTION_MARKERS: readonly string[] = [
  BRIEF_MARKERS.now,
  BRIEF_MARKERS.directAddress,
  BRIEF_MARKERS.autonomousBeat,
];
