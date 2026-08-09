/**
 * The item domain — equipping, using, giving, dropping, picking up, reading, and typed wardrobe
 * changes.
 *
 * Lifted verbatim out of `GameEngine` (see `resolvers/host.ts` for the contract). Item resolution
 * is the busiest deterministic path in the engine: it grounds the player's words to a real carried
 * id, preflights the reducer commands, and only then narrates — so prose can never mint or move a
 * thing the world does not agree exists.
 *
 * @author Runkai Zhang
 */
import type { RollResult } from "../../rules/dice.ts";
import { roll } from "../../rules/dice.ts";
import { energyOf } from "../../rules/costs.ts";
import type { GameEvent } from "../../events/types.ts";
import { mentionsName } from "../../rules/continuity.ts";
import { factionOf, factionStandingCommands, giftFactionWarmth } from "../../rules/factions.ts";
import { giftWarmth } from "../../rules/relationships.ts";
import { GROUND_ITEMS_MODULE, groundItemsAt, groundPatchAdd, groundPatchRemove } from "../../rules/ground-items.ts";
import { formatCoins, getMasterItem, itemDisplayNameOf, itemFitsSlot, resolveItem, tradePriceCp, type ResolvedItem } from "../../rules/items.ts";
import { BASELINE_COVERAGE_SLOT_IDS, WARDROBE_MODULE, WARDROBE_SLOT_IDS, isWardrobeSlotId, occupiedSlotsOf, wardrobeSlotLabel, type WardrobeSlice, type WardrobeSlotId, type WardrobeSlotState } from "../../rules/wardrobe.ts";
import { displayName, type Entity, type EquipSlot } from "../../world/entity.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";
import { isCombatActive } from "../../world/queries.ts";
import type { NarrationIntent } from "../../modules/narration.ts";
import { noteExchange } from "./economy.ts";
import { capitalize, naturalList } from "./phrasing.ts";
import type { TickContext } from "../tick.ts";

/** Slot probe order for a bare "equip X" — weapon first, then worn armor, then shield. */
const EQUIP_SLOTS: readonly EquipSlot[] = ["weapon", "armor", "shield"];
import type { TurnPlan } from "../turn-plan.ts";

/** The item id equipped in `slot` on the PC right now (for an `unequip` grounded action), or a
 *  sentinel that grounds to nothing so the resolver narrates "already stowed" rather than acting. */
export function equippedItemInSlot(model: WorldModel, slot: string): string {
  const equipped = playerEntity(model)?.stats?.equipped ?? {};
  return (equipped as Record<string, string | undefined>)[slot] ?? `__empty:${slot}`;
}

/**
 * Resolve a grounded item action — equip/unequip/use/give — with every number from code.
 * A healing consumable rolls its heal dice on the seeded RNG and consumes ONE stacked
 * instance; equip/unequip route through the reducer's `equipItem` (slot fit gated here via
 * `itemFitsSlot` — the reducer only checks possession); give is a `transferItem` to someone
 * present. Anything ungroundable degrades to freeform narration with the item as context.
 * During an active fight a completed action spends the player's combat turn: it parks
 * `ctx.data.itemActionTurn` and the combat module advances the initiative off it.
 */
