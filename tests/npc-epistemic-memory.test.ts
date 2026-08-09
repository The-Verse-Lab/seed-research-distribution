/**
 * Phase 5 — query-aware memory recall + runtime learned knowledge (NPC-EPISTEMIC-CONTEXT-PLAN
 * §12): an old betrayal outranks recent small talk when trust is the question; a spoken canonical
 * fact teaches the co-located listeners (and nobody absent) through the reducer; learning is
 * replay-safe (snapshot == fold(deltas)) so a rewind discards exactly the discarded tail.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { BRIEF_MARKERS } from "../src/util/markers.ts";
import type { CompletionChunk, CompletionRequest, LlmRole } from "../src/llm/types.ts";
import { fromGameState } from "../src/world/model.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { applyDelta } from "../src/world/replay.ts";
import type { DeltaEvent } from "../src/events/deltas.ts";
import { recallForQuery } from "../src/modules/npc-memory/state.ts";
import type { NpcMemoryEntry } from "../src/rules/npc-memory.ts";
import { readLearnedFacts } from "../src/rules/npc-knowledge.ts";
import { composeEpistemicPacket } from "../src/knowledge/packet.ts";
import { groundUsedFactIds, renderEpistemicBlocks } from "../src/knowledge/render.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { KnowledgeAsk } from "../src/knowledge/types.ts";
import { freeformPlan } from "../src/engine/turn-plan.ts";

async function emberfordModel() {
  const playset = await loadPlaySetFromDir(fileURLToPath(new URL("fixtures/worlds/example", import.meta.url)));
  const engine = new GameEngine({
    classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
  });
  await engine.start();
  return { playset, model: fromGameState(engine.getState(), playset.world, playset.campaign) };
}

describe("query-aware recall (§12.1)", () => {
  const betrayal: NpcMemoryEntry = {
    at: 100,
    kind: "relationship",
    summary: "Brann broke his sworn word to you over the cellar ledger.",
    subjectIds: ["npc.brann"],
    domains: ["trust", "betrayal"],
  };
  const smallTalk = (i: number): NpcMemoryEntry => ({
    at: 5000 + i * 10,
    kind: "traveled",
    summary: `Walked the square in the rain (${i}).`,
  });

  async function journalModel() {
    const { model } = await emberfordModel();
    model.modules.npcMemory = {
      entries: { "npc.lyra": [betrayal, ...Array.from({ length: 7 }, (_, i) => smallTalk(i))] },
    };
    model.clock = 6000;
    return model;
  }

  test("an old betrayal outranks recent small talk when trust is asked about", async () => {
    const model = await journalModel();
    const recalled = recallForQuery(model, "npc.lyra", "Can I still trust Brann, after everything?");
    expect(recalled.some((e) => e.summary.includes("broke his sworn word"))).toBe(true);
    // Chronological order is preserved for the prompt.
    const ats = recalled.map((e) => e.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });

  test("a line touching nothing stored degrades to plain recency — the betrayal stays buried", async () => {
    const model = await journalModel();
    const recalled = recallForQuery(model, "npc.lyra", "Lovely evening, is it not?");
    expect(recalled).toHaveLength(6);
    expect(recalled.some((e) => e.summary.includes("broke his sworn word"))).toBe(false);
  });

  test("legacy entries without metadata still rank by their summary tokens", async () => {
    const model = await journalModel();
    const entries = (model.modules.npcMemory as { entries: Record<string, NpcMemoryEntry[]> }).entries;
    entries["npc.lyra"] = [
      { at: 50, kind: "addressed", summary: "You spoke of the drowned mill and its broken wheel." },
      ...Array.from({ length: 7 }, (_, i) => smallTalk(i)),
    ];
    const recalled = recallForQuery(model, "npc.lyra", "What do you know about the drowned mill?");
    expect(recalled.some((e) => e.summary.includes("drowned mill"))).toBe(true);
  });
});

describe("learned knowledge — reducer, replay, rewind (§7.6)", () => {
  test("learnFact records; re-learning only upgrades; the delta folds to the identical slice", async () => {
    const { model } = await emberfordModel();
    const learn = applyCommand(model, {
      type: "learnFact",
      npcId: "npc.brann",
      factId: "fact.x",
      certainty: "rumor",
      sourceKind: "rumor",
    });
    expect(learn.rejected).toBeFalsy();
    expect(learn.deltas).toHaveLength(1);
    expect(readLearnedFacts(model.modules, "npc.brann")["fact.x"]?.certainty).toBe("rumor");

    // Downgrade attempt is a noop (no delta, state unchanged).
    const down = applyCommand(model, {
      type: "learnFact",
      npcId: "npc.brann",
      factId: "fact.x",
      certainty: "rumor",
      sourceKind: "told",
    });
    expect(down.deltas).toHaveLength(0);

    // Upgrade raises certainty but keeps the ORIGINAL learning moment.
    const before = readLearnedFacts(model.modules, "npc.brann")["fact.x"]!.learnedAt;
    const up = applyCommand(model, {
      type: "learnFact",
      npcId: "npc.brann",
      factId: "fact.x",
      certainty: "certain",
      sourceKind: "witnessed",
      sourceId: "pc.you",
    });
    expect(up.deltas).toHaveLength(1);
    const after = readLearnedFacts(model.modules, "npc.brann")["fact.x"]!;
    expect(after.certainty).toBe("certain");
    expect(after.learnedAt).toBe(before);

    // Replay: folding the emitted deltas onto a fresh model reproduces the slice byte-for-byte.
    const { model: fresh } = await emberfordModel();
    for (const d of [...learn.deltas, ...up.deltas]) applyDelta(fresh, d as DeltaEvent);
    expect(readLearnedFacts(fresh.modules, "npc.brann")).toEqual(readLearnedFacts(model.modules, "npc.brann"));

    // Rewind semantics: a fold of the PREFIX (before the learning) simply never contains it.
    const { model: rewound } = await emberfordModel();
    expect(readLearnedFacts(rewound.modules, "npc.brann")["fact.x"]).toBeUndefined();
  });
});

describe("witnessed testimony teaches co-located listeners (§12.3)", () => {
  const testimonyPlayset = (): PlaySet => {
    const world = WorldSchema.parse({
      id: "world.testimony",
      name: "Testimony Fixture",
      facts: [
        {
          id: "fact.fixture",
          statement: "Every service shares responsibility for the blue bridge.",
          domains: ["bridge", "responsibility"],
          access: "common",
        },
      ],
      locations: [
        {
          id: "loc.room",
          name: "Meeting Room",
          description: "A plain room for a public briefing.",
          npcs: ["npc.speaker", "npc.listener"],
        },
        {
          id: "loc.away",
          name: "Archive",
          description: "A separate room beyond earshot.",
          npcs: ["npc.absent"],
        },
      ],
      npcs: [
        {
          id: "npc.speaker",
          name: "Arin",
          persona: "A precise public steward.",
          knowledge: [
            {
              factId: "fact.fixture",
              domains: ["bridge", "responsibility"],
              familiarity: "expert",
              certainty: "certain",
              disclosure: { mode: "open" },
            },
          ],
          autonomy: { isPartyMember: true, level: "reactive" },
        },
        { id: "npc.listener", name: "Bela", persona: "An attentive clerk." },
        { id: "npc.absent", name: "Cato", persona: "An archivist working elsewhere." },
      ],
    });
    const campaign = CampaignSchema.parse({
      id: "campaign.testimony",
      name: "Testimony Fixture",
      worldId: world.id,
      characters: [
        {
          id: "pc.you",
          name: "You",
          stats: {
            abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
            maxHp: 10,
            armorClass: 10,
          },
        },
      ],
      startingState: {
        locationId: "loc.room",
        party: ["pc.you"],
        companions: ["npc.speaker"],
      },
    });
    return { world, campaign };
  };

  /** Narrator gateway: a DIRECT ADDRESS turn answers with a structured intent citing a listed fact. */
  class SpeakingGateway extends OfflineGateway {
    override async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
      const user = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (role === "narrator" && user.includes(BRIEF_MARKERS.directAddress)) {
        yield {
          delta: JSON.stringify({
            speech: [{ say: "Every service shares responsibility for the blue bridge.", mood: "neutral" }],
            factsUsed: ["fact.fixture"],
          }),
          done: false,
        };
        yield { delta: "", done: true };
        return;
      }
      yield* super.stream(role, req);
    }
  }

  const ask: KnowledgeAsk = { kind: "current-location", timeframe: "current", locality: "nearby" };
  const withAsk: TurnClassifier = {
    async classify() {
      return {
        ...freeformPlan(),
        kind: "dialogueToNpc",
        targetId: "npc.speaker",
        knowledgeAsk: ask,
      };
    },
  };

  test("a spoken listed fact lands in every OTHER present NPC's learned slice — and nobody absent", async () => {
    const playset = testimonyPlayset();
    const engine = new GameEngine({
      classifier: withAsk,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new SpeakingGateway(),
      lore: { k: 4, minScore: 0 },
    });
    await engine.start();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    const bystanders = [...model.entities.values()].filter((e) => e.kind === "npc" && e.id === "npc.listener");
    expect(bystanders).toHaveLength(1);

    await engine.submitPlayerInput("Arin, who is responsible for the blue bridge?");
    const modules = engine.getState().modules ?? {};

    for (const b of bystanders) {
      const learned = readLearnedFacts(modules, b.id);
      expect(learned["fact.fixture"]).toBeDefined();
      expect(learned["fact.fixture"]?.sourceKind).toBe("told");
      expect(learned["fact.fixture"]?.sourceId).toBe("npc.speaker");
    }
    // The speaker taught themself nothing, and an absent NPC heard nothing.
    expect(readLearnedFacts(modules, "npc.speaker")["fact.fixture"]).toBeUndefined();
    expect(readLearnedFacts(modules, "npc.absent")["fact.fixture"]).toBeUndefined();
  });

  test("groundUsedFactIds drops hallucinated handles and unlisted ids", () => {
    const world = WorldSchema.parse({
      id: "w.g",
      name: "G",
      facts: [{ id: "fact.a", statement: "A stands true today." }],
      locations: [{ id: "loc.g", name: "G", description: "g", npcs: ["npc.g"] }],
      npcs: [{ id: "npc.g", name: "Gio", persona: "G." }],
    });
    const packet = composeEpistemicPacket({
      world,
      npcTemplateId: "npc.g",
      npcName: "Gio",
      playerLine: "Does A stand true?",
      ask: { kind: "current-status", timeframe: "current", locality: "here" },
      locationId: "loc.g",
      adjacentLocationIds: [],
    });
    const blocks = renderEpistemicBlocks(packet);
    expect(packet.factIds).toEqual(["fact.a"]);
    expect(groundUsedFactIds(["F1"], blocks, packet.factIds)).toEqual(["fact.a"]);
    expect(groundUsedFactIds(["fact.a", "F1"], blocks, packet.factIds)).toEqual(["fact.a"]);
    expect(groundUsedFactIds(["F9", "fact.invented", "not-a-handle"], blocks, packet.factIds)).toEqual([]);
  });
});

