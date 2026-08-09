/**
 * Phase 2 (Mystery wave) — the case spine: content solvability, loader cross-validation, the reducer
 * command family (idempotent/clamped/capped), the `snapshot == fold(deltas)` replay invariant over a
 * scripted case session, and the engine→brief surfaces (event/check reveals reach `playerKnown`; the
 * GM `# CASE` block renders while the solution stays on the private gmLore channel).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import {
  compileAndValidatePlaySet,
  loadPlaySetFromDir,
  loadRawPlaySetFromDir,
} from "../src/content/loader.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { applyDelta } from "./support/replay.ts";
import type { DeltaEvent } from "../src/events/deltas.ts";
import { buildNarrationContext } from "../src/agents/context.ts";
import { NpcAgent } from "../src/agents/npc.ts";
import { NpcTemplateSchema, type Case, type PlaySet } from "../src/content/schema.ts";
import { BRIEF_MARKERS } from "../src/util/markers.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { ChatMessage, CompletionChunk, CompletionRequest, LlmRole } from "../src/llm/types.ts";
import { CasesModule } from "../src/modules/cases/module.ts";
import { CaseTestimonyModule } from "../src/modules/case-testimony/module.ts";
import type { TickContext } from "../src/engine/tick.ts";
import { reconcilePlan, type TurnClassifier } from "../src/engine/classify.ts";
import type { ClassifierContext, TurnPlan } from "../src/engine/turn-plan.ts";
import {
  caseBriefForNpc,
  checkCaseSolvability,
  classifyCaseClaim,
  CLAIMS_CAP,
  CREDIBILITY_MAX,
  CREDIBILITY_MIN,
  defaultCaseRuntime,
  defaultNpcCaseState,
  joinFactTexts,
  planCaseShare,
  readCasesSlice,
  renderCaseFileForNpc,
  SHARE_COOLDOWN_MINUTES,
  type CaseRuntime,
} from "../src/rules/cases.ts";
import { casesOf } from "../src/state/projections.ts";
import type { Command } from "../src/world/commands.ts";
import type { GameState } from "../src/state/types.ts";

/** Records the narrator-role user prompt of every stream, delegating to offline (npc-lore.test.ts). */
class RecordingGateway implements LlmGateway {
  readonly narratorPrompts: string[] = [];
  private readonly inner = new OfflineGateway();
  complete(role: LlmRole, req: CompletionRequest) {
    return this.inner.complete(role, req);
  }
  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (role === "narrator") {
      const user = [...req.messages].reverse().find((m: ChatMessage) => m.role === "user");
      if (user) this.narratorPrompts.push(user.content);
    }
    yield* this.inner.stream(role, req);
  }
  embed(role: LlmRole, texts: string[]) {
    return this.inner.embed(role, texts);
  }
}

const CASE_ID = "case.the-pawnbroker";

function casefileDir(): string {
  return fileURLToPath(new URL("fixtures/worlds/casefile", import.meta.url));
}
function casefile(): Promise<PlaySet> {
  return loadPlaySetFromDir(casefileDir());
}

async function casefileModel(): Promise<{ playset: PlaySet; model: WorldModel; engine: GameEngine }> {
  const playset = await casefile();
  const engine = new GameEngine({
    classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(7),
  });
  await engine.start();
  const model = fromGameState(engine.getState(), playset.world, playset.campaign);
  return { playset, model, engine };
}

function theCase(playset: PlaySet): Case {
  return playset.campaign.cases.find((c) => c.id === CASE_ID)!;
}

describe("case solvability (pure content invariant)", () => {
  test("the authored casefile case is solvable by construction", async () => {
    const playset = await casefile();
    expect(checkCaseSolvability(theCase(playset))).toEqual([]);
  });

  test("an unreachable core fact is caught", async () => {
    const playset = await casefile();
    const c = structuredClone(theCase(playset));
    c.clues = c.clues.filter((cl) => cl.id !== "clue.ledger"); // ledger now surfaced by no clue…
    c.npcKnowledge = {}; // …and no NPC knows anything
    const problems = checkCaseSolvability(c);
    expect(problems.some((p) => p.includes("fact.ledger") && p.includes("unreachable"))).toBe(true);
  });

  test("a single NPC who knows every required fact breaks collaboration-by-construction", async () => {
    const playset = await casefile();
    const c = structuredClone(theCase(playset));
    c.npcKnowledge["npc.reeve"] = { knows: ["fact.wound", "fact.ledger", "fact.seen"], believes: [], asserts: [] };
    expect(checkCaseSolvability(c).some((p) => p.includes("npc.reeve") && p.includes("no collaboration"))).toBe(true);
  });

  test("a culprit who knows every required fact is rejected", async () => {
    const playset = await casefile();
    const c = structuredClone(theCase(playset));
    c.npcKnowledge["npc.culprit"] = { knows: ["fact.wound", "fact.ledger", "fact.seen"], believes: [], asserts: [] };
    expect(checkCaseSolvability(c).some((p) => p.includes("culprit") && p.includes("must lack"))).toBe(true);
  });

  test("a herring with no refuter is rejected", async () => {
    const playset = await casefile();
    const c = structuredClone(theCase(playset));
    c.redHerrings[0]!.refutedBy = [];
    expect(checkCaseSolvability(c).some((p) => p.includes("herring.rival") && p.includes("no refuter"))).toBe(true);
  });
});

