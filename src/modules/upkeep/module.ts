/**
 * Upkeep module — the daily coin/food pressure (the hall-as-hub wave, Phase C).
 *
 * A tick module keyed on the in-world DAY counter: each time the clock crosses into a new day (whether
 * by a long rest or by marching through the night), it settles the party's upkeep ONCE for the elapsed
 * span — merc WAGES (`modules.partyWages`) and FOOD (one `item.rations` per day). Skipping bites: an
 * unpaid mercenary walks (and sours), and an unfed party accrues hunger that becomes exhaustion past a
 * threshold. This is the coin drain that makes "keep earning" a real loop.
 *
 * All randomness-free; every mutation flows through the reducer (enqueued commands). The narration
 * rides the shared `ctx.data.eventBeats` array EventsModule emits in the narrate phase. Its cursor
 * (`lastDay` + per-member `hunger`) persists via `modulePatch`. Fully inert until a day actually
 * crosses; a party with no mercs and full rations pays nothing and stays silent.
 *
 * @author Runkai Zhang
 */
import type { Campaign, World } from "../../content/schema.ts";
import { playerEntity, type WorldModel } from "../../world/model.ts";
import type { Entity } from "../../world/entity.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import { PARTY_WAGES_MODULE, readPartyWagesSlice } from "../../rules/recruit.ts";
import {
  HUNGER_EXHAUSTION_AT,
  MAX_UPKEEP_DAYS,
  PROVISIONS_ITEM_ID,
  UPKEEP_MODULE,
  readUpkeepSlice,
  upkeepDayOf,
} from "../../rules/upkeep.ts";
import { resolveItem } from "../../rules/items.ts";

/**
 * What a meal at a paid table costs: exactly the market price of the day's rations it stands in for
 * (`item.rations`, 50 cp on the SRD masterlist). Deliberately not a discount — an inn is a
 * convenience, and the hunger ladder must not be buyable around with a 10 cp bunk.
 */
const BOARD_CP = resolveItem({ items: [] }, PROVISIONS_ITEM_ID)?.baseCostCp ?? 50;

export class UpkeepModule implements TickModule {
  readonly id = "upkeep";
  readonly phases: TickModule["phases"];

  constructor(
    private readonly _world: World,
    private readonly _campaign: Campaign,
  ) {
    this.phases = { react: (ctx) => this.onReact(ctx) };
  }

  private onReact(ctx: TickContext): void {
    if (ctx.trigger.kind !== "player") return;
    const model = ctx.model;
    const pc = playerEntity(model);
    if (!pc?.stats) return;

    const slice = readUpkeepSlice(model.modules);
    const currentDay = upkeepDayOf(model.clock);
    // First observation: seed the cursor, never settle a spurious day (the travel-events precedent).
    if (slice.lastDay === null) {
      ctx.applySilent({ type: "modulePatch", module: UPKEEP_MODULE, patch: { lastDay: currentDay, hunger: slice.hunger } });
      ctx.data.persist = true;
      return;
    }
    const days = Math.min(currentDay - slice.lastDay, MAX_UPKEEP_DAYS);
    if (days <= 0) return;

    const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
    const members = [...model.entities.values()].filter(
      (e): e is Entity & { stats: NonNullable<Entity["stats"]> } => e.partyMember && e.stats !== undefined,
    );

    this.settleWages(ctx, model, pc, days, beats);
    // A night bought under a roof is fed at that roof's table — for COIN, not out of the travel
    // packs (r5 P2: 12 cp for a bunk in the hearth-loft, and a marching ration taken off the pack
    // for the same night — paid twice for one sleep). Board is priced at the ration it replaces, so
    // an inn is a convenience, never a discount: a bed does not beat the hunger ladder. The stamp is
    // set by the Wake resolver earlier in this tick — by now the party is back in the hall.
    const boarded = ctx.data.lodgedNight === true ? 1 : 0;
    this.settleFood(ctx, members, pc, slice.hunger, days, beats, boarded);

    ctx.data.eventBeats = beats;
    ctx.applySilent({ type: "modulePatch", module: UPKEEP_MODULE, patch: { lastDay: currentDay, hunger: slice.hunger } });
    ctx.data.persist = true;
  }

