/**
 * Quest presentation helpers — pure, content-layer, no engine/world imports.
 *
 * @author Runkai Zhang
 */

/**
 * The player-facing quest PITCH: the quest's own words, with any leading world-blurb stripped.
 *
 * Worldsmith-authored quests bake the world synopsis / summary in FRONT of the pitch (reconcile
 * prefixes `skeleton.summary`, which is also the campaign synopsis / default world summary), so
 * the in-fiction quest-offer beat strips it here at one shared seam. An empty pitch returns ""
 * (callers use the quest name alone, never falling back to world text).
 */
export function questPitch(description: string, world: { synopsis?: string; summary?: string }): string {
  const blurbs = [world.synopsis, world.summary].map((t) => (t ?? "").trim()).filter((t) => t.length > 0);
  let pitch = description.trim();
  for (const blurb of blurbs) {
    if (pitch.startsWith(blurb)) pitch = pitch.slice(blurb.length).trimStart();
  }
  return pitch;
}
