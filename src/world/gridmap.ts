/**
 * Grid map — discrete tile-grid layout, derived PURELY from the exit graph (map-grid rework).
 *
 * Companion to `coords.ts` (which stays, and keeps producing the FLOAT coordinates generation
 * dead-reckoning + rumor bearings need). This module answers a different question: given a region's
 * (or the whole world's) locations, assign each an INTEGER `{col, row}` from CARDINAL exit
 * directions only — BFS from a deterministic anchor, collisions resolved by a deterministic id-keyed
 * spiral. Locations reached only through PORTAL exits (up/down/in/out/through/…) nest as interior
 * sub-grids under the location that portals into them (Lilith's-Throne-style drill-down).
 *
 * The module is FOG-IGNORANT: it lays out every member of a region and lets the caller
 * presentation layers fog-filter the result. Running over the full member set is what keeps a
 * tile's cell STABLE as the player reveals more of a region — the anchor + BFS order never depend on
 * what has been explored.
 *
 * Everything here is PURE and DETERMINISTIC. All randomness is drawn from an id-keyed PRIVATE rng
 * (`idRng` = mulberry32(fnv1a(id)), from coords.ts) so it consumes ZERO draws from any shared seeded
 * stream — the engine's byte-determinism (and every replay test) is untouched.
 *
 * @author Runkai Zhang
 */
import type { Location, World } from "../content/schema.ts";
import { COMPASS_OPPOSITE, bearingName, idRng, normalizeDirection, regionCentroid } from "./coords.ts";
import { isFrontierId } from "./expansion.ts";

/** Bucket every region-less location under one synthetic region so legacy/regionless worlds still
 *  get exactly one region grid (and the world-overview level is skipped). */
export const UNREGIONED_ID = "__unregioned__";

export type CompassWord = "north" | "south" | "east" | "west";

/** One tile in a region's surface grid OR one of its nested interior sub-grids (flat, tagged). */
export interface PlacedCell {
  id: string;
  col: number;
  row: number;
  /** Set on interior members only: the location whose sub-grid this cell lives in. */
  interiorOf?: string;
  /** True ⇒ this cell owns a nested interior sub-grid (a drill affordance). */
  hasInterior: boolean;
}

/** Integer grid step for each compass word (screen convention: north = up = row−1). Diagonals are
 *  placed at a diagonal offset for layout but never draw a street (Manhattan distance ≠ 1). */
const GRID_STEP: Readonly<Record<string, { dc: number; dr: number }>> = {
  north: { dc: 0, dr: -1 },
  south: { dc: 0, dr: 1 },
  east: { dc: 1, dr: 0 },
  west: { dc: -1, dr: 0 },
  northeast: { dc: 1, dr: -1 },
  northwest: { dc: -1, dr: -1 },
  southeast: { dc: 1, dr: 1 },
  southwest: { dc: -1, dr: 1 },
};

const CARDINALS: readonly CompassWord[] = ["north", "south", "east", "west"];

// ---- direction classification (the crux) --------------------------------------------------------

type DirClass =
  | { kind: "planar"; canon: string } // a real compass word (n/s/e/w or a diagonal)
  | { kind: "portal" } // a non-empty NON-compass word (up/down/in/out/through/custom)
  | { kind: "unlabeled" }; // never authored — synthesize a planar bearing

/**
 * Three-way split — the single most important correctness rule in the module. `normalizeDirection`
 * folds BOTH "never authored" and "authored a non-compass word" to "", so we must inspect the RAW
 * value first: an ABSENT direction is unlabeled-planar (still a surface link), whereas a present but
 * non-compass word (`up`, `down`, `in`, `out`, `through`) is a PORTAL that drives interior nesting.
 * Getting this wrong nests every legacy/undirected world (no directions) entirely as "interior".
 */
