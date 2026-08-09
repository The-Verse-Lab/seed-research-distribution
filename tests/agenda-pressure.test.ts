/**
 * Agenda-pressure pacing tests — a companion's demand/pressure can no longer soft-lock the table.
 *
 * The live-playtest defect under test: a transactional/exploitative companion pressed the IDENTICAL
 * "presses a debt" CHA-resist on three consecutive player turns, consuming every input (travel
 * included). Two guards fix it, both covered here:
 *  - WON-DEBT GUARD (pure, src/rules/agenda.ts): a won press sets `debtFlagKey(npcId)` on the
 *    target; once the flag is held, `chooseAgendaAction` never chooses the pressure again.
 *  - PRESSURE COOLDOWN (module, src/modules/autonomy/module.ts): arming a demand/pressure stamps
 *    `lastPressedAt`; within PRESSURE_COOLDOWN_BEATS × heartbeat the NPC's beat is plain dialogue.
 *    Default-open: an absent stamp ⇒ 0 ⇒ the first press always fires.
 * Plus the narration-fiction regression (src/engine/engine.ts): answering a pressure narrates as
 * clean prose, never a mechanical parenthetical like `(presses a debt)`.
 *
 * Same conventions as tests/agenda.test.ts / tests/autonomy.test.ts: offline gateway (recorded),
 * seeded/forced rng, in-memory store, white-box autonomy patching through a doctored snapshot.
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
import { makeSaveKey } from "../src/state/store.ts";
import type { AutonomyRuntime, GameState } from "../src/state/types.ts";
import { chooseAgendaAction, debtFlagKey, stance } from "../src/rules/agenda.ts";
import { fromGameState, type WorldModel } from "../src/world/model.ts";
import type { GameEvent } from "../src/events/types.ts";
import { byKind, type TraceBeat } from "./support/harness.ts";

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

/**
 * Pure fixture (the tests/agenda.test.ts shape) with a controllable PC inventory: an EMPTY one
 * steers `chooseAgendaAction` past the demand branch (nothing to demand) into the debt PRESSURE.
 */
function fixture(npcPatch: Partial<NpcTemplate>, relationship: number, pcInventory: string[]): {
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
    id: "world.pressure",
    name: "Pressure Fixture",
    summary: "A test world.",
    locations: [{ id: "loc.start", name: "Start", npcs: [] }],
    items: [{ id: "item.coin", name: "bright coin", kind: "treasure" }],
    npcs: [npcInput],
  });
  const npc = world.npcs[0]!;
  const campaign = CampaignSchema.parse({
    id: "campaign.pressure",
    name: "Pressure",
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
        inventory: pcInventory,
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
      "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.start", inventory: pcInventory, conditions: [] },
      "npc.test": { id: "npc.test", currentHp: 12, locationId: "loc.start", inventory: [], conditions: [] },
    },
    quests: {},
    relationships: { "npc.test": { "pc.you": relationship } },
    autonomy: { "npc.test": { talking: false, replyDepth: 0, lastActedAt: 0 } },
    flags: {},
  };
  return { npc, world, model: fromGameState(state, world, campaign) };
}

