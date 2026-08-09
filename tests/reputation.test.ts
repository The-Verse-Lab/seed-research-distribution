/**
 * Guild reputation (the hall-as-hub wave, Phase C) — a successful work shift warms the hall's guild
 * faction (`WORK_STANDING_GAIN`, `factionStandingCommands`), and a `Work.requires` clause
 * (`factionStandingAtLeast`) gates a shift off the board until standing rises — the same
 * modules-readable predicate evaluated on both the pure board projection (`workOffersOf`) and the
 * engine's resolve-time authority (`workOpportunityById`), plus the shared `evalCondition`/
 * `evalPredicate` used by prebaked events. DCs are chosen so the outcome is deterministic without
 * scripting the RNG: `dc: 1` clamps to 5 (a str-20 PC always clears it), `dc: 40` clamps to 30 (the
 * same PC can never clear it) — see `src/engine/engine.ts` `resolveWork`'s `Math.max(5, Math.min(30, ...))`.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type PlaySet, type TriggerPredicate } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { byKind } from "./support/harness.ts";
import { fromGameState, partyLocationOf } from "../src/world/model.ts";
import { factionStandingOf } from "../src/rules/factions.ts";
import { workRequiresMet } from "../src/rules/work-gate.ts";
import { workOffersOf } from "../src/state/projections.ts";
import { evalPredicate } from "../src/modules/events/module.ts";

const PC = "pc.you";
const HALL_A = "loc.hall-a"; // guild.factionId set — the reputation loop lives here
const HALL_B = "loc.hall-b"; // guild present, but NO factionId — a successful shift moves nothing
const FACTION = "faction.river-guild";

const WORK_SURE = "work.sure"; // dc 1 → clamps to 5; str 20 always clears it
const WORK_BOTCH = "work.botch"; // dc 40 → clamps to 30; str 20 can never clear it
const WORK_GATED = "work.gated"; // requires factionStandingAtLeast(FACTION, 20)
const WORK_PLAIN = "work.plain"; // at the factionless hall

// str 20 (+5 modifier): worst roll (1) + 5 = 6 ≥ 5 (WORK_SURE always succeeds); best roll (20) + 5 =
// 25 < 30 (WORK_BOTCH always fails). Deterministic without touching the RNG.
const pcStats = { abilities: { str: 20, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 20, armorClass: 10 };

function reputationPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.rep",
    name: "Reputation Test",
    summary: "Two guild halls for testing standing gains and the reputation gate.",
    locations: [
      {
        id: HALL_A,
        name: "Hall A",
        description: "A guild hall loyal to the river-guild.",
        guild: { name: "Hall A", factionId: FACTION },
        work: [
          { id: WORK_SURE, label: "Haul crates", ability: "str", dc: 1, wageCp: 50, failWageCp: 0 },
          { id: WORK_BOTCH, label: "Thread a needle blindfolded", ability: "str", dc: 40, wageCp: 50, failWageCp: 0 },
          {
            id: WORK_GATED,
            label: "Escort the ledger",
            ability: "str",
            dc: 1,
            wageCp: 80,
            failWageCp: 0,
            requires: { allOf: [{ kind: "factionStandingAtLeast", factionId: FACTION, value: 20 }] },
          },
        ],
      },
      {
        id: HALL_B,
        name: "Hall B",
        description: "An unaffiliated hall — no guild faction backs it.",
        guild: { name: "Hall B" },
        work: [{ id: WORK_PLAIN, label: "Sweep the yard", ability: "str", dc: 1, wageCp: 30, failWageCp: 0 }],
      },
    ],
    factions: [{ id: FACTION, name: "River Guild" }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.rep",
    name: "Reputation Campaign",
    worldId: world.id,
    characters: [{ id: PC, name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: HALL_A, party: [PC], companions: [] },
  });
  return { world, campaign };
}

function repState(opts: { locationId?: string; modules?: Record<string, unknown>; clock?: number } = {}): GameState {
  const loc = opts.locationId ?? HALL_A;
  return {
    campaignId: "c.rep",
    worldId: "w.rep",
    partyLocationId: loc,
    clock: opts.clock ?? 480,
    party: [PC],
    companions: [],
    actors: { [PC]: { id: PC, currentHp: pcStats.maxHp, locationId: loc, inventory: [], conditions: [], coins: 0 } },
    quests: {},
    relationships: {},
    autonomy: {},
    modules: opts.modules ?? {},
    flags: {},
  };
}

async function engineWith(playset: PlaySet, state: GameState): Promise<GameEngine> {
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, PC), state);
  const engine = new GameEngine({ playset, store, gateway: new OfflineGateway(), rng: mulberry32(11) });
  await engine.start();
  return engine;
}

// ---------------------------------------------------------------------------------------------

describe("resolveWork — guild reputation warmth", () => {
  test("a successful shift raises the hall's guild faction standing by exactly WORK_STANDING_GAIN (3), repeated shifts accumulate", async () => {
    const playset = reputationPlayset();
    const engine = await engineWith(playset, repState());
    expect(factionStandingOf(engine.getState().modules, PC, FACTION)).toBe(0);

    await engine.submitAction({ kind: "work", opportunityId: WORK_SURE });
    expect(factionStandingOf(engine.getState().modules, PC, FACTION)).toBe(3);

    await engine.submitAction({ kind: "work", opportunityId: WORK_SURE });
    expect(factionStandingOf(engine.getState().modules, PC, FACTION)).toBe(6);

    await engine.submitAction({ kind: "work", opportunityId: WORK_SURE });
    expect(factionStandingOf(engine.getState().modules, PC, FACTION)).toBe(9);
    expect(engine.getState().actors[PC]?.coins).toBe(150); // 3 × 50cp wage
  });

  test("a botched shift pays nothing and moves no standing", async () => {
    const playset = reputationPlayset();
    const engine = await engineWith(playset, repState());

    await engine.submitAction({ kind: "work", opportunityId: WORK_BOTCH });

    expect(factionStandingOf(engine.getState().modules, PC, FACTION)).toBe(0);
    expect(engine.getState().actors[PC]?.coins ?? 0).toBe(0);
  });

  test("a successful shift at a hall with no guild.factionId moves no faction standing", async () => {
    const playset = reputationPlayset();
    const engine = await engineWith(playset, repState({ locationId: HALL_B }));

    await engine.submitAction({ kind: "work", opportunityId: WORK_PLAIN });

    expect(engine.getState().actors[PC]?.coins).toBe(30); // the shift still pays...
    expect(engine.getState().modules?.factionStanding).toBeUndefined(); // ...but nothing warmed
    expect(factionStandingOf(engine.getState().modules, PC, FACTION)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Work.requires — the reputation-gated shift", () => {
  test("workOffersOf hides the gated row below standing 20 and surfaces it at/above 20", async () => {
    const playset = reputationPlayset();
    const low = repState();
    expect(workOffersOf(playset, low).map((w) => w.id)).not.toContain(WORK_GATED);
    expect(workOffersOf(playset, low).map((w) => w.id)).toContain(WORK_SURE); // ungated rows unaffected

    const atThreshold = repState({ modules: { factionStanding: { byPc: { [PC]: { [FACTION]: 20 } } } } });
    expect(workOffersOf(playset, atThreshold).map((w) => w.id)).toContain(WORK_GATED);

    const justBelow = repState({ modules: { factionStanding: { byPc: { [PC]: { [FACTION]: 19 } } } } });
    expect(workOffersOf(playset, justBelow).map((w) => w.id)).not.toContain(WORK_GATED);
  });

  test("engine resolve-time authority refuses the gated shift below standing 20 — no roll, no pay", async () => {
    const playset = reputationPlayset();
    const engine = await engineWith(playset, repState());
    const events: import("../src/events/types.ts").GameEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await engine.submitAction({ kind: "work", opportunityId: WORK_GATED });

    expect(engine.getState().actors[PC]?.coins ?? 0).toBe(0);
    expect(byKind(events, "diceRolled")).toHaveLength(0); // the gate refuses before any check rolls
  });

  test("engine resolve-time authority allows the gated shift once standing reaches 20", async () => {
    const playset = reputationPlayset();
    const engine = await engineWith(
      playset,
      repState({ modules: { factionStanding: { byPc: { [PC]: { [FACTION]: 20 } } } } }),
    );
    const events: import("../src/events/types.ts").GameEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await engine.submitAction({ kind: "work", opportunityId: WORK_GATED });

    expect(engine.getState().actors[PC]?.coins).toBe(80); // WORK_GATED's wage — the shift actually ran
    expect(byKind(events, "diceRolled")).toHaveLength(1);
    expect(factionStandingOf(engine.getState().modules, PC, FACTION)).toBe(23); // +3 on top of the seeded 20
  });
});

// ---------------------------------------------------------------------------------------------

describe("workRequiresMet — pure unit", () => {
  const playset = reputationPlayset();
  /** The gate, asked exactly the way the board and the resolver ask it. */
  const met = (req: TriggerPredicate | undefined, state: GameState = repState()): boolean =>
    workRequiresMet(
      req,
      fromGameState(state, playset.world, playset.campaign),
      playset.world,
      playset.campaign.characters,
    );
  const withModules = (modules: Record<string, unknown>): GameState => repState({ modules });

  test("an absent `requires` is always satisfied", () => {
    expect(met(undefined)).toBe(true);
  });

  test("factionStandingAtLeast holds iff standing >= value", () => {
    const req: TriggerPredicate = { allOf: [{ kind: "factionStandingAtLeast", factionId: FACTION, value: 20 }] };
    expect(met(req)).toBe(false); // no slice at all ⇒ standing 0
    expect(met(req, withModules({ factionStanding: { byPc: { [PC]: { [FACTION]: 19 } } } }))).toBe(false);
    expect(met(req, withModules({ factionStanding: { byPc: { [PC]: { [FACTION]: 20 } } } }))).toBe(true);
    expect(met(req, withModules({ factionStanding: { byPc: { [PC]: { [FACTION]: 100 } } } }))).toBe(true);
  });

  test("workedOpportunity holds iff the recorded count >= countAtLeast", () => {
    const req: TriggerPredicate = {
      allOf: [{ kind: "workedOpportunity", opportunityId: WORK_SURE, countAtLeast: 2 }],
    };
    expect(met(req)).toBe(false);
    expect(met(req, withModules({ workHistory: { opportunities: { [WORK_SURE]: 1 } } }))).toBe(false);
    expect(met(req, withModules({ workHistory: { opportunities: { [WORK_SURE]: 2 } } }))).toBe(true);
  });

  test("multiple allOf clauses all have to hold", () => {
    const req: TriggerPredicate = {
      allOf: [
        { kind: "factionStandingAtLeast", factionId: FACTION, value: 20 },
        { kind: "workedOpportunity", opportunityId: WORK_SURE, countAtLeast: 1 },
      ],
    };
    const onlyStanding = { factionStanding: { byPc: { [PC]: { [FACTION]: 20 } } } };
    const onlyHistory = { workHistory: { opportunities: { [WORK_SURE]: 1 } } };
    expect(met(req, withModules(onlyStanding))).toBe(false);
    expect(met(req, withModules(onlyHistory))).toBe(false);
    expect(met(req, withModules({ ...onlyStanding, ...onlyHistory }))).toBe(true);
  });

  // Regex audit §10b. The board used to run its OWN two-clause reader over `requires.allOf` and
  // treat every other kind as satisfied, so each of these three returned `true` against an empty PC
  // — reproduced verbatim against the shipped function. A gate an author wrote was simply ignored.
  describe("clause kinds the board's private reader used to wave through (fail-open repro)", () => {
    const cases: [string, TriggerPredicate][] = [
      ["hasItem", { allOf: [{ kind: "hasItem", entityId: PC, itemId: "item.guild-seal" }] }],
      ["questState", { allOf: [{ kind: "questState", questId: "quest.bond", state: "complete" }] }],
      ["flag", { allOf: [{ kind: "flag", key: "vouched", equals: true }] }],
      ["atLocation", { allOf: [{ kind: "atLocation", locationId: HALL_B }] }],
    ];

    test("an unmet clause now CLOSES the gate", () => {
      for (const [label, req] of cases) expect([label, met(req)]).toEqual([label, false]);
    });

    // …and the other direction, so the fix is a real evaluation and not a blanket "no": each gate
    // OPENS as soon as the world actually satisfies it.
    test("the same clause OPENS the gate once the world satisfies it", () => {
      const held = repState();
      held.actors[PC]!.inventory = ["item.guild-seal"];
      expect(met(cases[0]![1], held)).toBe(true);

      const done = repState();
      done.quests = { "quest.bond": "complete" };
      expect(met(cases[1]![1], done)).toBe(true);

      const flagged = repState();
      flagged.flags = { vouched: true };
      expect(met(cases[2]![1], flagged)).toBe(true);

      expect(met(cases[3]![1], repState({ locationId: HALL_B }))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("evalPredicate/evalCondition — factionStandingAtLeast (shared by prebaked events)", () => {
  test("the clause holds iff factionStandingOf(modules, pc, factionId) >= value", async () => {
    const playset = reputationPlayset();
    const pred: TriggerPredicate = { allOf: [{ kind: "factionStandingAtLeast", factionId: FACTION, value: 20 }] };

    const modelZero = fromGameState(repState(), playset.world, playset.campaign);
    expect(evalPredicate(pred, modelZero, partyLocationOf(modelZero))).toBe(false);

    const modelJustBelow = fromGameState(
      repState({ modules: { factionStanding: { byPc: { [PC]: { [FACTION]: 19 } } } } }),
      playset.world,
      playset.campaign,
    );
    expect(evalPredicate(pred, modelJustBelow, partyLocationOf(modelJustBelow))).toBe(false);

    const modelAtThreshold = fromGameState(
      repState({ modules: { factionStanding: { byPc: { [PC]: { [FACTION]: 20 } } } } }),
      playset.world,
      playset.campaign,
    );
    expect(evalPredicate(pred, modelAtThreshold, partyLocationOf(modelAtThreshold))).toBe(true);

    const modelAbove = fromGameState(
      repState({ modules: { factionStanding: { byPc: { [PC]: { [FACTION]: 45 } } } } }),
      playset.world,
      playset.campaign,
    );
    expect(evalPredicate(pred, modelAbove, partyLocationOf(modelAbove))).toBe(true);
  });

  test("a different faction's standing does not satisfy the clause", async () => {
    const playset = reputationPlayset();
    const pred: TriggerPredicate = { allOf: [{ kind: "factionStandingAtLeast", factionId: FACTION, value: 1 }] };
    const model = fromGameState(
      repState({ modules: { factionStanding: { byPc: { [PC]: { "faction.other": 99 } } } } }),
      playset.world,
      playset.campaign,
    );
    expect(evalPredicate(pred, model, partyLocationOf(model))).toBe(false);
  });
});
