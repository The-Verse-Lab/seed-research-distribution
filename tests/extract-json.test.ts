/**
 * `extractJson` — pulling the model's JSON payload out of a chatty completion.
 *
 * Every model-reading utility outside the classifier funnels through this one function (the
 * character builder's rounds, party enrichment, prose-entity extraction, case testimony), and each
 * of them treats a throw as "the model failed" and drops the whole result. So a reply shape that
 * defeats the extractor is not a cosmetic bug: it is a silent feature outage on a model that
 * answered correctly.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { extractJson } from "../src/worldsmith/reconcile.ts";

describe("extractJson", () => {
  test("a bare object, fenced or not", () => {
    expect(extractJson('{"name":"Ro"}')).toBe('{"name":"Ro"}');
    expect(extractJson('here you go: {"name":"Ro"} — hope that helps')).toBe('{"name":"Ro"}');
    expect(extractJson('```json\n{"name":"Ro"}\n```')).toBe('{"name":"Ro"}');
  });

  test("a fenced ASIDE before the payload no longer swallows the answer (r8 regex audit)", () => {
    // Reproduced against the shipped function: it matched ONE fenced block — the first — and
    // searched only inside it, so a reasoning model that fences its scratch-work first threw
    // "no JSON object in worldsmith output" and the builder round was reported as a model failure.
    const reply = [
      "Here is my reasoning first:",
      "```",
      "The character should feel weathered.",
      "```",
      "And here is the character:",
      "```json",
      '{"name":"Elis Vane","ancestry":"human"}',
      "```",
    ].join("\n");
    expect(extractJson(reply)).toBe('{"name":"Elis Vane","ancestry":"human"}');
  });

  test("the first block that PARSES wins — braces in an aside do not decide it", () => {
    const reply = [
      "```",
      "Sketch: { a mood, not a payload }",
      "```",
      "```json",
      '{"npcs":[],"places":[]}',
      "```",
    ].join("\n");
    expect(extractJson(reply)).toBe('{"npcs":[],"places":[]}');
  });

  test("a fence marker INSIDE the payload falls back to the raw scan", () => {
    expect(extractJson('```json\n{"name":"Ro","note":"a ``` inside"}\n```')).toBe(
      '{"name":"Ro","note":"a ``` inside"}',
    );
  });

  test("nothing brace-shaped anywhere still throws", () => {
    expect(() => extractJson("I'm sorry, I can't help with that.")).toThrow(/no JSON object/);
    expect(() => extractJson("")).toThrow(/no JSON object/);
  });

  test("a brace span that does not parse is still returned, so the CALLER reports the real error", () => {
    // Legacy behavior, deliberately preserved: the caller's own JSON.parse throws a message that
    // names the syntax problem, which is more useful than a flat "no JSON object".
    expect(extractJson('{"name": }')).toBe('{"name": }');
  });
});
