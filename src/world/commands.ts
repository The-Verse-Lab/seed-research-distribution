/**
 * Command — the intent vocabulary of the single mutation chokepoint.
 *
 * Every change to the WorldModel is expressed as a Command and applied by the reducer
 * (src/world/reducer.ts), which is the only writer. Narration/dialogue/dice are NOT commands
 * (they don't mutate truth) and remain plain emitted events. Intent enters as a TurnPlan
 * (src/engine/classify.ts) or an autonomy grounding (src/modules/autonomy/grounding.ts), both
 * of which resolve to Command(s) here.
 *
 * @author Runkai Zhang
 */
import type { Location, NpcTemplate } from "../content/schema.ts";
import type { EntityKind, EntityTier, EquipSlot } from "./entity.ts";
import type { QuestState } from "./model.ts";
import type { ExitRuntimeState } from "../rules/exit-state.ts";
import type { NpcMemoryEntry } from "../rules/npc-memory.ts";
import type { LearnedCertainty, LearnedSourceKind } from "../rules/npc-knowledge.ts";
import type { CaptivityKind } from "../rules/captivity.ts";
import type { StatusEffect } from "../rules/status-effects.ts";
import type { WardrobeSlotState } from "../rules/wardrobe.ts";
import type { CaseClaim, CaseStatus } from "../rules/cases.ts";
import type { ExchangeRecord, ServiceAgreement } from "../rules/exchange.ts";
import type { Deal, DealState } from "../rules/deals.ts";

/** What a spawnEntity command needs to create a registry row. */
export interface SpawnSpec {
  id: string;
  kind: EntityKind;
  tier: EntityTier;
  name: string;
  locationId: string | null;
  templateId?: string;
  stats?: {
    currentHp: number;
    maxHp: number;
    conditions?: string[];
    inventory?: string[];
    coins?: number;
    energy?: number;
    maxEnergy?: number;
    exhaustion?: number;
  };
}

/**
 * A brand-new EMERGENT town minted by pure-wander expansion — a settlement NOT in the gazetteer,
 * discovered where the party wandered to (src/world/expansion.ts). `id` is the terminal room's
 * location id. Rides the `expandWorld` command / `worldExpanded` delta / expansion slice as an
 * optional passenger so the road network can find it read-side; additive, so no new delta kind.
 */
export interface EmergentTown {
  id: string;
  name: string;
  kind: "town" | "city";
}

