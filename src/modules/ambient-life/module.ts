/**
 * Ambient-life module — fills a location with living extras on arrival, so a crowded market reads
 * crowded and a lawless waste reads empty. It finally WIRES the long-dead `Location.spawns` rules
 * (nothing read them before) plus each region's `ambientPool` / `threatPool`, scaled by the
 * region's `crowd` and the day phase (busy midday, deserted at deep-night — dynamic population with
 * no extra state).
 *
 * Discipline (mirrors TravelEventsModule): PLAYER-turn-scoped, suppressed in combat, fires ONLY on a
 * real arrival (a location change), never through Camp/Captivity transitions. Extras spawn as
 * `transient` entities, so the existing `cullTransients` (src/world/maintenance.ts) reaps them the
 * instant the party moves on — no new teardown code. All randomness is PRIVATE id-keyed
 * (`rules/ambient.ts` + `keyedFireCheck`/`keyedWeightedPick`), so it draws ZERO from the shared tick
 * rng and replays byte-identically; the spawn + identity ride the existing `entitySpawned`/
 * `npcEnriched` deltas (no new delta kind, no LLM on replay). It runs in `react` and applies
 * immediately (`ctx.apply`) so the crowd is PRESENT when the narrator builds the brief the same turn.
 *
 * Ambient ids are `template#n` INSTANCES; the RoutineModule keys on bare template ids, so ambient
 * extras are never reconciled/sighted — the "every roster NPC is scheduled" invariant is untouched.
 * The authoring rule (documented on RegionSchema): pools reference GENERIC crowd/monster templates,
 * never a scheduled roster NPC. A generic template gets a danger-weighted seeded identity (the
 * prose-entities idiom, MINUS the gateway — no LLM); an authored NPC keeps its authored identity via
 * its templateId. Generated threat actors use the same neutral identity schema as every other NPC.
 *
 * @author Runkai Zhang
 */
import { NpcTemplateSchema, type NpcTemplate, type DayPhase, type SpawnRule, type World } from "../../content/schema.ts";
import { partyLocationOf, type WorldModel } from "../../world/model.ts";
import { CAMP_LOCATION_ID } from "../../world/camp.ts";
import { CAPTIVITY_LOCATION_ID } from "../../world/captivity.ts";
import { LODGING_LOCATION_ID } from "../../world/lodging.ts";
import { combatPendingInQueue, isCombatActive } from "../../world/queries.ts";
import { mirrorEnrichment } from "../../world/enrichment.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import { buildSpawnCommand, nextSpawnId } from "../events/effect-to-command.ts";
import { keyedFireCheck, keyedWeightedPick } from "../../rules/travel-events.ts";
import {
  ambientCount,
  crowdPhaseFactor,
  packChance,
  packCount,
  packDroughtBonus,
  threatAmbientChance,
} from "../../rules/ambient.ts";
import { regionProfileOf, type RegionProfile } from "../../rules/regions.ts";
import { dayPhaseOf } from "../../agents/context.ts";
import { composeNpcTemplate } from "../party/enrich.ts";
import { dangerWeightedPools, seededIdentityFor } from "../../worldsmith/reconcile.ts";

/** The hard ceiling on ambient extras per location — protects the brief's `Present:` line and caps
 *  the per-arrival spawn work regardless of how many rules/pools a place authors. */
const MAX_AMBIENT_PER_LOC = 4;

/** Persisted per-module cursor (WorldModel.modules.ambientLife). */
interface AmbientCursor {
  /** Party location at the end of the previous tick (arrival detection). */
  lastLoc: string | null;
  /** locationId → number of times the party has arrived here (the fresh-faces identity salt). */
  visits: Record<string, number>;
  /**
   * Arrivals since a monster pack last materialized anywhere — the drought counter behind
   * `packDroughtBonus`. Absent in an old save ⇒ 0, i.e. exactly the pre-drought odds.
   */
  quietArrivals: number;
}

/** Read the cursor as a defaulting COPY — never a live reference (write-back would dirty a
 *  spawn-less snapshot; snapshot-purity gotcha from the routines wave). */
function readCursor(model: WorldModel): AmbientCursor {
  const slice = model.modules.ambientLife as Partial<AmbientCursor> | undefined;
  return {
    lastLoc: slice?.lastLoc ?? null,
    visits: { ...(slice?.visits ?? {}) },
    quietArrivals: slice?.quietArrivals ?? 0,
  };
}

