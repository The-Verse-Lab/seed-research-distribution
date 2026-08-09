/**
 * Living relationships — the proactive-NPC wave that lets NPC regard MOVE during play:
 *  - a conversation nudge the NPC's own agent proposes, code-clamped to ±2 and capped at
 *    CHAT_FRIENDSHIP_CAP cumulative (cooling uncapped);
 *  - once-a-day decay drifting an untended relationship toward its personality baseline.
 *
 * Organic-event warmth (quests/gifts/combat) and faction propagation are covered by the pure
 * helpers in relationships.test.ts plus their trivial call-site wiring; here we drive the two
 * stateful modules through real TickContexts (the turn-outcome harness shape).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { NpcAgent } from "../src/agents/npc.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { Command } from "../src/world/commands.ts";
import type { GameEvent } from "../src/events/types.ts";
import { TickRunner, type TickContext, type TickTrigger } from "../src/engine/tick.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { CompletionChunk, LlmRole } from "../src/llm/types.ts";
import type { GameState } from "../src/state/types.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import { DialogueModule, type DialogueIntent } from "../src/modules/dialogue.ts";
import { RelationshipDecayModule } from "../src/modules/relationship-decay/module.ts";
import { CHAT_FRIENDSHIP_CAP, readRelationshipMeta } from "../src/rules/relationships.ts";

/** A gateway whose stream yields one scripted completion (the NPC's JSON turn), any role. */
const scriptGateway = (text: string): LlmGateway =>
  ({
    // eslint-disable-next-line require-yield
    async *stream(_role: LlmRole): AsyncIterable<CompletionChunk> {
      yield { delta: text, done: false } as CompletionChunk;
    },
    async complete() {
      return { text } as never;
    },
    async embed() {
      return { vectors: [] } as never;
    },
  }) as unknown as LlmGateway;

/** A tiny two-actor world: one non-party NPC (brute/ce → low baseline) with a relationship to the PC. */
function tinyPlayset(npcTowardPc: number, opts: { partyMember?: boolean } = {}): PlaySet {
  const world = WorldSchema.parse({
    id: "world.rel",
    name: "Rel Fixture",
    summary: "A test world.",
    locations: [{ id: "loc.start", name: "Start", npcs: ["npc.brute"] }],
    npcs: [
      {
        id: "npc.brute",
        name: "Bruiser",
        summary: "A hard case.",
        persona: "Terse and mean.",
        goals: ["Intimidate"],
        alignment: "ce",
        personalityTemplate: "brute",
        stats: {
          abilities: { str: 14, dex: 10, con: 12, int: 8, wis: 10, cha: 8 },
          maxHp: 14,
          armorClass: 12,
          level: 1,
          speed: 30,
          proficiencies: [],
          spells: [],
        },
        autonomy: {
          isPartyMember: opts.partyMember ?? false,
          level: "proactive",
          canLead: false,
          heartbeatSeconds: 30,
          replyDecayAlpha: 0.2,
        },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "camp.rel",
    name: "Rel",
    worldId: world.id,
    characters: [
      {
        id: "pc.you",
        name: "You",
        stats: {
          abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 12 },
          maxHp: 10,
          armorClass: 10,
          level: 1,
          speed: 30,
          proficiencies: [],
          spells: [],
        },
        inventory: [],
      },
    ],
    startingState: {
      locationId: "loc.start",
      party: ["pc.you"],
      companions: opts.partyMember ? ["npc.brute"] : [],
    },
  });
  return { world, campaign };
}

function stateOf(playset: PlaySet, npcTowardPc: number, clock = 0): GameState {
  const partyMember = playset.campaign.startingState.companions?.includes("npc.brute") ?? false;
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.start",
    clock,
    party: ["pc.you"],
    companions: partyMember ? ["npc.brute"] : [],
    actors: {
      "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.start", inventory: [], conditions: [] },
      "npc.brute": { id: "npc.brute", currentHp: 14, locationId: "loc.start", inventory: [], conditions: [] },
    },
    quests: {},
    relationships: { "npc.brute": { "pc.you": npcTowardPc } },
    autonomy: {},
    modules: {},
    flags: {},
  };
}

function dialogueCtx(model: WorldModel, playset: PlaySet, gateway: LlmGateway, intent: DialogueIntent): TickContext {
  const events: GameEvent[] = [];
  const ctx: TickContext = {
    trigger: { kind: "player", input: intent.playerLine },
    model,
    services: { world: playset.world, campaign: playset.campaign, gateway, rng: mulberry32(1) },
    recent: [],
    data: { dialogue: intent },
    queue: [],
    enqueue(cmd) {
      ctx.queue.push(cmd);
    },
    apply: (cmd) => applyCommand(model, cmd),
    applySilent: (cmd) => applyCommand(model, cmd),
    dryRun: (cmd) => applyCommand(structuredClone(model), cmd),
    emit: (ev) => events.push({ ...ev, id: `e${events.length}`, at: 0, seq: events.length } as GameEvent),
    state: () => toGameState(model),
  };
  return ctx;
}

async function runDialogue(model: WorldModel, playset: PlaySet, gateway: LlmGateway): Promise<TickContext> {
  const npc = playset.world.npcs[0]!;
  const runner = new TickRunner();
  runner.register(new DialogueModule(new Map([[npc.id, new NpcAgent(gateway, npc)]])));
  const ctx = dialogueCtx(model, playset, gateway, { npcId: npc.id, playerLine: "You did well back there." });
  await runner.run(ctx);
  return ctx;
}

