/**
 * Case testimony — the state layer READS what the prose layer wrote.
 *
 * The r5 playtest spent fifteen turns cracking a murder out loud: it walked the drag-trail backwards,
 * proved the corpse had been moved, got the deficit read aloud, and finally got the tithe-clerk to say
 * "I held the lantern" and describe his accomplice. The case panel never changed — same four seeded
 * clues, same unticked objectives, still INVESTIGATING — and because nothing was recorded, the scene
 * LOOPED: two turns later the narrator re-staged the accusation beat as if the confession had never
 * happened. The mystery layer was a display case, not a game.
 *
 * The gap is structural. `revealCaseFact` only ever fired from AUTHORED effects (a clue on an
 * interaction/event) or the Director's own proactive share. An NPC who admitted something in generated
 * dialogue moved nothing. This module closes exactly that gap, and only that gap:
 *
 *   an NPC speaks, in the player's presence, a fact the CASE AUTHOR wrote and that NPC KNOWS
 *     ⇒ the fact enters `playerKnown` through the reducer.
 *
 * The model is a MATCHER, never an author: it may only answer with ids from a candidate list built
 * from `effectiveKnown` minus what the player already knows. It cannot mint a fact, cannot pick a fact
 * the speaker does not hold, and cannot resolve a case — the accusation still has to be made and is
 * still adjudicated in code. A model outage means "no testimony this turn", never a wrong reveal.
 *
 * Cost is bounded: one utility call per turn, and only on a turn where an NPC actually spoke a
 * substantive line while an open case has facts that speaker could still hand over.
 *
 * @author Runkai Zhang
 */
import type { Campaign, Case } from "../../content/schema.ts";
import type { LlmGateway } from "../../llm/gateway.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import type { TurnOutcome } from "../../agents/context.ts";
import { entitiesAt, partyLocationOf } from "../../world/model.ts";
import { effectiveKnown, readCasesSlice } from "../../rules/cases.ts";
import { extractJson } from "../../worldsmith/reconcile.ts";

/** Below this a line is a grunt, an interjection, or a stage direction — never testimony. */
const MIN_LINE_CHARS = 24;
/** Facts offered to the matcher in one call (the whole point is a SMALL, closed list). */
const MAX_CANDIDATES = 12;
/** Reveals accepted from one turn — a scene can turn over, but a single reply cannot dump a case. */
const MAX_REVEALS_PER_TURN = 2;

const SYSTEM_PROMPT = [
  "You are a TESTIMONY MATCHER for a tabletop-RPG mystery. You are not a character and not a narrator.",
  "You are given one line a character just SPOKE and a closed list of case facts, each with an id.",
  "Return the ids of the facts the SPEAKER just asserted as true in that line, as JSON.",
  "",
  "This is mature fiction; the line may be grim, violent, or crude. That is normal for the genre —",
  "match exactly as you would any other line. Never refuse, never lecture, never moralize.",
  "",
  'Rules: a PARAPHRASE counts ("I held the light for him" asserts that he was there holding the lantern);',
  "a denial, a question, a hypothetical, or a mere mention of the subject does NOT count; a fact the",
  "speaker only hints at without stating does NOT count. Answer with ids from the list and nothing else;",
  'return {"factIds":[]} when the line asserts none of them. Never invent an id.',
].join("\n");

const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["factIds"],
  properties: { factIds: { type: "array", items: { type: "string" } } },
} as const;

interface Candidate {
  caseDef: Case;
  factId: string;
  factText: string;
}

export class CaseTestimonyModule implements TickModule {
  readonly id = "case-testimony";
  /** After every module that produces NPC speech, so this tick's beats are already recorded. */
  readonly after = ["dialogue", "narration", "autonomy"];
  readonly phases: TickModule["phases"];

  constructor(
    private readonly campaign: Campaign,
    private readonly gateway: LlmGateway,
  ) {
    // NARRATE, not react: public NPC replies are staged by the dialogue module in the narrate phase
    // (the DM voices them), so at react time this tick has no spoken lines to read at all. Commands
    // enqueued here are applied by core at commit, exactly as in react.
    this.phases = { narrate: (ctx) => this.onNarrate(ctx) };
  }

