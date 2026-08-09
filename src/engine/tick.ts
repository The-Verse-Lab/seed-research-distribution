/**
 * Tick — one simulation advance, and the module spine around it.
 *
 * A tick is triggered by player input or a heartbeat. It runs ordered phases; modules
 * register handlers against phases. Core owns the phase order + the mutation chokepoint;
 * modules own behavior. The discipline: modules in `react`/`narrate` only `enqueue` commands
 * (applied by core at `commit`) and `emit` narrative events — so a tick is a transaction with
 * explicit ordering and no half-mutations. (Player mechanical resolution applies in `resolve`
 * so narration in `narrate` reflects it; reactive modules enqueue for `commit`.)
 *
 * @author Runkai Zhang
 */
import type { Campaign, NpcTemplate, World } from "../content/schema.ts";
import type { Entity } from "../world/entity.ts";
import type { EmittedEvent, GameEvent } from "../events/types.ts";
import type { GameState } from "../state/types.ts";
import type { LlmGateway } from "../llm/gateway.ts";
import type { ModulePhaseTrace } from "../logging/types.ts";
import type { NpcHistoryStore } from "../memory/npc-history-store.ts";
import type { DisclosureStore } from "../memory/disclosure-store.ts";
import type { Rng } from "../rules/dice.ts";
import type { Command } from "../world/commands.ts";
import type { WorldModel } from "../world/model.ts";
import type { CommandResult } from "../world/reducer.ts";
import type { EngineClient } from "./client.ts";
import type { LoreRetriever } from "../memory/retriever.ts";
import type { ContinuityJudge } from "../agents/judge.ts";
import type { TurnPlan } from "./turn-plan.ts";

export type TickPhase = "perceive" | "resolve" | "react" | "narrate" | "commit" | "persist";

/** Phase order. perceive/commit/persist are core; resolve/react/narrate carry modules. */
export const TICK_PHASES: readonly TickPhase[] = [
  "perceive",
  "resolve",
  "react",
  "narrate",
  "commit",
  "persist",
];

export type TickTrigger =
  | {
      kind: "player";
      input: string;
      /**
       * Private-thread address (Phase 6, click-to-chat): when set, the engine validated the id as
       * a PRESENT NPC before the tick started and the turn is forced to a private dialogueToNpc —
       * both the player line and the reply carry `channel:"private"`. Absent ⇒ the classifier
       * routes the input exactly as before (byte-identical behavior).
       */
      toId?: string;
      /**
       * A pre-built TurnPlan (grounded-action channel, `engine.submitAction`): when set, the turn
       * runs this plan DIRECTLY and the utility classifier is BYPASSED — the plan came from a typed
       * `GroundedAction` (a clicked exit/item/quest), not from parsing free text. The shared
       * resolve pipeline (pricing, the depletion gate, the per-kind switch → reducer commands) runs
       * unchanged, so a clicked action lands as authoritative reducer mutation and can never desync
       * from the narrated fiction. Absent ⇒ `input` is classified as before. The text-only pre-branches
       * (agenda-pressure discharge, the yes/no proposal matcher) are skipped for an injected plan —
       * a typed action is unambiguous intent, not free text to interpret.
       */
      plan?: TurnPlan;
      /**
       * The leader-proposal card this input answers (`answerProposal.fromId`): the accept branch
       * executes THAT stashed proposal, not blindly the first one — with two companions holding
       * plans, the clicked card and stashed[0] can be different proposals (2026-07-25 playtest).
       * Absent (typed "yes") ⇒ the first DISPLAYED proposal (leader-first stash order) answers.
       */
      proposalFromId?: string;
    }
  | { kind: "heartbeat"; npcId: string };

/**
 * The engine's live NPC-agent roster, as the party domain needs to see it.
 *
 * Joining a party is not just a world-model edit: the NPC also gains a reply agent and a heartbeat,
 * and leaving takes both away. Those live on the engine, not in the model, so the party resolver
 * reaches them through this port rather than through the whole engine.
 */
export interface CompanionRoster {
  /** Give an NPC that just joined its reply agent + heartbeat. No-op if it already has them. */
  attach(npcId: string): void;
  /** Take back the agent + heartbeat of an NPC that just left. */
  detach(npcId: string): void;
  /** The authored/enriched template behind an entity, if the world has one. */
  templateFor(entity: Entity): NpcTemplate | undefined;
}

