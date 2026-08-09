/**
 * NPC-events module — personal random events around scheduled NPCs, and the rumor mill.
 *
 * One roll pass per (day, phase) on player ticks: for each NPC template carrying `events`, a
 * private keyed fire-check per eligible event and one keyed weighted pick — at most one event per
 * NPC per phase, replay-identical (src/rules/npc-events.ts). A `"co-located"` event is eligible
 * only while the player shares the NPC's EFFECTIVE location (routine override > slot > live
 * position) and plays out NOW: narrate beats ride the shared `eventBeats` array, checks roll
 * keyed against the PC, ambushes mirror the travel-events hand-off, everything else
 * expands through `effectToCommand` into the commit queue. An `"anywhere"` event applies its
 * effects offstage and queues each narrate text as a day-stamped RUMOR.
 *
 * Rumors drain ONE per player turn while the party stands at a social venue (a present vendor,
 * or a scheduled NPC in a `venue: true` slot) — "Talk at The Stone Cup: …".
 *
 * `routineOverride` effects accumulate into a single routines modulePatch (habit-break signal:
 * the pinned NPC leaves their learned haunts for N days) plus an immediate offstage relocation.
 *
 * Fully INERT in a world where no template authors `events`. One writer holds: every mutation is
 * an enqueued command or an `applySilent` modulePatch.
 *
 * @author Runkai Zhang
 */
import type { Campaign, Condition, DayPhase, Effect, NpcEvent, NpcTemplate, World } from "../../content/schema.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";
import { isCombatActive } from "../../world/queries.ts";
import { CAMP_LOCATION_ID } from "../../world/camp.ts";
import { CAPTIVITY_LOCATION_ID } from "../../world/captivity.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import { dayPhaseOf } from "../../agents/context.ts";
import { abilityModifier } from "../../rules/dice.ts";
import { keyedCheck } from "../../rules/travel-events.ts";
import {
  eligibleNpcEvents,
  isInteractiveEffect,
  isSocialVenue,
  npcEventKey,
  pushRumor,
  readNpcEventsSlice,
  rollNpcEvent,
  type NpcEventsSlice,
} from "../../rules/npc-events.ts";
import {
  dayOf,
  effectiveScheduleOf,
  phaseKeyOf,
  readRoutinesSlice,
  resolveRoutineTarget,
  type RoutineOverride,
} from "../../rules/routine.ts";
import { MONSTER_SEEN_MODULE } from "../combat/module.ts";
import { evalPredicate, standardEvalLookups, type EvalLookups } from "../events/module.ts";
import { buildSpawnCommand, effectToCommands, nextSpawnId } from "../events/effect-to-command.ts";
import { isRoutineSuspended } from "../routines/module.ts";

export class NpcEventsModule implements TickModule {
  readonly id = "npc-events";
  /** After events (owns the eventBeats array) and routines (this phase's overrides are current). */
  readonly after = ["core", "events", "routines"];
  readonly phases: TickModule["phases"];
  /** Templates carrying personal events — the inertness guard and the roll work-list. */
  private readonly eventful: Map<string, NpcTemplate>;
  private readonly lookups: EvalLookups;

  constructor(
    private readonly world: World,
    private readonly campaign: Campaign,
  ) {
    this.eventful = new Map(world.npcs.filter((n) => n.events && n.events.length > 0).map((n) => [n.id, n]));
    // The COMPLETE bundle (regex audit §10d): this used to omit `occupiedOf`, so an `attireState`
    // clause on a personal-event trigger was judged against all six coverage slots instead of the
    // character's own. No shipped world authors one today, so this is inert-but-correct.
    this.lookups = standardEvalLookups(world, campaign.characters);
    this.phases = { react: (ctx) => this.onReact(ctx) };
  }

