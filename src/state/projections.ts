/**
 * Read-only projections over a `GameState` snapshot.
 *
 * Pure derivations — captivity, standing deals, cases, work on offer, the recruitment board, and the
 * present-cast detail rows. They read the snapshot and return player-safe shapes; nothing here
 * mutates, and nothing here belongs to a particular client. The headless research build and its
 * specs use these as one honest way to read what a turn did.
 *
 * @author Runkai Zhang
 */

import type { GameState } from "./types.ts";
import type { PlaySet, Work } from "../content/schema.ts";
import { CAPTIVITY_CONFIG, captivityActionButtons, type CaptivitySlice } from "../rules/captivity.ts";
import { readCasesSlice } from "../rules/cases.ts";
import { openDeals, readDealsSlice } from "../rules/deals.ts";
import { dayPhaseOf } from "../agents/context.ts";
import { fromGameState } from "../world/model.ts";
import { workRequiresMet } from "../rules/work-gate.ts";
import { composeNpcTemplate } from "../modules/party/enrich.ts";
import { readRecruitBoardSlice, recruitDayOf, recruitOfferId, seededMercName } from "../rules/recruit.ts";
import type { Entity } from "../world/entity.ts";

// --- Read-only projected shapes. ---

/** One player-established case fact (mystery wave) — read-only evidence-log row. Never a GM truth or an
 *  unrevealed fact: only ids already in the case's `playerKnown`. */
export interface CaseFactRef {
  id: string;
  text: string;
  /** motive | means | opportunity | timeline | physical | testimony — the evidentiary axis. */
  kind: string;
  /** True for a core fact (one an accusation can require as proof). */
  core: boolean;
}

/** A hireable mercenary on a hall's recruit board — a generated sellsword-for-coin. */
export interface MercOfferRef {
  offerId: string;
  name: string;
  /** A one-line read on the sellsword (seeded persona blurb). */
  summary: string;
  hireCp: number;
  /** Per-day wage owed once hired (the upkeep cost). */
  wageCp: number;
  affordable: boolean;
}

/** A present NPC the player can recruit into THEIR party (existing invite flow) — id + label. */
export interface RecruitCandidateRef {
  id: string;
  name: string;
}

/** A present NPC LEADER whose party the player can sign ONTO (become a follower). */
export interface JoinableLeaderRef {
  id: string;
  name: string;
  summary?: string;
}

/** One available captivity action (labor/escape/endure). Its label can round-trip through the
 * ordinary text input path, while its id can be submitted as a typed grounded action. */
export interface CaptivityActionButtonRef {
  id: string;
  label: string;
  hint: string;
}

/**
 * The live captivity hold as a read-only projection; null unless the player is held. Player-safe by
 * construction: the kind, captor name, day/progress/escape-DC gauges, and action menu, never raw
 * prose. This adds no new mutation surface.
 */
export interface CaptivityScene {
  /** The bad-end kind (gaol/debt-bondage/lair/ransom). */
  kind: string;
  /** Who holds you (a jailer or beast). */
  captorName: string;
  /** The place noun ("the holding cell"). */
  place: string;
  /** The captivity day counter. */
  day: number;
  /** Progress toward serving the term out. */
  progress: number;
  /** Progress needed for automatic release. */
  goal: number;
  /** The CURRENT escape-check DC (labour wears it down; a failed run stiffens it). */
  escapeDc: number;
  /** The ordered action buttons (Labor / Attempt escape / Endure). */
  actions: CaptivityActionButtonRef[];
}

/**
 * A hand-authored mystery as a read-only case view (mystery wave). Carries ONLY
 * player-safe content: the facts the player has established, the persons of interest they've met, and
 * the accusation budget — never the GM-only solution, unrevealed facts, or NPC belief state.
 */
export interface CaseRef {
  id: string;
  name: string;
  /** "open" | "solved" | "failed". */
  state: string;
  /** Facts the PLAYER has established so far (the evidence board). */
  knownFacts: CaseFactRef[];
  /** Persons of interest the player has MET (case cast ∩ known entities) — display names, id-keyed. */
  suspects: { id: string; name: string }[];
  /** Wrong accusations spent so far and the budget before the case is lost. */
  wrongAccusations: number;
  maxWrongAccusations: number;
}

/**
 * A standing agreement for the read-only deals view (§2.2) — struck and not yet closed, in the
 * terms the fiction settled on. Player-safe by construction: the row is the player's own bargain.
 */
