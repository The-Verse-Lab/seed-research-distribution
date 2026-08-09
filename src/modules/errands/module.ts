/**
 * Errands module — the away-and-back tick (r5 fix wave).
 *
 * Watches every errand the player dispatched (`modules.errands.active`) and lands it once the
 * campaign clock passes its `dueAtClock`: the runner walks home, the CODE decides what they
 * learned (`resolveErrandTask`), and the finding is delivered three ways —
 *
 *  1. a beat, but only when the party is standing where the runner came back to;
 *  2. a `recordNpcMemory` row, so asking the runner about it LATER actually works;
 *  3. `npcLearnCaseFact` when the finding was a case fact, so the case ledger agrees.
 *
 * (2) is the whole point. r4's witness scoping is correct — a dispatched NPC is not in the
 * `presentIds` of any scene it missed, so it genuinely knows nothing about them — which is exactly
 * why an errand's result has to be handed over as explicit state rather than left to the
 * transcript. That is why the r4 run's Oda "answered about something else".
 *
 * Shape is `QuestDeadlinesModule`'s, deliberately: react phase, player triggers only (a heartbeat
 * must not land an errand mid-lull), the PROSPECTIVE end-of-turn clock so a long march lands on
 * the turn that caused it, and beats APPENDED to `ctx.data.eventBeats` (EventsModule seeds that
 * array). Registered after RoutineModule so the routines slice it reads is already this phase's.
 *
 * Zero rng draws.
 *
 * @author Runkai Zhang
 */