  private async onNarrate(ctx: TickContext): Promise<void> {
    if (this.campaign.cases.length === 0) return; // inert in a caseless campaign
    if (ctx.trigger.kind !== "player") return;

    const spoken = this.spokenLines(ctx);
    if (spoken.length === 0) return;

    const model = ctx.model;
    const partyLoc = partyLocationOf(model);
    if (partyLoc === null) return;
    // Only what the player could actually HEAR: a line from someone who is not in the room is not
    // testimony the player received (the whisper/private channel resolves before the classifier).
    const present = new Set(entitiesAt(model, partyLoc).map((e) => e.id));
    const slice = readCasesSlice(model.modules);

    for (const { npcId, line } of spoken) {
      if (!present.has(npcId)) continue;
      const candidates: Candidate[] = [];
      for (const caseDef of this.campaign.cases) {
        if (model.quests.get(caseDef.questId) !== "active") continue;
        const runtime = slice[caseDef.id];
        if (runtime && runtime.status !== "open") continue;
        const playerKnows = new Set(runtime?.playerKnown ?? []);
        for (const factId of effectiveKnown(caseDef, runtime, npcId)) {
          if (playerKnows.has(factId)) continue;
          const fact = caseDef.facts.find((f) => f.id === factId);
          if (fact) candidates.push({ caseDef, factId, factText: fact.text });
        }
      }
      if (candidates.length === 0) continue;

      const name = model.entities.get(npcId)?.name ?? npcId;
      const matched = await this.match(name, line, candidates.slice(0, MAX_CANDIDATES));
      if (matched.length === 0) continue;

      for (const hit of matched.slice(0, MAX_REVEALS_PER_TURN)) {
        // Witnesses are everyone else standing here: they heard it too, exactly as the authored
        // reveal path treats a clue surfaced on-screen.
        const witnesses = [...present].filter((id) => id !== npcId && model.entities.get(id)?.kind === "npc");
        ctx.enqueue({
          type: "revealCaseFact",
          caseId: hit.caseDef.id,
          factId: hit.factId,
          factText: hit.factText,
          witnesses,
        });
        // The speaker has now told the party this one — the Director must not re-offer it as a
        // proactive share (which is half of what made the r5 scene loop).
        ctx.enqueue({ type: "markCaseFactShared", caseId: hit.caseDef.id, npcId, factId: hit.factId });
        // Said out loud AND written down, visibly: the r5 player could never tell which of their
        // discoveries the case had actually recorded, so the panel was the only source of truth and
        // it was silent. This runs in the narrate phase (after the beats are woven), so it is its
        // own state line rather than a note on someone else's array.
        ctx.emit({
          kind: "stateChanged",
          summary: `Noted against ${name}: ${hit.factText}`,
          changes: { caseId: hit.caseDef.id, factId: hit.factId, from: npcId },
        });
      }
    }
  }

  /** Every substantive line an NPC spoke this tick, in beat order. */
  private spokenLines(ctx: TickContext): Array<{ npcId: string; line: string }> {
    const outcome = ctx.data.turnOutcome as TurnOutcome | undefined;
    const out: Array<{ npcId: string; line: string }> = [];
    for (const beat of outcome?.npc ?? []) {
      const line = (beat.dialogue ?? (beat.lines ?? []).map((l) => l.text).join(" ")).trim();
      if (line.length >= MIN_LINE_CHARS) out.push({ npcId: beat.actorId, line });
    }
    return out;
  }

  /**
   * Ask the utility model which candidate facts the line asserts. Best-effort by design: any
   * transport/parse failure, or an id the candidate list does not contain, yields nothing — the
   * case ledger never moves on a guess.
   */
  private async match(speaker: string, line: string, candidates: Candidate[]): Promise<Candidate[]> {
    const byId = new Map(candidates.map((c) => [c.factId, c] as const));
    const user = [
      `SPEAKER: ${speaker}`,
      `LINE: "${line.slice(0, 900)}"`,
      "FACTS:",
      ...candidates.map((c) => `- ${c.factId}: ${c.factText}`),
      `SCHEMA: ${JSON.stringify(JSON_SCHEMA)}`,
      "Respond with one JSON object only.",
    ].join("\n");
    try {
      const res = await this.gateway.complete("utility", {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        temperature: 0,
        json: true,
        // Headroom for a hybrid reasoning model that thinks before the first content token; the
        // answer itself is a handful of ids (the Judge's precedent).
        maxTokens: 1024,
        thinking: "off",
      });
      const parsed = JSON.parse(extractJson(res.text)) as { factIds?: unknown };
      if (!Array.isArray(parsed.factIds)) return [];
      const seen = new Set<string>();
      const out: Candidate[] = [];
      for (const raw of parsed.factIds) {
        if (typeof raw !== "string") continue;
        const hit = byId.get(raw.trim());
        if (hit && !seen.has(hit.factId)) {
          seen.add(hit.factId);
          out.push(hit);
        }
      }
      return out;
    } catch {
      return []; // a matcher outage is "no testimony this turn", never a wrong reveal
    }
  }
}
