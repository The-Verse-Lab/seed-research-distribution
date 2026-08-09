/**
 * ConsequenceBinder (Phase 3) — the ENGINE integration: a classified turn carrying a real `impact`
 * binds ≥1 persistent delta (a transgression's notoriety + victim disposition/faction/memory, a social
 * ask granted), so success stops being indistinguishable from failure (playtest #1). Driven with a
 * STUB classifier (the deterministic test classifier never sets impact — that's exactly why the whole
 * existing suite is untouched), the offline gateway, and seeded rng.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { mulberry32 } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { GameEvent } from "../src/events/types.ts";

const pcStats = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 12, armorClass: 10 };

/** A PC standing with one neutral merchant (a faction member) in a market. */
function buildPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.conseq",
    name: "Testmarket",
    summary: "A test market.",
    locations: [{ id: "loc.market", name: "The Market", description: "Stalls and crowds.", npcs: ["npc.maro"] }],
    npcs: [
      {
        id: "npc.maro",
        name: "Maro",
        persona: "A relic-broker.",
        age: 40,
        alignment: "tn",
        factionId: "fac.merchants",
        autonomy: { isPartyMember: false, level: "passive" },
      },
    ],
    factions: [{ id: "fac.merchants", name: "The Merchants" }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.conseq",
    name: "Test Campaign",
    worldId: "w.conseq",
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: "loc.market", party: ["pc.you"] },
  });
  return { world, campaign };
}

/** A classifier that returns a FIXED plan for every input (the LLM-classifier stand-in for a test). */
function stubClassifier(plan: TurnPlan): TurnClassifier {
  return { classify: () => Promise.resolve(plan) };
}

async function drive(plan: TurnPlan, input: string): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const engine = new GameEngine({
    classifier: stubClassifier(plan),
    playset: buildPlayset(),
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(7),
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  await engine.submitPlayerInput(input);
  return { engine, events };
}

const baseCheck = { warranted: true, ability: "dex" as const, skill: null, dc: 13, reason: "" };
const checkPlan = (impact: TurnPlan["impact"], over: Partial<TurnPlan> = {}): TurnPlan =>
  ({
    kind: "attemptRequiringCheck",
    targetId: null,
    destinationLocationId: null,
    check: baseCheck,
    impact,
    confidence: 0.9,
    ...over,
  }) as TurnPlan;

describe("ConsequenceBinder — a transgression leaves a persistent trace (playtest #1)", () => {
  test("a property crime against a present NPC drops their regard + raises regional notoriety", async () => {
    const plan = checkPlan({ domain: "property", severity: "serious", victimId: "npc.maro" });
    const { engine, events } = await drive(plan, "I tip a lit lamp into the relic stall.");
    const state = engine.getState();
    // The victim's regard toward the PC hardened (a real, carried-forward delta — not a bare "failure").
    expect((state.relationships["npc.maro"]?.["pc.you"] ?? 0)).toBeLessThan(0);
    // Regional notoriety was stamped (scope = the location id, no region authored here).
    expect(state.flags["notoriety.loc.market"]).toBeGreaterThanOrEqual(1);
    // A single authoritative beat surfaced it.
    const beat = events.find((e) => e.kind === "stateChanged" && /notoriety|regard|remember/i.test((e as { summary?: string }).summary ?? ""));
    expect(beat).toBeDefined();
  });

  test("success and failure NO LONGER fold to the same state — both leave a trace, success weighs more", async () => {
    // Seed the roll so we get one of each across two runs by flipping the DC extreme.
    const win = checkPlan({ domain: "violence", severity: "grave", victimId: "npc.maro" }, { check: { ...baseCheck, dc: 1 } });
    const lose = checkPlan({ domain: "violence", severity: "grave", victimId: "npc.maro" }, { check: { ...baseCheck, dc: 30 } });
    const a = await drive(win, "I lunge at Maro.");
    const b = await drive(lose, "I lunge at Maro.");
    const notorietyA = a.engine.getState().flags["notoriety.loc.market"] as number;
    const notorietyB = b.engine.getState().flags["notoriety.loc.market"] as number;
    expect(notorietyA).toBeGreaterThanOrEqual(1);
    expect(notorietyB).toBeGreaterThanOrEqual(1); // a MISS still leaves a trace (you were seen trying)
    expect(notorietyA).toBeGreaterThan(notorietyB); // ...but a landed grave act weighs more than a miss
  });
});

describe("ConsequenceBinder — a social ask lands a real outcome, and a neutral turn binds nothing", () => {
  test("pressing an NPC changes their regard (a bound outcome, not a bare success)", async () => {
    const plan = checkPlan(
      { domain: "social", severity: "minor", victimId: "npc.maro" },
      { targetId: "npc.maro", check: { ...baseCheck, ability: "cha" } },
    );
    const { engine } = await drive(plan, "I try to persuade Maro to lower the toll.");
    // Win (+2) or lose (−2), the regard MOVED — the social attempt is no longer a stateless dice roll.
    expect((engine.getState().relationships["npc.maro"]?.["pc.you"] ?? 0)).not.toBe(0);
  });

  test("a NEUTRAL turn (impact none — every deterministic-classifier turn) binds NO consequence", async () => {
    const plan = checkPlan({ domain: "none", severity: "none", victimId: null });
    const { engine, events } = await drive(plan, "I look around the market.");
    const state = engine.getState();
    expect(state.flags["notoriety.loc.market"]).toBeUndefined();
    expect(state.relationships["npc.maro"]?.["pc.you"] ?? 0).toBe(0);
    expect(events.some((e) => e.kind === "stateChanged" && /notoriety|regard|remember/i.test((e as { summary?: string }).summary ?? ""))).toBe(false);
  });

  test("a domain-set but SEVERITY-NONE impact binds NOTHING — no dead flag, byte-stable (review fix)", async () => {
    // isMeaningful requires both a domain AND a severity; the binder's guard must match, or the floor
    // would fire a dead witnessed.<loc> flag + a CONSEQUENCES block on a turn the design deems neutral.
    const plan = checkPlan({ domain: "violence", severity: "none", victimId: "npc.maro" });
    const { engine } = await drive(plan, "I glare at Maro.");
    const state = engine.getState();
    expect(state.flags["notoriety.loc.market"]).toBeUndefined();
    expect(state.flags["witnessed.loc.market"]).toBeUndefined();
    expect(state.relationships["npc.maro"]?.["pc.you"] ?? 0).toBe(0);
  });
});
