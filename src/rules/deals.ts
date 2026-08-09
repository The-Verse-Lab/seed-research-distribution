/**
 * Deals — the standing-agreement ledger (PROSE-TO-CODE §2.2, "deals are state, not scrollback").
 *
 * Why this exists (playtest run 6): the run's best content was its bargains — Vess's first-refusal
 * contract, Brann's strongbox stake, Sela's credit on the vest — and every one of them was recorded
 * nowhere. They lived in the scrollback, which meant the world could not hold anyone to them and the
 * campaign was an improv session with a good memory for prose and none for obligations.
 *
 * What this wave commits to is CAPTURE + VISIBILITY, not enforcement: a struck deal becomes a real
 * row, the narrator and every NPC brief carry the open ones as `# STANDING DEALS`, and the player can
 * read them in `/state` and through the read-only projection. Whether handing over the strongbox *mechanically*
 * settles Brann's stake is a later pass (§2.2 in the ledger says so). The point is that the terms
 * survive the turn they were spoken in.
 *
 * Slice discipline (the `exchanges` precedent): value shapes + defaults + pure helpers live here; the
 * ONLY writers are the reducer commands `recordDeal` / `setDealState` via the accessor in
 * `src/world/module-slices.ts`, and replay folds the same absolute `modulePatched` patches.
 *
 * @author Runkai Zhang
 */

export const DEALS_MODULE = "deals";

/** How many deal rows the slice retains (FIFO) — closed rows age out, open ones are few by nature. */
export const DEALS_CAP = 24;

/** How many open deals a brief block carries (newest last). */
export const DEALS_BRIEF_ROWS = 5;

/** Longest terms text kept — one clause, not a contract; anything longer is prose that lost the plot. */
export const MAX_TERMS_LENGTH = 160;

export type DealState = "open" | "honoured" | "broken";

/**
 * One agreement the player and someone else settled aloud. `terms` is the finished, player-safe
 * clause every surface reuses verbatim, so the brief, the panel and the fiction cannot disagree
 * about what was promised.
 */
export interface Deal {
  id: number;
  /** Entity ids party to it — the PC first, then the counterparty(ies). */
  parties: string[];
  /** Display names parallel to {@link parties}, so a panel renders without a world lookup. */
  partyNames: string[];
  terms: string;
  state: DealState;
  /** In-world clock (monotonic minutes) when it was struck. */
  atClock: number;
  /** When it was honoured or broken; null while open. */
  closedAtClock: number | null;
}

export interface DealsSlice {
  records: Deal[];
  nextId: number;
}

export function defaultDealsSlice(): DealsSlice {
  return { records: [], nextId: 1 };
}

/** Deep copy so a `modulePatched` patch carries an ABSOLUTE post-state replay folds byte-identically. */
export function cloneDealsSlice(slice: DealsSlice): DealsSlice {
  return {
    records: slice.records.map((d) => ({ ...d, parties: [...d.parties], partyNames: [...d.partyNames] })),
    nextId: slice.nextId,
  };
}

/** Read-only view over a modules bag (GameState projection or `WorldModel.modules`) — never a write. */
export function readDealsSlice(modules: Record<string, unknown> | undefined): DealsSlice {
  const slice = modules?.[DEALS_MODULE] as Partial<DealsSlice> | undefined;
  const records = Array.isArray(slice?.records) ? slice.records.filter(isDeal) : [];
  return { records: records.map((d) => ({ ...d })), nextId: typeof slice?.nextId === "number" ? slice.nextId : 1 };
}

function isDeal(value: unknown): value is Deal {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === "number" &&
    Array.isArray(d.parties) &&
    typeof d.terms === "string" &&
    (d.state === "open" || d.state === "honoured" || d.state === "broken")
  );
}

/** Still-standing deals, oldest first — what a brief block and read-only projection show. */
export function openDeals(slice: DealsSlice): Deal[] {
  return slice.records.filter((d) => d.state === "open");
}

/**
 * The open deal an honour/break line most likely means: the most recent standing agreement `npcId`
 * is party to (or, with no party named, the most recent standing agreement at all). Code picks the
 * referent — the player says "I keep my word to Brann", never a row id.
 */
export function openDealWith(slice: DealsSlice, npcId: string | null): Deal | undefined {
  const open = openDeals(slice);
  const scoped = npcId ? open.filter((d) => d.parties.includes(npcId)) : open;
  return scoped.at(-1);
}

/**
 * Normalize terms for storage AND for the duplicate check: collapsed whitespace, trimmed, capped.
 * The dedup key is the lowercase form — an NPC re-stating the same bargain on the next turn must not
 * mint a second row (the classifier reports what the LINE settles, and a two-turn haggle settles the
 * same thing twice).
 */
export function normalizeTerms(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_TERMS_LENGTH);
}

export function termsKey(terms: string): string {
  return normalizeTerms(terms).toLowerCase();
}

/** Whether an equivalent OPEN deal already stands between the same parties — the mint guard. */
export function hasEquivalentOpenDeal(slice: DealsSlice, parties: readonly string[], terms: string): boolean {
  const key = termsKey(terms);
  const who = [...parties].sort().join("|");
  return openDeals(slice).some((d) => termsKey(d.terms) === key && [...d.parties].sort().join("|") === who);
}

/** "with Brann Coldwater — first refusal on any glass I bring back" — one line for a brief or a panel. */
export function renderDeal(deal: Deal, playerId: string): string {
  const others = deal.partyNames.filter((_, i) => deal.parties[i] !== playerId);
  const who = others.length > 0 ? others.join(" and ") : "someone";
  return `with ${who} — ${deal.terms}`;
}
