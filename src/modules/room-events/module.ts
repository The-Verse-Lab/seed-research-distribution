/**
 * Room-events module — the DoL-style overnight-intrusion roller for a RENTED ROOM (the hall-as-hub wave).
 *
 * The counterpart to CampEventsModule. It rolls a separate authored table (`campaign.roomEvents`, not
 * `travelEvents`) each turn the PC is bedded down
 * (`isAtLodging`), keeps its OWN persisted cursor (module `"roomEvents"`) and its OWN private-rng key
 * namespace (`room-fire:` / `room-pick:`), so it never double-fires with — or perturbs the seed stream
 * of — the traversal/camp rollers.
 *
 * An ambush fires only for a private tier; a shared bunk neutralizes it. Predicates are evaluated
 * against the hall (the district where the player slept), not the synthetic room.
 *
 * Mutation flows only through enqueued reducer commands (one writer); narration rides the shared
 * `ctx.data.eventBeats` array that EventsModule emits in the narrate phase. All randomness is private
 * keyed rng (zero shared draws → replay-safe).
 *
 * @author Runkai Zhang
 */
import type { Campaign, Effect, TravelEvent, World } from "../../content/schema.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";
import { LODGING_LOCATION_ID, isAtLodging, readLodgingSlice } from "../../world/lodging.ts";
import { isCombatActive } from "../../world/queries.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import type { Command } from "../../world/commands.ts";
import { evalPredicate, standardEvalLookups, type EvalLookups } from "../events/module.ts";
import { buildSpawnCommand, effectToCommands, nextSpawnId } from "../events/effect-to-command.ts";
import { abilityModifier } from "../../rules/dice.ts";
import { cooledDownByCounter, keyedCheck, keyedFireCheck, keyedWeightedPick } from "../../rules/travel-events.ts";
import { MONSTER_SEEN_MODULE } from "../combat/module.ts";

type AmbushEffect = Extract<Effect, { kind: "ambush" }>;

/** Persisted per-module cursor (WorldModel.modules.roomEvents). */
interface RoomCursor {
  /** Monotonic room-turn counter — the private-rng salt + the cooldown clock. Bumped each lodging turn. */
  turnCounter: number;
  /** The turnCounter at which ANY room event last fired (reserved for a global floor; unused = 0). */
  lastFiredAt: number;
  /** Event ids fired with `once: "campaign"`. */
  firedCampaign: string[];
  /** eventId → turnCounter of its last fire (per-event `cooldownMoves`). */
  perEventLastFired: Record<string, number>;
}


/** Whether an effect tree contains an ambush intrusion (neutralized for a shared bunk). */
function containsIntrusion(eff: Effect): boolean {
  if (eff.kind === "ambush") return true;
  if (eff.kind === "check") return eff.onSuccess.some(containsIntrusion) || eff.onFail.some(containsIntrusion);
  return false;
}

function readCursor(model: WorldModel): RoomCursor {
  const slice = model.modules.roomEvents as Partial<RoomCursor> | undefined;
  return {
    turnCounter: slice?.turnCounter ?? 0,
    lastFiredAt: slice?.lastFiredAt ?? 0,
    firedCampaign: [...(slice?.firedCampaign ?? [])],
    perEventLastFired: { ...(slice?.perEventLastFired ?? {}) },
  };
}

export class RoomEventsModule implements TickModule {
  readonly id = "room-events";
  readonly phases: TickModule["phases"];
  private readonly lookups: EvalLookups;

  constructor(
    private readonly world: World,
    private readonly campaign: Campaign,
  ) {
    this.lookups = standardEvalLookups(world, campaign.characters);
    this.phases = { react: (ctx) => this.onReact(ctx) };
  }

