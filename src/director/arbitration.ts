/**
 * Arbitration — the pure, testable core of bounded autonomy.
 *
 * Reply-chain decay and reply-focus selection are deterministic functions of state and an
 * RNG, so they live here as plain functions (no model, no IO). See docs/PROACTIVE-NPCS.md
 * sections 3–4.
 *
 * @author Runkai Zhang
 */
import type { Rng } from "../rules/dice.ts";

/**
 * Probability that an NPC continues an NPC-to-NPC reply chain at the given depth.
 *   P(depth) = max(0, 1 − (depth − 1)·α)
 * depth 1 → 1.0, and it decays to 0 as the thread lengthens.
 */
export function replyProbability(depth: number, alpha = 0.2): number {
  return Math.max(0, 1 - (depth - 1) * alpha);
}

/** Roll whether a reply chain continues. Depth ≤ 0 (player/world prompt) always passes. */
export function shouldContinueReply(depth: number, alpha = 0.2, rng: Rng = Math.random): boolean {
  if (depth <= 0) return true;
  return rng() < replyProbability(depth, alpha);
}

/**
 * Reply-focus arbitration: when several characters could be answered, pick the one with
 * the highest relationship score from the responder's perspective; ties broken randomly.
 * Returns null if there are no candidates.
 */
export function pickReplyTarget(
  candidateIds: string[],
  relationships: Record<string, number>,
  rng: Rng = Math.random,
): string | null {
  if (candidateIds.length === 0) return null;

  let best = -Infinity;
  let tied: string[] = [];
  for (const id of candidateIds) {
    const score = relationships[id] ?? 0;
    if (score > best) {
      best = score;
      tied = [id];
    } else if (score === best) {
      tied.push(id);
    }
  }
  if (tied.length === 1) return tied[0] ?? null;
  return tied[Math.floor(rng() * tied.length)] ?? null;
}
