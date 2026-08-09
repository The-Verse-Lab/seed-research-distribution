/**
 * Roads — the read-side network between DISCOVERED towns (map system, Strategy C).
 *
 * Pure and derived: given the discovered town points (start/hub + realized gazetteer settlements +
 * emergent towns, in discovery order) it lays a spanning tree of roads plus a few shortcut loops.
 * Nothing here mutates state or persists — the network is recomputed from coordinates each turn.
 *
 * STABILITY: towns are connected in DISCOVERY ORDER (recovered from the insertion-ordered expansion
 * slice), each to its nearest ALREADY-PLACED town. So a road, once drawn for a town, is fixed the
 * moment that town is discovered and never rewires as the map grows — stable across turns with zero
 * persistence. (For ≤ dozens of towns a complete-graph spanning tree equals the Delaunay MST, so no
 * triangulation dependency is needed.)
 *
 * @author Runkai Zhang
 */
import type { PlaySet } from "../content/schema.ts";
import { gazetteerAnchor, regionCentroid, type Point } from "./coords.ts";
import { type ExpansionSlice, knownGazetteerIdsOf } from "./expansion.ts";

export interface MapNode {
  id: string;
  x: number;
  y: number;
  name: string;
  /** "hub" for the start settlement, else the gazetteer/emergent kind ("town"/"city"/…). */
  kind: string;
}

/** A road connects two town ids. */
export type RoadEdge = [string, string];

/** The subset of GameState the road builder reads (kept structural so callers pass GameState). */
interface RoadState {
  modules?: Record<string, unknown>;
  flags?: Record<string, unknown>;
}

function coordOf(playset: PlaySet, id: string): Point | undefined {
  const loc = playset.world.locations.find((l) => l.id === id);
  if (loc?.x === undefined || loc?.y === undefined) return undefined;
  return { x: loc.x, y: loc.y };
}

/**
 * The DISCOVERED towns, in discovery order: the campaign start/hub first, then — walking the
 * insertion-ordered expansion slice — every realized gazetteer settlement the party has reached and
 * every emergent town that has been minted. Each resolves to the live coordinate on `world.locations`.
 */
export function townNodes(playset: PlaySet, state: RoadState): MapNode[] {
  const world = playset.world;
  const nodes: MapNode[] = [];
  const seen = new Set<string>();
  const add = (n: MapNode | undefined): void => {
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      nodes.push(n);
    }
  };

  const startId = playset.campaign.startingState.locationId;
  const startXY = coordOf(playset, startId);
  const startLoc = world.locations.find((l) => l.id === startId);
  if (startXY && startLoc) add({ id: startId, ...startXY, name: startLoc.name, kind: "hub" });

  const known = knownGazetteerIdsOf(state);
  const gaz = new Map((world.gazetteer ?? []).map((g) => [g.id, g] as const));
  const slice = state.modules?.expansion as ExpansionSlice | undefined;
  for (const pocket of Object.values(slice?.pockets ?? {})) {
    if (pocket.realizedGazetteerId && known.has(pocket.realizedGazetteerId)) {
      const entry = gaz.get(pocket.realizedGazetteerId);
      const termId = pocket.locations[pocket.locations.length - 1]?.id;
      const xy = termId ? coordOf(playset, termId) : undefined;
      if (entry && (entry.kind === "town" || entry.kind === "city") && termId && xy) {
        add({ id: termId, ...xy, name: entry.name, kind: entry.kind });
      }
    }
    if (pocket.emergentTown) {
      const xy = coordOf(playset, pocket.emergentTown.id);
      if (xy) add({ id: pocket.emergentTown.id, ...xy, name: pocket.emergentTown.name, kind: pocket.emergentTown.kind });
    }
  }
  return nodes;
}

/**
 * The RUMORED places not yet discovered — every gazetteer entry the party has not reached, shown at
 * its fixed seeded anchor (relative to the hub) so the map can mark it before arrival. These are
 * markers only; roads connect discovered towns.
 */
export function rumoredNodes(playset: PlaySet, state: RoadState): MapNode[] {
  const known = knownGazetteerIdsOf(state);
  const hub = coordOf(playset, playset.campaign.startingState.locationId) ?? { x: 0, y: 0 };
  const out: MapNode[] = [];
  for (const g of playset.world.gazetteer ?? []) {
    if (known.has(g.id)) continue;
    // Anchor the rumor near its own region (centroid of that territory's located rooms) when it
    // declares one; else fall back to the hub ring. Same resolution the realizing pocket uses.
    const centroid = regionCentroid(playset.world, g.region);
    const a = gazetteerAnchor(g, centroid ?? hub, centroid !== undefined);
    out.push({ id: g.id, x: a.x, y: a.y, name: g.name, kind: g.kind });
  }
  return out;
}

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The stable road spine: connect each town (past the first, in order) to its nearest EARLIER town.
 * Deterministic and monotone — the edge for town i depends only on towns 0..i, so it never changes
 * as later towns are discovered. `n` towns ⇒ `n-1` edges, fully connected. 0/1 town ⇒ no edges.
 */
export function spanningTree(towns: MapNode[]): RoadEdge[] {
  const edges: RoadEdge[] = [];
  for (let i = 1; i < towns.length; i++) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < i; j++) {
      const d = dist(towns[i]!, towns[j]!);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best >= 0) edges.push([towns[best]!.id, towns[i]!.id]);
  }
  return edges;
}

/** Do open segments p1p2 and p3p4 properly cross (shared endpoints are NOT a crossing)? */
function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = o(p3, p4, p1);
  const d2 = o(p3, p4, p2);
  const d3 = o(p1, p2, p3);
  const d4 = o(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * A few shortcut loop edges over the tree — short town pairs that aren't already roads and don't
 * cross an existing road, so the network reads like a road map rather than a bare tree. Bounded to
 * ~n/3 extra edges and deterministic (scanned in index order). Threshold scales with the median tree
 * edge, so it adapts to the map's scale.
 */
export function loopEdges(towns: MapNode[], tree: RoadEdge[]): RoadEdge[] {
  if (towns.length < 4) return [];
  const byId = new Map(towns.map((t) => [t.id, t] as const));
  const all: RoadEdge[] = [...tree];
  const has = (a: string, b: string): boolean => all.some((e) => (e[0] === a && e[1] === b) || (e[0] === b && e[1] === a));
  const lens = tree.map(([a, b]) => dist(byId.get(a)!, byId.get(b)!)).sort((x, y) => x - y);
  const median = lens.length ? lens[Math.floor(lens.length / 2)]! : 0;
  const cap = Math.floor(towns.length / 3);
  const loops: RoadEdge[] = [];
  for (let i = 0; i < towns.length && loops.length < cap; i++) {
    for (let j = i + 1; j < towns.length && loops.length < cap; j++) {
      const a = towns[i]!;
      const b = towns[j]!;
      if (has(a.id, b.id)) continue;
      if (dist(a, b) > median * 1.4) continue;
      // Skip if it crosses any existing edge that doesn't share an endpoint with a/b.
      const crosses = all.some(([u, v]) => {
        if (u === a.id || u === b.id || v === a.id || v === b.id) return false;
        return segmentsCross(a, b, byId.get(u)!, byId.get(v)!);
      });
      if (crosses) continue;
      loops.push([a.id, b.id]);
      all.push([a.id, b.id]);
    }
  }
  return loops;
}

/** The full road network: the stable spanning tree plus a few shortcut loops. */
export function computeRoads(towns: MapNode[]): RoadEdge[] {
  const tree = spanningTree(towns);
  return [...tree, ...loopEdges(towns, tree)];
}