export type Command =
  | { type: "moveEntity"; entityId: string; to: string; teleport?: boolean }
  | { type: "moveParty"; to: string; solo?: boolean; teleport?: boolean }
  | { type: "spawnEntity"; entity: SpawnSpec }
  | { type: "despawnEntity"; entityId: string }
  | { type: "setEntityTier"; entityId: string; tier: EntityTier }
  | { type: "adjustHp"; entityId: string; by: number }
  | { type: "setCondition"; entityId: string; condition: string; active: boolean }
  | { type: "transferItem"; itemId: string; from: string | null; to: string | null }
  // --- Items & economy (Phase 1). Coins are integer copper pieces clamped at 0; the matching
  //     delta carries the ABSOLUTE post-balance so replay folds idempotently. `equipItem` with a
  //     null itemId unequips the slot; the reducer checks possession (content is out of its reach —
  //     slot FIT is the enqueuer's gate, `itemFitsSlot` in src/rules/items.ts) and its delta
  //     carries the ABSOLUTE post-change slot record. ---
  | { type: "adjustCoins"; entityId: string; by: number }
  | { type: "equipItem"; entityId: string; slot: EquipSlot; itemId: string | null }
  // --- Trade (Phase 1 follow-up). ONE atomic vendor exchange: move `itemId` between the PC and the
  //     vendor and adjust the PC's coins by `priceCp`, in a single reducer step so no half-state
  //     (coins-without-item, item-without-coins) can ever exist. The engine holds the world content
  //     the reducer can't see, so it computes the price (`tradePriceCp`, src/rules/items.ts) and
  //     passes the absolute `priceCp` in — exactly like `linkExit` passes the display `name`. The
  //     reducer validates possession on the correct side and affordability on a buy, then emits the
  //     ordinary `itemTransferred` + `coinsChanged` (ABSOLUTE post-balance) deltas so replay folds
  //     idempotently. Vendors keep a bottomless purse by design (only STOCK is real), so the
  //     vendor's coins are untouched. ---
  | { type: "tradeWith"; pcId: string; vendorId: string; itemId: string; direction: "buy" | "sell"; priceCp: number }
  // --- Traversal & energy (Workstream H). `setExitState` writes the mutable exit-state overlay
  //     (`model.modules.exitState`) for the directed exit locationId→to and MIRRORS the change
  //     onto the reverse exit when one exists (a door is one object seen from two sides); each
  //     changed direction rides its own absolute delta, so replay folds verbatim. `adjustEnergy`
  //     follows `adjustCoins`: integer, clamped [0, maxEnergy], absolute post-value delta. Absent
  //     energy fields read as FULL (pre-energy saves wake rested — src/rules/costs.ts).
  //     `adjustExhaustion` is the persistent ladder paired with energy: integer, clamped [0,6],
  //     and omitted old fields read as 0 (fresh). ---
  | { type: "setExitState"; locationId: string; to: string; state: ExitRuntimeState }
  | { type: "adjustEnergy"; entityId: string; by: number }
  | { type: "adjustExhaustion"; entityId: string; by: number }
  | { type: "adjustRelationship"; actorId: string; targetId: string; by: number }
  // Player↔faction standing (living faction system). `pcId` holds the standing toward `factionId`
  // (−100..100). Ally/enemy bleed through the authored faction matrix is expanded at the call site
  // into further commands of this same type (`src/rules/factions.ts`); the reducer stays content-free.
  | { type: "adjustFactionStanding"; pcId: string; factionId: string; by: number }
  // --- Character progression. `grantXp` folds experience into the persisted `progression` slice,
  //     cascading level-ups (each grants +HP to max & current and a study credit) atomically; it
  //     emits modulePatched (the slice) plus an hpChanged when a level-up raises HP — no new delta
  //     kind. `learnSpell` unions a spell into the earned list. `baseLevel` seeds the slice from the
  //     authored StatBlock level on the first grant (the reducer is content-free otherwise). ---
  | { type: "grantXp"; entityId: string; by: number; baseLevel: number }
  | { type: "learnSpell"; entityId: string; spellId: string; baseLevel: number; spendCredit?: boolean }
  | { type: "setQuestState"; questId: string; state: QuestState }
  | { type: "setObjectiveDone"; questId: string; objectiveId: string; done: boolean }
  | { type: "advanceClock"; by: number }
  | { type: "setFlag"; scope: "world" | "entity"; entityId?: string; key: string; value: unknown }
  | { type: "modulePatch"; module: string; patch: Record<string, unknown> }
  // --- Automatic wardrobe coverage. Scene/captivity writers use this typed path so their strips
  //     can only ESCALATE each coverage slot. Manual dress actions and explicit lifecycle resets
  //     deliberately keep using modulePatch because they are legitimate de-escalations. ---
  | { type: "escalateWardrobeCoverage"; entityId: string; state: WardrobeSlotState }
  // --- Status effects. Temporary mechanical effects live in `modules.statusEffects` and mirror
  //     their display tag into `entity.stats.conditions[]`. Compound command; emits only
  //     conditionChanged + modulePatched, so no new delta kind is needed. ---
  | { type: "applyStatusEffect"; entityId: string; effect: StatusEffect }
  // --- NPC memory (M4 Part B). The module ENQUEUES these; only the reducer writes the slice. The
  //     record carries ONE entry to append — the reducer applies the cap and the matching delta
  //     carries the resulting ABSOLUTE journal so replay folds idempotently (cap logic stays in the
  //     reducer alone). ---
  | { type: "recordNpcMemory"; npcId: string; entry: NpcMemoryEntry }
  | { type: "clearNpcMemory"; npcId: string }
  // --- Learned knowledge (epistemic plan §7.6). Code-owned hooks ENQUEUE this when an NPC
  //     witnesses a canonical fact being revealed/spoken; only the reducer writes the slice.
  //     Re-learning a known fact only ever RAISES certainty (never downgrades ⇒ noop). The
  //     matching delta carries the NPC's ABSOLUTE post-cap learned map, so replay folds
  //     idempotently and a rewind discards exactly the discarded tail's learning. ---
  | {
      type: "learnFact";
      npcId: string;
      factId: string;
      certainty: LearnedCertainty;
      sourceKind: LearnedSourceKind;
      sourceId?: string;
    }
  // --- Captivity (bad-end follow-up). TWO COMPOUND, ATOMIC commands the reducer expands into a
  //     sequence of EXISTING sub-commands (moveEntity/transferItem/setPartyMembership/setEntityTier/
  //     setCondition/modulePatch), so they emit ONLY existing deltas — the delta vocabulary + replay
  //     fold are untouched (no new delta kind, replay-safe by reuse). `beginCaptivity` reads live state
  //     the outcome table can't (the PC's gear to confiscate, the party to scatter) — which is why it
  //     must be one compound command, not a static effect list (the defeat transaction preflights each
  //     effect independently). The per-turn loop advance rides the generic `modulePatch`; only begin/end
  //     are typed. `kind` selects the tuned term/DC (src/rules/captivity.ts CAPTIVITY_CONFIG). ---
  | { type: "beginCaptivity"; pcId: string; captorId: string | null; kind: CaptivityKind }
  | { type: "endCaptivity"; outcome: "escaped" | "served" | "freed" }
  // --- Party (Phase 2, Stage A). Membership stays the `Entity.partyMember` flag; leadership +
  //     denied-leave bookkeeping live in the `model.modules.party` slice. Each matching delta
  //     carries the ABSOLUTE post-state slice so replay folds idempotently. Membership is
  //     mechanically NEUTRAL: no disposition bonus or personality rewrite. ---
  | { type: "setPartyMembership"; entityId: string; member: boolean }
  | { type: "setPartyLeader"; entityId: string | null }
  | { type: "recordLeaveDenied"; entityId: string; deniedAtSeq?: number }
  // --- NPC enrichment (Phase 2, Stage B). Promotes a runtime NPC to a permanent fixture: the
  //     payload carries the FULL composed template (any LLM prose already merged module-side —
  //     src/modules/party/enrich.ts), so the matching `npcEnriched` delta replays verbatim and
  //     LLM-free (the `expandWorld` pattern). The reducer records it in the `enrichment` slice,
  //     sets the entity's templateId (if unset), and promotes the tier to "significant" via an
  //     accompanying `tierChanged` delta. Enrichment is mechanically NEUTRAL like membership:
  //     personality/morality are composed from what the NPC already appears to be, never
  //     softened toward friendliness. `promote: false` records the template WITHOUT the tier
  //     promotion — the first-observation profile path (Workstream A): identity binds at first
  //     sight while the NPC stays transient/culled like any bystander. ---
  | { type: "enrichNpc"; npcId: string; template: NpcTemplate; promote?: boolean }
  // --- Combat (M3). The module will enqueue these in Phase 3; Phase 2 owns only the SSOT spine.
  //     Deltas carry the FULL post-state encounter so replay overwrites verbatim. ---
  | { type: "startCombat"; locationId: string; order: string[]; allies?: string[]; turnIndex?: number; round?: number }
  //     Add a combatant to a LIVE encounter (r5). `ally` marks them as fighting on the party's
  //     side; without it `sideOf` would read a non-member as a foe. Inserted AFTER the current
  //     turn so no one is silently granted or skipped a turn.
  | { type: "joinCombat"; entityId: string; ally: boolean }
  | { type: "advanceTurn" }
  | { type: "endCombat" }
  // --- World expansion (explore-time generation). The payload carries the FULL generated
  //     locations, so the matching delta replays verbatim (LLM-free, but non-determinism-safe
  //     either way). `viaExitTo` names the consumed `frontier:` exit on `fromLocationId`.
  //     `realizedGazetteerId` (Phase 4, additive) links the pocket's terminal room to the
  //     gazetteer entry it realizes; the reducer records it in the `expansion` slice. ---
  | {
      type: "expandWorld";
      fromLocationId: string;
      viaExitTo: string;
      locations: Location[];
      realizedGazetteerId?: string;
      /** A surprise settlement this pocket minted (not in the gazetteer). Additive; recorded in the
       *  expansion slice by the reducer so the road network can find it. */
      emergentTown?: EmergentTown;
    }
  // --- Open-world REUSE (explore-time). Wire a discovered direct exit from `fromLocationId` into an
  //     EXISTING location `to` ("go back to the tavern") — no new content, no duplicate place. The
  //     enqueuer (the engine, which holds the world content the reducer can't see) passes the target
  //     `name`; the matching `exitLinked` delta carries it so replay reconstructs the edge verbatim,
  //     and the edge is recorded in the durable `expansion` slice (`links`) so it survives a reload
  //     (hydrate re-derives the same label from the target's name). Idempotent — a second link to the
  //     same target is a noop. ---
  | { type: "linkExit"; fromLocationId: string; to: string; name: string }
  // --- Mystery / collaborative deduction (the cases layer). Epistemic state is CODE-OWNED: who knows
  //     which case fact lives in `modules.cases` and is mutated ONLY here (the LLM phrases, never
  //     bookkeeps). Every writer is idempotent + clamped and emits the generic `modulePatched` delta
  //     carrying the ABSOLUTE post-state per-case runtime, so replay folds verbatim (no new delta kind
  //     — the progression-slice precedent). `revealCaseFact`/`resolveCase` also join the continuity +
  //     turn-fact command sets so the narrator sees and defends what the player just learned. ---
  //     A clue reaches the player: add `factId` to `playerKnown` AND to each present `witnesses` NPC's
  //     `learned` (limited perception — an NPC learns only by witnessing/being told). `factText` rides
  //     the command for the turn-fact line (content stays out of the reducer's reach).
  | { type: "revealCaseFact"; caseId: string; factId: string; factText: string; witnesses: string[] }
  //     An NPC learns a single fact off-screen path (another NPC voiced it, testimony machinery).
  | { type: "npcLearnCaseFact"; caseId: string; npcId: string; factId: string }
  //     A witnessed refutation overturns a believed red herring (the cases TickModule enqueues this).
  | { type: "npcDropCaseBelief"; caseId: string; npcId: string; beliefId: string }
  //     Record that an NPC has voiced a fact to the party (proactive-share dedup + cooldown clock).
  | { type: "markCaseFactShared"; caseId: string; npcId: string; factId: string }
  //     Append one player claim to the bounded lie/credibility ledger (cap applied in the reducer).
  | { type: "recordCaseClaim"; caseId: string; claim: CaseClaim }
  //     Nudge the player's credibility with one NPC (clamped to [-5, 5]).
  | { type: "adjustCaseCredibility"; caseId: string; npcId: string; by: number }
  //     Close a case (solved | failed) — flips the terminal status; the engine pairs it with the
  //     quest-completion command on a proven accusation (Phase 4).
  | { type: "resolveCase"; caseId: string; status: CaseStatus }
  //     Spend one wrong-accusation from the budget (returns the incremented count via its delta).
  | { type: "recordWrongAccusation"; caseId: string }
  //     Record that the player REFUSED to show this NPC these facts (r5). Bounded; cleared for that
  //     NPC the moment they learn anything from the player, so a refusal is never permanent.
  | { type: "recordCaseWithhold"; caseId: string; npcId: string; factIds: string[] }
  // --- Exchanges & services (r8, the dealings ledger). `recordExchange` appends one executed
  //     receipt to the bounded `modules.exchanges` slice (cap applied in the reducer; the delta
  //     carries the ABSOLUTE post-append slice — the journey-log precedent) so narrator + NPC
  //     briefs can refer back to what actually changed hands. It moves no goods itself — the
  //     commands that DID (tradeWith/transferItem/adjustCoins) run first. `serviceBegin` is one
  //     ATOMIC strike of a service deal: charge the fee, take the item into the NPC's custody when
  //     the work keeps it (via the ordinary transfer/coin deltas), and append the agreement;
  //     `serviceComplete` returns the custody item and marks the agreement done. Fees/dues are
  //     computed by the enqueuer (content is out of the reducer's reach). ---
  | { type: "recordExchange"; record: Omit<ExchangeRecord, "id"> }
  | { type: "serviceBegin"; pcId: string; agreement: ServiceAgreement }
  | { type: "serviceComplete"; agreementId: string }
  // --- Deals (§2.2, the standing-agreement ledger). `recordDeal` appends one struck agreement to
  //     the bounded `modules.deals` slice; an equivalent OPEN deal between the same parties is a
  //     no-op, because a two-turn haggle settles the same bargain twice and must mint one row.
  //     `setDealState` closes one (honoured/broken) and stamps the clock. Both emit the ABSOLUTE
  //     post-state as `modulePatched` (the recordExchange precedent). Capture + visibility only:
  //     the reducer never JUDGES whether terms were met — the classifier reports what the fiction
  //     said, and code owns the row. ---
  | { type: "recordDeal"; deal: Omit<Deal, "id"> }
  | { type: "setDealState"; dealId: number; state: DealState; atClock: number };

