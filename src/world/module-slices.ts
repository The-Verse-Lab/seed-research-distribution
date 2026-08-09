/**
 * Module-slice accessors — the typed, defaulting views onto `WorldModel.modules[*]` shared by the
 * reducer (the writer, `applyCommand`) and replay (the fold, `applyDelta`).
 *
 * Centralized here so each module's slice shape + default list live in exactly one place: any drift
 * between how `applyCommand` and `applyDelta` default a slice would silently break the
 * `snapshot == fold(deltas)` invariant, so the two MUST default identically. Previously both files
 * carried byte-identical private copies of these helpers — this is the single source.
 *
 * @author Runkai Zhang
 */
import { defaultExitStateSlice, type ExitStateSlice } from "../rules/exit-state.ts";
import { defaultNpcKnowledgeSlice, type NpcKnowledgeSlice } from "../rules/npc-knowledge.ts";
import { defaultNpcMemorySlice, type NpcMemorySlice } from "../rules/npc-memory.ts";
import { clonePartySlice, defaultPartySlice, type PartySlice } from "../rules/party.ts";
import { cloneCombatEncounter, defaultCombatEncounter, type CombatEncounter } from "../rules/combat-state.ts";
import { defaultStatusEffectSlice, type StatusEffectSlice } from "../rules/status-effects.ts";
import { CASES_MODULE, type CasesSlice } from "../rules/cases.ts";
import { DEALS_MODULE, defaultDealsSlice, type DealsSlice } from "../rules/deals.ts";
import {
  EXCHANGES_MODULE,
  SERVICES_MODULE,
  defaultExchangesSlice,
  defaultServicesSlice,
  type ExchangesSlice,
  type ServicesSlice,
} from "../rules/exchange.ts";
import type { WorldModel } from "./model.ts";

/** A generic untyped module slice, created empty on first touch (objectives, the generic patch). */
export function moduleSlice(model: WorldModel, name: string): Record<string, unknown> {
  let slice = model.modules[name] as Record<string, unknown> | undefined;
  if (!slice) {
    slice = {};
    model.modules[name] = slice;
  }
  return slice;
}

/**
 * The typed cases slice (mystery wave), created empty on first touch and stored back on the model.
 * Returns the LIVE record — the reducer replaces whole per-case runtimes in place. Per-case defaults
 * live in `caseRuntimeOf` (rules/cases.ts); this only guarantees the top-level record exists. Replay
 * defaults it identically via the generic `modulePatched` fold (the patch carries absolute runtimes),
 * so the two agree and the `snapshot == fold(deltas)` invariant holds.
 */
export function casesSlice(model: WorldModel): CasesSlice {
  const slice = (model.modules[CASES_MODULE] as CasesSlice | undefined) ?? {};
  model.modules[CASES_MODULE] = slice;
  return slice;
}

/**
 * The typed exchanges slice (r8, the dealings ledger), created + fully defaulted on first touch
 * and stored back on the model. Returns the LIVE slice — the reducer mutates it in place and
 * emits the ABSOLUTE post-state via the generic `modulePatched` delta, so replay folds verbatim.
 */
export function exchangesSlice(model: WorldModel): ExchangesSlice {
  const existing = model.modules[EXCHANGES_MODULE] as Partial<ExchangesSlice> | undefined;
  const d = defaultExchangesSlice();
  const slice: ExchangesSlice = {
    records: existing?.records ?? d.records,
    nextId: existing?.nextId ?? d.nextId,
  };
  model.modules[EXCHANGES_MODULE] = slice;
  return slice;
}

/**
 * The typed deals slice (§2.2, the standing-agreement ledger), created + fully defaulted on first
 * touch and stored back on the model. Same live-slice + modulePatched replay discipline as exchanges.
 */
export function dealsSlice(model: WorldModel): DealsSlice {
  const existing = model.modules[DEALS_MODULE] as Partial<DealsSlice> | undefined;
  const d = defaultDealsSlice();
  const slice: DealsSlice = {
    records: existing?.records ?? d.records,
    nextId: existing?.nextId ?? d.nextId,
  };
  model.modules[DEALS_MODULE] = slice;
  return slice;
}

/**
 * The typed services slice (r8, struck service agreements + custody), created + fully defaulted
 * on first touch and stored back on the model. Same modulePatched replay discipline as exchanges.
 */
export function servicesSlice(model: WorldModel): ServicesSlice {
  const existing = model.modules[SERVICES_MODULE] as Partial<ServicesSlice> | undefined;
  const d = defaultServicesSlice();
  const slice: ServicesSlice = {
    agreements: existing?.agreements ?? d.agreements,
  };
  model.modules[SERVICES_MODULE] = slice;
  return slice;
}

/**
 * The typed per-NPC memory slice (M4 Part B), created + fully defaulted on first touch and stored
 * back on the model. Returns the LIVE slice — the reducer/replay mutate it in place; existing
 * per-NPC journal arrays keep their identity. The literal is checked against {@link NpcMemorySlice},
 * so a new field forces an update both here AND in `readNpcMemory` (no silent fold divergence — the
 * single-source rule in this file's header).
 */
export function npcMemorySlice(model: WorldModel): NpcMemorySlice {
  const existing = model.modules.npcMemory as Partial<NpcMemorySlice> | undefined;
  const d = defaultNpcMemorySlice();
  const slice: NpcMemorySlice = {
    entries: existing?.entries ?? d.entries,
  };
  model.modules.npcMemory = slice;
  return slice;
}

