/**
 * Relationship-decay module — living relationships that breathe.
 *
 * When an in-world DAY boundary passes (detected on player ticks), every NPC's regard toward the PC
 * drifts one small step toward that NPC's personality-derived baseline (`personalityBaseline`, the
 * same alignment/personality tables `stance()` reads). Warm archetypes settle a little above 0,
 * cold/exploitative ones below it; earned history (quests, gifts, betrayals) still dominates — this is
 * only where an untouched relationship rests. Active party members and anyone interacted-with in the
 * last `DECAY_RECENT_DAYS` days are exempt (a bond you are actively tending never fades).
 *
 * The day cursor is held IN MEMORY, not in world state: the module writes nothing on the first
 * observation (it just anchors) and nothing on a day where no drift is due — so it is as inert as the
 * routines module in a world with no relationships, and a freshly-loaded save never perturbs the
 * event stream. Drifts are applied with `ctx.apply` (a real `relationshipChanged` delta, replay-safe)
 * but NOT enqueued: the npc-memory module scans the command QUEUE, and ambient daily decay must never
 * spawn "my regard cooled" memories (which would feed back through `memoryLean` and never converge).
 * Fully deterministic — day-keyed, no rng.
 *
 * @author Runkai Zhang
 */
import type { NpcTemplate, World } from "../../content/schema.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import { personalityBaseline } from "../../rules/agenda.ts";
import { DECAY_RECENT_DAYS, DECAY_STEP, driftToward, readRelationshipMeta } from "../../rules/relationships.ts";
import { dayOf } from "../../rules/routine.ts";
import { isCombatActive } from "../../world/queries.ts";
import { playerEntity } from "../../world/model.ts";

export class RelationshipDecayModule implements TickModule {
  readonly id = "relationshipDecay";
  /** After core so positions/clock are settled for the day this tick lands on. */
  readonly after = ["core"];
  readonly phases: TickModule["phases"];
  private readonly npcById: Map<string, NpcTemplate>;
  /** In-memory day cursor (best-effort; re-anchors on reload). No world state until a real drift. */
  private cursorDay: number | null = null;

  constructor(private readonly world: World) {
    this.npcById = new Map(world.npcs.map((n) => [n.id, n] as const));
    this.phases = { react: (ctx) => this.onReact(ctx) };
  }

  private templateFor(id: string): NpcTemplate | undefined {
    return this.npcById.get(id) ?? this.npcById.get(id.replace(/#\d+$/, ""));
  }

  private onReact(ctx: TickContext): void {
    if (ctx.trigger.kind !== "player") return; // heartbeats never move the clock
    const model = ctx.model;
    if (isCombatActive(model)) return; // no ambient drift mid-fight
    const pc = playerEntity(model);
    if (!pc) return;

    const day = dayOf(model.clock);
    if (this.cursorDay === null) {
      this.cursorDay = day; // first observation: anchor only, write nothing
      return;
    }
    if (day <= this.cursorDay) return; // same in-world day — at most one drift pass per day

    const meta = readRelationshipMeta(model.modules);
    for (const [npcId, targets] of model.relationships) {
      if (npcId === pc.id) continue;
      const current = targets.get(pc.id);
      if (current === undefined) continue;
      if (model.entities.get(npcId)?.partyMember) continue; // a companion at your side does not drift
      const lastSeen = meta.lastInteractDay[npcId]?.[pc.id];
      if (lastSeen !== undefined && day - lastSeen < DECAY_RECENT_DAYS) continue; // recently tended
      const template = this.templateFor(npcId);
      if (!template) continue; // no authored identity ⇒ no baseline to settle toward
      const next = driftToward(current, personalityBaseline(template), DECAY_STEP);
      if (next !== current) {
        ctx.apply({ type: "adjustRelationship", actorId: npcId, targetId: pc.id, by: next - current });
      }
    }
    this.cursorDay = day;
  }
}
