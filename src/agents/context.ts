/**
 * Narration context assembly — pure, engine-owned, no IO and no model.
 *
 * The engine (which holds content + state + the event store) calls this to build the
 * brief the DM/NPC agents narrate from. Keeping it pure makes it unit-testable and keeps
 * the agents thin ("render system prompt + send"). The resolved-mechanics block is the
 * channel through which deterministic dice results reach the narrator as fact.
 *
 * @author Runkai Zhang
 */
import type { Campaign, Condition, DayPhase, Effect, Location, World } from "../content/schema.ts";
import { regionProfileOf } from "../rules/regions.ts";
import { crowdAdjective, crowdPhaseFactor } from "../rules/ambient.ts";
import type { GameState } from "../state/types.ts";
import { knownGazetteerIdsOf } from "../world/expansion.ts";
import { CAMP_LOCATION_ID } from "../world/camp.ts";
import { LODGING_LOCATION_ID } from "../world/lodging.ts";
import { WorldView, isRosteredNpc } from "../world/queries.ts";
import type { GameEvent } from "../events/types.ts";
import type { CheckResult } from "../rules/checks.ts";
import { exhaustionDescriptor, exhaustionLabel } from "../rules/exhaustion.ts";
import {
  attireDescriptor,
  attireStateOf,
  WARDROBE_MODULE,
  type WardrobeSlice,
  type WardrobeSlotId,
  type WardrobeSlotState,
} from "../rules/wardrobe.ts";
import { describeBody } from "../rules/body.ts";
import { ATTIRE_FACT_ID, occupiedCoverageOf, visibleStateOf, type VisibleFact } from "../rules/visible-state.ts";
import { formatCoins, itemDisplayNameOf, resolveItem } from "../rules/items.ts";
import { factionStandingLines } from "../rules/factions.ts";
import { readCasesSlice } from "../rules/cases.ts";
import {
  DEALINGS_ROWS,
  dueLabel,
  openAgreements,
  readExchangesSlice,
  readServicesSlice,
  recentExchanges,
} from "../rules/exchange.ts";
import { DEALS_BRIEF_ROWS, openDeals, readDealsSlice, renderDeal } from "../rules/deals.ts";
import { recentJourneys } from "../rules/journey.ts";
import { nameMentionedIn } from "../rules/name-match.ts";
import { ERRAND_REPORT_ROWS, readErrandsSlice } from "../rules/errands.ts";
// Re-exported from the rules leaf that owns DAY_PHASES; the brief is its biggest caller.
export { dayPhaseOf } from "../rules/routine.ts";
import { dayPhaseOf } from "../rules/routine.ts";
import { QUEST_DEADLINES_MODULE } from "../rules/quest-deadlines.ts";
import type { NarrationContext, NarratorScene, ResolvedMechanics } from "./dm.ts";
import { BRIEF_MARKERS } from "../util/markers.ts";

/** How many trailing *renderable* lines to fold into the brief. */
export const NARRATION_HISTORY_LIMIT = 12;

/**
 * How many raw events to read from the durable log to feed the narrator window. Deltas (and
 * other non-renderable kinds) are persisted to the same log but render as nothing in the
 * transcript, so a single party move can emit several rows that would otherwise crowd out real
 * story lines. Reading a wider raw window lets `transcript()` still surface
 * NARRATION_HISTORY_LIMIT renderable lines after filtering.
 */
export const RECENT_EVENT_READ_LIMIT = 64;

/**
 * Hard ceiling on the widened raw read (Phase 6). Private-channel dialogue renders only into its
 * two parties' briefs, so a long private thread would otherwise fill the whole raw window and
 * starve the GM/bystander `# RECENT` down to "(nothing has happened yet)". The engine widens the
 * read by the number of private lines it finds (public continuity survives any realistic thread)
 * but never past this bound — the read must stay O(1) per tick, not O(history).
 */
export const RECENT_EVENT_READ_MAX = 4 * RECENT_EVENT_READ_LIMIT;

/** One rendered presence row sourced from the WorldModel registry (everyone here but the PC). */
export interface PresentEntity {
  id: string;
  name: string;
  /** GM-facing one-line summary, if the entity has one. */
  summary?: string;
  /** Coarse HP band ("unhurt"/"wounded"/…), if the entity has stats. */
  band?: string;
  /** Authored biological sex ("male"/"female"), surfaced as a pronoun cue so narration doesn't drift
   *  (playtest B7: an NPC with no authored sex had its pronouns flip mid-scene). */
  sex?: string;
  /** Active mechanical status-effect kinds, separate from the coarse HP band. */
  activeConditions?: string[];
  /** Current routine activity ("tending the bar") for a scheduled NPC; absent for everyone else —
   *  omit-when-empty keeps schedule-less briefs byte-identical. */
  activity?: string;
  /** True when this row is a party companion travelling WITH the player (authoritative, from the
   *  entity registry's `partyMember`). Drives the `Party:` line + the "(with you)" row marker. */
  partyMember?: boolean;
  /** True when this row is AMBIENT SCENERY — a transient, non-exploitative background person spawned by
   *  ambient-life, culled the moment the party moves. Marked "(local)" so the narrator never
   *  personifies the crowd as companions and may let them drift off (they never "travel with you").
   *  A foe/monster or an authored NPC is never `local`. */
  local?: boolean;
  /** Coarse danger cue for a hostile monster vs the player's ceiling ("far beyond your strength") —
   *  the difficulty telegraph. Omit-when-empty; never a number. */
  threat?: string;
  /** The NPC's HELD look (authored `appearance`/`description`), re-asserted on every brief so a
   *  character's physical description is consistent turn over turn instead of being re-improvised
   *  per beat (r6 P2: the grey woman was twenty with spent-coal eyes, then old with winter-sky
   *  eyes, three turns later). Omit-when-empty keeps look-less briefs byte-identical. */
  looks?: string;
}

/**
 * Who a brief is being built FOR (NPC-EPISTEMIC-CONTEXT-PLAN Phase 2). The GM/narrator audience
 * (absent/default) keeps today's byte-identical omniscient brief. An `npc` audience renders the
 * OBSERVER-SAFE projection of the same scene: no other-NPC motive summaries, no concealed player
 * inventory, no player-only case evidence, and a participation-filtered record — one shared
 * formatter, projected per audience, never a fork.
 */
export type ContextAudience =
  | { kind: "gm" }
  | {
      kind: "npc";
      /** Runtime entity id of the observing NPC (matches presence rows / errand runners). */
      npcId: string;
      /** Stable template id when the runtime id differs (spawned instances); defaults to npcId. */
      templateId?: string;
    };

export interface ContextInput {
  world: World;
  campaign: Campaign;
  state: GameState;
  /**
   * Audience projection (Phase 2). ABSENT ⇒ the GM view, byte-identical to before this existed.
   * NPC reply/decide briefs pass their observer so narrator-only authority never leaks to a
   * character's prompt.
   */
  audience?: ContextAudience;
  /** Recent events, oldest-first (as readEvents returns them). */
  recentEvents: GameEvent[];
  /** Prose description of the player's grounded action — the thing to narrate. */
  trigger: string;
  /** Resolved verdict to inject as authoritative fact, if a check was rolled. */
  resolved?: ResolvedMechanics;
  /**
   * Authoritative CONSEQUENCE lines the engine BOUND this turn (Phase 3 — the consequence floor): a
   * transgression's notoriety/disposition/faction/memory trace, or a social ask granted. Each line
   * corresponds to a real reducer command already in the Judge's ledger, so the narrator must reflect
   * these outcomes. Rendered as an omit-when-empty `=== CONSEQUENCES ===` block in the screened
   * current-action region; absent ⇒ ZERO bytes, so every non-consequence brief stays byte-identical.
   */
  consequences?: string[];
  /**
   * TURN FACTS — the player-salient state changes the reducer performed (or will legally perform at
   * commit) this turn, rendered from the authorized-command ledger (`src/rules/turn-facts.ts`). The
   * narrator finally SEES what mechanically happened — item/coin/gear movements, downs, XP, travel —
   * so it can neither invent an exchange nor contradict one (live 07-18 #1/#4). Rendered as an
   * omit-when-empty `=== TURN FACTS ===` block in the screened current-action region; absent ⇒
   * ZERO bytes, so every no-change brief stays byte-identical.
   */
  turnFacts?: string[];
  /**
   * NPC beats already EXECUTED this tick (Workstream C slim): the dialogue module's emitted
   * reply, the autonomy Director's spoken lines / grounded actions. The GM runs LAST in the
   * narrate phase and weaves these as authoritative fact — never contradicting or re-deciding
   * them. Rendered as its own `===` block in the current-action region; omitted entirely when
   * empty, so a zero-beat scene's brief is byte-identical to before the block existed.
   */
  turnOutcome?: NpcBeat[];
  /**
   * Environmental beats (prebaked event `narrate` effects) already shown to the player THIS tick,
   * before the GM's last-word prose. Rendered as a consistency block so the GM narrates around
   * them instead of contradicting them — never re-narrated. Omitted when empty (byte-identical).
   */
  turnEvents?: string[];
  /**
   * An offstage rumor that has reached this room (r11 F-12). NOT already shown — the deterministic
   * `You overhear talk at X: "…"` beat is gone, because the narrator kept re-dramatizing it and the
   * player read the same fact twice in one turn. The GM weaves it ONCE, in its own voice, as
   * background talk around the player's own business — it never replaces the answer to what the
   * player actually did. Omitted when there is nothing to weave (byte-identical brief).
   */
  overheard?: { place: string; text: string };
  /**
   * Appearance/identity social reads (Workstream F follow-up) that colored an NPC's chosen move this
   * tick — a TONE-ONLY cue for the GM's last-word prose (e.g. "Bram regards you: trust +4, fear -3").
   * Rendered as its own `===` block in the current-action region, screened with the action; the
   * resolver already bounded every modifier. Populated ONLY by the narration module from
   * `ctx.data.socialReads`, so it reaches the
   * GM's brief but never an NPC decide brief; omitted entirely when empty ⇒ byte-identical brief.
   */
  socialReads?: SocialRead[];
  /**
   * Presence sourced from the WorldModel registry (matches the classifier): authored location
   * NPCs, spawned transients, and moved tracked NPCs — not just party+companions. When omitted,
   * presence falls back to the legacy WorldView (party+companions) path.
   */
  present?: PresentEntity[];
  /**
   * Exit display names sourced from the WorldModel map (hidden exits already filtered out).
   * When omitted, exits fall back to the legacy WorldView (loc.connections) path.
   */
  exits?: string[];
  /**
   * Relevant authored-lore snippets (already rendered as bullets) from read-only retrieval (M4).
   * Injected as a `# RELEVANT LORE` section AFTER `# RECENT` and BEFORE `# NOW`, so it grounds the
   * GM in real canon without entering the screened current-action region. Omitted entirely when
   * empty/absent ⇒ a no-lore world's brief is byte-identical to before retrieval existed. This is
   * pure prompt context — it carries no state and changes nothing.
   */
  lore?: string[];
  /**
   * The campaign rolling-summary — a "story so far" carried forward so a long campaign isn't
   * forgotten as events scroll out of `# RECENT` (M4 follow-up). Injected as a `# STORY SO FAR`
   * section in the GROUNDING region (after `# LOCATION`, BEFORE `# NOW`, so the guard's `# NOW` cut
   * point is unchanged and it isn't over-screened), and OMITTED entirely when empty/absent ⇒ a
   * no-summary campaign's brief is byte-identical. It is a best-effort, LLM-generated, regenerated
   * derived cache (NOT source of truth): pure prompt context that carries no state and changes
   * nothing.
   */
  storySoFar?: string;
  /**
   * Claims NPCs present this turn previously voiced (the disclosure ledger,
   * `src/memory/disclosure-store.ts`). Rendered as an omit-when-empty `# PRIOR NPC CLAIMS` block in
   * the grounding region. These preserve speaker continuity but are explicitly NOT authoritative
   * world truth: an NPC may lie or be mistaken. Best-effort derived cache; empty/absent ⇒ no block.
   */
  established?: string[];
  /**
   * Private-thread visibility (Phase 6, click-to-chat). `# RECENT` EXCLUDES every dialogue event
   * carrying `channel:"private"` unless this id is one of its two parties (`actorId`/`toId`) — the
   * GM and bystander NPCs narrate/decide AROUND private asides, while the addressed NPC's own
   * reply/decide brief still carries its side of the thread. Omitted (the default, and the only
   * value public narration ever passes) ⇒ ALL private lines are excluded; a campaign with zero
   * private messages renders a byte-identical brief either way (the filter never fires).
   */
  privateFor?: string;
  /**
   * GM-ONLY secret lore (already rendered as bullets) from read-only retrieval. THE PRIVACY
   * BOUNDARY: this is passed straight through onto the returned `NarrationContext.gmLore` and is
   * DELIBERATELY NOT woven into `contextText` — the shared brief stays byte-stable, and only the
   * DM's own narrate message (`dm.narrate`) renders it. NPCs consume `contextText`, so they never
   * see secret lore. Pure prompt context: it carries no state.
   */
  gmLore?: string[];
  /**
   * Stage 1 self-perception: the DECIDING NPC's own body/inventory/energy/goal/
   * party status, plus a peek through its own exits — so an autonomous NPC decides from the same
   * kind of compact state summary a player reads, instead of a location-only brief. Rendered as a `# YOU` block
   * (trailing `Adjacent:` peek line included) placed after the location/presence section and
   * before `# NOW`. ONLY the autonomy module's NPC decide brief ever passes this
   * (`src/modules/autonomy/module.ts` `briefFor`) — the GM/player brief never does, so omitted ⇒
   * ZERO bytes added, and the byte-stable-header contract holds exactly as before Stage 1 existed.
   * Pre-extracted by the caller from the WorldModel registry so this file stays a pure formatter.
   */
  self?: SelfInfo;
}

