/**
 * World expansion — generate the map as the player explores.
 *
 * An authored (or previously generated) location may carry a FRONTIER exit: `to` uses the
 * `frontier:` prefix and points at nothing yet. The loader admits it, the classifier offers it
 * like any exit, and when the party travels through it the engine generates a small POCKET of
 * locations on the spot — deterministic templated content (offline-identical), applied through
 * the reducer's `expandWorld` command so the map mutation is a typed, replayable delta. The far
 * end of every pocket carries a fresh frontier exit, so the world never runs out of edge.
 *
 * Mechanics live in code: the pocket's shape, names, and its optional lurking monster come from
 * the seeded session rng. The narrator only ever PHRASES arrival prose over generated content.
 *
 * @author Runkai Zhang
 */
import { LocationSchema, type GazetteerEntry, type Location, type World } from "../content/schema.ts";
import type { Exit } from "./map.ts";
import type { EmergentTown, SpawnSpec } from "./commands.ts";
import type { Rng } from "../rules/dice.ts";
import {
  SEGMENT,
  bearingName,
  deadReckon,
  gazetteerAnchor,
  idRng,
  normalizeDirection,
  regionCentroid,
  seededCompass,
  type Point,
} from "./coords.ts";

export const FRONTIER_PREFIX = "frontier:";

/** Is this exit target an ungenerated edge of the map? */
export function isFrontierId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(FRONTIER_PREFIX);
}

/**
 * Is procedural frontier expansion enabled for this world? Enabled when the flag is absent OR true;
 * disabled only on an explicit `false`. Both generation triggers and every frontier-offering surface
 * consult this; the reducer/replay/hydrate path never does (existing pockets always replay).
 */
export function frontierExpansionEnabled(world: Pick<World, "frontierExpansion">): boolean {
  return world.frontierExpansion !== false;
}

/** The display name shown for a frontier exit that carries no authored label. */
export const FRONTIER_FALLBACK_NAME = "an unexplored way";

/** What one expansion contributes: the pocket's locations, plus anything lurking in them. */
export interface GeneratedPocket {
  locations: Location[];
  spawns: SpawnSpec[];
  /** Set when the pocket's terminal room realizes a gazetteer entry (author canon reached). */
  realizedGazetteerId?: string;
  /** Set when pure-wander expansion minted a surprise settlement not in the gazetteer (map system). */
  emergentTown?: EmergentTown;
}

/** The durable record of every expansion, kept as a module slice (persists + replays). */
export interface ExpansionSlice {
  /** Keyed by the consumed frontier id — also the idempotency guard. */
  pockets: Record<
    string,
    {
      fromLocationId: string;
      locations: Location[];
      /** The gazetteer entry this pocket's terminal room realized, if any (Phase 4). */
      realizedGazetteerId?: string;
      /** The surprise settlement this pocket minted, if any (map system). */
      emergentTown?: EmergentTown;
    }
  >;
  /** Open-world REUSE edges: a discovered direct exit into an EXISTING location ("go back to the
   *  tavern"). Kept durable + hydrated like pockets so a reused route survives a reload and never
   *  spawns a duplicate place. Written by the reducer's `applyLink`. */
  links?: Array<{ fromLocationId: string; to: string }>;
}

/** What a pocket is shaped toward — an authored gazetteer entry being realized, OR an open-world
 *  REACH titled from the player's own words (no gazetteer link). */
interface PocketTarget {
  name: string;
  summary?: string;
  kind?: GazetteerEntry["kind"];
  /** Set only when this target IS a gazetteer entry — drives realization + the arrival flag. */
  gazetteerId?: string;
}

/**
 * The gazetteer entry ids already realized by past expansions — read from the durable `expansion`
 * module slice (`WorldModel.modules` / `GameState.modules`), the single record `applyExpansion`
 * writes. This is the GENERATION-side set (the engine's unrealized-candidate filter): an entry
 * counts the moment a pocket materializes toward it, party arrival or not, so the same entry can
 * never be picked twice. What the player-facing surfaces call "known" is the stricter
 * `knownGazetteerIdsOf` (realized AND arrived at).
 */
