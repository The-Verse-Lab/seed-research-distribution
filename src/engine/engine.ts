/**
 * GameEngine — the orchestrator: a command goes in, a stream of events comes out.
 *
 * M1 turn pipeline (submitPlayerInput): classify intent → resolve any check in code
 * (deterministic dice) → narrate the outcome → apply state mutations → emit events →
 * persist. Reactive companion dialogue is handled inline; autonomous NPC initiative (the
 * Director) is M2. The engine takes a REQUIRED LlmGateway (no offline fallback — clients build
 * it via env.ts, tests inject a deterministic stub) and defaults the classifier to freeform-only
 * and the RNG to Math.random.
 *
 * @author Runkai Zhang
 */
import type { Case, Location, LocationInteraction, NpcTemplate, PlaySet, Work } from "../content/schema.ts";
import { questPitch } from "../content/quest.ts";
import {
  CorruptSnapshotError,
  makeSaveKey,
  type CommittedSnapshot,
  type GameStateStore,
  type SaveKey,
} from "../state/store.ts";
import type { ActorRuntime, AutonomyRuntime, GameState } from "../state/types.ts";
import { InProcessEventBus, type EventBus, type EventListener } from "../events/bus.ts";
import type { DeltaEvent, EmittedDelta } from "../events/deltas.ts";
import { isDelta, reduceDeltas } from "../world/replay.ts";
import type { EmittedEvent, GameEvent } from "../events/types.ts";
import type { LlmGateway } from "../llm/gateway.ts";
import type { SafetyContext } from "../llm/safety.ts";
import { costOf, energyOf, maxEnergyOf, DEFAULT_TURN_MINUTES, TURN_COSTS } from "../rules/costs.ts";
import {
  EXHAUSTION_MAX,
  exhaustionOf,
  workingCap,
} from "../rules/exhaustion.ts";
import { roll, type Rng } from "../rules/dice.ts";
import { nameMentionedIn, nameTokens } from "../rules/name-match.ts";
import { derivedAc } from "../rules/combat.ts";
import {
  effectiveStatBlock,
  progressionOf,
  readProgressionSlice,
} from "../rules/progression.ts";
import { exitStateTag, isPassable } from "../rules/exit-state.ts";
import {
  formatCoins,
  itemDisplayNameOf,
  itemFitsSlot,
  resolveItem,
} from "../rules/items.ts";
import {
  liveOffersFor,
} from "../rules/pending-offers.ts";
import { normalizeTerms, openDealWith, readDealsSlice } from "../rules/deals.ts";
import { groundItemsAt } from "../rules/ground-items.ts";
import { entitiesAt, fromGameState, partyLocationOf, playerEntity, toGameState, type WorldModel } from "../world/model.ts";
import { readCasesSlice } from "../rules/cases.ts";
import { isAtCamp } from "../world/camp.ts";
import { CAPTIVITY_LOCATION_ID, isCaptive, resolveCaptivityLocation } from "../world/captivity.ts";
import { isAtLodging, readLodgingSlice } from "../world/lodging.ts";
import { captivityActionButtons } from "../rules/captivity.ts";
import { exitsFrom as mapExitsFrom } from "../world/map.ts";
import { findRoute } from "../world/pathfind.ts";
import { effectiveExitState, exitVerdict } from "../world/traversal.ts";
import {
  FRONTIER_FALLBACK_NAME,
  hydrateExpansions,
  isFrontierId,
  visitedFlag,
} from "../world/expansion.ts";
import { norm } from "../world/exit-match.ts";
import { hydrateEnrichments } from "../world/enrichment.ts";
import { worldMaintenance } from "../world/maintenance.ts";
import { combatPendingInQueue, isCombatActive, isRosteredNpc, safetyCharacterOf } from "../world/queries.ts";
import { isMinor } from "../safety/minor.ts";
import { regionOfLocation } from "../rules/regions.ts";
import { placeTokensOf } from "../rules/place-tokens.ts";
import {
  consequencesFor,
  notorietyFlagKey,
  notorietyTier,
  wantedFlagKey,
  witnessedFlagKey,
  type ConsequenceOutcome,
} from "../rules/consequence.ts";
import { applyCommand, type CommandResult } from "../world/reducer.ts";
import type { Command } from "../world/commands.ts";
import { displayName, type Entity } from "../world/entity.ts";
import type {
  ClassifierContext,
  ClassifierEntityRef,
  ClassifierInteractionRef,
  ClassifierLearnRef,
  ClassifierVendorRef,
  TurnPlan,
} from "./turn-plan.ts";
import { freeformClassifier, type TurnClassifier } from "./classify.ts";
import {
  absentReferencedNpcs,
  dayPhaseOf,
  RECENT_EVENT_READ_LIMIT,
  RECENT_EVENT_READ_MAX,
  resolvedHardRefusal,
  type TurnOutcome,
} from "../agents/context.ts";
import { recentJourneys } from "../rules/journey.ts";
import { QUEST_DEADLINES_MODULE } from "../rules/quest-deadlines.ts";
import type { ModulePhaseTrace, TurnTrace } from "../logging/types.ts";
import { turnContext, type TurnScratch } from "../logging/turn-context.ts";
import { NpcAgent } from "../agents/npc.ts";
import { ContinuityJudge } from "../agents/judge.ts";
import type { EngineClient } from "./client.ts";
import {
  TickRunner,
  type TickContext,
  type TickModule,
  type TickProbe,
  type TickServices,
  type TickTrigger,
} from "./tick.ts";
// Domain resolvers (the `GameEngine` split — see `resolvers/host.ts` for the contract they run under).
import type { EngineHost } from "./resolvers/host.ts";
import { resolveHireMercenary, resolvePartyAction } from "./resolvers/party.ts";
import {
  absentAddressee,
  bumpGrievance,
  resolveAgendaPressure,
  resolveCheckIntent,
} from "./resolvers/social.ts";
import {
  executeKnownRoadsTravel,
  expandFrontier,
  frontierEnabled,
  hasCompanionsHere,
  leftBehindNotice,
  priceMovementTurn,
  knownPlacesFor,
  reachOpenWorld,
  resolveBarredMove,
  resolveBarrierCheck,
  resolveDisengage,
  waysOnFrom,
  type PendingTravel,
} from "./resolvers/movement.ts";
import { awardXp } from "./resolvers/progression.ts";
import { resolveCast, resolveLearn } from "./resolvers/magic.ts";
import { resolveCaseAction, resolveCaseClaims } from "./resolvers/cases.ts";
import { dispatchErrand, resolveErrand, type PendingErrand } from "./resolvers/errands.ts";
import {
  ensureCampLocation,
  ensureLodgingLocation,
  resolveEndDay,
  resolveEnterCamp,
  resolveRentRoom,
  resolveRest,
  resolveWakeInRoom,
  riseFromRoom,
} from "./resolvers/lodging.ts";
import {
  equippedItemInSlot,
  explicitEquipItems,
  resolveAcceptItemEffect,
  resolveClothingAction,
  resolveItemAction,
} from "./resolvers/items.ts";
import { workOpportunitiesHere } from "./resolvers/work-board.ts";
import {
  rankWorkInquiry,
  resolveAmbientCoinGift,
  resolveService,
  resolveSpendCoinsEffect,
  resolveTrade,
  resolveTradeBatch,
  resolveWork,
  settleDueServices,
  workLeadSpeaker,
} from "./resolvers/economy.ts";
import { NarrationModule, type NarrationIntent } from "../modules/narration.ts";
import { DialogueModule, type DialogueIntent } from "../modules/dialogue.ts";
import { EventsModule } from "../modules/events/module.ts";
import { queuedSpawnIds } from "../modules/events/effect-to-command.ts";
import { TravelEventsModule } from "../modules/travel-events/module.ts";
import { AmbientLifeModule } from "../modules/ambient-life/module.ts";
import { CampEventsModule } from "../modules/camp-events/module.ts";
import { RoomEventsModule } from "../modules/room-events/module.ts";
import { UpkeepModule } from "../modules/upkeep/module.ts";
import { QuestDeadlinesModule } from "../modules/quest-deadlines/module.ts";
import { ErrandsModule } from "../modules/errands/module.ts";
import { RoutineModule } from "../modules/routines/module.ts";
import { RelationshipDecayModule } from "../modules/relationship-decay/module.ts";
import { NpcEventsModule } from "../modules/npc-events/module.ts";
import { CasesModule } from "../modules/cases/module.ts";
import { CaseTestimonyModule } from "../modules/case-testimony/module.ts";
import { CaptivityModule } from "../modules/captivity/module.ts";
import { StatusEffectsModule } from "../modules/status-effects/module.ts";
import { NpcProfileModule } from "../modules/npc-profile.ts";
import { AutonomyModule, type CancelledProposal } from "../modules/autonomy/module.ts";
import { CombatModule, DEESCALATION_RE, type CombatAttackIntent } from "../modules/combat/module.ts";
import type { GroundedAction } from "./grounded.ts";
import { ProseEntityModule } from "../modules/prose-entities.ts";
import { ScenesModule } from "../modules/scenes/module.ts";
import { NpcMemoryModule } from "../modules/npc-memory/module.ts";
import { HeartbeatScheduler } from "../director/heartbeat.ts";
import { LoreRetriever } from "../memory/retriever.ts";
import { collectLoreDocs } from "../memory/ingest.ts";
import {
  stance,
  type PendingAgendaPressure,
} from "../rules/agenda.ts";
import { effectiveScheduleOf, readRoutinesSlice } from "../rules/routine.ts";
import { habitOf, nameMentioned, readSightingsSlice, renderHabitLine } from "../rules/sightings.ts";
import { WHISPERS_MODULE } from "../rules/whispers.ts";
import { statusMods } from "../rules/status-effects.ts";
import { QUEST_GIVER_WARMTH } from "../rules/relationships.ts";
import { QUEST_FACTION_WARMTH, factionOf, factionStandingCommands } from "../rules/factions.ts";
import { composeNpcTemplate } from "../modules/party/enrich.ts";
import { FileVectorCache, NoopVectorCache, type VectorCache } from "../memory/vector-cache.ts";
import {
  WARDROBE_MODULE,
  isWardrobeSlotId,
  wardrobeLockOf,
  wardrobeSlotLabel,
  type WardrobeSlice,
} from "../rules/wardrobe.ts";
import { buildDigest, foldCampaignSummary, type FoldInput } from "../memory/summary.ts";
import {
  FileSummaryStore,
  NoopSummaryStore,
  SUMMARY_STORE_VERSION,
  type SummaryStore,
} from "../memory/summary-store.ts";
import { NpcHistoryStore, npcHistorySidecarPath } from "../memory/npc-history-store.ts";
import { DisclosureStore, disclosureSidecarPath } from "../memory/disclosure-store.ts";
import { join } from "node:path";

/**
 * How many new events must accrue past the fold cursor before the rolling summary is regenerated.
 * Keeps the fold off the per-turn path (it runs roughly once a dozen events, not every turn).
 */
export const SUMMARY_BATCH = 12;
/** Word budget for the rolling summary the brief carries forward. */
export const SUMMARY_MAX_WORDS = 220;
// Rest/clock policy moved to `src/rules/rest.ts` (pure arithmetic, no engine state). Re-exported
// here because tests and callers have long imported these names from the engine.
export {
  LONG_REST_MINUTES,
  NIGHT_START_MINUTE,
  REST_WAKE_MINUTE,
  SHORT_REST_ENERGY_FRACTION,
  SHORT_REST_HP_FRACTION,
  SHORT_REST_MINUTES,
  restAdvanceMinutes,
} from "../rules/rest.ts";

/**
 * Turn kinds that reach OUT of a rented room — the hall's board, its counter, its people, the road.
 * Attempting one while abed GETS THE PLAYER UP first (see the guard in `resolvePlan`), because a
 * player who says they are going down to the hall has already told the world what they want.
 * Deliberately does NOT include speech, item/clothing handling, rest, or freeform: those
 * are things a body in a bed can do, and the presence checks already bound who can hear them.
 */
const OUTSIDE_THE_ROOM: ReadonlySet<TurnPlan["kind"]> = new Set<TurnPlan["kind"]>([
  "movement",
  "work",
  "workInquiry",
  "trade",
  "tradeBatch",
  "service",
  "hireMercenary",
  "locationInteraction",
  "errand",
  "partyAction",
  "caseAction",
  "questAction",
]);

/**
 * Turn kinds an UNCONSCIOUS (0 HP) player cannot take (r7 P2: a downed PC kept resolving Arcana
 * checks and delivering speeches, so being downed carried no weight). Recovery paths (rest, camp,
 * wake, use-a-potion via itemAction's own gate) and out-of-character asides stay open; captivity
 * and defeat scenes own their own downed flow and bypass this gate entirely.
 */
const DOWNED_BLOCKED: ReadonlySet<TurnPlan["kind"]> = new Set<TurnPlan["kind"]>([
  "attemptRequiringCheck",
  "dialogueToNpc",
  "freeformNarrative",
  "movement",
  "attack",
  "errand",
  "work",
  "workInquiry",
  "trade",
  "tradeBatch",
  "service",
  "hireMercenary",
  "rentRoom",
  "locationInteraction",
  "partyAction",
  "caseAction",
  "questAction",
]);

/**
 * Pending autonomous demands are gameplay state: they decide whether the player's next public line
 * opens a resist roll and whether a consequence lands. Keep the serializable payload in the model's
 * module bag and use the in-memory Map only as the live index handed to AutonomyModule.
 */
const AGENDA_PRESSURES_MODULE = "agendaPressures";
interface AgendaPressuresSlice {
  pending: Record<string, PendingAgendaPressure>;
}


function fileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "legacy";
}

/** The first salient token of a display name — how prose and players actually refer to someone. */
function firstToken(name: string): string {
  return name.trim().toLowerCase().split(/\s+/)[0] ?? "";
}

/**
 * The numbers-free `# WORK ON OFFER` grounding for a `workInquiry` routed through an NPC: the
 * authoritative job the live board carries, phrased as facts the replier POINTS at in their own
 * voice. Wage/DC/Take stay in the WorkCard — the divide between system (the card) and roleplay
 * (the spoken pointer) is the whole point, so the bullets forbid quoting numbers.
 */
function workLeadFacts(job: Work, basis: string): string[] {
  return [
    `- Honest paid work you know is posted here, ${basis}: “${job.label}.”`,
    `- Point the asker to it plainly, in your own voice. Do NOT quote wages, dice, or numbers — the work-board carries the terms.`,
  ];
}

export function summarySidecarPath(dataDir: string, key: SaveKey): string {
  return join(dataDir, `summary-${fileSegment(key.campaignId)}-${fileSegment(key.characterId)}.json`);
}

/** Honorific/kin/rank words that open many NPC names ("Sister Lian", "Old Marta") — never enough
 *  on their own to count as naming that NPC (r7 P3: the absence floor fired on a bare "sister"). */
const GENERIC_NAME_TOKENS: ReadonlySet<string> = new Set([
  "sister", "brother", "mother", "father", "old", "young", "master", "mistress", "miss",
  "lady", "lord", "ser", "sir", "dame", "captain", "sergeant", "corporal", "doctor",
  "aunt", "uncle", "granny", "grandma", "grandpa", "widow", "saint",
]);


/**
 * The wall-clock floor (ms) at which a module handler that changed NOTHING still earns a row in the
 * turn trace's `modules` list. A tick invokes ~40 handlers and most no-op in microseconds; listing
 * them all buries the ones that matter. Anything slower than this is worth seeing even when it was
 * a no-op — a quiet handler burning time is exactly the thing per-module attribution exists to find.
 */
const MODULE_TRACE_MS_FLOOR = 2;


export interface EngineDeps {
  playset: PlaySet;
  store: GameStateStore;
  /** Defaults to an in-process bus. */
  bus?: EventBus;
  /** REQUIRED — no offline fallback; clients build it via env.ts, tests inject a stub. */
  gateway: LlmGateway;
  /** Defaults to freeform-only (safe, model-free) — real clients inject the LLM classifier. */
  classifier?: TurnClassifier;
  /** Seedable RNG for all rolls; defaults to Math.random. Inject mulberry32(seed) in tests. */
  rng?: Rng;
  /** Optional client callbacks (streaming, click-to-roll). */
  client?: EngineClient;
  /** Prepended to GM/NPC system prompts (model-specific "unlock" directives). */
  systemPrefix?: string;
  /**
   * Enable the Continuity Judge (verification-only agent). Default OFF at this layer so the test
   * harness is inert unless a spec opts in; the CLI passes `config.continuityJudge`
   * (`SEED_CONTINUITY_JUDGE`, default ON) to turn it on in real play. When off ⇒ byte-identical to
   * the legacy risk-buffer/`verifyCast` narration path.
   */
  continuityJudge?: boolean;
  /** Model id for the judge's Tier-2 verdicts (`SEED_JUDGE_MODEL`), on the utility endpoint. */
  judgeModel?: string;
  /**
   * Let the Continuity Judge stream provably-clean turns live instead of buffering
   * (`SEED_JUDGE_STREAM_CLEAN`, default OFF). No effect unless `continuityJudge` is also on. Off ⇒
   * every judged turn buffers, byte-identical to the release-gate behavior.
   */
  judgeStreamClean?: boolean;
  /**
   * Read-only lore-retrieval (M4) knobs. Defaults to k=4 / minScore=0.1 when omitted. Pure prompt
   * context — never mutates state. `cache` (default off here when omitted) persists the lore
   * embeddings; the CLI passes `config.lore.cache` (default on).
   */
  lore?: { k: number; minScore: number; cache?: boolean };
  /**
   * Where runtime data lives (the cache file goes under here, beside `seed.db`). Defaults to "./data"
   * when omitted; only consulted when the lore cache is enabled. Embeddings only — never world state.
   */
  dataDir?: string;
  /**
   * The configured embedding model, folded into the lore cache's corpus signature so a model swap
   * invalidates the on-disk vectors. Defaults to "" (still correct — just keyed on the empty hint).
   */
  embeddingModel?: string;
  /**
   * Campaign rolling-summary ("story so far") — default ON when omitted (`SEED_SUMMARY` controls it
   * from the CLI). When enabled, the engine loads a best-effort sidecar under `dataDir` and
   * regenerates the summary off the turn's critical path; the brief carries it as `# STORY SO FAR`.
   * It is an LLM-generated derived cache, NOT source of truth — never in the WorldModel/deltas/
   * snapshot/event-log. Disabling it (`false`) skips load/regen and the brief is byte-identical.
   */
  summary?: boolean;
  /**
   * Best-effort per-turn trace sink (Workstream D, slim). Called once at the end of every tick with
   * the turn's decision skeleton — classifier plan, freeform-fallback reason, accepted PUBLIC NPC
   * beats. Wire it to persist (the store's TraceSink) and, dev-gated, to surface in CLI output.
   * Pure telemetry: never world state, never a delta, never blocks or crashes a turn.
   */
  onTurnTrace?: (trace: TurnTrace) => void;
  /**
   * Wall-clock seam for module timestamp stamps (autonomy pacing, exploitation cooldowns, grievance).
   * Defaults to `Date.now`; tests inject a pinned clock for deterministic modulePatch deltas.
   */
  now?: () => number;
}

export class GameEngine {
  readonly bus: EventBus;
  /** The single source of truth. Mutated only through the reducer (this.apply / applySilent). */
  private model: WorldModel | null = null;
  private readonly saveKey: SaveKey;
  private readonly gateway: LlmGateway;
  private readonly classifier: TurnClassifier;
  private readonly rng: Rng;
  /** Events are stamped during a transaction but withheld from listeners until its commit succeeds. */
  private eventBatch: { events: GameEvent[]; committed: boolean } | null = null;
  /** Durable events emitted outside a managed tick (mostly white-box/admin paths), flushed by persist. */
  private pendingEvents: GameEvent[] = [];
  private readonly npcs = new Map<string, NpcAgent>();
  /**
   * Ephemeral reply agents for PRIVATE threads addressed at non-companion location NPCs (Phase 6).
   * Session-local prompt plumbing only — never heartbeat-registered, never persisted, and always
   * outranked by a real companion agent in `npcs` (e.g. after an invite promotes the NPC).
   */
  private readonly privateAgents = new Map<string, NpcAgent>();
  private readonly tick = new TickRunner();
  /** Wired to fire heartbeat ticks; dormant until the autonomy module registers NPCs (Phase 6). */
  private readonly heartbeat = new HeartbeatScheduler();
  /** True while a tick is executing (INCLUDING a player turn blocked on a pending click-to-roll gate).
   *  A heartbeat that would fire during this window is skipped — it must never interleave with an
   *  in-flight turn, whose narration would otherwise reach the client before the roll resolves
   *  (2026-07-05 playtest: an NPC "pledged loyalty" before the player rolled). */
  private ticking = false;
  /** The serialized tick queue (D1): every player turn chains here; heartbeats skip when it is busy. */
  private tickChain: Promise<void> = Promise.resolve();
  /** Ticks queued or in flight on `tickChain` — the heartbeat's don't-interleave signal. */
  private pendingTicks = 0;
  /**
   * The authorized-command ledger for the CURRENT tick — every reducer command applied this turn
   * (via `apply`/`applySilent`, including the many direct `this.apply(...)` sites the `ctx` closures
   * bypass). Non-null ONLY for the span of a tick body: `runTickInner` points it at the tick's own
   * array and nulls it in a `finally`, so a command applied outside a tick is a safe no-op and no
   * stale reference can leak into the next turn (mirrors the `ticking` set/reset discipline). The
   * Continuity Judge reads it (∪ the pending `ctx.queue`) as the ground truth for what the world was
   * actually allowed to do this turn, so narration can't assert a change no command authorized.
   */
  private turnCommandSink: Command[] | null = null;
  /** Live index of pending NPC pressure; synchronized to the authoritative module slice at commit. */
  private readonly agendaPressures = new Map<string, PendingAgendaPressure>();
  /**
   * A quoted-but-unconfirmed known-roads journey (open-world reach to a VISITED multi-hop
   * destination): the quote turn states the route and its true cost, and the NEXT player turn
   * must commit it — a matching movement line or a bare "yes" executes; anything else lets it
   * rest (the quote's own wording says so). Engine-private and deliberately NOT persisted
   * (precedent: `agendaPressures`): a stale quote surviving a reload would be exactly the
   * out-of-context movement class the 2026-07-25 fix wave removed. Captured-and-cleared at the
   * top of every player turn; re-armed only by a fresh quote.
   */
  private pendingTravel: PendingTravel | null = null;
  /**
   * A camp intent at a location that sells beds, awaiting the player's re-confirmation: the first
   * "make camp" under a roof with authored lodging answers with the choice out loud (there are
   * beds for coin here), and only a repeat commits the roadside camp. Same lifecycle as
   * `pendingTravel` (engine-private, unpersisted, good for exactly one following turn) — r4 P1:
   * a misread "cot in the loft" fired MAKE CAMP silently and the player lost the paid bed.
   */
  private pendingCamp: { locationId: string } | null = null;
  /**
   * An errand quoted last turn, awaiting the player's word. The runner states the terms in their
   * own voice — where, how long, what it costs — and only a "yes" spends the coin and sends them.
   * Same lifecycle as `pendingTravel` (engine-private, unpersisted, good for exactly one following
   * turn): an errand quote that survived a reload would send someone on a trip the player never
   * agreed to, which is the out-of-context state change the r3 wave removed.
   */
  private pendingErrand: PendingErrand | null = null;
  /**
   * The authored `world.npcs` as handed to this engine, BEFORE any enrichment mirror touched it.
   * `restart()` restores it so a fresh campaign never inherits a previous run's enriched
   * templates (mirrorEnrichment mutates the shared playset content in place, and the wiped
   * enrichment slice can no longer un-mirror them).
   */
  private readonly authoredNpcs: NpcTemplate[];
  /**
   * The authored `world.locations` snapshotted BEFORE any explore-time expansion mirror touched it.
   * `hydrateExpansions` grows `world.locations` in place (appended pockets) and is additive-only, so
   * it cannot shrink a dirty mirror — a rewind past a world expansion would otherwise leave ghost
   * rooms/exits on the map. `rewindTo` splices this back before re-hydrating from the folded slice.
   */
  private readonly authoredLocations: Location[];
  /**
   * Read-only lore retrieval (M4) over `World.lore[]`. Built once (best-effort, non-blocking) at
   * start; the narrate phase queries it to ground prose in authored canon. It mutates nothing.
   */
  private readonly lore: LoreRetriever;
  private readonly loreOptions: { k: number; minScore: number };
  /**
   * Campaign rolling-summary state — a best-effort DERIVED CACHE, deliberately NOT in the WorldModel
   * (it's LLM-generated, so it would break the `snapshot==fold(deltas)` replay invariant). Persisted
   * to a separate sidecar; loaded into the brief; regenerated off the turn's critical path.
   */
  private readonly summaryStore: SummaryStore;
  private readonly npcHistory: NpcHistoryStore;
  private readonly disclosure: DisclosureStore;
  /** Verification-only agent; present only when enabled (see `EngineDeps.continuityJudge`). */
  private readonly judge?: ContinuityJudge;
  /** Stream provably-clean judged turns live instead of buffering (see `EngineDeps.judgeStreamClean`). */
  private readonly judgeStreamClean: boolean;
  private readonly summaryEnabled: boolean;
  /** The running "story so far" the brief carries; "" until the first fold (or load). */
  private summaryText = "";
  /** Highest event seq already folded into `summaryText` (the fold cursor); -1 = nothing folded. */
  private summaryCursor = -1;
  /** Guard against overlapping folds (a fold can outlive its turn; never run two at once). */
  private summaryFolding = false;
  /**
   * Derived-store timeline generation, bumped by `rewindTo`. An off-critical-path async fold that
   * captured a stale generation before the rewind drops its write instead of overwriting the cleared
   * summary with a discarded timeline's prose. Companion to the per-store epoch on the NPC-history /
   * disclosure sidecars (which the reducer/deltas replay invariant does NOT cover).
   */
  private derivedGen = 0;

