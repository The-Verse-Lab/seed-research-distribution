/**
 * Regression locks for the adversarially-confirmed review findings on the traversal-energy
 * branch: the barrier-check hijack (hidden exits / blind single-exit fallback), refused-move
 * pricing, parallel-edge traversal semantics, and the frontier overlay-key migration. Pure +
 * engine-level, fully offline-deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { fromGameState, partyLocationOf, type WorldModel } from "../src/world/model.ts";
import { canTraverse, exitVerdict, overlayExitState } from "../src/world/traversal.ts";
import { loadExample } from "./support/harness.ts";

function planOf(partial: Partial<TurnPlan>): TurnPlan {
  return {
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
    ...partial,
  };
}

function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return {
    classify: async () => {
      const plan = plans[Math.min(i, plans.length - 1)] ?? planOf({});
      i += 1;
      return plan;
    },
  };
}

async function exampleEngine(plans: TurnPlan[]) {
  const playset = await loadExample();
  const engine = new GameEngine({
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(1234),
    classifier: scriptedClassifier(plans),
  });
  await engine.start();
  return { engine, playset };
}

/** The live model behind a started engine (test-only reach-around, the repo convention). */
function modelOf(engine: GameEngine): WorldModel {
  return (engine as unknown as { model: WorldModel }).model;
}