export function resolveItemAction(ctx: TickContext, plan: TurnPlan, input: string): NarrationIntent {
  const model = ctx.model;
  const player = playerEntity(model);
  // A runtime-conjured item (the grounded acceptItem channel, quest conjures) has NO content row —
  // resolveItem yields undefined and every verb on it used to silently bail to plain narration
  // (the claim token could be minted but never dropped/given: the mark was unbreakable). A HELD
  // id (or one on this floor, for pickup) synthesizes an honest inert row instead — named via the
  // slug prettifier, no mechanics, tradeless.
  const rawItemId = plan.item?.itemId;
  const resolved = rawItemId ? resolveItem(ctx.services.world, rawItemId) : undefined;
  const conjuredFallback: ResolvedItem | undefined =
    !resolved &&
    rawItemId &&
    player?.stats &&
    (player.stats.inventory.includes(rawItemId) ||
      (player.locationId != null && groundItemsAt(model.modules, player.locationId).includes(rawItemId)))
      ? { id: rawItemId, name: itemDisplayNameOf(rawItemId), description: "", kind: "misc", properties: {} }
      : undefined;
  const item = resolved ?? conjuredFallback;
  if (!plan.item || !item || !player?.stats) {
    return { trigger: input };
  }
  // `pickup` is the one verb whose target is by definition NOT carried — it grounds against the
  // floor slice instead (checked in its own case below).
  if (plan.item.verb !== "pickup" && !player.stats.inventory.includes(item.id)) {
    return { trigger: `You reach for the ${item.name}, but you are not carrying it. ${input}` };
  }
  if (player.stats.currentHp <= 0) {
    return {
      trigger: `You are down — the world swims dark and your hands will not answer. (Rest or victory can bring you back.)`,
    };
  }
  // A completed action mid-fight takes the player's turn in the initiative order.
  const spendCombatTurn = (): void => {
    if (isCombatActive(model)) ctx.data.itemActionTurn = { actorId: player.id };
  };

  switch (plan.item.verb) {
    case "equip": {
      const requested = compoundEquipItems(ctx, player.stats.inventory, item, input);
      const readied: ResolvedItem[] = [];
      let changed = false;
      for (const requestedItem of requested) {
        const slot = EQUIP_SLOTS.find((s) => itemFitsSlot(requestedItem, s));
        if (!slot) continue;
        const res = ctx.apply({
          type: "equipItem",
          entityId: player.id,
          slot,
          itemId: requestedItem.id,
        });
        if (res.rejected) {
          if (requestedItem.id === item.id) {
            return { trigger: `You try to ready the ${item.name}, but cannot. ${input}` };
          }
          continue;
        }
        readied.push(requestedItem);
        if (!res.mutated) continue;
        changed = true;
        ctx.emit({
          kind: "stateChanged",
          summary: `You equip the ${requestedItem.name}.`,
          changes: { entityId: player.id, slot, itemId: requestedItem.id },
        });
      }
      if (readied.length === 0) {
        return { trigger: `You handle the ${item.name}, but it is nothing you can wield or wear. ${input}` };
      }
      if (!changed) {
        const subject = capitalize(naturalList(readied.map((entry) => `the ${entry.name}`)));
        return {
          trigger: `${subject} ${readied.length === 1 ? "is" : "are"} already readied. You settle your gear and stay alert.`,
        };
      }
      spendCombatTurn();
      // MECHANICAL CLICKS DON'T PAY A NARRATOR ROUND-TRIP (live 07-24: an equip/unequip/buy/sell
      // issued as typed actions cost one full streamed narrator call — 60-120s on a reasoning model —
      // to re-say a line the resolver had already written in finished player-facing prose). The
      // four bookkeeping successes (equip / unequip / buy / sell) are marked `deterministic`, so
      // NarrationModule emits the trigger verbatim and skips the model entirely. `give` stays
      // model-narrated on purpose: a gift is a social beat, not bookkeeping.
      //
      // DELIBERATE CONSEQUENCE: CombatModule.liftPlayerLine refuses to fold a `deterministic`
      // intent into the round beat, so an IN-COMBAT equip now renders as its own short plain line
      // PLUS the combat beat instead of one folded beat. That is NOT a regression of live 07-18 #3
      // (see CombatModule's `itemActionTurn` branch) — that failure was a second MODEL-narrated
      // beat built on a combat-blind brief, which re-established the peaceful scene
      // mid-fight. This path makes no model call at all: one short true line, nothing re-established.
      return { trigger: `You ready ${naturalList(readied.map((entry) => `the ${entry.name}`))} for use.`, deterministic: true };
    }

    case "unequip": {
      const equipped = player.stats.equipped ?? {};
      const slot = EQUIP_SLOTS.find((s) => equipped[s] === item.id);
      if (!slot) return { trigger: `The ${item.name} is already stowed. ${input}` };
      ctx.apply({ type: "equipItem", entityId: player.id, slot, itemId: null });
      ctx.emit({
        kind: "stateChanged",
        summary: `You stow the ${item.name}.`,
        changes: { entityId: player.id, slot, itemId: null },
      });
      spendCombatTurn();
      // Bookkeeping success — already complete player-facing prose, so no narrator call (see the
      // equip case above for the full rationale and the in-combat consequence).
      return { trigger: `You stow the ${item.name}.`, deterministic: true };
    }

    case "give": {
      const targetId = plan.item.targetId ?? plan.targetId;
      const target = targetId && targetId !== player.id ? model.entities.get(targetId) : undefined;
      if (!target || target.locationId !== player.locationId) {
        return { trigger: `You hold out the ${item.name}, but there is no one here to take it. ${input}` };
      }
      if (!target.stats) {
        return { trigger: `You offer the ${item.name} to ${target.name}, but they cannot take it. ${input}` };
      }
      const res = ctx.apply({ type: "transferItem", itemId: item.id, from: player.id, to: target.id });
      if (res.rejected) return { trigger: `You try to hand over the ${item.name}, but cannot. ${input}` };
      // A genuine gift warms the recipient toward the PC, scaled by the item's worth (distinct
      // from a transactional sale). The reducer clamps.
      const giftValueCp = tradePriceCp(item, 1)?.buy ?? 0;
      ctx.apply({
        type: "adjustRelationship",
        actorId: target.id,
        targetId: player.id,
        by: giftWarmth(giftValueCp),
      });
      // …and a little of that goodwill accrues to the recipient's faction (living faction system).
      for (const cmd of factionStandingCommands(
        ctx.services.world,
        player.id,
        factionOf(ctx.services.world, target.id),
        giftFactionWarmth(giftValueCp),
      )) {
        ctx.apply(cmd);
      }
      ctx.emit({
        kind: "stateChanged",
        summary: `You give the ${item.name} to ${target.name}.`,
        changes: { itemId: item.id, from: player.id, to: target.id },
      });
      noteExchange(ctx, model, {
        npcId: target.id,
        npcName: target.name,
        kind: "gift",
        lines: [{ itemId: item.id, name: item.name, quantity: 1, eachCp: null }],
        coinsCp: 0,
        note: `You give the ${item.name} to ${target.name}.`,
      });
      spendCombatTurn();
      return {
        trigger: `You hand the ${item.name} to ${target.name}. Narrate the exchange in a sentence or two.`,
      };
    }

    case "drop": {
      // A freeform surrender/discard mints the SAME authoritative delta the give path does — the
      // item genuinely leaves the sheet (to the world, not to a holder), so later narration can
      // never quietly hand it back (live r2/r3: "I lay my club on the flagstones" left the club
      // carried ×1 and immediately swingable). One instance leaves a stack; equip slots vacate
      // via the reducer's transferItem path.
      const res = ctx.apply({ type: "transferItem", itemId: item.id, from: player.id, to: null });
      if (res.rejected) return { trigger: `You move to set the ${item.name} down, but cannot. ${input}` };
      // Record WHERE it landed (the groundItems slice) so `pickup` can find it later — dropped
      // gear is recoverable, not annihilated (live 07-18 #2). Absolute per-location array via the
      // generic modulePatch ⇒ replay-safe with no new Command kind.
      if (player.locationId) {
        ctx.apply({
          type: "modulePatch",
          module: GROUND_ITEMS_MODULE,
          patch: groundPatchAdd(model.modules, player.locationId, item.id),
        });
      }
      ctx.emit({
        kind: "stateChanged",
        summary: `You set down the ${item.name}.`,
        changes: { itemId: item.id, from: player.id, to: null },
      });
      spendCombatTurn();
      return {
        trigger: `You set the ${item.name} down and it is no longer yours to wield. ${input}`,
      };
    }

    case "pickup": {
      // The inverse of drop (live 07-18 #2: a dropped club was lost for good; "I pick up my club"
      // drifted to an armor equip). The id was grounded against THIS floor's slice (FLOOR_ITEMS),
      // and the floor is re-checked here at resolve time — a stale or hallucinated pickup degrades
      // to the honest refusal, never mints an item from nothing.
      const loc = player.locationId;
      const patch = loc ? groundPatchRemove(model.modules, loc, item.id) : null;
      if (!patch) {
        return { trigger: `You look about for the ${item.name}, but it is not here to take. ${input}` };
      }
      const res = ctx.apply({ type: "transferItem", itemId: item.id, from: null, to: player.id });
      if (res.rejected) return { trigger: `You reach for the ${item.name}, but cannot take it up. ${input}` };
      ctx.apply({ type: "modulePatch", module: GROUND_ITEMS_MODULE, patch });
      ctx.emit({
        kind: "stateChanged",
        summary: `You pick up the ${item.name}.`,
        changes: { itemId: item.id, from: null, to: player.id },
      });
      spendCombatTurn();
      return { trigger: `You take the ${item.name} back into your hands. ${input}` };
    }

    case "read": {
      // A readable item (letter/note/missive): its authored `properties.body` is surfaced as the
      // narration grounding, and an optional `properties.offersQuest` makes the READ itself the
      // in-fiction delivery beat for a quest. The offer flip is ENQUEUED (committed at tick end,
      // not applied mid-resolve) so the inline offer card lands AFTER the letter's prose — the
      // apply-hook (`surfaceQuestOffers`) emits `questOffered` when that commit lands. Malformed
      // data degrades to plain narration, never a crash (the heal-dice precedent).
      const body = typeof item.properties.body === "string" ? item.properties.body.trim() : "";
      const offersQuest = typeof item.properties.offersQuest === "string" ? item.properties.offersQuest : null;
      if (offersQuest && model.quests.get(offersQuest) === "hidden") {
        ctx.enqueue({ type: "setQuestState", questId: offersQuest, state: "offered" });
      }
      spendCombatTurn();
      return {
        trigger: body
          ? `You unfold the ${item.name} and read:\n\n${body}`
          : `You read the ${item.name}. ${input}`,
      };
    }

    case "use": {
      const heal = typeof item.properties.heal === "string" ? item.properties.heal : null;
      if (!heal) {
        // Food/drink restoring energy (Workstream H): an authored integer `properties.energy`
        // is applied through the reducer and consumes ONE stacked instance — malformed data
        // degrades to narration, never a crash (the heal-dice precedent).
        const energyProp = item.properties.energy;
        const gain =
          typeof energyProp === "number" && Number.isInteger(energyProp) && energyProp > 0
            ? energyProp
            : null;
        if (gain !== null) {
          const before = energyOf(player.stats);
          ctx.apply({ type: "adjustEnergy", entityId: player.id, by: gain });
          const restored = energyOf(player.stats) - before;
          ctx.apply({ type: "transferItem", itemId: item.id, from: player.id, to: null });
          ctx.emit({
            kind: "stateChanged",
            summary: `${player.name}: +${restored} energy (${item.name} consumed)`,
            changes: { entityId: player.id, restored, itemId: item.id },
          });
          spendCombatTurn();
          return {
            trigger:
              restored > 0
                ? `You consume the ${item.name} and feel some strength return.`
                : `You consume the ${item.name}, though you were not in need of it.`,
          };
        }
        // No coded effect — the DM narrates the use with the item as grounding context.
        return { trigger: `You use the ${item.name}. ${input}` };
      }
      let healRoll: RollResult;
      try {
        healRoll = roll(heal, ctx.services.rng);
      } catch {
        return { trigger: `You use the ${item.name}. ${input}` }; // malformed authored dice — narrate, no numbers
      }
      const before = player.stats.currentHp;
      ctx.apply({ type: "adjustHp", entityId: player.id, by: healRoll.total });
      const healed = player.stats.currentHp - before;
      ctx.apply({ type: "transferItem", itemId: item.id, from: player.id, to: null });
      ctx.emit({
        kind: "diceRolled",
        actorId: player.id,
        notation: heal,
        rolls: healRoll.rolls,
        total: healRoll.total,
        purpose: `${item.name} — healing`,
      });
      ctx.emit({
        kind: "stateChanged",
        summary: `${player.name}: +${healed} HP → ${player.stats.currentHp}/${player.stats.maxHp} HP (${item.name} consumed)`,
        changes: { entityId: player.id, healed, itemId: item.id },
      });
      spendCombatTurn();
      return {
        trigger:
          healed > 0
            ? `You drink the ${item.name} and warmth knits ${healed} points of hurt closed.`
            : `You drink the ${item.name}, but you are already whole — it is spent all the same.`,
      };
    }
  }
}

