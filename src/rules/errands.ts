/**
 * Errands — "an NPC goes somewhere the player cannot, does one bounded thing, and comes back with
 * a result the CODE owns."
 *
 * Why it exists (r4 playtest, P3): the player told a companion "go to the Guild, ask X and Y, meet
 * me at the Crown". He accepted in dialogue, was co-located again two turns later, volunteered
 * nothing, and answered about something else entirely. Nothing mechanical had ever happened.
 * Sending an NPC where the player cannot go is the single best answer this build has to its
 * unreachable-content problem, and as shipped it cost a turn and returned nothing legible.
 *
 * The one rule that makes it worth having: **the finding is computed, never improvised.**
 * `resolveErrandTask` reads only authored `knowledge[]` / `knownLore`, case facts the subject
 * actually knows, live registry rows, and real routes. The model phrases the report; it never
 * decides what was learned. That is the same division of labour as `planCaseShare` → the ledger.
 *
 * Pure and deterministic: no rng at all (not even a keyed stream), so an errand turn consumes zero
 * draws and cannot shift any downstream roll. The slice lives at `WorldModel.modules.errands` and
 * is written only through the reducer's generic `modulePatch` by the errands tick module — no new
 * command, no new delta kind.
 *
 * @author Runkai Zhang
 */
import type { Campaign, Case, NpcTemplate, World } from "../content/schema.ts";
import { knowledgeStatements } from "../knowledge/facts.ts";
import { caseRuntimeOf, effectiveKnown } from "./cases.ts";
import { itemBaseCostCp, resolveItem } from "./items.ts";
import { dayOf, dayPhaseOf } from "./routine.ts";
import { entitiesAt, type WorldModel } from "../world/model.ts";
import { displayName } from "../world/entity.ts";

/** The `model.modules` key. */
export const ERRANDS_MODULE = "errands";

/** At most this many errands run at once — bounds the slice and keeps the ledger readable. */
export const ERRAND_CAP = 3;
/** How long a brought subject stays put once delivered, in days. */
export const MEETING_HOLD_DAYS = 1;
/** The doing, on top of two-way travel: knocking, waiting, being answered. */
export const ERRAND_WORK_MINUTES = 30;
/** Round trips longer than this are refused outright — a week-long errand is not a game action. */
export const ERRAND_MAX_MINUTES = 2 * 1440;
/** How many past reports THE RECORD carries. */
export const ERRAND_REPORT_ROWS = 3;

export type ErrandTask =
  | { kind: "ask"; subjectId: string; topic: string }
  | { kind: "bring"; subjectId: string }
  | { kind: "scout"; locationId: string }
  | { kind: "fetch"; locationId: string; itemId: string };

export interface Errand {
  /** `err:<runnerId>:<departedAtClock>` — deterministic, no rng. */
  id: string;
  runnerId: string;
  task: ErrandTask;
  /** A REAL location id. Never a `frontier:` id, never the empty string. */
  destinationId: string;
  /** Where the party stood at commit — where the runner comes back to. */
  reportLocationId: string;
  /** Where the runner stood before leaving (the routine-override restore target). */
  homeLocationId: string;
  departedAtClock: number;
  dueAtClock: number;
  feeCp: number;
}

export type ErrandOutcome = "delivered" | "empty" | "unreachable";

export interface ErrandReport {
  errandId: string;
  runnerId: string;
  atClock: number;
  outcome: ErrandOutcome;
  /** ENGINE-TEMPLATED lines only — `recordNpcMemory` forbids model prose (rules/npc-memory.ts). */
  findings: string[];
  /** A case fact the subject knew and the runner carried back, for `npcLearnCaseFact`. */
  caseFact?: { caseId: string; factId: string };
  /** A `fetch` that succeeded: the module mints the transfer and the coin. */
  bought?: { itemId: string; costCp: number };
  /** The subject to bring home alongside the runner (a delivered `bring`). */
  broughtId?: string;
}

export interface ErrandsSlice {
  /** runnerId → the errand they are on. One per runner, structurally. */
  active: Record<string, Errand>;
  /** runnerId → their most recent report (the ledger's `[REPORTED]` row). */
  reports: Record<string, ErrandReport>;
}

export function defaultErrandsSlice(): ErrandsSlice {
  return { active: {}, reports: {} };
}

/**
 * Defaulting COPY-reader (the `readRoutinesSlice` idiom). Never stores the default back on the
 * model — a world that has never run an errand must keep a byte-identical snapshot.
 */
export function readErrandsSlice(modules: Record<string, unknown> | undefined): ErrandsSlice {
  const slice = modules?.[ERRANDS_MODULE] as Partial<ErrandsSlice> | undefined;
  return {
    active: structuredClone(slice?.active ?? {}),
    reports: structuredClone(slice?.reports ?? {}),
  };
}