export interface DealRef {
  id: number;
  /** The other party's display name(s) — "Brann Coldwater". */
  withWhom: string;
  /** The settled terms, one clause, verbatim from when it was struck. */
  terms: string;
  /** In-world day it was struck (1-based) + the coarse phase word. */
  day: number;
  phase: string;
}

/** A work opportunity on offer here: label, wage, and the ability it tests. */
export interface WorkOfferRef {
  id: string;
  label: string;
  ability: string;
  dc: number;
  wageCp: number;
  /** In-world MINUTES the shift takes — surfaced so the player can see that a job costs the day
   *  BEFORE spending it (playtest 07-24: "the game fails to communicate the time cost of actions").
   *  Absent when the shift declares none (it then costs the flat cost-table row). */
  minutes?: number;
  /** Days before this shift can be worked again; absent ⇒ repeatable. */
  cooldownDays?: number;
}

/** The guild hall's recruitment surface — mercs for hire, loiterers to invite, crews to join. */
export interface RecruitBoardRef {
  mercs: MercOfferRef[];
  loiterers: RecruitCandidateRef[];
  leaders: JoinableLeaderRef[];
}

/**
 * Derive the live captivity view from the snapshot (PURE READ). Null unless the player is HELD
 * (`slice.active`). Player-safe: the kind, the captor's name, the day/progress/escape-DC gauges, and
 * the Labor/Escape/Endure menu — never prose. This is what makes the bad end visible as a
 * lived state the player plays out of, not a one-shot paragraph.
 */
export function captivitySceneOf(state: GameState): CaptivityScene | null {
  const slice = state.modules?.captivity as Partial<CaptivitySlice> | undefined;
  if (!slice?.active || !slice.kind) return null;
  const cfg = CAPTIVITY_CONFIG[slice.kind];
  return {
    kind: slice.kind,
    captorName: slice.captorName || cfg.keeper,
    place: cfg.place,
    day: slice.day ?? 1,
    progress: slice.progress ?? 0,
    goal: slice.goal ?? cfg.goal,
    escapeDc: slice.escapeDc ?? cfg.escapeDc,
    actions: captivityActionButtons().map((b) => ({ id: b.id, label: b.label, hint: b.hint })),
  };
}

/**
 * Standing deals for the read-only projection (§2.2) — the OPEN rows only, oldest first, rendered with the same
 * "with whom / terms" shape the brief block uses so projections and prose cannot disagree. Empty (and
 * therefore absent from the snapshot) for a campaign that has struck none.
 */
export function dealsOf(state: GameState): DealRef[] {
  const playerId = state.party[0] ?? "";
  return openDeals(readDealsSlice(state.modules)).map((d) => ({
    id: d.id,
    withWhom: d.partyNames.filter((_, i) => d.parties[i] !== playerId).join(" and "),
    terms: d.terms,
    day: Math.floor(d.atClock / 1440) + 1,
    phase: dayPhaseOf(d.atClock),
  }));
}

export function casesOf(playset: PlaySet, state: GameState): CaseRef[] {
  const { campaign, world } = playset;
  if (campaign.cases.length === 0) return [];
  const slice = readCasesSlice(state.modules);
  const out: CaseRef[] = [];
  for (const c of campaign.cases) {
    const questState = state.quests[c.questId];
    if (questState === undefined || questState === "hidden" || questState === "offered") continue;
    const runtime = slice[c.id];
    const knownIds = new Set(runtime?.playerKnown ?? []);
    const knownFacts = c.facts
      .filter((f) => knownIds.has(f.id))
      .map((f) => ({ id: f.id, text: f.text, kind: f.kind, core: f.core }));
    const suspects: { id: string; name: string }[] = [];
    for (const npcId of Object.keys(c.npcKnowledge)) {
      const name = world.npcs.find((n) => n.id === npcId)?.name;
      if (name) suspects.push({ id: npcId, name });
    }
    out.push({
      id: c.id,
      name: c.name,
      state: runtime?.status ?? "open",
      knownFacts,
      suspects,
      wrongAccusations: runtime?.wrongAccusations ?? 0,
      maxWrongAccusations: c.accusation.maxWrongAccusations,
    });
  }
  return out;
}

