/**
 * Gazetteer realization — Phase 4 Stage B: frontier expansion realizes author-canon entries.
 *
 * The contract under test: when a world carries unrealized gazetteer entries, `generatePocket`
 * deterministically (seeded) picks one and shapes the pocket TOWARD it — approach rooms reference
 * it, the TERMINAL room IS it (entry name/summary, `gen.*` id) — and the realization link rides
 * the existing `worldExpanded` delta (`realizedGazetteerId`, additive), so reducer and replay
 * record it through the one shared `applyExpansion` and it survives a reload. The player-facing
 * "known" flip is STRICTER than the record: it waits for ARRIVAL — the reducer's `moveParty`
 * marks a world flag the first time the party stands in the realized terminal room, and the
 * brief and CLI surfaces both read the one `knownGazetteerIdsOf` gate, so no surface ever claims
 * the party knows a place it has never seen. Early rings prefer wilds/ruin (a rumored city never
 * sits one pocket from the hub), realized settlements never host a lurker, and with every entry
 * realized the pocket is BYTE-IDENTICAL to a gazetteer-less world's (today's behavior — and the
 * far end still always opens a new frontier).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { DeltaEvent } from "../src/events/deltas.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import type { GameState } from "../src/state/types.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { heuristicClassify } from "./support/test-classifier.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { buildNarrationContext, nearbyLineOf } from "../src/agents/context.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { reduceDeltas } from "./support/replay.ts";
import { fromGameState, toGameState } from "../src/world/model.ts";
import {
  gazetteerArrivedFlag,
  generatePocket,
  isFrontierId,
  knownGazetteerIdsOf,
  realizedGazetteerIdsOf,
} from "../src/world/expansion.ts";
import { gazetteerRumor } from "../src/worldsmith/floors.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

const GAZ = [
  { id: "gaz.thornmere", name: "Thornmere", kind: "town", summary: "a swamp town, somewhere east" },
  { id: "gaz.fane", name: "The Sunken Fane", kind: "ruin", summary: "a drowned shrine" },
] as const;

function buildPlayset(gazetteer?: unknown): PlaySet {
  const world = WorldSchema.parse({
    id: "w.edge",
    name: "Edgeworld",
    summary: "A world with an edge.",
    locations: [
      {
        id: "loc.camp",
        name: "The Camp",
        description: "A camp at the world's edge.",
        exits: [{ to: "frontier:mistlands", name: "a path into the mist" }],
      },
    ],
    npcs: [],
    ...(gazetteer !== undefined ? { gazetteer } : {}),
  });
  const campaign = CampaignSchema.parse({
    id: "c.edge",
    name: "Edge Campaign",
    worldId: "w.edge",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    startingState: { locationId: "loc.camp", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

function seededModel(playset: PlaySet) {
  const gs = {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.camp",
    clock: 0,
    party: ["pc.you"],
    companions: [],
    actors: { "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.camp", inventory: [], conditions: [] } },
    quests: {},
    relationships: {},
    autonomy: {},
    modules: {},
    flags: {},
  };
  return fromGameState(gs as never, playset.world, playset.campaign);
}

/** A movement classifier whose destination the test can re-point between turns. */
const moveVia = (route: { to: string }): TurnClassifier => ({
  classify: async () => ({
    kind: "movement",
    targetId: null,
    destinationLocationId: route.to,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
  }),
});