describe("loader cross-validation", () => {
  test("the casefile loads clean (solvability + clue-manifest ↔ effects both pass)", async () => {
    await expect(casefile()).resolves.toBeTruthy();
  });

  test("a clue whose fact no effect surfaces fails the loader", async () => {
    const raw = await loadRawPlaySetFromDir(casefileDir());
    // Break the manifest backing: drop the shop-search event that reveals fact.ledger.
    raw.campaign.events = raw.campaign.events.filter((e) => e.id !== "ev.shop-search");
    expect(() => compileAndValidatePlaySet(raw)).toThrow(/clue "clue.ledger".*no revealCaseFact effect/);
  });

  test("a case pointing at an unknown quest fails the loader", async () => {
    const raw = await loadRawPlaySetFromDir(casefileDir());
    raw.campaign.cases[0]!.questId = "quest.does-not-exist";
    expect(() => compileAndValidatePlaySet(raw)).toThrow(/unknown quest/);
  });
});

describe("reducer — the case command family", () => {
  test("revealCaseFact adds to playerKnown and every present witness learns it (idempotent)", async () => {
    const { model } = await casefileModel();
    const cmd: Command = {
      type: "revealCaseFact",
      caseId: CASE_ID,
      factId: "fact.wound",
      factText: "struck from behind",
      witnesses: ["npc.reeve"],
    };
    const first = applyCommand(model, cmd);
    expect(first.mutated).toBe(true);
    const rt = readCasesSlice(model.modules)[CASE_ID]!;
    expect(rt.playerKnown).toEqual(["fact.wound"]);
    expect(rt.npcState["npc.reeve"]!.learned).toEqual(["fact.wound"]);
    // Re-applying the same reveal is a no-op (already known, witness already learned).
    expect(applyCommand(model, cmd).mutated).toBe(false);
  });

  test("credibility clamps to the band and adjust-by-zero is a no-op", async () => {
    const { model } = await casefileModel();
    applyCommand(model, { type: "adjustCaseCredibility", caseId: CASE_ID, npcId: "npc.culprit", by: -100 });
    expect(readCasesSlice(model.modules)[CASE_ID]!.npcState["npc.culprit"]!.credibility).toBe(CREDIBILITY_MIN);
    applyCommand(model, { type: "adjustCaseCredibility", caseId: CASE_ID, npcId: "npc.culprit", by: 100 });
    expect(readCasesSlice(model.modules)[CASE_ID]!.npcState["npc.culprit"]!.credibility).toBe(CREDIBILITY_MAX);
    expect(applyCommand(model, { type: "adjustCaseCredibility", caseId: CASE_ID, npcId: "npc.culprit", by: 0 }).mutated).toBe(false);
  });

  test("the claim ledger is bounded at the cap", async () => {
    const { model } = await casefileModel();
    for (let i = 0; i < CLAIMS_CAP + 5; i++) {
      applyCommand(model, {
        type: "recordCaseClaim",
        caseId: CASE_ID,
        claim: { npcId: "npc.reeve", factId: `fact.${i}`, stance: "assert", caught: false, clock: i },
      });
    }
    const claims = readCasesSlice(model.modules)[CASE_ID]!.claims;
    expect(claims.length).toBe(CLAIMS_CAP);
    // Oldest dropped, newest kept.
    expect(claims[claims.length - 1]!.factId).toBe(`fact.${CLAIMS_CAP + 4}`);
  });

  test("resolveCase flips status once; recordWrongAccusation counts up", async () => {
    const { model } = await casefileModel();
    expect(applyCommand(model, { type: "resolveCase", caseId: CASE_ID, status: "solved" }).mutated).toBe(true);
    expect(readCasesSlice(model.modules)[CASE_ID]!.status).toBe("solved");
    expect(applyCommand(model, { type: "resolveCase", caseId: CASE_ID, status: "solved" }).mutated).toBe(false);
    applyCommand(model, { type: "recordWrongAccusation", caseId: CASE_ID });
    applyCommand(model, { type: "recordWrongAccusation", caseId: CASE_ID });
    expect(readCasesSlice(model.modules)[CASE_ID]!.wrongAccusations).toBe(2);
  });

  test("snapshot == fold(deltas) over a scripted case session (the replay invariant)", async () => {
    const { model } = await casefileModel();
    const script: Command[] = [
      { type: "revealCaseFact", caseId: CASE_ID, factId: "fact.wound", factText: "struck from behind", witnesses: ["npc.reeve"] },
      { type: "npcLearnCaseFact", caseId: CASE_ID, npcId: "npc.witness", factId: "fact.seen" },
      { type: "npcDropCaseBelief", caseId: CASE_ID, npcId: "npc.reeve", beliefId: "herring.rival" },
      { type: "markCaseFactShared", caseId: CASE_ID, npcId: "npc.witness", factId: "fact.seen" },
      { type: "recordCaseClaim", caseId: CASE_ID, claim: { npcId: "npc.culprit", factId: "fact.ledger", stance: "contradict", caught: true, clock: 12 } },
      { type: "adjustCaseCredibility", caseId: CASE_ID, npcId: "npc.culprit", by: -2 },
      { type: "recordWrongAccusation", caseId: CASE_ID },
      // r5: a hold-out written, then cleared by a later disclosure to the same NPC.
      { type: "recordCaseWithhold", caseId: CASE_ID, npcId: "npc.reeve", factIds: ["fact.ledger"] },
      { type: "npcLearnCaseFact", caseId: CASE_ID, npcId: "npc.reeve", factId: "fact.ledger" },
      { type: "resolveCase", caseId: CASE_ID, status: "solved" },
    ];
    const folded = { modules: {}, entities: new Map() } as unknown as WorldModel;
    for (const cmd of script) {
      const res = applyCommand(model, cmd);
      for (const d of res.deltas) applyDelta(folded, d as DeltaEvent);
    }
    expect(readCasesSlice(folded.modules)[CASE_ID]).toEqual(readCasesSlice(model.modules)[CASE_ID]!);
  });
});

