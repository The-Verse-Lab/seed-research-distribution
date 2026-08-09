/**
 * Learn-spell engine tests — the magic-acquisition intent end to end: a scripted `learn` plan runs a
 * real classified turn that grounds the source, spends its cost, and unions the spell into the PC's
 * earned spellbook through the `learnSpell` reducer (so it is then castable + persisted). Scripted
 * classifier stubs drive the intent — the LLM classifier is the product classifier; tests never
 * regex-guess.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { ItemSchema, SpellSchema, type PlaySet } from "../src/content/schema.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { readProgressionSlice } from "../src/rules/progression.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { loadExample } from "./support/harness.ts";

const PC = "pc.you";

function learnPlan(
  spellId: string,
  sourceId: string | null,
  source: "study" | "trainer" | "scroll" | null = null,
): TurnPlan {
  return {
    kind: "learn",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    learn: { spellId, source, sourceId },
    confidence: 1,
  };
}

function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return { classify: () => Promise.resolve(plans[Math.min(i++, plans.length - 1)]!) };
}

async function startWith(playset: PlaySet, plans: TurnPlan[]): Promise<GameEngine> {
  const engine = new GameEngine({
    classifier: scriptedClassifier(plans),
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(7),
  });
  await engine.start();
  return engine;
}

describe("learn via scroll", () => {
  test("reading a teaching scroll learns the spell and consumes the scroll", async () => {
    const playset = await loadExample();
    playset.world.spells.push(SpellSchema.parse({ id: "spell.frost", name: "Frost Touch", level: 0 }));
    playset.world.items.push(
      ItemSchema.parse({
        id: "item.scroll-frost",
        name: "Frost Scroll",
        kind: "misc",
        properties: { teachesSpell: "spell.frost" },
      }),
    );
    playset.campaign.characters[0]!.inventory.push("item.scroll-frost");

    const engine = await startWith(playset, [learnPlan("spell.frost", "item.scroll-frost")]);
    await engine.submitPlayerInput("I read the frost scroll and study it");

    const state = engine.getState();
    const learned = readProgressionSlice(state.modules)[PC]?.learned ?? [];
    expect(learned).toContain("spell.frost");
    // The scroll is spent in the reading — gone from the pack.
    expect(state.actors[PC]?.inventory ?? []).not.toContain("item.scroll-frost");
  });

  test("an explicit STUDY intent never consumes a matching scroll (the source discriminator)", async () => {
    const playset = await loadExample();
    playset.world.spells.push(SpellSchema.parse({ id: "spell.frost", name: "Frost Touch", level: 0 }));
    playset.world.items.push(
      ItemSchema.parse({
        id: "item.scroll-frost",
        name: "Frost Scroll",
        kind: "misc",
        properties: { teachesSpell: "spell.frost" },
      }),
    );
    playset.campaign.characters[0]!.inventory.push("item.scroll-frost");

    // The PC means to STUDY (a level-up credit), not read the scroll. With no credit here the learn
    // fails cleanly — but the key invariant is it must NOT silently fall through to the scroll and
    // burn it (the pre-fix bug: `sourceId: null` read as "no preference" ⇒ scroll consumed).
    const engine = await startWith(playset, [learnPlan("spell.frost", null, "study")]);
    await engine.submitPlayerInput("I study the next working I'm ready for");

    const state = engine.getState();
    expect(readProgressionSlice(state.modules)[PC]?.learned ?? []).not.toContain("spell.frost");
    expect(state.actors[PC]?.inventory ?? []).toContain("item.scroll-frost"); // scroll intact
  });

  test("a spell already known is not re-learned (no-op)", async () => {
    const playset = await loadExample();
    playset.world.spells.push(SpellSchema.parse({ id: "spell.frost", name: "Frost Touch", level: 0 }));
    playset.campaign.characters[0]!.stats.spells.push("spell.frost"); // authored-known
    playset.world.items.push(
      ItemSchema.parse({
        id: "item.scroll-frost",
        name: "Frost Scroll",
        kind: "misc",
        properties: { teachesSpell: "spell.frost" },
      }),
    );
    playset.campaign.characters[0]!.inventory.push("item.scroll-frost");

    const engine = await startWith(playset, [learnPlan("spell.frost", "item.scroll-frost")]);
    await engine.submitPlayerInput("I read the frost scroll");

    const state = engine.getState();
    // Nothing learned (already known), and the scroll is NOT consumed.
    expect(readProgressionSlice(state.modules)[PC]?.learned ?? []).not.toContain("spell.frost");
    expect(state.actors[PC]?.inventory ?? []).toContain("item.scroll-frost");
  });
});

describe("learn via trainer", () => {
  test("a present tutor teaching for free imparts the spell", async () => {
    const playset = await loadExample();
    playset.world.spells.push(SpellSchema.parse({ id: "spell.frost", name: "Frost Touch", level: 0 }));
    // Make the example's co-located companion a spell tutor (free tuition — the PC starts penniless).
    const tutor = playset.world.npcs.find((n) => n.id === "npc.lyra");
    if (!tutor) throw new Error("expected npc.lyra in the example world");
    tutor.teaches = [{ spellId: "spell.frost", costCoins: 0 }];

    const engine = await startWith(playset, [learnPlan("spell.frost", "npc.lyra")]);
    await engine.submitPlayerInput("I ask Lyra to teach me the frost working");

    const state = engine.getState();
    expect(readProgressionSlice(state.modules)[PC]?.learned ?? []).toContain("spell.frost");
  });

  test("a tutor's tuition the PC cannot afford blocks the learning", async () => {
    const playset = await loadExample();
    playset.world.spells.push(SpellSchema.parse({ id: "spell.frost", name: "Frost Touch", level: 0 }));
    const tutor = playset.world.npcs.find((n) => n.id === "npc.lyra");
    if (!tutor) throw new Error("expected npc.lyra in the example world");
    tutor.teaches = [{ spellId: "spell.frost", costCoins: 5000 }]; // more than the PC's 0 coins

    const engine = await startWith(playset, [learnPlan("spell.frost", "npc.lyra")]);
    await engine.submitPlayerInput("I ask Lyra to teach me the frost working");

    const state = engine.getState();
    expect(readProgressionSlice(state.modules)[PC]?.learned ?? []).not.toContain("spell.frost");
  });
});
