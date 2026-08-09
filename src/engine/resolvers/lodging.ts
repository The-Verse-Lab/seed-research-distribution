/**
 * The lodging domain — resting, making camp, renting a bed, ending the day, and getting up again.
 *
 * Lifted verbatim out of `GameEngine` (see `resolvers/host.ts` for the contract). These five verbs
 * are one domain because they all move the same thing: where the party sleeps and what the clock
 * does about it. The abed trap (r6) lives here — a small-hours rest must not eat a day, a paid
 * night must stay paid, and waking in daylight RISES rather than sleeping again.
 *
 * @author Runkai Zhang
 */
import type { LodgingTier, World } from "../../content/schema.ts";
import type { GameEvent } from "../../events/types.ts";
import { energyOf, maxEnergyOf } from "../../rules/costs.ts";
import { exhaustionOf, workingCap } from "../../rules/exhaustion.ts";
import { MINUTES_PER_DAY, NIGHT_START_MINUTE, REST_WAKE_MINUTE, RISE_MINUTES, SHORT_REST_ENERGY_FRACTION, SHORT_REST_HP_FRACTION, SHORT_REST_MINUTES, restAdvanceMinutes } from "../../rules/rest.ts";
import { formatCoins, tradePriceCp } from "../../rules/items.ts";
import { regionOfLocation } from "../../rules/regions.ts";
import { displayName, type Entity } from "../../world/entity.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";
import { CAMP_LOCATION_ID, isAtCamp, readCampSlice, resolveCampLocation } from "../../world/camp.ts";
import { LODGING_LOCATION_ID, isAtLodging, readLodgingSlice, resolveLodgingLocation } from "../../world/lodging.ts";
import { isCombatActive } from "../../world/queries.ts";
import type { NarrationIntent } from "../../modules/narration.ts";
import { naturalList } from "./phrasing.ts";
import type { TickContext } from "../tick.ts";
import type { TurnPlan } from "../turn-plan.ts";

/**
 * Ensure the synthetic Camp location (long rest) exists in the world content mirror. Fixed content,
 * NOT durable world data: materialized the first time the party makes camp (and re-derived at load
 * only while a reloaded session is still camped), so a session that never rests keeps world.locations
 * untouched. Idempotent; emits no delta and touches no durable slice. Same guard as `expandFrontier`.
 */
export function ensureCampLocation(world: World): void {
  if (!world.locations.some((l) => l.id === CAMP_LOCATION_ID)) {
    world.locations.push(resolveCampLocation(world));
  }
}

/**
 * Ensure the synthetic rented Room exists in the content mirror, themed for the CURRENT stay (hall
 * name + tier), so the narrator can name it. Unlike Camp this is per-stay: the room reflects which
 * hall and whether it's a private room or a shared loft, so it REPLACES any prior room node. Spliced
 * out on Wake (like Camp), rebuilt from the slice on reload. Idempotent; emits no delta.
 */
export function ensureLodgingLocation(world: World, hallName: string, tier: LodgingTier | undefined): void {
  const idx = world.locations.findIndex((l) => l.id === LODGING_LOCATION_ID);
  if (idx >= 0) world.locations.splice(idx, 1);
  world.locations.push(resolveLodgingLocation(hallName, tier));
}

/**
 * A SHORT rest (BG3-style) — a breather in place. Blocked while a fight is live or a hostile monster
 * stands here; otherwise every CONSCIOUS party member recovers a PORTION of their missing hp/energy
 * and ~an hour passes (no new day). Does NOT revive the downed and does NOT fold NPC memory — those
 * are the long rest (End Day). All mechanics in code; the model narrates.
 */
