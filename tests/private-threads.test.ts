/**
 * Private threads (Phase 6, click-to-chat) — the engine privacy core, fully deterministic
 * (offline gateway + seeded/pinned rng, no network).
 *
 * Covers the channel end-to-end: the forced private dialogueToNpc round-trip (companion AND
 * location NPC), the no-turn-consumed invalid-target notice, structural bystander exclusion
 * (autonomy priority-B never hears an aside), `# RECENT` narrator exclusion vs the addressed
 * NPC's own inclusion, npc-memory recording on the addressed NPC only, the standing whisper-steer
 * slice (recorded, replay-persisted across reload), the deterministic NPC-initiated-private rule
 * (exploitative agenda steering toward the PC goes private — the uncensored pillar: the channel
 * changes who hears, never what is possible), and offline determinism of the whole sequence.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { byKind, makeEngine, SEED } from "./support/harness.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { freeformPlan } from "../src/engine/turn-plan.ts";
import { DEFAULT_TURN_MINUTES } from "../src/rules/costs.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TickContext, TickTrigger } from "../src/engine/tick.ts";
import { AutonomyModule } from "../src/modules/autonomy/module.ts";
import { HeartbeatScheduler } from "../src/director/heartbeat.ts";
import { NpcAgent } from "../src/agents/npc.ts";
import type { NpcBeat, TurnOutcome } from "../src/agents/context.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type {
  ChatMessage,
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  LlmRole,
} from "../src/llm/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { NpcMemorySlice } from "../src/rules/npc-memory.ts";
import type { WhisperSlice } from "../src/rules/whispers.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import type { Command } from "../src/world/commands.ts";
import type { EmittedEvent, GameEvent } from "../src/events/types.ts";
import type { GameState } from "../src/state/types.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

/**
 * A hall with two reactive companions (Ash addressed, Bee the would-be bystander), one
 * non-companion location NPC (Crow — the "any present NPC has a reply path" case), and a
 * PC-carried trinket for agenda demands.
 */
function buildPlayset(extra: { npcs?: unknown[]; companions?: string[] } = {}): PlaySet {
  const world = WorldSchema.parse({
    id: "w.priv",
    name: "Whisperhold",
    summary: "A close-quarters test world.",
    locations: [{ id: "loc.hall", name: "The Hall", description: "A stone hall.", npcs: ["npc.crow"] }],
    items: [{ id: "itm.locket", name: "Silver Locket", description: "A keepsake.", kind: "treasure" }],
    npcs: [
      { id: "npc.ash", name: "Ash", persona: "An even-keeled scout.", autonomy: { isPartyMember: true, level: "reactive" } },
      { id: "npc.bee", name: "Bee", persona: "A talkative tinker.", autonomy: { isPartyMember: true, level: "reactive" } },
      { id: "npc.crow", name: "Crow", persona: "A wary local.", autonomy: { isPartyMember: false, level: "passive" } },
      ...(extra.npcs ?? []),
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.priv",
    name: "Private Threads",
    worldId: "w.priv",
    characters: [{ id: "pc.you", name: "You", stats: STATS, inventory: ["itm.locket"] }],
    startingState: {
      locationId: "loc.hall",
      party: ["pc.you"],
      companions: ["npc.ash", "npc.bee", ...(extra.companions ?? [])],
    },
  });
  return { world, campaign };
}

/** A classifier pinned to "the player addressed Ash" — the public-address control. */
const addressAsh: TurnClassifier = {
  classify: () => Promise.resolve({ ...freeformPlan(), kind: "dialogueToNpc" as const, targetId: "npc.ash" }),
};

/** Records every narrator-role user prompt while behaving exactly like the offline gateway. */
class RecordingGateway implements LlmGateway {
  readonly narratorPrompts: string[] = [];
  private readonly offline = new OfflineGateway();

  private record(role: LlmRole, req: CompletionRequest): void {
    if (role !== "narrator") return;
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m: ChatMessage | undefined = req.messages[i];
      if (m?.role === "user") {
        this.narratorPrompts.push(m.content);
        return;
      }
    }
  }

  complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    this.record(role, req);
    return this.offline.complete(role, req);
  }

  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    this.record(role, req);
    yield* this.offline.stream(role, req);
  }

  embed(role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return this.offline.embed(role, texts);
  }
}

