/**
 * Map view — the TRUTHFUL, richer read-side of the spatial map (map system, revisit wave).
 *
 * Where `roads.ts` lays a synthetic tree over town coordinates, this module derives the map from the
 * ACTUAL exit graph: which discovered locations are really connected, which of those edges lie on a
 * major route between towns, plus the region + realized-point-of-interest metadata the UI paints.
 * Everything here is PURE and derived — recomputed each push from `world.locations` + the expansion
 * slice, nothing mutates or persists. Colors are computed here (id-keyed, deterministic) so the
 * client stays a dumb renderer.
 *
 * @author Runkai Zhang
 */
import type { PlaySet, World } from "../content/schema.ts";
import { fnv1a } from "../rules/dice.ts";
import { isFrontierId, knownGazetteerIdsOf, visitedFlag, type ExpansionSlice } from "./expansion.ts";
import { UNREGIONED_ID } from "./gridmap.ts";
import { spanningTree, townNodes } from "./roads.ts";

/** Display metadata for one region — derived from its id, sent over the wire so the client is dumb. */
export interface RegionMeta {
  id: string;
  name: string;
  /** An `hsl(...)` string, stable per id. */
  color: string;
}

/** The subset of state the derivations read (structural — callers pass GameState). */
interface MapState {
  modules?: Record<string, unknown>;
  flags?: Record<string, unknown>;
  partyLocationId?: string | null;
}

/** Ids of every located (discovered / placed) location — those carrying a real coordinate. */
function locatedIds(world: World): Set<string> {
  const ids = new Set<string>();
  for (const l of world.locations) if (l.x !== undefined && l.y !== undefined) ids.add(l.id);
  return ids;
}

/**
 * The fog-of-war reveal set: every located location the map should draw. A location is EXPLORED
 * (`exploredLocationIds`) when the party has stood in it — the durable `visited:<id>` world flag
 * the reducer sets on move, plus the current party location (belt-and-suspenders, covers a start
 * room never left). This function widens that by one hop: each explored room's non-frontier,
 * located exit neighbors are GLIMPSED (drawn dim), so an exit always has a visible destination on
 * the map. Everything beyond stays hidden until walked toward. Pure — recomputed each push.
 */
export function exploredLocationIds(world: World, state: MapState): Set<string> {
  const located = locatedIds(world);
  const out = new Set<string>();
  for (const id of located) if (state.flags?.[visitedFlag(id)] === true) out.add(id);
  const here = state.partyLocationId;
  if (here && located.has(here)) out.add(here);
  return out;
}

/** The full reveal set — explored rooms plus a one-hop glimpse of their located exit neighbors.
 *  The glimpse is UNDIRECTED (over the same adjacency `discoveredEdges` draws): a room adjacent to
 *  an explored one is revealed even when only the FAR room carries the exit (a one-way generated
 *  edge into the hub), so the map graph stays consistent with the edges it ships. */
export function revealedLocationIds(world: World, state: MapState): Set<string> {
  const explored = exploredLocationIds(world, state);
  const revealed = new Set(explored);
  for (const [a, b] of discoveredEdges(world)) {
    if (explored.has(a)) revealed.add(b);
    if (explored.has(b)) revealed.add(a);
  }
  return revealed;
}

/** A stable undirected key for an edge (order-independent), so a↔b is emitted once. */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * The REAL connectivity network: every undirected pair of discovered locations joined by a
 * non-frontier exit, deduped. This is the base map network — the thing the old road tree never drew,
 * so rooms stopped looking like scattered dots. Directed exits fold to one line (a map edge is
 * traversable-ish; the engine still validates each actual move).
 */
export function discoveredEdges(world: World, revealed?: ReadonlySet<string>): [string, string][] {
  const located = locatedIds(world);
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const loc of world.locations) {
    if (!located.has(loc.id)) continue;
    // Fog-of-war: when a reveal set is passed, emit an edge only if BOTH endpoints are revealed —
    // the client drops any edge whose endpoint isn't a present node, so this keeps that invariant.
    if (revealed && !revealed.has(loc.id)) continue;
    for (const ex of loc.exits) {
      // A HIDDEN exit is undiscovered — never draw its edge (it would reveal + place the secret room
      // on the map before the player finds the passage, and the room stays non-clickable since it's
      // not a listed exit). The classifier/player exit surfaces filter hidden the same way (audit #16).
      if (ex.hidden || isFrontierId(ex.to) || !located.has(ex.to) || ex.to === loc.id) continue;
      if (revealed && !revealed.has(ex.to)) continue;
      const k = edgeKey(loc.id, ex.to);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([loc.id, ex.to]);
    }
  }
  return out;
}

/** Undirected adjacency over a list of edges — for BFS pathing. */
function adjacencyOf(edges: [string, string][]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const list = adj.get(a) ?? [];
    list.push(b);
    adj.set(a, list);
  };
  for (const [a, b] of edges) {
    link(a, b);
    link(b, a);
  }
  return adj;
}

