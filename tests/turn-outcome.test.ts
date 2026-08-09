/**
 * Turn outcome (Workstream C slim) — the GM narrates LAST and weaves executed NPC beats.
 *
 * The dialogue/autonomy modules accumulate what ALREADY happened onto `ctx.data.turnOutcome`;
 * the narration module (now `after: ["dialogue", "events", "autonomy"]`) renders those beats
 * as an authoritative `=== NPC ACTIONS THIS TURN ===` block in the brief's current-action
 * region. One source of truth: the emitted dialogue event's text IS the recorded beat IS the
 * brief's block line. Zero-beat scenes render byte-identical briefs; the resolved-mechanics
 * contract is untouched; event beats print BEFORE GM prose.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { buildNarrationContext, recordSocialRead, type ContextInput } from "../src/agents/context.ts";
import { NpcAgent } from "../src/agents/npc.ts";
import { NpcTemplateSchema, PrebakedEventSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { TickRunner, type TickContext } from "../src/engine/tick.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { ChatMessage, CompletionChunk, CompletionRequest, LlmRole } from "../src/llm/types.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import { DialogueModule, type DialogueIntent } from "../src/modules/dialogue.ts";
import { NarrationModule, type NarrationIntent } from "../src/modules/narration.ts";
import { summarizeCommand } from "../src/modules/autonomy/module.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { loadExample, SEED, type TraceBeat } from "./support/harness.ts";

const OUTCOME_HDR = "=== NPC ACTIONS THIS TURN (authoritative — weave these in; do not contradict or re-decide them) ===";

function baseInput(playset: PlaySet, overrides: Partial<ContextInput> = {}): ContextInput {
  return {
    world: playset.world,
    campaign: playset.campaign,
    state: {
      campaignId: playset.campaign.id,
      worldId: playset.world.id,
      partyLocationId: playset.world.locations[0]!.id,
      clock: 0,
      party: ["pc.you"],
      companions: [],
      actors: {},
      quests: {},
      relationships: {},
      autonomy: {},
      modules: {},
      flags: {},
    },
    recentEvents: [],
    trigger: "You look around.",
    ...overrides,
  };
}

const EVENTS_HDR = "=== ALREADY HAPPENING THIS TURN (already shown to the player — stay consistent, do NOT restate or contradict) ===";

describe("the turn-outcome block — brief rendering contract", () => {
  test("zero beats ⇒ byte-identical brief (absent, undefined, and empty all render the same)", async () => {
    const playset = await loadExample();
    const absent = buildNarrationContext(baseInput(playset)).contextText;
    const empty = buildNarrationContext(baseInput(playset, { turnOutcome: [] })).contextText;
    expect(empty).toBe(absent);
    expect(absent).not.toContain("NPC ACTIONS THIS TURN");
  });

  test("environmental event beats render a stay-consistent block; empty ⇒ byte-identical brief", async () => {
    const playset = await loadExample();
    const absent = buildNarrationContext(baseInput(playset)).contextText;
    expect(buildNarrationContext(baseInput(playset, { turnEvents: [] })).contextText).toBe(absent);
    expect(absent).not.toContain("ALREADY HAPPENING");

    const withBeat = buildNarrationContext(
      baseInput(playset, { turnEvents: ["A crier nails a fresh notice to the board."] }),
    ).contextText;
    const occurrences = withBeat.split(EVENTS_HDR).length - 1;
    expect(occurrences).toBe(1);
    expect(withBeat).toContain("- A crier nails a fresh notice to the board.");
    expect(withBeat.indexOf(EVENTS_HDR)).toBeGreaterThan(withBeat.indexOf("# NOW")); // current-action region
    expect(withBeat.startsWith(absent)).toBe(true); // only APPENDS — nothing above it moves
  });

  test("one accepted NPC line ⇒ exactly one authoritative block, in the current-action region", async () => {
    const playset = await loadExample();
    const ctx = buildNarrationContext(
      baseInput(playset, {
        turnOutcome: [{ actorId: "npc.lyra", name: "Lyra Vane", dialogue: "Stay close to me." }],
      }),
    );
    const occurrences = ctx.contextText.split(OUTCOME_HDR).length - 1;
    expect(occurrences).toBe(1);
    expect(ctx.contextText).toContain('- Lyra Vane: said: "Stay close to me."');
    expect(ctx.contextText.indexOf(OUTCOME_HDR)).toBeGreaterThan(ctx.contextText.indexOf("# NOW"));

    // An action-bearing beat renders both halves on the one line.
    const withAction = buildNarrationContext(
      baseInput(playset, {
        turnOutcome: [{ actorId: "npc.lyra", name: "Lyra Vane", dialogue: "This way.", action: "set off toward the Square" }],
      }),
    ).contextText;
    expect(withAction).toContain('- Lyra Vane: said: "This way." — set off toward the Square');
  });

  test("signed-turn enrichment only APPENDS — rejected + facts render after the byte-stable skeleton", async () => {
    const playset = await loadExample();
    // accepted:true adds nothing → byte-identical to the un-enriched beat (enrichment is opt-in).
    const plain = buildNarrationContext(
      baseInput(playset, {
        turnOutcome: [{ actorId: "npc.lyra", name: "Lyra Vane", dialogue: "This way.", action: "set off toward the Square" }],
      }),
    ).contextText;
    const accepted = buildNarrationContext(
      baseInput(playset, {
        turnOutcome: [{ actorId: "npc.lyra", name: "Lyra Vane", dialogue: "This way.", action: "set off toward the Square", accepted: true }],
      }),
    ).contextText;
    expect(accepted).toBe(plain);

    // A REJECTED action is flagged so the DM will not narrate it as succeeding.
    const rejected = buildNarrationContext(
      baseInput(playset, {
        turnOutcome: [{ actorId: "npc.lyra", name: "Lyra Vane", action: "set off toward the Square", accepted: false, rejectedReason: "no such exit" }],
      }),
    ).contextText;
    expect(rejected).toContain("- Lyra Vane: set off toward the Square (REJECTED: no such exit — do NOT narrate as succeeding)");

    // factsAsserted remain attributed NPC claims; they never become authoritative world truth.
    const facts = buildNarrationContext(
      baseInput(playset, {
        turnOutcome: [{ actorId: "npc.lyra", name: "Lyra Vane", dialogue: "The bridge is out.", factsAsserted: ["the north bridge is out"] }],
      }),
    ).contextText;
    expect(facts).toContain(
      '- Lyra Vane: said: "The bridge is out." [claims aloud — not verified world truth: the north bridge is out]',
    );
  });

  test("the RESOLVED MECHANICS contract is untouched and coexists with the outcome block", async () => {
    const playset = await loadExample();
    const resolved = { label: "Athletics check", total: 17, success: true, critical: null } as const;
    const without = buildNarrationContext(baseInput(playset, { resolved })).contextText;
    const withBeats = buildNarrationContext(
      baseInput(playset, {
        resolved,
        turnOutcome: [{ actorId: "npc.lyra", name: "Lyra Vane", dialogue: "Nicely done." }],
      }),
    ).contextText;
    expect(without).toContain("=== RESOLVED MECHANICS (authoritative — narrate this exact outcome) ===");
    expect(withBeats).toContain("=== RESOLVED MECHANICS (authoritative — narrate this exact outcome) ===");
    expect(withBeats.startsWith(without)).toBe(true); // the block only APPENDS — nothing moved
  });
});

const SOCIAL_HDR =
  "=== SOCIAL READ (tone only — how the acting NPCs regard their targets; color the prose, change no outcome) ===";

describe("the social-read block (Workstream F follow-up) — a GM tone cue, omit-when-empty", () => {
  test("zero reads ⇒ byte-identical brief (absent and empty render the same, no header)", async () => {
    const playset = await loadExample();
    const absent = buildNarrationContext(baseInput(playset)).contextText;
    expect(buildNarrationContext(baseInput(playset, { socialReads: [] })).contextText).toBe(absent);
    expect(absent).not.toContain("SOCIAL READ");
  });

  test("a read renders exactly one tone block in the screened current-action region; only APPENDS", async () => {
    const playset = await loadExample();
    const absent = buildNarrationContext(baseInput(playset)).contextText;
    const withRead = buildNarrationContext(
      baseInput(playset, { socialReads: [{ actor: "Bram", target: "you", summary: "trust +4, fear -3" }] }),
    ).contextText;
    expect(withRead.split(SOCIAL_HDR).length - 1).toBe(1);
    expect(withRead).toContain("- Bram regards you: trust +4, fear -3");
    expect(withRead.indexOf(SOCIAL_HDR)).toBeGreaterThan(withRead.indexOf("# NOW")); // current-action region
    expect(withRead.startsWith(absent)).toBe(true); // the block only APPENDS — nothing above it moves
  });

  test("recordSocialRead accumulates onto ctx.data.socialReads in order (slot created on first use)", () => {
    const data: Record<string, unknown> = {};
    recordSocialRead(data, { actor: "Bram", target: "you", summary: "trust +4" });
    recordSocialRead(data, { actor: "Sable", target: "you", summary: "fear -2" });
    expect(data.socialReads).toEqual([
      { actor: "Bram", target: "you", summary: "trust +4" },
      { actor: "Sable", target: "you", summary: "fear -2" },
    ]);
  });
});

describe("the disclosure-ledger block — prior NPC claims, omit-when-empty", () => {
  const ESTABLISHED_HDR = "# PRIOR NPC CLAIMS (speaker continuity only — NOT authoritative world truth)";

  test("absent and empty render byte-identically, with no header", async () => {
    const playset = await loadExample();
    const absent = buildNarrationContext(baseInput(playset)).contextText;
    expect(buildNarrationContext(baseInput(playset, { established: [] })).contextText).toBe(absent);
    expect(absent).not.toContain("PRIOR NPC CLAIMS");
  });

  test("facts render as bullets in the grounding region (before # NOW)", async () => {
    const playset = await loadExample();
    const ctx = buildNarrationContext(
      baseInput(playset, { established: ["the north bridge is out", "Mara owns the mill"] }),
    ).contextText;
    expect(ctx.split(ESTABLISHED_HDR).length - 1).toBe(1);
    expect(ctx).toContain("- the north bridge is out");
    expect(ctx).toContain("- Mara owns the mill");
    expect(ctx.indexOf(ESTABLISHED_HDR)).toBeLessThan(ctx.indexOf("# NOW")); // grounding region, before the guard cut
  });
});

describe("dryRun — the signed-TurnOutcome oracle: validate without mutating the live model", () => {
  test("a would-succeed command reports mutated; a bad one reports rejected; the live model is untouched either way", async () => {
    const playset = await loadExample();
    const engine = new GameEngine({
      classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(SEED),
    });
    await engine.start();
    const model: WorldModel = fromGameState(engine.getState(), playset.world, playset.campaign);

    // Exactly how the engine implements ctx.dryRun: reduce against a deep clone.
    const dryRun = (cmd: Parameters<typeof applyCommand>[1]) => applyCommand(structuredClone(model), cmd);
    const before = toGameState(model);

    const ok = dryRun({ type: "advanceClock", by: 5 });
    expect(ok.mutated).toBe(true);
    expect(ok.rejected).toBeUndefined();
    expect(model.clock).toBe(before.clock); // the dry-run did NOT advance the live clock

    const bad = dryRun({ type: "moveEntity", entityId: "npc.ghost-does-not-exist", to: playset.world.locations[0]!.id });
    expect(bad.mutated).toBe(false);
    expect(bad.rejected).toBeDefined(); // the accepted/rejected signal for the signed TurnOutcome
    expect(toGameState(model)).toEqual(before); // the live model is wholly unchanged by both dry-runs
  });
});

/** Records narrator briefs AND yields the deterministic offline completion. */
class BriefRecordingGateway implements LlmGateway {
  readonly briefs: string[] = [];
  private readonly inner = new OfflineGateway();

