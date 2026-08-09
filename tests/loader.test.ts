/**
 * Loader integrity tests — prebaked-event reference validation. A typo in an event's trigger
 * or effect must fail loudly at load (naming the event id + bad ref), not silently misbehave
 * mid-session. The bundled thistledown events must still pass. Deterministic, no network.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadPlaySetFromDir, validateReferences } from "../src/content/loader.ts";
import { CampaignSchema, WorldSchema, type Campaign, type PrebakedEvent, type World } from "../src/content/schema.ts";

function thistledown(): Promise<{ world: World; campaign: Campaign }> {
  return loadPlaySetFromDir(fileURLToPath(new URL("fixtures/worlds/thistledown", import.meta.url)));
}

function blackConcord(): Promise<{ world: World; campaign: Campaign }> {
  return loadPlaySetFromDir(fileURLToPath(new URL("fixtures/worlds/black-concord", import.meta.url)));
}

/** Re-validate the world/campaign with `events` swapped for a hand-built set. */
function withEvents(world: World, campaign: Campaign, events: PrebakedEvent[]): () => void {
  return () => validateReferences(world, { ...campaign, events });
}

const event = (over: Partial<PrebakedEvent>): PrebakedEvent => ({
  id: "ev.test",
  when: "onEnterLocation",
  trigger: { allOf: [] },
  effects: [],
  once: "campaign",
  ...over,
});

describe("prebaked-event reference validation", () => {
  test("the bundled thistledown events validate", async () => {
    const { world, campaign } = await thistledown();
    expect(() => validateReferences(world, campaign)).not.toThrow();
  });

  test("the black-concord stress world validates", async () => {
    const { world, campaign } = await blackConcord();
    expect(() => validateReferences(world, campaign)).not.toThrow();
    expect(world.lore.some((l) => l.tags.includes("secret"))).toBe(true);
    expect(world.locations.some((l) => l.exits.some((e) => e.hidden || e.locked))).toBe(true);
    expect(campaign.events.length).toBeGreaterThan(0);
  });

  test("a trigger atLocation to an unknown location fails, naming event + ref", async () => {
    const { world, campaign } = await thistledown();
    expect(
      withEvents(world, campaign, [
        event({ trigger: { allOf: [{ kind: "atLocation", locationId: "loc.nowhere" }] } }),
      ]),
    ).toThrow(/ev\.test.*loc\.nowhere/);
  });

  test("a trigger attireState with an unknown entity fails; a real entity and the PC default pass", async () => {
    const { world, campaign } = await thistledown();
    expect(
      withEvents(world, campaign, [
        event({ trigger: { allOf: [{ kind: "attireState", entityId: "npc.ghost", state: "bare" }] } }),
      ]),
    ).toThrow(/ev\.test.*unknown entity "npc\.ghost"/);
    expect(
      withEvents(world, campaign, [
        event({ trigger: { allOf: [{ kind: "attireState", entityId: world.npcs[0]!.id, state: "bare" }] } }),
      ]),
    ).not.toThrow();
    // entityId absent = the runtime's read-the-PC default — nothing to resolve.
    expect(
      withEvents(world, campaign, [
        event({ trigger: { allOf: [{ kind: "attireState", state: "disheveled" }] } }),
      ]),
    ).not.toThrow();
  });

  test("an effect setQuestState to an unknown quest fails", async () => {
    const { world, campaign } = await thistledown();
    expect(
      withEvents(world, campaign, [
        event({ effects: [{ kind: "setQuestState", questId: "quest.ghost", state: "active" }] }),
      ]),
    ).toThrow(/unknown quest "quest\.ghost"/);
  });

  test("an effect setObjectiveDone to an unknown objective of a real quest fails", async () => {
    const { world, campaign } = await thistledown();
    expect(
      withEvents(world, campaign, [
        event({
          effects: [
            { kind: "setObjectiveDone", questId: "quest.souring-ward", objectiveId: "obj.ghost", done: true },
          ],
        }),
      ]),
    ).toThrow(/unknown objective "obj\.ghost"/);
  });

  test("a spawn effect with an unknown template fails", async () => {
    const { world, campaign } = await thistledown();
    expect(
      withEvents(world, campaign, [
        event({ effects: [{ kind: "spawn", templateId: "mon.ghost", locationId: "loc.barrow", tier: "transient" }] }),
      ]),
    ).toThrow(/unknown template "mon\.ghost"/);
  });

  test("a spawn effect to an unknown location fails", async () => {
    const { world, campaign } = await thistledown();
    expect(
      withEvents(world, campaign, [
        event({ effects: [{ kind: "spawn", templateId: "mon.boggart", locationId: "loc.void", tier: "transient" }] }),
      ]),
    ).toThrow(/unknown location "loc\.void"/);
  });

  test("an adjustHp effect on an unknown entity fails", async () => {
    const { world, campaign } = await thistledown();
    expect(
      withEvents(world, campaign, [event({ effects: [{ kind: "adjustHp", entityId: "npc.ghost", by: -1 }] })]),
    ).toThrow(/unknown entity "npc\.ghost"/);
  });

  test("a hasItem trigger with an unknown item fails", async () => {
    const { world, campaign } = await thistledown();
    expect(
      withEvents(world, campaign, [
        event({ trigger: { allOf: [{ kind: "hasItem", entityId: "pc.you", itemId: "item.ghost" }] } }),
      ]),
    ).toThrow(/unknown item "item\.ghost"/);
  });

  test("a real spawn template (world monster) + real location is accepted", async () => {
    const { world, campaign } = await thistledown();
    expect(
      withEvents(world, campaign, [
        event({
          trigger: { allOf: [{ kind: "atLocation", locationId: "loc.barrow" }] },
          effects: [
            { kind: "spawn", templateId: "mon.barrowwight", locationId: "loc.barrow", tier: "significant" },
            { kind: "adjustRelationship", actorId: "npc.maelle", targetId: "pc.you", by: 1 },
          ],
        }),
      ]),
    ).not.toThrow();
  });
});