  constructor(private readonly deps: EngineDeps) {
    this.bus = deps.bus ?? new InProcessEventBus();
    this.saveKey = makeSaveKey(
      deps.playset.campaign.id,
      deps.playset.campaign.startingState.party[0] ?? deps.playset.campaign.characters[0]?.id,
    );
    this.gateway = deps.gateway;
    this.classifier = deps.classifier ?? freeformClassifier;
    this.rng = deps.rng ?? Math.random;
    // Read-only lore index: collected from the world's authored lore at construction (pure), embedded
    // lazily on start. Secret-tagged lore is bucketed (not excluded) inside the retriever. When the
    // lore cache is enabled, persist the embeddings to `<dataDir>/lore-vectors.json` so a cold start
    // reuses them instead of re-embedding an unchanged corpus; otherwise a Noop cache (always embed,
    // no file). The cache is keyed to the embedding model so a model swap invalidates it. EMBEDDINGS
    // only — it never touches the game-state store or any world state.
    const loreCache: VectorCache = deps.lore?.cache
      ? new FileVectorCache(join(deps.dataDir ?? "./data", "lore-vectors.json"), deps.embeddingModel ?? "")
      : new NoopVectorCache(deps.embeddingModel ?? "");
    this.lore = new LoreRetriever(collectLoreDocs(deps.playset.world), undefined, loreCache);
    this.loreOptions = deps.lore ?? { k: 4, minScore: 0.1 };

    // Campaign rolling-summary: default ON. When enabled, persist `{summary, cursorSeq}` to a sidecar
    // under `dataDir` (beside `seed.db`/`lore-vectors.json`) — a best-effort DERIVED CACHE, never the
    // game-state store, never a delta. When disabled, a Noop store (no load, no file) and no regen.
    this.summaryEnabled = deps.summary !== false;
    this.summaryStore = this.summaryEnabled
      ? new FileSummaryStore(summarySidecarPath(deps.dataDir ?? "./data", this.saveKey))
      : new NoopSummaryStore();
    // Per-NPC derived history (statefulness #2+#3): persisted beside the summary sidecar when derived
    // caches are on, else in-memory only (null path). Loaded in the async init below.
    this.npcHistory = new NpcHistoryStore(
      this.summaryEnabled ? npcHistorySidecarPath(deps.dataDir ?? "./data", this.saveKey) : null,
      deps.playset.campaign.id,
    );
    // Per-NPC disclosure ledger (facts NPCs have voiced): same persistence posture as npcHistory —
    // a JSON sidecar when derived caches are on, else in-memory only. Loaded in the async init below.
    this.disclosure = new DisclosureStore(
      this.summaryEnabled ? disclosureSidecarPath(deps.dataDir ?? "./data", this.saveKey) : null,
      deps.playset.campaign.id,
    );
    // The Continuity Judge — constructed ONLY when enabled (default-on in the CLI via
    // `config.continuityJudge`; omitted by the test harness so the offline suite is byte-stable). It
    // reuses the engine's own (guarded/logging-wrapped) gateway; its verdicts run on the unscreened
    // `utility` role, so screening the prose roles never recurses through it.
    this.judge = deps.continuityJudge
      ? new ContinuityJudge(this.gateway, deps.playset.world, deps.judgeModel)
      : undefined;
    this.judgeStreamClean = deps.judgeStreamClean ?? false;

    // Pristine authored templates, snapshotted before any enrichment mirror can land (restart()
    // restores from this — see the field doc).
    this.authoredNpcs = structuredClone(deps.playset.world.npcs);
    // Same pristine snapshot for locations — the rewind baseline, taken before any expansion mirror.
    this.authoredLocations = structuredClone(deps.playset.world.locations);

    const companions = new Set(deps.playset.campaign.startingState.companions);
    for (const npc of deps.playset.world.npcs) {
      if (companions.has(npc.id)) {
        this.npcs.set(npc.id, new NpcAgent(this.gateway, npc, deps.systemPrefix));
      }
    }

    // The tick spine: core owns perceive/commit/persist + player resolution; the narration and
    // dialogue modules own the narrate phase. The events module (Phase 5) and the autonomy
    // Director (Phase 6) register additional resolve/react handlers without touching core.
    this.tick.register(this.coreModule());
    this.tick.register(new StatusEffectsModule());
    this.tick.register(new CombatModule(deps.playset.world, this.gateway, deps.systemPrefix));
    this.tick.register(new NarrationModule(deps.playset.world, this.gateway, deps.systemPrefix));
    // The dialogue module resolves companion agents first; the fallback supplies ephemeral reply
    // agents so BOTH a private thread (Phase 6) and a public address (Workstream B slice) can
    // reach any present location NPC, not just companions.
    this.tick.register(new DialogueModule(this.npcs, (npcId) => this.privateReplyAgentFor(npcId)));
    this.tick.register(new EventsModule(deps.playset.campaign.events, deps.playset.world, deps.playset.campaign));
    // Registered immediately AFTER EventsModule so its narrate beats ride the same eventBeats array
    // EventsModule.onNarrate emits (arrival-scoped, player-turn-only; inert unless a world opts in).
    this.tick.register(new TravelEventsModule(deps.playset.world, deps.playset.campaign));
    // Ambient life: fills a location with living extras on arrival from its `spawns` rules + the
    // region's ambient/threat pools, scaled by region crowd × day phase. Registered right after
    // TravelEventsModule (react phase) so the crowd is PRESENT when the narrator builds the brief.
    // Extras are transient (reaped by cullTransients on departure). Fully inert unless a world
    // authors location `spawns` or region pools.
    this.tick.register(new AmbientLifeModule(deps.playset.world));
    // Camp events (long rest): the same authored travelEvents list, but rolled each CAMP turn on the
    // filtered camp-safe subset. Its own trigger
    // (isAtCamp) + cursor + rng namespace, so it never double-fires with the traversal roller above.
    this.tick.register(new CampEventsModule(deps.playset.world, deps.playset.campaign));
    // Room events (rented lodging): the DoL overnight-intrusion roller. A SEPARATE authored table
    // (`campaign.roomEvents`), fired each turn the PC sleeps in a rented room (isAtLodging). Its own
    // cursor + rng namespace keeps it independent of the camp/traversal rollers.
    this.tick.register(new RoomEventsModule(deps.playset.world, deps.playset.campaign));
    // NPC routines (daily/weekly schedules): reconciles scheduled world NPCs to their day-phase
    // slot via teleport moveEntity commands at the commit chokepoint. Registered after events so
    // its depart/arrive beats append to the eventBeats array EventsModule.onNarrate emits. Fully
    // inert (zero slice writes, zero brief bytes) in a world with no `schedule` on any NPC.
    this.tick.register(new RoutineModule(deps.playset.world));
    // NPC personal events + rumors: one keyed roll per (npc, day-phase) — co-located events play
    // out on screen, offstage ones apply world truth and queue rumors drained at social venues.
    // Registered after routines so this phase's override pins are already current. Fully inert
    // in a world where no template authors `events`.
    this.tick.register(new NpcEventsModule(deps.playset.world, deps.playset.campaign));
    // Cases (mystery layer): the one reactive rule — a clue revealed on-screen this tick that refutes
    // a red herring a PRESENT NPC still believes overturns that false belief in front of them
    // (npcDropCaseBelief + a GM weave note). `after` the event-producing modules so ctx.queue already
    // carries this tick's reveals. Fully inert in a caseless campaign.
    // Case testimony: an NPC who ADMITS an authored case fact in play hands it to the player's
    // ledger, instead of the admission living only in the transcript (r5 P1 — a witnessed confession
    // moved nothing, and the unrecorded scene then looped). Runs BEFORE CasesModule so a fact
    // revealed by testimony can overturn a present NPC's red herring on the same tick.
    this.tick.register(new CaseTestimonyModule(deps.playset.campaign, this.gateway));
    this.tick.register(new CasesModule(deps.playset.campaign));
    // Living relationships: once per in-world day, an untended NPC's regard for the PC drifts one
    // small step toward its personality baseline (decay). Applied (not enqueued) so ambient drift
    // never spawns npc-memory beats. Inert in a world with no relationships toward the PC.
    this.tick.register(new RelationshipDecayModule(deps.playset.world));
    // Daily upkeep (the hall-as-hub wave): once per in-world day the party owes merc wages + one
    // ration each — unpaid mercs walk, an unfed party goes hungry then exhausted. Keyed on the day
    // counter so it settles whether the day rolled via a long rest or a night march. Inert until a
    // day crosses; a merc-less, well-provisioned party pays nothing.
    this.tick.register(new UpkeepModule(deps.playset.world, deps.playset.campaign));
    // Deadlines with teeth (2026-07-25): fails past-due quests the engine armed on acceptance.
    this.tick.register(new QuestDeadlinesModule(deps.playset.campaign));
    // Delegated errands (r5): lands a dispatched NPC's away-and-back once the clock passes its
    // due hour — the runner walks home, CODE decides what they learned, and the finding reaches
    // the player as a beat, the runner's own journal, and (when it was one) a case fact. After
    // RoutineModule so the routines slice it edits is already this phase's. Inert with no errands.
    this.tick.register(new ErrandsModule(deps.playset.world, deps.playset.campaign));
    // First-observation profiles (Workstream A): any runtime NPC colocated with the party gets
    // its deterministic seeded identity recorded (promote:false) the moment the party sees it —
    // LLM-free, replay-safe, tier untouched. Registered after events so freshly-committed spawns
    // profile on their first shared tick.
    this.tick.register(new NpcProfileModule());
    this.tick.register(
      new AutonomyModule(
        this.npcs,
        this.heartbeat,
        deps.playset.world,
        this.rng,
        this.agendaPressures,
        // Stage 3: build an agent for ANY present non-party world NPC on demand (the module only
        // holds companion agents). Resolve the template via the entity's templateId (falling back to
        // the id), the same pattern the barrier/stance paths use, so a suffixed runtime instance
        // still finds its authored template. No template ⇒ undefined ⇒ that NPC takes no world beat.
        (npcId) => {
          const entity = this.model?.entities.get(npcId);
          const template = deps.playset.world.npcs.find((n) => n.id === (entity?.templateId ?? npcId));
          return template ? new NpcAgent(this.gateway, template, this.deps.systemPrefix) : undefined;
        },
      ),
    );
    // Per-NPC memory (M4 Part B): records deterministic beats into each NPC's journal, woven back
    // into its reply/decide prompts. Registered UNCONDITIONALLY — inert (no journal, byte-identical
    // prompts) until a beat fires, so there's nothing to gate.
    this.tick.register(new NpcMemoryModule(deps.playset.world, deps.playset.campaign));
    // Captivity (bad-end follow-up): owns a HELD player's turns (labor/endure/escape → release).
    // Registered unconditionally and inert until a defeat outcome enqueues `beginCaptivity`.
    this.tick.register(new CaptivityModule(deps.playset.campaign));
    // Prose-entity grounding (Workstream A): after the GM prose is emitted, ground any newly-named
    // characters into the registry so a "to the Keeper" line next turn addresses a real entity instead
    // of mis-routing to whoever is PRESENT. Registered last in narrate;
    // content-agnostic world hygiene, so it's unconditional. On-the-fly identity is danger-weighted.
    this.tick.register(new ProseEntityModule(deps.playset.world, this.gateway));
    // Scene registry + terminator watchdog (Concordia transfer #6): mirrors scene-shaped slices into
    // `modules.scenes` and force-ends a combat whose own reap never ran (the reap is player-tick-only;
    // the watchdog evaluates every tick, heartbeats included). World-flag gated: off ⇒ never
    // registered ⇒ byte-identical event streams everywhere the flag is absent.
    if (deps.playset.world.constitution.toggles.scenes) {
      this.tick.register(new ScenesModule());
    }
    this.heartbeat.onTick((npcId) => void this.tickHeartbeat(npcId));
  }

  subscribe(listener: EventListener): () => void {
    return this.bus.subscribe(listener);
  }

  /**
   * Ensure the synthetic Captivity hold (bad-end follow-up) exists in the world content mirror, so the
   * narrator can name it and a held player can be teleported into it. Fixed synthetic content (no exits,
   * no coords), like Camp — but injected UNCONDITIONALLY at start/restart rather than lazily: captivity
   * is enqueued deep inside a defeat outcome, with no engine resolver to
   * materialize the room first, so it must already be present. Idempotent; emits no delta.
   */
  private ensureCaptivityLocation(): void {
    const world = this.deps.playset.world;
    if (!world.locations.some((l) => l.id === CAPTIVITY_LOCATION_ID)) {
      world.locations.push(resolveCaptivityLocation(world));
    }
  }

  /**
   * Rebuild the live model + content mirror from a seed GameState — a fresh init, a reload, or a
   * rewind-folded state. Shared by `start()` and `rewindTo()`: re-apply persisted expansions and
   * enrichments onto the world CONTENT before the model/map derives from it, materialize the
   * synthetic camp/captivity room ONLY when the seed's slice says the session is in it, then
   * re-arm/drop live companion agents to match party membership. Emits nothing and persists nothing
   * — the caller does. (On rewind the caller resets `world.locations`/`world.npcs` to the authored
   * baseline FIRST, so the additive-only hydrations rebuild the mirror from the folded slices.)
   */
  private loadFrom(seed: GameState): void {
    const { playset } = this.deps;
    // Re-apply any persisted explore-time expansions onto the world CONTENT before the model/map
    // derives from it — generated locations survive a reload (and are rebuilt after a rewind).
    hydrateExpansions(playset.world, seed.modules);
    // Same for promoted-NPC enrichments: rebuild the world.npcs mirror from the durable slice BEFORE
    // fromGameState runs, so the enriched template resolves for templateId/maxHp lookups.
    hydrateEnrichments(playset.world, seed.modules);
    // Mid-camp / mid-captivity: re-derive the synthetic room BEFORE fromGameState (so the map gets its
    // no-exit node and the narrator can name it) — but ONLY when the seed's slice says we're in it, so
    // a session that never rested / was never held keeps world.locations byte-identical.
    if ((seed.modules?.camp as { active?: boolean } | undefined)?.active) ensureCampLocation(this.deps.playset.world);
    if ((seed.modules?.captivity as { active?: boolean } | undefined)?.active) this.ensureCaptivityLocation();
    // Mid-stay in a rented room: rebuild the themed room from the persisted slice (hall + tier) BEFORE
    // fromGameState, so the map gets its no-exit node and the narrator can name it. Byte-stable when
    // no stay is live.
    const lodgeSeed = seed.modules?.lodging as { active?: boolean; hallId?: string; tierId?: string } | undefined;
    if (lodgeSeed?.active) {
      const hall = lodgeSeed.hallId ? playset.world.locations.find((l) => l.id === lodgeSeed.hallId) : undefined;
      const tier = hall?.guild?.lodging?.tiers.find((t) => t.id === lodgeSeed.tierId);
      ensureLodgingLocation(this.deps.playset.world, hall?.guild?.name ?? hall?.name ?? "the hall", tier);
    }
    this.model = fromGameState(seed, playset.world, playset.campaign);
    this.hydrateAgendaPressures();
    // Rebuild live companion agents for every NPC party member (starting companions were wired in the
    // constructor; members invited in a prior session are re-armed from their hydrated templates).
    for (const e of this.model.entities.values()) {
      if (e.kind === "npc" && e.partyMember) this.ensureCompanionAgent(e.id);
    }
    // And the mirror move: DROP agents for companions the seed says are no longer members, so a
    // released companion never comes back as a live agent (heartbeat, proposals).
    for (const id of [...this.npcs.keys()]) {
      const e = this.model.entities.get(id);
      if (!e || !e.partyMember) {
        this.npcs.delete(id);
        this.heartbeat.unregister(id);
      }
    }
  }

  /** Remove every runtime content mirror before rebuilding it from an authoritative snapshot. */
  private restoreFromState(seed: GameState): void {
    const { world } = this.deps.playset;
    world.npcs.splice(0, world.npcs.length, ...structuredClone(this.authoredNpcs));
    world.locations.splice(0, world.locations.length, ...structuredClone(this.authoredLocations));
    this.loadFrom(seed);
  }

  /** Start withholding stamped events until the surrounding authoritative write succeeds. */
  private beginEventBatch(): void {
    if (this.eventBatch) throw new Error("An event transaction is already active.");
    this.eventBatch = { events: [], committed: false };
  }

  /** Publish a successfully committed batch in original sequence order. Silent deltas stay private. */
  private publishEventBatch(): void {
    const batch = this.eventBatch;
    if (!batch?.committed) throw new Error("Cannot publish an uncommitted event transaction.");
    this.eventBatch = null;
    for (const event of batch.events) {
      if (event.silent !== true) {
        try {
          this.bus.publish(event);
        } catch {
          // Observation follows durability; a custom subscriber bus cannot undo the commit.
        }
      }
    }
  }

  /** Drop a failed batch and return the sequence allocator to its pre-operation cursor. */
  private discardEventBatch(seqStart: number): void {
    this.eventBatch = null;
    this.bus.reseed?.(seqStart);
  }

  /** Events that form the durable replay log; UI-only notices/cards are deliberately ephemeral. */
  private isDurableEvent(event: GameEvent): boolean {
    return event.kind !== "system" && event.kind !== "questOffered";
  }

  /** Rebuild the live pressure index from authoritative module state after load/rewind. */
  private hydrateAgendaPressures(): void {
    this.agendaPressures.clear();
    const slice = this.getModel().modules[AGENDA_PRESSURES_MODULE] as Partial<AgendaPressuresSlice> | undefined;
    const pending = slice?.pending;
    if (!pending || typeof pending !== "object") return;
    for (const [targetId, raw] of Object.entries(pending)) {
      if (!raw || typeof raw !== "object") continue;
      const pressure = raw as PendingAgendaPressure;
      if (
        pressure.targetId !== targetId ||
        typeof pressure.npcId !== "string" ||
        (pressure.actionKind !== "demand" && pressure.actionKind !== "pressure") ||
        typeof pressure.summary !== "string" ||
        typeof pressure.directive !== "string" ||
        !pressure.consequence ||
        typeof pressure.consequence !== "object" ||
        !pressure.resist ||
        typeof pressure.resist !== "object" ||
        typeof pressure.resist.ability !== "string" ||
        !Number.isFinite(pressure.resist.dc) ||
        typeof pressure.resist.label !== "string"
      ) {
        continue;
      }
      this.agendaPressures.set(targetId, structuredClone(pressure));
    }
  }

  /**
   * Persist the live pressure index as one absolute module field. Autonomy arms pressures during
   * narrate; player resolution consumes them during resolve, so commit is the common synchronization
   * point. The equality guard avoids a bookkeeping delta on unrelated turns.
   */
  private syncAgendaPressures(ctx: TickContext): void {
    const pending = Object.fromEntries(
      [...this.agendaPressures.entries()].map(([targetId, pressure]) => [targetId, structuredClone(pressure)]),
    );
    const current =
      (ctx.model.modules[AGENDA_PRESSURES_MODULE] as Partial<AgendaPressuresSlice> | undefined)?.pending ?? {};
    if (JSON.stringify(current) === JSON.stringify(pending)) return;
    this.applySilent({
      type: "modulePatch",
      module: AGENDA_PRESSURES_MODULE,
      patch: { pending },
    });
    ctx.data.persist = true;
  }

  /**
   * Bounded rewind — reset world state to just BEFORE the turn anchored at `anchorSeq`, discarding
   * everything at/after it (linear truncate, not a branch). Edit and regenerate both reduce to
   * `rewindTo(anchor)` then a fresh `submitPlayerInput`. The durable delta log is the truth: "state
   * before turn N" = fold the deltas with `seq < anchor` onto the authored baseline (§ world-model
   * SSOT). No downstream turn is auto-replayed, so the unseeded tick RNG re-rolling is intended.
   *
   * Runs on the caller's serialized turn queue AND holds `ticking` across its awaits, so a heartbeat
   * can never interleave the model swap. `anchorSeq` MUST name a PC-authored PUBLIC `dialogue` event
   * (the clicked player line) — rejected otherwise (defensive; the UI only offers it on player lines).
   */
  async rewindTo(anchorSeq: number): Promise<void> {
    const { playset, store } = this.deps;
    this.getModel(); // throws if not started
    if (this.ticking) throw new Error("Another game operation is already in progress.");
    if (this.pendingEvents.length > 0) throw new Error("Cannot rewind while authoritative events are uncommitted.");
    const rewind = store.rewindSave;
    if (typeof rewind !== "function") throw new Error("This save cannot be atomically rewound.");

    const before = this.getState();
    const seqBefore = this.bus.currentSeq?.() ?? 0;
    let durableCommitted = false;
    this.ticking = true;
    try {
      // Validate the anchor: exactly the event at anchorSeq must be the player's own PUBLIC dialogue.
      const at = await store.readEvents(this.saveKey, { sinceSeq: anchorSeq, beforeSeq: anchorSeq + 1, includeSilent: true });
      const anchor = at.find((e) => e.seq === anchorSeq);
      const playerId = playerEntity(this.getModel())?.id ?? "pc.you";
      if (!anchor || anchor.kind !== "dialogue" || anchor.actorId !== playerId || anchor.channel === "private") {
        throw new Error("Can only rewind to one of your own past lines.");
      }

      // 1. Read the delta prefix (seq < anchor) — the mutations that happened BEFORE this turn.
      const durable = await store.readEvents(this.saveKey, { beforeSeq: anchorSeq, includeSilent: true });
      const prefix = durable.filter(isDelta) as DeltaEvent[];

      // 2. Compute the folded prefix without publishing it as live state. Reset world CONTENT to the
      //    authored baseline: the fold seed must not start from a mirror
      //    carrying a previous run's enrichments/expansions — both are additive-only hydrations that
      //    can't shrink a dirty mirror. `initialState()` reads live world.npcs, so this precedes it.
      playset.world.npcs.splice(0, playset.world.npcs.length, ...structuredClone(this.authoredNpcs));
      playset.world.locations.splice(0, playset.world.locations.length, ...structuredClone(this.authoredLocations));
      const seedModel = fromGameState(this.initialState(), playset.world, playset.campaign);
      const foldedModel = reduceDeltas(seedModel, prefix);
      const foldedState = toGameState(foldedModel);

      // Exercise the exact hydration path before changing durable state; malformed retained data must
      // fail while the old timeline is still authoritative. Then put the old live mirror back while
      // the atomic database transaction runs. A trigger/IO fault
      // therefore leaves both the visible session and the full durable log untouched.
      this.restoreFromState(foldedState);
      this.restoreFromState(before);
      await rewind.call(store, this.saveKey, anchorSeq, foldedState);
      durableCommitted = true;

      // 3. Only after truncation+snapshot commit succeeds does the folded prefix become live.
      this.restoreFromState(foldedState);

      // 4. Ephemeral reply agents from the discarded future must not speak in the rewound present, and
      //    a pending NPC agenda-pressure from a discarded turn must not hijack the first resubmitted
      //    input. `loadFrom` rebuilt the live Map from the folded prefix's authoritative module slice,
      //    preserving a pressure that genuinely existed before the anchor while dropping future ones.
      this.privateAgents.clear();
      const newMax = durable.reduce((max, event) => Math.max(max, event.seq), -1);
      this.bus.reseed?.(newMax + 1);

      // 5. Retain only derived memory that can be attributed to the kept prefix. The summary is
      //    rebuilt deterministically from retained story events; seq-tagged NPC sidecars truncate.
      await this.rebuildDerivedCachesForPrefix(playset.campaign.id, durable, anchorSeq);
    } catch (err) {
      if (!durableCommitted) {
        this.restoreFromState(before);
        this.bus.reseed?.(seqBefore);
      }
      throw err;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Invalidate EVERY derived narrative cache that lives OUTSIDE the snapshot==fold(deltas) invariant
   * (LLM-generated, non-deterministic): the rolling campaign summary (seq-keyed), per-NPC history
   * (id-keyed), and the disclosure ledger (id-keyed). Bumps the generation FIRST so any off-critical-
   * path fold/gist still in flight from the old timeline no-ops its write (see `maybeFoldSummary` +
   * the per-store epoch guards) instead of resurrecting cleared state, then persists the emptied
   * sidecars so a crash before the next save can't reload the discarded caches. Used for a full
   * restart; rewind instead calls `rebuildDerivedCachesForPrefix` to preserve attributable history.
   */
  private async resetDerivedCaches(campaignId: string): Promise<void> {
    this.derivedGen++;
    this.summaryStore.invalidate?.(); // abort any in-flight fold's disk save from the discarded timeline
    this.summaryText = "";
    this.summaryCursor = -1;
    this.npcHistory.clear();
    this.disclosure.clear();
    await Promise.all([
      this.summaryStore.save({
        version: SUMMARY_STORE_VERSION,
        campaignId,
        summary: "",
        cursorSeq: -1,
      }),
      this.npcHistory.save(),
      this.disclosure.save(),
    ]);
  }

  /** Keep only rewind-prefix derived memory; never surface a sidecar fault after SSOT commit. */
  private async rebuildDerivedCachesForPrefix(
    campaignId: string,
    retained: GameEvent[],
    anchorSeq: number,
  ): Promise<void> {
    this.derivedGen++;
    this.summaryStore.invalidate?.();
    const visible = retained.filter((event) => event.silent !== true);
    const digestLines = visible
      .map((event) => renderEventLine(event, (id) => this.actorName(id), false))
      .filter((line): line is string => line !== null);
    this.summaryText = buildDigest("", digestLines, SUMMARY_MAX_WORDS);
    this.summaryCursor = retained.reduce((max, event) => Math.max(max, event.seq), -1);
    this.npcHistory.truncateFrom(anchorSeq);
    this.disclosure.truncateFrom(anchorSeq);
    try {
      await Promise.all([
        this.summaryStore.save({
          version: SUMMARY_STORE_VERSION,
          campaignId,
          summary: this.summaryText,
          cursorSeq: this.summaryCursor,
        }),
        this.npcHistory.save(),
        this.disclosure.save(),
      ]);
    } catch {
      // Derived caches are reconstructable and cannot turn a committed rewind into a reported failure.
    }
  }

  /** Read the durable high-water mark without guessing; read failure is a startup/commit error. */
  private async maxEventSeq(): Promise<number> {
    const store = this.deps.store as GameStateStore & {
      getMaxSeq?: (key: SaveKey) => Promise<number>;
    };
    if (typeof store.getMaxSeq === "function") return store.getMaxSeq(this.saveKey);
    const newest = await store.readEvents(this.saveKey, { limit: 1, includeSilent: true });
    return newest.at(-1)?.seq ?? -1;
  }

  /**
   * Recover a marked new-format corrupt snapshot from its complete retained delta history. Unmarked
   * legacy rows fail closed because replay completeness cannot be proven.
   */
  private async recoverCorruptSnapshot(error: CorruptSnapshotError): Promise<CommittedSnapshot> {
    const commit = this.deps.store.commitTurn;
    if (!error.replayableFromOrigin || typeof commit !== "function") throw error;
    const events = await this.deps.store.readEvents(this.saveKey, { includeSilent: true });
    let last = -1;
    for (const event of events) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= last || typeof event.kind !== "string") throw error;
      last = event.seq;
    }
    // The snapshot cursor certifies that every durable row through it was reflected. If even one of
    // those rows is missing, the retained log is not a complete recovery source.
    if (last < error.eventSeq) throw error;

    const { world, campaign } = this.deps.playset;
    world.npcs.splice(0, world.npcs.length, ...structuredClone(this.authoredNpcs));
    world.locations.splice(0, world.locations.length, ...structuredClone(this.authoredLocations));
    const seed = fromGameState(this.initialState(), world, campaign);
    const recovered = toGameState(reduceDeltas(seed, events.filter(isDelta) as DeltaEvent[]));
    // Install the recovered checkpoint without touching the complete log. If this write fails, the
    // corrupt row remains in place and the next startup still fails closed.
    await commit.call(this.deps.store, this.saveKey, recovered, []);
    return { state: recovered, eventSeq: last, replayableFromOrigin: true };
  }

  /** Load the saved session (or initialize a fresh one) and emit the opening beat. */
  async start(): Promise<GameState> {
    const { playset, store } = this.deps;
    let committed: CommittedSnapshot | null;
    try {
      committed = store.loadCommitted
        ? await store.loadCommitted(this.saveKey)
        : ((state) => (state ? { state, eventSeq: -1 } : null))(await store.load(this.saveKey));
    } catch (err) {
      if (!(err instanceof CorruptSnapshotError)) throw err;
      committed = await this.recoverCorruptSnapshot(err);
    }

    let maxSeq = await this.maxEventSeq();
    if (!committed && maxSeq >= 0) {
      // An orphan log may be incomplete (or belong to a lost snapshot). Never overwrite it with a
      // deceptively clean new game. An operator can inspect/recover it explicitly.
      throw new Error("Save snapshot is missing while its story log still exists; refusing to overwrite it.");
    }

    const existing = committed !== null;
    this.restoreFromState(committed?.state ?? this.initialState());

    // A committed snapshot may lag an event batch after an older/non-atomic writer crashed. Its
    // explicit cursor makes the tail unambiguous: fold only durable deltas beyond that cursor, then
    // atomically checkpoint the reconciled projection before exposing the session.
    if (committed && store.loadCommitted) {
      if (committed.eventSeq > maxSeq) {
        throw new Error("Save snapshot references story events that are missing; refusing to continue.");
      }
      const tail = await store.readEvents(this.saveKey, {
        sinceSeq: committed.eventSeq + 1,
        includeSilent: true,
      });
      if (tail.length > 0) {
        const checkpoint = committed.state;
        const reconciled = toGameState(reduceDeltas(this.getModel(), tail.filter(isDelta) as DeltaEvent[]));
        this.restoreFromState(reconciled);
        const commit = store.commitTurn;
        if (typeof commit !== "function") {
          throw new Error("This save store cannot atomically reconcile its event tail.");
        }
        try {
          await commit.call(store, this.saveKey, reconciled, []);
        } catch (err) {
          this.restoreFromState(checkpoint);
          throw err;
        }
        maxSeq = Math.max(maxSeq, tail.at(-1)?.seq ?? maxSeq);
      }
    }

    // Warm the read-only lore index in the background. Fire-and-forget + best-effort: build() never
    // throws, and a still-building/failed index just means retrieval returns empty for early turns —
    // it must never block or slow startup. retrieve() also self-builds on first use as a fallback.
    void this.lore.build(this.gateway);

    // Load the rolling-summary sidecar (best-effort, derived cache — NOT source of truth). A missing/
    // corrupt/mismatched file just leaves an empty summary; the store never throws. Only a sidecar
    // for THIS campaign is trusted (the file is per-data-dir, so guard against a stale/foreign one).
    try {
      const stored = await this.summaryStore.load();
      if (stored && stored.campaignId === playset.campaign.id) {
        this.summaryText = stored.summary;
        this.summaryCursor = stored.cursorSeq;
      }
    } catch {
      // best-effort — start from an empty summary
    }
    // Per-NPC history sidecar (best-effort, derived cache). Missing/corrupt/mismatched ⇒ NPCs start blank.
    await this.npcHistory.load();
    // Per-NPC disclosure ledger (best-effort). Missing/corrupt/mismatched ⇒ NPCs have established nothing yet.
    await this.disclosure.load();
    // Reconcile the derived memory sidecars against the durable event high-water mark. A rewind truncates
    // them in memory then persists best-effort inside a swallowing try/catch; if that save fails (disk/IO),
    // the on-disk sidecars keep the rewound-away entries and this load() would trust them verbatim — an NPC
    // then "remembers" or refuses to re-reveal a fact from a discarded timeline. The durable log is the
    // SSOT, so drop any sidecar entry (and clamp the summary cursor) stamped beyond it (audit #12).
    this.npcHistory.truncateFrom(maxSeq + 1);
    this.disclosure.truncateFrom(maxSeq + 1);

    // Opening/resume events are also transactional. In particular, fresh opening prose is durable
    // before any listener sees it; it can never sit in memory waiting for the first player turn.
    this.bus.reseed?.(maxSeq + 1);
    const seqStart = this.bus.currentSeq?.() ?? maxSeq + 1;
    this.beginEventBatch();
    try {
      this.emit({
        kind: "system",
        level: "info",
        message: `Loaded world "${playset.world.name}" · campaign "${playset.campaign.name}".`,
      });
      if (!existing) {
        const opening = this.openingNarration();
        if (opening) this.emit({ kind: "narration", text: opening });
      } else {
        this.emit({
          kind: "system",
          level: "info",
          message: `Resuming at ${this.locationName(this.getState().partyLocationId)}.`,
        });
      }
      // Any quests still ON OFFER get one clear, deterministic opt-in line (omitted when none).
      this.emitOfferedQuestNotice();
      // A character's own kit belongs ON them (r5 P3): the builder sheet promised AC 16, play began
      // at AC 11 with the chain shirt and shield still in the bag, nothing said so, and the first
      // ambush would have been fought five points down for no reason the player could see.
      this.equipStartingKit();

      if (!existing) {
        const replace = store.replaceSave;
        if (typeof replace !== "function") throw new Error("This save store cannot atomically create a save.");
        const batch = this.eventBatch!;
        const durable = batch.events.filter((event) => this.isDurableEvent(event));
        await replace.call(store, this.saveKey, this.getState(), durable, { replayableFromOrigin: true });
        this.pendingEvents = [];
        batch.committed = true;
      } else {
        await this.persist();
      }
      this.publishEventBatch();
    } catch (err) {
      if (!this.eventBatch?.committed) this.discardEventBatch(seqStart);
      else this.eventBatch = null;
      throw err;
    }

    return this.getState();
  }

