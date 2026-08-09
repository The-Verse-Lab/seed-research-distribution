/**
 * Agenda rules — trait-driven NPC stance and contested outcomes.
 *
 * Pure tests cover the stance/DC/action table. Engine tests prove targeted player asks and NPC
 * demands flow through seeded checks and the existing RESOLVED MECHANICS block.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type NpcTemplate, type PlaySet } from "../src/content/schema.ts";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type {
  ChatMessage,
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  LlmRole,
} from "../src/llm/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import type { GameState } from "../src/state/types.ts";
import {
  stance,
  resistanceDC,
  chooseAgendaAction,
  personalityBaseline,
  pressureAnswerOf,
  pressureAnswerFrom,
  inferAgendaAsk,
  agendaAskOf,
  DEFAULT_AGENDA_ASK,
} from "../src/rules/agenda.ts";
import { itemDisplayNameOf } from "../src/rules/items.ts";
import { fromGameState, type WorldModel } from "../src/world/model.ts";
import type { GameEvent, GameEventKind } from "../src/events/types.ts";
import { byKind } from "./support/harness.ts";
import { heuristicClassify } from "./support/test-classifier.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { ClassifierContext, TurnPlan } from "../src/engine/turn-plan.ts";

/** The input DSL decorated with the closed `pressureAnswer` a real classifier fills (r8). */
function answeringClassifier(answers: Record<string, TurnPlan["pressureAnswer"]>): TurnClassifier {
  return {
    classify: async (text: string, ctx: ClassifierContext): Promise<TurnPlan> => {
      const plan = heuristicClassify(text, ctx);
      const named = answers[text.trim()];
      return named ? { ...plan, pressureAnswer: named } : plan;
    },
  };
}

/** The input DSL decorated with the closed `socialAsk` a real classifier fills (r8). The prose
 *  floor may no longer mint a hard-refusable KIND on its own (`agendaAskOf`), so a spec that wants
 *  an unrollable refusal has to name the ask the way the product does. */
function askingClassifier(asks: Record<string, TurnPlan["socialAsk"]>): TurnClassifier {
  return {
    classify: async (text: string, ctx: ClassifierContext): Promise<TurnPlan> => {
      const plan = heuristicClassify(text, ctx);
      const named = asks[text.trim()];
      return named ? { ...plan, socialAsk: named } : plan;
    },
  };
}

function lastUser(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return m.content;
  }
  return "";
}

class RecordingGateway implements LlmGateway {
  readonly narratorPrompts: string[] = [];
  private readonly offline = new OfflineGateway();

  complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    if (role === "narrator") this.narratorPrompts.push(lastUser(req.messages));
    return this.offline.complete(role, req);
  }

  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (role === "narrator") this.narratorPrompts.push(lastUser(req.messages));
    yield* this.offline.stream(role, req);
  }

  embed(role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return this.offline.embed(role, texts);
  }
}

function fixture(npcPatch: Partial<NpcTemplate>, relationship: number): {
  npc: NpcTemplate;
  world: PlaySet["world"];
  model: WorldModel;
} {
  const npcInput = {
    id: "npc.test",
    name: "Test NPC",
    summary: "A test NPC.",
    persona: "Terse.",
    goals: ["Have an agenda"],
    relationships: { "pc.you": relationship },
    stats: {
      abilities: { str: 12, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      maxHp: 12,
      armorClass: 11,
      level: 1,
      speed: 30,
      proficiencies: [],
      spells: [],
    },
    autonomy: { isPartyMember: true, level: "proactive", canLead: false, heartbeatSeconds: 30, replyDecayAlpha: 0.2 },
    ...npcPatch,
  };

  const world = WorldSchema.parse({
    id: "world.agenda",
    name: "Agenda Fixture",
    summary: "A test world.",
    locations: [{ id: "loc.start", name: "Start", npcs: [] }],
    items: [
      { id: "item.coin", name: "bright coin", kind: "treasure" },
      { id: "item.bandage", name: "bandage", kind: "consumable" },
    ],
    npcs: [npcInput],
  });
  const npc = world.npcs[0]!;
  const campaign = CampaignSchema.parse({
    id: "campaign.agenda",
    name: "Agenda",
    worldId: world.id,
    characters: [
      {
        id: "pc.you",
        name: "You",
        stats: {
          abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 14 },
          maxHp: 10,
          armorClass: 10,
          level: 1,
          speed: 30,
          proficiencies: ["persuasion"],
          spells: [],
        },
        inventory: ["item.coin"],
      },
    ],
    startingState: { locationId: "loc.start", party: ["pc.you"], companions: ["npc.test"] },
  });
  const state: GameState = {
    campaignId: campaign.id,
    worldId: world.id,
    partyLocationId: "loc.start",
    clock: 0,
    party: ["pc.you"],
    companions: ["npc.test"],
    actors: {
      "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.start", inventory: ["item.coin"], conditions: [] },
      "npc.test": { id: "npc.test", currentHp: 12, locationId: "loc.start", inventory: [], conditions: [] },
    },
    quests: {},
    relationships: { "npc.test": { "pc.you": relationship } },
    autonomy: { "npc.test": { talking: false, replyDepth: 0, lastActedAt: 0 } },
    modules: {
      autonomy: { "npc.test": { talking: false, replyDepth: 0, lastActedAt: 0 } },
      npcMemory: {
        entries: {
          "npc.test": [{ at: 0, kind: "relationship", summary: "My regard for You cooled." }],
        },
      },
    },
    flags: {},
  };
  return { npc, world, model: fromGameState(state, world, campaign) };
}