  /** Pay each hired merc's daily wage × the elapsed days; anyone the purse can't cover walks (and sours). */
  private settleWages(ctx: TickContext, model: WorldModel, pc: Entity, days: number, beats: string[]): void {
    const wages = readPartyWagesSlice(model.modules);
    const mercIds = Object.keys(wages).filter((id) => model.entities.get(id)?.partyMember === true);
    if (mercIds.length === 0) return;
    let purse = pc.stats?.coins ?? 0;
    let paid = 0;
    const dismissed: string[] = [];
    // Cheapest first: keep as many swords as the coin stretches to; drop the dearest you can't cover.
    for (const id of mercIds.sort((a, b) => wages[a]! - wages[b]!)) {
      const owed = wages[id]! * days;
      if (purse >= owed) {
        purse -= owed;
        paid += owed;
      } else {
        dismissed.push(id);
      }
    }
    if (paid > 0) ctx.enqueue({ type: "adjustCoins", entityId: pc.id, by: -paid });
    // Zero the wage of every dismissed merc. `modulePatch` is a shallow Object.assign — it can OVERWRITE
    // a key but never DELETE one — so a "delete then patch the reduced map" would leave the stale entry
    // untouched. Overwriting to 0 makes the entry provably inert (owed 0, and the partyMember filter
    // already excludes it), which is the reliable way to retire it through this reducer.
    const wagePatch: Record<string, number> = {};
    for (const id of dismissed) {
      const name = model.entities.get(id)?.name ?? "A hired sword";
      ctx.enqueue({ type: "setPartyMembership", entityId: id, member: false });
      ctx.enqueue({ type: "adjustRelationship", actorId: id, targetId: pc.id, by: -10 });
      wagePatch[id] = 0;
      beats.push(`${name}, unpaid, gathers their kit and walks — coin was the only thing keeping them at your side.`);
    }
    if (dismissed.length > 0) {
      ctx.enqueue({ type: "modulePatch", module: PARTY_WAGES_MODULE, patch: wagePatch });
    }
  }

  /**
   * Spend one ration per elapsed day; unfed days accrue hunger → exhaustion past the threshold.
   * `boardedDays` are days the party slept at a paid table: those are bought in COIN at the market
   * price of the ration they replace, and only when the purse covers it — a purse too thin falls
   * straight back to the packs, so board is never a way to eat for free.
   */
  private settleFood(
    ctx: TickContext,
    members: Array<Entity & { stats: NonNullable<Entity["stats"]> }>,
    pc: Entity,
    hunger: Record<string, number>,
    days: number,
    beats: string[],
    boardedDays = 0,
  ): void {
    if (members.length === 0) return;
    const wanted = Math.max(0, Math.min(boardedDays, days));
    const purse = pc.stats?.coins ?? 0;
    const boarded = wanted > 0 && purse >= BOARD_CP * wanted ? wanted : 0;
    if (boarded > 0) {
      ctx.enqueue({ type: "adjustCoins", entityId: pc.id, by: -BOARD_CP * boarded });
      beats.push(
        `You take your meal at the hall's table (${BOARD_CP * boarded} cp) — no marching ration is broken into.`,
      );
    }
    const needed = days - boarded;
    // Consume up to `needed` rations from the party's packs (one per unboarded day).
    let consumed = 0;
    for (const m of members) {
      for (const itemId of m.stats.inventory) {
        if (consumed >= needed) break;
        if (itemId === PROVISIONS_ITEM_ID) {
          ctx.enqueue({ type: "transferItem", itemId: PROVISIONS_ITEM_ID, from: m.id, to: null });
          consumed++;
        }
      }
      if (consumed >= needed) break;
    }
    const fedDays = consumed + boarded;
    const hungryDays = days - fedDays;
    let anyBite = false;
    for (const m of members) {
      if (fedDays > 0) {
        // Fed: the ache eases (mirrors the old long-rest ration relief). The hunger counter clears
        // only when the party ate EVERY settled day — a partially-fed settle must keep the accrued
        // unfed days, or scraping one ration together would erase a prior day's hunger (the slice
        // documents hunger as "days unfed since last threshold bite", and a fed day is not an
        // erasure of earlier unfed ones).
        ctx.enqueue({ type: "adjustExhaustion", entityId: m.id, by: -1 });
        if (hungryDays === 0) hunger[m.id] = 0;
      }
      if (hungryDays > 0) {
        let h = (hunger[m.id] ?? 0) + hungryDays;
        while (h >= HUNGER_EXHAUSTION_AT) {
          ctx.enqueue({ type: "adjustExhaustion", entityId: m.id, by: 1 });
          h -= HUNGER_EXHAUSTION_AT;
          anyBite = true;
        }
        hunger[m.id] = h;
      }
    }
    if (hungryDays > 0) {
      beats.push(
        anyBite
          ? "Empty packs and empty bellies — the days without a proper meal have worn the party down to the bone."
          : "The rations have run out; the party goes hungry, and the ache of it starts to gnaw.",
      );
    }
  }
}
