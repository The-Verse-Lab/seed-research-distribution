/**
 * Action grounding — a CLOSED NPC act → a typed, legal world action.
 *
 * The model's creativity lives in *phrasing*; the world only moves through validated, legal
 * actions. An NPC agent returns a structured turn intent (src/agents/npc.ts `decideTurn`) carrying
 * an `act` in the closed {@link NpcAct} form; this pure function LOOKS THAT UP in the table of
 * actions the actor may legally take FROM ITS CURRENT STATE — speak, move (to a reachable, unlocked
 * exit), give (an item it owns to someone present), equip/unequip (an item it owns, into/out of the
 * one slot it legally fits), open a barred exit (the passive paths only — a held key or a true
 * `condition`, exactly the player's legality), pick/force a barred exit (a SEEDED skill check where
 * the passive path is closed — classified here, ROLLED in the autonomy module), rest (recover
 * energy when depleted), loot (take a named item off a DEFEATED present holder) and use a
 * consumable. The SAME table is rendered into the NPC's brief as `# CANDIDATE ACTIONS`
 * ({@link renderActCandidates}), so the model can only ever name something that was legal when the
 * beat began, and code re-checks legality here before a Command is produced.
 *
 * WHY IT IS A TABLE AND NOT A SCORER (r8 regex audit). Until this rewrite the model handed over a
 * free-text imperative and twelve hand-written keyword lists guessed the verb, with
 * `confidence = matched keywords / TOTAL tokens`. That is an intent classifier sitting on the delta
 * path (`ctx.enqueue(ground.action.command)`) — the exact machinery the Prune Wave deleted from
 * `src/` for PLAYER intent — and it was structurally inverted. Reproduced against the shipped
 * scorer on the thistledown fixture:
 *   - "I'll walk over to Emrin's Forge and hand the player the sealed letter she asked for."
 *     → 0.167, BELOW the 0.4 floor ⇒ dropped to banter, though every id in it was legal;
 *   - "Sit tight." (a line spoken TO the player) → 0.5 ⇒ committed `adjustEnergy +20`;
 *   - "trust" → 1.0 ⇒ committed `adjustRelationship` toward `present[0]`, a person the line never
 *     named (the relationship arm had a bare `target ?? present[0]` default).
 * The natural, fully-grounded sentence lost; the two-word aside won. The closed form removes the
 * guess entirely: the NPC NAMES the act from a list code built, and code still computes and
 * commits every number.
 *
 * TWO BEHAVIOURS DELIBERATELY LOST WITH THE NET. (1) `adjustRelationship` is no longer a grounded
 * verb at all: it only ever fired on a stray warm word and, with nobody named, aimed at whoever
 * happened to be `present[0]` — a wrong-target delta. Regard now moves only where a person is
 * genuinely addressed, through the dialogue path's clamped `relationshipNudge`
 * (src/modules/dialogue.ts). (2) An NPC can no longer move through a HIDDEN exit: this table is
 * prompt text, and listing a secret way would hand the model something it could speak aloud.
 *
 * NPC authority is deliberately narrow — see {@link NPC_ACT_VERBS}. An NPC can never ground into
 * setFlag / spawn / despawn: story/world structure is the GM's and the events module's job, not an
 * autonomous companion's. ONE scoped carve-out (Feature 1, {@link GroundingContext}): a LEADER
 * (`leadsParty`) grounds a move into `moveParty` (the party follows) and may take up a job that is
 * ALREADY on offer (`setQuestState` offered→active) — both ride an override-able proposal, so the
 * leader only steers/opts the party in; it never authors quests or flips hidden ones. An act that
 * names nothing legal (or no act at all) falls back to `speak`, which is always legal and never
 * mutates truth — so the autonomy module is never handed an invalid mutation. (docs/PROACTIVE-NPCS §5.)
 *
 * @author Runkai Zhang
 */