function classifyDirection(raw: string | undefined | null): DirClass {
  if (raw === undefined || raw === null || raw.trim() === "") return { kind: "unlabeled" };
  const canon = normalizeDirection(raw);
  return canon ? { kind: "planar", canon } : { kind: "portal" };
}

/** The synthetic bearing for an unlabeled edge, keyed on the UNDIRECTED pair so a→b and b→a agree
 *  (b→a is the exact opposite of a→b). Deterministic, zero shared-stream draws. */
function synthDir(a: string, b: string): CompassWord {
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  const base = CARDINALS[Math.floor(idRng(`unlabeled:${key}`)() * CARDINALS.length) % CARDINALS.length]!;
  return a < b ? base : (COMPASS_OPPOSITE[base] as CompassWord);
}

// ---- portal orientation (interior nesting) ------------------------------------------------------

/**
 * Portal polarity — the crux of orienting interior nesting. A reciprocal building link is authored
 * BOTH ways (`outside → foyer` "in", `foyer → outside` "out"). Treating each raw edge as parent→child
 * (the pre-fix behaviour) marks outside a child of foyer AND foyer a child of outside, so a plain
 * multi-room interior with no compass edges leaves NO surface root — an empty `surfaceIds`, which
 * makes `pickAnchor` emit a phantom `{id: undefined}` cell. So we orient every portal edge to ONE
 * parent→child sense before selecting the surface: a DESCENDING word (in/down/…) keeps its authored
 * direction, an ASCENDING word (out/up/…) is the child pointing back at its parent (reversed), and an
 * ambiguous word (through/…) keeps its authored direction (dedup + the empty-surface guard in
 * `layoutRegion` cover a pure ambiguous cycle).
 */
const PORTAL_ASCEND: ReadonlySet<string> = new Set([
  "out", "outside", "up", "above", "over", "exit", "ascend", "upward", "outward",
]);

/** Orient one portal edge `from → to` (raw direction word) to a single parent→child sense. The first
 *  token drives it ("up the stair" → up → ascending), so compound authored phrases still classify. */
function orientPortal(from: string, to: string, raw: string | undefined | null): { parent: string; child: string } {
  const first = (raw ?? "").trim().toLowerCase().split(/[\s-]+/)[0] ?? "";
  if (PORTAL_ASCEND.has(first)) return { parent: to, child: from }; // ascending: the child points home
  return { parent: from, child: to }; // descending or ambiguous: the authored sense is parent→child
}

// ---- planar / portal graph over a member set ----------------------------------------------------

interface ChosenEdge {
  a: string; // lexicographically smaller endpoint
  b: string;
  dir: string; // canonical compass word FROM a TO b
}

interface PlanarGraph {
  /** Undirected planar edges keyed by `min|max` id pair. */
  edges: Map<string, ChosenEdge>;
  /** id → its planar member-neighbors, in authored exit order, deduped. */
  ordered: Map<string, string[]>;
  /** Every id that appears in ≥1 planar edge (a "surface" candidate). */
  surface: Set<string>;
  /** Directed portal edges parent→child among the member set. */
  portal: Array<{ parent: string; child: string }>;
  /** child → parents that portal into it (incoming portal adjacency). */
  incomingPortal: Map<string, string[]>;
}

