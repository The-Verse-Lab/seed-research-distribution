/** Neutral authored-duration regressions for clock and energy accounting. */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dayPhaseOf } from "../src/agents/context.ts";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { TURN_PLAN_JSON_SCHEMA, CLASSIFIER_SYSTEM_PROMPT } from "../src/engine/classify.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { TurnKindSchema } from "../src/engine/turn-plan.ts";
import { costOf, DEFAULT_MAX_ENERGY, MAX_ACTION_ENERGY, scaledEnergy } from "../src/rules/costs.ts";
import { dayOf } from "../src/rules/routine.ts";
import type { PlaySet } from "../src/content/schema.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";

const FIXTURE = fileURLToPath(new URL("fixtures/worlds/thistledown", import.meta.url));

async function durationFixture(): Promise<PlaySet> {
  const playset = await loadPlaySetFromDir(FIXTURE);
  playset.campaign.startingState.clock = 480;
  const exit = (from: string, to: string) =>
    playset.world.locations.find((row) => row.id === from)!.exits.find((row) => row.to === to)!;
  exit("loc.hart", "loc.green").minutes = 15;
  exit("loc.green", "loc.hart").minutes = 15;
  exit("loc.green", "loc.forge").minutes = 495;
  exit("loc.forge", "loc.green").minutes = 495;
  const hart = playset.world.locations.find((row) => row.id === "loc.hart")!;
  hart.work = [{
    id: "work.fixture-shift",
    label: "Sort the neutral fixture ledger",
    ability: "int",
    dc: 1,
    wageCp: 20,
    failWageCp: 20,
    minutes: 480,
    cooldownDays: 1,
  }];
  hart.guild = { name: "Fixture Hall", clerkId: "npc.bett" };
  return playset;
}

async function build(playset: PlaySet): Promise<GameEngine> {
  const engine = new GameEngine({
    classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
  });
  await engine.start();
  return engine;
}

describe("classifier day-rolling kinds", () => {
  test("every resolved TurnKind is offered to the classifier", () => {
    const offered = new Set(TURN_PLAN_JSON_SCHEMA.properties.kind.enum);
    for (const kind of TurnKindSchema.options) expect(offered.has(kind), kind).toBe(true);
  });

  test("the prompt distinguishes a breather from sleeping through the night", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("a BREATHER IN PLACE");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("the day does NOT roll");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("the ONLY ones that carry the player through a NIGHT");
  });
});

describe("authored exit durations", () => {
  test("keeps a local hop short and a long route symmetric", async () => {
    const playset = await durationFixture();
    const exit = (from: string, to: string) =>
      playset.world.locations.find((row) => row.id === from)?.exits.find((row) => row.to === to);
    expect(exit("loc.hart", "loc.green")?.minutes).toBe(15);
    expect(exit("loc.green", "loc.forge")?.minutes).toBe(495);
    expect(exit("loc.forge", "loc.green")?.minutes).toBe(495);
  });

  test("a long route advances time and a round trip crosses the day boundary", async () => {
    const engine = await build(await durationFixture());
    const before = engine.getState().clock;
    await engine.submitAction({ kind: "move", exitId: "loc.green" });
    await engine.submitAction({ kind: "move", exitId: "loc.forge" });
    const after = engine.getState().clock;
    expect(after - before).toBe(510);
    expect(dayPhaseOf(before)).toBe("morning");
    expect(dayPhaseOf(after)).not.toBe("morning");
    await engine.submitAction({ kind: "move", exitId: "loc.green" });
    await engine.submitAction({ kind: "move", exitId: "loc.hart" });
    expect(dayOf(engine.getState().clock)).toBeGreaterThan(dayOf(before));
  });

  test("an unauthored exit retains the standard movement cost", async () => {
    const playset = await loadPlaySetFromDir(FIXTURE);
    const engine = await build(playset);
    const before = engine.getState().clock;
    await engine.submitAction({ kind: "move", exitId: "loc.green" });
    expect(engine.getState().clock - before).toBe(costOf("movement").minutes);
  });
});

describe("energy scaling", () => {
  test("is proportional, monotonic, and capped", () => {
    const base = costOf("movement");
    expect(base).toEqual({ minutes: 30, energy: 8 });
    expect(scaledEnergy(base.energy, 15, base.minutes)).toBeLessThan(base.energy);
    expect(scaledEnergy(base.energy, 495, base.minutes)).toBe(MAX_ACTION_ENERGY);
    expect(MAX_ACTION_ENERGY).toBeLessThan(DEFAULT_MAX_ENERGY);
    expect(scaledEnergy(0, 480, 60)).toBe(0);
    for (let minutes = 1; minutes < 600; minutes++) {
      expect(scaledEnergy(base.energy, minutes, base.minutes)).toBeGreaterThanOrEqual(
        scaledEnergy(base.energy, minutes - 1, base.minutes),
      );
    }
  });

  test("keeps the curve linear through the base row and bends only above it", () => {
    const move = costOf("movement");
    expect(scaledEnergy(move.energy, 10, move.minutes)).toBe(3);
    expect(scaledEnergy(move.energy, 15, move.minutes)).toBe(4);
    expect(scaledEnergy(move.energy, 30, move.minutes)).toBe(8);
    expect(scaledEnergy(move.energy, 120, move.minutes)).toBe(18);
  });

  test("differentiates half-day and full-day work below the cap", () => {
    const work = costOf("work");
    expect(scaledEnergy(work.energy, 120, work.minutes)).toBe(18);
    expect(scaledEnergy(work.energy, 240, work.minutes)).toBe(28);
    expect(scaledEnergy(work.energy, 480, work.minutes)).toBe(40);
  });
});

describe("authored work duration and cooldown", () => {
  test("a full shift advances eight hours and cannot be farmed twice that day", async () => {
    const engine = await build(await durationFixture());
    const pc = engine.getState().party[0]!;
    const beforeClock = engine.getState().clock;
    await engine.submitAction({ kind: "work", opportunityId: "work.fixture-shift" });
    expect(engine.getState().clock - beforeClock).toBe(480);
    const firstCoins = engine.getState().actors[pc]?.coins;
    await engine.submitAction({ kind: "work", opportunityId: "work.fixture-shift" });
    expect(engine.getState().actors[pc]?.coins).toBe(firstCoins);
  });
});
