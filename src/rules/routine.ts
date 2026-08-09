/**
 * NPC routine mechanics — the pure, deterministic core of the daily/weekly schedule system.
 *
 * Mirrors `src/rules/travel-events.ts`: every stochastic decision draws from a PRIVATE id-keyed
 * rng via the shared keyed helpers, never the tick stream, so reconciling routines consumes ZERO
 * draws from `ctx.services.rng` and can never shift another seeded mechanic. Same
 * (npc, day, phase) ⇒ same slot pick, for the whole phase and on every replay.
 *
 * The slice lives under `WorldModel.modules.routines` (never `Entity.flags` — statted NPCs drop
 * their flags on the save/reload round-trip) and is written only through the reducer's
 * `modulePatch` by the routines tick module.
 *
 * @author Runkai Zhang
 */
import {
  DayPhaseSchema,
  type Condition,
  type DayPhase,
  type NpcSchedule,
  type NpcTemplate,
  type ScheduleSlot,
  type World,
} from "../content/schema.ts";
import { fnv1a, mulberry32 } from "./dice.ts";
import { keyedFireCheck, keyedWeightedPick } from "./travel-events.ts";

/** The six day phases, in day order — locked to `dayPhaseOf` outputs (pinned by test). */
export const DAY_PHASES: readonly DayPhase[] = DayPhaseSchema.options;

/**
 * Coarse in-world time from the campaign clock (minutes; day = 1440). Six phases, dawn at 05:00.
 * Rendered as a `Time:` line in the brief's `# LOCATION` block so the narrator (and NPC prompts
 * downstream) keep day and night straight — rest advances the clock a full night, so time moves.
 *
 * Lives in this leaf rather than the brief builder because `DAY_PHASES` (right above) is locked to
 * its outputs, and because rules modules need it without importing the agent layer.
 */
export function dayPhaseOf(clock: number): string {
  const minute = ((clock % 1440) + 1440) % 1440;
  if (minute < 300) return "deep night";
  if (minute < 420) return "dawn";
  if (minute < 720) return "morning";
  if (minute < 1020) return "afternoon";
  if (minute < 1200) return "dusk";
  return "night";
}

/** Campaign day index (0-based) of a clock reading in minutes. */
export function dayOf(clock: number): number {
  return Math.floor(clock / 1440);
}

/** The reconcile cursor key for one (day, phase) — "12:morning". */
export function phaseKeyOf(day: number, phase: DayPhase): string {
  return `${day}:${phase}`;
}

/** A standing routine override (an event pinned the NPC somewhere) — active while day < untilDay. */
export interface RoutineOverride {
  locationId: string;
  activity?: string;
  untilDay: number;
}

/** Persisted routines runtime (WorldModel.modules.routines). */
export interface RoutinesSlice {
  /** Day of the last reconcile pass; null ⇒ never ran (first-boot seed sentinel). */
  lastDay: number | null;
  /** Phase of the last reconcile pass. */
  lastPhase: string | null;
  /** npcId → phaseKey last reconciled to (skip guard; lets the Director win mid-phase). */
  applied: Record<string, string>;
  /** npcId → current routine activity ("tending the bar"); absent when idle/unscheduled. */
  activity: Record<string, string>;
  /** npcId → their active slot is a social venue (rumor delivery reads this). */
  venues: Record<string, true>;
  /** npcId → standing override (event-pinned relocation). */
  overrides: Record<string, RoutineOverride>;
}

export function defaultRoutinesSlice(): RoutinesSlice {
  return { lastDay: null, lastPhase: null, applied: {}, activity: {}, venues: {}, overrides: {} };
}

/**
 * Defaulting COPY-reader for the routines slice (the `readCampSlice` idiom). Never stores the
 * default back on the model — a schedule-less world's snapshot must stay byte-identical.
 */
export function readRoutinesSlice(modules: Record<string, unknown> | undefined): RoutinesSlice {
  const slice = modules?.routines as Partial<RoutinesSlice> | undefined;
  return {
    lastDay: slice?.lastDay ?? null,
    lastPhase: slice?.lastPhase ?? null,
    applied: { ...(slice?.applied ?? {}) },
    activity: { ...(slice?.activity ?? {}) },
    venues: { ...(slice?.venues ?? {}) },
    overrides: structuredClone(slice?.overrides ?? {}),
  };
}

/** Slots applying to (day, phase) whose conditions all hold, in stable authored order. */
export function eligibleSlots(
  schedule: NpcSchedule,
  day: number,
  phase: DayPhase,
  condsHold: (conditions: Condition[]) => boolean,
): Array<{ slot: ScheduleSlot; index: number }> {
  const weekday = ((day % 7) + 7) % 7;
  const out: Array<{ slot: ScheduleSlot; index: number }> = [];
  schedule.slots.forEach((slot, index) => {
    if (!slot.phases.includes(phase)) return;
    if (slot.days && !slot.days.includes(weekday)) return;
    if (slot.conditions.length > 0 && !condsHold(slot.conditions)) return;
    out.push({ slot, index });
  });
  return out;
}

/** Where a scheduled NPC should be this phase. `locationId: null` ⇒ hold position (no move). */
export interface RoutineTarget {
  locationId: string | null;
  activity: string;
  venue: boolean;
  source: "override" | "hold" | "slot" | "default";
}

