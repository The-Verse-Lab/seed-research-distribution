/**
 * NPC personal events & rumors — the pure, deterministic core of the per-NPC random-event layer.
 *
 * Mirrors `src/rules/travel-events.ts`: every stochastic decision draws from a PRIVATE keyed rng,
 * never the shared tick stream. One fire roll per (npc, event, day, phase) and one weighted pick
 * per (npc, day, phase) — sitting through a phase can never re-roll, and replays are identical.
 * Cooldowns are DAY-based (the campaign clock), not wall-clock, so they replay exactly.
 *
 * The slice lives under `WorldModel.modules.npcEvents`; rumors are a bounded FIFO of authored
 * narrate texts from offstage (`scope: "anywhere"`) fires, drained one per player turn at a
 * social venue (a present vendor, or a scheduled NPC in a `venue: true` slot).
 *
 * @author Runkai Zhang
 */
import type { Effect, NpcEvent, TriggerPredicate, World } from "../content/schema.ts";
import type { DayPhase } from "../content/schema.ts";
import { keyedFireCheck, keyedWeightedPick } from "./travel-events.ts";

/** One queued offstage narration, day-stamped for flavor ("word from earlier today"). */
export interface Rumor {
  day: number;
  text: string;
}

/** Persisted npc-events runtime (WorldModel.modules.npcEvents). */
export interface NpcEventsSlice {
  /** The (day:phase) key of the last roll pass; null ⇒ never ran (first-boot seed sentinel). */
  lastRolledKey: string | null;
  /** `${npcId}:${eventId}` → day it last fired (cooldownDays clock). */
  lastFiredDay: Record<string, number>;
  /** `${npcId}:${eventId}` keys fired with `once: "campaign"`. */
  firedCampaign: string[];
  /** Bounded offstage-narration queue, oldest first. */
  rumors: Rumor[];
}

/** Rumor queue bound — drop-oldest beyond this. */
export const RUMOR_CAP = 20;

/** Defaulting COPY-reader (readRoutinesSlice idiom) — never materializes the slice. */
export function readNpcEventsSlice(modules: Record<string, unknown> | undefined): NpcEventsSlice {
  const slice = modules?.npcEvents as Partial<NpcEventsSlice> | undefined;
  return {
    lastRolledKey: slice?.lastRolledKey ?? null,
    lastFiredDay: { ...(slice?.lastFiredDay ?? {}) },
    firedCampaign: [...(slice?.firedCampaign ?? [])],
    rumors: structuredClone(slice?.rumors ?? []),
  };
}

/** Append a rumor, bounded FIFO drop-oldest. */
export function pushRumor(rumors: Rumor[], rumor: Rumor, cap: number = RUMOR_CAP): Rumor[] {
  const next = [...rumors, rumor];
  while (next.length > cap) next.shift();
  return next;
}

/** Day-based cooldown: ready when never fired or `cooldownDays` have passed. Replay-exact. */
export function cooledDownByDay(lastDay: number | undefined, cooldownDays: number, today: number): boolean {
  if (lastDay === undefined) return true;
  if (cooldownDays <= 0) return true;
  return today - lastDay >= cooldownDays;
}

/**
 * Whether an effect reaches into the player's turn — forbidden on `"anywhere"` (offstage) events:
 * a check rolls the PC, an ambush opens a fight, and a `giveItem` without an
 * explicit recipient defaults to the player's pack. The loader enforces this at authoring time;
 * the module also skips such effects defensively.
 */
export function isInteractiveEffect(eff: Effect): boolean {
  if (eff.kind === "check" || eff.kind === "ambush") return true;
  // A case reveal hands the player evidence — offstage rumor must never do that (mystery wave).
  if (eff.kind === "revealCaseFact") return true;
  if (eff.kind === "giveItem") return eff.to === undefined;
  return false;
}

/** The bookkeeping key for one event on one NPC (event ids need only be unique per template). */
export function npcEventKey(npcId: string, eventId: string): string {
  return `${npcId}:${eventId}`;
}

/**
 * The events that may fire for this NPC in (day, phase): phase/weekday windows, once/cooldown
 * bookkeeping, co-location for `"co-located"` scope, and the trigger predicate. Stable authored order.
 */
export function eligibleNpcEvents(
  events: NpcEvent[],
  npcId: string,
  day: number,
  phase: DayPhase,
  opts: {
    coLocated: boolean;
    firedCampaign: string[];
    lastFiredDay: Record<string, number>;
    predHolds: (trigger: TriggerPredicate) => boolean;
  },
): NpcEvent[] {
  const weekday = ((day % 7) + 7) % 7;
  return events.filter((ev) => {
    if (ev.phases && !ev.phases.includes(phase)) return false;
    if (ev.days && !ev.days.includes(weekday)) return false;
    if (ev.scope === "co-located" && !opts.coLocated) return false;
    const key = npcEventKey(npcId, ev.id);
    if (ev.once === "campaign" && opts.firedCampaign.includes(key)) return false;
    if (!cooledDownByDay(opts.lastFiredDay[key], ev.cooldownDays, day)) return false;
    return opts.predHolds(ev.trigger);
  });
}

/**
 * Roll this NPC's phase: a keyed fire check per eligible event, then a keyed weighted pick among
 * the firers — at most ONE event per NPC per phase. Zero shared-rng draws; same inputs ⇒ same
 * outcome forever.
 */
export function rollNpcEvent(npcId: string, eligible: NpcEvent[], day: number, phase: DayPhase): NpcEvent | null {
  const firers = eligible.filter((ev) =>
    keyedFireCheck(ev.chance, `npc-event-fire:${npcId}:${ev.id}:${day}:${phase}`),
  );
  if (firers.length === 0) return null;
  const pickedId = keyedWeightedPick(
    firers.map((ev) => ({ id: ev.id, weight: ev.weight })),
    `npc-event-pick:${npcId}:${day}:${phase}`,
  );
  return firers.find((ev) => ev.id === pickedId) ?? firers[0] ?? null;
}

/**
 * Whether the party's location counts as a SOCIAL VENUE for rumor delivery — one code rule:
 * somebody present sells (a vendor template), or a present scheduled NPC's active slot was
 * authored `venue: true` (the routines slice's `venues` record).
 */
export function isSocialVenue(
  present: Array<{ id: string; templateId?: string }>,
  world: World,
  venues: Record<string, true>,
): boolean {
  return present.some((e) => {
    if (venues[e.id]) return true;
    const tpl = world.npcs.find((n) => n.id === (e.templateId ?? e.id));
    return tpl?.vendor !== undefined;
  });
}