import type { Character, World } from "../../content/schema.ts";
import type { Command } from "../../world/commands.ts";
import { barrierDescription } from "../../rules/exit-state.ts";
import { energyOf, maxEnergyOf } from "../../rules/costs.ts";
import { isConsumable, itemDisplayNameOf, itemFitsSlot, resolveItem, type ResolvedItem } from "../../rules/items.ts";
import { NPC_ACT_VERBS, type NpcAct } from "../../rules/npc-act.ts";
import type { Entity, EquipSlot } from "../../world/entity.ts";
import { canReach, exitsFrom } from "../../world/map.ts";
import { isFrontierId } from "../../world/expansion.ts";
import { entitiesAt, type WorldModel } from "../../world/model.ts";
import { regionOfLocation } from "../../rules/regions.ts";
import { barredExitsAt, type ExitVerdict } from "../../world/traversal.ts";
import { evalPredicate, standardEvalLookups } from "../events/module.ts";

/**
 * The split point the dropped-action telemetry classifies on (`groundingFallbackReason`). With the
 * closed form there is no scoring left to fall below a floor: a grounded act is confidence 1, an
 * act that named something illegal is confidence 1 (⇒ reported as `illegal`), and "the NPC named no
 * act at all" is confidence 0 (⇒ not a drop — pure conversation). Kept as the published constant so
 * the telemetry contract in `src/logging/types.ts` is unchanged.
 */
export const GROUNDING_THRESHOLD = 0.4;

/**
 * A grounded NPC action. Speech is NOT a Command (it mutates no truth — it is an emitted dialogue
 * event), so it is its own variant; every world-mutating outcome carries a reducer `Command`.
 * The speak variant carries no text on purpose: the grounder never sees the NPC's prose any more,
 * and the autonomy module has always displayed `spokenLineOf(visibleSpeech)` instead.
 */
export type GroundedAction =
  | { kind: "speak" }
  | { kind: "command"; command: Command }
  /**
   * A barrier skill-check the actor ATTEMPTS (Stage 2b): pick a lock (dex vs `dc`) or force an
   * obstacle (str vs `breakDc`). Grounding CLASSIFIES it only — pure, no rolling; the autonomy
   * module rolls it with the seeded RNG (`resolveBarrierAttempt`) and, on success, enqueues the
   * `setExitState` that opens ("open") or breaks ("broken") the way. Carries everything the module
   * needs so it never re-derives content: the DC, the obstacle's words, and the destination name.
   */
  | {
      kind: "barrierAttempt";
      verb: "pick" | "force";
      ability: "dex" | "str";
      locationId: string;
      to: string;
      dc: number;
      barrierDesc: string;
      destName: string;
    }
  /**
   * A consumable the actor USES on itself (Feature 1d): drink a healing draught / eat a ration.
   * Like `barrierAttempt`, grounding only CLASSIFIES it — the seeded heal roll + the consume
   * transfer live in the autonomy module (`resolveItemUse`), so grounding stays pure.
   */
  | { kind: "consumeItem"; itemId: string };

/**
 * Optional per-actor context that unlocks the LEADER-only grounder targets (Feature 1). Absent /
 * empty ⇒ an ordinary NPC: no `moveParty`, no job acceptance. Sourced from the model + campaign by
 * the caller — grounding never reads campaign.
 */
export interface GroundingContext {
  /** The actor currently leads the party (canLeadNow) — enables `moveParty` + accept-offered-job. */
  leadsParty?: boolean;
  /** Quests visibly ON OFFER (name + id), so a leader can ground `take_job` → setQuestState. */
  offeredQuests?: { id: string; name: string }[];
  /**
   * The campaign's character sheets, for the ONE thing predicate evaluation needs them for: the
   * attire-occupancy baseline an `attireState` barrier condition is judged against
   * ({@link standardEvalLookups}). Omitted ⇒ that clause falls back to the conservative all-slots
   * read, which is the pre-2026-07-28 behaviour and is why it is optional rather than required —
   * every PRODUCT caller (autonomy/module.ts) passes it.
   */
  characters?: readonly Character[];
}

