/**
 * Events module — authored trigger→effect beats, evaluated each tick.
 *
 * Scripted beats become deterministic data the LLM only *narrates* — the biggest reducer of
 * emergent edge-case surface. The evaluator runs on the tick's `react` phase: select beats by
 * `when` + entry, test the (pure) trigger predicate against the model, respect `once` via the
 * module's own cursor (persisted in WorldModel.modules.events), then expand effects → enqueue
 * commands (applied at commit) + collect narration. Beats narrate on the `narrate` phase, after
 * the player's narration (`after: ["narration"]`), so a scripted line follows the action.
 *
 * @author Runkai Zhang
 */
import type { Campaign, Character, Condition, Effect, PrebakedEvent, TriggerPredicate, World } from "../../content/schema.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import { recordTurnEvent } from "../../agents/context.ts";
import { effectToCommands } from "./effect-to-command.ts";
import { abilityModifier } from "../../rules/dice.ts";
import { keyedCheck } from "../../rules/travel-events.ts";
import { attireStateOf, WARDROBE_MODULE, type WardrobeSlice, type WardrobeSlotId } from "../../rules/wardrobe.ts";
import { occupiedCoverageOf } from "../../rules/visible-state.ts";
import { regionOfLocation, regionProfileOf } from "../../rules/regions.ts";
import { dayPhaseOf } from "../../agents/context.ts";
import { livingCompanionsWithPc } from "../../world/queries.ts";
import { factionStandingOf } from "../../rules/factions.ts";

/**
 * Coverage-occupancy lookup for `attireState` clauses — the SAME baseline the brief's `Attire:`
 * line and the status-effects module judge "bare" against, so an authored `attireState: "bare"`
 * event fires on the very strip the player just read as bare. `undefined` (no sheet for the id)
 * keeps {@link attireStateOf}'s conservative all-slots read.
 */
export type OccupiedCoverageLookup = (entityId: string) => ReadonlySet<WardrobeSlotId> | undefined;

/** Build the standard {@link OccupiedCoverageLookup} over a campaign's character sheets. */
export function occupiedLookupOf(characters: readonly Character[]): OccupiedCoverageLookup {
  return (entityId) => occupiedCoverageOf(characters.find((c) => c.id === entityId));
}

/** The `WorldModel.modules` key holding {@link EventsCursor} — this module owns it. */
export const EVENTS_MODULE = "events";

/** The `once` bookkeeping for authored beats. Exported so the OTHER path that fires authored
 *  `onEnterLocation` events — an errand landing offstage at a destination the party never entered
 *  (src/modules/errands/module.ts) — consumes the same cursor rather than re-firing `once` beats. */
export interface EventsCursor {
  /** Beat ids fired with `once: campaign`. */
  fired: string[];
  /** Beat ids fired with `once: visit` (cleared on each location change). */
  visitFired: string[];
  /** Party location at the end of the previous tick (for entry detection). */
  lastLoc: string | null;
}

interface InteractionUse {
  interactionId: string;
  locationId?: string;
}

/** Read the cursor as a fresh, detached COPY — callers mutate it freely and hand the whole thing
 *  back through a `modulePatch` command, so model state is only ever written by the reducer. */
export function readEventsCursor(model: WorldModel): EventsCursor {
  const slice = model.modules[EVENTS_MODULE] as Partial<EventsCursor> | undefined;
  return {
    fired: [...(slice?.fired ?? [])],
    visitFired: [...(slice?.visitFired ?? [])],
    lastLoc: slice?.lastLoc ?? null,
  };
}

/** Resolve the party's current location to its region id (src/rules/regions.ts `regionOfLocation`). */
export type RegionLookup = (locationId: string | null) => string | undefined;

/** Resolve the party's current location to its effective region DANGER (`regionProfileOf(...).danger`,
 *  world-danger fallback). Same fail-closed contract as {@link RegionLookup}: a caller that owns no
 *  world can never match a `regionDangerAtLeast` gate. */
export type DangerLookup = (locationId: string | null) => number | undefined;

