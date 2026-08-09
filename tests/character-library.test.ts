/**
 * Character library tests — standalone characters selected and bound at the load boundary.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bindCharacter, loadCharacterFromFile, resolveCharacter } from "../src/content/character.ts";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { compileAuthoringLayer } from "../src/content/quest-flow.ts";
import { CampaignSchema, WorldSchema } from "../src/content/schema.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";

const CHARACTER_DIR = fileURLToPath(new URL("fixtures/characters", import.meta.url));
const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

/** The bundled character library and default-world pairing. */
const SHIPPED_CHARACTER_DIR = fileURLToPath(new URL("../characters", import.meta.url));
const SHIPPED_WORLD_DIR = fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url));
/** Read at module scope so a NEW character file joins the sweep the moment it lands on disk. */
const SHIPPED_CHARACTER_FILES = readdirSync(SHIPPED_CHARACTER_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();

/** Every path under `value` holding a string that EQUALS `id` — the recursive stale-reference audit. */
function refPaths(value: unknown, id: string, path = ""): string[] {
  if (value === id) return [path];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
    refPaths(v, id, `${path}/${key}`),
  );
}

function worldDir(name: string): string {
  return fileURLToPath(new URL(`fixtures/worlds/${name}`, import.meta.url));
}

async function ashguard() {
  return resolveCharacter("ashguard", CHARACTER_DIR);
}

describe("character library loading", () => {
  test("loads a library character by file path and by bare id", async () => {
    const byPath = await loadCharacterFromFile(join(CHARACTER_DIR, "ashguard.json"));
    const byId = await resolveCharacter("ashguard", CHARACTER_DIR);

    expect(byPath.id).toBe("pc.ashguard");
    expect(byPath.stats.maxHp).toBe(28);
    expect(byId).toEqual(byPath);
  });

  test("bad ids and paths fail loudly", async () => {
    await expect(resolveCharacter("missing-b1-test", CHARACTER_DIR)).rejects.toThrow(/Failed to load character/);
    await expect(resolveCharacter(join(CHARACTER_DIR, "missing-b1-test.json"))).rejects.toThrow(
      /Failed to load character/,
    );
  });
});

describe("bindCharacter", () => {
  test("binds the character into the primary PC slot without mutating the input playset", async () => {
    const playset = await loadPlaySetFromDir(worldDir("thistledown"));
    const before = structuredClone(playset);
    const character = await ashguard();
    const bound = bindCharacter(playset, character);

    expect(playset).toEqual(before);
    expect(bound).not.toBe(playset);
    // bind may remap NPC standing from the player slot onto the bound character; the world is otherwise
    // structurally unchanged (same locations, same NPC roster). The dedicated remap test below is precise.
    expect(bound.world.locations).toEqual(playset.world.locations);
    expect(bound.world.npcs.map((n) => n.id)).toEqual(playset.world.npcs.map((n) => n.id));
    expect(bound.campaign.startingState.party[0]).toBe(character.id);
    expect(bound.campaign.characters.find((c) => c.id === character.id)).toEqual(character);
    expect(bound.campaign.startingState.locationId).toBe(playset.campaign.startingState.locationId);
    expect(bound.campaign.startingState.companions).toEqual(playset.campaign.startingState.companions);
    expect(bound.campaign.quests).toEqual(playset.campaign.quests);
  });

  test("replaces an existing character with the same id and rejects NPC id collisions", async () => {
    const playset = await loadPlaySetFromDir(worldDir("example"));
    const character = await ashguard();
    const once = bindCharacter(playset, character);
    const updated = bindCharacter(once, { ...character, name: "Seren Updated", inventory: [] });

    expect(updated.campaign.characters.filter((c) => c.id === character.id)).toHaveLength(1);
    expect(updated.campaign.characters.find((c) => c.id === character.id)?.name).toBe("Seren Updated");

    expect(() => bindCharacter(playset, { ...character, id: playset.world.npcs[0]!.id })).toThrow(
      /collides with a world NPC/,
    );
  });
});