export interface GroundingResult {
  action: GroundedAction;
  /** 1 when the NPC named an act (grounded or illegal), 0 when it named none — see GROUNDING_THRESHOLD. */
  confidence: number;
  /** True when the safe `speak` fallback was used (no act named, or the act named nothing legal). */
  fellBack: boolean;
}

/** One legal target the NPC may name: the id it must copy verbatim, plus words for the brief. */
export interface ActTarget {
  id: string;
  label: string;
}

/**
 * Everything `actorId` may legally do RIGHT NOW, one group per verb. Built from the world model
 * only (never from free text) and used for BOTH halves of the closed loop: rendered into the NPC's
 * brief so the model can name an act, and looked up again at ground time so a stale or invented id
 * can never become a delta.
 */
export interface ActCandidates {
  /** Destinations reachable through an unlocked, non-frontier exit. */
  move: ActTarget[];
  /** Items the actor owns and could hand over (needs at least one `recipient` to be usable). */
  give: ActTarget[];
  /** Present entities that may receive a `give` (the act's `to`). */
  recipients: ActTarget[];
  /** Owned items that fit a slot they do not already occupy. */
  equip: (ActTarget & { slot: EquipSlot })[];
  /** Currently-worn items, with the slot each vacates. */
  unequip: (ActTarget & { slot: EquipSlot })[];
  /** Barred exits the actor can open for FREE (held key / true condition) — target is the destination. */
  open: ActTarget[];
  /** Barred exits with a lock still to pick (dex vs `dc`) and no free way through. */
  pick: (ActTarget & { dc: number; barrierDesc: string })[];
  /** Barred exits that can be forced (str vs `breakDc`) and no free way through. */
  force: (ActTarget & { dc: number; barrierDesc: string })[];
  /** Energy a rest would recover; 0 ⇒ resting is not a legal act (the actor is at its ceiling). */
  rest: number;
  /** Items on a DEFEATED present holder, with the holder each comes from. */
  loot: (ActTarget & { holderId: string; holderName: string })[];
  /** Owned consumables. */
  use: ActTarget[];
  /** Quests visibly on offer — LEADER only. */
  take_job: ActTarget[];
}

const speakFallback = (confidence: number): GroundingResult => ({
  action: { kind: "speak" },
  confidence,
  fellBack: true,
});

/** The full slot set, for resolving which slot an item legally occupies. */
const EQUIP_SLOTS: readonly EquipSlot[] = ["weapon", "armor", "shield"];

/** The one slot an item may occupy, or undefined for unequippable content (a potion, a key). */
function slotFor(item: ResolvedItem): EquipSlot | undefined {
  return EQUIP_SLOTS.find((slot) => itemFitsSlot(item, slot));
}

/** The authored display name of a location, for labelling a destination in the candidate list. */
function locationNameOf(world: World, locationId: string): string {
  return world.locations.find((l) => l.id === locationId)?.name ?? locationId;
}

/** The authored display name of an item id, for labelling it in the candidate list. */
function itemNameOf(world: World, itemId: string): string {
  return resolveItem(world, itemId)?.name ?? itemDisplayNameOf(itemId);
}

/**
 * Whether a present holder is DEFEATED — and thus lootable. The combat module sets `unconscious`
 * and drops HP to 0 on a downed foe (src/modules/combat/module.ts `afterSwing`); `queries.ts`
 * treats hp ≤ 0 as a corpse. A CONSCIOUS holder is never lootable — taking from one is theft, an
 * agenda concern, out of scope for grounding.
 */
function isDefeated(entity: Entity): boolean {
  const s = entity.stats;
  return s !== undefined && (s.currentHp <= 0 || s.conditions.includes("unconscious"));
}