export function realizedGazetteerIdsOf(modules: Record<string, unknown> | undefined): Set<string> {
  const slice = modules?.expansion as ExpansionSlice | undefined;
  const out = new Set<string>();
  for (const pocket of Object.values(slice?.pockets ?? {})) {
    if (pocket.realizedGazetteerId) out.add(pocket.realizedGazetteerId);
  }
  return out;
}

/** The world-flag key recording that the party has actually STOOD IN a realized entry's room. */
export function gazetteerArrivedFlag(gazetteerId: string): string {
  return `gazetteer.arrived:${gazetteerId}`;
}

/**
 * The world-flag key recording that the party has VISITED a location — the fog-of-war discovery
 * bit. Set-once by the reducer's `moveParty` (an ordinary `flagSet` delta, replay-safe, riding the
 * snapshot) for both the room left and the room entered, so the map reveals only where the party
 * has actually been (plus a glimpse of its immediate neighbors). Mirrors `gazetteerArrivedFlag`.
 */
export function visitedFlag(locationId: string): string {
  return `visited:${locationId}`;
}

/**
 * The gazetteer entry realized AT this location — i.e. `locationId` is the TERMINAL room of a
 * pocket that realized an entry. The reducer's `moveParty` case uses this to mark arrival the
 * moment the party steps in (`applyExpansion` remains the only writer of the realization link
 * itself; arrival is a separate world flag riding the ordinary `flagSet` delta).
 */
export function gazetteerEntryRealizedAt(
  modules: Record<string, unknown> | undefined,
  locationId: string,
): string | undefined {
  const slice = modules?.expansion as ExpansionSlice | undefined;
  for (const pocket of Object.values(slice?.pockets ?? {})) {
    if (!pocket.realizedGazetteerId) continue;
    if (pocket.locations[pocket.locations.length - 1]?.id === locationId) {
      return pocket.realizedGazetteerId;
    }
  }
  return undefined;
}

/**
 * The gazetteer entries the party has actually reached: realized by expansion AND arrived at
 * (the terminal room entered at least once, recorded as a world flag by the reducer). This is
 * the ONE set every player-facing surface reads, including the brief and CLI `Nearby:` line, so
 * "known" can never mean different things on different surfaces, and a
 * pocket merely charted toward a rumor (party still 1–2 rooms out, or turned around) keeps
 * rendering as a rumor until the party has stood in the place.
 */
export function knownGazetteerIdsOf(state: {
  modules?: Record<string, unknown>;
  flags?: Record<string, unknown>;
}): Set<string> {
  const out = new Set<string>();
  for (const id of realizedGazetteerIdsOf(state.modules)) {
    if (state.flags?.[gazetteerArrivedFlag(id)] === true) out.add(id);
  }
  return out;
}

const PLACE_KINDS = [
  { noun: "hollow", desc: "a low, sheltered dell where sound falls away" },
  { noun: "crossing", desc: "a worn junction marked by a leaning stone" },
  { noun: "ruin", desc: "tumbled walls half-swallowed by moss and root" },
  { noun: "thicket", desc: "close-grown trunks that force the path to wind" },
  { noun: "rise", desc: "open high ground with a long view back the way you came" },
  { noun: "cavemouth", desc: "a dark, breathing gap in the stone" },
  { noun: "shrine", desc: "a forgotten wayside altar, its carvings worn smooth" },
  { noun: "ford", desc: "cold shallow water over rattling stones" },
] as const;

const PLACE_MOODS = ["Silent", "Grey", "Old", "Hidden", "Broken", "Cold", "Deep", "Pale"] as const;

