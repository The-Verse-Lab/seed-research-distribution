/**
 * Anti-cast-hallucination guard — the "Oda still walks beside you after I left him" immersion break.
 *
 * Layer 1 (this file's builder tests): `buildNarrationContext` renders an authoritative `Not present`
 * negative anchor for authored NPCs still echoing in the recent transcript / rolling summary who are
 * NOT in the present roster, strengthens the solitude label when the PC is alone, and carries a
 * `castGuard` (present + absent names) on the returned context. Omitted/byte-stable when no absent
 * NPC is referenced or the referenced NPC is actually present.
 *
 * Layer 2 (the DungeonMaster tests): `verifyCast` parses the utility model's offender verdict
 * (tolerant of prose/fences, fail-open on error), and `narrate({ forbid })` appends the hard
 * continuity-correction directive used on the regeneration pass.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { absentReferencedNames, buildNarrationContext, type ContextInput } from "../src/agents/context.ts";
import { DungeonMaster } from "../src/agents/dm.ts";
import { CampaignSchema, WorldSchema } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";
import type { GameEvent } from "../src/events/types.ts";
import type {
  ChatMessage,
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  LlmRole,
} from "../src/llm/types.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

const ODA_WALKS: GameEvent[] = [{ id: "1", at: 0, seq: 0, kind: "narration", text: "Oda walks beside you, silent." }];

function baseInput(overrides: Partial<ContextInput> = {}): ContextInput {
  const world = WorldSchema.parse({
    id: "w.t",
    name: "Testhold",
    summary: "A quiet vale.",
    locations: [{ id: "loc.room", name: "The Room", description: "A plain room." }],
    npcs: [{ id: "npc.oda", name: "Oda", persona: "A quiet companion." }],
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
  // Default: the PC is alone (present: []) and Oda is echoing in the transcript — the risk case.
  return { world, campaign, state, recentEvents: ODA_WALKS, trigger: "You ford the stream.", present: [], ...overrides };
}

describe("absentReferencedNames", () => {
  const world = baseInput().world;

  test("flags an authored NPC referenced in recent text but not present", () => {
    expect(absentReferencedNames(world, [], "Oda walks beside you.")).toEqual(["Oda"]);
  });

  test("does NOT flag an NPC who is actually present (by id or name)", () => {
    const present = [{ id: "npc.oda", name: "Oda" }];
    expect(absentReferencedNames(world, present, "Oda walks beside you.")).toEqual([]);
  });

  test("does NOT flag when the NPC is not referenced at all", () => {
    expect(absentReferencedNames(world, [], "The ford runs shallow and cold.")).toEqual([]);
  });

  test("scans the rolling summary too, and dedupes", () => {
    expect(absentReferencedNames(world, [], "…", "Earlier, Oda spoke of the ford. Oda again.")).toEqual(["Oda"]);
  });

  test("empty when there is no text to scan", () => {
    expect(absentReferencedNames(world, [], undefined, "  ")).toEqual([]);
  });

  test("a title-style name does NOT match on its leading article (no `the` false-positive)", () => {
    const titled = WorldSchema.parse({
      id: "w.t2",
      name: "Reach",
      summary: "A grim coast.",
      locations: [{ id: "loc.room", name: "The Room", description: "A plain room." }],
      npcs: [{ id: "npc.collector", name: "The Collector", persona: "A far-off buyer of debts." }],
    });
    // Prose full of the definite article but never naming the Collector must not flag them —
    // otherwise every narration would trip the guard's buffer+verify slow path.
    expect(absentReferencedNames(titled, [], "The road runs on. The wind bites the mire.")).toEqual([]);
    // The real name still flags.
    expect(absentReferencedNames(titled, [], "The Collector waits at the crossing.")).toEqual(["The Collector"]);
  });
});

describe("buildNarrationContext — cast guard", () => {
  test("renders the authoritative `Not present` anchor for a left-behind, still-referenced NPC", () => {
    const out = buildNarrationContext(baseInput());
    expect(out.contextText).toContain("Not present (elsewhere — do NOT depict as here, speaking, or acting): Oda");
    expect(out.castGuard).toEqual({ present: [], absent: ["Oda"] });
  });

  test("strengthens the solitude label when the PC is alone", () => {
    const text = buildNarrationContext(baseInput({ recentEvents: [] })).contextText;
    expect(text).toContain("you are ALONE here");
  });

  test("the anchor is placed inside # LOCATION, before # RECENT", () => {
    const text = buildNarrationContext(baseInput()).contextText;
    const locIdx = text.indexOf("# LOCATION");
    const anchorIdx = text.indexOf("Not present (elsewhere");
    const recentIdx = text.indexOf("# RECENT");
    expect(anchorIdx).toBeGreaterThan(locIdx);
    expect(anchorIdx).toBeLessThan(recentIdx);
  });

  test("no anchor and empty-absent castGuard when the referenced NPC is actually present", () => {
    const out = buildNarrationContext(
      baseInput({ present: [{ id: "npc.oda", name: "Oda", summary: "A quiet companion." }] }),
    );
    expect(out.contextText).not.toContain("Not present (elsewhere");
    expect(out.castGuard?.absent).toEqual([]);
  });

  test("no anchor when nothing off-cast is referenced (byte-stable vs no-npc world)", () => {
    const out = buildNarrationContext(baseInput({ recentEvents: [] }));
    expect(out.contextText).not.toContain("Not present (elsewhere");
    expect(out.castGuard?.absent).toEqual([]);
  });
});

// A capturing/scriptable gateway: `stream` echoes a canned narration and records the last user
// message; `complete("utility")` returns a scripted verifier verdict.
class StubGateway implements LlmGateway {
  lastUserMessage = "";
  constructor(
    private readonly narration: string,
    private readonly utilityJson: string,
  ) {}
  complete(role: LlmRole, _req: CompletionRequest): Promise<CompletionResult> {
    const text = role === "utility" ? this.utilityJson : this.narration;
    return Promise.resolve({ text, model: `stub-${role}` });
  }
  async *stream(_role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const user = [...req.messages].reverse().find((m: ChatMessage) => m.role === "user");
    this.lastUserMessage = user?.content ?? "";
    yield { delta: this.narration, done: true };
  }
  embed(_role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return Promise.resolve({ vectors: texts.map(() => [0]), model: "stub-embed" });
  }
}

describe("DungeonMaster — Layer-2 cast verification", () => {
  const world = baseInput().world;
  const state = baseInput().state;
  const ctx = { contextText: "# NOW\nYou ford the stream.", trigger: "You ford the stream." };

  test("verifyCast returns the offenders the utility model reports", async () => {
    const gw = new StubGateway("prose", '{"offenders":["Oda"]}');
    const dm = new DungeonMaster(gw, world);
    expect(await dm.verifyCast("Oda walks beside you.", [], ["Oda"])).toEqual(["Oda"]);
  });

  test("verifyCast tolerates fenced JSON and returns empty on a clean scene", async () => {
    const gw = new StubGateway("prose", '```json\n{"offenders":[]}\n```');
    const dm = new DungeonMaster(gw, world);
    expect(await dm.verifyCast("You ford alone.", [], ["Oda"])).toEqual([]);
  });

  test("verifyCast fails open (no offenders) when the verdict is unparseable", async () => {
    const gw = new StubGateway("prose", "not json at all");
    const dm = new DungeonMaster(gw, world);
    expect(await dm.verifyCast("…", [], ["Oda"])).toEqual([]);
  });

  test("narrate({ forbid }) appends the hard continuity-correction directive", async () => {
    const gw = new StubGateway("You ford the cold water alone.", '{"offenders":[]}');
    const dm = new DungeonMaster(gw, world);
    await dm.narrate(state, ctx, { forbid: ["Oda"] });
    expect(gw.lastUserMessage).toContain("CONTINUITY CORRECTION");
    expect(gw.lastUserMessage).toContain("Oda");
  });

  test("narrate without forbid leaves the user message free of the correction block", async () => {
    const gw = new StubGateway("You ford the cold water alone.", '{"offenders":[]}');
    const dm = new DungeonMaster(gw, world);
    await dm.narrate(state, ctx);
    expect(gw.lastUserMessage).not.toContain("CONTINUITY CORRECTION");
  });
});

describe("buildNarrationContext — party vs local", () => {
  test("marks a party companion '(with you)' and names them on the authoritative Party line", () => {
    const out = buildNarrationContext(
      baseInput({
        recentEvents: [],
        present: [{ id: "npc.oda", name: "Oda", summary: "A quiet companion.", partyMember: true }],
      }),
    );
    expect(out.contextText).toContain("Oda (with you)");
    expect(out.contextText).toContain("Party (these and ONLY these travel with you): Oda");
  });

  test("marks ambient crowd '(local)' and asserts the player travels ALONE (the crowd fix)", () => {
    const out = buildNarrationContext(
      baseInput({
        recentEvents: [],
        present: [
          { id: "npc.crowd#0", name: "A dockhand", local: true },
          { id: "npc.crowd#1", name: "A fishwife", local: true },
        ],
      }),
    );
    expect(out.contextText).toContain("A dockhand (local)");
    expect(out.contextText).toContain("travel ALONE"); // Party line says solo despite the crowd
    expect(out.contextText).not.toContain("(with you)");
  });
});
