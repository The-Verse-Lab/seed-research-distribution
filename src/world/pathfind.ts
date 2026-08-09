/**
 * Pathfinding over the live directed map — "how would the party actually WALK to a place they
 * already know?".
 *
 * Powers known-roads travel (open-world reach to a VISITED location): instead of minting a
 * minutes-less wormhole exit straight to the destination — the 2026-07-25 playtest's free-travel
 * exploit, where a road authored as an 8.3-hour march re-ran for a flat 30 minutes forever —
 * the engine now routes along EXISTING exits, prices the summed authored minutes, and moves the
 * party leg by leg through the reducer (each leg a real, validated traversal).
 *
 * Read-only by design: nothing here mutates the model, mints exits, or touches the overlay.
 * Deterministic: Dijkstra with a stable tie-break (lower cost, then lexicographic node id), so
 * the same map always yields the same route — tests and replays agree.
 *
 * @author Runkai Zhang
 */
import { isPassable } from "../rules/exit-state.ts";
import { exitsFrom } from "./map.ts";
import { isFrontierId } from "./expansion.ts";
import type { WorldModel } from "./model.ts";
import { effectiveExitState } from "./traversal.ts";
import type { ExitRuntimeState } from "../rules/exit-state.ts";

/** One walkable step of a route: a directed edge and what its crossing costs in minutes. */
export interface RouteLeg {
  from: string;
  to: string;
  minutes: number;
}

/** A full route between two known locations, cheapest-first deterministic. */
export interface Route {
  legs: RouteLeg[];
  totalMinutes: number;
}

interface FindRouteOpts {
  /** Cost of an exit that declares no `minutes` (callers pass the movement cost-table row). */
  defaultLegMinutes?: number;
}

const FALLBACK_LEG_MINUTES = 30;

/**
 * Cheapest route `from` → `to` along the live map, traversing only exits a body could actually
 * take right now: visible (`!hidden`), leading somewhere real (never a latent `frontier:` edge),
 * and passable under the runtime exit-state overlay. Returns null when no such route exists.
 */
export function findRoute(model: WorldModel, from: string, to: string, opts?: FindRouteOpts): Route | null {
  return dijkstra(model, from, to, opts?.defaultLegMinutes ?? FALLBACK_LEG_MINUTES, true);
}

/**
 * The first NON-passable edge on the route the party WOULD take if barriers didn't stop them —
 * so a refusal can name the actual obstacle ("the way through X toward Y is barred") instead of
 * a flat "no road". Null when even the barrier-blind graph has no route (the place is genuinely
 * unconnected from here).
 */
export function firstBarredLeg(
  model: WorldModel,
  from: string,
  to: string,
  opts?: FindRouteOpts,
): { from: string; to: string; state: ExitRuntimeState } | null {
  const blind = dijkstra(model, from, to, opts?.defaultLegMinutes ?? FALLBACK_LEG_MINUTES, false);
  if (!blind) return null;
  for (const leg of blind.legs) {
    for (const exit of exitsFrom(model.map, leg.from)) {
      if (exit.to !== leg.to || exit.hidden) continue;
      const state = effectiveExitState(model, leg.from, exit);
      if (!isPassable(state)) return { from: leg.from, to: leg.to, state };
      break;
    }
  }
  return null;
}

function dijkstra(
  model: WorldModel,
  from: string,
  to: string,
  defaultLegMinutes: number,
  requirePassable: boolean,
): Route | null {
  if (from === to) return { legs: [], totalMinutes: 0 };
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, RouteLeg>();
  const done = new Set<string>();
  // The map is small (dozens of rooms); a scan-min frontier keeps this dependency-free and the
  // tie-break explicit: lowest cost first, lexicographic id on equal cost.
  const frontier = new Set<string>([from]);
  while (frontier.size > 0) {
    let current: string | undefined;
    let best = Infinity;
    for (const id of frontier) {
      const d = dist.get(id) ?? Infinity;
      if (d < best || (d === best && current !== undefined && id < current)) {
        best = d;
        current = id;
      }
    }
    if (current === undefined) break;
    frontier.delete(current);
    if (current === to) break;
    done.add(current);
    for (const exit of exitsFrom(model.map, current)) {
      if (exit.hidden || isFrontierId(exit.to) || done.has(exit.to)) continue;
      if (requirePassable && !isPassable(effectiveExitState(model, current, exit))) continue;
      const minutes = exit.minutes ?? defaultLegMinutes;
      const next = best + minutes;
      const known = dist.get(exit.to);
      if (known === undefined || next < known) {
        dist.set(exit.to, next);
        prev.set(exit.to, { from: current, to: exit.to, minutes });
        frontier.add(exit.to);
      }
    }
  }
  if (!prev.has(to)) return null;
  const legs: RouteLeg[] = [];
  for (let at = to; at !== from; ) {
    const leg = prev.get(at);
    if (!leg) return null;
    legs.unshift(leg);
    at = leg.from;
  }
  return { legs, totalMinutes: legs.reduce((sum, l) => sum + l.minutes, 0) };
}