export class AmbientLifeModule implements TickModule {
  readonly id = "ambient-life";
  /** After core (movement applied) so arrival detection sees the new location. */
  readonly after = ["core"];
  readonly phases: TickModule["phases"];
  /** True when no location authors `spawns` and no region authors pools — the module is fully inert
   *  (early return, zero writes) so a spawn-less/region-less world's snapshot is byte-identical. */
  private readonly inert: boolean;

  constructor(private readonly world: World) {
    this.inert =
      world.locations.every((l) => l.spawns.length === 0) &&
      world.regions.every((r) => r.ambientPool.length === 0 && r.threatPool.length === 0);
    this.phases = { react: (ctx) => this.onReact(ctx) };
  }

  private onReact(ctx: TickContext): void {
    if (this.inert) return;
    if (ctx.trigger.kind !== "player") return; // a heartbeat never travels
    if (isCombatActive(ctx.model)) return; // no crowd spawn mid-fight; re-arms after
    // A fight is OPENING this tick — enqueued by an earlier react module (a travel ambush or a
    // prebaked event) and not yet committed, so `isCombatActive` cannot see it. Defer the crowd just
    // as for committed combat so a transient cannot enter a forming fight.
    if (combatPendingInQueue(ctx.queue)) return;
    const model = ctx.model;
    const partyLoc = partyLocationOf(model);
    const cursor = readCursor(model);
    const prevLoc = cursor.lastLoc;
    if (partyLoc === prevLoc) return; // no move ⇒ no roll, no write

    // Camp/Captivity/rented-room are teleports outside the world — sync the cursor, never populate. A
    // crowd conjured into a private room would contradict the synthetic room's isolation.
    const synthetic =
      partyLoc === CAMP_LOCATION_ID ||
      prevLoc === CAMP_LOCATION_ID ||
      partyLoc === CAPTIVITY_LOCATION_ID ||
      prevLoc === CAPTIVITY_LOCATION_ID ||
      partyLoc === LODGING_LOCATION_ID ||
      prevLoc === LODGING_LOCATION_ID;
    cursor.lastLoc = partyLoc;
    if (!synthetic && partyLoc !== null) this.populate(ctx, partyLoc, cursor);

    ctx.applySilent({ type: "modulePatch", module: "ambientLife", patch: { ...cursor } });
    ctx.data.persist = true;
  }

  /** Spawn the crowd (location rules + region ambient pool), then maybe an off-roster threat. */
  private populate(ctx: TickContext, loc: string, cursor: AmbientCursor): void {
    const model = ctx.model;
    const profile = regionProfileOf(this.world, loc);
    const phase = dayPhaseOf(model.clock) as DayPhase;
    const phaseFactor = crowdPhaseFactor(phase);
    const visit = (cursor.visits[loc] ?? 0) + 1;
    cursor.visits[loc] = visit;

    const location = this.world.locations.find((l) => l.id === loc);
    // Count live instances of a template already here — a `tracked`/`significant` spawn PERSISTS across
    // revisits (cullTransients only reaps transients), so its `max` is a standing ceiling, not a
    // per-arrival budget: honoring it stops the same authored monster re-spawning every return. A
    // transient template counts 0 (already culled on the last departure), so its behavior is unchanged.
    const countAt = (templateId: string): number =>
      [...model.entities.values()].filter((e) => e.locationId === loc && e.templateId === templateId).length;
    let spawned = 0;
    const spawnRules = (rules: readonly SpawnRule[], count: (max: number, ri: number) => number): void => {
      for (let ri = 0; ri < rules.length && spawned < MAX_AMBIENT_PER_LOC; ri++) {
        const rule = rules[ri]!;
        const room = Math.max(0, rule.max - countAt(rule.templateId));
        const n = Math.min(count(rule.max, ri), room);
        for (let k = 0; k < n && spawned < MAX_AMBIENT_PER_LOC; k++) {
          if (this.spawnAmbient(ctx, rule.templateId, loc, profile, visit, false, rule.tier)) spawned++;
        }
      }
    };
    // Authored location packs (usually monsters) scale by DANGER, but only materialize on a fraction
    // of arrivals (packChance) so even a deadly region has quiet, monster-free paths — travel isn't a
    // fight EVERY time. Region ambient people scale by CROWD × day phase and are continuous. Distinct
    // rng keys so the gate, the pack count, and the crowd count are all independent.
    // The drought bonus rides on top of the danger-scaled odds: a long monster-free walk makes the
    // next authored pack likelier, and materializing one resets the counter. An arrival that had
    // nothing to roll for (no authored spawns here) still counts as quiet — the player walked and
    // met nothing, which is the thing being measured.
    const droughtChance = Math.min(0.9, packChance(profile.danger) + packDroughtBonus(cursor.quietArrivals));
    const before = spawned;
    if ((location?.spawns.length ?? 0) > 0 && keyedFireCheck(droughtChance, `ambient-pack:${loc}:${visit}`)) {
      spawnRules(location!.spawns, (max, ri) => packCount(max, profile.danger, `${loc}:${visit}:pack:${ri}`));
    }
    cursor.quietArrivals = spawned > before ? 0 : cursor.quietArrivals + 1;
    spawnRules(profile.ambientPool, (max, ri) => ambientCount(max, profile.crowd, phaseFactor, `${loc}:${visit}:amb:${ri}`));

    // Off-roster threat: only where a region authors a threatPool, only above danger 1
    // (threatAmbientChance is 0 below that), and only if the seeded roll fires.
    if (
      profile.threatPool.length > 0 &&
      keyedFireCheck(threatAmbientChance(profile.danger), `ambient-threat:${loc}:${visit}`)
    ) {
      const pickId = keyedWeightedPick(
        profile.threatPool.map((p, i) => ({ id: String(i), weight: Math.max(1, p.max) })),
        `ambient-threat-pick:${loc}:${visit}`,
      );
      if (pickId !== null) {
        const threat = profile.threatPool[Number(pickId)]!;
        if (countAt(threat.templateId) < threat.max) {
          this.spawnAmbient(ctx, threat.templateId, loc, profile, visit, true, threat.tier);
        }
      }
    }
  }