/**
 * Work on offer at the party's location (the job system's UI, M13): the location's job board (surfaced
 * ONLY at an adventure-guild hall — `location.guild` present) plus every present NPC who hires
 * (`template.work`). Deduped by id. Player-safe — label + wage + the ability the shift tests; the
 * resolve-time authority stays the engine's `workOpportunityById` (same guild gate).
 */
export function workOffersOf(playset: PlaySet, state: GameState): WorkOfferRef[] {
  const world = playset.world;
  const npcById = new Map(world.npcs.map((n) => [n.id, n] as const));
  const out = new Map<string, WorkOfferRef>();
  const add = (w: Work): void => {
    if (!out.has(w.id)) {
      out.set(w.id, {
        id: w.id,
        label: w.label,
        ability: w.ability,
        dc: w.dc,
        wageCp: w.wageCp,
        // Omit-when-absent: a shift with no authored duration/cooldown renders exactly as before.
        ...(w.minutes !== undefined ? { minutes: w.minutes } : {}),
        ...(w.cooldownDays !== undefined ? { cooldownDays: w.cooldownDays } : {}),
      });
    }
  };
  // GUILD-ONLY board (mirrors the engine gate): the location's job board surfaces only at a hall, and
  // only shifts whose reputation gate (`requires`) the PC has met — same visible set as the engine.
  const locData = world.locations.find((l) => l.id === state.partyLocationId);
  // `workRequiresMet` runs the ONE predicate evaluator now (regex audit §10b — the board's private
  // two-clause reader failed open on `hasItem`/`questState`/`flag` gates), and that evaluator reads
  // the WorldModel. Projected here, once per push, only when a guild board is actually in front of
  // the player — the far commoner no-hall case does no work at all.
  if (locData?.guild) {
    const model = fromGameState(state, world, playset.campaign);
    for (const w of locData.work ?? []) if (workRequiresMet(w.requires, model, world, playset.campaign.characters)) add(w);
  }
  for (const id of presentIdsOf(state)) {
    const tpl = npcById.get(id) ?? npcById.get(baseTemplateId(id));
    for (const w of tpl?.work ?? []) add(w);
  }
  return [...out.values()];
}

/**
 * The recruitment surface at the party's guild hall (the hall-as-hub wave, Phase B): mercenaries for
 * hire (generated per hall/day/slot, taken seats filtered), present non-party NPCs to invite into the
 * PC's party, and present leader-capable NPCs whose crew the PC can sign onto. Null when the party is
 * not at a hall (or nothing is recruitable). The engine stays the resolve-time authority (`resolveHire
 * Mercenary`, `resolvePartyInvite`, `resolveJoinParty`) — this only surfaces the affordances.
 */