/** Carried, equip-compatible items explicitly named in readiness clauses, in mention order. */
export function explicitEquipItems(
ctx: TickContext,inventory: string[], input: string): ResolvedItem[] {
  const clauses = input.split(/\b(?:and|then)\b|[,;]/i);
  const cue = /\b(?:equip|wear|don|buckle|strap|wield|ready|draw|take|hold|grip|hand)\b/i;
  const matches: Array<{ item: ResolvedItem; at: number }> = [];
  const seen = new Set<string>();
  const lower = input.toLowerCase();
  for (const id of inventory) {
    if (seen.has(id)) continue;
    seen.add(id);
    const candidate = resolveItem(ctx.services.world, id);
    if (!candidate || !EQUIP_SLOTS.some((slot) => itemFitsSlot(candidate, slot))) continue;
    const name = candidate.name.toLowerCase();
    const clause = clauses.find((part) => part.toLowerCase().includes(name) && cue.test(part));
    if (!clause) continue;
    matches.push({ item: candidate, at: lower.indexOf(name) });
  }
  matches.sort((a, b) => a.at - b.at);
  return matches.map((entry) => entry.item);
}

/**
 * Expand an already-grounded EQUIP intent to every other explicitly named piece of carried gear.
 * The classifier's primary is retained even if its wording lacks a local readiness cue; named
 * compound items keep the player's mention order. Non-equip clauses ("and give the club away")
 * remain inert.
 */
