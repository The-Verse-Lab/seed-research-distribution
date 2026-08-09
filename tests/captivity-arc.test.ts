/**
 * Captivity ARC — the engine-level bad-end FOLLOW-UP loop, end to end.
 *
 * The pure resolver (`rules/captivity.ts`) and the reducer's `beginCaptivity`/`endCaptivity` are unit
 * tested elsewhere, and `combat-bad-end.test.ts` proves a lost fight MATERIALIZES a capture. What is NOT
 * covered is the turn-by-turn LOOP wired through a live `GameEngine`: a held player submitting
 * `labor`/`endure`/`escape` lines, the slice advancing, and release/escape actually turning them loose
 * with the world RESTORED (location, condition, party). This throwaway suite drives that arc against the
 * real engine + reducer to catch integration bugs the pure tests can't (a swallowed turn, a softlock, a
 * botched restore).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { mulberry32 } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { CaptivitySlice } from "../src/rules/captivity.ts";
import { CAPTIVITY_LOCATION_ID } from "../src/world/captivity.ts";

const pcStats = (str = 12) => ({
  abilities: { str, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
  maxHp: 24,
  armorClass: 10,
});
const foeStats = { abilities: { str: 18, dex: 14, con: 14, int: 8, wis: 10, cha: 8 }, maxHp: 40, armorClass: 12 };

/** A PC, a brute, and a companion in one room. plainFoe selects the generic defeat table. */
function buildPlayset(pcStr = 12): PlaySet {
  const world = WorldSchema.parse({
    id: "w.arc",
    name: "Testhold",
    summary: "A test world.",
    locations: [{ id: "loc.cell", name: "A Locked Cell", description: "Bare stone.", npcs: ["npc.brute"] }],
    npcs: [
      {
        id: "npc.brute",
        name: "Brute",
        persona: "A hostile thug — greedy, not exploitative.",
        age: 40,
        stats: foeStats,
        autonomy: { isPartyMember: false, level: "passive" },
      },
      {
        id: "npc.ally",
        name: "Ally",
        persona: "A loyal companion.",
        age: 28,
        stats: pcStats(),
        autonomy: { isPartyMember: true, level: "passive" },
      },
    ],
    constitution: { useGenericDefeatOutcomes: true },
  });
  const campaign = CampaignSchema.parse({
    id: "c.arc",
    name: "Test Campaign",
    worldId: "w.arc",
    characters: [{ id: "pc.you", name: "You", stats: pcStats(pcStr), age: 30 }],
    startingState: { locationId: "loc.cell", party: ["pc.you", "npc.ally"], companions: ["npc.ally"] },
  });
  return { world, campaign };
}

/** Mid-fight losing state: PC at 1 HP with a companion + gear, a live combat vs the brute. */
function losingState(): GameState {
  return {
    campaignId: "c.arc",
    worldId: "w.arc",
    partyLocationId: "loc.cell",
    clock: 0,
    party: ["pc.you", "npc.ally"],
    companions: ["npc.ally"],
    actors: {
      "pc.you": { id: "pc.you", currentHp: 1, locationId: "loc.cell", inventory: [], conditions: [] },
      "npc.ally": { id: "npc.ally", currentHp: 1, locationId: "loc.cell", inventory: [], conditions: [] },
      "npc.brute": { id: "npc.brute", currentHp: 40, locationId: "loc.cell", inventory: [], conditions: [] },
    },
    quests: {},
    relationships: {},
    autonomy: {},
    // Only the PC + brute in the initiative order (the downed ally sits it out) so the brute wins cleanly.
    modules: { combat: { active: true, locationId: "loc.cell", order: ["pc.you", "npc.brute"], turnIndex: 0, round: 1 } },
    flags: {},
  };
}

/** A classifier flipped between "attack the brute" (to lose the fight) and freeform (during captivity). */
function makeClassifier(): TurnClassifier & { mode: "attack" | "freeform" } {
  return {
    mode: "attack",
    async classify(): Promise<TurnPlan> {
      if (this.mode === "attack") {
        return {
          kind: "attack",
          targetId: "npc.brute",
          destinationLocationId: null,
          check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
          confidence: 1,
        };
      }
      return {
        kind: "freeformNarrative",
        targetId: null,
        destinationLocationId: null,
        check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
        confidence: 1,
      };
    },
  };
}