  private onReact(ctx: TickContext): void {
    const events = this.campaign.roomEvents;
    if (events.length === 0) return;
    // Player-turn-scoped: a heartbeat never rolls (mirrors the other event rollers).
    if (ctx.trigger.kind !== "player") return;
    const model = ctx.model;
    // Only rolls while the PC is bedded down in a rented room — the whole trigger surface.
    if (!isAtLodging(model)) return;
    // A fight owns the turn; never re-roll an intrusion while it is underway.
    if (isCombatActive(model)) return;
    const slice = readLodgingSlice(model);
    // Predicates read the DISTRICT the PC slept in (region danger), not the region-less synthetic room.
    const evalLoc = slice.hallId ?? "";
    const cursor = readCursor(model);
    cursor.turnCounter += 1;
    const key = `${LODGING_LOCATION_ID}:${cursor.turnCounter}`;

    if (keyedFireCheck(this.campaign.roomEventChance, `room-fire:${key}`)) {
      const eligible = events.filter((ev) => this.eligible(ev, model, evalLoc, cursor, slice.private));
      const chosenId = keyedWeightedPick(
        eligible.map((e) => ({ id: e.id, weight: e.weight })),
        `room-pick:${key}`,
      );
      const chosen = chosenId ? (eligible.find((e) => e.id === chosenId) ?? null) : null;
      if (chosen) this.fire(chosen, model, ctx, cursor, evalLoc, slice.private);
    }

    // Every lodging turn advances the cursor, paired with a persist so it survives reload.
    ctx.applySilent({ type: "modulePatch", module: "roomEvents", patch: { ...cursor } });
    ctx.data.persist = true;
  }

  /** Whether an event may fire this turn: `once`/cooldown clear, tier-gated, safety-gated, predicate holds. */
  private eligible(ev: TravelEvent, model: WorldModel, loc: string, cursor: RoomCursor, isPrivate: boolean): boolean {
    if (ev.once === "campaign" && cursor.firedCampaign.includes(ev.id)) return false;
    if (!cooledDownByCounter(cursor.perEventLastFired[ev.id], ev.cooldownMoves, cursor.turnCounter)) return false;
    // A shared bunk is safe: an event whose ONLY payload is an intrusion is filtered out entirely; a
    // mixed event still fires (its benign effects play, its intrusion is neutralized at expand time).
    if (!isPrivate && ev.effects.every(containsIntrusion)) return false;
    return evalPredicate(ev.trigger, model, loc, undefined, this.lookups);
  }

  /** Mark bookkeeping and expand the chosen event's effects (narration + enqueued commands). */
  private fire(ev: TravelEvent, model: WorldModel, ctx: TickContext, cursor: RoomCursor, loc: string, isPrivate: boolean): void {
    if (ev.once === "campaign") cursor.firedCampaign.push(ev.id);
    cursor.perEventLastFired[ev.id] = cursor.turnCounter;
    cursor.lastFiredAt = cursor.turnCounter;
    const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
    const baseKey = `room-check:${ev.id}:${cursor.turnCounter}`;
    ev.effects.forEach((eff, index) => {
      this.expandEffect(eff, model, ctx, beats, index === 0 ? baseKey : `${baseKey}:${index}`, isPrivate);
    });
    ctx.data.eventBeats = beats; // EventsModule.onNarrate emits these.
  }

  private expandEffect(eff: Effect, model: WorldModel, ctx: TickContext, beats: string[], key: string, isPrivate: boolean): void {
    if (eff.kind === "narrate") {
      beats.push(eff.text);
      return;
    }
    if (eff.kind === "adjustCoins") {
      const target = eff.target ?? playerEntity(model)?.id ?? null;
      if (target) ctx.enqueue({ type: "adjustCoins", entityId: target, by: eff.by });
      return;
    }
    if (eff.kind === "adjustEnergy") {
      const target = eff.target ?? playerEntity(model)?.id ?? null;
      if (target) ctx.enqueue({ type: "adjustEnergy", entityId: target, by: eff.by });
      return;
    }
    if (eff.kind === "adjustExhaustion") {
      const target = eff.target ?? playerEntity(model)?.id ?? null;
      if (target) ctx.enqueue({ type: "adjustExhaustion", entityId: target, by: eff.by });
      return;
    }
    if (eff.kind === "giveItem") {
      const to = eff.to ?? playerEntity(model)?.id ?? null;
      if (to) ctx.enqueue({ type: "transferItem", itemId: eff.itemId, from: null, to });
      return;
    }
    if (eff.kind === "check") {
      const mod = this.checkModifier(eff, model);
      const result = keyedCheck(mod, eff.dc, key);
      const branch = result.success ? eff.onSuccess : eff.onFail;
      const suffix = result.success ? "s" : "f";
      branch.forEach((branchEff, index) => this.expandEffect(branchEff, model, ctx, beats, `${key}:${suffix}:${index}`, isPrivate));
      return;
    }
    if (eff.kind === "ambush") {
      // A break-in fight — only in a PRIVATE room; a shared bunk neutralizes it (like camp).
      if (isPrivate) this.enqueueAmbush(eff, model, ctx, beats);
      return;
    }
    // Shared single-command kinds (setFlag/setQuestState/setObjectiveDone/adjustRelationship/adjustHp/setCondition/spawn).
    for (const cmd of effectToCommands(eff, this.world, model, ctx.queue, this.campaign)) ctx.enqueue(cmd);
  }

