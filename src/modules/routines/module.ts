/**
 * Routines module — off-screen life for scheduled world NPCs.
 *
 * On each PLAYER tick it reconciles every scheduled NPC to their day-phase slot: an offstage
 * `moveEntity {teleport:true}` through the commit chokepoint (one writer), the current activity
 * recorded in the `modules.routines` slice (never `Entity.flags` — statted NPCs drop flags on
 * reload), and a deterministic depart/arrive beat pushed onto the shared `eventBeats` array when
 * the player is there to see it. All randomness is PRIVATE keyed rng (src/rules/routine.ts) —
 * zero draws from the shared tick stream, replay-identical.
 *
 * The `applied[npcId] = phaseKey` stamp makes reconcile idempotent within a phase: the schedule
 * asserts a position ONCE per (day, phase); anything that moves the NPC afterwards (the autonomy
 * Director, an event) wins until the next boundary. A suspended NPC (party member, combatant,
 * captor, or downed combatant) is skipped WITHOUT the stamp, so it catches up on
 * the first player tick after the suspension lifts — even mid-phase.
 *
 * Fully INERT in a world with no `schedule` on any NPC template: zero slice writes, zero reads
 * that allocate, zero brief bytes — a schedule-less campaign persists byte-identically.
 *
 * @author Runkai Zhang
 */
import type { World } from "../../content/schema.ts";
import type { Condition, DayPhase, NpcSchedule } from "../../content/schema.ts";
import type { Entity } from "../../world/entity.ts";
import type { WorldModel } from "../../world/model.ts";
import type { CombatEncounter } from "../../rules/combat-state.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import { partyLocationOf } from "../../world/model.ts";
import { isCombatActive } from "../../world/queries.ts";
import { CAMP_LOCATION_ID } from "../../world/camp.ts";
import { CAPTIVITY_LOCATION_ID, readCaptivitySlice } from "../../world/captivity.ts";
import { dayPhaseOf } from "../../agents/context.ts";
import { dangerLookupOf, evalPredicate, type EvalLookups } from "../events/module.ts";
import { regionOfLocation } from "../../rules/regions.ts";
import {
  arriveBeat,
  dayOf,
  departBeat,
  effectiveScheduleOf,
  phaseKeyOf,
  readRoutinesSlice,
  resolveRoutineTarget,
} from "../../rules/routine.ts";
import { readSightingsSlice, recordSighting } from "../../rules/sightings.ts";

/** Whether this NPC's routine must not touch it right now (skipped WITHOUT an `applied` stamp). */
export function isRoutineSuspended(model: WorldModel, entity: Entity): boolean {
  if (entity.partyMember) return true;
  if (entity.stats && entity.stats.currentHp <= 0) return true;
  if (entity.locationId === CAMP_LOCATION_ID || entity.locationId === CAPTIVITY_LOCATION_ID) return true;
  const combat = model.modules.combat as Partial<CombatEncounter> | undefined;
  if (combat?.active === true && combat.order?.includes(entity.id)) return true;
  const captivity = readCaptivitySlice(model);
  if (captivity.active && captivity.captorId === entity.id) return true;
  return false;
}

export class RoutineModule implements TickModule {
  readonly id = "routines";
  /** After core (player resolution priced) and events (which SETS the eventBeats array we append to). */
  readonly after = ["core", "events"];
  readonly phases: TickModule["phases"];
  /** Effective schedules (authored, else world-opt-in derived), precomputed once — the inertness
   *  guard and the reconcile work-list. */
  private readonly scheduled: Map<string, NpcSchedule>;
  private readonly lookups: EvalLookups;

  constructor(private readonly world: World) {
    this.lookups = { regionOf: (id) => regionOfLocation(this.world, id), dangerOf: dangerLookupOf(world) };
    this.scheduled = new Map(
      world.npcs.flatMap((n) => {
        const schedule = effectiveScheduleOf(n, world);
        return schedule ? [[n.id, schedule] as const] : [];
      }),
    );
    this.phases = { react: (ctx) => this.onReact(ctx) };
  }

