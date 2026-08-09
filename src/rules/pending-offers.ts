/**
 * Pending offers — the bounded, per-NPC record of wares an NPC PRICED ALOUD, so the counter can
 * honour the thing the fiction just offered (PROSE-TO-CODE §2.1, "the lantern, properly").
 *
 * The seam this closes: an NPC takes a lantern off a rack and names a price, the player says "I'll
 * take it", and the trade resolver — which only ever matched authored inventory — answers with the
 * r7 diegetic refusal ("that one's spoken for"). The fiction asserted something the mechanics would
 * not honour, which is the exact failure mode the ledger exists to kill.
 *
 * The capture is a STRUCTURED SELF-REPORT, never an extraction: the NPC agent's reply JSON carries
 * an optional `offers: [{name, priceCp}]` array (see `INTENT_JSON_INSTRUCTION` in
 * `src/agents/npc.ts`), so no regex ever reads model prose looking for a price. Rows without both
 * fields are dropped at the parse boundary.
 *
 * The math-leaf sibling of `utterances.ts`: a pure value shape plus helpers over the
 * `model.modules.pendingOffers` slice. The slice is written ONLY by the reducer, via the generic
 * `modulePatch` command the emit sites enqueue with `applySilent` (replay-safe: `modulePatched`
 * deltas fold with `Object.assign`, and each patch carries the absolute new per-NPC list). Bounded
 * by design: the last {@link MAX_OFFERS_PER_NPC} offers per NPC, so the slice can never outgrow the
 * cast that has spoken.
 *
 * Offers are SCENE-scoped, twice over: {@link liveOffersFor} hands back only offers stamped with the
 * location the player is standing in AND made within {@link OFFER_TTL_MINUTES} of the current clock,
 * so a price quoted in Anchorfall cannot follow the party across the map, and a return visit three
 * days later does not revive it.
 *
 * @author Runkai Zhang
 */

/** The module-slice key under `model.modules` (written via the generic `modulePatch` command). */
export const PENDING_OFFERS_MODULE = "pendingOffers";

/** How many recent offers to remember per NPC — a FIFO ring, oldest dropped. */
export const MAX_OFFERS_PER_NPC = 4;

/**
 * How long (in-world minutes) an unclaimed offer stands. Long enough to survive a conversation and
 * a short errand; short enough that a price quoted on day 1 is not still binding on day 3.
 */
export const OFFER_TTL_MINUTES = 180;

/** One ware an NPC named a price for, in their own words. */
export interface PendingOffer {
  /** The ware as the NPC named it ("brass lantern") — matched loosely against the player's ask. */
  name: string;
  /** The price the NPC quoted, in copper. Always a positive integer. */
  priceCp: number;
  /** Where the offer was made — an offer is only live where it was spoken. */
  locationId: string;
  /** The world clock (monotonic minutes) when it was made — the TTL anchor. */
  atClock: number;
}

/**
 * The full runtime slice stored at `model.modules.pendingOffers`: per-NPC id → that NPC's recent
 * offers, oldest-first, capped at {@link MAX_OFFERS_PER_NPC}. Absent key ⇒ that NPC has offered
 * nothing.
 */
export type PendingOffersSlice = Record<string, PendingOffer[]>;

/** Read the per-NPC list defensively (the modules bag is `unknown` by contract). Returns a COPY. */
export function readOffers(modules: Record<string, unknown>, npcId: string): PendingOffer[] {
  const slice = modules[PENDING_OFFERS_MODULE] as PendingOffersSlice | undefined;
  const list = slice?.[npcId];
  if (!Array.isArray(list)) return [];
  return list.filter(isPendingOffer).map((o) => ({ ...o }));
}

function isPendingOffer(value: unknown): value is PendingOffer {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    o.name.trim().length > 0 &&
    typeof o.priceCp === "number" &&
    Number.isInteger(o.priceCp) &&
    o.priceCp > 0 &&
    typeof o.locationId === "string" &&
    typeof o.atClock === "number"
  );
}

/**
 * The offers of `npcId` that are still binding for a player standing in `locationId` at `clock`:
 * same place, within the TTL, newest LAST (the caller prefers the most recent quote for a name).
 * Pure read — never touches the slice.
 */
export function liveOffersFor(
  modules: Record<string, unknown>,
  npcId: string,
  locationId: string,
  clock: number,
): PendingOffer[] {
  return readOffers(modules, npcId).filter(
    (o) => o.locationId === locationId && clock - o.atClock <= OFFER_TTL_MINUTES && clock >= o.atClock,
  );
}

/**
 * The next bounded per-NPC list after `npcId` offers `added` — the existing offers with the new ones
 * appended, truncated to the most-recent {@link MAX_OFFERS_PER_NPC}. Pure: returns the value the
 * caller hands to the `modulePatch` command; it does not mutate the slice. A re-quote of a name the
 * NPC already offered here REPLACES the older row (a vendor who names a new price has changed it,
 * not added a second lantern).
 */
export function pushOffers(
  modules: Record<string, unknown>,
  npcId: string,
  added: readonly PendingOffer[],
): PendingOffer[] {
  const fresh = added.filter(isPendingOffer);
  if (fresh.length === 0) return readOffers(modules, npcId);
  const superseded = new Set(fresh.map((o) => offerKey(o.name, o.locationId)));
  const kept = readOffers(modules, npcId).filter((o) => !superseded.has(offerKey(o.name, o.locationId)));
  return [...kept, ...fresh.map((o) => ({ ...o }))].slice(-MAX_OFFERS_PER_NPC);
}

/**
 * The `modulePatch` payload that records `offers` as spoken by `npcId`, here, now — the one shape
 * both emit sites (the reactive reply in `modules/dialogue.ts`, the autonomous beat in
 * `modules/autonomy/module.ts`) hand to `applySilent`. Kept here so the slice has exactly one
 * writer-shaped helper and the two sites cannot drift. Pure.
 */
export function offersPatch(
  modules: Record<string, unknown>,
  npcId: string,
  offers: readonly { name: string; priceCp: number }[],
  locationId: string,
  clock: number,
): { module: string; patch: Record<string, unknown> } {
  const stamped = offers.map((o) => ({ name: o.name, priceCp: o.priceCp, locationId, atClock: clock }));
  return { module: PENDING_OFFERS_MODULE, patch: { [npcId]: pushOffers(modules, npcId, stamped) } };
}

/**
 * The next per-NPC list with one offer REMOVED — what a completed offered sale leaves behind. One
 * lantern offered is one lantern sold; the quote does not stand for a second purchase.
 */
export function dropOffer(
  modules: Record<string, unknown>,
  npcId: string,
  offer: PendingOffer,
): PendingOffer[] {
  const key = offerKey(offer.name, offer.locationId);
  return readOffers(modules, npcId).filter(
    (o) => !(offerKey(o.name, o.locationId) === key && o.atClock === offer.atClock),
  );
}

function offerKey(name: string, locationId: string): string {
  return `${locationId}::${name.trim().toLowerCase().replace(/\s+/g, " ")}`;
}