  complete(role: LlmRole, req: CompletionRequest) {
    return this.inner.complete(role, req);
  }

  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const user = [...req.messages].reverse().find((m: ChatMessage) => m.role === "user")?.content ?? "";
    if (role === "narrator") {
      this.briefs.push(user);
      // Give the reactive NPC an ungrounded physical staging proposal. The dialogue module must keep
      // the words but discard this action before it can enter the authoritative GM weave.
      if (user.includes("Respond ONLY with a single JSON object describing your turn")) {
        yield {
          delta: JSON.stringify({ speech: [{ say: "Ready.", mood: "neutral" }], action: "opens the sealed gate" }),
          done: false,
        };
        yield { delta: "", done: true };
        return;
      }
    }
    yield* this.inner.stream(role, req);
  }

  embed(role: LlmRole, texts: string[]) {
    return this.inner.embed(role, texts);
  }
}

describe("module spine — dialogue feeds the GM, who runs last (real TickRunner, real modules)", () => {
  test("companion beat fires: recorded beat === brief block line, and NO raw public dialogue bubble", async () => {
    const playset = await loadExample();
    const engine = new GameEngine({
      classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(SEED),
    });
    await engine.start();
    const model: WorldModel = fromGameState(engine.getState(), playset.world, playset.campaign);

    const gateway = new BriefRecordingGateway();
    const lyra = playset.world.npcs.find((n) => n.id === "npc.lyra")!;
    const runner = new TickRunner();
    // Deliberately register narration FIRST — its `after: ["dialogue", ...]` must lift the
    // dialogue module ahead of it (the engine's real ordering mechanism, not registration luck).
    runner.register(new NarrationModule(playset.world, gateway));
    runner.register(new DialogueModule(new Map([["npc.lyra", new NpcAgent(gateway, lyra)]])));

    const events: GameEvent[] = [];
    const ctx: TickContext = {
      trigger: { kind: "player", input: "Lyra, ready?" },
      model,
      services: { world: playset.world, campaign: playset.campaign, gateway, rng: mulberry32(SEED) },
      recent: [],
      data: {
        dialogue: { npcId: "npc.lyra", playerLine: "Lyra, ready?" } satisfies DialogueIntent,
        narration: { trigger: "You shoulder your pack." } satisfies NarrationIntent,
      },
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
    await runner.run(ctx);

    // Public NPC speech is now DM-owned: NO raw dialogue bubble is emitted — the reply lands as a beat
    // on the turn outcome and is woven into the GM's brief, which the DM narrates as staged prose.
    expect(events.some((e) => e.kind === "dialogue")).toBe(false);
    expect(events.some((e) => e.kind === "narration")).toBe(true);

    // Single source: the recorded beat IS the brief's weave-block line (the GM ran AFTER it existed).
    const record = (ctx.data.turnOutcome as { npc: Array<{ dialogue?: string; action?: string }> }).npc;
    expect(record).toHaveLength(1);
    const said = record[0]!.dialogue ?? "";
    expect(said.length).toBeGreaterThan(0);
    const gmBrief = gateway.briefs.find((b) => b.includes(OUTCOME_HDR));
    expect(gmBrief).toBeDefined();
    expect(gmBrief!).toContain(`- ${lyra.name}: said: "${said}"`);
    expect(record[0]!.action).toBeUndefined();
    expect(gmBrief!).not.toContain("opens the sealed gate");
  });

  test("a DETERMINISTIC line still carries the tick's public NPC beats (no model, but nobody is muted)", async () => {
    // The 07-24 wave marked the four bookkeeping successes (equip/unequip/buy/sell) `deterministic`
    // to save a narrator round-trip. That branch skips the BRIEF, which is the only renderer a public
    // NPC beat has — so a world NPC who spoke (or acted) on the same tick was silently dropped from
    // the transcript while their command still committed. The mechanical line must stay byte-true AND
    // the beat must still be heard.
    const playset = await loadExample();
    const model: WorldModel = fromGameState(
      {
        campaignId: playset.campaign.id,
        worldId: playset.world.id,
        partyLocationId: playset.world.locations[0]!.id,
        clock: 0,
        party: ["pc.you"],
        companions: [],
        actors: {},
        quests: {},
        relationships: {},
        autonomy: {},
        flags: {},
      },
      playset.world,
      playset.campaign,
    );
    const gateway = new BriefRecordingGateway();

    const run = async (beats: Array<{ actorId: string; name: string; dialogue?: string; action?: string }>) => {
      const runner = new TickRunner();
      runner.register(new NarrationModule(playset.world, gateway));
      const events: GameEvent[] = [];
      const ctx: TickContext = {
        trigger: { kind: "player", input: "buy a coil of rope from Kessa" },
        model,
        services: { world: playset.world, campaign: playset.campaign, gateway, rng: mulberry32(SEED) },
        recent: [],
        data: {
          narration: {
            trigger: "You buy the Coil of Rope from Kessa for 5 sp.",
            deterministic: true,
          } satisfies NarrationIntent,
          ...(beats.length > 0 ? { turnOutcome: { npc: beats } } : {}),
        },
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
      await runner.run(ctx);
      return events.filter((e) => e.kind === "narration").map((e) => (e as { text: string }).text);
    };

    // A spoken beat AND an action-only beat both survive the short-circuit.
    const withBeats = await run([
      { actorId: "npc.kessa", name: "Kessa", dialogue: "Mind the gate after dark." },
      { actorId: "npc.bett", name: "Bett", action: "moves to head toward the Market Row" },
    ]);
    expect(withBeats).toHaveLength(1);
    expect(withBeats[0]!).toContain("You buy the Coil of Rope from Kessa for 5 sp.");
    expect(withBeats[0]!).toContain("Mind the gate after dark.");
    expect(withBeats[0]!).toContain("Bett moves to head toward the Market Row.");
    // …and no model was called for any of it.
    expect(gateway.briefs).toHaveLength(0);

    // Zero beats ⇒ the bare trigger, byte-identical to the pre-fix emit.
    expect(await run([])).toEqual(["You buy the Coil of Rope from Kessa for 5 sp."]);
  });

  test("an NPC who SPOKE this tick stays on the brief's Present line despite a queued exit (r13)", async () => {
    // The narrate-phase preview applies the queue so a departing NPC is not staged as still here.
    // But autonomy can make an NPC speak AND queue their exit in the same phase — and then the brief
    // said, in the same breath, "deliver this line verbatim" and "this person is elsewhere". r13
    // fixture-work t10: Lys the Quiet spoke a case fact, the preview evicted her, the narrator burned
    // 140 s and returned nothing, and the engine's own beat echo was audited as a castPresence
    // violation. They were here when they spoke.
    const playset = await loadExample();
    const engine = new GameEngine({
      classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(SEED),
    });
    await engine.start();
    const lyra = playset.world.npcs.find((n) => n.id === "npc.lyra")!;
    const elsewhere = playset.world.locations[1]!.id;

    /** Run one narrate tick with Lyra's exit queued, with or without a spoken beat from her. */
    const presentLineWith = async (beats: Array<{ actorId: string; name: string; dialogue: string }>) => {
      const model: WorldModel = fromGameState(engine.getState(), playset.world, playset.campaign);
      const gateway = new BriefRecordingGateway();
      const runner = new TickRunner();
      runner.register(new NarrationModule(playset.world, gateway));
      const events: GameEvent[] = [];
      const ctx: TickContext = {
        trigger: { kind: "player", input: "I listen." },
        model,
        services: { world: playset.world, campaign: playset.campaign, gateway, rng: mulberry32(SEED) },
        recent: [],
        data: {
          narration: { trigger: "You listen." } satisfies NarrationIntent,
          ...(beats.length > 0 ? { turnOutcome: { npc: beats } } : {}),
        },
        queue: [{ type: "moveEntity", entityId: lyra.id, to: elsewhere }],
        enqueue(cmd) {
          ctx.queue.push(cmd);
        },
        apply: (cmd) => applyCommand(model, cmd),
        applySilent: (cmd) => applyCommand(model, cmd),
        dryRun: (cmd) => applyCommand(structuredClone(model), cmd),
        emit: (ev) => events.push({ ...ev, id: `e${events.length}`, at: 0, seq: events.length } as GameEvent),
        state: () => toGameState(model),
      };
      await runner.run(ctx);
      const brief = gateway.briefs.find((b) => b.includes("Present: "))!;
      expect(brief).toBeDefined();
      return brief.split("\n").find((l) => l.startsWith("Present: "))!;
    };

    // Beat-less: the queued exit is previewed exactly as before — she is already gone from the scene.
    expect(await presentLineWith([])).not.toContain(lyra.name);
    // She spoke: the exit still commits, but this turn's brief keeps her where she said it.
    expect(await presentLineWith([{ actorId: lyra.id, name: lyra.name, dialogue: "Mind the gate." }])).toContain(
      lyra.name,
    );
  });

  test("a PRIVATE reply never reaches the GM's weave block", async () => {
    const playset = await loadExample();
    const engine = new GameEngine({
      classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(SEED),
    });
    await engine.start();
    const model: WorldModel = fromGameState(engine.getState(), playset.world, playset.campaign);

    const gateway = new BriefRecordingGateway();
    const lyra = playset.world.npcs.find((n) => n.id === "npc.lyra")!;
    const runner = new TickRunner();
    runner.register(new NarrationModule(playset.world, gateway));
    runner.register(new DialogueModule(new Map([["npc.lyra", new NpcAgent(gateway, lyra)]])));

    const ctx: TickContext = {
      trigger: { kind: "player", input: "psst", toId: "npc.lyra" },
      model,
      services: { world: playset.world, campaign: playset.campaign, gateway, rng: mulberry32(SEED) },
      recent: [],
      data: {
        dialogue: { npcId: "npc.lyra", playerLine: "psst", channel: "private" } satisfies DialogueIntent,
        narration: { trigger: "You lean in." } satisfies NarrationIntent,
      },
      queue: [],
      enqueue(cmd) {
        ctx.queue.push(cmd);
      },
      apply: (cmd) => applyCommand(model, cmd),
      applySilent: (cmd) => applyCommand(model, cmd),
      dryRun: (cmd) => applyCommand(structuredClone(model), cmd),
      emit() {},
      state: () => toGameState(model),
    };
    await runner.run(ctx);

    expect(ctx.data.turnOutcome).toBeUndefined(); // structurally invisible, like all private lines
    expect(gateway.briefs.every((b) => !b.includes(OUTCOME_HDR))).toBe(true);
  });
});

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

describe("summarizeCommand — attempt phrasing + resolved names (never canonized, never raw ids)", () => {
  test("a grounded give renders the item DISPLAY name as an ATTEMPT, not the raw id nor a completed fact", async () => {
    const playset = await loadExample();
    const ctx = { model: { entities: new Map([["npc.bett", { name: "Bett" }]]) } } as unknown as TickContext;

    const give = summarizeCommand({ type: "transferItem", itemId: "weapon.dagger", from: "npc.lyra", to: "npc.bett" }, ctx, playset.world);
    expect(give).toBe("offers Dagger to Bett"); // masterlist display name, recipient name, INTENT verb
    expect(give).not.toContain("weapon.dagger"); // no internal id leaks into the authoritative brief
    expect(give).not.toContain("handed over"); // not a completed fact — commit may still reject

    const move = summarizeCommand({ type: "moveEntity", entityId: "npc.lyra", to: "loc.square" }, ctx, playset.world);
    expect(move).toContain("moves to head toward"); // an attempt, not "arrived"
    expect(move).toContain(playset.world.locations.find((l) => l.id === "loc.square")!.name);

    const warm = summarizeCommand({ type: "adjustRelationship", actorId: "npc.lyra", targetId: "pc.you", by: 2 }, ctx, playset.world);
    expect(warm).toBe("makes a warm gesture");
  });
});

describe("engine transcript order — NPC lines and event beats print BEFORE GM prose", () => {
  test("a prebaked narrate-beat lands before the GM's movement narration", async () => {
    const playset = structuredClone(await loadExample());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.bell",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "narrate", text: "EVENT-BEAT: a bell tolls." }],
        once: "campaign",
      }),
    );
    const scripted: TurnClassifier = {
      classify: async () => planOf({ kind: "movement", destinationLocationId: "loc.square" }),
    };
    const engine = new GameEngine({
      classifier: scripted,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(SEED),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();
    events.length = 0;

    await engine.submitPlayerInput("go to the square");
    const narrations = events.filter((e) => e.kind === "narration") as Extract<GameEvent, { kind: "narration" }>[];
    expect(narrations.length).toBeGreaterThanOrEqual(2);
    expect(narrations[0]!.text).toBe("EVENT-BEAT: a bell tolls."); // the beat FIRST
    expect(narrations[narrations.length - 1]!.text).not.toContain("EVENT-BEAT"); // GM prose last
  });

  test("the event beat reaches the GM's brief so its last-word prose can't contradict it", async () => {
    const playset = structuredClone(await loadExample());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.bell",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "narrate", text: "EVENT-BEAT: a bell tolls." }],
        once: "campaign",
      }),
    );
    const gateway = new BriefRecordingGateway();
    const engine = new GameEngine({
      classifier: { classify: async () => planOf({ kind: "movement", destinationLocationId: "loc.square" }) },
      playset,
      store: new InMemoryGameStateStore(),
      gateway,
      rng: mulberry32(SEED),
    });
    await engine.start();
    gateway.briefs.length = 0;

    await engine.submitPlayerInput("go to the square");
    const brief = gateway.briefs.find((b) => b.includes(EVENTS_HDR));
    expect(brief).toBeDefined(); // the GM ran LAST with the already-shown beat in hand
    expect(brief!).toContain("- EVENT-BEAT: a bell tolls.");
  });

  test("a public reply from a location NPC is DM-narrated — a beat, not a raw bubble", async () => {
    const playset = await loadExample();
    const beats: TraceBeat[] = [];
    const engine = new GameEngine({
      classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(SEED),
      onTurnTrace: (t) => {
        if (t.npcBeats) beats.push(...t.npcBeats);
      },
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();
    events.length = 0;
    beats.length = 0;

    await engine.submitPlayerInput("Brann, heard anything from the east road?");
    // No raw "Brann: …" bubble — the public reply is a beat the DM weaves into staged prose.
    expect(events.some((e) => e.kind === "dialogue" && e.actorId === "npc.brann")).toBe(false);
    expect(beats.some((b) => b.actorId === "npc.brann" && (b.dialogue?.length ?? 0) > 0)).toBe(true);
    expect(events.some((e) => e.kind === "narration")).toBe(true); // the DM ran and delivered the words
  });
});