/** Build the standard {@link DangerLookup} over a world's region fabric. Region danger is static
 *  authored content, so each resolved location is cached for the lookup's lifetime. */
export function dangerLookupOf(world: World): DangerLookup {
  const cache = new Map<string, number>();
  return (id) => {
    if (id === null) return undefined;
    let danger = cache.get(id);
    if (danger === undefined) {
      danger = regionProfileOf(world, id).danger;
      cache.set(id, danger);
    }
    return danger;
  };
}

/**
 * The optional resolvers a predicate evaluation may need, bundled so a new condition kind adds a
 * KEY here instead of another positional parameter at every call site. Each lookup keeps the same
 * fail-closed contract: absent ⇒ its condition kind never matches.
 */
export interface EvalLookups {
  occupiedOf?: OccupiedCoverageLookup;
  regionOf?: RegionLookup;
  dangerOf?: DangerLookup;
}

/**
 * THE complete bundle, for any caller that holds the world + its characters. Two seams in `src/`
 * deliberately do NOT use it, and both are subsets on purpose: `camp-events` evaluates at the
 * synthetic `__camp__` location, which has no region at all, and `RoutineModule` is constructed
 * from the world alone (no campaign ⇒ no character sheets ⇒ no `occupiedOf`). Everything else —
 * events, npc-events, room-events, travel-events, errands, both `Exit.barrier` seams and the work
 * gate — asks here.
 *
 * WHY THIS EXISTS (regex audit §10d, 2026-07-28). Each seam used to hand-assemble its own bundle,
 * and the two `Exit.barrier` seams — `autonomy/grounding.ts` `canOpenBarrier` and the engine's
 * `resolveBarredMove` — assembled only `{ regionOf }`. Because every lookup is fail-closed, that
 * silently sealed two whole condition kinds shut. Reproduced on the thistledown fixture, where
 * `loc.green` sits in a region of danger 1: an iron gate whose barrier condition is
 * `regionDangerAtLeast: 0` offered ZERO open candidates and grounded to speech, forever, with no
 * error — while the identical gate on `clockAtLeast: 0` opened. An `attireState: "bare"` clause was
 * the same story one step removed: without `occupiedOf` the read fell back to all six coverage
 * slots, so a stripped two-garment PC that every other surface (the brief's `Attire:` line, the
 * social read, authored events) reports as "bare" read "disheveled" at the barrier alone.
 *
 * So: a NEW key on {@link EvalLookups} must be filled in HERE, and a seam should reach for this
 * rather than hand-rolling a subset.
 */
export function standardEvalLookups(world: World, characters: readonly Character[]): EvalLookups {
  return {
    occupiedOf: occupiedLookupOf(characters),
    regionOf: (id) => regionOfLocation(world, id),
    dangerOf: dangerLookupOf(world),
  };
}