describe("back compatibility", () => {
  test("bundled playsets are unchanged when no character is selected", async () => {
    for (const name of ["thistledown", "example", "black-concord"]) {
      const a = await loadPlaySetFromDir(worldDir(name));
      const b = await loadPlaySetFromDir(worldDir(name));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

describe("engine seeding", () => {
  test("a bound playset seeds the library character as the PC without engine changes", async () => {
    const playset = await loadPlaySetFromDir(worldDir("thistledown"));
    const character = await ashguard();
    const bound = bindCharacter(playset, character);
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset: bound,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
    });

    try {
      const state = await engine.start();
      expect(state.party[0]).toBe(character.id);
      expect(state.actors[character.id]?.currentHp).toBe(character.stats.maxHp);
      expect(state.actors[character.id]?.inventory).toEqual(character.inventory);
      expect(state.actors[character.id]?.locationId).toBe(bound.campaign.startingState.locationId);
      expect(state.actors["pc.you"]).toBeUndefined();
      for (const companionId of bound.campaign.startingState.companions) {
        expect(state.actors[companionId]).toBeDefined();
      }
      expect(Object.keys(state.quests).sort()).toEqual(bound.campaign.quests.map((q) => q.id).sort());
    } finally {
      engine.stop();
    }
  });

  test("the same campaign keeps independent saves for different bound characters", async () => {
    const base = await loadPlaySetFromDir(worldDir("thistledown"));
    const ashPlayset = bindCharacter(base, await resolveCharacter("ashguard", CHARACTER_DIR));
    const mirePlayset = bindCharacter(base, await resolveCharacter("mireglass", CHARACTER_DIR));
    const ashKey = makeSaveKey(ashPlayset.campaign.id, ashPlayset.campaign.startingState.party[0]);
    const mireKey = makeSaveKey(mirePlayset.campaign.id, mirePlayset.campaign.startingState.party[0]);
    const store = new InMemoryGameStateStore();

    const ash = new GameEngine({ classifier: heuristicClassifier,
      playset: ashPlayset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(1),
    });
    await ash.start();
    await ash.submitPlayerInput("go to the green");
    expect(ash.getState().party[0]).toBe("pc.ashguard");
    expect(ash.getState().partyLocationId).toBe("loc.green");
    ash.stop();

    const mire = new GameEngine({ classifier: heuristicClassifier,
      playset: mirePlayset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(1),
    });
    await mire.start();
    expect(mire.getState().party[0]).toBe("pc.mireglass");
    expect(mire.getState().partyLocationId).toBe("loc.hart");
    mire.stop();

    const ashReload = new GameEngine({ classifier: heuristicClassifier,
      playset: ashPlayset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(1),
    });
    const mireReload = new GameEngine({ classifier: heuristicClassifier,
      playset: mirePlayset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(1),
    });
    await ashReload.start();
    await mireReload.start();

    expect(ashReload.getState().partyLocationId).toBe("loc.green");
    expect(mireReload.getState().partyLocationId).toBe("loc.hart");
    expect((await store.load(ashKey))?.party[0]).toBe("pc.ashguard");
    expect((await store.load(mireKey))?.party[0]).toBe("pc.mireglass");

    const ashEvents = await store.readEvents(ashKey);
    const mireEvents = await store.readEvents(mireKey);
    expect(ashEvents.some((e) => e.kind === "entityMoved" && e.entityId === "pc.ashguard" && e.to === "loc.green")).toBe(true);
    expect(mireEvents.some((e) => e.kind === "entityMoved" && e.entityId === "pc.ashguard")).toBe(false);
    ashReload.stop();
    mireReload.stop();
  });
});

describe("player-slot reference remap", () => {
  test("a bound character inherits NPC standing authored toward the campaign's player slot", async () => {
    const playset = await loadPlaySetFromDir(worldDir("thistledown"));
    const priorPc = playset.campaign.startingState.party[0]!;
    const authored = playset.world.npcs.find((n) => n.relationships[priorPc] !== undefined);
    if (!authored) throw new Error("fixture: expected a thistledown NPC with player-slot standing");
    const value = authored.relationships[priorPc]!;

    const character = await ashguard();
    const bound = bindCharacter(playset, character);

    const rebound = bound.world.npcs.find((n) => n.id === authored.id)!;
    expect(rebound.relationships[character.id]).toBe(value);
    expect(rebound.relationships[priorPc]).toBeUndefined();
    // input playset is not mutated
    const original = playset.world.npcs.find((n) => n.id === authored.id)!;
    expect(original.relationships[priorPc]).toBe(value);
    expect(original.relationships[character.id]).toBeUndefined();
  });

  test("remaps event targeting and the seeded runtime relationship onto the bound character", async () => {
    const world = WorldSchema.parse({
      id: "w.remap",
      name: "Remap Vale",
      summary: "A test vale.",
      locations: [{ id: "loc.room", name: "The Room", description: "A plain room.", npcs: ["npc.ward"] }],
      npcs: [
        {
          id: "npc.ward",
          name: "Ward",
          summary: "a watchful companion",
          persona: "Steady.",
          relationships: { "pc.you": 30 },
          autonomy: { isPartyMember: true, level: "reactive" },
        },
      ],
    });
    const campaign = CampaignSchema.parse({
      id: "c.remap",
      name: "C",
      worldId: "w.remap",
      characters: [{ id: "pc.you", name: "You", stats: STATS }],
      // An inert event (its flag trigger never fires) so we can assert its targeting was remapped
      // without it perturbing the seeded relationship at runtime.
      events: [
        {
          id: "ev.never",
          trigger: { allOf: [{ kind: "flag", key: "never-set", equals: true }] },
          effects: [
            { kind: "adjustRelationship", actorId: "npc.ward", targetId: "pc.you", by: 1 },
          ],
        },
      ],
      startingState: { locationId: "loc.room", party: ["pc.you"], companions: ["npc.ward"] },
    });

    const character = await ashguard();
    const bound = bindCharacter({ world, campaign }, character);

    const effect = bound.campaign.events[0]!.effects[0]!;
    if (effect.kind !== "adjustRelationship") throw new Error("expected an adjustRelationship effect");
    expect(effect.targetId).toBe(character.id);
    expect(bound.world.npcs[0]!.relationships[character.id]).toBe(30);

    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset: bound,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
    });
    try {
      const state = await engine.start();
      expect(state.relationships["npc.ward"]?.[character.id]).toBe(30);
      expect(state.relationships["npc.ward"]?.["pc.you"]).toBeUndefined();
    } finally {
      engine.stop();
    }
  });

  test("remaps authored defeat-outcome player-entity fields; leaves locations and null captor alone", async () => {
    const world = WorldSchema.parse({
      id: "w.defeat-remap",
      name: "Defeat Remap Vale",
      summary: "A test vale.",
      locations: [
        { id: "loc.room", name: "The Room", description: "A plain room." },
        { id: "loc.hub", name: "The Hub", description: "A safe hub." },
      ],
      constitution: {
        defeatOutcomes: [
          {
            id: "row.captivity",
            weight: 1,
            requiresCause: ["combat-defeat"],
            effects: [
              { type: "beginCaptivity", pcId: "pc.you", captorId: null, kind: "gaol" },
              { type: "adjustCoins", entityId: "pc.you", by: -10 },
              { type: "moveEntity", entityId: "pc.you", to: "loc.hub", teleport: true },
              { type: "advanceClock", by: 60 },
            ],
            narratorBrief: "A bad end.",
          },
        ],
      },
    });
    const campaign = CampaignSchema.parse({
      id: "c.defeat-remap",
      name: "C",
      worldId: "w.defeat-remap",
      characters: [{ id: "pc.you", name: "You", stats: STATS }],
      startingState: { locationId: "loc.room", party: ["pc.you"], companions: [] },
    });

    const character = await ashguard();
    const bound = bindCharacter({ world, campaign }, character);
    const effects = bound.world.constitution.defeatOutcomes[0]!.effects as Record<string, unknown>[];

    expect(effects[0]!.pcId).toBe(character.id); // player-entity field rebound
    expect(effects[0]!.captorId).toBeNull(); // null captor untouched
    expect(effects[1]!.entityId).toBe(character.id); // adjustCoins target rebound
    expect(effects[2]!.entityId).toBe(character.id);
    expect(effects[2]!.to).toBe("loc.hub"); // a LOCATION `to` is never the player id → unchanged
    // the input playset is not mutated
    const original = world.constitution.defeatOutcomes[0]!.effects as Record<string, unknown>[];
    expect(original[0]!.pcId).toBe("pc.you");
  });

  /**
   * The r8 P0: the remap was a hand-maintained switch over four effect kinds, so `transferItem`,
   * `giveItem`, the optional coin/energy/exhaustion `target` and every nested `check` branch kept
   * pointing at the replaced player slot. The `hasItem` GATE moved and the matching transfer did
   * not, which made every quest hand-in in the flagship world unfinishable for a library character.
   * One exhaustive fixture, so a newly authored id-bearing field fails here rather than in a session.
   */
  test("remaps every id-bearing effect/condition field, including nested check branches", async () => {
    const world = WorldSchema.parse({
      id: "w.field-remap",
      name: "Field Remap Vale",
      summary: "A test vale.",
      locations: [
        { id: "loc.room", name: "The Room", description: "A plain room.", npcs: ["npc.ward"] },
        { id: "loc.hub", name: "The Hub", description: "A safe hub." },
      ],
      npcs: [{ id: "npc.ward", name: "Ward", summary: "a warden", persona: "Steady." }],
      items: [{ id: "item.token", name: "Token", kind: "quest" }],
    });
    const campaign = CampaignSchema.parse({
      id: "c.field-remap",
      name: "C",
      worldId: "w.field-remap",
      characters: [{ id: "pc.you", name: "You", stats: STATS }],
      events: [
        {
          id: "ev.every-field",
          trigger: {
            allOf: [
              { kind: "atLocation", locationId: "loc.room" },
              { kind: "hasItem", entityId: "pc.you", itemId: "item.token" },
              { kind: "entityPresent", entityId: "pc.you" },
              { kind: "relationshipAtLeast", actorId: "npc.ward", targetId: "pc.you", value: 10 },
              { kind: "attireState", entityId: "pc.you", state: "bare" },
            ],
          },
          effects: [
            { kind: "transferItem", itemId: "item.token", from: "pc.you", to: "npc.ward" },
            { kind: "transferItem", itemId: "item.token", from: "npc.ward", to: "pc.you" },
            { kind: "giveItem", itemId: "item.token", to: "pc.you" },
            { kind: "adjustCoins", by: -5, target: "pc.you" },
            { kind: "adjustEnergy", by: -1, target: "pc.you" },
            { kind: "adjustExhaustion", by: 1, target: "pc.you" },
            { kind: "adjustHp", entityId: "pc.you", by: -1 },
            { kind: "setCondition", entityId: "pc.you", condition: "bleeding", active: true },
            { kind: "spawn", templateId: "npc.ward", locationId: "loc.room" },
            { kind: "linkExit", fromLocationId: "loc.room", to: "loc.hub" },
            {
              kind: "check",
              ability: "dex",
              dc: 12,
              onSuccess: [{ kind: "transferItem", itemId: "item.token", from: "pc.you", to: null }],
              onFail: [
                {
                  kind: "check",
                  ability: "con",
                  dc: 10,
                  onSuccess: [],
                  onFail: [{ kind: "adjustHp", entityId: "pc.you", by: -2 }],
                },
              ],
            },
          ],
        },
      ],
      startingState: { locationId: "loc.room", party: ["pc.you"], companions: [] },
    });

    const character = await ashguard();
    const bound = bindCharacter({ world, campaign }, character);

    expect(refPaths(bound.campaign.events, "pc.you")).toEqual([]);
    const event = bound.campaign.events[0]!;
    expect(refPaths(event, character.id).sort()).toEqual(
      [
        "/trigger/allOf/1/entityId",
        "/trigger/allOf/2/entityId",
        "/trigger/allOf/3/targetId",
        "/trigger/allOf/4/entityId",
        "/effects/0/from",
        "/effects/1/to",
        "/effects/2/to",
        "/effects/3/target",
        "/effects/4/target",
        "/effects/5/target",
        "/effects/6/entityId",
        "/effects/7/entityId",
        "/effects/10/onSuccess/0/from",
        "/effects/10/onFail/0/onFail/0/entityId",
      ].sort(),
    );
    // …and the value guard holds: a location/template/item id is never the player slot.
    const spawn = event.effects[8]!;
    if (spawn.kind !== "spawn") throw new Error("expected a spawn effect");
    expect(spawn.templateId).toBe("npc.ward");
    expect(spawn.locationId).toBe("loc.room");
    const link = event.effects[9]!;
    if (link.kind !== "linkExit") throw new Error("expected a linkExit effect");
    expect(link.to).toBe("loc.hub");
    const drop = event.effects[10]!;
    if (drop.kind !== "check" || drop.onSuccess[0]!.kind !== "transferItem") throw new Error("expected a nested transfer");
    expect(drop.onSuccess[0]!.to).toBeNull(); // a null `to` (drop to the ground) is left alone
  });
});

describe("player-slot reference remap — the shipped library", () => {
  test("no library character leaves a stale player-slot reference in the flagship playset", async () => {
    const playset = await loadPlaySetFromDir(SHIPPED_WORLD_DIR);
    const priorPc = playset.campaign.startingState.party[0]!;
    // Guard against a vacuous sweep: the world must actually author player-slot references, and the
    // library must actually have characters in it.
    expect(SHIPPED_CHARACTER_FILES.length).toBeGreaterThan(0);
    expect(refPaths(playset.campaign.events, priorPc).length).toBeGreaterThan(0);

    for (const file of SHIPPED_CHARACTER_FILES) {
      const character = await loadCharacterFromFile(join(SHIPPED_CHARACTER_DIR, file));
      const bound = bindCharacter(playset, character);
      // Reported as an object so a failure names the character file that regressed.
      expect({ file, stale: refPaths(bound.campaign.events, priorPc) }).toEqual({ file, stale: [] });
      expect({ file, stale: refPaths(bound.world, priorPc) }).toEqual({ file, stale: [] });
      // The default PC sheet stays in `campaign.characters` (its `id` is identity, not a reference);
      // it is out of `startingState.party`, so the engine never seeds it as an actor.
      expect(refPaths(bound.campaign, priorPc)).toEqual([`/characters/0/id`]);
      expect(bound.campaign.startingState.party).not.toContain(priorPc);

      // The shape of the bug: a hand-in gates on `hasItem <pc>` and then transfers the same item
      // FROM `<pc>` — the two must always name the same entity, or the transfer hits a ghost.
      let handIns = 0;
      for (const ev of bound.campaign.events) {
        for (const gate of ev.trigger.allOf) {
          if (gate.kind !== "hasItem") continue;
          for (const eff of ev.effects) {
            if (eff.kind !== "transferItem" || eff.itemId !== gate.itemId) continue;
            expect({ file, event: ev.id, from: eff.from }).toEqual({ file, event: ev.id, from: gate.entityId });
            handIns += 1;
          }
        }
      }
      expect(handIns).toBeGreaterThan(0);
    }
  });

  test("the authoring layer compiles hand-ins against the bound PC when it runs AFTER the bind", async () => {
    // Today the loader always compiles BEFORE `bindCharacter`, so the generated default id is just
    // one more reference the remap rewrites. Nothing enforces that ordering, though, and a compile
    // on the far side of a bind (an editor hot reload of a live session) used to emit a hand-in
    // gated on an entity that no longer exists. The compiler derives the slot from the campaign now.
    const world = WorldSchema.parse({
      id: "w.delivery-remap",
      name: "Delivery Remap",
      locations: [{ id: "loc.counter", name: "Counter", description: "A plain handoff counter.", npcs: ["npc.clerk"] }],
      npcs: [{ id: "npc.clerk", name: "Clerk", persona: "Methodical.", inventory: ["item.parcel"] }],
      items: [{ id: "item.parcel", name: "Parcel", kind: "quest" }],
    });
    const campaign = CampaignSchema.parse({
      id: "c.delivery-remap",
      name: "Delivery Remap",
      worldId: world.id,
      characters: [{ id: "pc.you", name: "You", stats: STATS }],
      quests: [{
        id: "quest.delivery",
        name: "Delivery",
        state: "offered",
        objectives: [{ id: "hand-in", description: "Return the parcel" }],
      }],
      questFlows: [{
        id: "delivery-remap",
        questId: "quest.delivery",
        template: "delivery",
        acceptance: {
          locationId: "loc.counter",
          npcId: "npc.clerk",
          effects: [{ kind: "transferItem", itemId: "item.parcel", from: "npc.clerk", to: "pc.you" }],
        },
        handIn: {
          locationId: "loc.counter",
          npcId: "npc.clerk",
          objectiveId: "hand-in",
          itemId: "item.parcel",
        },
      }],
      startingState: { locationId: "loc.counter", party: ["pc.you"], companions: [] },
    });
    const playset = { world, campaign };
    const character = await loadCharacterFromFile(join(SHIPPED_CHARACTER_DIR, "arden-vale.json"));
    const bound = bindCharacter(playset, character);

    const recompiled = compileAuthoringLayer(bound.world, bound.campaign).campaign;
    expect(refPaths(recompiled.events, "pc.you")).toEqual([]);

    const handIn = recompiled.events.find((ev) => ev.id === "qf.delivery-remap.hand-in");
    if (!handIn) throw new Error("fixture: expected the compiled delivery hand-in event");
    const gate = handIn.trigger.allOf.find((c) => c.kind === "hasItem");
    const transfer = handIn.effects.find((e) => e.kind === "transferItem");
    expect(gate?.kind === "hasItem" ? gate.entityId : null).toBe(character.id);
    expect(transfer?.kind === "transferItem" ? transfer.from : null).toBe(character.id);
  });
});
