/** End-to-end authored epistemic routing pins for the bundled research world. */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { composeEpistemicPacket } from "../src/knowledge/packet.ts";

const DIR = fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url));

describe("Wakeward authored fact routing", () => {
  test("a current ferry question answers with the revision and marks the noon schedule as history", async () => {
    const { world } = await loadPlaySetFromDir(DIR);
    const packet = composeEpistemicPacket({
      world,
      npcTemplateId: "npc.ivo-pell",
      npcName: "Ivo Pell",
      playerLine: "When does the Cinderhook ferry leave now?",
      ask: { kind: "current-status", timeframe: "current", locality: "nearby" },
      locationId: "loc.bellharbor-relay",
      adjacentLocationIds: ["loc.bellharbor-quay", "loc.bellharbor-market"],
    });
    expect(packet.authoritative.find((row) => row.id === "fact.ferry.second-bell")?.text).toContain("11:00");
    expect(packet.history.find((row) => row.id === "fact.ferry.old-second-bell")?.text).toContain("noon");
    expect(packet.authoritative.some((row) => row.id === "fact.ferry.old-second-bell")).toBe(false);
  });

  test("a historical question promotes the superseded schedule only as requested past context", async () => {
    const { world } = await loadPlaySetFromDir(DIR);
    const packet = composeEpistemicPacket({
      world,
      npcTemplateId: "npc.ivo-pell",
      npcName: "Ivo Pell",
      playerLine: "When did the ferry leave before the gale?",
      ask: { kind: "history", timeframe: "historical", locality: "nearby" },
      locationId: "loc.bellharbor-relay",
      adjacentLocationIds: ["loc.bellharbor-quay"],
    });
    expect(packet.authoritative.find((row) => row.id === "fact.ferry.old-second-bell")?.temporal).toBe("historical");
    const current = packet.history.find((row) => row.id === "fact.ferry.second-bell");
    if (current) expect(current.temporal).toBe("current");
  });

  test("Nia's private admission appears only when its topic is actually asked", async () => {
    const { world } = await loadPlaySetFromDir(DIR);
    const packet = (line: string) => composeEpistemicPacket({
      world,
      npcTemplateId: "npc.nia-wren",
      npcName: "Nia Wren",
      playerLine: line,
      ask: { kind: "explanation", timeframe: "historical", locality: "here" },
      locationId: "loc.bellharbor-quay",
      adjacentLocationIds: [],
    });
    const admission = "copied the first cargo list before Ivo's correction arrived";
    expect(JSON.stringify(packet("Who copied the first cargo list?"))).toContain(admission);
    expect(JSON.stringify(packet("Why did the seasonal gale damage the quay?"))).not.toContain(admission);
  });
});
