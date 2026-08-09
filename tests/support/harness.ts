/**
 * Shared test harness — a deterministic engine (offline gateway + seeded rng + in-memory
 * store) and helpers to assert on the emitted event stream.
 *
 * @author Runkai Zhang
 */
import { fileURLToPath } from "node:url";
import { mulberry32 } from "../../src/rules/dice.ts";
import { OfflineGateway } from "./offline-gateway.ts";
import { heuristicClassifier } from "./test-classifier.ts";
import { InMemoryGameStateStore } from "./memory-store.ts";
import { GameEngine, type EngineDeps } from "../../src/engine/engine.ts";
import { loadPlaySetFromDir } from "../../src/content/loader.ts";
import { BRIEF_MARKERS } from "../../src/util/markers.ts";
import type { PlaySet } from "../../src/content/schema.ts";
import type { GameEvent, GameEventKind } from "../../src/events/types.ts";
import type { TurnTrace } from "../../src/logging/types.ts";

export const SEED = 1234;

/** A public NPC beat as surfaced on the turn trace (the observable for DM-owned public speech). */
export type TraceBeat = NonNullable<TurnTrace["npcBeats"]>[number];

export function loadExample(): Promise<PlaySet> {
  const dir = fileURLToPath(new URL("../fixtures/worlds/example", import.meta.url));
  return loadPlaySetFromDir(dir);
}

/** The bundled default-play world (proactive companions Maelle + Dorran) for autonomy tests. */
export function loadThistledown(): Promise<PlaySet> {
  const dir = fileURLToPath(new URL("../fixtures/worlds/thistledown", import.meta.url));
  return loadPlaySetFromDir(dir);
}

/**
 * An OfflineGateway that answers an NPC's "what do you want to do?" beat with a STRUCTURED turn
 * intent carrying a real closed `act`, and behaves exactly like the offline stub everywhere else.
 *
 * A leader only mints an AGREE/DECLINE proposal when its intent GROUNDS TO A COMMAND — advice with
 * nothing behind it is plain dialogue (2026-07-24 playtest P2, where a card fired on nearly every
 * beat with `commands: []`). The plain offline stub returns prose with no `act`, so it can only ever
 * produce speech; specs that need to exercise the proposal machinery script the intent the way a
 * live model actually returns it: a verb from `NPC_ACT_VERBS` plus an id the NPC's own
 * `# CANDIDATE ACTIONS` block offered (r8 — an imperative sentence no longer grounds anything).
 */
export class LeaderPlanGateway extends OfflineGateway {
  constructor(
    private readonly intent: {
      act: { do: string; target?: string; to?: string };
      visibleAction?: string;
      visibleSpeech: string;
    },
  ) {
    super();
  }
  override complete(role: Parameters<OfflineGateway["complete"]>[0], req: Parameters<OfflineGateway["complete"]>[1]) {
    const wantsIntent = req.messages.some((m) => m.content.includes(BRIEF_MARKERS.autonomousBeat));
    if (wantsIntent) return Promise.resolve({ text: JSON.stringify(this.intent), model: "offline-intent" });
    return super.complete(role, req);
  }
  override async *stream(role: Parameters<OfflineGateway["stream"]>[0], req: Parameters<OfflineGateway["stream"]>[1]) {
    const { text } = await this.complete(role, req);
    yield { delta: text, done: false };
    yield { delta: "", done: true };
  }
}

/** Captures every narrator brief (streamed or not), so specs can assert what the GM actually saw. */
export class RecordingGateway extends OfflineGateway {
  readonly briefs: string[] = [];

  private record(role: string, req: { messages: { role: string; content: string }[] }): void {
    if (role !== "narrator") return;
    const user = req.messages.filter((m) => m.role === "user").at(-1);
    if (user) this.briefs.push(user.content);
  }
  override complete(role: Parameters<OfflineGateway["complete"]>[0], req: Parameters<OfflineGateway["complete"]>[1]) {
    this.record(role, req);
    return super.complete(role, req);
  }
  override async *stream(role: Parameters<OfflineGateway["stream"]>[0], req: Parameters<OfflineGateway["stream"]>[1]) {
    this.record(role, req);
    yield* super.stream(role, req);
  }
}

export interface Harness {
  engine: GameEngine;
  events: GameEvent[];
  /**
   * Public NPC beats this run, in order across turns — the observable for DM-owned public NPC speech
   * (which is no longer a `dialogue` event; it lands on the turn trace's `npcBeats` and is narrated by
   * the DM). Collected via `onTurnTrace`. Private whispers still surface as `dialogue` events instead.
   */
  beats: TraceBeat[];
  store: InMemoryGameStateStore;
  playset: PlaySet;
}

/** Build a started, fully-deterministic engine wired to a recording listener. */
export async function makeEngine(overrides: Partial<EngineDeps> = {}): Promise<Harness> {
  const playset = overrides.playset ?? (await loadExample());
  const store = (overrides.store as InMemoryGameStateStore) ?? new InMemoryGameStateStore();
  const beats: TraceBeat[] = [];
  const engine = new GameEngine({
    // Forward ALL overrides (so opt-in deps like `continuityJudge`, `summary`, and `lore`
    // reach the engine), then pin the harness defaults that must always be deterministic.
    ...overrides,
    playset,
    store,
    gateway: overrides.gateway ?? new OfflineGateway(),
    // The test input DSL (retired product heuristic) so specs drive intents from canonical
    // phrasings; the ENGINE default is freeform-only.
    classifier: overrides.classifier ?? heuristicClassifier,
    rng: overrides.rng ?? mulberry32(SEED),
    // Collect public NPC beats off the turn trace (the observable for DM-owned public speech), then
    // forward to any test-supplied handler.
    onTurnTrace: (t) => {
      if (t.npcBeats) beats.push(...t.npcBeats);
      overrides.onTurnTrace?.(t);
    },
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  return { engine, events, beats, store, playset };
}

export const kinds = (events: GameEvent[]): GameEventKind[] => events.map((e) => e.kind);

export function byKind<K extends GameEventKind>(
  events: GameEvent[],
  kind: K,
): Extract<GameEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<GameEvent, { kind: K }> => e.kind === kind);
}