describe("NPC schedule validation", () => {
  const pcStats = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

  function schedWorld(schedule: unknown): World {
    return WorldSchema.parse({
      id: "w.sched",
      name: "Schedworld",
      summary: "Test.",
      locations: [{ id: "loc.a", name: "A" }],
      npcs: [{ id: "npc.s", name: "S", persona: "Test.", age: 30, schedule }],
    });
  }
  const schedCampaign: Campaign = CampaignSchema.parse({
    id: "c.sched",
    name: "Sched Campaign",
    worldId: "w.sched",
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: "loc.a", party: ["pc.you"] },
  });

  test("a slot referencing an unknown location fails, naming npc + ref", () => {
    const world = schedWorld({ slots: [{ phases: ["morning"], locationId: "loc.nowhere" }] });
    expect(() => validateReferences(world, schedCampaign)).toThrow(/npc\.s.*loc\.nowhere/);
  });

  test("an unknown defaultLocationId fails", () => {
    const world = schedWorld({
      slots: [{ phases: ["morning"], locationId: "loc.a" }],
      defaultLocationId: "loc.ghost",
    });
    expect(() => validateReferences(world, schedCampaign)).toThrow(/defaultLocationId.*loc\.ghost/);
  });

  test("a slot condition naming an unknown quest fails", () => {
    const world = schedWorld({
      slots: [
        {
          phases: ["morning"],
          locationId: "loc.a",
          conditions: [{ kind: "questState", questId: "quest.none", state: "active" }],
        },
      ],
    });
    expect(() => validateReferences(world, schedCampaign)).toThrow(/condition questState.*quest\.none/);
  });

  test("schedule authoring parses with defaults (weight 1, variance 0, venue false, daily)", () => {
    const world = schedWorld({ slots: [{ phases: ["morning"], locationId: "loc.a" }] });
    const sched = world.npcs[0]!.schedule!;
    expect(sched.variance).toBe(0);
    expect(sched.slots[0]).toEqual({
      phases: ["morning"],
      locationId: "loc.a",
      activity: "",
      weight: 1,
      conditions: [],
      venue: false,
    });
    // A schedule-less NPC stays schedule-less (optional, never defaulted in).
    const bare = WorldSchema.parse({
      id: "w.bare",
      name: "Bare",
      summary: "Test.",
      locations: [{ id: "loc.a", name: "A" }],
      npcs: [{ id: "npc.b", name: "B", persona: "Test.", age: 30 }],
    });
    expect(bare.npcs[0]!.schedule).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Regex audit §10c — the authored surfaces `validateEventReferences` never walked, and the clause
// kinds `validateConditions` had no case for. Each input below was reproduced LOADING GREEN against
// the shipped loader (on the example fixture) before this batch; the neighbouring `atLocation`
// clause, which the loader did check, was rejected in the same run.
// ---------------------------------------------------------------------------------------------

describe("§10c — barrier / work / region / faction reference validation", () => {
  const pcStats10c = {
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    maxHp: 10,
    armorClass: 10,
  };
  const campaign10c: Campaign = CampaignSchema.parse({
    id: "c.10c",
    name: "§10c Campaign",
    worldId: "w.10c",
    characters: [{ id: "pc.you", name: "You", stats: pcStats10c, age: 30 }],
    startingState: { locationId: "loc.a", party: ["pc.you"] },
  });
  /** Two rooms, one real item, one real faction, one real region — plus whatever the case overrides. */
  const world10c = (over: Record<string, unknown>): World =>
    WorldSchema.parse({
      id: "w.10c",
      name: "§10c World",
      summary: "Test.",
      items: [{ id: "item.real-key", name: "A real key" }],
      factions: [{ id: "faction.real", name: "Real Guild" }],
      regions: [{ id: "r.real", name: "Real Region" }],
      locations: [
        { id: "loc.a", name: "A", region: "r.real" },
        { id: "loc.b", name: "B" },
      ],
      ...over,
    });
  /** `loc.a` with a barred exit to `loc.b`. */
  const withBarrier = (barrier: Record<string, unknown>): World =>
    world10c({
      locations: [
        { id: "loc.a", name: "A", region: "r.real", exits: [{ to: "loc.b", barrier }] },
        { id: "loc.b", name: "B" },
      ],
    });
  /** `loc.a` as a guild hall carrying one gated shift. */
  const withWorkGate = (requires: unknown): World =>
    world10c({
      locations: [
        {
          id: "loc.a",
          name: "A",
          region: "r.real",
          guild: { name: "Hall" },
          work: [{ id: "work.shift", label: "A shift", ability: "str", dc: 10, wageCp: 10, requires }],
        },
        { id: "loc.b", name: "B" },
      ],
    });

  test("Exit.barrier.keyItemId must name a real item — and a real one passes", () => {
    expect(() => validateReferences(withBarrier({ kind: "gate", keyItemId: "item.nope" }), campaign10c)).toThrow(
      /barrier keyItemId references unknown item "item\.nope"/,
    );
    expect(() =>
      validateReferences(withBarrier({ kind: "gate", keyItemId: "item.real-key" }), campaign10c),
    ).not.toThrow();
  });

  test("Exit.barrier.condition is walked like any other predicate", () => {
    expect(() =>
      validateReferences(
        withBarrier({ kind: "gate", condition: { allOf: [{ kind: "atLocation", locationId: "loc.nope" }] } }),
        campaign10c,
      ),
    ).toThrow(/barrier condition atLocation references unknown location "loc\.nope"/);
    expect(() =>
      validateReferences(
        withBarrier({ kind: "gate", condition: { allOf: [{ kind: "atLocation", locationId: "loc.b" }] } }),
        campaign10c,
      ),
    ).not.toThrow();
  });

  test("Work.requires is walked — the hasItem gate the board used to ignore entirely", () => {
    expect(() =>
      validateReferences(withWorkGate({ allOf: [{ kind: "hasItem", entityId: "pc.you", itemId: "item.nope" }] }), campaign10c),
    ).toThrow(/work "work\.shift" requires hasItem references unknown item "item\.nope"/);
    expect(() =>
      validateReferences(
        withWorkGate({ allOf: [{ kind: "hasItem", entityId: "pc.you", itemId: "item.real-key" }] }),
        campaign10c,
      ),
    ).not.toThrow();
  });

  test("inRegion resolves against authored regions AND the region ids locations actually carry", () => {
    const trigger = (regionId: string) => [
      event({ trigger: { allOf: [{ kind: "inRegion", regionId }] } }),
    ];
    expect(() => validateReferences(world10c({}), { ...campaign10c, events: trigger("region.nope") })).toThrow(
      /trigger inRegion references unknown region "region\.nope"/,
    );
    expect(() => validateReferences(world10c({}), { ...campaign10c, events: trigger("r.real") })).not.toThrow();
    // A location tagged with a region that has no `regions[]` row is legitimate content (several
    // fixtures do it) — `regionOfLocation` reads the location's own field, so the id is real.
    const undeclared = world10c({
      locations: [
        { id: "loc.a", name: "A", region: "r.undeclared" },
        { id: "loc.b", name: "B" },
      ],
    });
    expect(() => validateReferences(undeclared, { ...campaign10c, events: trigger("r.undeclared") })).not.toThrow();
  });

  test("factionStandingAtLeast resolves against the faction roster", () => {
    const trigger = (factionId: string) => [
      event({ trigger: { allOf: [{ kind: "factionStandingAtLeast", factionId, value: 20 }] } }),
    ];
    expect(() => validateReferences(world10c({}), { ...campaign10c, events: trigger("faction.nope") })).toThrow(
      /trigger factionStandingAtLeast references unknown faction "faction\.nope"/,
    );
    expect(() => validateReferences(world10c({}), { ...campaign10c, events: trigger("faction.real") })).not.toThrow();
  });

  test("the id-less vulnerability clauses stay legal (they name nothing to resolve)", () => {
    const clauses: PrebakedEvent["trigger"]["allOf"] = [
      { kind: "dayPhase", phases: ["night"] },
      { kind: "partyAlone" },
      { kind: "regionDangerAtLeast", value: 2 },
    ];
    for (const c of clauses) {
      expect(() =>
        validateReferences(world10c({}), { ...campaign10c, events: [event({ trigger: { allOf: [c] } })] as never }),
      ).not.toThrow();
    }
  });
});