/**
 * The PASSIVE open paths only, mirroring the player's legality exactly (engine
 * `resolveBarredMove`): a held `barrier.keyItemId` in the actor's inventory, or a true
 * `barrier.condition`. Picking and forcing are skill checks — their own verbs.
 */
function canOpenBarrier(
  verdict: ExitVerdict,
  inventory: readonly string[],
  model: WorldModel,
  from: string,
  world: World,
  characters: readonly Character[],
): boolean {
  const barrier = verdict.exit.barrier;
  if (!barrier) return false;
  if (barrier.keyItemId !== undefined && inventory.includes(barrier.keyItemId)) return true;
  // The COMPLETE lookup bundle, not a hand-picked subset. Every `EvalLookups` resolver is
  // fail-closed, so this used to pass `{ regionOf }` alone and thereby seal `regionDangerAtLeast`
  // shut forever and read `attireState` against the wrong coverage baseline (regex audit §10d —
  // the repro and the reasoning live on `standardEvalLookups`). Mirrors the engine's
  // `resolveBarredMove`, which is the player-facing twin of this check.
  return (
    barrier.condition !== undefined &&
    evalPredicate(barrier.condition, model, from, undefined, standardEvalLookups(world, characters))
  );
}

/** The words that describe a barred exit in the candidate list: its name, destination and obstacle. */
function barredLabel(verdict: ExitVerdict, world: World): string {
  const destName = locationNameOf(world, verdict.exit.to);
  const exitName = verdict.exit.name;
  return `${exitName ? `${exitName} → ` : ""}${destName} — ${barrierDescription(verdict.exit.barrier)}`;
}

/**
 * Enumerate every legal act for `actorId` from the live model. Pure and cheap: it is called once to
 * build the brief block and once again at ground time, so an act named against a scene that has
 * since changed simply finds no row and degrades to speech.
 *
 * `world` is content lookup only (item names/slots, location names) — legal targets always come
 * from the model.
 */
