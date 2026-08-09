/**
 * Formative memories — what an NPC already remembers about themselves the first time you meet them.
 *
 * Ported from the `FormativeMemoriesInitializer` idea in DeepMind's Concordia, where an agent's
 * memory bank is seeded at construction rather than starting empty. Seed had the same gap: an NPC
 * carries an authored role, faction, goals and relationships, but its JOURNAL is empty until the
 * player does something to it — so the first several conversations recall nothing, and the character
 * reads as though it began existing when you walked in.
 *
 * These entries are DERIVED, never stored. Like the seeded-routine fallback they mirror, they are
 * computed at recall time from authored content only, so:
 *   - nothing is written into the world model, no delta, no replay divergence;
 *   - a real recorded beat always outranks them (they are appended BELOW the journal, and drop off
 *     entirely once the NPC has enough real history);
 *   - the world editor never round-trips them into content.
 *
 * Every line is engine-templated over the author's own words — the model is never asked to invent a
 * past. An NPC with nothing authored yields nothing, so the block stays omit-when-empty.
 *
 * @author Runkai Zhang
 */
import type { NpcTemplate, World } from "../content/schema.ts";
import type { NpcMemoryEntry } from "./npc-memory.ts";

/** The beat kind every derived entry carries, so they are distinguishable in any journal dump. */
export const FORMATIVE_KIND = "formative";

/** How many derived beats an NPC may carry at most. A handful of anchors, not a biography. */
export const FORMATIVE_MAX = 4;

/**
 * Once an NPC has this many REAL recorded beats, the derived ones stop being offered: lived history
 * has taken over, and the standing facts are in the prompt by other means anyway.
 */
export const FORMATIVE_FADE_AT = 6;

/** A relationship this strong (either way) is a formative fact about the person, not a mood. */
const STRONG_REGARD = 40;

function trimSentence(text: string, max = 120): string {
  const first = text.trim().split(/(?<=[.!?])\s/)[0]?.trim() ?? "";
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The formative beats for one NPC, oldest-feeling first. Deterministic: same template, same world,
 * same lines, in the same order — so two runs of the same save read identically.
 *
 * `at: 0` dates them before the campaign's own clock, which is what they are: things true before
 * the story started. That also keeps them last in any recency sort, behind everything lived.
 */
export function formativeMemories(world: Pick<World, "npcs" | "factions">, npc: NpcTemplate): NpcMemoryEntry[] {
  const out: NpcMemoryEntry[] = [];
  const push = (summary: string, domains: string[], subjectIds?: string[]): void => {
    if (out.length >= FORMATIVE_MAX || !summary) return;
    out.push({
      at: 0,
      kind: FORMATIVE_KIND,
      summary,
      domains,
      ...(subjectIds && subjectIds.length > 0 ? { subjectIds } : {}),
    });
  };

  // What they are. The single most load-bearing thing a character should never be vague about.
  const role = (npc.socialRole ?? "").trim();
  if (role) push(`This is what I am and have been: ${trimSentence(role)}.`, ["work", "identity"]);

  // Who they stand with. Named from the world's own faction list so the NPC uses the canon name.
  if (npc.factionId) {
    const faction = world.factions?.find((f) => f.id === npc.factionId);
    if (faction) {
      push(`I have stood with ${faction.name} long enough that its quarrels are mine.`, ["faction", "loyalty"], [
        npc.factionId,
      ]);
    }
  }

  // Who they already have history with — the strongest authored regard, warm or cold. Only rows
  // pointing at someone the world actually names, so a dangling id never becomes a remembered person.
  const bonds = Object.entries(npc.relationships ?? {})
    .filter(([id, value]) => Math.abs(value) >= STRONG_REGARD && id !== npc.id)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  for (const [otherId, value] of bonds) {
    const other = world.npcs?.find((n) => n.id === otherId);
    if (!other) continue;
    push(
      value > 0
        ? `${other.name} and I go back. I count them a friend, and I do not pretend otherwise.`
        : `${other.name} and I have history, and none of it good. I have not forgotten it.`,
      ["trust", "history"],
      [otherId],
    );
    break; // one bond: the point is an anchor, not a social register
  }

  // What they are after. Goals are already in the prompt as intent; as a MEMORY it reads as the
  // thing they have been carrying, which is how a person actually holds a want.
  const goal = (npc.goals ?? [])[0]?.trim();
  if (goal) push(`What I have been working toward, all this while: ${trimSentence(goal)}.`, ["goal", "motive"]);

  return out;
}

/**
 * The derived beats to append below an NPC's real recall, given how much real history it has.
 *
 * Returns nothing once lived history has taken over ({@link FORMATIVE_FADE_AT}) — the character has
 * a past of its own by then, and the standing facts reach the prompt through the roster and lore.
 */
export function formativeFloor(
  world: Pick<World, "npcs" | "factions">,
  npc: NpcTemplate | undefined,
  realBeats: number,
): NpcMemoryEntry[] {
  if (!npc || realBeats >= FORMATIVE_FADE_AT) return [];
  return formativeMemories(world, npc).slice(0, Math.max(0, FORMATIVE_MAX - realBeats));
}