export function resolveRest(ctx: TickContext): NarrationIntent {
  const model = ctx.model;
  // Already at camp: a short rest is meaningless (and its own clock-advance would defeat the camp
  // time-freeze). End Day is the rest here.
  if (isAtCamp(model)) {
    return { trigger: "You are already at camp — end the day to rest through the night." };
  }
  if (isCombatActive(model)) {
    return {
      trigger: "You try to rest, but the fight is still on you — there is no stepping out of it here.",
      deterministic: true,
    };
  }
  const loc = partyLocationOf(model);
  const threat =
    loc !== null &&
    entitiesAt(model, loc).some(
      (e) => e.kind === "monster" && !e.partyMember && (e.stats?.currentHp ?? 0) > 0,
    );
  if (threat) {
    return {
      trigger: "You try to settle down, but something hostile is too close to let you rest easy. Narrate the unease.",
    };
  }
  let healed = false;
  for (const e of model.entities.values()) {
    if (!e.partyMember || !e.stats) continue;
    // A short rest does NOT revive the downed — that needs a full night (End Day).
    if (e.stats.conditions.includes("unconscious")) continue;
    const missingHp = e.stats.maxHp - e.stats.currentHp;
    const hpGain = Math.floor(missingHp * SHORT_REST_HP_FRACTION);
    if (hpGain > 0) {
      ctx.apply({ type: "adjustHp", entityId: e.id, by: hpGain });
      healed = true;
    }
    const maxE = maxEnergyOf(e.stats);
    const cap = workingCap(exhaustionOf(e.stats), maxE);
    const missingE = cap - Math.min(energyOf(e.stats), cap);
    const eGain = Math.floor(missingE * SHORT_REST_ENERGY_FRACTION);
    if (eGain > 0) {
      ctx.apply({ type: "adjustEnergy", entityId: e.id, by: eGain });
    }
  }
  // A short rest is an hour, not a night — the day does NOT roll over.
  ctx.apply({ type: "advanceClock", by: SHORT_REST_MINUTES });
  ctx.emit({
    kind: "stateChanged",
    summary: healed ? "The party takes a short rest — some strength returns." : "The party takes a short rest.",
    changes: { shortRested: true },
  });
  return {
    trigger:
      "You take a short rest — a breather to catch your wind, not a full night. Narrate the pause and the partial recovery.",
  };
}

/**
 * Long rest, part one — MAKE CAMP. Teleports the player + the party members currently with them to
 * the inaccessible Camp location (no recovery yet; that's End Day). Blocked while a fight is live or
 * a hostile monster stands here. Stores the origin in the camp slice so End Day returns everyone.
 */
export function resolveEnterCamp(
  ctx: TickContext,
  /** Arm the engine's one-turn camp-under-a-roof confirmation (see the r4 camp gate). */
  arm: (pending: { locationId: string }) => void,
  opts?: { viaEndDay?: boolean }): NarrationIntent {
  const model = ctx.model;
  if (isAtCamp(model)) {
    return { trigger: "You are already at camp. Narrate the quiet of the fire and the settled company." };
  }
  if (isCombatActive(model)) {
    return { trigger: "You cannot break for camp — the fight is still on you." };
  }
  const from = partyLocationOf(model);
  if (from === null) {
    return { trigger: "There is nowhere to make camp from here." };
  }
  // Camping where beds are sold takes a CONFIRMATION (r4 P1: a misread "cot in the loft" fired
  // MAKE CAMP silently — ration spent, no coin charged, and the camp narrator invented a road).
  // First ask answers with the choice out loud and arms `pendingCamp`; a repeat commits. The
  // End Day chain BYPASSES the gate — "I sleep through the night" already IS the commitment,
  // and resolveEndDay requires the chain to leave the party camped.
  const gateLoc = ctx.services.world.locations.find((l) => l.id === from);
  if (gateLoc?.guild?.lodging !== undefined && !opts?.viaEndDay) {
    const armed = ctx.data.pendingCamp as { locationId: string } | undefined;
    if (!armed || armed.locationId !== from) {
      arm({ locationId: from });
      ctx.data.clockMinutes = 1;
      ctx.data.energyCost = 0;
      return {
        trigger:
          `There are beds for coin here at ${gateLoc.name} — you need not sleep rough. ` +
          `Say "make camp" again and the party quits the roof for the roadside; or take a room instead.`,
        deterministic: true,
      };
    }
  }
  const threat = entitiesAt(model, from).some(
    (e) => e.kind === "monster" && !e.partyMember && (e.stats?.currentHp ?? 0) > 0,
  );
  if (threat) {
    return {
      trigger: "You cannot settle for the night — something hostile is too close to make camp. Narrate the unease.",
    };
  }
  const memberIds = entitiesAt(model, from)
    .filter((e) => e.partyMember)
    .map((e) => e.id);
  // Materialize the Camp location into the content mirror the first time the party rests, so the
  // narrator/session can name it (idempotent; no delta).
  ensureCampLocation(ctx.services.world);
  // Teleport the co-located party to Camp (moveParty auto-follows every partyMember here); non-party
  // NPCs are left behind. `teleport` bypasses the barrier check (Camp has no incoming exit).
  ctx.apply({ type: "moveParty", to: CAMP_LOCATION_ID, teleport: true });
  ctx.apply({
    type: "modulePatch",
    module: "camp",
    patch: { active: true, returnLocationId: from, memberIds, enteredClock: model.clock },
  });
  // Camping from somewhere with beds for coin is a CHOICE, and leaving an interior for the
  // roadside is a real relocation — say both out loud (2026-07-25 playtest read the silent
  // interior→roadside move as a teleport bug and lost trust in the button).
  const fromLoc = ctx.services.world.locations.find((l) => l.id === from);
  const hasLodging = fromLoc?.guild?.lodging !== undefined;
  const fromName = fromLoc?.name ?? "where you were";
  ctx.emit({
    kind: "stateChanged",
    summary: hasLodging
      ? `The party leaves ${fromName} to make camp on the roadside for the night.`
      : "The party makes camp for the night.",
    changes: { partyLocationId: CAMP_LOCATION_ID, camp: true },
  });
  // Pin the camp to its origin (r4 P1: an unanchored camp narration invented "the east road,
  // six days to the Widow" while the map still read the Undercroft). The narrator gets the
  // geography AND an explicit no-travel directive.
  const regionId = regionOfLocation(ctx.services.world, from);
  const regionName = regionId
    ? (ctx.services.world.regions?.find((r) => r.id === regionId)?.name ?? null)
    : null;
  const anchor =
    `The camp sits just outside ${fromName}${regionName ? `, still within ${regionName}` : ""}. ` +
    `The party did NOT travel — do not narrate a road taken, a journey, distances, or directions.`;
  return {
    trigger: hasLodging
      ? `You quit ${fromName}'s roof for a roadside camp beyond its walls — there are beds for coin back there if you'd rather have stayed. ${anchor} Narrate leaving and settling at the fire. Time holds here until you choose to end the day.`
      : `You make camp for the night, the day set aside. ${anchor} Narrate settling into the camp — the fire, the company, the stillness. Time holds here until you choose to end the day.`,
  };
}