export function actCandidates(
  actorId: string,
  model: WorldModel,
  world: World,
  ctx: GroundingContext = {},
): ActCandidates {
  const empty: ActCandidates = {
    move: [], give: [], recipients: [], equip: [], unequip: [],
    open: [], pick: [], force: [], rest: 0, loot: [], use: [], take_job: [],
  };
  const actor = model.entities.get(actorId);
  const actorLoc = actor?.locationId ?? null;
  if (!actor) return empty;

  const present = actorLoc ? entitiesAt(model, actorLoc).filter((e) => e.id !== actorId) : [];
  const inventory = actor.stats?.inventory ?? [];
  const equipped = actor.stats?.equipped ?? {};

  // move — reachable, unlocked exits. Two exclusions are baked into the OFFER, not just the check,
  // so the model is never tempted by a destination that would be refused:
  //  · a `frontier:` exit crosses into an UNgenerated pocket — that is worldgen (expandFrontier),
  //    never a self/party move; grounding one into moveParty would strand the party on the mapless
  //    sentinel (the reducer hard-rejects it too, audit #1).
  //  · a party COMPANION that is NOT leading must not walk itself out of the party on a background
  //    beat — a plain `moveEntity(self)` splits the group (the party never follows, `partyMember`
  //    stays true) and the departed companion is then narrated back into the scene as a phantom
  //    (audit #6). A present NON-party world NPC keeps wandering its own world.
  //  · a HIDDEN exit is not offered, because this table is PROMPT TEXT: the old scorer read hidden
  //    exits (it only filtered `locked`) but never printed them, so listing one here would hand the
  //    model a secret passage it could then speak aloud. Every player-facing surface filters
  //    `hidden` (modelExits, the barred-exit arms below); the candidate block matches them.
  const mayMove = ctx.leadsParty === true || !actor.partyMember;
  const move: ActTarget[] =
    actorLoc && mayMove
      ? exitsFrom(model.map, actorLoc)
          .filter((e) => !e.locked && !e.hidden && !isFrontierId(e.to))
          .map((e) => ({ id: e.to, label: e.name ?? locationNameOf(world, e.to) }))
      : [];

  // give / recipients — an owned item into the hands of someone present. Both halves must exist.
  const recipients: ActTarget[] = present.map((e) => ({ id: e.id, label: e.name }));
  const give: ActTarget[] =
    recipients.length > 0 ? inventory.map((id) => ({ id, label: itemNameOf(world, id) })) : [];

  // equip — an owned item into the one slot it legally fits (the reducer checks possession; slot FIT
  // is the enqueuer's gate — itemFitsSlot, per commands.ts). An item already occupying its slot is
  // not offered: there is nothing to do.
  const equip = inventory.flatMap((itemId) => {
    const resolved = resolveItem(world, itemId);
    const slot = resolved ? slotFor(resolved) : undefined;
    if (slot === undefined || equipped[slot] === itemId) return [];
    return [{ id: itemId, label: itemNameOf(world, itemId), slot }];
  });

  // unequip — something currently WORN; `equipItem` with a null itemId vacates the slot (the
  // reducer's documented unequip form). A merely-carried item has nothing to take off.
  const unequip = (Object.keys(equipped) as EquipSlot[]).flatMap((slot) => {
    const itemId = equipped[slot];
    return itemId ? [{ id: itemId, label: itemNameOf(world, itemId), slot }] : [];
  });

  // open / pick / force — the barred, NON-HIDDEN exits here (hidden exits stay unknown, the same
  // filter every player surface applies). A free open always beats a risk, so an exit the actor can
  // open passively is offered ONLY as `open`, and the skill checks are offered only where that
  // passive path is closed. Legality mirrors the engine's resolveBarrierCheck exactly: pick needs a
  // `dc` AND a still-"locked" state (a fall of rubble has no lock to pick); force needs a `breakDc`.
  const open: ActTarget[] = [];
  const pick: (ActTarget & { dc: number; barrierDesc: string })[] = [];
  const force: (ActTarget & { dc: number; barrierDesc: string })[] = [];
  if (actorLoc) {
    for (const verdict of barredExitsAt(model, actorLoc)) {
      if (verdict.exit.hidden) continue;
      const label = barredLabel(verdict, world);
      const barrierDesc = barrierDescription(verdict.exit.barrier);
      if (canOpenBarrier(verdict, inventory, model, actorLoc, world, ctx.characters ?? [])) {
        open.push({ id: verdict.exit.to, label });
        continue;
      }
      const barrier = verdict.exit.barrier;
      if (barrier?.dc !== undefined && verdict.state === "locked") {
        pick.push({ id: verdict.exit.to, label, dc: barrier.dc, barrierDesc });
      }
      if (barrier?.breakDc !== undefined) {
        force.push({ id: verdict.exit.to, label, dc: barrier.breakDc, barrierDesc });
      }
    }
  }

  // rest — a depleted actor catches its breath. Recovery is the FULL missing energy, derived from
  // the energy model (no invented number); the reducer clamps it. At the ceiling there is nothing
  // to recover, so `rest` is not offered at all and a "sit tight" aside can never spend a delta.
  const stats = actor.stats;
  const rest = stats ? Math.max(0, maxEnergyOf(stats) - energyOf(stats)) : 0;

  // loot — items on a DEFEATED present holder (downed / hp ≤ 0), never a conscious one.
  const loot = present.filter(isDefeated).flatMap((holder) =>
    (holder.stats?.inventory ?? []).map((itemId) => ({
      id: itemId,
      label: itemNameOf(world, itemId),
      holderId: holder.id,
      holderName: holder.name,
    })),
  );

  // use — an owned consumable (a draught, a ration).
  const use = inventory.flatMap((itemId) => {
    const resolved = resolveItem(world, itemId);
    return resolved !== undefined && isConsumable(resolved)
      ? [{ id: itemId, label: itemNameOf(world, itemId) }]
      : [];
  });

  // take_job — Feature 1c, LEADER only: a quest that is visibly ON OFFER. This is the one place an
  // NPC grounds into `setQuestState` (see the module docstring's carve-out): the quest is
  // player-visible and rides an override-able proposal, so the leader only opts the party in.
  const take_job: ActTarget[] =
    ctx.leadsParty && ctx.offeredQuests ? ctx.offeredQuests.map((q) => ({ id: q.id, label: q.name })) : [];

  return { move, give, recipients, equip, unequip, open, pick, force, rest, loot, use, take_job };
}

