/**
 * Open-world reach (B1 grounding-desync fix) — a player names a place that isn't a listed exit and
 * the engine REACHES it: reuse an existing location (a discovered `linkExit` edge, never a duplicate),
 * realize a gazetteer entry, or generate a fresh 2–3 room approach on the fly — then actually MOVES
 * the party, so state stays synced with the prose. Covers the generation primitive, the reducer's
 * append/link paths (replay-safe), and the engine end-to-end incl. a reload.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { DeltaEvent } from "../src/events/deltas.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { reduceDeltas } from "./support/replay.ts";
import { fromGameState, toGameState } from "../src/world/model.ts";
import { canReach, exitsFrom } from "../src/world/map.ts";
import { generatePocket, isFrontierId } from "../src/world/expansion.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

/** A hub (start, no exits) plus a DISCONNECTED "The Tavern" — the reuse target for "go back to X".
 *  `worldExtra` folds extra world-level fields in (e.g. `openWorldReach:false`). */
function buildPlayset(worldExtra?: Record<string, unknown>): PlaySet {
  const world = WorldSchema.parse({
    id: "w.reach",
    name: "Reachworld",
    summary: "A world you can name your way across.",
    locations: [
      { id: "loc.hub", name: "The Hub", description: "A crossroads.", exits: [] },
      { id: "loc.tavern", name: "The Tavern", description: "A warm common room.", exits: [] },
    ],
    npcs: [],
    ...worldExtra,
  });
  const campaign = CampaignSchema.parse({
    id: "c.reach",
    name: "Reach Campaign",
    worldId: "w.reach",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    startingState: { locationId: "loc.hub", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

/** A scripted classifier for a movement-MISS: a named place with no grounded exit id. */
const reachName = (name: string): TurnClassifier => ({
  classify: async () => ({
    kind: "movement",
    targetId: null,
    destinationLocationId: null,
    destinationName: name,
    movementMiss: true,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
  }),
});

function seededModel(playset: PlaySet) {
  const gs = {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.hub",
    clock: 0,
    party: ["pc.you"],
    companions: [],
    actors: { "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.hub", inventory: [], conditions: [] } },
    quests: {},
    relationships: {},
    autonomy: {},
    modules: {},
    flags: {},
  };
  return fromGameState(gs as never, playset.world, playset.campaign);
}

// ---------------------------------------------------------------------------
// generatePocket — the `reach` mode (name-titled + forced-gazetteer targets)
// ---------------------------------------------------------------------------

describe("generatePocket (reach)", () => {
  test("deterministic; terminal room titled from the name; back-exit + fresh frontier onward", () => {
    const { world } = buildPlayset();
    const reach = { name: "the Almshouse" };
    const a = generatePocket(world, "loc.hub", "frontier:reach-almshouse", mulberry32(4), undefined, reach);
    const b = generatePocket(world, "loc.hub", "frontier:reach-almshouse", mulberry32(4), undefined, reach);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // byte-identical for the same seed
    expect(a.locations.length).toBeGreaterThanOrEqual(2);
    const terminal = a.locations[a.locations.length - 1]!;
    expect(terminal.name).toBe("the Almshouse"); // the named place IS the far room
    expect(a.locations[0]!.exits.some((e) => e.to === "loc.hub")).toBe(true); // back the way you came
    expect(terminal.exits.some((e) => isFrontierId(e.to))).toBe(true); // the map keeps growing
    expect(a.realizedGazetteerId).toBeUndefined(); // an invented place has no gazetteer link
  });

  test("a forced SETTLEMENT gazetteer entry realizes it and never squats a lurker in it", () => {
    const world = WorldSchema.parse({
      id: "w.gz",
      name: "Gazworld",
      summary: "A world with a rumored town.",
      locations: [{ id: "loc.hub", name: "The Hub", description: "A crossroads.", exits: [] }],
      npcs: [],
      gazetteer: [{ id: "gz.thornmere", name: "Thornmere", kind: "town", summary: "a walled market town" }],
    });
    const pocket = generatePocket(world, "loc.hub", "frontier:reach-thornmere", mulberry32(4), undefined, {
      name: "Thornmere",
      forcedGazetteerId: "gz.thornmere",
    });
    expect(pocket.realizedGazetteerId).toBe("gz.thornmere");
    expect(pocket.locations[pocket.locations.length - 1]!.name).toBe("Thornmere");
    expect(pocket.spawns.length).toBe(0); // a settlement never gets a lurker
  });
});

// ---------------------------------------------------------------------------
// reducer — expandWorld APPEND (no pre-existing frontier) + linkExit
// ---------------------------------------------------------------------------

describe("reducer: reach append + linkExit", () => {
  test("expandWorld APPENDS an origin→entrance edge when the origin has no frontier exit", () => {
    const playset = buildPlayset();
    const model = seededModel(playset);
    const before = exitsFrom(model.map, "loc.hub").length;
    const pocket = generatePocket(playset.world, "loc.hub", "frontier:reach-almshouse", mulberry32(4), undefined, {
      name: "the Almshouse",
    });
    const entrance = pocket.locations[0]!.id;
    const res = applyCommand(model, {
      type: "expandWorld",
      fromLocationId: "loc.hub",
      viaExitTo: "frontier:reach-almshouse",
      locations: pocket.locations,
    });
    expect(res.mutated).toBe(true);
    expect(canReach(model.map, "loc.hub", entrance)).toBe(true);
    expect(exitsFrom(model.map, "loc.hub").length).toBe(before + 1); // exactly one discovered edge
    // Idempotent by the pocket-key guard.
    const again = applyCommand(model, {
      type: "expandWorld",
      fromLocationId: "loc.hub",
      viaExitTo: "frontier:reach-almshouse",
      locations: pocket.locations,
    });
    expect(again.mutated).toBe(false);
  });

  test("snapshot == fold(deltas): a reach append replays verbatim", () => {
    const live = seededModel(buildPlayset());
    const pocket = generatePocket(buildPlayset().world, "loc.hub", "frontier:reach-almshouse", mulberry32(4), undefined, {
      name: "the Almshouse",
    });
    const res = applyCommand(live, {
      type: "expandWorld",
      fromLocationId: "loc.hub",
      viaExitTo: "frontier:reach-almshouse",
      locations: pocket.locations,
    });
    const folded = seededModel(buildPlayset());
    reduceDeltas(
      folded,
      res.deltas.map((d, i) => ({ ...d, id: `d${i}`, at: 0, seq: i }) as DeltaEvent),
    );
    expect(toGameState(folded)).toEqual(toGameState(live));
    expect([...folded.map.exits.keys()].sort()).toEqual([...live.map.exits.keys()].sort());
  });

  test("linkExit wires one discovered edge into an EXISTING location — idempotent, no new location", () => {
    const live = seededModel(buildPlayset());
    const keysBefore = live.map.exits.size;
    const res = applyCommand(live, { type: "linkExit", fromLocationId: "loc.hub", to: "loc.tavern", name: "The Tavern" });
    expect(res.mutated).toBe(true);
    expect(canReach(live.map, "loc.hub", "loc.tavern")).toBe(true);
    expect(live.map.exits.size).toBe(keysBefore); // no new location was created
    // A second identical link is a no-op.
    expect(applyCommand(live, { type: "linkExit", fromLocationId: "loc.hub", to: "loc.tavern", name: "The Tavern" }).mutated).toBe(false);
    // And it replays verbatim.
    const folded = seededModel(buildPlayset());
    reduceDeltas(
      folded,
      res.deltas.map((d, i) => ({ ...d, id: `d${i}`, at: 0, seq: i }) as DeltaEvent),
    );
    expect(toGameState(folded)).toEqual(toGameState(live));
  });
});

// ---------------------------------------------------------------------------
// engine end-to-end
// ---------------------------------------------------------------------------

describe("engine: open-world reach", () => {
  test("naming an unlisted, non-gazetteer place STAYS PUT — degrade in place, no fabrication", async () => {
    const playset = buildPlayset(); // no gazetteer → "the Almshouse" resolves to nothing real
    const before = playset.world.locations.length;
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: reachName("the Almshouse"),
      rng: mulberry32(21),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("go to the almshouse");

    // Movement obeys the same grounding contract as every other intent: an unresolved name never
    // fabricates world state. The party stays; the narrator handles the reference in place.
    expect(engine.getState().partyLocationId).toBe("loc.hub"); // stayed put
    expect(events.some((e) => e.kind === "worldExpanded")).toBe(false); // nothing generated
    expect(playset.world.locations.length).toBe(before); // no invented location
    expect(events.some((e) => e.kind === "narration")).toBe(true); // still narrated in place
    // r14 (fixture-combat t6–t8): the degrade leaves a RECEIPT — a visible stateChanged naming the dead
    // ask — or the narrator's cover-prose reads as progress and the same ask repeats forever.
    // Receipts, not relays: the refusal reaches the screen where prose cannot overwrite it.
    const receipt = events.find(
      (e) => e.kind === "stateChanged" && e.summary.includes("No way from here leads to"),
    );
    expect(receipt).toBeDefined();
    expect((receipt as { summary: string }).summary).toContain("the Almshouse");
    // The Hub authors no exits, so the ways tail is honestly omitted rather than printed empty.
    expect((receipt as { summary: string }).summary).not.toContain("Ways on from here:");
  });

  test("the degrade receipt names the real ways out when the room has any (r14)", async () => {
    const playset = buildPlayset({
      locations: [
        {
          id: "loc.hub",
          name: "The Hub",
          description: "A crossroads.",
          exits: [{ to: "loc.tavern", name: "the tavern road", locked: false, hidden: false }],
        },
        { id: "loc.tavern", name: "The Tavern", description: "A warm common room.", exits: [] },
      ],
    });
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: reachName("the split-stone where the glass-road forks"),
      rng: mulberry32(21),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();
    await engine.submitPlayerInput("I head west to the split-stone where the glass-road forks.");
    expect(engine.getState().partyLocationId).toBe("loc.hub");
    const receipt = events.find(
      (e) => e.kind === "stateChanged" && e.summary.includes("No way from here leads to"),
    );
    expect(receipt).toBeDefined();
    expect((receipt as { summary: string }).summary).toContain("Ways on from here: the tavern road");
  });

  test("naming an UNVISITED authored place STAYS PUT — no wormhole past the journey", async () => {
    // Reuse is gated to VISITED places: a never-seen authored room (the disconnected, unvisited
    // Tavern) must NOT be teleported to by name — that was a wormhole skipping every intervening
    // barrier/exit. It degrades in place exactly like a place that exists nowhere.
    const playset = buildPlayset();
    const before = playset.world.locations.length;
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: reachName("The Tavern"),
      rng: mulberry32(21),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("go back to the tavern");

    expect(engine.getState().partyLocationId).toBe("loc.hub"); // stayed — never visited the tavern
    expect(events.some((e) => e.kind === "exitLinked")).toBe(false); // no wormhole link minted
    expect(events.some((e) => e.kind === "worldExpanded")).toBe(false);
    expect(playset.world.locations.length).toBe(before);
  });

  test("naming a VISITED place WALKS the real road back — adjacent leg executes, NO wormhole minted", async () => {
    // A world where the party WALKS to the hub (visiting both rooms), then names the tavern from a
    // reach-MISS (no grounded exit id) — the legitimate "go back to X" route. 2026-07-25 fix wave:
    // the reuse no longer mints a minutes-less `linkExit` wormhole; it routes over the EXISTING
    // road, so an adjacent destination executes at once and the discovered-edge event never fires.
    const mkPlayset = (): PlaySet => {
      const world = WorldSchema.parse({
        id: "w.reach2",
        name: "Reachworld2",
        summary: "A world you can name your way back across.",
        locations: [
          {
            id: "loc.tavern",
            name: "The Tavern",
            description: "A warm common room.",
            exits: [{ to: "loc.hub", name: "out to the hub", locked: false, hidden: false }],
          },
          {
            id: "loc.hub",
            name: "The Hub",
            description: "A crossroads.",
            exits: [{ to: "loc.tavern", name: "back to the tavern", locked: false, hidden: false }],
          },
        ],
        npcs: [],
      });
      const campaign = CampaignSchema.parse({
        id: "c.reach2",
        name: "Reach Campaign 2",
        worldId: "w.reach2",
        characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
        startingState: { locationId: "loc.tavern", party: ["pc.you"], companions: [] },
      });
      return { world, campaign };
    };
    const noCheck = { warranted: false, ability: null, skill: null, dc: null, reason: "" };
    // A GROUNDED walk tavern→hub (visits both), then a reach-MISS naming the now-visited tavern.
    let call = 0;
    const classifier: TurnClassifier = {
      classify: async () =>
        call++ === 0
          ? { kind: "movement", targetId: null, destinationLocationId: "loc.hub", destinationName: null, movementMiss: false, check: noCheck, confidence: 1 }
          : { kind: "movement", targetId: null, destinationLocationId: null, destinationName: "The Tavern", movementMiss: true, check: noCheck, confidence: 1 },
    };
    const playset = mkPlayset();
    const before = playset.world.locations.length;
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({ playset, store, gateway: new OfflineGateway(), classifier, rng: mulberry32(21) });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("head out to the hub"); // grounded walk — visits tavern + hub
    expect(engine.getState().partyLocationId).toBe("loc.hub");
    await engine.submitPlayerInput("go back to the tavern"); // reach-miss → walk the real road back

    expect(engine.getState().partyLocationId).toBe("loc.tavern"); // routed to the real one
    expect(events.some((e) => e.kind === "exitLinked")).toBe(false); // NO wormhole minted
    expect(events.some((e) => e.kind === "worldExpanded")).toBe(false); // nothing generated
    expect(playset.world.locations.length).toBe(before); // no duplicate place

    // The position survives a reload (no minted edge needed).
    const relaunch = mkPlayset();
    const engine2 = new GameEngine({ playset: relaunch, store, gateway: new OfflineGateway(), rng: mulberry32(22) });
    await engine2.start();
    expect(engine2.getState().partyLocationId).toBe("loc.tavern");
  });

  test("a VISITED place with NO road back refuses honestly — no teleport, no minted edge", async () => {
    // One-way physics: the tavern opens onto the hub but the hub has no way back. The old reuse
    // minted a wormhole exit and teleported; now the engine refuses in place, naming the truth.
    const world = WorldSchema.parse({
      id: "w.reach3",
      name: "Reachworld3",
      summary: "A world with a one-way door.",
      locations: [
        {
          id: "loc.tavern",
          name: "The Tavern",
          description: "A warm common room.",
          exits: [{ to: "loc.hub", name: "out to the hub", locked: false, hidden: false }],
        },
        { id: "loc.hub", name: "The Hub", description: "A crossroads.", exits: [] },
      ],
      npcs: [],
    });
    const campaign = CampaignSchema.parse({
      id: "c.reach3",
      name: "Reach Campaign 3",
      worldId: "w.reach3",
      characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
      startingState: { locationId: "loc.tavern", party: ["pc.you"], companions: [] },
    });
    const noCheck = { warranted: false, ability: null, skill: null, dc: null, reason: "" };
    let call = 0;
    const classifier: TurnClassifier = {
      classify: async () =>
        call++ === 0
          ? { kind: "movement", targetId: null, destinationLocationId: "loc.hub", destinationName: null, movementMiss: false, check: noCheck, confidence: 1 }
          : { kind: "movement", targetId: null, destinationLocationId: null, destinationName: "The Tavern", movementMiss: true, check: noCheck, confidence: 1 },
    };
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({ playset: { world, campaign }, store, gateway: new OfflineGateway(), classifier, rng: mulberry32(21) });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("head out to the hub");
    expect(engine.getState().partyLocationId).toBe("loc.hub");
    await engine.submitPlayerInput("go back to the tavern");

    expect(engine.getState().partyLocationId).toBe("loc.hub"); // stayed — no road back
    expect(events.some((e) => e.kind === "exitLinked")).toBe(false); // no wormhole
    expect(events.some((e) => e.kind === "worldExpanded")).toBe(false);
  });

  test("naming an unrealized GAZETTEER rumor still realizes it and MOVES (route 2 — authored canon)", async () => {
    const playset = buildPlayset({
      gazetteer: [{ id: "gz.almshouse", name: "the Almshouse", kind: "poi", summary: "a shuttered charity house" }],
    });
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: reachName("the Almshouse"),
      rng: mulberry32(21),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("make for the almshouse");

    // A place the player names that IS authored (a gazetteer rumor) still materializes on demand —
    // the one reach that legitimately generates, because the place already exists in the world.
    const state = engine.getState();
    expect(state.partyLocationId.startsWith("gen.reach")).toBe(true); // materialized + moved
    expect(events.some((e) => e.kind === "worldExpanded")).toBe(true);
    expect(playset.world.locations.some((l) => l.id === state.partyLocationId)).toBe(true);
  });

  test("flag OFF: naming an unrealized GAZETTEER rumor STAYS PUT — no realization (frontierExpansion:false)", async () => {
    // The one reach that normally generates (route 2, authored canon) is gated by the world flag:
    // with `frontierExpansion:false` even a matched gazetteer rumor is NOT realized on demand — it
    // degrades in place like any unlisted name, so no pocket is minted and the party holds.
    const playset = buildPlayset({
      frontierExpansion: false,
      gazetteer: [{ id: "gz.almshouse", name: "the Almshouse", kind: "poi", summary: "a shuttered charity house" }],
    });
    const before = playset.world.locations.length;
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      classifier: reachName("the Almshouse"),
      rng: mulberry32(21),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("make for the almshouse");

    expect(engine.getState().partyLocationId).toBe("loc.hub"); // stayed put — expansion disabled
    expect(events.some((e) => e.kind === "worldExpanded")).toBe(false); // nothing realized
    expect(playset.world.locations.length).toBe(before); // no materialized location
    expect(events.some((e) => e.kind === "narration")).toBe(true); // degraded in place
  });

  test("naming the CURRENT room stays put — no reach, no duplicate", async () => {
    const playset = buildPlayset();
    const before = playset.world.locations.length;
    const engine = new GameEngine({
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      classifier: reachName("The Hub"),
      rng: mulberry32(21),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("wander around the hub");

    expect(engine.getState().partyLocationId).toBe("loc.hub"); // did not move
    expect(events.some((e) => e.kind === "worldExpanded")).toBe(false);
    expect(playset.world.locations.length).toBe(before);
  });

  test("naming a SUB-FEATURE of the current room degrades to an in-place approach beat (T6)", async () => {
    // "the deep vaults" lives only inside the current room's own description — an authored prop, not
    // a Location or gazetteer entry. Walking to it must neither refuse flatly nor mint anything: the
    // party stays put and the narrator is steered to approach it WITHIN the scene.
    const playset = buildPlayset();
    playset.world.locations.find((l) => l.id === "loc.hub")!.description =
      "A crossroads over the deep vaults, their sunken doors chained shut.";
    const before = playset.world.locations.length;
    const engine = new GameEngine({
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      classifier: reachName("the deep vaults"),
      rng: mulberry32(21),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("go to the deep vaults");

    expect(engine.getState().partyLocationId).toBe("loc.hub"); // no move
    expect(events.some((e) => e.kind === "worldExpanded")).toBe(false); // no mint
    expect(playset.world.locations.length).toBe(before);
    expect(events.some((e) => e.kind === "narration")).toBe(true); // narrated in place
  });
});