const LURKER_KINDS = [
  { name: "Gaunt Prowler", hp: 11, note: "something lean that has learned to follow travellers" },
  { name: "Barrow Shade", hp: 9, note: "a cold outline where the light does not reach" },
  { name: "Feral Boar", hp: 13, note: "a scarred tusker with no fear left in it" },
] as const;

// What a lurker has swallowed/hoarded — masterlist ids (src/rules/srd/items.json), so a kill
// always yields loot the economy can price (`lootDowned` strips the fallen foe to the killer).
const LURKER_TRINKETS = ["item.gem-agate", "item.ring-silver", "weapon.dagger"] as const;

// An always-present crude weapon on every lurker: loot flavor + a real blade the beast can draw
// (its damage is covered by the natural-weapon fallback in combat, but a carried weapon reads
// better and the kill drops something the party can wield). Masterlist ids (`lootDowned` prices
// them). Drawn from the SAME seeded stream so pockets stay deterministic.
const LURKER_WEAPONS = ["weapon.club", "weapon.handaxe", "weapon.spear"] as const;

function pick<T>(rng: Rng, arr: readonly T[]): T {
  const i = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return arr[i] as T;
}

/**
 * Make a generic wilderness-room name unique against `taken` (existing world + this pocket's earlier
 * rooms). On a collision, keep the landform noun and step through the remaining mood words in fixed
 * order (deterministic, no rng), then fall back to a stable ordinal. Mutates `taken` with the chosen
 * name. Cosmetic only — never touches the seeded generation stream.
 */
function uniqueGenName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) {
    taken.add(base.toLowerCase());
    return base;
  }
  const noun = base.replace(/^The\s+\S+\s+/, ""); // strip "The <mood> " → the landform noun
  for (const mood of PLACE_MOODS) {
    const cand = `The ${mood} ${noun}`;
    if (!taken.has(cand.toLowerCase())) {
      taken.add(cand.toLowerCase());
      return cand;
    }
  }
  let n = 2;
  let cand = `${base} (${n})`;
  while (taken.has(cand.toLowerCase())) cand = `${base} (${++n})`;
  taken.add(cand.toLowerCase());
  return cand;
}

// Name parts for an EMERGENT town (a surprise settlement the wander path mints). Drawn from an
// id-keyed private rng, so the same frontier always yields the same name and the shared stream is
// untouched.
const TOWN_PREFIX = ["Ash", "Bram", "Cold", "Fen", "Grey", "Hollow", "Marsh", "Oak", "Pike", "Stone", "Thorn", "Wend"] as const;
const TOWN_SUFFIX = ["ford", "gate", "cross", "reach", "stead", "mere", "hold", "bury", "fell", "market"] as const;

/** A stable settlement name keyed only on the pocket's frontier id. */
function seededTownName(frontierId: string): string {
  const r = idRng(`townname:${frontierId}`);
  return `${pick(r, TOWN_PREFIX)}${pick(r, TOWN_SUFFIX)}`;
}

/** A stable, readable id slug from the consumed frontier id ("frontier:deepwood" → "deepwood"). */
function slugOf(frontierId: string): string {
  const raw = frontierId.slice(FRONTIER_PREFIX.length) || "edge";
  return raw.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
}

/** A stable slug from a free-form place NAME ("the Almshouse" → "the-almshouse"), for the synthetic
 *  `frontier:reach-<slug>` id the engine mints when reaching a named-but-unlisted place. Exported so
 *  the engine builds the same id it passes as the expansion's `viaExitTo` / idempotency key. */
export function slugOfName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "reach";
}

