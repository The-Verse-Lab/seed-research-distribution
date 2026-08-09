/**
 * Sightings & learned habits — the pure core of routine learnability.
 *
 * The player LEARNS an NPC's routine by witnessing it: each player turn co-located with a
 * scheduled NPC records one bounded sighting (deduped per (day, phase)); two sightings of the
 * same (phase, location) pair mint a "known habit" the UI may surface. No omniscience — a save
 * shows only what it has witnessed. The slice lives under `WorldModel.modules.sightings`,
 * written only through the reducer's `modulePatch` by the routines tick module.
 *
 * `whereaboutsLines` is the other direction: the TRUE routine of an asked-about NPC, rendered
 * as facts for a replier who would plausibly know them (same home region, same faction, or any
 * standing relationship) — gossip as a second way to learn habits. Deterministic, no rng.
 *
 * @author Runkai Zhang
 */
import type { NpcTemplate } from "../content/schema.ts";
import { nameMentionedIn } from "./name-match.ts";
import { DAY_PHASES, type RoutineOverride } from "./routine.ts";

export interface Sighting {
  day: number;
  phase: string;
  locationId: string;
}

/** Persisted sightings runtime (WorldModel.modules.sightings). */
export interface SightingsSlice {
  byNpc: Record<string, Sighting[]>;
}

/** Bounded history per NPC — drop-oldest beyond this. */
export const SIGHTING_CAP = 30;
/** Sightings of the same (phase, location) pair needed before it reads as a known habit. */
export const HABIT_THRESHOLD = 2;

/** Defaulting COPY-reader (readRoutinesSlice idiom) — never materializes the slice. */
export function readSightingsSlice(modules: Record<string, unknown> | undefined): SightingsSlice {
  const slice = modules?.sightings as Partial<SightingsSlice> | undefined;
  return { byNpc: structuredClone(slice?.byNpc ?? {}) };
}

/**
 * Record one sighting: deduped per (day, phase) — lingering through a phase is ONE observation —
 * and bounded drop-oldest. Returns the (possibly new) list plus whether anything changed.
 */
export function recordSighting(
  list: Sighting[],
  sighting: Sighting,
  cap: number = SIGHTING_CAP,
): { list: Sighting[]; changed: boolean } {
  if (list.some((s) => s.day === sighting.day && s.phase === sighting.phase)) {
    return { list, changed: false };
  }
  const next = [...list, sighting];
  while (next.length > cap) next.shift();
  return { list: next, changed: true };
}

/**
 * The best-established (phase, location) habit: highest sighting count at or above the
 * threshold. Deterministic tie-break: day-phase order, then locationId lexicographic.
 */