export function compoundEquipItems(
ctx: TickContext,inventory: string[], primary: ResolvedItem, input: string): ResolvedItem[] {
  const explicit = explicitEquipItems(ctx, inventory, input);
  if (explicit.some((item) => item.id === primary.id)) return explicit;
  return [primary, ...explicit];
}

/** Resolve a classifier-proposed item hand-over from a present NPC or recent scene prose. */
/**
 * Did the recent transcript actually put this object in the scene? The membership rule the
 * prose-entity module already applies to PEOPLE, applied to things: an object is real enough to
 * pick up when the narration (or an NPC's line) named it, and a name the world never wrote is a
 * player invention that mints nothing.
 */
export function namedInRecentProse(ctx: TickContext, itemName: string, itemId: string): boolean {
  const prose = [
    ...ctx.recent
      .filter((e): e is Extract<GameEvent, { kind: "narration" | "dialogue" }> =>
        e.kind === "narration" || e.kind === "dialogue",
      )
      .slice(-8)
      .map((e) => e.text),
    (ctx.data.lastNarration as string | undefined) ?? "",
  ].join("\n");
  if (!prose.trim()) return false;
  const slug = itemId.replace(/^item\./, "").replace(/-/g, " ");
  return mentionsName(prose, itemName) || mentionsName(prose, slug);
}


