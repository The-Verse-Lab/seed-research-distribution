/**
 * The economy domain — buying, selling, vendor services, day-labour, and the coin beats around
 * them.
 *
 * Lifted verbatim out of `GameEngine` (see `resolvers/host.ts` for the contract). Prices come from
 * `src/rules/items.ts`, service agreements from `src/rules/services.ts`; every mutation still goes
 * through the reducer via `ctx.apply`, and every executed exchange still lands on the dealings
 * ledger so a later brief can refer back to it instead of the fiction quietly un-happening.
 *
 * @author Runkai Zhang
 */
import type { VendorService, Work } from "../../content/schema.ts";
import { agreementReady, dueLabel, openAgreements, readServicesSlice, type ExchangeKind, type ExchangeLine, type ServiceAgreement } from "../../rules/exchange.ts";
import { dropOffer, liveOffersFor, PENDING_OFFERS_MODULE, type PendingOffer } from "../../rules/pending-offers.ts";
import { formatCoins, itemDisplayNameOf, itemIdByName, itemRefMatchesStrongly, itemRefSubsumes, matchItemLoosely, resolveItem, sceneItemIdFor, tradePriceCp, wareKindAskOf } from "../../rules/items.ts";
import { factionStandingCommands } from "../../rules/factions.ts";
import { resolveCheck } from "../../rules/checks.ts";
import { costOf, scaledEnergy } from "../../rules/costs.ts";
import { dayOf } from "../../rules/routine.ts";
import { workRequiresMet } from "../../rules/work-gate.ts";
import { displayName, type Entity } from "../../world/entity.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";
import { isCombatActive } from "../../world/queries.ts";
import { resolvedFromCheck } from "../../agents/context.ts";
import type { NarrationIntent } from "../../modules/narration.ts";
import { ABILITY_NAMES, naturalList } from "./phrasing.ts";
import type { TickContext } from "../tick.ts";

/** Guild standing earned per successful work shift (the reputation loop; small — standing is a grind). */
const WORK_STANDING_GAIN = 3;

/**
 * How many minutes of authored labor one in-world day holds — a full working day, the length of the
 * board's own full-day rows.
 *
 * `cooldownDays` throttles ONE ROW, never the day: the Anchorfall board alone posts 240 + 480 + 480 +
 * 240 minutes of legal same-day work, so a player who simply worked every row cleared the two-week
 * grind ceiling by 1.7x (measured through the real engine: 44 shifts / 1530 cp in fourteen days, on a
 * board whose best single row pays 80 cp, with the standing from the extra shifts unlocking the
 * faction-gated 220 cp contract a week early). Energy and the exhaustion ladder do eventually close
 * the board — but only after the money is made, so they are not the brake this needs. Two half-day
 * rows still fit, which is the trade the half-day wages are priced for.
 */
const WORK_DAY_MINUTES = 480;
import type { TurnPlan } from "../turn-plan.ts";
import { itemNameOf } from "./names.ts";
import { workOpportunitiesHere } from "./work-board.ts";

/**
 * The line names the coins as the PRICE OF GOODS the player is acquiring — an acquisition verb and
 * a price clause over money ("I'll take the spear for 1 gold", "I buy the lantern for five silver").
 * A purchase is `resolveTrade`'s job, and that resolver is atomic-or-nothing by construction: coins
 * and stock move together or neither moves. The ambient rescue has no stock half, so charging one of
 * these mints the exact coins-without-item state the trade path forbids.
 *
 * Live r15, fixture-trade t3: the classifier read "I'll take the spear for 1 gold—count out 100 coppers.
 * Then I'll sell this club; what do you give me?" as freeformNarrative (two halves, confidence 0.4),
 * the rescue matched "count out 100 coppers", and 100 cp left the purse for a spear that was never
 * transferred. The player then sold their club two turns later and fought the rest of the run
 * bare-handed — every swing to the end of the sweep resolved as `Unarmed Strike`.
 *
 * Deliberately narrow: it needs an EXPLICIT acquisition verb followed by a `for <money>` price
 * clause inside one sentence. A bare payment ("I count five silver onto the counter", "I pay her two
 * silver for the room") names no goods and still charges — that is the r5 P2 / r6 counter-verb
 * contract, and it stays untouched.
 */
const PURCHASE_PRICE_RE =
  /\b(?:buy|buys|buying|bought|purchase|purchases|purchased|purchasing|take|takes|taking|took)\b[^.!?\n]{0,60}?\bfor\b[^.!?\n]{0,40}?\b(?:coins?|coppers?|silvers?|gold)\b/i;

/**
 * Resolve explicit prose-level currency gifts without fabricating a recipient entity. Stored money
 * is canonical copper, while the player's named denomination is preserved in the visible beat.
 * Vague common phrases are deliberately small and documented: a couple/some = 2, a few = 3,
 * several = 4. Returns null for negation, mere coin discussion, an empty purse, or no transfer cue.
 *
 * `goodsReceived` is the turn's answer to "did anything actually cross into the player's hands?" —
 * when the line is priced as a PURCHASE ({@link PURCHASE_PRICE_RE}) and nothing did, the rescue
 * declines and returns the honest no-deal note instead of a deduction. A purchase whose goods DID
 * ground (a `acceptItem`/pickup effect resolved this turn) is a completed exchange and still pays.
 */
