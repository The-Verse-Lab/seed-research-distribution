/**
 * Per-NPC memory recall (M4 Part B, phase 3) — the `# YOU REMEMBER` block in an NPC's prompt.
 *
 * Two layers:
 *  - NpcAgent.reply / NpcAgent.decide render the section BEFORE the action marker when memory is
 *    supplied, and omit it (byte-identical prompt) when empty — so a memory-less NPC is unchanged.
 *  - End-to-end through real turns: addressing a companion on one turn makes the recalled beat show
 *    up in its reply prompt on a LATER turn (you remember prior beats, not the line you're answering).
 * Deterministic offline.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { NpcAgent } from "../src/agents/npc.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { ChatMessage, CompletionChunk, CompletionRequest, LlmRole } from "../src/llm/types.ts";
import { BRIEF_MARKERS } from "../src/util/markers.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { NpcTemplateSchema } from "../src/content/schema.ts";
import { loadExample } from "./support/harness.ts";

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

describe("NpcAgent.reply — # YOU REMEMBER placement", () => {
  const template = NpcTemplateSchema.parse({ id: "npc.x", name: "Xenia", persona: "Terse." });

  test("renders the section BEFORE # DIRECT ADDRESS when memory is supplied", async () => {
    const gw = new RecordingGateway();
    const agent = new NpcAgent(gw, template);
    await agent.reply({} as never, {
      contextText: "# WORLD\nsummary",
      playerLine: "remember me?",
      fromName: "You",
      memory: ["‣ Spoke with You."],
    });
    const prompt = gw.narratorPrompts.at(-1) ?? "";
    expect(prompt).toContain("# YOU REMEMBER");
    expect(prompt).toContain("Spoke with You.");
    expect(prompt.indexOf("# YOU REMEMBER")).toBeLessThan(prompt.indexOf(BRIEF_MARKERS.directAddress));
  });

  test("omits the section (byte-identical) when memory is absent or an empty array", async () => {
    const gw = new RecordingGateway();
    const agent = new NpcAgent(gw, template);
    await agent.reply({} as never, { contextText: "# WORLD\nsummary", playerLine: "hi", fromName: "You" });
    const baseline = gw.narratorPrompts.at(-1) ?? "";
    expect(baseline).not.toContain("# YOU REMEMBER");
    await agent.reply({} as never, { contextText: "# WORLD\nsummary", playerLine: "hi", fromName: "You", memory: [] });
    const withEmpty = gw.narratorPrompts.at(-1) ?? "";
    expect(withEmpty).toBe(baseline);
  });
});

describe("NpcAgent.decide — # YOU REMEMBER placement", () => {
  const template = NpcTemplateSchema.parse({ id: "npc.x", name: "Xenia", persona: "Terse.", goals: ["scout ahead"] });

  test("renders the section BEFORE the autonomous-beat marker when memory is supplied", async () => {
    const gw = new RecordingGateway();
    const agent = new NpcAgent(gw, template);
    await agent.decide({} as never, {
      contextText: "# WORLD\nsummary",
      stimulus: "Anything to do?",
      replyDepth: 0,
      memory: ["‣ Quest \"The Errand\" was resolved."],
    });
    const prompt = gw.narratorPrompts.at(-1) ?? "";
    expect(prompt).toContain("# YOU REMEMBER");
    expect(prompt).toContain("The Errand");
    expect(prompt.indexOf("# YOU REMEMBER")).toBeLessThan(prompt.indexOf(BRIEF_MARKERS.autonomousBeat));
  });

  test("omits the section (byte-identical) when memory is absent or empty", async () => {
    const gw = new RecordingGateway();
    const agent = new NpcAgent(gw, template);
    await agent.decide({} as never, { contextText: "# WORLD\nsummary", stimulus: "go", replyDepth: 0 });
    const baseline = gw.narratorPrompts.at(-1) ?? "";
    expect(baseline).not.toContain("# YOU REMEMBER");
    await agent.decide({} as never, { contextText: "# WORLD\nsummary", stimulus: "go", replyDepth: 0, memory: [] });
    expect(gw.narratorPrompts.at(-1) ?? "").toBe(baseline);
  });
});

describe("dialogue turn — recall appears on a LATER turn (offline smoke)", () => {
  test("addressing a companion, then addressing again, surfaces the prior beat in its reply prompt", async () => {
    const gw = new RecordingGateway();
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset: await loadExample(), // the Emberford example (npc.lyra companion)
      store: new InMemoryGameStateStore(),
      gateway: gw,
      rng: mulberry32(1),
    });
    await engine.start();

    // Turn 1: address Lyra. The "Spoke with You." beat is recorded at commit, AFTER this reply —
    // so it must NOT yet appear in turn 1's reply prompt. The NPC reply prompt is the narrator-role
    // prompt bearing `# DIRECT ADDRESS` (the DM now also narrates the reply as a public beat, so the
    // LAST narrator prompt is the DM's narration, not the reply).
    await engine.submitPlayerInput("Lyra, hello there.");
    const firstReply = gw.narratorPrompts.find((p) => p.includes(BRIEF_MARKERS.directAddress)) ?? "";
    expect(firstReply).toContain(BRIEF_MARKERS.directAddress);
    expect(firstReply).not.toContain("# YOU REMEMBER"); // nothing remembered yet on the first turn
    const afterTurn1 = gw.narratorPrompts.length;

    // Turn 2: address Lyra again. Now the prior beat is in her journal → recalled in this prompt.
    await engine.submitPlayerInput("Lyra, still with me?");
    const secondReply =
      gw.narratorPrompts.slice(afterTurn1).find((p) => p.includes(BRIEF_MARKERS.directAddress)) ?? "";
    expect(secondReply).toContain("# YOU REMEMBER");
    expect(secondReply).toContain("Spoke with You.");
    // Placement contract holds end-to-end: recall precedes the current addressed line.
    expect(secondReply.indexOf("# YOU REMEMBER")).toBeLessThan(secondReply.indexOf(BRIEF_MARKERS.directAddress));
  });
});