export type CommandType = Command["type"];

/**
 * The compile-time union erases at runtime, but content validation (authored defeat-outcome effects)
 * needs an ENUMERABLE set of the valid `type`s. This record is the single hand-kept mirror; the
 * `Record<CommandType, true>` type makes `tsc` fail the moment a new command is added to the union
 * without a matching key here (or a stale key lingers), so the set below can never silently drift.
 */
const COMMAND_TYPE_TABLE: Record<CommandType, true> = {
  moveEntity: true,
  moveParty: true,
  spawnEntity: true,
  despawnEntity: true,
  setEntityTier: true,
  adjustHp: true,
  setCondition: true,
  transferItem: true,
  adjustCoins: true,
  equipItem: true,
  tradeWith: true,
  setExitState: true,
  adjustEnergy: true,
  adjustExhaustion: true,
  adjustRelationship: true,
  adjustFactionStanding: true,
  grantXp: true,
  learnSpell: true,
  setQuestState: true,
  setObjectiveDone: true,
  advanceClock: true,
  setFlag: true,
  modulePatch: true,
  escalateWardrobeCoverage: true,
  applyStatusEffect: true,
  recordNpcMemory: true,
  clearNpcMemory: true,
  learnFact: true,
  beginCaptivity: true,
  endCaptivity: true,
  setPartyMembership: true,
  setPartyLeader: true,
  recordLeaveDenied: true,
  enrichNpc: true,
  startCombat: true,
  joinCombat: true,
  advanceTurn: true,
  endCombat: true,
  expandWorld: true,
  linkExit: true,
  revealCaseFact: true,
  npcLearnCaseFact: true,
  npcDropCaseBelief: true,
  markCaseFactShared: true,
  recordCaseClaim: true,
  adjustCaseCredibility: true,
  resolveCase: true,
  recordWrongAccusation: true,
  recordCaseWithhold: true,
  recordExchange: true,
  serviceBegin: true,
  serviceComplete: true,
  recordDeal: true,
  setDealState: true,
};

/** Every valid Command `type`, for validating data-driven effects at content-load / preflight time. */
export const COMMAND_TYPES: ReadonlySet<CommandType> = new Set(
  Object.keys(COMMAND_TYPE_TABLE) as CommandType[],
);