/** Build the planar + portal graph restricted to `members`. Pure. */
function buildGraph(world: World, members: ReadonlySet<string>): PlanarGraph {
  const byId = new Map(world.locations.map((l) => [l.id, l] as const));
  const edges = new Map<string, ChosenEdge>();
  const ordered = new Map<string, string[]>();
  const surface = new Set<string>();
  const portal: Array<{ parent: string; child: string }> = [];
  const incomingPortal = new Map<string, string[]>();
  const portalSeen = new Set<string>();

  const pushOrdered = (from: string, to: string): void => {
    const list = ordered.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    ordered.set(from, list);
  };

  // Iterate in world.locations order (stable), each loc's exits in authored order.
  for (const loc of world.locations) {
    if (!members.has(loc.id)) continue;
    for (const ex of loc.exits) {
      // Hidden exits are undiscovered — no street is drawn for them (matches the fog reveal set +
      // classifier), so a secret room never gets a connector line before it's found (audit #16).
      if (ex.hidden || isFrontierId(ex.to) || ex.to === loc.id || !members.has(ex.to) || !byId.has(ex.to))
        continue;
      const cls = classifyDirection(ex.direction);
      if (cls.kind === "portal") {
        // Orient by polarity so a reciprocal in/out pair collapses to ONE parent→child edge (and the
        // parent is never falsely recorded as having an incoming portal). Deduped by (parent,child).
        const { parent, child } = orientPortal(loc.id, ex.to, ex.direction);
        const key = `${parent}|${child}`;
        if (!portalSeen.has(key)) {
          portalSeen.add(key);
          portal.push({ parent, child });
          const inc = incomingPortal.get(child) ?? [];
          inc.push(parent);
          incomingPortal.set(child, inc);
        }
        continue;
      }
      // planar or unlabeled → a surface link
      const from = loc.id;
      const to = ex.to;
      surface.add(from);
      surface.add(to);
      // UNDIRECTED adjacency: list the neighbor on BOTH sides so BFS can traverse an edge even when
      // only the FAR room carries the exit (a one-way generated edge into a hub) — otherwise that
      // room would be stranded as a straggler instead of placed adjacent. `dirOf` supplies the sign.
      pushOrdered(from, to);
      pushOrdered(to, from);
      const a = from < to ? from : to;
      const b = from < to ? to : from;
      const key = `${a}|${b}`;
      const existing = edges.get(key);
      const dirAB = cls.kind === "planar" ? (from === a ? cls.canon : (COMPASS_OPPOSITE[cls.canon] ?? cls.canon)) : null;
      if (!existing) {
        edges.set(key, { a, b, dir: dirAB ?? "" });
      } else if (existing.dir === "" && dirAB) {
        existing.dir = dirAB; // first EXPLICIT planar direction wins; fills a prior unlabeled slot
      }
    }
  }
  // Fill any edge still lacking an explicit direction (both sides unlabeled) with a synthetic one.
  for (const e of edges.values()) if (e.dir === "") e.dir = synthDir(e.a, e.b);
  return { edges, ordered, surface, portal, incomingPortal };
}

/** The compass word FROM `from` TO `to` over a chosen planar edge (opposite when reversed). */
function dirOf(graph: PlanarGraph, from: string, to: string): string {
  const key = from < to ? `${from}|${to}` : `${to}|${from}`;
  const e = graph.edges.get(key);
  if (!e) return "";
  return from === e.a ? e.dir : (COMPASS_OPPOSITE[e.dir] ?? e.dir);
}

// ---- deterministic collision spiral -------------------------------------------------------------

/** Cells at Chebyshev distance `radius` from the origin, clockwise from due north — a fixed order. */
function ringOffsets(radius: number): Array<{ dc: number; dr: number }> {
  const out: Array<{ dc: number; dr: number }> = [];
  for (let c = -radius; c <= radius; c++) out.push({ dc: c, dr: -radius }); // top row L→R
  for (let r = -radius + 1; r <= radius; r++) out.push({ dc: radius, dr: r }); // right col T→B
  for (let c = radius - 1; c >= -radius; c--) out.push({ dc: c, dr: radius }); // bottom row R→L
  for (let r = radius - 1; r >= -radius + 1; r--) out.push({ dc: -radius, dr: r }); // left col B→T
  return out;
}

/** Nearest free cell to `(col,row)`: the cell itself if free, else an id-keyed rotated spiral out.
 *  Deterministic; guaranteed to terminate (linear fallback beyond radius 6). */