describe("generatePocket realization", () => {
  test("seeded pick is deterministic; the terminal room IS the entry; approach rooms point at it", () => {
    const { world } = buildPlayset(GAZ);
    const a = generatePocket(world, "loc.camp", "frontier:mistlands", mulberry32(9));
    const b = generatePocket(world, "loc.camp", "frontier:mistlands", mulberry32(9));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    // Early ring (authored origin) + one wilds/ruin candidate → the ruin, every seed.
    expect(a.realizedGazetteerId).toBe("gaz.fane");
    const terminal = a.locations[a.locations.length - 1]!;
    expect(terminal.name).toBe("The Sunken Fane");
    expect(terminal.description).toContain("a drowned shrine");
    expect(terminal.id.startsWith("gen.mistlands.")).toBe(true); // id stays in the gen.* space
    // The far end still ALWAYS opens a new frontier — the world never runs out.
    expect(terminal.exits.some((e) => isFrontierId(e.to))).toBe(true);
    // Every approach room references the way toward the entry, in prose AND on its onward exit.
    for (const room of a.locations.slice(0, -1)) {
      expect(room.description).toContain("The Sunken Fane");
      expect(room.exits.some((e) => e.name === "on toward The Sunken Fane")).toBe(true);
    }
  });

  test("early rings prefer wilds/ruin; deeper (gen.*) origins draw from every kind", () => {
    const { world } = buildPlayset(GAZ);
    for (let seed = 1; seed <= 24; seed += 1) {
      const p = generatePocket(world, "loc.camp", "frontier:mistlands", mulberry32(seed));
      expect(p.realizedGazetteerId).toBe("gaz.fane");
    }
    const picks = new Set<string>();
    for (let seed = 1; seed <= 24; seed += 1) {
      const p = generatePocket(world, "gen.deep.2", "frontier:mistlands", mulberry32(seed));
      if (p.realizedGazetteerId) picks.add(p.realizedGazetteerId);
    }
    expect(picks.has("gaz.thornmere")).toBe(true); // settlements become reachable deeper in
  });

  test("a realized settlement never hosts a lurker; a wild entry still can", () => {
    const town = buildPlayset([GAZ[0]]).world; // only the town → candidates = [town] even early
    for (let seed = 1; seed <= 40; seed += 1) {
      const p = generatePocket(town, "loc.camp", "frontier:mistlands", mulberry32(seed));
      expect(p.realizedGazetteerId).toBe("gaz.thornmere");
      expect(p.spawns).toEqual([]);
    }
    const ruin = buildPlayset([GAZ[1]]).world;
    let lurked = false;
    for (let seed = 1; seed <= 40 && !lurked; seed += 1) {
      lurked = generatePocket(ruin, "loc.camp", "frontier:mistlands", mulberry32(seed)).spawns.length > 0;
    }
    expect(lurked).toBe(true);
  });

  test("generated rooms inherit the ORIGIN region (no blank __unregioned__ pocket)", () => {
    // Origin room carries a region; a pure-wander pocket must NOT drop its rooms into the synthetic
    // unregioned bucket (which merged unrelated pockets + forged a false gateway back to the origin).
    const world = WorldSchema.parse({
      id: "w.reg",
      name: "Regioned Edge",
      summary: "An edge with a home region.",
      locations: [
        { id: "loc.camp", name: "The Camp", description: "Home turf.", region: "grain-coast", exits: [{ to: "frontier:mist", name: "a path into the mist" }] },
      ],
      npcs: [],
    });
    const p = generatePocket(world, "loc.camp", "frontier:mist", mulberry32(3));
    expect(p.locations.length).toBeGreaterThan(0);
    for (const l of p.locations) expect(l.region).toBe("grain-coast");
  });

  test("a realized gazetteer terminal joins ITS OWN declared region; approach rooms stay in the origin", () => {
    const world = WorldSchema.parse({
      id: "w.reg2",
      name: "Regioned Edge 2",
      summary: "An edge that leads to another territory's landmark.",
      locations: [
        { id: "loc.camp", name: "The Camp", description: "Home turf.", region: "grain-coast", exits: [{ to: "frontier:mist", name: "a path into the mist" }] },
      ],
      gazetteer: [{ id: "gaz.fane", name: "The Sunken Fane", kind: "ruin", summary: "a drowned shrine", region: "saltmire" }],
      npcs: [],
    });
    const p = generatePocket(world, "loc.camp", "frontier:mist", mulberry32(9));
    expect(p.realizedGazetteerId).toBe("gaz.fane");
    const terminal = p.locations[p.locations.length - 1]!;
    expect(terminal.region).toBe("saltmire"); // the landmark genuinely belongs to its own region
    for (const room of p.locations.slice(0, -1)) expect(room.region).toBe("grain-coast"); // approach stays home
    // Nothing is region-less: the false unregioned collapse can't happen.
    for (const l of p.locations) expect(l.region).toBeDefined();
  });

  test("a rumor-register summary with its own trailing period embeds as hearsay, never '..'", () => {
    // The offline/fallback rumor ALWAYS ends in a period and speaks from a distant teller's view
    // ("somewhere to the northwest — known here only from travelers' talk."). The realized room
    // must quote it as what the rumors SAID — not claim it as self-description — and never
    // double the period.
    const rumor = gazetteerRumor("ruin", "northwest");
    const { world } = buildPlayset([{ id: "gaz.tor", name: "Widow's Tor", kind: "ruin", summary: rumor }]);
    const p = generatePocket(world, "loc.camp", "frontier:mistlands", mulberry32(9));
    const terminal = p.locations[p.locations.length - 1]!;
    expect(terminal.name).toBe("Widow's Tor");
    expect(terminal.description).not.toContain("..");
    // The distant-teller phrasing sits inside the quoted rumor, and the room then contradicts
    // the distance in its own voice: the party is standing in the place.
    expect(terminal.description).toMatch(/^The rumors spoke of an old ruin, somewhere to the northwest/);
    expect(terminal.description).toContain("you stand in Widow's Tor itself");
  });

  test("exhaustion: every entry realized → byte-identical to a gazetteer-less world's pocket", () => {
    const plain = buildPlayset().world;
    const gaz = buildPlayset(GAZ).world;
    const allRealized = new Set(GAZ.map((g) => g.id));
    for (const seed of [3, 7, 11]) {
      const a = generatePocket(plain, "loc.camp", "frontier:mistlands", mulberry32(seed));
      const b = generatePocket(gaz, "loc.camp", "frontier:mistlands", mulberry32(seed), allRealized);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a)); // same rng stream, same templates
      expect(b.realizedGazetteerId).toBeUndefined();
      expect(b.locations[b.locations.length - 1]!.exits.some((e) => isFrontierId(e.to))).toBe(true);
    }
  });
});

