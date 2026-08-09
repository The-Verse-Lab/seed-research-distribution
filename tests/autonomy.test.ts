/**
 * Autonomy integration tests — the Director (AutonomyModule) on a live, offline, seeded engine.
 *
 * These exercise the whole heartbeat/react/narrate path end-to-end against the bundled thistledown
 * world (companions: Maelle = leader, Dorran = reactive). Everything is deterministic: the offline
 * gateway, a fixed `mulberry32(42)` RNG, and an in-memory store. The contract under test is the
 * never-stall guarantee (a heartbeat resolves in ms and never throws) plus the A>B>C gates:
 * talk-lock, reply-chain decay, dedup, leader proposals, and tacit consent (docs/PROACTIVE-NPCS).
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { mulberry32, type Rng } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { NpcAgent, scrubSelfNarration, spokenLineOf } from "../src/agents/npc.ts";
import {
  AutonomyModule,
  resolveBarrierAttempt,
  WORLD_NPC_DEDUP_MS,
  type AutonomyDialogueItem,
} from "../src/modules/autonomy/module.ts";
import { HeartbeatScheduler } from "../src/director/heartbeat.ts";
import type { GroundedAction } from "../src/modules/autonomy/grounding.ts";
import type { AutonomyRuntime, GameState } from "../src/state/types.ts";
import type { EmittedEvent, GameEvent } from "../src/events/types.ts";
import { byKind, LeaderPlanGateway, loadThistledown, type TraceBeat } from "./support/harness.ts";
import { CampaignSchema, WorldSchema, type AutonomyLevel, type PlaySet } from "../src/content/schema.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import { applyCommand } from "../src/world/reducer.ts";
import type { TickContext, TickTrigger } from "../src/engine/tick.ts";
import type { Command } from "../src/world/commands.ts";

const SEED = 42;

interface Built {
  engine: GameEngine;
  events: GameEvent[];
  /** Public NPC beats across turns — the observable for DM-owned public speech. */
  beats: TraceBeat[];
  store: InMemoryGameStateStore;
  playset: PlaySet;
}

/**
 * A started thistledown engine. `mutateState` (optional) white-box-patches the loaded snapshot
 * (autonomy bookkeeping) before start; `mutatePlayset` (optional) tweaks the content (e.g. an
 * NPC's autonomy level) before construction.
 */