import type { Campaign, Effect, World } from "../../content/schema.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import {
  ERRANDS_MODULE,
  MEETING_HOLD_DAYS,
  readErrandsSlice,
  resolveErrandTask,
  type Errand,
  type ErrandReport,
} from "../../rules/errands.ts";
import { isInteractiveEffect } from "../../rules/npc-events.ts";
import { dayOf, readRoutinesSlice } from "../../rules/routine.ts";
import { displayName } from "../../world/entity.ts";
import { partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";
import { isCombatActive } from "../../world/queries.ts";
import { effectToCommands } from "../events/effect-to-command.ts";
import {
  EVENTS_MODULE,
  evalPredicate,
  readEventsCursor,
  standardEvalLookups,
  type EvalLookups,
  type EventsCursor,
} from "../events/module.ts";
import { isRoutineSuspended } from "../routines/module.ts";

export class ErrandsModule implements TickModule {
  readonly id = "errands";
  readonly after = ["events", "routines"];
  readonly phases: TickModule["phases"];
  /** The events module's OWN resolver bundle — these are its beats, so they must be judged by its
   *  rules (fail-closed lookups included), not by a second, laxer evaluator living over here. */
  private readonly lookups: EvalLookups;

  constructor(
    private readonly world: World,
    private readonly campaign: Campaign,
  ) {
    this.lookups = standardEvalLookups(world, campaign.characters);
    this.phases = { react: (ctx) => this.onReact(ctx) };
  }

  private onReact(ctx: TickContext): void {
    if (ctx.trigger.kind !== "player") return;
    const model = ctx.model;
    const slice = readErrandsSlice(model.modules);
    const runnerIds = Object.keys(slice.active);
    if (runnerIds.length === 0) return;
    // Never walk a body into a live fight — the errand simply lands on the next quiet turn.
    if (isCombatActive(model)) return;

    const advance =
      ctx.data.advancesClock !== false && typeof ctx.data.clockMinutes === "number" ? ctx.data.clockMinutes : 0;
    const clockAtCommit = model.clock + Math.max(0, advance);

    const routines = readRoutinesSlice(model.modules);
    // Read AFTER EventsModule's own react pass (`after: ["events", …]`), so this is the cursor it
    // just advanced — including the `visitFired` reset it does when the party changed location.
    const cursor = readEventsCursor(model);
    let changed = false;
    let routinesChanged = false;
    let cursorChanged = false;
    const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
    const here = partyLocationOf(model);

    for (const runnerId of runnerIds) {
      const errand = slice.active[runnerId]!;
      if (clockAtCommit < errand.dueAtClock) continue;
      const runner = model.entities.get(runnerId);

      // Abort paths first. A runner who died or was culled off the registry mid-errand does not
      // come home; drop the record and release the pin rather than teleporting a ghost.
      if (!runner || (runner.stats && runner.stats.currentHp <= 0)) {
        delete slice.active[runnerId];
        if (routines.overrides[runnerId]) {
          delete routines.overrides[runnerId];
          delete routines.activity[runnerId];
          routinesChanged = true;
        }
        changed = true;
        continue;
      }

      const runnerName = displayName(runner);
      const resolved = resolveErrandTask(errand.task, {
        model,
        world: this.world,
        campaign: this.campaign,
        runnerName,
        destinationId: errand.destinationId,
        playerCoins: playerEntity(model)?.stats?.coins ?? 0,
      });
      const report: ErrandReport = {
        errandId: errand.id,
        runnerId,
        atClock: clockAtCommit,
        outcome: resolved.outcome,
        findings: resolved.findings,
        ...(resolved.caseFact ? { caseFact: resolved.caseFact } : {}),
        ...(resolved.bought ? { bought: resolved.bought } : {}),
        ...(resolved.broughtId ? { broughtId: resolved.broughtId } : {}),
      };

      // Authored content standing at the destination reaches the player through the runner, on the
      // SAME rule the offstage `scope:"anywhere"` npc-event path uses: non-interactive effects
      // really fire, their narrate texts become findings, and anything that needs the player in the
      // room (a check, an ambush, a exploitation opener, an unaddressed hand-over) is skipped.
      if (this.fireOffstageEvents(ctx, errand.destinationId, report, cursor)) cursorChanged = true;

      // Bring the runner home, and whoever they brought with them.
      ctx.enqueue({ type: "moveEntity", entityId: runnerId, to: errand.reportLocationId, teleport: true });
      if (routines.overrides[runnerId]) {
        delete routines.overrides[runnerId];
        delete routines.activity[runnerId];
        routinesChanged = true;
      }
      if (report.broughtId) {
        const subject = model.entities.get(report.broughtId);
        if (subject && !isRoutineSuspended(model, subject)) {
          ctx.enqueue({ type: "moveEntity", entityId: report.broughtId, to: errand.reportLocationId, teleport: true });
          // Pin them, or the next phase boundary marches them straight back to their own slot —
          // the meeting the player paid for would end before it began.
          routines.overrides[report.broughtId] = {
            locationId: errand.reportLocationId,
            activity: "waiting on a meeting",
            untilDay: dayOf(clockAtCommit) + MEETING_HOLD_DAYS,
          };
          routines.activity[report.broughtId] = "waiting on a meeting";
          delete routines.venues[report.broughtId];
          routinesChanged = true;
        } else {
          delete report.broughtId;
          report.outcome = "empty";
        }
      }

      this.settleCoin(ctx, errand, report, model);

      // The runner's own journal — engine-templated, never model prose (rules/npc-memory.ts).
      ctx.enqueue({
        type: "recordNpcMemory",
        npcId: runnerId,
        entry: { at: model.clock, kind: "errandReport", summary: report.findings[0] ?? "Came back with nothing." },
      });
      if (report.caseFact) {
        ctx.enqueue({
          type: "npcLearnCaseFact",
          caseId: report.caseFact.caseId,
          npcId: runnerId,
          factId: report.caseFact.factId,
        });
      }

      // On screen only where the player actually is. Off-site, the ledger row and the runner's
      // journal carry it — the report is not lost, it just isn't narrated to an empty room.
      if (here === errand.reportLocationId) {
        beats.push(`${runnerName} is back from ${this.locationName(errand.destinationId)}.`, ...report.findings);
      }

      slice.reports[runnerId] = report;
      delete slice.active[runnerId];
      changed = true;
    }

    // Safe under this guard: `cursorChanged` is only ever set on a landing path, and every landing
    // path falls through to `changed = true` below — so a consumed `once` beat always reaches the
    // reducer. Any future early `continue` added AFTER `fireOffstageEvents` must keep that true.
    if (!changed) return;
    if (beats.length > 0) ctx.data.eventBeats = beats;
    // Read fresh and applied AFTER RoutineModule's own whole-slice write this phase, or its
    // `applied`/`activity`/`venues` bookkeeping would be clobbered by a stale copy.
    if (routinesChanged) ctx.applySilent({ type: "modulePatch", module: "routines", patch: { ...routines } });
    // Whole cursor, not a partial: the delta fold is a shallow Object.assign, and `lastLoc` (which
    // this module never touches) rides along untouched precisely because it was read fresh above.
    if (cursorChanged) ctx.applySilent({ type: "modulePatch", module: EVENTS_MODULE, patch: { ...cursor } });
    // BOTH keys, whole: the delta fold is a shallow Object.assign, so a partial patch would drop
    // the other half of the slice.
    ctx.applySilent({
      type: "modulePatch",
      module: ERRANDS_MODULE,
      patch: { active: slice.active, reports: slice.reports },
    });
    ctx.data.persist = true;
  }

  /** A paid errand that produced nothing gives the coin back; the runner is paid on delivery. */
  private settleCoin(ctx: TickContext, errand: Errand, report: ErrandReport, model: WorldModel): void {
    const playerId = playerEntity(model)?.id;
    if (report.bought && playerId) {
      ctx.enqueue({ type: "adjustCoins", entityId: playerId, by: -report.bought.costCp });
      ctx.enqueue({ type: "transferItem", itemId: report.bought.itemId, from: null, to: playerId });
    }
    if (errand.feeCp <= 0 || report.outcome === "delivered" || !playerId) return;
    // Paired, never minted: the fee only comes back off a runner who could actually hold it.
    const runner = model.entities.get(errand.runnerId);
    if (runner?.stats) ctx.enqueue({ type: "adjustCoins", entityId: errand.runnerId, by: -errand.feeCp });
    ctx.enqueue({ type: "adjustCoins", entityId: playerId, by: errand.feeCp });
  }

  /**
   * The destination's own `onEnterLocation` events, run offstage under the npc-events rule.
   *
   * An `atLocation` clause naming the destination SELECTS an event; it does not authorize it. The
   * gate is the whole authored predicate, run through the events module's own `evalPredicate` with
   * the DESTINATION standing in for the party location — the runner is the one in that room, so
   * `atLocation`/`entityPresent` read there, while every other clause (flags, quest state, the PC's
   * inventory, the clock) reads the real world as it stands. Before r8 this fired on the mere
   * PRESENCE of a matching clause and ignored the rest, so in the authored regression corpus an
   * errand to Umberwick paid the countess's repeat toll with `umberwick.tolled` still false, and an
   * errand to the caravan wreck handed over the bond-writ while the quest gating it was still
   * hidden. This is the same full-predicate rule the sibling offstage path already honours
   * (src/modules/npc-events/module.ts) — errands were the one place that didn't.
   *
   * `once` is honoured against the events module's cursor, mutated in place on the caller's fresh
   * COPY and written back by the caller in a single reducer patch (one writer). Reading `visitFired`
   * is right rather than merely convenient: EventsModule clears it whenever the PARTY moves, so a
   * beat consumed offstage suppresses only repeat errands sent from the same standing spot, and the
   * player's own eventual arrival still gets its beat.
   *
   * Returns whether the cursor changed.
   */
  private fireOffstageEvents(
    ctx: TickContext,
    destinationId: string,
    report: ErrandReport,
    cursor: EventsCursor,
  ): boolean {
    let cursorChanged = false;
    for (const event of this.campaign.events) {
      if (event.when !== "onEnterLocation") continue;
      const atDestination = event.trigger.allOf.some(
        (cond) => cond.kind === "atLocation" && cond.locationId === destinationId,
      );
      if (!atDestination) continue;
      if (event.once === "campaign" && cursor.fired.includes(event.id)) continue;
      if (event.once === "visit" && cursor.visitFired.includes(event.id)) continue;
      // No `interaction` argument: a beat gated on `interactionUsed` needs the player's own hands on
      // the thing, so it fails closed here — an errand runner cannot pull a lever by proxy.
      if (!evalPredicate(event.trigger, ctx.model, destinationId, undefined, this.lookups)) continue;

      if (event.once === "campaign") {
        cursor.fired.push(event.id);
        cursorChanged = true;
      } else if (event.once === "visit") {
        cursor.visitFired.push(event.id);
        cursorChanged = true;
      }
      for (const eff of event.effects as Effect[]) {
        if (isInteractiveEffect(eff)) continue;
        if (eff.kind === "narrate") {
          report.findings.push(eff.text);
          continue;
        }
        if (eff.kind === "routineOverride") continue; // an errand does not re-schedule the world
        for (const cmd of effectToCommands(eff, this.world, ctx.model, ctx.queue, this.campaign)) ctx.enqueue(cmd);
      }
    }
    return cursorChanged;
  }

  private locationName(locationId: string): string {
    return this.world.locations.find((l) => l.id === locationId)?.name ?? locationId;
  }
}