const capOf = (engine: GameEngine): Partial<CaptivitySlice> | undefined =>
  engine.getState().modules?.captivity as Partial<CaptivitySlice> | undefined;

/** Lose the fight against the brute under `seed`; returns the engine + whether a CAPTIVITY outcome fired. */
async function captureUnder(seed: number, pcStr = 12): Promise<{ engine: GameEngine; captured: boolean }> {
  const playset = buildPlayset(pcStr);
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey("c.arc", "pc.you"), losingState());
  const classifier = makeClassifier();
  const engine = new GameEngine({
    playset,
    store,
    gateway: new OfflineGateway(),
    classifier,
    rng: mulberry32(seed),
  });
  await engine.start();
  for (let i = 0; i < 8; i++) {
    await engine.submitPlayerInput("I attack the brute");
    if (!(engine.getState().modules?.combat as { active?: boolean })?.active) break;
  }
  classifier.mode = "freeform"; // combat over — the rest of the arc is captivity input
  return { engine, captured: capOf(engine)?.active === true };
}

/** Find a seed whose plainFoe defeat lands on a CAPTIVITY outcome (ransom/gaol/debt-bondage). */
async function captureSeed(pcStr = 12): Promise<{ engine: GameEngine; seed: number }> {
  for (let seed = 1; seed < 300; seed++) {
    const { engine, captured } = await captureUnder(seed, pcStr);
    if (captured) return { engine, seed };
  }
  throw new Error("no seed produced a captivity outcome in 300 tries");
}

describe("captivity arc (engine end-to-end)", () => {
  test("a lost fight can TAKE the player: moved to the hold, condition set, party scattered, card shown", async () => {
    const { engine } = await captureSeed();
    const state = engine.getState();
    const cap = capOf(engine);

    expect(cap?.active).toBe(true);
    expect(state.actors["pc.you"]?.locationId).toBe(CAPTIVITY_LOCATION_ID);
    expect(state.actors["pc.you"]?.conditions).toContain("captive");
    // The companion is scattered — a captive is taken alone (re-admitted on release).
    // (NPC party members project into `companions`, not `party`, which only holds PCs.)
    expect(state.companions).not.toContain("npc.ally");
    expect((state.modules?.combat as { active?: boolean })?.active).toBe(false);
    // A real term to serve + an escape DC (the card reads these).
    expect(cap?.goal ?? 0).toBeGreaterThan(0);
    expect(cap?.escapeDc ?? 0).toBeGreaterThan(0);
  });

  test("LABOR to release: the loop serves the term, then really turns the player loose (world restored)", async () => {
    const { engine } = await captureSeed();
    const origin = "loc.cell";

    let turns = 0;
    while (capOf(engine)?.active && turns < 40) {
      await engine.submitPlayerInput("I labor and do as I am told.");
      turns++;
    }

    expect(capOf(engine)?.active).not.toBe(true); // released within a sane number of turns (no softlock)
    expect(turns).toBeLessThan(40);
    const state = engine.getState();
    expect(state.actors["pc.you"]?.locationId).toBe(origin); // back where taken
    expect(state.actors["pc.you"]?.conditions).not.toContain("captive");
    expect(state.companions).toContain("npc.ally"); // party re-admitted
  });

  test("ESCAPE to freedom: a strong PC can break out mid-term (loop ends, world restored)", async () => {
    // A high-STR PC beats the escape DC quickly; labour first to wear the guard down, then run.
    const { engine } = await captureSeed(30);

    let turns = 0;
    let escaped = false;
    while (capOf(engine)?.active && turns < 40) {
      // Alternate a wearing-down labour turn with an escape attempt.
      await engine.submitPlayerInput(turns % 2 === 0 ? "I labor quietly." : "I break out and run for it.");
      turns++;
      if (!capOf(engine)?.active) {
        escaped = true;
        break;
      }
    }

    expect(escaped).toBe(true);
    expect(turns).toBeLessThan(40);
    const state = engine.getState();
    expect(state.actors["pc.you"]?.locationId).toBe("loc.cell");
    expect(state.actors["pc.you"]?.conditions).not.toContain("captive");
  });
});
