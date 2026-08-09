/**
 * Exchange & service value shapes — the DEALINGS ledger (every buy/sell/fee/gift/payment the
 * reducer actually executed, in order, with in-world stamps) and SERVICE agreements (an NPC doing
 * bounded work for a fee — sharpening, repair — with optional item CUSTODY and a due time).
 *
 * Why this exists (playtest run 7): commerce lived only in prose, so the narration could assert
 * purchases that never executed ("You're kitted"), a service fee resolved as a half-price SALE of
 * the item being serviced, and nothing anywhere remembered what had actually changed hands. The
 * ledger is the shared memory: the narrator brief and each NPC's reply brief read it back, so an
 * exchange can be referred to later instead of silently un-happening.
 *
 * Slice discipline: value shapes + defaults + pure helpers live here; the ONLY writers are the
 * reducer commands (`recordExchange`, `serviceBegin`, `serviceComplete`) via the accessors in
 * `src/world/module-slices.ts`, and replay folds the same absolute `modulePatched` patches.
 *
 * @author Runkai Zhang
 */

export const EXCHANGES_MODULE = "exchanges";
export const SERVICES_MODULE = "services";

/** How many exchange records the slice retains (FIFO) — enough for "recently" in a long session
 *  without growing the save unboundedly. Brief injection reads far fewer. */
export const EXCHANGE_CAP = 48;

/** How many [DEALT] rows the narrator brief carries (newest last). */
export const DEALINGS_ROWS = 8;

/** How many dealings-with-you rows an NPC's own reply brief carries. */
export const NPC_DEALINGS_ROWS = 5;

export type ExchangeKind =
  | "buy" // goods vendor → PC, coins PC → vendor
  | "sell" // goods PC → vendor, coins vendor → PC
  | "service" // a fee paid for work done (item may be in custody meanwhile)
  | "payment" // coins handed over outside a counter (tip, bribe, fee, donation)
  | "gift" // an item given away by the PC
  | "received"; // an item handed TO the PC

/** One goods line inside a record ("Rations (1 day) ×3 @ 5 sp"). */
export interface ExchangeLine {
  itemId: string | null;
  name: string;
  quantity: number;
  /** Price per unit in copper, when priced (null for gifts/props). */
  eachCp: number | null;
}

/** One executed exchange — a receipt the world remembers. `note` is the finished, player-safe
 *  sentence every brief reuses verbatim, so prose and panels can never disagree about it. */
export interface ExchangeRecord {
  id: number;
  /** In-world stamp (campaign day + minute-of-day) so an NPC can say "this morning". */
  day: number;
  minute: number;
  /** The counterparty (null for unowned payments — coins left on a crate). */
  npcId: string | null;
  npcName: string;
  kind: ExchangeKind;
  lines: ExchangeLine[];
  /** Signed copper from the PC's point of view: negative left the purse, positive entered it. */
  coinsCp: number;
  note: string;
}

export interface ExchangesSlice {
  records: ExchangeRecord[];
  nextId: number;
}

export function defaultExchangesSlice(): ExchangesSlice {
  return { records: [], nextId: 1 };
}

export type ServiceState = "active" | "done";

/**
 * A struck service agreement. `custody` means the NPC HOLDS `itemId` until `dueDay/dueMinute`
 * (the sharpening-overnight shape); the item left the PC's pack via the same reducer command that
 * minted the agreement, and `serviceComplete` is the only path that returns it. A while-you-wait
 * service has no custody and no due.
 */
export interface ServiceAgreement {
  id: string;
  npcId: string;
  npcName: string;
  /** Player-facing label ("Sharpen and dress the Rapier"). */
  label: string;
  feeCp: number;
  itemId: string | null;
  itemName: string | null;
  custody: boolean;
  /** When the work is ready (absolute campaign day + minute); null ⇒ done on the spot. */
  dueDay: number | null;
  dueMinute: number | null;
  state: ServiceState;
}

export interface ServicesSlice {
  agreements: ServiceAgreement[];
}

export function defaultServicesSlice(): ServicesSlice {
  return { agreements: [] };
}

/** Deep-copy helpers so `modulePatched` patches carry ABSOLUTE post-states that replay can fold
 *  byte-identically (the journey-log precedent — never patch with live references). */
export function cloneExchangesSlice(slice: ExchangesSlice): ExchangesSlice {
  return {
    records: slice.records.map((r) => ({ ...r, lines: r.lines.map((l) => ({ ...l })) })),
    nextId: slice.nextId,
  };
}

export function cloneServicesSlice(slice: ServicesSlice): ServicesSlice {
  return { agreements: slice.agreements.map((a) => ({ ...a })) };
}

/** Open (still-active) agreements, oldest first. */
export function openAgreements(slice: ServicesSlice): ServiceAgreement[] {
  return slice.agreements.filter((a) => a.state === "active");
}

/** True once the world clock has reached an agreement's due stamp (no due ⇒ always ready). */
export function agreementReady(a: ServiceAgreement, day: number, minute: number): boolean {
  if (a.dueDay === null || a.dueMinute === null) return true;
  return day > a.dueDay || (day === a.dueDay && minute >= a.dueMinute);
}

/** "ready at dusk (day 3)" — a player-safe due label from a minute-of-day. Mirrors the brief's
 *  coarse phase words rather than a clock readout the fiction never shows. */
export function dueLabel(a: ServiceAgreement): string {
  if (a.dueDay === null || a.dueMinute === null) return "ready now";
  const phase =
    a.dueMinute < 300 ? "the small hours" :
    a.dueMinute < 660 ? "morning" :
    a.dueMinute < 840 ? "midday" :
    a.dueMinute < 1080 ? "afternoon" :
    a.dueMinute < 1260 ? "dusk" : "night";
  return `ready by ${phase} (day ${a.dueDay})`;
}

/** Read-only slice views over a modules bag (GameState projection or WorldModel.modules) — the
 * brief builders and state projections read through these; only the reducer writes. */
export function readExchangesSlice(modules: Record<string, unknown> | undefined): ExchangesSlice {
  const slice = modules?.[EXCHANGES_MODULE] as Partial<ExchangesSlice> | undefined;
  return { records: slice?.records ?? [], nextId: slice?.nextId ?? 1 };
}

export function readServicesSlice(modules: Record<string, unknown> | undefined): ServicesSlice {
  const slice = modules?.[SERVICES_MODULE] as Partial<ServicesSlice> | undefined;
  return { agreements: slice?.agreements ?? [] };
}

/** The most recent records, newest LAST (chronological for a brief block). */
export function recentExchanges(slice: ExchangesSlice, limit: number): ExchangeRecord[] {
  return slice.records.slice(-Math.max(0, limit));
}

/** Records involving one NPC, newest last — an NPC's own memory of dealing with the player. */
export function exchangesWith(slice: ExchangesSlice, npcId: string, limit: number): ExchangeRecord[] {
  return slice.records.filter((r) => r.npcId === npcId).slice(-Math.max(0, limit));
}