export function habitOf(list: Sighting[]): { phase: string; locationId: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const s of list) {
    const key = `${s.phase}|${s.locationId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: { phase: string; locationId: string; count: number } | null = null;
  for (const [key, count] of counts) {
    if (count < HABIT_THRESHOLD) continue;
    const [phase, locationId] = key.split("|") as [string, string];
    if (
      best === null ||
      count > best.count ||
      (count === best.count &&
        (phaseRank(phase) < phaseRank(best.phase) ||
          (phaseRank(phase) === phaseRank(best.phase) && locationId < best.locationId)))
    ) {
      best = { phase, locationId, count };
    }
  }
  return best;
}

function phaseRank(phase: string): number {
  const i = DAY_PHASES.indexOf(phase as (typeof DAY_PHASES)[number]);
  return i === -1 ? DAY_PHASES.length : i;
}

/** The player-facing habit line — "usually at The Stone Cup in the morning". */
export function renderHabitLine(
  habit: { phase: string; locationId: string },
  locName: (id: string) => string,
): string {
  return `usually at ${locName(habit.locationId)} in the ${habit.phase}`;
}

/**
 * Whether the player's line names this NPC. Delegates to the shared distinctive-token binder
 * (`src/rules/name-match.ts`) on a PLAYER surface — casing carries no signal here and plenty of
 * players type "where can i find oda".
 *
 * The hand-rolled matcher this replaces was wrong in BOTH directions on the shipped roster:
 *   - false POSITIVE: it took the first whitespace token of the name, so "I hitch the dray and load
 *     the crates" recorded a sighting of the quartermaster named "Dray". (The binder now treats
 *     "dray" as an ordinary English word, so it may only bind capitalized.)
 *   - false NEGATIVE: it located the needle with `indexOf`, which stops at the FIRST substring hit.
 *     "The pagoda burned; Oda said so." found the "oda" inside "pagoda", saw it was not
 *     word-bounded, and reported that "Oda the Wayfarer" was never named at all.
 *
 * `surface` defaults to `uncased`, which is what EVERY narrative-action caller must keep: the
 * errand-subject pool (`src/engine/engine.ts`) and the absent-addressee line both read arbitrary
 * player text, so "I hitch the dray and load the crates" has to keep naming nobody. The one caller
 * that may pass `player-query` is the `# KNOWN WHEREABOUTS` lookup, and only on a turn the
 * classifier itself scored as a whereabouts ASK — see `whereaboutsFor` in `src/modules/dialogue.ts`.
 */
export function nameMentioned(
  line: string,
  name: string,
  surface: "uncased" | "player-query" = "uncased",
): boolean {
  return nameMentionedIn(line, name, { surface });
}

/**
 * The TRUE routine of an asked-about NPC as brief facts: the modal (max-weight, first-authored on
 * ties, day-agnostic) slot per phase, consecutive phases sharing a location merged into ranges,
 * plus a "Lately" line while an override pins them elsewhere. Empty when there is nothing to say.
 */
export function whereaboutsLines(
  target: Pick<NpcTemplate, "name" | "schedule">,
  override: RoutineOverride | undefined,
  locName: (id: string) => string,
): string[] {
  const schedule = target.schedule;
  if (!schedule) return [];
  const perPhase = DAY_PHASES.map((phase) => {
    let best: { locationId: string; activity: string; weight: number } | null = null;
    for (const slot of schedule.slots) {
      if (!slot.phases.includes(phase)) continue;
      if (best === null || slot.weight > best.weight) {
        best = { locationId: slot.locationId, activity: slot.activity, weight: slot.weight };
      }
    }
    return best ? { phase, ...best } : null;
  });

  const segments: string[] = [];
  for (let i = 0; i < perPhase.length; i++) {
    const cur = perPhase[i];
    if (!cur) continue;
    let end = i;
    while (end + 1 < perPhase.length && perPhase[end + 1]?.locationId === cur.locationId) end++;
    const range = end === i ? cur.phase : `${cur.phase}–${perPhase[end]!.phase}`;
    segments.push(`${range} at ${locName(cur.locationId)}${cur.activity ? ` (${cur.activity})` : ""}`);
    i = end;
  }
  if (segments.length === 0 && schedule.defaultLocationId) {
    segments.push(`keeps to ${locName(schedule.defaultLocationId)}`);
  }

  const lines: string[] = [];
  if (segments.length > 0) lines.push(`- ${target.name}: ${segments.join("; ")}.`);
  if (override) {
    lines.push(
      `- Lately: keeps to ${locName(override.locationId)}${override.activity ? ` (${override.activity})` : ""}.`,
    );
  }
  return lines;
}

/**
 * Would this replier plausibly know the target's routine? Same home region (the location whose
 * roster lists them), same faction, or ANY standing relationship score. Code-owned — the model
 * only phrases what it is given.
 */
export function replierKnowsTarget(
  replier: Pick<NpcTemplate, "id" | "factionId"> | undefined,
  target: Pick<NpcTemplate, "id" | "factionId">,
  regionOf: (locId: string | undefined) => string | undefined,
  homeLocOf: (npcId: string) => string | undefined,
  relationship: number | undefined,
): boolean {
  if (!replier) return false;
  if (replier.factionId && replier.factionId === target.factionId) return true;
  if (relationship !== undefined && relationship !== 0) return true;
  const replierRegion = regionOf(homeLocOf(replier.id));
  const targetRegion = regionOf(homeLocOf(target.id));
  return replierRegion !== undefined && replierRegion === targetRegion;
}