describe("engine → brief surfaces", () => {
  test("entering the shop surfaces the wound (event) and ledger (check→reveal) into playerKnown", async () => {
    const { engine } = await casefileModel();
    await engine.submitPlayerInput("go to the pawnshop");
    const rt = readCasesSlice(engine.getState().modules ?? {})[CASE_ID]!;
    expect(rt.playerKnown).toContain("fact.wound");
    expect(rt.playerKnown).toContain("fact.ledger"); // the DC -50 check always passes → reveal fires
  });

  test("the GM brief shows the # CASE block of known facts but never the solution; gmLore holds the truth", async () => {
    const { engine, playset } = await casefileModel();
    await engine.submitPlayerInput("go to the pawnshop");
    const ctx = buildNarrationContext({
      world: playset.world,
      campaign: playset.campaign,
      state: engine.getState(),
      recentEvents: [],
      trigger: "You study the room.",
    });
    expect(ctx.contextText).toContain("# CASE — The Pawnbroker's Death");
    expect(ctx.contextText).toContain("struck once from behind"); // an established, player-known fact
    // The solution never reaches the shared brief…
    expect(ctx.contextText).not.toContain("walked out into the dusk");
    expect(ctx.contextText).not.toContain("CASE SOLUTION");
    // …but it IS on the private gmLore channel for the narrator's own consistency.
    expect(ctx.gmLore?.some((l) => l.includes("CASE SOLUTION") && l.includes("npc.culprit"))).toBe(true);
  });
});

describe("per-NPC case file (code-owned belief injection)", () => {
  test("a knower renders facts as certainties with a 'not yet told' nudge", async () => {
    const playset = await casefile();
    const lines = renderCaseFileForNpc(theCase(playset), undefined, "npc.reeve").join("\n");
    expect(lines).toContain("You are certain: The broker was struck once from behind");
    expect(lines).toContain("you have NOT yet told the party this");
    // A believed herring is rendered IDENTICALLY to a fact (the NPC can't tell it's false).
    expect(lines).toContain("You are certain: A rival pawnbroker two streets over");
  });

  test("the culprit gets the truth + a concealment directive + the herring they knowingly push", async () => {
    const playset = await casefile();
    const lines = renderCaseFileForNpc(theCase(playset), undefined, "npc.culprit").join("\n");
    expect(lines).toContain("YOU did this");
    expect(lines).toContain("CONCEAL it");
    expect(lines).toContain("Steer suspicion toward this");
    // The culprit does NOT hold the evidence facts they never learned.
    expect(lines).not.toContain("struck once from behind");
  });

  test("a distrust rail joins once credibility falls to the threshold", async () => {
    const playset = await casefile();
    const runtime = defaultCaseRuntime();
    runtime.npcState["npc.witness"] = {
      learned: [], dropped: [], toldPlayer: [], credibility: -2, lastShareClock: -1_000_000,
    };
    const lines = renderCaseFileForNpc(theCase(playset), runtime, "npc.witness").join("\n");
    expect(lines).toContain("weigh their claims with open suspicion");
  });

  test("an NPC with no stake in the case renders nothing", async () => {
    const playset = await casefile();
    expect(renderCaseFileForNpc(theCase(playset), undefined, "npc.nobody")).toEqual([]);
  });

  test("caseBriefForNpc surfaces only cases whose quest is active", async () => {
    const { engine, playset } = await casefileModel();
    const state = engine.getState();
    expect(caseBriefForNpc(playset.campaign, state, "npc.reeve").length).toBeGreaterThan(0);
    // Flip the quest off active → the NPC's case file goes silent.
    const closed = { ...state, quests: { ...state.quests, "quest.the-pawnbroker": "complete" as const } };
    expect(caseBriefForNpc(playset.campaign, closed, "npc.reeve")).toEqual([]);
  });
});

describe("NpcAgent — # THE CASE AS YOU KNOW IT injection", () => {
  const template = NpcTemplateSchema.parse({ id: "npc.x", name: "Xenia", persona: "Terse." });

  test("reply renders the block before # DIRECT ADDRESS when a case file is supplied; omits it otherwise", async () => {
    const gw = new RecordingGateway();
    const agent = new NpcAgent(gw, template);
    await agent.reply({} as never, {
      contextText: "# WORLD\nsummary",
      playerLine: "what do you make of it?",
      fromName: "You",
      caseFile: ['In the matter of "X":', "- You are certain: the lock was forced."],
    });
    const prompt = gw.narratorPrompts.at(-1) ?? "";
    expect(prompt).toContain("# THE CASE AS YOU KNOW IT");
    expect(prompt).toContain("the lock was forced");
    expect(prompt.indexOf("# THE CASE AS YOU KNOW IT")).toBeLessThan(prompt.indexOf(BRIEF_MARKERS.directAddress));

    gw.narratorPrompts.length = 0;
    await agent.reply({} as never, { contextText: "# WORLD\nsummary", playerLine: "hi", fromName: "You" });
    expect(gw.narratorPrompts.at(-1) ?? "").not.toContain("# THE CASE AS YOU KNOW IT");
  });

  test("decideTurn also carries the block (the autonomous path is no longer case-blind)", async () => {
    const gw = new RecordingGateway();
    const agent = new NpcAgent(gw, template);
    await agent.decideTurn({} as never, {
      contextText: "# WORLD\nsummary",
      stimulus: "You have a moment.",
      replyDepth: 0,
      caseFile: ["- You are certain: the debt was overdue."],
    });
    expect(gw.narratorPrompts.at(-1) ?? "").toContain("# THE CASE AS YOU KNOW IT");
  });
});