  private checkModifier(eff: Extract<Effect, { kind: "check" }>, model: WorldModel): number {
    const pc = playerEntity(model);
    const statBlock = pc ? this.campaign.characters.find((c) => c.id === pc.id)?.stats : undefined;
    const score = statBlock?.abilities[eff.ability] ?? 10;
    return abilityModifier(score) + (eff.bonus ?? 0);
  }

  private enqueueAmbush(eff: AmbushEffect, model: WorldModel, ctx: TickContext, beats: string[]): void {
    const locId = LODGING_LOCATION_ID;
    const spawnId = nextSpawnId(model, eff.templateId, ctx.queue);
    const spawn = this.buildAmbushSpawn(model, eff, locId, spawnId);
    ctx.enqueue(spawn);
    // Interior-intrusion telegraph (r3 P3: a fight hard-cut into a social interior with no beat of
    // warning, and the menace chip never had a pre-combat frame to render in). A MONSTER intruder
    // spawns THIS tick with an approach beat — it lands on the Present board (threat band and all)
    // — and the existing once-per-monster on-sight aggro opens the fight on the player's NEXT turn,
    // intruder first. An NPC-template ambusher keeps the same-tick start: `tryMonsterAggro` skips
    // NPCs, so splitting would strand a peaceful-looking intruder in the room forever.
    const isMonsterIntruder = spawn.type === "spawnEntity" && spawn.entity.kind === "monster";
    if (isMonsterIntruder) {
      const name = spawn.type === "spawnEntity" ? spawn.entity.name : (eff.name ?? eff.templateId);
      beats.push(`${name} is in the room — between you and the door, a breath from violence.`);
      // This beat IS the telegraph — mark the spawn seen so the combat module's generalized
      // interior-ambush telegraph (r4) does not warn twice; on-sight aggro opens next turn.
      ctx.enqueue({ type: "modulePatch", module: MONSTER_SEEN_MODULE, patch: { [spawnId]: true } });
      return;
    }
    const partyOrder = entitiesAt(model, locId)
      .filter((e) => e.partyMember && e.id !== spawnId && (e.stats?.currentHp ?? 1) > 0)
      .map((e) => e.id);
    ctx.enqueue({
      type: "startCombat",
      locationId: locId,
      order: [spawnId, ...partyOrder],
      round: 1,
      turnIndex: partyOrder.length > 0 ? 1 : 0,
    });
  }

  private buildAmbushSpawn(model: WorldModel, eff: AmbushEffect, locationId: string, spawnId: string): Command {
    const hasTemplate = this.world.monsters.some((m) => m.id === eff.templateId) || this.world.npcs.some((n) => n.id === eff.templateId);
    if (hasTemplate) {
      return buildSpawnCommand(this.world, model, { templateId: eff.templateId, locationId, tier: eff.tier, id: spawnId, hp: eff.hp, name: eff.name });
    }
    const hp = eff.hp ?? 11;
    return {
      type: "spawnEntity",
      entity: {
        id: spawnId,
        kind: "monster",
        tier: eff.tier,
        name: eff.name ?? eff.templateId,
        locationId,
        templateId: eff.templateId,
        stats: { currentHp: hp, maxHp: hp },
      },
    };
  }
}