/** Evaluate a single predicate clause against the model. Pure. */
function evalCondition(
  c: Condition,
  model: WorldModel,
  partyLoc: string | null,
  interaction?: InteractionUse,
  lookups: EvalLookups = {},
): boolean {
  switch (c.kind) {
    case "atLocation":
      return partyLoc === c.locationId;
    case "inRegion":
      // Fail-closed: a caller that owns no world (no resolver) can never match an `inRegion` gate.
      // No existing content authors `inRegion`, so absent-resolver evaluations are unchanged.
      return lookups.regionOf?.(partyLoc) === c.regionId;
    case "questState":
      return model.quests.get(c.questId) === c.state;
    case "flag":
      return c.equals === undefined ? Boolean(model.flags[c.key]) : model.flags[c.key] === c.equals;
    case "hasItem":
      return model.entities.get(c.entityId)?.stats?.inventory.includes(c.itemId) ?? false;
    case "relationshipAtLeast":
      return (model.relationships.get(c.actorId)?.get(c.targetId) ?? 0) >= c.value;
    case "factionStandingAtLeast": {
      const pcId = playerEntity(model)?.id;
      return pcId !== undefined && factionStandingOf(model.modules, pcId, c.factionId) >= c.value;
    }
    case "clockAtLeast":
      return model.clock >= c.minutes;
    case "entityPresent":
      return entitiesAt(model, c.locationId ?? partyLoc ?? "").some((e) => e.id === c.entityId);
    case "workedOpportunity": {
      const slice = model.modules.workHistory as { opportunities?: Record<string, number> } | undefined;
      return (slice?.opportunities?.[c.opportunityId] ?? 0) >= c.countAtLeast;
    }
    case "interactionUsed":
      return (
        interaction?.interactionId === c.interactionId &&
        (c.locationId === undefined || interaction.locationId === c.locationId)
      );
    case "attireState": {
      const entityId = c.entityId ?? playerEntity(model)?.id ?? null;
      if (!entityId) return false;
      const wardrobe = model.modules[WARDROBE_MODULE] as WardrobeSlice | undefined;
      return attireStateOf(wardrobe?.[entityId], lookups.occupiedOf?.(entityId)) === c.state;
    }
    // --- Vulnerability signals (Phase 2) — each reuses an existing runtime computation. ---
    case "dayPhase":
      return (c.phases as string[]).includes(dayPhaseOf(model.clock));
    case "partyAlone":
      return livingCompanionsWithPc(model) === 0;
    case "regionDangerAtLeast": {
      // Fail-closed like `inRegion`: a caller that owns no world (no danger resolver) never matches.
      const danger = lookups.dangerOf?.(partyLoc);
      return danger !== undefined && danger >= c.value;
    }
  }
}

/** Whether every clause of a trigger predicate holds against the model. Pure. */
export function evalPredicate(
  p: TriggerPredicate,
  model: WorldModel,
  partyLoc: string | null,
  interaction?: InteractionUse,
  lookups?: EvalLookups,
): boolean {
  return p.allOf.every((c) => evalCondition(c, model, partyLoc, interaction, lookups));
}

export class EventsModule implements TickModule {
  readonly id = "events";
  // (Workstream C slim: the GM now runs last — narration declares `after: ["events", ...]`,
  // so beat narration PRECEDES the player's GM prose. The old `after: ["narration"]` would cycle.)
  readonly phases: TickModule["phases"];

  private readonly lookups: EvalLookups;
  /** Player sheets for the PC's `check` modifier + wardrobe occupancy (derived from the campaign). */
  private readonly characters: readonly Character[];

  constructor(
    private readonly events: PrebakedEvent[],
    private readonly world: World,
    /** The campaign — needed to resolve `revealCaseFact` effects (its `cases`) and the PC sheets.
     *  Optional so the deterministic module unit test can construct an event-only module. */
    private readonly campaign?: Campaign,
  ) {
    this.characters = campaign?.characters ?? [];
    this.lookups = standardEvalLookups(world, this.characters);
    this.phases = { react: (ctx) => this.onReact(ctx), narrate: (ctx) => this.onNarrate(ctx) };
  }

