/**
 * Per-NPC lore retrieval (M4, Part A, phase 3) — the `# RELEVANT LORE` section in an NPC reply.
 *
 * Two layers:
 *  - NpcAgent.reply renders the section BEFORE `# DIRECT ADDRESS` when lore is supplied, and omits
 *    it (byte-stable prompt) when empty.
 *  - End-to-end through a real dialogue turn: a companion's own `knowledge[]` plus PUBLIC world lore
 *    are injected into its reply prompt; secret-tagged world lore is never injected.
 * Deterministic offline (hashToVec) — plumbing, not ranking.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { NpcAgent } from "../src/agents/npc.ts";
import { localGuildLineOf } from "../src/agents/context.ts";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { ChatMessage, CompletionChunk, CompletionRequest, LlmRole } from "../src/llm/types.ts";
import { BRIEF_MARKERS } from "../src/util/markers.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { NpcTemplateSchema, CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

/** Records the narrator-role user prompt of every stream, delegating to offline. */
class RecordingGateway implements LlmGateway {
  readonly narratorPrompts: string[] = [];
  private readonly inner = new OfflineGateway();
  complete(role: LlmRole, req: CompletionRequest) {
    return this.inner.complete(role, req);
  }
  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (role === "narrator") {
      const user = [...req.messages].reverse().find((m: ChatMessage) => m.role === "user");
      if (user) this.narratorPrompts.push(user.content);
    }
    yield* this.inner.stream(role, req);
  }
  embed(role: LlmRole, texts: string[]) {
    return this.inner.embed(role, texts);
  }
}

describe("NpcAgent.reply — # RELEVANT LORE placement", () => {
  const template = NpcTemplateSchema.parse({ id: "npc.x", name: "Xenia", persona: "Terse." });

  test("renders the section BEFORE # DIRECT ADDRESS when lore is supplied", async () => {
    const gw = new RecordingGateway();
    const agent = new NpcAgent(gw, template);
    await agent.reply({} as never, {
      contextText: "# WORLD\nsummary",
      playerLine: "what do you know?",
      fromName: "You",
      lore: ["‣ Roads: the east road floods in spring."],
    });
    const prompt = gw.narratorPrompts.at(-1) ?? "";
    expect(prompt).toContain("# RELEVANT LORE");
    expect(prompt).toContain("east road floods");
    expect(prompt.indexOf("# RELEVANT LORE")).toBeLessThan(prompt.indexOf(BRIEF_MARKERS.directAddress));
  });

  test("omits the section (no header) when no lore is supplied", async () => {
    const gw = new RecordingGateway();
    const agent = new NpcAgent(gw, template);
    await agent.reply({} as never, { contextText: "# WORLD\nsummary", playerLine: "hi", fromName: "You" });
    const prompt = gw.narratorPrompts.at(-1) ?? "";
    expect(prompt).not.toContain("# RELEVANT LORE");
  });

  test("omits the section when lore is an empty array (byte-identical to absent)", async () => {
    const gw = new RecordingGateway();
    const agent = new NpcAgent(gw, template);
    await agent.reply({} as never, { contextText: "# WORLD\nsummary", playerLine: "hi", fromName: "You" });
    const baseline = gw.narratorPrompts.at(-1) ?? "";
    await agent.reply({} as never, { contextText: "# WORLD\nsummary", playerLine: "hi", fromName: "You", lore: [] });
    const withEmpty = gw.narratorPrompts.at(-1) ?? "";
    expect(withEmpty).toBe(baseline);
  });
});

function dialoguePlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.t",
    name: "Vale",
    summary: "A vale.",
    lore: [
      { id: "lore.stones", title: "The Warden Stones", body: "Seven stones ring the vale to hold the dark.", tags: ["wards"] },
      { id: "lore.secret", title: "The Failing Seal", body: "Only the GM knows the eastern stone cracked.", tags: ["secret"] },
    ],
    locations: [{ id: "loc.room", name: "The Hall", description: "A stone hall." }],
    npcs: [
      {
        id: "npc.maelle",
        name: "Maelle",
        persona: "A hedge-witch.",
        age: 40,
        knowledge: ["The Warden Stones and their ward-signs", "Every footpath in the vale"],
        autonomy: { isPartyMember: true, level: "reactive" },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.t",
    name: "C",
    worldId: "w.t",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    startingState: { locationId: "loc.room", party: ["pc.you"], companions: ["npc.maelle"] },
  });
  return { world, campaign };
}

describe("dialogue turn — NPC reply is grounded in knowledge + public world lore (offline)", () => {
  test("addressing a companion injects # RELEVANT LORE drawn from its knowledge + world lore", async () => {
    const gw = new RecordingGateway();
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset: dialoguePlayset(),
      store: new InMemoryGameStateStore(),
      gateway: gw,
      lore: { k: 5, minScore: 0 }, // floor 0: non-semantic offline embeddings always pass
    });
    await engine.start();
    await engine.submitPlayerInput('Maelle, what do you know about the warden stones?');

    // The NPC reply prompt is the narrator-role prompt bearing `# DIRECT ADDRESS`. (The DM now also
    // narrates the reply as a public beat, so its narration prompt — the last one — is NOT the reply.)
    const replyPrompt = gw.narratorPrompts.find((p) => p.includes(BRIEF_MARKERS.directAddress)) ?? "";
    expect(replyPrompt).toContain(BRIEF_MARKERS.directAddress);
    expect(replyPrompt).toContain("# RELEVANT LORE");
    // Public world lore is present.
    expect(replyPrompt).toContain("The Warden Stones");
    // The NPC's own knowledge is present.
    expect(replyPrompt).toContain("ward-signs");
    // The section is placed before the current addressed line.
    expect(replyPrompt.indexOf("# RELEVANT LORE")).toBeLessThan(replyPrompt.indexOf(BRIEF_MARKERS.directAddress));
    // Secret-tagged world lore is NEVER injected into an NPC prompt.
    expect(replyPrompt).not.toContain("The Failing Seal");
    expect(replyPrompt).not.toContain("eastern stone cracked");
  });

  test("asking Mara for the closest guild grounds her in Relay House's authored local hall", async () => {
    const playset = await loadPlaySetFromDir(
      fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url)),
    );
    playset.campaign.startingState.locationId = "loc.bellharbor-relay";
    expect(localGuildLineOf(playset.world, playset.campaign.startingState.locationId)).toBe(
      "Local guild (authoritative): The Wakeward Relay House is HERE at Relay House, not at any exit or neighboring district; its clerk is Ivo Pell. When asked where to find a guild, give this local hall before unrelated guild or faction lore.",
    );

    const gw = new RecordingGateway();
    const engine = new GameEngine({
      classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: gw,
      lore: { k: 8, minScore: 0 },
    });
    await engine.start();
    await engine.submitPlayerInput("Mara, where is the closest guild?");

    const replyPrompt =
      gw.narratorPrompts.find(
        (prompt) =>
          prompt.includes(BRIEF_MARKERS.directAddress) &&
          prompt.includes("Mara, where is the closest guild?"),
      ) ?? "";
    expect(replyPrompt).toContain(
      "Local guild (authoritative): The Wakeward Relay House is HERE at Relay House",
    );
    expect(replyPrompt).toContain("its clerk is Ivo Pell");
    expect(replyPrompt.indexOf("Local guild (authoritative)")).toBeLessThan(
      replyPrompt.indexOf(BRIEF_MARKERS.directAddress),
    );
  });
});