const privateDialogues = (events: GameEvent[]) =>
  byKind(events, "dialogue").filter((e) => e.channel === "private");

// ===========================================================================
// The private round-trip — player toId → forced dialogueToNpc → private reply.
// ===========================================================================

describe("private round-trip", () => {
  test("a toId turn emits the player line AND the companion reply on channel private", async () => {
    const { engine, events } = await makeEngine({ playset: buildPlayset() });
    events.length = 0;
    await engine.submitPlayerInput("we need to talk alone", { toId: "npc.ash" });
    engine.stop();

    const dialogues = byKind(events, "dialogue");
    expect(dialogues.length).toBe(2);
    expect(dialogues[0]).toMatchObject({ actorId: "pc.you", toId: "npc.ash", channel: "private" });
    expect(dialogues[1]).toMatchObject({ actorId: "npc.ash", toId: "pc.you", channel: "private" });
    // No GM narration rides a pure private exchange.
    expect(byKind(events, "narration").length).toBe(0);
  });

  test("a whisper is a spoken beat: the turn advances the default beat, not the historic 1 minute", async () => {
    const { engine } = await makeEngine({ playset: buildPlayset() });
    const before = engine.getState().clock;
    await engine.submitPlayerInput("we need to talk alone", { toId: "npc.ash" });
    engine.stop();
    expect(engine.getState().clock - before).toBe(DEFAULT_TURN_MINUTES);
  });

  test("a NON-companion location NPC also has a reply path (ephemeral agent, still private)", async () => {
    const { engine, events } = await makeEngine({ playset: buildPlayset() });
    events.length = 0;
    await engine.submitPlayerInput("a quiet word, stranger", { toId: "npc.crow" });
    engine.stop();

    const dialogues = byKind(events, "dialogue");
    expect(dialogues[0]).toMatchObject({ actorId: "pc.you", toId: "npc.crow", channel: "private" });
    expect(dialogues[1]).toMatchObject({ actorId: "npc.crow", toId: "pc.you", channel: "private" });
  });

  test("omitting toId keeps today's routing byte-identical (no channel on public dialogue)", async () => {
    const { engine, events } = await makeEngine({ playset: buildPlayset(), classifier: addressAsh });
    events.length = 0;
    await engine.submitPlayerInput("Ash, how fare you?");
    engine.stop();

    for (const d of byKind(events, "dialogue")) expect(d.channel).toBeUndefined();
    expect(privateDialogues(events).length).toBe(0);
  });
});

// ===========================================================================
// Invalid target — one ephemeral notice, NO turn consumed.
// ===========================================================================

describe("invalid toId", () => {
  test("an unknown entity id emits one system notice; no tick, no clock, nothing persisted", async () => {
    const { engine, events, store, playset } = await makeEngine({ playset: buildPlayset() });
    const key = makeSaveKey(playset.campaign.id, "pc.you");
    const clockBefore = engine.getState().clock;
    const logBefore = (await store.readEvents(key, { includeSilent: true })).length;
    events.length = 0;

    await engine.submitPlayerInput("hello?", { toId: "npc.ghost" });
    engine.stop();

    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ kind: "system", level: "info" });
    expect(engine.getState().clock).toBe(clockBefore); // no turn consumed
    const logAfter = (await store.readEvents(key, { includeSilent: true })).length;
    expect(logAfter).toBe(logBefore); // nothing persisted (system notices are ephemeral)
  });

  test("a present non-NPC (the PC itself) is rejected the same way", async () => {
    const { engine, events } = await makeEngine({ playset: buildPlayset() });
    events.length = 0;
    await engine.submitPlayerInput("talking to myself", { toId: "pc.you" });
    engine.stop();
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("system");
  });
});

// ===========================================================================
// Bystander exclusion — priority-B never hears an aside.
// ===========================================================================

