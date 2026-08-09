/**
 * Transcript export tests.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { transcriptToJson, transcriptToMarkdown } from "../src/logging/export.ts";
import type { GameEvent } from "../src/events/types.ts";

const EVENTS: GameEvent[] = [
  { id: "1", at: 0, seq: 0, kind: "narration", text: "You enter the room." },
  { id: "2", at: 0, seq: 1, kind: "dialogue", actorId: "npc.lyra", toId: "pc.you", text: "Hello." },
  { id: "3", at: 0, seq: 2, kind: "diceRolled", notation: "1d20", rolls: [15], total: 18, purpose: "Stealth check", success: true },
  { id: "4", at: 0, seq: 3, kind: "system", level: "info", message: "loaded" },
];

describe("transcriptToMarkdown", () => {
  test("renders narration, named dialogue, and dice; omits system noise", () => {
    const md = transcriptToMarkdown(EVENTS, {
      title: "Test",
      nameOf: (id) => (id === "npc.lyra" ? "Lyra" : id === "pc.you" ? "You" : id),
    });
    expect(md).toContain("# Test");
    expect(md).toContain("You enter the room.");
    expect(md).toContain("**Lyra (to You):** Hello.");
    expect(md).toContain("Stealth check: rolled 18 — success");
    expect(md).not.toContain("loaded");
  });

  test("falls back to ids when no name resolver is given", () => {
    expect(transcriptToMarkdown(EVENTS)).toContain("**npc.lyra (to pc.you):** Hello.");
  });
});

describe("transcriptToJson", () => {
  test("bundles campaign id, events, and state", () => {
    const d = JSON.parse(transcriptToJson({ campaignId: "c1", exportedAt: 123, events: EVENTS, state: { x: 1 } }));
    expect(d.campaignId).toBe("c1");
    expect(d.events.length).toBe(4);
    expect(d.state.x).toBe(1);
  });
});