async function loadBlackConcord(): Promise<PlaySet> {
  const dir = fileURLToPath(new URL("fixtures/worlds/black-concord", import.meta.url));
  return loadPlaySetFromDir(dir);
}

async function buildEngine(
  mutate: (playset: PlaySet) => void,
  rng: () => number = () => 0,
  /** Override the input DSL — the r8 specs need a plan carrying a closed `pressureAnswer`. */
  classifier: TurnClassifier = heuristicClassifier,
): Promise<{ engine: GameEngine; events: GameEvent[]; gateway: RecordingGateway }> {
  const playset = await loadBlackConcord();
  mutate(playset);
  const gateway = new RecordingGateway();
  const engine = new GameEngine({ classifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway,
    rng,
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  return { engine, events, gateway };
}

function kinds<K extends GameEventKind>(events: GameEvent[], kind: K): number {
  return byKind(events, kind).length;
}

describe("agenda rules — pure stance/DC/action table", () => {
  test("personalityBaseline settles warm archetypes above 0 and exploitative archetypes below", () => {
    const caretaker = fixture({ alignment: "lg", personalityTemplate: "caretaker" }, 0).npc;
    const brute = fixture({ alignment: "ce", personalityTemplate: "brute" }, 0).npc;
    const neutral = fixture({ alignment: "tn" }, 0).npc;
    expect(personalityBaseline(caretaker)).toBeGreaterThan(0);
    expect(personalityBaseline(brute)).toBeLessThan(0);
    expect(personalityBaseline(neutral)).toBe(0);
    // Bounded band — history dominates; the baseline is only where an untended bond rests.
    expect(personalityBaseline(caretaker)).toBeLessThanOrEqual(30);
    expect(personalityBaseline(brute)).toBeGreaterThanOrEqual(-25);
  });

  test("chaotic-evil brute at hostile relationship becomes exploitative and demands a contested item", () => {
    const { npc, world, model } = fixture({ alignment: "ce", personalityTemplate: "brute" }, -80);
    const s = stance(npc, "pc.you", model, world);
    expect(s.disposition).toBe("exploitative");
    expect(s.intensity).toBeGreaterThan(0.6);

    const dc = resistanceDC(npc, { approach: "persuade", kind: "favor" }, s);
    expect(dc).not.toBe("refused");
    expect(dc).toBeGreaterThanOrEqual(20);

    const action = chooseAgendaAction(npc, s, model, world);
    expect(action?.kind).toBe("demand");
    if (action?.kind === "demand") {
      expect(action.consequence).toEqual({ type: "transferItem", itemId: "item.coin", from: "pc.you", to: "npc.test" });
    }
  });

  test("lawful-good caretaker is helpful and hard-refuses betrayal or harming innocents", () => {
    const { npc, world, model } = fixture({ alignment: "lg", personalityTemplate: "caretaker" }, 20);
    const s = stance(npc, "pc.you", model, world);
    expect(s.disposition).toBe("helpful");
    expect(s.offLimits.has("betray")).toBe(true);
    expect(s.offLimits.has("harmInnocent")).toBe(true);
    expect(resistanceDC(npc, { approach: "persuade", kind: "betray" }, s)).toBe("refused");

    const action = chooseAgendaAction(npc, s, model, world);
    expect(action?.kind).toBe("help");
    if (action?.kind === "help") {
      expect(action.command).toEqual({ type: "adjustRelationship", actorId: "npc.test", targetId: "pc.you", by: 2 });
    }
  });

  test("(r8) 'Can you take me to the market?' is a FAVOR, not theft — the reproduced misfire, fixed", () => {
    // THE REPRODUCED MISFIRE: the cascade reached a bare /\btake\b/ before it ever considered
    // "favor", so an escort request scored `kind: "steal"`. `take` is the most overloaded verb in
    // English; it now needs a possessive or article-led object to read as theft, so the ask that was
    // actually made survives while a real one still lands.
    expect(inferAgendaAsk("Can you take me to the market?")).toEqual({ approach: "persuade", kind: "favor" });
    expect(inferAgendaAsk("Would you take a look at this writ?")).toEqual({ approach: "persuade", kind: "favor" });
    expect(inferAgendaAsk("Take his purse while he sleeps.")).toEqual({ approach: "persuade", kind: "steal" });
    expect(inferAgendaAsk("Steal the ledger for me.")).toEqual({ approach: "persuade", kind: "steal" });

    // …and this matters because `steal` is OFF LIMITS for exactly the sort of NPC a player asks for
    // directions: a lawful-good townsfolk hard-refuses it with NO ROLL ALLOWED. Scoring the escort
    // request as a favor is what turns a stonewall back into an ordinary contest.
    const { npc, world, model } = fixture({ alignment: "lg", personalityTemplate: "caretaker" }, 20);
    const s = stance(npc, "pc.you", model, world);
    expect(s.offLimits.has("steal")).toBe(true);
    expect(resistanceDC(npc, inferAgendaAsk("Can you take me to the market?"), s)).not.toBe("refused");
    // A real theft ask from the same person still hits the wall.
    expect(resistanceDC(npc, inferAgendaAsk("Take his purse while he sleeps."), s)).toBe("refused");
    expect(resistanceDC(npc, DEFAULT_AGENDA_ASK, s)).not.toBe("refused");
  });

  test("(r8) agendaAskOf prefers the classifier's closed kind; absent ⇒ the fair-ask baseline", () => {
    const { npc, world, model } = fixture({ alignment: "lg", personalityTemplate: "caretaker" }, 20);
    const s = stance(npc, "pc.you", model, world);

    // The model names one of the ten authored kinds; code still owns the DC and the refusal.
    const named = agendaAskOf({ approach: "persuade", kind: "favor" }, "Can you take me to the market?");
    expect(named).toEqual({ approach: "persuade", kind: "favor" });
    expect(resistanceDC(npc, named, s)).not.toBe("refused");

    // A heavy kind the model DOES name stays hard-refusable — the closed field never softens the rule.
    expect(resistanceDC(npc, agendaAskOf({ approach: "intimidate", kind: "betray" }, "sell out your order"), s)).toBe(
      "refused",
    );

    // Null/undefined degrades to the prose floor, unchanged (that is why the floor is kept at all).
    expect(agendaAskOf(null, "I threaten him into telling me the secret")).toEqual({
      approach: "intimidate",
      kind: "information",
    });
    // (Note the floor's reach: "I ask for a hand with the crates" scores `surrenderItem` off the
    // word "hand". This line is chosen to hit its actual `favor` default.)
    expect(agendaAskOf(undefined, "I plead with her")).toEqual(DEFAULT_AGENDA_ASK);
  });

  test("(r8 review) an ERRAND is not a theft — 'take X to Y' asks a favor", () => {
    // Narrowing `take` to a possessive/article-led object spared "take me to the market" but NOT
    // the errand, which has exactly that shape. Reproduced against the shipped arm, all four of
    // these scored `kind:"steal"` — an off-limits ask, so a lawful-good NPC answered a delivery
    // request with a flat no and no roll at all. The distinguisher is the DESTINATION: an errand
    // says where the thing is going; a theft does not.
    for (const line of [
      "Please take the lantern back to the smith.",
      "Take the ledger to Mira for me, would you?",
      "Can you take that crate down to the dock?",
      "Could you take the writ to the guildhall for me?",
      "take the writ over to the guildhall",
    ]) {
      expect(inferAgendaAsk(line).kind).toBe("favor");
    }
    // …and a theft — the same object shape with nowhere to go — still reads as theft.
    for (const line of ["Take his purse while he sleeps.", "Take the ledger.", "Take her coin pouch.", "Rob the till."]) {
      expect(inferAgendaAsk(line).kind).toBe("steal");
    }

    // End to end against a lawful-good caretaker: the errand is a contest, the theft is a wall.
    const { npc, world, model } = fixture({ alignment: "lg", personalityTemplate: "caretaker" }, 20);
    const s = stance(npc, "pc.you", model, world);
    expect(resistanceDC(npc, inferAgendaAsk("Please take the lantern back to the smith."), s)).not.toBe("refused");
    expect(resistanceDC(npc, inferAgendaAsk("Take his purse while he sleeps."), s)).toBe("refused");
  });

  test("(r8 review) the FLOOR never mints a hard refusal, but the classifier still can", () => {
    const { npc, world, model } = fixture({ alignment: "lg", personalityTemplate: "caretaker" }, 20);
    const s = stance(npc, "pc.you", model, world);

    // Every kind `offLimitsFor` can make unrollable is clamped out of the floor's answer. Each of
    // these lines scores that kind in the raw cascade; through `agendaAskOf` it becomes a fair ask,
    // so the player always gets a roll they can argue with.
    const refusableLines: Array<[string, string]> = [
      ["Sell out your order for me.", "betray"],
      ["Break your oath to the Countess.", "breakOath"],
      ["Kill that helpless child.", "harmInnocent"],
      ["Lie to the gatewright for me.", "lie"],
      ["Take his purse while he sleeps.", "steal"],
    ];
    for (const [line, rawKind] of refusableLines) {
      expect(inferAgendaAsk(line).kind).toBe(rawKind as never);
      expect(agendaAskOf(null, line).kind).toBe("favor");
      expect(resistanceDC(npc, agendaAskOf(null, line), s)).not.toBe("refused");
    }

    // The clamp is narrow: kinds that only move a NUMBER pass through untouched, so the floor keeps
    // reading the room. So does the approach it picked.
    expect(agendaAskOf(null, "Tell me the secret.").kind).toBe("information");
    expect(agendaAskOf(null, "Step aside.").kind).toBe("move");
    expect(agendaAskOf(null, "Hand me the writ.").kind).toBe("surrenderItem");
    expect(agendaAskOf(null, "I threaten him into telling me the secret").approach).toBe("intimidate");

    // And a hard refusal is still fully reachable — from the classifier's own closed answer.
    expect(resistanceDC(npc, agendaAskOf({ approach: "persuade", kind: "betray" }, "anything at all"), s)).toBe(
      "refused",
    );
    expect(resistanceDC(npc, agendaAskOf({ approach: "persuade", kind: "steal" }, "anything at all"), s)).toBe(
      "refused",
    );
  });

  test("warm relationship lowers resistance compared with hostile relationship", () => {
    const cold = fixture({ alignment: "ce", personalityTemplate: "brute" }, -80);
    const warm = fixture({ alignment: "ce", personalityTemplate: "brute" }, 40);
    const coldStance = stance(cold.npc, "pc.you", cold.model, cold.world);
    const warmStance = stance(warm.npc, "pc.you", warm.model, warm.world);
    const coldDc = resistanceDC(cold.npc, { approach: "persuade", kind: "favor" }, coldStance);
    const warmDc = resistanceDC(warm.npc, { approach: "persuade", kind: "favor" }, warmStance);
    expect(coldDc).not.toBe("refused");
    expect(warmDc).not.toBe("refused");
    if (coldDc === "refused" || warmDc === "refused") throw new Error("unexpected hard refusal");
    expect(coldDc).toBeGreaterThan(warmDc);
  });

});

describe("agenda contests — engine integration", () => {
  test("a resistant NPC holds ground when the seeded social check fails", async () => {
    const { engine, events, gateway } = await buildEngine((playset) => {
      const isolde = playset.world.npcs.find((n) => n.id === "npc.isolde");
      if (!isolde) throw new Error("missing Isolde");
      isolde.alignment = "ce";
      isolde.personalityTemplate = "brute";
      isolde.relationships["pc.you"] = -90;
    });
    events.length = 0;
    gateway.narratorPrompts.length = 0;

    await engine.submitPlayerInput("persuade Isolde to stand down and let me pass");

    const rolls = byKind(events, "diceRolled");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]?.success).toBe(false);
    expect(rolls[0]?.purpose).toContain("Dame Isolde Varr");
    expect(gateway.narratorPrompts.some((p) => p.includes("=== RESOLVED MECHANICS") && p.includes("FAILURE"))).toBe(true);
  });

  test("an off-limits betrayal ask is refused with no roll", async () => {
    // The unrollable refusal is fully reachable — through the CLASSIFIER's closed `socialAsk`,
    // which is where the r8 migration put the authority. The prose floor may no longer mint a
    // hard-refusable kind on its own (`agendaAskOf`); see the pure spec below for that direction.
    const { engine, events, gateway } = await buildEngine(
      (playset) => {
        const isolde = playset.world.npcs.find((n) => n.id === "npc.isolde");
        if (!isolde) throw new Error("missing Isolde");
        isolde.alignment = "lg";
        isolde.personalityTemplate = "caretaker";
        isolde.relationships["pc.you"] = 35;
      },
      () => 0,
      askingClassifier({ "persuade Isolde to betray Severin": { approach: "persuade", kind: "betray" } }),
    );
    events.length = 0;
    gateway.narratorPrompts.length = 0;

    await engine.submitPlayerInput("persuade Isolde to betray Severin");

    expect(kinds(events, "diceRolled")).toBe(0);
    expect(gateway.narratorPrompts.some((p) => p.includes("=== RESOLVED MECHANICS") && p.includes("REFUSED"))).toBe(true);
  });

  test("(r8 review) the PROSE FLOOR cannot mint that refusal — the same line, unnamed, gets a roll", async () => {
    // The other direction of the same rule. With no `socialAsk` from the classifier the cascade
    // reads "betray" and would have scored `kind:"betray"`, which `offLimitsFor` makes unrollable
    // for this lawful-good caretaker — a stonewall the player cannot argue with, minted by a word
    // list. `agendaAskOf` clamps it to the fair-ask baseline, so the ask becomes an ordinary
    // contest: a real roll happens and nothing is hard-refused.
    const { engine, events, gateway } = await buildEngine((playset) => {
      const isolde = playset.world.npcs.find((n) => n.id === "npc.isolde");
      if (!isolde) throw new Error("missing Isolde");
      isolde.alignment = "lg";
      isolde.personalityTemplate = "caretaker";
      isolde.relationships["pc.you"] = 35;
    });
    events.length = 0;
    gateway.narratorPrompts.length = 0;

    await engine.submitPlayerInput("persuade Isolde to betray Severin");

    expect(kinds(events, "diceRolled")).toBe(1);
    expect(gateway.narratorPrompts.some((p) => p.includes("REFUSED"))).toBe(false);
  });

  test("(r8 regex audit) an INSIGHT read that mentions a lie is not a social contest", async () => {
    // `resolveTargetedNpcAsk`'s "is this social?" sniff listed the bare word `lie`, which is a noun
    // and an intransitive verb at least as often as it is an act of deception. Reproduced against
    // the shipped engine: this line (wis/insight, scene DC 12) came back as
    // `Wisdom (insight) vs Dame Isolde Varr (DC 15)` — the scene's DC replaced by the NPC's
    // RESISTANCE, and the turn narrated as "You press …", i.e. reading someone became pressuring
    // them. Only the word changed the turn; the roll and the target were identical.
    const insight = (over: Partial<TurnPlan> = {}): TurnPlan => ({
      kind: "attemptRequiringCheck",
      targetId: "npc.isolde",
      destinationLocationId: null,
      check: { warranted: true, ability: "wis", skill: "insight", dc: 12, reason: "reading her face" },
      confidence: 1,
      ...over,
    });
    const scripted = (plan: TurnPlan): TurnClassifier => ({ classify: () => Promise.resolve(plan) });

    const read = await buildEngine(() => {}, () => 0, scripted(insight()));
    read.events.length = 0;
    await read.engine.submitPlayerInput("I watch Isolde's face while she answers — is that a lie?");
    const readRolls = byKind(read.events, "diceRolled");
    expect(readRolls).toHaveLength(1);
    expect(readRolls[0]?.purpose).toBe("Wisdom (insight) check (DC 12)");

    // The genuine article still contests: a lie the player TELLS is a CHA roll…
    const told = await buildEngine(
      () => {},
      () => 0,
      scripted(insight({ check: { warranted: true, ability: "cha", skill: "deception", dc: 12, reason: "" } })),
    );
    told.events.length = 0;
    await told.engine.submitPlayerInput("I tell Isolde the writ was already paid — a flat lie, warmly told.");
    expect(byKind(told.events, "diceRolled")[0]?.purpose).toContain("vs Dame Isolde Varr");

    // …and so is one the CLASSIFIER names through its closed `socialAsk`, whatever ability it chose.
    const named = await buildEngine(
      () => {},
      () => 0,
      scripted(insight({ socialAsk: { approach: "persuade", kind: "lie" } })),
    );
    named.events.length = 0;
    await named.engine.submitPlayerInput("I spin Isolde a story about the writ being settled.");
    expect(byKind(named.events, "diceRolled")[0]?.purpose).toContain("vs Dame Isolde Varr");
  });

  test("a exploitative NPC demand mutates player inventory only after a failed resist", async () => {
    const { engine, events, gateway } = await buildEngine((playset) => {
      playset.campaign.startingState.companions = ["npc.velvet-enforcer"];
      const enforcer = playset.world.npcs.find((n) => n.id === "npc.velvet-enforcer");
      if (!enforcer) throw new Error("missing enforcer");
      enforcer.alignment = "ce";
      enforcer.personalityTemplate = "brute";
      enforcer.relationships["pc.you"] = -85;
      enforcer.autonomy = {
        isPartyMember: true,
        level: "proactive",
        canLead: false,
        heartbeatSeconds: 30,
        replyDecayAlpha: 0.2,
      };
    });
    events.length = 0;
    gateway.narratorPrompts.length = 0;

    await engine.tickHeartbeat("npc.velvet-enforcer");

    expect(byKind(events, "dialogue").some((e) => e.actorId === "npc.velvet-enforcer")).toBe(true);
    expect(kinds(events, "itemTransferred")).toBe(0);
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("item.famine-coin");

    events.length = 0;
    gateway.narratorPrompts.length = 0;
    await engine.submitPlayerInput("I refuse and keep the coin.");

    const rolls = byKind(events, "diceRolled");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]?.success).toBe(false);
    expect(byKind(events, "itemTransferred")).toContainEqual(
      expect.objectContaining({ itemId: "item.famine-coin", from: "pc.you", to: "npc.velvet-enforcer" }),
    );
    expect(engine.getState().actors["pc.you"]?.inventory).not.toContain("item.famine-coin");
    expect(engine.getState().actors["npc.velvet-enforcer"]?.inventory).toContain("item.famine-coin");
    expect(gateway.narratorPrompts.some((p) => p.includes("=== RESOLVED MECHANICS") && p.includes("FAILURE"))).toBe(true);
  });

  test("an explicit refusal is named as a refusal — a lost roll is coercion, not compliance", async () => {
    const { engine, events, gateway } = await buildEngine((playset) => {
      playset.campaign.startingState.companions = ["npc.velvet-enforcer"];
      const enforcer = playset.world.npcs.find((n) => n.id === "npc.velvet-enforcer");
      if (!enforcer) throw new Error("missing enforcer");
      enforcer.alignment = "ce";
      enforcer.personalityTemplate = "brute";
      enforcer.relationships["pc.you"] = -85;
      enforcer.autonomy = {
        isPartyMember: true,
        level: "proactive",
        canLead: false,
        heartbeatSeconds: 30,
        replyDecayAlpha: 0.2,
      };
    });
    await engine.tickHeartbeat("npc.velvet-enforcer");
    events.length = 0;
    gateway.narratorPrompts.length = 0;

    await engine.submitPlayerInput("No. That's mine and I'm keeping it.");

    const rolls = byKind(events, "diceRolled");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]?.purpose).toContain("you refused");
    // The RESOLVED block must instruct the fiction that this was a REFUSAL, so a lost roll is
    // narrated as the thing being taken over protest — never as the compliance the playtest saw.
    const resolved = gateway.narratorPrompts.find((p) => p.includes("=== RESOLVED MECHANICS"));
    expect(resolved).toBeDefined();
    expect(resolved!).toContain("The player REFUSED");
    expect(resolved!).toContain("Do NOT narrate the player agreeing");
  });

  test("(r8) a concessive REFUSAL is not compliance — the item stays and the roll is real", async () => {
    // THE REPRODUCED MISFIRE, end to end. `pressureAnswerOf("Fine. But you will have to pry it from
    // me.")` === "comply" against the shipped regex (its `fine` arm fires first and the refusal list
    // matches nothing in the rest), which is the branch with NO ROLL: `ctx.apply(consequence)` runs
    // unconditionally and the RESOLVED block says "The player COMPLIES willingly". The classifier's
    // closed `pressureAnswer` is now the authority, and a named refusal restores every mechanic the
    // player earned by refusing — the +2, the honest roll, and the "REFUSED" instruction.
    const { engine, events, gateway } = await buildEngine(
      (playset) => {
        playset.campaign.startingState.companions = ["npc.velvet-enforcer"];
        const enforcer = playset.world.npcs.find((n) => n.id === "npc.velvet-enforcer");
        if (!enforcer) throw new Error("missing enforcer");
        enforcer.alignment = "ce";
        enforcer.personalityTemplate = "brute";
        enforcer.relationships["pc.you"] = -85;
        enforcer.autonomy = {
          isPartyMember: true,
          level: "proactive",
          canLead: false,
          heartbeatSeconds: 30,
          replyDecayAlpha: 0.2,
        };
      },
      // A winning roll, so the refusal actually HOLDS the coin — the observable difference from the
      // no-roll compliance branch, which transfers regardless.
      () => 0.99,
      answeringClassifier({ "Fine. But you will have to pry it from me.": "refuse" }),
    );
    await engine.tickHeartbeat("npc.velvet-enforcer");
    events.length = 0;
    gateway.narratorPrompts.length = 0;

    await engine.submitPlayerInput("Fine. But you will have to pry it from me.");

    const rolls = byKind(events, "diceRolled");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]?.purpose).toContain("you refused");
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("item.famine-coin");
    const resolved = gateway.narratorPrompts.find((p) => p.includes("=== RESOLVED MECHANICS"));
    expect(resolved).toBeDefined();
    expect(resolved!).not.toContain("The player COMPLIES willingly");
  });

  test("an explicit compliance hands the item over with no roll", async () => {
    // The free-handover branch is fully reachable — through the CLASSIFIER's closed
    // `pressureAnswer`. `pressureAnswerFrom` clamps the prose floor's own `comply` to `neutral`
    // (nothing mutates without a roll on a word-list's say-so); see the pair below.
    const { engine, events, gateway } = await buildEngine(
      (playset) => {
        playset.campaign.startingState.companions = ["npc.velvet-enforcer"];
        const enforcer = playset.world.npcs.find((n) => n.id === "npc.velvet-enforcer");
        if (!enforcer) throw new Error("missing enforcer");
        enforcer.alignment = "ce";
        enforcer.personalityTemplate = "brute";
        enforcer.relationships["pc.you"] = -85;
        enforcer.autonomy = {
          isPartyMember: true,
          level: "proactive",
          canLead: false,
          heartbeatSeconds: 30,
          replyDecayAlpha: 0.2,
        };
      },
      () => 0,
      answeringClassifier({ "Fine. Take it, it's yours.": "comply" }),
    );
    await engine.tickHeartbeat("npc.velvet-enforcer");
    events.length = 0;
    gateway.narratorPrompts.length = 0;

    await engine.submitPlayerInput("Fine. Take it, it's yours.");

    expect(kinds(events, "diceRolled")).toBe(0);
    expect(byKind(events, "itemTransferred")).toContainEqual(
      expect.objectContaining({ itemId: "item.famine-coin", from: "pc.you", to: "npc.velvet-enforcer" }),
    );
    expect(gateway.narratorPrompts.some((p) => p.includes("The player COMPLIES willingly"))).toBe(true);
  });

  test("(r8 review) an UNNAMED 'take it' answer keeps the item behind a roll, not a free handover", async () => {
    // The other direction. Same line, no classifier answer: the floor reads `comply`, and the
    // clamp turns it into the bare contested roll. With a winning roll the coin stays — the
    // observable difference from the no-roll branch, which transfers regardless — and the narrator
    // is never told the player complied willingly.
    const { engine, events, gateway } = await buildEngine(
      (playset) => {
        playset.campaign.startingState.companions = ["npc.velvet-enforcer"];
        const enforcer = playset.world.npcs.find((n) => n.id === "npc.velvet-enforcer");
        if (!enforcer) throw new Error("missing enforcer");
        enforcer.alignment = "ce";
        enforcer.personalityTemplate = "brute";
        enforcer.relationships["pc.you"] = -85;
        enforcer.autonomy = {
          isPartyMember: true,
          level: "proactive",
          canLead: false,
          heartbeatSeconds: 30,
          replyDecayAlpha: 0.2,
        };
      },
      () => 0.99,
    );
    await engine.tickHeartbeat("npc.velvet-enforcer");
    events.length = 0;
    gateway.narratorPrompts.length = 0;

    await engine.submitPlayerInput("Fine. Take it, it's yours.");

    expect(kinds(events, "diceRolled")).toBe(1);
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("item.famine-coin");
    expect(gateway.narratorPrompts.some((p) => p.includes("The player COMPLIES willingly"))).toBe(false);
  });
});