describe("bystander exclusion (autonomy priority-B)", () => {
  test("control: a PUBLIC address lets the second companion chime in (rng pinned open)", async () => {
    const { engine, events, beats } = await makeEngine({
      playset: buildPlayset(),
      classifier: addressAsh,
      rng: () => 0, // B-reaction chance gate always passes — if B can hear it, B reacts
    });
    events.length = 0;
    beats.length = 0;
    await engine.submitPlayerInput("Ash, what do you make of this place?");
    engine.stop();
    // A public chime-in is a DM-narrated beat now, not a raw dialogue bubble.
    expect(beats.some((b) => b.actorId === "npc.bee")).toBe(true);
  });

  test("the SAME table on a PRIVATE address: the bystander stays silent", async () => {
    const { engine, events } = await makeEngine({
      playset: buildPlayset(),
      classifier: addressAsh,
      rng: () => 0, // identical gate — only the channel differs
    });
    events.length = 0;
    await engine.submitPlayerInput("Ash, what do you make of this place?", { toId: "npc.ash" });
    engine.stop();
    expect(byKind(events, "dialogue").some((d) => d.actorId === "npc.bee")).toBe(false);
    // The addressed companion still replied — privately.
    expect(privateDialogues(events).some((d) => d.actorId === "npc.ash")).toBe(true);
  });
});

// ===========================================================================
// Narrator # RECENT — the GM narrates around asides; the addressed NPC remembers its own.
// ===========================================================================

describe("# RECENT visibility", () => {
  test("a later PUBLIC turn's GM brief excludes the private line; the NPC's own reply brief keeps it", async () => {
    const gateway = new RecordingGateway();
    const { engine } = await makeEngine({ playset: buildPlayset(), gateway });

    await engine.submitPlayerInput("the password is zanzibar", { toId: "npc.ash" });
    await engine.submitPlayerInput("I look around the hall.");
    await engine.submitPlayerInput("do you recall the word?", { toId: "npc.ash" });
    engine.stop();

    const gmBrief = gateway.narratorPrompts.find((p) => p.includes("I look around the hall."));
    expect(gmBrief).toBeDefined();
    expect(gmBrief).not.toContain("zanzibar"); // the GM narrates around the aside

    const replyBrief = gateway.narratorPrompts.find((p) => p.includes('"do you recall the word?"'));
    expect(replyBrief).toBeDefined();
    expect(replyBrief).toContain("zanzibar"); // the addressed NPC's own thread stays in ITS brief
  });
});

// ===========================================================================
// npc-memory — only the addressed NPC records the aside.
// ===========================================================================

describe("npc-memory", () => {
  test("the addressed companion records a private beat; the bystander records nothing", async () => {
    const { engine } = await makeEngine({ playset: buildPlayset() });
    await engine.submitPlayerInput("keep this quiet", { toId: "npc.ash" });
    engine.stop();

    const slice = engine.getState().modules?.npcMemory as NpcMemorySlice | undefined;
    const ash = slice?.entries["npc.ash"] ?? [];
    expect(ash.some((e) => e.kind === "addressed" && e.summary === "Spoke privately with You.")).toBe(true);
    expect(slice?.entries["npc.bee"] ?? []).toEqual([]);
    expect(slice?.entries["npc.crow"] ?? []).toEqual([]);
  });
});

// ===========================================================================
// The standing whisper steer — recorded through the reducer, survives reload.
// ===========================================================================

describe("whisper-steer slice", () => {
  test("the last private line per NPC is recorded and persists across a reload", async () => {
    const playset = buildPlayset();
    const store = new InMemoryGameStateStore();
    const { engine } = await makeEngine({ playset, store });
    await engine.submitPlayerInput("stay professional", { toId: "npc.ash" });
    await engine.submitPlayerInput("you can trust me", { toId: "npc.ash" });
    await engine.submitPlayerInput("watch the door", { toId: "npc.bee" });
    engine.stop();

    const whispers = engine.getState().modules?.whispers as WhisperSlice | undefined;
    expect(whispers).toEqual({ "npc.ash": "you can trust me", "npc.bee": "watch the door" }); // last steer only

    // Reload from the same store: the slice is world state, not session memory.
    const engine2 = new GameEngine({ classifier: heuristicClassifier, playset, store, gateway: new OfflineGateway(), rng: mulberry32(SEED) });
    await engine2.start();
    engine2.stop();
    const reloaded = engine2.getState().modules?.whispers as WhisperSlice | undefined;
    expect(reloaded).toEqual({ "npc.ash": "you can trust me", "npc.bee": "watch the door" });
  });
});