  /**
   * Spawn one extra and, for a GENERIC npc template, attach a danger-weighted seeded identity so the
   * crowd is addressable and the exploitation scorer/stance can read it. Monsters and authored NPCs need
   * no enrichment (a monster is fightable as-is; an authored NPC's identity is reachable via its
   * templateId). Returns false if the spawn was rejected (so the caller's headcount stays honest).
   */
  private spawnAmbient(
    ctx: TickContext,
    templateId: string,
    loc: string,
    profile: RegionProfile,
    visit: number,
    forceThreat: boolean,
    tier: SpawnRule["tier"],
  ): boolean {
    const model = ctx.model;
    const isMonster = this.world.monsters.some((m) => m.id === templateId);
    const spawnId = nextSpawnId(model, templateId, ctx.queue);
    // Honor the authored spawn tier. A `transient` extra (the default, and every region crowd/threat
    // pool) is reaped by cullTransients on departure and re-rolled fresh on return; a `tracked`/
    // `significant` authored monster PERSISTS (the caller caps it at `max` via a live-instance count, so
    // it never accumulates a fresh copy each revisit).
    const spawn = ctx.apply(buildSpawnCommand(this.world, model, { templateId, locationId: loc, tier, id: spawnId }));
    if (spawn.rejected) return false;
    if (isMonster) return true;

    const baseNpc = this.world.npcs.find((n) => n.id === templateId);
    // An authored identity (alignment set) is respected verbatim — reachable through the templateId;
    // spawning is enough. Only a GENERIC,
    // identity-less crowd template needs the seeded floor.
    if (baseNpc?.alignment !== undefined) return true;

    const ent = model.entities.get(spawnId);
    if (!ent) return true;
    const salt = `${this.world.name}:ambient:${loc}:${visit}`;
    const identity = seededIdentityFor(salt, spawnId, dangerWeightedPools(profile.danger));
    // Ambient crowds are never exploitative. The dedicated threat pool supplies that signal.
    const exploitative = forceThreat;
    const template: NpcTemplate = NpcTemplateSchema.parse({
      ...composeNpcTemplate(this.world, ent),
      sex: identity.sex,
      alignment: identity.alignment,
      personalityTemplate: identity.personalityTemplate,
      exploitative,
    });
    const enr = ctx.apply({ type: "enrichNpc", npcId: spawnId, template, promote: false });
    if (enr.mutated) mirrorEnrichment(this.world, template);
    return true;
  }
}