describe("pressureAnswerOf", () => {
  test("refusals beat compliance-shaped substrings", () => {
    expect(pressureAnswerOf("No. That's mine and I'm keeping it.")).toBe("refuse");
    expect(pressureAnswerOf("Give it back.")).toBe("refuse");
    expect(pressureAnswerOf("Then we don't have terms. Veressa, you're not walking with me.")).toBe("refuse");
    expect(pressureAnswerOf("You can't take it. Back off.")).toBe("refuse");
  });

  test("clear compliance reads as compliance", () => {
    expect(pressureAnswerOf("Fine. Take it.")).toBe("comply");
    expect(pressureAnswerOf("Here, take them — as you wish.")).toBe("comply");
    expect(pressureAnswerOf("I hand it over without a word.")).toBe("comply");
  });

  test("uncommitted answers stay neutral", () => {
    expect(pressureAnswerOf("I count out sixteen silver and six coppers onto the counter.")).toBe("neutral");
    expect(pressureAnswerOf("Why do you want it?")).toBe("neutral");
  });

  test("(r8) the word-lists CANNOT read a concessive answer — the reproduced misfire", () => {
    // Executed against the shipped regex: PRESSURE_COMPLY_RE's `fine` arm fires on the first word
    // and PRESSURE_REFUSE_RE (checked first) matches nothing in the rest, so the line scores
    // COMPLY. Downstream that is the branch with NO ROLL: the demanded item transfers, and the
    // RESOLVED block tells the narrator "The player COMPLIES willingly" about a player who just
    // said they would have to be fought for it.
    //
    // Fixed at the floor as well as by the closed field: the bare "fine" alternative is gone, since
    // it is the one thing on that list a REFUSAL can also say. Every remaining alternative carries
    // an object, so a genuine concession still reads as one.
    expect(pressureAnswerOf("Fine. But you will have to pry it from me.")).toBe("neutral");
    expect(pressureAnswerOf("Fine. Take it.")).toBe("comply");
    expect(pressureAnswerOf("Fine. It's yours.")).toBe("comply");
  });

  test("(r8 review) a defiant answer that CONTAINS a comply phrase is not compliance", () => {
    // Object-bearing was not enough: a refusal can put the same object phrase inside a dare or a
    // condition. All three scored `comply` against the shipped list (reproduced) — the branch that
    // transfers the item with no roll. The cue is now vetoed by defiance on either side of it.
    expect(pressureAnswerOf("You'll have to take it from my corpse.")).not.toBe("comply");
    expect(pressureAnswerOf("Go on then, try and take it.")).not.toBe("comply");
    expect(pressureAnswerOf("As you wish — but I'll die before it leaves my hand.")).not.toBe("comply");
    expect(pressureAnswerOf("Over my dead body. Take it if you can.")).not.toBe("comply");

    // The genuine concession is untouched — including the one that opens with the same "Fine."
    expect(pressureAnswerOf("Fine. Take it, it's yours.")).toBe("comply");
    expect(pressureAnswerOf("Here, take them — as you wish.")).toBe("comply");
    expect(pressureAnswerOf("I hand it over without a word.")).toBe("comply");
    expect(pressureAnswerOf("I give in.")).toBe("comply");
    expect(pressureAnswerOf("Reluctantly, I hand it over.")).toBe("comply");
  });
});

