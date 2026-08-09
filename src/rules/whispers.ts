/**
 * Whisper steers — the standing private line a PC last gave each NPC (Phase 6, click-to-chat).
 *
 * The math-leaf sibling of the private-thread channel: pure value shape + the single read helper
 * over the `model.modules.whispers` slice. The slice is written ONLY by the reducer, via the
 * generic `modulePatch` command the engine enqueues on every private player turn (replay-safe:
 * `modulePatched` deltas fold with `Object.assign`, and the patch always carries the absolute
 * latest steer). Bounded by design: exactly ONE string per NPC — the most recent private line —
 * so the slice can never grow past the cast of NPCs the player has whispered to.
 *
 * Consumers treat a steer as a condition, never a script: the autonomy Director treats a standing
 * steer as an open private thread when deciding whether an agenda line stays discreet.
 *
 * @author Runkai Zhang
 */

/** The module-slice key under `model.modules` (written via the generic `modulePatch` command). */
export const WHISPERS_MODULE = "whispers";

/**
 * The full runtime slice stored at `model.modules.whispers`: per-NPC id → the raw text of the
 * PC's most recent standing private steer to that NPC. Absent key ⇒ no private thread yet.
 */
export type WhisperSlice = Record<string, string>;

/**
 * The standing private steer the PC last gave `npcId`, or undefined when no private line has ever
 * been sent to that NPC (or the slice is missing/foreign-shaped — read defensively: the modules
 * bag is `unknown` by contract). A blank steer reads as no steer.
 */
export function whisperSteerOf(modules: Record<string, unknown>, npcId: string): string | undefined {
  const slice = modules[WHISPERS_MODULE] as WhisperSlice | undefined;
  const steer = slice?.[npcId];
  return typeof steer === "string" && steer.trim().length > 0 ? steer : undefined;
}
