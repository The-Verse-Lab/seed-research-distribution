/**
 * WorldMap — the first-class spatial model.
 *
 * Replaces the bare `connections: Id[]` directed graph with `Exit` objects that can carry
 * direction, locks, hidden state, and (later) conditions. Phase 1 populates only `to`
 * (built from legacy connections); Phase 3 lands the authored `Exit` schema + loader
 * normalization and generate-then-freeze map generation. The reducer validates movement
 * against this map, so the model is self-contained — no content lookups inside mutation.
 *
 * @author Runkai Zhang
 */
import type { Exit, World } from "../content/schema.ts";

export type { Exit };

export interface WorldMap {
  /** locationId → exits leading out of it. */
  exits: Map<string, Exit[]>;
}

/** Exits leading out of a location (empty if unknown). */
export function exitsFrom(map: WorldMap, locId: string): Exit[] {
  return map.exits.get(locId) ?? [];
}

/** Whether `to` is reachable from `from` via an unlocked exit. */
export function canReach(map: WorldMap, from: string, to: string): boolean {
  return exitsFrom(map, from).some((e) => e.to === to && !e.locked);
}

/** Normalize legacy connections into first-class exits (directed, all unlocked/visible). */
export function exitsFromConnections(connections: string[]): Exit[] {
  return connections.map((to) => ({ to, locked: false, hidden: false }));
}

/** Build the world map from authored `exits`, falling back to legacy `connections`. */
export function mapFromWorld(world: World): WorldMap {
  const exits = new Map<string, Exit[]>();
  for (const loc of world.locations) {
    exits.set(loc.id, loc.exits.length > 0 ? loc.exits : exitsFromConnections(loc.connections));
  }
  return { exits };
}