/**
 * One non-hidden exit from the deciding NPC's own location, for the `Adjacent:` peek line
 * (Stage 1 self-perception). `name`/`direction` are the exit's own authored fields (undefined when
 * unauthored); `destination` is always the resolved display name of what lies beyond it.
 */
export interface AdjacentExit {
  /** Authored exit label ("the North Gate"), when distinct from the destination's own name. */
  name?: string;
  /** Compass/relative direction ("east"), if authored. */
  direction?: string;
  /** The destination location's display name. */
  destination: string;
}

/**
 * The deciding NPC's own self-perception (Stage 1): body/inventory/energy/goal/party status plus
 * an exits peek, pre-extracted from the WorldModel entity registry by the autonomy module. Every
 * field is omit-when-empty — a statless/bare NPC's `# YOU` block degrades gracefully line by line,
 * and the whole feature is gated by the caller supplying `self` on {@link ContextInput} at all.
 */
export interface SelfInfo {
  currentHp?: number;
  maxHp?: number;
  /** Waking stamina, already folded from absence to full (`energyOf`, src/rules/costs.ts). */
  energy?: number;
  maxEnergy?: number;
  /** Persistent exhaustion ladder; 0/absent omits the `Exhaustion:` line. */
  exhaustion?: number;
  conditions?: string[];
  /** Multiset of currently-carried item ids — this file resolves display names + collapses dupes. */
  inventory?: string[];
  coins?: number;
  /** Equipped item ids (weapon/armor/shield slots), already flattened to a plain list. */
  equipped?: string[];
  /** The NPC's own private drive, phrased as a first-person aim. Optional — omitted by default. */
  aim?: string;
  /** This NPC's own party standing. */
  party?: "leader" | "member" | "none";
  /** Non-hidden exits from the NPC's own location. */
  adjacent?: AdjacentExit[];
}

/**
 * Render Stage 1 self-perception into the `# YOU` block (with its trailing `Adjacent:` peek line).
 * Every line is omit-when-empty; returns null when `self` has nothing at all to show, so a
 * statless/bare NPC (or one with no exits) still gets a byte-appropriate (possibly empty) render.
 */
export function renderSelfBlock(world: Pick<World, "items">, self: SelfInfo): string | null {
  const lines: string[] = [];

  if (self.currentHp !== undefined && self.maxHp !== undefined) {
    lines.push(`Health: ${self.currentHp}/${self.maxHp} HP`);
  }
  if (self.energy !== undefined && self.maxEnergy !== undefined) {
    lines.push(`Energy: ${self.energy}/${self.maxEnergy}`);
  }
  if (self.exhaustion) lines.push(`Exhaustion: ${self.exhaustion}`);
  if (self.conditions && self.conditions.length > 0) {
    lines.push(`Conditions: ${self.conditions.join(", ")}`);
  }

  const carrying: string[] = [];
  if (self.inventory && self.inventory.length > 0) {
    const counts = new Map<string, number>();
    for (const id of self.inventory) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, count] of counts) {
      const name = resolveItem(world, id)?.name ?? itemDisplayNameOf(id);
      carrying.push(count > 1 ? `${name} x${count}` : name);
    }
  }
  if (self.coins !== undefined && self.coins > 0) carrying.push(formatCoins(self.coins));
  if (carrying.length > 0) lines.push(`Carrying: ${carrying.join(", ")}`);

  if (self.equipped && self.equipped.length > 0) {
    lines.push(`Equipped: ${self.equipped.map((id) => resolveItem(world, id)?.name ?? itemDisplayNameOf(id)).join(", ")}`);
  }

  if (self.aim) lines.push(`Your aim: ${self.aim}`);

  if (self.party) {
    const label =
      self.party === "leader" ? "leader" : self.party === "member" ? "travelling with the party" : "not in the party";
    lines.push(`Party: ${label}`);
  }

  if (self.adjacent && self.adjacent.length > 0) {
    const phrases = self.adjacent.map((e) =>
      e.name
        ? `through the ${e.name} lies the ${e.destination}`
        : e.direction
          ? `the ${e.destination} lies ${e.direction}`
          : `the ${e.destination} lies beyond`,
    );
    lines.push(`Adjacent: ${phrases.join("; ")}.`);
  }

  if (lines.length === 0) return null;
  return [`# YOU`, ...lines].join("\n");
}

/**
 * The player's REAL kit as omit-when-empty brief lines (finding #5 — the GM/player narrator brief
 * carried NO inventory, so the model invented a kit and contradicted the sheet). Additive: an empty
 * pack + no coins + nothing equipped ⇒ no lines, so the tested header contract stays byte-identical.
 * Reads the SAME live `ActorRuntime` projection the sheet + the `# YOU` NPC-decide block read (stacks
 * collapsed, id → display name), so the three can never drift. The narrator must not contradict it.
 */
export function playerKitLines(
  world: Pick<World, "items">,
  actor: { inventory?: string[]; coins?: number; equipped?: { weapon?: string; armor?: string; shield?: string } } | undefined,
  /**
   * Observer-safe restriction (Phase 2): an NPC audience sees only what is VISIBLY worn/wielded —
   * never the contents of the pack or the purse. Inventory visibility isn't modeled yet, so
   * equipped-only is the honest default (plan §10.3). GM callers omit this and keep the full kit.
   */
  opts: { visibleOnly?: boolean } = {},
): string[] {
  if (!actor) return [];
  const lines: string[] = [];
  const carrying: string[] = [];
  if (!opts.visibleOnly && actor.inventory && actor.inventory.length > 0) {
    const counts = new Map<string, number>();
    for (const id of actor.inventory) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, count] of counts) {
      const name = resolveItem(world, id)?.name ?? itemDisplayNameOf(id);
      carrying.push(count > 1 ? `${name} x${count}` : name);
    }
  }
  if (!opts.visibleOnly && actor.coins !== undefined && actor.coins > 0) carrying.push(formatCoins(actor.coins));
  if (carrying.length > 0) lines.push(`You carry: ${carrying.join(", ")}`);
  const equipped = actor.equipped ? Object.values(actor.equipped).filter((id): id is string => !!id) : [];
  if (equipped.length > 0) {
    lines.push(`Wielding/worn: ${equipped.map((id) => resolveItem(world, id)?.name ?? itemDisplayNameOf(id)).join(", ")}`);
  }
  return lines;
}

function transcript(input: ContextInput, view: WorldView): string {
  const lines: string[] = [];
  // Witness scoping (r4): a brief built FOR a specific NPC (`privateFor` — only NPC reply/decide
  // briefs set it) drops scene rows stamped with a cast that excludes them. An absent NPC must not
  // quote a scene from across the city (Oda repeated Undercroft names, whisper-adjacent, at the
  // stair). Rows without the stamp (legacy events, pre-model emits) stay in — fail-open keeps old
  // sessions and the GM/player brief byte-identical.
  const unwitnessed = (presentIds?: string[]): boolean =>
    input.privateFor !== undefined && presentIds !== undefined && !presentIds.includes(input.privateFor);
  for (const e of input.recentEvents) {
    switch (e.kind) {
      case "narration":
        if (unwitnessed(e.presentIds)) break;
        lines.push(`GM: ${e.text}`);
        break;
      case "dialogue": {
        // A private aside renders ONLY into a brief built for one of its two parties; every other
        // consumer (the GM, bystander NPCs) never sees the line. Public dialogue is untouched, so
        // a zero-private history renders byte-identically to before the channel existed.
        const pf = input.privateFor;
        if (e.channel === "private" && !(pf !== undefined && (e.actorId === pf || e.toId === pf))) break;
        if (unwitnessed(e.presentIds)) break;
        lines.push(`${view.name(e.actorId)}: ${e.text}`);
        break;
      }
      case "diceRolled": {
        const verdict = e.success === undefined ? "" : e.success ? " SUCCESS" : " FAILURE";
        lines.push(`[roll] ${e.purpose ?? e.notation} → ${e.total}${verdict}`);
        break;
      }
      case "stateChanged":
        if (unwitnessed(e.presentIds)) break;
        lines.push(`[*] ${e.summary}`);
        break;
      default:
        break; // system/npcProposal/delta are noise here
    }
  }
  const tail = lines.slice(-NARRATION_HISTORY_LIMIT);
  return tail.length ? tail.join("\n") : "(nothing has happened yet)";
}

/**
 * Anti-cast-hallucination (the reported "Oda still walks beside you after I left him" drift).
 *
 * Authored NPCs whose name still appears in the recent transcript / rolling summary but who are
 * NOT in the present roster are characters the GM is at risk of carrying forward by momentum. We
 * name them on an authoritative `Not present` line so the model has an explicit fact to obey instead
 * of a silence to fill.
 *
 * Matching used to be deliberately INCLUSIVE on the theory that a false include is harmless. It is
 * not. Against a large authored roster, the single scene-setting line "You step back onto
 * the coast road. One of the drovers spits into the dust and says the old ferry has not run in a
 * year. A nightjar calls from the reeds." — which names nobody — put FIVE people on the `Not
 * present` line (Coast Farmhand, Nightjar, Old Corle, Old Wenna, One of the Standing), filled the
 * six-row cap with pure noise so a genuinely absent companion could not fit, and handed the
 * classifier five bogus ids to ground an intent against. So the pool now goes through the shared
 * distinctive-token binder (`src/rules/name-match.ts`): prose, so a capital is required.
 * Returns the display names, capped, oldest authored order; empty ⇒ the line is omitted (byte-stable).
 */
export function absentReferencedNames(
  world: World,
  presentRows: PresentEntity[],
  ...texts: (string | undefined)[]
): string[] {
  return absentReferencedNpcs(world, presentRows, ...texts).map((n) => n.name);
}

