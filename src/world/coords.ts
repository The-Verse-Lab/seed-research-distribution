/**
 * Map coordinates — dead-reckoning + a deterministic layout pass.
 *
 * The world is a topological graph (locations + exits); this module attaches a 2D position to each
 * location so the map can be drawn and roads laid between towns. Two producers feed it:
 *   • generated pockets dead-reckon from the parent room in the compass direction travelled
 *     (src/world/expansion.ts), and
 *   • authored / frozen worlds get a one-time, fill-only radial layout at load (`assignCoordinates`,
 *     called from src/content/loader.ts).
 *
 * Everything here is PURE and DETERMINISTIC. All randomness is drawn from an id-keyed PRIVATE rng
 * (`idRng` = mulberry32(fnv1a(id))) so it consumes ZERO draws from any shared seeded stream — the
 * engine's byte-determinism (and every replay test) is untouched. Coordinates are passenger content:
 * the reducer/WorldModel read only `exits`, never x/y, so coordinates ride the `worldExpanded` delta
 * and persist as JSON with no new delta kind.
 *
 * @author Runkai Zhang
 */
import type { Location, World } from "../content/schema.ts";
import { fnv1a, mulberry32, type Rng } from "../rules/dice.ts";

export interface Point {
  x: number;
  y: number;
}

/** Nominal distance between adjacent rooms on the map (dead-reckoning + layout share the scale). */
export const SEGMENT = 10;

/**
 * Unit (or unit-normalized) displacement per compass direction. Screen convention: +y is DOWN, so
 * north is negative y and a "north" child renders above its parent. Diagonals are unit-normalized.
 */
export const COMPASS_VECTORS: Readonly<Record<string, Point>> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
  northeast: { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
  northwest: { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
  southeast: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
  southwest: { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
};

/** The reverse bearing — used to stamp the "back the way you came" exit truthfully. Involution. */
export const COMPASS_OPPOSITE: Readonly<Record<string, string>> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  northeast: "southwest",
  southwest: "northeast",
  northwest: "southeast",
  southeast: "northwest",
  up: "down",
  down: "up",
};

const DIRECTION_ALIASES: Readonly<Record<string, string>> = {
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  ne: "northeast",
  nw: "northwest",
  se: "southeast",
  sw: "southwest",
};

/** Normalize a raw direction label to a canonical PLANAR compass key, or "" if it isn't one
 *  (vertical up/down, unknown, or absent all fold to "" so callers pick a seeded bearing). */
export function normalizeDirection(direction: string | undefined | null): string {
  if (!direction) return "";
  const d = direction.trim().toLowerCase();
  const canon = DIRECTION_ALIASES[d] ?? d;
  return canon in COMPASS_VECTORS ? canon : "";
}

/** A private, deterministic rng keyed only on `id` — consumes ZERO draws from any shared stream. */
export function idRng(id: string): Rng {
  return mulberry32(fnv1a(id));
}

/** Pick one of the eight planar compass directions from a (private) rng draw. */
export function seededCompass(rng: Rng): string {
  const keys = Object.keys(COMPASS_VECTORS);
  return keys[Math.min(keys.length - 1, Math.floor(rng() * keys.length))]!;
}

/** The nearest compass direction pointing from `from` toward `to` (""" if the points coincide). Used
 *  to label a generated exit with a truthful bearing so fuzzy-match + display read right. */
export function bearingName(from: Point, to: Point): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return "";
  let best = "";
  let bestDot = -Infinity;
  for (const [name, u] of Object.entries(COMPASS_VECTORS)) {
    const dot = (dx * u.x + dy * u.y) / len;
    if (dot > bestDot) {
      bestDot = dot;
      best = name;
    }
  }
  return best;
}

/** A unit vector at `angle` radians. */
function unit(angle: number): Point {
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

/**
 * Place a new point one segment from `parent` in `direction`. A planar compass direction sets the
 * bearing; anything else (vertical up/down, unknown, or absent) falls back to a bearing drawn from
 * `jitterRng`, so vertically-linked or unlabeled rooms spread out instead of stacking. A small
 * id-keyed jitter (angular wobble + length wobble) is always added so grid-aligned pockets never
 * overlap exactly. Deterministic in (parent, direction, segLen, jitterRng draw order).
 */
export function deadReckon(
  parent: Point,
  direction: string | undefined | null,
  segLen: number,
  jitterRng: Rng,
): Point {
  const canon = normalizeDirection(direction);
  const base = canon ? COMPASS_VECTORS[canon]! : unit(jitterRng() * Math.PI * 2);
  const wobble = (jitterRng() - 0.5) * (Math.PI / 8); // ±~11°
  const len = segLen * (0.85 + jitterRng() * 0.3); // ±15%
  const ca = Math.cos(wobble);
  const sa = Math.sin(wobble);
  const vx = base.x * ca - base.y * sa;
  const vy = base.x * sa + base.y * ca;
  return { x: parent.x + vx * len, y: parent.y + vy * len };
}

/**
 * The mean position of a region's LOCATED authored locations — the region's spatial centroid, the
 * one bit of per-region geometry the read-side needs to place a rumor near its own territory.
 * Only authored rooms carry `region` (generated pocket rooms never set one) and their coordinates
 * are fixed once at load, so the centroid is STABLE for the whole session — a rumor anchored on it
 * never drifts as the map grows. Returns undefined for no region or no located members. Pure.
 */
export function regionCentroid(world: World, region: string | undefined): Point | undefined {
  if (!region) return undefined;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const l of world.locations) {
    if (l.region !== region || l.x === undefined || l.y === undefined) continue;
    sx += l.x;
    sy += l.y;
    n += 1;
  }
  return n > 0 ? { x: sx / n, y: sy / n } : undefined;
}

