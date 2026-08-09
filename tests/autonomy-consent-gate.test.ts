/**
 * The Director's consent gate (playtest r9, finding F-1) — what an NPC may do with nobody's word.
 *
 * F-1, "idle-to-win": the player idled five minutes composing a question and the Director walked
 * the party two locations west, firing arrival events and completing a quest objective on the way.
 * Two surfaces could act unasked — tacit consent (an expired `pendingProposal` consumed on a quiet
 * heartbeat) and the direct-act branch (grounding produced a command while the proposal path was
 * closed) — and each was patched with a denylist of command *types*, which fails open on every
 * verb added afterwards. `take_job` (`setQuestState` offered→active) was exactly that: it shipped
 * after the movement ban and committed the party to a contract nobody answered.
 *
 * The rule these specs pin (`src/modules/autonomy/consent.ts`) is an ALLOWLIST: an NPC may act
 * unasked only on itself and its own property; anything that moves the player, spends their things,
 * or commits the party waits for an actual answer. Nothing is LOST to the gate — the same plan
 * executes whole through the accept path (tests/proposal-answer.test.ts, plus (C6) below).
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier, heuristicClassify } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { mulberry32, type Rng } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { consentBlockFor, consentBlockInPlan } from "../src/modules/autonomy/consent.ts";
import type { AutonomyRuntime, GameState } from "../src/state/types.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { ClassifierContext, TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnTrace } from "../src/logging/types.ts";
import { byKind, LeaderPlanGateway, loadThistledown, type TraceBeat } from "./support/harness.ts";
import type { WorldModel } from "../src/world/model.ts";
import type { Entity } from "../src/world/entity.ts";
import type { PlaySet } from "../src/content/schema.ts";

const SEED = 42;

/** The job the leader keeps trying to take on the party's behalf — put on offer, never accepted. */
const JOB = "quest.missing-miller";

interface Built {
  engine: GameEngine;
  events: GameEvent[];
  beats: TraceBeat[];
  traces: TurnTrace[];
  playset: PlaySet;
}

