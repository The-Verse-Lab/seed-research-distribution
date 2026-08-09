/**
 * Travel-events module — DoL-style random events rolled on ARRIVAL at a new location.
 *
 * Runs on the tick's `react` phase, PLAYER-turn-scoped (a heartbeat never travels, and re-firing on
 * every heartbeat is the spam trap the events module already guards). On a detected arrival it rolls
 * the campaign's per-move `travelEventChance` and, on a hit, weighted-picks one eligible event from
 * `campaign.travelEvents` and expands its effects. All randomness is PRIVATE keyed rng (zero shared
 * draws → never shifts another seeded mechanic); the cursor (move counter + cooldown bookkeeping) is
 * persisted via the reducer's `modulePatch`, so fires replay identically and `once` survives reload.
 *
 * Narration rides the shared `ctx.data.eventBeats` array that EventsModule (registered just before)
 * emits in the narrate phase, so a courier or ambush lead-in prints like any authored beat. Mutation
 * flows only through enqueued reducer commands (one writer).
 *
 * @author Runkai Zhang
 */
import type { Campaign, Effect, TravelEvent, World } from "../../content/schema.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";
import { CAMP_LOCATION_ID } from "../../world/camp.ts";
import { CAPTIVITY_LOCATION_ID } from "../../world/captivity.ts";
import { LODGING_LOCATION_ID } from "../../world/lodging.ts";
import { isCombatActive } from "../../world/queries.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import type { Command } from "../../world/commands.ts";
import { evalPredicate, standardEvalLookups, type EvalLookups } from "../events/module.ts";
import { buildSpawnCommand, effectToCommands, nextSpawnId } from "../events/effect-to-command.ts";
import { abilityModifier } from "../../rules/dice.ts";
import {
  combatDroughtBonus,
  combatDroughtWeight,
  cooledDownByCounter,
  keyedCheck,
  keyedFireCheck,
  keyedWeightedPick,
  opensCombat,
} from "../../rules/travel-events.ts";
import { regionProfileOf } from "../../rules/regions.ts";

/** Persisted per-module cursor (WorldModel.modules.travelEvents). */
interface TravelCursor {
  /** Party location at the end of the previous tick (arrival detection). */
  lastLoc: string | null;
  /** Monotonic move counter — the private-rng salt + the cooldown clock. Bumped on each arrival. */
  moveCounter: number;
  /** The moveCounter at which ANY travel event last fired (reserved for a global floor; unused = 0). */
  lastFiredAt: number;
  /** Event ids fired with `once: "campaign"`. */
  firedCampaign: string[];
  /** eventId → moveCounter of its last fire (per-event `cooldownMoves`). */
  perEventLastFired: Record<string, number>;
  /**
   * Moves since a fight-opening event last fired — the drought counter behind `combatDroughtBonus`
   * / `combatDroughtWeight` (r11 F-10). Absent in an old save ⇒ 0, i.e. exactly the pre-drought odds.
   */
  quietMoves: number;
}

type AmbushEffect = Extract<Effect, { kind: "ambush" }>;



function readCursor(model: WorldModel): TravelCursor {
  const slice = model.modules.travelEvents as Partial<TravelCursor> | undefined;
  return {
    lastLoc: slice?.lastLoc ?? null,
    moveCounter: slice?.moveCounter ?? 0,
    lastFiredAt: slice?.lastFiredAt ?? 0,
    firedCampaign: [...(slice?.firedCampaign ?? [])],
    perEventLastFired: { ...(slice?.perEventLastFired ?? {}) },
    quietMoves: slice?.quietMoves ?? 0,
  };
}

export class TravelEventsModule implements TickModule {
  readonly id = "travel-events";
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
    const events = this.campaign.travelEvents;
    if (events.length === 0) return;
    // Player-turn-scoped: a heartbeat never travels (mirrors EventsModule's guard).
    if (ctx.trigger.kind !== "player") return;
    // No travel roll while a fight is live. A fight suppresses the whole roll; it re-arms once combat ends.
    if (isCombatActive(ctx.model)) return;
    const model = ctx.model;
    const partyLoc = partyLocationOf(model);
    const cursor = readCursor(model);
    // Travel events fire ONLY on a real traversal (a location change). No change ⇒ no roll, no write.
    const prevLoc = cursor.lastLoc;
    if (partyLoc === prevLoc) return;
    cursor.lastLoc = partyLoc;
    // Entering or leaving Camp (long rest), captivity, OR a rented room is a teleport, not a journey:
    // never roll a travel event on that transition. Camp is owned by CampEventsModule and the rented
    // room by RoomEventsModule; captivity is an exit-less hold. A road ambush or exploitation opener fired
    // on a teleport into the room would spawn a ROAD encounter inside the bedroom — bypassing both the
    // room roller's ownership and the shared-bunk safety (live-caught). Sync the cursor so the next
    // real traversal still detects a change, but don't bump the move counter or roll.
    if (
      partyLoc === CAMP_LOCATION_ID ||
      prevLoc === CAMP_LOCATION_ID ||
      partyLoc === CAPTIVITY_LOCATION_ID ||
      prevLoc === CAPTIVITY_LOCATION_ID ||
      partyLoc === LODGING_LOCATION_ID ||
      prevLoc === LODGING_LOCATION_ID
    ) {
      ctx.applySilent({ type: "modulePatch", module: "travelEvents", patch: { ...cursor } });
      ctx.data.persist = true;
      return;
    }
    if (prevLoc === null) {
      // First observation this campaign — seed the cursor, do NOT fire. A random travel event needs an
      // actual move (traversal), not the opening spawn-in; the first genuine move fires the first roll.
      ctx.applySilent({ type: "modulePatch", module: "travelEvents", patch: { ...cursor } });
      ctx.data.persist = true;
      return;
    }
    cursor.moveCounter += 1;
    const loc = partyLoc ?? "";