/**
 * Generate the pocket behind a frontier exit: a 2–3 location chain. The entrance links back to
 * where the party came from; the far end always opens a NEW frontier, so exploration never hits
 * a final wall. Ids are namespaced under `gen.<slug>` and deduped against the existing world.
 * Deterministic in (rng, frontierId, world, alreadyRealized) — offline runs generate identical
 * pockets.
 *
 * Gazetteer realization (Phase 4 — author canon guides exploration): when the world carries
 * gazetteer entries not yet realized (`alreadyRealized` names the ones that are), one is picked
 * from the SAME seeded stream and the pocket is shaped TOWARD it — approach rooms reference it,
 * and the TERMINAL room IS the realized place (its name/description come from the entry; the id
 * stays in the `gen.*` space, the link rides `realizedGazetteerId`). Early rings (expanding
 * straight off the authored map) prefer wilds/ruin entries — a rumored city should not sit one
 * pocket from the hub. With no unrealized entries left, the block draws NOTHING from the rng, so
 * the pocket is byte-identical to pre-gazetteer behavior (and the far end still opens a frontier).
 *
 * Open-world REACH (`reach` set — a player named a place that isn't a listed exit): the random
 * gazetteer draw is SKIPPED and the target is FORCED — a matched gazetteer entry (`forcedGazetteerId`,
 * realized as usual) or, failing that, a synthetic target titled from `reach.name` (no gazetteer
 * link). The 2–3 room approach + fresh onward frontier are unchanged, so the party walks toward the
 * named place and the map keeps growing. `reach` undefined ⇒ byte-identical to the authored-frontier
 * path above.
 */