// ===========================================================================
// NPC-initiated private — the deterministic discretion rule.
// ===========================================================================

describe("NPC-initiated private lines", () => {
  test("a exploitative companion's agenda line toward the PC goes private (heartbeat, end-to-end)", async () => {
    const playset = buildPlayset({
      npcs: [
        {
          id: "npc.viper",
          name: "Viper",
          persona: "A coiled threat.",
          alignment: "ne",
          exploitative: true,
          autonomy: { isPartyMember: true, level: "proactive" },
        },
      ],
      companions: ["npc.viper"],
    });

    const { engine, events } = await makeEngine({ playset, rng: () => 0 });
    events.length = 0;
    await engine.tickHeartbeat("npc.viper");
    engine.stop();

    const line = byKind(events, "dialogue").find((d) => d.actorId === "npc.viper");
    expect(line).toBeDefined();
    expect(line).toMatchObject({ toId: "pc.you", channel: "private" }); // exploitative steering, whispered
  });

  test("a standing private thread keeps a non-exploitative NPC's PC-directed agenda line private", async () => {
    const fixture = discreetFixture({ whispered: true });
    await fixture.run();
    const line = fixture.dialogues().find((d) => d.actorId === "npc.fixer");
    expect(line).toBeDefined();
    expect(line).toMatchObject({ toId: "pc.you", channel: "private" });
  });

  test("without a private thread the same NPC's line stays public (byte-identical rule floor)", async () => {
    const fixture = discreetFixture({ whispered: false });
    await fixture.run();
    // PUBLIC now means a DM-narrated beat (not a private dialogue bubble): the line lands on the
    // turn outcome, and NO private dialogue event is emitted for this NPC.
    const beat = fixture.beats().find((b) => b.actorId === "npc.fixer");
    expect(beat).toBeDefined();
    expect((beat?.dialogue?.length ?? 0)).toBeGreaterThan(0);
    expect(fixture.dialogues().some((d) => d.actorId === "npc.fixer" && d.channel === "private")).toBe(false);
  });
});

/**
 * A module-level harness around AutonomyModule for the discretion rule's whisper-thread branch: a
 * transactional (schemer) companion whose demand targets the PC, with/without a standing whisper
 * steer seeded into `modules.whispers`. Heartbeat trigger, react + narrate phases only (no real
 * heartbeat timers are registered).
 */
