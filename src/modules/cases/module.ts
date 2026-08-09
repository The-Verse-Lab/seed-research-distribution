/**
 * Cases module — the ONE reactive rule of the mystery layer that the reducer can't own alone: when a
 * clue revealed ON-SCREEN this tick refutes a red herring a PRESENT NPC still believes, that NPC's
 * false belief is overturned in front of them (`npcDropCaseBelief`) and a GM weave note is queued so
 * the narrator can play the reaction.
 *
 * Everything else in the cases layer is pure reducer commands (reveals, learns, credibility). This
 * module exists only because "belief overturned by witnessing" couples a fresh reveal (queued, not
 * yet committed) to another NPC's current belief — a cross-fact reaction, not a single mutation.
 *
 * Runs on `react` AFTER the event-producing modules so `ctx.queue` already carries this tick's
 * `revealCaseFact` commands. Player-turn-scoped and fully INERT in a caseless campaign. One writer:
 * the belief drop is an enqueued command; the weave note rides the shared `eventBeats` array.
 *
 * @author Runkai Zhang
 */
import type { Campaign } from "../../content/schema.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import { entitiesAt, partyLocationOf } from "../../world/model.ts";
import { effectiveBeliefs, readCasesSlice } from "../../rules/cases.ts";

export class CasesModule implements TickModule {
  readonly id = "cases";
  /** After every module that can enqueue a `revealCaseFact` (advisory; unknown ids are ignored). */
  readonly after = ["events", "npc-events", "travel-events", "camp-events", "room-events", "case-testimony"];
  readonly phases: TickModule["phases"];

  constructor(private readonly campaign: Campaign) {
    this.phases = { react: (ctx) => this.onReact(ctx) };
  }

  private onReact(ctx: TickContext): void {
    if (this.campaign.cases.length === 0) return; // inert in a caseless campaign
    if (ctx.trigger.kind !== "player") return;

    // Facts being revealed THIS tick (queued by events/interactions, not yet committed).
    const revealedByCase = new Map<string, Set<string>>();
    for (const cmd of ctx.queue) {
      if (cmd.type === "revealCaseFact") {
        let set = revealedByCase.get(cmd.caseId);
        if (!set) revealedByCase.set(cmd.caseId, (set = new Set<string>()));
        set.add(cmd.factId);
      }
    }
    if (revealedByCase.size === 0) return;

    const model = ctx.model;
    const partyLoc = partyLocationOf(model);
    const present = partyLoc
      ? entitiesAt(model, partyLoc).filter((e) => e.kind === "npc").map((e) => e.id)
      : [];
    if (present.length === 0) return; // no witness ⇒ no belief is overturned "in front of them"

    const slice = readCasesSlice(model.modules);
    const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
    let added = false;

    for (const c of this.campaign.cases) {
      if (model.quests.get(c.questId) !== "active") continue;
      const revealed = revealedByCase.get(c.id);
      if (!revealed) continue;
      const runtime = slice[c.id];
      for (const herring of c.redHerrings) {
        if (!herring.refutedBy.some((fid) => revealed.has(fid))) continue;
        for (const npcId of present) {
          if (!effectiveBeliefs(c, runtime, npcId).includes(herring.id)) continue;
          ctx.enqueue({ type: "npcDropCaseBelief", caseId: c.id, npcId, beliefId: herring.id });
          const name = model.entities.get(npcId)?.name ?? npcId;
          beats.push(`${name}'s certainty falters — the fresh evidence cuts clean across what they had believed.`);
          added = true;
        }
      }
    }

    if (added) ctx.data.eventBeats = beats;
  }
}
