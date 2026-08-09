/**
 * Character identity prompt wiring — DM-only PC/NPC hidden notes and owning-NPC traits.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { buildNarrationContext, type ContextInput } from "../src/agents/context.ts";
import { NpcAgent } from "../src/agents/npc.ts";
import { CampaignSchema, NpcTemplateSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type { ChatMessage, CompletionChunk, CompletionRequest, LlmRole } from "../src/llm/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import type { GameState } from "../src/state/types.ts";
import { BRIEF_MARKERS } from "../src/util/markers.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };
const SECRET_HDR = "=== SECRET LORE (GM eyes only";

class PromptRecordingGateway implements LlmGateway {
  readonly narratorCalls: Array<{ system: string; user: string }> = [];
  private readonly inner = new OfflineGateway();

  complete(role: LlmRole, req: CompletionRequest) {
    return this.inner.complete(role, req);
  }

  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (role === "narrator") {
      const system = req.messages.find((m: ChatMessage) => m.role === "system")?.content ?? "";
      const user = [...req.messages].reverse().find((m: ChatMessage) => m.role === "user")?.content ?? "";
      this.narratorCalls.push({ system, user });
    }
    yield* this.inner.stream(role, req);
  }

  embed(role: LlmRole, texts: string[]) {
    return this.inner.embed(role, texts);
  }
}

function baseContextInput(overrides: Partial<ContextInput> = {}): ContextInput {
  const world = WorldSchema.parse({
    id: "w.identity",
    name: "Identity Vale",
    summary: "A test vale.",
    locations: [{ id: "loc.room", name: "The Room", description: "A plain room." }],
    npcs: [
      {
        id: "npc.vey",
        name: "Vey",
        summary: "a careful broker",
        persona: "Soft-spoken.",
        hiddenLore: "VEY-HIDDEN-SIGNET",
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.identity",
    name: "C",
    worldId: "w.identity",
    characters: [
      {
        id: "pc.you",
        name: "You",
        stats: STATS,
        personality: "PC-PERSONALITY-ASH",
        knownLore: "PC-KNOWN-KEY",
        backstory: "PC-BACKSTORY-ROAD",
        hiddenLore: "PC-HIDDEN-HEIR",
      },
    ],
    startingState: { locationId: "loc.room", party: ["pc.you"], companions: ["npc.vey"] },
  });
  const state: GameState = {
    campaignId: "c.identity",
    worldId: "w.identity",
    partyLocationId: "loc.room",
    clock: 0,
    party: ["pc.you"],
    companions: ["npc.vey"],
    actors: {
      "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.room", inventory: [], conditions: [] },
      "npc.vey": { id: "npc.vey", currentHp: 10, locationId: "loc.room", inventory: [], conditions: [] },
    },
    quests: {},
    relationships: {},
    autonomy: {},
    flags: {},
  };
  return {
    world,
    campaign,
    state,
    recentEvents: [],
    trigger: "You watch Vey.",
    present: [{ id: "npc.vey", name: "Vey", summary: "a careful broker" }],
    ...overrides,
  };
}

describe("buildNarrationContext — authored identity privacy", () => {
  test("a PC physical description reaches gmLore as an Appearance line, never contextText", () => {
    const input = baseContextInput();
    input.campaign.characters[0]!.description = "PC-LOOK-GREYEYES";
    const ctx = buildNarrationContext(input);
    expect(ctx.gmLore?.join("\n") ?? "").toContain("Appearance: PC-LOOK-GREYEYES");
    expect(ctx.contextText).not.toContain("PC-LOOK-GREYEYES");
  });

  test("routes PC notes and present NPC hiddenLore to gmLore, never contextText", () => {
    const ctx = buildNarrationContext(baseContextInput({ gmLore: ["‣ Retrieved Secret: EXTERNAL-GM-SECRET"] }));
    const gm = ctx.gmLore?.join("\n") ?? "";

    expect(gm).toContain("PC-PERSONALITY-ASH");
    expect(gm).toContain("PC-KNOWN-KEY");
    expect(gm).toContain("PC-BACKSTORY-ROAD");
    expect(gm).toContain("PC-HIDDEN-HEIR");
    expect(gm).toContain("VEY-HIDDEN-SIGNET");
    expect(gm).toContain("EXTERNAL-GM-SECRET");

    for (const privateText of [
      "PC-PERSONALITY-ASH",
      "PC-KNOWN-KEY",
      "PC-BACKSTORY-ROAD",
      "PC-HIDDEN-HEIR",
      "VEY-HIDDEN-SIGNET",
      "EXTERNAL-GM-SECRET",
    ]) {
      expect(ctx.contextText).not.toContain(privateText);
    }
    expect(ctx.contextText).not.toContain(SECRET_HDR);
  });

  test("identity-only changes do not move any shared-brief bytes", () => {
    const withIdentity = buildNarrationContext(baseContextInput()).contextText;
    const plain = baseContextInput({
      world: WorldSchema.parse({
        id: "w.identity",
        name: "Identity Vale",
        summary: "A test vale.",
        locations: [{ id: "loc.room", name: "The Room", description: "A plain room." }],
        npcs: [{ id: "npc.vey", name: "Vey", summary: "a careful broker", persona: "Soft-spoken." }],
      }),
      campaign: CampaignSchema.parse({
        id: "c.identity",
        name: "C",
        worldId: "w.identity",
        characters: [{ id: "pc.you", name: "You", stats: STATS }],
        startingState: { locationId: "loc.room", party: ["pc.you"], companions: ["npc.vey"] },
      }),
    });
    expect(withIdentity).toBe(buildNarrationContext(plain).contextText);
  });
});

describe("NpcAgent — owning NPC identity prompt", () => {
  test("sex + physical description enter the owning prompt, omit-when-empty stays byte-stable", () => {
    const embodied = NpcTemplateSchema.parse({
      id: "npc.vey",
      name: "Vey",
      summary: "a careful broker",
      persona: "Soft-spoken.",
      sex: "female",
      description: "VEY-LOOK-SCAR",
    });
    const prompt = new NpcAgent(new OfflineGateway(), embodied).buildSystemPrompt();
    expect(prompt).toContain("You are female.");
    expect(prompt).toContain("What others see: VEY-LOOK-SCAR");

    // Legacy `appearance` still grounds the look when `description` is unauthored.
    const legacy = NpcTemplateSchema.parse({
      id: "npc.vey",
      name: "Vey",
      summary: "a careful broker",
      persona: "Soft-spoken.",
      appearance: "VEY-LOOK-PIN",
    });
    expect(new NpcAgent(new OfflineGateway(), legacy).buildSystemPrompt()).toContain(
      "What others see: VEY-LOOK-PIN",
    );

    // No identity fields ⇒ the prompt is byte-identical to the pre-identity shape (no notes block).
    const bare = NpcTemplateSchema.parse({
      id: "npc.vey",
      name: "Vey",
      summary: "a careful broker",
      persona: "Soft-spoken.",
    });
    const barePrompt = new NpcAgent(new OfflineGateway(), bare).buildSystemPrompt();
    expect(barePrompt).not.toContain("Private character notes");
    expect(barePrompt).not.toContain("You are female.");
    expect(barePrompt).not.toContain("What others see:");
  });

  test("authored goals enter the prompt as private motivations, never a recitable list (leak fix)", () => {
    const withGoals = NpcTemplateSchema.parse({
      id: "npc.sev",
      name: "Severin",
      summary: "a doubting friar",
      persona: "Grave.",
      goals: ["Recover Saint Odran's true record"],
    });
    const prompt = new NpcAgent(new OfflineGateway(), withGoals).buildSystemPrompt();
    // The goal drives behavior, so the text is present...
    expect(prompt).toContain("Recover Saint Odran's true record");
    // ...but framed as a PRIVATE motivation the NPC must not recite (2026-07-05 dialogue leak),
    // never the bare "Your goals:" list the model read aloud verbatim.
    expect(prompt).toContain("never recite");
    expect(prompt).not.toContain("Your goals:");
  });

  test("profile fields (age/socialRole/voiceTags/preferences) enter the owning prompt, omit-when-empty", () => {
    const profiled = NpcTemplateSchema.parse({
      id: "npc.vey",
      name: "Vey",
      summary: "a careful broker",
      persona: "Soft-spoken.",
      age: 34,
      socialRole: "VEY-ROLE-BROKER",
      voiceTags: ["VEY-VOICE-CLIPPED", "VEY-VOICE-WRY"],
      preferences: ["VEY-LIKES-COIN", "VEY-AVOIDS-CROWDS"],
    });
    const prompt = new NpcAgent(new OfflineGateway(), profiled).buildSystemPrompt();
    expect(prompt).toContain("You are 34 years old.");
    expect(prompt).toContain("Your place: VEY-ROLE-BROKER.");
    expect(prompt).toContain("Your manner of speech: VEY-VOICE-CLIPPED; VEY-VOICE-WRY.");
    expect(prompt).toContain("You like/avoid: VEY-LIKES-COIN; VEY-AVOIDS-CROWDS.");

    // No profile fields ⇒ byte-identical prompt (the omit-when-empty contract).
    const bare = NpcTemplateSchema.parse({
      id: "npc.vey",
      name: "Vey",
      summary: "a careful broker",
      persona: "Soft-spoken.",
    });
    const barePrompt = new NpcAgent(new OfflineGateway(), bare).buildSystemPrompt();
    expect(barePrompt).not.toContain("years old");
    expect(barePrompt).not.toContain("Your place:");
    expect(barePrompt).not.toContain("Your manner of speech:");
    expect(barePrompt).not.toContain("You like/avoid:");
  });

  test("includes only the owning NPC's alignment/personality/knownLore, excluding hiddenLore", () => {
    const own = NpcTemplateSchema.parse({
      id: "npc.vey",
      name: "Vey",
      summary: "a careful broker",
      persona: "Soft-spoken.",
      personality: "VEY-PERSONALITY-GLASS",
      knownLore: "VEY-KNOWN-BRIDGE",
      hiddenLore: "VEY-HIDDEN-SIGNET",
      alignment: "ln",
      personalityTemplate: "schemer",
    });
    const other = NpcTemplateSchema.parse({
      id: "npc.brann",
      name: "Brann",
      summary: "a stern guard",
      persona: "Blunt.",
      personality: "BRANN-PERSONALITY-EMBER",
      knownLore: "BRANN-KNOWN-VAULT",
      hiddenLore: "BRANN-HIDDEN-ORACLE",
      alignment: "ce",
      personalityTemplate: "brute",
    });

    const ownPrompt = new NpcAgent(new OfflineGateway(), own).buildSystemPrompt();
    const otherPrompt = new NpcAgent(new OfflineGateway(), other).buildSystemPrompt();

    expect(ownPrompt).toContain("VEY-PERSONALITY-GLASS");
    expect(ownPrompt).toContain("VEY-KNOWN-BRIDGE");
    expect(ownPrompt).toContain("Lawful Neutral");
    expect(ownPrompt).toContain("Schemer");
    expect(ownPrompt).not.toContain("VEY-HIDDEN-SIGNET");
    expect(ownPrompt).not.toContain("BRANN-PERSONALITY-EMBER");
    expect(ownPrompt).not.toContain("BRANN-KNOWN-VAULT");
    expect(ownPrompt).not.toContain("BRANN-HIDDEN-ORACLE");

    expect(otherPrompt).toContain("BRANN-PERSONALITY-EMBER");
    expect(otherPrompt).toContain("BRANN-KNOWN-VAULT");
    expect(otherPrompt).toContain("Chaotic Evil");
    expect(otherPrompt).toContain("Brute");
    expect(otherPrompt).not.toContain("BRANN-HIDDEN-ORACLE");
    expect(otherPrompt).not.toContain("VEY-PERSONALITY-GLASS");
    expect(otherPrompt).not.toContain("VEY-KNOWN-BRIDGE");
    expect(otherPrompt).not.toContain("VEY-HIDDEN-SIGNET");
  });
});

function privacyPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.identity",
    name: "Identity Vale",
    summary: "A quiet vale.",
    locations: [{ id: "loc.room", name: "The Room", description: "A plain room." }],
    npcs: [
      {
        id: "npc.vey",
        name: "Vey",
        summary: "a careful broker",
        persona: "Soft-spoken.",
        personality: "VEY-PERSONALITY-GLASS",
        knownLore: "VEY-KNOWN-BRIDGE",
        hiddenLore: "VEY-HIDDEN-SIGNET",
        alignment: "ln",
        personalityTemplate: "schemer",
        autonomy: { isPartyMember: true, level: "reactive" },
      },
      {
        id: "npc.brann",
        name: "Brann",
        summary: "a stern guard",
        persona: "Blunt.",
        personality: "BRANN-PERSONALITY-EMBER",
        knownLore: "BRANN-KNOWN-VAULT",
        hiddenLore: "BRANN-HIDDEN-ORACLE",
        alignment: "ce",
        personalityTemplate: "brute",
        autonomy: { isPartyMember: true, level: "reactive" },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.identity",
    name: "C",
    worldId: "w.identity",
    characters: [
      {
        id: "pc.you",
        name: "You",
        stats: STATS,
        personality: "PC-PERSONALITY-ASH",
        knownLore: "PC-KNOWN-KEY",
        backstory: "PC-BACKSTORY-ROAD",
        hiddenLore: "PC-HIDDEN-HEIR",
      },
    ],
    startingState: { locationId: "loc.room", party: ["pc.you"], companions: ["npc.vey", "npc.brann"] },
  });
  return { world, campaign };
}

describe("identity wiring — end-to-end privacy invariant (offline)", () => {
  test("DM sees private PC/present-NPC hidden lore; target NPC sees only its own traits", async () => {
    const gateway = new PromptRecordingGateway();
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset: privacyPlayset(),
      store: new InMemoryGameStateStore(),
      gateway,
      rng: () => 0.99, // suppress priority-B chime-ins so the addressed NPC prompt is isolated
    });
    await engine.start();

    await engine.submitPlayerInput("I study Vey and Brann from the doorway.");
    await engine.submitPlayerInput("Vey, stay with me.");

    const dmCall = gateway.narratorCalls.find(
      (c) => c.user.includes(SECRET_HDR) && !c.user.includes(BRIEF_MARKERS.directAddress),
    );
    expect(dmCall).toBeDefined();
    const dmUser = dmCall!.user;
    const secretIdx = dmUser.indexOf(SECRET_HDR);
    const sharedBrief = dmUser.slice(0, secretIdx);
    const gmBlock = dmUser.slice(secretIdx);

    for (const privateText of [
      "PC-PERSONALITY-ASH",
      "PC-KNOWN-KEY",
      "PC-BACKSTORY-ROAD",
      "PC-HIDDEN-HEIR",
      "VEY-HIDDEN-SIGNET",
      "BRANN-HIDDEN-ORACLE",
    ]) {
      expect(gmBlock).toContain(privateText);
      expect(sharedBrief).not.toContain(privateText);
    }
    expect(gmBlock).not.toContain("VEY-KNOWN-BRIDGE");
    expect(gmBlock).not.toContain("BRANN-KNOWN-VAULT");

    const npcCall = gateway.narratorCalls.find(
      (c) => c.user.includes(BRIEF_MARKERS.directAddress) && c.system.includes("You are Vey."),
    );
    expect(npcCall).toBeDefined();
    expect(npcCall!.system).toContain("VEY-PERSONALITY-GLASS");
    expect(npcCall!.system).toContain("VEY-KNOWN-BRIDGE");
    expect(npcCall!.system).toContain("Lawful Neutral");
    expect(npcCall!.system).toContain("Schemer");

    const fullNpcPrompt = `${npcCall!.system}\n${npcCall!.user}`;
    for (const forbidden of [
      "PC-PERSONALITY-ASH",
      "PC-KNOWN-KEY",
      "PC-BACKSTORY-ROAD",
      "PC-HIDDEN-HEIR",
      "VEY-HIDDEN-SIGNET",
      "BRANN-PERSONALITY-EMBER",
      "BRANN-KNOWN-VAULT",
      "BRANN-HIDDEN-ORACLE",
      "Chaotic Evil",
      "Brute",
      SECRET_HDR,
    ]) {
      expect(fullNpcPrompt).not.toContain(forbidden);
    }
  });
});