/**
 * What a non-companion charges to walk it: roughly a tenth of a day-labourer's wage per hour on
 * the road, floored so even a short hop is worth someone's trouble. Companions pay nothing — the
 * caller decides that, not this function.
 */
export function errandFee(routeMinutes: number): number {
  return Math.max(10, Math.round(routeMinutes / 6));
}

/** Out, do the thing, back. */
export function errandDueClock(clock: number, routeMinutes: number): number {
  return clock + routeMinutes * 2 + ERRAND_WORK_MINUTES;
}

/** "dusk, day 3" — the ETA the runner states before the player agrees to pay for it. */
export function errandEtaLabel(dueAtClock: number): string {
  return `${dayPhaseOf(dueAtClock)}, day ${dayOf(dueAtClock) + 1}`;
}

/** Everything `resolveErrandTask` needs, so it can stay pure. */
export interface ErrandResolveContext {
  model: WorldModel;
  world: World;
  campaign: Campaign;
  runnerName: string;
  destinationId: string;
  /** The player's purse, in copper — a `fetch` cannot spend what is not there. */
  playerCoins: number;
}

/**
 * THE code-owned result. Deterministic, side-effect free, and incapable of inventing a fact: every
 * branch either quotes authored content or reports a real registry/route reading.
 */
export function resolveErrandTask(
  task: ErrandTask,
  ctx: ErrandResolveContext,
): Pick<ErrandReport, "outcome" | "findings" | "caseFact" | "bought" | "broughtId"> {
  const place = locationName(ctx.world, ctx.destinationId);
  switch (task.kind) {
    case "ask":
      return resolveAsk(task, ctx, place);
    case "bring":
      return resolveBring(task, ctx, place);
    case "scout":
      return resolveScout(ctx, place);
    case "fetch":
      return resolveFetch(task, ctx, place);
  }
}

function resolveAsk(
  task: Extract<ErrandTask, { kind: "ask" }>,
  ctx: ErrandResolveContext,
  place: string,
): Pick<ErrandReport, "outcome" | "findings" | "caseFact"> {
  const subject = ctx.model.entities.get(task.subjectId);
  const template = templateOf(ctx.world, task.subjectId);
  const name = subject ? displayName(subject) : (template?.name ?? task.subjectId);
  if (!subject || subject.locationId !== ctx.destinationId) {
    return { outcome: "empty", findings: [`${ctx.runnerName} found no sign of ${name} at ${place}.`] };
  }

  // A case fact the subject actually knows and the player does not is the most valuable thing an
  // errand can carry, so it wins over flavour lore. The runner LEARNS it too (the caller applies
  // `npcLearnCaseFact`), which is what makes asking them about it afterwards work.
  const fact = unsharedCaseFact(ctx, task.subjectId);
  if (fact) {
    return {
      outcome: "delivered",
      findings: [`${ctx.runnerName} put the question to ${name} at ${place}, and came back with it: ${fact.text}`],
      caseFact: { caseId: fact.caseId, factId: fact.factId },
    };
  }

  const line = bestKnowledgeLine(template, task.topic);
  if (line) {
    return { outcome: "delivered", findings: [`${ctx.runnerName} asked ${name} at ${place}. What came back: ${line}`] };
  }
  const lore = template?.knownLore?.trim();
  if (lore) {
    return { outcome: "delivered", findings: [`${ctx.runnerName} asked ${name} at ${place}. What came back: ${lore}`] };
  }
  return {
    outcome: "empty",
    findings: [`${ctx.runnerName} found ${name} at ${place}, but got nothing worth carrying back.`],
  };
}

function resolveBring(
  task: Extract<ErrandTask, { kind: "bring" }>,
  ctx: ErrandResolveContext,
  place: string,
): Pick<ErrandReport, "outcome" | "findings" | "broughtId"> {
  const subject = ctx.model.entities.get(task.subjectId);
  const template = templateOf(ctx.world, task.subjectId);
  const name = subject ? displayName(subject) : (template?.name ?? task.subjectId);
  if (!subject || subject.locationId !== ctx.destinationId) {
    return { outcome: "empty", findings: [`${ctx.runnerName} found no sign of ${name} at ${place}.`] };
  }
  if (subject.stats && subject.stats.currentHp <= 0) {
    return { outcome: "empty", findings: [`${ctx.runnerName} found ${name} at ${place} in no state to be moved.`] };
  }
  if (subject.partyMember) {
    return { outcome: "empty", findings: [`${name} already walks with you — there is no one to send for.`] };
  }
  return {
    outcome: "delivered",
    findings: [`${ctx.runnerName} brought ${name} back from ${place}.`],
    broughtId: task.subjectId,
  };
}