describe("barrier-check hijack (review finding: hidden/blind fallback)", () => {
  test("a force-verbed check does NOT resolve against a HIDDEN barred exit", async () => {
    const { engine } = await exampleEngine([
      planOf({ kind: "attemptRequiringCheck", check: { warranted: true, ability: "str", skill: "athletics", dc: 13, reason: "" } }),
    ]);
    const model = modelOf(engine);
    // One barred exit at the tavern — and it is HIDDEN (never shown to the player).
    model.map.exits.set("loc.tavern", [
      { to: "loc.square", locked: false, hidden: false },
      { to: "loc.cellar", locked: true, hidden: true, barrier: { kind: "door", breakDc: 5 } },
    ]);

    const before = overlayExitState(model.modules, "loc.tavern", "loc.cellar");
    await engine.submitPlayerInput("I try to break open the crate");
    // The hidden exit is untouched — the input resolved as a generic check, not a jailbreak.
    expect(overlayExitState(model.modules, "loc.tavern", "loc.cellar")).toBe(before);
  });

  test("a force-verbed check that does not NAME the one visible barred exit stays a generic check", async () => {
    const { engine } = await exampleEngine([
      planOf({ kind: "attemptRequiringCheck", check: { warranted: true, ability: "str", skill: "athletics", dc: 13, reason: "" } }),
    ]);
    const model = modelOf(engine);
    model.map.exits.set("loc.tavern", [
      { to: "loc.square", locked: false, hidden: false },
      { to: "loc.cellar", locked: true, hidden: false, barrier: { kind: "gate", breakDc: 5, description: "a rusted iron gate" } },
    ]);

    await engine.submitPlayerInput("I try to break open the crate");
    // No blind single-exit fallback: the gate is not named, so its state never changes.
    expect(overlayExitState(model.modules, "loc.tavern", "loc.cellar")).toBeUndefined();
    expect(canTraverse(model, "loc.tavern", "loc.cellar")).toBe(false);
  });

  test("naming the obstacle through its barrier words still targets it", async () => {
    const { engine } = await exampleEngine([
      planOf({ kind: "attemptRequiringCheck", check: { warranted: true, ability: "str", skill: "athletics", dc: 13, reason: "" } }),
    ]);
    const model = modelOf(engine);
    model.map.exits.set("loc.tavern", [
      { to: "loc.square", locked: false, hidden: false },
      { to: "loc.cellar", locked: true, hidden: false, barrier: { kind: "gate", breakDc: 1, description: "a rusted iron gate" } },
    ]);

    // Forced low DC + seeded rng: the named attempt resolves against the gate.
    await engine.submitPlayerInput("I smash the rusted iron gate");
    expect(overlayExitState(model.modules, "loc.tavern", "loc.cellar")).toBe("broken");
  });

  test("an incidental word from the barrier's own PROSE never targets it (r8 regex audit)", async () => {
    // The match was "any shared 3+ character token" against a label that concatenates the
    // barrier's authored DESCRIPTION — and a description is a sentence. The reproduced ward
    // Pass ward is authored as "no wall bars the way, only a pressure in the air that turns most
    // travelers back…", so its token bag holds `the`, `way`, `back`, `most`. Reproduced against the
    // shipped matcher: "I force my way through the crowd to the counter" and "I break the seal on
    // the letter" both resolved AGAINST THE WARD, rolling a DC-22 break-out — and a good roll tears
    // a permanent hole in the map. `breakDc: 1` here so a wrong hit cannot hide behind a bad roll.
    const { engine } = await exampleEngine([
      planOf({ kind: "attemptRequiringCheck", check: { warranted: true, ability: "str", skill: "athletics", dc: 13, reason: "" } }),
      planOf({ kind: "attemptRequiringCheck", check: { warranted: true, ability: "str", skill: "athletics", dc: 13, reason: "" } }),
    ]);
    const model = modelOf(engine);
    model.map.exits.set("loc.tavern", [
      { to: "loc.square", locked: false, hidden: false },
      {
        to: "loc.cellar",
        locked: true,
        hidden: false,
        barrier: {
          kind: "magical",
          breakDc: 1,
          description:
            "no wall bars the way, only a pressure in the air that turns most travelers back — pressing on takes a hard act of will",
        },
      },
    ]);

    await engine.submitPlayerInput("I force my way through the crowd to the counter");
    expect(overlayExitState(model.modules, "loc.tavern", "loc.cellar")).toBeUndefined();
    await engine.submitPlayerInput("I break the seal on the letter");
    expect(overlayExitState(model.modules, "loc.tavern", "loc.cellar")).toBeUndefined();
    expect(canTraverse(model, "loc.tavern", "loc.cellar")).toBe(false);
  });

  test("naming the ward — by kind, or by two of its own words — still targets it (r8 regex audit)", async () => {
    const { engine } = await exampleEngine([
      planOf({ kind: "attemptRequiringCheck", check: { warranted: true, ability: "str", skill: "athletics", dc: 13, reason: "" } }),
    ]);
    const model = modelOf(engine);
    model.map.exits.set("loc.tavern", [
      { to: "loc.square", locked: false, hidden: false },
      {
        to: "loc.cellar",
        locked: true,
        hidden: false,
        barrier: {
          kind: "magical",
          breakDc: 1,
          description:
            "no wall bars the way, only a pressure in the air that turns most travelers back — pressing on takes a hard act of will",
        },
      },
    ]);

    // "ward" is the closed-enum kind's own handle: one NAME word is enough to aim the attempt.
    await engine.submitPlayerInput("I set my shoulder to the ward and force it");
    expect(overlayExitState(model.modules, "loc.tavern", "loc.cellar")).toBe("broken");
  });

  test("an incidental word from the exit's own NAME never targets it either (r8 review)", async () => {
    // The ordinary-word filter went on the DESCRIPTION and stopped there — but authored worlds
    // authors exit NAMES as prose too, and a name handle is worth 2 on its own, i.e. a match by
    // itself. `loc.pale-gatehouse`'s exit is named "through the sealed gate into the frozen
    // highland" (verbatim below), so `through` was a full-weight handle. Reproduced against the
    // shipped matcher, three lines about crowds and weather each armed the DC-24 break-out that on
    // success commits `setExitState "broken"` and opens the frozen highland permanently.
    // `breakDc: 1` here so a wrong hit cannot hide behind a bad roll.
    const { engine } = await exampleEngine([
      planOf({ kind: "attemptRequiringCheck", check: { warranted: true, ability: "str", skill: "athletics", dc: 13, reason: "" } }),
      planOf({ kind: "attemptRequiringCheck", check: { warranted: true, ability: "str", skill: "athletics", dc: 13, reason: "" } }),
      planOf({ kind: "attemptRequiringCheck", check: { warranted: true, ability: "str", skill: "athletics", dc: 13, reason: "" } }),
    ]);
    const model = modelOf(engine);
    model.map.exits.set("loc.tavern", [
      { to: "loc.square", locked: false, hidden: false },
      {
        to: "loc.cellar",
        locked: true,
        hidden: false,
        name: "through the sealed gate into the frozen highland",
        barrier: {
          kind: "gate",
          breakDc: 1,
          description: "the sealed white gate, whose pale-glass keyhole takes one key and no other",
        },
      },
    ]);

    for (const line of [
      "I force my way through the crowd to the counter",
      "I break through the line of dockhands",
      "I push through the fog toward the lamps",
    ]) {
      await engine.submitPlayerInput(line);
      expect(overlayExitState(model.modules, "loc.tavern", "loc.cellar")).toBeUndefined();
    }
    expect(canTraverse(model, "loc.tavern", "loc.cellar")).toBe(false);
  });

  test("…and the same sentence-named exit still answers to what identifies it (r8 review)", async () => {
    // The other direction, one attempt per handle class the filter must preserve: the closed-enum
    // kind word, the DESTINATION label, and a distinctive word of the authored name.
    for (const line of ["I force the gate", "I break into the cellar", "I break the sealed gate open"]) {
      const { engine } = await exampleEngine([
        planOf({ kind: "attemptRequiringCheck", check: { warranted: true, ability: "str", skill: "athletics", dc: 13, reason: "" } }),
      ]);
      const model = modelOf(engine);
      model.map.exits.set("loc.tavern", [
        { to: "loc.square", locked: false, hidden: false },
        {
          to: "loc.cellar",
          locked: true,
          hidden: false,
          name: "through the sealed gate into the frozen highland",
          barrier: {
            kind: "gate",
            breakDc: 1,
            description: "the sealed white gate, whose pale-glass keyhole takes one key and no other",
          },
        },
      ]);

      await engine.submitPlayerInput(line);
      expect(overlayExitState(model.modules, "loc.tavern", "loc.cellar")).toBe("broken");
    }
  });
});

