/**
 * PROSE-TO-CODE §2.12 — quest-flow diagnostics fail CI for bundled worlds (as a ratchet).
 *
 * This test makes diagnostics binding for `worlds/` content. An unlisted diagnostic (a quest
 * without a completion path or a sourceless quest item) fails the suite.
 *
 * When a listed entry stops firing, this test also fails — delete the row, so the ratchet only
 * ever tightens.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { compileAndValidatePlaySet, loadRawPlaySetFromDir } from "../src/content/loader.ts";

/**
 * Keep this empty. A new diagnostic means bundled content lacks a mechanical completion/source
 * path; fix the content rather than reopening the list.
 */
const KNOWN_DEBT: ReadonlySet<string> = new Set([]);

describe("bundled worlds — quest-flow diagnostics are binding (§2.12 ratchet)", () => {
  test("The Wakeward Isles fires exactly the pinned known-debt diagnostics, nothing new", async () => {
    const raw = await loadRawPlaySetFromDir("worlds/wakeward-isles");
    const { diagnostics } = compileAndValidatePlaySet(raw);
    const keys = diagnostics.map((d) => `${d.code}:${d.path ?? ""}`);
    const fresh = keys.filter((k) => !KNOWN_DEBT.has(k));
    // A new diagnostic means new content shipped without its completion/source path — fix the
    // content, do not extend KNOWN_DEBT.
    expect(fresh).toEqual([]);
    // The ratchet's other jaw: paid-down debt must be deleted from the pin list.
    const stale = [...KNOWN_DEBT].filter((k) => !keys.includes(k));
    expect(stale).toEqual([]);
  });
});