/** Shortest node path from `from` to `to` over the adjacency (inclusive), or null if unreachable. */
function bfsPath(adj: Map<string, string[]>, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string>();
  const queue = [from];
  const seen = new Set<string>([from]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nxt of adj.get(cur) ?? []) {
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      prev.set(nxt, cur);
      if (nxt === to) {
        const path = [to];
        let step = to;
        while (prev.has(step)) {
          step = prev.get(step)!;
          path.unshift(step);
        }
        return path;
      }
      queue.push(nxt);
    }
  }
  return null;
}

/**
 * The MAJOR routes — the subset of real edges that lie on an actual path between towns. For each
 * town pair the stable spanning tree connects (`roads.ts`), we walk the real exit graph and collect
 * the edges of the shortest path through it. So a "road" now follows the true room chain between two
 * settlements instead of cutting a straight coordinate line through the map. Deduped. Empty when
 * there are <2 discovered towns or the towns aren't connected in the discovered graph yet.
 */
export function majorRouteEdges(
  playset: PlaySet,
  state: MapState,
  revealed?: ReadonlySet<string>,
): [string, string][] {
  const towns = townNodes(playset, state);
  if (towns.length < 2) return [];
  // Path over the FULL real graph (a route may cross rooms the party hasn't reached), then keep
  // only the revealed segments — a partial road renders as the stretch the player has uncovered.
  const edges = discoveredEdges(playset.world);
  const adj = adjacencyOf(edges);
  const tree = spanningTree(towns);
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const [a, b] of tree) {
    const path = bfsPath(adj, a, b);
    if (!path) continue;
    for (let i = 1; i < path.length; i++) {
      const u = path[i - 1]!;
      const v = path[i]!;
      if (revealed && (!revealed.has(u) || !revealed.has(v))) continue;
      const k = edgeKey(u, v);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([u, v]);
    }
  }
  return out;
}

/**
 * Every discovered location's realized point-of-interest KIND, keyed by location id. Covers the full
 * gazetteer range (town/city/ruin/wilds/poi — not just settlements) plus minted emergent towns, so a
 * discovered ruin or shrine can render with its own icon instead of a bare room dot. Only entries the
 * party has actually reached (`knownGazetteerIdsOf`) count, matching every other player-facing surface.
 */
export function realizedKindMap(playset: PlaySet, state: MapState): Map<string, string> {
  const out = new Map<string, string>();
  const known = knownGazetteerIdsOf(state);
  const gaz = new Map((playset.world.gazetteer ?? []).map((g) => [g.id, g] as const));
  const slice = state.modules?.expansion as ExpansionSlice | undefined;
  for (const pocket of Object.values(slice?.pockets ?? {})) {
    if (pocket.realizedGazetteerId && known.has(pocket.realizedGazetteerId)) {
      const entry = gaz.get(pocket.realizedGazetteerId);
      const termId = pocket.locations[pocket.locations.length - 1]?.id;
      if (entry && termId) out.set(termId, entry.kind);
    }
    if (pocket.emergentTown) out.set(pocket.emergentTown.id, pocket.emergentTown.kind);
  }
  return out;
}

/** Title-case a kebab/space id for display: "grain-coast" → "Grain Coast". */
function titleCase(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** A muted, parchment-friendly color for a region id — deterministic (id-keyed hue, fixed s/l). */
export function regionColor(id: string): string {
  const hue = fnv1a(`region:${id}`) % 360;
  return `hsl(${hue}, 42%, 52%)`;
}

/** Display metadata for a region id: title-cased name + a stable derived color. */
export function regionMeta(id: string): RegionMeta {
  return { id, name: titleCase(id), color: regionColor(id) };
}

/**
 * The regions present on the discovered map — one `RegionMeta` per distinct region id carried by a
 * located location, in first-seen order. Drives the client's region tint + legend. Empty when no
 * discovered location declares a region.
 */
export function discoveredRegions(world: World, revealed?: ReadonlySet<string>): RegionMeta[] {
  const seen = new Set<string>();
  const out: RegionMeta[] = [];
  for (const l of world.locations) {
    if (l.x === undefined || l.y === undefined) continue;
    // Fog-of-war: a region counts only once some revealed located room in it has been uncovered.
    if (revealed && !revealed.has(l.id)) continue;
    if (!l.region || seen.has(l.region)) continue;
    seen.add(l.region);
    out.push(regionMeta(l.region));
  }
  return out;
}

/**
 * Region-level fog rollup for the world-overview grid (map-grid rework): one entry per region owning
 * a REVEALED location, flagged `explored` once any member has actually been walked in (vs only
 * glimpsed). One level up from `discoveredRegions`' per-location semantics; region-less locations
 * roll up under `UNREGIONED_ID`. Pure — the caller passes the same reveal/explored sets it fog-filters
 * everything else with, so `mapview` stays the single fog source of truth.
 */
export function regionFogState(
  world: World,
  revealed: ReadonlySet<string>,
  explored: ReadonlySet<string>,
): Map<string, { explored: boolean }> {
  const out = new Map<string, { explored: boolean }>();
  for (const l of world.locations) {
    if (!revealed.has(l.id)) continue;
    const region = l.region ?? UNREGIONED_ID;
    const cur = out.get(region) ?? { explored: false };
    if (explored.has(l.id)) cur.explored = true;
    out.set(region, cur);
  }
  return out;
}
