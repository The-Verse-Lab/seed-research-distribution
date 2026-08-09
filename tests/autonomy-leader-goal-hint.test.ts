/**
 * Stage 5 (goal-directed leadership) — focused tests for `leaderGoalHint`, the pure, code-derived
 * party-direction nudge appended to `idleStimulus` ONLY for a companion that can currently lead
 * (src/modules/autonomy/module.ts). Exercised directly against a hand-built WorldModel/TickContext
 * (no engine, no gateway calls) so each fact rule (active objective / offered job / unexplored way)
 * is asserted in isolation and deterministically, plus one end-to-end wiring assertion that the real
 * `idleStimulus` carries the hint for a LEADER and withholds it from a plain follower.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { AutonomyModule, goalHint, leaderGoalHint, type AutonomyDialogueItem } from "../src/modules/autonomy/module.ts";
import { NpcAgent } from "../src/agents/npc.ts";
import type { NpcAct } from "../src/rules/npc-act.ts";
import { HeartbeatScheduler } from "../src/director/heartbeat.ts";
import { CampaignSchema, WorldSchema, type Exit, type Quest } from "../src/content/schema.ts";
import { fromGameState } from "../src/world/model.ts";
import type { GameState } from "../src/state/types.ts";
import type { TickContext } from "../src/engine/tick.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { turnContext, type TurnScratch } from "../src/logging/turn-context.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

/**
 * Build a minimal two-location world (`loc.a` --exits--> `loc.b`) with one deciding companion
 * (`npc.lead`, authored a `leader` by default) at `loc.a`, plus the quests + runtime quest state +
 * exits a scenario needs, wrapped in a bare-bones TickContext. `leaderGoalHint` only reads
 * `ctx.model` and `ctx.services.campaign`, so every other member is a never-called stub.
 */
