/**
 * First-observation NPC profiles (Workstream A, slim slice) — the NpcProfileModule.
 *
 * A runtime-spawned NPC gets its deterministic seeded profile recorded (enrichNpc
 * promote:false) on the first tick it shares a location with the party: identity binds at
 * first sight, LLM-free, while the entity stays transient and cullable. Authored NPCs and
 * monsters are never profiled; the profile survives reloads through the enrichment slice +
 * hydrated mirror; the same seed replays the same profile byte-for-byte.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { NpcTemplateSchema, PrebakedEventSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { enrichmentsOf } from "../src/world/enrichment.ts";
import { MINOR_SAFETY_REFUSAL } from "../src/llm/safety.ts";
import { makeSaveKey } from "../src/state/store.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { ChatMessage, CompletionChunk, CompletionRequest, LlmRole } from "../src/llm/types.ts";
import { loadExample, SEED, type TraceBeat } from "./support/harness.ts";

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

/** Classifier scripted per-call — each submitted input consumes the next plan. */
function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return {
    classify: async () => {
      const plan = plans[Math.min(i, plans.length - 1)] ?? planOf({});
      i += 1;
      return plan;
    },
  };
}

/** Records every narrator-stream SYSTEM prompt (NPC replies ride the narrator role). */
class NpcPromptRecordingGateway implements LlmGateway {
  readonly systems: string[] = [];
  private readonly inner = new OfflineGateway();

  complete(role: LlmRole, req: CompletionRequest) {
    return this.inner.complete(role, req);
  }

  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (role === "narrator") {
      this.systems.push(req.messages.find((m: ChatMessage) => m.role === "system")?.content ?? "");
    }
    yield* this.inner.stream(role, req);
  }

  embed(role: LlmRole, texts: string[]) {
    return this.inner.embed(role, texts);
  }
}

/** Every narrator stream is guard-blocked — the dialogue path must refuse, not reply. */
class BlockingGateway implements LlmGateway {
  private readonly inner = new OfflineGateway();

  complete(role: LlmRole, req: CompletionRequest) {
    return this.inner.complete(role, req);
  }

  async *stream(role: LlmRole, _req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (role === "narrator") {
      yield { delta: "", done: true, blocked: true };
      return;
    }
    yield* this.inner.stream(role, _req);
  }

  embed(role: LlmRole, texts: string[]) {
    return this.inner.embed(role, texts);
  }
}

/** Records the narrator briefs so tests can assert on the `Present:` row. */
class BriefRecordingGateway implements LlmGateway {
  readonly briefs: string[] = [];
  private readonly inner = new OfflineGateway();

  complete(role: LlmRole, req: CompletionRequest) {
    return this.inner.complete(role, req);
  }

  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (role === "narrator") {
      const user = [...req.messages].reverse().find((m: ChatMessage) => m.role === "user")?.content ?? "";
      this.briefs.push(user);
    }
    yield* this.inner.stream(role, req);
  }

  embed(role: LlmRole, texts: string[]) {
    return this.inner.embed(role, texts);
  }
}

/** Example world + a prebaked event spawning a runtime NPC extra in the square. */
function withWatchSpawn(
  playset: PlaySet,
  tier: "transient" | "tracked" = "transient",
  once: "campaign" | "visit" = "campaign",
): PlaySet {
  const out = structuredClone(playset);
  out.world.npcs.push(
    NpcTemplateSchema.parse({
      id: "npc.watch",
      name: "Square Watcher",
      persona: "Eyes on everything.",
      stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 8, armorClass: 10 },
    }),
  );
  out.campaign.events.push(
    PrebakedEventSchema.parse({
      id: "ev.watch",
      when: "onEnterLocation",
      trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
      effects: [{ kind: "spawn", templateId: "npc.watch", locationId: "loc.square", tier }],
      once,
    }),
  );
  return out;
}

