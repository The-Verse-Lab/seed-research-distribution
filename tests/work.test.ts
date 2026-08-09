/**
 * Work tests — the job system wired end-to-end through the engine.
 *
 * Exercises reconcilePlan's grounding of a model-authored `work` payload (present opportunity
 * grounds, hallucinated/absent drops to freeform), and the engine's code-only resolution via the
 * grounded-action channel (`submitAction` — the Work-button path, classifier bypassed): a shift
 * rolls a seeded ability check, a success pays `wageCp` and a botch `failWageCp`, the coin flows
 * through the reducer's `adjustCoins` (one writer), an unknown opportunity refuses without pay, and
 * an exhausted PC cannot start a shift at all. Offline gateway throughout — deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { GameState } from "../src/state/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { reconcilePlan, type TurnClassifier } from "../src/engine/classify.ts";
import type { ClassifierContext, TurnPlan } from "../src/engine/turn-plan.ts";
import { byKind, loadExample } from "./support/harness.ts";
import { workOffersOf } from "../src/state/projections.ts";

// --- reconcilePlan work grounding --------------------------------------------

function workCtx(overrides: Partial<ClassifierContext> = {}): ClassifierContext {
  return {
    playerActorId: "pc.you",
    locationId: "loc.tavern",
    locationName: "The Tavern",
    exits: [],
    presentEntities: [],
    companionIds: [],
    workOpportunities: [{ id: "work.easy", label: "Sweep the common room" }],
    ...overrides,
  };
}

const rawWork = (work: Record<string, unknown> | null) => ({
  kind: "work",
  targetId: null,
  destinationLocationId: null,
  check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
  work,
  confidence: 0.8,
});

describe("reconcilePlan work grounding", () => {
  test("a present opportunity grounds the payload", () => {
    const plan = reconcilePlan(rawWork({ opportunityId: "work.easy" }), workCtx());
    expect(plan.kind).toBe("work");
    expect(plan.work).toEqual({ opportunityId: "work.easy" });
  });

  test("a hallucinated opportunity drops the payload and downgrades to freeform", () => {
    const plan = reconcilePlan(rawWork({ opportunityId: "work.ghost" }), workCtx());
    expect(plan.kind).toBe("freeformNarrative");
    expect(plan.work).toBeUndefined();
  });

  test("a null opportunityId grounds to the only work on offer", () => {
    const plan = reconcilePlan(rawWork({ opportunityId: null }), workCtx());
    expect(plan.kind).toBe("work");
    expect(plan.work).toEqual({ opportunityId: "work.easy" });
  });

  test("no work present ⇒ a work payload never grounds", () => {
    const plan = reconcilePlan(rawWork({ opportunityId: "work.easy" }), workCtx({ workOpportunities: [] }));
    expect(plan.kind).toBe("freeformNarrative");
  });
});

// --- engine resolution (grounded Work-button channel) ------------------------

/** The example tavern as an adventure-guild hall with a two-job board: a trivial shift and an
 *  impossible one. Jobs are guild-only now (owner decision 2026-07-22), so the board must ride a
 *  `guild` flag for the engine collectors to surface it. */
function workPlayset(base: PlaySet): PlaySet {
  const playset = structuredClone(base);
  const tavern = playset.world.locations.find((l) => l.id === "loc.tavern")!;
  tavern.guild = { name: "The Tavern Work-Board" };
  tavern.work = [
    { id: "work.easy", label: "Sweep the common room", ability: "str", dc: 5, wageCp: 60, failWageCp: 10 },
    { id: "work.hard", label: "Wrestle the cellar barrels", ability: "str", dc: 30, wageCp: 200, failWageCp: 20 },
  ];
  return playset;
}

function seededState(playset: PlaySet, energy = 100, exhaustion = 0): GameState {
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.tavern",
    clock: 0,
    party: ["pc.you"],
    companions: [],
    actors: {
      "pc.you": {
        id: "pc.you",
        currentHp: 10,
        locationId: "loc.tavern",
        inventory: [],
        conditions: [],
        coins: 100,
        energy,
        maxEnergy: 100,
        exhaustion,
      },
    },
    quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
    relationships: {},
    autonomy: {},
    flags: {},
  };
}