/**
 * Long rest, part two — END DAY. Full recovery (the old long-rest loop): every party member heals to
 * full, shakes `unconscious`, energy restores; the clock rolls to the next morning; NPC memory folds.
 * Then everyone camped returns to the stored origin (the LIVE party set — anyone recruited at camp
 * comes home too). No-op unless the party is at camp.
 */
export function resolveEndDay(
  ctx: TickContext,
  /** Threaded through to {@link resolveEnterCamp} — an End Day under a roof still routes via the
   *  camp confirmation, so it arms the same one-turn quote. */
  arm: (pending: { locationId: string }) => void,
): NarrationIntent {
  const model = ctx.model;
  if (!isAtCamp(model)) {
    // "I sleep through the night" typed rough — not camped, no room. The player's intent is the
    // NIGHT, so CHAIN: make camp right here (every enterCamp guard applies — combat and nearby
    // threats still refuse) and fall through to the full End Day below. The old path returned a
    // "narrate the confusion" seed, and the narrator delivered a whole dawn the clock refused
    // (r2 P1 phantom night: three narrated dawns for one day advance). A failed chain refuses
    // DETERMINISTICALLY — no narrator, so no night can be written that did not happen.
    resolveEnterCamp(ctx, arm, { viaEndDay: true });
    if (!isAtCamp(model)) {
      return {
        trigger: isCombatActive(model)
          ? "You cannot bed down for the night — the fight is still on you."
          : "You cannot settle in to sleep here — something hostile is too close, and no night passes. (Reach safer ground, make camp, or take a room.)",
        deterministic: true,
      };
    }
  }
  const camp = readCampSlice(model);
  let healed = false;
  const camped = [...model.entities.values()].filter(
    (e): e is Entity & { stats: NonNullable<Entity["stats"]> } =>
      e.partyMember && e.stats !== undefined && e.locationId === CAMP_LOCATION_ID,
  );
  // Food + the fed/hungry exhaustion swing are settled by the UpkeepModule on this same tick's day
  // rollover (it owns rations for both rest AND night-march day crossings). End Day only heals.
  for (const e of camped) {
    if (e.stats.conditions.includes("unconscious")) {
      ctx.apply({ type: "setCondition", entityId: e.id, condition: "unconscious", active: false });
    }
    if (e.stats.currentHp < e.stats.maxHp) {
      ctx.apply({ type: "adjustHp", entityId: e.id, by: e.stats.maxHp - e.stats.currentHp });
      healed = true;
    }
    const maxE = maxEnergyOf(e.stats);
    const currentE = energyOf(e.stats);
    if (currentE < maxE) {
      ctx.apply({ type: "adjustEnergy", entityId: e.id, by: maxE - currentE });
    }
  }
  // A full night: advance to the next day's wake hour so the DAY counter rolls over.
  ctx.apply({ type: "advanceClock", by: restAdvanceMinutes(ctx.model.clock) });
  // Sleep consolidation (statefulness #3) + disclosure checkpoint — off the critical path, best-effort.
  void ctx.services.npcHistory?.foldAll(ctx.services.gateway);
  void ctx.services.disclosure?.save();
  // Return EVERYONE at Camp to where the party was — party members AND any straggler (a companion
  // dismissed while camped, a camp-event body) — so nobody is stranded at the exit-less Camp. Snapshot
  // the list first (the loop mutates locationId). `teleport` steps past Camp's missing exit.
  const back = camp.returnLocationId ?? ctx.services.campaign.startingState.locationId;
  for (const e of [...entitiesAt(model, CAMP_LOCATION_ID)]) {
    ctx.apply({ type: "moveEntity", entityId: e.id, to: back, teleport: true });
  }
  ctx.apply({
    type: "modulePatch",
    module: "camp",
    patch: { active: false, returnLocationId: null, memberIds: [], enteredClock: 0 },
  });
  // Camp is transient content: drop it from the world mirror now the party has left, so it can never
  // leak into a save / world-editor as durable, map-placed content (it re-injects on the next rest).
  const world = ctx.services.world;
  const campIdx = world.locations.findIndex((l) => l.id === CAMP_LOCATION_ID);
  if (campIdx >= 0) world.locations.splice(campIdx, 1);
  ctx.emit({
    kind: "stateChanged",
    summary: healed
      ? "The party breaks camp — wounds closed, a new day begun."
      : "The party breaks camp — a new day begins.",
    changes: { rested: true, camp: false, partyLocationId: back },
  });
  return {
    trigger:
      "You break camp as the new day begins — the party wakes recovered and returns to the road where they left it. Narrate the waking, the packing away, and the day ahead.",
  };
}

