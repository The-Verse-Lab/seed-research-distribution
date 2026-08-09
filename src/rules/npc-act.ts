/**
 * NPC act — the CLOSED form an NPC names its world action in.
 *
 * An autonomous NPC used to hand grounding a free-text imperative ("I'll walk over to the
 * counting-house and hand Mira the sealed letter") and a twelve-list keyword net in
 * `src/modules/autonomy/grounding.ts` guessed which reducer Command that meant. That net was an
 * intent CLASSIFIER on the delta path — precisely the thing the Prune Wave deleted from `src/` for
 * PLAYER intent (CLAUDE.md, "Intent classification is LLM-only in the product") — and it was
 * structurally inverted, because confidence divided matched keywords by TOTAL tokens: the sentence
 * above scored 2/16 and was dropped as banter, while a two-word "Sit tight." scored 1/2 = 0.5 and
 * committed an `adjustEnergy` delta (both reproduced against the shipped scorer, r8 regex audit).
 *
 * The NPC agent already returns structured JSON once per beat, so naming the act costs ZERO extra
 * LLM calls: the model picks a verb from {@link NPC_ACT_VERBS} and copies a target id VERBATIM out
 * of the `# CANDIDATE ACTIONS` block its brief carries (enumerated from the world model by
 * `actCandidates`). Grounding is then a table lookup — the same matcher-only, closed-candidate-list
 * shape as `src/modules/case-testimony`. The model NAMES the act; code owns the legality, the roll,
 * and the mutation.
 *
 * Value shape only (the `src/rules/npc-memory.ts` precedent): both the agent that emits the form
 * (`src/agents/npc.ts`) and the grounder that consumes it import from here, so neither depends on
 * the other.
 *
 * @author Runkai Zhang
 */

/**
 * Every world action an NPC may name for itself — deliberately narrow (docs/PROACTIVE-NPCS §5):
 * speak / move / give / equip / unequip / open a barrier / pick / force / rest / loot / use a
 * consumable / take up an offered job. There is no `setFlag`, `spawn`, `setQuestState` (beyond
 * accepting a job already ON OFFER) or any other story-structure verb: world structure is the GM's
 * and the events module's job, never an autonomous companion's. `none` is the deliberate "my words
 * are the whole beat" answer and is also what any unrecognized verb degrades to.
 */
export const NPC_ACT_VERBS = [
  "move",
  "give",
  "equip",
  "unequip",
  "open",
  "pick",
  "force",
  "rest",
  "loot",
  "use",
  "take_job",
  "none",
] as const;

export type NpcActVerb = (typeof NPC_ACT_VERBS)[number];

/** A closed, id-addressed act. Every id must appear in the actor's `# CANDIDATE ACTIONS` block. */
export interface NpcAct {
  /** The verb, from the closed list. */
  do: NpcActVerb;
  /**
   * The primary id the verb acts on, copied verbatim from the candidate list: a destination
   * location id (move/open/pick/force), an item id (give/equip/unequip/loot/use), or a quest id
   * (take_job). Absent for `rest`/`none`.
   */
  target?: string;
  /**
   * The RECIPIENT entity id — `give` only. Deliberately required there rather than defaulted to
   * "the only other person present": who receives a gift is a durable delta, so it is named or the
   * act does not happen.
   */
  to?: string;
}

/**
 * Parse the model's `act` object defensively. Returns `undefined` — which grounds to plain speech,
 * the SAFE branch — for anything that is not an object carrying a KNOWN verb, and for the explicit
 * `none`, so every downstream caller sees only actionable verbs. Ids are passed through as trimmed
 * strings and are NOT trusted here: `groundToCommand` matches them against the legal candidate
 * table, and an id that isn't on it yields speech (recorded as an `illegal` grounding drop).
 * NEVER throws — a malformed intent must not stall a heartbeat.
 */
export function parseNpcAct(value: unknown): NpcAct | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const rawVerb = [o.do, o.verb, o.act].find((v): v is string => typeof v === "string");
  const verb = (rawVerb ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (!(NPC_ACT_VERBS as readonly string[]).includes(verb) || verb === "none") return undefined;
  const id = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  const target = id(o.target) ?? id(o.id);
  const to = id(o.to) ?? id(o.recipient);
  return {
    do: verb as NpcActVerb,
    ...(target !== undefined ? { target } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}
