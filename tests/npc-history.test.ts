/**
 * Per-NPC derived history (statefulness #2+#3) — the PURE, deterministic core: the day-buffer ring, the
 * omit-when-empty prompt block, and the deterministic fold FLOOR (the guaranteed offline/failure path the
 * LLM fold degrades to). The model-backed `extractGist`/`foldNpcHistory` are best-effort and covered by the
 * floor here; their live behavior is exercised in play. The last describe pins the regex-audit §10a
 * repro: which gateway REPLY is usable is a structural question, never a question about the model's
 * NAME.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  defaultNpcHistory,
  extractGist,
  foldNpcHistory,
  foldNpcHistoryFloor,
  NPC_GIST_CAP,
  pushGist,
  renderHistoryBlock,
} from "../src/memory/npc-history.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { CompletionResult } from "../src/llm/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";

/** A gateway answering every `complete` with one fixed result; stream/embed unused here. */
const fixed = (res: CompletionResult): LlmGateway =>
  ({
    complete: () => Promise.resolve(res),
    stream: () => {
      throw new Error("not used");
    },
    embed: () => {
      throw new Error("not used");
    },
  }) as unknown as LlmGateway;

describe("pushGist (day-buffer ring)", () => {
  test("appends, caps to NPC_GIST_CAP (oldest drops), ignores blanks", () => {
    let h = defaultNpcHistory();
    for (let i = 0; i < NPC_GIST_CAP + 3; i++) h = pushGist(h, `gist ${i}`);
    expect(h.dayGists.length).toBe(NPC_GIST_CAP);
    expect(h.dayGists[0]).toBe("gist 3"); // the three oldest fell off
    expect(h.dayGists.at(-1)).toBe(`gist ${NPC_GIST_CAP + 2}`);
    expect(pushGist(h, "   ").dayGists.length).toBe(NPC_GIST_CAP); // blank records nothing
  });
});

describe("renderHistoryBlock (omit-when-empty)", () => {
  test("empty history ⇒ [] (byte-identical prompt)", () => {
    expect(renderHistoryBlock(undefined)).toEqual([]);
    expect(renderHistoryBlock(defaultNpcHistory())).toEqual([]);
  });
  test("renders # OUR HISTORY and # RECENTLY WITH YOU when present", () => {
    const out = renderHistoryBlock({ history: "You owe me a debt.", dayGists: ["Asked about the ledger; I deflected."] });
    expect(out).toContain("# OUR HISTORY");
    expect(out).toContain("‣ You owe me a debt.");
    expect(out).toContain("# RECENTLY WITH YOU");
    expect(out).toContain("‣ Asked about the ledger; I deflected.");
  });
  test("history-only omits the recent block, and vice-versa", () => {
    expect(renderHistoryBlock({ history: "prior", dayGists: [] })).not.toContain("# RECENTLY WITH YOU");
    expect(renderHistoryBlock({ history: "", dayGists: ["today"] })).not.toContain("# OUR HISTORY");
  });
});

describe("foldNpcHistoryFloor (deterministic fold fallback)", () => {
  test("concatenates prior + today's gists", () => {
    const out = foldNpcHistoryFloor("A prior fact.", ["Today one.", "Today two."], 100);
    expect(out).toContain("A prior fact.");
    expect(out).toContain("Today one.");
    expect(out).toContain("Today two.");
  });
  test("word cap keeps the most-recent words and marks the elision", () => {
    const long = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
    const out = foldNpcHistoryFloor("", [long], 10);
    expect(out.startsWith("…")).toBe(true);
    expect(out).toContain("w49"); // recency-biased — the tail survives
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(11); // 10 words + the ellipsis marker
  });
  test("empty inputs ⇒ empty string", () => {
    expect(foldNpcHistoryFloor("", [], 100)).toBe("");
  });
});

describe("the model-backed pair — a model's NAME never decides whether its answer counts (§10a)", () => {
  const exchange = { npcName: "Veil", playerLine: "Who paid for the writ?", npcReply: "Not my ledger to open." };

  // Reproduced against the shipped functions before the fix: `isOfflineModel(res.model)` made
  // extractGist return "" and foldNpcHistory return the floor for EVERY call on these ids, so a
  // self-hoster running "offline-llama-3-8b" had NPC journals that never recorded a word.
  test("an \"offline\"-prefixed LM Studio tag is a real model — its gist and fold are taken", async () => {
    for (const model of ["offline-llama-3-8b", "offlinemind-7b"]) {
      const gw = fixed({ text: "Veil refused to name who paid for the writ.", model });
      expect(await extractGist(gw, exchange)).toBe("Veil refused to name who paid for the writ.");
      expect(await foldNpcHistory(gw, { prevHistory: "prior", gists: ["a gist"], maxWords: 50 })).toBe(
        "Veil refused to name who paid for the writ.",
      );
    }
  });

  test("a guard block and an empty reply still floor — the two structural signals that remain", async () => {
    const blocked = fixed({ text: "", model: "real-model", blocked: true });
    const empty = fixed({ text: "  \n ", model: "real-model" });
    for (const gw of [blocked, empty]) {
      expect(await extractGist(gw, exchange)).toBe("");
      expect(await foldNpcHistory(gw, { prevHistory: "prior", gists: ["a gist"], maxWords: 50 })).toBe(
        foldNpcHistoryFloor("prior", ["a gist"], 50),
      );
    }
  });

  test("the deterministic TEST gateway floors too — it answers these prompts with nothing", async () => {
    const gw = new OfflineGateway();
    expect(await extractGist(gw, exchange)).toBe("");
    expect(await foldNpcHistory(gw, { prevHistory: "prior", gists: ["a gist"], maxWords: 50 })).toBe(
      foldNpcHistoryFloor("prior", ["a gist"], 50),
    );
  });
});

describe("extractGist — the quote peel (regex audit §8g)", () => {
  const exchange = { npcName: "Veil", playerLine: "Who paid for the writ?", npcReply: "Not my ledger to open." };

  // Reproduced against the shipped `extractGist`: the peel class was `["']` only, so a model that
  // answers in the SMART quotes it writes prose with kept BOTH marks and the NPC's own
  // `# RECENTLY WITH YOU` bullet read `‣ “He asked about the ledger; she refused.”`.
  test("smart quotes, guillemets and markdown emphasis are peeled off both edges", async () => {
    const cases: [string, string][] = [
      ["“He asked about the ledger; she refused.”", "He asked about the ledger; she refused."],
      ["«He asked about the ledger; she refused.»", "He asked about the ledger; she refused."],
      ['"He asked about the ledger; she refused."', "He asked about the ledger; she refused."],
      ["**He asked about the ledger; she refused.**", "He asked about the ledger; she refused."],
      ["‘He asked about the ledger; she refused.’", "He asked about the ledger; she refused."],
    ];
    for (const [raw, want] of cases) {
      expect(await extractGist(fixed({ text: raw, model: "real-model" }), exchange)).toBe(want);
    }
  });

  test("interior quotes survive — only the EDGES are peeled", async () => {
    const gw = fixed({ text: 'Veil said “not my ledger to open” and turned away.', model: "real-model" });
    expect(await extractGist(gw, exchange)).toBe('Veil said “not my ledger to open” and turned away.');
  });
});
