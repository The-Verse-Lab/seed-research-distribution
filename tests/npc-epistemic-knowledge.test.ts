/**
 * Epistemic layer, first slice (NPC-EPISTEMIC-CONTEXT-PLAN Phases 1+3+4 core): world facts +
 * structured knowledge schemas, loader integrity, plausible access, temporal priority, and
 * disclosure filtering — all deterministic, no model in the loop.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  CampaignSchema,
  NpcKnowledgeEntrySchema,
  NpcTemplateSchema,
  WorldFactSchema,
  WorldSchema,
  type World,
  type WorldFact,
} from "../src/content/schema.ts";
import { compileAndValidatePlaySet } from "../src/content/loader.ts";
import { canAccessFact, hasExplicitGrant, npcHomeRegion } from "../src/knowledge/access.ts";
import { knowledgeStatements, structuredKnowledgeOf } from "../src/knowledge/facts.ts";
import { isCurrentFact, isHistoricalFact, selectForTimeframe } from "../src/knowledge/temporal.ts";
import { composeEpistemicPacket } from "../src/knowledge/packet.ts";
import { renderEpistemicBlocks } from "../src/knowledge/render.ts";
import type { KnowledgeAsk } from "../src/knowledge/types.ts";

// --- Fixture world: one region with a current hall, a defunct predecessor, a faction secret ----

function fixtureWorld(): World {
  return WorldSchema.parse({
    id: "w.epi",
    name: "Harborfall",
    summary: "A test harbor.",
    facts: [
      {
        id: "fact.hall.current",
        statement: "The Ledger-House is the working contract hall in Harborfall today.",
        subjectIds: ["loc.harbor"],
        domains: ["guilds", "work"],
        kind: "current",
        scope: { locationIds: ["loc.harbor"], regionIds: ["harbor"] },
        access: "local",
      },
      {
        id: "fact.hall.old",
        statement: "The Old Wardens' Hall ran Harborfall's contracts for a century.",
        subjectIds: ["loc.harbor"],
        domains: ["guilds", "history"],
        kind: "defunct",
        scope: { regionIds: ["harbor"] },
        access: "local",
        supersededBy: "fact.hall.current",
      },
      {
        id: "fact.tide.cartel",
        statement: "The Tide Cartel sets every berth fee in the harbor.",
        subjectIds: ["faction.tide"],
        domains: ["trade"],
        kind: "current",
        scope: { factionIds: ["faction.tide"] },
        access: "faction",
      },
      {
        id: "fact.glass.secret",
        statement: "The glassworks' furnace-song formula is held by three masters.",
        domains: ["glasscraft"],
        kind: "current",
        access: "professional",
      },
      {
        id: "fact.harbor.rumor",
        statement: "They say a drowned bell rings under the pier on still nights.",
        domains: ["guilds", "harbor"],
        kind: "rumor",
        access: "common",
      },
    ],
    factions: [{ id: "faction.tide", name: "Tide Cartel" }],
    locations: [
      { id: "loc.harbor", name: "Harborfall Quay", description: "Salt and rope.", region: "harbor", npcs: ["npc.local", "npc.member", "npc.glasswright"] },
      { id: "loc.inland", name: "Inland Stead", description: "Dry fields.", region: "inland", npcs: ["npc.farmhand"] },
    ],
    npcs: [
      { id: "npc.local", name: "Quaywoman", persona: "Local." },
      { id: "npc.member", name: "Cartel Clerk", persona: "Member.", factionId: "faction.tide" },
      {
        id: "npc.glasswright",
        name: "Glasswright",
        persona: "Expert.",
        knowledge: [{ statement: "You apprenticed under the furnace-masters.", domains: ["glasscraft"] }],
      },
      { id: "npc.farmhand", name: "Farmhand", persona: "Far away." },
    ],
  });
}

describe("schemas — facts + structured knowledge parse (legacy stays valid)", () => {
  test("WorldFactSchema applies defaults; mixed knowledge[] parses strings and entries", () => {
    const fact = WorldFactSchema.parse({ id: "fact.x", statement: "X stands." });
    expect(fact.kind).toBe("current");
    expect(fact.access).toBe("common");
    expect(fact.scope.locationIds).toEqual([]);

    const npc = NpcTemplateSchema.parse({
      id: "npc.n",
      name: "N",
      persona: "P.",
      knowledge: ["a plain line", { statement: "a structured line", disclosure: { mode: "asked-only" } }],
      privateKnowledge: [{ statement: "a guarded line", disclosure: { mode: "trust", minFriendship: 40 } }],
      gmTruth: "N does not know their patron is dead.",
    });
    expect(knowledgeStatements(npc.knowledge)).toEqual(["a plain line", "a structured line"]);
    expect(structuredKnowledgeOf(npc)).toHaveLength(1);
    expect(npc.privateKnowledge?.[0]?.disclosure.minFriendship).toBe(40);
  });

  test("guarded statements never fold into the flat retrieval surface", () => {
    const entries = [
      "open line",
      NpcKnowledgeEntrySchema.parse({ statement: "trust-gated", disclosure: { mode: "trust" } }),
      NpcKnowledgeEntrySchema.parse({ statement: "never-told", disclosure: { mode: "never" } }),
      NpcKnowledgeEntrySchema.parse({ statement: "misdirected", disclosure: { mode: "misdirect" } }),
      NpcKnowledgeEntrySchema.parse({ statement: "reluctant-but-tellable", disclosure: { mode: "reluctant" } }),
    ];
    expect(knowledgeStatements(entries)).toEqual(["open line", "reluctant-but-tellable"]);
  });

  test("a world with no facts field re-serializes without one (byte-compat posture)", () => {
    const world = WorldSchema.parse({ id: "w.n", name: "N", locations: [], npcs: [] });
    expect("facts" in JSON.parse(JSON.stringify(world))).toBe(false);
  });
});

describe("loader — epistemic integrity fails loud", () => {
  const campaignFor = (worldId: string) =>
    CampaignSchema.parse({
      id: "c.epi",
      name: "C",
      worldId,
      characters: [{ id: "pc.you", name: "You", stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 }, age: 30 }],
      startingState: { locationId: "loc.harbor", party: ["pc.you"], companions: [] },
    });

  const compile = (mutate: (w: World) => void): (() => void) => {
    const world = fixtureWorld();
    mutate(world);
    return () => compileAndValidatePlaySet({ world, campaign: campaignFor(world.id) });
  };

  test("the clean fixture compiles", () => {
    expect(compile(() => {})).not.toThrow();
  });

  test("duplicate fact ids fail", () => {
    expect(
      compile((w) => w.facts?.push({ ...(w.facts[0] as WorldFact) })),
    ).toThrow(/declared twice/);
  });

  test("unknown supersededBy fails; a supersession cycle fails", () => {
    expect(
      compile((w) => {
        (w.facts![1] as WorldFact).supersededBy = "fact.ghost";
      }),
    ).toThrow(/unknown fact "fact.ghost"/);
    expect(
      compile((w) => {
        (w.facts![0] as WorldFact).supersededBy = "fact.hall.old"; // old already points at current
      }),
    ).toThrow(/supersession cycle/);
  });

  test("unknown scope/subject ids fail", () => {
    expect(
      compile((w) => (w.facts![0] as WorldFact).scope.locationIds.push("loc.ghost")),
    ).toThrow(/unknown location "loc.ghost"/);
    expect(
      compile((w) => (w.facts![0] as WorldFact).scope.regionIds.push("nowhere")),
    ).toThrow(/unknown region "nowhere"/);
    expect(
      compile((w) => (w.facts![0] as WorldFact).subjectIds.push("npc.ghost")),
    ).toThrow(/unknown entity "npc.ghost"/);
  });

  test("a knowledge grant with neither factId nor statement fails; an unknown factId fails", () => {
    expect(
      compile((w) => w.npcs[0]!.knowledge.push({ domains: ["x"] } as never)),
    ).toThrow(/neither a factId nor a statement/);
    expect(
      compile((w) => w.npcs[0]!.knowledge.push({ factId: "fact.ghost" } as never)),
    ).toThrow(/unknown world fact "fact.ghost"/);
  });
});

describe("access — plausible knowledge is gated in code", () => {
  const world = fixtureWorld();
  const local = world.npcs.find((n) => n.id === "npc.local")!;
  const member = world.npcs.find((n) => n.id === "npc.member")!;
  const glasswright = world.npcs.find((n) => n.id === "npc.glasswright")!;
  const farmhand = world.npcs.find((n) => n.id === "npc.farmhand")!;
  const fact = (id: string): WorldFact => world.facts!.find((f) => f.id === id)!;

  test("home region grants local facts; a distant farmhand is refused", () => {
    expect(npcHomeRegion(world, "npc.local")).toBe("harbor");
    expect(canAccessFact(world, local, fact("fact.hall.current"))).toBe(true);
    expect(canAccessFact(world, farmhand, fact("fact.hall.current"))).toBe(false);
  });

  test("faction facts reach members, not outsiders", () => {
    expect(canAccessFact(world, member, fact("fact.tide.cartel"))).toBe(true);
    expect(canAccessFact(world, local, fact("fact.tide.cartel"))).toBe(false);
  });

  test("professional facts require a shared domain; restricted requires an explicit grant", () => {
    expect(canAccessFact(world, glasswright, fact("fact.glass.secret"))).toBe(true);
    expect(canAccessFact(world, local, fact("fact.glass.secret"))).toBe(false);

    const restricted = WorldFactSchema.parse({ id: "fact.vault", statement: "The vault key hides in the well.", access: "restricted" });
    expect(canAccessFact(world, local, restricted)).toBe(false);
    const keeper = NpcTemplateSchema.parse({ id: "npc.keeper", name: "K", persona: "K.", knowledge: [{ factId: "fact.vault" }] });
    expect(hasExplicitGrant(keeper, "fact.vault")).toBe(true);
    expect(canAccessFact(world, keeper, restricted)).toBe(true);
  });

  test("a visiting outsider gains local access through the CURRENT region", () => {
    expect(canAccessFact(world, farmhand, fact("fact.hall.current"), { currentRegionId: "harbor" })).toBe(true);
  });
});

describe("temporal — current answers current; history answers history", () => {
  const world = fixtureWorld();
  const facts = world.facts!.filter((f) => f.kind !== "rumor");

  test("classification: superseded/ended facts are history, whatever their authored kind", () => {
    expect(isCurrentFact(world.facts![0]!)).toBe(true);
    expect(isHistoricalFact(world.facts![1]!)).toBe(true);
    const ended = WorldFactSchema.parse({ id: "f.e", statement: "S.", kind: "current", validUntil: "last winter" });
    expect(isCurrentFact(ended)).toBe(false);
    expect(isHistoricalFact(ended)).toBe(true);
  });

  test("a current ask answers from current facts; the defunct hall is context only", () => {
    const { answer, context } = selectForTimeframe(facts, "current");
    expect(answer.map((f) => f.id)).toContain("fact.hall.current");
    expect(answer.map((f) => f.id)).not.toContain("fact.hall.old");
    expect(context.map((f) => f.id)).toContain("fact.hall.old");
  });

  test("a historical ask answers from the defunct chain; current is contrast", () => {
    const { answer, context } = selectForTimeframe(facts, "historical");
    expect(answer.map((f) => f.id)).toContain("fact.hall.old");
    expect(context.map((f) => f.id)).toContain("fact.hall.current");
  });

  test("the unspecified default behaves as current (invariant 5)", () => {
    const { answer } = selectForTimeframe(facts, "any");
    expect(answer.map((f) => f.id)).toContain("fact.hall.current");
    expect(answer.map((f) => f.id)).not.toContain("fact.hall.old");
  });
});

describe("packet + disclosure — knowing is not volunteering", () => {
  const ask: KnowledgeAsk = { kind: "current-location", timeframe: "current", locality: "nearby" };

  const packetFor = (line: string, friendship?: number, askOverride?: KnowledgeAsk) => {
    const world = fixtureWorld();
    world.npcs[0]!.privateKnowledge = [
      {
        statement: "You watched the Wardens' charter burn: the harbormaster sold their ledger to the cartel.",
        topic: "why the Old Wardens' Hall fell",
        domains: ["guilds", "history", "wardens"],
        familiarity: "firsthand",
        certainty: "certain",
        disclosure: { mode: "trust", minFriendship: 50, reason: "it would cost her neck" },
        source: undefined,
        learnedAt: undefined,
        lastConfirmedAt: undefined,
        factId: undefined,
      },
    ];
    return composeEpistemicPacket({
      world,
      npcTemplateId: "npc.local",
      npcName: "Quaywoman",
      playerLine: line,
      ask: askOverride ?? ask,
      friendship,
      locationId: "loc.harbor",
      adjacentLocationIds: [],
    });
  };

  test("a current guild question selects the current hall; the defunct hall is marked history", () => {
    const packet = packetFor("Where is the closest guild hall?");
    expect(packet.authoritative.map((l) => l.id)).toContain("fact.hall.current");
    expect(packet.authoritative.map((l) => l.id)).not.toContain("fact.hall.old");
    expect(packet.history.map((l) => l.id)).toContain("fact.hall.old");
    const rendered = renderEpistemicBlocks(packet);
    const current = rendered.answerFacts.find((l) => l.includes("Ledger-House"))!;
    const old = rendered.answerFacts.find((l) => l.includes("Old Wardens' Hall"))!;
    expect(current).toBeDefined();
    expect(old).toContain("no longer true — history only");
    expect(rendered.answerFacts.indexOf(current)).toBeLessThan(rendered.answerFacts.indexOf(old));
  });

  test("rumor-kind facts render only as qualified hearsay", () => {
    const packet = packetFor("What do the guild folk say about the harbor at night?");
    expect(packet.beliefs.map((l) => l.id)).toContain("fact.harbor.rumor");
    const rendered = renderEpistemicBlocks(packet);
    expect(rendered.answerFacts.some((l) => l.includes("you have only heard this") && l.includes("drowned bell"))).toBe(true);
  });

  test("low trust: the secret stays out; only a topic cue enters the disclosure block", () => {
    const packet = packetFor("Why did the Old Wardens' Hall fall, truly?", 10, {
      kind: "explanation",
      timeframe: "historical",
      locality: "here",
    });
    const everything = JSON.stringify([packet.authoritative, packet.history, packet.beliefs]);
    expect(everything).not.toContain("harbormaster sold");
    expect(packet.disclosureConstraints.some((c) => c.includes("why the Old Wardens' Hall fell"))).toBe(true);
    expect(packet.disclosureConstraints.join(" ")).not.toContain("harbormaster sold");
  });

  test("at/above the trust floor the secret becomes speakable — when asked about", () => {
    const packet = packetFor("Why did the Old Wardens' Hall fall, truly?", 60, {
      kind: "explanation",
      timeframe: "historical",
      locality: "here",
    });
    expect(packet.authoritative.some((l) => l.text.includes("harbormaster sold"))).toBe(true);
    expect(packet.disclosureConstraints).toHaveLength(0);
  });

  test("an unrelated question never surfaces the secret OR its cue", () => {
    const packet = packetFor("Lovely weather on the quay today, no?", 10);
    const everything = JSON.stringify(packet);
    expect(everything).not.toContain("harbormaster sold");
    expect(everything).not.toContain("Old Wardens' Hall fell");
  });

  test("unknown is a valid answer: a framed question with nothing behind it says so", () => {
    const world = fixtureWorld();
    const packet = composeEpistemicPacket({
      world,
      npcTemplateId: "npc.farmhand",
      npcName: "Farmhand",
      playerLine: "Where can I buy a ship's chronometer?",
      ask: { kind: "current-service", timeframe: "current", locality: "here" },
      locationId: "loc.inland",
      adjacentLocationIds: [],
    });
    expect(packet.authoritative).toHaveLength(0);
    expect(packet.unknowns.length).toBe(1);
    expect(packet.unknowns[0]).toContain("do not invent");
  });

  test("an unframed small-talk line composes an EMPTY packet (byte-identical prompts)", () => {
    const world = fixtureWorld();
    const packet = composeEpistemicPacket({
      world,
      npcTemplateId: "npc.farmhand",
      npcName: "Farmhand",
      playerLine: "Good morning to you.",
      locationId: "loc.inland",
      adjacentLocationIds: [],
    });
    const rendered = renderEpistemicBlocks(packet);
    expect(rendered.answerFacts).toHaveLength(0);
    expect(rendered.disclosure).toHaveLength(0);
  });
});