/** Engine-level services a module needs, stable across ticks. */
export interface TickServices {
  world: World;
  campaign: Campaign;
  gateway: LlmGateway;
  rng: Rng;
  systemPrefix?: string;
  client?: EngineClient;
  /**
   * Read-only lore retrieval (M4). Built once at engine init; narrate-phase modules query it (best
   * effort) to ground prose in authored canon. Optional so non-engine callers/tests can omit it.
   */
  lore?: LoreRetriever;
  /** Retrieval knobs (max snippets, cosine floor) threaded from config. */
  loreOptions?: { k: number; minScore: number };
  /**
   * The campaign rolling-summary the brief carries forward (M4 follow-up). The engine sets this each
   * tick from its in-memory cache (loaded from a best-effort sidecar, regenerated off the critical
   * path); the narrate module injects it as `# STORY SO FAR`. Empty/absent ⇒ no section is rendered
   * (byte-identical brief). It is a best-effort derived cache, NOT source of truth.
   */
  storySoFar?: string;
  /**
   * Per-NPC derived history store (statefulness #2+#3). Modules read it (`get` → `renderHistoryBlock`)
   * to inject `# OUR HISTORY` into a reply, and write to it (`recordGist`) after one. Best-effort derived
   * cache, OUTSIDE the WorldModel (mirrors the rolling summary); absent ⇒ inert (byte-identical prompts).
   */
  npcHistory?: NpcHistoryStore;
  /**
   * Per-NPC disclosure ledger (claims NPCs have voiced this campaign). Modules read it
   * (`get(npcId)` → `# PRIOR NPC CLAIMS` brief block) to preserve attributed speaker history,
   * and write to it (`record(npcId, facts)`) after a beat. Best-effort derived cache, OUTSIDE
   * the WorldModel (mirrors `npcHistory`); absent ⇒ inert (byte-identical prompts).
   */
  disclosure?: DisclosureStore;
  /**
   * The Continuity Judge (verification-only agent). Present ONLY when enabled
   * (`SEED_CONTINUITY_JUDGE`, default-on in the CLI; omitted by the test harness so the offline
   * suite is byte-stable). When present, `narrateGuarded` and the whisper path route buffered prose
   * through it before emit; absent ⇒ the legacy risk-buffer/`verifyCast` behavior, byte-identical.
   */
  judge?: ContinuityJudge;
  /**
   * When true (and a `judge` is present), `narrateGuarded` streams provably-clean turns live
   * (no absent cast / established facts / combat / downed) and screens Tier-1 post-stream instead of
   * buffering the whole generation. Absent/false ⇒ every judged turn buffers (byte-identical).
   */
  judgeStreamClean?: boolean;
  /**
   * Wall-clock seam. Autonomy/dialogue pacing is deliberately REAL time (heartbeats ride
   * setInterval), but the timestamps modules stamp into modulePatch deltas should come through an
   * injectable clock, not bare `Date.now()`, so tests can pin a deterministic clock. Optional —
   * absent ⇒ modules fall back to `Date.now` (byte-identical behavior); the engine always injects it.
   */
  now?: () => number;
  /**
   * Whether the player currently has text in the composer. Purely a PACING read: heartbeats keep
   * running (the world stays alive while you think), but a leader's tacit-consent deadline is HELD,
   * so an unanswered proposal cannot execute itself out from under a half-typed reply. Absent ⇒
   * never composing (byte-identical to the pre-signal behavior; the CLI and tests never set it).
   */
  isComposing?: () => boolean;
  /**
   * The engine's NPC-agent roster (see {@link CompanionRoster}). Injected by `GameEngine`; absent on
   * hand-built test contexts, where a join simply does not mint an agent — the world-model side of
   * the transition is unaffected either way.
   */
  companions?: CompanionRoster;
}

export interface TickContext {
  trigger: TickTrigger;
  model: WorldModel;
  services: TickServices;
  /** Recent events (narrator memory), read once at tick start. */
  recent: GameEvent[];
  /** Per-tick scratch — modules pass intents through it (e.g. what to narrate). */
  data: Record<string, unknown>;
  /** Commands enqueued by react-phase modules, applied by core at commit. */
  queue: Command[];
  /** Enqueue a command for the commit transaction. */
  enqueue(cmd: Command): void;
  /** Apply a command now, emitting its deltas (player mechanical resolution). */
  apply(cmd: Command): CommandResult;
  /**
   * Validate a command against a CLONE of the model — the accepted/rejected oracle for the signed
   * TurnOutcome. Runs the pure reducer on a deep copy: mutates nothing, emits nothing, persists
   * nothing (the real mutation stays the reducer at `commit`, so one-writer holds). The returned
   * `CommandResult.rejected` reason, if any, is why the command would not apply.
   */
  dryRun(cmd: Command): CommandResult;
  /** Apply a bookkeeping command now without broadcasting (clock, autonomy). */
  applySilent(cmd: Command): CommandResult;
  /** Emit a narrative/system event. */
  emit(ev: EmittedEvent): void;
  /** The current state as the legacy GameState projection. */
  state(): GameState;
}