  private onReact(ctx: TickContext): void {
    if (this.events.length === 0) return;
    // Prebaked beats are PLAYER-turn-scoped: they narrate "after the action" (see the module header),
    // and entry detection only matters on player movement. Evaluating them on every NPC heartbeat tick
    // re-ran level-triggered `onTick` beats several times per turn — the hunger-event spam that buried
    // all prose in the 2026-07-05 Black Concord playtest. A heartbeat never enters a location or takes
    // a player action, so it has no business firing an authored beat.
    if (ctx.trigger.kind !== "player") return;
    const model = ctx.model;
    const partyLoc = partyLocationOf(model);
    const cursor = readEventsCursor(model);
    const interaction = ctx.data.locationInteraction as InteractionUse | undefined;
    const entered = partyLoc !== cursor.lastLoc;
    if (entered) {
      cursor.visitFired = [];
      cursor.lastLoc = partyLoc;
    }

    // Seed from any beats an earlier-registered module already parked this tick (the combat
    // module's r4 interior-ambush telegraph resolves BEFORE this module) — assigning a fresh
    // array here would silently drop them.
    const beats: string[] = (ctx.data.eventBeats as string[] | undefined) ?? [];
    let fired = 0;
    for (const ev of this.events) {
      if (ev.when === "onCommand" && !interaction) continue;
      if (ev.when === "onEnterLocation" && !entered) continue;
      if (ev.when !== "onCommand" && ev.trigger.allOf.some((c) => c.kind === "interactionUsed")) continue;
      if (ev.once === "campaign" && cursor.fired.includes(ev.id)) continue;
      if (ev.once === "visit" && cursor.visitFired.includes(ev.id)) continue;
      if (!evalPredicate(ev.trigger, model, partyLoc, interaction, this.lookups)) continue;

      fired++;
      if (ev.once === "campaign") cursor.fired.push(ev.id);
      else if (ev.once === "visit") cursor.visitFired.push(ev.id);
      // Recursive expansion so authored `check` beats ("search → skill check → reveal") branch,
      // mirroring the travel/npc-event expanders. The check key rides `ev.id` + the in-world clock
      // so a repeated (`once: "always"`) beat re-rolls across turns while replaying identically.
      const baseKey = `event-check:${ev.id}:${model.clock}`;
      ev.effects.forEach((eff, index) => this.expandEffect(ctx, eff, beats, `${baseKey}:${index}`));
    }

    ctx.data.eventBeats = beats;
    // Only touch the cursor when it actually changed (entry or a fired beat), and pair any
    // change with a persist — so a cursor advance can never be silently mutated in memory yet
    // lost on reload (which would re-fire a `once` beat). No-op ticks skip the write entirely.
    if (entered || fired > 0) {
      ctx.applySilent({ type: "modulePatch", module: EVENTS_MODULE, patch: { ...cursor } });
      ctx.data.persist = true;
    }
  }

  private onNarrate(ctx: TickContext): void {
    const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
    for (const text of beats) {
      ctx.emit({ kind: "narration", text });
      // The GM narrates LAST (Workstream C slim). Record each already-shown beat so the GM's
      // brief carries it and its arrival prose can't contradict a beat the player just read.
      recordTurnEvent(ctx.data, text);
    }
  }

  /**
   * Expand one authored effect at the given keyed rng path. `narrate` collects prose; `check` rolls
   * a private keyed d20, emits a settled `diceRolled`, and recurses into `onSuccess`/`onFail`
   * (mirrors `npc-events`/`travel-events`). Everything else maps through `effectToCommand` into the
   * commit queue. `ambush` stays module-owned (travel/camp) and no-ops here by design.
   */
  private expandEffect(ctx: TickContext, eff: Effect, beats: string[], key: string): void {
    const model = ctx.model;
    if (eff.kind === "narrate") {
      beats.push(eff.text);
      return;
    }
    if (eff.kind === "check") {
      const result = keyedCheck(this.checkModifier(eff, model), eff.dc, key);
      ctx.emit({
        kind: "diceRolled",
        actorId: playerEntity(model)?.id,
        notation: "1d20",
        rolls: [result.roll],
        total: result.total,
        purpose: `${eff.ability.toUpperCase()} check (DC ${eff.dc})`,
        success: result.success,
      });
      const branch = result.success ? eff.onSuccess : eff.onFail;
      const suffix = result.success ? "s" : "f";
      branch.forEach((branchEff, index) => this.expandEffect(ctx, branchEff, beats, `${key}:${suffix}:${index}`));
      return;
    }
    for (const cmd of effectToCommands(eff, this.world, model, ctx.queue, this.campaign)) ctx.enqueue(cmd);
  }

  /** The PC's resolved d20 modifier for a `check` effect (ability mod + authored bonus). */
  private checkModifier(eff: Extract<Effect, { kind: "check" }>, model: WorldModel): number {
    const pc = playerEntity(model);
    const statBlock = pc ? this.characters.find((c) => c.id === pc.id)?.stats : undefined;
    const score = statBlock?.abilities[eff.ability] ?? 10;
    return abilityModifier(score) + (eff.bonus ?? 0);
  }
}