describe("walking the breadcrumb (heuristic exit matching)", () => {
  // The generated approach room offers "back toward the entrance" FIRST and "on toward <entry>"
  // second. Both contain "toward", so first-any-word matching would bounce the player backward
  // off the very label the pocket printed — the exact-name pass and the word-count scoring in
  // `findExit` must send "toward <entry>" phrasings deeper in.
  const ctx = {
    exits: [
      { id: "gen.deepwood.0", name: "back toward the entrance" },
      { id: "gen.deepwood.2", name: "on toward Rushdown Fen" },
    ],
    presentEntities: [],
    partyMemberIds: [],
    playerId: "pc.you",
  };

  test("the exit label typed verbatim wins outright", () => {
    const plan = heuristicClassify("walk on toward Rushdown Fen", ctx as never);
    expect(plan.kind).toBe("movement");
    expect(plan.destinationLocationId).toBe("gen.deepwood.2");
  });

  test("a natural 'toward <entry>' phrasing beats the earlier back-exit on word overlap", () => {
    const plan = heuristicClassify("head toward Rushdown Fen", ctx as never);
    expect(plan.kind).toBe("movement");
    expect(plan.destinationLocationId).toBe("gen.deepwood.2");
  });

  test("going back still goes back", () => {
    const plan = heuristicClassify("walk back toward the entrance", ctx as never);
    expect(plan.kind).toBe("movement");
    expect(plan.destinationLocationId).toBe("gen.deepwood.0");
  });

  test("a 3-letter place noun ('the fen', 'the tor') routes onward, never backward", () => {
    // Shipped content names places by short nouns ("Rushdown Fen", "Widow's Tor"). A player who
    // says "toward the fen" hits only "toward" on BOTH labels unless the 3-letter noun counts —
    // and a 1-1 tie keeps the earliest exit, which generated pockets always push as the BACK
    // exit. The salient-word filter must keep short non-stop-words.
    const fen = heuristicClassify("go toward the fen", ctx as never);
    expect(fen.kind).toBe("movement");
    expect(fen.destinationLocationId).toBe("gen.deepwood.2");

    const torCtx = {
      ...ctx,
      exits: [
        { id: "gen.northridge.0", name: "back toward the entrance" },
        { id: "gen.northridge.2", name: "on toward Widow's Tor" },
      ],
    };
    const tor = heuristicClassify("head toward the tor", torCtx as never);
    expect(tor.kind).toBe("movement");
    expect(tor.destinationLocationId).toBe("gen.northridge.2");
  });
});