function resolveCollision(
  col: number,
  row: number,
  occupied: ReadonlySet<string>,
  idKey: string,
): [number, number] {
  if (!occupied.has(`${col},${row}`)) return [col, row];
  const rot = Math.floor(idRng(`gridcollision:${idKey}`)() * 8);
  for (let radius = 1; radius <= 6; radius++) {
    const ring = ringOffsets(radius);
    for (let k = 0; k < ring.length; k++) {
      const off = ring[(k + rot) % ring.length]!;
      const c = col + off.dc;
      const r = row + off.dr;
      if (!occupied.has(`${c},${r}`)) return [c, r];
    }
  }
  let c = col;
  while (occupied.has(`${c},${row}`)) c += 1;
  return [c, row];
}

// ---- generic BFS placement ----------------------------------------------------------------------

/**
 * Place `ids` on an integer grid: BFS from `anchor` over cardinal/diagonal steps (first placement of
 * a node wins — a later edge to an already-placed node bends rather than repositions), then any
 * unreached straggler spirals out from the origin in id order. Pure, deterministic.
 */
function placeSet(ids: ReadonlySet<string>, anchor: string, graph: PlanarGraph): Map<string, { col: number; row: number }> {
  const placed = new Map<string, { col: number; row: number }>();
  const occupied = new Set<string>();
  const put = (id: string, col: number, row: number): void => {
    placed.set(id, { col, row });
    occupied.add(`${col},${row}`);
  };
  put(anchor, 0, 0);
  const queue = [anchor];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const { col, row } = placed.get(cur)!;
    for (const nbr of graph.ordered.get(cur) ?? []) {
      if (!ids.has(nbr) || placed.has(nbr)) continue;
      const step = GRID_STEP[dirOf(graph, cur, nbr)] ?? { dc: 0, dr: 0 };
      const [c, r] = resolveCollision(col + step.dc, row + step.dr, occupied, nbr);
      put(nbr, c, r);
      queue.push(nbr);
    }
  }
  for (const id of [...ids].sort()) {
    if (placed.has(id)) continue;
    const [c, r] = resolveCollision(0, 0, occupied, id);
    put(id, c, r);
  }
  return placed;
}

// ---- public helpers -----------------------------------------------------------------------------

/** The region a location belongs to, or the synthetic unregioned bucket. */
export function effectiveRegionOf(loc: Pick<Location, "region">): string {
  return loc.region ?? UNREGIONED_ID;
}

/** Ids of every location owned by `regionId` (or the unregioned bucket). */
function membersOf(world: World, regionId: string): Set<string> {
  const out = new Set<string>();
  for (const l of world.locations) if (effectiveRegionOf(l) === regionId) out.add(l.id);
  return out;
}

/** Undirected planar edges among `ownerIds` (each with its canonical direction). Test-facing. */
export function cardinalEdges(world: World, ownerIds: ReadonlySet<string>): ChosenEdge[] {
  return [...buildGraph(world, ownerIds).edges.values()];
}

/** True iff `id` has NO planar edge to any other member of `ownerIds` — reachable only via portals. */
export function isInteriorLocation(world: World, id: string, ownerIds: ReadonlySet<string>): boolean {
  return !buildGraph(world, ownerIds).surface.has(id);
}

/** Count exits from `id` that cross into a different region (a gateway-bearing surface member). */
function crossRegionDegree(world: World, id: string): number {
  const byId = new Map(world.locations.map((l) => [l.id, l] as const));
  const loc = byId.get(id);
  if (!loc) return 0;
  const region = effectiveRegionOf(loc);
  let n = 0;
  for (const ex of loc.exits) {
    if (isFrontierId(ex.to)) continue;
    const to = byId.get(ex.to);
    if (to && effectiveRegionOf(to) !== region) n += 1;
  }
  return n;
}

/**
 * Lay out one region on an integer grid: surface members via cardinal BFS + portal-only members
 * nested (recursively) under their portal parent. Runs over ALL members — the caller fog-filters.
 */