/**
 * The same matcher, returning `{id, name}` rows.
 *
 * The names half feeds the brief's `Not present` line (a negative anchor for the narrator); the
 * ids half feeds the CLASSIFIER (r5), so an intent ABOUT someone the world has only mentioned —
 * send a companion to fetch them, go ask after them — can carry a real authored id rather than
 * inventing one. Both callers need the identical pool, so there is exactly one scan.
 */
export function absentReferencedNpcs(
  world: World,
  presentRows: PresentEntity[],
  ...texts: (string | undefined)[]
): { id: string; name: string }[] {
  const haystack = texts.filter((t): t is string => !!t && t.trim().length > 0).join("\n");
  if (!haystack.trim()) return [];
  const presentIds = new Set(presentRows.map((p) => p.id));
  const presentNames = new Set(presentRows.map((p) => p.name.trim().toLowerCase()));
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const npc of world.npcs) {
    const name = npc.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key) || presentIds.has(npc.id) || presentNames.has(key)) continue;
    if (nameMentionedIn(haystack, name)) {
      out.push({ id: npc.id, name });
      seen.add(key);
    }
    if (out.length >= 6) break;
  }
  return out;
}

/** Trim prose and return undefined for empty/defaulted values. */
function prose(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Authored private character notes for the GM-only channel. These never enter `contextText`.
 * Player-character notes are included for party PCs; NPC `hiddenLore` is included only for NPCs
 * currently present in the brief, because those are the hidden truths the DM may need this turn.
 */
function characterGmLore(input: ContextInput, presentRows: PresentEntity[]): string[] {
  const lines: string[] = [];

  for (const id of input.state.party) {
    const pc = input.campaign.characters.find((c) => c.id === id);
    if (!pc) continue;
    const name = pc.name || id;
    const description = prose(pc.description);
    const personality = prose(pc.personality);
    const knownLore = prose(pc.knownLore);
    const backstory = prose(pc.backstory);
    const hiddenLore = prose(pc.hiddenLore);
    // Physical description first (omit-when-empty): how the world sees this character.
    if (description) lines.push(`‣ Player Character — ${name}: Appearance: ${description}`);
    // Structured physical features for the GM's reference; clothing is rendered separately.
    const body = describeBody(pc.body);
    if (body) lines.push(`‣ Player Character — ${name}: Body: ${body}`);
    if (personality) lines.push(`‣ Player Character — ${name}: Personality: ${personality}`);
    if (knownLore) lines.push(`‣ Player Character — ${name}: Known lore: ${knownLore}`);
    if (backstory) lines.push(`‣ Player Character — ${name}: Backstory: ${backstory}`);
    if (hiddenLore) lines.push(`‣ Player Character — ${name}: Hidden lore: ${hiddenLore}`);
  }

  const presentNpcIds = new Set(presentRows.map((p) => p.id));
  for (const npc of input.world.npcs) {
    if (!presentNpcIds.has(npc.id)) continue;
    const hiddenLore = prose(npc.hiddenLore);
    if (hiddenLore) lines.push(`‣ NPC Hidden Lore — ${npc.name || npc.id}: ${hiddenLore}`);
  }

  return lines;
}

/** Render the resolved verdict into the unmissable, authoritative block. */
export function renderResolvedBlock(r: ResolvedMechanics): string {
  if (r.refused) {
    return [
      "=== RESOLVED MECHANICS (authoritative — narrate this exact outcome) ===",
      `${r.label}: REFUSED — no roll possible.`,
      "Narrate this refusal as fact. Do not soften it, override it, or invent a roll.",
    ].join("\n");
  }
  const dc = r.dc !== undefined ? ` vs DC ${r.dc}` : "";
  const crit = r.critical ? ` (critical ${r.critical})` : "";
  const lines = [
    "=== RESOLVED MECHANICS (authoritative — narrate this exact outcome) ===",
    `${r.label}${dc}: total ${r.total} — ${r.success ? "SUCCESS" : "FAILURE"}${crit}.`,
  ];
  if (r.damage !== undefined) {
    lines.push(`Damage: ${r.damage}${r.damageType ? ` ${r.damageType}` : ""}.`);
  }
  if (r.note) {
    lines.push(r.note);
  }
  lines.push("Narrate this result as fact. Do not change it, re-roll it, or invent any other number.");
  return lines.join("\n");
}

/**
 * The authoritative CONSEQUENCES block (Phase 3) — the persistent outcomes the engine BOUND this turn,
 * each backed by a real ledgered reducer command. The narrator must voice these as fact (a disposition
 * that hardened, notoriety that grew, an ask that was granted) so success no longer reads the same as
 * failure. Never rendered when empty (the caller omits the block), so byte-stable elsewhere.
 */
export function renderConsequencesBlock(lines: string[]): string {
  return [
    "=== CONSEQUENCES (authoritative — reflect these outcomes as fact) ===",
    ...lines.map((l) => `- ${l}`),
    "These changes have already happened in the world. Weave them into the prose; do not deny or undo them.",
  ].join("\n");
}

/**
 * The authoritative TURN FACTS block — what the engine ACTUALLY changed this turn, straight from the
 * authorized-command ledger. The narrator's positive ground truth (the continuity checks are the
 * negative half): with this in the brief, a fabricated purchase contradicts an explicit fact list
 * instead of a silence. Never rendered when empty (the caller omits the block) — byte-stable briefs.
 */
export function renderTurnFactsBlock(lines: string[]): string {
  return [
    "=== TURN FACTS (authoritative — the only mechanical changes this turn) ===",
    ...lines.map((l) => `- ${l}`),
    "These are the ONLY items, coins, gear, conditions, or movements that changed this turn. Anything else the player attempted did NOT mechanically happen — narrate such attempts without confirming completion.",
  ].join("\n");
}

/** Build a ResolvedMechanics from a rules CheckResult + a label. */
export function resolvedFromCheck(label: string, c: CheckResult): ResolvedMechanics {
  return { label, dc: c.dc, total: c.total, success: c.success, critical: c.critical };
}

/** Build a no-roll hard-refusal verdict for the existing resolved-mechanics block. */
export function resolvedHardRefusal(label: string): ResolvedMechanics {
  return { label, total: 0, success: false, critical: null, refused: true };
}

/**
 * One NPC beat already executed this tick (Workstream C slim) — accumulated on
 * `ctx.data.turnOutcome` by the dialogue/autonomy modules from their EXISTING outputs (the
 * emitted reply, the grounded action) and woven into the GM's brief, which now runs last.
 * No new agent calls and no new decision surface: this only carries what already happened.
 */
export interface NpcBeat {
  actorId: string;
  name: string;
  /** The exact spoken line already emitted to the transcript, if the NPC spoke. */
  dialogue?: string;
  /**
   * The NPC's spoken line(s) as an ordered, mood-tagged list (the structured form of `dialogue`).
   * Carried to the public intent wire so the client can tint each rendered quote by the mood the NPC
   * itself assigned. Absent when the NPC spoke via the legacy plain-string path (⇒ neutral).
   */
  lines?: { text: string; mood: string }[];
  /**
   * A short ATTEMPT summary of an action the NPC is taking, if any. Phrased as intent (not a
   * completed fact) because the grounded command is enqueued and applied at commit — AFTER this
   * beat is woven — and the reducer may still reject it, so the brief must never canonize it.
   */
  action?: string;
  /**
   * Signed-turn field: did the NPC's desired command VALIDATE (via the dry-run oracle)? `true` for
   * pure speech (no command) and for a command that would apply; `false` when the reducer/grounding
   * rejected it. Absent ⇒ unknown (renders byte-identical to a pre-enrichment beat). Only `false`
   * changes the brief — it flags the DM not to narrate the action as succeeding.
   */
  accepted?: boolean;
  /** Why the desired command was rejected (dry-run reducer reason or grounding fallback), when `accepted===false`. */
  rejectedReason?: string;
  /** Discrete claims the NPC voiced this turn — remembered as claims, never promoted to world truth. */
  factsAsserted?: string[];
  /**
   * The NPC's 0..1 self-rated confidence in this beat. Carried for telemetry + the public-safe intent
   * wire's contrast boundary; NOT rendered into the authoritative block (noise for a narrator) and
   * NEVER placed on the public wire.
   */
  confidence?: number;
}

/** The per-tick accumulation shape modules share on `ctx.data.turnOutcome`. */
export interface TurnOutcome {
  npc: NpcBeat[];
  /**
   * Environmental beats already narrated this tick (prebaked event `narrate` effects). The GM
   * runs LAST and these fired BEFORE it, so without this the GM would build its brief blind to
   * them and could narrate a contradiction (arrive to "the barrow lies silent" right after a
   * beat announced a wight rising). Carried here so the GM stays consistent — NOT re-narrated.
   */
  events?: string[];
}

/** Append one executed NPC beat to the tick's outcome record (creates the slot on first use). */
export function recordNpcBeat(data: Record<string, unknown>, beat: NpcBeat): void {
  const outcome = (data.turnOutcome as TurnOutcome | undefined) ?? { npc: [] };
  outcome.npc.push(beat);
  data.turnOutcome = outcome;
}

/**
 * One appearance/identity social read (Workstream F follow-up) — how an acting NPC perceived its
 * target this tick, already reduced to a one-line axis summary (`summarizeModifiers`) with the
 * names resolved at record time (like `NpcBeat.name`). A TONE cue for the GM, never a mechanic.
 */
export interface SocialRead {
  actor: string;
  target: string;
  summary: string;
}

/** Append one social read to the tick's `ctx.data.socialReads` slot (creates it on first use). */
export function recordSocialRead(data: Record<string, unknown>, read: SocialRead): void {
  const reads = (data.socialReads as SocialRead[] | undefined) ?? [];
  reads.push(read);
  data.socialReads = reads;
}

/** Append one already-narrated environmental beat so the GM's last-word brief stays consistent. */
export function recordTurnEvent(data: Record<string, unknown>, text: string): void {
  const outcome = (data.turnOutcome as TurnOutcome | undefined) ?? { npc: [] };
  (outcome.events ??= []).push(text);
  data.turnOutcome = outcome;
}

/** Render executed NPC beats into the authoritative weave-these-in block. */
export function renderTurnOutcomeBlock(beats: NpcBeat[]): string {
  const lines = beats.map((b) => {
    const parts: string[] = [];
    if (b.dialogue) parts.push(`said: "${b.dialogue}"`);
    if (b.action) parts.push(b.action);
    // The byte-stable skeleton (unchanged for a pre-enrichment beat); signed-turn clauses only APPEND.
    let line = `- ${b.name}: ${parts.join(" — ") || "acted"}`;
    if (b.accepted === false) {
      line += ` (REJECTED${b.rejectedReason ? `: ${b.rejectedReason}` : ""} — do NOT narrate as succeeding)`;
    }
    if (b.factsAsserted && b.factsAsserted.length > 0) {
      line += ` [claims aloud — not verified world truth: ${b.factsAsserted.join("; ")}]`;
    }
    return line;
  });
  return [
    "=== NPC ACTIONS THIS TURN (authoritative — weave these in; do not contradict or re-decide them) ===",
    ...lines,
  ].join("\n");
}

/** Render already-narrated environmental beats into a stay-consistent (do-not-restate) block. */
export function renderTurnEventsBlock(events: string[]): string {
  return [
    "=== ALREADY HAPPENING THIS TURN (already shown to the player — stay consistent, do NOT restate or contradict) ===",
    ...events.map((e) => `- ${e}`),
  ].join("\n");
}

/**
 * Render the offstage rumor that has reached this room (r11 F-12). Unlike the block above, this has
 * NOT been shown to the player — the GM is the only voice that will carry it, so the instruction is
 * to weave it, once, without letting it take the turn away from what the player did.
 */
export function renderOverheardBlock(overheard: { place: string; text: string }): string {
  return [
    "=== OVERHEARD (talk in this room — NOT yet shown to the player; weave it in ONCE, in your own voice) ===",
    `- At ${overheard.place}, the talk is: "${overheard.text}"`,
    "- Give it a mouth and a corner: someone nearby saying it, half-heard. Do not quote it verbatim as a block.",
    "- It is BACKGROUND. Answer what the player actually did first; the talk colors the scene, it never replaces the answer.",
  ].join("\n");
}

/**
 * Render social reads into a TONE-ONLY cue block (Workstream F follow-up). It tells the GM how the
 * acting NPCs perceived their targets this turn so the prose can carry that colour — it changes NO
 * outcome (the disposition nudge already happened, bounded, in `agenda.stance()`), so the wording is
 * explicit that it must not alter events.
 */
export function renderSocialReadsBlock(reads: SocialRead[]): string {
  return [
    "=== SOCIAL READ (tone only — how the acting NPCs regard their targets; color the prose, change no outcome) ===",
    ...reads.map((r) => `- ${r.actor} regards ${r.target}: ${r.summary}`),
  ].join("\n");
}

export function timeLineOf(clock: number): string {
  return `Time: ${dayPhaseOf(clock)} (day ${Math.floor(clock / 1440) + 1})`;
}

/**
 * The optional `Ambience:` line for the `# LOCATION` block — a one-word crowd cue from the location's
 * region `crowd` and the day phase (a market throngs at midday, empties at night). Returns null for a
 * location NOT in a first-class region row, and for a NEUTRAL region (`crowd === 1`), so an unregioned
 * world — and every place the author didn't mark busy or quiet — emits NOTHING and the brief stays
 * byte-identical (the `Nearby:` / gazetteer precedent; the tested header contract is untouched).
 */
export function ambienceLineOf(world: World, locationId: string | null, clock: number): string | null {
  const profile = regionProfileOf(world, locationId);
  if (profile.regionId === null || profile.crowd === 1) return null;
  const adj = crowdAdjective(profile.crowd, crowdPhaseFactor(dayPhaseOf(clock) as DayPhase));
  if (!adj) return null;
  const locName = world.locations.find((l) => l.id === locationId)?.name ?? "the place";
  return `Ambience: ${locName} is ${adj}`;
}

/** The optional exertion line for the brief — omitted at level 0 for byte-stable fresh saves. */
export function exertionLineOf(level: number | undefined): string | null {
  const n = level ?? 0;
  if (n <= 0) return null;
  return `Exertion: ${exhaustionLabel(n)} — ${exhaustionDescriptor(n)}`;
}

/**
 * The optional `Attire:` line for the brief — the PC's current wardrobe state (paper-doll UI,
 * `modules.wardrobe`), omitted while fully dressed for byte-stable default saves. Shared
 * `contextText` (not `gmLore`), so both the DM narrator and NPC reply/decide prompts see it —
 * the fix for "am I wearing anything?" going unanswered and present NPCs never noticing.
 *
 * `occupied` narrows "bare" to the coverage slots the character actually dresses (see
 * {@link attireStateOf}); omitting it keeps the conservative all-slots read.
 */
export function attireLineOf(
  row: Partial<Record<WardrobeSlotId, WardrobeSlotState>> | undefined,
  occupied?: ReadonlySet<WardrobeSlotId>,
): string | null {
  const state = attireStateOf(row, occupied);
  if (!state) return null;
  return `Attire: ${state} — ${attireDescriptor(state)}`;
}

/**
 * The optional `Visibly:` line — every NON-attire visible fact about the PC (active status effects
 * today; future perceivables ride the same `visibleStateOf` seam). Attire is excluded because it
 * already has its own tested `Attire:` line above — rendering it twice would double-report.
 * Returns null when nothing is visible, so an unremarkable PC's brief stays byte-identical to
 * before this line existed.
 */
export function visiblyLineOf(facts: readonly VisibleFact[]): string | null {
  const rest = facts.filter((f) => f.id !== ATTIRE_FACT_ID);
  if (rest.length === 0) return null;
  return `Visibly: ${rest.map((f) => f.brief).join(", ")}`;
}

/**
 * The `Nearby:` line for the `# LOCATION` block — the world's gazetteer entries (rumored/known
 * points of interest beyond the map) as `Name (kind)` in authored order, same comma style as
 * `Exits:`. Returns null when the world has no gazetteer, so BOTH consumers (the brief and the
 * CLI's /look) omit the line entirely and a gazetteer-less world renders byte-identically to
 * before the line existed. One formatter, shared, so the two surfaces can't drift.
 *
 * A KNOWN entry (frontier expansion realized it AND the party has stood in it — Phase 4) renders
 * as `Name (kind, known)`: the smallest change that stops the brief framing a place the party has
 * reached as distant hearsay. An entry merely charted toward (pocket generated, party never
 * arrived) stays hearsay and renders byte-identically to before, as do callers that pass no
 * known set — the pre-Phase-4 line verbatim.
 */
export function nearbyLineOf(world: World, known?: ReadonlySet<string>): string | null {
  const entries = world.gazetteer ?? [];
  if (entries.length === 0) return null;
  return `Nearby: ${entries
    .map((g) => `${g.name} (${g.kind}${known?.has(g.id) ? ", known" : ""})`)
    .join(", ")}`;
}

/**
 * The authored guild hall at the party's current location. Location.guild is the mechanical
 * authority for work inquiries and hall services, so it must also ground NPC directions; otherwise
 * semantic lore retrieval can tempt an NPC to combine an unrelated guild with a real nearby exit.
 * Omitted outside a guild location to preserve existing briefs byte-for-byte.
 */
export function localGuildLineOf(world: World, locationId: string | null): string | null {
  if (!locationId) return null;
  const loc = world.locations.find((candidate) => candidate.id === locationId);
  if (!loc?.guild) return null;

  const clerk = loc.guild.clerkId
    ? world.npcs.find((candidate) => candidate.id === loc.guild?.clerkId)?.name
    : undefined;
  return `Local guild (authoritative): ${loc.guild.name} is HERE at ${loc.name}, not at any exit or neighboring district${clerk ? `; its clerk is ${clerk}` : ""}. When asked where to find a guild, give this local hall before unrelated guild or faction lore.`;
}

/** Assemble the full narrator brief from content + state + recent events. Pure. */
/**
 * The GM `# CASE — <name>` grounding block(s): the player-KNOWN facts only, with a hard no-invention
 * rail. One block per ACTIVE case (quest state `active`, runtime not yet resolved). Omit-when-empty:
 * a campaign with no cases — or none active — adds ZERO lines, so the tested header contract is
 * byte-stable. The GM's own omniscient view of the solution rides the separate gmLore channel below.
 */
function caseBriefLines(campaign: Campaign, state: GameState): string[] {
  const slice = readCasesSlice(state.modules);
  const lines: string[] = [];
  for (const c of campaign.cases) {
    if (state.quests[c.questId] !== "active") continue;
    const runtime = slice[c.id];
    if (runtime && runtime.status !== "open") continue;
    const known = runtime?.playerKnown ?? [];
    lines.push(`# CASE — ${c.name}`);
    if (known.length === 0) {
      lines.push(`No hard evidence established yet. Do NOT invent findings; the investigation must earn them.`);
    } else {
      lines.push(`Established evidence — treat as fact; never contradict it, and state NO evidence beyond this list:`);
      for (const id of known) {
        const fact = c.facts.find((f) => f.id === id);
        if (fact) lines.push(`- [${fact.kind}] ${fact.text}`);
      }
    }
    lines.push(``);
  }
  return lines;
}

/**
 * The `# THE RECORD` block — the world's own ledger of what the player has COMMITTED to and settled:
 * every quest they have taken, failed, or finished, with its objectives and the NPC who gave it.
 *
 * Why it exists (playtest 07-24 P1): the brief carried lore, memory, relationships, history,
 * whereabouts and case files — and no quest state at all. So a companion who had walked the whole
 * arc had no record that the contract existed, and when the player said "we signed the bond" the
 * model simply invented an answer ("the bond was paid this morning"). The ledger is code-owned and
 * derived straight from `state.quests`; the LLM may phrase it and may resent it, but it can never
 * contradict it. Carries the same no-invention rail as `caseBriefLines`, whose shape this follows.
 *
 * Omit-when-empty: a campaign where the player has taken nothing adds ZERO lines, so the tested
 * header contract stays byte-stable.
 */
export function recordBriefLines(
  campaign: Campaign,
  state: GameState,
  world?: World,
  /**
   * Participation filter (Phase 2, plan §10.4): when the brief is FOR an NPC, a ledger row enters
   * only if that observer plausibly holds it — they gave the quest, walked the journey (party),
   * ran the errand, or were the counterparty of the deal. The GM (absent) keeps the full record;
   * a party companion keeps the arc it walked (the 07-24 P1 this block was built for).
   */
  forObserver?: { ids: ReadonlySet<string>; partyMember: boolean },
): string[] {
  const objectivesDone = (state.modules?.objectives ?? {}) as Record<string, Record<string, boolean>>;
  const deadlines = (state.modules?.[QUEST_DEADLINES_MODULE] ?? {}) as Record<string, number>;
  const rows: string[] = [];
  for (const quest of campaign.quests) {
    const status = state.quests[quest.id];
    if (status !== "active" && status !== "complete" && status !== "failed") continue;
    if (forObserver && !forObserver.partyMember && !(quest.giver && forObserver.ids.has(quest.giver))) continue;
    const giver = quest.giver ? (state.actors[quest.giver]?.name ?? null) : null;
    const label = status === "active" ? "TAKEN" : status === "complete" ? "FINISHED" : "FAILED";
    // An armed deadline renders on the ACTIVE row — the one true clock, so NPC dialogue can stop
    // improvising due dates (2026-07-25: "noon tomorrow" restated on two consecutive days).
    const dueAt = status === "active" ? deadlines[quest.id] : undefined;
    // The time LEFT, beside the due date. r5 was sent after a caravan its own guide priced at "four
    // days hard" on a two-day bond, and nothing anywhere — clerk, guide, journal — ever put the two
    // numbers side by side, so the deadline read as noise and its failure taught nothing. One clock,
    // both halves: a speaker quoting it now quotes something the player can plan against.
    const left = dueAt !== undefined ? Math.max(0, dueAt - state.clock) : 0;
    // Round to whole hours FIRST, then split into days — rounding the remainder alone minted
    // "about 1d 24h left" on a two-day bond (playtest r9 F-4: 1439 leftover minutes round to 24h).
    const hoursTotal = Math.round(left / 60);
    const daysPart = Math.floor(hoursTotal / 24);
    const hoursPart = hoursTotal % 24;
    const spanLabel =
      daysPart > 0 ? `${daysPart}d${hoursPart > 0 ? ` ${hoursPart}h` : ""}` : `${hoursPart}h`;
    const leftLabel =
      dueAt === undefined ? "" : left <= 0 ? " (the time is up)" : ` (about ${spanLabel} left)`;
    const due =
      dueAt !== undefined ? ` — due by ${dayPhaseOf(dueAt)}, day ${Math.floor(dueAt / 1440) + 1}${leftLabel}` : "";
    rows.push(
      `- [${label}] ${quest.name}${giver ? ` — given by ${giver}` : ""}${due}${quest.description ? `: ${quest.description}` : ""}`,
    );
    const done = objectivesDone[quest.id] ?? {};
    for (const objective of quest.objectives) {
      if (done[objective.id] ?? objective.done) rows.push(`  · done — ${objective.description}`);
    }
  }
  // Journey rows (2026-07-25): the party's last real travels are RECORD facts too, so an NPC can
  // never again confidently deny a road the party walked ("we haven't gone yet" while the energy
  // bar still carried the march). Rendered only when the caller passes the world (name lookup).
  let traveled = 0;
  // A journey belongs to those who made it: the GM and party companions keep the rows; a bystander
  // NPC the party is merely talking to was not along and does not receive the itinerary.
  if (world && (!forObserver || forObserver.partyMember)) {
    const nameOf = (id: string): string => world.locations.find((l) => l.id === id)?.name ?? id;
    for (const leg of recentJourneys(state.modules ?? {})) {
      rows.push(
        `- [TRAVELED] ${nameOf(leg.fromId)} → ${nameOf(leg.toId)} (set out ${dayPhaseOf(leg.atClock)}, day ${Math.floor(leg.atClock / 1440) + 1})`,
      );
      traveled += 1;
    }
  }
  // Errand rows (r5): who the player has sent where, and what came back. These are RECORD facts
  // for the same reason journeys are — an NPC must not wonder aloud where a companion went when
  // the player sent them, and must not re-litigate a report the runner already delivered. Counted
  // toward the emptiness check below, so an errand-only ledger still gets its header.
  if (world) {
    const nameOf = (id: string): string => world.locations.find((l) => l.id === id)?.name ?? id;
    const whoOf = (id: string): string => state.actors[id]?.name ?? world.npcs.find((n) => n.id === id)?.name ?? id;
    const errands = readErrandsSlice(state.modules ?? {});
    // An errand is known to its runner, its sender's party, and no one else.
    const errandVisible = (runnerId: string): boolean =>
      !forObserver || forObserver.partyMember || forObserver.ids.has(runnerId);
    for (const errand of Object.values(errands.active)) {
      if (!errandVisible(errand.runnerId)) continue;
      rows.push(
        `- [ERRAND] ${whoOf(errand.runnerId)} is away at ${nameOf(errand.destinationId)} — ` +
          `expected back by ${dayPhaseOf(errand.dueAtClock)}, day ${Math.floor(errand.dueAtClock / 1440) + 1}.`,
      );
    }
    for (const report of Object.values(errands.reports).slice(-ERRAND_REPORT_ROWS)) {
      if (!errandVisible(report.runnerId)) continue;
      const finding = report.findings[0];
      if (finding) rows.push(`- [REPORTED] ${whoOf(report.runnerId)} brought back: ${finding}`);
    }
  }
  // Dealings rows (r8): every exchange the reducer actually executed — buys, sells, fees, tips,
  // gifts — plus property currently in an NPC's custody. RECORD facts for the run-7 reason: the
  // prose asserted purchases that never happened ("You're kitted") and forgot ones that did. The
  // ledger is the ONLY commerce that occurred; anything else discussed was talk.
  let dealt = 0;
  // A deal is known to its counterparty and to the party that stood beside the counter — a
  // stranger the player later addresses has no window into someone else's commerce.
  for (const rec of recentExchanges(readExchangesSlice(state.modules ?? {}), DEALINGS_ROWS)) {
    if (forObserver && !forObserver.partyMember && !(rec.npcId && forObserver.ids.has(rec.npcId))) continue;
    rows.push(`- [DEALT] ${rec.note} (${dayPhaseOf(rec.minute)}, day ${rec.day + 1})`);
    dealt += 1;
  }
  for (const a of openAgreements(readServicesSlice(state.modules ?? {}))) {
    if (!a.custody) continue;
    if (forObserver && !forObserver.partyMember && !forObserver.ids.has(a.npcId)) continue;
    rows.push(`- [IN CUSTODY] Your ${a.itemName ?? "property"} is with ${a.npcName} (${a.label}, paid) — ${dueLabel(a)}. It is NOT lost and NOT sold.`);
    dealt += 1;
  }
  if (rows.length === 0) return [];
  return [
    `# THE RECORD`,
    `The world's own ledger of what this player has taken on. Treat every line as ESTABLISHED FACT: if`,
    `they state one of these, it happened — acknowledge it, never dispute it, and never require proof`,
    `of it. State NOTHING beyond this list as settled.`,
    ...(traveled > 0 ? [`[TRAVELED] rows are real journeys the party made — no one who was along denies them.`] : []),
    ...(dealt > 0
      ? [
          `[DEALT] rows are the ONLY goods and coin that actually changed hands. Never narrate the player`,
          `as owning, wearing, or carrying a purchase that is not on this list — a deal that was only`,
          `talked about did NOT conclude.`,
        ]
      : []),
    ...rows,
    ``,
  ];
}

/**
 * The `# STANDING DEALS` block (PROSE-TO-CODE §2.2) — agreements the player has actually struck and
 * not yet closed, in the terms they were struck in.
 *
 * Why it is its own block and not a `# THE RECORD` row: the record answers "what happened", and a
 * deal is a live obligation that constrains what should happen NEXT. Run 6's best content was its
 * bargains — a first-refusal contract, a strongbox stake, credit on a vest — and every one of them
 * existed only in the scrollback, so the world could neither honour nor hold anyone to them.
 *
 * Participation-filtered exactly like the record: a deal is known to its parties and to the party
 * that stood beside it; a stranger the player later addresses has no window into someone else's
 * bargain. Omit-when-empty, so a campaign with no deals adds ZERO lines and the tested header
 * contract stays byte-stable.
 */
export function standingDealsLines(
  state: GameState,
  forObserver?: { ids: ReadonlySet<string>; partyMember: boolean },
): string[] {
  const playerId = state.party[0] ?? "";
  const rows: string[] = [];
  for (const deal of openDeals(readDealsSlice(state.modules ?? {})).slice(-DEALS_BRIEF_ROWS)) {
    if (forObserver && !forObserver.partyMember && !deal.parties.some((p) => forObserver.ids.has(p))) continue;
    rows.push(`- [DEAL] ${renderDeal(deal, playerId)} (struck ${dayPhaseOf(deal.atClock)}, day ${Math.floor(deal.atClock / 1440) + 1})`);
  }
  if (rows.length === 0) return [];
  return [
    `# STANDING DEALS`,
    `Agreements the player has actually struck and not yet closed. Treat each as ESTABLISHED: the`,
    `terms are what was agreed, nobody disputes that it was agreed, and nobody re-negotiates it`,
    `unasked. A party to a deal may hold the player to it; anyone else has no standing to invoke it.`,
    ...rows,
    ``,
  ];
}

/**
 * GM-ONLY case ground truth for the secret-lore DM channel (never the shared brief, never an NPC
 * prompt): the solution + solving directive, so the narrator stays internally consistent without
 * ever blurting it. Gated to active cases; omit-when-empty.
 */
function caseGmLore(campaign: Campaign, state: GameState): string[] {
  return campaign.cases
    .filter((c) => state.quests[c.questId] === "active")
    .map(
      (c) =>
        `CASE SOLUTION — ${c.name} (GM eyes only; NEVER state this as fact in prose and let NO npc assert it): ` +
        `culprit = ${c.truth.culpritId}; method = ${c.truth.method}; motive = ${c.truth.motive}. ${c.truth.summary}`,
    );
}

/**
 * GM-ONLY quest ground truth (r7 P0): where each ACTIVE quest's objectives REALLY resolve, derived
 * from the authored event wiring itself (any event whose effects tick an objective; its atLocation /
 * hasItem conditions name the real site and token). Run 7's narrator built a complete parallel
 * quest location — an NPC guide, a culvert, directions, a described reward — that could never
 * satisfy the objective, while the authored wreck sat one node away, unmentioned. The GM cannot be
 * forbidden from improvising scenery; it CAN be told where the real referents are and that leads
 * must point at them. Omit-when-empty (no active located quests ⇒ byte-identical brief).
 */
/**
 * Corrections for props the LOCATION TEXT still stages after they were taken (playtest r9 F-2).
 * An authored description is static prose: "beside it, in a waxed canvas tube, the caravan's
 * bond-writ" keeps asserting the writ lies in the dust long after a `giveItem` event handed it
 * to the player — and the narrator (plus every NPC decide brief) trusted the scene text over the
 * inventory line, three scenes running ("the writ's still sitting there" about an item in the
 * PC's pack). Deterministic and content-derived: for every prebaked event anchored to THIS
 * location whose effects give an item, if some actor now HOLDS that item, say so explicitly —
 * the description above predates the taking. Omit-when-empty keeps the brief byte-stable.
 */
export function takenPropLines(
  campaign: Pick<Campaign, "events">,
  world: Pick<World, "items">,
  state: GameState,
  locationId: string | null,
): string[] {
  if (!locationId) return [];
  const lines: string[] = [];
  const giveItemIds = (effects: Effect[]): string[] =>
    effects.flatMap((e) => {
      if (e.kind === "giveItem") return [e.itemId];
      if (e.kind === "check") return [...giveItemIds(e.onSuccess), ...giveItemIds(e.onFail)];
      return [];
    });
  for (const ev of campaign.events ?? []) {
    const here = ev.trigger.allOf.some((c) => c.kind === "atLocation" && c.locationId === locationId);
    if (!here) continue;
    for (const itemId of giveItemIds(ev.effects)) {
      const holderId = Object.keys(state.actors).find((id) => (state.actors[id]?.inventory ?? []).includes(itemId));
      if (!holderId) continue;
      const itemName = resolveItem(world, itemId)?.name ?? itemDisplayNameOf(itemId);
      const holder = state.actors[holderId];
      const holderName = holderId.startsWith("pc.") ? "You" : (holder?.name ?? "someone");
      lines.push(
        `(GM: the ${itemName} is NO LONGER lying here — ${holderName === "You" ? "the player carries it" : `${holderName} carries it`} now. ` +
          `The description above predates this; never describe or reference it as still in the scene.)`,
      );
    }
  }
  return lines;
}

function questGmTruth(campaign: Campaign, state: GameState, world: World): string[] {
  const locName = (id: string): string => world.locations.find((l) => l.id === id)?.name ?? id;
  const itemName = (id: string): string => world.items.find((i) => i.id === id)?.name ?? id;
  const lines: string[] = [];
  for (const quest of campaign.quests) {
    if (state.quests[quest.id] !== "active") continue;
    const sites: string[] = [];
    for (const ev of campaign.events ?? []) {
      const ticks = ev.effects.some((e) => e.kind === "setObjectiveDone" && e.questId === quest.id);
      if (!ticks) continue;
      const at = ev.trigger.allOf.find((c): c is Extract<Condition, { kind: "atLocation" }> => c.kind === "atLocation");
      if (!at) continue;
      const needs = ev.trigger.allOf.find((c): c is Extract<Condition, { kind: "hasItem" }> => c.kind === "hasItem");
      sites.push(`${locName(at.locationId)}${needs ? ` (needs the ${itemName(needs.itemId)})` : ""}`);
    }
    if (sites.length === 0) continue;
    lines.push(
      `QUEST TRUTH — "${quest.name}" (GM eyes only): its objectives really resolve at ${[...new Set(sites)].join("; ")}. ` +
        `Every lead, direction, or rumor you or any NPC give about this quest MUST point toward those real places. ` +
        `NEVER invent an alternative site, wreck, cache, or copy of the objective item — a discovery anywhere else ` +
        `cannot satisfy the claim, and sending the player there is a false trail. If an invented scene threatens to ` +
        `contain the objective, have it come up empty and steer toward the real site instead.`,
    );
  }
  return lines;
}

/**
 * The `Roads:` line — every authored way out of here with its real travel time, rounded to the
 * nearest quarter-hour and rendered in hours ("Thornwick — 6h east"). Returns null when no exit
 * carries `minutes`, so a world that never authored travel times keeps a byte-identical brief.
 */
function roadsLineOf(loc: Location | undefined): string | null {
  const rows = (loc?.exits ?? [])
    .filter((e) => !e.hidden && typeof e.minutes === "number" && e.minutes > 0)
    .map((e) => {
      const hours = Math.round(((e.minutes as number) / 60) * 4) / 4;
      const time = hours >= 1 ? `${hours}h` : `${Math.round(e.minutes as number)}min`;
      return `${e.name ?? e.to} — ${time}${e.direction ? ` ${e.direction}` : ""}`;
    });
  return rows.length > 0 ? `Roads: ${rows.join("; ")}` : null;
}

/** How many DESCRIBED canon rows a brief carries before the rest fall back to names-only. */
const CANON_DESCRIBED_CAP = 24;
/** Longest a canon row's role phrase may run before it is cut at a word boundary. */
const CANON_ROLE_MAX = 64;

/**
 * The head of a role phrase — its identity, without the colour.
 *
 * Authored `socialRole` text runs to a full editorial sentence ("the toll-lord of Umberwick —
 * self-styled, unelected, obeyed"). The registry needs what the person IS so an NPC speaking of them
 * cannot invent a trade; the rest is prose the narrator will write better itself, and across a
 * 60-name roster it was the single largest block in the brief.
 */
function canonRoleOf(npc: { socialRole?: string; summary?: string }): string {
  const raw = (npc.socialRole ?? (npc.summary ?? "").split(/(?<=[.;—])\s/)[0] ?? "").trim();
  const clause = /^(.*?)(?:,| — |; )/.exec(raw)?.[1]?.trim() ?? raw;
  const head = clause.replace(/[.;,]$/, "");
  if (head.length <= CANON_ROLE_MAX) return head;
  const cut = head.slice(0, CANON_ROLE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > CANON_ROLE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The canon-name registry — every name the world has already spent, so the narrator can never mint
 * an incidental character on top of a real one.
 *
 * The bug it answers (r2 P1): the narrator invented a girl and named her Tamsin; every later NPC
 * reply grounded that name to the real, male Tamsin, voiding two days of play. So completeness of
 * the NAME list is the load-bearing property — a name missing from here is a name free to be reused.
 *
 * It is rendered in two tiers because the two jobs it does have different appetites. Preventing
 * reuse needs only the name. Keeping what an NPC SAYS about someone consistent (see the paired rules
 * in `dm.buildSystemPrompt`) needs the role — but only for people this scene could plausibly discuss:
 * whoever is in this region, plus anyone the transcript is already talking about. Everyone else is
 * listed by name under a rail that says plainly they are unknown here, which is what the "no false
 * trails" rule wanted from those rows anyway. On the shipped world this is ~68% smaller than the flat
 * list it replaces, and unlike that list it truncates nothing.
 *
 * Spawn-only crowd templates are excluded ({@link isRosteredNpc}) — a generic label is not a name the
 * world ever introduced, and listing it would tell the narrator that "Coast Farmhand" is a person.
 */
function canonNameBlock(
  world: World,
  opts: { presentNames: ReadonlySet<string>; region: string | null; salientText: string },
): string[] {
  const rosterRegion = new Map<string, string | undefined>();
  for (const l of world.locations) for (const id of l.npcs) if (!rosterRegion.has(id)) rosterRegion.set(id, l.region);
  const haystack = opts.salientText.toLowerCase();

  const described: string[] = [];
  const bare: string[] = [];
  for (const npc of world.npcs ?? []) {
    if (!isRosteredNpc(world, npc)) continue;
    const name = npc.name.trim();
    if (opts.presentNames.has(name.toLowerCase())) continue; // `Present:` already establishes them
    const near = opts.region !== null && rosterRegion.get(npc.id) === opts.region;
    const discussed = haystack.includes(name.toLowerCase());
    if ((near || discussed) && described.length < CANON_DESCRIBED_CAP) {
      const role = canonRoleOf(npc);
      described.push(`- ${name}${npc.sex ? ` (${npc.sex})` : ""}${role ? ` — ${role}` : ""}`);
    } else {
      bare.push(name);
    }
  }
  if (described.length === 0 && bare.length === 0) return [];
  return [
    `# CANON NAMES (already taken — never reuse one for a character you invent)`,
    `A row with a role is an established person you may describe. A name on the "Also taken" line is`,
    `real but UNKNOWN here — never invent a trade, a history, or whereabouts for one.`,
    ...described,
    // ` · ` rather than a comma: several authored names contain their own commas ("Osric, the
    // Tithe-Clerk"), and a comma-joined list would split them into two people.
    ...(bare.length > 0 ? [`Also taken (unknown here): ${bare.join(" · ")}`] : []),
    ``,
  ];
}

/**
 * Everything the brief's registered blocks select from — computed once by the builder.
 *
 * The registries below only ORDER and SELECT; they never compute. That split is deliberate: it keeps
 * the registry a pure statement of layout, so moving a block is provably a layout change and not a
 * semantic one, and it keeps every derivation exactly where it already lived and was tested.
 */
interface BriefParts {
  input: ContextInput;
  /** Set when this brief is projected for an NPC observer rather than the GM (Phase 2). */
  npcAudience: ContextAudience | undefined;
  observerRecord: { ids: Set<string>; partyMember: boolean } | undefined;
  lines: Record<string, string | null>;
  blocks: Record<string, string[]>;
  action: Record<string, string>;
}

/** One `Label:` line in the `# LOCATION` stack. Renders zero or more lines; empty ⇒ zero bytes. */
export interface BriefLineSpec {
  /**
   * The literal prefix this line renders with. Used as the block's stable identity and, in the
   * ordering spec, to find it in an assembled brief. A line with no fixed prefix declares the
   * closest thing it has; the spec skips any key it cannot locate rather than guessing.
   */
  key: string;
  render(parts: BriefParts): string[];
}

/**
 * Which side of the guard's cut point a block sits on.
 *
 * `# NOW` is where `src/llm/guarded-gateway.ts` cuts the input screen: everything from it onward is
 * the CURRENT ACTION and is screened; everything before it is surrounding transcript and lore, which
 * must not be over-blocked. So this is not a cosmetic ordering field — a block that drifts across
 * the cut changes what the minor-safety guard examines. `tests/brief-registry.test.ts` pins it.
 */
export type BriefRegion = "grounding" | "action";

/** One `# HEADER` block in the grounding region (between `# YOU` and `# RECENT`). */
export interface BriefBlockSpec {
  key: string;
  region: "grounding";
  render(parts: BriefParts): string[];
}

/** One `===` block in the screened current-action region. Concatenated, so "" costs zero bytes. */
export interface BriefActionSpec {
  key: string;
  region: "action";
  render(parts: BriefParts): string;
}

/**
 * The `# LOCATION` line-stack, in render order.
 *
 * This is the part of the brief that accretes: fifteen optional lines have been added to it over as
 * many playtests, each one a fix for prose contradicting state. Declaring the order here rather than
 * inline in a 50-element array literal is what makes "where does `Attire:` go" a one-line answer.
 */
export const LOCATION_LINES: readonly BriefLineSpec[] = [
  { key: "(GM: the", render: (p) => p.blocks.takenProps ?? [] },
  { key: "Exits:", render: (p) => [p.lines.exits!] },
  { key: "Roads:", render: (p) => (p.lines.roads ? [p.lines.roads] : []) },
  { key: "Local guild", render: (p) => (p.lines.localGuild ? [p.lines.localGuild] : []) },
  { key: "Nearby:", render: (p) => (p.lines.nearby ? [p.lines.nearby] : []) },
  { key: "Present:", render: (p) => [p.lines.present!] },
  { key: "Not present", render: (p) => (p.lines.absent ? [p.lines.absent] : []) },
  { key: "Party", render: (p) => [p.lines.party!] },
  { key: "Time:", render: (p) => [p.lines.time!] },
  { key: "Ambience:", render: (p) => (p.lines.ambience ? [p.lines.ambience] : []) },
  { key: "This camp lies just outside", render: (p) => (p.lines.campAnchor ? [p.lines.campAnchor] : []) },
  { key: "The party is ABED", render: (p) => (p.lines.abedAnchor ? [p.lines.abedAnchor] : []) },
  { key: "Exertion:", render: (p) => (p.lines.exertion ? [p.lines.exertion] : []) },
  { key: "Attire:", render: (p) => (p.lines.attire ? [p.lines.attire] : []) },
  { key: "Visibly:", render: (p) => (p.lines.visibly ? [p.lines.visibly] : []) },
  { key: "Body:", render: (p) => (p.lines.body ? [p.lines.body] : []) },
  { key: "You carry:", render: (p) => p.blocks.kit ?? [] },
];

/**
 * Which turn a scene owns, for the per-scene narrator (#8). Pure over the projection state — the
 * same slices (and the same precedence) the scene-narrowed classifier reads, so the GM stance, the
 * classifier schema, and the scene registry can never disagree about whose turn it is.
 * `undefined` = free play, and every consumer is omit-when-absent (byte-identical briefs/prompts).
 */
export function narrationSceneOf(state: GameState): NarratorScene | undefined {
  const modules = (state.modules ?? {}) as Record<string, Record<string, unknown> | undefined>;
  if (modules.combat?.active === true) return "combat";
  if (modules.captivity?.active === true) return "captivity";
  if (state.partyLocationId === LODGING_LOCATION_ID) return "lodging";
  return undefined;
}

/**
 * Grounding blocks a live scene DROPS from the brief (#8, `NEXT_GAME_MASTER`'s other half: a
 * combat GM does not need the gazetteer). Dropping is the only legal per-scene brief edit — the
 * headers themselves are a tested contract and never change. Keys must match `GROUNDING_BLOCKS`.
 *
 * The heaviest win is `# CANON NAMES` (~20% of every narrator brief): it exists so prose minting a
 * NEW character cannot steal a canon name — and the scenes dropping it are exactly the ones where
 * `ProseEntityModule` refuses to mint anyway (combat) or the cast is fixed by the scene itself
 * (captivity). Lodging drops nothing: a quiet inn turn still introduces people.
 */
export const SCENE_BLOCK_DROPS: Record<NarratorScene, ReadonlySet<string>> = {
  combat: new Set(["# STORY SO FAR", "# PRIOR NPC CLAIMS", "# CANON NAMES", "# STANDING DEALS", "# CASE", "# FACTION STANDING"]),
  captivity: new Set(["# CANON NAMES", "# STANDING DEALS", "# CASE", "# FACTION STANDING"]),
  lodging: new Set<string>(),
};

/**
 * The grounding-region blocks, in render order — everything between the `# YOU` self block and
 * `# RECENT`. Every one is omit-when-empty: a world that never uses a block adds zero bytes for it,
 * which is what has kept the header contract byte-stable while the list grew to eight.
 */
export const GROUNDING_BLOCKS: readonly BriefBlockSpec[] = [
  { key: "# STORY SO FAR", region: "grounding", render: (p) => p.blocks.story ?? [] },
  { key: "# PRIOR NPC CLAIMS", region: "grounding", render: (p) => p.blocks.established ?? [] },
  { key: "# CANON NAMES", region: "grounding", render: (p) => p.blocks.canonNames ?? [] },
  { key: "# THE RECORD", region: "grounding", render: (p) => p.blocks.record ?? [] },
  { key: "# STANDING DEALS", region: "grounding", render: (p) => p.blocks.standingDeals ?? [] },
  { key: "# CASE", region: "grounding", render: (p) => p.blocks.case ?? [] },
  { key: "# FACTION STANDING", region: "grounding", render: (p) => p.blocks.factionStanding ?? [] },
];

/**
 * The current-action blocks, in render order — everything after `# NOW`, the trigger, and the
 * resolved verdict.
 *
 * These are CONCATENATED rather than joined, so a block that renders "" adds no newline either. Each
 * carries its own leading `\n\n`, which is why an empty one is exactly zero bytes.
 */
export const ACTION_BLOCKS: readonly BriefActionSpec[] = [
  { key: "=== NPC ACTIONS THIS TURN", region: "action", render: (p) => p.action.turnOutcome ?? "" },
  { key: "=== ALREADY HAPPENING THIS TURN", region: "action", render: (p) => p.action.turnEvents ?? "" },
  { key: "=== OVERHEARD", region: "action", render: (p) => p.action.overheard ?? "" },
  { key: "=== SOCIAL READ", region: "action", render: (p) => p.action.socialReads ?? "" },
  { key: "=== CONSEQUENCES", region: "action", render: (p) => p.action.consequences ?? "" },
  { key: "=== TURN FACTS", region: "action", render: (p) => p.action.turnFacts ?? "" },
];

export function buildNarrationContext(input: ContextInput): NarrationContext {
  const { world, state } = input;
  // The owning scene (#8): computed ONCE, drives both the grounding-block drops below and the
  // narrator stance (returned on the context). Free play ⇒ undefined ⇒ byte-identical output.
  const scene = narrationSceneOf(state);
  const view = new WorldView(world, input.campaign, state);
  const loc = view.location();
  const locName = loc?.name ?? view.partyLocationId();

  // Audience projection (Phase 2): every narrowing below hangs off this ONE flag, so the GM brief
  // (absent audience) is byte-identical to before audiences existed.
  const npcAudience = input.audience?.kind === "npc" ? input.audience : undefined;
  const observerTemplate = npcAudience
    ? world.npcs.find((n) => n.id === (npcAudience.templateId ?? npcAudience.npcId))
    : undefined;

  // Exits + presence come from the WorldModel when the caller supplies them (so they match the
  // classifier: hidden exits filtered, full registry presence). The WorldView path is the
  // fallback for callers that don't yet hold a model (and keeps the pure builder testable).
  const exits = (input.exits ?? view.exitsFrom().map((e) => e.name)).join(", ") || "none";
  // `Roads:` — what each way out actually COSTS, in hours, off the authored `Exit.minutes`. Grounding
  // only (omit-when-nothing-authored, so a world without exit times renders byte-identically).
  // r5's quest-giver priced the road "four days east by wagon, two and a half by river barge" to a
  // place two hours' walk away, and then a two-day bond was hung on it: the fiction was inventing
  // distances because nothing in the brief ever stated one.
  const roadsLine = roadsLineOf(loc);

  const renderPresence = (e: PresentEntity): string => {
    // Observer-safe presence (Phase 2): another person's authored `summary` routinely carries
    // motive, history, and exploitative subtext no bystander could READ off them — an NPC audience
    // gets only the observable surface (looks/activity/wounds/party status). The GM keeps the
    // full row: it narrates FROM that subtext.
    const summary = e.summary && !npcAudience ? ` — ${e.summary}` : "";
    const s = (e.sex ?? "").trim().toLowerCase();
    const pron = s === "female" ? " (she/her)" : s === "male" ? " (he/him)" : "";
    const act = e.activity ? ` (${e.activity})` : "";
    const active = e.activeConditions && e.activeConditions.length > 0 ? ` {${e.activeConditions.join(", ")}}` : "";
    // Role marker: a party companion travels WITH the player; a "(local)" is ambient background that
    // does NOT travel with the party and may drift off. Everything else (authored NPCs, foes) is
    // unmarked and persists until the engine moves it. Rows with neither flag render byte-identically.
    const role = e.partyMember ? " (with you)" : e.local ? " (local)" : "";
    // Danger telegraph: weave the menace into the scene so a cautious player can READ the gulf
    // before it is fatal (r2 P1: nothing distinguished a 6× foe from a mystery light).
    const threat = e.threat ? ` ⚠ ${e.threat} — let the scene telegraph this menace` : "";
    // The held look: when the world authored one, the narrator describes THIS person — never a
    // re-improvised face (r6 P2).
    const looks = e.looks ? ` Looks (held — describe exactly this): ${e.looks}` : "";
    return `${e.name}${pron}${role}${summary}${looks}${act}${e.band ? ` [${e.band}]` : ""}${active}${threat}`;
  };
  const presentRows: PresentEntity[] =
    input.present ??
    view.actorsAt().map((id) => ({
      id,
      name: view.name(id),
      summary: view.npcSummary(id) || undefined,
      band: view.hpBand(id) || undefined,
    }));
  const present =
    presentRows.map(renderPresence).join("; ") ||
    "(only you — you are ALONE here; no other character is present)";
  // Authoritative negative anchor: authored NPCs still echoing in # RECENT / # STORY SO FAR who are
  // NOT actually here. Naming them kills the momentum hallucination at the source. The recent
  // transcript is rendered once below (`recentText`) and reused so this costs no extra scan.
  const recentText = transcript(input, view);
  const absentNames = absentReferencedNames(input.world, presentRows, recentText, input.storySoFar);
  const absentLine =
    absentNames.length > 0
      ? `Not present (elsewhere — do NOT depict as here, speaking, or acting): ${absentNames.join(", ")}`
      : "";
  // Authoritative party roster (code-truth from `partyMember`), re-asserted EVERY turn so a stale
  // rolling summary or a prior prose slip can never define who travels with the player. A present row
  // that is not named here is NOT a companion — in particular the ambient "(local)" crowd, which the
  // narrator must never carry along as an escort.
  const companionNames = presentRows.filter((e) => e.partyMember).map((e) => e.name);
  const partyLine =
    companionNames.length > 0
      ? `Party (these and ONLY these travel with you): ${companionNames.join(", ")} — they are visibly at the player's side; no one in the scene may call the player alone or unaccompanied.`
      : `Party: you travel ALONE — no one here is your companion (any "(local)" present is passing background, not party)`;

  const resolvedBlock = input.resolved ? `\n\n${renderResolvedBlock(input.resolved)}` : "";
  // Executed NPC beats (Workstream C slim) join the same current-action region: authoritative
  // fact the GM weaves, screened with the action. Omitted when empty — byte-identical briefs.
  const turnOutcomeBlock =
    input.turnOutcome && input.turnOutcome.length > 0 ? `\n\n${renderTurnOutcomeBlock(input.turnOutcome)}` : "";
  // Environmental beats already shown this tick (before the GM's last-word prose): a stay-consistent
  // block so the GM cannot contradict a beat it never saw. Omitted when empty — byte-identical.
  const turnEventsBlock =
    input.turnEvents && input.turnEvents.length > 0 ? `\n\n${renderTurnEventsBlock(input.turnEvents)}` : "";
  // The offstage rumor that reached this room (r11 F-12) — the GM's to weave, not a printed beat.
  // Omitted when there is none, so every ordinary turn's brief is byte-identical.
  const overheardBlock =
    input.overheard && input.overheard.text.trim().length > 0 ? `\n\n${renderOverheardBlock(input.overheard)}` : "";
  // Social reads (Workstream F follow-up): a tone-only cue joining the same screened current-action
  // region. Omitted when empty — byte-identical briefs; only the GM's brief ever carries it.
  const socialReadsBlock =
    input.socialReads && input.socialReads.length > 0 ? `\n\n${renderSocialReadsBlock(input.socialReads)}` : "";
  // Consequences bound this turn (Phase 3): authoritative outcome lines the narrator must reflect,
  // each backed by a real ledgered command so the Continuity Judge converges. Same screened current-
  // action region; omitted when empty — byte-identical briefs for every non-consequence turn.
  const consequencesBlock =
    input.consequences && input.consequences.length > 0 ? `\n\n${renderConsequencesBlock(input.consequences)}` : "";
  // Turn facts (the authorized-command ledger, rendered): the narrator's positive ground truth for
  // what ACTUALLY changed this turn. Same screened current-action region; omitted when empty —
  // byte-identical briefs for every turn with no player-salient change.
  const turnFactsBlock =
    input.turnFacts && input.turnFacts.length > 0 ? `\n\n${renderTurnFactsBlock(input.turnFacts)}` : "";

  // Relevant lore (read-only retrieval, M4) sits AFTER `# RECENT` and BEFORE `# NOW` — grounding
  // context, NOT the current action, so the guard's `# NOW` cut point is unchanged and the section
  // is not over-screened. Emitted ONLY when there is at least one hit; otherwise nothing is added,
  // so a no-lore world / no-hit turn yields a byte-identical brief.
  const loreLines = input.lore && input.lore.length > 0 ? [`# RELEVANT LORE`, ...input.lore, ``] : [];

  // The campaign rolling-summary (M4 follow-up) sits in the grounding region — after `# LOCATION`,
  // BEFORE `# NOW` — so the guard's `# NOW` cut point is unchanged and it isn't over-screened. It is
  // a best-effort derived cache, NOT source of truth. Emitted ONLY when a non-empty summary exists;
  // otherwise nothing is added, so a no-summary campaign's brief is byte-identical to before.
  // The rolling summary is an omniscient narrator digest — GM grounding only. No NPC brief
  // currently passes one, but the gate is structural (Phase 2): a character can never receive
  // the whole campaign's story as its own knowledge.
  const storyLines =
    input.storySoFar && input.storySoFar.trim().length > 0 && !npcAudience
      ? [`# STORY SO FAR`, input.storySoFar.trim(), ``]
      : [];

  // The disclosure ledger (prior claims NPCs have voiced) sits beside `# STORY SO FAR` in the
  // grounding region — before `# NOW`, so the guard cut point is unchanged. A best-effort derived
  // cache; emitted ONLY when non-empty, so a world where no NPC has asserted a fact is byte-identical.
  const establishedLines =
    input.established && input.established.length > 0
      ? [
          `# PRIOR NPC CLAIMS (speaker continuity only — NOT authoritative world truth)`,
          ...input.established.map((f) => `- ${f}`),
          ``,
        ]
      : [];

  // The PC's standing with the world's factions (living faction system) sits in the grounding region
  // beside `# STORY SO FAR` — before `# NOW`, so the guard cut point is unchanged. It grounds the GM
  // (and any NPC decide brief that shares this builder) in who the PC is allied with or hated by.
  // Emitted ONLY when the PC has moved a standing off zero, so a factionless / fresh world is
  // byte-identical to before the block existed.
  // The world's ledger of taken/settled quests — rendered into the brief AND carried on the returned
  // context so the Continuity Judge screens against exactly the rows this brief contained. An NPC
  // audience receives only the rows it participated in (gave, walked, ran, or dealt — Phase 2).
  const observerRecord = npcAudience
    ? {
        ids: new Set([npcAudience.npcId, npcAudience.templateId ?? npcAudience.npcId]),
        partyMember: presentRows.some((p) => p.id === npcAudience.npcId && p.partyMember === true),
      }
    : undefined;
  const recordLines = recordBriefLines(input.campaign, state, world, observerRecord);
  // Faction standing is reputation-as-perceived: the GM reads all of it; an NPC reads only how the
  // PC stands with its OWN faction (a factionless observer reads none — Phase 2).
  const factionLines = state.party[0]
    ? npcAudience
      ? observerTemplate?.factionId
        ? factionStandingLines(state.modules, world, state.party[0], observerTemplate.factionId)
        : []
      : factionStandingLines(state.modules, world, state.party[0])
    : [];
  const factionStandingBlock = factionLines.length > 0 ? [`# FACTION STANDING`, ...factionLines, ``] : [];

  // The `Nearby:` line (gazetteer breadcrumbs) sits INSIDE the `# LOCATION` block, directly after
  // `Exits:` — grounding, far before the guard's `# NOW` cut point. Emitted ONLY when the world
  // authors gazetteer entries; otherwise nothing is added, so every pre-gazetteer world's brief is
  // byte-identical to before the line existed (the tested header contract is untouched). Entries
  // the party has actually reached (realized by expansion AND arrived at — the durable expansion
  // slice plus the arrival world flag) render ", known"; a place they've never seen stays hearsay.
  const nearbyLine = nearbyLineOf(world, knownGazetteerIdsOf(state));
  // `Location.guild` is the job-board authority, so surface that same authored hall as authoritative
  // local knowledge for every narrator/NPC brief. This prevents retrieved faction lore from being
  // spliced onto a plausible nearby exit when the player asks for "a guild".
  const localGuildLine = localGuildLineOf(world, loc?.id ?? null);
  // The `Ambience:` line (region crowd cue) sits inside `# LOCATION`, after `Time:` — grounding, far
  // before the `# NOW` cut. Null (nothing added) for an unregioned/neutral place ⇒ byte-identical.
  const ambienceLine = ambienceLineOf(world, loc?.id ?? null, state.clock);
  // Camped: anchor the synthetic Camp room to its real origin (r4 P1 — an unanchored camp brief
  // let the narrator invent a road east and a six-day itinerary while the map read the Undercroft).
  // Omit-when-not-camped ⇒ every non-camp brief stays byte-identical.
  const campReturnId = (state.modules?.camp as { returnLocationId?: string | null } | undefined)?.returnLocationId;
  const campReturnName = campReturnId ? world.locations.find((l) => l.id === campReturnId)?.name : undefined;
  const campAnchorLine =
    view.partyLocationId() === CAMP_LOCATION_ID && campReturnName
      ? `This camp lies just outside ${campReturnName}; the party has NOT traveled — the roads are as they were.`
      : null;
  // Abed: the same anchoring for a rented room, and the same reason. r5 played an entire in-world
  // day out of a bunk because the prose kept walking the player downstairs, across the village and
  // into a sheep pen while their body — and every system that reads it — stayed in the loft.
  const lodgingSlice = state.modules?.lodging as { returnLocationId?: string | null } | undefined;
  const lodgingHallName = lodgingSlice?.returnLocationId
    ? world.locations.find((l) => l.id === lodgingSlice.returnLocationId)?.name
    : undefined;
  const abedAnchorLine =
    view.partyLocationId() === LODGING_LOCATION_ID
      ? `The party is ABED in this rented room${lodgingHallName ? ` at ${lodgingHallName}` : ""}. They have not left it: do not narrate them going downstairs, out into the street, or anywhere else, and do not stage this scene outside this room. Getting up is their own next choice to make.`
      : null;
  const pcId = state.party[0];
  const exertionLine = exertionLineOf(pcId ? state.actors[pcId]?.exhaustion : undefined);
  const wardrobeSlice = state.modules?.[WARDROBE_MODULE] as WardrobeSlice | undefined;
  // Occupancy from the authored appearance prose (derived in src/rules/visible-state.ts, the one
  // shared derivation): a PC who canonically wears two garments reads "bare" once THOSE two are
  // removed — the four slots they never dress can't pin the state at "disheveled" forever.
  const pcCharacter = pcId ? input.campaign.characters.find((c) => c.id === pcId) : undefined;
  const occupied = occupiedCoverageOf(pcCharacter);
  const attireLine = attireLineOf(pcId ? wardrobeSlice?.[pcId] : undefined, occupied);
  // The `Visibly:` line (non-attire visible facts — active status effects with a narrative phrase)
  // sits directly after `Attire:` inside `# LOCATION`: grounding, far before the guard's `# NOW`
  // cut point, so screening is unchanged. Omitted when nothing is visible — byte-identical briefs.
  const visiblyLine = visiblyLineOf(pcId ? visibleStateOf(state, pcId, pcCharacter) : []);
  // The `Body:` line carries stable physical features. It is rendered only when someone is present
  // to perceive them; clothing remains a separate live-state line.
  const observerBody =
    presentRows.length > 0 && pcCharacter
      ? describeBody(pcCharacter.body)
      : "";
  const bodyLine = observerBody ? `Body: ${observerBody}` : "";

  // Stage 1 self-perception (`# YOU` + `Adjacent:`): ONLY the autonomy module's NPC decide brief
  // ever passes `self` — the GM/player brief never does, so `selfBlock` is null there and this
  // adds ZERO bytes, keeping the tested header contract byte-stable.
  const selfBlock = input.self ? renderSelfBlock(world, input.self) : null;

  // The player's real kit (finding #5) — an omit-when-empty line pair so the GM can't invent an
  // inventory that contradicts the sheet. Reads the same live actor projection the sheet does; absent
  // (empty pack + no coins + nothing equipped) ⇒ zero lines, so the tested header contract is byte-stable.
  // NPC audiences see only the visible kit (equipped/worn) — never the pack or the purse (Phase 2).
  const kitLines = pcId ? playerKitLines(world, state.actors[pcId], { visibleOnly: !!npcAudience }) : [];

  // Canon-name registry (r2 P1 "Tamsin"): the narrator once borrowed a REAL NPC's name for an
  // invented character — a girl who never existed — and every later NPC reply grounded the name to
  // the real (male) Tamsin, voiding two days of play. Pin every authored name to its owner so prose
  // reuse is impossible-by-instruction (the paired Hard rule lives in dm.buildSystemPrompt).
  // PRESENT NPCs are omitted (the Present: line already establishes them); omit-when-empty keeps the
  // tested header contract byte-stable for worlds with no off-scene roster.
  const presentNameSet = new Set(presentRows.map((p) => p.name.trim().toLowerCase()));
  // GM briefs only (`input.self` marks an NPC decide brief, `npcAudience` any NPC-projected brief).
  // The old justification — "an NPC does not invent named characters" — is DISPROVEN (r13: NPC
  // replies minted "Corin", "Solen's", and "Sable Jenkins" as findable leads); the roster block
  // still stays GM-only for the token cost and because it would leak the whole world roster into
  // one character's knowledge. The NPC-side defense is the no-false-findable-leads rail in
  // npc.buildSystemPrompt + INTENT_JSON_INSTRUCTION, backed by the engine's deterministic
  // phantom-addressee answer (plan.targetName).
  const canonNameLines =
    input.self || npcAudience
      ? []
      : canonNameBlock(world, {
          presentNames: presentNameSet,
          region: loc?.region ?? null,
          // Anyone the scene is already talking about earns a described row even from far away:
          // the turn is about them, so their identity is exactly what must not be improvised.
          salientText: `${recentText}\n${input.storySoFar ?? ""}\n${(input.established ?? []).join("\n")}`,
        });

  // Everything the registries select from. They order and select; they never compute — see BriefParts.
  const parts: BriefParts = {
    input,
    npcAudience,
    observerRecord,
    lines: {
      exits: `Exits: ${exits}`,
      roads: roadsLine,
      localGuild: localGuildLine,
      nearby: nearbyLine,
      present: `Present: ${present}`,
      absent: absentLine || null,
      party: partyLine,
      time: timeLineOf(state.clock),
      ambience: ambienceLine,
      campAnchor: campAnchorLine,
      abedAnchor: abedAnchorLine,
      exertion: exertionLine,
      attire: attireLine,
      visibly: visiblyLine,
      body: bodyLine || null,
    },
    blocks: {
      takenProps: takenPropLines(input.campaign, world, state, loc?.id ?? null),
      kit: kitLines,
      story: storyLines,
      established: establishedLines,
      canonNames: canonNameLines,
      // The ledger goes BEFORE `# NOW`, so it grounds without being over-screened by the cut point.
      record: recordLines,
      // Standing deals ride directly after the record, same region and same participation filter: an
      // open obligation is grounding for what happens next, not part of the current action (§2.2).
      standingDeals: standingDealsLines(state, observerRecord),
      // The `# CASE` block is the PLAYER's established evidence — narrator authority. An NPC brief
      // must never inherit it (plan §4.6): the character's own case view is `caseBriefForNpc`,
      // appended by the dialogue/autonomy callers as `# THE CASE AS YOU KNOW IT`.
      case: npcAudience ? [] : caseBriefLines(input.campaign, state),
      factionStanding: factionStandingBlock,
    },
    action: {
      turnOutcome: turnOutcomeBlock,
      turnEvents: turnEventsBlock,
      overheard: overheardBlock,
      socialReads: socialReadsBlock,
      consequences: consequencesBlock,
      turnFacts: turnFactsBlock,
    },
  };

  // The SPINE — the frame the registries hang off. Deliberately not itself a registry: `# WORLD`,
  // the `# LOCATION` header, `# RECENT` and `# NOW` are always present and their relative order is
  // the prompt protocol other modules key on (`src/util/markers.ts`, the guard's cut point, the
  // deterministic test gateway). What accretes — and therefore what is registered — is the optional
  // material hanging between them.
  const contextText = [
    `# WORLD`,
    world.summary,
    ``,
    `# LOCATION — ${locName}`,
    loc?.description ?? "",
    ...LOCATION_LINES.flatMap((line) => line.render(parts)),
    ``,
    ...(selfBlock ? [selfBlock, ``] : []),
    // Per-scene brief slimming (#8): a live scene DROPS whole grounding blocks (never edits one) —
    // free play renders every block, byte-identical to before scenes existed.
    ...GROUNDING_BLOCKS.filter((block) => !scene || !SCENE_BLOCK_DROPS[scene].has(block.key)).flatMap((block) =>
      block.render(parts),
    ),
    `# RECENT`,
    recentText,
    ``,
    // Retrieved lore sits AFTER `# RECENT` and BEFORE `# NOW` — grounding, but downstream of the
    // transcript it is meant to gloss, so it is part of the spine rather than the grounding stack.
    ...loreLines,
    BRIEF_MARKERS.now,
    input.trigger,
    resolvedBlock,
    // Concatenated (not a new join element): an empty block must add ZERO bytes to the brief.
    ACTION_BLOCKS.map((block) => block.render(parts)).join(""),
  ].join("\n");

  // `gmLore` rides on the returned context but is intentionally NOT part of `contextText` above —
  // it reaches ONLY the DM's private narrate message (dm.narrate), never the shared brief or an NPC
  // prompt. In addition to caller-supplied secret retrieval hits, the GM gets authored private PC
  // notes and present-NPC hidden lore. Omitted when all sources are empty (byte-stable no-secret).
  const gmLoreLines = [
    ...characterGmLore(input, presentRows),
    ...caseGmLore(input.campaign, state),
    ...questGmTruth(input.campaign, state, world),
    ...(input.gmLore ?? []),
  ];
  const gmLore = gmLoreLines.length > 0 ? gmLoreLines : undefined;
  // Layer-2 cast guard: the authoritative present roster + the momentum-drift risks (absent NPCs
  // still echoing in the transcript). Carried on the context so `narrateGuarded` can verify-and-
  // regenerate without recomputing. `absent` empty ⇒ no risk ⇒ the turn streams normally.
  const castGuard = { present: presentRows.map((p) => p.name), absent: absentNames };
  // Canonical pronouns of the present cast (r3 P3: Oda "she" for a beat) — the Judge's
  // pronoun-drift ground truth. Only rows with an authored sex; omit-when-empty.
  const presentPronouns = presentRows
    .map((p) => {
      const s = (p.sex ?? "").trim().toLowerCase();
      return s === "female" ? `${p.name} (she/her)` : s === "male" ? `${p.name} (he/him)` : null;
    })
    .filter((line): line is string => line !== null);
  // The Continuity Judge reads its ground truth from the RETURNED context (single source of truth),
  // not a blind `ctx.data` peek — so a caller that omits these (e.g. combat's own narrate site) is
  // verified against exactly what its own brief contained, never flagged for a line it never carried.
  return {
    contextText,
    trigger: input.trigger,
    resolved: input.resolved,
    gmLore,
    castGuard,
    ...(presentPronouns.length > 0 ? { presentPronouns } : {}),
    beats: input.turnOutcome,
    established: input.established,
    // Only the fact rows (the header + rail are prompt scaffolding the Judge does not need).
    ledger: recordLines.filter((l) => l.startsWith("- ") || l.startsWith("  · ")),
    // The owning scene (#8) rides the context so `dm.narrate` picks its stance from the SAME
    // derivation that just slimmed the brief. Omit-when-free.
    ...(scene ? { scene } : {}),
  };
}