export function generatePocket(
  world: World,
  fromLocationId: string,
  frontierId: string,
  rng: Rng,
  alreadyRealized?: ReadonlySet<string>,
  reach?: { name: string; forcedGazetteerId?: string },
): GeneratedPocket {
  const slug = slugOf(frontierId);
  const taken = new Set(world.locations.map((l) => l.id));
  // Generic wilderness rooms draw a name from an 8×8 mood×kind pool, so two INDEPENDENT pockets can
  // roll the same "The Silent Rise" — producing duplicate labels the map can't tell apart. Dedupe
  // the DISPLAY name against every existing location (and rooms minted earlier in this pocket). Names
  // are cosmetic — this consumes ZERO draws from the shared seeded `rng` (mood/kind are still rolled
  // as before), so generation determinism + replay stay byte-identical; only a colliding label shifts
  // to the next unused mood word (then a stable ordinal). Terminal gazetteer/reach rooms keep their
  // authored names (a repeat reach reuses the existing room via the engine, never a second one).
  const takenNames = new Set(world.locations.map((l) => l.name.toLowerCase()));
  const idFor = (n: number): string => {
    let candidate = `gen.${slug}.${n}`;
    let bump = 0;
    while (taken.has(candidate)) {
      bump += 1;
      candidate = `gen.${slug}.${n}-${bump}`;
    }
    taken.add(candidate);
    return candidate;
  };

  // The place the pocket is shaped toward. A REACH forces it (no random draw — the two request paths
  // never interleave the rng): a matched gazetteer entry, else a synthetic target from the player's
  // words. Otherwise the authored-frontier path picks one unrealized entry from the seeded stream.
  let target: PocketTarget | undefined;
  if (reach) {
    const forced =
      reach.forcedGazetteerId !== undefined
        ? (world.gazetteer ?? []).find((g) => g.id === reach.forcedGazetteerId)
        : undefined;
    target = forced
      ? { name: forced.name, summary: forced.summary, kind: forced.kind, gazetteerId: forced.id }
      : { name: reach.name };
  } else {
    const unrealized = (world.gazetteer ?? []).filter((g) => !alreadyRealized?.has(g.id));
    const earlyRing = !fromLocationId.startsWith("gen.");
    const wildish = unrealized.filter((g) => g.kind === "wilds" || g.kind === "ruin");
    const candidates = earlyRing && wildish.length > 0 ? wildish : unrealized;
    const picked: GazetteerEntry | undefined = candidates.length > 0 ? pick(rng, candidates) : undefined;
    target = picked
      ? { name: picked.name, summary: picked.summary, kind: picked.kind, gazetteerId: picked.id }
      : undefined;
  }

  // Surprise EMERGENT town (map system): on the pure-wander path (no reach, no gazetteer target), a
  // per-frontier chance mints a brand-new settlement not in the gazetteer, placed where the party
  // wandered to. The roll is id-keyed (per frontier id), so it draws NOTHING from the shared stream —
  // a world that leaves `emergentTownChance` unset (⇒ 0) generates byte-identically to before.
  let emergent: { name: string; kind: "town" | "city" } | undefined;
  if (!reach && !target && (world.emergentTownChance ?? 0) > 0) {
    const er = idRng(`emergent:${frontierId}`);
    if (er() < (world.emergentTownChance ?? 0)) {
      emergent = { name: seededTownName(frontierId), kind: er() < 0.22 ? "city" : "town" };
      target = { name: emergent.name, kind: emergent.kind };
    }
  }

  const count = 2 + (rng() < 0.5 ? 0 : 1);
  const ids = Array.from({ length: count }, (_, n) => idFor(n));
  const onwardFrontier = `${FRONTIER_PREFIX}${slug}-${ids[ids.length - 1]?.split(".").pop() ?? "on"}-beyond`;
  const emergentTown: EmergentTown | undefined = emergent
    ? { id: ids[ids.length - 1] as string, name: emergent.name, kind: emergent.kind }
    : undefined;

  // --- Map coordinates (dead-reckoning). Every generated room gets a 2D position so the map can be
  //     drawn and roads laid. Realizing a rumored gazetteer entry AIMS the pocket at that entry's
  //     fixed seeded anchor (so the placed rumor and the arrived room agree); otherwise it dead-
  //     reckons outward in the travelled compass direction. All jitter is id-keyed — ZERO shared-
  //     stream draws — so coordinates never perturb generation determinism.
  const parentLoc = world.locations.find((l) => l.id === fromLocationId);
  const parentXY: Point = { x: parentLoc?.x ?? 0, y: parentLoc?.y ?? 0 };
  // Aim at the entry's seeded anchor. Region-anchored (rumor sits near its own territory) when the
  // realized entry declares a region with located rooms — resolved the SAME pure way as the rumor
  // marker (`rumoredNodes`), so the marker and this terminal room land on the same point. Region-
  // less entries fall back to the hub origin, byte-identical to the pre-region behavior.
  const targetRegion =
    target?.gazetteerId !== undefined
      ? (world.gazetteer ?? []).find((g) => g.id === target.gazetteerId)?.region
      : undefined;
  // Region inheritance (fog + region correctness): a generated room adopts its ORIGIN room's region so
  // a contiguous pocket never falls into the synthetic `__unregioned__` bucket — which merged every
  // regionless pocket into one shared grid AND forged a false cross-region gateway back to the origin
  // region. A realized gazetteer terminal that declares its OWN region joins that territory instead
  // (its landmark genuinely belongs there); approach/wander rooms stay in the origin region.
  const originRegion = parentLoc?.region;
  const regionFields = (terminal: boolean): { region?: string } => {
    const r = terminal && targetRegion ? targetRegion : originRegion;
    return r !== undefined ? { region: r } : {};
  };
  const targetCentroid = regionCentroid(world, targetRegion);
  const anchor: Point | undefined =
    target?.gazetteerId !== undefined
      ? gazetteerAnchor(
          { id: target.gazetteerId, kind: target.kind ?? "poi" },
          targetCentroid ?? { x: 0, y: 0 },
          targetCentroid !== undefined,
        )
      : undefined;
  const holderDir = normalizeDirection(parentLoc?.exits.find((e) => e.to === frontierId)?.direction);
  const baseDir = holderDir || (anchor ? "" : seededCompass(idRng(frontierId)));
  const coords: Point[] = [];
  for (let n = 0; n < count; n++) {
    const jr = idRng(ids[n] as string);
    if (anchor) {
      // Interpolate parent → anchor; the terminal room lands exactly ON the anchor.
      if (n === count - 1) {
        coords.push({ x: anchor.x, y: anchor.y });
      } else {
        const t = (n + 1) / count;
        coords.push({
          x: parentXY.x + (anchor.x - parentXY.x) * t + (jr() - 0.5) * SEGMENT * 0.35,
          y: parentXY.y + (anchor.y - parentXY.y) * t + (jr() - 0.5) * SEGMENT * 0.35,
        });
      }
    } else {
      coords.push(deadReckon(n === 0 ? parentXY : (coords[n - 1] as Point), baseDir, SEGMENT, jr));
    }
  }
  // The truthful outward bearing for a room's onward exit — toward the next room, or (terminal) the
  // continued heading. Stamped on the ONWARD exit only (the back exit stays unlabeled) so a compass
  // word can never create a fuzzy-match tie between the two directions out of a room.
  const outwardDir = (n: number): string =>
    n < count - 1
      ? bearingName(coords[n] as Point, coords[n + 1] as Point)
      : bearingName(n === 0 ? parentXY : (coords[n - 1] as Point), coords[n] as Point);

  const locations: Location[] = ids.map((id, n) => {
    const terminal = n === ids.length - 1;
    const d = outwardDir(n);
    const here: Point = coords[n] as Point;
    const exits: Exit[] = [];
    // Back the way you came: entrance → the frontier's holder; deeper rooms → the previous room.
    exits.push({
      to: n === 0 ? fromLocationId : (ids[n - 1] as string),
      name: n === 0 ? "back the way you came" : "back toward the entrance",
      locked: false,
      hidden: false,
    });
    if (!terminal) {
      exits.push({
        to: ids[n + 1] as string,
        // The breadcrumb the player actually walks: an approach room's onward exit names the
        // rumored place it leads toward (the classifier offers exits by this label).
        name: target ? `on toward ${target.name}` : "deeper in",
        ...(d ? { direction: d } : {}),
        locked: false,
        hidden: false,
      });
    } else {
      exits.push({
        to: onwardFrontier,
        name: "an unmarked way onward",
        ...(d ? { direction: d } : {}),
        locked: false,
        hidden: false,
      });
    }
    // The terminal room of a realizing pocket IS the gazetteer entry: display name verbatim,
    // description seeded from the authored summary. Mechanics in code — the narrator only ever
    // phrases arrival prose over this content.
    if (terminal && target && target.gazetteerId !== undefined) {
      // The summary is rumor-register prose written from a DISTANT teller's view (the offline
      // `gazetteerRumor` always ends "…known here only from travelers' talk.", period included),
      // so the room the party now STANDS IN must quote it as hearsay — never claim it as
      // self-description — and strip its terminal punctuation so the sentence can't double a
      // period.
      const summary = (target.summary ?? "").trim().replace(/[\s.!?…]+$/u, "");
      return LocationSchema.parse({
        id,
        name: target.name,
        description: summary
          ? `The rumors spoke of ${summary}. They were true: you stand in ${target.name} itself.`
          : `The rumors were true: you have reached ${target.name}.`,
        exits,
        x: here.x,
        y: here.y,
        ...regionFields(terminal),
      });
    }
    if (terminal && target) {
      // An open-world REACH titled from the player's own words: the place the fiction named is now a
      // real room. No map backs it — the narrator phrases arrival over this deterministic scaffold.
      return LocationSchema.parse({
        id,
        name: target.name,
        description: `The way brings you to ${target.name}. No chart you carry names it, yet here it stands, as real as the ground underfoot.`,
        exits,
        x: here.x,
        y: here.y,
        ...regionFields(terminal),
      });
    }
    const kind = pick(rng, PLACE_KINDS);
    const mood = pick(rng, PLACE_MOODS);
    const toward = target ? ` The way presses on toward ${target.name}.` : "";
    const baseName = `The ${mood} ${kind.noun[0]?.toUpperCase()}${kind.noun.slice(1)}`;
    return LocationSchema.parse({
      id,
      name: uniqueGenName(baseName, takenNames),
      description: `Beyond the edge of the known paths: ${kind.desc}.${toward} No map names this place.`,
      exits,
      x: here.x,
      y: here.y,
      ...regionFields(terminal),
    });
  });

  // Danger without opt-in: roughly half of all pockets hide a lurker in their far room. Inline
  // stats (no template needed); `kind: "monster"` makes the combat module's on-sight aggro real.
  // The draw always happens (stream shape stays regular), but a realized SETTLEMENT (city/town)
  // never gets a monster squatting in its terminal room.
  const spawns: SpawnSpec[] = [];
  const lurk = rng() < 0.5;
  const settlement = target?.kind === "city" || target?.kind === "town";
  if (lurk && !settlement) {
    const lurker = pick(rng, LURKER_KINDS);
    const lairId = ids[ids.length - 1] as string;
    // Always a weapon in the slot (the beast draws it; loot on the kill), plus a trinket to price.
    const lurkerWeapon = pick(rng, LURKER_WEAPONS);
    const lurkerTrinket = pick(rng, LURKER_TRINKETS);
    spawns.push({
      id: `mon.gen.${slug}`,
      kind: "monster",
      tier: "tracked",
      name: lurker.name,
      locationId: lairId,
      stats: {
        currentHp: lurker.hp,
        maxHp: lurker.hp,
        conditions: [],
        inventory: [lurkerWeapon, lurkerTrinket],
      },
    });
  }

  return {
    locations,
    spawns,
    ...(target?.gazetteerId !== undefined ? { realizedGazetteerId: target.gazetteerId } : {}),
    ...(emergentTown ? { emergentTown } : {}),
  };
}