  private onReact(ctx: TickContext): void {
    if (this.scheduled.size === 0) return; // inert: a schedule-less world writes nothing, ever
    if (ctx.trigger.kind !== "player") return; // heartbeats never move the clock or the cast
    // Never shuffle the cast mid-fight (mirrors travel-events); positions catch up after because
    // suspended/unreconciled NPCs carry no fresh `applied` stamp.
    if (isCombatActive(ctx.model)) return;

    const model = ctx.model;
    const day = dayOf(model.clock);
    const phase = dayPhaseOf(model.clock) as DayPhase;
    const phaseKey = phaseKeyOf(day, phase);
    const slice = readRoutinesSlice(model.modules);
    const partyLoc = partyLocationOf(model);

    // First observation this campaign: seed the cursor and stamp everyone WITHOUT moving, so the
    // authored opening staging holds until the first real phase boundary (travel-events precedent).
    if (slice.lastDay === null) {
      slice.lastDay = day;
      slice.lastPhase = phase;
      for (const npcId of this.scheduled.keys()) slice.applied[npcId] = phaseKey;
      ctx.applySilent({ type: "modulePatch", module: "routines", patch: { ...slice } });
      ctx.data.persist = true;
      this.recordSightings(ctx, day, phase, partyLoc);
      return;
    }
    // Beats only surface at a REAL player location — camp/captivity are outside the world.
    const observing = partyLoc !== null && partyLoc !== CAMP_LOCATION_ID && partyLoc !== CAPTIVITY_LOCATION_ID;
    const condsHold = (conditions: Condition[]): boolean =>
      evalPredicate({ allOf: conditions }, model, partyLoc, undefined, this.lookups);
    const locName = (id: string): string => this.world.locations.find((l) => l.id === id)?.name ?? id;
    const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
    const beatCountBefore = beats.length;
    let changed = false;

    // Self-heal: a scheduled NPC that has become SUSPENDED (most often recruited into the party, but
    // also downed, in combat, or captive) is no longer running its routine, so drop any
    // stale activity/venue annotation it still carries. Otherwise a travelling companion reads
    // "keeping the taproom" in the brief + every presence panel forever, and its lingering venue flag
    // turns any location (a swamp, a dungeon) into a rumor-draining social venue. Runs UNGATED by the
    // phase stamp, so it heals the tick AFTER recruitment — the reconcile loop below skips an
    // already-stamped NPC before reaching its suspension check, so clearing must happen here (#12/#13).
    for (const npcId of this.scheduled.keys()) {
      if (slice.activity[npcId] === undefined && slice.venues[npcId] === undefined) continue;
      const e = model.entities.get(npcId);
      if (e && isRoutineSuspended(model, e)) {
        delete slice.activity[npcId];
        delete slice.venues[npcId];
        changed = true;
      }
    }

    // The NPC the player is addressing THIS turn holds its ground even across a phase boundary
    // (r4 clock repricing: dialogue beats are 10 minutes now, so a long interrogation genuinely
    // crosses phases — the witness must not teleport away mid-sentence). No stamp is written, so
    // the routine catches up, with its departure beat, on the first turn the player lets go.
    const addressedNpcId = (ctx.data.dialogue as { npcId?: string } | undefined)?.npcId;

    for (const [npcId, schedule] of this.scheduled) {
      if (slice.applied[npcId] === phaseKey) continue; // already asserted this phase
      const entity = model.entities.get(npcId);
      if (!entity) continue; // never seeded / despawned — nothing to move
      if (isRoutineSuspended(model, entity)) continue; // no stamp ⇒ catches up when lifted
      if (npcId === addressedNpcId) continue; // mid-conversation hold — catches up next turn

      // Prune an expired override where it's read, so the slice never accretes stale pins.
      const override = slice.overrides[npcId];
      const activeOverride = override && day < override.untilDay ? override : undefined;
      if (override && !activeOverride) {
        delete slice.overrides[npcId];
        changed = true;
      }

      const target = resolveRoutineTarget(npcId, schedule, day, phase, activeOverride, condsHold);
      slice.applied[npcId] = phaseKey;
      changed = true;
      if (target.locationId === null) continue; // hold: keep position, activity, venue as they are

      if (target.activity) slice.activity[npcId] = target.activity;
      else delete slice.activity[npcId];
      if (target.venue) slice.venues[npcId] = true;
      else delete slice.venues[npcId];

      const from = entity.locationId;
      if (from === target.locationId) continue;
      ctx.enqueue({ type: "moveEntity", entityId: npcId, to: target.locationId, teleport: true });
      if (observing && from === partyLoc) {
        beats.push(departBeat(entity.name, locName(target.locationId), target.activity));
      } else if (observing && target.locationId === partyLoc) {
        beats.push(arriveBeat(entity.name, target.activity));
      }
    }

    if (slice.lastDay !== day || slice.lastPhase !== phase) {
      slice.lastDay = day;
      slice.lastPhase = phase;
      changed = true;
    }
    if (beats.length > beatCountBefore) ctx.data.eventBeats = beats;
    if (changed) {
      ctx.applySilent({ type: "modulePatch", module: "routines", patch: { ...slice } });
      ctx.data.persist = true;
    }
    this.recordSightings(ctx, day, phase, partyLoc);
  }

  /**
   * Learnability (sightings): each player turn co-located with a scheduled NPC records one
   * bounded observation of (day, phase, location) — deduped per phase inside `recordSighting`,
   * so lingering costs nothing. Party members are not "sightings" (they travel with you).
   * Positions are read pre-commit: an NPC arriving THIS tick is witnessed from the next turn on.
   */
  private recordSightings(ctx: TickContext, day: number, phase: DayPhase, partyLoc: string | null): void {
    if (partyLoc === null || partyLoc === CAMP_LOCATION_ID || partyLoc === CAPTIVITY_LOCATION_ID) return;
    const slice = readSightingsSlice(ctx.model.modules);
    let changed = false;
    for (const npcId of this.scheduled.keys()) {
      const entity = ctx.model.entities.get(npcId);
      if (!entity || entity.locationId !== partyLoc || entity.partyMember) continue;
      const result = recordSighting(slice.byNpc[npcId] ?? [], { day, phase, locationId: partyLoc });
      if (result.changed) {
        slice.byNpc[npcId] = result.list;
        changed = true;
      }
    }
    if (changed) {
      ctx.applySilent({ type: "modulePatch", module: "sightings", patch: { ...slice } });
      ctx.data.persist = true;
    }
  }
}