  /** Wipe the current campaign's saved progress and begin again from the opening. */
  async restart(): Promise<GameState> {
    const { playset, store } = this.deps;
    this.getModel();
    if (this.ticking) throw new Error("Another game operation is already in progress.");
    const replace = store.replaceSave;
    if (typeof replace !== "function") throw new Error("This save store cannot atomically restart a save.");
    const before = this.getState();
    const seqStart = this.bus.currentSeq?.() ?? 0;
    let committedWrite = false;
    this.beginEventBatch();
    this.ticking = true;
    try {
    // Un-mirror every enrichment AND expansion: restore the authored templates + rooms snapshotted
    // at construction so the fresh campaign seeds companions/NPCs and the map from authored content,
    // not the abandoned run's enriched templates or explore-time-appended pockets (the wiped slices
    // cannot un-mirror themselves). In-place so every module holding the world object sees the
    // restored arrays — mirrors the same baseline reset `rewindTo` performs.
    playset.world.npcs.splice(0, playset.world.npcs.length, ...structuredClone(this.authoredNpcs));
    playset.world.locations.splice(0, playset.world.locations.length, ...structuredClone(this.authoredLocations));
    const seed = this.initialState();
    this.loadFrom(seed);
    // Re-sync live agents to the fresh membership: drop agents for members recruited mid-run (a
    // fresh campaign has only the starting companions) and re-arm any starting companion whose
    // agent was dropped when the abandoned run released them.
    const model = this.getModel();
    for (const id of [...this.npcs.keys()]) {
      const e = model.entities.get(id);
      if (!e || !e.partyMember) {
        this.npcs.delete(id);
        this.heartbeat.unregister(id);
      }
    }
    for (const e of model.entities.values()) {
      if (e.kind === "npc" && e.partyMember) this.ensureCompanionAgent(e.id);
    }
    // The abandoned run's cached ephemeral reply agents must not speak in the fresh campaign, and a
    // pending in-memory agenda-pressure must not hijack the first input of the new run (audit #3).
    this.privateAgents.clear();
    this.agendaPressures.clear();
    this.bus.reseed?.(0);
    this.emit({ kind: "system", level: "info", message: "Campaign restarted from the beginning." });
    const opening = this.openingNarration();
    if (opening) this.emit({ kind: "narration", text: opening });
    this.emitOfferedQuestNotice();
    const durable = this.eventBatch!.events.filter((event) => this.isDurableEvent(event));
    await replace.call(store, this.saveKey, this.getState(), durable, { replayableFromOrigin: true });
    committedWrite = true;
    this.pendingEvents = [];
    this.eventBatch!.committed = true;
    this.publishEventBatch();

    // Only after the authoritative replacement succeeds may the abandoned timeline's derived caches
    // be invalidated. A failed restart therefore leaves both the old save and its memories intact.
    await this.resetDerivedCaches(playset.campaign.id);
    return this.getState();
    } catch (err) {
      if (!committedWrite) {
        this.restoreFromState(before);
        this.discardEventBatch(seqStart);
      } else {
        this.eventBatch = null;
      }
      throw err;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Resolve one player turn end-to-end as a tick.
   *
   * `options.toId` (Phase 6, click-to-chat) addresses the input as a PRIVATE line to one present
   * NPC: the turn is forced to a private dialogueToNpc (the classifier is skipped) and both the
   * player line and the reply carry `channel:"private"`. The id is validated HERE, before any tick
   * starts: it must name a present (party-location) entity of kind "npc" — a companion or a
   * location NPC, either of which has a reply path. An invalid/absent-entity id emits ONE
   * ephemeral system notice and consumes NO turn: no tick runs, the clock doesn't advance, and
   * nothing is persisted (system events never enter the durable log). Omitted ⇒ byte-identical
   * pre-Phase-6 behavior.
   */
  async submitPlayerInput(text: string, options?: { toId?: string; proposalFromId?: string }): Promise<void> {
    const input = text.trim();
    if (!input) return;
    const toId = options?.toId;
    if (toId !== undefined) {
      const model = this.getModel();
      const target = model.entities.get(toId);
      // A downed/dead NPC never answers a private aside either — the same consciousness gate the
      // public dialogueToNpc path enforces ("a corpse must not chat"), applied to click-to-chat so
      // the invariant holds on BOTH address paths, not just the public one.
      const conscious = !target?.stats || target.stats.currentHp > 0;
      const present =
        target !== undefined &&
        target.kind === "npc" &&
        conscious &&
        target.locationId === partyLocationOf(model);
      if (!present) {
        this.emit({
          kind: "system",
          level: "info",
          code: "private-undelivered",
          message: "There is no one here by that name to hear you — the private word goes unspoken.",
        });
        return;
      }
      await this.runTickQueued({ kind: "player", input, toId });
      return;
    }
    await this.runTickQueued({ kind: "player", input, proposalFromId: options?.proposalFromId });
  }

  /**
   * Resolve one GROUNDED player action (`GroundedAction`, src/engine/grounded.ts). Mirrors
   * `submitPlayerInput` but BYPASSES the LLM classifier: each typed
   * action maps 1:1 to a `TurnPlan` built here, and the SAME resolve pipeline (`resolvePlan` — the
   * tail `submitPlayerInput` also reaches) prices the turn, runs the depletion gate, and dispatches
   * to the per-kind resolver, so the reducer still does every mutation and the narrator still
   * describes the result. Validation is the resolver's own: an absent/unreachable/gated target is
   * rejected there, consuming no turn — this never throws to the caller.
   *
   * `answerProposal` is handled specially rather than via a plan: it reuses the existing
   * leader-proposal machinery (the autonomy module stashes
   *    the pending proposal each tick; an accept enqueues its grounded commands, a decline clears it).
   */
  async submitAction(action: GroundedAction): Promise<void> {
    const model = this.getModel();

    // Captivity is text-driven inside the hold, exactly like a scene: resolve the id → the button's
    // canonical label and feed it through the one input path so the CaptivityModule's resolve pass reads
    // it (labor/endure/escape). The label carries the keyword the module's classifier recovers.
    if (action.kind === "captivityAction") {
      const button = captivityActionButtons().find((b) => b.id === action.actionId);
      await this.submitPlayerInput(button?.label ?? action.actionId);
      return;
    }

    // Paper-doll wardrobe changes are a lightweight UI affordance, not a narrated turn: the
    // inventory item stays held, while modules.wardrobe records this slot as worn/removed.
    if (action.kind === "clothing") {
      await this.submitClothingAction(action);
      return;
    }

    // A leader-proposal answer reuses the EXISTING stashed-proposal machinery verbatim (the autonomy
    // perceive pass stashes the pending proposal each tick; resolvePlayer's PROPOSAL_ACCEPT_RE /
    // PROPOSAL_DECLINE_RE branch then executes or clears it). Route a canonical "yes"/"no" through the
    // one input path so an accept enqueues the proposal's grounded commands (reducer-only) and a
    // decline sets it aside — no reinvention.
    if (action.kind === "answerProposal") {
      // Carry the card's identity through the trigger so the accept branch answers the proposal the
      // player was actually shown — never a different companion's stale plan riding stashed[0].
      await this.submitPlayerInput(action.accept ? "yes" : "no", { proposalFromId: action.fromId });
      return;
    }

    const plan = this.planForAction(action, model);
    if (!plan) return; // unsupported typed action; no turn consumed
    await this.runTickQueued({ kind: "player", input: this.actionInputLine(action), plan });
  }

  private async submitClothingAction(action: Extract<GroundedAction, { kind: "clothing" }>): Promise<void> {
    if (!isWardrobeSlotId(action.slotId)) return;
    const gateModel = this.getModel();
    // One shared gate drives engine acceptance. It covers every state that owns the player's body
    // while preserving typed clothing turns as the in-combat route.
    const lock = wardrobeLockOf(gateModel);
    if (lock.locked) {
      this.emit({
        kind: "system",
        level: "info",
        message: lock.reason ?? "You cannot adjust your clothing right now.",
      });
      return;
    }
    if (this.ticking) throw new Error("Another game operation is already in progress.");
    const before = this.getState();
    const seqStart = this.bus.currentSeq?.() ?? 0;
    this.beginEventBatch();
    this.ticking = true;
    try {
      const player = playerEntity(this.getModel());
      if (!player) {
        this.eventBatch!.committed = true;
        this.publishEventBatch();
        return;
      }
      const wardrobe = (this.getModel().modules[WARDROBE_MODULE] as WardrobeSlice | undefined) ?? {};
      const current = wardrobe[player.id] ?? {};
      const next = { ...current, [action.slotId]: action.state };
      this.apply({ type: "modulePatch", module: WARDROBE_MODULE, patch: { [player.id]: next } });
      this.emit({
        kind: "stateChanged",
        summary:
          action.state === "worn"
            ? `You put your ${wardrobeSlotLabel(action.slotId)} back in order.`
            : `You adjust your ${wardrobeSlotLabel(action.slotId)}.`,
        changes: { wardrobe: { slotId: action.slotId, state: action.state } },
      });
      await this.persist();
      this.publishEventBatch();
    } catch (err) {
      if (!this.eventBatch?.committed) {
        this.restoreFromState(before);
        this.discardEventBatch(seqStart);
      } else {
        this.eventBatch = null;
      }
      throw err;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Map a typed `GroundedAction` to a `TurnPlan` (the classifier's output shape), grounded against
   * the live model. Every kind yields a plan the shared resolver validates. Ids are taken verbatim from the
   * typed action; the resolver rejects an absent, unreachable, or wrong-kind target without
   * consuming a turn (the same guard the classified path relies on).
   */
  private planForAction(action: GroundedAction, model: WorldModel): TurnPlan | null {
    const base = (): TurnPlan => ({
      kind: "freeformNarrative",
      targetId: null,
      destinationLocationId: null,
      check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
      confidence: 1,
    });
    switch (action.kind) {
      case "move":
        // The exitId IS a real destination location id (or a `frontier:` id) — the movement resolver
        // does barrier/frontier/open-world handling exactly as for a classified move.
        return { ...base(), kind: "movement", destinationLocationId: action.exitId };
      case "equip":
        return { ...base(), kind: "itemAction", item: { verb: "equip", itemId: action.itemId, targetId: null } };
      case "unequip":
        // Unequip grounds by the ITEM currently in the slot (the resolver walks slots by item id);
        // the wire carries a slot, so resolve it to the equipped item id here (else no-op narration).
        return {
          ...base(),
          kind: "itemAction",
          item: { verb: "unequip", itemId: equippedItemInSlot(model, action.slot), targetId: null },
        };
      case "useItem":
        return { ...base(), kind: "itemAction", item: { verb: "use", itemId: action.itemId, targetId: null } };
      case "give":
        return {
          ...base(),
          kind: "itemAction",
          targetId: action.toId,
          item: { verb: "give", itemId: action.itemId, targetId: action.toId },
        };
      case "acceptQuest":
        return { ...base(), kind: "questAction", quest: { verb: "accept", questId: action.questId } };
      case "declineQuest":
        return { ...base(), kind: "questAction", quest: { verb: "decline", questId: action.questId } };
      case "rest":
        return { ...base(), kind: "rest" };
      case "enterCamp":
        return { ...base(), kind: "enterCamp" };
      case "endDay":
        return { ...base(), kind: "endDay" };
      case "rentRoom":
        return { ...base(), kind: "rentRoom", lodging: { tierId: action.tierId } };
      case "wakeInRoom":
        return { ...base(), kind: "wakeInRoom" };
      case "attack":
        return { ...base(), kind: "attack", targetId: action.targetId };
      case "trade":
        return {
          ...base(),
          kind: "trade",
          targetId: action.vendorId,
          trade: { direction: action.direction, itemId: action.itemId, vendorId: action.vendorId },
        };
      case "tradeBatch":
        return {
          ...base(),
          kind: "tradeBatch",
          targetId: action.vendorId,
          tradeBatch: {
            vendorId: action.vendorId,
            lines: action.lines.map((l) => ({ direction: l.direction, itemId: l.itemId, quantity: l.quantity ?? 1 })),
          },
        };
      case "serviceBuy":
        return {
          ...base(),
          kind: "service",
          targetId: action.vendorId,
          service: { npcId: action.vendorId, serviceId: action.serviceId, itemId: action.itemId ?? null },
        };
      case "work":
        return { ...base(), kind: "work", work: { opportunityId: action.opportunityId } };
      case "recruitNpc":
        // A click-to-recruit a present NPC is just an invite through the stance gate.
        return { ...base(), kind: "partyAction", targetId: action.targetId, party: { verb: "invite", targetId: action.targetId } };
      case "joinParty":
        // A click-to-join a present NPC leader — the PC becomes their follower.
        return { ...base(), kind: "partyAction", targetId: action.leaderId, party: { verb: "join", targetId: action.leaderId } };
      case "hireMerc":
        return { ...base(), kind: "hireMercenary", recruit: { offerId: action.offerId } };
      case "locationInteraction":
        return { ...base(), kind: "locationInteraction", interaction: { interactionId: action.interactionId } };
      default:
        return null;
    }
  }

  /** A short human-readable line for a grounded action — the narration trigger + trace `input`. It
   *  is NEVER re-parsed (the plan carries the intent); it only gives the narrator/transcript words. */
  private actionInputLine(action: GroundedAction): string {
    switch (action.kind) {
      case "move":
        return `You head for ${this.locationName(action.exitId)}.`;
      case "equip":
        return `You ready the ${this.itemName(action.itemId)}.`;
      case "unequip":
        return `You stow what you have in your ${action.slot}.`;
      case "useItem":
        return `You use the ${this.itemName(action.itemId)}.`;
      case "give":
        return `You offer the ${this.itemName(action.itemId)} to ${this.actorName(action.toId)}.`;
      case "acceptQuest":
        return `You take on ${this.questName(action.questId)}.`;
      case "declineQuest":
        return `You turn down ${this.questName(action.questId)}.`;
      case "rest":
        return "You take a short rest.";
      case "enterCamp":
        return "You make camp for the night.";
      case "endDay":
        return "You break camp as the day begins.";
      case "rentRoom":
        return "You take a room for the night.";
      case "wakeInRoom":
        return "You rise with the new day.";
      case "attack":
        return `You attack ${this.actorName(action.targetId)}.`;
      case "trade":
        return action.direction === "buy"
          ? `You buy the ${this.itemName(action.itemId)}.`
          : `You sell the ${this.itemName(action.itemId)}.`;
      case "tradeBatch":
        return `You settle up at ${this.actorName(action.vendorId)}'s counter.`;
      case "serviceBuy":
        return `You engage ${this.actorName(action.vendorId)} for a piece of work.`;
      case "work":
        return "You set to work.";
      case "recruitNpc":
        return `You ask ${this.actorName(action.targetId)} to join you.`;
      case "joinParty":
        return `You throw in with ${this.actorName(action.leaderId)}.`;
      case "hireMerc":
        return "You sign a sellsword on from the board.";
      case "locationInteraction":
        return `You examine ${action.interactionId}.`;
      default:
        return "";
    }
  }

  /** Display name of an item id (masterlist/world; conjured slugs title-cased), for narration lines. */
  private itemName(itemId: string): string {
    return resolveItem(this.deps.playset.world, itemId)?.name ?? itemDisplayNameOf(itemId);
  }

  /** Fire a heartbeat tick for an NPC. Resolves to nothing until the autonomy module (Phase 6). */
  async tickHeartbeat(npcId: string): Promise<void> {
    if (this.model && isCombatActive(this.model)) return;
    // A player turn (or another heartbeat) is mid-flight OR queued — never interleave, never jump
    // the queue. `pendingTicks` covers the whole window from enqueue to completion (the bare
    // `ticking` flag is false while a queued player turn waits its turn, which was the D1 race: a
    // heartbeat fired in that gap and the player's turn then threw mid-flight). Crucially, a turn
    // blocked on a pending click-to-roll gate keeps its slot, so no autonomous line reaches the
    // client before the player has rolled. The NPC simply acts on its next free beat.
    if (this.ticking || this.pendingTicks > 0) return;
    await this.runTickQueued({ kind: "heartbeat", npcId });
  }

  /**
   * Serialize every tick through one promise chain (D1). Player submits arriving while a heartbeat
   * (or an earlier submit) is mid-flight now WAIT their turn instead of hitting `runTick`'s
   * in-flight throw; heartbeats never enqueue behind anything (they skip when busy, above). The
   * chain swallows a predecessor's rejection so one failed turn never poisons the next; the
   * caller still receives its own turn's rejection untouched.
   */
  private runTickQueued(trigger: TickTrigger): Promise<void> {
    this.pendingTicks++;
    const run = this.tickChain.then(() => this.runTick(trigger));
    this.tickChain = run.then(
      () => {
        this.pendingTicks--;
      },
      () => {
        this.pendingTicks--;
      },
    );
    return run;
  }

  /** Guard every tick with the in-flight flag (set across the whole turn, including a roll wait). */
  private async runTick(trigger: TickTrigger): Promise<void> {
    if (this.ticking) throw new Error("Another game operation is already in progress.");
    const before = this.getState();
    const seqStart = this.bus.currentSeq?.() ?? 0;
    const summaryBefore = { text: this.summaryText, cursor: this.summaryCursor };
    this.npcHistory.beginTurn(seqStart);
    this.disclosure.beginTurn(seqStart);
    this.beginEventBatch();
    this.ticking = true;
    try {
      await this.runTickInner(trigger);
      // A heartbeat with no state flag may skip core's persist hook. Still close the transaction so
      // any emitted beat and the snapshot share one commit boundary.
      if (!this.eventBatch?.committed) await this.persist();
      this.publishEventBatch();
    } catch (err) {
      // A post-commit observer fault cannot be rolled back durably. EventBus/trace observers are
      // isolated, so this is only a defensive escape hatch.
      if (this.eventBatch?.committed) {
        this.eventBatch = null;
        throw err;
      }
      this.derivedGen++;
      this.summaryStore.invalidate?.();
      this.summaryText = summaryBefore.text;
      this.summaryCursor = summaryBefore.cursor;
      this.npcHistory.truncateFrom(seqStart);
      this.disclosure.truncateFrom(seqStart);
      void this.npcHistory.save();
      void this.disclosure.save();
      this.restoreFromState(before);
      this.privateAgents.clear();
      this.discardEventBatch(seqStart);
      throw err;
    } finally {
      this.ticking = false;
    }
  }

  /** Stop background timers (the autonomy heartbeat). Call on shutdown so no autonomous tick fires
   *  after the player has quit (the "proposal after /quit" bug). Idempotent. */
  stop(): void {
    this.heartbeat.stop();
  }

  /** Pause/resume proactive NPC timers while retaining their registrations (for warm sessions). */
  setAutonomyPaused(paused: boolean): void {
    if (paused) this.heartbeat.pause();
    else this.heartbeat.resume();
  }

  /**
   * The player is composing a line right now. Purely a PACING signal: NPC heartbeats keep running
   * (the world stays alive while you think), but a leader's tacit-consent deadline is held, so an
   * unanswered proposal cannot execute itself out from under a half-typed reply — the 2026-07-24
   * playtest's "Meeting no objection, Oda follows through" landing mid-sentence. A client that never
   * calls this behaves exactly as before.
   */
  setComposing(active: boolean): void {
    this.composing = active;
  }

  /** True while the player has text in the composer (see {@link setComposing}). */
  isComposing(): boolean {
    return this.composing;
  }
  private composing = false;

  /** Assemble the per-tick context and run the phases. The turn always persists at the end. */
  private async runTickInner(trigger: TickTrigger): Promise<void> {
    this.getModel(); // throws if not started
    // The narrator's memory: the most recent events (newest N, oldest-first). Read a wider raw
    // window than the rendered cap so persisted deltas (which render as nothing) don't crowd out
    // real story lines; transcript() then trims to NARRATION_HISTORY_LIMIT renderable lines. A
    // read failure just means the narrator lacks recent history for this tick — not fatal.
    //
    // Private threads (Phase 6): a private line renders into NOTHING but its two parties' own
    // briefs, so a long whisper thread would crowd every public story line out of the fixed
    // window and starve the GM's `# RECENT`. Widen the read by the number of private lines seen
    // (iterating until the window is stable, hard-capped at RECENT_EVENT_READ_MAX) so the newest
    // public lines always survive the trim. A campaign with zero private messages takes exactly
    // one read of the same size as before — byte-identical briefs.
    let recent: GameEvent[] = [];
    try {
      let limit = RECENT_EVENT_READ_LIMIT;
      for (;;) {
        recent = await this.deps.store.readEvents(this.saveKey, { limit, includeSilent: false });
        const privateLines = recent.filter(
          (e) => e.kind === "dialogue" && e.channel === "private",
        ).length;
        const widened = Math.min(RECENT_EVENT_READ_LIMIT + privateLines, RECENT_EVENT_READ_MAX);
        if (widened <= limit || recent.length < limit) break; // stable, capped, or log exhausted
        limit = widened;
      }
    } catch {
      // continue with no history
    }
    const services: TickServices = {
      world: this.deps.playset.world,
      campaign: this.deps.playset.campaign,
      gateway: this.gateway,
      rng: this.rng,
      systemPrefix: this.deps.systemPrefix,
      client: this.deps.client,
      lore: this.lore,
      loreOptions: this.loreOptions,
      // The current rolling-summary (best-effort derived cache) for the narrate brief's
      // `# STORY SO FAR`. Empty until the first fold ⇒ no section rendered (byte-identical brief).
      storySoFar: this.summaryEnabled && this.summaryText ? this.summaryText : undefined,
      npcHistory: this.npcHistory,
      disclosure: this.disclosure,
      judge: this.judge,
      judgeStreamClean: this.judgeStreamClean,
      now: this.deps.now ?? Date.now,
      isComposing: () => this.composing,
      // The party domain mints and retires companion agents through this port (see CompanionRoster).
      companions: {
        attach: (npcId) => this.ensureCompanionAgent(npcId),
        detach: (npcId) => {
          this.npcs.delete(npcId);
          this.heartbeat.unregister(npcId);
        },
        templateFor: (entity) => this.npcTemplateFor(entity),
      },
    };
    const queue: Command[] = [];
    // The tick's authorized-command ledger — the Judge reads it (∪ queue) from `ctx.data.turnCommands`.
    const turnCommands: Command[] = [];
    const ctx: TickContext = {
      trigger,
      model: this.getModel(),
      services,
      recent,
      data: { turnCommands },
      queue,
      enqueue: (cmd) => queue.push(cmd),
      apply: (cmd) => this.apply(cmd),
      applySilent: (cmd) => this.applySilent(cmd),
      dryRun: (cmd) => this.dryRun(cmd),
      emit: (ev) => this.emit(ev),
      state: () => this.getState(),
    };
    // Bracket the turn for the trace (Workstream D): `seqStart` is the seq the tick's first event
    // will carry, and the per-turn `AsyncLocalStorage` scratch scopes correlation (turnSeq) + the
    // classifier's freeform-fallback reason across the tick's awaits, heartbeat-interleave-safe.
    const seqStart = this.bus.currentSeq?.() ?? 0;
    const atStart = Date.now();
    const scratch: TurnScratch = { turnSeq: seqStart };
    // Per-module attribution (Workstream D, attribution pass): who ran, what they enqueued/applied/
    // emitted, and what it cost. Built ONLY when a trace sink is attached — with no sink there is no
    // probe, the runner takes its original unwrapped path, and the tick is byte-identical to before.
    const moduleTrace: ModulePhaseTrace[] = [];
    const probe: TickProbe | undefined = this.deps.onTurnTrace
      ? { seq: () => this.bus.currentSeq?.() ?? 0, record: (rec) => void moduleTrace.push(rec) }
      : undefined;
    // Point the command ledger at THIS tick's array for the span of the tick body only, then detach
    // it in a `finally` (same discipline as `ticking`): a command applied outside a tick — or after
    // an exception here — can never dirty another turn's ledger.
    this.turnCommandSink = turnCommands;
    try {
      await turnContext.run(scratch, () => this.tick.run(ctx, probe));
    } finally {
      this.turnCommandSink = null;
    }

    // Emit the per-turn trace — best-effort telemetry, OFF the critical path (like the summary fold).
    this.emitTurnTrace(trigger, ctx.data, scratch, seqStart, atStart, moduleTrace);

    // Off the critical path: regenerate the rolling summary if enough new events have accrued. Fire-
    // and-forget + best-effort (like the background lore build) — it must NEVER block, slow, or crash
    // a turn, so it runs un-awaited and swallows every failure.
    void this.maybeFoldSummary();
  }

  /**
   * Build the turn's trace (Workstream D) and hand it to the best-effort sink. Pure telemetry — the
   * decision skeleton (classifier plan, freeform-fallback reason, accepted PUBLIC NPC beats), never
   * world state, never a delta. Swallows every failure so a trace bug can never break a turn.
   */
  private emitTurnTrace(
    trigger: TickTrigger,
    data: Record<string, unknown>,
    scratch: TurnScratch,
    seqStart: number,
    atStart: number,
    moduleTrace: ModulePhaseTrace[],
  ): void {
    if (!this.deps.onTurnTrace) return;
    try {
      const plan = data.plan as TurnPlan | undefined;
      const outcome = data.turnOutcome as TurnOutcome | undefined;
      const seqEnd = (this.bus.currentSeq?.() ?? seqStart) - 1;
      // A pure no-op heartbeat (zero events, no beats, no fallback) records nothing: the r9 run
      // wrote 313 heartbeat rows against 16 player turns, most with the inverted `seqEnd <
      // seqStart` range an empty batch produces — noise that buried the real traces in the
      // Observatory Turns view (F-15). A heartbeat that DID something still records.
      if (
        trigger.kind === "heartbeat" &&
        seqEnd < seqStart &&
        !outcome?.npc.length &&
        !outcome?.events?.length &&
        !scratch.fallback
      ) {
        return;
      }
      const trace: TurnTrace = {
        campaignId: this.saveKey.campaignId,
        characterId: this.saveKey.characterId,
        turnSeq: seqStart,
        seqStart,
        seqEnd,
        atStart,
        atEnd: Date.now(),
        trigger: trigger.kind,
        input: trigger.kind === "player" ? trigger.input : undefined,
        npcId: trigger.kind === "heartbeat" ? trigger.npcId : undefined,
        classifierKind: plan?.kind,
        classifierTargetId: plan ? plan.targetId : undefined,
        classifierConfidence: plan?.confidence,
        classifierCheck: !plan
          ? undefined
          : plan.check.warranted
            ? { ability: plan.check.ability, skill: plan.check.skill, dc: plan.check.dc }
            : null,
        // r10 — record WHAT the classifier asked commerce to move, not just that it was a trade:
        // the r10 report had to guess F-3's substitution mechanism because this was absent.
        classifierTrade: plan?.trade
          ? {
              direction: plan.trade.direction,
              itemId: plan.trade.itemId ?? null,
              vendorId: plan.trade.vendorId ?? null,
              ...(plan.trade.quantity ? { quantity: plan.trade.quantity } : {}),
              ...(plan.trade.inquiry ? { inquiry: true } : {}),
              ...(plan.trade.itemWords ? { itemWords: plan.trade.itemWords } : {}),
              ...(plan.trade.vendorWords ? { vendorWords: plan.trade.vendorWords } : {}),
            }
          : undefined,
        // r13 — the settle-then-move half, so a relocation the player ASKED for in the same sentence
        // is distinguishable from one the engine performed unbidden.
        classifierSecondaryMove: plan?.secondaryMove
          ? {
              destinationLocationId: plan.secondaryMove.destinationLocationId,
              destinationName: plan.secondaryMove.destinationName,
            }
          : undefined,
        fallback: scratch.fallback,
        // Map to explicit PUBLIC-SAFE fields — never spread the raw beat, so `confidence` (and any
        // future internal field) can't ride the trace or the non-gated turnIntent built from it.
        npcBeats: outcome?.npc.length
          ? outcome.npc.map((b) => ({
              actorId: b.actorId,
              name: b.name,
              ...(b.dialogue !== undefined ? { dialogue: b.dialogue } : {}),
              ...(b.lines && b.lines.length > 0 ? { lines: b.lines } : {}),
              ...(b.action !== undefined ? { action: b.action } : {}),
              ...(b.accepted !== undefined ? { accepted: b.accepted } : {}),
              ...(b.rejectedReason !== undefined ? { rejectedReason: b.rejectedReason } : {}),
              ...(b.factsAsserted && b.factsAsserted.length > 0 ? { factsAsserted: b.factsAsserted } : {}),
            }))
          : undefined,
        eventBeats: outcome?.events?.length ? outcome.events : undefined,
        socialModifiers: scratch.socialModifiers?.length ? scratch.socialModifiers : undefined,
        groundingFallbacks: scratch.groundingFallbacks?.length ? scratch.groundingFallbacks : undefined,
        consentBlocks: scratch.consentBlocks?.length ? scratch.consentBlocks : undefined,
        // Turn-auditor findings (best-effort, from narrateGuarded's screen of the emitted prose) —
        // mapped to explicit public-safe fields, the npcBeats discipline.
        audit: (() => {
          const raw = data.auditViolations as { kind?: unknown; detail?: unknown }[] | undefined;
          if (!raw?.length) return undefined;
          return raw.map((v) => ({ kind: String(v.kind ?? "unknown"), detail: String(v.detail ?? "") }));
        })(),
        // Per-module attribution: keep the handlers that DID something (mutated the world, emitted,
        // threw, or cost real time); the quiet remainder is COUNTED, not dropped, so the panel can
        // never read as "these were the only modules that ran".
        ...(() => {
          const loud = moduleTrace.filter(
            (m) =>
              m.enqueued !== undefined ||
              m.applied !== undefined ||
              m.emitted !== undefined ||
              m.error !== undefined ||
              m.ms >= MODULE_TRACE_MS_FLOOR,
          );
          const quiet = moduleTrace.length - loud.length;
          return {
            ...(loud.length > 0 ? { modules: loud } : {}),
            ...(quiet > 0 ? { modulesQuiet: quiet } : {}),
          };
        })(),
      };
      this.deps.onTurnTrace(trace);
    } catch {
      // Trace telemetry is best-effort; never break a turn.
    }
  }

  /**
   * Best-effort rolling-summary regeneration, OFF the turn's critical path. Fires after a tick (un-
   * awaited): if at least `SUMMARY_BATCH` new events have accrued past the fold cursor, it reads the
   * scrolled-out events, folds them into the summary (the deterministic digest is the offline/failure
   * floor), persists `{summary, cursorSeq}` to the sidecar, and advances the cursor + the in-memory
   * string used by the next brief. NEVER throws, NEVER mutates the WorldModel/reducer/deltas — the
   * summary is a derived cache, not source of truth.
   */
  private async maybeFoldSummary(): Promise<void> {
    if (!this.summaryEnabled || this.summaryFolding) return;
    this.summaryFolding = true;
    // Snapshot the timeline generation: a rewind mid-fold invalidates whatever this round computed.
    const gen = this.derivedGen;
    try {
      const campaignId = this.deps.playset.campaign.id;
      // Authoritative high-water seq, store-agnostic: the newest persisted event. (Both stores
      // support a limited readEvents; reading fresh reflects this turn's just-appended events.)
      let currentSeq = -1;
      try {
        const newest = await this.deps.store.readEvents(this.saveKey, { limit: 1, includeSilent: false });
        currentSeq = newest.at(-1)?.seq ?? -1;
      } catch {
        return; // can't read the log — skip this round
      }
      // Cadence: only regenerate once a batch of new events has scrolled past the cursor.
      if (currentSeq - this.summaryCursor < SUMMARY_BATCH) return;

      // The events folded this round: everything strictly after the cursor, up to the current seq.
      let batch: GameEvent[] = [];
      try {
        const since = await this.deps.store.readEvents(this.saveKey, {
          sinceSeq: this.summaryCursor + 1,
          includeSilent: false,
        });
        batch = since.filter((e) => e.seq <= currentSeq);
      } catch {
        return; // can't read the batch — skip
      }
      if (batch.length === 0) return;

      const nameOf = (id: string): string => this.actorName(id);
      const fold: FoldInput = {
        prevSummary: this.summaryText,
        batchLines: batch.map((e) => renderEventLine(e, nameOf, true)).filter((l): l is string => l !== null),
        digestLines: batch.map((e) => renderEventLine(e, nameOf, false)).filter((l): l is string => l !== null),
        maxWords: SUMMARY_MAX_WORDS,
      };
      // foldCampaignSummary never throws: offline/blocked/empty/error all return the deterministic
      // digest floor (which is pure → offline runs reproduce it). Generated via the guarded narrator.
      const next = await foldCampaignSummary(this.gateway, fold);

      // A rewind between this round's start and now cleared the summary and reseeded the cursor —
      // this fold folded a discarded timeline. Drop it rather than overwrite the rewound present.
      if (gen !== this.derivedGen) return;

      // Advance the cache + cursor, then persist the sidecar (best-effort; save never throws).
      this.summaryText = next;
      this.summaryCursor = currentSeq;
      await this.summaryStore.save({
        version: SUMMARY_STORE_VERSION,
        campaignId,
        summary: next,
        cursorSeq: currentSeq,
      });
    } catch {
      // Best-effort by contract: a summary fault must never surface to the turn.
    } finally {
      this.summaryFolding = false;
    }
  }

  /** Core tick module: reply-decay reset, player resolution, the commit transaction, persist. */
  private coreModule(): TickModule {
    return {
      id: "core",
      phases: {
        perceive: (ctx) => {
          // Player input is priority A: reset reply-chain decay. Player ticks always persist;
          // a heartbeat persists only if a react module enqueues a change (handled at commit).
          ctx.data.persist = ctx.trigger.kind === "player";
          if (ctx.trigger.kind === "player") this.resetReplyDepth(ctx.model);
        },
        resolve: async (ctx) => {
          if (ctx.trigger.kind !== "player") return;
          await this.resolvePlayer(ctx);
          // The narration trigger is settled now, and the react phase (NPC reply/decide LLM calls)
          // runs before narrate — kick the lore embedding round-trip here so it OVERLAPS those calls
          // instead of serializing in front of the narrator. Pure latency: the narrate module awaits
          // this same promise, so the retrieved result is byte-identical.
          this.prefetchLore(ctx);
        },
        commit: (ctx) => {
          // The transaction: react-phase commands mutate here, not before. Player mechanics
          // already applied in resolve so narration reflected them.
          if (ctx.queue.length > 0) ctx.data.persist = true;
          // Entities BORN in this commit's batch are spared from the cull: an authored
          // "spawn elsewhere" effect (prebaked/camp/anywhere npc-event) must not be applied and
          // reaped in the same breath — that would turn the effect into a silent no-op while
          // still burning its once-per-campaign trigger. Normal tier semantics resume next tick.
          const bornThisCommit = queuedSpawnIds(ctx.queue);
          for (const cmd of ctx.queue) this.apply(cmd);
          ctx.queue.length = 0;
          this.syncAgendaPressures(ctx);
          // World maintenance at the ONE commit chokepoint: reap transient extras the party left
          // behind, AFTER the queue drain so react-path moves (the autonomy leader's tacit-consent
          // moveParty) are covered too — the old per-movement-branch calls in resolvePlayer missed
          // them. Safe this late in the tick: no narrate-phase surface reads non-co-located
          // entities, and the despawn deltas still land in this tick's batch before persist.
          const maintenance = worldMaintenance(this.getModel(), partyLocationOf(this.getModel()), bornThisCommit);
          if (maintenance.length > 0) {
            ctx.data.persist = true;
            for (const cmd of maintenance) this.apply(cmd);
          }
          // The ONE per-turn cost chokepoint (Workstream H): the resolve phase priced the turn
          // (ctx.data.clockMinutes / energyCost from the src/rules/costs.ts table); paths that
          // only flip advancesClock (agenda pressure, private dialogue) price as the default
          // spoken beat (r4 playtest: the clock must move on every prompt, or thirty turns of
          // talk fit inside one morning and no deadline can ever arrive). Heartbeats never set
          // advancesClock — NPC autonomy is never taxed. Rest prices at zero here: its resolver
          // advances LONG_REST_MINUTES itself.
          // At camp (long rest) time is stopped: no clock/energy spend, whatever a resolver priced.
          if (ctx.data.advancesClock && !isAtCamp(ctx.model)) {
            const minutes = typeof ctx.data.clockMinutes === "number" ? ctx.data.clockMinutes : DEFAULT_TURN_MINUTES;
            if (minutes > 0) this.applySilent({ type: "advanceClock", by: minutes });
            const player = playerEntity(ctx.model);
            const baseEnergy = typeof ctx.data.energyCost === "number" ? ctx.data.energyCost : 0;
            const energy = Math.max(0, baseEnergy + (player ? statusMods(ctx.model, player.id).energy : 0));
            if (energy > 0 && player?.stats) {
              this.spendEnergyOrExhaust(player.id, energy);
            }
          }
        },
        persist: async (ctx) => {
          if (ctx.data.persist !== false) await this.persist();
        },
      },
    };
  }

  /**
   * Start the read-only lore retrieval for this turn's narration OFF the narrate critical path.
   * Called at the tail of the resolve phase (the narration trigger is finalized, and no react module
   * rewrites it), so the embedding round-trip runs concurrently with the react-phase NPC calls. The
   * narrate module awaits the stashed promise when its trigger matches; a turn with no settled intent
   * (private whisper, heartbeat-driven beat) simply skips it and the narrate module retrieves fresh.
   * Best-effort by contract — `retrieve` never throws (empty buckets on any fault).
   */
  private prefetchLore(ctx: TickContext): void {
    const lore = ctx.services.lore;
    const intent = ctx.data.narration as NarrationIntent | undefined;
    // A deterministic intent (hard mechanical refusal) is emitted verbatim and never reaches the
    // narrator/retriever — skip it so we don't fire a wasted embed the narrate phase would drop.
    if (!lore || !intent || intent.deterministic) return;
    ctx.data.lorePrefetchTrigger = intent.trigger;
    ctx.data.lorePrefetch = lore.retrieve(intent.trigger, ctx.services.loreOptions);
  }

  /** Spend short-term energy; if the spend overruns the pool, ratchet exhaustion and refresh the cap. */
  private spendEnergyOrExhaust(entityId: string, cost: number): void {
    const entity = this.getModel().entities.get(entityId);
    if (!entity?.stats || cost <= 0) return;
    const level = exhaustionOf(entity.stats);
    const max = maxEnergyOf(entity.stats);
    const current = energyOf(entity.stats);
    const afterSpend = current - cost;
    if (afterSpend >= 0) {
      const capped = Math.min(afterSpend, workingCap(level, max));
      if (capped !== current) this.applySilent({ type: "adjustEnergy", entityId, by: capped - current });
      return;
    }

    const nextLevel = Math.min(EXHAUSTION_MAX, level + 1);
    this.applyExhaustionTransition(entityId, nextLevel);
    const live = this.getModel().entities.get(entityId);
    if (!live?.stats) return;
    const cap = workingCap(nextLevel, maxEnergyOf(live.stats));
    const target = Math.max(0, cap - cost);
    const now = energyOf(live.stats);
    if (target !== now) this.applySilent({ type: "adjustEnergy", entityId, by: target - now });
  }

  /** Apply side effects that happen when the persistent exhaustion ladder crosses key thresholds. */
  private applyExhaustionTransition(entityId: string, toLevel: number): void {
    const entity = this.getModel().entities.get(entityId);
    if (!entity?.stats) return;
    const from = exhaustionOf(entity.stats);
    const target = Math.max(from, Math.min(EXHAUSTION_MAX, Math.trunc(toLevel)));
    if (target > from) {
      this.applySilent({ type: "adjustExhaustion", entityId, by: target - from });
    }

    const live = this.getModel().entities.get(entityId);
    if (!live?.stats) return;
    if (from < 5 && target >= 5 && live.stats.currentHp > 1) {
      const debit = Math.max(1, Math.floor(live.stats.maxHp * 0.25));
      const loss = Math.min(debit, live.stats.currentHp - 1);
      if (loss > 0) this.applySilent({ type: "adjustHp", entityId, by: -loss });
    }
    if (target >= EXHAUSTION_MAX && !live.stats.conditions.includes("unconscious")) {
      this.applySilent({ type: "setCondition", entityId, condition: "unconscious", active: true });
    }
  }

  /**
   * Bounded proposal-answer matchers (see the PROPOSAL ANSWER branch in resolvePlayer). These are
   * deliberately engine-side and deterministic — NOT a classifier kind — because a leader's
   * proposal must be answerable offline; anything they don't match falls through to normal
   * classification, which is the historic cancel path (now merely visible instead of silent).
   *
   * Bounded as a LEADING answer word in a SHORT input
   * (≤ 5 words), NO question mark, and NO contrast connective. A bare prefix match executed the
   * whole plan on "Okay, but first let me talk to Sera" and swallowed "Wait — what's at the
   * barrow?" as a silent decline; a mixed sentence or a question is NOT an answer — it falls
   * through to classification (the safe direction), cancelling the proposal exactly as every
   * non-answer input always has. Short compound answers ("yes, lead on", "no, hold position")
   * still read naturally as answers.
   *
   * THE QUALIFIER GAP, r8 review. The concessive lookahead used to span only whitespace and a
   * COMMA, so ending the answer word with a period defeated it outright — and `lexicalAccept` is
   * computed first, which means the classifier is never consulted and the leader's stashed
   * `moveParty` executes on a flat rejection. Reproduced against the shipped regex:
   *
   *   "Fine, but not the mine."   accept:false   ← the comma form was already handled
   *   "Fine. But not that way."   accept:TRUE    ← the party walks that way
   *   "Fine. Not the mine."       accept:TRUE
   *   "Yes. But wait."            accept:TRUE
   *   "OK. Though I doubt it."    accept:TRUE
   *
   * So the gap now spans sentence punctuation, and ACCEPT (only) also treats a leading negation as
   * a qualifier: "Fine. Not the mine." is a refusal spelled without "but". DECLINE keeps the
   * connective list alone — "No. Not the mine." is a decline twice over, not a qualified one. A
   * qualified answer matching NEITHER matcher is not lost: it goes to the classifier's closed
   * `proposalAnswer` with the proposal in the prompt, which is the whole point of the r8 ordering.
   */
  private static readonly PROPOSAL_ACCEPT_RE =
    /^\s*(?:yes|aye|agreed?|do it|lead on|let'?s go|go ahead|very well|fine|okay|ok|sounds good|accept)\b(?!\s*[,.;:!—–-]*\s*(?:but|though|although|however|unless|if|not|no|nope|never)\b)/i;
  private static readonly PROPOSAL_DECLINE_RE =
    /^\s*(?:no|nay|not (?:yet|now)|hold|wait|stand down|decline|refuse)\b(?!\s*[,.;:!—–-]*\s*(?:but|though|although|however|unless|if)\b)/i;

  /** An input short and plain enough to BE an answer (the matchers above only lead it). */
  private static isProposalAnswerShaped(input: string): boolean {
    return input.trim().split(/\s+/).length <= 5 && !input.includes("?");
  }

  // ASSENT BY ECHO — `isProposalEcho` — IS DELETED (r8 regex audit). It answered "did the player
  // say the plan back?" with string containment: every content word of the answer had to already
  // appear in the proposal. The 2026-07-24 beat it was written for ("We go up. Together." answered
  // verbatim) is real, but the test cannot tell assent from a REJECTION assembled out of the
  // proposal's own vocabulary — against "We should head for the mine, not the road", the answer
  // "Not the mine." introduced no new word, scored ACCEPT, and the leader's stashed `moveParty`
  // walked the party to the mine the player had just refused (reproduced against the shipped code).
  // Both readings now come from the classifier's closed `TurnPlan.proposalAnswer`, with the
  // PENDING_PROPOSAL text in the prompt so it is answering the same question — see the branch in
  // `resolvePlayer`. The two bounded word matchers above stay in FRONT of it, free and unchanged.

  /**
   * Classify this turn's line AT MOST ONCE, memoized on per-tick scratch.
   *
   * The r8 migration moved six regexes that read open-ended prose onto closed `TurnPlan` fields, and
   * several of their readers sit in `resolvePlayer` branches that RETURN before the main
   * classification (a standing demand, a leader's proposal, a captive turn, a live scene). Routing
   * every one of them through here is what keeps the promise the migration rests on: a turn still
   * costs exactly one utility call, no matter how many branches consult the plan. A branch that
   * consults it and then falls through hands its cached plan to the main path below for free.
   *
   * `situational` is only honored on the FIRST call of a turn — the branches that pass it are
   * mutually exclusive by construction (a whisper, a demand, and a proposal each return), and a
   * silently re-prompted second classification is the exact cost this helper exists to prevent.
   */
  private async classifyOnce(
    ctx: TickContext,
    input: string,
    situational?: Pick<ClassifierContext, "pendingDemand" | "pendingProposal">,
  ): Promise<TurnPlan> {
    const cached = ctx.data.classifiedPlan as TurnPlan | undefined;
    if (cached) return cached;
    const plan = await this.classifier.classify(input, this.buildClassifierContext(ctx.recent, input, situational));
    ctx.data.classifiedPlan = plan;
    return plan;
  }

  /**
   * `classifyOnce` for the branches that OWN their turn (demand / proposal / captivity / live
   * scene). A classifier hiccup there must not break the turn — every one of them has a documented
   * regex-or-default floor to fall back to — so the throw is swallowed and `undefined` means
   * "no model answer", exactly the same signal a plan with a null field carries.
   */
  private async classifyOnceSafe(
    ctx: TickContext,
    input: string,
    situational?: Pick<ClassifierContext, "pendingDemand" | "pendingProposal">,
  ): Promise<TurnPlan | undefined> {
    try {
      return await this.classifyOnce(ctx, input, situational);
    } catch {
      return undefined;
    }
  }

  /** Player-turn resolution: classify, apply mechanics now, and park the narration intent. */
  private async resolvePlayer(ctx: TickContext): Promise<void> {
    if (ctx.trigger.kind !== "player") return;
    const input = ctx.trigger.input.trim();
    const model = ctx.model;
    const playerId = playerEntity(model)?.id ?? "pc.you";

    // Take (and clear) any standing travel quote: it is good for exactly THIS turn. A matching
    // movement line or a bare "yes" below commits it; any other turn lets it rest — the quote's
    // own wording promises as much, so silent expiry is self-documenting. The scratch handoff
    // lets the movement branch (reachOpenWorld) recognize "the same destination, quoted last
    // turn" as confirmation.
    const armedTravel = this.pendingTravel;
    this.pendingTravel = null;
    if (armedTravel) ctx.data.pendingTravel = armedTravel;

    // Same one-turn handoff for a camp-under-a-roof confirmation (see `pendingCamp`).
    const armedCamp = this.pendingCamp;
    this.pendingCamp = null;
    if (armedCamp) ctx.data.pendingCamp = armedCamp;

    // ...and for an errand quote (see `pendingErrand`).
    const armedErrand = this.pendingErrand;
    this.pendingErrand = null;

    // PRIVATE THREAD (Phase 6): a validated `toId` forces this turn to a private dialogueToNpc —
    // no classifier, no other routing. Deliberately checked BEFORE the pending-pressure branch: a
    // private aside neither answers nor discharges a standing public demand (the pressure stays
    // pending for the player's next public input).
    if (ctx.trigger.toId !== undefined) {
      this.resolvePrivateDialogue(ctx, ctx.trigger.toId, input, playerId);
      return;
    }

    // A live captivity hold owns the turn: the CaptivityModule's resolve pass reads the player's line as a captivity action
    // (labor/endure/escape). The generic check pipeline must NOT also run, or a natural-language
    // action would be double-resolved. A captive turn is a long, grinding stretch — price it as an
    // hour so days pass while held — but it never drains energy (no exhaustion soft-lock in a cell).
    //
    // The line IS classified (r8), for `plan.captivityAction` alone — the closed answer that replaced
    // `classifyCaptivityInput`, whose `/\brun\b/` arm scored "I run my hands along the wall looking
    // for loose stones" as a break-out: a real d20, a permanently raised escapeDc, and a burned day.
    // The stashed plan is READ ONLY BY the captivity module's action pick; core still resolves
    // nothing here, so there is no double-roll. A clicked button label short-circuits without a call.
    if (isCaptive(model)) {
      ctx.data.advancesClock = true;
      ctx.data.clockMinutes = 60;
      ctx.data.energyCost = 0;
      if (!captivityActionButtons().some((b) => b.label.toLowerCase() === input.trim().toLowerCase())) {
        ctx.data.captivityPlan = await this.classifyOnceSafe(ctx, input);
      }
      return;
    }

    // GROUNDED ACTION (engine.submitAction): a pre-built plan runs DIRECTLY — bypassing the
    // classifier AND the free-text pre-branches below (a typed action neither discharges a standing
    // agenda-pressure nor answers a leader proposal — those interpret prose the player didn't type).
    if (ctx.trigger.plan) {
      // A clicked action is not an answer — any pending proposal card drops VISIBLY (never the
      // 2026-07-25 silent vanish whose stale commands later executed out of context).
      this.emitProposalDropBeat(ctx);
      await this.resolvePlan(ctx, ctx.trigger.plan, input);
      return;
    }

    const pressure = this.agendaPressures.get(playerId);
    if (pressure) {
      this.agendaPressures.delete(playerId);
      ctx.data.advancesClock = true;
      // Classify the ANSWER (r8): `plan.pressureAnswer` is the closed comply/refuse/neutral read
      // that replaced `pressureAnswerOf`'s word-lists, whose `fine` arm scored "Fine. But you will
      // have to pry it from me." as compliance — the demanded item transferred with no roll and the
      // RESOLVED block told the narrator the player gave it up willingly. The demand itself rides
      // into the prompt as PENDING_DEMAND so the model is answering a question it can see. One call
      // (`classifyOnce`), and a hiccup ⇒ no field ⇒ the prose floor, exactly as today.
      const answerPlan = await this.classifyOnceSafe(ctx, input, {
        pendingDemand: { npcName: this.actorName(pressure.npcId), summary: pressure.summary },
      });
      ctx.data.narration = await resolveAgendaPressure(pressure, input, ctx, answerPlan);
      return;
    }

    // PROPOSAL ANSWER: the autonomy module's perceive pass just cancelled the leader's pending
    // proposal (priority-A override, unchanged) and stashed it into per-tick scratch. A bounded,
    // deterministic yes/no matcher runs HERE — after the private-thread and agenda-pressure
    // branches (a whisper or a demanded answer is never swallowed as a proposal answer), before
    // the classifier (proposals must be answerable offline). An accept enqueues the proposal's
    // grounded commands for the core commit — reducer-only mutation preserved. Anything that is
    // neither an accept nor an explicit decline falls through to normal classification: the
    // historic cancel, now visible instead of silent.
    const stashed = ctx.data.pendingProposals as CancelledProposal[] | undefined;
    // The clicked card answers ITS OWN proposal (`answerProposal.fromId` rides the trigger); a typed
    // "yes" answers the proposal the UI displays — leader-first stash order, first with a spoken
    // line (appointed leader first, then slice order). With two companions holding plans, stashed[0] and the
    // rendered card were different proposals (2026-07-25 playtest: "get inside Vellmere" on the
    // card, a stale backwards moveParty executed).
    const proposalFromId = ctx.trigger.proposalFromId;
    const answered = proposalFromId
      ? stashed?.find((p) => p.npcId === proposalFromId)
      : (stashed?.find((p) => p.text.trim().length > 0) ?? stashed?.[0]);
    if (stashed && answered && GameEngine.isProposalAnswerShaped(input)) {
      const leaderName = this.actorName(answered.npcId);
      // ASSENT BY ECHO IS NOW THE CLASSIFIER'S CALL (r8). `isProposalEcho` asked "is every content
      // word of the answer already in the proposal?", which is true of a REJECTION built from the
      // proposal's own vocabulary: against "We should head for the mine, not the road", the answer
      // "Not the mine." contained nothing new, scored ACCEPT, and the leader's stashed moveParty
      // walked the whole party to the mine the player had just refused (reproduced, r8 audit).
      //
      // Order is deliberate and costs nothing extra: the two bounded word matchers run FIRST (free,
      // deterministic, and they cover the overwhelmingly common "yes"/"no"), and only a shaped line
      // they BOTH miss — which was going to be classified below anyway — consults the model. The
      // proposal rides in as PENDING_PROPOSAL. Null/hiccup ⇒ "neither" ⇒ the historic fall-through,
      // the one branch that mutates nothing.
      const lexicalAccept = GameEngine.PROPOSAL_ACCEPT_RE.test(input);
      const lexicalDecline = GameEngine.PROPOSAL_DECLINE_RE.test(input);
      const namedAnswer =
        lexicalAccept || lexicalDecline
          ? null
          : ((
              await this.classifyOnceSafe(ctx, input, {
                pendingProposal: { npcName: leaderName, text: answered.text },
              })
            )?.proposalAnswer ?? null);
      if (lexicalAccept || namedAnswer === "accept") {
        ctx.data.advancesClock = true;
        // Spoken assent prices as a dialogue beat whether or not the plan lands — the beat was
        // still spent.
        ctx.data.clockMinutes = DEFAULT_TURN_MINUTES;
        ctx.data.energyCost = 0;
        // A SIBLING companion's cancelled proposal still drops visibly on an answered turn — the
        // "yes" consumes only the answered card (review finding #2).
        this.emitProposalDropBeat(ctx, answered.npcId);
        const plan = answered.text.trim();
        // STALE-PLAN GUARD: the commands were grounded against the location the proposal was ARMED
        // at; once the party stands elsewhere, that baked destination is meaningless — and if it
        // happens to be ADJACENT (the room just walked in from), the dry-run below would happily
        // teleport the party backwards for free (2026-07-25 playtest: AGREE at Sela's door undid an
        // 8.3-hour day). Refuse honestly instead. Absent origin ⇒ pre-fix save ⇒ legacy behavior.
        if (answered.originLocationId !== undefined && partyLocationOf(model) !== answered.originLocationId) {
          ctx.data.narration = {
            trigger: `${leaderName}'s plan was made for somewhere you've since left — the moment has passed.`,
          } satisfies NarrationIntent;
          return;
        }
        // Only the ANSWERED leader's plan executes — a second leader's stale proposal must not ride
        // along on someone else's "yes". APPLY the grounded commands NOW (in resolve) and gate the
        // assent narration on them landing: the proposal was grounded when it was ARMED, but state
        // can drift before the player answers (a barrier closes, the destination goes unreachable),
        // and enqueuing for commit would let the reducer silently reject AFTER the prose already
        // claimed the plan happened — the party stays put while the GM narrates the journey
        // (audit #4). All-or-nothing via dry-run so a multi-command plan can't half-apply; mirrors
        // the player-movement branch (validate → mutate → narrate the truth).
        const wouldReject = answered.commands.some((cmd) => ctx.dryRun(cmd).rejected);
        if (wouldReject) {
          ctx.data.narration = {
            trigger: `You agree to ${leaderName}'s plan, but it comes to nothing — the way it hinged on is no longer open.`,
          } satisfies NarrationIntent;
          return;
        }
        // An agreed MOVE is a real journey, not a spoken beat: price it like the player-movement
        // branch (authored exit minutes, exhaustion factor, scaled energy) BEFORE applying — the
        // edge is looked up from the still-current location. The 2026-07-25 playtest walked whole
        // regions for 1 minute/0 energy through this door.
        const agreedMove = answered.commands.find(
          (c): c is Extract<Command, { type: "moveParty" } | { type: "moveEntity" }> =>
            c.type === "moveParty" || c.type === "moveEntity",
        );
        if (agreedMove) priceMovementTurn(ctx, agreedMove.to);
        for (const cmd of answered.commands) this.apply(cmd);
        // Quiet (r7 P4): the narrator's own prose carries the assent — the same sentence printed
        // as a `·` ledger line AND again in the paragraph read as the scene ending twice.
        this.emit({ kind: "stateChanged", summary: `You agree to ${leaderName}'s plan.`, quiet: true });
        // The trigger goes verbatim under `# NOW` — the slot that on every OTHER turn carries the
        // PLAYER's own words (`You speak to X: "<input>"`). Appending the leader's spoken line there
        // taught the model that those were the player's words too, and it expanded them into
        // paragraphs of invented player dialogue: the 2026-07-24 playtest got a three-sentence
        // tactical speech quoted as its own ("Oda's right… Three signals. Sela—trace the loops…").
        // The plan belongs in the AUTHORITATIVE facts block, attributed to whoever actually said it.
        ctx.data.narration = { trigger: `You agree to ${leaderName}'s plan.` } satisfies NarrationIntent;
        if (plan) {
          const consequences = (ctx.data.consequences as string[] | undefined) ?? [];
          consequences.push(
            `${leaderName} proposed: "${plan}" — and the player agreed. Those are ${leaderName}'s words, not the player's; do not put them, or any speech like them, in the player's mouth.`,
          );
          ctx.data.consequences = consequences;
        }
        return;
      }
      if (lexicalDecline || namedAnswer === "decline") {
        ctx.data.advancesClock = true;
        ctx.data.clockMinutes = DEFAULT_TURN_MINUTES;
        ctx.data.energyCost = 0;
        // Sibling proposals drop visibly here too (review finding #2).
        this.emitProposalDropBeat(ctx, answered.npcId);
        // Feature 3: waving off the leader's plan is a slight to its authority — it nurses the grudge.
        bumpGrievance(ctx, model, answered.npcId);
        this.emit({ kind: "stateChanged", summary: `${leaderName}'s plan is set aside.` });
        ctx.data.narration = {
          trigger: `You wave off ${leaderName}'s plan and keep your own counsel.`,
        } satisfies NarrationIntent;
        return;
      }
    }

    // Falling past the yes/no matcher means the input was NOT an answer: the cancelled proposal
    // (priority-A override) would historically vanish in silence. Leave a visible line instead —
    // but ONLY when the turn actually contradicts the plan (the party walks away from it). The
    // r6 playtest read the unconditional line as nagging: it fired while the player was buying
    // gear FOR the very trip proposed. Compatible business drops the card quietly into the
    // narrator's ear instead of marking the player down. (The plan isn't classified yet at this
    // point in resolvePlayer, so the contradiction sniff runs on the raw line — it only decides
    // whether a ledger line prints, never any state.)
    //
    // `head` needs its complement, r8 regex audit — bare `\bhead\b` is the body part far more often
    // than the verb. Reproduced against the shipped engine with Maelle's "Let's make for the green"
    // standing: "I rest my head against the cold wall for a moment." printed "Maelle Ashfield lets
    // the plan drop." on the ledger — the player was marked down for walking away while sitting
    // still. So `head` scores only with a direction or destination behind it, the same discipline
    // `run (?:for|to|away)` already carries here (running your HANDS over a wall is not flight) —
    // and never behind a possessive or an article, which is what makes it the body part ("I keep my
    // head down and count the coins again" satisfies the complement rule on its own).
    this.emitProposalDropBeat(ctx, undefined, {
      visible:
        /\b(go|walk|travel|leave|depart|return|flee|bolt|set out|run (?:for|to|away))\b|(?<!\b(?:my|his|her|their|your|our|its|the|a)\s)\bhead(?:s|ing)?\s+(?:for|to|toward|towards|back|out|off|up|down|over|into|in|on|along|straight|north|south|east|west|home)\b/i.test(
          input,
        ),
    });

    // TRAVEL-QUOTE ANSWER: a known-roads journey quoted LAST turn commits on a bare "yes" — the
    // same deterministic matchers the proposal branch uses, never a classifier guess — and rests
    // on an explicit "no". Deliberately BELOW the leader-proposal branch (when both a card and a
    // quote stand, the "yes" belongs to the card the player can see).
    if (armedTravel && GameEngine.isProposalAnswerShaped(input)) {
      if (GameEngine.PROPOSAL_DECLINE_RE.test(input)) {
        ctx.data.advancesClock = true;
        ctx.data.clockMinutes = DEFAULT_TURN_MINUTES;
        ctx.data.energyCost = 0;
        ctx.data.narration = {
          trigger: `You set the road to ${armedTravel.destName} aside for now.`,
        } satisfies NarrationIntent;
        return;
      }
      if (GameEngine.PROPOSAL_ACCEPT_RE.test(input)) {
        ctx.data.advancesClock = true;
        ctx.data.narration = executeKnownRoadsTravel(ctx, armedTravel.destId, armedTravel.destName);
        return;
      }
    }

    // ERRAND-QUOTE ANSWER (r5): same deterministic shape, one rung below the travel quote — with a
    // card, a road and an errand all standing, a bare "yes" belongs to the most recently offered
    // thing the player can see, and the travel quote is the louder of the two.
    if (armedErrand && GameEngine.isProposalAnswerShaped(input)) {
      if (GameEngine.PROPOSAL_DECLINE_RE.test(input)) {
        ctx.data.advancesClock = true;
        ctx.data.clockMinutes = DEFAULT_TURN_MINUTES;
        ctx.data.energyCost = 0;
        ctx.data.narration = {
          trigger: `You let it go — ${armedErrand.runnerName} stays where they are.`,
          deterministic: true,
        } satisfies NarrationIntent;
        return;
      }
      if (GameEngine.PROPOSAL_ACCEPT_RE.test(input)) {
        ctx.data.advancesClock = true;
        ctx.data.clockMinutes = DEFAULT_TURN_MINUTES;
        ctx.data.narration = dispatchErrand(ctx, armedErrand);
        return;
      }
    }

    // An explicit compound gear command is fully groundable from the live pack and should not
    // depend on an LLM squeezing two actions into the single-item TurnPlan wire shape. The live N4
    // sentence ("buckle on the leather armor and take the club in hand") was classified as freeform,
    // so resolving extras only inside itemAction still dropped both mutations. Intercept only when
    // TWO OR MORE carried, equip-compatible items are each named in their own readiness clause; a
    // single-item line and ambiguous handling still go through the ordinary classifier.
    const player = playerEntity(model);
    const explicitGear = player?.stats ? explicitEquipItems(ctx, player.stats.inventory, input) : [];
    if (explicitGear.length >= 2) {
      const plan: TurnPlan = {
        kind: "itemAction",
        targetId: null,
        destinationLocationId: null,
        check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
        item: { verb: "equip", itemId: explicitGear[0]!.id, targetId: null },
        confidence: 1,
      };
      this.emit({ kind: "dialogue", actorId: playerId, text: input });
      await this.resolvePlan(ctx, plan, input);
      return;
    }

    const plan = await this.classifyOnce(ctx, input);
    // Record the player's own free-text line as a scene event BEFORE resolving it. `dialogueToNpc`
    // emits its own targeted dialogue event (skip it here to avoid a double), and `metaOOC` is an
    // out-of-character aside that must not become a scene line — every other kind (freeform action,
    // movement, a check attempt…) otherwise reached the narrator ONLY as this turn's trigger and was
    // never recorded. That gap dropped the line from the exported transcript AND left the narrator's
    // `# RECENT` history blind to what the player did, so later turns lost the thread — the GM began
    // mis-attributing the player's own actions to an NPC. The client already showed the line via
    // its optimistic "me" echo and dedups this event by matching text, so no double appears there.
    if (plan.kind !== "dialogueToNpc" && plan.kind !== "metaOOC") {
      this.emit({ kind: "dialogue", actorId: playerId, text: input });
    }
    await this.resolvePlan(ctx, plan, input);
  }

  /**
   * A pending leader proposal the player's input did NOT answer dies VISIBLY: one `stateChanged`
   * line plus a consequences note the narrator may weave, PER dropped proposal. The 2026-07-25
   * playtest watched the morning's card vanish without a word — and its stale baked commands were
   * the prime suspect in the day's teleports. Non-answer paths call this with no exclusion; the
   * accept/decline paths call it with the ANSWERED proposal excluded, so a sibling companion's
   * cancelled plan never vanishes in silence either (review finding #2).
   */
  private emitProposalDropBeat(ctx: TickContext, excludeNpcId?: string, opts: { visible?: boolean } = {}): void {
    const stashed = ctx.data.pendingProposals as CancelledProposal[] | undefined;
    if (!stashed || stashed.length === 0) return;
    const visible = opts.visible !== false;
    for (const dropped of stashed) {
      if (dropped.npcId === excludeNpcId) continue;
      const dropName = this.actorName(dropped.npcId);
      // The `·` line is reserved for contradictions (r6 P3); a compatible action drops the card
      // into the narrator's ear only, below.
      if (visible) this.emit({ kind: "stateChanged", summary: `${dropName} lets the plan drop.` });
      if (dropped.text.trim()) {
        const consequences = (ctx.data.consequences as string[] | undefined) ?? [];
        consequences.push(
          `${dropName} proposed: "${dropped.text.trim()}" and got no answer, so ${dropName} lets it drop. Reflect that briefly if natural; do not treat the plan as agreed.`,
        );
        ctx.data.consequences = consequences;
      }
    }
  }

  /**
   * Resolve one turn from a KNOWN TurnPlan — the shared tail of the player pipeline. Reached two
   * ways with the SAME body, so a clicked grounded action and a classified line land identically:
   *   - `resolvePlayer` after the utility classifier reads the free text (the open channel), and
   *   - `submitAction` after mapping a typed `GroundedAction` to a plan (the click channel — the
   *     classifier is bypassed, but this pricing/energy-gate/switch is not, so the reducer still
   *     mutates and the narrator still describes the result).
   * `input` is the human-readable line stashed for narration triggers + the trace (a synthesized
   * phrase on the click path). Prices the turn from the cost table, runs the depletion gate, then
   * dispatches to the per-kind resolver — every one of which mutates ONLY through the reducer.
   */
  private async resolvePlan(ctx: TickContext, plan: TurnPlan, input: string): Promise<void> {
    const model = ctx.model;
    const playerId = playerEntity(model)?.id ?? "pc.you";
    // Stash the reconciled plan for the turn trace (Workstream D).
    ctx.data.plan = plan;
    // Out-of-character requests don't advance the world clock.
    ctx.data.advancesClock = plan.kind !== "metaOOC";
    // Price the turn from the cost table (Workstream H): the core commit spends these once the
    // turn resolves. The rest resolver advances its own clock, so its row here is zero.
    const cost = costOf(plan.kind);
    ctx.data.clockMinutes = cost.minutes;
    ctx.data.energyCost = cost.energy;
    const playerStats = playerEntity(model)?.stats;
    const exhaustionLevel = exhaustionOf(playerStats);
    // THE ABED TRAP (r5 P1). A whole in-game day was played out of a rented bunk: the player ate
    // breakfast, crossed the village, sent a companion on an errand and rolled two checks, and every
    // one of those turns resolved as prose against a scene their body was not in — the world frozen,
    // the companion "ELSEWHERE", the day gone. Anything that reaches PAST the room now GETS THE
    // PLAYER UP first: they said they were going down to the hall, so they go down to the hall, and
    // the intent then resolves from there at its normal cost. Refusing would have been honest but
    // useless — the player already told the world what they wanted. In-room life (speech, items,
    // items, rest, freeform, Wake itself) is untouched, and the night stays paid, so
    // going back up costs nothing. Runs BEFORE movement pricing so the trip is priced from the hall.
    if (isAtLodging(model) && OUTSIDE_THE_ROOM.has(plan.kind)) {
      const rise = riseFromRoom(ctx, readLodgingSlice(model));
      ctx.data.roseFromRoom = rise.trigger;
    }
    if (plan.kind === "movement") {
      // The one movement-pricing rule (authored exit minutes → exhaustion factor → scaled energy),
      // shared with the proposal-accept path.
      priceMovementTurn(ctx, plan.destinationLocationId);
    }
    // At Camp (long rest), time is stopped and energy is free — every camp action costs nothing.
    // End Day is exempt: it advances its own clock to the next morning.
    if (isAtCamp(model) && plan.kind !== "endDay") {
      ctx.data.clockMinutes = 0;
      ctx.data.energyCost = 0;
    }
    // In a rented room the night is held (like Camp) — every in-room action is free. Wake is exempt:
    // it advances its own clock to the next morning.
    if (isAtLodging(model) && plan.kind !== "wakeInRoom") {
      ctx.data.clockMinutes = 0;
      ctx.data.energyCost = 0;
    }
    // The exhaustion gate: levels 0–4 can push through and overflow into the ladder at commit.
    // Level 5 refuses fresh out-of-combat exertion; level 6 is collapse. Mid-combat swings/fleeing
    // stay open so exhaustion never traps the player in a losing fight.
    const taxedNow =
      !isAtCamp(model) &&
      (plan.kind === "attemptRequiringCheck" ||
        plan.kind === "work" ||
        ((plan.kind === "movement" || plan.kind === "attack") && !isCombatActive(model)));
    if (taxedNow && playerStats && exhaustionLevel >= 5) {
      // Deliberately 1, not the default beat: a refused exertion is a moment, not a scene.
      ctx.data.clockMinutes = 1;
      ctx.data.energyCost = 0;
      const collapsed = exhaustionLevel >= EXHAUSTION_MAX;
      ctx.data.narration = {
        trigger: collapsed
          ? "You have collapsed — the world has gone dark, and only rest can bring you back to yourself."
          : "You are failing — your legs shake and your hands will not answer. No amount of will replaces sleep; you must rest before exerting yourself again.",
        resolved: resolvedHardRefusal("Exhaustion"),
      } satisfies NarrationIntent;
      return;
    }
    // THE DOWNED GATE (r7 P2). At 0 HP the run kept playing: the composer stayed live, an
    // UNCONSCIOUS PC resolved an INT (Arcana) check and delivered speeches, and being downed
    // carried no weight at all. One chokepoint here, not per-resolver: an unconscious body does
    // not act, speak, roll, or bargain. Rest/camp/wake stay open (recovery IS the way back),
    // metaOOC is out-of-character, and captivity/defeat scenes own their own downed flow.
    if (playerStats && playerStats.currentHp <= 0 && !isCaptive(model) && DOWNED_BLOCKED.has(plan.kind)) {
      ctx.data.clockMinutes = 1;
      ctx.data.energyCost = 0;
      ctx.data.narration = {
        trigger:
          "You are down — the world is a far-off smear of sound and dark, and your body will not answer. " +
          "(Unconscious: you cannot act or speak until you are brought back — rest, victory, or an ally's help.)",
        resolved: resolvedHardRefusal("Unconscious"),
      } satisfies NarrationIntent;
      return;
    }
    // Due custody work settles the moment its clock and its holder line up — before the per-kind
    // resolver, so "ready by evening bell" is kept by the world, not remembered by the narrator.
    settleDueServices(ctx);

    // PROSE-TO-CODE §2.4 — a compound line's dropped half is SAID, never swallowed. "Oda, we go
    // west — just the two of us" grounded one kind and silently discarded the dismissal; the
    // classifier now confesses the unrepresented half and this ledger line makes the drop honest.
    // Deterministic surface (a `·` line), so it cannot depend on the narrator weaving it in.
    if (plan.droppedIntent) {
      this.emit({
        kind: "stateChanged",
        summary: `One thing at a time — "${plan.droppedIntent}" hasn't happened; say it on its own to do it.`,
        changes: {},
      });
    }

    switch (plan.kind) {
      case "movement": {
        // Mark the turn as a movement attempt so the narrator-output guard BUFFERS it: a grounded move
        // is already buffered (it carries a moveParty command), but a DEGRADED reach (an unreachable
        // named place → no move) is the exact turn where the narrator is told "do not move" and a
        // spatial-drift regeneration must be possible.
        ctx.data.movementAttempt = true;
        // THE PRICE OF LEAVING A FIGHT (r11 F-5). Before any route out is chosen — grounded exit,
        // named reach, multi-leg break, destination-less bolt — a live encounter with someone still
        // standing gets a contested escape check. Pass and everything below runs unchanged; fail and
        // the party stays, the turn is spent, and the other side answers. One chokepoint, so no
        // movement route can be the free one.
        {
          const blocked = await resolveDisengage(ctx);
          if (blocked) {
            ctx.data.narration = blocked;
            break;
          }
        }
        // At camp there is nowhere to travel — intercept BEFORE the frontier/open-world branches so
        // reactive worldgen never mints a pocket off Camp. End Day is the only way back out.
        if (isAtCamp(model)) {
          ctx.data.clockMinutes = 0;
          ctx.data.energyCost = 0;
          ctx.data.narration = {
            trigger:
              "You are at camp for the night — there is nowhere to travel until you break camp. Use End Day to head back out.",
          } satisfies NarrationIntent;
          break;
        }
        // In a rented room there is nowhere to go until morning — Wake is the only way back out.
        if (isAtLodging(model)) {
          ctx.data.clockMinutes = 0;
          ctx.data.energyCost = 0;
          ctx.data.narration = {
            trigger:
              "You are shut in your room for the night — there is nowhere to travel until you rise. Wake to head back into the hall.",
          } satisfies NarrationIntent;
          break;
        }
        if (plan.destinationLocationId) {
          const destName = this.locationName(plan.destinationLocationId);
          // A barred exit resolves through the barrier chain (condition → key → refusal) so the
          // obstacle is narrated as an obstacle — never a bare "no way there". Checked BEFORE
          // the frontier shortcut: a barred frontier exit must not expand the world past its
          // own lock (the retargeted exit would stay barred and strand the "crossing").
          const from = partyLocationOf(model);
          const verdict = from !== null ? exitVerdict(model, from, plan.destinationLocationId) : undefined;
          if (from !== null && verdict && !isPassable(verdict.state)) {
            ctx.data.narration = resolveBarredMove(ctx, verdict, from, plan.destinationLocationId, destName);
            break;
          }
          if (isFrontierId(plan.destinationLocationId)) {
            if (frontierEnabled(this.deps.playset.world)) {
              // The party walks off the authored map: generate the pocket behind the frontier
              // exit, then travel into its entrance — the world grows as they explore.
              ctx.data.narration = expandFrontier(ctx, plan.destinationLocationId);
              break;
            }
            // Frontier expansion disabled for this world: the edge is latent content, not a
            // crossing. Price it like the barred/hard-refusal branches (1 min, no energy) and give
            // a coherent "impassable" beat — never a pocket, never a move. In practice the
            // classifier suppression keeps a frontier id from ever grounding here, but this guards
            // any other grounding path.
            ctx.data.clockMinutes = 1;
            ctx.data.energyCost = 0;
            ctx.data.narration = {
              trigger: `You cast about for a way on toward ${destName}, but there is no crossing here — the way is impassable.`,
            } satisfies NarrationIntent;
            break;
          }
          // "I go alone": the PC travels solo, companions stay put (the reducer splits the party) —
          // EXCEPT mid-fight (r6 P1): a rout is not a deliberate split. A flee that grounded an
          // exit used to honour a stray `solo` read and strand every companion on the field with
          // no line about them (Oda, FRIEND 4, simply vanished from the scene).
          const fleeingCombat = isCombatActive(model);
          const solo = plan.solo === true && !fleeingCombat && hasCompanionsHere(model);
          // Read visited-ness BEFORE the move — the reducer stamps the flag as part of it.
          const known = model.flags[visitedFlag(plan.destinationLocationId)] === true;
          const res = this.apply({ type: "moveParty", to: plan.destinationLocationId, solo: fleeingCombat ? false : plan.solo });
          if (res.mutated) {
            this.emit({
              kind: "stateChanged",
              summary: solo ? `You set out for ${destName} alone.` : `The party moves to ${destName}.`,
              changes: { partyLocationId: plan.destinationLocationId },
            });
            // Left-behind notice (playtest #8): if the player was JUST talking to a present NPC who
            // never joined the party, they are silently left at the origin — say so, so a would-be
            // companion doesn't just vanish from the prose. Only on a whole-party (non-solo) departure.
            const leftBehind = solo ? null : leftBehindNotice(from, model, ctx.recent);
            // A RETURN is not an arrival. The authored description is re-injected verbatim on every
            // visit, so with nothing in the trigger to say otherwise the narrator restaged the same
            // establishing beat word for word (r5 P4: Thornwick's bread at the standing stone,
            // day 1 and day 3 alike). Say which one this is; the place stays the same, the scene
            // must not.
            // Parenthesized GM-note form: the echo path strips `(GM: …)` wholesale, so an empty
            // narrator completion can never print this instruction as the scene (r7 P1 — it did,
            // verbatim, and that turn produced no content at all).
            const arrival = known
              ? ` (GM: they have been here before — do not restage the arrival you already gave it; open on what has changed since: the hour, who is about, what is different.)`
              : "";
            ctx.data.narration = {
              trigger: solo
                ? `You set out for ${destName} alone, leaving your companions behind. Narrate the solo departure.${arrival}`
                : `You travel to ${destName}.${leftBehind ? ` (${leftBehind})` : ""}${arrival}`,
            } satisfies NarrationIntent;
          } else {
            // A refused move is a door rattled, not a journey: price it as the engine's other
            // hard refusals do (1 minute, no energy) — never the full travel row.
            ctx.data.clockMinutes = 1;
            ctx.data.energyCost = 0;
            ctx.data.narration = {
              trigger: `You try to reach ${destName}, but find no way there.`,
            } satisfies NarrationIntent;
          }
        } else if (isCombatActive(model)) {
          // A named but ungrounded forward destination is NOT permission to take the first exit,
          // which may point the opposite way (N5: "push on toward a hold" retreated to the origin).
          // Give it the same grounded reach treatment as any other named movement: a visited/authored
          // place can resolve, while an unknown one refuses honestly in place. Only a truly
          // destination-less flee falls back to the first open exit below.
          if (plan.destinationName?.trim()) {
            ctx.data.narration = reachOpenWorld(ctx, plan.destinationName.trim(), (quote) => {
              this.pendingTravel = quote;
            });
            break;
          }
          // A destination-less flee mid-fight still gets the party OUT: bolt through the first
          // open exit (the combat module reaps the abandoned encounter on this same tick).
          const loc = partyLocationOf(model);
          const out = loc
            ? mapExitsFrom(model.map, loc).find(
                // Effective state, not the static flag: a runtime-unlocked door IS a way out,
                // a runtime-locked one is not.
                (e) => !e.hidden && !isFrontierId(e.to) && isPassable(effectiveExitState(model, loc, e)),
              )
            : undefined;
          if (out && this.apply({ type: "moveParty", to: out.to }).mutated) {
            const destName = this.locationName(out.to);
            this.emit({
              kind: "stateChanged",
              summary: `The party flees to ${destName}.`,
              changes: { partyLocationId: out.to },
            });
            ctx.data.narration = { trigger: `You break and run for ${destName}.` } satisfies NarrationIntent;
          } else {
            ctx.data.clockMinutes = 1;
            ctx.data.energyCost = 0;
            ctx.data.narration = { trigger: `You look for a way out, but find none. ${input}` } satisfies NarrationIntent;
          }
        } else if (plan.destinationName && plan.destinationName.trim()) {
          // The player NAMED a place that isn't a listed exit — REACH it on the fly (worldgen-as-
          // explore): reuse a known location, realize a gazetteer entry, or generate a fresh pocket,
          // then MOVE the party. This keeps projected state synced with the prose instead of the old
          // ungrounded "no route" refusal the narrator would override (B1 grounding-desync fix).
          ctx.data.narration = reachOpenWorld(ctx, plan.destinationName.trim(), (quote) => {
              this.pendingTravel = quote;
            });
        } else {
          // A move with no named destination (a groped "onward" with nothing to reach) — stay put and
          // let the narrator describe the search, priced as a non-journey (1 minute, no energy).
          // r14 (fixture-combat t8, "I keep walking west…"): this branch was the round's one fully SILENT
          // movement shape — same receipt discipline as the named degrade, reworded for the nameless
          // ask (skeptic pass: "leads there" dangles when no place was named).
          const from = partyLocationOf(model);
          const ways = from !== null ? waysOnFrom(ctx, from) : [];
          this.emit({
            kind: "stateChanged",
            summary: `No clear way onward from here.${ways.length > 0 ? ` Ways on from here: ${ways.join(", ")}.` : ""}`,
            changes: {},
          });
          ctx.data.clockMinutes = 1;
          ctx.data.energyCost = 0;
          ctx.data.narration = { trigger: `You look for a way onward. ${input}` } satisfies NarrationIntent;
        }
        break;
      }

      case "rest": {
        ctx.data.narration = resolveRest(ctx);
        break;
      }

      // Both camp kinds bend to the bed you already paid for. r5 P2: "sleep until first light",
      // typed from a 12-copper bunk in the Stone Cup's hearth-loft, ran the whole MAKE CAMP
      // machinery — "the party makes camp for the night", "returns to the road where they left
      // it", and one travel ration gone. The classifier's roof-vs-rough fork is a prompt rule and
      // a prompt rule cannot see the lodging slice; the state can, so the state decides.
      case "enterCamp": {
        ctx.data.narration = isAtLodging(model)
          ? resolveWakeInRoom(ctx, { sleep: true })
          : resolveEnterCamp(ctx, (pending) => {
              this.pendingCamp = pending;
            });
        break;
      }

      case "endDay": {
        ctx.data.narration = isAtLodging(model)
          ? resolveWakeInRoom(ctx, { sleep: true })
          : resolveEndDay(ctx, (pending) => {
              this.pendingCamp = pending;
            });
        break;
      }

      case "rentRoom": {
        ctx.data.narration = resolveRentRoom(ctx, plan);
        break;
      }

      case "wakeInRoom": {
        // r9 F-13: an explicit sleep intent sleeps whatever the clock says — "I lie down and
        // sleep" at dusk (before NIGHT_START) used to fall to the daylight fallback and RISE.
        ctx.data.narration = resolveWakeInRoom(ctx, plan.wake?.intent === "sleep" ? { sleep: true } : {});
        break;
      }

      case "itemAction": {
        ctx.data.narration = resolveItemAction(ctx, plan, input);
        break;
      }

      case "cast": {
        ctx.data.narration = resolveCast(ctx, plan, input);
        break;
      }

      case "learn": {
        ctx.data.narration = resolveLearn(ctx, plan, input);
        break;
      }

      case "clothing": {
        ctx.data.narration = resolveClothingAction(ctx, plan, input);
        break;
      }

      case "trade": {
        ctx.data.narration = resolveTrade(ctx, plan, input);
        break;
      }

      case "tradeBatch": {
        ctx.data.narration = resolveTradeBatch(ctx, plan);
        break;
      }

      case "service": {
        ctx.data.narration = resolveService(ctx, plan, input);
        break;
      }

      case "work": {
        ctx.data.narration = resolveWork(ctx, plan, input);
        break;
      }

      case "locationInteraction": {
        ctx.data.narration = this.resolveLocationInteraction(ctx, plan, input);
        break;
      }

      case "partyAction": {
        ctx.data.narration = await resolvePartyAction(ctx, plan, input);
        break;
      }

      case "errand": {
        ctx.data.narration = resolveErrand(ctx, plan, input, (quote) => {
          this.pendingErrand = quote;
        });
        break;
      }

      case "hireMercenary": {
        ctx.data.narration = await resolveHireMercenary(ctx, plan, input);
        break;
      }

      case "questAction": {
        ctx.data.narration = this.resolveQuestAction(ctx, plan, input);
        break;
      }

      case "caseAction": {
        ctx.data.narration = resolveCaseAction(ctx, plan, input);
        break;
      }

      case "dialogueToNpc": {
        this.emit({ kind: "dialogue", actorId: playerId, text: input, toId: plan.targetId ?? undefined });
        const target = plan.targetId ? model.entities.get(plan.targetId) : undefined;
        // Workstream B slice: ANY grounded, present, CONSCIOUS NPC gets a real in-character
        // reply — the dialogue module resolves companions first, then the ephemeral fallback
        // agent (whose template, post-NpcProfileModule, carries the full first-sight identity).
        // The GM voices the line when no NPC entity grounds (targetId null/absent) — or when
        // the target is downed/dead (a corpse must not chat, and the weave block must never
        // canonize a reply from one; the GM sees the "down" band and narrates the silence).
        const conscious = !target?.stats || target.stats.currentHp > 0;
        const addressable =
          !!target &&
          target.kind === "npc" &&
          conscious &&
          (target.partyMember || target.locationId === partyLocationOf(model));
        if (plan.targetId && addressable) {
          ctx.data.dialogue = { npcId: plan.targetId, playerLine: input } satisfies DialogueIntent;
          // r5 P3: speaking to a present NON-party bystander during a live fight is a call for aid.
          // The classifier already did the work of resolving who is being addressed, so the combat
          // module reads that rather than running a second, unversioned sniff over the raw line.
          // It marks the turn as SPENT — help that arrives a turn late is the defect, delayed.
          if (!target!.partyMember && (isCombatActive(model) || combatPendingInQueue(ctx.queue))) {
            // r6 P1: a DE-ESCALATION line ("ODA, STOP!", "put the knife down — nobody wants this")
            // is a parley, never a call for aid — the combat module runs it as a stop-the-fight
            // contest; without this gate it could recruit a bystander INTO the fight being ended.
            //
            // WHICH of the two it is now comes from the classifier's closed `speechAct` (r8). The
            // regex answered both questions with one word-list and could not tell an ORDER from a
            // plea: mid-fight "Brann, stop him!" — a companion being told to stop the enemy — hit
            // the `stop` arm, so the call for aid was suppressed and the line was scored as a
            // parley instead (reproduced). Null/absent ⇒ the regex, unchanged, so every scripted
            // stub and a classifier outage behave exactly as they do today.
            const deescalating = plan.speechAct !== undefined && plan.speechAct !== null
              ? plan.speechAct === "deescalate"
              : DEESCALATION_RE.test(input);
            if (!deescalating) {
              ctx.data.combatAid = { actorId: playerId, targetId: plan.targetId };
            }
          }
          // The DM now delivers the NPC's PUBLIC reply as staged prose (it owns public NPC speech), so
          // park a narration intent too — it runs AFTER the dialogue module (narration `after:[dialogue]`)
          // with the reply beat already in the weave block, and narrates the exchange. Private address
          // never reaches here (resolvePrivateDialogue short-circuits before the classifier), so the
          // whisper thread keeps its verbatim, un-narrated reply.
          ctx.data.narration = {
            trigger: `You speak to ${target?.name ?? "them"}: "${input}"`,
            // Both dialogue triggers embed the player's own sentence, so a blank narration would fall
            // to `stripNarratorDirective(trigger)` and hand the player their own words back as GM prose
            // (playtest 07-24 P3: "You say: ""…""" re-echoed as a paragraph). T7 forbids exactly that —
            // it was guarded on the freeform branch only. `triggerEcho` prefers real NPC beats over
            // this, so the fallback is reached only when nobody spoke either. The fallback QUOTES the
            // player's words as their own speech (r3 P3: a bare stub landing on a parley climax wasted
            // the turn entirely — at least the spoken line now stands in the record). Quoted
            // attribution, never GM restatement, so T7 holds.
            echoFallback: `"${input}" — the words hang there, unanswered.`,
          } satisfies NarrationIntent;
        } else {
          // r5 P1: an NPC the world only TOLD the player about can never ground — `reconcilePlan`
          // clamps `targetId` to PRESENT_ENTITIES (classify.ts), so addressing a person another
          // NPC just produced ("she's here, three tables to your left") arrives here with a null
          // target and used to fall through to the generic stub, which `triggerEcho` rendered as
          // the content-free "The moment passes." Name the absence instead: it costs the same
          // beat, but it teaches the player a boundary rather than looking like a hiccup.
          const absent = absentAddressee(ctx, input, model, target, (line, present) =>
            this.absentNamedInLine(line, present),
          );
          // r13: the PHANTOM addressee — a name the world has never had, minted by an NPC reply
          // ("Corin", "Sable Jenkins") and now spoken to. absentAddressee above only knows the
          // AUTHORED roster, so these fell through to the generic stub; the narrator then faced an
          // unanswerable job (voice a person canon forbids inventing) and burned 45–141s of
          // retries/judge churn into the content-free echo, six times in one sweep. The classifier
          // confesses the spoken name (plan.targetName, carried only when unbound); answer it
          // deterministically, the absent-branch shape. Roster stays FIRST — a near-mutation of an
          // authored name ("Sable Jenkins") binds Sable Renn there and gets the honest redirect.
          // Guards: capital-as-evidence in the player's own line (a lowercase role — "the carter" —
          // keeps today's narrator roleplay), and the absentNamedAllInLine token lessons (a place
          // token is not a person; a generic honorific carries no identity).
          const phantomFirst = firstToken(plan.targetName ?? "");
          // A spoken name sharing ANY token with someone standing here ("Brann Jenkins" while
          // Brann is present) is a near-miss, not a phantom — the narrator, who sees the full
          // scene, owns that correction; an absence line about a present person would gaslight.
          const loc = partyLocationOf(model);
          const phantomCollides = (loc ? entitiesAt(model, loc) : []).some((e) => {
            const tokens = new Set(nameTokens(displayName(e)));
            return nameTokens(plan.targetName ?? "").some((t) => tokens.has(t));
          });
          const phantomName =
            !absent &&
            !target &&
            plan.targetName &&
            !phantomCollides &&
            nameMentionedIn(input, plan.targetName, { surface: "prose" }) &&
            !this.placeTokens().has(phantomFirst) &&
            !GENERIC_NAME_TOKENS.has(phantomFirst)
              ? plan.targetName
              : null;
          // A PRESENT non-NPC target (a monster mid-fight) has no reply machinery, but the words
          // were still spoken AT it — stage the address for the GM instead of the bare "You say"
          // stub, and mid-fight the line is the player's action for the round: the foes answer
          // (r14, fixture-combat t16: "I'm not running. What do you want?" at the hound drew "There is
          // no sign of Ash Hound here." and froze the fight). A de-escalation line is NOT spent
          // here — the combat module's parley contest owns that turn (r6 P1) and prices it itself.
          const presentBeast = !absent && !!target && target.kind !== "npc";
          if (presentBeast && (isCombatActive(model) || combatPendingInQueue(ctx.queue))) {
            const deescalating =
              plan.speechAct !== undefined && plan.speechAct !== null
                ? plan.speechAct === "deescalate"
                : DEESCALATION_RE.test(input);
            if (!deescalating) ctx.data.combatTurnSpent = { actorId: playerId };
          }
          ctx.data.narration = absent
            ? ({ trigger: absent, deterministic: true } satisfies NarrationIntent)
            : phantomName
              ? ({
                  trigger: `There is no sign of anyone called ${phantomName} here.`,
                  deterministic: true,
                } satisfies NarrationIntent)
              : presentBeast
                ? ({
                    trigger: `You speak to ${target.name}: "${input}" — it cannot answer in words. Narrate how it takes the sound of you.`,
                    echoFallback: `"${input}" — the words land on ${target.name}, and the moment answers for it.`,
                  } satisfies NarrationIntent)
                : ({
                    trigger: `You say: "${input}"`,
                    echoFallback: `"${input}" — you speak, and the moment holds.`,
                  } satisfies NarrationIntent);
        }
        break;
      }

      case "attemptRequiringCheck": {
        // A check aimed at a barred exit (picking the lock, forcing the door) resolves against
        // the barrier's own DCs and can change the exit's state; anything else falls through to
        // the generic check.
        const barrier = await resolveBarrierCheck(ctx, plan, input);
        ctx.data.narration =
          barrier ?? (await resolveCheckIntent(plan.check, input, ctx, plan.targetId, plan.socialAsk));
        // Mid-fight, the attempt IS the player's action for the round — pass initiative on so the
        // foes answer in the same tick, exactly as an item action or a failed disengage does
        // (r14, fixture-combat t15/t17: two failed break-away checks resolved as generic attempts and
        // the hound simply waited — no swing, no combatTurnAdvanced, the fight clock frozen).
        // A PASSED disengage-purpose check still ends the fight first: the combat module's
        // evasion-calm consumes `checkOutcome` and returns before this scratch is read.
        if (isCombatActive(model)) ctx.data.combatTurnSpent = { actorId: playerId };
        break;
      }

      case "attack": {
        // No fighting at camp: combat would run defeat/reward resolvers that advance the clock and
        // energy DIRECTLY (past the camp time-freeze chokepoint). Camp is a safe rest space.
        if (isAtCamp(model)) {
          ctx.data.clockMinutes = 0;
          ctx.data.energyCost = 0;
          ctx.data.narration = {
            trigger: "Not here — camp is no place for a fight. Break camp first if it must come to that.",
          } satisfies NarrationIntent;
          break;
        }
        ctx.data.combatAttack = {
          actorId: playerId,
          targetId: plan.targetId,
          input,
        } satisfies CombatAttackIntent;
        ctx.data.narration = undefined;
        break;
      }

      case "metaOOC": {
        this.emit({
          kind: "system",
          level: "info",
          message: "That reads as an out-of-character request — try /help, /look, /save, or /sheet.",
        });
        break;
      }

      case "workInquiry": {
        // A workInquiry is a SOCIAL/informational act, not a menu print. The world never narrates its
        // own job list: a person POINTS (dialogue), the WorkCard OFFERS (wage/DC/Take), the player
        // CHOOSES via the card. So rank the live board (N3/N11 — no roll, no pay, no move, no invented
        // employer), then deliver the pointer through the right diegetic source: the addressed NPC or a
        // present companion answers IN CHARACTER with numbers stripped (they live in the card), and
        // with no one to speak the GM points at the claims-board as a fixture. Mid-combat / an empty
        // board degrade to plain narration or an honest "nothing posted". The CLASSIFIER routes here;
        // a servile plea to a present person is dialogueToNpc, never this branch.
        const ranked = rankWorkInquiry(ctx, input);
        if (!ranked) {
          // Jobs are guild-only now, so an empty board off-hall is the norm. When the world keeps
          // contract-halls, nudge the player toward them rather than a flat "nothing posted".
          const hasGuildHall = this.deps.playset.world.locations.some((l) => l.guild);
          const emptyLine = hasGuildHall
            ? "No work is posted here — the contract-halls keep the boards. Ask at a guild hall."
            : "No honest paid work is posted here right now.";
          ctx.data.narration = isCombatActive(model)
            ? ({ trigger: input, echoFallback: "The moment passes." } satisfies NarrationIntent)
            : ({ trigger: emptyLine, deterministic: true } satisfies NarrationIntent);
          break;
        }
        const speaker = workLeadSpeaker(ctx, plan);
        if (speaker) {
          // Route through the speaker as an in-character reply — the # WORK ON OFFER grounding points
          // them at the real job, numbers-free. The parked narration runs AFTER the dialogue module
          // (narration `after:[dialogue]`) and weaves the exchange, exactly like dialogueToNpc.
          ctx.data.dialogue = {
            npcId: speaker.id,
            playerLine: input,
            workLead: workLeadFacts(ranked.job, ranked.basis),
          } satisfies DialogueIntent;
          ctx.data.narration = {
            trigger: `You ask ${speaker.name} where honest work can be found.`,
          } satisfies NarrationIntent;
        } else {
          // No one to speak — point at the fixture (the claims-board) diegetically. Numbers stay on
          // the board / WorkCard; the prose names the job as a thing in the world, not a menu row.
          ctx.data.narration = {
            trigger: `The claims-board here still carries ${ranked.basis}: “${ranked.job.label}.” Its terms are chalked there, yours to take when you are ready.`,
            deterministic: true,
          } satisfies NarrationIntent;
        }
        break;
      }

      case "freeformNarrative":
      default: {
        // A grounded look/emote/wait — the narrator sees the whole line. (A movement whose id didn't
        // ground no longer lands here: it STAYS `movement` and the case above REACHES the named place
        // via `reachOpenWorld`, so the party actually moves and state tracks the prose.) The
        // trigger IS the raw player line, so a blank narrator must fall to the neutral echoFallback —
        // never parrot the player's own words back as narration (T7).
        ctx.data.narration = { trigger: input, echoFallback: "The moment passes." } satisfies NarrationIntent;
        break;
      }
    }

    // The grounded-freeform channel: physical transfers riding a freeform/dialogue line mint REAL
    // reducer commands (the same resolvers the itemAction verbs use — one behavior source), and the
    // mechanical beats are prepended to whatever prose follows, so the narrator phrases what
    // actually happened instead of fabricating a transaction. The legacy ambient-coin regex is the
    // fallback only when no grounded spendCoins effect fired — it stops growing from here.
    if (
      plan.kind === "dialogueToNpc" ||
      plan.kind === "freeformNarrative" ||
      // Taking a contract and PAYING for it are one sentence often enough that the accept used to
      // swallow the fee whole (r5 P2, reproduced live: "I count five silver onto the counter for the
      // bond" took the quest and charged nothing).
      plan.kind === "questAction" ||
      // Property parted with UNDER A ROLL (r14, fixture-travel t8: "I fling a fistful of copper at the
      // revenant's eyes" — the coppers left the hand in prose and never left the purse). The check
      // decides whether the maneuver works; it never decides whether the coins were real.
      plan.kind === "attemptRequiringCheck"
    ) {
      const leads: string[] = [];
      // Mystery lie/credibility side-channel — case claims riding this dialogue line resolve against the
      // addressed, present, conscious NPC's epistemic state (truthful share vs caught lie). Applied
      // BEFORE the reply is parked so the credibility drop's distrust rail reaches THIS turn's brief.
      if (plan.kind === "dialogueToNpc" && plan.targetId && plan.caseClaims && plan.caseClaims.length > 0) {
        const tgt = model.entities.get(plan.targetId);
        const conscious = !tgt?.stats || tgt.stats.currentHp > 0;
        if (tgt && tgt.kind === "npc" && conscious && (tgt.partyMember || tgt.locationId === partyLocationOf(model))) {
          leads.push(...resolveCaseClaims(ctx, plan.targetId, plan.caseClaims));
        }
      }
      let spentCoins = false;
      // Did anything actually cross INTO the player's hands this turn? The ambient coin rescue reads
      // it to keep a priced purchase atomic — see `resolveAmbientCoinGift`'s PURCHASE_PRICE_RE.
      let goodsReceived = false;
      for (const eff of plan.effects ?? []) {
        if (eff.type === "spendCoins") {
          const beat = resolveSpendCoinsEffect(ctx, eff.amountCp ?? 0, eff.toNpcId);
          if (beat) {
            leads.push(beat);
            spentCoins = true;
          }
        } else if (eff.type === "acceptItem") {
          if (eff.itemId) {
            // A null giver is the PROSE-PROP path: the scene put an object on a counter and the
            // player picked it up (r5 P2 — "I fold Veil's sealed note into my coat" ended with "the
            // note of interest still lies on the counter", and the note never became anything at
            // all). Nobody has to be holding it out for it to be real.
            const beat = resolveAcceptItemEffect(ctx, eff.itemId, eff.toNpcId);
            if (beat) {
              leads.push(beat);
              goodsReceived = true;
            }
          }
        } else if (eff.type === "makeDeal") {
          const beat = this.resolveMakeDealEffect(ctx, eff.terms ?? "", eff.toNpcId);
          if (beat) leads.push(beat);
        } else if (eff.type === "dealAction") {
          const beat = this.resolveDealActionEffect(ctx, eff.toNpcId, eff.dealState ?? null);
          if (beat) leads.push(beat);
        } else if (eff.itemId) {
          const verb = eff.type === "giveItem" ? ("give" as const) : eff.type === "dropItem" ? ("drop" as const) : ("pickup" as const);
          // Honor a stated multi-unit part-with (r7 P3: "I dump EVERY ration I own — four days of
          // salt fish" threw four in fiction and deducted one). Each unit re-resolves through the
          // same one verb path, capped by what the pack actually still holds; the beat reports once.
          const stated = eff.quantity ?? 1;
          const held = playerEntity(model)?.stats?.inventory.filter((id) => id === eff.itemId).length ?? 0;
          const units = verb === "pickup" ? 1 : Math.max(1, Math.min(stated, held));
          let beat = "";
          let done = 0;
          for (let i = 0; i < units; i++) {
            const intent = resolveItemAction(
              ctx,
              { ...plan, kind: "itemAction", item: { verb, itemId: eff.itemId, targetId: eff.toNpcId ?? null } },
              "",
            );
            const line = intent.trigger.trim();
            if (!line) break;
            beat = line;
            done += 1;
          }
          if (beat) {
            leads.push(done > 1 ? `${beat} (×${done} — the whole lot.)` : beat);
            if (verb === "pickup") goodsReceived = true;
          }
        }
      }
      // The ambient regex is a RESCUE for a line the classifier proposed no transfer for. It is
      // suppressed ONLY when a coin proposal itself failed to ground (a nonsense amount — the
      // honest nothing-changed note below is the answer there; a regex second guess would charge
      // for the very transfer the engine just refused). A dropped ITEM transfer must NOT suppress
      // it — the r6 exploit: "I count five silver onto the table" for a vest the player doesn't
      // yet carry dropped its giveItem, silenced the rescue, and the fiction honoured the sale
      // for free. A coin the prose says left your hand must leave the purse.
      // The rescue reads the RAW player line, and it was tuned on lines whose whole point is a
      // transfer (spoken and freeform ones). A checked attempt is not that shape — "I try to lift her
      // purse and count the silver inside" would charge the player for money they were stealing, not
      // spending — so the new kind rides the GROUNDED channel only.
      // `goodsReceived` carries the last gate: a line that PRICES goods ("I'll take the spear for 1
      // gold — count out 100 coppers") is a purchase, and a purchase whose goods never grounded must
      // not be charged for. See `resolveAmbientCoinGift` for the r15 fixture-trade repro.
      if (!spentCoins && !plan.coinsDropped && plan.kind !== "attemptRequiringCheck") {
        const coinGift = resolveAmbientCoinGift(ctx, input, goodsReceived);
        if (coinGift) leads.push(coinGift);
      }
      // The classifier proposed a physical transfer but NOTHING grounded (a hallucinated item/npc,
      // a nonsense amount): say so honestly, so the turn can never silently read as completed.
      if (plan.effectsDropped && leads.length === 0) {
        leads.push("(Nothing actually changes hands — you still hold what you held, and your purse is untouched.)");
      }
      if (leads.length > 0) {
        const lead = leads.join(" ");
        const narration = ctx.data.narration as NarrationIntent | undefined;
        // Each mechanical beat is ALSO emitted as a `·` ledger line by its resolver, so the receipt
        // is already on the player's screen. Hand it to the model as FACT to ground on, not as prose
        // to repeat — the live r6 defect was the same sentence printed twice (the ledger bullet and
        // the narrator echoing the prepended lead verbatim). The blank-narrator echo keeps the
        // verbatim lead so a transient empty completion still shows what changed hands (T7).
        ctx.data.narration = narration
          ? {
              ...narration,
              trigger:
                `(Already resolved and shown to the player as a ledger line: "${lead}" — ` +
                `this REALLY happened; ground the scene on it but do NOT repeat that sentence.) ` +
                narration.trigger,
              echoFallback: narration.echoFallback ? `${lead} ${narration.echoFallback}` : lead,
            }
          : ({ trigger: `${lead} ${input}`, echoFallback: lead } satisfies NarrationIntent);
      }
    }

    // PROSE-TO-CODE §2.4, the SETTLE-THEN-MOVE half (r11 F-11, owner decision 2026-08-01).
    //
    // "I take the caravan salvage claim and head west on the road" kept the movement and dropped the
    // quest accept: the flagship's own set-piece then sat `offered` for the whole run, the player
    // spent ten turns prying a writ that could never tick an objective, and one dropped half-sentence
    // cost the run its content. The narrow fix, deliberately NOT a general two-action machine: the
    // classifier makes the SETTLE the plan (it is the half that cannot be redone by walking back) and
    // hands the move over as `secondaryMove`, which runs HERE — after the settle has committed.
    //
    // Bounded on purpose. Only a settle kind may carry one; only a GROUNDED adjacent exit executes
    // (no reach, no frontier, no multi-leg quote, no mid-fight rout — those all have their own rules
    // and their own costs); anything else stays the honest `droppedIntent` ledger note it is today.
    if (plan.secondaryMove?.destinationLocationId) {
      const to = plan.secondaryMove.destinationLocationId;
      const from = partyLocationOf(model);
      const verdict = from !== null ? exitVerdict(model, from, to) : undefined;
      const passable = !!verdict && isPassable(verdict.state);
      const walkable = !isCombatActive(model) && !isAtCamp(model) && !isAtLodging(model) && !isCaptive(model);
      const destName = this.locationName(to);
      // "After the settle has committed" is the contract above, and a TRADE settle is the one
      // whitelisted kind with a mechanical commit signal — so hold it to it (r12: "buy my boots for
      // 6 sp… then I'm off to the docks" moved the party after the sale FAILED, an involuntary
      // relocation off a deal that never closed). An INQUIRY settles by being answered; the spoken
      // kinds settle by being said; both keep their tail move. A committed exchange always applies
      // a trade-family command, read off the tick's own applied ledger.
      const settleCommitted =
        plan.kind !== "trade" ||
        plan.trade?.inquiry === true ||
        ((ctx.data.turnCommands as Command[] | undefined) ?? []).some(
          (c) => c.type === "tradeWith" || c.type === "transferItem" || c.type === "adjustCoins",
        );
      if (walkable && passable && settleCommitted && this.apply({ type: "moveParty", to }).mutated) {
        // The turn is now a journey, not a spoken beat: price it as one, from the settle's location.
        priceMovementTurn(ctx, to);
        this.emit({
          kind: "stateChanged",
          summary: `The party moves to ${destName}.`,
          changes: { partyLocationId: to },
        });
        const narration = ctx.data.narration as NarrationIntent | undefined;
        // A DETERMINISTIC settle (the quest-accept line, a buy receipt) is already finished
        // player-facing prose that skips the model entirely — so its tail must be prose too. Live
        // r11: an instruction appended here printed on screen, word for word, under the narration.
        // A model-bound settle gets the parenthesized GM-note form for the same reason in reverse:
        // the echo path strips `(GM: …)` wholesale, so a blank completion can never print it (r7 P1).
        const arrival = ` You set out, and the road brings the party to ${destName}.`;
        const tail = narration?.deterministic
          ? arrival
          : `${arrival} (GM: narrate the leaving and the arrival in a sentence or two, after the business above.)`;
        ctx.data.narration = narration
          ? { ...narration, trigger: `${narration.trigger}${tail}` }
          : ({ trigger: `${input}${tail}` } satisfies NarrationIntent);
      } else {
        // The move could not be honoured (barred, mid-fight, at camp, refused by the reducer). Say so
        // rather than swallowing it — the same honesty contract `droppedIntent` exists for.
        this.emit({
          kind: "stateChanged",
          summary: `One thing at a time — you settle your business here; the way on to ${destName} is a trip of its own.`,
          changes: {},
        });
      }
    }

    // Consequence floor (Phase 3, playtest #1): after the per-kind resolver runs (in this RESOLVE
    // phase, so any mutation lands before narrate and auto-enters the Judge ledger), bind a real
    // persistent trace to a meaningful transgression / social ask — so success stops being identical
    // to failure. A no-op for combat, the resolvers that already mutate, and neutral (`impact.none`)
    // turns, which is EVERY deterministic-classifier turn — so nothing regresses.
    // Getting up is part of the turn's story: whatever the intent resolved to, the prose has to say
    // the player left the bed first, or the scene reads as another phantom trip out of a room they
    // never left (r5 P1).
    const rose = ctx.data.roseFromRoom as string | undefined;
    if (rose) {
      const narration = ctx.data.narration as NarrationIntent | undefined;
      ctx.data.narration = narration
        ? {
            ...narration,
            trigger: `${rose} ${narration.trigger}`,
            ...(narration.echoFallback ? { echoFallback: `You get up and come down into the hall. ${narration.echoFallback}` } : {}),
          }
        : ({ trigger: rose } satisfies NarrationIntent);
    }
    this.bindConsequences(ctx, plan, input);
  }

  /**
   * Consequence floor (Phase 3, playtest #1) — bind ≥1 PERSISTENT delta to a MEANINGFUL resolved turn
   * so success stops folding to the same state as failure ("outside scripted quest rails the engine
   * produced varied prose around UNCHANGED state"). Scope = the two LEAK paths (attemptRequiringCheck /
   * freeformNarrative — the only resolvers that emit no reducer delta); every other kind already
   * mutates, combat emits its own deltas, and a neutral `impact.none` turn (EVERY deterministic test
   * turn, since the test classifier never sets impact) is a no-op — so nothing regresses.
   *
   * Each authored effect grounds to an EXISTING reducer command (setFlag / adjustRelationship /
   * adjustFactionStanding / recordNpcMemory — no new command or delta kind), dry-run first and applied
   * only if it wouldn't reject; the applied commands auto-enter the Judge ledger via `this.apply`. A
   * meaningful turn that grounds to nothing still gets a can't-reject `setFlag`, so ≥1 accepted delta
   * is unconditional. The authoritative lines are stashed on `ctx.data.consequences` for the narrator
   * brief (the CONSEQUENCES block) so prose reflects the outcome and the Judge converges.
   */
  private bindConsequences(ctx: TickContext, plan: TurnPlan, input: string): void {
    if (plan.kind !== "attemptRequiringCheck" && plan.kind !== "freeformNarrative") return;
    if (ctx.data.combatAttack) return; // combat emits its own deltas
    const impact = plan.impact;
    // A neutral beat leaves no trace. Guard BOTH domain and severity `none` (matching consequence.ts
    // `isMeaningful`): a domain-set/severity-none impact earns no effects from the table, so falling
    // through would fire the floor and write a dead `witnessed.<loc>` flag + a CONSEQUENCES block on a
    // turn the design treats as byte-identical (review finding).
    if (!impact || impact.domain === "none" || impact.severity === "none") return;

    const model = ctx.model;
    const world = this.deps.playset.world;
    const pcId = playerEntity(model)?.id ?? "pc.you";
    const loc = partyLocationOf(model);
    if (!loc) return;

    // Outcome: a check reads its verdict off the parked resolved block; a freeform transgression has
    // no roll, so the act simply HAPPENED (success). A hard refusal (exhaustion) is skipped — nothing
    // landed to have a consequence.
    const resolved = (ctx.data.narration as NarrationIntent | undefined)?.resolved;
    if (resolved?.refused) return;
    const outcome: ConsequenceOutcome =
      plan.kind === "attemptRequiringCheck" ? (resolved?.success ? "success" : "failure") : "success";

    // The grounded victim + living co-located witnesses (besides the victim) + the regional scope the
    // notoriety count is tracked against (region id, else the location id for an unregioned place).
    const victimId =
      impact.victimId && model.entities.get(impact.victimId)?.kind === "npc" ? impact.victimId : null;
    const witnesses = entitiesAt(model, loc).filter(
      (e) => e.kind === "npc" && e.id !== victimId && (!e.stats || e.stats.currentHp > 0),
    );
    const scope = regionOfLocation(world, loc) ?? loc;

    // Violence with no PERSON on the receiving end — fighting off a monster, a rope trick on the
    // hound cornering you — is survival, not scandal (r7 P3: a FAILED snare against a hostile beast
    // printed "your notoriety in the region grows" with no legible cause). Social consequence
    // machinery needs a social act; monster-fights already carry their costs in HP and rations.
    if (impact.domain === "violence" && victimId === null) return;

    const effects = consequencesFor({
      domain: impact.domain,
      severity: impact.severity,
      outcome,
      witnessed: witnesses.length > 0,
      hasVictim: victimId !== null,
    });

    const lines: string[] = [];
    const tryApply = (cmd: Command): boolean => {
      if (ctx.dryRun(cmd).rejected) return false;
      this.apply(cmd);
      return true;
    };
    const flagNumber = (key: string): number => (typeof model.flags[key] === "number" ? (model.flags[key] as number) : 0);

    for (const effect of effects) {
      switch (effect.kind) {
        case "notoriety": {
          const key = notorietyFlagKey(scope);
          const prev = flagNumber(key);
          const next = prev + effect.by;
          if (tryApply({ type: "setFlag", scope: "world", key, value: next })) {
            // Name the CAUSE (r7 P3: "told I'm being judged, not told for what") — the domain is
            // the classifier's own read of what the act was.
            const cause =
              impact.domain === "violence" ? "the violence" :
              impact.domain === "property" ? "the theft" :
              impact.domain === "deception" ? "the deceit" : "what you did";
            lines.push(`Word of ${cause} spreads; your notoriety in the region grows.`);
          }
          // Crossing into the WANTED tier sets a flag authored guard-response events key on (like the
          // existing `fenwick_toll_raised` flag) — a single write, on the crossing only.
          if (notorietyTier(prev) !== "wanted" && notorietyTier(next) === "wanted") {
            if (tryApply({ type: "setFlag", scope: "world", key: wantedFlagKey(scope), value: true })) {
              lines.push("You are now WANTED in the region — the law will be looking for you.");
            }
          }
          break;
        }
        case "witnessFlag": {
          if (tryApply({ type: "setFlag", scope: "world", key: witnessedFlagKey(loc), value: true })) {
            lines.push("Your action did not go unseen here.");
          }
          break;
        }
        case "disposition": {
          const targets =
            effect.who === "victim" ? (victimId ? [victimId] : []) : witnesses.slice(0, 3).map((e) => e.id);
          for (const id of targets) {
            if (tryApply({ type: "adjustRelationship", actorId: id, targetId: pcId, by: effect.by })) {
              lines.push(`${this.actorName(id)}'s regard for you ${effect.by < 0 ? "hardens" : "warms"}.`);
            }
          }
          break;
        }
        case "faction": {
          if (!victimId) break;
          const factionId = factionOf(world, model.entities.get(victimId)?.templateId ?? victimId);
          if (!factionId) break;
          let any = false;
          for (const cmd of factionStandingCommands(world, pcId, factionId, effect.by)) any = tryApply(cmd) || any;
          if (any) lines.push(`Your standing with ${factionId} shifts.`);
          break;
        }
        case "memory": {
          if (!victimId) break;
          const summary = `The player: "${input.trim().slice(0, 90)}"`;
          if (tryApply({ type: "recordNpcMemory", npcId: victimId, entry: { at: model.clock, kind: "witnessed", summary } })) {
            lines.push(`${this.actorName(victimId)} will remember this.`);
          }
          break;
        }
        case "grantAsk": {
          const socialAsk = ctx.data.socialAsk as { targetId: string | null; askKind: string; success: boolean } | undefined;
          if (socialAsk?.targetId) {
            const key = `agenda.granted.${socialAsk.targetId}.${socialAsk.askKind}`;
            if (tryApply({ type: "setFlag", scope: "world", key, value: true })) {
              lines.push(`${this.actorName(socialAsk.targetId)} yields to your ${socialAsk.askKind}.`);
            }
          }
          break;
        }
      }
    }

    // Floor: a meaningful turn that grounded to NOTHING (e.g. a victimless, unwitnessed transgression)
    // still gets a can't-reject setFlag, so ≥1 accepted delta is UNCONDITIONAL for any non-neutral turn.
    if (lines.length === 0) {
      if (impact.severity === "serious" || impact.severity === "grave") {
        const key = notorietyFlagKey(scope);
        if (tryApply({ type: "setFlag", scope: "world", key, value: flagNumber(key) + 1 })) {
          lines.push("Word of what you did spreads; your notoriety in the region grows.");
        }
      } else if (tryApply({ type: "setFlag", scope: "world", key: witnessedFlagKey(loc), value: true })) {
        lines.push("Your action leaves its mark here.");
      }
    }

    if (lines.length > 0) {
      this.emit({ kind: "stateChanged", summary: lines[0]! });
      ctx.data.consequences = lines;
    }
  }

  /**
   * A PRIVATE player turn (Phase 6): the validated target gets the line as an aside. The player's
   * dialogue event carries `channel:"private"`, the addressed NPC's reply follows through the
   * dialogue module on the same channel, and the line becomes that NPC's STANDING WHISPER STEER —
   * the last private line per NPC, recorded through the reducer's generic `modulePatch` chokepoint
   * (replay-safe; bounded to one string per NPC). Bystander exclusion is structural: the intent's
   * `channel` gates autonomy priority-B, `# RECENT` filtering, and other NPCs' memory beats. The
   * same world rules still apply — a private line advances the clock like any spoken one, and the
   * channel never weakens a content gate (it changes who HEARS a line, never what is possible).
   * A private line is never read as the player's PUBLIC response to an agenda or proposal.
   */
  private resolvePrivateDialogue(ctx: TickContext, toId: string, input: string, playerId: string): void {
    ctx.data.advancesClock = true;
    this.emit({ kind: "dialogue", actorId: playerId, text: input, toId, channel: "private" });
    this.applySilent({ type: "modulePatch", module: WHISPERS_MODULE, patch: { [toId]: input } });
    ctx.data.dialogue = { npcId: toId, playerLine: input, channel: "private" } satisfies DialogueIntent;
  }

  /**
   * Mint a classifier-reported `makeDeal` effect (PROSE-TO-CODE §2.2): terms the player and a PRESENT
   * person just settled become a standing row in the `deals` slice, so the bargain outlives the
   * scrollback it was spoken in. The reducer owns dedup (a haggle settled over three turns is one
   * deal) and the cap; this only grounds the parties and hands the terms over verbatim.
   *
   * Capture, not enforcement (the §2.2 bar for this wave): nothing here checks whether the terms are
   * possible, priced, or kept. A recorded deal is a fact about what was SAID, which is exactly what
   * was missing — the trade/quest resolvers reading it back is the next pass.
   */
  private resolveMakeDealEffect(ctx: TickContext, rawTerms: string, withNpcId: string | null): string | null {
    const model = ctx.model;
    const player = playerEntity(model);
    const other = withNpcId ? model.entities.get(withNpcId) : undefined;
    const terms = normalizeTerms(rawTerms);
    if (!player || !other || !terms) return null;
    const result = this.apply({
      type: "recordDeal",
      deal: {
        parties: [player.id, other.id],
        partyNames: [displayName(player), displayName(other)],
        terms,
        state: "open",
        atClock: model.clock,
        closedAtClock: null,
      },
    });
    // A rejected mint is malformed terms; a NO-OP is the same bargain already standing — both are
    // silent, because "you agree again" is not a beat.
    if (result.rejected || result.deltas.length === 0) return null;
    this.emit({
      kind: "stateChanged",
      summary: `Deal struck with ${displayName(other)}: ${terms}`,
      changes: { deal: terms, withId: other.id },
      // The narrator already has the exchange in prose — the row is bookkeeping, not a second line.
      quiet: true,
    });
    ctx.data.persist = true;
    return `You and ${displayName(other)} settle it: ${terms}`;
  }

  /**
   * Close a standing deal the player just kept or broke (§2.2). WHICH deal is code's call — the most
   * recent open one with the named party (`openDealWith`), or the most recent open one at all when
   * the line named nobody, since the model reports the ACT and never a row id.
   */
  private resolveDealActionEffect(
    ctx: TickContext,
    withNpcId: string | null,
    state: "honoured" | "broken" | null,
  ): string | null {
    if (!state) return null;
    const model = ctx.model;
    const deal = openDealWith(readDealsSlice(model.modules), withNpcId);
    if (!deal) return null;
    if (this.apply({ type: "setDealState", dealId: deal.id, state, atClock: model.clock }).rejected) return null;
    const who = deal.partyNames.filter((_, i) => deal.parties[i] !== playerEntity(model)?.id).join(" and ");
    const verb = state === "honoured" ? "kept" : "broken";
    this.emit({
      kind: "stateChanged",
      summary: `Deal ${verb} with ${who || "them"}: ${deal.terms}`,
      changes: { dealId: deal.id, state },
      quiet: true,
    });
    ctx.data.persist = true;
    return state === "honoured"
      ? `Your word to ${who || "them"} is kept: ${deal.terms}`
      : `Your word to ${who || "them"} is broken: ${deal.terms}`;
  }


  private resolveLocationInteraction(ctx: TickContext, plan: TurnPlan, input: string): NarrationIntent | undefined {
    const interactionId = plan.interaction?.interactionId ?? null;
    const loc = partyLocationOf(ctx.model);
    if (!interactionId || !loc) return { trigger: input };
    const interaction = this.deps.playset.world.locations
      .find((l) => l.id === loc)
      ?.interactions?.find((i) => i.id === interactionId && i.mode === "action");
    if (!interaction) {
      ctx.data.clockMinutes = 1;
      ctx.data.energyCost = 0;
      return { trigger: `You look for something to work with here, but find no such opportunity. ${input}` };
    }
    ctx.data.locationInteraction = { interactionId, locationId: loc };
    return undefined;
  }

  // --- Errands (r5) ---------------------------------------------------------

  /**
   * The authored NPC a line NAMES but who is not here, or undefined.
   *
   * Two guards, both learned in live play. **Only rostered NPCs count** — an ambient
   * crowd/spawn-only template is not someone the world ever introduced by name, so the player
   * cannot be addressing them. And a bare given-name token must not be a PLACE token: "go to the
   * Undercroft" was binding the crowd template "Undercroft Shadow" and answering "there is no sign
   * of Undercroft Shadow here." That is r4's GENERIC_PLACE_TOKENS lesson (`src/world/exit-match.ts`)
   * in the person half — a token that names somewhere cannot, on its own, name someone.
   */  private absentNamedInLine(input: string, presentNames: ReadonlySet<string>): NpcTemplate | undefined {
    return this.absentNamedAllInLine(input, presentNames)[0];
  }

  /**
   * EVERY absent authored NPC the line names, in roster order — see `absentNamedInLine` for the
   * two guards. One line routinely names more than one person: "Oda, go find Brann" names the
   * runner AND the subject. Taking only the first match there drops whichever the guards skip —
   * the runner is PRESENT, so the singular form returned nothing and the errand pool came up
   * empty on the very turn the player first thinks of the subject (found in live play).
   */
  private absentNamedAllInLine(input: string, presentNames: ReadonlySet<string>): NpcTemplate[] {
    const world = this.deps.playset.world;
    const lower = input.toLowerCase();
    return world.npcs.filter((npc) => {
      const name = npc.name?.trim();
      if (!name || presentNames.has(name.toLowerCase())) return false;
      if (!this.isNameableNpc(npc)) return false;
      // The DEFAULT (`uncased`) surface, never `player-query`, at both callers — and this is the
      // honest reason, not an oversight. The errand pool is built BEFORE the classifier runs (it is
      // part of the message the classifier reads), so there is no plan to vouch that the line asks
      // about anyone; and a name in that pool is a name the model may bind an ACTION to, which is
      // why the pool is conservative in the first place (see `errandTargetsFor`). The addressee
      // caller is a direct address, not a query, and its wrong hit is a player-facing "X is not
      // here" about a cart. Cost of holding the line: a rostered, schedule-carrying NPC whose whole
      // name is ordinary English — three on the shipped roster (Dray, Nightjar, The Widow of the
      // Tor) — must be typed with a capital to be sent for or addressed in absentia.
      if (!nameMentioned(input, name)) return false;
      // A full-name mention is unambiguous; a lone first token must carry its own weight — it must
      // not be a place token, and not a generic honorific/kin/rank word either (r7 P3: a stray
      // "There is no sign of Sister Lian here" fired off the bare word "sister" for an NPC no one
      // in the run had ever mentioned — in a mystery, an unexplained proper noun reads as a clue).
      if (lower.includes(name.toLowerCase())) return true;
      const first = firstToken(name);
      return !this.placeTokens().has(first) && !GENERIC_NAME_TOKENS.has(first);
    });
  }

  /** See {@link isRosteredNpc} — the shared definition of "a name the world actually introduced". */
  private isNameableNpc(npc: NpcTemplate): boolean {
    return isRosteredNpc(this.deps.playset.world, npc);
  }

  /**
   * The world's place vocabulary — see `absentNamedInLine`. This used to be a private set built
   * from location names alone; it is now the shared `placeTokensOf` (locations + regions +
   * gazetteer, cached per world), because the same rule was needed by the continuity binder and
   * having two copies is how r11's "Anchorfall" ⇒ "Anchorfall Local" survived at the sites this
   * one never covered.
   */
  private placeTokens(): ReadonlySet<string> {
    return placeTokensOf(this.deps.playset.world);
  }

  /**
   * Whether anybody in this world keeps a routine a local could describe — authored `schedule`, or
   * one derived at runtime under the world's `seededRoutines` opt-in. Arms the classifier's
   * `dialogueAsk` guidance (and nothing else): where nobody has a routine, "where can I find X?" is
   * a question the engine cannot answer, so the flag stays off and the prompt is byte-identical —
   * which is every schedule-less fixture world under tests/. Computed once; the roster and the flag
   * are both load-time content.
   */
  private routinesKnown(): boolean {
    if (this.routinesKnownCache === null) {
      const world = this.deps.playset.world;
      this.routinesKnownCache = world.npcs.some((npc) => !!effectiveScheduleOf(npc, world));
    }
    return this.routinesKnownCache;
  }
  private routinesKnownCache: boolean | null = null;

  /**
   * The legal `errand` subject/destination pool. Deliberately WIDER than "who you have met": a
   * person the world has only named is exactly who the player wants to send someone after (r4 P1),
   * and a place with a road to it is somewhere a runner can plausibly walk even if the player
   * never has. Capped so the prompt line stays small.
   */
  private errandTargetsFor(
    model: WorldModel,
    loc: string,
    presentIds: ReadonlySet<string>,
    knownAbsent: { id: string; name: string }[],
    input: string,
  ): { npcs: ClassifierEntityRef[]; places: ClassifierEntityRef[] } {
    const world = this.deps.playset.world;
    const npcs = new Map<string, ClassifierEntityRef>();
    // The brief's `Not present` pool is deliberately OVER-inclusive (a false include there only
    // forbids depicting someone, which is always safe). An errand pool is not: a name in it is a
    // name the model may bind an action to, and the live run bound "go to the Undercroft" to the
    // ambient crowd template "Undercroft Shadow". Same two guards as `absentNamedInLine`.
    for (const row of knownAbsent) {
      const template = world.npcs.find((n) => n.id === row.id);
      if (!template || !this.isNameableNpc(template)) continue;
      if (this.placeTokens().has(firstToken(row.name))) continue;
      npcs.set(row.id, row);
    }
    // The player NAMING someone in this very line is the strongest signal there is that they mean
    // to act on them — stronger than any relationship or sighting. Without this, "Oda, go ask
    // Brann about the list" grounds nothing on the turn the player first thinks of Brann, which is
    // exactly when they want to send someone (found in live play). ALL the names, not
    // the first: that line names the present runner first, and a singular read stopped there.
    for (const named of this.absentNamedAllInLine(input, new Set())) {
      if (!presentIds.has(named.id)) npcs.set(named.id, { id: named.id, name: named.name });
    }

    const sightings = readSightingsSlice(model.modules);
    const playerId = playerEntity(model)?.id ?? "pc.you";
    for (const template of world.npcs) {
      if (npcs.size >= 12) break;
      if (presentIds.has(template.id) || !this.isNameableNpc(template)) continue;
      if (this.placeTokens().has(firstToken(template.name))) continue;
      const witnessed = (sightings.byNpc[template.id]?.length ?? 0) > 0;
      const known = model.relationships.get(template.id)?.get(playerId) !== undefined;
      const rosteredWhereVisited = world.locations.some(
        (l) => l.npcs.includes(template.id) && model.flags[visitedFlag(l.id)] === true,
      );
      if (witnessed || known || rosteredWhereVisited) npcs.set(template.id, { id: template.id, name: template.name });
    }

    const places: ClassifierEntityRef[] = [];
    for (const location of world.locations) {
      if (places.length >= 12) break;
      if (location.id === loc || isFrontierId(location.id)) continue;
      const visited = model.flags[visitedFlag(location.id)] === true;
      if (!visited && !findRoute(model, loc, location.id, { defaultLegMinutes: TURN_COSTS.movement.minutes })) continue;
      places.push({ id: location.id, name: location.name });
    }
    return { npcs: [...npcs.values()], places };
  }

  private npcName(npcId: string): string {
    const entity = this.getModel().entities.get(npcId);
    if (entity) return displayName(entity);
    return this.deps.playset.world.npcs.find((n) => n.id === npcId)?.name ?? npcId;
  }

  // --- Party actions (Phase 2, Stage C) -------------------------------------

  /** The authored/enriched template behind an entity (content lookup by templateId-or-id). */
  private npcTemplateFor(entity: Entity): NpcTemplate | undefined {
    return this.deps.playset.world.npcs.find((n) => n.id === (entity.templateId ?? entity.id));
  }

  /**
   * Ensure an NPC party member has a live companion agent + heartbeat (idempotent). Invited
   * members get one at join; `start()` rebuilds them on reload from the hydrated enriched
   * templates, so a companion recruited last session still speaks and self-initiates today.
   */
  private ensureCompanionAgent(npcId: string): void {
    if (this.npcs.has(npcId)) return;
    const entity = this.model?.entities.get(npcId);
    if (!entity || entity.kind !== "npc") return;
    const template = this.npcTemplateFor(entity);
    if (!template) return;
    this.npcs.set(npcId, new NpcAgent(this.gateway, template, this.deps.systemPrefix));
    this.heartbeat.register(npcId, template.autonomy.heartbeatSeconds);
  }

  /**
   * The reply agent for a PRIVATE thread (Phase 6). A standing companion agent always wins; a
   * non-companion location NPC gets a cached ephemeral agent built from its authored/enriched
   * template (deterministic composed floor when none exists — the same fallback the stance math
   * uses). Ephemeral means exactly that: no heartbeat, no persistence, no autonomy registration —
   * a location NPC can privately CONVERSE without becoming a proactive companion.
   */
  private privateReplyAgentFor(npcId: string): NpcAgent | undefined {
    const companion = this.npcs.get(npcId);
    if (companion) return companion;
    const cached = this.privateAgents.get(npcId);
    if (cached) return cached;
    const entity = this.model?.entities.get(npcId);
    if (!entity || entity.kind !== "npc") return undefined;
    const template = this.npcTemplateFor(entity) ?? composeNpcTemplate(this.deps.playset.world, entity);
    const agent = new NpcAgent(this.gateway, template, this.deps.systemPrefix);
    this.privateAgents.set(npcId, agent);
    return agent;
  }

  /**
   * Commit the authoritative snapshot and every staged durable event as one indivisible unit.
   * Persistence failure is a turn failure: callers roll the live model back and no staged event is
   * published. Emitting a warning here would recurse into the same broken write path, so errors are
   * deliberately propagated unchanged.
   */
  private async persist(): Promise<void> {
    const commit = this.deps.store.commitTurn;
    if (typeof commit !== "function") {
      throw new Error("This save store cannot atomically commit a turn.");
    }
    const batch = this.eventBatch;
    if (batch?.committed) return;
    const staged = [...this.pendingEvents, ...(batch?.events ?? [])].filter((event) => this.isDurableEvent(event));
    await commit.call(this.deps.store, this.saveKey, this.getState(), staged);
    this.pendingEvents = [];
    if (batch) batch.committed = true;

    // Derived memories are intentionally outside the SSOT. Flush them only after the authoritative
    // write succeeds; each sidecar is best-effort and epoch-guarded against rewind/rollback races.
    if (this.disclosure.isDirty()) void this.disclosure.save();
    if (this.npcHistory.isDirty()) void this.npcHistory.save();
  }

  /** The model, or throw if the engine hasn't started. */
  private getModel(): WorldModel {
    if (!this.model) throw new Error("engine not started");
    return this.model;
  }

  /** The current state as the legacy GameState shape — a pure projection of the model. */
  getState(): GameState {
    return toGameState(this.getModel());
  }

  /** Everyone present at the party's location, sourced from the model registry — so it includes
   *  statless authored NPCs and spawned foes the legacy GameState projection omits. For client
   *  presence (/who) that must match what the narrator sees. `activity`/`knownHabit` carry the
   *  routine annotation + the habit this save has witnessed (omit-when-empty). */
  presentEntities(): Array<{
    id: string;
    name: string;
    partyMember: boolean;
    kind: string;
    activity?: string;
    knownHabit?: string;
  }> {
    const model = this.getModel();
    const loc = partyLocationOf(model);
    if (loc === null) return [];
    const playerId = playerEntity(model)?.id;
    const routines = readRoutinesSlice(model.modules);
    const sightings = readSightingsSlice(model.modules);
    const locName = (id: string): string =>
      this.deps.playset.world.locations.find((l) => l.id === id)?.name ?? id;
    return entitiesAt(model, loc)
      .filter((e) => e.id !== playerId)
      // A downed, stat-bearing foe is a corpse in the room — cull it so /who and the presence
      // panels don't list the thing the party just dropped. Statless authored NPCs (no `stats`)
      // are never "downed" and always stay present.
      .filter((e) => e.stats === undefined || e.stats.currentHp > 0)
      .map((e) => {
        const habit = habitOf(sightings.byNpc[e.id] ?? []);
        return {
          id: e.id,
          name: displayName(e),
          partyMember: e.partyMember,
          kind: e.kind,
          ...(routines.activity[e.id] ? { activity: routines.activity[e.id] } : {}),
          ...(habit ? { knownHabit: renderHabitLine(habit, locName) } : {}),
        };
      });
  }

  /**
   * Present characters with any declared ages — the minor-safety guard's declared-participant
   * protection. The guard reads this each screen (wired via `guard.setContextProvider`), so a
   * sub-18 PC/NPC standing in the scene is protected by id, independent of prose distance.
   * Best-effort: returns no characters before the engine has started or if the party is nowhere.
   */
  currentSafetyContext(): SafetyContext {
    if (!this.model) return {};
    const loc = partyLocationOf(this.model);
    if (loc === null) return {};
    const { campaign, world } = this.deps.playset;
    // Keep the model↔content age/isMinor join in one place. `id` is included so the safety guard can
    // protect a specific participant rather than relying on prose proximity.
    const model = this.model;
    const characters = entitiesAt(model, loc).map((e) => safetyCharacterOf(model, world, campaign, e.id));
    return { characters };
  }

  /** Apply a command through the reducer, emitting (and persisting) its deltas as story events. */
  private apply(cmd: Command): CommandResult {
    // A capture MATERIALIZES the synthetic hold the moment it fires — lazily, like Camp is materialized
    // by resolveEnterCamp — so the narrator can name it and the teleport lands somewhere real. Idempotent;
    // a session that is never captured keeps world.locations byte-identical (the count invariant tests rely on).
    if (cmd.type === "beginCaptivity") this.ensureCaptivityLocation();
    const res = applyCommand(this.getModel(), cmd);
    // Only ACCEPTED commands enter the turn's authorized-command ledger. A rejected command mutated
    // nothing (the reducer's atomic-or-nothing rule), so recording it would let the continuity Judge
    // treat a failed transfer/unlock/move as a real world change and bless prose that narrates it.
    if (this.turnCommandSink && !res.rejected) this.turnCommandSink.push(cmd);
    for (const d of res.deltas) {
      this.mirrorContentDelta(d);
      this.emit(d);
    }
    this.surfaceQuestOffers(res);
    this.grantQuestReward(res);
    this.armQuestDeadlines(res);
    this.evictStaleAgents(res);
    return res;
  }

  /** Keep the immutable-content mirror aligned for read-side guidance after runtime map deltas. */
  private mirrorContentDelta(delta: EmittedDelta): void {
    if (delta.kind !== "exitLinked") return;
    const holder = this.deps.playset.world.locations.find((l) => l.id === delta.fromLocationId);
    if (!holder || holder.exits.some((e) => e.to === delta.to)) return;
    holder.exits.push({ to: delta.to, name: `to ${delta.name}`, locked: false, hidden: false });
  }

  /** Apply a bookkeeping command (clock, autonomy) — mutates the model, broadcasts nothing. */
  private applySilent(cmd: Command): CommandResult {
    const res = applyCommand(this.getModel(), cmd);
    // Same reject-aware ledger discipline as `apply`: a rejected command changed nothing, so it must
    // not be reported to the Judge as an authorized world change this turn.
    if (this.turnCommandSink && !res.rejected) this.turnCommandSink.push(cmd);
    for (const d of res.deltas) this.emitSilent(d);
    this.evictStaleAgents(res);
    return res;
  }

  /**
   * Validate a command WITHOUT touching the live model — the accepted/rejected oracle for the signed
   * TurnOutcome. Runs the pure reducer against a `structuredClone` of the model (the model is all plain
   * data — Maps/Records/arrays — so the clone is deep and independent), emitting nothing and persisting
   * nothing. The real mutation stays the reducer at `commit` (one-writer intact).
   */
  private dryRun(cmd: Command): CommandResult {
    return applyCommand(structuredClone(this.getModel()), cmd);
  }

  /**
   * Drop any cached ephemeral reply agent whose template just changed: `privateReplyAgentFor`
   * caches per id forever, and P5 made that cache the reply path for ALL public address of
   * non-companions — a profile rebind or promotion deepening must not leave a stale voice.
   */
  private evictStaleAgents(res: CommandResult): void {
    for (const d of res.deltas) {
      if (d.kind === "npcEnriched") this.privateAgents.delete(d.npcId);
      // A membership DROP from ANY path must retire the live companion agent, or the heartbeat keeps
      // ticking an NPC the world says has left. Release paths already delete explicitly (harmless
      // double-delete here); the path that could NOT reach engine internals was a tick module — e.g.
      // the upkeep dismissal enqueues setPartyMembership from UpkeepModule, and without this hook the
      // "unpaid, walks" merc kept acting as a companion until the next reload reconciled agents.
      if (d.kind === "partyMembershipChanged" && !d.member) {
        this.npcs.delete(d.entityId);
        this.heartbeat.unregister(d.entityId);
      }
      // The mirror: (re-)admission re-arms the agent (idempotent — existing agents are kept). This
      // covers reducer-driven joins the resolver paths can't reach, e.g. endCaptivity re-admitting
      // the scattered party after the capture-side drops above evicted them.
      if (d.kind === "partyMembershipChanged" && d.member) this.ensureCompanionAgent(d.entityId);
    }
  }

  // --- internals ----------------------------------------------------------

  /**
   * Resolve a quest opt-in (Phase 3): accepting a quest ON OFFER makes it active; declining
   * re-hides it (declinable but recoverable — a prebaked event or NPC can re-offer it later).
   * The ANSWER is pure state mechanics through the reducer; the narrator only restates the
   * deterministic outcome. A stale/ungrounded target degrades to freeform-style narration.
   */
  private resolveQuestAction(ctx: TickContext, plan: TurnPlan, input: string): NarrationIntent {
    const quest = plan.quest;
    const questId = quest?.questId ?? null;
    // Re-check the CURRENT state at execution time — the classifier context could be stale.
    if (!quest || !questId || ctx.model.quests.get(questId) !== "offered") {
      return { trigger: `You speak of taking on a task, but no such offer stands. ${input}` };
    }
    const name = this.questName(questId);
    if (quest.verb === "accept") {
      this.apply({ type: "setQuestState", questId, state: "active" });
      this.emit({
        kind: "stateChanged",
        summary: `Quest accepted: ${name}.`,
        changes: { questId, questState: "active" },
      });
      // Bookkeeping, not a scene: the offer was already played out in fiction (the quest-giver's
      // dialogue), so the accept lands verbatim with no narrator round-trip — the panel ACCEPT
      // used to cost a full ~60s narrated turn that re-ran the scene (r2 P2; the equip/buy
      // instant-mechanics precedent).
      return { trigger: `You take on the task: "${name}". It is now yours to see through.`, deterministic: true };
    }
    this.apply({ type: "setQuestState", questId, state: "hidden" });
    this.emit({
      kind: "stateChanged",
      summary: `Quest declined: ${name}.`,
      changes: { questId, questState: "hidden" },
    });
    return { trigger: `You turn down the task: "${name}". The offer is withdrawn — for now.`, deterministic: true };
  }

  /** Display name of a quest id (authored campaign name; falls back to the id). */
  private questName(questId: string): string {
    return this.deps.playset.campaign.quests.find((q) => q.id === questId)?.name ?? questId;
  }

  /**
   * The active-case grounding surface for the classifier (mystery wave): the FIRST active, open case,
   * its present-NPC suspects, and the player's established facts (fact text as the display name).
   * Undefined when no case is active ⇒ the classifier context omits `activeCase` (byte-identical
   * caseless prompt). Fact text is truncated so a long clue can't bloat the classifier prompt.
   */
  private activeCaseContextFor(model: WorldModel, present: Entity[]): ClassifierContext["activeCase"] | undefined {
    const cases = this.deps.playset.campaign.cases;
    if (cases.length === 0) return undefined;
    const slice = readCasesSlice(model.modules);
    for (const c of cases) {
      if (model.quests.get(c.questId) !== "active") continue;
      const runtime = slice[c.id];
      if (runtime && runtime.status !== "open") continue;
      const suspects = present.filter((e) => e.kind === "npc").map((e) => ({ id: e.id, name: e.name }));
      const knownFacts = (runtime?.playerKnown ?? []).map((id) => {
        const text = c.facts.find((f) => f.id === id)?.text ?? id;
        return { id, name: text.length > 80 ? `${text.slice(0, 79)}…` : text };
      });
      return { caseId: c.id, suspects, knownFacts };
    }
    return undefined;
  }


  private offeredQuestRefs(): ClassifierEntityRef[] {
    const refs: ClassifierEntityRef[] = [];
    for (const [questId, state] of this.getModel().quests) {
      if (state === "offered") refs.push({ id: questId, name: this.questName(questId) });
    }
    return refs;
  }

  /**
   * What the world's ledger already records as true of this player — the quests they have TAKEN or
   * settled. The classifier needs this to tell "I want you to believe me" (a cha check) apart from
   * "this is what happened" (a statement of record). Without it the model cannot see that a claim is
   * already true, so it defaulted to Persuasion and a failed roll made an NPC's confabulation the
   * stickier canon (playtest 07-24 P1). Omit-when-empty keeps a fresh campaign's prompt byte-stable.
   */
  private establishedFactRefs(): ClassifierEntityRef[] {
    const refs: ClassifierEntityRef[] = [];
    for (const [questId, state] of this.getModel().quests) {
      if (state === "active") refs.push({ id: questId, name: `you took on "${this.questName(questId)}"` });
      else if (state === "complete") refs.push({ id: questId, name: `you finished "${this.questName(questId)}"` });
      else if (state === "failed") refs.push({ id: questId, name: `you failed "${this.questName(questId)}"` });
    }
    // The party's recent REAL journeys (2026-07-25): without them, "weren't we just at X?" reads
    // to the classifier like a contestable claim rather than a statement of record.
    for (const leg of recentJourneys(this.getModel().modules)) {
      refs.push({
        id: `traveled:${leg.toId}:${leg.atClock}`,
        name: `you traveled from ${this.locationName(leg.fromId)} to ${this.locationName(leg.toId)} (${dayPhaseOf(leg.atClock)}, day ${Math.floor(leg.atClock / 1440) + 1})`,
      });
    }
    return refs;
  }

  /**
   * Surface every quest currently ON OFFER as an in-fiction offer beat at session start (fresh,
   * resumed, or restarted). `questOffered` is ephemeral and not persisted, like a system notice.
   * Omitted entirely when nothing is offered.
   */
  emitOfferedQuestNotice(): void {
    for (const [questId, state] of this.getModel().quests) {
      if (state === "offered") this.emitQuestOffered(questId);
    }
  }

  /**
   * Put the starting kit ON the character (r5 P3). A fresh PC's armour, shield and weapon shipped in
   * the bag: the review sheet said AC 16, play opened at AC 11 with no armour worn, and nothing
   * anywhere said so — the player found out by opening the inventory before a road trip, and a new
   * one would simply have lost the first fight five points down.
   *
   * Only fills EMPTY slots, only from what the character already carries, and only on the opening
   * turn (a resumed save is the player's own arrangement and is never touched). Deliberately dumb
   * about "best": the first item that fits each slot, so the choice is the author's kit order.
   */
  private equipStartingKit(): void {
    const model = this.getModel();
    const player = playerEntity(model);
    if (!player?.stats) return;
    const world = this.deps.playset.world;
    const sheet = this.deps.playset.campaign.characters.find((c) => c.id === player.id)?.stats;
    const equipped = { ...(player.stats.equipped ?? {}) };
    for (const slot of ["armor", "shield", "weapon"] as const) {
      if (equipped[slot]) continue;
      const itemId = player.stats.inventory.find((id) => {
        const item = resolveItem(world, id);
        if (item === undefined || !itemFitsSlot(item, slot) || Object.values(equipped).includes(id)) return false;
        // Never make the character WORSE off: a stat block whose authored armorClass already beats
        // what the carried armour would derive keeps its own number (some sheets carry a natural or
        // authored defence the kit does not explain).
        if (slot !== "armor" || !sheet) return true;
        const resolver = (candidate: string) => resolveItem(world, candidate);
        return derivedAc(sheet, { ...equipped, armor: id }, resolver) >= derivedAc(sheet, equipped, resolver);
      });
      if (!itemId) continue;
      const result = this.applySilent({ type: "equipItem", entityId: player.id, itemId, slot });
      if (!result.rejected) equipped[slot] = itemId;
    }
  }

  /**
   * Emit the in-fiction `questOffered` beat for one quest. The pitch is the quest's own words with
   * any repeated world blurb stripped through the shared `questPitch` seam.
   */
  private emitQuestOffered(questId: string): void {
    const { campaign, world } = this.deps.playset;
    const quest = campaign.quests.find((q) => q.id === questId);
    this.emit({
      kind: "questOffered",
      questId,
      name: this.questName(questId),
      description: quest
        ? questPitch(quest.description, { synopsis: campaign.synopsis, summary: world.summary })
        : "",
    });
  }

  /**
   * Post-command hook (runs inside `apply`, so EVERY channel funnels through it — an event effect's
   * enqueued command committed at tick end, a letter read, a direct opt-in): when a command flips a
   * quest INTO "offered", deliver the inline card at that beat. The reducer no-ops a same-state set,
   * so a genuine transition emits exactly once; a later decline→hidden then re-offer emits afresh.
   */
  private surfaceQuestOffers(res: CommandResult): void {
    for (const d of res.deltas) {
      if (d.kind === "questStateChanged" && d.state === "offered") this.emitQuestOffered(d.questId);
    }
  }

  /**
   * Post-command hook, sibling to `surfaceQuestOffers`: when a command flips a quest INTO
   * "active" and the quest authors `deadlineMinutes`, arm the ABSOLUTE due clock into
   * `modules.questDeadlines` (2026-07-25: deadlines with teeth). Runs inside `apply`, so every
   * accept channel — an event effect, a typed action, NPC grounding — arms exactly once (the
   * reducer no-ops a same-state set; a re-activation after failure re-arms afresh). The inner
   * apply emits only `modulePatched`, which no hook matches — recursion terminates.
   */
  private armQuestDeadlines(res: CommandResult): void {
    for (const d of res.deltas) {
      if (d.kind !== "questStateChanged" || d.state !== "active") continue;
      const quest = this.deps.playset.campaign.quests.find((q) => q.id === d.questId);
      if (!quest?.deadlineMinutes) continue;
      this.apply({
        type: "modulePatch",
        module: QUEST_DEADLINES_MODULE,
        patch: { [d.questId]: this.getModel().clock + quest.deadlineMinutes },
      });
    }
  }

  /**
   * Post-command hook, sibling to `surfaceQuestOffers`: when a command flips a quest INTO
   * "complete", pay its authored reward ONCE. The reducer no-ops a same-state set, so a genuine
   * transition pays exactly once (and a later re-complete can't happen — "complete" is terminal).
   * The reward rides the SAME `adjustCoins` / `transferItem` commands as everything else (one
   * writer, replay-safe); `rewardCoins ≤ 0` with no `rewardItems` ⇒ nothing happens — a quest is
   * narrative-only by default, exactly as before this hook existed.
   */
  private grantQuestReward(res: CommandResult): void {
    for (const d of res.deltas) {
      if (d.kind !== "questStateChanged" || d.state !== "complete") continue;
      const quest = this.deps.playset.campaign.quests.find((q) => q.id === d.questId);
      if (!quest) continue;
      const player = playerEntity(this.getModel());
      if (!player) continue;
      // The quest-giver warms toward the PC on completion (living relationships) — independent of
      // any material reward, only when the giver names a real entity in the world.
      if (quest.giver && this.getModel().entities.has(quest.giver)) {
        this.apply({ type: "adjustRelationship", actorId: quest.giver, targetId: player.id, by: QUEST_GIVER_WARMTH });
        // …and the giver's whole faction warms toward the PC (bleeding to its allies/enemies).
        for (const cmd of factionStandingCommands(
          this.deps.playset.world,
          player.id,
          factionOf(this.deps.playset.world, quest.giver),
          QUEST_FACTION_WARMTH,
        )) {
          this.apply(cmd);
        }
      }
      const coins = quest.rewardCoins ?? 0;
      const items = quest.rewardItems ?? [];
      const xp = quest.rewardXp ?? 0;
      if (coins <= 0 && items.length === 0 && xp <= 0) continue;
      // from:null conjures the reward item into the player's pack (the giveItem precedent).
      if (coins > 0) this.apply({ type: "adjustCoins", entityId: player.id, by: coins });
      for (const itemId of items) this.apply({ type: "transferItem", itemId, from: null, to: player.id });
      if (xp > 0) awardXp(this.host(), player.id, xp);
      const parts: string[] = [];
      if (coins > 0) parts.push(formatCoins(coins));
      if (items.length > 0) parts.push(items.map((i) => this.itemName(i)).join(", "));
      if (xp > 0) parts.push(`${xp} XP`);
      this.emit({
        kind: "stateChanged",
        summary: `Reward for "${this.questName(d.questId)}": ${parts.join(" + ")}.`,
        changes: { questId: d.questId, rewardCoins: coins, rewardItems: items, rewardXp: xp },
      });
    }
  }

  /**
   * @param situational  The r8 closed-answer flags the MODEL cannot derive — a standing agenda
   *   demand and a leader's stashed proposal both live in per-turn engine scratch, not in the world
   *   model. Everything else the flags need (captive and in-combat) IS derivable
   *   and is read here, so every classify path gets it without threading a parameter.
   */
  private buildClassifierContext(
    recent: readonly GameEvent[] = [],
    input = "",
    situational: Pick<ClassifierContext, "pendingDemand" | "pendingProposal"> = {},
  ): ClassifierContext {
    const model = this.getModel();
    const player = playerEntity(model);
    const playerId = player?.id ?? "pc.you";
    const loc = partyLocationOf(model) ?? "";

    // Presence is now a registry query: everyone here except the player is addressable.
    const present = entitiesAt(model, loc).filter((e) => e.id !== playerId);
    const presentIds = new Set(present.map((entity) => entity.id));
    // Barred exits stay LISTED (the player must be able to try the door — the reducer refuses
    // with a reason); the state tag marks them so the classifier can ground "the locked door".
    // Frontier exits are dropped when expansion is disabled (like a hidden exit) so the classifier
    // can never ground a `frontier:` destination — the attempt degrades in place instead of refusing
    // a way it advertised. THE functional gate; when enabled this filter is byte-identical.
    const frontierOk = frontierEnabled(this.deps.playset.world);
    const exits: ClassifierEntityRef[] = mapExitsFrom(model.map, loc)
      .filter((e) => !e.hidden && (frontierOk || !isFrontierId(e.to)))
      .map((e) => ({
        id: e.to,
        // Keep the state-tagged name (the prompt/display contract), and carry the authored
        // direction so the fuzzy matcher can ground "go north" against a directional exit.
        name: `${e.name ?? this.locationName(e.to)}${exitStateTag(effectiveExitState(model, loc, e))}`,
        ...(e.direction ? { direction: e.direction } : {}),
      }));
    // Far-but-known travel referents (r9 F-5's classifier face): visited places, quest-named
    // places, gazetteer rumors — so "head west toward Ashford" classifies as the movement it is
    // instead of a shrug into freeform. Omit-when-empty keeps pre-quest prompts byte-identical.
    const knownPlaces = knownPlacesFor(model, this.deps.playset.world, this.deps.playset.campaign);

    // What the player carries (deduped — repeated ids are stacks), the itemAction grounding.
    // Stack counts ride the display name ("Rations (1 day) ×4") so the classifier can honor
    // "I throw ALL my rations" with a real quantity (r7 P3: four thrown, one deducted).
    const carriedCounts = new Map<string, number>();
    for (const itemId of player?.stats?.inventory ?? []) {
      carriedCounts.set(itemId, (carriedCounts.get(itemId) ?? 0) + 1);
    }
    const carried = new Map<string, ClassifierEntityRef>();
    for (const [itemId, n] of carriedCounts) {
      const base = resolveItem(this.deps.playset.world, itemId)?.name ?? itemDisplayNameOf(itemId);
      carried.set(itemId, { id: itemId, name: n > 1 ? `${base} ×${n}` : base });
    }

    // Spells the PC knows — the authored `spells` UNIONED with anything learned in play (the
    // effective spellbook the `cast` overlay grounds against). Known spells live on the campaign
    // character's stat block (not the runtime entity, whose `flags`/stats drop on reload); learned
    // ids live in the persisted `progression` slice, so both survive a reload.
    const knownSpells: ClassifierEntityRef[] = [];
    const pcBase = this.deps.playset.campaign.characters.find((c) => c.id === playerId)?.stats;
    const pcProg = readProgressionSlice(model.modules)[playerId];
    const pcSpellbook = pcBase ? effectiveStatBlock(pcBase, pcProg).spells : [];
    for (const spellId of pcSpellbook) {
      const spell = this.deps.playset.world.spells.find((s) => s.id === spellId);
      if (spell) knownSpells.push({ id: spell.id, name: spell.name });
    }
    const learnableSpells = this.learnableSpellsHere(model, playerId, present, new Set(pcSpellbook));
    const activeCaseCtx = this.activeCaseContextFor(model, present);

    // r5: authored people the recent transcript NAMED but who are not here. Same pool and same
    // matcher as the brief's `Not present` line, so the two can never disagree about who the
    // world has mentioned. These are grounding targets for intents ABOUT an absent person, never
    // addressees — `reconcilePlan` still clamps `targetId` to `presentEntities`.
    const knownAbsentNpcs = absentReferencedNpcs(
      this.deps.playset.world,
      present.map((e) => ({ id: e.id, name: displayName(e) })),
      recent
        .filter((e) => e.kind === "narration" || e.kind === "dialogue")
        .slice(-8)
        .map((e) => (e.kind === "narration" ? e.text : e.text))
        .join("\n"),
      this.summaryEnabled && this.summaryText ? this.summaryText : undefined,
    );

    // The errand grounding pool (r5). People: those the world has NAMED to the player, plus
    // anyone they have a standing relationship with, have witnessed, or would find on the roster
    // of somewhere they have been. Places: everywhere visited, plus anywhere a real road reaches
    // from here. Code-derived on purpose — the classifier can then never mint an id for someone
    // or somewhere the world has not shown, and the r4 "she's here" lead is still reachable.
    const errandTargets = this.errandTargetsFor(model, loc, presentIds, knownAbsentNpcs, input);

    // Present merchants (template opts in via `vendor`) and their live stock — trade grounding.
    const vendors: ClassifierVendorRef[] = [];
    for (const e of present) {
      if (e.kind !== "npc" || !e.stats) continue;
      const template = this.deps.playset.world.npcs.find((n) => n.id === (e.templateId ?? e.id));
      if (!template?.vendor) continue;
      const stock = new Map<string, ClassifierEntityRef>();
      for (const itemId of e.stats.inventory) {
        if (!stock.has(itemId)) {
          stock.set(itemId, { id: itemId, name: resolveItem(this.deps.playset.world, itemId)?.name ?? itemDisplayNameOf(itemId) });
        }
      }
      const services = (template.vendor.services ?? []).map((s) => ({ id: s.id, name: s.label }));
      // §2.1 — what this vendor PRICED ALOUD here, alongside what they stock. Grounding fodder, so
      // the classifier copies the offered name instead of reaching for the nearest stocked id.
      const offers = liveOffersFor(model.modules, e.id, loc, model.clock).map((o) => ({
        name: o.name,
        priceCp: o.priceCp,
      }));
      vendors.push({
        id: e.id,
        name: e.name,
        stock: [...stock.values()],
        ...(services.length > 0 ? { services } : {}),
        ...(offers.length > 0 ? { offers } : {}),
      });
    }

    return {
      playerActorId: playerId,
      locationId: loc,
      locationName: this.locationName(loc),
      exits,
      ...(knownPlaces.length > 0 ? { knownPlaces } : {}),
      presentEntities: present.map((e) => ({ id: e.id, name: e.name })),
      companionIds: present.filter((e) => e.partyMember && e.kind === "npc").map((e) => e.id),
      carriedItems: [...carried.values()],
      // What lies on THIS floor — the `pickup` grounding pool (deduped; omit-when-empty renders
      // no FLOOR_ITEMS line, keeping every bare-floor prompt byte-identical).
      floorItems: [...new Set(groundItemsAt(model.modules, loc))].map((id) => ({
        id,
        name: resolveItem(this.deps.playset.world, id)?.name ?? itemDisplayNameOf(id),
      })),
      knownSpells,
      learnableSpells,
      vendors,
      workOpportunities: workOpportunitiesHere(this.deps.playset.world, this.deps.playset.campaign, model, loc, present),
      locationInteractions: this.locationInteractionsHere(loc),
      offeredQuests: this.offeredQuestRefs(),
      establishedFacts: this.establishedFactRefs(),
      // Omit-when-not-abed (byte-identical prompts everywhere else): a line that leaves a rented
      // room has to get the player up first, or the turn narrates a trip their body never made.
      ...(isAtLodging(model) ? { abed: true } : {}),
      ...(activeCaseCtx ? { activeCase: activeCaseCtx } : {}),
      ...(knownAbsentNpcs.length > 0 ? { knownAbsentNpcs } : {}),
      ...(errandTargets.npcs.length > 0 || errandTargets.places.length > 0 ? { errandTargets } : {}),
      // The r8 situational flags. Same omit-when-absent discipline as `abed`: a turn with none of
      // these live renders a byte-identical user message, so the whole migration is invisible to
      // these live renders a byte-identical user message, so the migration is invisible to
      // ordinary play.
      ...(isCaptive(model) ? { captive: true } : {}),
      ...(isCombatActive(model) ? { inCombat: true } : {}),
      ...(this.routinesKnown() ? { routinesKnown: true } : {}),
      // Epistemic layer: only a world that authors `facts` earns the knowledgeAsk frame — every
      // fact-less fixture world keeps a byte-identical classifier prompt.
      ...((this.deps.playset.world.facts?.length ?? 0) > 0 ? { factsKnown: true } : {}),
      ...situational,
    };
  }

  /**
   * The spells the PC could acquire right now — the `learn` grounding. Three sources, all deduped by
   * (spell, source):
   *  - study : a level-up credit, offered only to a caster (already knows ≥1 spell), over the world
   *            spellbook they haven't learned and are high-enough level for.
   *  - trainer : each present NPC template's `teaches` entries not already known (tuition = costCoins).
   *  - scroll : each carried item whose `properties.teachesSpell` names a not-yet-known spell.
   * Bounded so the classifier prompt stays small.
   */
  private learnableSpellsHere(
    model: WorldModel,
    playerId: string,
    present: Entity[],
    known: Set<string>,
  ): ClassifierLearnRef[] {
    const out: ClassifierLearnRef[] = [];
    const seen = new Set<string>();
    const push = (ref: ClassifierLearnRef): void => {
      const key = `${ref.id}:${ref.source}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (out.length < 12) out.push(ref);
    };
    const spellName = (id: string): string | undefined => this.deps.playset.world.spells.find((s) => s.id === id)?.name;

    // Study — only a caster with an unspent credit picks freely from the world spellbook.
    const base = this.deps.playset.campaign.characters.find((c) => c.id === playerId)?.stats;
    if (base && known.size > 0) {
      const prog = progressionOf(model.modules, playerId, base.level);
      if (prog.credits > 0) {
        for (const spell of this.deps.playset.world.spells) {
          if (known.has(spell.id) || spell.level > prog.level) continue;
          push({ id: spell.id, name: spell.name, source: "study" });
        }
      }
    }

    // Trainers present here.
    for (const e of present) {
      const template = this.deps.playset.world.npcs.find((n) => n.id === (e.templateId ?? e.id));
      for (const t of template?.teaches ?? []) {
        if (known.has(t.spellId)) continue;
        const name = spellName(t.spellId);
        if (name) push({ id: t.spellId, name, source: "trainer", sourceId: e.id, costCoins: t.costCoins });
      }
    }

    // Scrolls / tomes in the pack.
    const player = model.entities.get(playerId);
    for (const itemId of player?.stats?.inventory ?? []) {
      const teaches = resolveItem(this.deps.playset.world, itemId)?.properties?.teachesSpell;
      if (typeof teaches !== "string" || known.has(teaches)) continue;
      const name = spellName(teaches);
      if (name) push({ id: teaches, name, source: "scroll", sourceId: itemId });
    }
    return out;
  }

  private locationInteractionsHere(loc: string): ClassifierInteractionRef[] {
    return (this.deps.playset.world.locations.find((l) => l.id === loc)?.interactions ?? [])
      .filter((i) => i.mode === "action")
      .map((i) => ({ id: i.id, label: this.interactionLabel(i), kind: i.kind }));
  }

  private interactionLabel(interaction: LocationInteraction): string {
    return interaction.label ?? interaction.id.replace(/[._-]+/g, " ");
  }

  /** Ids of companion NPCs (party-member NPCs with a standing agent slot). */
  private companionIds(model: WorldModel): string[] {
    const ids: string[] = [];
    for (const e of model.entities.values()) if (e.kind === "npc" && e.partyMember) ids.push(e.id);
    return ids;
  }

  /** Player input is priority A: reset every companion's reply-chain depth (silent write). */
  private resetReplyDepth(model: WorldModel): void {
    const autonomy = (model.modules.autonomy as Record<string, AutonomyRuntime> | undefined) ?? {};
    const patch: Record<string, AutonomyRuntime> = {};
    for (const id of this.companionIds(model)) {
      const a = autonomy[id];
      if (a && a.replyDepth !== 0) patch[id] = { ...a, replyDepth: 0 };
    }
    if (Object.keys(patch).length > 0) {
      this.applySilent({ type: "modulePatch", module: "autonomy", patch });
    }
  }

  /** Display name of a location id (frontier edges get a wanderer's label, else the id). */
  private locationName(id: string): string {
    if (isFrontierId(id)) return FRONTIER_FALLBACK_NAME;
    return this.deps.playset.world.locations.find((l) => l.id === id)?.name ?? id;
  }

  /** Display name of an actor id (PC or NPC) for summary lines; falls back to the id. */
  private actorName(id: string): string {
    const { world, campaign } = this.deps.playset;
    return (
      campaign.characters.find((c) => c.id === id)?.name ??
      world.npcs.find((n) => n.id === id)?.name ??
      id
    );
  }

  /**
   * This engine viewed through the narrow {@link EngineHost} contract — content + model + the two
   * write paths, and nothing else. Extracted domain resolvers take a host (or a `TickContext`, which
   * `hostOf` narrows to the same thing) instead of the whole engine, so what a resolver can reach is
   * stated rather than ambient. Built per call: it closes over `this`, so a model swapped by a
   * load/rewind is always the live one.
   */
  private host(): EngineHost {
    return {
      world: this.deps.playset.world,
      campaign: this.deps.playset.campaign,
      model: () => this.getModel(),
      apply: (cmd) => this.apply(cmd),
      emit: (ev) => this.emit(ev),
    };
  }

  private emit(event: EmittedEvent): void {
    // Witness scoping (r4): stamp scene-carrying kinds with who was AT the party's location when
    // the event fired, so NPC briefs can later drop rows the NPC never witnessed. Best-effort and
    // additive — no model yet (opening narration) or an already-stamped event passes through, and
    // unstamped rows are fail-open (treated as witnessed) at read time.
    if (
      this.model &&
      (event.kind === "narration" || event.kind === "dialogue" || event.kind === "stateChanged") &&
      event.presentIds === undefined
    ) {
      const loc = partyLocationOf(this.model);
      if (loc !== null) {
        event = { ...event, presentIds: entitiesAt(this.model, loc).map((e) => e.id) };
      }
    }
    const full = this.bus.stamp(event);
    if (this.eventBatch) {
      this.eventBatch.events.push(full);
      return;
    }
    if (this.isDurableEvent(full)) this.pendingEvents.push(full);
    try {
      this.bus.publish(full);
    } catch {
      // Observation-only custom buses cannot invalidate an otherwise pending authoritative event.
    }
  }

  private emitSilent(event: EmittedEvent): void {
    const full = { ...this.bus.stamp(event), silent: true };
    if (this.eventBatch) {
      this.eventBatch.events.push(full);
      return;
    }
    this.pendingEvents.push(full);
  }

  private openingNarration(): string | null {
    const { campaign } = this.deps.playset;
    const scene = campaign.scenes.find((s) => s.id === campaign.startingState.openingSceneId);
    return scene?.setup ?? null;
  }

  private initialState(): GameState {
    const { world, campaign } = this.deps.playset;
    const start = campaign.startingState;

    const actors: Record<string, ActorRuntime> = {};
    for (const pc of campaign.characters) {
      if (!start.party.includes(pc.id)) continue;
      actors[pc.id] = {
        id: pc.id,
        currentHp: pc.stats.maxHp,
        locationId: start.locationId,
        inventory: [...pc.inventory],
        conditions: [],
        // Spread-in so a coinless character stays keyless (pre-economy saves stay byte-stable).
        ...(pc.coins !== undefined ? { coins: pc.coins } : {}),
      };
    }

    const autonomy: GameState["autonomy"] = {};
    const relationships: GameState["relationships"] = {};
    for (const template of world.npcs) {
      if (Object.keys(template.relationships).length > 0) relationships[template.id] = { ...template.relationships };
    }
    for (const npcId of start.companions) {
      const template = world.npcs.find((n) => n.id === npcId);
      actors[npcId] = {
        id: npcId,
        currentHp: template?.stats?.maxHp ?? 10,
        locationId: start.locationId,
        // An authored sidearm/kit travels with the companion (templates default to []).
        inventory: [...(template?.inventory ?? [])],
        conditions: [],
      };
      autonomy[npcId] = { talking: false, replyDepth: 0, lastActedAt: 0 };
    }

    const quests: GameState["quests"] = {};
    for (const quest of campaign.quests) quests[quest.id] = quest.state;

    return {
      campaignId: campaign.id,
      worldId: world.id,
      partyLocationId: start.locationId,
      clock: start.clock ?? 0,
      party: [...start.party],
      companions: [...start.companions],
      actors,
      quests,
      relationships,
      autonomy,
      flags: {},
    };
  }
}

/**
 * Render one persisted event to a transcript line for the rolling-summary fold (mirrors
 * `context.ts` `transcript()`). `includeDice` distinguishes the two fold inputs: `batchLines` (the
 * model's raw material, dice included) pass `true`; `digestLines` (the deterministic floor's de-
 * noised material — narration/dialogue/state changes only) pass `false`. Non-renderable kinds
 * (system/delta/npcProposal) return `null` and are filtered out.
 */
function renderEventLine(e: GameEvent, nameOf: (id: string) => string, includeDice: boolean): string | null {
  switch (e.kind) {
    case "narration":
      return `GM: ${e.text}`;
    case "dialogue":
      // Private asides (Phase 6) never enter the shared rolling summary: `# STORY SO FAR` feeds
      // every public brief, so folding a whisper here would leak it to the table.
      if (e.channel === "private") return null;
      return `${nameOf(e.actorId)}: ${e.text}`;
    case "stateChanged":
      return `[*] ${e.summary}`;
    case "diceRolled": {
      if (!includeDice) return null;
      const verdict = e.success === undefined ? "" : e.success ? " SUCCESS" : " FAILURE";
      return `[roll] ${e.purpose ?? e.notation} → ${e.total}${verdict}`;
    }
    default:
      return null; // system/npcProposal/delta are noise here
  }
}
