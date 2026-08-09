/**
 * Campaign rolling-summary fold (M4 follow-up) — the pure floor + the gateway path.
 *
 * Asserts the two halves of `src/memory/summary.ts`:
 *  - `buildDigest`/`capWords` are PURE and deterministic: same inputs → same string, recency-biased
 *    word-capping with an elision mark, and the `[*]` state-change marker stripped so the digest
 *    reads as prose. This is the offline/failure floor the rest of the feature leans on.
 *  - `foldCampaignSummary` calls the GUARDED `narrator` role but degrades to EXACTLY that digest on
 *    blocked / empty / a thrown gateway, and NEVER throws. A real model reply is taken but
 *    defensively word-capped so the brief can't grow unbounded — and the MODEL'S NAME is never a
 *    reason to drop it (regex audit §10a).
 *
 * Deterministic + isolated: hand-rolled fake gateways, no engine/state/IO.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  buildDigest,
  capWords,
  foldCampaignSummary,
  type FoldInput,
} from "../src/memory/summary.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { CompletionResult, EmbeddingResult, LlmRole } from "../src/llm/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";

/** A minimal gateway whose `complete` returns a fixed result (or throws); embed/stream unused here. */
class FakeGateway implements LlmGateway {
  constructor(private readonly responder: () => Promise<CompletionResult>) {}
  complete(_role: LlmRole, _req: Parameters<LlmGateway["complete"]>[1]): Promise<CompletionResult> {
    return this.responder();
  }
  async *stream(): AsyncIterable<never> {
    throw new Error("not used");
  }
  embed(): Promise<EmbeddingResult> {
    throw new Error("not used");
  }
}

const input = (overrides: Partial<FoldInput> = {}): FoldInput => ({
  prevSummary: "",
  batchLines: [],
  digestLines: [],
  maxWords: 50,
  ...overrides,
});

describe("capWords", () => {
  test("returns text unchanged (normalized whitespace) when under budget", () => {
    expect(capWords("the party reached the keep", 50)).toBe("the party reached the keep");
  });

  test("keeps the LAST N words (recency) and marks the elision", () => {
    expect(capWords("one two three four five", 2)).toBe("… four five");
  });

  test("collapses arbitrary whitespace into single spaces", () => {
    expect(capWords("a\n\nb   c", 50)).toBe("a b c");
  });
});

describe("buildDigest (the deterministic floor)", () => {
  test("appends salient lines to the prior summary, in order", () => {
    const out = buildDigest("The party left town.", ["They crossed the river.", "A wolf attacked."], 50);
    expect(out).toBe("The party left town. They crossed the river. A wolf attacked.");
  });

  test("strips the [*] state-change marker so it reads as prose", () => {
    const out = buildDigest("", ["[*] The gate opened.", "Garrick drew his blade."], 50);
    expect(out).toBe("The gate opened. Garrick drew his blade.");
  });

  test("is deterministic — identical inputs yield an identical string", () => {
    const a = buildDigest("Prior.", ["[*] x happened.", "y said hello."], 30);
    const b = buildDigest("Prior.", ["[*] x happened.", "y said hello."], 30);
    expect(a).toBe(b);
  });

  test("caps to the word budget, keeping the most recent words (oldest dropped)", () => {
    // "alpha beta gamma delta epsilon" (5 words) capped to 3 keeps the last three.
    const out = buildDigest("alpha beta", ["gamma delta epsilon"], 3);
    expect(out).toBe("… gamma delta epsilon");
  });

  test("empty inputs yield an empty string", () => {
    expect(buildDigest("", [], 50)).toBe("");
  });

  test("blank lines are dropped, not joined as gaps", () => {
    expect(buildDigest("Start.", ["", "  ", "Real line."], 50)).toBe("Start. Real line.");
  });
});

describe("foldCampaignSummary — the guarded gateway path with a deterministic floor", () => {
  const fold = input({
    prevSummary: "The party reached the mill.",
    batchLines: ["[roll] Stealth → 14 SUCCESS", "GM: The door creaks open.", "[*] Garrick joined the party."],
    digestLines: ["The door creaks open.", "[*] Garrick joined the party."],
    maxWords: 50,
  });
  const expectedDigest = buildDigest(fold.prevSummary, fold.digestLines, fold.maxWords);

  // Regex audit §10a. `isOfflineModel(m) => m.startsWith("offline")` used to gate this fold, so a
  // self-hoster's model TAG decided whether their campaign kept a rolling summary. Both of these ids
  // reproduced the loss against the shipped function (they returned the digest, "a b", in a scratch
  // run); both are ordinary LM Studio / Ollama tags, not the test gateway.
  test("a model whose id merely BEGINS \"offline\" is still a real model — its summary is taken", async () => {
    for (const model of ["offline-llama-3-8b", "offlinemind-7b", "Offline-Mistral-7B"]) {
      const gw = new FakeGateway(() => Promise.resolve({ text: "The party reached the mill and pressed on.", model }));
      expect(await foldCampaignSummary(gw, fold)).toBe("The party reached the mill and pressed on.");
    }
  });

  // …and the other direction: the deterministic TEST gateway still yields the floor verbatim, because
  // it now ANSWERS NOTHING to this prompt rather than being recognised by its model id.
  test("the OfflineGateway stub ⇒ EXACTLY the deterministic digest (it says nothing at all)", async () => {
    expect(await foldCampaignSummary(new OfflineGateway(), fold)).toBe(expectedDigest);
  });

  test("blocked result ⇒ the digest floor", async () => {
    const gw = new FakeGateway(() => Promise.resolve({ text: "", model: "real-model", blocked: true }));
    expect(await foldCampaignSummary(gw, fold)).toBe(expectedDigest);
  });

  test("empty/whitespace model reply ⇒ the digest floor", async () => {
    const gw = new FakeGateway(() => Promise.resolve({ text: "   \n  ", model: "real-model" }));
    expect(await foldCampaignSummary(gw, fold)).toBe(expectedDigest);
  });

  test("a THROWING gateway ⇒ the digest floor (never throws)", async () => {
    const gw = new FakeGateway(() => Promise.reject(new Error("network down")));
    await expect(foldCampaignSummary(gw, fold)).resolves.toBe(expectedDigest);
  });

  test("a real model reply is taken (not the floor) and word-capped", async () => {
    const longReply = Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ");
    const gw = new FakeGateway(() => Promise.resolve({ text: longReply, model: "real-model" }));
    const out = await foldCampaignSummary(gw, { ...fold, maxWords: 10 });
    expect(out).not.toBe(expectedDigest);
    expect(out.startsWith("… ")).toBe(true);
    // 10 kept words + the leading "…" token = 11 whitespace-separated tokens.
    expect(out.split(/\s+/).filter(Boolean)).toHaveLength(11);
    expect(out.endsWith("w79")).toBe(true);
  });
});