/**
 * RENT A ROOM — the hall-as-hub lodging entry. Requires the PC at a `guild` hall that offers beds;
 * charges the tier's nightly coin (honest refusal if short); teleports the PC ALONE into the
 * synthetic private room (companions stay in the common hall — aloneness is the risk); stores the
 * origin + tier in the lodging slice so Wake can return the PC and the room-events roller/opportunity
 * scorer can read privacy. Blocked in combat / already lodging / at camp.
 */
export function resolveRentRoom(ctx: TickContext, plan: TurnPlan): NarrationIntent {
  const model = ctx.model;
  if (isAtLodging(model)) {
    return { trigger: "You have already taken a room for the night. Rise when you are ready to face the day." };
  }
  if (isCombatActive(model)) {
    return { trigger: "You cannot bed down — the fight is still on you." };
  }
  if (isAtCamp(model)) {
    return { trigger: "You are already camped for the night — there are no rooms to rent out here." };
  }
  const player = playerEntity(model);
  const from = partyLocationOf(model);
  if (from === null || !player?.stats) {
    return { trigger: "There is nowhere to take a room here." };
  }
  const locData = ctx.services.world.locations.find((l) => l.id === from);
  const lodging = locData?.guild?.lodging;
  if (!lodging || lodging.tiers.length === 0) {
    return { trigger: "There are no beds for rent here — this is no place to sleep for coin. Narrate the absence." };
  }
  const coins = player.stats.coins ?? 0;
  const requested = plan.lodging?.tierId ? lodging.tiers.find((t) => t.id === plan.lodging?.tierId) : undefined;
  // No tier named (a bare "rent a room"): take the cheapest bed the player can afford, else the
  // cheapest on offer (so the affordability refusal below can name the real gap).
  const byPrice = [...lodging.tiers].sort((a, b) => a.nightlyCp - b.nightlyCp);
  const tier = requested ?? byPrice.find((t) => t.nightlyCp <= coins) ?? byPrice[0];
  if (!tier) {
    return { trigger: "There are no beds for rent here." };
  }
  // A night already bought at THIS hall is still bought: the player who stepped out at noon and
  // came back up costs nothing more until the next dawn.
  const paid = readLodgingSlice(model);
  const stillPaid =
    paid.hallId === from && typeof paid.paidThroughClock === "number" && model.clock < paid.paidThroughClock;
  if (!stillPaid && coins < tier.nightlyCp) {
    return {
      trigger:
        `${tier.label} costs ${tier.nightlyCp} cp for the night, more coin than you carry. You cannot take the room. Narrate turning away, short of coin.`,
      deterministic: true,
    };
  }
  if (!stillPaid) ctx.apply({ type: "adjustCoins", entityId: player.id, by: -tier.nightlyCp });
  const hallName = locData?.guild?.name ?? locData?.name ?? "the hall";
  ensureLodgingLocation(ctx.services.world, hallName, tier);
  // Teleport the PC ALONE (moveEntity, not moveParty): companions keep the common hall. `teleport`
  // bypasses the barrier check (the room has no incoming exit).
  ctx.apply({ type: "moveEntity", entityId: player.id, to: LODGING_LOCATION_ID, teleport: true });
  ctx.apply({
    type: "modulePatch",
    module: "lodging",
    patch: {
      active: true,
      returnLocationId: from,
      hallId: from,
      guildFactionId: locData?.guild?.factionId ?? null,
      tierId: tier.id,
      private: tier.private,
      enteredClock: model.clock,
    },
  });
  ctx.emit({
    kind: "stateChanged",
    summary: stillPaid
      ? `You go back up to ${tier.label} — the night is already paid.`
      : `You take ${tier.label} for the night (${tier.nightlyCp} cp).`,
    changes: { partyLocationId: LODGING_LOCATION_ID, lodging: true },
  });
  // DAYLIGHT honesty (r6 P3): a bed taken at noon is a room held until dark, NOT a sleep — the
  // old settling-in narration played a full bedding-down that charged the coin and did nothing,
  // offered exactly when a hurt player was looking for recovery. Say plainly what the coin bought.
  const intoDay = model.clock % MINUTES_PER_DAY;
  const daylight = intoDay >= REST_WAKE_MINUTE && intoDay < NIGHT_START_MINUTE;
  if (daylight) {
    return {
      trigger:
        `You take ${tier.label} — the room is yours until morning, but sleep won't come in daylight. ` +
        `Narrate dropping your pack and sitting a while: a place to rest and wait, not a night's sleep. ` +
        `(Come evening you can sleep the night through; a SHORT REST is what mends wounds by day.)`,
    };
  }
  return {
    trigger: tier.private
      ? "You pay for a room and bar the door behind you. Narrate settling in for the night — the bed, the shuttered window, the muffled noise of the hall below. Rest here until you choose to rise; sleep leaves you exposed."
      : "You pay for a bunk in the common loft and find an empty bedroll among the others. Narrate bedding down amid the breathing of strangers. Rest here until you choose to rise.",
  };
}