async function build(opts: {
  mutateState?: (s: GameState) => void;
  mutatePlayset?: (p: PlaySet) => void;
  rng?: Rng;
  /** Script the NPC's own turn intent — the only way to exercise the proposal path, which now
   *  requires a closed `act` that GROUNDS to a real command (advice stays plain dialogue). */
  gateway?: OfflineGateway;
} = {}): Promise<Built> {
  const playset = await loadThistledown();
  opts.mutatePlayset?.(playset);

  const store = new InMemoryGameStateStore();
  if (opts.mutateState) {
    // Produce a valid baseline snapshot from a throwaway engine, patch it, and seed the store so
    // the real engine loads our doctored autonomy state on start().
    const seed = new GameEngine({ classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(SEED),
    });
    await seed.start();
    const snapshot = seed.getState();
    opts.mutateState(snapshot);
    await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), snapshot);
  }

  const beats: TraceBeat[] = [];
  const engine = new GameEngine({ classifier: heuristicClassifier,
    playset,
    store,
    gateway: opts.gateway ?? new OfflineGateway(),
    rng: opts.rng ?? mulberry32(SEED),
    onTurnTrace: (t) => {
      if (t.npcBeats) beats.push(...t.npcBeats);
    },
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  return { engine, events, beats, store, playset };
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

describe("autonomy Director — heartbeat gates", () => {
  test("(9) a held talk-lock suppresses the heartbeat (no dialogue, no proposal)", async () => {
    const { engine, events } = await build({
      mutateState: (s) => setAutonomy(s, "npc.maelle", { talking: true }),
    });
    events.length = 0;
    await engine.tickHeartbeat("npc.maelle");
    expect(byKind(events, "dialogue").length).toBe(0);
    expect(byKind(events, "npcProposal").length).toBe(0);
  });

  test("(10) a passive / non-companion NPC heartbeat does nothing", async () => {
    const { engine, events } = await build();
    events.length = 0;
    // Bett is passive and not a companion — she has no agent and never self-initiates.
    await engine.tickHeartbeat("npc.bett");
    expect(events.length).toBe(0);
  });

  test("(11) a proactive companion's heartbeat self-initiates a dialogue line", async () => {
    const { engine, events, beats } = await build({
      // Promote Dorran to `proactive` so a heartbeat adds priority C (a spoken line, not a
      // leader proposal). Offline `decide()` yields prose that grounds to a safe speak.
      mutatePlayset: (p) => {
        const dorran = p.world.npcs.find((n) => n.id === "npc.dorran");
        if (dorran) dorran.autonomy.level = "proactive";
      },
    });
    events.length = 0;
    beats.length = 0;
    await engine.tickHeartbeat("npc.dorran");
    // A spontaneous PUBLIC line is a DM-narrated beat now, not a raw dialogue bubble.
    const lines = beats.filter((b) => b.actorId === "npc.dorran");
    expect(lines.length).toBe(1);
    expect((lines[0]?.dialogue ?? "").length).toBeGreaterThan(0);
  });

  test("(13b) the idle budget: two unprompted quiet beats, then silence until the player speaks (r9 F-12)", async () => {
    // Decay alone never STOPS a chain before depth 6 — a failed roll just re-rolls on the next
    // 40s heartbeat, so an idle player got five long re-stagings of the same scene. Hard cap: 2.
    const { engine, beats } = await build({
      mutatePlayset: (p) => {
        const dorran = p.world.npcs.find((n) => n.id === "npc.dorran");
        if (dorran) dorran.autonomy.level = "proactive";
      },
    });
    beats.length = 0;
    for (let i = 0; i < 6; i++) await engine.tickHeartbeat("npc.dorran");
    expect(beats.filter((b) => b.actorId === "npc.dorran").length).toBeLessThanOrEqual(2);
    // Player input reopens the budget: the companion may speak again after.
    await engine.submitPlayerInput("Dorran, talk to me.");
    beats.length = 0;
    await engine.tickHeartbeat("npc.dorran");
    expect(beats.filter((b) => b.actorId === "npc.dorran").length).toBeLessThanOrEqual(1);
  });

  test("(13) a long reply chain (depth 6) stays silent on a heartbeat", async () => {
    const { engine, events } = await build({
      mutateState: (s) => setAutonomy(s, "npc.maelle", { replyDepth: 6 }),
    });
    events.length = 0;
    await engine.tickHeartbeat("npc.maelle");
    expect(byKind(events, "dialogue").length).toBe(0);
    expect(byKind(events, "npcProposal").length).toBe(0);
  });
});

describe("autonomy Director — priority A (player override)", () => {
  test("(12) player input resets a companion's reply-chain depth to 0", async () => {
    const { engine } = await build({
      mutateState: (s) => setAutonomy(s, "npc.maelle", { replyDepth: 5 }),
    });
    expect(engine.getState().autonomy["npc.maelle"]?.replyDepth).toBe(5);
    // A non-addressing line: core resets every companion's depth; no priority-B reaction fires.
    await engine.submitPlayerInput("I look around the room.");
    expect(engine.getState().autonomy["npc.maelle"]?.replyDepth).toBe(0);
  });
});

describe("autonomy Director — priority B (reactive chime-in)", () => {
  test("(B1) addressing a companion does NOT always make a second one chime in", async () => {
    // rng forced high → the priority-B probability gate fails: only the addressed companion replies.
    // Public NPC lines are DM-narrated beats now, not raw dialogue bubbles.
    const { engine, beats } = await build({ rng: () => 0.99 });
    beats.length = 0;
    await engine.submitPlayerInput("Maelle, what should we do?");
    expect(beats.some((b) => b.actorId === "npc.maelle")).toBe(true);
    expect(beats.some((b) => b.actorId === "npc.dorran")).toBe(false);
  });

  test("(B2) a present ally still chimes in when the gate passes", async () => {
    // rng forced low → the gate passes: the addressed companion's ally (Dorran) reacts too.
    const { engine, beats } = await build({ rng: () => 0 });
    beats.length = 0;
    await engine.submitPlayerInput("Maelle, what should we do?");
    expect(beats.some((b) => b.actorId === "npc.dorran")).toBe(true);
  });
});

describe("autonomy Director — leadership", () => {
  test("(14) a leader companion's heartbeat emits exactly one proposal when it has a real plan", async () => {
    const { engine, events } = await build({
      gateway: new LeaderPlanGateway({
        act: { do: "move", target: "loc.green" },
        visibleSpeech: "We make for the green while the light holds.",
      }),
    });
    events.length = 0;
    await engine.tickHeartbeat("npc.maelle"); // Maelle is the leader
    expect(byKind(events, "npcProposal").length).toBe(1);
    const prop = byKind(events, "npcProposal")[0];
    expect(prop?.actorId).toBe("npc.maelle");
    // The card has teeth: accepting it (or tacit consent) has a command to run.
    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal?.commands.length).toBeGreaterThan(0);
  });

  test("(14b) a leader whose beat is only WORDS speaks — no empty AGREE/DECLINE card", async () => {
    // The 2026-07-24 playtest's churn: `priority === "C"` short-circuited the grounding test, so
    // every spontaneous beat became a card — three "be careful" prompts in a row mid-march, each
    // carrying `commands: []`, so answering one changed nothing. Advice is dialogue.
    const { engine, events } = await build({
      gateway: new LeaderPlanGateway({
        act: { do: "none" },
        visibleSpeech: "Keep your spacing on the road, and mind the cairns.",
      }),
    });
    events.length = 0;
    await engine.tickHeartbeat("npc.maelle");
    expect(byKind(events, "npcProposal")).toHaveLength(0);
    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal).toBeUndefined();
  });

  test("(14c) the proposal cooldown counts IN-WORLD minutes, so a slow model cannot burn it", async () => {
    // The cooldown was wall-clock (3 × the 40s heartbeat = 120s) — shorter than one narrated turn on
    // a reasoning model, so it expired for free while the player read and typed. It now counts the
    // campaign clock, which only advances on the player's own turns.
    const { engine, events } = await build({
      gateway: new LeaderPlanGateway({
        act: { do: "move", target: "loc.green" },
        visibleSpeech: "We make for the green while the light holds.",
      }),
      mutateState: (s) => setAutonomy(s, "npc.maelle", { lastProposedClock: s.clock }),
    });
    events.length = 0;
    await engine.tickHeartbeat("npc.maelle");
    expect(byKind(events, "npcProposal")).toHaveLength(0);
  });

  test("(14d) the proposal path being closed never lets a leader's move EXECUTE directly", async () => {
    // Playtest r9 (2026-07-31), F-1: with a proposal pending (or the cooldown holding), `propose`
    // is false — and the grounded `moveParty` used to fall through to the direct-act branch and
    // enqueue for real on a heartbeat. Two silent party relocations and an auto-completed quest
    // objective while the player idled. The only surface allowed to move the party is a movement
    // the player CHOSE: same rule as tacit consent (test 15). The urge stays a spoken nudge.
    const { engine, events, beats } = await build({
      gateway: new LeaderPlanGateway({
        act: { do: "move", target: "loc.green" },
        visibleSpeech: "Daylight's not a thing to waste — we should move.",
      }),
      // Cooldown active ⇒ propose=false ⇒ the old code path executed the move directly.
      mutateState: (s) => setAutonomy(s, "npc.maelle", { lastProposedClock: s.clock }),
    });
    events.length = 0;
    await engine.tickHeartbeat("npc.maelle");
    // Nobody moves on a heartbeat — not the PC, not the party, not the leader via moveParty.
    expect(byKind(events, "entityMoved")).toHaveLength(0);
    // And no proposal either (the cooldown holds) — the beat degrades to dialogue, not a card.
    expect(byKind(events, "npcProposal")).toHaveLength(0);
    // The urge is still delivered as words, and the beat records no accepted command.
    const beat = beats.find((b) => b.actorId === "npc.maelle");
    expect(beat?.dialogue ?? "").toContain("we should move");
    expect(beat?.action).toBeUndefined();
  });

  test("(15) tacit consent never MOVES anyone: an expired movement plan nudges, and does not execute", async () => {
    // 2026-07-25 fix wave: silence is not consent to travel. Seven involuntary relocations traced
    // back to exactly this class of stale movement command firing without player input — an
    // expired moveParty/moveEntity plan now narrates a nudge and dies instead of executing.
    const { engine, events } = await build({
      mutateState: (s) =>
        setAutonomy(s, "npc.maelle", {
          // A concrete, legal directive (loc.green is a direct exit from the start, loc.hart),
          // a beat that already elapsed, and a fresh dedup stamp so no *new* proposal competes.
          lastActedAt: Date.now(),
          pendingProposal: {
            commands: [{ type: "moveEntity", entityId: "npc.maelle", to: "loc.green" }],
            expiresAt: Date.now() - 1000,
          },
        }),
    });
    events.length = 0;
    await engine.tickHeartbeat("npc.maelle");
    const moves = byKind(events, "entityMoved").filter((d) => d.entityId === "npc.maelle");
    expect(moves.length).toBe(0); // the movement ban: nobody moves on silence
    // The plan is spent either way — a later heartbeat can't re-consume it.
    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal).toBeUndefined();
  });

  test("(15a) tacit consent still EXECUTES a self-scoped plan at its own location", async () => {
    // The execute path survives the consent gate: a plan scoped to the NPC's OWN body/gear/property
    // (here an hp adjustment) still runs on a quiet heartbeat. Anything that binds the PLAYER —
    // travel, a job, their coin or their pack — waits for an answer instead
    // (tests/autonomy-consent-gate.test.ts, src/modules/autonomy/consent.ts).
    const { engine, events } = await build({
      mutateState: (s) =>
        setAutonomy(s, "npc.maelle", {
          lastActedAt: Date.now(),
          pendingProposal: {
            commands: [{ type: "adjustHp", entityId: "npc.maelle", by: -2 }],
            expiresAt: Date.now() - 1000,
          },
        }),
    });
    events.length = 0;
    await engine.tickHeartbeat("npc.maelle");
    expect(byKind(events, "hpChanged").filter((d) => d.entityId === "npc.maelle").length).toBe(1);
    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal).toBeUndefined();
  });

  test("(15c) tacit consent refuses a non-movement plan grounded at a location the party has left", async () => {
    // The origin stamp: commands were grounded against the room the proposal was armed in; once
    // the party stands elsewhere the plan is stale and dies with a beat instead of firing.
    const { engine, events } = await build({
      mutateState: (s) =>
        setAutonomy(s, "npc.maelle", {
          lastActedAt: Date.now(),
          pendingProposal: {
            commands: [{ type: "adjustHp", entityId: "npc.maelle", by: -2 }],
            expiresAt: Date.now() - 1000,
            originLocationId: "loc.green", // armed elsewhere; the party stands at loc.hart
          },
        }),
    });
    events.length = 0;
    await engine.tickHeartbeat("npc.maelle");
    expect(byKind(events, "hpChanged").length).toBe(0);
    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal).toBeUndefined();
  });

  test("(15b) tacit consent WAITS while the player is composing an answer", async () => {
    // "Meeting no objection, Oda follows through" resolved the scene while the 2026-07-24 playtester
    // was still typing a reply to it. Someone mid-sentence IS objecting — they just haven't finished
    // saying so. Same setup as (15), which proves this proposal DOES execute when nobody is typing.
    const { engine, events } = await build({
      mutateState: (s) =>
        setAutonomy(s, "npc.maelle", {
          lastActedAt: Date.now(),
          pendingProposal: {
            commands: [{ type: "moveEntity", entityId: "npc.maelle", to: "loc.green" }],
            expiresAt: Date.now() - 1000,
          },
        }),
    });

    engine.setComposing(true);
    events.length = 0;
    await engine.tickHeartbeat("npc.maelle");

    expect(byKind(events, "entityMoved").filter((d) => d.entityId === "npc.maelle")).toHaveLength(0);
    // HELD, not discarded — the leader's plan is still on the table, with its deadline pushed out.
    const held = engine.getState().autonomy["npc.maelle"]?.pendingProposal;
    expect(held).toBeDefined();
    expect(held!.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("spokenLineOf — autonomous lines are DIALOGUE, never stage direction", () => {
  // The verbatim live-playtest sample that motivated the sanitizer: a first-person action
  // description wrapping the actual spoken words in quotes, rendered on the proposal surface.
  const LIVE_SAMPLE =
    `I grunt as I haul the boat further up the shingle, then turn to face Aela, ` +
    `water dripping from my boots, and say flatly, "Right—we make for the green. The road's ours by dusk."`;

  test("the live sample distills to exactly the quoted sentence", () => {
    expect(spokenLineOf(LIVE_SAMPLE)).toBe("Right—we make for the green. The road's ours by dusk.");
  });

  test("a bare spoken line passes through untouched", () => {
    expect(spokenLineOf("We should rest before the pass.")).toBe("We should rest before the pass.");
  });

  test("curly quotes count as quoted speech too", () => {
    expect(spokenLineOf("She leans in and murmurs, “Not here. Follow me.”")).toBe("Not here. Follow me.");
  });

  test("multiple quoted spans join in order", () => {
    expect(spokenLineOf(`"Wait," he says, pausing, "someone's watching."`)).toBe("Wait, someone's watching.");
  });

  test("leading/trailing *asterisk actions* and markdown emphasis are stripped", () => {
    expect(spokenLineOf("*shoulders the pack* We move at first light. *spits*")).toBe("We move at first light.");
    expect(spokenLineOf("We move at **first** light.")).toBe("We move at first light.");
  });

  test("never empty: an all-action line falls back to the raw trim", () => {
    expect(spokenLineOf("  *nods slowly*  ")).toBe("*nods slowly*");
  });

  // --- the trailing-beat strip is LINEAR (r8 P0) ------------------------------------------------
  // `/(?:\s*\*[^*]*\*\s*)+$/` put `\s*` at both ends of a `+`-repeated group, so the whitespace
  // between two beats could be attributed to either side: ~2^k parses, every one of which had to be
  // tried before the `$` anchor was allowed to fail. On unbounded model output that is two bugs at
  // once — seconds of blocked event loop per NPC line, and, past JSC's backtracking ceiling, a
  // reported NO MATCH that silently no-opped the strip and put raw stage direction on the player's
  // screen. The shape is player-steerable ("reply only in action beats, no quotes").

  /** The pre-fix regex, kept here as the parity oracle ONLY — never call it on a long input. */
  const legacyTrailingStrip = (text: string): string => text.replace(/(?:\s*\*[^*]*\*\s*)+$/, "");

  test("the replacement strips exactly what the old regex stripped", () => {
    const table: ReadonlyArray<readonly [string, string]> = [
      ["We move at first light. *spits*", "We move at first light."],
      ["Hold the line. *he grunts* *he spits* *he waits*", "Hold the line."],
      ["Hold the line. *he grunts*\n\n  *he spits*  ", "Hold the line."],
      ["Two coppers, no more.", "Two coppers, no more."],
      ["He points north *", "He points north"], // an unbalanced asterisk is not a beat
      ["*a* mid *b* line *c*", "mid b line"],
      ["*nods slowly*", "*nods slowly*"], // all beat ⇒ the never-empty fallback
      ["*a**b*", "*a**b*"],
    ];
    for (const [input, expected] of table) {
      expect(spokenLineOf(input)).toBe(expected);
      // …and the old regex agreed on every one of them, so nothing well-behaved moved.
      expect(spokenLineOf(input)).toBe(spokenLineOfWithLegacyTrailingStrip(input));
    }
  });

  /** `spokenLineOf`, verbatim, but wired to {@link legacyTrailingStrip} — the differential oracle. */
  function spokenLineOfWithLegacyTrailingStrip(text: string): string {
    const raw = text.trim();
    const spans: string[] = [];
    const quoted = /"([^"]*)"|“([^”]*)”/g;
    let m: RegExpExecArray | null;
    while ((m = quoted.exec(raw)) !== null) {
      const inner = (m[1] ?? m[2] ?? "").trim();
      if (inner) spans.push(inner);
    }
    if (spans.length > 0) return spans.join(" ").replace(/\s+/g, " ").trim();
    const stripped = legacyTrailingStrip(raw.replace(/^(?:\s*\*[^*]*\*\s*)+/, ""))
      .replace(/[*_]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return stripped.length > 0 ? stripped : raw;
  }

  test("differential fuzz: 20k asterisk-dense lines strip identically to the old regex", () => {
    // Inputs are capped at 14 characters — at most four beats, so ≤16 parses — precisely so the
    // pathological oracle stays cheap. The alphabet is asterisk/whitespace-heavy on purpose: unit
    // boundaries and the `\s*`-attribution ambiguity are the whole surface being pinned.
    const alphabet = ["*", " ", "a", "b", "\n", "\t", "_", ".", '"'];
    let seed = 12345;
    const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 20_000; i++) {
      let line = "";
      const length = 1 + Math.floor(rnd() * 14);
      for (let j = 0; j < length; j++) line += alphabet[Math.floor(rnd() * alphabet.length)]!;
      expect(spokenLineOf(line)).toBe(spokenLineOfWithLegacyTrailingStrip(line));
    }
  });

  test("a 30-beat line strips its trailing beat, in well under 50ms", () => {
    // The correctness half: the old regex hit JSC's ceiling here, reported no match, and shipped the
    // raw beat. (At k=20 — under the ceiling — it stripped correctly, in 61ms.)
    const line = `He waits. ${"*a* ".repeat(30)}then he turns. *he nods*`;
    const started = performance.now();
    const spoken = spokenLineOf(line);
    expect(performance.now() - started).toBeLessThan(50); // was 721ms
    expect(spoken.endsWith("then he turns.")).toBe(true);
    expect(spoken).not.toContain("nods");
  });

  test("a 30-beat line that ends in prose does NOT strip, also in well under 50ms", () => {
    // The latency half: here the strip must fail, and failing is exactly what cost 1166ms.
    const line = `He waits. ${"*he shifts* ".repeat(30)}and then nothing.`;
    const started = performance.now();
    const spoken = spokenLineOf(line);
    expect(performance.now() - started).toBeLessThan(50); // was 1166ms
    expect(spoken.endsWith("and then nothing.")).toBe(true);
  });

  test("scales past anything a model can emit — 5000 beats stays linear", () => {
    const line = `He waits. ${"*he shifts* ".repeat(5000)}and then nothing.`;
    const started = performance.now();
    expect(spokenLineOf(line).endsWith("and then nothing.")).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("the LEADING sibling regex is safe and stays a regex — 200 beats, no blowup", () => {
    // `^` gives it one start position and nothing follows the group, so the greedy pass either
    // succeeds or fails outright. Pinned so a future "consistency" edit doesn't invent a problem.
    const line = `${"*he shifts* ".repeat(200)}he waits.`;
    const started = performance.now();
    expect(spokenLineOf(line)).toBe("he waits.");
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("scrubSelfNarration — third-person self-narration never ships as dialogue (D2 07-17)", () => {
  // The verbatim live sample: Oda's quoted speech carried his own third-person stage direction.
  const LIVE_SAMPLE =
    `Oda stays still, hands loose at his sides, but his eyes track the revenant's posture—shoulders, ` +
    `the tilt of its salt-crusted head. What are you here for?`;

  test("the live sample keeps only the genuinely spoken sentence", () => {
    expect(scrubSelfNarration(LIVE_SAMPLE, "Oda the Wayfarer")).toBe("What are you here for?");
  });

  test("a first-person self-introduction naming the speaker survives", () => {
    expect(scrubSelfNarration("I am Oda. The road is long.", "Oda the Wayfarer")).toBe(
      "I am Oda. The road is long.",
    );
  });

  test("third-person sentences about OTHERS are untouched", () => {
    expect(scrubSelfNarration("He owes me coin. Sela knows the way.", "Oda the Wayfarer")).toBe(
      "He owes me coin. Sela knows the way.",
    );
  });

  test("nothing surviving yields the empty string (silence over broken narration)", () => {
    expect(scrubSelfNarration("Oda watches the door in silence.", "Oda the Wayfarer")).toBe("");
  });

  test("the 'the' in a styled name is not a match-all token", () => {
    expect(scrubSelfNarration("The tide is rising fast.", "Oda the Wayfarer")).toBe("The tide is rising fast.");
  });
});

describe("autonomy Director — proposal surfaces carry the spoken line only", () => {
  test("a leader proposal from a stage-direction intent surfaces just the quoted words", async () => {
    const playset = await loadThistledown();
    // A gateway whose narrator output is the LIVE defect sample: decide() returns first-person
    // narration wrapping the spoken words — the proposal surface must show only the words.
    // The spoken words name a real destination, so the line GROUNDS to a party move — which is what
    // earns a proposal card at all now: a leader's command-less advice stays plain dialogue rather
    // than becoming an AGREE/DECLINE prompt with nothing behind it (2026-07-24 playtest P2).
    const sample = JSON.stringify({
      act: { do: "move", target: "loc.green" },
      visibleAction: "hauls the boat further up the shingle, water dripping from his boots",
      visibleSpeech:
        `I grunt as I haul the boat further up the shingle, then turn to face Aela, ` +
        `water dripping from my boots, and say flatly, "Right—we make for the green. The road's ours by dusk."`,
    });
    const scripted = {
      complete: () => Promise.resolve({ text: sample }),
      async *stream() {
        yield { delta: sample };
      },
      embed: (texts: string[]) => Promise.resolve({ embeddings: texts.map(() => [0, 0, 0, 0]) }),
    };
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: scripted as unknown as ConstructorParameters<typeof GameEngine>[0]["gateway"],
      rng: mulberry32(SEED),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();
    events.length = 0;

    await engine.tickHeartbeat("npc.maelle"); // Maelle is the leader → priority C proposes

    const proposals = byKind(events, "npcProposal");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.proposal).toBe("Right—we make for the green. The road's ours by dusk.");
    // The stored text (echoed by the accept narration) is the same clean line.
    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal?.text).toBe(
      "Right—we make for the green. The road's ours by dusk.",
    );
  });
});

describe("resolveBarrierAttempt (Stage 2b — seeded pick/force resolution)", () => {
  /** A grounded barrier attempt with the given verb + DC (the rest of the fields are inert here). */
  const attempt = (verb: "pick" | "force", dc: number): Extract<GroundedAction, { kind: "barrierAttempt" }> => ({
    kind: "barrierAttempt",
    verb,
    ability: verb === "pick" ? "dex" : "str",
    locationId: "loc.green",
    to: "loc.vault",
    dc,
    barrierDesc: "a heavy iron gate, padlocked",
    destName: "the vault",
  });

  test("a pick that clears its DC succeeds and OPENS the way (state 'open')", () => {
    // DC 1 is met by any d20 → deterministic success regardless of the seeded draw. On success the
    // module enqueues setExitState → this state; the pure resolver proves the mapping.
    const out = resolveBarrierAttempt(attempt("pick", 1), 10, mulberry32(SEED));
    expect(out.success).toBe(true);
    expect(out.state).toBe("open");
  });

  test("a force that clears its DC succeeds and BREAKS the way (state 'broken')", () => {
    const out = resolveBarrierAttempt(attempt("force", 1), 10, mulberry32(SEED));
    expect(out.success).toBe(true);
    expect(out.state).toBe("broken");
  });

  test("a force that CANNOT reach its DC fails (the module enqueues no command)", () => {
    // DC 40 is unreachable by d20 + a +0 modifier → deterministic failure.
    const out = resolveBarrierAttempt(attempt("force", 40), 10, mulberry32(SEED));
    expect(out.success).toBe(false);
  });

  test("the 5e ability modifier is folded in, and the same seed replays the same roll", () => {
    const a = resolveBarrierAttempt(attempt("pick", 12), 18, mulberry32(SEED));
    const b = resolveBarrierAttempt(attempt("pick", 12), 18, mulberry32(SEED));
    expect(a.result.total).toBe(b.result.total); // deterministic given the seed
    expect(a.result.modifier).toBe(4); // 5e modifier for an 18 ability score
  });
});

describe("autonomy Director — never-stall", () => {
  test("a heartbeat completes (and never throws) even when the gateway is broken", async () => {
    const playset = await loadThistledown();
    // Promote Dorran so the heartbeat reaches the decide() path, then hand it a gateway that
    // always throws — the tick must still resolve, warn, and release the lock.
    const dorran = playset.world.npcs.find((n) => n.id === "npc.dorran");
    if (dorran) dorran.autonomy.level = "proactive";
    const brokenGateway = {
      complete: () => Promise.reject(new Error("no network")),
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("no network");
      },
      embed: () => Promise.reject(new Error("no network")),
    };
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: brokenGateway as unknown as ConstructorParameters<typeof GameEngine>[0]["gateway"],
      rng: mulberry32(SEED),
    });
    const events: GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start();
    events.length = 0;

    // decide() swallows gateway errors and returns a safe fallback intent (Dorran's first goal),
    // which grounds to a speak — so we still get a line, and crucially the tick never throws.
    await expect(engine.tickHeartbeat("npc.dorran")).resolves.toBeUndefined();
    // The talk-lock is released regardless of the gateway failure.
    expect(engine.getState().autonomy["npc.dorran"]?.talking).toBe(false);
  });
});

// ===========================================================================
// Stage 3 — present NON-PARTY world NPCs take bounded autonomous beats.
//
// Module-level harness (mirrors the private-threads discreetFixture): a market with a present
// non-party NPC, optionally two reactive companions, driven by a PLAYER trigger. `react()` returns
// the queued autonomyDialogue items directly (deterministic — independent of grounding output);
// `step()` runs react+narrate against a persistent model so releaseLock's cooldown stamp lands.
// ===========================================================================

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

function worldFixture(
  opts: {
    /** The present non-party NPC's authored autonomy level (default proactive). */
    merchantLevel?: AutonomyLevel;
    /** Add Ash (addressed) + Bee (would-be reactor) as reactive companions. */
    withCompanions?: boolean;
    /** Seed the merchant's autonomy runtime slice (e.g. a fresh `lastActedAt` for the cooldown). */
    merchantRuntime?: Partial<AutonomyRuntime>;
    /** If true and the merchant is a `leader`, author it `canLead` (so a proposal WOULD fire but for the world guard). */
    canLead?: boolean;
    /** The module's seeded RNG (pick + chance gate). Default `() => 0` → picks first, passes the chance gate. */
    rng?: () => number;
  } = {},
) {
  const merchantLevel = opts.merchantLevel ?? "proactive";
  const gateway = new OfflineGateway();
  const rng = opts.rng ?? (() => 0);

  const npcs: unknown[] = [
    {
      id: "npc.merchant",
      name: "Merchant",
      persona: "A brisk stall-keeper hawking wares.",
      goals: ["sell the day's stock"],
      autonomy: { isPartyMember: false, level: merchantLevel, ...(opts.canLead ? { canLead: true } : {}) },
    },
  ];
  if (opts.withCompanions) {
    npcs.push(
      { id: "npc.ash", name: "Ash", persona: "An even-keeled scout.", autonomy: { isPartyMember: true, level: "reactive" } },
      { id: "npc.bee", name: "Bee", persona: "A talkative tinker.", autonomy: { isPartyMember: true, level: "reactive" } },
    );
  }

  const world = WorldSchema.parse({
    id: "w.mkt",
    name: "Market",
    summary: "A busy market square.",
    locations: [{ id: "loc.market", name: "The Market", description: "Stalls and noise.", npcs: ["npc.merchant"] }],
    npcs,
  });
  const companions = opts.withCompanions ? ["npc.ash", "npc.bee"] : [];
  const campaign = CampaignSchema.parse({
    id: "c.mkt",
    name: "Market Day",
    worldId: "w.mkt",
    characters: [{ id: "pc.you", name: "You", stats: STATS, inventory: [] }],
    startingState: { locationId: "loc.market", party: ["pc.you"], companions },
  });

  const actors: Record<string, unknown> = {
    "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.market", inventory: [], conditions: [] },
  };
  if (opts.withCompanions) {
    actors["npc.ash"] = { id: "npc.ash", currentHp: 10, locationId: "loc.market", inventory: [], conditions: [] };
    actors["npc.bee"] = { id: "npc.bee", currentHp: 10, locationId: "loc.market", inventory: [], conditions: [] };
  }
  const autonomy: Record<string, AutonomyRuntime> = {};
  if (opts.merchantRuntime) {
    autonomy["npc.merchant"] = { talking: false, replyDepth: 0, lastActedAt: 0, ...opts.merchantRuntime };
  }

  const gs: GameState = {
    campaignId: "c.mkt",
    worldId: "w.mkt",
    partyLocationId: "loc.market",
    clock: 0,
    party: ["pc.you"],
    companions,
    actors: actors as GameState["actors"],
    quests: {},
    relationships: {},
    autonomy,
    modules: { autonomy },
    flags: {},
  };
  const model = fromGameState(gs, world, campaign);

  // Companion agents live in `this.npcs`; a factory summons a present world NPC's agent on demand.
  const companionAgents = new Map<string, NpcAgent>();
  if (opts.withCompanions) {
    companionAgents.set("npc.ash", new NpcAgent(gateway, world.npcs.find((n) => n.id === "npc.ash")!));
    companionAgents.set("npc.bee", new NpcAgent(gateway, world.npcs.find((n) => n.id === "npc.bee")!));
  }
  const factory = (npcId: string): NpcAgent | undefined => {
    const template = world.npcs.find((n) => n.id === npcId);
    return template ? new NpcAgent(gateway, template) : undefined;
  };
  const module = new AutonomyModule(companionAgents, new HeartbeatScheduler(), world, rng, new Map(), factory);

  const makeCtx = (
    data: Record<string, unknown>,
    // A GROUNDED UI action arrives as a player trigger carrying a pre-built `plan`; the gate only
    // checks its presence, so a loose sentinel plan is enough to exercise the suppression path.
    triggerPlan?: unknown,
  ): { ctx: TickContext; events: EmittedEvent[] } => {
    const events: EmittedEvent[] = [];
    const queue: Command[] = [];
    const ctx: TickContext = {
      trigger: {
        kind: "player",
        input: "I look around the market.",
        ...(triggerPlan ? { plan: triggerPlan } : {}),
      } as TickTrigger,
      model,
      services: { world, campaign, gateway, rng: () => 0 },
      recent: [],
      data,
      queue,
      enqueue: (cmd) => queue.push(cmd),
      apply: (cmd) => applyCommand(model, cmd),
      applySilent: (cmd) => applyCommand(model, cmd),
      dryRun: (cmd) => applyCommand(structuredClone(model), cmd),
      emit: (ev) => events.push(ev),
      state: () => toGameState(model),
    };
    return { ctx, events };
  };

  return {
    model,
    /** Run the react phase only; return the items it queued (the pure gating observable). A
     *  `triggerPlan` marks the tick as a GROUNDED UI action (accept-quest / buy / equip…). */
    react: async (
      data: Record<string, unknown> = {},
      triggerPlan?: unknown,
    ): Promise<AutonomyDialogueItem[]> => {
      const { ctx } = makeCtx(data, triggerPlan);
      await module.phases.react!(ctx);
      return (ctx.data.autonomyDialogue as AutonomyDialogueItem[] | undefined) ?? [];
    },
    /** Run react + narrate (a full tick); returns the emitted events + the tick's queued items. */
    step: async (
      data: Record<string, unknown> = {},
    ): Promise<{ events: EmittedEvent[]; items: AutonomyDialogueItem[] }> => {
      const { ctx, events } = makeCtx(data);
      await module.phases.react!(ctx);
      await module.phases.narrate!(ctx);
      return { events, items: (ctx.data.autonomyDialogue as AutonomyDialogueItem[] | undefined) ?? [] };
    },
  };
}

describe("autonomy Director — Stage 3 present non-party world NPCs", () => {
  test("a present PROACTIVE non-party NPC takes a world beat when no companion reacts", async () => {
    // No companion present, non-addressing player line ⇒ reactPlayer is null ⇒ reactWorldNpc runs.
    // rng () => 0 picks the sole candidate and clears the chance gate (0 < WORLD_NPC_CHANCE).
    const fx = worldFixture({ merchantLevel: "proactive" });
    const items = await fx.react();
    expect(items).toHaveLength(1);
    expect(items[0]?.npcId).toBe("npc.merchant");
    expect(items[0]?.world).toBe(true);
    expect(items[0]?.priority).toBe("C");
    // Stage 4: `worldStimulus` is reworded goal-directed/active, naming the widened action space —
    // and this fixture's merchant is full-energy with no barred exit/fallen holder present, so the
    // `situationHint` nudge is empty. F3: the merchant HAS a goal ("sell the day's stock"), so
    // `goalHint` appends its self-scoped step-toward-your-aim nudge (never quoting the goal).
    expect(items[0]?.stimulus).toBe(
      "You are going about your business at The Market; You is here with you. Go after what you want " +
        "right now — speak, move on, ready your gear, force or pick a barred way, rest, or turn to " +
        "what's around you. What do you do?" +
        " Don't just pass the time — take one concrete step toward what you're really after right now.",
    );
  });

  test("a GROUNDED UI action tick suppresses the world beat (no stale-history re-reply)", async () => {
    // Regression: accepting a quest / buying / equipping is a mechanical grounded action that rides a
    // player tick carrying a `trigger.plan`. Its `ctx.recent` still holds the player's LAST spoken
    // line, so before the gate a present proactive NPC would take a world beat and re-answer that
    // stale question right after "Quest accepted" (the duplicate-reply bug). Same fixture as the test
    // above (which fires with rng 0) — the ONLY difference is the trigger carries a plan.
    const fx = worldFixture({ merchantLevel: "proactive" });
    const questAcceptPlan = { kind: "questAction", quest: { verb: "accept", questId: "quest.x" } };
    expect(await fx.react({}, questAcceptPlan)).toHaveLength(0);
  });

  test("a REACTIVE world NPC stays quiet (only proactive/leader self-initiate)", async () => {
    const fx = worldFixture({ merchantLevel: "reactive" });
    expect(await fx.react()).toHaveLength(0);
  });

  test("a PASSIVE world NPC stays quiet", async () => {
    const fx = worldFixture({ merchantLevel: "passive" });
    expect(await fx.react()).toHaveLength(0);
  });

  test("the low chance gate suppresses the beat when the RNG draw is above it", async () => {
    // rng () => 0.99: the candidate is still picked, but 0.99 >= WORLD_NPC_CHANCE ⇒ the tick is quiet.
    const fx = worldFixture({ merchantLevel: "proactive", rng: () => 0.99 });
    expect(await fx.react()).toHaveLength(0);
  });

  test("a companion priority-B reaction PRE-EMPTS the world beat (companions win)", async () => {
    // Player addresses Ash; Bee (a second reactive companion) chimes in via priority B. reactWorldNpc
    // is short-circuited by the `??`, so the present proactive merchant never gets a beat this tick.
    const fx = worldFixture({ merchantLevel: "proactive", withCompanions: true });
    const items = await fx.react({ dialogue: { npcId: "npc.ash", playerLine: "what now?" } });
    expect(items).toHaveLength(1);
    expect(items[0]?.npcId).toBe("npc.bee");
    expect(items[0]?.world).toBeUndefined();
    expect(items.some((i) => i.npcId === "npc.merchant")).toBe(false);
  });

  test("the WORLD cooldown suppresses a second world beat after one just fired", async () => {
    const fx = worldFixture({ merchantLevel: "proactive" });
    // First tick: the beat fires and releaseLock stamps `lastActedAt = Date.now()` on the model.
    const first = await fx.step();
    expect(first.items[0]?.npcId).toBe("npc.merchant");
    expect(fx.model.entities.get("npc.merchant")).toBeDefined();
    // The stamp is well within WORLD_NPC_DEDUP_MS, so the very next tick's candidate scan rejects it.
    expect(WORLD_NPC_DEDUP_MS).toBeGreaterThan(1000);
    expect(await fx.react()).toHaveLength(0);
  });

  test("a world beat NEVER emits a proposal, even from an authored present LEADER", async () => {
    // A leader-level, canLead present non-party NPC would propose on a companion C beat — but a WORLD
    // beat is guarded (`!item.world`), so it grounds to a plain beat and emits no npcProposal.
    const fx = worldFixture({ merchantLevel: "leader", canLead: true });
    const { events } = await fx.step();
    expect(events.filter((e) => "kind" in e && e.kind === "npcProposal")).toHaveLength(0);
  });
});