describe("agenda pressure — the won-debt guard (pure)", () => {
  test("an empty-handed target draws the debt PRESSURE, keyed by debtFlagKey", () => {
    const { npc, world, model } = fixture({ alignment: "ce", personalityTemplate: "brute" }, -80, []);
    const s = stance(npc, "pc.you", model, world);
    expect(s.disposition).toBe("exploitative");

    const action = chooseAgendaAction(npc, s, model, world);
    expect(action?.kind).toBe("pressure");
    if (action?.kind !== "pressure") throw new Error("expected the pressure action");
    // The consequence literal and the guard share ONE key helper — they can never drift.
    expect(action.consequence).toEqual({
      type: "setFlag",
      scope: "entity",
      entityId: "pc.you",
      key: debtFlagKey(npc.id),
      value: true,
    });
  });

  test("a WON press never re-presses: with the debt flag held, no pressure is chosen", () => {
    const { npc, world, model } = fixture({ alignment: "ce", personalityTemplate: "brute" }, -80, []);
    const s = stance(npc, "pc.you", model, world);

    // The consequence of a LOST resist: the target now carries the debt flag.
    const target = model.entities.get("pc.you");
    expect(target).toBeDefined();
    target!.flags[debtFlagKey(npc.id)] = true;

    // The soft-lock regression: before the guard this returned the identical pressure forever.
    expect(chooseAgendaAction(npc, s, model, world)).toBeNull();
  });

  test("debtFlagKey sanitizes the NPC id exactly like the consequence used to", () => {
    expect(debtFlagKey("npc.velvet-enforcer")).toBe("debt_to_npc.velvet-enforcer");
    expect(debtFlagKey("npc id with spaces!")).toBe("debt_to_npc_id_with_spaces_");
  });
});

// --- engine integration: cooldown pacing + clean narration ------------------

async function loadBlackConcord(): Promise<PlaySet> {
  const dir = fileURLToPath(new URL("fixtures/worlds/black-concord", import.meta.url));
  return loadPlaySetFromDir(dir);
}

/** Make the Velvet Enforcer a exploitative companion — the proven pressure-arming setup. */
function exploitativeEnforcer(playset: PlaySet): void {
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
}

/** Patch one companion's autonomy runtime in both projections fromGameState may read. */
function setAutonomy(s: GameState, npcId: string, patch: Partial<AutonomyRuntime>): void {
  const base: AutonomyRuntime = s.autonomy[npcId] ?? { talking: false, replyDepth: 0, lastActedAt: 0 };
  const next = { ...base, ...patch };
  s.autonomy[npcId] = next;
  s.modules = s.modules ?? {};
  const mod = (s.modules.autonomy as Record<string, AutonomyRuntime> | undefined) ?? {};
  mod[npcId] = next;
  s.modules.autonomy = mod;
}