describe("realization through the reducer (record + replay)", () => {
  test("the slice records the link, the delta carries it, and a re-apply is a no-op", () => {
    const playset = buildPlayset(GAZ);
    const model = seededModel(playset);
    const pocket = generatePocket(playset.world, "loc.camp", "frontier:mistlands", mulberry32(9));
    const res = applyCommand(model, {
      type: "expandWorld",
      fromLocationId: "loc.camp",
      viaExitTo: "frontier:mistlands",
      locations: pocket.locations,
      realizedGazetteerId: pocket.realizedGazetteerId,
    });
    expect(res.mutated).toBe(true);
    const delta = res.deltas[0]!;
    expect(delta.kind === "worldExpanded" && delta.realizedGazetteerId).toBe("gaz.fane");
    expect(realizedGazetteerIdsOf(toGameState(model).modules)).toEqual(new Set(["gaz.fane"]));
    // Idempotency guard unchanged: the same expansion again mutates nothing.
    const again = applyCommand(model, {
      type: "expandWorld",
      fromLocationId: "loc.camp",
      viaExitTo: "frontier:mistlands",
      locations: pocket.locations,
      realizedGazetteerId: pocket.realizedGazetteerId,
    });
    expect(again.mutated).toBe(false);
  });

  test("snapshot == fold(deltas): realization replays verbatim", () => {
    const playset = buildPlayset(GAZ);
    const live = seededModel(playset);
    const pocket = generatePocket(playset.world, "loc.camp", "frontier:mistlands", mulberry32(9));
    const res = applyCommand(live, {
      type: "expandWorld",
      fromLocationId: "loc.camp",
      viaExitTo: "frontier:mistlands",
      locations: pocket.locations,
      realizedGazetteerId: pocket.realizedGazetteerId,
    });
    const folded = seededModel(buildPlayset(GAZ));
    reduceDeltas(
      folded,
      res.deltas.map((d, i) => ({ ...d, id: `d${i}`, at: 0, seq: i }) as DeltaEvent),
    );
    expect(toGameState(folded)).toEqual(toGameState(live));
    expect(realizedGazetteerIdsOf(toGameState(folded).modules)).toEqual(new Set(["gaz.fane"]));
  });

  test("arrival at the realized terminal room sets the world flag once, replay-verbatim", () => {
    const playset = buildPlayset(GAZ);
    const live = seededModel(playset);
    const pocket = generatePocket(playset.world, "loc.camp", "frontier:mistlands", mulberry32(9));
    const all = applyCommand(live, {
      type: "expandWorld",
      fromLocationId: "loc.camp",
      viaExitTo: "frontier:mistlands",
      locations: pocket.locations,
      realizedGazetteerId: pocket.realizedGazetteerId,
    }).deltas.slice();

    // Realized (recorded) but NOT yet arrived: the player-facing gate stays shut.
    expect(realizedGazetteerIdsOf(toGameState(live).modules)).toEqual(new Set(["gaz.fane"]));
    expect(knownGazetteerIdsOf(toGameState(live))).toEqual(new Set());

    // Walk the party room by room; only the step INTO the terminal room emits the flag.
    const chain = pocket.locations.map((l) => l.id);
    for (const to of chain) all.push(...applyCommand(live, { type: "moveParty", to }).deltas);
    // Ignore the fog-of-war `visited:` flags every move also sets — this test is about arrival.
    const flagDeltas = all.filter(
      (d) => d.kind === "flagSet" && !(d as { key: string }).key.startsWith("visited:"),
    );
    expect(flagDeltas).toEqual([
      { kind: "flagSet", scope: "world", key: gazetteerArrivedFlag("gaz.fane"), value: true },
    ]);
    expect(knownGazetteerIdsOf(toGameState(live))).toEqual(new Set(["gaz.fane"]));

    // Leaving and returning re-emits nothing (set once), and the flip is sticky.
    all.push(...applyCommand(live, { type: "moveParty", to: chain[chain.length - 2]! }).deltas);
    const back = applyCommand(live, { type: "moveParty", to: chain[chain.length - 1]! });
    expect(back.deltas.some((d) => d.kind === "flagSet")).toBe(false);
    all.push(...back.deltas);
    expect(knownGazetteerIdsOf(toGameState(live))).toEqual(new Set(["gaz.fane"]));

    // snapshot == fold(deltas): the arrival flag rides the ordinary flagSet delta.
    const folded = seededModel(buildPlayset(GAZ));
    reduceDeltas(
      folded,
      all.map((d, i) => ({ ...d, id: `d${i}`, at: 0, seq: i }) as DeltaEvent),
    );
    expect(toGameState(folded)).toEqual(toGameState(live));
  });

  test("realizedGazetteerIdsOf folds absence to the empty set", () => {
    expect(realizedGazetteerIdsOf(undefined)).toEqual(new Set());
    expect(realizedGazetteerIdsOf({})).toEqual(new Set());
    // A pre-Phase-4 pocket record (no realization link) contributes nothing.
    expect(
      realizedGazetteerIdsOf({
        expansion: { pockets: { "frontier:old": { fromLocationId: "loc.camp", locations: [] } } },
      }),
    ).toEqual(new Set());
  });
});