export function recruitBoardOf(playset: PlaySet, state: GameState): RecruitBoardRef | null {
  const world = playset.world;
  const hall = world.locations.find((l) => l.id === state.partyLocationId);
  if (!hall?.guild) return null;
  const npcById = new Map(world.npcs.map((n) => [n.id, n] as const));
  const coins = state.actors[pcIdOf(state)]?.coins ?? 0;
  const inParty = new Set<string>([...state.party, ...state.companions]);

  // Mercs: generated offers for the hall's board, minus the seats already hired today. The PC's
  // given name is avoided in the seeded pick (r4 P4: a "Kestrel Foss" offered to Kestrel Vane) —
  // the hire path derives from the same name, so board and hire always agree.
  const mercs: RecruitBoardRef["mercs"] = [];
  if (hall.guild.recruits) {
    const { hireCp, wageCp, slots } = hall.guild.recruits;
    const hired = new Set(readRecruitBoardSlice(state.modules).hired);
    const day = recruitDayOf(state.clock);
    const pcName =
      playset.campaign.characters.find((c) => c.id === pcIdOf(state))?.name ?? state.actors[pcIdOf(state)]?.name;
    for (let slot = 0; slot < slots; slot++) {
      const offerId = recruitOfferId(hall.id, day, slot);
      if (hired.has(offerId) || state.actors[offerId]) continue;
      const pseudo: Entity = { id: offerId, kind: "npc", tier: "transient", name: seededMercName(offerId, pcName), locationId: hall.id, partyMember: false, flags: {} };
      const t = composeNpcTemplate(world, pseudo);
      mercs.push({ offerId, name: t.name, summary: t.summary ?? "", hireCp, wageCp, affordable: coins >= hireCp });
    }
  }

  // Present non-party NPCs: leader-capable ones are joinable CREWS; the rest are invite candidates.
  // The hall's own guildmaster + any vendor run the place — they're not looking for a crew, so they're
  // excluded from the loiterer list (you can still address them directly).
  const clerkId = hall.guild.clerkId;
  const loiterers: RecruitBoardRef["loiterers"] = [];
  const leaders: RecruitBoardRef["leaders"] = [];
  for (const id of presentIdsOf(state)) {
    if (inParty.has(id)) continue;
    const tpl = npcById.get(id) ?? npcById.get(baseTemplateId(id));
    if (!tpl) continue;
    // A runtime spawn wears a `template#n` id (nextSpawnId); an authored NPC present as itself keeps
    // its bare id. AmbientLifeModule crowd are `#n` instances of a GENERIC template, so several share
    // one label ("Anchorfall Local") — surfacing them as loiterers reads as a wall of nameless
    // duplicate [RECRUIT] rows. Only individuated authored NPCs belong on the loiterer list; the
    // generated hire path (SWORDS FOR HIRE) is the way to take on anonymous swords. Leaders keep
    // instances (a runtime NPC leader can still front a joinable crew).
    const isAmbientInstance = baseTemplateId(id) !== id;
    if (tpl.autonomy?.level === "leader" && tpl.autonomy?.canLead === true) {
      leaders.push({ id, name: displayNameOf(playset, state, id), ...(tpl.summary ? { summary: tpl.summary } : {}) });
    } else if (id !== clerkId && baseTemplateId(id) !== clerkId && !tpl.vendor && !isAmbientInstance) {
      loiterers.push({ id, name: displayNameOf(playset, state, id) });
    }
  }
  if (mercs.length === 0 && loiterers.length === 0 && leaders.length === 0) return null;
  return { mercs, loiterers, leaders };
}

/** The PC id — the first party member, or the conventional fallback. */
function pcIdOf(state: GameState): string {
  return state.party[0] ?? "pc.you";
}

/** Everyone at the party's location (player included): actor rows UNION authored statless NPCs. */
function presentIdsOf(state: GameState): string[] {
  const ids = new Set(presentAt(state));
  for (const [id, npc] of Object.entries(state.authoredNpcs ?? {})) {
    if (npc.locationId === state.partyLocationId) ids.add(id);
  }
  return [...ids];
}

/** The base template id behind a spawn instance id (`mon.wolf#0` → `mon.wolf`). */
function baseTemplateId(id: string): string {
  return id.replace(/#\d+$/, "");
}

/** A clean display label for an entity id from live identity first, then content, else a de-slugged
 *  id. Exact/runtime templates outrank a spawn's shared base template. */
function displayNameOf(playset: PlaySet, state: GameState, id: string): string {
  const base = baseTemplateId(id);
  const runtimeName = state.actors[id]?.name;
  const templateId = runtimeTemplateIdOf(state, id);
  const name =
    (typeof runtimeName === "string" && runtimeName.trim().length > 0 ? runtimeName : undefined) ??
    playset.campaign.characters.find((c) => c.id === id)?.name ??
    playset.world.npcs.find((n) => n.id === id)?.name ??
    playset.world.npcs.find((n) => n.id === templateId)?.name ??
    playset.world.npcs.find((n) => n.id === base)?.name ??
    playset.world.monsters.find((m) => m.id === id)?.name ??
    playset.world.monsters.find((m) => m.id === templateId)?.name ??
    playset.world.monsters.find((m) => m.id === base)?.name;
  return name?.trim().replace(/#\d+$/, "") || deslug(base);
}

/** Actor ids currently at the party's location (the player included). Derived from the snapshot. */
export function presentAt(state: GameState): string[] {
  return Object.values(state.actors)
    .filter((a) => a.locationId === state.partyLocationId)
    .map((a) => a.id);
}

/** Live template identity first; a base-id fallback is only for legacy spawn snapshots. */
function runtimeTemplateIdOf(state: GameState, id: string): string {
  const templateId = state.actors[id]?.templateId;
  return typeof templateId === "string" && templateId.length > 0 ? templateId : id;
}

/** A readable fallback label from a bare id (`mon.gen.foo` → "Foo"). */
function deslug(id: string): string {
  const tail = id.split(/[.:]/).pop() ?? id;
  return tail.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