/**
 * Resolve one NPC's routine target for (day, phase). Precedence: an active override pins the NPC
 * outright; then the variance roll may hold them where they stand ("running late" texture); then
 * the keyed weighted pick over eligible slots; then the schedule default; else hold. The pick is
 * keyed on (npc, day, phase), so it cannot flicker within a phase and replays identically.
 */
export function resolveRoutineTarget(
  npcId: string,
  schedule: NpcSchedule,
  day: number,
  phase: DayPhase,
  override: RoutineOverride | undefined,
  condsHold: (conditions: Condition[]) => boolean,
): RoutineTarget {
  if (override && day < override.untilDay) {
    return { locationId: override.locationId, activity: override.activity ?? "", venue: false, source: "override" };
  }
  if (keyedFireCheck(schedule.variance, `routine-var:${npcId}:${day}:${phase}`)) {
    return { locationId: null, activity: "", venue: false, source: "hold" };
  }
  const eligible = eligibleSlots(schedule, day, phase, condsHold);
  if (eligible.length > 0) {
    const pickedId = keyedWeightedPick(
      eligible.map((e) => ({ id: String(e.index), weight: e.slot.weight })),
      `routine-slot:${npcId}:${day}:${phase}`,
    );
    const picked = eligible.find((e) => String(e.index) === pickedId) ?? eligible[0]!;
    const slot = picked.slot;
    return { locationId: slot.locationId, activity: slot.activity, venue: slot.venue, source: "slot" };
  }
  if (schedule.defaultLocationId) {
    return {
      locationId: schedule.defaultLocationId,
      activity: schedule.defaultActivity ?? "",
      venue: false,
      source: "default",
    };
  }
  return { locationId: null, activity: "", venue: false, source: "hold" };
}

/** Location names/descriptions that read as social houses (derived evening haunts). */
const SOCIAL_VENUE_PATTERN = /\b(inn|tavern|alehouse|taproom|way-?house|public house|common room|market|bazaar|square|plaza|feast-?hall|meadhall|mead-?hall)\b/i;

/**
 * Derive a conservative 2-anchor routine for an unscheduled NPC (world `seededRoutines` opt-in):
 * dawn→afternoon at its roster location (the authored anchor — quest flows never miss it), dusk
 * at a same-region social venue picked by a PRIVATE id-keyed rng (same NPC ⇒ same haunt,
 * forever), night/deep-night back home. No venue candidate ⇒ evenings at home too. Variance 0
 * and `venue: false` throughout — derived life stays predictable and never mints rumor stops.
 * Runtime-only data: callers must never write the result into content. Returns undefined for an
 * NPC with no roster location (nothing to anchor to).
 */
export function deriveSchedule(npc: Pick<NpcTemplate, "id" | "socialRole" | "vendor">, world: World): NpcSchedule | undefined {
  const home = world.locations.find((l) => l.npcs.includes(npc.id));
  if (!home) return undefined;
  const dayActivity = npc.vendor
    ? "minding the stall"
    : (npc.socialRole ?? "").trim() || "going about the day's work";

  const candidates = world.locations.filter(
    (l) =>
      l.id !== home.id &&
      l.region !== undefined &&
      l.region === home.region &&
      SOCIAL_VENUE_PATTERN.test(`${l.name} ${l.description}`),
  );
  // One clamped draw from a private id-keyed rng (the worldsmith seeded idiom) — zero shared draws.
  const rng = mulberry32(fnv1a(`sched:${npc.id}`));
  const haunt = candidates.length > 0 ? candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))]! : undefined;

  const slots: ScheduleSlot[] = [
    { phases: ["dawn", "morning", "afternoon"], locationId: home.id, activity: dayActivity, weight: 1, conditions: [], venue: false },
    ...(haunt
      ? [{ phases: ["dusk" as DayPhase], locationId: haunt.id, activity: `passing the evening at ${haunt.name}`, weight: 1, conditions: [], venue: false }]
      : []),
    { phases: ["night", "deep night"], locationId: home.id, activity: "settled in for the night", weight: 1, conditions: [], venue: false },
  ];
  return { slots, variance: 0, defaultLocationId: home.id, defaultActivity: dayActivity };
}

/**
 * The schedule that governs this NPC: the authored one, else (when the world opts into
 * `seededRoutines`) the derived fallback, else none. The single accessor every consumer
 * (routines module, npc-events, whereabouts) reads — authored content always wins.
 */
export function effectiveScheduleOf(npc: NpcTemplate, world: World): NpcSchedule | undefined {
  if (npc.schedule) return npc.schedule;
  if (world.seededRoutines !== true) return undefined;
  return deriveSchedule(npc, world);
}

/** Deterministic departure beat, shown only when the player shares the NPC's location. */
export function departBeat(name: string, destName: string, activity: string): string {
  return `${name} sets off toward ${destName}${activity ? ` — ${activity}` : ""}.`;
}

/** Deterministic arrival beat, shown only when the NPC arrives where the player stands. */
export function arriveBeat(name: string, activity: string): string {
  return `${name} arrives${activity ? ` — ${activity}` : ""}.`;
}
