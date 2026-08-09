/**
 * Secret / GM-only lore — the DM-only narrate channel (M4 follow-up).
 *
 * The privacy story for read-only lore RAG: secret-tagged world lore reaches ONLY the
 * `DungeonMaster.narrate` user message (a `=== SECRET LORE ===` block), NEVER the shared
 * `contextText`, the `# RELEVANT LORE` block, or any NPC `reply()`/`decide()` prompt. This suite
 * proves that boundary at three levels:
 *  - unit (dm.ts): `narrate` appends the GM block to its OWN user message when `gmLore` is present,
 *    and is byte-identical to a plain brief when it is absent/empty;
 *  - unit (context.ts): `buildNarrationContext` rides `gmLore` on the returned context WITHOUT
 *    putting it in `contextText` (the shared brief stays byte-stable);
 *  - end-to-end (the privacy invariant): a secret entry appears in the DM narrate message but is
 *    ABSENT from the shared-brief portion AND from a companion's reply prompt.
 *
 * Deterministic offline (hashToVec embeddings) — plumbing + routing, not ranking. Read-only: no
 * state mutation, no reducer/deltas/persistence. Secret fixtures are benign plot canon.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { DungeonMaster } from "../src/agents/dm.ts";
import { NpcAgent } from "../src/agents/npc.ts";
import { buildNarrationContext, type ContextInput } from "../src/agents/context.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { ChatMessage, CompletionChunk, CompletionRequest, LlmRole } from "../src/llm/types.ts";
import { BRIEF_MARKERS } from "../src/util/markers.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };
const SECRET_HDR = "=== SECRET LORE (GM eyes only";

/** Records the narrator-role user message of every stream (in order), delegating to offline. */
class RecordingGateway implements LlmGateway {
  readonly narratorMessages: string[] = [];
  private readonly inner = new OfflineGateway();
  complete(role: LlmRole, req: CompletionRequest) {
    return this.inner.complete(role, req);
  }
  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (role === "narrator") {
      const user = [...req.messages].reverse().find((m: ChatMessage) => m.role === "user");
      if (user) this.narratorMessages.push(user.content);
    }
    yield* this.inner.stream(role, req);
  }
  embed(role: LlmRole, texts: string[]) {
    return this.inner.embed(role, texts);
  }
}

// ── Unit: dm.narrate appends the GM block to its OWN user message ───────────────────────────────

describe("DungeonMaster.narrate — the GM-only secret block", () => {
  const world = WorldSchema.parse({ id: "w.t", name: "Hold", summary: "A keep." });

  test("appends the SECRET LORE block to the narrate user message when gmLore is present", async () => {
    const gw = new RecordingGateway();
    const dm = new DungeonMaster(gw, world);
    await dm.narrate({} as never, {
      contextText: "# WORLD\nsummary\n\n# NOW\nYou look around.",
      trigger: "You look around.",
      gmLore: ["‣ The Steward: the steward is secretly an informant for the crown."],
    });
    const msg = gw.narratorMessages.at(-1) ?? "";
    expect(msg).toContain(SECRET_HDR);
    expect(msg).toContain("the steward is secretly an informant");
    // The block is appended AFTER the shared brief (it follows # NOW, the brief's last region).
    expect(msg.indexOf(SECRET_HDR)).toBeGreaterThan(msg.indexOf(BRIEF_MARKERS.now));
  });

  test("byte-identical narrate message (no header) when gmLore is absent, undefined, or empty", async () => {
    const gw = new RecordingGateway();
    const dm = new DungeonMaster(gw, world);
    const brief = "# WORLD\nsummary\n\n# NOW\nYou wait.";

    await dm.narrate({} as never, { contextText: brief, trigger: "You wait." });
    const absent = gw.narratorMessages.at(-1) ?? "";
    await dm.narrate({} as never, { contextText: brief, trigger: "You wait.", gmLore: undefined });
    const undef = gw.narratorMessages.at(-1) ?? "";
    await dm.narrate({} as never, { contextText: brief, trigger: "You wait.", gmLore: [] });
    const empty = gw.narratorMessages.at(-1) ?? "";

    expect(absent).toBe(brief); // the user message is exactly the contextText — nothing added
    expect(undef).toBe(absent);
    expect(empty).toBe(absent);
    expect(absent).not.toContain(SECRET_HDR);
  });
});

// ── Unit: buildNarrationContext rides gmLore WITHOUT touching contextText ────────────────────────

function baseInput(overrides: Partial<ContextInput> = {}): ContextInput {
  const world = WorldSchema.parse({
    id: "w.t",
    name: "Testhold",
    summary: "A quiet vale.",
    locations: [{ id: "loc.room", name: "The Room", description: "A plain room." }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.t",
    name: "C",
    worldId: "w.t",
    characters: [{ id: "pc.you", name: "You", stats: STATS }],
    startingState: { locationId: "loc.room", party: ["pc.you"] },
  });
  const state: GameState = {
    campaignId: "c.t",
    worldId: "w.t",
    partyLocationId: "loc.room",
    clock: 0,
    party: ["pc.you"],
    companions: [],
    actors: { "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.room", inventory: [], conditions: [] } },
    quests: {},
    relationships: {},
    autonomy: {},
    flags: {},
  };
  return { world, campaign, state, recentEvents: [], trigger: "You look around.", ...overrides };
}

