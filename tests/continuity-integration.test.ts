/**
 * Continuity Judge — end-to-end integration through the real engine (`continuityJudge: true`).
 *
 * A scriptable gateway returns a cast/phantom-state-hallucinating narration on the first pass and a
 * clean one once the CONTINUITY CORRECTION directive appears, while answering the Judge's utility-role
 * call with a scripted verdict. This proves the whole judged-narration path wired together — ledger →
 * bundle → buffer predicate → adjudicate → regenerate → emit — not just the pure checks in isolation.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { byKind, makeEngine } from "./support/harness.ts";
import { offlineUtility } from "./support/offline-gateway.ts";
import { chunkWords } from "../src/util/text.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { CompletionChunk, CompletionRequest, CompletionResult, EmbeddingResult, LlmRole } from "../src/llm/types.ts";

function lastUser(req: CompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) if (req.messages[i]?.role === "user") return req.messages[i]!.content;
  return "";
}
function systemOf(req: CompletionRequest): string {
  return req.messages.find((m) => m.role === "system")?.content ?? "";
}

/** Scriptable gateway: phantom narrator draft → clean on correction; scripted Judge verdict on utility. */
class ScriptGateway implements LlmGateway {
  judgeCalls = 0;
  constructor(private readonly opts: { draft: string; clean: string; verdict: unknown[] }) {}
  complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    if (role === "utility") {
      if (systemOf(req).includes("continuity checker")) {
        this.judgeCalls++;
        // A faithful Judge flags the phantom DRAFT but CLEARS the corrected prose — the judged text is
        // embedded verbatim in the prompt, so key the verdict on whether the phantom draft is present.
        // (The old stub returned a fixed verdict regardless of prose; now that every regeneration
        // candidate is re-adjudicated, that would wrongly reject the clean retry too.)
        const judgesTheDraft = lastUser(req).includes(this.opts.draft);
        return Promise.resolve({
          text: JSON.stringify({ violations: judgesTheDraft ? this.opts.verdict : [] }),
          model: "stub",
        });
      }
      return Promise.resolve({ text: offlineUtility(), model: "stub" });
    }
    // A regeneration carries the CONTINUITY CORRECTION block; the first pass does not.
    const text = lastUser(req).includes("CONTINUITY CORRECTION") ? this.opts.clean : this.opts.draft;
    return Promise.resolve({ text, model: "stub" });
  }
  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const { text } = await this.complete(role, req);
    for (const t of chunkWords(text)) yield { delta: t, done: false };
    yield { delta: "", done: true };
  }
  embed(_role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return Promise.resolve({ vectors: texts.map(() => new Array(8).fill(0)), model: "stub" });
  }
}

describe("Continuity Judge (engine integration)", () => {
  test("a phantom state change on a verifiable turn is caught and regenerated away", async () => {
    const gateway = new ScriptGateway({
      draft: "You cross toward the square as the iron gate swings open before you.",
      clean: "You cross into the square, boots loud on the wet stone.",
      verdict: [{ kind: "phantomState", detail: "no barrier was opened", correction: "the gate did not open" }],
    });
    const { engine, events } = await makeEngine({ gateway, continuityJudge: true, summary: false });
    events.length = 0;
    await engine.submitPlayerInput("go to the square");
    const narration = byKind(events, "narration").at(-1)?.text ?? "";
    // The move applied a moveParty command (significant ⇒ buffered), the draft staged a phantom gate
    // opening with no setExitState, the Judge confirmed it, and the regeneration replaced the prose.
    expect(gateway.judgeCalls).toBeGreaterThan(0);
    expect(narration).toBe("You cross into the square, boots loud on the wet stone.");
    expect(narration).not.toContain("gate swings open");
  });

  test("a clean verifiable turn emits as-is and never consults the Judge model", async () => {
    const gateway = new ScriptGateway({
      draft: "You cross into the square, boots loud on the wet stone.",
      clean: "unused",
      verdict: [],
    });
    const { engine, events } = await makeEngine({ gateway, continuityJudge: true, summary: false });
    events.length = 0;
    await engine.submitPlayerInput("go to the square");
    const narration = byKind(events, "narration").at(-1)?.text ?? "";
    expect(narration).toBe("You cross into the square, boots loud on the wet stone.");
    // Tier-1 found nothing and there is no absent cast / established-fact risk, so the model tier is
    // skipped — a clean flavor turn never pays a utility round-trip (`force:false`, the first-pass gate).
    expect(gateway.judgeCalls).toBe(0);
  });
});