  private onReact(ctx: TickContext): void {
    if (this.eventful.size === 0) return; // inert: an event-less world writes nothing, ever
    if (ctx.trigger.kind !== "player") return;
    if (isCombatActive(ctx.model)) return; // no offstage drama mid-fight; re-rolls after

    const model = ctx.model;
    const day = dayOf(model.clock);
    const phase = dayPhaseOf(model.clock) as DayPhase;
    const phaseKey = phaseKeyOf(day, phase);
    const slice = readNpcEventsSlice(model.modules);
    const partyLoc = partyLocationOf(model);
    const atRealLoc = partyLoc !== null && partyLoc !== CAMP_LOCATION_ID && partyLoc !== CAPTIVITY_LOCATION_ID;
    const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
    const beatCountBefore = beats.length;
    let changed = false;

    // --- roll pass: once per (day, phase) --------------------------------------
    if (slice.lastRolledKey !== phaseKey) {
      const firstBoot = slice.lastRolledKey === null;
      slice.lastRolledKey = phaseKey;
      changed = true;
      if (!firstBoot) {
        // First boot only seeds the cursor — the opening turn stays the authored scene.
        const overrides: Record<string, RoutineOverride> = {};
        const routines = readRoutinesSlice(model.modules);
        const condsHold = (conditions: Condition[]): boolean =>
          evalPredicate({ allOf: conditions }, model, partyLoc, undefined, this.lookups);
        for (const [npcId, template] of this.eventful) {
          const entity = model.entities.get(npcId);
          if (!entity || isRoutineSuspended(model, entity)) continue;
          const effLoc = this.effectiveLocOf(npcId, template, day, phase, routines, model, condsHold);
          const coLocated = atRealLoc && effLoc === partyLoc;
          const eligible = eligibleNpcEvents(template.events ?? [], npcId, day, phase, {
            coLocated,
            firedCampaign: slice.firedCampaign,
            lastFiredDay: slice.lastFiredDay,
            predHolds: (trigger) => evalPredicate(trigger, model, partyLoc, undefined, this.lookups),
          });
          const chosen = rollNpcEvent(npcId, eligible, day, phase);
          if (!chosen) continue;
          this.fire(ctx, npcId, chosen, day, phase, coLocated, beats, slice, overrides);
        }
        this.applyOverrides(ctx, overrides, day);
      }
    }

    // --- rumor drain: one per player turn at a social venue ---------------------
    //
    // THE RUMOR IS THE NARRATOR'S, NOT A PRINTED LINE (r11 F-12, owner decision 2026-08-01).
    // It used to be pushed as its own event beat — `You overhear talk at Anchorfall: "…"` — which
    // printed above the GM's prose AND rode into the brief as an already-shown fact. The r11 sweep
    // caught the narrator re-dramatizing the same rumor verbatim inside its own paragraph (the
    // player read one fact twice in a turn), and a rumor opening a turn where the player had asked a
    // direct question read as the channel talking over them. So the deterministic print is gone: the
    // rumor is handed to the GM as material to WEAVE into the scene, once, in its own voice.
    //
    // Drained ONLY when the narrator will actually run this turn — a deterministic (already
    // player-facing) intent skips the model entirely, and draining into a brief nobody builds would
    // silently eat the rumor. It simply waits for the next venue turn that does reach the GM.
    if (slice.rumors.length > 0 && atRealLoc) {
      const intent = ctx.data.narration as { deterministic?: boolean } | undefined;
      const narratorWillRun = intent !== undefined && intent.deterministic !== true;
      const present = entitiesAt(model, partyLoc).filter((e) => e.id !== playerEntity(model)?.id);
      const venues = readRoutinesSlice(model.modules).venues;
      if (narratorWillRun && isSocialVenue(present, this.world, venues)) {
        const rumor = slice.rumors.shift()!;
        ctx.data.overheard = { place: this.locName(partyLoc), text: rumor.text };
        changed = true;
      }
    }

    if (beats.length > beatCountBefore) ctx.data.eventBeats = beats;
    if (changed) {
      ctx.applySilent({ type: "modulePatch", module: "npcEvents", patch: { ...slice } });
      ctx.data.persist = true;
    }
  }

  /** Where the NPC effectively is this phase: routine target (override > slot > default) or live position. */
  private effectiveLocOf(
    npcId: string,
    template: NpcTemplate,
    day: number,
    phase: DayPhase,
    routines: ReturnType<typeof readRoutinesSlice>,
    model: WorldModel,
    condsHold: (conditions: Condition[]) => boolean,
  ): string | null {
    const entity = model.entities.get(npcId);
    if (!entity) return null;
    const schedule = effectiveScheduleOf(template, this.world);
    if (!schedule) return entity.locationId;
    const override = routines.overrides[npcId];
    const active = override && day < override.untilDay ? override : undefined;
    const target = resolveRoutineTarget(npcId, schedule, day, phase, active, condsHold);
    return target.locationId ?? entity.locationId;
  }

  /** Mark bookkeeping and expand the chosen event's effects (on-screen or offstage). */
  private fire(
    ctx: TickContext,
    npcId: string,
    ev: NpcEvent,
    day: number,
    phase: DayPhase,
    coLocated: boolean,
    beats: string[],
    slice: NpcEventsSlice,
    overrides: Record<string, RoutineOverride>,
  ): void {
    const key = npcEventKey(npcId, ev.id);
    if (ev.once === "campaign") slice.firedCampaign.push(key);
    slice.lastFiredDay[key] = day;
    const baseKey = `npc-event-check:${npcId}:${ev.id}:${day}:${phase}`;
    ev.effects.forEach((eff, index) => {
      this.expandEffect(ctx, npcId, eff, ev.scope, coLocated, day, beats, slice, overrides, `${baseKey}:${index}`);
    });
  }