describe("CasesModule — a witnessed reveal overturns a believed herring", () => {
  function fakeCtx(model: WorldModel, queue: Command[]) {
    const enqueued: Command[] = [];
    const data: Record<string, unknown> = {};
    const ctx = {
      trigger: { kind: "player", input: "look" },
      model,
      services: {},
      recent: [],
      data,
      queue,
      enqueue: (c: Command) => enqueued.push(c),
      apply: () => {},
      applySilent: () => {},
      emit: () => {},
      state: () => toGameState(model),
    } as unknown as TickContext;
    return { ctx, enqueued, data };
  }

  test("revealing the ledger in front of the believing reeve drops her belief; the asserting culprit is untouched", async () => {
    const { model, playset } = await casefileModel(); // party at loc.commons, reeve + culprit present
    const reveal: Command = { type: "revealCaseFact", caseId: CASE_ID, factId: "fact.ledger", factText: "", witnesses: [] };
    const { ctx, enqueued, data } = fakeCtx(model, [reveal]);
    new CasesModule(playset.campaign).phases.react?.(ctx);
    expect(enqueued.some((c) => c.type === "npcDropCaseBelief" && c.npcId === "npc.reeve" && c.beliefId === "herring.rival")).toBe(true);
    // The culprit merely ASSERTS the herring (does not believe it) — nothing to overturn.
    expect(enqueued.some((c) => c.type === "npcDropCaseBelief" && c.npcId === "npc.culprit")).toBe(false);
    // A GM weave note was queued for the narrator.
    expect((data.eventBeats as string[]).some((b) => b.includes("certainty falters"))).toBe(true);
  });

  test("a non-refuting reveal changes no beliefs", async () => {
    const { model, playset } = await casefileModel();
    const reveal: Command = { type: "revealCaseFact", caseId: CASE_ID, factId: "fact.threat", factText: "", witnesses: [] };
    const { ctx, enqueued } = fakeCtx(model, [reveal]);
    new CasesModule(playset.campaign).phases.react?.(ctx);
    expect(enqueued.some((c) => c.type === "npcDropCaseBelief")).toBe(false);
  });
});