describe("pressureAnswerFrom — the classifier's closed answer in front of the prose floor (r8)", () => {
  test("a named answer wins outright, including over the concessive misfire", () => {
    expect(pressureAnswerFrom("refuse", "Fine. But you will have to pry it from me.")).toBe("refuse");
    expect(pressureAnswerFrom("comply", "No. That's mine.")).toBe("comply");
    expect(pressureAnswerFrom("neutral", "Fine. Take it.")).toBe("neutral");
  });

  test("null/undefined degrades to the prose floor with `comply` CLAMPED OUT", () => {
    // This spec used to assert "it can never reach `comply` by accident" while only feeding it
    // lines the comply list misses — vacuous, and the claim was false: `pressureAnswerFrom(null,
    // "You'll have to take it from my corpse.")` returned `comply` (reproduced, r8 review). The
    // guarantee is now structural, so the inputs below are lines the floor DOES read as compliance.
    expect(pressureAnswerOf("Fine. Take it, it's yours.")).toBe("comply");
    expect(pressureAnswerFrom(null, "Fine. Take it, it's yours.")).toBe("neutral");
    expect(pressureAnswerFrom(undefined, "I hand it over without a word.")).toBe("neutral");
    expect(pressureAnswerFrom(null, "I give in.")).toBe("neutral");
    // …and the lines that scored `comply` against the shipped list are doubly covered.
    expect(pressureAnswerFrom(null, "You'll have to take it from my corpse.")).toBe("neutral");
    expect(pressureAnswerFrom(null, "Go on then, try and take it.")).toBe("neutral");
    expect(pressureAnswerFrom(null, "As you wish — but I'll die before it leaves my hand.")).toBe("neutral");

    // `refuse` still passes through — it only adds +2 to the player's own resist, never a mutation.
    expect(pressureAnswerFrom(null, "Give it back.")).toBe("refuse");
    expect(pressureAnswerFrom(undefined, "Why do you want it?")).toBe("neutral");
    expect(pressureAnswerFrom(null, "I count out sixteen silver onto the counter.")).toBe("neutral");

    // The classifier's own `comply` is untouched — the capability lives there, not in a word list.
    expect(pressureAnswerFrom("comply", "You'll have to take it from my corpse.")).toBe("comply");
  });

  test("demand labels never leak a raw item id", () => {
    // The playtest saw `ANDS ITEM.POTION-HEALING (DC 16)` — a raw id baked into the roll label
    // when the demanded item was absent from the world's item list.
    expect(itemDisplayNameOf("item.potion-healing")).toBe("Potion Healing");
    expect(itemDisplayNameOf("item.rope-hempen")).toBe("Rope Hempen");
  });
});