export function layoutRegion(world: World, regionId: string, startId: string): PlacedCell[] {
  const members = membersOf(world, regionId);
  if (members.size === 0) return [];
  const graph = buildGraph(world, members);

  // Interior = no planar edge AND has a portal parent among members. A member with neither (a lone
  // room, or a planar island) is a SURFACE straggler, not an interior (no parent to nest under).
  const interiorIds = new Set<string>();
  const surfaceIds = new Set<string>();
  for (const id of members) {
    if (graph.surface.has(id)) surfaceIds.add(id);
    else if ((graph.incomingPortal.get(id)?.length ?? 0) > 0) interiorIds.add(id);
    else surfaceIds.add(id); // straggler → placed on the surface grid
  }

  // Guard: a region whose members are ALL portal-linked with no root (a pure ambiguous-portal cycle,
  // e.g. A→B→C→A all "through") leaves surfaceIds empty — then `pickAnchor` has nothing to anchor and
  // emits a phantom `{id: undefined}` cell. Promote a deterministic root (the campaign start if it's a
  // member here, else the lowest id) to the surface so every non-empty region has ≥1 surface tile.
  if (surfaceIds.size === 0) {
    const root = members.has(startId) ? startId : [...members].sort()[0]!;
    interiorIds.delete(root);
    surfaceIds.add(root);
  }

  // --- anchor: start if in-region, else most cross-region exits, then most cardinal degree, then id.
  const anchor = pickAnchor(world, surfaceIds, graph, startId);
  const surfacePos = placeSet(surfaceIds, anchor, graph);

  // --- interior assignment: BFS out from the surface over portal edges, nearest surface parent wins.
  const parentOf = assignInteriors(interiorIds, surfaceIds, graph);
  const parentsWithInterior = new Set(parentOf.values());

  // Any interior we couldn't attach (a portal cycle with no surface entry) → surface straggler.
  const orphans = [...interiorIds].filter((id) => !parentOf.has(id));
  for (const id of orphans) {
    interiorIds.delete(id);
    surfaceIds.add(id);
  }
  const surfacePos2 = orphans.length > 0 ? placeSet(surfaceIds, anchor, graph) : surfacePos;

  const cells: PlacedCell[] = [];
  for (const [id, p] of surfacePos2) {
    cells.push({ id, col: p.col, row: p.row, hasInterior: parentsWithInterior.has(id) });
  }

  // --- lay out each parent's interior children as their own sub-grid.
  const childrenByParent = new Map<string, Set<string>>();
  for (const [child, parent] of parentOf) {
    const set = childrenByParent.get(parent) ?? new Set<string>();
    set.add(child);
    childrenByParent.set(parent, set);
  }
  for (const [parent, childIds] of [...childrenByParent].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const subGraph = buildGraph(world, childIds);
    const subAnchor = pickInteriorAnchor(childIds, subGraph, parent, world);
    const subPos = placeSet(childIds, subAnchor, subGraph);
    for (const [id, p] of subPos) {
      cells.push({ id, col: p.col, row: p.row, interiorOf: parent, hasInterior: false });
    }
  }
  return cells;
}

/** Deterministic surface anchor: campaign start if it's a surface member here, else the surface
 *  member with the most cross-region exits, then the most cardinal neighbors, then the lowest id. */
function pickAnchor(world: World, surfaceIds: ReadonlySet<string>, graph: PlanarGraph, startId: string): string {
  if (surfaceIds.has(startId)) return startId;
  let best: string | undefined;
  let bestKey: [number, number, string] | undefined;
  for (const id of [...surfaceIds].sort()) {
    const key: [number, number, string] = [crossRegionDegree(world, id), (graph.ordered.get(id) ?? []).length, id];
    if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = id;
      bestKey = key;
    }
  }
  return best ?? [...surfaceIds].sort()[0]!;
}