  private expandEffect(
    ctx: TickContext,
    npcId: string,
    eff: Effect,
    scope: NpcEvent["scope"],
    coLocated: boolean,
    day: number,
    beats: string[],
    slice: NpcEventsSlice,
    overrides: Record<string, RoutineOverride>,
    key: string,
  ): void {
    const model = ctx.model;
    const onScreen = scope === "co-located" && coLocated;
    if (eff.kind === "narrate") {
      if (onScreen) beats.push(eff.text);
      else slice.rumors = pushRumor(slice.rumors, { day, text: eff.text });
      return;
    }
    if (eff.kind === "routineOverride") {
      overrides[eff.npcId ?? npcId] = {
        locationId: eff.locationId,
        ...(eff.activity !== undefined ? { activity: eff.activity } : {}),
        untilDay: day + eff.days,
      };
      return;
    }
    // Interactive effects never run offstage — the loader forbids authoring them on `"anywhere"`
    // events; this is the defensive belt for a co-located event rolled with the player elsewhere
    // (unreachable today: co-location is an eligibility gate) and for hand-edited content.
    if (!onScreen && isInteractiveEffect(eff)) return;
    if (eff.kind === "check") {
      const result = keyedCheck(this.checkModifier(eff, model), eff.dc, key);
      const branch = result.success ? eff.onSuccess : eff.onFail;
      const suffix = result.success ? "s" : "f";
      branch.forEach((branchEff, index) =>
        this.expandEffect(ctx, npcId, branchEff, scope, coLocated, day, beats, slice, overrides, `${key}:${suffix}:${index}`),
      );
      return;
    }
    if (eff.kind === "ambush") {
      const locId = eff.locationId ?? partyLocationOf(model) ?? "";
      if (locId.trim().length === 0) return;
      const spawnId = nextSpawnId(model, eff.templateId, ctx.queue);
      const spawn = buildSpawnCommand(this.world, model, { templateId: eff.templateId, locationId: locId, tier: eff.tier, id: spawnId, hp: eff.hp, name: eff.name });
      ctx.enqueue(spawn);
      // Interior-intrusion telegraph (r3 P3: a Salt Revenant hard-cut into a mid-parley interior
      // with no beat of warning): a MONSTER intruder spawns THIS tick with an approach beat — it
      // lands on the Present board with its threat band — and the existing once-per-monster
      // on-sight aggro opens the fight on the player's NEXT turn, intruder first. An NPC-template
      // ambusher keeps the same-tick start (`tryMonsterAggro` skips NPCs; splitting would strand
      // a hostile stranger standing peacefully in the room).
      if (spawn.type === "spawnEntity" && spawn.entity.kind === "monster") {
        if (onScreen) beats.push(`${spawn.entity.name} is on you — no words, a breath from violence.`);
        // This beat IS the telegraph: mark the spawn seen so the combat module's generalized
        // interior-ambush telegraph (r4) does not warn about the same intruder a second time —
        // its on-sight aggro opens the fight next turn exactly as before.
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
      return;
    }
    for (const cmd of effectToCommands(eff, this.world, model, ctx.queue, this.campaign)) ctx.enqueue(cmd);
  }

  /** Accumulated routine pins: one routines modulePatch + an immediate offstage relocation each. */
  private applyOverrides(ctx: TickContext, overrides: Record<string, RoutineOverride>, day: number): void {
    void day;
    const ids = Object.keys(overrides);
    if (ids.length === 0) return;
    const routines = readRoutinesSlice(ctx.model.modules);
    for (const id of ids) {
      const pin = overrides[id]!;
      routines.overrides[id] = pin;
      if (pin.activity) routines.activity[id] = pin.activity;
      delete routines.venues[id];
      const entity = ctx.model.entities.get(id);
      if (entity && entity.locationId !== pin.locationId && !isRoutineSuspended(ctx.model, entity)) {
        ctx.enqueue({ type: "moveEntity", entityId: id, to: pin.locationId, teleport: true });
      }
    }
    ctx.applySilent({ type: "modulePatch", module: "routines", patch: { ...routines } });
    ctx.data.persist = true;
  }

  private checkModifier(eff: Extract<Effect, { kind: "check" }>, model: WorldModel): number {
    const pc = playerEntity(model);
    const statBlock = pc ? this.campaign.characters.find((c) => c.id === pc.id)?.stats : undefined;
    const score = statBlock?.abilities[eff.ability] ?? 10;
    return abilityModifier(score) + (eff.bonus ?? 0);
  }

  private locName(id: string): string {
    return this.world.locations.find((l) => l.id === id)?.name ?? id;
  }
}
