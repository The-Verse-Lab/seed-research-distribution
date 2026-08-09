/**
 * Camp-events module — the filtered long-rest slice of the DoL-style random-event roller.
 *
 * `TravelEventsModule` fires ONLY on a real traversal, of which there is none at Camp (the party sits
 * in one no-exit room), so a long rest needs its own roller. This module rolls the SAME authored
 * `campaign.travelEvents` list each CAMP turn, restricted to the camp-safe subset (`isCampSafe` — a
 * courier/messenger can still find you; a random threat or ambush cannot). It keeps its own persisted
 * cursor (module `"campEvents"`) and its OWN private-rng key namespace (`camp-fire:` / `camp-pick:`),
 * so it can never double-fire with — or perturb the seed stream of — the traversal roller. All
 * randomness is private keyed rng (zero shared draws → replay-safe). Mutation flows only through
 * enqueued reducer commands (one writer); narration rides the shared `ctx.data.eventBeats` array that
 * EventsModule emits in the narrate phase.
 *
 * @author Runkai Zhang
 */
import type { Campaign, Effect, TravelEvent, World } from "../../content/schema.ts";
import { playerEntity, type WorldModel } from "../../world/model.ts";
import { CAMP_LOCATION_ID, isAtCamp } from "../../world/camp.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import { evalPredicate, occupiedLookupOf, type OccupiedCoverageLookup } from "../events/module.ts";
import { effectToCommands } from "../events/effect-to-command.ts";
import { abilityModifier } from "../../rules/dice.ts";
import { cooledDownByCounter, isCampSafe, keyedCheck, keyedFireCheck, keyedWeightedPick } from "../../rules/travel-events.ts";

/** Persisted per-module cursor (WorldModel.modules.campEvents). */
interface CampCursor {
  /** Monotonic camp-turn counter — the private-rng salt + the cooldown clock. Bumped each camp turn. */
  turnCounter: number;
  /** The turnCounter at which ANY camp event last fired (reserved for a global floor; unused = 0). */
  lastFiredAt: number;
  /** Event ids fired with `once: "campaign"`. */
  firedCampaign: string[];
  /** eventId → turnCounter of its last fire (per-event `cooldownMoves`). */
  perEventLastFired: Record<string, number>;
}

function readCursor(model: WorldModel): CampCursor {
  const slice = model.modules.campEvents as Partial<CampCursor> | undefined;
  return {
    turnCounter: slice?.turnCounter ?? 0,
    lastFiredAt: slice?.lastFiredAt ?? 0,
    firedCampaign: [...(slice?.firedCampaign ?? [])],
    perEventLastFired: { ...(slice?.perEventLastFired ?? {}) },
  };
}

export class CampEventsModule implements TickModule {
  readonly id = "camp-events";
  readonly phases: TickModule["phases"];
  private readonly occupiedOf: OccupiedCoverageLookup;

  constructor(
    private readonly world: World,
    private readonly campaign: Campaign,
  ) {
    this.occupiedOf = occupiedLookupOf(campaign.characters);
    this.phases = { react: (ctx) => this.onReact(ctx) };
  }

  private onReact(ctx: TickContext): void {
    const events = this.campaign.travelEvents;
    if (events.length === 0) return;
    // Player-turn-scoped: a heartbeat never rolls (mirrors TravelEventsModule's guard).
    if (ctx.trigger.kind !== "player") return;
    const model = ctx.model;
    // Only rolls while the party is camped — the whole trigger surface for a long rest.
    if (!isAtCamp(model)) return;
    const cursor = readCursor(model);
    cursor.turnCounter += 1;
    const key = `${CAMP_LOCATION_ID}:${cursor.turnCounter}`;

    // Per-camp-turn fire roll, then a weighted pick over the CAMP-SAFE eligible set — both private rng.
    if (keyedFireCheck(this.campaign.travelEventChance, `camp-fire:${key}`)) {
      const eligible = events.filter((ev) => this.eligible(ev, model, cursor));
      const chosenId = keyedWeightedPick(
        eligible.map((e) => ({ id: e.id, weight: e.weight })),
        `camp-pick:${key}`,
      );
      const chosen = chosenId ? (eligible.find((e) => e.id === chosenId) ?? null) : null;
      if (chosen) this.fire(chosen, model, ctx, cursor);
    }

    // Every camp turn advances the cursor, paired with a persist so it survives reload.
    ctx.applySilent({ type: "modulePatch", module: "campEvents", patch: { ...cursor } });
    ctx.data.persist = true;
  }

  /** Whether an event may fire this camp turn: camp-safe, `once`/cooldown clear, predicate holds. */
  private eligible(ev: TravelEvent, model: WorldModel, cursor: CampCursor): boolean {
    if (!isCampSafe(ev)) return false;
    if (ev.once === "campaign" && cursor.firedCampaign.includes(ev.id)) return false;
    if (!cooledDownByCounter(cursor.perEventLastFired[ev.id], ev.cooldownMoves, cursor.turnCounter)) return false;
    return evalPredicate(ev.trigger, model, CAMP_LOCATION_ID, undefined, { occupiedOf: this.occupiedOf });
  }

  /** Mark bookkeeping and expand the chosen event's effects (narration + enqueued commands). */
  private fire(ev: TravelEvent, model: WorldModel, ctx: TickContext, cursor: CampCursor): void {
    if (ev.once === "campaign") cursor.firedCampaign.push(ev.id);
    cursor.perEventLastFired[ev.id] = cursor.turnCounter;
    cursor.lastFiredAt = cursor.turnCounter;
    const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
    const baseKey = `camp-check:${ev.id}:${CAMP_LOCATION_ID}:${cursor.turnCounter}`;
    ev.effects.forEach((eff, index) => {
      this.expandEffect(eff, model, ctx, beats, index === 0 ? baseKey : `${baseKey}:${index}`);
    });
    ctx.data.eventBeats = beats; // EventsModule.onNarrate emits these.
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
      // The courier/messenger hand-off — materialize the item straight into the recipient's pack.
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
    if (eff.kind === "ambush") return;
    // Shared single-command kinds (setFlag/setQuestState/setObjectiveDone/adjustRelationship/adjustHp/setCondition/spawn).
    for (const cmd of effectToCommands(eff, this.world, model, ctx.queue, this.campaign)) ctx.enqueue(cmd);
  }

  private checkModifier(eff: Extract<Effect, { kind: "check" }>, model: WorldModel): number {
    const pc = playerEntity(model);
    const statBlock = pc ? this.campaign.characters.find((c) => c.id === pc.id)?.stats : undefined;
    const score = statBlock?.abilities[eff.ability] ?? 10;
    return abilityModifier(score) + (eff.bonus ?? 0);
  }
}