function resolveScout(ctx: ErrandResolveContext, place: string): Pick<ErrandReport, "outcome" | "findings"> {
  const standing = entitiesAt(ctx.model, ctx.destinationId)
    .filter((e) => e.kind === "npc" && (e.stats === undefined || e.stats.currentHp > 0))
    .map((e) => displayName(e));
  const summary = ctx.world.locations.find((l) => l.id === ctx.destinationId)?.description?.trim();
  const findings = [`${ctx.runnerName} walked to ${place} and looked.`];
  if (summary) findings.push(summary);
  findings.push(
    standing.length > 0 ? `Who was there: ${standing.join(", ")}.` : `Nobody was there when ${ctx.runnerName} looked.`,
  );
  return { outcome: "delivered", findings };
}

function resolveFetch(
  task: Extract<ErrandTask, { kind: "fetch" }>,
  ctx: ErrandResolveContext,
  place: string,
): Pick<ErrandReport, "outcome" | "findings" | "bought"> {
  const item = resolveItem(ctx.world, task.itemId);
  const itemName = item?.name ?? task.itemId;
  // Only a real vendor standing there can sell it, and only out of live stock — the runner cannot
  // conjure goods any more than the narrator can.
  for (const seller of entitiesAt(ctx.model, ctx.destinationId)) {
    if (seller.kind !== "npc" || !seller.stats?.inventory.includes(task.itemId)) continue;
    const template = templateOf(ctx.world, seller.templateId ?? seller.id);
    if (!template?.vendor) continue;
    const base = item ? itemBaseCostCp(item) : 0;
    if (base <= 0) {
      return {
        outcome: "empty",
        findings: [`${displayName(seller)} at ${place} would not put a price on ${itemName}.`],
      };
    }
    const costCp = Math.max(1, Math.round(base * template.vendor.priceModifier));
    if (costCp > ctx.playerCoins) {
      return {
        outcome: "empty",
        findings: [`${itemName} was there at ${place}, at ${costCp}cp — more than you had sent ${ctx.runnerName} with.`],
      };
    }
    return {
      outcome: "delivered",
      findings: [`${ctx.runnerName} bought ${itemName} at ${place} for ${costCp}cp.`],
      bought: { itemId: task.itemId, costCp },
    };
  }
  return { outcome: "empty", findings: [`No one at ${place} had ${itemName} to sell.`] };
}

/** The first active-case fact this NPC knows that the player does not. */
function unsharedCaseFact(
  ctx: ErrandResolveContext,
  npcId: string,
): { caseId: string; factId: string; text: string } | null {
  for (const caseDef of ctx.campaign.cases) {
    const runtime = caseRuntimeOf(ctx.model.modules, caseDef.id);
    if (runtime.status !== "open") continue;
    const known = new Set(runtime.playerKnown);
    for (const factId of effectiveKnown(caseDef, runtime, npcId)) {
      if (known.has(factId)) continue;
      const text = factTextOf(caseDef, factId);
      if (text) return { caseId: caseDef.id, factId, text };
    }
  }
  return null;
}

function factTextOf(caseDef: Case, factId: string): string | undefined {
  return caseDef.facts.find((f) => f.id === factId)?.text;
}

/**
 * The authored `knowledge[]` line that best answers the topic, by lowercase-token overlap.
 * Deterministic tie-break: first authored wins. A topic that overlaps nothing returns null rather
 * than handing back an unrelated line — an errand that learned nothing must SAY it learned nothing.
 */
export function bestKnowledgeLine(template: NpcTemplate | undefined, topic: string): string | null {
  // Structured entries fold to their statement text; guarded (trust/never/misdirect) entries are
  // excluded by the fold — an errand runner cannot fetch a secret its keeper would not speak.
  const lines = knowledgeStatements(template?.knowledge);
  if (lines.length === 0) return null;
  const wanted = tokens(topic);
  if (wanted.size === 0) return lines[0] ?? null;
  let best: { line: string; score: number } | null = null;
  for (const line of lines) {
    let score = 0;
    for (const t of tokens(line)) if (wanted.has(t)) score++;
    if (score > 0 && (best === null || score > best.score)) best = { line, score };
  }
  return best?.line ?? null;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  );
}

function templateOf(world: World, npcId: string): NpcTemplate | undefined {
  return world.npcs.find((n) => n.id === npcId);
}

function locationName(world: World, locationId: string): string {
  return world.locations.find((l) => l.id === locationId)?.name ?? locationId;
}