/**
 * Coin denominations, spelled the way both the engine and the narrator spell them. `copper`/`silver`
 * /`gold` are here as bare metals too: the prose says "the six coppers", not "6 cp".
 */
const COIN_WORD = "cp|sp|gp|copper|coppers|silver|silvers|gold|golds|coin|coins|piece|pieces";
/** A NUMBER (digits or a written-out small number) attached to a coin word — "six coppers", "3 cp". */
const COIN_COUNT =
  "\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an|the|some|few|handful";
const COIN_QUANTITY_RE = new RegExp(
  `^\\s*(?:${COIN_COUNT})[\\s-]+(?:of[\\s-]+)?(?:${COIN_WORD})\\s*$`,
  "i",
);
/** A bare denomination with no count: "coppers", "coin". */
const BARE_COIN_RE = new RegExp(`^\\s*(?:${COIN_WORD})\\s*$`, "i");

/**
 * Is this "item" actually an amount of MONEY?
 *
 * r11 P1: `I pocket the six coppers` minted `item.six-coppers` out of nothing and handed it to the
 * player, because the unattended branch's only content guard is `namedInRecentProse` — and the
 * narrator's own previous sentence, describing the player's PURSE BALANCE ("six coppers heavier is
 * not a weight you can feel"), satisfied it. The coppers it minted were the ones that same prose had
 * just said belonged to the vendor: "counted, hers, and not coming back."
 *
 * Coin is a first-class purse quantity (`coinsChanged`), so minting it as an object creates a second,
 * parallel copy of the same money — and one that can then be sold. Both the id slug and the display
 * name are tested: a runtime-conjured id has no content row, so the name is only the prettified slug.
 */