/**
 * Wall-clock read through the injectable `TickServices.now` seam — the ONE fallback site, so
 * modules never re-derive `(services.now ?? Date.now)()` themselves. The engine always injects
 * `now`; the fallback exists for hand-built test contexts (byte-identical behavior).
 */
export function nowOf(ctx: TickContext): number {
  return (ctx.services.now ?? Date.now)();
}

export interface TickModule {
  id: string;
  /** Module ids this one must run after, within a phase (advisory ordering). */
  after?: string[];
  phases: Partial<Record<TickPhase, (ctx: TickContext) => void | Promise<void>>>;
}

/**
 * Per-module attribution sink for one tick (Workstream D, attribution pass). Optional everywhere:
 * absent ⇒ `TickRunner.run` takes its original unwrapped path — no timing, no diffs, no allocation
 * — and a tick behaves exactly as it did before the probe existed.
 */
export interface TickProbe {
  /**
   * The bus's current event seq, so events can be attributed to the handler that emitted them.
   * Absent ⇒ emission counts are simply omitted (the rest of the attribution still works).
   */
  seq?(): number;
  /** Receive one handler's record. Must never throw — the runner guards it anyway. */
  record(rec: ModulePhaseTrace): void;
}

/** Runs registered modules through the phase order. Core owns the order; modules the behavior. */
export class TickRunner {
  private readonly modules: TickModule[] = [];

  register(module: TickModule): void {
    this.modules.push(module);
  }

  async run(ctx: TickContext, probe?: TickProbe): Promise<void> {
    const ordered = this.ordered();
    for (const phase of TICK_PHASES) {
      for (const m of ordered) {
        const handler = m.phases[phase];
        if (!handler) continue;
        if (probe) await runProbed(m.id, phase, handler, ctx, probe);
        else await handler(ctx);
      }
    }
  }

  /** Stable order honoring `after` constraints (simple: keep registration order, lift afters). */
  private ordered(): TickModule[] {
    const byId = new Map(this.modules.map((m) => [m.id, m]));
    const out: TickModule[] = [];
    const placed = new Set<string>();
    const place = (m: TickModule, stack: Set<string>): void => {
      if (placed.has(m.id) || stack.has(m.id)) return;
      stack.add(m.id);
      for (const dep of m.after ?? []) {
        const d = byId.get(dep);
        if (d) place(d, stack);
      }
      stack.delete(m.id);
      if (!placed.has(m.id)) {
        placed.add(m.id);
        out.push(m);
      }
    };
    for (const m of this.modules) place(m, new Set());
    return out;
  }
}

/**
 * Run one phase handler under a {@link TickProbe}, attributing what it did.
 *
 * Attribution is by OBSERVATION, deliberately: the commit queue's tail, the tick's applied-command
 * ledger (`ctx.data.turnCommands` — the array the engine points its `apply`/`applySilent` sink at)
 * and the bus seq are diffed around the call. Nothing is instrumented at the `ctx` methods, so no
 * module can behave differently for being watched and a probe bug cannot corrupt a turn. Handlers
 * within a tick are awaited strictly in sequence and ticks are serialized, so a before/after diff
 * can only see this handler's own work.
 *
 * Every read is defensive — a hand-built test context missing `queue`/`data` just yields fewer
 * fields. A thrown handler is RECORDED and then rethrown: the tick fails exactly as it would have,
 * but the trace names which module failed it.
 */
async function runProbed(
  moduleId: string,
  phase: TickPhase,
  handler: (ctx: TickContext) => void | Promise<void>,
  ctx: TickContext,
  probe: TickProbe,
): Promise<void> {
  const queue = Array.isArray(ctx.queue) ? ctx.queue : null;
  const ledgerRaw = (ctx.data as Record<string, unknown> | undefined)?.turnCommands;
  const ledger = Array.isArray(ledgerRaw) ? (ledgerRaw as Command[]) : null;
  const queueAt = queue?.length ?? 0;
  const ledgerAt = ledger?.length ?? 0;
  const seqAt = probe.seq?.() ?? 0;
  const startedAt = performance.now();
  let error: string | undefined;
  try {
    await handler(ctx);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    const enqueued = queue ? queue.slice(queueAt).map((c) => c.type) : [];
    const applied = ledger ? ledger.slice(ledgerAt).map((c) => c.type) : [];
    const emitted = probe.seq ? Math.max(0, probe.seq() - seqAt) : 0;
    try {
      probe.record({
        moduleId,
        phase,
        ms: Math.round(performance.now() - startedAt),
        ...(enqueued.length > 0 ? { enqueued } : {}),
        ...(applied.length > 0 ? { applied } : {}),
        ...(emitted > 0 ? { emitted } : {}),
        ...(error !== undefined ? { error } : {}),
      });
    } catch {
      // Attribution is best-effort telemetry; it must never break or slow a turn.
    }
  }
}