/** `id (label)`, the one shape every candidate is offered in — the id is what must be copied back. */
const offer = (t: ActTarget): string => `${t.id} (${t.label})`;

/**
 * Render the candidate table as the NPC brief's `# CANDIDATE ACTIONS` block (src/agents/npc.ts
 * injects it before the beat marker). Returns `[]` when nothing is legal, so the block is
 * omit-when-empty like every other brief section and a scene with no affordances leaves the prompt
 * byte-identical to a pure-conversation one.
 */
export function renderActCandidates(candidates: ActCandidates): string[] {
  const lines: string[] = [];
  const row = (verb: string, targets: readonly ActTarget[]): void => {
    if (targets.length > 0) lines.push(`- "${verb}": ${targets.map(offer).join(" | ")}`);
  };
  row("move", candidates.move);
  if (candidates.give.length > 0 && candidates.recipients.length > 0) {
    row("give", candidates.give);
    lines.push(`  (for "give", also set "to" to one of: ${candidates.recipients.map(offer).join(" | ")})`);
  }
  row("equip", candidates.equip);
  row("unequip", candidates.unequip);
  row("open", candidates.open);
  row("pick", candidates.pick);
  row("force", candidates.force);
  if (candidates.rest > 0) lines.push(`- "rest": no target — you would recover ${candidates.rest} energy`);
  if (candidates.loot.length > 0) {
    lines.push(
      `- "loot": ${candidates.loot.map((t) => `${offer(t)} from ${t.holderName}`).join(" | ")}`,
    );
  }
  row("use", candidates.use);
  row("take_job", candidates.take_job);
  return lines;
}

/**
 * Ground a CLOSED act into a legal command for `actorId` given the live model — a table lookup, not
 * a guess. The act's ids are matched by EXACT equality against {@link actCandidates}; anything the
 * table doesn't hold (a stale destination, an invented item, a recipient who left, a verb whose
 * whole group is empty) grounds to `speak`, and so does a missing act.
 *
 * Confidence is now a two-valued signal for the dropped-action telemetry, NOT a similarity score:
 * 1 when the NPC named an act (grounded, or named-but-illegal ⇒ reported as an `illegal` drop),
 * 0 when it named none (pure conversation ⇒ not a drop at all).
 */