export function isCoinQuantity(itemId: string, itemName: string): boolean {
  const slug = itemId.replace(/^item\./, "").replace(/[-_]+/g, " ");
  return [slug, itemName].some((s) => COIN_QUANTITY_RE.test(s) || BARE_COIN_RE.test(s));
}

export function resolveAcceptItemEffect(
  ctx: TickContext,
  itemId: string,
  fromNpcId: string | null,
): string | null {
  const model = ctx.model;
  const player = playerEntity(model);
  const giver = fromNpcId ? model.entities.get(fromNpcId) : undefined;
  if (!player?.stats) return null;
  if (fromNpcId && !giver) return null;
  const itemName = resolveItem(ctx.services.world, itemId)?.name ?? itemDisplayNameOf(itemId);
  // The UNATTENDED branch: an object the SCENE named, taken off a counter or a stair with nobody
  // handing it over. Its one guard is that the prose really did put it there — an object no recent
  // narration mentions is a player invention, and inventing objects is not a player power.
  if (!giver) {
    if (getMasterItem(itemId) !== undefined) return null; // never mint SRD-priced gear from thin air
    if (isCoinQuantity(itemId, itemName)) return null; // money is a purse balance, never an object
    if (!namedInRecentProse(ctx, itemName, itemId)) return null;
    const result = ctx.apply({ type: "transferItem", itemId, from: null, to: player.id });
    if (result.rejected) return null;
    ctx.emit({
      kind: "stateChanged",
      summary: `You take the ${itemName}.`,
      changes: { itemId, from: null, to: player.id },
    });
    return `You take the ${itemName}.`;
  }
  const giverName = displayName(giver);
  const from = giver.stats?.inventory.includes(itemId) ? giver.id : null;
  // CONJURE GUARD (review): from-nothing minting is for prose-born objects, not real gear — a
  // masterlist (SRD-priced) id the giver does not actually carry is refused honestly, so "she
  // presses her dagger into your hand" can never mint sellable equipment out of thin air.
  if (from === null && getMasterItem(itemId) !== undefined) {
    return `(${giverName} is not actually holding out the ${itemName} — nothing changes hands.)`;
  }
  const result = ctx.apply({ type: "transferItem", itemId, from, to: player.id });
  if (result.rejected) return null;
  ctx.emit({
    kind: "stateChanged",
    summary: `You accept the ${itemName} from ${giverName}.`,
    changes: { itemId, from: giver.id, to: player.id },
  });
  noteExchange(ctx, model, {
    npcId: giver.id,
    npcName: giverName,
    kind: "received",
    lines: [{ itemId, name: itemName, quantity: 1, eachCp: null }],
    coinsCp: 0,
    note: `You accept the ${itemName} from ${giverName}.`,
  });
  return `You accept the ${itemName} from ${giverName}.`;
}