describe("learned facts reach the packet at their learned certainty", () => {
  const world = WorldSchema.parse({
    id: "w.l",
    name: "L",
    facts: [
      {
        id: "fact.secret-ford",
        statement: "The hidden ford below the mill crossing is passable at low tide.",
        domains: ["roads"],
        access: "restricted",
      },
    ],
    locations: [{ id: "loc.l", name: "Lowtown", description: "l", npcs: ["npc.l"] }],
    npcs: [{ id: "npc.l", name: "Lonn", persona: "L." }],
  });
  const ask: KnowledgeAsk = { kind: "current-location", timeframe: "current", locality: "nearby" };

  test("unlearned: a restricted fact is simply unknown", () => {
    const packet = composeEpistemicPacket({
      world,
      npcTemplateId: "npc.l",
      npcName: "Lonn",
      playerLine: "Is there a ford below the mill?",
      ask,
      locationId: "loc.l",
      adjacentLocationIds: [],
    });
    expect(JSON.stringify(packet)).not.toContain("hidden ford");
  });

  test("heard as rumor: it enters ONLY as qualified hearsay; told confidently: it answers", () => {
    const base = {
      world,
      npcTemplateId: "npc.l",
      npcName: "Lonn",
      playerLine: "Is there a ford below the mill?",
      ask,
      locationId: "loc.l",
      adjacentLocationIds: [] as string[],
    };
    const rumor = composeEpistemicPacket({
      ...base,
      learned: { "fact.secret-ford": { factId: "fact.secret-ford", certainty: "rumor", sourceKind: "rumor", learnedAt: 10 } },
    });
    expect(rumor.authoritative.some((l) => l.text.includes("hidden ford"))).toBe(false);
    expect(rumor.beliefs.some((l) => l.text.includes("hidden ford") && l.certainty === "rumor")).toBe(true);

    const told = composeEpistemicPacket({
      ...base,
      learned: { "fact.secret-ford": { factId: "fact.secret-ford", certainty: "confident", sourceKind: "told", learnedAt: 10 } },
    });
    expect(told.authoritative.some((l) => l.text.includes("hidden ford"))).toBe(true);
  });
});