describe("refused movement pricing (review finding: full travel cost on a bounced door)", () => {
  test("a barred move charges the refusal price (1 min, 0 energy), not the travel row", async () => {
    const { engine } = await exampleEngine([
      planOf({ kind: "movement", destinationLocationId: "loc.square" }),
    ]);
    const model = modelOf(engine);
    model.map.exits.set("loc.tavern", [
      { to: "loc.square", locked: true, hidden: false, barrier: { kind: "door", dc: 15 } },
    ]);
    const clockBefore = engine.getState().clock;

    await engine.submitPlayerInput("go to the square");

    expect(engine.getState().partyLocationId).toBe("loc.tavern");
    expect(engine.getState().clock).toBe(clockBefore + 1);
    expect(engine.getState().actors["pc.you"]?.energy).toBeUndefined(); // absent = full, undebited
  });

  test("a move to nowhere charges the refusal price too", async () => {
    const { engine } = await exampleEngine([
      planOf({ kind: "movement", destinationLocationId: "loc.nowhere" }),
    ]);
    const clockBefore = engine.getState().clock;

    await engine.submitPlayerInput("go to the nowhere");

    expect(engine.getState().clock).toBe(clockBefore + 1);
    expect(engine.getState().actors["pc.you"]?.energy).toBeUndefined();
  });

  test("a SUCCESSFUL move still pays the full travel row", async () => {
    const { engine } = await exampleEngine([
      planOf({ kind: "movement", destinationLocationId: "loc.square" }),
    ]);
    const clockBefore = engine.getState().clock;

    await engine.submitPlayerInput("go to the square");

    expect(engine.getState().partyLocationId).toBe("loc.square");
    expect(engine.getState().clock).toBe(clockBefore + 30);
    expect(engine.getState().actors["pc.you"]?.energy).toBe(92);
  });
});

describe("parallel edges (review finding: first-match verdict regressed canReach semantics)", () => {
  test("a passable parallel edge wins over a barred one, whatever the order", async () => {
    const playset = await loadExample();
    const engine = new GameEngine({
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(1),
    });
    await engine.start();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    // Barred edge FIRST, open edge second — the old .find() verdict barred the way.
    model.map.exits.set("loc.tavern", [
      { to: "loc.square", locked: true, hidden: false, barrier: { kind: "door" } },
      { to: "loc.square", locked: false, hidden: false, name: "the side arch" },
    ]);

    expect(exitVerdict(model, "loc.tavern", "loc.square")?.state).toBe("open");
    expect(canTraverse(model, "loc.tavern", "loc.square")).toBe(true);
    const res = applyCommand(model, { type: "moveParty", to: "loc.square" });
    expect(res.mutated).toBe(true);
    expect(partyLocationOf(model)).toBe("loc.square");
  });
});

describe("frontier overlay migration (review finding: unlock-then-expand orphaned the key)", () => {
  test("expandWorld migrates a frontier exit's overlay state onto the retargeted destination", async () => {
    const playset = await loadExample();
    const engine = new GameEngine({
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(1),
    });
    await engine.start();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    model.map.exits.set("loc.square", [
      { to: "loc.tavern", locked: false, hidden: false },
      { to: "frontier:east", locked: true, hidden: false, barrier: { kind: "gate", dc: 10 } },
    ]);
    // Unlock the barred frontier gate, then expand through it.
    expect(applyCommand(model, { type: "setExitState", locationId: "loc.square", to: "frontier:east", state: "open" }).mutated).toBe(true);
    const res = applyCommand(model, {
      type: "expandWorld",
      fromLocationId: "loc.square",
      viaExitTo: "frontier:east",
      locations: [
        { id: "gen.gate-road", name: "Gate Road", description: "", connections: [], exits: [{ to: "loc.square", locked: false, hidden: false }], region: undefined, spawns: [], npcs: [] },
      ],
    });
    expect(res.mutated).toBe(true);
    // The unlock followed the retarget: no orphaned frontier key, the real edge is open.
    expect(overlayExitState(model.modules, "loc.square", "frontier:east")).toBeUndefined();
    expect(overlayExitState(model.modules, "loc.square", "gen.gate-road")).toBe("open");
    expect(canTraverse(model, "loc.square", "gen.gate-road")).toBe(true);
  });
});