/**
 * Resolve a TYPED clothing change — "I strip off my clothes", "I pull my hood back up" — as a
 * real turn: the wardrobe patch lands through the reducer AND the narrator (and reactive NPCs)
 * see the change this same tick. The paper-doll's per-slot buttons stay the silent no-turn
 * affordance (`submitClothingAction`) by design; this path is for the player SAYING it, which
 * deserves a response. Deterministic and check-free, so the intent carries a plain trigger only
 * (the itemAction equip/unequip precedent — `resolved` is shaped for dice verdicts, never this).
 *
 * "all" targets the slots this character actually dresses: garments named in the appearance
 * prose (accessories included) ∪ the paper-doll's guaranteed baseline coverage pair — the SAME
 * occupancy read the brief's Attire line uses, so a typed full strip reads "bare" in this very
 * tick. That closes the P1 gap (a prose-only garment such as a coat in `over-upper` is now
 * strippable) without ever narrating a hatless PC pulling off headwear.
 */
export function resolveClothingAction(ctx: TickContext, plan: TurnPlan, input: string): NarrationIntent {
  const player = playerEntity(ctx.model);
  const clothing = plan.clothing;
  if (!player || !clothing) return { trigger: input };

  const dressedSlots = (): WardrobeSlotId[] => {
    const pc = ctx.services.campaign.characters.find((c) => c.id === player.id);
    const occupied = new Set<WardrobeSlotId>([
      ...occupiedSlotsOf([pc?.description ?? "", ...(pc?.appearanceTags ?? [])].join(" ")),
      ...BASELINE_COVERAGE_SLOT_IDS,
    ]);
    return WARDROBE_SLOT_IDS.filter((s) => occupied.has(s));
  };
  // A scripted/unreconciled plan may still carry garbage — degrade to plain narration, never a crash.
  const slots: WardrobeSlotId[] =
    clothing.slot === "all" ? dressedSlots() : isWardrobeSlotId(clothing.slot) ? [clothing.slot] : [];
  if (slots.length === 0) return { trigger: input };

  const state: WardrobeSlotState = clothing.state;
  const row = (ctx.model.modules[WARDROBE_MODULE] as WardrobeSlice | undefined)?.[player.id] ?? {};
  const changed = slots.filter((s) => (row[s] ?? "worn") !== state);
  if (changed.length === 0) {
    const asked = naturalList(slots.map(wardrobeSlotLabel));
    return {
      trigger:
        state === "removed"
          ? `You have already stripped off your ${asked}.`
          : state === "worn"
            ? `You have already put your ${asked} back in place.`
            : `You have already left your ${asked} in disarray.`,
    };
  }

  const res = ctx.apply({
    type: "modulePatch",
    module: WARDROBE_MODULE,
    patch: { [player.id]: { ...row, ...Object.fromEntries(changed.map((s) => [s, state])) } },
  });
  if (res.rejected) return { trigger: input };
  if (isCombatActive(ctx.model)) ctx.data.itemActionTurn = { actorId: player.id };
  const labels = naturalList(changed.map(wardrobeSlotLabel));
  const line =
    state === "removed"
      ? `You strip off your ${labels}.`
      : state === "worn"
        ? `You put your ${labels} back in place.`
        : `You tug your ${labels} loose and askew.`;
  ctx.emit({
    kind: "stateChanged",
    summary: line,
    changes: { wardrobe: { slots: changed, state } },
  });
  return { trigger: line };
}
