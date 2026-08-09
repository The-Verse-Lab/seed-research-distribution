/**
 * Phase 5 tests — prebaked events: predicate evaluation, firing on entry, `once: campaign`
 * suppression, and survival across a reload (the persisted cursor). Deterministic, offline.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { fromGameState, toGameState } from "../src/world/model.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { EventsModule, evalPredicate, occupiedLookupOf } from "../src/modules/events/module.ts";
import type { GameEvent } from "../src/events/types.ts";
import { PrebakedEventSchema, type PlaySet, type PrebakedEvent } from "../src/content/schema.ts";
import type { TickContext } from "../src/engine/tick.ts";
import { coverageRow } from "../src/rules/wardrobe.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";

function thistledown(): Promise<PlaySet> {
  return loadPlaySetFromDir(fileURLToPath(new URL("fixtures/worlds/thistledown", import.meta.url)));
}

function makeEngine(playset: PlaySet, store: InMemoryGameStateStore) {
  const engine = new GameEngine({ classifier: heuristicClassifier, playset, store, gateway: new OfflineGateway(), rng: mulberry32(7) });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, events };
}

const narrations = (events: GameEvent[]): string[] =>
  events.filter((e): e is Extract<GameEvent, { kind: "narration" }> => e.kind === "narration").map((e) => e.text);

describe("trigger predicate", () => {
  test("atLocation + clockAtLeast evaluate against the model", async () => {
    const playset = await thistledown();
    const engine = new GameEngine({ classifier: heuristicClassifier, playset, store: new InMemoryGameStateStore(), gateway: new OfflineGateway() });
    await engine.start();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    expect(evalPredicate({ allOf: [{ kind: "atLocation", locationId: "loc.hart" }] }, model, "loc.hart")).toBe(true);
    expect(evalPredicate({ allOf: [{ kind: "atLocation", locationId: "loc.ford" }] }, model, "loc.hart")).toBe(false);
    expect(evalPredicate({ allOf: [{ kind: "clockAtLeast", minutes: 0 }] }, model, "loc.hart")).toBe(true);
    expect(evalPredicate({ allOf: [{ kind: "clockAtLeast", minutes: 5 }] }, model, "loc.hart")).toBe(false);
    model.modules.workHistory = { opportunities: { "work.test": 2 } };
    expect(evalPredicate({ allOf: [{ kind: "workedOpportunity", opportunityId: "work.test", countAtLeast: 2 }] }, model, "loc.hart")).toBe(true);
    expect(evalPredicate({ allOf: [{ kind: "workedOpportunity", opportunityId: "work.test", countAtLeast: 3 }] }, model, "loc.hart")).toBe(false);
  });

  test("attireState reads the default entity (PC) when entityId is absent, an explicit entity otherwise", async () => {
    const playset = await thistledown();
    const engine = new GameEngine({ classifier: heuristicClassifier, playset, store: new InMemoryGameStateStore(), gateway: new OfflineGateway() });
    await engine.start();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);

    // Nobody has a wardrobe row yet ⇒ fully dressed, neither state matches.
    expect(evalPredicate({ allOf: [{ kind: "attireState", state: "bare" }] }, model, "loc.hart")).toBe(false);
    expect(evalPredicate({ allOf: [{ kind: "attireState", state: "disheveled" }] }, model, "loc.hart")).toBe(false);

    // Default entity (entityId absent) reads the PC.
    model.modules.wardrobe = { "pc.you": coverageRow("removed") };
    expect(evalPredicate({ allOf: [{ kind: "attireState", state: "bare" }] }, model, "loc.hart")).toBe(true);
    expect(evalPredicate({ allOf: [{ kind: "attireState", state: "disheveled" }] }, model, "loc.hart")).toBe(false);

    // An explicit entityId reads THAT entity's row instead — independent of the PC's.
    model.modules.wardrobe = { "npc.maelle": { upper: "displaced" } };
    expect(
      evalPredicate({ allOf: [{ kind: "attireState", entityId: "npc.maelle", state: "disheveled" }] }, model, "loc.hart"),
    ).toBe(true);
    expect(
      evalPredicate({ allOf: [{ kind: "attireState", entityId: "npc.maelle", state: "bare" }] }, model, "loc.hart"),
    ).toBe(false);
    // The default-PC path is unaffected by another entity's row.
    expect(evalPredicate({ allOf: [{ kind: "attireState", state: "bare" }] }, model, "loc.hart")).toBe(false);

    // With an occupancy lookup (the modules' wiring — occupiedLookupOf over the campaign sheets),
    // a two-garment character who removed both reads BARE, matching every other attire surface;
    // omitting the lookup keeps the conservative all-slots read (the same row is only disheveled).
    model.modules.wardrobe = { "pc.you": { upper: "removed", lower: "removed" } };
    const occupiedOf = occupiedLookupOf([
      { ...playset.campaign.characters.find((c) => c.id === "pc.you")! },
    ]);
    expect(
      evalPredicate({ allOf: [{ kind: "attireState", state: "bare" }] }, model, "loc.hart", undefined, { occupiedOf }),
    ).toBe(true);
    expect(evalPredicate({ allOf: [{ kind: "attireState", state: "bare" }] }, model, "loc.hart")).toBe(false);
    expect(evalPredicate({ allOf: [{ kind: "attireState", state: "disheveled" }] }, model, "loc.hart")).toBe(true);
  });
});

describe("attireState prebaked beat — fires through a real typed clothing turn", () => {
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

  test("an authored bare beat fires on the typed full strip — the predicate shares the brief's occupancy read", async () => {
    const playset = await thistledown();
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.test-bare-notice",
        when: "onTick",
        trigger: { allOf: [{ kind: "attireState", state: "bare" }] },
        effects: [{ kind: "narrate", text: "A cold draft finds every inch of your bare skin." }],
        once: "campaign",
      }),
      PrebakedEventSchema.parse({
        id: "ev.test-disheveled-notice",
        when: "onTick",
        trigger: { allOf: [{ kind: "attireState", state: "disheveled" }] },
        effects: [{ kind: "narrate", text: "A cold draft catches at your loosened clothes." }],
        once: "campaign",
      }),
    );

    // The typed clothing turn narrows to the PC's occupied coverage slots (here just the baseline
    // upper/lower pair — thistledown's PC names no extra garment). The evaluator judges the SAME
    // occupancy (EventsModule is wired with the campaign's character sheets), so stripping "all"
    // reads BARE — the same state the brief's Attire line reports — never the old conservative
    // six-slot mixed read that left an authored `bare` beat unfireable from a typed strip.
    const plans: TurnPlan[] = [planOf({}), planOf({ kind: "clothing", clothing: { slot: "all", state: "removed" } })];
    let i = 0;
    const classifier: TurnClassifier = { classify: async () => plans[Math.min(i++, plans.length - 1)]! };
    const store = new InMemoryGameStateStore();
    const engine = new GameEngine({ playset, store, gateway: new OfflineGateway(), classifier, rng: mulberry32(7) });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();

    await engine.submitPlayerInput("look around"); // still fully dressed — neither beat fires
    expect(narrations(events).some((t) => t.includes("cold draft"))).toBe(false);

    events.length = 0;
    await engine.submitPlayerInput("I strip off my clothes"); // typed clothing turn — now bare
    // EventsModule's react runs AFTER the resolve-phase wardrobe write, so it fires the SAME tick.
    expect(narrations(events).some((t) => t.includes("bare skin"))).toBe(true);
    expect(narrations(events).some((t) => t.includes("loosened clothes"))).toBe(false);
  });
});

describe("prebaked beats", () => {
  test("entering the ford fires the coat beat once, sets its objective + flag", async () => {
    const playset = await thistledown();
    const store = new InMemoryGameStateStore();
    const { engine, events } = makeEngine(playset, store);
    await engine.start();

    await engine.submitPlayerInput("go to the green");
    await engine.submitPlayerInput("go to the ford");
    expect(narrations(events).some((t) => t.includes("miller's coat"))).toBe(true);

    const gs = engine.getState();
    expect(gs.flags.found_millers_coat).toBe(true);
    const objectives = gs.modules?.objectives as Record<string, Record<string, boolean>> | undefined;
    expect(objectives?.["quest.missing-miller"]?.["obj.follow-trail"]).toBe(true);

    // Leave and return — `once: campaign` suppresses a re-fire.
    events.length = 0;
    await engine.submitPlayerInput("go to the green");
    await engine.submitPlayerInput("go to the ford");
    expect(narrations(events).some((t) => t.includes("miller's coat"))).toBe(false);
  });

  test("prebaked item handoff effects give items to the PC and transfer held items", async () => {
    const playset = await thistledown();
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.test-item-handoff",
        when: "onTick",
        trigger: { allOf: [{ kind: "clockAtLeast", minutes: 0 }] },
        effects: [
          { kind: "giveItem", itemId: "item.honeycakes" },
          { kind: "transferItem", itemId: "item.wardlantern", from: "pc.you", to: "npc.maelle" },
        ],
        once: "campaign",
      }),
    );
    const { engine } = makeEngine(playset, new InMemoryGameStateStore());
    await engine.start();

    await engine.submitPlayerInput("look around");

    expect(engine.getState().actors["pc.you"]?.inventory).toContain("item.honeycakes");
    expect(engine.getState().actors["pc.you"]?.inventory).not.toContain("item.wardlantern");
    expect(engine.getState().actors["npc.maelle"]?.inventory).toContain("item.wardlantern");
  });

  test("the once cursor persists across a reload (no re-fire after resuming at the ford)", async () => {
    const playset = await thistledown();
    const store = new InMemoryGameStateStore();
    const first = makeEngine(playset, store);
    await first.engine.start();
    await first.engine.submitPlayerInput("go to the green");
    await first.engine.submitPlayerInput("go to the ford");
    expect(narrations(first.events).some((t) => t.includes("miller's coat"))).toBe(true);

    // Fresh engine over the same store → resumes at the ford with the fired cursor restored.
    const second = makeEngine(playset, store);
    await second.engine.start();
    second.events.length = 0;
    await second.engine.submitPlayerInput("go to the green");
    await second.engine.submitPlayerInput("go to the ford");
    expect(narrations(second.events).some((t) => t.includes("miller's coat"))).toBe(false);
  });
});

describe("heartbeat spam guard", () => {
  test("prebaked onTick beats fire on a player tick but never on a heartbeat tick", async () => {
    const playset = await thistledown();
    const engine = new GameEngine({ classifier: heuristicClassifier, playset, store: new InMemoryGameStateStore(), gateway: new OfflineGateway() });
    await engine.start();
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);

    // An always-true onTick beat. Before the guard, this re-fired on EVERY tick — including the
    // idle NPC heartbeats that run between player turns — which was the 2026-07-05 hunger spam.
    const events: PrebakedEvent[] = [
      { id: "ev.always", when: "onTick", once: "always", trigger: { allOf: [{ kind: "clockAtLeast", minutes: 0 }] }, effects: [{ kind: "narrate", text: "TICK-BEAT" }] },
    ];
    const mod = new EventsModule(events, playset.world);

    const beatsFor = (trigger: TickContext["trigger"]): string[] => {
      const data: Record<string, unknown> = {};
      const ctx = {
        trigger, model, services: {}, recent: [], data, queue: [] as unknown[],
        enqueue() {}, apply: (c: unknown) => applyCommand(model, c as never),
        applySilent: (c: unknown) => applyCommand(model, c as never), emit() {}, state: () => toGameState(model),
      } as unknown as TickContext;
      mod.phases.react?.(ctx);
      return (data.eventBeats as string[] | undefined) ?? [];
    };

    expect(beatsFor({ kind: "player", input: "wait" })).toContain("TICK-BEAT");
    expect(beatsFor({ kind: "heartbeat", npcId: "npc.anyone" })).toEqual([]);
  });
});

describe("commit-cull same-tick spawn exemption", () => {
  test("a spawn-elsewhere transient survives the tick it is born, then normal tier semantics reap it", async () => {
    const playset = await thistledown();
    // Authored staging pattern: entering the green spawns a transient at the (offstage) ford.
    playset.campaign.events.push({
      id: "ev.stage-rider",
      when: "onEnterLocation",
      once: "campaign",
      trigger: { allOf: [{ kind: "atLocation", locationId: "loc.green" }] },
      effects: [{ kind: "spawn", templateId: "mon.boggart", locationId: "loc.ford", tier: "transient" }],
    } as PrebakedEvent);
    const { engine } = makeEngine(playset, new InMemoryGameStateStore());
    await engine.start();

    await engine.submitPlayerInput("go to the green");
    // Born in this commit's batch ⇒ exempt from the same-tick cull. Without the exemption the
    // spawn would be applied and reaped in one breath — a silent no-op that still burned the
    // once-per-campaign trigger.
    expect(engine.getState().actors["mon.boggart#0"]).toBeTruthy();

    // The next tick applies ordinary transient semantics: not co-located with the party ⇒ reaped.
    await engine.submitPlayerInput("wait");
    expect(engine.getState().actors["mon.boggart#0"]).toBeFalsy();
  });
});