/** Interior sub-anchor: the unique child that portals directly back to its parent, else lowest id. */
function pickInteriorAnchor(childIds: ReadonlySet<string>, subGraph: PlanarGraph, parent: string, world: World): string {
  const byId = new Map(world.locations.map((l) => [l.id, l] as const));
  const backToParent = [...childIds].filter((id) => {
    const loc = byId.get(id);
    return loc?.exits.some((ex) => ex.to === parent) ?? false;
  });
  if (backToParent.length === 1) return backToParent[0]!;
  // else prefer a planar-connected child (so the sub-BFS has edges to follow), then lowest id.
  const connected = [...childIds].filter((id) => subGraph.surface.has(id)).sort();
  return (connected[0] ?? [...childIds].sort()[0])!;
}

/** Attach each interior to the nearest surface ancestor over portal edges (surface parents first,
 *  id-tie-broken). Returns child→parent; interiors in a portal cycle with no surface entry are left
 *  unassigned (the caller folds them into surface stragglers). */
function assignInteriors(
  interiorIds: ReadonlySet<string>,
  surfaceIds: ReadonlySet<string>,
  graph: PlanarGraph,
): Map<string, string> {
  const parentOf = new Map<string, string>();
  const level = new Map<string, number>();
  for (const id of surfaceIds) level.set(id, 0);
  let changed = true;
  while (changed) {
    changed = false;
    for (const child of [...interiorIds].sort()) {
      if (parentOf.has(child)) continue;
      // Candidate parents: portal sources that already have a level (surface or an assigned interior).
      let bestParent: string | undefined;
      let bestLevel = Infinity;
      for (const p of (graph.incomingPortal.get(child) ?? []).slice().sort()) {
        const lv = level.get(p);
        if (lv === undefined) continue;
        if (lv < bestLevel) {
          bestLevel = lv;
          bestParent = p;
        }
      }
      if (bestParent !== undefined) {
        parentOf.set(child, bestParent);
        level.set(child, bestLevel + 1);
        changed = true;
      }
    }
  }
  return parentOf;
}

// ---- world overview (region blocks) -------------------------------------------------------------

