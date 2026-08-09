/**
 * Formative memories — what an NPC already remembers about itself the first time you meet it.
 *
 * The gap this closes: an NPC carries an authored role, faction, bonds and goals, but its JOURNAL
 * starts empty, so the first several conversations recall nothing and the character reads as though
 * it began existing when the player walked in.
 *
 * The two properties that make this safe are what these specs pin: it is DERIVED (never a delta,
 * never persisted, so the replay invariant cannot see it) and it is SUBORDINATE (real recorded beats
 * always speak first, and the derived floor fades out entirely once a character has a past of its
 * own). Plus the standing house rule for any opt-in: flag absent ⇒ byte-identical.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { FORMATIVE_FADE_AT, formativeFloor, formativeMemories } from "../src/rules/formative-memory.ts";
import { renderRecall } from "../src/modules/npc-memory/state.ts";
import { WorldSchema, type World } from "../src/content/schema.ts";
import type { WorldModel } from "../src/world/model.ts";
import type { NpcMemoryEntry } from "../src/rules/npc-memory.ts";

function makeWorld(formative: boolean): World {
  return WorldSchema.parse({
    id: "w.fm",
    name: "FM",
    summary: "s",
    ...(formative ? { formativeMemories: true } : {}),
    factions: [{ id: "fac.lances", name: "the Free Lances", description: "Sellswords." }],
    locations: [{ id: "loc.a", name: "A", description: "d", npcs: ["npc.veil", "npc.oda"] }],
    npcs: [
      {
        id: "npc.veil",
        name: "Veil",
        summary: "A muster-clerk.",
        persona: "Flat.",
        socialRole: "the Free Lances' muster-clerk, keeper of the contract-board",
        factionId: "fac.lances",
        goals: ["Keep the board honest, whatever it costs. And it will cost."],
        relationships: { "npc.oda": -70 },
        knowledge: [],
      },
      { id: "npc.oda", name: "Oda", summary: "A wayfarer.", persona: "Patient.", knowledge: [] },
      { id: "npc.blank", name: "Blank", summary: "Nothing authored.", persona: "Quiet.", knowledge: [] },
    ],
  });
}

const world = makeWorld(true);
const veil = world.npcs.find((n) => n.id === "npc.veil")!;

/** A model carrying `n` real recorded beats for Veil. */
function modelWith(n: number): WorldModel {
  const entries: NpcMemoryEntry[] = Array.from({ length: n }, (_, i) => ({
    at: 100 + i,
    kind: "addressed",
    summary: `Real beat ${i}.`,
  }));
  return { clock: 500, modules: { npcMemory: { entries: { "npc.veil": entries } } } } as unknown as WorldModel;
}

describe("formative memories", () => {
  test("an NPC's role, faction, strongest bond and first goal each become a beat", () => {
    const beats = formativeMemories(world, veil);
    const text = beats.map((b) => b.summary).join("\n");
    expect(text).toContain("the Free Lances' muster-clerk");
    expect(text).toContain("I have stood with the Free Lances");
    expect(text).toContain("Oda and I have history, and none of it good");
    expect(text).toContain("Keep the board honest");
    // They predate the campaign clock, which is exactly what they are.
    expect(beats.every((b) => b.at === 0)).toBe(true);
  });

  test("a warm bond reads warm, a cold one cold", () => {
    const warm = WorldSchema.parse({
      ...makeWorld(true),
      npcs: [{ ...veil, relationships: { "npc.oda": 80 } }, world.npcs[1]!],
    });
    const text = formativeMemories(warm, warm.npcs[0]!).map((b) => b.summary).join("\n");
    expect(text).toContain("I count them a friend");
  });

  test("an NPC with nothing authored yields nothing — the block stays omit-when-empty", () => {
    const blank = world.npcs.find((n) => n.id === "npc.blank")!;
    expect(formativeMemories(world, blank)).toEqual([]);
  });

  test("a bond pointing at nobody the world names is not remembered", () => {
    // A dangling relationship id must never become a remembered person.
    const dangling = { ...veil, relationships: { "npc.ghost": -90 } };
    const text = formativeMemories(world, dangling).map((b) => b.summary).join("\n");
    expect(text).not.toContain("history");
  });

  test("derivation is deterministic — same template, same lines, same order", () => {
    expect(formativeMemories(world, veil)).toEqual(formativeMemories(world, veil));
  });

  test("real history crowds the derived floor out, then ends it", () => {
    expect(formativeFloor(world, veil, 0).length).toBeGreaterThan(0);
    // Each real beat takes a derived slot...
    expect(formativeFloor(world, veil, 2).length).toBeLessThan(formativeFloor(world, veil, 0).length);
    // ...and past the fade point the character has a past of its own.
    expect(formativeFloor(world, veil, FORMATIVE_FADE_AT)).toEqual([]);
  });

  test("recall puts lived history first and the derived floor beneath it", () => {
    const lines = renderRecall(modelWith(2), "npc.veil", 6, world);
    expect(lines[0]).toContain("Real beat 0");
    expect(lines[1]).toContain("Real beat 1");
    expect(lines.slice(2).join("\n")).toContain("muster-clerk");
  });

  test("with the flag absent the prompt is byte-identical", () => {
    const off = makeWorld(false);
    expect(renderRecall(modelWith(0), "npc.veil", 6, off)).toEqual([]);
    // …and omitting the world entirely is the same as before the feature existed.
    expect(renderRecall(modelWith(0), "npc.veil", 6)).toEqual([]);
  });

  test("nothing derived ever reaches the model", () => {
    // The floor is read-only by construction: it takes a template and returns entries. This pins the
    // contract that matters — no command, no delta, so `snapshot == fold(deltas)` cannot see it.
    const model = modelWith(0);
    const before = JSON.stringify(model.modules);
    renderRecall(model, "npc.veil", 6, world);
    expect(JSON.stringify(model.modules)).toBe(before);
  });
});