    // Per-move fire roll, then a weighted pick over the eligible set — both from private keyed rng.
    // The region's `eventRate` reshapes the THRESHOLD only; the rng key stays byte-stable
    // (`travel-fire:${loc}:${counter}`) so an unregioned world (rate 1) draws identically to before.
    //
    // THE DROUGHT (r11 F-10) rides on top, on the same two dials and nothing else: a long fightless
    // stretch raises the fire chance AND up-weights the fight-opening candidates. Four moves are
    // free, so a short town circuit is byte-identical to the pre-drought roller; a `quietMoves` of 0
    // (a fresh campaign, an old save) leaves both dials at their old values exactly.
    const droughtWeight = combatDroughtWeight(cursor.quietMoves);
    const chance = Math.max(
      0,
      Math.min(
        1,
        this.campaign.travelEventChance * regionProfileOf(this.world, loc).eventRate + combatDroughtBonus(cursor.quietMoves),
      ),
    );
    let fought = false;
    if (keyedFireCheck(chance, `travel-fire:${loc}:${cursor.moveCounter}`)) {
      const eligible = events.filter((ev) => this.eligible(ev, model, loc, cursor));
      const chosenId = keyedWeightedPick(
        // Weights are rounded so the bucket walk stays integral and a drought-boosted pool replays
        // identically; a non-combat event's weight is untouched.
        eligible.map((e) => ({ id: e.id, weight: opensCombat(e) ? Math.round(e.weight * droughtWeight) : e.weight })),
        `travel-pick:${loc}:${cursor.moveCounter}`,
      );
      const chosen = chosenId ? (eligible.find((e) => e.id === chosenId) ?? null) : null;
      if (chosen) {
        const before = ctx.queue.length;
        this.fire(chosen, model, ctx, cursor, loc);
        // What actually reached the queue, not what the event COULD have done: an ambush nested in
        // the losing branch of a keyed check never happened, and must not reset the pity timer.
        fought = ctx.queue.slice(before).some((cmd) => cmd.type === "startCombat");
      }
    }
    // A fight resets the pity timer; every other arrival extends it. Only the roller's OWN fights
    // reset it — a monster that aggroed on sight is the ambient-life module's business and has its
    // own counter, and double-counting would make the road quiet again for reasons the road never saw.
    cursor.quietMoves = fought ? 0 : cursor.quietMoves + 1;

    // Every arrival advances the cursor (moveCounter/lastLoc), paired with a persist so it can't be
    // lost on reload (which would re-roll a stale counter or re-fire a `once` event).
    ctx.applySilent({ type: "modulePatch", module: "travelEvents", patch: { ...cursor } });
    ctx.data.persist = true;
  }

  /** Whether an event may fire this move: `once`/cooldown clear, safety-gated, and its predicate holds. */
  private eligible(ev: TravelEvent, model: WorldModel, loc: string, cursor: TravelCursor): boolean {
    if (ev.once === "campaign" && cursor.firedCampaign.includes(ev.id)) return false;
    if (!cooledDownByCounter(cursor.perEventLastFired[ev.id], ev.cooldownMoves, cursor.moveCounter)) return false;
    return evalPredicate(ev.trigger, model, loc, undefined, this.lookups);
  }

  /** Mark bookkeeping and expand the chosen event's effects (narration + enqueued commands). */
  private fire(ev: TravelEvent, model: WorldModel, ctx: TickContext, cursor: TravelCursor, loc: string): void {
    if (ev.once === "campaign") cursor.firedCampaign.push(ev.id);
    cursor.perEventLastFired[ev.id] = cursor.moveCounter;
    cursor.lastFiredAt = cursor.moveCounter;
    const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
    const baseKey = `travel-check:${ev.id}:${loc}:${cursor.moveCounter}`;
    ev.effects.forEach((eff, index) => {
      this.expandEffect(eff, model, ctx, beats, index === 0 ? baseKey : `${baseKey}:${index}`);
    });
    ctx.data.eventBeats = beats; // EventsModule.onNarrate (registered just before) emits these.
  }

  private expandEffect(eff: Effect, model: WorldModel, ctx: TickContext, beats: string[], key: string): void {
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
      // Materialize the item straight into the recipient's pack (default: the player). from:null is
      // the reducer's "conjure into `to`" path (atomic; only the receiving side gets the stack).
      const to = eff.to ?? playerEntity(model)?.id ?? null;
      if (to) ctx.enqueue({ type: "transferItem", itemId: eff.itemId, from: null, to });
      return;
    }
    if (eff.kind === "check") {
      const mod = this.checkModifier(eff, model);
      const result = keyedCheck(mod, eff.dc, key);
      const branch = result.success ? eff.onSuccess : eff.onFail;
      const suffix = result.success ? "s" : "f";
      branch.forEach((branchEff, index) => this.expandEffect(branchEff, model, ctx, beats, `${key}:${suffix}:${index}`));
      return;
    }
    if (eff.kind === "ambush") {
      this.enqueueAmbush(eff, model, ctx);
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

  private enqueueAmbush(eff: AmbushEffect, model: WorldModel, ctx: TickContext): void {
    const locId = eff.locationId ?? partyLocationOf(model) ?? "";
    if (locId.trim().length === 0) return;
    const spawnId = nextSpawnId(model, eff.templateId, ctx.queue);
    ctx.enqueue(this.buildAmbushSpawn(model, eff, locId, spawnId));
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