describe("conversation-driven warmth (Workstream B)", () => {
  test("a public reply's proposed nudge enqueues a clamped adjustRelationship and banks it under the cap", async () => {
    const playset = tinyPlayset(0);
    const model = fromGameState(stateOf(playset, 0), playset.world, playset.campaign);
    const gateway = scriptGateway('{"speech":"...fine. You held your own.","relationship":2}');
    const ctx = await runDialogue(model, playset, gateway);

    const rel = ctx.queue.filter((c): c is Extract<Command, { type: "adjustRelationship" }> => c.type === "adjustRelationship");
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ actorId: "npc.brute", targetId: "pc.you", by: 2 });
    expect(readRelationshipMeta(model.modules).chatEarned["npc.brute"]?.["pc.you"]).toBe(2);
  });

  test("an over-range proposal is clamped to +2", async () => {
    const playset = tinyPlayset(0);
    const model = fromGameState(stateOf(playset, 0), playset.world, playset.campaign);
    const ctx = await runDialogue(model, playset, scriptGateway('{"speech":"friend!","relationship":9}'));
    const rel = ctx.queue.filter((c) => c.type === "adjustRelationship");
    expect(rel[0]).toMatchObject({ by: 2 });
  });

  test("positive nudges stop at CHAT_FRIENDSHIP_CAP; cooling is never capped", async () => {
    const playset = tinyPlayset(0);
    // Already at the ceiling from prior talk.
    const state = stateOf(playset, 0);
    state.modules = { relationshipMeta: { chatEarned: { "npc.brute": { "pc.you": CHAT_FRIENDSHIP_CAP } }, lastInteractDay: {} } };
    const modelHot = fromGameState(state, playset.world, playset.campaign);
    const hot = await runDialogue(modelHot, playset, scriptGateway('{"speech":"pals?","relationship":2}'));
    expect(hot.queue.filter((c) => c.type === "adjustRelationship")).toHaveLength(0); // warmth refused at cap

    const modelCold = fromGameState(state, playset.world, playset.campaign);
    const cold = await runDialogue(modelCold, playset, scriptGateway('{"speech":"get lost.","relationship":-2}'));
    const rel = cold.queue.filter((c) => c.type === "adjustRelationship");
    expect(rel[0]).toMatchObject({ by: -2 }); // cooling still applies at the cap
  });
});

describe("relationship decay toward personality baseline (Workstream C)", () => {
  const trigger: TickTrigger = { kind: "player", input: "wait" };

  function decayCtx(model: WorldModel, playset: PlaySet): TickContext {
    const events: GameEvent[] = [];
    const ctx: TickContext = {
      trigger,
      model,
      services: { world: playset.world, campaign: playset.campaign, gateway: scriptGateway(""), rng: mulberry32(1) },
      recent: [],
      data: {},
      queue: [],
      enqueue(cmd) {
        ctx.queue.push(cmd);
      },
      apply: (cmd) => applyCommand(model, cmd),
      applySilent: (cmd) => applyCommand(model, cmd),
      dryRun: (cmd) => applyCommand(structuredClone(model), cmd),
      emit: (ev) => events.push({ ...ev, id: `e${events.length}`, at: 0, seq: events.length } as GameEvent),
      state: () => toGameState(model),
    };
    return ctx;
  }

  test("first observation anchors without drifting; a day later a warm brute cools toward its low baseline", () => {
    const playset = tinyPlayset(60); // brute is uncharacteristically liked (+60)
    const mod = new RelationshipDecayModule(playset.world);

    // Day 0: anchor only — no drift, no write.
    const model = fromGameState(stateOf(playset, 60, 0), playset.world, playset.campaign);
    mod.phases.react!(decayCtx(model, playset));
    expect(model.relationships.get("npc.brute")?.get("pc.you")).toBe(60);

    // Day 1 (clock += 1440): one step down toward the brute's negative baseline.
    model.clock = 1440;
    mod.phases.react!(decayCtx(model, playset));
    const after = model.relationships.get("npc.brute")?.get("pc.you")!;
    expect(after).toBeLessThan(60);
    expect(after).toBeGreaterThanOrEqual(56); // a small, bounded step
  });

  test("an active party member is exempt from decay", () => {
    const playset = tinyPlayset(60, { partyMember: true });
    const mod = new RelationshipDecayModule(playset.world);
    const model = fromGameState(stateOf(playset, 60, 0), playset.world, playset.campaign);
    mod.phases.react!(decayCtx(model, playset)); // anchor
    model.clock = 1440;
    mod.phases.react!(decayCtx(model, playset));
    expect(model.relationships.get("npc.brute")?.get("pc.you")).toBe(60); // unchanged — at your side
  });

  test("a recently-tended relationship (interacted this day-window) does not drift", () => {
    const playset = tinyPlayset(60);
    const mod = new RelationshipDecayModule(playset.world);
    const state = stateOf(playset, 60, 0);
    // Interacted on day 1 — inside DECAY_RECENT_DAYS when the day-1 pass runs.
    state.modules = { relationshipMeta: { chatEarned: {}, lastInteractDay: { "npc.brute": { "pc.you": 1 } } } };
    const model = fromGameState(state, playset.world, playset.campaign);
    mod.phases.react!(decayCtx(model, playset)); // anchor day 0
    model.clock = 1440;
    mod.phases.react!(decayCtx(model, playset));
    expect(model.relationships.get("npc.brute")?.get("pc.you")).toBe(60); // exempt — freshly tended
  });
});