export function groundToCommand(
  actorId: string,
  act: NpcAct | undefined,
  model: WorldModel,
  world: World,
  ctx: GroundingContext = {},
): GroundingResult {
  if (!act || act.do === "none" || !(NPC_ACT_VERBS as readonly string[]).includes(act.do)) {
    return speakFallback(0);
  }
  const actor = model.entities.get(actorId);
  const actorLoc = actor?.locationId ?? null;
  const candidates = actCandidates(actorId, model, world, ctx);
  const target = act.target?.trim() ?? "";
  const find = <T extends ActTarget>(rows: readonly T[]): T | undefined => rows.find((r) => r.id === target);
  // A named act that finds no legal row: speech, reported as an `illegal` drop so the Turns
  // inspector shows WHICH act never happened.
  const illegal = (): GroundingResult => speakFallback(1);
  const grounded = (action: GroundedAction): GroundingResult => ({ action, confidence: 1, fellBack: false });
  const command = (cmd: Command): GroundingResult => grounded({ kind: "command", command: cmd });

  switch (act.do) {
    case "move": {
      const dest = find(candidates.move);
      // Re-check reachability at ground time (the table was built from the same model, but the
      // beat may have been staged earlier in the tick).
      if (!dest || !actorLoc || !canReach(model.map, actorLoc, dest.id)) return illegal();
      // A LEADER moves the whole party (`moveParty` auto-follows co-located members, reducer.ts),
      // so "let's head to the forge" takes everyone — not just the leader (moveEntity).
      return command(
        ctx.leadsParty
          ? { type: "moveParty", to: dest.id }
          : { type: "moveEntity", entityId: actorId, to: dest.id },
      );
    }
    case "give": {
      const item = find(candidates.give);
      const to = act.to?.trim() ?? "";
      const recipient = candidates.recipients.find((r) => r.id === to);
      if (!item || !recipient) return illegal();
      return command({ type: "transferItem", itemId: item.id, from: actorId, to: recipient.id });
    }
    case "equip": {
      const row = find(candidates.equip);
      if (!row || !actor?.stats?.inventory.includes(row.id)) return illegal();
      return command({ type: "equipItem", entityId: actorId, slot: row.slot, itemId: row.id });
    }
    case "unequip": {
      const row = find(candidates.unequip);
      if (!row) return illegal();
      return command({ type: "equipItem", entityId: actorId, slot: row.slot, itemId: null });
    }
    case "open": {
      const row = find(candidates.open);
      if (!row || !actorLoc) return illegal();
      // Opening is the visible act; the NPC's own movement through happens on a later beat.
      return command({ type: "setExitState", locationId: actorLoc, to: row.id, state: "open" });
    }
    case "pick":
    case "force": {
      const row = act.do === "pick" ? find(candidates.pick) : find(candidates.force);
      if (!row || !actorLoc) return illegal();
      return grounded({
        kind: "barrierAttempt",
        verb: act.do,
        ability: act.do === "pick" ? "dex" : "str",
        locationId: actorLoc,
        to: row.id,
        dc: row.dc,
        barrierDesc: row.barrierDesc,
        destName: locationNameOf(world, row.id),
      });
    }
    case "rest": {
      if (candidates.rest <= 0) return illegal();
      return command({ type: "adjustEnergy", entityId: actorId, by: candidates.rest });
    }
    case "loot": {
      // The item id addresses the row; the holder comes from the table, so an NPC can never name a
      // holder it wasn't offered. Two defeated holders carrying the SAME item id resolve to the
      // first in registry order — deterministic, and the act was legal either way.
      const row = find(candidates.loot);
      if (!row) return illegal();
      return command({ type: "transferItem", itemId: row.id, from: row.holderId, to: actorId });
    }
    case "use": {
      const row = find(candidates.use);
      if (!row) return illegal();
      return grounded({ kind: "consumeItem", itemId: row.id });
    }
    case "take_job": {
      const row = find(candidates.take_job);
      if (!row) return illegal();
      return command({ type: "setQuestState", questId: row.id, state: "active" });
    }
  }
}

/**
 * Workstream C (slim) telemetry: classify a grounding result as a *dropped action* — an NPC that
 * NAMED a world act which never happened — or `null` if it wasn't one. Both a clean grounding
 * (`fellBack:false`) and a pure-conversation beat (no act named ⇒ confidence 0) return `null`, so a
 * chatty scene never floods the trace. With the closed act form every drop is an `illegal` one (the
 * act named a target that isn't on the legal table); the `low-confidence` reason is retained in the
 * union because the shipped trace schema (src/logging/types.ts) and old exported traces carry it.
 * Pure — the autonomy module wraps it to push onto the per-turn scratch.
 */
export function groundingFallbackReason(
  ground: GroundingResult,
): { confidence: number; reason: "low-confidence" | "illegal" } | null {
  if (!ground.fellBack || ground.confidence <= 0) return null;
  return {
    confidence: ground.confidence,
    reason: ground.confidence >= GROUNDING_THRESHOLD ? "illegal" : "low-confidence",
  };
}