async function makeEngine(playset: PlaySet, classifier: TurnClassifier, gateway?: LlmGateway, store?: InMemoryGameStateStore) {
  const beats: TraceBeat[] = [];
  const engine = new GameEngine({
    playset,
    store: store ?? new InMemoryGameStateStore(),
    gateway: gateway ?? new OfflineGateway(),
    classifier,
    rng: mulberry32(SEED),
    onTurnTrace: (t) => {
      if (t.npcBeats) beats.push(...t.npcBeats);
    },
  });
  const events: GameEvent[] = [];
  engine.subscribe((event) => events.push(event));
  await engine.start();
  events.length = 0;
  return { engine, events, beats };
}

const kinds = (events: GameEvent[], kind: GameEvent["kind"]) => events.filter((e) => e.kind === kind);

describe("NpcProfileModule — identity binds at first observation", () => {
  test("an event-spawned NPC is profiled on the next shared tick: slice + mirror, tier untouched", async () => {
    const playset = withWatchSpawn(await loadExample());
    const gateway = new BriefRecordingGateway();
    const { engine, events } = await makeEngine(
      playset,
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // spawn enqueued, commits
        planOf({ kind: "freeformNarrative" }), // first shared tick — the profile lands
        planOf({ kind: "freeformNarrative" }), // brief now carries the profiled summary
      ]),
      gateway,
    );

    await engine.submitPlayerInput("head to the square");
    expect(kinds(events, "entitySpawned")).toHaveLength(1);
    expect(kinds(events, "npcEnriched")).toHaveLength(0); // spawn commits at tick end — not yet seen

    await engine.submitPlayerInput("I look around");
    const enriched = kinds(events, "npcEnriched") as Extract<GameEvent, { kind: "npcEnriched" }>[];
    expect(enriched).toHaveLength(1);
    expect(enriched[0]!.npcId).toBe("npc.watch#0");
    expect(enriched[0]!.template.id).toBe("npc.watch#0"); // named for THIS individual
    expect(enriched[0]!.template.persona).toBe("Eyes on everything."); // authored base seeds the floor
    expect(enriched[0]!.template.age).toBeGreaterThanOrEqual(19); // explicit 18+ age at first sight
    expect(kinds(events, "tierChanged")).toHaveLength(0); // promote:false — still a cullable extra

    // Durable slice + content mirror both hold the profile.
    expect(enrichmentsOf(engine.getState().modules)["npc.watch#0"]).toEqual(enriched[0]!.template);
    expect(playset.world.npcs.find((n) => n.id === "npc.watch#0")).toEqual(enriched[0]!.template);

    // The narrator brief's Present: row now carries the profiled summary.
    await engine.submitPlayerInput("I take stock of who is here");
    const brief = gateway.briefs.at(-1) ?? "";
    const presentLine = brief.split("\n").find((l) => l.startsWith("Present:")) ?? "";
    expect(presentLine).toContain("Square Watcher");
    expect(presentLine).toContain(enriched[0]!.template.summary);

    // Observation alone never promotes and never re-fires — the record stands, quietly.
    expect(kinds(events, "npcEnriched")).toHaveLength(1);
  });

  test("authored location NPCs and monsters are never profiled", async () => {
    const playset = structuredClone(await loadExample());
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.stalker",
        when: "onEnterLocation",
        trigger: { allOf: [{ kind: "atLocation", locationId: "loc.square" }] },
        effects: [{ kind: "spawn", templateId: "mon.ashstalker", locationId: "loc.square", tier: "transient" }],
        once: "campaign",
      }),
    );
    const { engine, events } = await makeEngine(
      playset,
      scriptedClassifier([
        planOf({ kind: "freeformNarrative" }), // colocated with authored NPCs at the start
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // monster spawns
        planOf({ kind: "freeformNarrative" }), // shared tick with the monster
      ]),
    );

    await engine.submitPlayerInput("I look around the tavern");
    expect(kinds(events, "npcEnriched")).toHaveLength(0); // authored NPCs stand unprofiled

    await engine.submitPlayerInput("to the square");
    await engine.submitPlayerInput("I look around");
    expect(kinds(events, "npcEnriched")).toHaveLength(0); // monsters are excluded by kind
    expect(enrichmentsOf(engine.getState().modules)).toEqual({});
  });

  test("culling still despawns a profiled transient — protection stays tier-based", async () => {
    const playset = withWatchSpawn(await loadExample(), "transient");
    const { engine, events } = await makeEngine(
      playset,
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }),
        planOf({ kind: "freeformNarrative" }), // profile lands
        planOf({ kind: "movement", destinationLocationId: "loc.tavern" }), // party leaves — cull
      ]),
    );

    await engine.submitPlayerInput("to the square");
    await engine.submitPlayerInput("I nod to the watcher");
    expect(kinds(events, "npcEnriched")).toHaveLength(1);

    await engine.submitPlayerInput("back to the tavern");
    const despawned = kinds(events, "entityDespawned") as Extract<GameEvent, { kind: "entityDespawned" }>[];
    expect(despawned.map((d) => d.entityId)).toContain("npc.watch#0");
    // The profile RECORD survives the body — the same id re-spawned is the same watcher.
    expect(enrichmentsOf(engine.getState().modules)["npc.watch#0"]).toBeDefined();
  });

  test("reload hydrates the mirror: the profiled template survives a process restart verbatim", async () => {
    const store = new InMemoryGameStateStore();
    const playset = withWatchSpawn(await loadExample(), "tracked");
    const { engine, events } = await makeEngine(
      playset,
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }),
        planOf({ kind: "freeformNarrative" }),
      ]),
      undefined,
      store,
    );
    await engine.submitPlayerInput("to the square");
    await engine.submitPlayerInput("I look around");
    const recorded = (kinds(events, "npcEnriched") as Extract<GameEvent, { kind: "npcEnriched" }>[])[0]!.template;

    // A fresh process: same store, freshly-loaded authored content (no drifter in it).
    const freshPlayset = withWatchSpawn(await loadExample(), "tracked");
    expect(freshPlayset.world.npcs.some((n) => n.id === "npc.watch#0")).toBe(false);
    const second = await makeEngine(freshPlayset, scriptedClassifier([planOf({})]), undefined, store);

    expect(freshPlayset.world.npcs.find((n) => n.id === "npc.watch#0")).toEqual(recorded);
    expect(enrichmentsOf(second.engine.getState().modules)["npc.watch#0"]).toEqual(recorded);
    // No re-profiling fires on the reloaded run — the record already stands.
    await second.engine.submitPlayerInput("I wait");
    expect(kinds(second.events, "npcEnriched")).toHaveLength(0);
  });

  test("public address reaches the profiled NPC: in-character reply, profile identity in the prompt", async () => {
    const playset = withWatchSpawn(await loadExample());
    const gateway = new NpcPromptRecordingGateway();
    const { engine, events, beats } = await makeEngine(
      playset,
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }),
        planOf({ kind: "freeformNarrative" }), // profile lands
        planOf({ kind: "dialogueToNpc", targetId: "npc.watch#0" }), // PUBLIC address
      ]),
      gateway,
    );
    await engine.submitPlayerInput("to the square");
    await engine.submitPlayerInput("I look around");
    const profile = enrichmentsOf(engine.getState().modules)["npc.watch#0"]!;

    beats.length = 0;
    await engine.submitPlayerInput("Watcher, what have you seen tonight?");
    // A public NPC reply is now a DM-narrated beat, not a raw dialogue bubble.
    const reply = beats.find((b) => b.actorId === "npc.watch#0");
    expect(reply).toBeDefined(); // a real agent reply, not GM ventriloquism
    // public — everyone hears it: no private dialogue event carries it.
    const priv = (kinds(events, "dialogue") as Extract<GameEvent, { kind: "dialogue" }>[]).find(
      (l) => l.actorId === "npc.watch#0",
    );
    expect(priv).toBeUndefined();
    expect((reply!.dialogue?.length ?? 0)).toBeGreaterThan(0);

    // The ephemeral agent spoke FROM the recorded profile: its identity reached the prompt.
    const system = gateway.systems.find((s) => s.includes("You are Square Watcher"));
    expect(system).toBeDefined();
    expect(system!).toContain(`You are ${profile.age} years old.`);
    expect(system!).toContain(`Your place: ${profile.socialRole}.`);
    expect(system!).toContain("Your manner of speech:");
    expect(system!).toContain(`What others see: ${profile.description}`);
    expect(system!).not.toContain(profile.hiddenLore); // the GM-only truth stays out
  });

  test("an ungrounded line stays GM-narrated; a minor-safety block refuses with no reply", async () => {
    const playset = withWatchSpawn(await loadExample());
    const { engine, events } = await makeEngine(
      playset,
      scriptedClassifier([planOf({ kind: "dialogueToNpc", targetId: null })]),
    );
    await engine.submitPlayerInput("Is anyone out there?");
    const lines = kinds(events, "dialogue") as Extract<GameEvent, { kind: "dialogue" }>[];
    expect(lines.map((l) => l.actorId)).toEqual(["pc.you"]); // no NPC grounds ⇒ the GM voices it
    expect(kinds(events, "narration").length).toBeGreaterThanOrEqual(1);

    // The one hard line, unchanged on the public path: a blocked reply is a firm OOC refusal.
    const blocked = await makeEngine(
      withWatchSpawn(await loadExample()),
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }),
        planOf({ kind: "freeformNarrative" }),
        planOf({ kind: "dialogueToNpc", targetId: "npc.watch#0" }),
      ]),
      new BlockingGateway(),
    );
    await blocked.engine.submitPlayerInput("to the square");
    await blocked.engine.submitPlayerInput("I look around");
    blocked.events.length = 0;
    await blocked.engine.submitPlayerInput("Watcher, come closer.");
    const replies = (kinds(blocked.events, "dialogue") as Extract<GameEvent, { kind: "dialogue" }>[]).filter(
      (l) => l.actorId === "npc.watch#0",
    );
    expect(replies).toHaveLength(0); // no reply text ever reaches the player
    const warns = kinds(blocked.events, "system") as Extract<GameEvent, { kind: "system" }>[];
    expect(warns.some((w) => w.message === MINOR_SAFETY_REFUSAL)).toBe(true);
  });

  test("a re-spawned id REBINDS its recorded profile — the same guard returns (continuity contract)", async () => {
    // once:"visit" re-fires on re-entry; the suffix probe reuses the freed #0 id.
    const playset = withWatchSpawn(await loadExample(), "transient", "visit");
    const gateway = new NpcPromptRecordingGateway();
    const { engine, events } = await makeEngine(
      playset,
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // spawn #0
        planOf({ kind: "freeformNarrative" }), // profile lands, templateId → npc.watch#0
        planOf({ kind: "movement", destinationLocationId: "loc.tavern" }), // cull despawns the body
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // visit beat re-fires: NEW npc.watch#0, templateId back to npc.watch
        planOf({ kind: "freeformNarrative" }), // the rebind tick
        planOf({ kind: "dialogueToNpc", targetId: "npc.watch#0" }),
      ]),
      gateway,
    );

    await engine.submitPlayerInput("to the square");
    await engine.submitPlayerInput("I look around");
    const first = (kinds(events, "npcEnriched") as Extract<GameEvent, { kind: "npcEnriched" }>[])[0]!;

    await engine.submitPlayerInput("back to the tavern");
    expect((kinds(events, "entityDespawned") as Extract<GameEvent, { kind: "entityDespawned" }>[]).map((d) => d.entityId)).toContain("npc.watch#0");

    await engine.submitPlayerInput("to the square again");
    expect(kinds(events, "entitySpawned")).toHaveLength(2); // the id was reused for a fresh body

    await engine.submitPlayerInput("I look around");
    const enriched = kinds(events, "npcEnriched") as Extract<GameEvent, { kind: "npcEnriched" }>[];
    expect(enriched).toHaveLength(2); // the rebind re-applied the RECORDED template
    expect(JSON.stringify(enriched[1]!.template)).toBe(JSON.stringify(first.template)); // verbatim — nobody new
    expect(kinds(events, "tierChanged")).toHaveLength(0); // still promote:false

    // And the returned guard SPEAKS from the recorded profile, not the shared authored template.
    await engine.submitPlayerInput("Watcher, you again?");
    const system = gateway.systems.find((s) => s.includes("You are Square Watcher"));
    expect(system).toBeDefined();
    expect(system!).toContain(`You are ${first.template.age} years old.`);
    expect(system!).toContain(`Your place: ${first.template.socialRole}.`);
  });

  test("a downed NPC gives NO in-character reply — the GM narrates the silence instead", async () => {
    const playset = withWatchSpawn(await loadExample(), "tracked");
    // ev.watch also raises a flag at first firing; ev.kill downs the watcher on a LATER entry.
    playset.campaign.events[playset.campaign.events.length - 1]!.effects.push({
      kind: "setFlag",
      key: "watcherSpawned",
    } as never);
    playset.campaign.events.push(
      PrebakedEventSchema.parse({
        id: "ev.kill",
        when: "onEnterLocation",
        trigger: {
          allOf: [
            { kind: "atLocation", locationId: "loc.square" },
            { kind: "flag", key: "watcherSpawned" },
          ],
        },
        effects: [{ kind: "adjustHp", entityId: "npc.watch#0", by: -999 }],
        once: "campaign",
      }),
    );
    const { engine, events } = await makeEngine(
      playset,
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // spawn + flag
        planOf({ kind: "freeformNarrative" }), // profile
        planOf({ kind: "movement", destinationLocationId: "loc.tavern" }),
        planOf({ kind: "movement", destinationLocationId: "loc.square" }), // ev.kill downs the watcher
        planOf({ kind: "dialogueToNpc", targetId: "npc.watch#0" }), // talking to a body
      ]),
    );
    await engine.submitPlayerInput("to the square");
    await engine.submitPlayerInput("I look around");
    await engine.submitPlayerInput("to the tavern");
    await engine.submitPlayerInput("back to the square");
    const downed = (kinds(events, "hpChanged") as Extract<GameEvent, { kind: "hpChanged" }>[]).find(
      (h) => h.entityId === "npc.watch#0",
    );
    expect(downed).toBeDefined();

    events.length = 0;
    await engine.submitPlayerInput("Watcher, who did this to you?");
    const replies = (kinds(events, "dialogue") as Extract<GameEvent, { kind: "dialogue" }>[]).filter(
      (l) => l.actorId === "npc.watch#0",
    );
    expect(replies).toHaveLength(0); // a corpse must not chat
    expect(kinds(events, "narration").length).toBeGreaterThanOrEqual(1); // the GM voices the scene

    // The SAME invariant on the PRIVATE (click-to-chat) path: a downed NPC never answers an aside.
    events.length = 0;
    await engine.submitPlayerInput("psst, are you alive?", { toId: "npc.watch#0" });
    const privateReplies = (kinds(events, "dialogue") as Extract<GameEvent, { kind: "dialogue" }>[]).filter(
      (l) => l.actorId === "npc.watch#0",
    );
    expect(privateReplies).toHaveLength(0); // no whispered reply from a body either
    const undelivered = (kinds(events, "system") as Extract<GameEvent, { kind: "system" }>[]).some(
      (s) => "code" in s && s.code === "private-undelivered",
    );
    expect(undelivered).toBe(true); // the aside goes unspoken, same as an absent target
  });

  test("a profile applied on a HEARTBEAT tick persists (snapshot, not just the event log)", async () => {
    const store = new InMemoryGameStateStore();
    const playset = withWatchSpawn(await loadExample(), "tracked");
    const { engine } = await makeEngine(
      playset,
      scriptedClassifier([planOf({ kind: "movement", destinationLocationId: "loc.square" })]),
      undefined,
      store,
    );
    await engine.submitPlayerInput("to the square"); // spawn commits at tick end — no profile yet
    expect(enrichmentsOf(engine.getState().modules)["npc.watch#0"]).toBeUndefined();

    await engine.tickHeartbeat("npc.lyra"); // the profile lands on a heartbeat tick
    expect(enrichmentsOf(engine.getState().modules)["npc.watch#0"]).toBeDefined();
    // The SNAPSHOT persisted it — a crash before the next player turn loses nothing.
    const saved = await store.load(makeSaveKey(playset.campaign.id, "pc.you"));
    expect(enrichmentsOf(saved?.modules)["npc.watch#0"]).toBeDefined();
  });

  test("promotion deepening EVICTS the cached ephemeral reply agent (no stale voice after release)", async () => {
    // A creative-role gateway that deepens lore on promotion; narrator streams record prompts.
    class DeepeningGateway extends NpcPromptRecordingGateway {
      override complete(role: LlmRole, req: CompletionRequest) {
        if (role === "creative") {
          return Promise.resolve({
            text: JSON.stringify({ knownLore: "DEEPENED-AFTER-JOIN" }),
            model: "scripted-live",
          });
        }
        return super.complete(role, req);
      }
    }
    const playset = withWatchSpawn(await loadExample(), "tracked");
    const gateway = new DeepeningGateway();
    const { engine, events } = await makeEngine(
      playset,
      scriptedClassifier([
        planOf({ kind: "movement", destinationLocationId: "loc.square" }),
        planOf({ kind: "freeformNarrative" }), // profile lands
        planOf({ kind: "dialogueToNpc", targetId: "npc.watch#0" }), // caches the ephemeral agent (floor lore)
        planOf({ kind: "partyAction", party: { verb: "invite", targetId: "npc.watch#0" } }), // deepen + promote
        planOf({ kind: "partyAction", party: { verb: "leave", targetId: "npc.watch#0" } }), // companion agent dropped
        planOf({ kind: "dialogueToNpc", targetId: "npc.watch#0" }), // must speak with the DEEPENED template
      ]),
      gateway,
    );
    await engine.submitPlayerInput("to the square");
    await engine.submitPlayerInput("I look around");
    await engine.submitPlayerInput("Watcher, seen anything?");
    expect(gateway.systems.some((s) => s.includes("You are Square Watcher"))).toBe(true);

    await engine.submitPlayerInput("Watcher, join us");
    const recorded = enrichmentsOf(engine.getState().modules)["npc.watch#0"];
    expect(recorded?.knownLore).toBe("DEEPENED-AFTER-JOIN"); // seeded stance roll accepts — deterministic
    await engine.submitPlayerInput("Watcher, you're free to go");
    expect((kinds(events, "stateChanged") as Extract<GameEvent, { kind: "stateChanged" }>[]).some((e) => e.summary.includes("part ways"))).toBe(true);

    gateway.systems.length = 0;
    await engine.submitPlayerInput("Watcher, one more question");
    const system = gateway.systems.find((s) => s.includes("You are Square Watcher"));
    expect(system).toBeDefined();
    expect(system!).toContain("DEEPENED-AFTER-JOIN"); // fresh agent from the enriched mirror, not the stale cache
  });

  test("same seed, fresh run ⇒ the identical npcEnriched payload (doc acceptance)", async () => {
    const run = async () => {
      const playset = withWatchSpawn(await loadExample());
      const { engine, events } = await makeEngine(
        playset,
        scriptedClassifier([
          planOf({ kind: "movement", destinationLocationId: "loc.square" }),
          planOf({ kind: "freeformNarrative" }),
        ]),
      );
      await engine.submitPlayerInput("to the square");
      await engine.submitPlayerInput("I look around");
      return (kinds(events, "npcEnriched") as Extract<GameEvent, { kind: "npcEnriched" }>[])[0]!.template;
    };
    const [a, b] = [await run(), await run()];
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
