/**
 * Thinking-tag filter tests — the streaming case (tags split across chunks) is the risky
 * part, so it's covered thoroughly.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { ThinkingFilter, stripThinking } from "../src/llm/thinking.ts";

describe("stripThinking (one-shot)", () => {
  test("passes plain text through unchanged", () => {
    expect(stripThinking("Just plain prose.")).toEqual({ content: "Just plain prose.", reasoning: "" });
  });

  test("removes an inline <thinking> block and captures the reasoning", () => {
    const r = stripThinking("before<thinking>secret plan</thinking>after");
    expect(r.content).toBe("beforeafter");
    expect(r.reasoning).toBe("secret plan");
  });

  test("supports the <think> variant", () => {
    expect(stripThinking("<think>hmm</think>The door opens.").content).toBe("The door opens.");
  });

  test("unclosed thinking yields all-reasoning, empty content", () => {
    const r = stripThinking("pre<thinking>still going");
    expect(r.content).toBe("pre");
    expect(r.reasoning).toBe("still going");
  });

  test("handles multiple blocks", () => {
    const r = stripThinking("a<think>x</think>b<think>y</think>c");
    expect(r.content).toBe("abc");
    expect(r.reasoning).toBe("xy");
  });

  test("leaves a non-tag '<' intact", () => {
    expect(stripThinking("5 < 10 is true").content).toBe("5 < 10 is true");
  });
});

describe("ThinkingFilter (streaming)", () => {
  function run(chunks: string[]): { content: string; reasoning: string } {
    const f = new ThinkingFilter();
    let content = "";
    let reasoning = "";
    for (const c of chunks) {
      const o = f.push(c);
      content += o.content;
      reasoning += o.reasoning;
    }
    const t = f.flush();
    return { content: content + t.content, reasoning: reasoning + t.reasoning };
  }

  test("reassembles content across chunk boundaries", () => {
    expect(run(["Hello ", "world."])).toEqual({ content: "Hello world.", reasoning: "" });
  });

  test("strips a thinking block split across many chunks", () => {
    const r = run(["be", "fore<thi", "nking>se", "cret</thin", "king>aft", "er"]);
    expect(r.content).toBe("beforeafter");
    expect(r.reasoning).toBe("secret");
  });

  test("handles an open tag split between chunks", () => {
    const r = run(["text <", "think>hidden</think> tail"]);
    expect(r.content).toBe("text  tail");
    expect(r.reasoning).toBe("hidden");
  });

  test("emits a non-tag '<' that was held back as a partial-tag suspect", () => {
    expect(run(["a <", "b c"])).toEqual({ content: "a <b c", reasoning: "" });
  });
});