/**
 * The typed learned-knowledge slice (epistemic plan §7.6), created + fully defaulted on first
 * touch and stored back on the model. Same live-slice contract as {@link npcMemorySlice}; the
 * literal is checked against {@link NpcKnowledgeSlice} so a new field forces an update here AND
 * in `readLearnedFacts` (no silent fold divergence).
 */
export function npcKnowledgeSlice(model: WorldModel): NpcKnowledgeSlice {
  const existing = model.modules.npcKnowledge as Partial<NpcKnowledgeSlice> | undefined;
  const d = defaultNpcKnowledgeSlice();
  const slice: NpcKnowledgeSlice = {
    learned: existing?.learned ?? d.learned,
  };
  model.modules.npcKnowledge = slice;
  return slice;
}

/**
 * The typed party slice (Phase 2), created + fully defaulted on first touch and stored back on
 * the model. Returns the LIVE slice — the reducer/replay mutate it in place; an existing
 * `pendingLeave` record keeps its identity. The literal is checked against {@link PartySlice}, so
 * a new field forces an update both here AND in every reader (no silent fold divergence — the
 * single-source rule in this file's header). A `leaderId` of null means the PC leads by default.
 */
export function partySlice(model: WorldModel): PartySlice {
  const existing = model.modules.party as Partial<PartySlice> | undefined;
  const d = defaultPartySlice();
  const slice: PartySlice = {
    leaderId: existing?.leaderId ?? d.leaderId,
    pendingLeave: existing?.pendingLeave ?? d.pendingLeave,
  };
  model.modules.party = slice;
  return slice;
}

/**
 * Overwrite the party slice with an absolute post-state — the SINGLE writer shared by the reducer
 * (command application) and replay (delta fold), so the two cannot drift and silently break
 * `snapshot == fold(deltas)`. Mutates the live slice in place and returns it.
 */
export function overwritePartySlice(model: WorldModel, next: PartySlice): PartySlice {
  const slice = partySlice(model);
  const clean = clonePartySlice(next);
  slice.leaderId = clean.leaderId;
  slice.pendingLeave = clean.pendingLeave;
  return slice;
}

/**
 * The typed exit-state overlay slice (Workstream H), created + fully defaulted on first touch
 * and stored back on the model. Returns the LIVE slice — the reducer/replay mutate it in place;
 * an existing `states` record keeps its identity. The literal is checked against
 * {@link ExitStateSlice}, so a new field forces an update both here AND in every reader (no
 * silent fold divergence — the single-source rule in this file's header).
 */
export function exitStateSlice(model: WorldModel): ExitStateSlice {
  const existing = model.modules.exitState as Partial<ExitStateSlice> | undefined;
  const d = defaultExitStateSlice();
  const slice: ExitStateSlice = {
    states: existing?.states ?? d.states,
  };
  model.modules.exitState = slice;
  return slice;
}

/**
 * The typed combat slice (M3), created + fully defaulted on first touch and stored back on the
 * model. Returns the LIVE slice — the reducer/replay mutate it in place; the `order` array present
 * on an existing slice keeps its identity. The literal is checked against {@link CombatEncounter},
 * so a new field forces an update here and in any read-only combat query.
 */
export function combatSlice(model: WorldModel): CombatEncounter {
  const existing = model.modules.combat as Partial<CombatEncounter> | undefined;
  const d = defaultCombatEncounter();
  const slice: CombatEncounter = {
    active: existing?.active ?? d.active,
    locationId: existing?.locationId ?? d.locationId,
    order: existing?.order ?? d.order,
    // Defaulted, so a save written before allies existed (and every 5-key test literal) reads clean.
    allies: existing?.allies ?? d.allies,
    turnIndex: existing?.turnIndex ?? d.turnIndex,
    round: existing?.round ?? d.round,
  };
  model.modules.combat = slice;
  return slice;
}

/**
 * The typed status-effect slice, created + fully defaulted on first touch and stored back on the
 * model. Returns the LIVE slice; callers that emit a `modulePatch` should clone after mutation so
 * replay overwrites the same absolute post-state.
 */
export function statusEffectSlice(model: WorldModel): StatusEffectSlice {
  const existing = model.modules.statusEffects as Partial<StatusEffectSlice> | undefined;
  const d = defaultStatusEffectSlice();
  const slice: StatusEffectSlice = {
    active: existing?.active ?? d.active,
  };
  model.modules.statusEffects = slice;
  return slice;
}

/**
 * Overwrite the combat slice with an absolute post-state encounter — the SINGLE writer shared by
 * the reducer (command application) and replay (delta fold), so the two cannot drift and silently
 * break `snapshot == fold(deltas)` (the trap this file's header warns about). Mutates the live
 * slice in place and returns it.
 */
export function overwriteCombatSlice(model: WorldModel, encounter: CombatEncounter): CombatEncounter {
  const slice = combatSlice(model);
  const next = cloneCombatEncounter(encounter);
  slice.active = next.active;
  slice.locationId = next.locationId;
  slice.order = next.order;
  slice.allies = next.allies;
  slice.turnIndex = next.turnIndex;
  slice.round = next.round;
  return slice;
}