export function resolveAmbientCoinGift(
  ctx: TickContext,
  input: string,
  goodsReceived = false,
): string | null {
  if (
    /\b(?:do(?:es)?n['’]?t|do not|won['’]?t|will not|never|refuse to|not going to)\b/i.test(input) ||
    /\bno\s+coins?\b/i.test(input)
  ) {
    return null;
  }
  // "hand" is also a body part ("wants a steady hand, no coin required"), so it must NOT count as a
  // give-verb on its own — only when it is used transitively, immediately followed by a recipient
  // or amount and then the coins. Every other verb keeps the looser proximity match. The money can
  // be named as "coins" OR as a counted bare denomination ("one copper", "two silvers") — live
  // r4-B's "I give one copper to the beggar" moved nothing because only the coin-noun form matched.
  // r5 P2: a clerk demanded "five silver, nonrefundable, payable now"; the player wrote "I count
  // five silver onto the counter", she wrote out the contract, and the purse never moved — 15 gp
  // before, 15 gp after. PAYING is not always GIVING: coin is counted, laid, set, pushed and paid
  // across a counter far more often than it is handed over. The amount grammar below is what keeps
  // these safe — a bare denomination still needs a count and a money-shaped tail, so "I set the
  // silver ring down" mints nothing.
  const transfer =
    /\b(?:give|press|slip|offer|donate|leave|drop|toss|pay|count|lay|set|place|put|push|slide|stack|spill|tip|produce)\b[^.!?\n]{0,80}\b(?:(?:gold|silver|copper)\s+)?(?:coins?|coppers?|silvers?|gold)\b/i;
  const handGift =
    /\bhand(?:s|ing|ed)?\s+(?:\w+\s+){0,4}?(?:(?:gold|silver|copper)\s+)?(?:coins?|coppers?|silvers?|gold)\b/i;
  if (!transfer.test(input) && !handGift.test(input)) {
    return null;
  }
  const COUNT = "a few|few|a couple|couple|some|several|an?|one|two|three|four|five|six|seven|eight|nine|ten|\\d+";
  // The bare-denomination form drops "a/an" from the counts: "a copper" is as likely the metal
  // ("a copper kettle", "a copper-smith") as the coin, and a mis-read mints a phantom deduction.
  const BARE_COUNT = COUNT.replace("an?|", "");
  // A COUNTED singular denomination can still be an adjective ("two silver rings", "one copper
  // kettle"), so the singular form only reads as money when the clause ends there or a function
  // word / money noun follows — a plural ("two silvers") is unambiguous and always accepted.
  // Only function words belong here: a denomination used as an ADJECTIVE is always followed by the
  // noun it modifies ("two silver rings"), never by a preposition, so every addition stays safe.
  const GIFT_TAIL =
    "pieces?|coins?|worth|to|for|from|into|in|at|on|onto|toward|towards|over|across|beside|between|against|upon|past|through|and|or|as|each|apiece|more|back|away|out|down|up|with|now|so|then|when|while|before|until|till|there|here|if";
  const amount =
    input.match(new RegExp(`\\b(?:(${COUNT})\\s+)?(?:(gold|silver|copper)\\s+)?coins?\\b`, "i")) ??
    // Counted bare denomination ("one copper", "3 silvers"): the COUNT is REQUIRED here so metal
    // mentions without a number never read as money.
    input.match(
      new RegExp(`\\b(${BARE_COUNT})\\s+(gold|silver|copper)(?:s\\b|\\b(?!\\s+(?!(?:${GIFT_TAIL})\\b)\\w))`, "i"),
    );
  if (!amount) return null;
  const countWord = (amount[1] ?? "one").toLowerCase();
  const wordCounts: Record<string, number> = {
    a: 1,
    an: 1,
    one: 1,
    "a couple": 2,
    couple: 2,
    some: 2,
    "a few": 3,
    few: 3,
    three: 3,
    several: 4,
    four: 4,
    two: 2,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  const count = /^\d+$/.test(countWord) ? Number.parseInt(countWord, 10) : (wordCounts[countWord] ?? 1);
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const denomination = (amount[2]?.toLowerCase() as "gold" | "silver" | "copper" | undefined) ?? "copper";
  const multiplier = denomination === "gold" ? 100 : denomination === "silver" ? 10 : 1;
  const requested = count * multiplier;
  const player = playerEntity(ctx.model);
  const available = player?.stats?.coins ?? 0;
  if (!player?.stats || available <= 0) return null;
  // ATOMIC OR NOTHING, on the rescue path too: money named as the price of goods that never arrived
  // is a purchase the engine did not make. Say so instead of charging for it — a refused deduction
  // can be paid on the next turn, a phantom one cannot be refunded. The refusal ships a RECEIPT
  // (r7: a refusal the player cannot see is how a run loses a purchase and never notices), so the
  // next turn can simply name the ware to the vendor and buy it through the atomic trade path.
  if (!goodsReceived && PURCHASE_PRICE_RE.test(input)) {
    const note = "No deal closes — nothing crossed the counter to you, so your purse is untouched.";
    ctx.emit({ kind: "stateChanged", summary: note, changes: { entityId: player.id, coinsGiven: 0 } });
    return note;
  }
  const spent = Math.min(requested, available);
  const result = ctx.apply({ type: "adjustCoins", entityId: player.id, by: -spent });
  if (result.rejected || !result.mutated) return null;
  const visibleAmount = spent === requested ? `${count} ${denomination}` : `${spent} copper`;
  ctx.emit({
    kind: "stateChanged",
    summary: `You give away ${visibleAmount}.`,
    changes: { entityId: player.id, coinsGiven: spent },
  });
  return `You give ${visibleAmount} away.`;
}

/**
 * Mint a classifier-proposed `spendCoins` effect (the grounded-freeform channel): clamp to the
 * real purse, deduct through the reducer, emit the tracker line, and return the mechanical beat
 * to prepend to the narration — or null when nothing could be spent (empty purse / rejected).
 * The recipient, when present, is named in the beat; the reducer holds the purse floor at 0.
 */
export function resolveSpendCoinsEffect(ctx: TickContext, amountCp: number, toNpcId: string | null): string | null {
  const player = playerEntity(ctx.model);
  const available = player?.stats?.coins ?? 0;
  if (!player?.stats || amountCp <= 0) return null;
  if (available <= 0) return `You reach for your purse, but it is empty.`;
  const spent = Math.min(amountCp, available);
  const result = ctx.apply({ type: "adjustCoins", entityId: player.id, by: -spent });
  if (result.rejected || !result.mutated) return null;
  const to = toNpcId ? ctx.model.entities.get(toNpcId) : undefined;
  const toText = to ? ` to ${displayName(to)}` : "";
  const short = spent === amountCp ? formatCoins(spent) : `${formatCoins(spent)} — all you have`;
  ctx.emit({
    kind: "stateChanged",
    summary: `You hand over ${short}${toText}.`,
    changes: { entityId: player.id, coinsGiven: spent, ...(to ? { to: to.id } : {}) },
  });
  noteExchange(ctx, ctx.model, {
    npcId: to?.id ?? null,
    npcName: to ? displayName(to) : "no one in particular",
    kind: "payment",
    lines: [],
    coinsCp: -spent,
    note: `You hand over ${formatCoins(spent)}${toText}.`,
  });
  return `You hand over ${short}${toText}.`;
}

/**
 * The ware a vendor's OWN WORDS put on sale that answers this ask (PROSE-TO-CODE §2.1) — the miss-
 * path's second chance, consulted only when nothing on the shelf matched.
 *
 * The offer list is a structured self-report from the NPC agent (`offers` on its reply JSON),
 * scoped to the location it was spoken in and a few in-world hours (`liveOffersFor`), so a price
 * quoted in Anchorfall cannot be cashed at the Reach. The player's ask is matched against the
 * offer NAMES with the same loose matcher the counter uses on real stock — an ask that overlaps
 * nothing returns null and the diegetic refusal stands.
 *
 * The id resolves against the catalogue first (`itemIdByName`, strict — a wrong confident match is
 * a real wrong purchase), and only when the catalogue has no such thing is a scene item minted:
 * the offer is the fiction's own object, and it exists because the vendor said it does.
 */
export function offeredWareFor(
ctx: TickContext,
  model: WorldModel,
  vendorId: string,
  ask: string,
): { offer: PendingOffer; itemId: string } | null {
  const player = playerEntity(model);
  if (!player?.locationId) return null;
  const offers = liveOffersFor(model.modules, vendorId, player.locationId, model.clock);
  if (offers.length === 0) return null;
  const hit = matchItemLoosely(ask, offers.map((o) => o.name), ctx.services.world);
  // Corroborate the loose pick: the offer pool is usually ONE name, and over a one-element pool
  // the matcher's unique-best-overlap tier resolves on a single shared adjective ("iron
  // shortsword" cashed a "salt-iron vest"). An offered ware is only the thing the player asked
  // for when their words and the vendor's subsume each other.
  if (!hit || !itemRefSubsumes(ask, hit)) return null;
  // Newest quote wins — a vendor who re-priced the thing meant the second number.
  const offer = [...offers].reverse().find((o) => o.name === hit);
  if (!offer) return null;
  const itemId = itemIdByName(offer.name, ctx.services.world) ?? sceneItemIdFor(offer.name);
  return itemId ? { offer, itemId } : null;
}

/**
 * Resolve a grounded trade — buy from / sell to a present vendor — with every number from code.
 * Price = the item's base cost × the vendor's priceModifier, rounded (sell = half that, floored;
 * src/rules/items.ts `tradePriceCp`). A buy the player cannot afford applies NOTHING (the
 * atomic-transfer precedent: no partial coins-without-item state can exist); an unpriceable item
 * is narrated as a shrug. Vendors do not track their own coins — the stall's purse is bottomless
 * by design, only the STOCK is real (the entity inventory both commands move through).
 * A COMPLETED trade mid-fight spends the player's combat turn exactly like an item action —
 * haggling over potions is not a free action while blades are out.
 */
export function resolveTrade(ctx: TickContext, plan: TurnPlan, input: string): NarrationIntent {
  const model = ctx.model;
  const player = playerEntity(model);
  const trade = plan.trade;
  if (!trade?.vendorId || !player?.stats) {
    // The classifier committed to commerce but no vendor grounded — usually no merchant stands
    // here. Deterministic honesty, never freeform: the freeform downgrade let the narrator
    // invent a vendor and then assert the completed deal against the sheet (live r4-C).
    // A vendor CAN be present on this path (a hallucinated vendorId beside several real stalls
    // drops the payload) — saying "no merchant" then would be its own false prose. Prefer the
    // vendor the player ADDRESSED (plan.targetId), then any present stallkeeper, and answer
    // with their REAL counter instead of the old "too vague to close" dead turn (playtest r2 P0:
    // that line consumed five turns and never once said what would work).
    const isVendorEntity = (e: Entity | undefined): boolean =>
      !!e &&
      e.kind === "npc" &&
      !!e.stats &&
      e.locationId === player?.locationId &&
      !!ctx.services.world.npcs.find((n) => n.id === (e.templateId ?? e.id))?.vendor;
    const addressed = plan.targetId ? model.entities.get(plan.targetId) : undefined;
    const stallkeeper = isVendorEntity(addressed)
      ? addressed
      : player
        ? [...model.entities.values()].find((e) => isVendorEntity(e))
        : undefined;
    return {
      trigger: stallkeeper
        ? `${stallkeeper.name} keeps the trade here. ${vendorCounterLine(ctx, stallkeeper)}`
        : "You look for someone to trade with, but no merchant is at hand here.",
      deterministic: true,
    };
  }
  const vendor = model.entities.get(trade.vendorId);
  if (!vendor?.stats || vendor.locationId !== player.locationId) {
    return {
      trigger: "You look around for the merchant, but there is no one here to trade with.",
      deterministic: true,
    };
  }
  // The player's OWN words for the ware (r10 F-3), sanitized for prose reuse. When present they
  // are the corroboration surface every grounded guess must answer to — the classifier substituted
  // "old belt knife" into `weapon.club` and the id short-circuit below sold the club unasked.
  const spokenWare = (trade.itemWords ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  // The player's words are spliced into engine prose, and they arrive already carrying whatever
  // determiner the player used. Live r11: "would you take my mage hat…" reached the refusal as
  // "You reach for the my mage hat". A determiner already there wins; otherwise "the" is added.
  const withArticle = (words: string): string =>
    /^(?:the|a|an|my|your|his|her|their|its|our|this|that|these|those|some|another)\b/i.test(words)
      ? words
      : `the ${words}`;
  if (!trade.itemId && !spokenWare) {
    // A browse — "show me what you sell", "name your prices". Answer with the live counter:
    // real stock, real prices, deterministic. The system event is ephemeral and never persisted.
    ctx.emit({
      kind: "system",
      level: "info",
      message: `${vendor.name} lays the goods out for you.`,
    });
    return {
      trigger: `${vendor.name} lays the goods out for you. ${vendorCounterLine(ctx, vendor)}`,
      deterministic: true,
    };
  }
  // Ground the model's item guess against the REAL pool first (buy: the vendor's stock; sell:
  // the player's pack) — "item.water-skin" must find the stocked "item.waterskin" instead of
  // refusing on a hyphen (r2 P0: five failed purchases, three phrasings, all name-shape misses).
  const guess = trade.itemId;
  const pool = trade.direction === "buy" ? vendor.stats.inventory : player.stats.inventory;
  let pooled = guess ? (pool.includes(guess) ? guess : matchItemLoosely(guess, pool, ctx.services.world)) : null;
  // THE CORROBORATION RAIL (r10 F-3): when the player named the ware in words, the pool choice
  // must answer to THOSE WORDS on the strong tiers (squash / distinctive-token subsume) — never
  // the unique-best-overlap tier, whose single shared adjective is how "belt knife" would come
  // back as a belt. A choice that doesn't answer is re-grounded by the words themselves; nothing
  // answering falls through to the honest refusal that names the words. No words ⇒ the guess is
  // trusted exactly as before (anaphora — "I'll take it" — must keep working).
  if (spokenWare && pooled !== null && !itemRefMatchesStrongly(spokenWare, pooled, ctx.services.world)) {
    pooled = null;
  }
  if (spokenWare && pooled === null) {
    pooled = pool.find((id) => itemRefMatchesStrongly(spokenWare, id, ctx.services.world)) ?? null;
  }
  // The surface later tiers ground against: the player's words when they gave any, else the guess.
  const probe = spokenWare || (guess ?? "");
  // PROSE-TO-CODE §2.1 — nothing on the shelf really answers the ask, so consult what this vendor
  // SAID. A ware they priced aloud in this scene is stock: the fiction made the offer, and the
  // counter honours it at THEIR quoted number (see `offeredWareFor`). A STRONG stock match still
  // wins outright — only the loose overlap tier defers, because a spoken "oiled wool cloak" shares
  // one token with a wool shirt on the shelf and the shelf would win a tie it should not.
  const strongStock = pooled !== null && itemRefMatchesStrongly(probe, pooled, ctx.services.world);
  const offered =
    trade.direction === "buy" && !strongStock ? offeredWareFor(ctx, model, vendor.id, probe) : null;
  // A masterlist fallback for the guess is legal only when the words corroborate it (or there are
  // no words): t7's teaching refusal — "You reach for the Waterskin, but you are not carrying
  // it." — needs the resolved Waterskin, while F-3's uncorroborated weapon.club must NOT resolve
  // and sell itself here.
  const masterGuess =
    guess && (!spokenWare || itemRefMatchesStrongly(spokenWare, guess, ctx.services.world)) ? guess : null;
  const item = offered
    ? (resolveItem(ctx.services.world, offered.itemId) ?? {
        id: offered.itemId,
        name: itemDisplayNameOf(offered.itemId),
        description: "",
        kind: "misc" as const,
        properties: {},
      })
    : resolveItem(ctx.services.world, pooled ?? masterGuess ?? probe);
  if (!item) {
    // The named ware grounds to nothing the pool, the spoken offers or the masterlist know —
    // refuse honestly rather than hand the line to the narrator (which would happily close an
    // ungrounded sale), and say what IS real so the refusal teaches instead of stonewalling.
    if (trade.direction === "sell" && spokenWare) {
      // Pack-deixis names the PACK, not a ware: "name what you'd pay for from what I'm carrying"
      // arrived here as an item called "what I'm carrying" and shipped the mangled splice "You
      // reach for the what I'm carrying…" (r14, fixture-trade t8). The honest answer to "what would
      // you buy from me?" is the sell-side counter. Quote-only, same contract as the kind hook.
      if (PACK_DEIXIS_RE.test(spokenWare)) {
        ctx.emit({
          kind: "system",
          level: "info",
          message: `${vendor.name} looks over what you carry.`,
        });
        return {
          trigger:
            playerSellCounterLine(ctx, vendor, player) ??
            `${vendor.name} glances over what you carry and finds nothing worth a coin.`,
          deterministic: true,
        };
      }
      // Teach past the miss (r14, fixture-trade t14–t16): the driver tried to sell the CARRIED
      // hedge-remedy three ways ("this remedy potion", "this little clay pot of remedy") and the
      // corroboration rail — rightly — refused to gamble on one shared token. The refusal is
      // correct; refusing in silence is what cost three turns. Name what the pack really holds.
      const counter = playerSellCounterLine(ctx, vendor, player);
      return {
        trigger: `You reach for ${withArticle(spokenWare)}, but nothing you carry answers to that name.${counter ? ` ${counter}` : ""}`,
        deterministic: true,
      };
    }
    // A CATEGORY ask ("best blade", "your cheapest weapon") names a KIND, not a ware — the lexical
    // tiers above cannot match it by construction (see `wareKindAskOf`), and the head-shake below
    // once asserted a complete-looking counter while three stocked, affordable swords sat past the
    // browse cap (playtest r13: sixteen turns of "no blade here" over a 1 gp spear). Answer with
    // the kind-filtered counter instead. Quote-only, on the inquiry path or off it: nothing here
    // grounds `item`, so no purchase can fall through (r10 F-2/F-3 stay closed).
    if (trade.direction === "buy") {
      const askSurface = spokenWare || (guess ? itemDisplayNameOf(guess) : "");
      const kindQuote = vendorKindQuoteLine(ctx, model, vendor, askSurface);
      if (kindQuote) {
        ctx.emit({
          kind: "system",
          level: "info",
          message: `${vendor.name} lays the goods out for you.`,
        });
        return { trigger: kindQuote, deterministic: true };
      }
    }
    const bare = spokenWare ? withoutLeadingDeterminer(spokenWare) : "";
    return {
      trigger:
        `${vendor.name} shakes their head — ${bare ? `no ${bare} here` : "they deal in nothing by that name"}, whatever the talk was. ` +
        `${vendorCounterLine(ctx, vendor)}`,
      deterministic: true,
    };
  }
  if (player.stats.currentHp <= 0) {
    return {
      trigger: `You are down — the world swims dark and your hands will not answer. (Rest or victory can bring you back.)`,
    };
  }
  const template = ctx.services.world.npcs.find((n) => n.id === (vendor.templateId ?? vendor.id));
  // An offered ware costs what its seller SAID it costs — their own quote already priced in the
  // margin the modifier models, and re-pricing it off the masterlist would make the counter
  // contradict the sentence that sold it (the whole point of §2.1).
  const price = offered
    ? { buy: offered.offer.priceCp, sell: Math.floor(offered.offer.priceCp / 2) }
    : tradePriceCp(item, template?.vendor?.priceModifier ?? 1);
  if (!price) {
    // No resolvable base cost — the market has no number for this thing.
    return {
      trigger: `${vendor.name} turns the ${item.name} over once and hands it back with a shrug — there is no price for that here.`,
    };
  }

  // A QUESTION IS ANSWERED, NEVER EXECUTED (r10 F-2: "I ask the price of the seasoned waterskin"
  // bought the waterskin — coins left the purse on an inquiry). Quote the counter's live number,
  // surface the available stock, and move NOTHING; the purse/stock arithmetic below belongs to committed
  // exchanges only. Sell-side quotes what the vendor would give, with the same worthless-ware
  // wave-off the real sale gives.
  if (trade.inquiry) {
    ctx.emit({
      kind: "system",
      level: "info",
      message: `${vendor.name} lays the goods out for you.`,
    });
    if (trade.direction === "sell") {
      // The quote answers to the SAME pool the sale itself checks (r14, fixture-trade t6→t7: the
      // masterlist fallback priced a shirt the player has never carried at 3 sp, and the sale one
      // turn later refused "you are not carrying it" — the counter promised what the counter then
      // denied). An uncarried ware quotes nothing; say what from the pack WOULD fetch coin.
      if (!player.stats.inventory.includes(item.id)) {
        const counter = playerSellCounterLine(ctx, vendor, player);
        return {
          trigger: `You carry no ${item.name} to sell.${counter ? ` ${counter}` : ""}`,
          deterministic: true,
        };
      }
      const line =
        price.sell <= 0
          ? `${vendor.name} glances at the ${item.name} and waves it off — it is not worth a single coin to them.`
          : `${vendor.name} looks the ${item.name} over and would give ${formatCoins(price.sell)} for it.`;
      return { trigger: `${line} ${vendorCounterLine(ctx, vendor)}`, deterministic: true };
    }
    const stocked =
      vendor.stats.inventory.filter((id) => id === item.id).length - custodyHeldCount(model, vendor.id, item.id);
    const stockNote = stocked <= 0 && !offered ? " — though none sits on the counter just now" : "";
    return {
      trigger: `${vendor.name} quotes ${formatCoins(price.buy)} for the ${item.name}${stockNote}. ${vendorCounterLine(ctx, vendor)}`,
      deterministic: true,
    };
  }

  if (trade.direction === "buy") {
    let inStockCount =
      vendor.stats.inventory.filter((id) => id === item.id).length -
      custodyHeldCount(model, vendor.id, item.id);
    if (inStockCount <= 0 && !offered) {
      // Diegetic refusal (r6 P1): the NPC did not offer this thing and does not stock it — say so
      // in the vendor's voice ("spoken for") instead of dumping a bare stock list that reads as
      // the game forgetting the last ninety seconds. Custody property (r8) reads the same way:
      // the sharpening dagger on the shelf is not merchandise. An offer REACHING here would be a
      // ware the vendor priced aloud, and §2.1 stocks it below instead of refusing it.
      return {
        trigger:
          `"That one's spoken for — not mine to sell," ${vendor.name} says. ` +
          `${vendorCounterLine(ctx, vendor)}`,
        deterministic: true,
      };
    }
    const purse = player.stats.coins ?? 0;
    if (purse < price.buy) {
      // A clear refusal, NO command: coins and stock are untouched (atomic or nothing).
      return {
        trigger:
          `${vendor.name} names the price for the ${item.name}: ${formatCoins(price.buy)}. ` +
          `You have ${formatCoins(purse)} — not enough, and no coin changes hands.`,
      };
    }
    // §2.1 — the offered ware becomes REAL stock, one unit, the instant the player can pay for it.
    // Minted AFTER the purse check on purpose: a purchase that cannot close must leave the world
    // exactly as it found it (the atomic-or-nothing rule this whole resolver is built on). One
    // lantern offered is one lantern stocked, so `inStock` caps a multi-buy at the thing offered.
    if (inStockCount <= 0 && offered) {
      if (ctx.apply({ type: "transferItem", itemId: item.id, from: null, to: vendor.id }).rejected) {
        return {
          trigger:
            `"That one's spoken for — not mine to sell," ${vendor.name} says. ` +
            `${vendorCounterLine(ctx, vendor)}`,
          deterministic: true,
        };
      }
      inStockCount = 1;
    }
    // Multi-unit buys (r3 P3: "two rations" silently bought one): honor the stated quantity,
    // capped by the vendor's real stock and the purse. Each unit is its own atomic `tradeWith`
    // (item vendor→PC, coins−price — no coins-without-item half-state can exist); the first
    // rejection stops the run. n === 1 keeps every line byte-identical to the single-buy path.
    const want = Math.min(99, trade.quantity ?? 1);
    const inStock = inStockCount; // custody units already held out (r8)
    const affordable = Math.floor(purse / price.buy);
    const n = Math.max(1, Math.min(want, inStock, affordable));
    let bought = 0;
    for (let i = 0; i < n; i++) {
      if (ctx.apply({ type: "tradeWith", pcId: player.id, vendorId: vendor.id, itemId: item.id, direction: "buy", priceCp: price.buy }).rejected) break;
      bought += 1;
    }
    if (bought === 0) return { trigger: `You try to buy the ${item.name}, but the deal falls through.`, deterministic: true };
    // The quote is SPENT (§2.1): the lantern the vendor offered has been sold, so the offer stops
    // standing. Without this the same sentence could be cashed once a turn forever.
    if (offered) {
      ctx.applySilent({
        type: "modulePatch",
        module: PENDING_OFFERS_MODULE,
        patch: { [vendor.id]: dropOffer(model.modules, vendor.id, offered.offer) },
      });
    }
    const total = price.buy * bought;
    const shortfall =
      bought >= want ? "" : bought >= inStock ? ` — only ${bought} on the counter` : ` — all your coin ran to ${bought}`;
    const boughtLabel = bought === 1 ? `the ${item.name}` : `${bought}× ${item.name}`;
    ctx.emit({
      kind: "stateChanged",
      summary: `You buy ${boughtLabel} from ${vendor.name} for ${formatCoins(total)} (${formatCoins(player.stats.coins ?? 0)} left).`,
      changes: { itemId: item.id, vendorId: vendor.id, priceCp: total, direction: "buy", quantity: bought },
      // The deterministic trigger below renders the SAME receipt — one line, not two (r6 P2).
      quiet: true,
    });
    noteExchange(ctx, model, {
      npcId: vendor.id,
      npcName: vendor.name,
      kind: "buy",
      lines: [{ itemId: item.id, name: item.name, quantity: bought, eachCp: price.buy }],
      coinsCp: -total,
      note: `You buy ${boughtLabel} from ${vendor.name} for ${formatCoins(total)}.`,
    });
    if (isCombatActive(model)) ctx.data.itemActionTurn = { actorId: player.id };
    // A settled purchase is bookkeeping: the line below already names item, vendor and price in
    // finished prose, so it goes out verbatim with no narrator round-trip (see `resolveItemAction`'s
    // equip case for the full rationale).
    return {
      trigger: `You buy ${boughtLabel} from ${vendor.name} for ${formatCoins(total)}${shortfall}.`,
      deterministic: true,
    };
  }

  // Sell: the player's carried item crosses the counter for half the asking price.
  if (!player.stats.inventory.includes(item.id)) {
    // Teach past the dead end (r14): the refusal alone left the seller guessing at their own pack
    // for two more turns — name what WOULD fetch coin, same as the buy-side counter teaches.
    const counter = playerSellCounterLine(ctx, vendor, player);
    return {
      trigger: `You reach for the ${item.name}, but you are not carrying it.${counter ? ` ${counter}` : ""}`,
      deterministic: true,
    };
  }
  if (price.sell <= 0) {
    return {
      trigger: `${vendor.name} glances at the ${item.name} and waves it off — it is not worth a single coin to them.`,
    };
  }
  // ONE atomic exchange (item PC→vendor, coins+price): reducer-only mutation, atomic-or-nothing.
  const done = ctx.apply({
    type: "tradeWith",
    pcId: player.id,
    vendorId: vendor.id,
    itemId: item.id,
    direction: "sell",
    priceCp: price.sell,
  });
  if (done.rejected) return { trigger: `You try to sell the ${item.name}, but the deal falls through.`, deterministic: true };
  ctx.emit({
    kind: "stateChanged",
    summary: `You sell the ${item.name} to ${vendor.name} for ${formatCoins(price.sell)} (${formatCoins(player.stats.coins ?? 0)} now).`,
    changes: { itemId: item.id, vendorId: vendor.id, priceCp: price.sell, direction: "sell" },
    // The deterministic trigger below renders the SAME receipt — one line, not two (r6 P2).
    quiet: true,
  });
  noteExchange(ctx, model, {
    npcId: vendor.id,
    npcName: vendor.name,
    kind: "sell",
    lines: [{ itemId: item.id, name: item.name, quantity: 1, eachCp: price.sell }],
    coinsCp: price.sell,
    note: `You sell the ${item.name} to ${vendor.name} for ${formatCoins(price.sell)}.`,
  });
  if (isCombatActive(model)) ctx.data.itemActionTurn = { actorId: player.id };
  // Settled sale — verbatim, no narrator call (same rationale as the buy branch above). The
  return {
    trigger: `You sell the ${item.name} to ${vendor.name} for ${formatCoins(price.sell)}.`,
    deterministic: true,
  };
}

/**
 * The player's words with one leading determiner dropped — for "no X here" prints, where the
 * classifier's verbatim `itemWords` splice read as engine damage ("no a cudgel here", live r13).
 * Print-site only: the corroboration rail and the sell-refusal's `withArticle` see the raw words.
 */
function withoutLeadingDeterminer(words: string): string {
  return words
    .replace(/^(?:the|a|an|my|your|his|her|their|its|our|this|that|these|those|some|another)\s+/i, "")
    .trim();
}

/**
 * Sell-side ware words that name the player's PACK rather than any ware — "what I'm carrying",
 * "anything I have", "my things". Resolver-side grounding of words the classifier already committed
 * as trade `itemWords` (the wareKindAskOf legal class — never an intent guess): these can match no
 * item by construction, and splicing them into the refusal shipped "You reach for the what I'm
 * carrying" (r14, fixture-trade t8). Deliberately tight: a phrase must point at the pack as a whole.
 */
const PACK_DEIXIS_RE =
  /^(?:(?:from\s+|out\s+of\s+)?(?:what(?:ever)?|any\s*thing|every\s*thing|some\s*thing|things|stuff)\s+(?:i|we)\s*(?:['’]m|am|['’]re|are|['’]ve|have)?\s*(?:carry(?:ing)?|got|have|hold(?:ing)?|own)(?:\s+on\s+me)?|my\s+(?:pack|gear|things|belongings|kit)|what(?:ever)?['’]?s?\s+in\s+my\s+(?:pack|bag|satchel)|what(?:ever)?\s+(?:would|will|can|do)\s+you\s+(?:pay|give|offer)(?:\s+for)?)\s*$/i;

/**
 * The sell-side counter: what the PLAYER carries that this vendor would pay real coin for, priced
 * with the same `tradePriceCp().sell` numbers a committed sale pays — the r2 teaching contract
 * ("say what WOULD work"), aimed the other way across the counter. Best coin first (the seller's
 * own question), capped at eight with an honest tail like the buy-side counter. QUOTE ONLY — the
 * caller returns this trigger directly; it grounds no item and can execute nothing. Null when the
 * pack holds nothing the market prices above zero.
 */
function playerSellCounterLine(ctx: TickContext, vendor: Entity, player: Entity): string | null {
  const inventory = player.stats?.inventory ?? [];
  const template = ctx.services.world.npcs.find((n) => n.id === (vendor.templateId ?? vendor.id));
  const modifier = template?.vendor?.priceModifier ?? 1;
  const seen = new Set<string>();
  const rows: { label: string; sellCp: number }[] = [];
  let beyondCap = 0;
  for (const itemId of inventory) {
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    const item = resolveItem(ctx.services.world, itemId);
    if (!item) continue;
    const price = tradePriceCp(item, modifier);
    if (!price || price.sell <= 0) continue;
    if (rows.length >= 8) {
      beyondCap += 1;
      continue;
    }
    const count = inventory.filter((id) => id === itemId).length;
    rows.push({
      label: `${item.name}${count > 1 ? ` ×${count}` : ""} (${formatCoins(price.sell)})`,
      sellCp: price.sell,
    });
  }
  if (rows.length === 0) return null;
  // Best coin first; JS sort is stable, so equal prices keep pack order — same pack, same line.
  rows.sort((a, b) => b.sellCp - a.sellCp);
  const more = beyondCap > 0 ? `, and ${beyondCap} more besides` : "";
  return `From what you carry, ${vendor.name} would take: ${rows.map((r) => r.label).join(", ")}${more}. Name what you will sell.`;
}

/**
 * The kind-filtered counter answer for a CATEGORY ask that grounded to no single ware — the r2 P0
 * teaching contract applied to a whole kind: say what WOULD work, cheapest first (so "your
 * cheapest weapon" is literally answered), instead of head-shaking past a rack of stocked steel
 * hidden behind the browse cap (playtest r13). QUOTE ONLY — the caller returns this trigger
 * directly; it grounds no item and can execute nothing. Custody-held units are not merchandise
 * and are never quoted (same rule as the committed-stock counts). Null when the words name no
 * category or the vendor stocks nothing of the kind — the honest head-shake stands.
 */
export function vendorKindQuoteLine(
ctx: TickContext,
  model: WorldModel,
  vendor: Entity,
  askWords: string,
): string | null {
  const kind = wareKindAskOf(askWords);
  if (!kind) return null;
  const stock = vendor.stats?.inventory ?? [];
  const template = ctx.services.world.npcs.find((n) => n.id === (vendor.templateId ?? vendor.id));
  const modifier = template?.vendor?.priceModifier ?? 1;
  const seen = new Set<string>();
  const rows: { label: string; buyCp: number }[] = [];
  for (const itemId of stock) {
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    const item = resolveItem(ctx.services.world, itemId);
    if (!item || item.kind !== kind) continue;
    const held = stock.filter((id) => id === itemId).length - custodyHeldCount(model, vendor.id, itemId);
    if (held <= 0) continue;
    const price = tradePriceCp(item, modifier);
    rows.push({
      label: price ? `${item.name} (${formatCoins(price.buy)})` : item.name,
      buyCp: price?.buy ?? Number.MAX_SAFE_INTEGER,
    });
  }
  if (rows.length === 0) return null;
  // Cheapest first; JS sort is stable, so equal prices keep template order — same ask, same line.
  rows.sort((a, b) => a.buyCp - b.buyCp);
  const shown = rows.slice(0, 8).map((r) => r.label);
  const more = rows.length > shown.length ? `, and ${rows.length - shown.length} more besides` : "";
  const noun = kind === "weapon" ? "weapons" : "armor";
  const bare = withoutLeadingDeterminer(askWords) || askWords;
  return `${vendor.name} shakes their head — no ${bare} here. But ${noun} they do sell: ${shown.join(", ")}${more}. Name what you will buy or sell.`;
}

/**
 * One player-facing line naming a vendor's REAL counter: up to eight distinct stocked wares with
 * their buy prices (the same `tradePriceCp` numbers a purchase pays). The browse answer, and the
 * teaching tail on every trade refusal — a failed trade must say what WOULD work (r2 P0).
 */
export function vendorCounterLine(
ctx: TickContext,vendor: Entity): string {
  const stock = vendor.stats?.inventory ?? [];
  const template = ctx.services.world.npcs.find((n) => n.id === (vendor.templateId ?? vendor.id));
  const modifier = template?.vendor?.priceModifier ?? 1;
  const seen = new Set<string>();
  const wares: string[] = [];
  // Count every distinct resolvable ware BEFORE capping the display: the old `break` at eight
  // left the tail unreachable (`seen` stopped growing with `wares`), so a thirteen-ware counter
  // printed eight and claimed completeness — the r13 fixture-trade driver read "no weapons exist"
  // off a counter whose ninth entry was a 1 gp spear.
  let beyondCap = 0;
  for (const itemId of stock) {
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    const item = resolveItem(ctx.services.world, itemId);
    if (!item) continue;
    if (wares.length >= 8) {
      beyondCap += 1;
      continue;
    }
    const price = tradePriceCp(item, modifier);
    wares.push(price ? `${item.name} (${formatCoins(price.buy)})` : item.name);
  }
  if (wares.length === 0) return `Their counter is bare — nothing is on offer just now.`;
  const more = beyondCap > 0 ? `, and ${beyondCap} more besides` : "";
  return `On offer: ${wares.join(", ")}${more}. Name what you will buy or sell.`;
}

/** The authored services on an NPC's counter (template `vendor.services`), or []. */
export function vendorServicesOf(
ctx: TickContext,vendor: Entity): VendorService[] {
  const template = ctx.services.world.npcs.find((n) => n.id === (vendor.templateId ?? vendor.id));
  return template?.vendor?.services ?? [];
}

/** Units of `itemId` this vendor holds ONLY as custody (open service agreements) — never stock.
 *  The sharpening dagger on the shelf is the player's property; it cannot be bought back. */
export function custodyHeldCount(model: WorldModel, vendorId: string, itemId: string): number {
  return openAgreements(readServicesSlice(model.modules)).filter(
    (a) => a.custody && a.npcId === vendorId && a.itemId === itemId,
  ).length;
}

/** One player-facing line naming a vendor's service list — the teaching tail on service refusals. */
export function vendorServiceLine(
ctx: TickContext,vendor: Entity): string {
  const services = vendorServicesOf(ctx, vendor);
  if (services.length === 0) return "";
  const rows = services.slice(0, 6).map((s) => `${s.label} (${formatCoins(s.priceCp)})`);
  return ` Work on offer: ${rows.join(", ")}.`;
}

/**
 * Append one executed receipt to the dealings ledger (`modules.exchanges`) — the shared memory
 * every brief reads back, so an exchange can be referred to later instead of un-happening
 * (playtest r7: "the prose is a poor witness to its own events"). Stamped with the in-world
 * day/minute; `note` is the finished player-safe sentence the briefs reuse verbatim.
 */
export function noteExchange(
ctx: TickContext,
  model: WorldModel,
  entry: { npcId: string | null; npcName: string; kind: ExchangeKind; lines: ExchangeLine[]; coinsCp: number; note: string },
): void {
  ctx.apply({
    type: "recordExchange",
    record: {
      day: dayOf(model.clock),
      minute: model.clock % 1440,
      ...entry,
    },
  });
}

/**
 * Resolve a caller-confirmed shopping basket — one vendor, many lines, one turn. Every line
 * re-validates at resolve time exactly like a single `trade`
 * (stock, purse, price — atomic per unit, the first rejection stops that line); the receipt is
 * ONE quiet ledger line and ONE narrator beat about the whole exchange, so provisioning stops
 * costing a narrated minute per item (r7: "four Buy clicks ≈ four minutes and an in-game morning").
 */
export function resolveTradeBatch(ctx: TickContext, plan: TurnPlan): NarrationIntent {
  const model = ctx.model;
  const player = playerEntity(model);
  const batch = plan.tradeBatch;
  if (!batch || !player?.stats) {
    return { trigger: "You look for someone to trade with, but no merchant is at hand here.", deterministic: true };
  }
  if (player.stats.currentHp <= 0) {
    return { trigger: `You are down — the world swims dark and your hands will not answer. (Rest or victory can bring you back.)` };
  }
  const vendor = model.entities.get(batch.vendorId);
  if (!vendor?.stats || vendor.locationId !== player.locationId) {
    return { trigger: "You look around for the merchant, but there is no one here to trade with.", deterministic: true };
  }
  const template = ctx.services.world.npcs.find((n) => n.id === (vendor.templateId ?? vendor.id));
  const modifier = template?.vendor?.priceModifier ?? 1;
  const bought: string[] = [];
  const sold: string[] = [];
  const recordLines: ExchangeLine[] = [];
  let net = 0; // signed copper, PC's point of view
  const misses: string[] = [];
  for (const line of batch.lines.slice(0, 24)) {
    const pool = line.direction === "buy" ? vendor.stats.inventory : player.stats.inventory;
    const pooled = pool.includes(line.itemId) ? line.itemId : matchItemLoosely(line.itemId, pool, ctx.services.world);
    const item = resolveItem(ctx.services.world, pooled ?? line.itemId);
    const price = item ? tradePriceCp(item, modifier) : null;
    if (!item || !price) {
      misses.push(itemNameOf(ctx.services.world, line.itemId));
      continue;
    }
    // Custody property in the vendor's hands is NOT stock (r8) — cap buys below it.
    const buyable =
      line.direction === "buy"
        ? vendor.stats.inventory.filter((id) => id === item.id).length - custodyHeldCount(model, vendor.id, item.id)
        : Number.POSITIVE_INFINITY;
    let done = 0;
    for (let i = 0; i < Math.min(99, line.quantity, buyable); i++) {
      const cp = line.direction === "buy" ? price.buy : price.sell;
      if (line.direction === "sell" && cp <= 0) break;
      if (ctx.apply({ type: "tradeWith", pcId: player.id, vendorId: vendor.id, itemId: item.id, direction: line.direction, priceCp: cp }).rejected) break;
      done += 1;
      net += line.direction === "buy" ? -cp : cp;
    }
    if (done === 0) {
      misses.push(item.name);
      continue;
    }
    const label = done === 1 ? item.name : `${item.name} ×${done}`;
    const eachCp = line.direction === "buy" ? price.buy : price.sell;
    (line.direction === "buy" ? bought : sold).push(`${label} (${formatCoins(eachCp * done)})`);
    recordLines.push({ itemId: item.id, name: item.name, quantity: done, eachCp });
  }
  if (bought.length === 0 && sold.length === 0) {
    return {
      trigger: `${vendor.name} looks over what you point at, but no deal closes — ${misses.length > 0 ? `nothing came of ${misses.join(", ")}` : "the counter has nothing for you"}. ${vendorCounterLine(ctx, vendor)}`,
      deterministic: true,
    };
  }
  const parts: string[] = [];
  if (bought.length > 0) parts.push(`bought ${bought.join(", ")}`);
  if (sold.length > 0) parts.push(`sold ${sold.join(", ")}`);
  const short = misses.length > 0 ? ` (no deal on ${misses.join(", ")})` : "";
  const receipt = `You settle up with ${vendor.name}: ${parts.join("; ")}${short} — ${formatCoins(player.stats.coins ?? 0)} left.`;
  ctx.emit({
    kind: "stateChanged",
    summary: receipt,
    changes: { vendorId: vendor.id, netCp: net, lines: recordLines.length },
    quiet: true,
  });
  const kind: ExchangeKind = bought.length > 0 && sold.length === 0 ? "buy" : sold.length > 0 && bought.length === 0 ? "sell" : "buy";
  noteExchange(ctx, model, {
    npcId: vendor.id,
    npcName: vendor.name,
    kind,
    lines: recordLines,
    coinsCp: net,
    note: receipt,
  });
  if (isCombatActive(model)) ctx.data.itemActionTurn = { actorId: player.id };
  // The GM still writes the exchange as a SCENE (the user-facing contract: windows for the
  // mechanics, prose for the moment) — but the receipt is already on the ledger, so the model
  // grounds on it without repeating it, and a blank completion falls back to the receipt itself.
  return {
    trigger:
      `(Already resolved and shown to the player as a ledger line: "${receipt}" — this REALLY happened; ` +
      `write the counter scene around it briefly, do NOT repeat that sentence or re-price the goods.) ` +
      `The player concludes their business at ${vendor.name}'s counter.`,
    echoFallback: receipt,
  };
}

/**
 * Resolve a SERVICE engagement — a fee for work on the player's property, never a sale (r7's
 * money-printing inversion: "sharpen it and name your price" sold the rapier at half list). The
 * authored offer names the fee/custody/due; the reducer strikes the whole deal atomically
 * (`serviceBegin`), and a custody item comes back through `serviceComplete` when due (the
 * services tick module walks co-located due agreements every turn).
 */
export function resolveService(ctx: TickContext, plan: TurnPlan, input: string): NarrationIntent {
  const model = ctx.model;
  const player = playerEntity(model);
  const svc = plan.service;
  if (!player?.stats) return { trigger: "You have no hands to trade with.", deterministic: true };
  if (player.stats.currentHp <= 0) {
    return { trigger: `You are down — the world swims dark and your hands will not answer. (Rest or victory can bring you back.)` };
  }
  const isVendorEntity = (e: Entity | undefined): boolean =>
    !!e && e.kind === "npc" && !!e.stats && e.locationId === player.locationId &&
    !!ctx.services.world.npcs.find((n) => n.id === (e.templateId ?? e.id))?.vendor;
  const named = svc?.npcId ? model.entities.get(svc.npcId) : undefined;
  const addressed = plan.targetId ? model.entities.get(plan.targetId) : undefined;
  // Prefer the NPC the payload named, then the addressed NPC, then the sole present vendor with
  // any services — never a bystander (the r7 lesson: Veil absorbed every counter in the city).
  const host =
    (named && named.locationId === player.locationId ? named : undefined) ??
    (addressed && addressed.locationId === player.locationId ? addressed : undefined) ??
    [...model.entities.values()].find((e) => isVendorEntity(e) && vendorServicesOf(ctx, e).length > 0);
  if (!host) {
    return { trigger: "You look for someone to do the work, but no one here takes that trade.", deterministic: true };
  }
  const services = vendorServicesOf(ctx, host);
  if (services.length === 0) {
    // The addressed NPC offers no authored services. HONEST refusal in their voice — and the
    // crucial guarantee: the player's goods DO NOT MOVE. No sale, no fee, no custody.
    return {
      trigger:
        `${host.name} turns the work over in their head and shakes it — that is not a trade they keep here. ` +
        `You keep hold of what is yours; no coin moves until terms are struck.`,
      deterministic: true,
    };
  }
  const offer = (svc?.serviceId ? services.find((s) => s.id === svc.serviceId) : undefined) ?? (services.length === 1 ? services[0] : undefined);
  if (!offer) {
    return {
      trigger: `${host.name} can do more than one kind of work — name it.${vendorServiceLine(ctx, host)}`,
      deterministic: true,
    };
  }
  // Ground the item the work is on: the payload's guess, else the player's sole carried item on a
  // needs-item service is NOT guessed — ask instead (a wrong custody grab is worse than a question).
  let itemId: string | null = null;
  let itemName: string | null = null;
  if (offer.needsItem || offer.custody) {
    const pool = player.stats.inventory;
    const pooled = svc?.itemId && (pool.includes(svc.itemId) ? svc.itemId : matchItemLoosely(svc.itemId, pool, ctx.services.world));
    const item = pooled ? resolveItem(ctx.services.world, pooled) : null;
    if (!item) {
      return {
        trigger: `${host.name} holds out a hand — "${offer.label} — of what?" Name the piece you are handing over.`,
        deterministic: true,
      };
    }
    itemId = item.id;
    itemName = item.name;
  }
  const purse = player.stats.coins ?? 0;
  if (purse < offer.priceCp) {
    return {
      trigger: `${host.name} names the fee for ${offer.label.toLowerCase()}: ${formatCoins(offer.priceCp)}. You have ${formatCoins(purse)} — not enough, and no work begins.`,
      deterministic: true,
    };
  }
  const custody = offer.custody && !!itemId;
  const dueClock = custody && offer.minutes > 0 ? model.clock + offer.minutes : null;
  const agreement: ServiceAgreement = {
    id: `svc-${model.clock}-${host.id}-${offer.id}`,
    npcId: host.id,
    npcName: host.name,
    label: itemName ? `${offer.label}: ${itemName}` : offer.label,
    feeCp: offer.priceCp,
    itemId,
    itemName,
    custody,
    dueDay: dueClock !== null ? dayOf(dueClock) : null,
    dueMinute: dueClock !== null ? dueClock % 1440 : null,
    state: "active",
  };
  const done = ctx.apply({ type: "serviceBegin", pcId: player.id, agreement });
  if (done.rejected) {
    return { trigger: `You try to strike the deal with ${host.name}, but it falls through.`, deterministic: true };
  }
  const holdLine = custody
    ? ` ${host.name} keeps the ${itemName} meanwhile — ${dueLabel(agreement)}.`
    : "";
  const receipt = `You pay ${host.name} ${formatCoins(offer.priceCp)} for ${agreement.label.toLowerCase()}.${holdLine}`;
  ctx.emit({
    kind: "stateChanged",
    summary: receipt,
    changes: { npcId: host.id, serviceId: offer.id, feeCp: offer.priceCp, custody },
    quiet: true,
  });
  noteExchange(ctx, model, {
    npcId: host.id,
    npcName: host.name,
    kind: "service",
    lines: itemId ? [{ itemId, name: itemName ?? itemId, quantity: 1, eachCp: null }] : [],
    coinsCp: -offer.priceCp,
    note: receipt,
  });
  if (!custody) {
    // While-you-wait work closes its own agreement in the same turn — the ledger keeps both ends.
    ctx.apply({ type: "serviceComplete", agreementId: agreement.id });
  }
  return {
    trigger:
      `(Already resolved and shown to the player as a ledger line: "${receipt}" — this REALLY happened; ` +
      `write the moment of the deal briefly, do NOT repeat that sentence, and do NOT return the item early${custody ? ` — ${host.name} holds the ${itemName} until it is ready` : ""}.) ` +
      `${input || `The player engages ${host.name} for ${offer.label.toLowerCase()}.`}`,
    echoFallback: receipt,
  };
}

/**
 * Walk due custody agreements each turn (called at resolve entry, before the per-kind switch):
 * when the holder NPC and the player stand in the same place and the due clock has passed, the
 * work comes back through the reducer — a real return beat, so "ready by evening bell" is a
 * promise the WORLD keeps, not the narrator.
 */
export function settleDueServices(ctx: TickContext): void {
  const model = ctx.model;
  const player = playerEntity(model);
  if (!player) return;
  // The PURE reader, never the accessor: a slice accessor write-backs an empty slice onto the
  // model, and a read-only walk that dirties the snapshot breaks `snapshot == fold(deltas)`
  // (the npc-routines-wave trap, re-learned here via three replay tests).
  const open = openAgreements(readServicesSlice(model.modules));
  if (open.length === 0) return;
  const day = dayOf(model.clock);
  const minute = model.clock % 1440;
  for (const a of open) {
    if (!a.custody || !a.itemId) continue;
    if (!agreementReady(a, day, minute)) continue;
    const holder = model.entities.get(a.npcId);
    if (!holder || holder.locationId !== player.locationId) continue;
    const done = ctx.apply({ type: "serviceComplete", agreementId: a.id });
    if (done.rejected) continue;
    const returned = player.stats?.inventory.includes(a.itemId) ?? false;
    const line = returned
      ? `${a.npcName} hands your ${a.itemName ?? "piece"} back — the work is done, as agreed.`
      : `${a.npcName} settles the ${a.label.toLowerCase()} — the work is done.`;
    ctx.emit({ kind: "stateChanged", summary: line, changes: { agreementId: a.id, itemId: a.itemId } });
    noteExchange(ctx, model, {
      npcId: a.npcId,
      npcName: a.npcName,
      kind: "received",
      lines: a.itemId ? [{ itemId: a.itemId, name: a.itemName ?? a.itemId, quantity: 1, eachCp: null }] : [],
      coinsCp: 0,
      note: line,
    });
  }
}

/**
 * Resolve a grounded WORK shift (the job system). Re-resolve the opportunity by id (resolve-time
 * authority — the classifier only grounds the id), roll the PC's `ability` vs the shift `dc` (a
 * seeded check — mechanics in code, the number never the model's), and pay through the reducer's
 * `adjustCoins`: `wageCp` on success, `failWageCp` on a botch (default 0). The narrator only
 * describes the toil. A down PC or a vanished opportunity refuses without charge. Mirrors
 * `resolveTrade`'s atomic-through-the-one-writer shape and `resolveCheckIntent`'s roll path.
 */
export function resolveWork(ctx: TickContext, plan: TurnPlan, input: string): NarrationIntent {
  const model = ctx.model;
  const player = playerEntity(model);
  const opportunityId = plan.work?.opportunityId ?? null;
  if (!opportunityId || !player?.stats) return { trigger: input };
  const job = workOpportunityById(ctx, model, player.locationId ?? "", opportunityId);
  if (!job) {
    return { trigger: `You cast about for the work you had in mind, but there is none to be had here. ${input}` };
  }
  if (player.stats.currentHp <= 0) {
    return {
      trigger: `You are in no shape to work — the world swims dark and your hands will not answer. (Rest or victory can bring you back.)`,
    };
  }
  // A shift with an authored cooldown cannot be worked twice in the same stretch of days. Nothing
  // bounded repetition before: `workHistory` counted LIFETIME shifts and its only reader used the
  // count as an unlock, so the board rewarded grinding the same job and the playtest flagged
  // "spam the highest-DC work button" as a plausible dominant strategy.
  if (job.cooldownDays !== undefined) {
    const lastDay = workLastDay(model, job.id);
    const today = dayOf(model.clock);
    if (lastDay !== null && today - lastDay < job.cooldownDays) {
      const wait = job.cooldownDays - (today - lastDay);
      return {
        trigger:
          `That shift is spoken for — "${job.label}" has been worked too recently, and the hall won't take you on again ` +
          `for another ${wait === 1 ? "day" : `${wait} days`}.`,
        deterministic: true,
      };
    }
  }
  // …and the DAY itself is throttled, not just each row (see WORK_DAY_MINUTES). A shift that would
  // push today's worked minutes past a full working day is refused — the body is spent, whatever
  // the boards still say. Only fires once some labor is already behind you, so a single authored
  // shift is never unworkable however long it is.
  //
  // Scoped to rows that declare a `cooldownDays`, which is the BOARD's own throttle marker (the
  // economy spec pins "every board shift is throttled: an authored duration and a cooldown"). A row
  // authored WITHOUT one is deliberately repeatable story labor, not the economy — `work.field-hand`
  // on npc.hollis is the three-shift spine of `quest.safe-harbor`, meant to be worked back to back.
  const throttled = job.cooldownDays !== undefined;
  const workedToday = throttled ? workMinutesToday(model) : 0;
  if (throttled && job.minutes !== undefined && workedToday > 0 && workedToday + job.minutes > WORK_DAY_MINUTES) {
    // NAME the shift that consumed the hours (r2 playtest: a bare "already given the day its
    // labor — 4 hours" read as a false statement when the player never knowingly worked; the
    // ledger must show its receipts).
    const slice = model.modules.workHistory as { lastDay?: Record<string, number> } | undefined;
    const today = dayOf(model.clock);
    const workedLabels = Object.entries(slice?.lastDay ?? {})
      .filter(([, day]) => day === today)
      .map(
        ([id]) =>
          ctx.services.world.locations.flatMap((l) => l.work ?? []).find((w) => w.id === id)?.label ?? id,
      );
    const receipts = workedLabels.length > 0 ? ` (${naturalList(workedLabels.map((l) => `"${l}"`))})` : "";
    return {
      trigger:
        `You have already given the day its labor — ${Math.round(workedToday / 60)} hours of it${receipts} — and "${job.label}" ` +
        `wants ${Math.round(job.minutes / 60)} more. Your hands are done; the hall will still be here tomorrow.`,
      deterministic: true,
    };
  }
  const pc = ctx.services.campaign.characters.find((c) => c.id === player.id);
  const abilityScore = pc ? pc.stats.abilities[job.ability] : 10;
  const bonus = job.skill && pc?.stats.proficiencies.includes(job.skill) ? 2 : 0;
  const dc = Math.max(5, Math.min(30, job.dc));
  const label = `${ABILITY_NAMES[job.ability]}${job.skill ? ` (${job.skill})` : ""} — ${job.label}`;

  const result = resolveCheck({ abilityScore, dc, bonus }, ctx.services.rng);
  ctx.emit({
    kind: "diceRolled",
    actorId: player.id,
    notation: "1d20",
    rolls: result.rolls,
    total: result.total,
    purpose: `${label} (DC ${dc})`,
    success: result.success,
  });
  const wage = result.success ? job.wageCp : job.failWageCp;
  if (wage > 0) ctx.apply({ type: "adjustCoins", entityId: player.id, by: wage });
  // A shift well-worked builds STANDING with the hall's guild faction (the reputation loop: grind
  // work → standing → unlock better work/quests/gear). Mirrors the quest-completion warmth.
  if (result.success) {
    const guildFactionId = ctx.services.world.locations.find((l) => l.id === player.locationId)?.guild?.factionId;
    for (const cmd of factionStandingCommands(ctx.services.world, player.id, guildFactionId, WORK_STANDING_GAIN)) {
      ctx.apply(cmd);
    }
  }
  const workHistory = ctx.model.modules.workHistory as {
    opportunities?: Record<string, number>;
    lastDay?: Record<string, number>;
  } | undefined;
  const opportunities = { ...(workHistory?.opportunities ?? {}) };
  opportunities[job.id] = (opportunities[job.id] ?? 0) + 1;
  // The lifetime count stays (it is the `workedOpportunity` unlock predicate); the DAY is new, and
  // it is what `cooldownDays` reads. Additive — a save without it just has no cooldown history.
  const lastDay = { ...(workHistory?.lastDay ?? {}), [job.id]: dayOf(model.clock) };
  // The day's labor tally the throttle above reads — board rows only, matching what it governs, and
  // omitted from the patch entirely for story labor so that row leaves the tally untouched. ONE day
  // is kept (overwritten whenever the day rolls over), so the slice stays a fixed two fields rather
  // than growing with the playthrough.
  const dayLabor = throttled
    ? { dayLabor: { day: dayOf(model.clock), minutes: workedToday + (job.minutes ?? 0) } }
    : {};
  ctx.apply({ type: "modulePatch", module: "workHistory", patch: { opportunities, lastDay, ...dayLabor } });
  // A shift costs its authored length, not a flat hour: "coin at day's end" should cost the day.
  // Priced here (not in `resolvePlan`) because only the resolver knows WHICH job was taken; the one
  // commit chokepoint still spends it. Energy scales with the hours, so a full day really tires.
  if (job.minutes !== undefined) {
    const base = costOf("work");
    ctx.data.clockMinutes = job.minutes;
    ctx.data.energyCost = scaledEnergy(base.energy, job.minutes, base.minutes);
  }
  const purse = formatCoins(player.stats.coins ?? 0);
  const paid = wage > 0 ? `You are paid ${formatCoins(wage)}.` : `You are paid nothing.`;
  ctx.emit({
    kind: "stateChanged",
    summary: result.success
      ? `You work — "${job.label}" — and earn ${formatCoins(wage)} (${purse} now).`
      : wage > 0
        ? `You botch the work — "${job.label}" — and take only ${formatCoins(wage)} (${purse} now).`
        : `You botch the work — "${job.label}" — and earn nothing.`,
    changes: { workId: job.id, wageCp: wage, success: result.success },
  });
  if (isCombatActive(model)) ctx.data.itemActionTurn = { actorId: player.id };
  return {
    trigger: result.success
      ? `You put in the work — ${job.label}. ${paid} Narrate the honest labor and the coin changing hands.`
      : `You labor at ${job.label}, and it goes badly. ${paid} Narrate the botched shift.`,
    resolved: resolvedFromCheck(label, result),
  };
}

/**
 * Rank the authoritative work on offer here for a `workInquiry`, by the inquiry's own modifier.
 * "Safest" means the lowest DC, then the best consolation wage; "best paying" means the highest
 * success wage; otherwise the clearest (lowest DC, then best wage). This ONLY ranks — it never
 * rolls, pays, moves, or invents an employer, and it emits no prose. Returns the top job plus a
 * diegetic `basis` phrase for the pointer, or null when nothing is posted (or mid-combat). The
 * CLASSIFIER decides what is an inquiry (`workInquiry` — the old `isWorkInquiry` regex net is
 * deleted per the no-nets rule); the modifiers below only rank an already-classified question.
 */
export function rankWorkInquiry(ctx: TickContext, input: string): { job: Work; basis: string } | null {
  if (isCombatActive(ctx.model)) return null;
  const loc = partyLocationOf(ctx.model);
  if (!loc) return null;
  const present = entitiesAt(ctx.model, loc).filter((entity) => entity.id !== playerEntity(ctx.model)?.id);
  const jobs = workOpportunitiesHere(ctx.services.world, ctx.services.campaign, ctx.model, loc, present)
    .map((ref) => workOpportunityById(ctx, ctx.model, loc, ref.id))
    .filter((job): job is Work => job !== undefined);
  if (jobs.length === 0) return null;

  // The bare word "sure" is NOT a safety modifier — it is the commonest hedge in English, and it
  // wins this branch outright because `safest` is tested first in the sort below. Reproduced
  // against the shipped ranker with the two-job fixture board (a DC-5 60cp sweep, a DC-30 200cp
  // haul): "I'm not sure — which of these jobs pays the best?" answered with the SWEEP. The
  // player asked which pays best and was pointed at the worst-paying job on the board, because
  // "not sure" scored as "no-risk". `surest` is unambiguous and stays; "sure" now needs the noun
  // that makes it a claim about the work ("a sure thing", "sure money").
  const safest =
    /\b(?:safe|safest|no[- ]risk|low[- ]risk|surest|reliable)\b|\bsure\s+(?:thing|bet|work|job|money|coin|pay|wage)\b/i.test(
      input,
    );
  // Catch both word orders — "best-paying"/"highest wage" AND "pays more"/"more coin" — so a
  // trailing modifier ("a job that pays more") ranks by wage instead of falling to the safe default.
  const bestPaying =
    /\b(?:best|highest|most|better|good|fastest)[^.!?]{0,18}\b(?:pay|paying|wage)\b|\bpaying\b|\bpays?\s+(?:the\s+)?(?:more|most|better|best|well)\b|\bmore\s+(?:pay|coin|money|silver)\b/i.test(
      input,
    );
  const ranked = [...jobs].sort((a, b) => {
    if (safest) return a.dc - b.dc || b.failWageCp - a.failWageCp || b.wageCp - a.wageCp;
    if (bestPaying) return b.wageCp - a.wageCp || a.dc - b.dc || b.failWageCp - a.failWageCp;
    return a.dc - b.dc || b.wageCp - a.wageCp;
  });
  const basis = safest ? "the surest of it" : bestPaying ? "the best-paying" : "the clearest honest work";
  return { job: ranked[0]!, basis };
}

/**
 * Who voices a `workInquiry` pointer — the diegetic source the answer should come THROUGH. The
 * world never narrates its own job menu: the explicitly ADDRESSED present, conscious NPC answers
 * (the player asked them), else a present COMPANION volunteers the lead in character. Returns null
 * when there is no one to speak — the caller then points at the claims-board as a fixture. A random
 * present stranger is deliberately NOT chosen (never put a job pitch in an un-addressed mouth).
 */
export function workLeadSpeaker(ctx: TickContext, plan: TurnPlan): Entity | null {
  const loc = partyLocationOf(ctx.model);
  if (!loc) return null;
  const conscious = (e: Entity): boolean => !e.stats || e.stats.currentHp > 0;
  const present = (e: Entity): boolean => e.partyMember || e.locationId === loc;
  const addressed = plan.targetId ? ctx.model.entities.get(plan.targetId) : undefined;
  if (addressed && addressed.kind === "npc" && conscious(addressed) && present(addressed)) return addressed;
  // At an adventure-guild hall the guildmaster (`clerkId`) is the board's own voice — prefer them
  // over a tag-along companion, so "who's hiring?" is answered by the person who keeps the postings.
  const guild = ctx.services.world.locations.find((l) => l.id === loc)?.guild;
  if (guild?.clerkId) {
    const clerk = ctx.model.entities.get(guild.clerkId);
    if (clerk && clerk.kind === "npc" && conscious(clerk) && present(clerk)) return clerk;
  }
  const companion = entitiesAt(ctx.model, loc).find(
    (e) => e.kind === "npc" && e.partyMember && conscious(e),
  );
  return companion ?? null;
}

/** Quests currently ON OFFER (state "offered"), as id+name refs — the questAction targets. */
/** The campaign day this shift was last worked, or null if it never has been. */
export function workLastDay(model: WorldModel, jobId: string): number | null {
  const slice = model.modules.workHistory as { lastDay?: Record<string, number> } | undefined;
  const day = slice?.lastDay?.[jobId];
  return typeof day === "number" ? day : null;
}

/**
 * Minutes of authored labor already worked TODAY (the `WORK_DAY_MINUTES` throttle's input). The
 * tally is stamped with the day it was earned on, so a stale one from any earlier day reads as
 * zero — no reset pass, and a save written before this field existed simply starts the day fresh.
 */
export function workMinutesToday(model: WorldModel): number {
  const slice = model.modules.workHistory as { dayLabor?: { day?: number; minutes?: number } } | undefined;
  const labor = slice?.dayLabor;
  if (!labor || labor.day !== dayOf(model.clock)) return 0;
  return typeof labor.minutes === "number" ? labor.minutes : 0;
}

/** Re-resolve a work opportunity by id from the location board or any present hirer (resolve-time
 *  authority — the classifier only grounds the id; wage/DC are read here, never trusted from the wire). */
export function workOpportunityById(
ctx: TickContext,model: WorldModel, loc: string, id: string): Work | undefined {
  // Resolve-time authority mirrors the guild gate above: the location board counts only at a guild.
  const locData = ctx.services.world.locations.find((l) => l.id === loc);
  const here = locData?.guild ? (locData.work ?? []) : [];
  const found = here.find((w) => w.id === id);
  // Resolve authority honors the same reputation gate as the board surface: a gated shift the PC
  // hasn't unlocked is not takeable (falls through to a present hirer, else "no such work").
  if (found && workRequiresMet(found.requires, model, ctx.services.world, ctx.services.campaign.characters)) {
    return found;
  }
  for (const e of entitiesAt(model, loc)) {
    if (e.kind !== "npc") continue;
    const template = ctx.services.world.npcs.find((n) => n.id === (e.templateId ?? e.id));
    const w = template?.work?.find((w) => w.id === id);
    if (w) return w;
  }
  return undefined;
}