async function buildEngine(opts: {
  mutateState?: (s: GameState) => void;
  rng?: () => number;
} = {}): Promise<{
  engine: GameEngine;
  events: GameEvent[];
  beats: TraceBeat[];
  gateway: RecordingGateway;
  store: InMemoryGameStateStore;
  playset: PlaySet;
}> {
  const playset = await loadBlackConcord();
  exploitativeEnforcer(playset);
  const gateway = new RecordingGateway();

  const store = new InMemoryGameStateStore();
  if (opts.mutateState) {
    const seed = new GameEngine({ classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: opts.rng ?? (() => 0),
    });
    await seed.start();
    const snapshot = seed.getState();
    opts.mutateState(snapshot);
    await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), snapshot);
  }

  const beats: TraceBeat[] = [];
  const engine = new GameEngine({
    classifier: heuristicClassifier,
    playset,
    store,
    gateway,
    rng: opts.rng ?? (() => 0),
    onTurnTrace: (t) => {
      if (t.npcBeats) beats.push(...t.npcBeats);
    },
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  return { engine, events, beats, gateway, store, playset };
}

describe("agenda pressure — cooldown pacing (engine)", () => {
  test("default-open: with no stamp the first press fires, and arming it stamps lastPressedAt", async () => {
    const { engine, events } = await buildEngine();
    const before = Date.now();
    events.length = 0;

    await engine.tickHeartbeat("npc.velvet-enforcer");

    // The press armed (the enforcer speaks; the resist waits on the player's next input)…
    expect(byKind(events, "dialogue").some((e) => e.actorId === "npc.velvet-enforcer")).toBe(true);
    // …and the cooldown clock is stamped where the pressure was armed.
    const stamped = engine.getState().autonomy["npc.velvet-enforcer"]?.lastPressedAt;
    expect(stamped).toBeDefined();
    expect(stamped!).toBeGreaterThanOrEqual(before);
  });

  test("within the cooldown the beat is plain dialogue — the next input answers NO resist", async () => {
    const { engine, events, beats } = await buildEngine({
      // A just-armed press: within 3× the enforcer's 30s heartbeat nothing new may be armed.
      mutateState: (s) => setAutonomy(s, "npc.velvet-enforcer", { lastPressedAt: Date.now() }),
    });
    events.length = 0;
    beats.length = 0;

    await engine.tickHeartbeat("npc.velvet-enforcer");

    // The companion still speaks — demoted to plain (public) dialogue delivered as a DM-narrated
    // beat, no machinery armed…
    expect(beats.some((b) => b.actorId === "npc.velvet-enforcer")).toBe(true);

    events.length = 0;
    beats.length = 0;
    await engine.submitPlayerInput("I refuse and keep the coin.");

    // …so the player's turn is THEIRS: no resist roll, no consequence, the coin stays.
    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "itemTransferred")).toHaveLength(0);
    expect(engine.getState().actors["pc.you"]?.inventory).toContain("item.famine-coin");
  });

  test("an expired cooldown presses again (the gate is pacing, not a permanent mute)", async () => {
    const { engine, events } = await buildEngine({
      // 3 beats × 30s = 90s; a stamp older than that must not gate the next press.
      mutateState: (s) => setAutonomy(s, "npc.velvet-enforcer", { lastPressedAt: Date.now() - 120_000 }),
    });
    events.length = 0;

    await engine.tickHeartbeat("npc.velvet-enforcer");
    events.length = 0;
    await engine.submitPlayerInput("I refuse and keep the coin.");

    // The re-armed press resolves as ever: one seeded resist roll on the player's answer.
    expect(byKind(events, "diceRolled")).toHaveLength(1);
  });

  test("an armed pressure survives engine reload and still owns the next public answer", async () => {
    const first = await buildEngine();
    first.events.length = 0;
    await first.engine.tickHeartbeat("npc.velvet-enforcer");
    expect(byKind(first.events, "dialogue").some((e) => e.actorId === "npc.velvet-enforcer")).toBe(true);
    first.engine.stop();

    const gateway = new RecordingGateway();
    const resumed = new GameEngine({
      classifier: heuristicClassifier,
      playset: first.playset,
      store: first.store,
      gateway,
      rng: () => 0,
    });
    const events: GameEvent[] = [];
    resumed.subscribe((event) => events.push(event));
    await resumed.start();
    events.length = 0;

    await resumed.submitPlayerInput("I refuse and keep the coin.");

    expect(byKind(events, "diceRolled")).toHaveLength(1);
    expect(gateway.narratorPrompts.some((prompt) => prompt.includes('you refuse: "I refuse and keep the coin."'))).toBe(
      true,
    );
    resumed.stop();
  });
});

describe("agenda pressure — the narration stays fiction (engine)", () => {
  test("answering a pressure never narrates a mechanical parenthetical", async () => {
    const { engine, gateway } = await buildEngine();
    await engine.tickHeartbeat("npc.velvet-enforcer"); // arms the demand

    gateway.narratorPrompts.length = 0;
    await engine.submitPlayerInput("I refuse and keep the coin.");

    // The live defect read: `You answer X's pressure (presses a debt): …` — machinery on stage.
    // An explicit refusal is named as a refusal, so a lost roll never reads as compliance.
    const narration = gateway.narratorPrompts.find((p) => p.includes("you refuse"));
    expect(narration).toBeDefined();
    expect(narration!).toContain(`you refuse: "I refuse and keep the coin."`);
    expect(narration!).toContain("The player REFUSED.");
    expect(narration!).not.toContain("'s pressure (");
    // The mechanics still reach the model where they belong: the resolved block.
    expect(gateway.narratorPrompts.some((p) => p.includes("=== RESOLVED MECHANICS"))).toBe(true);
  });
});