function discreetFixture(opts: { whispered: boolean }) {
  const world = WorldSchema.parse({
    id: "w.disc",
    name: "Backroom",
    summary: "A test backroom.",
    locations: [{ id: "loc.den", name: "The Den", description: "A low-lit den." }],
    items: [{ id: "itm.locket", name: "Silver Locket", description: "A keepsake.", kind: "treasure" }],
    npcs: [
      {
        id: "npc.fixer",
        name: "Fixer",
        persona: "A ledger-minded go-between.",
        personalityTemplate: "schemer",
        autonomy: { isPartyMember: true, level: "proactive" },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.disc",
    name: "Discretion",
    worldId: "w.disc",
    characters: [{ id: "pc.you", name: "You", stats: STATS, inventory: ["itm.locket"] }],
    startingState: { locationId: "loc.den", party: ["pc.you"], companions: ["npc.fixer"] },
  });
  const gs: GameState = {
    campaignId: "c.disc",
    worldId: "w.disc",
    partyLocationId: "loc.den",
    clock: 0,
    party: ["pc.you"],
    companions: ["npc.fixer"],
    actors: {
      "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.den", inventory: ["itm.locket"], conditions: [] },
      "npc.fixer": { id: "npc.fixer", currentHp: 10, locationId: "loc.den", inventory: [], conditions: [] },
    },
    quests: {},
    relationships: {},
    autonomy: { "npc.fixer": { talking: false, replyDepth: 0, lastActedAt: 0 } },
    modules: {
      autonomy: { "npc.fixer": { talking: false, replyDepth: 0, lastActedAt: 0 } },
      ...(opts.whispered ? { whispers: { "npc.fixer": "keep this between us" } } : {}),
    },
    flags: {},
  };
  const model: WorldModel = fromGameState(gs, world, campaign);
  const events: EmittedEvent[] = [];
  const queue: Command[] = [];
  const ctx: TickContext = {
    trigger: { kind: "heartbeat", npcId: "npc.fixer" } satisfies TickTrigger,
    model,
    services: { world, campaign, gateway: new OfflineGateway(), rng: () => 0 },
    recent: [],
    data: {},
    queue,
    enqueue: (cmd) => queue.push(cmd),
    apply: (cmd) => applyCommand(model, cmd),
    applySilent: (cmd) => applyCommand(model, cmd),
    dryRun: (cmd) => applyCommand(structuredClone(model), cmd),
    emit: (ev) => events.push(ev),
    state: () => toGameState(model),
  };
  const template = world.npcs[0]!;
  const npcs = new Map([["npc.fixer", new NpcAgent(new OfflineGateway(), template)]]);
  const module = new AutonomyModule(npcs, new HeartbeatScheduler(), world, () => 0, new Map());
  return {
    run: async () => {
      await module.phases.react!(ctx);
      await module.phases.narrate!(ctx);
    },
    dialogues: () =>
      events.filter((e): e is Extract<EmittedEvent, { kind: "dialogue" }> => "kind" in e && e.kind === "dialogue"),
    // A PUBLIC NPC line is no longer a dialogue event — it lands as a DM-narrated beat on the
    // tick's `ctx.data.turnOutcome.npc`. Private asides still emit their own dialogue bubble.
    beats: (): NpcBeat[] => (ctx.data.turnOutcome as TurnOutcome | undefined)?.npc ?? [],
  };
}

// ===========================================================================
// # RECENT starvation — a long private thread must not evict public history.
// ===========================================================================

describe("# RECENT starvation", () => {
  test("32 consecutive private exchanges do not starve the next public GM brief", async () => {
    const gateway = new RecordingGateway();
    const { engine } = await makeEngine({ playset: buildPlayset(), gateway });

    // A public beat the GM must still remember after the thread.
    await engine.submitPlayerInput("I hang the lantern over the map table.");
    // 32 exchanges ⇒ 64+ private dialogue events — enough to fill the base raw read window,
    // which used to leave the GM's # RECENT literally "(nothing has happened yet)".
    for (let i = 0; i < 32; i++) {
      await engine.submitPlayerInput(`between us, item ${i}`, { toId: "npc.ash" });
    }
    await engine.submitPlayerInput("I look around the hall.");
    engine.stop();

    const gmBrief = [...gateway.narratorPrompts].reverse().find((p) => p.includes("I look around the hall."));
    expect(gmBrief).toBeDefined();
    expect(gmBrief).not.toContain("(nothing has happened yet)"); // public continuity survives
    expect(gmBrief).toContain("lantern"); // …and it is the real pre-thread public beat
    expect(gmBrief).not.toContain("between us, item"); // the aside text itself stays filtered
  });
});

// ===========================================================================
// Offline determinism — the whole private sequence replays byte-identically.
// ===========================================================================

describe("offline determinism", () => {
  const shape = (events: GameEvent[]) =>
    events.map((e) => ({
      kind: e.kind,
      ...(e.kind === "dialogue" ? { actorId: e.actorId, toId: e.toId, channel: e.channel, text: e.text } : {}),
      ...(e.kind === "narration" ? { text: e.text } : {}),
    }));

  test("two fresh runs of the same private sequence emit identical event streams", async () => {
    const run = async (): Promise<GameEvent[]> => {
      const { engine, events } = await makeEngine({ playset: buildPlayset(), rng: mulberry32(SEED) });
      await engine.submitPlayerInput("the password is zanzibar", { toId: "npc.ash" });
      await engine.submitPlayerInput("I look around the hall.");
      await engine.submitPlayerInput("do you recall the word?", { toId: "npc.ash" });
      engine.stop();
      return events;
    };
    const [a, b] = [await run(), await run()];
    expect(shape(a)).toEqual(shape(b));
  });
});