async function build(opts: {
  mutateState?: (s: GameState) => void;
  mutatePlayset?: (p: PlaySet) => void;
  rng?: Rng;
  gateway?: OfflineGateway;
  classifier?: TurnClassifier;
} = {}): Promise<Built> {
  const playset = await loadThistledown();
  opts.mutatePlayset?.(playset);
  const store = new InMemoryGameStateStore();
  if (opts.mutateState) {
    const seed = new GameEngine({
      classifier: heuristicClassifier,
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
  const traces: TurnTrace[] = [];
  const engine = new GameEngine({
    classifier: opts.classifier ?? heuristicClassifier,
    playset,
    store,
    gateway: opts.gateway ?? new OfflineGateway(),
    rng: opts.rng ?? mulberry32(SEED),
    onTurnTrace: (t) => {
      traces.push(t);
      if (t.npcBeats) beats.push(...t.npcBeats);
    },
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  return { engine, events, beats, traces, playset };
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

describe("consent gate — the classifier (pure)", () => {
  // The predicate reads exactly two things off the model — who the PC is, and who is in the party —
  // so the fixture is those three entities and nothing else.
  const entity = (id: string, kind: Entity["kind"], partyMember = false): Entity => ({
    id,
    name: id,
    kind,
    locationId: "loc.hart",
    tier: "significant",
    flags: {},
    partyMember,
  });
  const model = {
    entities: new Map<string, Entity>([
      ["pc.you", entity("pc.you", "pc", true)],
      ["npc.maelle", entity("npc.maelle", "npc", true)],
      ["npc.bett", entity("npc.bett", "npc")],
    ]),
  } as unknown as WorldModel;
  const at = (path: "tacit" | "direct") => ({ actorId: "npc.maelle", path, model });

  test("(C0) the default is ASK — an unclassified verb never fires unasked", () => {
    // The whole point of an allowlist. A verb grounding learns tomorrow inherits "wait for the
    // player", not "execute on silence" — the failure mode that let `take_job` through.
    const block = consentBlockFor({ type: "setFlag", scope: "world", key: "gate.open", value: true }, at("direct"));
    expect(block?.reason).toBe("unclassified");
    const spawn = { id: "x", name: "X", kind: "npc", tier: "transient", locationId: "loc.hart" } as const;
    expect(consentBlockFor({ type: "spawnEntity", entity: spawn }, at("direct"))).not.toBeNull();
  });

  test("(C0b) the NPC's own business is its own — gear, stamina, a door it can open", () => {
    expect(consentBlockFor({ type: "equipItem", entityId: "npc.maelle", slot: "weapon", itemId: "item.axe" }, at("tacit"))).toBeNull();
    expect(consentBlockFor({ type: "adjustEnergy", entityId: "npc.maelle", by: 20 }, at("tacit"))).toBeNull();
    expect(consentBlockFor({ type: "setExitState", locationId: "loc.hart", to: "loc.green", state: "open" }, at("direct"))).toBeNull();
    // …but not somebody ELSE's body or gear.
    expect(consentBlockFor({ type: "adjustEnergy", entityId: "pc.you", by: -20 }, at("direct"))).not.toBeNull();
  });

  test("(C0c) a solo move is legal on a heartbeat and refused as an expired PLAN", () => {
    const solo = { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" } as const;
    expect(consentBlockFor(solo, at("direct"))).toBeNull(); // ordinary NPC life; routines rely on it
    expect(consentBlockFor(solo, at("tacit"))?.reason).toBe("movement"); // a plan met with silence dies
    // Moving anyone else is never unasked, on either path.
    expect(consentBlockFor({ type: "moveEntity", entityId: "pc.you", to: "loc.green" }, at("direct"))).not.toBeNull();
    expect(consentBlockFor({ type: "moveParty", to: "loc.green" }, at("direct"))?.reason).toBe("movement");
  });

  test("(C0d) giving is the NPC's to decide; taking from the party is not", () => {
    const give = { type: "transferItem", itemId: "item.rope", from: "npc.maelle", to: "pc.you" } as const;
    expect(consentBlockFor(give, at("direct"))).toBeNull();
    const loot = { type: "transferItem", itemId: "item.coin", from: "npc.bett", to: "npc.maelle" } as const;
    expect(consentBlockFor(loot, at("direct"))).toBeNull();
    const offPlayer = { type: "transferItem", itemId: "item.rope", from: "pc.you", to: "npc.maelle" } as const;
    expect(consentBlockFor(offPlayer, at("direct"))?.reason).toBe("custody");
    const thirdParty = { type: "transferItem", itemId: "item.rope", from: "npc.bett", to: "pc.you" } as const;
    expect(consentBlockFor(thirdParty, at("direct"))?.reason).toBe("custody");
  });

  test("(C0e) a plan is blocked by its WORST command, not its first", () => {
    const plan = [
      { type: "adjustEnergy", entityId: "npc.maelle", by: 5 },
      { type: "setQuestState", questId: JOB, state: "active" },
    ] as const;
    expect(consentBlockInPlan(plan, at("tacit"))?.command).toBe("setQuestState");
    expect(consentBlockInPlan([], at("tacit"))).toBeNull();
  });
});

describe("consent gate — tacit consent (an expired plan on a quiet heartbeat)", () => {
  test("(C1) a job the leader put to the table is NOT taken on silence", async () => {
    // The r9 hole the movement ban didn't cover: `setQuestState` commits the whole party to a
    // contract — deadlines, obligations, a quest banner — on nothing but the player not answering.
    const { engine, events, traces } = await build({
      mutateState: (s) => {
        s.quests[JOB] = "offered";
        setAutonomy(s, "npc.maelle", {
          lastActedAt: Date.now(),
          pendingProposal: {
            commands: [{ type: "setQuestState", questId: JOB, state: "active" }],
            expiresAt: Date.now() - 1000,
            text: "We should take the miller's road.",
          },
        });
      },
    });
    events.length = 0;
    traces.length = 0;
    await engine.tickHeartbeat("npc.maelle");

    expect(engine.getState().quests[JOB]).toBe("offered"); // nobody signed anything
    expect(byKind(events, "questStateChanged")).toHaveLength(0);
    // The plan still resolves — it does not sit there re-firing every beat — and says so.
    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal).toBeUndefined();
    const narration = byKind(events, "narration").map((e) => e.text).join(" ");
    expect(narration).toContain("waits on your word");
    // And the suppression is COUNTABLE (r9 spec item (d)) — an unmeasured gate reads as an idle
    // Director, which is precisely what the finding looked like from the outside.
    const blocks = traces.flatMap((t) => t.consentBlocks ?? []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ actorId: "npc.maelle", command: "setQuestState", reason: "commitment", path: "tacit" });
  });

  test("(C2) the leader's OWN business still enacts on a quiet table — this is a leash, not a muzzle", async () => {
    // The gate's stated risk is a passive party. A plan scoped to the leader itself is not the
    // player's decision to make, so it fires exactly as before (autonomy (15a)) and — the part
    // that matters here — records no suppression at all.
    const { engine, events, traces } = await build({
      mutateState: (s) =>
        setAutonomy(s, "npc.maelle", {
          lastActedAt: Date.now(),
          pendingProposal: {
            commands: [{ type: "adjustHp", entityId: "npc.maelle", by: -2 }],
            expiresAt: Date.now() - 1000,
            text: "I'll take the first watch.",
          },
        }),
    });
    events.length = 0;
    traces.length = 0;
    await engine.tickHeartbeat("npc.maelle");

    expect(byKind(events, "hpChanged").filter((e) => e.entityId === "npc.maelle")).toHaveLength(1);
    expect(traces.flatMap((t) => t.consentBlocks ?? [])).toHaveLength(0);
    const narration = byKind(events, "narration").map((e) => e.text).join(" ");
    expect(narration).toContain("Meeting no objection");
  });
});

describe("consent gate — the direct-act branch (no card, nothing to answer)", () => {
  test("(C3) a leader with the proposal path closed cannot take a job on a heartbeat", async () => {
    // With a cooldown holding, `propose` is false and the grounded command used to execute for
    // real — the worst shape of F-1, because the player never even saw a card to object to.
    const { engine, events, beats, traces } = await build({
      gateway: new LeaderPlanGateway({
        act: { do: "take_job", target: JOB },
        visibleSpeech: "The miller's road is work we could use.",
      }),
      mutateState: (s) => {
        s.quests[JOB] = "offered";
        setAutonomy(s, "npc.maelle", { lastProposedClock: s.clock });
      },
    });
    events.length = 0;
    beats.length = 0;
    traces.length = 0;
    await engine.tickHeartbeat("npc.maelle");

    expect(engine.getState().quests[JOB]).toBe("offered");
    expect(byKind(events, "npcProposal")).toHaveLength(0); // the cooldown holds — no card either
    // The urge is still delivered as words; the beat records no accepted command.
    const beat = beats.find((b) => b.actorId === "npc.maelle");
    expect(beat?.dialogue ?? "").toContain("miller's road");
    expect(beat?.action).toBeUndefined();
    const blocks = traces.flatMap((t) => t.consentBlocks ?? []);
    expect(blocks[0]).toMatchObject({ command: "setQuestState", reason: "commitment", path: "direct" });
  });

  test("(C4) the leader catching her own breath on the same closed path still happens", async () => {
    // Symmetry check against (C3): the direct branch is not a blanket suppressor. A worn leader
    // resting is her own stamina, her own decision — it fires with the same cooldown holding that
    // suppressed the job, and records no suppression.
    const { engine, events, traces } = await build({
      gateway: new LeaderPlanGateway({
        act: { do: "rest" },
        visibleSpeech: "A moment. My legs are done arguing.",
      }),
      mutateState: (s) => {
        setAutonomy(s, "npc.maelle", { lastProposedClock: s.clock });
        const actor = s.actors["npc.maelle"];
        if (actor) actor.energy = 20; // depleted ⇒ `rest` is a legal candidate
      },
    });
    events.length = 0;
    traces.length = 0;
    await engine.tickHeartbeat("npc.maelle");

    expect(byKind(events, "energyChanged").filter((e) => e.entityId === "npc.maelle")).toHaveLength(1);
    expect(traces.flatMap((t) => t.consentBlocks ?? [])).toHaveLength(0);
  });
});

describe("consent gate — the answer path is untouched", () => {
  test("(C6) the job the gate refused on silence is taken the moment the player says yes", async () => {
    // Nothing is lost to the gate: it moves a decision from silence to an answer. The plan the
    // heartbeat refused in (C1) executes whole here, through the ordinary accept branch.
    const { engine } = await build({
      classifier: {
        classify: async (text: string, ctx: ClassifierContext): Promise<TurnPlan> => ({
          ...heuristicClassify(text, ctx),
          ...(text.trim() === "aye, take it" ? { proposalAnswer: "accept" as const } : {}),
        }),
      },
      mutateState: (s) => {
        s.quests[JOB] = "offered";
        setAutonomy(s, "npc.maelle", {
          pendingProposal: {
            commands: [{ type: "setQuestState", questId: JOB, state: "active" }],
            expiresAt: Date.now() + 60_000,
            text: "We should take the miller's road.",
          },
        });
      },
    });

    await engine.submitPlayerInput("aye, take it");
    expect(engine.getState().quests[JOB]).toBe("active");
  });
});