describe("CaseTestimonyModule — an NPC's own words reach the ledger (r5 P1)", () => {
  /** A matcher stub: answers with whatever fact ids it is told to, ignoring the prompt. */
  class MatcherGateway implements LlmGateway {
    readonly prompts: string[] = [];
    private readonly inner = new OfflineGateway();
    constructor(private readonly factIds: string[]) {}
    complete(role: LlmRole, req: CompletionRequest) {
      if (role === "utility" && req.json === true) {
        const user = [...req.messages].reverse().find((m: ChatMessage) => m.role === "user");
        if (user?.content.startsWith("SPEAKER:")) {
          this.prompts.push(user.content);
          return Promise.resolve({ text: JSON.stringify({ factIds: this.factIds }), model: "stub" });
        }
      }
      return this.inner.complete(role, req);
    }
    async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
      yield* this.inner.stream(role, req);
    }
    embed(role: LlmRole, texts: string[]) {
      return this.inner.embed(role, texts);
    }
  }

  function speakingCtx(model: WorldModel, actorId: string, line: string) {
    const enqueued: Command[] = [];
    const data: Record<string, unknown> = {
      turnOutcome: { npc: [{ actorId, name: "Corin", dialogue: line }] },
    };
    const emitted: { kind: string; summary?: string }[] = [];
    const ctx = {
      trigger: { kind: "player", input: "press him" },
      model,
      services: {},
      recent: [],
      data,
      queue: [],
      enqueue: (c: Command) => enqueued.push(c),
      apply: () => {},
      applySilent: () => {},
      emit: (e: { kind: string; summary?: string }) => void emitted.push(e),
      state: () => toGameState(model),
    } as unknown as TickContext;
    return { ctx, enqueued, data, emitted };
  }

  test("a present speaker who states a fact HE knows puts it into playerKnown", async () => {
    const { model, playset } = await casefileModel(); // party at loc.commons: the reeve and the culprit
    const gw = new MatcherGateway(["fact.threat"]);
    const { ctx, enqueued, emitted } = speakingCtx(
      model,
      "npc.culprit",
      "All right — I cursed his name over my cups, more nights than one. That is no crime.",
    );
    await new CaseTestimonyModule(playset.campaign, gw).phases.narrate!(ctx);

    const reveal = enqueued.find((c) => c.type === "revealCaseFact");
    expect(reveal).toMatchObject({ caseId: CASE_ID, factId: "fact.threat" });
    // And the speaker is marked as having told it, so the Director never re-offers the same fact
    // (half of what made the r5 scene re-stage a beat the player had already won).
    expect(enqueued.some((c) => c.type === "markCaseFactShared" && c.factId === "fact.threat")).toBe(true);
    // The player SEES the ledger move — r5's panel was the only source of truth and it was silent.
    expect(emitted.some((e) => e.kind === "stateChanged" && e.summary?.includes("Noted against"))).toBe(true);
    // The matcher was handed a CLOSED list — only facts this speaker actually holds.
    expect(gw.prompts[0]).toContain("- fact.threat:");
    expect(gw.prompts[0]).not.toContain("- fact.ledger:");
  });

  test("the model can never mint a fact the speaker does not hold", async () => {
    const { model, playset } = await casefileModel();
    // The matcher answers with a real fact id that this NPC does NOT know, and an invented one.
    const gw = new MatcherGateway(["fact.ledger", "fact.invented"]);
    const { ctx, enqueued } = speakingCtx(
      model,
      "npc.culprit",
      "The ledger? I never had the reading of it, but they say the debt was large.",
    );
    await new CaseTestimonyModule(playset.campaign, gw).phases.narrate!(ctx);
    expect(enqueued).toHaveLength(0);
  });

  test("no model call at all when the speaker holds nothing the player still needs", async () => {
    const { model, playset } = await casefileModel();
    const gw = new MatcherGateway(["fact.seen"]);
    // The reeve knows only fact.wound; reveal it first so she has nothing left to give.
    applyCommand(model, {
      type: "revealCaseFact",
      caseId: CASE_ID,
      factId: "fact.wound",
      factText: "",
      witnesses: [],
    });
    const { ctx, enqueued } = speakingCtx(
      model,
      "npc.reeve",
      "Struck from behind, and not a thing out of place in the room.",
    );
    await new CaseTestimonyModule(playset.campaign, gw).phases.narrate!(ctx);
    expect(gw.prompts).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe("player surface — classifier grounding + accusation verdict", () => {
  function baseCtx(): ClassifierContext {
    return {
      playerActorId: "pc.you",
      locationId: "loc.commons",
      locationName: "The Commons",
      exits: [],
      presentEntities: [{ id: "npc.culprit", name: "Hedwyn" }],
      companionIds: [],
      activeCase: {
        caseId: CASE_ID,
        suspects: [{ id: "npc.culprit", name: "Hedwyn" }],
        knownFacts: [{ id: "fact.wound", name: "struck from behind" }],
      },
    };
  }

  test("reconcilePlan grounds a caseAction — suspect + known facts kept, unknown facts dropped, caseId filled", () => {
    const raw = {
      kind: "caseAction",
      check: { warranted: false },
      case: { verb: "accuse", suspectId: "npc.culprit", factIds: ["fact.wound", "fact.made-up"] },
    };
    const plan = reconcilePlan(raw, baseCtx());
    expect(plan.kind).toBe("caseAction");
    expect(plan.case?.suspectId).toBe("npc.culprit");
    expect(plan.case?.factIds).toEqual(["fact.wound"]);
    expect(plan.case?.caseId).toBe(CASE_ID);
  });

  test("reconcilePlan degrades a caseAction with an ungroundable suspect to freeform", () => {
    const raw = { kind: "caseAction", check: { warranted: false }, case: { verb: "accuse", suspectId: "npc.ghost", factIds: [] } };
    expect(reconcilePlan(raw, baseCtx()).kind).toBe("freeformNarrative");
  });

  // A classifier that reads structured "ACCUSE <id>" / "PRESENT <id> <factIds…>" test inputs and
  // delegates everything else (movement etc.) to the frozen heuristic DSL — the sanctioned way to
  // drive a new intent in engine tests without growing test-classifier.ts.
  function caseClassifier(): TurnClassifier {
    return {
      classify: async (input, ctx) => {
        const m = input.match(/^(ACCUSE|PRESENT)\s+(\S+)(?:\s+(.+))?$/);
        if (m) {
          const verb = m[1] === "ACCUSE" ? ("accuse" as const) : ("present" as const);
          const factIds = m[3] ? m[3].split(/\s+/) : [];
          return {
            kind: "caseAction",
            targetId: null,
            destinationLocationId: null,
            check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
            case: { verb, suspectId: m[2]!, factIds, caseId: CASE_ID },
            confidence: 1,
          } satisfies TurnPlan;
        }
        return heuristicClassifier.classify(input, ctx);
      },
    };
  }

  async function caseEngine() {
    const playset = await casefile();
    const engine = new GameEngine({
      classifier: caseClassifier(),
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(7),
    });
    await engine.start();
    return { engine, playset };
  }

  const runtime = (engine: GameEngine) => readCasesSlice(engine.getState().modules ?? {})[CASE_ID]!;

  test("a correct, PROVEN accusation solves the case and completes the quest", async () => {
    const { engine } = await caseEngine();
    await engine.submitPlayerInput("go to the pawnshop"); // fact.wound + fact.ledger
    await engine.submitPlayerInput("go to the commons");
    await engine.submitPlayerInput("go to the tavern"); // fact.seen
    await engine.submitPlayerInput("go to the commons"); // Hedwyn is here
    expect(runtime(engine).playerKnown).toEqual(expect.arrayContaining(["fact.wound", "fact.ledger", "fact.seen"]));

    await engine.submitPlayerInput("ACCUSE npc.culprit");
    expect(runtime(engine).status).toBe("solved");
    expect(engine.getState().quests["quest.the-pawnbroker"]).toBe("complete");
  });

  test("a correct but UNPROVEN accusation is refused; the case stays open", async () => {
    const { engine } = await caseEngine();
    await engine.submitPlayerInput("go to the pawnshop"); // only wound + ledger (not seen)
    await engine.submitPlayerInput("go to the commons");
    await engine.submitPlayerInput("ACCUSE npc.culprit");
    expect(runtime(engine).status).toBe("open");
    expect(engine.getState().quests["quest.the-pawnbroker"]).toBe("active");
  });

  test("wrong accusations burn the budget and fail the case when it is exhausted", async () => {
    const { engine } = await caseEngine();
    await engine.submitPlayerInput("ACCUSE npc.reeve"); // wrong (1/3)
    await engine.submitPlayerInput("ACCUSE npc.reeve"); // wrong (2/3)
    expect(runtime(engine).status).toBe("open");
    expect(runtime(engine).wrongAccusations).toBe(2);
    await engine.submitPlayerInput("ACCUSE npc.reeve"); // wrong (3/3) → budget exhausted
    expect(runtime(engine).wrongAccusations).toBe(3);
    expect(runtime(engine).status).toBe("failed");
    expect(engine.getState().quests["quest.the-pawnbroker"]).toBe("failed");
  });

  test("presenting a refuting fact makes the NPC learn it and drops the herring they believed", async () => {
    const { engine } = await caseEngine();
    await engine.submitPlayerInput("go to the pawnshop"); // learn fact.ledger
    await engine.submitPlayerInput("go to the commons"); // Reeve Alda is here (believes herring.rival)
    await engine.submitPlayerInput("PRESENT npc.reeve fact.ledger");
    const npc = runtime(engine).npcState["npc.reeve"]!;
    expect(npc.learned).toContain("fact.ledger");
    expect(npc.dropped).toContain("herring.rival"); // refuted by fact.ledger, overturned on presentation
  });
});

describe("planCaseShare — the Director proactive-share pick (pure)", () => {
  function withCaseRuntime(state: GameState, runtime: ReturnType<typeof defaultCaseRuntime>): GameState {
    return { ...state, modules: { ...state.modules, cases: { [CASE_ID]: runtime } } };
  }

  test("an NPC volunteers a core fact the party hasn't heard; nothing shareable ⇒ null", async () => {
    const { playset, engine } = await casefileModel();
    const state = engine.getState(); // quest active, no reveals yet
    // Reeve knows the (core) wound and hasn't told anyone ⇒ shares it.
    const share = planCaseShare(playset.campaign, state, "npc.reeve", 10_000);
    expect(share).toEqual({ caseId: CASE_ID, factId: "fact.wound", factText: expect.any(String) });
    // The player already knowing it ⇒ nothing left to volunteer.
    const known = withCaseRuntime(state, { ...defaultCaseRuntime(), playerKnown: ["fact.wound"] });
    expect(planCaseShare(playset.campaign, known, "npc.reeve", 10_000)).toBeNull();
    // Already told the party ⇒ nothing left either.
    const told = defaultCaseRuntime();
    told.npcState["npc.reeve"] = { learned: [], dropped: [], toldPlayer: ["fact.wound"], credibility: 0, lastShareClock: 0 };
    expect(planCaseShare(playset.campaign, withCaseRuntime(state, told), "npc.reeve", 10_000)).toBeNull();
  });

  test("the share cooldown gates re-volunteering, then clears", async () => {
    const { playset, engine } = await casefileModel();
    const state = engine.getState();
    const rt = defaultCaseRuntime();
    rt.npcState["npc.reeve"] = { learned: [], dropped: [], toldPlayer: [], credibility: 0, lastShareClock: 9_990 };
    const s = { ...state, modules: { ...state.modules, cases: { [CASE_ID]: rt } } };
    expect(planCaseShare(playset.campaign, s, "npc.reeve", 10_000)).toBeNull(); // 10 min < cooldown
    expect(planCaseShare(playset.campaign, s, "npc.reeve", 9_990 + SHARE_COOLDOWN_MINUTES)?.factId).toBe("fact.wound");
  });

  test("priority: a core fact wins over a plain one; a herring-refuter wins when no core is left", async () => {
    const { playset, engine } = await casefileModel();
    const state = engine.getState();
    // Core beats a non-core first-listed fact (threat is non-core and listed first).
    const core = structuredClone(playset.campaign);
    core.cases[0]!.npcKnowledge["npc.reeve"] = { knows: ["fact.threat", "fact.wound"], believes: [], asserts: [] };
    expect(planCaseShare(core, state, "npc.reeve", 10_000)?.factId).toBe("fact.wound");
    // With no core in reach, the refuter (fact.ledger overturns herring.rival) beats the first fact.
    const ref = structuredClone(playset.campaign);
    ref.cases[0]!.facts.find((f) => f.id === "fact.ledger")!.core = false;
    ref.cases[0]!.npcKnowledge["npc.reeve"] = { knows: ["fact.threat", "fact.ledger"], believes: [], asserts: [] };
    expect(planCaseShare(ref, state, "npc.reeve", 10_000)?.factId).toBe("fact.ledger");
  });
});

describe("classifyCaseClaim — the lie/credibility verdict (pure)", () => {
  test("assert always teaches; contradict is caught only against a fact the NPC knows", async () => {
    const c = theCase(await casefile());
    expect(classifyCaseClaim(c, undefined, "npc.reeve", "assert", "fact.ledger")).toBe("learn");
    // Reeve KNOWS the wound ⇒ denying it is a caught lie.
    expect(classifyCaseClaim(c, undefined, "npc.reeve", "contradict", "fact.wound")).toBe("caught");
    // The witness does NOT know the wound ⇒ the denial is a harmless (unprovable) noop.
    expect(classifyCaseClaim(c, undefined, "npc.witness", "contradict", "fact.wound")).toBe("noop");
    // r5: refusing is neither a share nor a lie — its own verdict.
    expect(classifyCaseClaim(c, undefined, "npc.reeve", "withhold", "fact.ledger")).toBe("withheld");
  });
});

describe("withholding — the rail, the reciprocity, and the doubled full stop (r4 P2)", () => {
  const held = (npcId: string, ids: string[]): CaseRuntime => ({
    ...defaultCaseRuntime(),
    npcState: { [npcId]: { ...defaultNpcCaseState(), withheld: ids } },
  });

  test("the NPC-facing rail states the COUNT and never the fact text", async () => {
    const c = theCase(await casefile());
    const lines = renderCaseFileForNpc(c, held("npc.reeve", ["fact.ledger"]), "npc.reeve").join("\n");
    expect(lines).toContain("refused to show you");
    // The whole point of a refusal: they do not learn what was withheld.
    expect(lines).not.toContain("ledger of pawned goods");
  });

  test("a stakeless NPC is not railed into a case they know nothing about", async () => {
    const c = theCase(await casefile());
    expect(renderCaseFileForNpc(c, held("npc.nobody", ["fact.ledger"]), "npc.nobody")).toEqual([]);
  });

  test("an NPC you stonewall stops volunteering, and resumes once you show them something", async () => {
    const playset = await casefile();
    const c = theCase(playset);
    const base = {
      quests: { [c.questId]: "active" },
      modules: { cases: { [CASE_ID]: defaultCaseRuntime() } },
    } as unknown as GameState;
    expect(planCaseShare(playset.campaign, base, "npc.reeve", 10_000)).not.toBeNull();
    const stonewalled = {
      ...base,
      modules: { cases: { [CASE_ID]: held("npc.reeve", ["fact.ledger"]) } },
    } as unknown as GameState;
    expect(planCaseShare(playset.campaign, stonewalled, "npc.reeve", 10_000)).toBeNull();
  });

  test("joinFactTexts never yields a doubled full stop", () => {
    const joined = joinFactTexts(["The bond was signed twice.", "He died over it."]);
    expect(joined).toBe("The bond was signed twice; He died over it");
    expect(`${joined}.`).not.toContain("..");
    expect(joinFactTexts([])).toBe("");
  });

  // Regex audit §8g. The strip class was `[.;,!?…"')\s]+` — greedy, so it ate the CLOSING mark
  // along with the stop and stranded the opener. Both reproduced against the shipped function:
  //   `The note read "burn it".` → `The note read "burn it`
  //   `He signed it (twice).`    → `He signed it (twice`
  // Facts are quoted verbatim into the GM's `# CASE` block and an NPC's case file, so an unclosed
  // quote is a grounding hazard, not a cosmetic one.
  test("a MATCHED closing quote or bracket survives the terminal-punctuation strip", () => {
    expect(joinFactTexts(['The note read "burn it".'])).toBe('The note read "burn it"');
    expect(joinFactTexts(["He signed it (twice)."])).toBe("He signed it (twice)");
    expect(joinFactTexts(["She said 'run'."])).toBe("She said 'run'");
    // The possessive that makes a global quote-balance count useless: the closing " must stay.
    expect(joinFactTexts(['The reeve\'s men said "go".'])).toBe('The reeve\'s men said "go"');
    // A stop tucked INSIDE a matched quote still goes — the caller's period is the only one.
    expect(joinFactTexts(['He said "he died over it."'])).toBe('He said "he died over it"');
  });

  test("a STRAY closer (no opener anywhere) is still dropped as noise", () => {
    expect(joinFactTexts(["He died over it)"])).toBe("He died over it");
  });

  test("a domain-specific fact text is unchanged but for its stop", () => {
    expect(
      joinFactTexts([
        "Pettifer was strangled from behind with a weighted lead-cord — a caravan guide's tool, not a footpad's knife.",
      ]),
    ).toBe("Pettifer was strangled from behind with a weighted lead-cord — a caravan guide's tool, not a footpad's knife");
  });
});

describe("casesOf — the read-only case projection", () => {
  test("an engaged case surfaces the player's known facts + persons of interest; hidden stays off the board", async () => {
    const { engine, playset } = await casefileModel();
    await engine.submitPlayerInput("go to the pawnshop"); // reveals fact.wound + fact.ledger
    const cases = casesOf(playset, engine.getState());
    expect(cases.length).toBe(1);
    expect(cases[0]!.id).toBe(CASE_ID);
    expect(cases[0]!.state).toBe("open");
    expect(cases[0]!.knownFacts.map((f) => f.id)).toEqual(expect.arrayContaining(["fact.wound", "fact.ledger"]));
    expect(cases[0]!.knownFacts.find((f) => f.id === "fact.wound")).toMatchObject({ kind: "physical", core: true });
    // The whole case cast (culprit among them, never marked as such) resolves to names.
    expect(cases[0]!.suspects.map((s) => s.id)).toEqual(expect.arrayContaining(["npc.reeve", "npc.witness", "npc.culprit"]));
    expect(cases[0]!.maxWrongAccusations).toBe(3);
    // A hidden case never appears (no spoiler that a mystery even exists).
    const hidden = { ...engine.getState(), quests: { ...engine.getState().quests, "quest.the-pawnbroker": "hidden" as const } };
    expect(casesOf(playset, hidden)).toEqual([]);
  });
});

describe("engine — caseClaims side-channel (lie/credibility ledger on a dialogue line)", () => {
  function claimClassifier(): TurnClassifier {
    return {
      classify: async (input, ctx) => {
        const m = input.match(/^CLAIM\s+(\S+)\s+(assert|contradict|withhold)\s+(\S+)$/);
        if (m) {
          return {
            kind: "dialogueToNpc",
            targetId: m[1]!,
            destinationLocationId: null,
            check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
            caseClaims: [{ factId: m[3]!, stance: m[2] as "assert" | "contradict" | "withhold", caseId: CASE_ID }],
            confidence: 1,
          } satisfies TurnPlan;
        }
        return heuristicClassifier.classify(input, ctx);
      },
    };
  }
  async function claimEngine() {
    const playset = await casefile();
    const engine = new GameEngine({
      classifier: claimClassifier(),
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(7),
    });
    await engine.start();
    return { engine, playset };
  }
  const rt = (engine: GameEngine) => readCasesSlice(engine.getState().modules ?? {})[CASE_ID]!;

  test("a truthful assert in conversation teaches the NPC the fact and overturns the herring they believed", async () => {
    const { engine } = await claimEngine();
    await engine.submitPlayerInput("go to the pawnshop"); // learn fact.ledger
    await engine.submitPlayerInput("go to the commons"); // Reeve Alda present (believes herring.rival)
    await engine.submitPlayerInput("CLAIM npc.reeve assert fact.ledger");
    const npc = rt(engine).npcState["npc.reeve"]!;
    expect(npc.learned).toContain("fact.ledger");
    expect(npc.dropped).toContain("herring.rival");
    expect(rt(engine).claims.at(-1)).toMatchObject({ npcId: "npc.reeve", factId: "fact.ledger", caught: false });
  });

  test("a lie the NPC can see through is caught — credibility drops to the distrust threshold", async () => {
    const { engine } = await claimEngine();
    await engine.submitPlayerInput("go to the pawnshop"); // learn fact.wound
    await engine.submitPlayerInput("go to the commons"); // Reeve present, and she KNOWS the wound
    await engine.submitPlayerInput("CLAIM npc.reeve contradict fact.wound");
    expect(rt(engine).npcState["npc.reeve"]!.credibility).toBe(-2);
    expect(rt(engine).claims.at(-1)).toMatchObject({ stance: "contradict", caught: true });
  });

  // --- r4 P2: a refusal is a move, and it is recorded ---

  test("withholding records the hold-out, teaches the NPC NOTHING, and still gets them a reply", async () => {
    const { engine } = await claimEngine();
    const events: { kind: string }[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.submitPlayerInput("go to the pawnshop"); // learn fact.ledger
    await engine.submitPlayerInput("go to the commons");
    const before = events.length;
    await engine.submitPlayerInput("CLAIM npc.reeve withhold fact.ledger");
    const npc = rt(engine).npcState["npc.reeve"]!;
    expect(npc.withheld).toContain("fact.ledger");
    // The whole point: refusing never hands the fact over.
    expect(npc.learned).not.toContain("fact.ledger");
    // No credibility damage — credibility is the caught-LYING band, and refusing is honest.
    expect(npc.credibility).toBe(0);
    // The regression pin for "no reply from Lys": a withhold rides dialogueToNpc, so the NPC answers.
    expect(events.slice(before).some((e) => e.kind === "dialogue")).toBe(true);
  });

  test("stonewalling the same person twice costs nothing new", async () => {
    const { engine } = await claimEngine();
    await engine.submitPlayerInput("go to the pawnshop");
    await engine.submitPlayerInput("go to the commons");
    await engine.submitPlayerInput("CLAIM npc.reeve withhold fact.ledger");
    const first = rt(engine).npcState["npc.reeve"]!;
    await engine.submitPlayerInput("CLAIM npc.reeve withhold fact.ledger");
    const second = rt(engine).npcState["npc.reeve"]!;
    expect(second.withheld).toEqual(first.withheld!);
  });

  test("showing them anything later CLEARS the hold-out — a refusal is never permanent", async () => {
    const { engine } = await claimEngine();
    await engine.submitPlayerInput("go to the pawnshop");
    await engine.submitPlayerInput("go to the commons");
    await engine.submitPlayerInput("CLAIM npc.reeve withhold fact.ledger");
    expect(rt(engine).npcState["npc.reeve"]!.withheld).toContain("fact.ledger");
    await engine.submitPlayerInput("CLAIM npc.reeve assert fact.ledger");
    const npc = rt(engine).npcState["npc.reeve"]!;
    expect(npc.withheld ?? []).toEqual([]);
    expect(npc.learned).toContain("fact.ledger");
  });
});