function fixture(opts: {
  exits?: Exit[];
  quests?: Quest[];
  /** Runtime quest state overlay (questId → state); the ONLY thing the hint reads for "active"/"offered". */
  questState?: Record<string, GameState["quests"][string]>;
  /** Authored autonomy level for the deciding NPC — default a real leader; pass "proactive" for a follower. */
  level?: "proactive" | "leader";
  /** Authored personal goals for the leader — drives the no-quest "set the course" directive. */
  goals?: string[];
  /** Worn the PC (energy below the depleted ratio) to exercise the party-rest nudge. */
  pcEnergy?: { energy: number; maxEnergy: number };
  /** Per-world frontier-expansion flag; omit ⇒ enabled (absent). Pass false to test suppression. */
  frontierExpansion?: boolean;
}): TickContext {
  const world = WorldSchema.parse({
    id: "w.lead",
    name: "Lead World",
    summary: "A test fixture.",
    ...(opts.frontierExpansion !== undefined ? { frontierExpansion: opts.frontierExpansion } : {}),
    locations: [
      { id: "loc.a", name: "The Yard", description: "", exits: opts.exits ?? [] },
      { id: "loc.b", name: "The Vault", description: "" },
    ],
    npcs: [
      {
        id: "npc.lead",
        name: "Cass",
        persona: "A test leader.",
        goals: opts.goals ?? [],
        autonomy: { isPartyMember: true, level: opts.level ?? "leader", canLead: opts.level === "proactive" ? false : true },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.lead",
    name: "Lead Campaign",
    worldId: "w.lead",
    characters: [{ id: "pc.you", name: "You", stats: STATS, inventory: [] }],
    quests: opts.quests ?? [],
    startingState: { locationId: "loc.a", party: ["pc.you"], companions: ["npc.lead"] },
  });

  const actors = {
    "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.a", inventory: [], conditions: [], ...(opts.pcEnergy ?? {}) },
    "npc.lead": { id: "npc.lead", currentHp: 10, locationId: "loc.a", inventory: [], conditions: [] },
  } as unknown as GameState["actors"];

  const gs: GameState = {
    campaignId: "c.lead",
    worldId: "w.lead",
    partyLocationId: "loc.a",
    clock: 0,
    party: ["pc.you"],
    companions: ["npc.lead"],
    actors,
    quests: opts.questState ?? {},
    relationships: {},
    autonomy: {},
    modules: { autonomy: {} },
    flags: {},
  };
  const model = fromGameState(gs, world, campaign);

  return {
    trigger: { kind: "heartbeat", npcId: "npc.lead" },
    model,
    services: { world, campaign, gateway: new OfflineGateway(), rng: () => 0 },
    recent: [],
    data: {},
    queue: [],
    enqueue: () => {},
    apply: () => ({ deltas: [], mutated: false }),
    dryRun: () => ({ deltas: [], mutated: false }),
    applySilent: () => ({ deltas: [], mutated: false }),
    emit: () => {},
    state: () => gs,
  };
}

/** A parsed quest with the given objectives (each objective's `done` defaulting false). */
function quest(id: string, name: string, objectives: { id: string; description: string; done?: boolean }[] = []): Quest {
  return { id, name, description: "", objectives: objectives.map((o) => ({ done: false, ...o })), state: "hidden" };
}

const FRONTIER_EXIT: Exit = {
  to: "frontier:deepwood",
  name: "the forest track",
  locked: false,
  hidden: false,
};

describe("leaderGoalHint (Stage 5 goal-direction nudge)", () => {
  test("no quests and no frontier ahead yields no hint at all", () => {
    expect(leaderGoalHint(fixture({}), "npc.lead")).toBe("");
  });

  test("an ACTIVE quest surfaces its first INCOMPLETE objective (nudges pursuit)", () => {
    const ctx = fixture({
      quests: [quest("quest.letter", "The Sealed Letter", [
        { id: "o1", description: "carry the letter to Greenferry", done: true },
        { id: "o2", description: "deliver it to the harbormaster" },
      ])],
      questState: { "quest.letter": "active" },
    });
    const hint = leaderGoalHint(ctx, "npc.lead");
    // The DONE objective is skipped; the first outstanding one is named.
    expect(hint).toContain("The party still has to: deliver it to the harbormaster.");
    expect(hint).not.toContain("carry the letter to Greenferry");
  });

  test("an objective completed in the LIVE slice is skipped — authored done:false does not resurrect it (r9 F-3)", () => {
    // The r9 brief said "The party still has to: recover its guild-bond" on the same page that
    // listed the objective `· done` — the hint read the static content flag, not the reducer's
    // `objectives` module slice.
    const ctx = fixture({
      quests: [
        quest("q.bond", "The Overdue Caravan", [
          { id: "o1", description: "recover its guild-bond or cargo" },
          { id: "o2", description: "lodge the salvage claim" },
        ]),
      ],
      questState: { "q.bond": "active" },
    });
    (ctx.model.modules as Record<string, unknown>)["objectives"] = { "q.bond": { o1: true } };
    const hint = leaderGoalHint(ctx, "npc.lead");
    expect(hint).not.toContain("guild-bond");
    expect(hint).toContain("lodge the salvage claim");
  });

  test("an ACTIVE quest with every objective done falls back to the quest name", () => {
    const ctx = fixture({
      quests: [quest("quest.letter", "The Sealed Letter", [{ id: "o1", description: "done thing", done: true }])],
      questState: { "quest.letter": "active" },
    });
    expect(leaderGoalHint(ctx, "npc.lead")).toContain("seeing The Sealed Letter through");
  });

  test("no quest + a leader WITH a personal goal ⇒ the 'set the course yourself' directive fires", () => {
    // The requested feature: with nothing else pulling the party, a leader that has its own aim is
    // told to steer the party toward it. The aim is NOT re-quoted (it rides `# YOU`), so the fragment
    // is the directive, not the goal text.
    const ctx = fixture({ goals: ["Reach the drowned city before the tide turns"] });
    const hint = leaderGoalHint(ctx, "npc.lead");
    expect(hint).toContain("the course is yours to set");
    // The private goal text itself never leaks into the nudge.
    expect(hint).not.toContain("drowned city");
  });

  test("no quest + a GOAL-LESS leader ⇒ no directive (omit-when-empty preserved)", () => {
    expect(leaderGoalHint(fixture({ goals: [] }), "npc.lead")).toBe("");
  });

  test("a live quest SUPPRESSES the personal-goal directive (the quest is the party's call)", () => {
    const ctx = fixture({
      goals: ["Reach the drowned city"],
      quests: [quest("quest.q", "Q", [{ id: "o1", description: "reach the tower" }])],
      questState: { "quest.q": "active" },
    });
    const hint = leaderGoalHint(ctx, "npc.lead");
    expect(hint).toContain("reach the tower");
    expect(hint).not.toContain("the course is yours to set");
  });

  test("a worn party member (the PC) surfaces the leader's group-rest nudge, taking priority", () => {
    const ctx = fixture({
      pcEnergy: { energy: 5, maxEnergy: 100 },
      goals: ["some aim"],
      exits: [FRONTIER_EXIT],
    });
    const hint = leaderGoalHint(ctx, "npc.lead");
    expect(hint).toContain("The party is worn — you could call a rest");
    // Rest (>) direction: with the 2-fact cap, the rest + the personal-goal directive win; the
    // frontier (weakest pull) is dropped.
    expect(hint).toContain("the course is yours to set");
    expect(hint).not.toContain("No one has explored");
  });

  test("the nudge is capped at two facts even when rest + quest + frontier all apply", () => {
    const ctx = fixture({
      pcEnergy: { energy: 5, maxEnergy: 100 },
      quests: [quest("quest.q", "Q", [{ id: "o1", description: "reach the tower" }])],
      questState: { "quest.q": "active" },
      exits: [FRONTIER_EXIT],
    });
    const hint = leaderGoalHint(ctx, "npc.lead");
    expect(hint).toContain("The party is worn");
    expect(hint).toContain("reach the tower");
    expect(hint).not.toContain("No one has explored");
  });

  test("with NO active quest, an OFFERED job on the table is nudged (player still decides)", () => {
    const ctx = fixture({
      quests: [quest("quest.bounty", "The Marsh Bounty")],
      questState: { "quest.bounty": "offered" },
    });
    expect(leaderGoalHint(ctx, "npc.lead")).toContain("job no one has taken up yet: The Marsh Bounty.");
  });

  test("an ACTIVE quest wins over an OFFERED one (pursue what's underway, not what's on offer)", () => {
    const ctx = fixture({
      quests: [
        quest("quest.active", "Underway", [{ id: "o1", description: "finish the job" }]),
        quest("quest.offered", "On Offer"),
      ],
      questState: { "quest.active": "active", "quest.offered": "offered" },
    });
    const hint = leaderGoalHint(ctx, "npc.lead");
    expect(hint).toContain("finish the job");
    expect(hint).not.toContain("On Offer");
  });

  test("a HIDDEN / COMPLETE quest is never surfaced (no GM-secret or done-goal leak)", () => {
    const ctx = fixture({
      quests: [quest("quest.secret", "Secret Plot", [{ id: "o1", description: "never say this" }])],
      questState: { "quest.secret": "hidden" },
    });
    expect(leaderGoalHint(ctx, "npc.lead")).toBe("");
    const done = fixture({
      quests: [quest("quest.done", "Finished", [{ id: "o1", description: "already handled" }])],
      questState: { "quest.done": "complete" },
    });
    expect(leaderGoalHint(done, "npc.lead")).toBe("");
  });

  test("a non-hidden FRONTIER exit surfaces the 'unexplored way' fragment naming it", () => {
    const ctx = fixture({ exits: [FRONTIER_EXIT] });
    expect(leaderGoalHint(ctx, "npc.lead")).toBe(" No one has explored the forest track yet.");
  });

  test("a HIDDEN frontier exit is never surfaced", () => {
    const ctx = fixture({ exits: [{ ...FRONTIER_EXIT, hidden: true }] });
    expect(leaderGoalHint(ctx, "npc.lead")).toBe("");
  });

  test("flag OFF: a frontier exit is NOT surfaced as an 'unexplored way' (frontierExpansion:false)", () => {
    // With expansion disabled the leader never nudges toward a crossing the engine will refuse.
    const ctx = fixture({ exits: [FRONTIER_EXIT], frontierExpansion: false });
    expect(leaderGoalHint(ctx, "npc.lead")).toBe("");
  });

  test("a real (non-frontier) exit is not an 'unexplored way'", () => {
    const ctx = fixture({ exits: [{ to: "loc.b", name: "the door", locked: false, hidden: false }] });
    expect(leaderGoalHint(ctx, "npc.lead")).toBe("");
  });

  test("an active objective + a frontier ahead join into a single terse two-fact hint", () => {
    const ctx = fixture({
      quests: [quest("quest.q", "Q", [{ id: "o1", description: "reach the tower" }])],
      questState: { "quest.q": "active" },
      exits: [FRONTIER_EXIT],
    });
    const hint = leaderGoalHint(ctx, "npc.lead");
    expect(hint).toContain("reach the tower");
    expect(hint).toContain("No one has explored the forest track yet");
  });
});

// ===========================================================================
// F3 — `goalHint`, the SELF-scoped counterpart appended for a proactive NON-leader / present world
// NPC. A goal-bearing NPC is steered to act toward its aim; a goal-less one gets nothing. The goal
// string itself must NEVER appear (private motivations are not recited — the Stage-4 leak rule).
// ===========================================================================
describe("goalHint (F3 self-scoped goal nudge)", () => {
  test("omit-when-empty: a goal-less NPC gets nothing", () => {
    expect(goalHint(fixture({ goals: [] }), "npc.lead")).toBe("");
  });

  test("a goal-bearing NPC gets a directive to take a step toward its aim", () => {
    const hint = goalHint(fixture({ goals: ["Recover the true record"] }), "npc.lead");
    expect(hint).toContain("take one concrete step toward what you're really after");
  });

  test("the goal text is NEVER quoted (no private-motive leak)", () => {
    const hint = goalHint(fixture({ goals: ["Recover the true record"] }), "npc.lead");
    expect(hint).not.toContain("Recover the true record");
    expect(hint.toLowerCase()).not.toContain("record");
  });
});

// ===========================================================================
// Wiring: the private `idleStimulus` builder appends `leaderGoalHint` ONLY for a companion that can
// currently lead the table (canLeadNow). Drives the real AutonomyModule's react phase directly
// (mirrors tests/autonomy-situation-hint.test.ts) so the one seam that would silently rot — the
// `canLeadNow`-gated call in idleStimulus — is covered end to end.
// ===========================================================================
describe("idleStimulus wiring (Stage 5)", () => {
  async function stimulusFor(ctx: TickContext): Promise<string> {
    const world = ctx.services.world;
    const template = world.npcs.find((n) => n.id === "npc.lead")!;
    const npcs = new Map([["npc.lead", new NpcAgent(ctx.services.gateway, template)]]);
    const module = new AutonomyModule(npcs, new HeartbeatScheduler(), world, () => 0);
    await module.phases.react!(ctx);
    const queue = (ctx.data.autonomyDialogue as AutonomyDialogueItem[] | undefined) ?? [];
    return queue[0]?.stimulus ?? "";
  }

  test("a LEADER's heartbeat stimulus carries the goal-direction nudge", async () => {
    const stimulus = await stimulusFor(
      fixture({
        quests: [quest("quest.q", "Q", [{ id: "o1", description: "reach the tower" }])],
        questState: { "quest.q": "active" },
      }),
    );
    expect(stimulus).toContain("Act on what matters to you");
    expect(stimulus).toContain("The party still has to: reach the tower.");
  });

  test("a plain PROACTIVE follower (no goals) gets no goal nudge — leader-direction absent", async () => {
    const stimulus = await stimulusFor(
      fixture({
        level: "proactive",
        quests: [quest("quest.q", "Q", [{ id: "o1", description: "reach the tower" }])],
        questState: { "quest.q": "active" },
      }),
    );
    expect(stimulus).toContain("Act on what matters to you");
    expect(stimulus).not.toContain("The party still has to"); // never the leader's PARTY-direction nudge
    expect(stimulus).not.toContain("take one concrete step"); // and no goalHint — this follower has no goals
  });

  test("a PROACTIVE follower WITH a goal carries the self-scoped goalHint (F3)", async () => {
    const stimulus = await stimulusFor(fixture({ level: "proactive", goals: ["mind the stall"] }));
    expect(stimulus).toContain("Act on what matters to you");
    expect(stimulus).not.toContain("The party still has to"); // still not the leader path
    expect(stimulus).toContain("take one concrete step toward what you're really after");
    expect(stimulus).not.toContain("mind the stall"); // goal never recited
  });
});

// ===========================================================================
// Stage A — proposal detection is GROUNDING-based, not keyword-based. A leader's priority-B reactive
// line becomes an executable NpcProposal only when it GROUNDS TO A CONCRETE WORLD MOVE (the old
// `PROPOSAL_MARKERS` keyword net is gone). Driven straight through the module's narrate phase with a
// stub agent so a specific intent can be forced deterministically (no gateway prose).
// ===========================================================================
describe("proposal detection is grounding-based (Stage A — keyword net retired)", () => {
  const REAL_EXIT: Exit = { to: "loc.b", name: "the vault door", locked: false, hidden: false };

  /** An NpcAgent whose decide always returns exactly the given intent (no LLM). */
  function stubAgent(intent: { visibleSpeech?: string; visibleAction?: string; desiredAct?: NpcAct }): NpcAgent {
    return { decideTurn: async () => intent } as unknown as NpcAgent;
  }

  /** Run one priority-B leader item through narrate; capture emitted events + the proposal patch. */
  async function runB(
    intent: { visibleSpeech?: string; visibleAction?: string; desiredAct?: NpcAct },
    exits: Exit[],
  ): Promise<{ events: Array<{ kind: string }>; commands: unknown[] | undefined }> {
    const ctx = fixture({ exits });
    const events: Array<{ kind: string }> = [];
    ctx.emit = (e) => void events.push(e as { kind: string });
    let commands: unknown[] | undefined;
    ctx.applySilent = (cmd) => {
      const patch = (cmd as { patch?: Record<string, { pendingProposal?: { commands?: unknown[] } }> }).patch;
      const pending = patch?.["npc.lead"]?.pendingProposal;
      if (pending) commands = pending.commands;
      return { deltas: [], mutated: false };
    };
    const module = new AutonomyModule(
      new Map([["npc.lead", stubAgent(intent)]]),
      new HeartbeatScheduler(),
      ctx.services.world,
      () => 0,
    );
    ctx.data.autonomyDialogue = [{ npcId: "npc.lead", stimulus: "", replyDepth: 0, priority: "B" }];
    await module.phases.narrate!(ctx);
    return { events, commands };
  }

  test("a B-line that grounds to a MOVE fires a proposal carrying the executable command", async () => {
    const { events, commands } = await runB({ visibleSpeech: "", desiredAct: { do: "move", target: "loc.b" } }, [REAL_EXIT]);
    expect(events.filter((e) => e.kind === "npcProposal")).toHaveLength(1);
    // The proposal is executable on tacit consent — it carries the grounded move, not an empty stub.
    expect(commands && commands.length).toBeGreaterThan(0);
  });

  test("a B-line that is PURE SPEECH does NOT propose (the old keyword net would have on 'come on')", async () => {
    const { events } = await runB({ visibleSpeech: '"Fine weather we\'re having, friend."' }, [REAL_EXIT]);
    expect(events.filter((e) => e.kind === "npcProposal")).toHaveLength(0);
  });

  test("an ILLEGAL act records WHICH act was dropped, not just that one was", async () => {
    // The r15 sweep reported `npc.oda action dropped (illegal, confidence 1.00)` and stopped there:
    // with no verb and no target on the record, "named a verb it was never offered" and "named a
    // stale/invented id" are indistinguishable, and neither a human nor the triage could diagnose it.
    const scratch: TurnScratch = { turnSeq: 1 };
    await turnContext.run(scratch, () =>
      runB({ visibleSpeech: "", desiredAct: { do: "move", target: "loc.nowhere" } }, [REAL_EXIT]),
    );
    expect(scratch.groundingFallbacks).toEqual([
      { actorId: "npc.lead", confidence: 1, reason: "illegal", act: "move", target: "loc.nowhere" },
    ]);
  });

  test("a CLEANLY grounded act records no drop at all", async () => {
    const scratch: TurnScratch = { turnSeq: 1 };
    await turnContext.run(scratch, () =>
      runB({ visibleSpeech: "", desiredAct: { do: "move", target: "loc.b" } }, [REAL_EXIT]),
    );
    expect(scratch.groundingFallbacks).toBeUndefined();
  });
});

describe("partyFatigued — multi-member weighting (Feature 2, via leaderGoalHint's rest fragment)", () => {
  const REST = "The party is worn — you could call a rest";

  /**
   * A leader (`npc.lead`, excluded from the fatigue read) plus a roster of NON-leader party members
   * (companions + the PC), each with an authored energy/exhaustion, all co-located at `loc.a`. Returns
   * the leaderGoalHint string so a scenario asserts on the presence/absence of the group-rest fragment.
   */
  function restHint(members: { id: string; energy: number; maxEnergy: number; exhaustion?: number }[]): string {
    const companionIds = members.filter((m) => m.id !== "pc.you").map((m) => m.id);
    const world = WorldSchema.parse({
      id: "w.fat",
      name: "Fatigue World",
      summary: "A test fixture.",
      locations: [{ id: "loc.a", name: "The Yard", description: "", exits: [] }],
      npcs: [
        { id: "npc.lead", name: "Cass", persona: "leader", goals: [], autonomy: { isPartyMember: true, level: "leader", canLead: true } },
        ...companionIds.map((id) => ({ id, name: id, persona: "member", autonomy: { isPartyMember: true, level: "reactive" as const, canLead: false } })),
      ],
    });
    const campaign = CampaignSchema.parse({
      id: "c.fat",
      name: "Fatigue Campaign",
      worldId: "w.fat",
      characters: [{ id: "pc.you", name: "You", stats: STATS, inventory: [] }],
      quests: [],
      startingState: { locationId: "loc.a", party: ["pc.you"], companions: ["npc.lead", ...companionIds] },
    });
    const actors: Record<string, unknown> = {
      "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.a", inventory: [], conditions: [] },
      "npc.lead": { id: "npc.lead", currentHp: 10, locationId: "loc.a", inventory: [], conditions: [] },
    };
    for (const m of members) {
      actors[m.id] = {
        id: m.id,
        currentHp: 10,
        locationId: "loc.a",
        inventory: [],
        conditions: [],
        energy: m.energy,
        maxEnergy: m.maxEnergy,
        ...(m.exhaustion !== undefined ? { exhaustion: m.exhaustion } : {}),
      };
    }
    const gs: GameState = {
      campaignId: "c.fat",
      worldId: "w.fat",
      partyLocationId: "loc.a",
      clock: 0,
      party: ["pc.you"],
      companions: ["npc.lead", ...companionIds],
      actors: actors as unknown as GameState["actors"],
      quests: {},
      relationships: {},
      autonomy: {},
      modules: { autonomy: {} },
      flags: {},
    };
    const model = fromGameState(gs, world, campaign);
    const ctx = {
      trigger: { kind: "heartbeat", npcId: "npc.lead" },
      model,
      services: { world, campaign, gateway: new OfflineGateway(), rng: () => 0 },
      recent: [],
      data: {},
      queue: [],
      enqueue: () => {},
      apply: () => ({ deltas: [], mutated: false }),
      dryRun: () => ({ deltas: [], mutated: false }),
      applySilent: () => ({ deltas: [], mutated: false }),
      emit: () => {},
      state: () => gs,
    } as unknown as TickContext;
    return leaderGoalHint(ctx, "npc.lead");
  }

  test("ONE mildly-tired member among fresh ones does NOT force a rest (the old first-match would have)", () => {
    // npc.a at 0.55 would trip the old `< 0.6` first-match; weighted, the party mean (0.85) is fine.
    const hint = restHint([
      { id: "pc.you", energy: 100, maxEnergy: 100 },
      { id: "npc.a", energy: 55, maxEnergy: 100 },
      { id: "npc.b", energy: 100, maxEnergy: 100 },
    ]);
    expect(hint).not.toContain(REST);
  });

  test("TWO members below 0.6 pull the MEAN under the depleted ratio → rest is nudged", () => {
    const hint = restHint([
      { id: "pc.you", energy: 50, maxEnergy: 100 },
      { id: "npc.a", energy: 50, maxEnergy: 100 },
    ]);
    expect(hint).toContain(REST);
  });

  test("ONE critically-spent member (< 0.35) pulls the whole party toward rest even if the mean is high", () => {
    const hint = restHint([
      { id: "pc.you", energy: 30, maxEnergy: 100 },
      { id: "npc.a", energy: 100, maxEnergy: 100 },
      { id: "npc.b", energy: 100, maxEnergy: 100 },
    ]);
    expect(hint).toContain(REST);
  });

  test("exhaustion lowers the working cap: a nominally-well-fed but exhausted member reads as tired", () => {
    // energy 70/100: fresh ⇒ ratio 0.70 (no rest). Exhaustion 4 caps effective energy at 50 ⇒ 0.50 (rest).
    expect(restHint([{ id: "pc.you", energy: 70, maxEnergy: 100 }])).not.toContain(REST);
    expect(restHint([{ id: "pc.you", energy: 70, maxEnergy: 100, exhaustion: 4 }])).toContain(REST);
  });

  test("a statless member never counts (and a fresh solo follower reads rested)", () => {
    expect(restHint([{ id: "pc.you", energy: 100, maxEnergy: 100 }])).not.toContain(REST);
  });
});