/**
 * WAKE — the lodging counterpart to End Day. Full recovery for the WHOLE party (they bunked at the
 * hall even while the PC took a private room): heal, clear `unconscious`, restore energy; consume one
 * ration if held (the exhaustion tick, as End Day); advance to the next morning; fold NPC memory; then
 * teleport everyone back to the hall and splice the room from the mirror.
 */
export function resolveWakeInRoom(ctx: TickContext, opts: { sleep?: boolean } = {}): NarrationIntent {
  const model = ctx.model;
  if (!isAtLodging(model)) {
    return { trigger: "You are not resting in a room — there is no night to sleep through here." };
  }
  const slice = readLodgingSlice(model);
  // RISING is not SLEEPING (r5 P1). Wake used to mean "sleep the night through" whatever the hour,
  // so a player who took a bunk in the afternoon and then got up lost the rest of that day and all
  // of the next — the reporting run lost a day, a quest and its deadline to one press of it. In
  // DAYLIGHT this gets you up; from the evening or the small hours it sleeps the night through, and
  // an explicit sleep intent ("sleep until first light", End Day — both routed here while abed)
  // always sleeps, whatever the clock says.
  const intoDay = model.clock % MINUTES_PER_DAY;
  const sleeping = opts.sleep === true || intoDay >= NIGHT_START_MINUTE || intoDay < REST_WAKE_MINUTE;
  if (!sleeping) return riseFromRoom(ctx, slice);
  const party = [...model.entities.values()].filter(
    (e): e is Entity & { stats: NonNullable<Entity["stats"]> } => e.partyMember && e.stats !== undefined,
  );
  // Food + the fed/hungry exhaustion swing are settled by the UpkeepModule on this same tick's day
  // rollover — waking only heals.
  let healed = false;
  for (const e of party) {
    if (e.stats.conditions.includes("unconscious")) {
      ctx.apply({ type: "setCondition", entityId: e.id, condition: "unconscious", active: false });
    }
    if (e.stats.currentHp < e.stats.maxHp) {
      ctx.apply({ type: "adjustHp", entityId: e.id, by: e.stats.maxHp - e.stats.currentHp });
      healed = true;
    }
    const maxE = maxEnergyOf(e.stats);
    const currentE = energyOf(e.stats);
    if (currentE < maxE) {
      ctx.apply({ type: "adjustEnergy", entityId: e.id, by: maxE - currentE });
    }
  }
  ctx.apply({ type: "advanceClock", by: restAdvanceMinutes(ctx.model.clock) });
  // The bed was paid for; its board feeds the party for the day this rest crosses into. UpkeepModule
  // reads this in the react phase, by which point everyone is back in the hall and the lodging slice
  // is already cleared — the stamp is the only surviving evidence the night was bought (r5 P2).
  ctx.data.lodgedNight = true;
  void ctx.services.npcHistory?.foldAll(ctx.services.gateway);
  void ctx.services.disclosure?.save();
  // Return the PC (and anything left at the exit-less room — a defeated/fled intruder body) to the
  // hall where the party waited. Snapshot the list first (the loop mutates locationId).
  const back = slice.returnLocationId ?? ctx.services.campaign.startingState.locationId;
  for (const e of [...entitiesAt(model, LODGING_LOCATION_ID)]) {
    ctx.apply({ type: "moveEntity", entityId: e.id, to: back, teleport: true });
  }
  ctx.apply({
    type: "modulePatch",
    module: "lodging",
    patch: { active: false, returnLocationId: null, hallId: null, guildFactionId: null, tierId: null, private: true, enteredClock: 0 },
  });
  // The room is transient content: drop it from the world mirror now the PC has left (it re-injects
  // on the next rental), so it can never leak into a save / world-editor as durable content.
  const world = ctx.services.world;
  const roomIdx = world.locations.findIndex((l) => l.id === LODGING_LOCATION_ID);
  if (roomIdx >= 0) world.locations.splice(roomIdx, 1);
  ctx.emit({
    kind: "stateChanged",
    summary: healed ? "You wake in the hall, rested — a new day." : "You wake in the hall — a new day.",
    changes: { rested: true, lodging: false, partyLocationId: back },
  });
  return {
    trigger:
      "You wake rested as the new day breaks and come back down into the hall to rejoin your companions. Narrate the waking and the morning ahead.",
  };
}