/** Undirected distinct region pairs joined by ≥1 cross-region non-frontier exit. */
export function regionAdjacency(world: World): Array<[string, string]> {
  const byId = new Map(world.locations.map((l) => [l.id, l] as const));
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const loc of world.locations) {
    const ra = effectiveRegionOf(loc);
    for (const ex of loc.exits) {
      if (isFrontierId(ex.to)) continue;
      const to = byId.get(ex.to);
      if (!to) continue;
      const rb = effectiveRegionOf(to);
      if (ra === rb) continue;
      const key = ra < rb ? `${ra}|${rb}` : `${rb}|${ra}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ra < rb ? [ra, rb] : [rb, ra]);
    }
  }
  return out;
}

/** A live cross-region crossing, rendered as a gateway tile on `fromId`'s border. */
export interface Gateway {
  fromId: string;
  toId: string;
  fromRegion: string;
  toRegion: string;
  direction: CompassWord;
}

/** Reduce any compass word (or a centroid bearing) to the nearest of the four cardinals. */
function toCardinal(word: string): CompassWord {
  const step = GRID_STEP[word];
  if (step) {
    // dominant axis wins; tie → east/west (horizontal) for readability
    if (Math.abs(step.dc) >= Math.abs(step.dr)) return step.dc >= 0 ? "east" : "west";
    return step.dr < 0 ? "north" : "south";
  }
  return "east";
}

/** Every cross-region gateway in the world, with a cardinal border direction (a real compass exit
 *  when authored, else a region-centroid bearing fallback). Caller fog-filters. */
export function crossRegionGateways(world: World): Gateway[] {
  const byId = new Map(world.locations.map((l) => [l.id, l] as const));
  const out: Gateway[] = [];
  for (const loc of world.locations) {
    const fromRegion = effectiveRegionOf(loc);
    for (const ex of loc.exits) {
      if (isFrontierId(ex.to)) continue;
      const to = byId.get(ex.to);
      if (!to) continue;
      const toRegion = effectiveRegionOf(to);
      if (fromRegion === toRegion) continue;
      const cls = classifyDirection(ex.direction);
      let dir: CompassWord;
      if (cls.kind === "planar") dir = toCardinal(cls.canon);
      else {
        const from = regionCentroid(world, loc.region);
        const dest = regionCentroid(world, to.region);
        dir = from && dest ? toCardinal(bearingName(from, dest)) : "east";
      }
      out.push({ fromId: loc.id, toId: to.id, fromRegion, toRegion, direction: dir });
    }
  }
  return out;
}

/** Coarse region-block grid for the world overview: BFS over the region graph (cross-region compass
 *  exits) from the start's region, centroid-bearing fallback for regions with no compass link.
 *  Returns [] when the world has ≤1 region (the caller skips the overview level). Pure. */
export function layoutOverview(world: World, startId: string): Array<{ id: string; col: number; row: number }> {
  const regions = new Set<string>();
  for (const l of world.locations) regions.add(effectiveRegionOf(l));
  if (regions.size <= 1) return [];

  const byId = new Map(world.locations.map((l) => [l.id, l] as const));
  const startRegion = effectiveRegionOf(byId.get(startId) ?? world.locations[0]!);

  // Region graph: directed compass edges regionA→regionB (unlabeled/portal cross-links contribute
  // nothing — a wrong whole-region guess is worse than a centroid fallback), ordered stably.
  const ordered = new Map<string, Array<{ to: string; dir: CompassWord }>>();
  const seenPair = new Set<string>();
  for (const loc of world.locations) {
    const ra = effectiveRegionOf(loc);
    for (const ex of loc.exits) {
      if (isFrontierId(ex.to)) continue;
      const to = byId.get(ex.to);
      if (!to) continue;
      const rb = effectiveRegionOf(to);
      if (ra === rb) continue;
      const cls = classifyDirection(ex.direction);
      if (cls.kind !== "planar") continue;
      const dir = toCardinal(cls.canon);
      const pairKey = `${ra}->${rb}`;
      if (seenPair.has(pairKey)) continue; // first-seen compass wins for a region pair
      seenPair.add(pairKey);
      const list = ordered.get(ra) ?? [];
      list.push({ to: rb, dir });
      ordered.set(ra, list);
    }
  }

  const placed = new Map<string, { col: number; row: number }>();
  const occupied = new Set<string>();
  const put = (id: string, col: number, row: number): void => {
    placed.set(id, { col, row });
    occupied.add(`${col},${row}`);
  };
  put(startRegion, 0, 0);
  const queue = [startRegion];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const { col, row } = placed.get(cur)!;
    for (const { to, dir } of ordered.get(cur) ?? []) {
      if (placed.has(to)) continue;
      const step = GRID_STEP[dir]!;
      const [c, r] = resolveCollision(col + step.dc, row + step.dr, occupied, to);
      put(to, c, r);
      queue.push(to);
    }
  }
  // Regions with no compass link into the tree: place by centroid bearing from the start region.
  const anchorCentroid = regionCentroid(world, startRegion === UNREGIONED_ID ? undefined : startRegion);
  for (const region of [...regions].sort()) {
    if (placed.has(region)) continue;
    const c = regionCentroid(world, region === UNREGIONED_ID ? undefined : region);
    const dir = anchorCentroid && c ? toCardinal(bearingName(anchorCentroid, c)) : "east";
    const step = GRID_STEP[dir]!;
    const [cc, rr] = resolveCollision(step.dc, step.dr, occupied, region);
    put(region, cc, rr);
  }
  return [...placed].map(([id, p]) => ({ id, col: p.col, row: p.row }));
}