describe("engine end-to-end + surfacing", () => {
  test("the narrator brief renders ', known' only after arrival — realization alone stays hearsay", () => {
    const playset = buildPlayset(GAZ);
    const base: GameState = {
      campaignId: "c.edge",
      worldId: "w.edge",
      partyLocationId: "loc.camp",
      clock: 0,
      party: ["pc.you"],
      companions: [],
      actors: {},
      quests: {},
      relationships: {},
      autonomy: {},
      modules: {},
      flags: {},
    };
    const before = buildNarrationContext({
      world: playset.world,
      campaign: playset.campaign,
      state: base,
      recentEvents: [],
      trigger: "look",
    });
    expect(before.contextText).toContain("Nearby: Thornmere (town), The Sunken Fane (ruin)\n");

    const pocket = generatePocket(playset.world, "loc.camp", "frontier:mistlands", mulberry32(9));
    const realizedState: GameState = {
      ...base,
      modules: {
        expansion: {
          pockets: {
            "frontier:mistlands": {
              fromLocationId: "loc.camp",
              locations: pocket.locations,
              realizedGazetteerId: "gaz.fane",
            },
          },
        },
      },
    };
    // Realized (pocket generated toward it) but never ARRIVED at: the brief must not tell the
    // GM the party knows a place it has never seen — the line stays byte-identical to hearsay.
    const charted = buildNarrationContext({
      world: playset.world,
      campaign: playset.campaign,
      state: realizedState,
      recentEvents: [],
      trigger: "look",
    });
    expect(charted.contextText).toContain("Nearby: Thornmere (town), The Sunken Fane (ruin)\n");

    // The arrival world flag (set by the reducer when the party steps in) flips it to known.
    const arrivedState: GameState = {
      ...realizedState,
      flags: { [gazetteerArrivedFlag("gaz.fane")]: true },
    };
    const after = buildNarrationContext({
      world: playset.world,
      campaign: playset.campaign,
      state: arrivedState,
      recentEvents: [],
      trigger: "look",
    });
    expect(after.contextText).toContain("Nearby: Thornmere (town), The Sunken Fane (ruin, known)\n");
  });
});