describe("buildNarrationContext — gmLore rides the context, never contextText", () => {
  test("gmLore is set on the returned context but is ABSENT from contextText", () => {
    const ctx = buildNarrationContext(
      baseInput({ gmLore: ["‣ Secret: the eastern stone has cracked."] }),
    );
    expect(ctx.gmLore).toEqual(["‣ Secret: the eastern stone has cracked."]);
    // The shared brief never carries the secret — not the text, not a header.
    expect(ctx.contextText).not.toContain("the eastern stone has cracked");
    expect(ctx.contextText).not.toContain(SECRET_HDR);
    expect(ctx.contextText).not.toContain("Secret");
  });

  test("byte-identical contextText whether gmLore is absent, undefined, or empty", () => {
    const noKey = buildNarrationContext(baseInput()).contextText;
    const undef = buildNarrationContext(baseInput({ gmLore: undefined })).contextText;
    const empty = buildNarrationContext(baseInput({ gmLore: [] })).contextText;
    expect(undef).toBe(noKey);
    expect(empty).toBe(noKey);
    // Supplying secret lore changes nothing in the shared brief either.
    const withSecret = buildNarrationContext(baseInput({ gmLore: ["‣ S: hidden."] })).contextText;
    expect(withSecret).toBe(noKey);
  });

  test("an empty gmLore array normalizes to undefined on the returned context", () => {
    expect(buildNarrationContext(baseInput({ gmLore: [] })).gmLore).toBeUndefined();
    expect(buildNarrationContext(baseInput()).gmLore).toBeUndefined();
  });
});

// ── End-to-end: THE PRIVACY INVARIANT ──────────────────────────────────────────────────────────

function secretPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.t",
    name: "Vale",
    summary: "A vale ringed by old stones.",
    lore: [
      { id: "lore.stones", title: "The Warden Stones", body: "Seven stones ring the vale to hold the dark.", tags: ["wards"] },
      // Benign plot secret — GM-only.
      { id: "lore.steward", title: "The Steward", body: "Only the GM knows the steward is secretly an informant for the crown.", tags: ["secret"] },
    ],
    locations: [{ id: "loc.room", name: "The Hall", description: "A stone hall." }],
    npcs: [
      {
        id: "npc.maelle",
        name: "Maelle",
        persona: "A hedge-witch.",
        age: 40,
        knowledge: ["The Warden Stones and their ward-signs"],
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

describe("secret lore — the privacy invariant, end-to-end (offline)", () => {
  test("secret reaches the DM narrate message ONLY — not contextText, not an NPC reply prompt", async () => {
    const gw = new RecordingGateway();
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset: secretPlayset(),
      store: new InMemoryGameStateStore(),
      gateway: gw,
      lore: { k: 5, minScore: 0 }, // floor 0: non-semantic offline embeddings always pass
    });
    await engine.start();

    // Turn 1: a non-dialogue action ⇒ the DM narrates (this message carries the gmLore block).
    await engine.submitPlayerInput("I study the steward and the warden stones around me.");
    // Turn 2: address the companion ⇒ an NPC reply prompt is generated (it must NOT carry secret).
    await engine.submitPlayerInput("Maelle, what do you know about the warden stones?");

    // Classify the captured narrator messages by their marker. An NPC reply prompt embeds the full
    // brief (so it ALSO contains `# NOW`) then appends `# DIRECT ADDRESS`; a DM narrate message has
    // `# NOW` but no `# DIRECT ADDRESS`. Split on that.
    const npcMsgs = gw.narratorMessages.filter((m) => m.includes(BRIEF_MARKERS.directAddress));
    const dmMsgs = gw.narratorMessages.filter(
      (m) => m.includes(BRIEF_MARKERS.now) && !m.includes(BRIEF_MARKERS.directAddress),
    );
    expect(dmMsgs.length).toBeGreaterThan(0);
    expect(npcMsgs.length).toBeGreaterThan(0);

    // (1) The DM narrate message DOES carry the secret — inside the GM-only block.
    const dm = dmMsgs.at(-1)!;
    const secretIdx = dm.indexOf(SECRET_HDR);
    expect(secretIdx).toBeGreaterThan(0);
    expect(dm).toContain("the steward is secretly an informant");

    // (2) ...but NOT in the shared-brief portion (everything before the secret header == contextText).
    const briefPortion = dm.slice(0, secretIdx);
    expect(briefPortion).not.toContain("the steward is secretly an informant");
    expect(briefPortion).not.toContain("The Steward");
    // The public lore IS in the shared brief, proving retrieval ran (not just an empty index).
    expect(briefPortion).toContain("# RELEVANT LORE");
    expect(briefPortion).toContain("The Warden Stones");

    // (3) The NPC reply prompt NEVER contains the secret — not the text, not the header.
    for (const npc of npcMsgs) {
      expect(npc).not.toContain("the steward is secretly an informant");
      expect(npc).not.toContain("The Steward");
      expect(npc).not.toContain(SECRET_HDR);
    }
  });
});