/**
 * Re-apply every persisted expansion onto freshly loaded world CONTENT (locations + the consumed
 * frontier exits) before the model/map is built from it. The `expansion` module slice is the
 * durable record (it rides GameState.modules); world.locations is the derived content cache the
 * narrator/CLI read names and descriptions from. Idempotent.
 */
export function hydrateExpansions(world: World, modules: Record<string, unknown> | undefined): void {
  const slice = modules?.expansion as ExpansionSlice | undefined;
  if (!slice) return;
  const have = new Set(world.locations.map((l) => l.id));
  for (const [frontierId, pocket] of Object.entries(slice.pockets ?? {})) {
    const entrance = pocket.locations[0]?.id;
    for (const loc of pocket.locations) {
      if (have.has(loc.id)) continue;
      world.locations.push(structuredClone(loc));
      have.add(loc.id);
    }
    if (!entrance) continue;
    const holder = world.locations.find((l) => l.id === pocket.fromLocationId);
    if (!holder) continue;
    // Retarget the consumed frontier exit (authored-frontier expansion), OR — for an open-world
    // REACH, whose origin never had a frontier exit — APPEND the discovered origin→entrance edge.
    // The content-cache twin of `applyExpansion`'s retarget-or-append; idempotent by construction.
    let retargeted = false;
    for (const exit of holder.exits) {
      if (exit.to === frontierId) {
        exit.to = entrance;
        retargeted = true;
      }
    }
    if (!retargeted && !holder.exits.some((e) => e.to === entrance)) {
      holder.exits.push({
        to: entrance,
        name: `to ${pocket.locations[0]?.name ?? entrance}`,
        locked: false,
        hidden: false,
      });
    }
  }
  // Reuse edges into EXISTING locations ("go back to X") — the content-cache twin of the reducer's
  // `applyLink`, so a discovered direct route survives a reload just like a pocket does (idempotent).
  for (const link of slice.links ?? []) {
    const holder = world.locations.find((l) => l.id === link.fromLocationId);
    if (!holder || holder.exits.some((e) => e.to === link.to)) continue;
    const target = world.locations.find((l) => l.id === link.to);
    holder.exits.push({
      to: link.to,
      name: `to ${target?.name ?? link.to}`,
      locked: false,
      hidden: false,
    });
  }
}