async function makeWorkEngine(
  seed = 7,
  energy = 100,
  exhaustion = 0,
  classifier: TurnClassifier = heuristicClassifier,
): Promise<{ engine: GameEngine; events: GameEvent[] }> {
  const playset = workPlayset(await loadExample());
  const store = new InMemoryGameStateStore();
  await store.save(
    makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]),
    seededState(playset, energy, exhaustion),
  );
  const engine = new GameEngine({
    playset,
    store,
    gateway: new OfflineGateway(),
    rng: mulberry32(seed),
    classifier,
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

const workRolls = (events: GameEvent[], label: string) =>
  byKind(events, "diceRolled").filter((e) => e.purpose?.includes(label));

/** Scripted classifier stub: the LLM classified the line as a work INQUIRY (the old pre-classify
 *  regex gate is deleted — the classifier is THE router now, per the no-nets rule). */
const workInquiryClassifier: TurnClassifier = {
  classify: () =>
    Promise.resolve({
      kind: "workInquiry",
      targetId: null,
      destinationLocationId: null,
      check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
      confidence: 1,
    } satisfies TurnPlan),
};

describe("engine work resolution", () => {
  test("a classified work inquiry is answered from the live board and points without working (N3)", async () => {
    const { engine, events } = await makeWorkEngine(7, 100, 0, workInquiryClassifier);

    await engine.submitPlayerInput(
      "point me to the fastest, safest paying work on the docks — day labor, hauling, anything with no risk",
    );

    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
    const answer = byKind(events, "narration").at(-1)?.text ?? "";
    expect(answer).toContain("Sweep the common room");
    // The system/roleplay divide: the pointer names the job as a thing in the world (the claims-board)
    // but the mechanics — wage, and the "say you take it" menu imperative — live in the WorkCard, never
    // the prose. Regression guard against the old disembodied menu ("… 60 cp for a good shift. Say you
    // take that job when you are ready.").
    expect(answer).not.toMatch(/\bsp\b|\bcp\b|\bcoins?\b/i);
    expect(answer.toLowerCase()).not.toContain("say you take");
  });

  test("'a job that pays more' ranks by wage, not lowest DC (N8)", async () => {
    const { engine, events } = await makeWorkEngine(7, 100, 0, workInquiryClassifier);

    // "pays more" is the reversed word order the old best-paying regex missed — it fell to the
    // default lowest-DC sort and pointed at the cheap Sweep job. It must now name the higher wage.
    await engine.submitPlayerInput("is there a job that pays more for no more danger? point me to it");

    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
    expect(byKind(events, "narration").at(-1)?.text).toContain("Wrestle the cellar barrels");
  });

  test("a hedged 'I'm not sure' does not rank the board by SAFETY (r8 regex audit)", async () => {
    const { engine, events } = await makeWorkEngine(7, 100, 0, workInquiryClassifier);

    // The safety modifier list carried the bare word "sure", the commonest hedge in English, and
    // `safest` is tested FIRST in the sort — so this line was answered with the DC-5 60cp sweep.
    // Reproduced against the shipped ranker: the player asked which job pays best and was pointed
    // at the worst-paying job on the board, because "not sure" scored as "no risk".
    await engine.submitPlayerInput("I'm not sure — which of these jobs pays the best?");

    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "narration").at(-1)?.text).toContain("Wrestle the cellar barrels");
  });

  test("a real safety ask still ranks by DC — 'a sure thing', 'the surest work' (r8 regex audit)", async () => {
    const { engine, events } = await makeWorkEngine(7, 100, 0, workInquiryClassifier);

    // The other direction: "sure" attached to the noun that makes it a claim about the WORK still
    // means what it always meant, and "surest" was never ambiguous.
    await engine.submitPlayerInput("is there a sure thing on that board? nothing risky");

    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "narration").at(-1)?.text).toContain("Sweep the common room");
  });

  test("'which one pays the most' ranks by wage — the article+superlative form (r4-C)", async () => {
    const { engine, events } = await makeWorkEngine(7, 100, 0, workInquiryClassifier);

    // Live r4-C: "what jobs pay here, and which one pays the most?" fell to the default lowest-DC
    // answer because "pays THE most" has an article between the verb and the superlative, and
    // "most" was missing from the trailing alternation entirely.
    await engine.submitPlayerInput("what jobs pay here, and which one pays the most?");

    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
    expect(byKind(events, "narration").at(-1)?.text).toContain("Wrestle the cellar barrels");
  });

  test("a discursive 'ask around for honest work' classified as inquiry answers from the board (N11)", async () => {
    const { engine, events } = await makeWorkEngine(7, 100, 0, workInquiryClassifier);

    // Anti-fabrication (N11): a classified inquiry must answer from the real board without a roll,
    // deterministically — never let the narrator invent employers and postings.
    await engine.submitPlayerInput("I ask around for honest work — a guard posting, hauling, anything");

    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
    expect(byKind(events, "narration").at(-1)?.text).toContain("Sweep the common room");
  });

  test("a work inquiry with a present companion routes THROUGH them, not the disembodied board", async () => {
    // The design contract: the world never narrates its own job menu. With a companion present, the
    // pointer is delivered as their in-character reply (a face), NOT the fixture claims-board prose —
    // so the deterministic board line must be absent, and no wage/menu-imperative leaks into the turn.
    const playset = workPlayset(await loadExample());
    const store = new InMemoryGameStateStore();
    const state = seededState(playset);
    state.companions = ["npc.lyra"];
    state.actors["npc.lyra"] = {
      id: "npc.lyra",
      currentHp: 10,
      locationId: "loc.tavern",
      inventory: [],
      conditions: [],
      coins: 0,
      energy: 100,
      maxEnergy: 100,
      exhaustion: 0,
    };
    await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), state);
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(7),
      classifier: workInquiryClassifier,
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();
    events.length = 0;

    await engine.submitPlayerInput("where can I find honest work around here?");

    // No fixture board narration (that is the no-speaker fallback) — the ask was routed to Lyra.
    const narrations = byKind(events, "narration").map((n) => n.text);
    expect(narrations.some((t) => t.includes("claims-board here still carries"))).toBe(false);
    // Still no rolling/paying, and no leaked mechanics anywhere in the turn's prose.
    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(narrations.join(" ")).not.toContain("say you take");
  });

  test("an impossible shift (DC 30) always fails and pays only the fail wage — through the reducer", async () => {
    const { engine, events } = await makeWorkEngine();

    await engine.submitAction({ kind: "work", opportunityId: "work.hard" });

    const rolled = workRolls(events, "cellar");
    expect(rolled).toHaveLength(1);
    expect(rolled[0]!.success).toBe(false);
    expect(byKind(events, "coinsChanged")).toEqual([
      expect.objectContaining({ entityId: "pc.you", coins: 120 }), // 100 + 20 fail wage
    ]);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(120);
  });

  test("a shift pays the wage that matches its roll; the coin flows as a coinsChanged delta", async () => {
    const { engine, events } = await makeWorkEngine();

    await engine.submitAction({ kind: "work", opportunityId: "work.easy" });

    const roll = workRolls(events, "common room")[0]!;
    const expected = 100 + (roll.success ? 60 : 10);
    expect(byKind(events, "coinsChanged")).toEqual([
      expect.objectContaining({ entityId: "pc.you", coins: expected }),
    ]);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(expected);
    const history = engine.getState().modules?.workHistory as { opportunities?: Record<string, number> } | undefined;
    expect(history?.opportunities?.["work.easy"]).toBe(1);
    expect(byKind(events, "modulePatched").some((e) => e.module === "workHistory")).toBe(true);
  });

  test("an unknown opportunity refuses without paying a coin", async () => {
    const { engine, events } = await makeWorkEngine();

    await engine.submitAction({ kind: "work", opportunityId: "work.nonexistent" });

    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
  });

  test("an exhausted PC (level 5) cannot start a shift — no roll, no pay, an honest refusal", async () => {
    const { engine, events } = await makeWorkEngine(7, 0, 5);

    await engine.submitAction({ kind: "work", opportunityId: "work.easy" });

    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
    const narrations = byKind(events, "narration");
    expect(narrations.some((n) => n.text.includes("failing"))).toBe(true);
  });

  test("the guild gate: a location with work[] but NO guild surfaces zero offers and refuses a shift", async () => {
    // Jobs are guild-only (owner decision 2026-07-22). Author the same board WITHOUT the guild flag:
    // the read-only projection must hide it, and the resolve-time authority must refuse the shift.
    const playset = structuredClone(await loadExample());
    const tavern = playset.world.locations.find((l) => l.id === "loc.tavern")!;
    tavern.work = [
      { id: "work.easy", label: "Sweep the common room", ability: "str", dc: 5, wageCp: 60, failWageCp: 10 },
    ];
    // (no tavern.guild)
    const store = new InMemoryGameStateStore();
    await store.save(
      makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]),
      seededState(playset),
    );
    const engine = new GameEngine({
      playset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(7),
      classifier: heuristicClassifier,
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();
    events.length = 0;

    // Projection: no board off-guild.
    expect(workOffersOf(playset, engine.getState())).toEqual([]);
    // Resolve authority: the ungated job is unknown, so the shift refuses without a roll or pay.
    await engine.submitAction({ kind: "work", opportunityId: "work.easy" });
    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "coinsChanged")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.coins).toBe(100);
  });
});