/**
 * The seeded anchor for a rumored gazetteer entry — a fixed position placed the moment the rumor
 * exists (usually game start), so the map can show it before the party arrives AND generation can
 * aim at it. Bearing + distance derive from the entry's own id (stable forever); distance scales
 * with kind (a city sits farther out than a wilds/poi). Pure — no shared-stream draws.
 *
 * `origin` is where the anchor is measured FROM and `regional` selects the ring scale: when the
 * entry has a region centroid (`regional` true) the rumor sits just OUTSIDE its own region cluster
 * (a tight kind-scaled offset); otherwise it falls back to the wider hub ring, byte-identical to
 * the pre-region behavior. Both call sites (`rumoredNodes`, `generatePocket`) resolve `origin` the
 * same pure way, so a rumor marker and the room that later realizes it land on the same point.
 */
export function gazetteerAnchor(entry: { id: string; kind: string }, origin: Point, regional: boolean): Point {
  const rng = idRng(`anchor:${entry.id}`);
  const angle = rng() * Math.PI * 2;
  const rings: Record<string, number> = regional
    ? { city: 2.5, town: 2, ruin: 1.5, wilds: 1.2, poi: 1.2 }
    : { city: 6, town: 4.5, ruin: 3.5, wilds: 3, poi: 3 };
  const dist = SEGMENT * (rings[entry.kind] ?? (regional ? 1.5 : 4)) * (0.85 + rng() * 0.3);
  const u = unit(angle);
  return { x: origin.x + u.x * dist, y: origin.y + u.y * dist };
}

/**
 * One-time, fill-only, deterministic layout for authored / frozen worlds that ship without
 * coordinates. Radial BFS from `startId` (placed at the origin): each unplaced neighbor is laid one
 * segment out, its bearing taken from the connecting exit's `direction` when present, else fanned by
 * even angle so the tree spreads. Locations already carrying x/y are LEFT UNTOUCHED (a generated
 * pocket re-hydrated into world.locations keeps its baked coords), and any location unreachable from
 * the start gets a seeded scatter position. Idempotent: a second call is a no-op.
 */
export function assignCoordinates(world: World, startId?: string): void {
  const locs = world.locations;
  if (locs.length === 0) return;
  const byId = new Map(locs.map((l) => [l.id, l] as const));

  // Undirected adjacency over real (non-frontier) exits, preserving authored order + the exit's dir.
  const neighbors = new Map<string, Array<{ id: string; direction?: string }>>();
  const addEdge = (a: string, b: string, dir?: string): void => {
    const list = neighbors.get(a) ?? [];
    list.push(dir ? { id: b, direction: dir } : { id: b });
    neighbors.set(a, list);
  };
  for (const loc of locs) {
    for (const ex of loc.exits) {
      if (ex.to.startsWith("frontier:") || !byId.has(ex.to)) continue;
      addEdge(loc.id, ex.to, ex.direction);
      const back = ex.direction ? COMPASS_OPPOSITE[normalizeDirection(ex.direction)] : undefined;
      addEdge(ex.to, loc.id, back);
    }
  }

  const place = (loc: Location, p: Point): void => {
    if (loc.x === undefined || loc.y === undefined) {
      loc.x = p.x;
      loc.y = p.y;
    }
  };

  const start = (startId ? byId.get(startId) : undefined) ?? locs[0]!;
  const placed = new Set<string>();
  const queue: Array<{ id: string; pos: Point }> = [];
  place(start, { x: 0, y: 0 });
  placed.add(start.id);
  queue.push({ id: start.id, pos: { x: start.x!, y: start.y! } });

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const kids = (neighbors.get(cur.id) ?? []).filter((n) => !placed.has(n.id));
    const jr = idRng(`layout:${cur.id}`);
    kids.forEach((kid, i) => {
      if (placed.has(kid.id)) return;
      const child = byId.get(kid.id)!;
      const dir = normalizeDirection(kid.direction);
      const pos = dir
        ? deadReckon(cur.pos, dir, SEGMENT, jr)
        : (() => {
            const angle = (Math.PI * 2 * i) / Math.max(1, kids.length) + jr() * 0.5;
            const u = unit(angle);
            return { x: cur.pos.x + u.x * SEGMENT, y: cur.pos.y + u.y * SEGMENT };
          })();
      place(child, pos);
      placed.add(kid.id);
      queue.push({ id: kid.id, pos: { x: child.x!, y: child.y! } });
    });
  }

  // Disconnected components / stragglers: a seeded scatter so every location has a finite position.
  for (const loc of locs) {
    if (loc.x !== undefined && loc.y !== undefined) continue;
    const r = idRng(`scatter:${loc.id}`);
    const angle = r() * Math.PI * 2;
    const dist = SEGMENT * (6 + r() * 6);
    loc.x = Math.cos(angle) * dist;
    loc.y = Math.sin(angle) * dist;
  }
}