/**
 * Get up and go back down — the daylight half of Wake. No night passes, no day rolls, no recovery:
 * the room is simply left (and the night stays PAID, so coming back up to it costs nothing more).
 */
export function riseFromRoom(ctx: TickContext, slice: ReturnType<typeof readLodgingSlice>): NarrationIntent {
  const model = ctx.model;
  const back = slice.returnLocationId ?? ctx.services.campaign.startingState.locationId;
  const hallId = slice.hallId;
  ctx.apply({ type: "advanceClock", by: RISE_MINUTES });
  for (const e of [...entitiesAt(model, LODGING_LOCATION_ID)]) {
    ctx.apply({ type: "moveEntity", entityId: e.id, to: back, teleport: true });
  }
  ctx.apply({
    type: "modulePatch",
    module: "lodging",
    patch: {
      active: false,
      returnLocationId: null,
      guildFactionId: null,
      tierId: null,
      private: true,
      enteredClock: 0,
      // Keep the hall + the night the coin bought: re-taking the SAME bed before the next dawn is
      // free, so stepping out for an hour can never charge a player twice for one night.
      hallId,
      paidThroughClock: Math.floor(model.clock / MINUTES_PER_DAY) * MINUTES_PER_DAY + MINUTES_PER_DAY + REST_WAKE_MINUTE,
    },
  });
  const world = ctx.services.world;
  const roomIdx = world.locations.findIndex((l) => l.id === LODGING_LOCATION_ID);
  if (roomIdx >= 0) world.locations.splice(roomIdx, 1);
  ctx.emit({
    kind: "stateChanged",
    summary: "You rise and come back down into the hall.",
    changes: { lodging: false, partyLocationId: back },
  });
  return {
    trigger:
      "You get up off the bed, leave the room as it is, and come back down into the hall. Narrate the rising and the room left behind — the day is still going on out there.",
  };
}
