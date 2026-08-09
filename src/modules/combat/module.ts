/**
 * CombatModule (M3) — deterministic weapon combat on the tick spine.
 *
 * Player attack intent enters through core as `ctx.data.combatAttack`. This module resolves every
 * number in code, enqueues reducer commands for state changes, and narrates each resolved swing via
 * the existing RESOLVED MECHANICS contract. It never writes `model.modules.combat` directly.
 *
 * @author Runkai Zhang
 */
import type { StatBlock, World } from "../../content/schema.ts";
import type { EmittedEvent } from "../../events/types.ts";
import type { LlmGateway } from "../../llm/gateway.ts";
import { DungeonMaster } from "../../agents/dm.ts";
import { buildNarrationContext } from "../../agents/context.ts";
import { entitiesAt, partyLocationOf, playerEntity, toGameState, type WorldModel } from "../../world/model.ts";
import { applyCommand } from "../../world/reducer.ts";
import { displayName, type Entity } from "../../world/entity.ts";
import { frontierExpansionEnabled } from "../../world/expansion.ts";
import { modelExits, modelPresence } from "../../world/queries.ts";
import { derivedAc, rollInitiative, resolveAttack, type AttackResult, type Combatant } from "../../rules/combat.ts";
import { resolveCheck } from "../../rules/checks.ts";
import { fnv1a, mulberry32 } from "../../rules/dice.ts";
import { resolveSpell, isOffensiveSpell } from "../../rules/magic.ts";
import {
  applyXpGain,
  effectiveStatBlock,
  progressionOf,
  type ProgressionEntry,
  readProgressionSlice,
  xpForDefeat,
} from "../../rules/progression.ts";
import type { Spell } from "../../content/schema.ts";
import type { CombatEncounter } from "../../rules/combat-state.ts";
import { allyFateSummary, escapeDc, resolveAllyFate, type EscapeFoe } from "../../rules/escape.ts";
import { exhaustionAttackMods, exhaustionOf } from "../../rules/exhaustion.ts";
import { isWeapon, resolveItem, type ResolvedItem } from "../../rules/items.ts";
import {
  getWeapon,
  UNARMED,
  NATURAL_WEAPON,
  IMPROVISED_WEAPON,
  weaponProfileFromItem,
  type WeaponProfile,
} from "../../rules/srd/index.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import type { TurnPlan } from "../../engine/turn-plan.ts";
import { authorizedCommandsOf, narrateGuarded, looksLikeRefusal, stripNarratorDirective } from "../narrate.ts";
import { turnFactLines } from "../../rules/turn-facts.ts";
import { baselineNpcStats } from "../../worldsmith/reconcile.ts";
import { decideIntervention, rollIntervention } from "../../rules/intervention.ts";
import { bystanderLeans } from "../../rules/agenda.ts";
import type { NarrationIntent } from "../narration.ts";
import { readCombat } from "./state.ts";
import { isPartyHostile, partyHostileFlag } from "../../rules/betrayal.ts";
import { nameHandleTokens, nameMentionedIn } from "../../rules/name-match.ts";
import { escapeRegExp } from "../../util/text.ts";
import { COMBAT_ASSIST_WARMTH, FACTION_MATE_CHILL, factionMatesPresent } from "../../rules/relationships.ts";
import { FACTION_ATTACK_STANDING, factionOf, factionStandingCommands } from "../../rules/factions.ts";
import { resolveDefeatOutcome, type DefeatGateContext, type DefeatOutcome } from "../../rules/defeat-outcomes.ts";
import { buildGenericDefeatOutcomes } from "../../content/generic-defeat-outcomes.ts";
import { statusMods } from "../../rules/status-effects.ts";

export interface CombatAttackIntent {
  actorId: string;
  targetId?: string | null;
  weaponId?: string | null;
  input: string;
}

interface ResolvedSwing {
  actorId: string;
  targetId: string;
  result: AttackResult;
}

type Side = "party" | "enemy";

/** Module-slice name for the durable once-per-monster/NPC on-sight aggro guard (see `hasAggroed`). */
const AGGRO_MODULE = "aggro";

/**
 * Module-slice name for entities the party has durably TALKED DOWN (r6 P1): a successful
 * de-escalation/parley marks the entity calmed — it never on-sight aggros again. This is the
 * mechanical half of "the scene resolved socially": before this slice the fiction could talk a
 * hostile down and the engine would start the fight anyway, because hostility was a one-way latch.
 */
const CALMED_MODULE = "combatCalmed";

/**
 * Player input that is an attempt to STOP violence, not to join, aim, or direct it ("ODA, STOP!",
 * "I put my hands up", "we yield", "let's talk this down"). Used by the engine (to NOT read the
 * line as a call for aid) and by this module (to run the parley contest).
 */
// The evasion-calm's trigger — a check whose purpose was to SHAKE a hostile rather than harm it —
// is now the classifier's closed `check.purpose` enum, read from `ctx.data.checkOutcome`. The regex
// that used to live here scanned the model's free-text `check.reason` plus the player's raw line for
// verbs like throw/feed/dump/hide, so a PASSED ATTACK check ended the encounter and durably calmed
// every foe: "I throw the table over onto the wight", "I dump the burning oil down the stairs onto
// them", "I feed the poisoned meat to the hound", "I hide behind the pillar, reload, and shoot
// again" all read as evasion. An unconstrained string decided an irreversible delta, which is the
// one thing the model may never do — it may only NAME the answer from a closed list.

export const DEESCALATION_RE =
  /\b(stop|stopp?ing|cease|yield|yields|surrender|parley|parlay|truce|stand\s*down|back\s*(down|off)|lower (your|the|that) (weapon|weapons|blade|sword|knife|bow)|put (your|the|that)[\w'’-]*\b(weapon|weapons|blade|sword|knife|bow)\w*\s+(down|away)|don['’]?t\s+(fight|shoot|swing|attack|hurt)|do not (fight|shoot|attack|hurt)|no more (fight|fighting|blood)|talk (this|it|them|her|him) down|de-?escalat|sheath|lay down (your|the|their) (weapon|weapons|arms)|stay your hand|hold (on|up|there|your)|enough\b)/i;
/**
 * Module-slice name for the durable "the player has SEEN this monster" record (`{[id]: true}`, the
 * AGGRO pattern). The interior-ambush telegraph (r4 P3, generalizing the r3 npc-events fix): a
 * monster the player did NOT walk in on — it was already placed, or spawned into the room — gets
 * ONE approach beat on the turn it is first seen, and its on-sight aggro opens the fight on the
 * player's NEXT turn, intruder first. Walking INTO a monster's room keeps same-tick aggro (the
 * player chose the door). Exported so spawn-with-beat paths (npc-events `ambush`) can mark their
 * own spawn seen and not telegraph the same intruder twice.
 */
export const MONSTER_SEEN_MODULE = "monsterSeen";

/**
 * Module-slice name for the durable once-per-victim kill-XP credit (`{[victimId]: true}`, the AGGRO
 * pattern). XP used to be welded to the DAMAGE site (`afterSwing`/spell), so any non-swing down —
 * an authored event's adjustHp/setCondition, a future DoT — ended combat with the "defeated" beat
 * and NO XP (latent class behind live 07-18 #5). The combat-END chokepoints now also award, and
 * this ledger makes every award exactly-once across ticks, replay-safe via the generic modulePatch.
 */
const XP_CREDIT_MODULE = "combatXpCredit";

const DIRECT_ATTACK_VERBS = [
  "attack",
  "hit",
  "strike",
  "stab",
  "shoot",
  "slash",
  "kill",
  "fight",
  "punch",
  "kick",
  "club",
  "crack",
  "bash",
  "smash",
  "brain",
] as const;
const DIRECT_ATTACK_RE = new RegExp(`\\b(?:${DIRECT_ATTACK_VERBS.join("|")})\\s+(?:(?:at|toward)\\s+|the\\s+)?__TARGET__\\b`, "i");
const DIRECT_LUNGE_RE = /\b(?:lunge|charge|swing)\s+(?:at|toward)\s+__TARGET__\b/i;
const BETRAYAL_RE = /\b(?:betray|backstab|turn\s+on|turn\s+against)\b/i;
const ATTACK_NEGATION_RE =
  /\b(?:do(?:es)?n['’]?t|do not|does not|won['’]?t|will not|never|can['’]?t|cannot|refuse to|not going to)\b/i;

/** Turn kinds that can carry a peaceful, entity-directed overture (see `peacefulOvertureTargets`). */
const OVERTURE_KINDS: ReadonlySet<TurnPlan["kind"]> = new Set([
  "dialogueToNpc",
  "itemAction",
  "trade",
  "freeformNarrative",
]);

/**
 * The entities the player's CLASSIFIED turn peacefully addresses this tick — a parley, a gift, a
 * trade attempt aimed at a specific present entity. Only these ids suppress on-sight monster aggro
 * for one beat (the flag is not burned, so the monster still engages on any later tick). A violent
 * impact, an attack/movement kind, or an untargeted line yields the empty set — the world stays
 * dangerous by default.
 */
function peacefulOvertureTargets(ctx: TickContext): ReadonlySet<string> {
  const plan = ctx.data.plan as TurnPlan | undefined;
  if (!plan || !OVERTURE_KINDS.has(plan.kind)) return new Set();
  if (plan.impact && plan.impact.domain === "violence") return new Set();
  const ids = new Set<string>();
  if (plan.targetId) ids.add(plan.targetId);
  if (plan.item?.targetId) ids.add(plan.item.targetId);
  if (plan.trade?.vendorId) ids.add(plan.trade.vendorId);
  return ids;
}

/**
 * The deterministic statblock for a template-less generated monster (a frontier lurker): a wary,
 * middling beast — real teeth, nothing heroic. `maxHp` is overridden by the entity's spawned HP.
 */
const GENERATED_MONSTER_BLOCK: StatBlock = {
  abilities: { str: 12, dex: 12, con: 12, int: 4, wis: 10, cha: 6 },
  maxHp: 11,
  armorClass: 11,
  level: 1,
  speed: 30,
  proficiencies: [],
  spells: [],
};

/**
 * Per-tick `ctx.data` key holding the on-sight-aggro path's parked player-visible events (see
 * {@link CombatModule.emitOrDefer}). It lives on the tick's scratch — NEVER on the module instance —
 * because one CombatModule object is shared by every tick: an instance flag stranded by an exception
 * mid-aggro would silently swallow the NEXT tick's combat events.
 */
const DEFERRED_EMITS_KEY = "combatDeferredEmits";

interface DeferredEmits {
  /** True while the aggro block owns the emit stream; false once the block has been torn down. */
  open: boolean;
  /** The parked events, in the order they were raised; drained by `flushDeferredEmits`. */
  events: EmittedEvent[];
}

export class CombatModule implements TickModule {
  readonly id = "combat";
  /**
   * `core` first (it parks the player's mechanical intents on `ctx.data` for this module to read),
   * then `narration` — that second entry is about BEAT ORDER, not state.
   *
   * `TickRunner.ordered()` computes ONE module order shared by EVERY phase (`after` is global, not
   * per-phase), so lifting combat behind narration re-seats it in the narrate phase, where it used
   * to be the FIRST handler of the whole tick — ahead of even the GM. The narrate order becomes
   * dialogue -> events -> autonomy -> narration -> combat -> prose-entities.
   *
   * Verified safe when this was added (live 07-24 beat-order fix):
   * - No cycle: narration's own dependency closure is {dialogue, events, autonomy, core}, and the
   *   string "combat" appears in NO other module's `after` anywhere in `src/modules` or `src/engine`.
   * - The RESOLVE order is unchanged — core -> combat -> captivity, before and after —
   *   because none of the interposed modules implements a `resolve` handler.
   * That second point is a property of the whole module registry rather than of this file, so it is
   * pinned by a tick-order spec instead of trusted to stay true.
   */
  readonly after = ["core", "narration"];
  readonly phases: TickModule["phases"];
  private readonly dm: DungeonMaster;

  constructor(
    private readonly world: World,
    gateway: LlmGateway,
    private readonly systemPrefix?: string,
  ) {
    this.dm = new DungeonMaster(gateway, world, systemPrefix);
    this.phases = {
      // Party position BEFORE core resolve moves anyone — the telegraph's walked-in test
      // (`tryMonsterAggro`) compares it against the post-resolve location.
      perceive: (ctx) => {
        ctx.data.combatPreLoc = partyLocationOf(ctx.model);
      },
      resolve: (ctx) => this.onResolve(ctx),
      narrate: (ctx) => this.onNarrate(ctx),
      // Last-chance release: a parked aggro event must NEVER be silently dropped. `onNarrate`
      // flushes on both of its paths, but commit runs after narrate, so a future early-return (or a
      // beat that never reaches the tail) still gets its mechanics onto the player's screen.
      commit: (ctx) => this.flushDeferredEmits(ctx),
    };
  }

  /**
   * Emit — unless the on-sight-aggro block is holding the stream, in which case park it.
   *
   * The engine batches a tick's events and publishes them in CALL order (`GameEngine.emit` →
   * `publishEventBatch`), so PHASE order decides what the player reads first. Aggro resolves in
   * `resolve` and emits its "Combat begins" line, its dice and its damage there, while the prose
   * that OPENS the fight is only parked (`ctx.data.combatStartBeat`) and narrated a phase later —
   * so an ambushed player read the mechanics of the ambush before the ambush (live 07-24). Parking
   * lets `onNarrate` release them immediately AFTER the start beat, in their original order.
   *
   * With the buffer closed — every other caller, above all the player's OWN declared attack, which
   * shares these same helpers — this is exactly `ctx.emit`.
   */
  private emitOrDefer(ctx: TickContext, event: EmittedEvent): void {
    const deferred = ctx.data[DEFERRED_EMITS_KEY] as DeferredEmits | undefined;
    if (deferred?.open) {
      deferred.events.push(event);
      return;
    }
    ctx.emit(event);
  }

  /** Start holding the aggro path's player-visible events. Idempotent within a tick. */
  private beginDeferredEmits(ctx: TickContext): void {
    const deferred = (ctx.data[DEFERRED_EMITS_KEY] as DeferredEmits | undefined) ?? { open: false, events: [] };
    deferred.open = true;
    ctx.data[DEFERRED_EMITS_KEY] = deferred;
  }

  /** Stop holding: later emits go straight out again. Anything already parked stays until a flush. */
  private closeDeferredEmits(ctx: TickContext): void {
    const deferred = ctx.data[DEFERRED_EMITS_KEY] as DeferredEmits | undefined;
    if (deferred) deferred.open = false;
  }

  /** Release every parked event in the order it was raised. Safe to call repeatedly (drains). */
  private flushDeferredEmits(ctx: TickContext): void {
    const deferred = ctx.data[DEFERRED_EMITS_KEY] as DeferredEmits | undefined;
    if (!deferred || deferred.events.length === 0) return;
    for (const event of deferred.events.splice(0)) ctx.emit(event);
  }

  private async onResolve(ctx: TickContext): Promise<void> {
    if (ctx.trigger.kind !== "player") return;
    const hp = this.hpProjection(ctx.model);
    // A stranded encounter (party fled the room / no foe left standing) must end HERE, on any
    // player tick — `isCombatActive` gates every heartbeat, so a fight nobody can finish would
    // otherwise silently disable proactive NPCs for the rest of the campaign.
    const reaped = this.reapStaleCombat(ctx, hp);

    // The player's OWN declared attack this tick OWNS the encounter opening. If on-sight aggro ran
    // first, a not-yet-aggroed monster would "ambush" the very player who just typed "I attack it" —
    // dropping their swing and narrating a surprise the player did not experience (audit). When the
    // player is NOT attacking, the world stays dangerous: a hostile/monster still opens on sight, and
    // any co-located foe is still swept into the fight the player started (startEncounter conscripts
    // every present monster/hostile), so nothing is left un-engaged to ambush a tick later.
    const declaredAttack = ctx.data.combatAttack as CombatAttackIntent | undefined;
    if (!reaped && !readCombat(ctx.model).active && !declaredAttack) {
      // DE-ESCALATION (r6 P1): a peaceful overture aimed at a hostile is a real contest, not a
      // one-beat suppression. Success calms the entity DURABLY; failure drops the suppression and
      // the thing answers talk with violence on this very tick.
      await this.tryDeescalate(ctx, hp);
      // BEAT ORDER (live 07-24): both helpers below emit "Combat begins. Initiative: …", the dice and
      // the damage lines RIGHT HERE in resolve, while the prose that opens the fight is only parked
      // for the narrate phase — so the player read the mechanics of an ambush before the ambush.
      // Park their player-visible events instead; `onNarrate` releases them the moment the start beat
      // has rendered. The buffer is closed again immediately after this block, so the player's OWN
      // declared-attack path below — which shares every one of these helpers — is untouched
      // (buffer closed ⇒ `emitOrDefer` IS `ctx.emit`, byte-identical to before).
      this.beginDeferredEmits(ctx);
      try {
        // A party member that has explicitly turned hostile can start a fight from inside the camp.
        // This is the betrayal path; ordinary companions still never auto-attack the PC.
        if (this.tryHostileNpcAggro(ctx, hp)) return;
        // A living hostile monster engages on sight (once) — the world is dangerous without the
        // player opting in. If it opened a fight, the ambusher's side acts first; the player's
        // own action lands on their initiative next tick.
        if (this.tryMonsterAggro(ctx, hp)) return;
      } finally {
        // `finally` because both branches above RETURN on success — the buffer must close on the
        // way out of the aggro block on every path, including a throw.
        this.closeDeferredEmits(ctx);
      }
    }

    // PARLEY (r6 P1): talking a LIVE fight down. Before this, the only in-combat verbs were
    // attack / call-aid / item — an explicit "ODA, STOP!" had no representation at all and could
    // even recruit a bystander into the fight the player was trying to end. The appeal spends the
    // player's turn; success ends the fight with every foe talked down, failure and the fight
    // rages on without them.
    // THE ADDRESSING GATE (r7 P0): the appeal must actually be AIMED AT THE FIGHT. In run 7 a
    // conversation with a bystander ("Your turn, Tamsin — what do you know about that wreck?")
    // tripped the regex and was scored as a DC 18 talk-down against the absent hound; the failure
    // was a free round of damage and the death that followed was unearned. A line the classifier
    // read as speech TO a present non-combatant is dialogue, never a parley.
    //
    // THE TRIGGER IS THE CLASSIFIER'S `speechAct` (r8 regex audit). One word-list cannot separate a
    // plea from an order or from a battle cry: "Brann, stop him!" (a companion told to stop the
    // ENEMY) and "Enough of this — kill it!" (the `enough` arm) both tripped it, the second opening
    // a surrender bid on a line that declared an attack. Both reproduced against the shipped regex.
    // The regex survives ONLY as the null fallback — a stub plan, a pre-r8 persisted plan, or a
    // double classifier failure keeps today's behavior including the untargeted shout — and the
    // code-side addressing gate below still has the last word on WHO is being talked to.
    if (!declaredAttack && ctx.trigger.kind === "player" && this.isDeescalation(ctx)) {
      const parleyEnc = reaped ? null : this.activeOrNull(ctx);
      if (parleyEnc && this.addressesTheFight(ctx, parleyEnc)) {
        await this.resolveParley(ctx, parleyEnc, hp);
        return;
      }
    }

    // EVASION-CALM (r7 P0): a PASSED check whose whole point was to shake the hostile — feed it,
    // distract it, hide from it, slip away — ends the fight the fiction just ended. Run 7's player
    // threw four days of rations and passed the Stealth check; the narration walked the hound out
    // of the cellar ("The cellar is quiet") while the encounter stayed live, rest stayed locked at
    // 1 HP, and the phantom kept swinging. Success is durable calm (the on-sight aggro never
    // re-fires); failure keeps the fight exactly as it was.
    {
      const outcome = ctx.data.checkOutcome as
        | { success: boolean; purpose?: "disengage" | "harm" | "other" | null; text: string }
        | undefined;
      const evadeEnc = reaped ? null : this.activeOrNull(ctx);
      if (
        evadeEnc &&
        ctx.trigger.kind === "player" &&
        outcome?.success === true &&
        outcome.purpose === "disengage"
      ) {
        const foes = evadeEnc.order.filter((id) => this.sideOf(ctx, id) === "enemy" && (hp.get(id) ?? 0) > 0);
        const calmPatch: Record<string, boolean> = {};
        for (const id of foes) {
          calmPatch[id] = true;
          if (isPartyHostile(ctx.model, id)) {
            ctx.apply({ type: "setFlag", scope: "world", key: partyHostileFlag(id), value: false });
          }
        }
        if (foes.length > 0) ctx.enqueue({ type: "modulePatch", module: CALMED_MODULE, patch: calmPatch });
        this.liftPlayerLine(ctx);
        ctx.emit({ kind: "stateChanged", summary: `The danger breaks off — the fight is over.` });
        ctx.data.combatEndBeat =
          `The ploy works — the threat loses interest and withdraws from the fight. ` +
          `Describe the disengagement in a sentence or two; nobody swings again.`;
        this.endCombat(ctx);
        return;
      }
    }

    // Bystanders taking the party's side (r5 P3). Runs BEFORE the turn-spending branches below so
    // a newly-joined ally is already in the order when the round is driven — otherwise the fix
    // lands a turn late, which is the reported defect with extra steps.
    this.tryAllyJoins(ctx, hp);

    // A call for aid is a real combat action and SPENDS the player's turn, exactly like drinking a
    // potion: without this the ally does not swing until the player's next attack, and the player
    // has again priced a stand-or-run decision on help that has not arrived.
    const aid = ctx.data.combatAid as { actorId: string } | undefined;
    if (aid) {
      const encounter = reaped ? null : this.activeOrNull(ctx);
      if (encounter && encounter.order[encounter.turnIndex] === aid.actorId) {
        this.liftPlayerLine(ctx);
        this.driveUntilPlayer(ctx, this.advance(ctx, encounter), hp, aid.actorId);
      }
      return;
    }

    // An item action core already resolved (drink/equip/give) spends the player's combat turn:
    // pass the initiative on and let the other side act, exactly as if the player had swung.
    // (The heal/equip commands applied in core's resolve, so `hp` above already reflects them.)
    // A FAILED DISENGAGE (r11 F-5) rides the same rail: the break-away attempt was the player's
    // action for the round, so the other side answers it here rather than the fight simply pausing.
    const itemTurn = (ctx.data.itemActionTurn ?? ctx.data.combatTurnSpent) as { actorId: string } | undefined;
    if (itemTurn) {
      const encounter = reaped ? null : this.activeOrNull(ctx);
      if (encounter && encounter.order[encounter.turnIndex] === itemTurn.actorId) {
        // ONE narration block per combat turn (live 07-18 #3): the attack path clears the parked
        // narration below; this path used to leave it set, so BOTH the round beat AND the
        // NarrationModule fired — the latter on a combat-blind brief that re-established the
        // peaceful scene mid-fight. Lift the player's line into the combat beat instead.
        this.liftPlayerLine(ctx);
        this.driveUntilPlayer(ctx, this.advance(ctx, encounter), hp, itemTurn.actorId);
      }
      return;
    }

    // A DOWNED player cannot declare a swing, but every turn they take must still move an active
    // fight forward — otherwise a lost-but-unfinished encounter (companions still trading blows)
    // freezes at the current round and NOTHING the player types (rest, move, look) can end it
    // (N9 soft-lock). Advance it on their behalf and let it resolve: a companion felling the last
    // foe revives the PC to 1 HP (tryEndCombat), a wipe triggers the defeat outcome. Keeps whatever
    // deterministic refusal core already set (e.g. "you cannot rest, the fight is still on you") —
    // the enemy/ally swings surface as their own state beats beneath it.
    if (!declaredAttack && !itemTurn) {
      const downed = playerEntity(ctx.model);
      const isDown =
        !!downed?.stats && ((downed.stats.currentHp ?? 0) <= 0 || downed.stats.conditions.includes("unconscious"));
      const combat = this.withPendingJoins(ctx, readCombat(ctx.model));
      if (downed && isDown && combat.active && !this.tryEndCombat(ctx, combat, hp)) {
        this.driveUntilPlayer(ctx, this.advance(ctx, combat), hp, downed.id);
      }
      if (downed && isDown) return;
    }

    const intent = ctx.data.combatAttack as CombatAttackIntent | undefined;
    if (!intent) return;
    ctx.data.narration = undefined;

    const actor = ctx.model.entities.get(intent.actorId);
    if (!actor || !this.combatantOf(ctx, actor)) {
      this.setFallback(ctx, `You try to attack, but you are in no shape to fight. ${intent.input}`);
      return;
    }
    if ((actor.stats?.currentHp ?? 0) <= 0 || actor.stats?.conditions.includes("unconscious")) {
      // A downed PC cannot swing — but the fight goes on without them: companions and enemies
      // keep trading blows, so the encounter still resolves (victory, wipe, or another round).
      this.setFallback(ctx, `You are down — the world swims dark and your limbs will not answer. (Rest or victory can bring you back.)`);
      const enc = this.withPendingJoins(ctx, readCombat(ctx.model));
      if (enc.active && !this.tryEndCombat(ctx, enc, hp)) {
        this.driveUntilPlayer(ctx, this.advance(ctx, enc), hp, intent.actorId);
      }
      return;
    }

    // A generic live-combat command ("attack the nearest threat") often grounds as attack with a
    // null targetId because it names no entity. The encounter itself is the authoritative target
    // set, so choose from its living opposite side instead of claiming nobody is in reach. Do this
    // only for an ALREADY-ACTIVE encounter: outside combat, a null target remains ambiguous and must
    // not make the engine pick a peaceful bystander on the player's behalf.
    let encounter = reaped ? null : this.activeOrNull(ctx);
    const inferredTargetId = !intent.targetId && encounter ? this.pickTarget(ctx, encounter, intent.actorId, hp) : null;
    const targetId = intent.targetId ?? inferredTargetId;
    const target = targetId ? ctx.model.entities.get(targetId) : undefined;
    if (!target || !this.combatantOf(ctx, target)) {
      this.setFallback(ctx, `You move to attack, but there is no valid target in reach. ${intent.input}`);
      return;
    }
    const loc = partyLocationOf(ctx.model);
    if (!loc || actor.locationId !== loc || target.locationId !== loc) {
      this.setFallback(ctx, `You move to attack, but there is no valid target in reach. ${intent.input}`);
      return;
    }
    if ((target.stats?.currentHp ?? 0) <= 0) {
      this.setFallback(ctx, `${this.nameOf(ctx, target.id)} is already down.`);
      return;
    }
    // Friendly-fire guard. A fuzzy classification ("strike the wight before it reaches Maelle")
    // resolves targetId to the first PRESENT entity named in the line — which is often a companion,
    // not the intended foe. Accidental ally-attacks still stay the hand. A direct "attack Maelle" /
    // "betray Maelle" line is deliberate, so the relationship breaks and combat may form.
    if (target.partyMember) {
      if (!this.deliberatePartyAttack(intent.input, target)) {
        this.setFallback(ctx, `You check the blow — ${this.nameOf(ctx, target.id)} stands at your side, not against you.`);
        return;
      }
      this.markHostileToParty(ctx, target.id);
    }

    // The reap above only ENQUEUED the end (the reducer applies at commit) — so a reaped
    // encounter must read as inactive here, letting a fresh fight form in the new room.
    if (!encounter) {
      const started = this.startEncounter(ctx, intent.actorId, target.id);
      if (!started) {
        this.setFallback(ctx, `You move to attack, but a fight cannot form here. ${intent.input}`);
        return;
      }
      encounter = started;
      // Open the violence from the action the player actually described (r4 P2: a fire-brand
      // shove was narrated as a canned "flat arc aimed at its skull"). Mechanics are untouched —
      // this only phrases the scene-set.
      if (intent.input.trim()) {
        ctx.data.combatStartBeat =
          `${ctx.data.combatStartBeat as string} The player declared: "${intent.input.trim()}" — open the violence from that action.`;
      }
      // A fresh fight the PC picked with a faction member sours that member's present kin toward
      // the PC (co-located propagation). Once per fight — this only runs when an encounter forms.
      if (!target.partyMember) this.propagateFactionChill(ctx, intent.actorId, target.id);
    }

    if (encounter.order[encounter.turnIndex] !== intent.actorId) {
      this.setFallback(ctx, `You tense to strike, but it is not your turn in the exchange.`);
      return;
    }

    const playerSwing = this.resolveSwing(ctx, intent.actorId, target.id, hp, intent.weaponId ?? undefined);
    if (!playerSwing) return;
    this.afterSwing(ctx, playerSwing, hp);
    if (this.tryEndCombat(ctx, encounter, hp)) return;

    encounter = this.advance(ctx, encounter);
    this.driveUntilPlayer(ctx, encounter, hp, intent.actorId);
  }

  private startEncounter(ctx: TickContext, actorId: string, targetId: string): CombatEncounter | null {
    const loc = partyLocationOf(ctx.model);
    if (!loc) return null;
    const ids = new Set<string>();
    for (const e of entitiesAt(ctx.model, loc)) {
      if (!(e.stats && e.stats.currentHp > 0 && this.statBlockFor(ctx, e))) continue;
      // Only REAL combatants are conscripted: party companions (allies), monsters (a pack fights
      // together), and NPCs already hostile to the party. A peaceful statted bystander — a vendor or
      // townsfolk who merely carries a weapon or goods (so `fromGameState` seeded stats) — is NOT swept
      // in: `sideOf` would misclassify it "enemy", it would attack the player, block the fight from
      // ending (enemyAlive stays true), and be killed for XP + looted (audit). The attacker + its named
      // target are always added explicitly below, so a DELIBERATE attack on a neutral still forms.
      if (e.partyMember || e.kind === "monster" || isPartyHostile(ctx.model, e.id)) ids.add(e.id);
    }
    ids.add(actorId);
    ids.add(targetId);
    const combatants = [...ids]
      .map((id) => {
        const e = ctx.model.entities.get(id);
        return e ? this.combatantOf(ctx, e) : null;
      })
      .filter((c): c is Combatant => c !== null);
    if (combatants.length < 2) return null;

    const order = rollInitiative(combatants, ctx.services.rng).map((entry) => entry.id);
    const turnIndex = Math.max(0, order.indexOf(actorId));
    const encounter: CombatEncounter = { active: true, locationId: loc, order, allies: [], turnIndex, round: 1 };
    ctx.enqueue({ type: "startCombat", locationId: loc, order, turnIndex, round: 1 });
    this.emitOrDefer(ctx, {
      kind: "system",
      level: "info",
      message: `Combat begins. Initiative: ${order.map((id) => this.nameOf(ctx, id)).join(" -> ")}.`,
    });
    // One LLM scene-set at the START of a fight. The only narrated combat beats are start + end —
    // every swing in between resolves as a deterministic mechanical line with no model call.
    ctx.data.combatStartBeat =
      `Violence erupts — ${this.nameOf(ctx, actorId)} strikes at ${this.nameOf(ctx, targetId)} and the room turns to a fight. ` +
      `Set the scene in a sentence or two; do not narrate individual blows.`;
    return encounter;
  }

  /** The live encounter, or null when none is active. */
  private activeOrNull(ctx: TickContext): CombatEncounter | null {
    const enc = this.withPendingJoins(ctx, readCombat(ctx.model));
    return enc.active ? enc : null;
  }

  /**
   * The encounter as it WILL read once this tick's queued `joinCombat` commands land.
   *
   * Commands commit at the end of the tick, so a joiner enqueued by `tryAllyJoins` is absent from
   * the slice for the rest of this tick — and every turn computation downstream would run against
   * an order one shorter than the one the reducer is about to write. In the reproduced live case that
   * desynced the pointer permanently: the module wrapped a 2-long order 1 → 0 and stopped, believing
   * index 1 was the player, while the reducer spliced the ally in and stepped a 3-long order
   * 1 → 2 → 0. The committed pointer came to rest on the MONSTER, so every later player swing was
   * refused by the "not your turn" gate and the fight deadlocked until movement reaped it.
   *
   * Mirrors `joinCombat`'s splice exactly — at `turnIndex + 1`, per joiner, in enqueue order —
   * because the two must agree on positions, not merely on membership.
   */
  private withPendingJoins(ctx: TickContext, enc: CombatEncounter): CombatEncounter {
    if (!enc.active) return enc;
    const order = [...enc.order];
    const allies = [...enc.allies];
    let changed = false;
    for (const cmd of ctx.queue) {
      if (cmd.type !== "joinCombat" || order.includes(cmd.entityId)) continue;
      order.splice(enc.turnIndex + 1, 0, cmd.entityId);
      if (cmd.ally && !allies.includes(cmd.entityId)) allies.push(cmd.entityId);
      changed = true;
    }
    return changed ? { ...enc, order, allies } : enc;
  }

  /**
   * End a stranded encounter: the party moved away (fled — movement is the disengage), or no
   * living foe remains at the fight's location. Ending it releases the heartbeat gate, so the
   * autonomy module re-registers proactive NPCs on the next tick. Returns true if it reaped.
   */
  private reapStaleCombat(ctx: TickContext, hp: Map<string, number>): boolean {
    const enc = readCombat(ctx.model);
    if (!enc.active) return false;
    const loc = partyLocationOf(ctx.model);
    const fled = loc !== enc.locationId;
    const foeStands = enc.order.some((id) => {
      const e = ctx.model.entities.get(id);
      return (
        !!e &&
        this.sideOf(ctx, id) === "enemy" &&
        (hp.get(id) ?? 0) > 0 &&
        e.locationId === enc.locationId
      );
    });
    if (!fled && foeStands) return false;
    // A reap with the party still ON the field means the foes are down or gone — credit any enemy
    // that is DOWN and still present (07-18 #5 latent class: a cross-tick non-swing down used to
    // reap with no XP). A foe that despawned or walked off alive earns nothing, and fleeing the
    // fight forfeits the credit.
    if (!fled) {
      const pcId = playerEntity(ctx.model)?.id;
      if (pcId) {
        for (const id of enc.order) {
          if (this.sideOf(ctx, id) === "enemy" && ctx.model.entities.has(id) && (hp.get(id) ?? 0) <= 0) {
            this.awardKillXp(ctx, pcId, id);
          }
        }
      }
    }
    // The ally note rides in `(GM: …)` form and BEFORE the trailing directive, both deliberately:
    // the echo path strips parenthesized notes wherever they appear but only strips directives from
    // the TAIL, so a plain sentence appended after "Describe the flight…" would leak the whole beat
    // onto the player's screen on an empty completion (caught live, r11). Each ally's outcome is
    // already its own `·` ledger line, so nothing is lost by keeping it out of the echo.
    const abandoned = fled ? this.resolveAbandonedAllies(ctx, enc, hp) : "";
    ctx.data.combatEndBeat = fled
      ? `The party breaks away and leaves the fight behind, unresolved.${abandoned} Describe the flight and the moment of escape in a sentence or two.`
      : `The enemies are gone and the fighting stops. Describe the aftermath in a sentence or two.`;
    this.endCombat(ctx);
    return true;
  }

  /**
   * THE PEOPLE YOU LEFT IN IT (r11 F-5, owner decision 2026-08-01).
   *
   * A bystander who took the party's side (`enc.allies` — Sela snatching the fire-iron off her own
   * hearth) used to be DELETED with the encounter: the engine ended the fight, the transients were
   * culled, and her outcome was never determined while the prose kept her swinging. Now she rolls
   * her own way out, once, against the same DC the player just faced: clear, clear-but-hurt, or
   * down where she stood — real state through the reducer, so the next scene has to answer for it.
   *
   * Party members are NOT here: they travel with the party by the move itself. Returns a short
   * GM-facing addendum for the flight beat (empty when nobody was left behind ⇒ byte-identical).
   */
  private resolveAbandonedAllies(ctx: TickContext, enc: CombatEncounter, hp: Map<string, number>): string {
    const at = enc.locationId;
    const to = partyLocationOf(ctx.model);
    if (!at || !to) return "";
    const foes: EscapeFoe[] = enc.order
      .filter((id) => this.sideOf(ctx, id) === "enemy" && (hp.get(id) ?? 0) > 0)
      .map((id) => ({ id, name: this.nameOf(ctx, id), level: this.levelOf(ctx, id) }));
    const dc = escapeDc(foes);
    const notes: string[] = [];
    for (const id of enc.allies ?? []) {
      const ally = ctx.model.entities.get(id);
      if (!ally || ally.partyMember || ally.locationId !== at) continue;
      const current = hp.get(id) ?? ally.stats?.currentHp ?? 0;
      if (current <= 0) continue;
      const outcome = resolveAllyFate(this.levelOf(ctx, id), ally.stats?.maxHp ?? current, current, dc, ctx.services.rng);
      const name = this.nameOf(ctx, id);
      if (outcome.fate === "downed") {
        ctx.enqueue({ type: "adjustHp", entityId: id, by: -current });
        ctx.enqueue({ type: "setCondition", entityId: id, condition: "unconscious", active: true });
      } else {
        if (outcome.fate === "wounded" && outcome.hpAfter !== undefined && outcome.hpAfter < current) {
          ctx.enqueue({ type: "adjustHp", entityId: id, by: outcome.hpAfter - current });
        }
        // Teleport: they came out the same way the party did, on the party's own move — this is
        // not a routine reconciliation and must not be re-pathed.
        ctx.enqueue({ type: "moveEntity", entityId: id, to, teleport: true });
      }
      const summary = allyFateSummary(name, outcome);
      ctx.emit({ kind: "stateChanged", summary });
      notes.push(summary);
    }
    return notes.length > 0 ? ` (GM: ${notes.join(" ")} Reflect that exactly; invent no other rescue.)` : "";
  }

  /**
   * A living hostile monster at the party's location opens combat on sight — once per monster
   * (an `aggroed` entity flag), so a fled or lost fight is not an endless re-engage loop. The
   * downed are not re-mauled: no aggro while the PC is at 0 HP. Returns true if a fight opened.
   */
  private tryMonsterAggro(ctx: TickContext, hp: Map<string, number>): boolean {
    const loc = partyLocationOf(ctx.model);
    const player = playerEntity(ctx.model);
    if (!loc || !player || (hp.get(player.id) ?? 0) <= 0) return false;
    // A monster the player is peacefully ADDRESSING this very tick (an offering, a parley, a
    // trade attempt) holds its charge for the beat — otherwise the same turn's prose narrates the
    // overture landing while the mechanics open a fight the story never chose (live D3, 07-17).
    // The aggro flag is NOT burned: ignore it next turn and it still attacks on sight.
    const overtureTargets = peacefulOvertureTargets(ctx);
    const failedDeescalation = ctx.data.deescalationFailed as string | undefined;
    // Interior-ambush telegraph (r4 P3): a monster the player did NOT walk in on — already placed
    // in the room, or spawned into it mid-scene — announces itself for one beat before its aggro
    // opens the fight next turn. Walking INTO the room keeps the same-tick ambush (the player
    // chose the door). Seen-marks are durable (module slice) and never burn the aggro flag.
    const preLoc = ctx.data.combatPreLoc as string | null | undefined;
    const walkedIn = preLoc !== undefined && preLoc !== loc;
    const seenPatch: Record<string, boolean> = {};
    const telegraphBeats: string[] = [];
    for (const e of entitiesAt(ctx.model, loc)) {
      if (e.kind !== "monster" || e.partyMember) continue;
      // A talked-down monster stays down (r6 P1) — the social resolution is mechanically real.
      if (this.isCalmed(ctx.model, e.id)) continue;
      // A FAILED de-escalation drops this tick's suppression for that one entity: it answers the
      // talk with violence now, instead of ambushing a turn later as if the talk never happened.
      if (overtureTargets.has(e.id) && e.id !== failedDeescalation) continue;
      if ((hp.get(e.id) ?? 0) <= 0 || this.hasAggroed(ctx.model, e.id)) continue;
      if (!this.combatantOf(ctx, e)) continue;
      if (!walkedIn && !this.hasSeenMonster(ctx.model, e.id)) {
        seenPatch[e.id] = true;
        telegraphBeats.push(`${this.nameOf(ctx, e.id)} is on you — no words, a breath from violence.`);
        continue;
      }
      ctx.enqueue({ type: "modulePatch", module: AGGRO_MODULE, patch: { [e.id]: true } });
      const started = this.startEncounter(ctx, e.id, player.id);
      if (!started) return false;
      ctx.data.combatStartBeat =
        `${this.nameOf(ctx, e.id)} turns on ${this.nameOf(ctx, player.id)} — no words, only violence. ` +
        `Set the ambush scene in a sentence or two; do not narrate individual blows.`;
      // ONE narration block per tick, exactly as the `itemActionTurn` branch does (see its comment):
      // the player who WALKS INTO the ambush still has core's parked "You travel to X." intent, so
      // without this both the NarrationModule and the ambush beat narrate the same moment — two
      // model-authored, mutually contradictory openings (one calm arrival, one ambush). Lifting folds
      // the player's line into the ambush beat; a deterministic/resolved intent is never lifted, so
      // refusal contract behavior is preserved.
      this.liftPlayerLine(ctx);
      this.driveUntilPlayer(ctx, started, hp, player.id, { stopIfPlayerDown: true });
      // A telegraphed monster stays marked even when a second (already-seen) monster opened a
      // fight this same tick — its own aggro follows next turn without a duplicate warning.
      if (Object.keys(seenPatch).length > 0) {
        ctx.enqueue({ type: "modulePatch", module: MONSTER_SEEN_MODULE, patch: seenPatch });
      }
      return true;
    }
    if (Object.keys(seenPatch).length > 0) {
      ctx.enqueue({ type: "modulePatch", module: MONSTER_SEEN_MODULE, patch: seenPatch });
      const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
      beats.push(...telegraphBeats);
      ctx.data.eventBeats = beats;
    }
    return false;
  }

  /** Durable has-the-player-seen-this-monster read (see `MONSTER_SEEN_MODULE`). */
  private hasSeenMonster(model: WorldModel, id: string): boolean {
    return (model.modules[MONSTER_SEEN_MODULE] as Record<string, boolean> | undefined)?.[id] === true;
  }

  /**
   * A betrayed NPC is no longer protected by party-side targeting. They may open combat against the
   * PC once, using the same on-sight shape as monster aggro but gated by an explicit betrayal flag.
   */
  private tryHostileNpcAggro(ctx: TickContext, hp: Map<string, number>): boolean {
    const loc = partyLocationOf(ctx.model);
    const player = playerEntity(ctx.model);
    if (!loc || !player || (hp.get(player.id) ?? 0) <= 0) return false;
    // Same courtesy as the monster path: a peaceful overture holds the betrayal for the beat —
    // unless the de-escalation contest already ran and LOST, in which case the knife answers now.
    const overtureTargets = peacefulOvertureTargets(ctx);
    const failedDeescalation = ctx.data.deescalationFailed as string | undefined;
    for (const e of entitiesAt(ctx.model, loc)) {
      if (e.kind !== "npc" || !isPartyHostile(ctx.model, e.id)) continue;
      if (overtureTargets.has(e.id) && e.id !== failedDeescalation) continue;
      if ((hp.get(e.id) ?? 0) <= 0 || this.hasAggroed(ctx.model, e.id)) continue;
      if (!this.combatantOf(ctx, e)) continue;
      this.markHostileToParty(ctx, e.id);
      ctx.enqueue({ type: "modulePatch", module: AGGRO_MODULE, patch: { [e.id]: true } });
      const started = this.startEncounter(ctx, e.id, player.id);
      if (!started) return false;
      ctx.data.combatStartBeat =
        `${this.nameOf(ctx, e.id)} turns on ${this.nameOf(ctx, player.id)} from inside the party. ` +
        `Set the betrayal scene in a sentence or two; do not narrate individual blows.`;
      // Same one-block rule as monster aggro above: fold the player's own parked line into the
      // betrayal beat instead of letting the NarrationModule narrate a second, calmer version of it.
      this.liftPlayerLine(ctx);
      this.driveUntilPlayer(ctx, started, hp, player.id, { stopIfPlayerDown: true });
      return true;
    }
    return false;
  }

  /** Durable talked-down read (see `CALMED_MODULE`). */
  private isCalmed(model: WorldModel, id: string): boolean {
    return (model.modules[CALMED_MODULE] as Record<string, boolean> | undefined)?.[id] === true;
  }

  /** The combat level the de-escalation/parley DC scales with (1 when unstatable). */
  private levelOf(ctx: TickContext, id: string): number {
    const e = ctx.model.entities.get(id);
    if (!e) return 1;
    return this.combatantOf(ctx, e)?.stats.level ?? 1;
  }

  /**
   * Is the player's line an attempt to STOP the violence? The classifier's closed `speechAct` names
   * it (r8 regex audit); `DEESCALATION_RE` is the fallback for a plan that carries no answer — a
   * scripted stub, a pre-r8 persisted plan, or a double classifier failure — so an outage keeps
   * exactly today's behavior, including the untargeted shout ("EVERYONE STOP!").
   *
   * The two lines the word-list got wrong, both reproduced against shipped code: "Brann, stop him!"
   * (an ORDER to a companion, which is a call for aid) and "Enough of this — kill it!" (a declared
   * ATTACK that opened a surrender bid through the `enough` arm).
   *
   * This answers WHAT the line is, never WHO it is aimed at — `addressesTheFight` below stays the
   * code-side authority on that, and both must pass before a parley rolls.
   */
  private isDeescalation(ctx: TickContext): boolean {
    const named = (ctx.data.plan as TurnPlan | undefined)?.speechAct;
    if (named !== undefined && named !== null) return named === "deescalate";
    return ctx.trigger.kind === "player" && DEESCALATION_RE.test(ctx.trigger.input);
  }

  /**
   * Is the player's line aimed at the FIGHT, or at somebody standing outside it? A parley may only
   * fire on the former (r7 P0). The classifier's read is the authority: a `dialogueToNpc` (or any
   * targeted line) whose target is a present entity NOT on the enemy side is a conversation — the
   * stop-words regex has no business converting it into a talk-down roll. Untargeted lines
   * ("EVERYONE STOP!") still address the fight.
   */
  private addressesTheFight(ctx: TickContext, encounter: CombatEncounter): boolean {
    const plan = ctx.data.plan as TurnPlan | undefined;
    const targetId = plan?.targetId;
    if (!targetId || !ctx.model.entities.has(targetId)) return true;
    // Yelling at anyone IN the fight — foe or your own ally ("ODA, STOP!") — is aimed at the fight.
    if (encounter.order.includes(targetId)) return true;
    // Speech to a BYSTANDER: a stop-COMMAND still parleys (the r6 contract — "Sela, stop them!"
    // leads with the plea), but a conversation where a stop-word surfaces mid-paragraph is
    // dialogue. Two honest signals, either suffices: the de-escalation cue LEADS the line, or the
    // line names a living foe. Only `dialogueToNpc` gets this scrutiny — an untargeted or
    // freeform/aid-shaped line keeps unconditional parley.
    if (plan?.kind !== "dialogueToNpc") return true;
    const input = ctx.trigger.kind === "player" ? ctx.trigger.input : "";
    // The "cue LEADS the line" signal was a positional proxy for "this is a plea, not a chat that
    // happens to contain a stop-word". When the classifier has named the speech act (r8) that proxy
    // is redundant — a line it calls `deescalate` IS the plea, wherever the words fall. The 48-char
    // window survives only for a plan with no answer, the same null path `isDeescalation` uses.
    if (plan.speechAct === "deescalate") return true;
    if (plan.speechAct == null && DEESCALATION_RE.test(input.slice(0, 48))) return true;
    // "names a living foe" goes through the shared binder (`src/rules/name-match.ts`) on the
    // `uncased` surface — player-typed, so casing proves nothing, but this is a NARRATIVE ACTION
    // site and never `player-query`: a wrong hit here suppresses a real conversation and rolls a
    // parley instead, so the whole-name relaxation stays off (a bystander line about scenery must
    // not address the fight — the reverted attempt's second casualty). The old test — any ≥3-char
    // whitespace token of the foe's name as a SUBSTRING of the line — meant a foe called "Oda the
    // Wayfarer" or "The Saltmother" was named by the article "the", so every bystander conversation
    // containing a stop-word counted as addressing the fight.
    return encounter.order.some(
      (id) =>
        this.sideOf(ctx, id) === "enemy" &&
        nameMentionedIn(input, this.nameOf(ctx, id), { surface: "uncased" }),
    );
  }

  /**
   * The entity ids a peaceful overture may target this tick that are actually HOSTILE — a monster
   * that would aggro on sight, or an NPC carrying the party-hostile flag. De-escalation contests
   * are rolled against one of these per turn.
   */
  private hostileOvertureTargets(ctx: TickContext, hp: Map<string, number>): string[] {
    const loc = partyLocationOf(ctx.model);
    if (!loc) return [];
    const out: string[] = [];
    for (const id of peacefulOvertureTargets(ctx)) {
      const e = ctx.model.entities.get(id);
      if (!e || e.locationId !== loc || (hp.get(id) ?? 0) <= 0) continue;
      if (e.kind === "monster" && !e.partyMember && !this.isCalmed(ctx.model, id) && this.combatantOf(ctx, e)) {
        out.push(id);
      } else if (e.kind === "npc" && isPartyHostile(ctx.model, id) && this.combatantOf(ctx, e)) {
        out.push(id);
      }
    }
    return out;
  }

  /**
   * Roll a peaceful overture aimed at a hostile (r6 P1). Before this, the overture merely held the
   * aggro for one beat — the fiction could talk a hostile down, resolve the scene socially, and
   * the engine would start the fight the same turn or the next, because nothing mechanical ever
   * changed. Now the talk is a real Persuasion contest: success marks the entity CALMED (durable —
   * it never on-sight aggros again, and an NPC's party-hostile flag clears), failure drops the
   * one-beat suppression so it answers talk with violence immediately. One roll per turn; other
   * hostiles addressed in the same line hold their charge for the beat as before.
   */
  private async tryDeescalate(ctx: TickContext, hp: Map<string, number>): Promise<void> {
    const player = playerEntity(ctx.model);
    if (!player || (hp.get(player.id) ?? 0) <= 0) return;
    const targetId = this.hostileOvertureTargets(ctx, hp)[0];
    if (!targetId) return;
    const dc = Math.min(18, 11 + this.levelOf(ctx, targetId));
    const name = this.nameOf(ctx, targetId);
    const label = `Charisma (Persuasion): talk ${name} down`;
    if (ctx.services.client?.promptRoll) {
      await ctx.services.client.promptRoll({
        actorId: player.id,
        ability: "cha",
        skill: "Persuasion",
        dc,
        label: `${label} — success and it stands down for good; failure and it answers with violence. DC ${dc}.`,
      });
    }
    const pc = ctx.services.campaign.characters.find((c) => c.id === player.id);
    const smods = statusMods(ctx.model, player.id);
    const result = resolveCheck(
      { abilityScore: pc?.stats.abilities.cha ?? 10, dc, bonus: smods.check, disadvantage: smods.disadvantage },
      ctx.services.rng,
    );
    ctx.emit({
      kind: "diceRolled",
      actorId: player.id,
      notation: "1d20",
      rolls: result.rolls,
      total: result.total,
      purpose: `${label} (DC ${dc})`,
      success: result.success,
    });
    if (result.success) {
      ctx.enqueue({ type: "modulePatch", module: CALMED_MODULE, patch: { [targetId]: true } });
      if (isPartyHostile(ctx.model, targetId)) {
        ctx.apply({ type: "setFlag", scope: "world", key: partyHostileFlag(targetId), value: false });
      }
      ctx.emit({ kind: "stateChanged", summary: `${name} stands down.` });
      // The overture's own narration proceeds in peace — the scene really is resolved socially.
    } else {
      // Failure is honest: the suppression lifts for THIS entity, so the aggro block below opens
      // the fight on this very tick instead of pretending the talk never happened.
      ctx.data.deescalationFailed = targetId;
    }
  }

  /**
   * Parley inside a live fight (r6 P1). The player's appeal spends their turn. Success: every
   * living foe is calmed, every party-hostile flag clears, and the fight ends — talked down, not
   * won. Failure: the fight rages on without them (the other side acts). This is the "talk" verb
   * the combat panel never offered.
   */
  private async resolveParley(ctx: TickContext, encounter: CombatEncounter, hp: Map<string, number>): Promise<void> {
    const player = playerEntity(ctx.model);
    if (!player) return;
    const foes = encounter.order.filter((id) => this.sideOf(ctx, id) === "enemy" && (hp.get(id) ?? 0) > 0);
    const dc = Math.min(18, 13 + Math.max(1, ...foes.map((id) => this.levelOf(ctx, id))));
    const foeNames = foes.map((id) => this.nameOf(ctx, id)).join(", ");
    const label = `Charisma (Persuasion): stop the fight`;
    if (ctx.services.client?.promptRoll) {
      await ctx.services.client.promptRoll({
        actorId: player.id,
        ability: "cha",
        skill: "Persuasion",
        dc,
        label: `${label} (${foeNames}) — success ends the fight without another blow. DC ${dc}.`,
      });
    }
    const pc = ctx.services.campaign.characters.find((c) => c.id === player.id);
    const smods = statusMods(ctx.model, player.id);
    const result = resolveCheck(
      { abilityScore: pc?.stats.abilities.cha ?? 10, dc, bonus: smods.check, disadvantage: smods.disadvantage },
      ctx.services.rng,
    );
    ctx.emit({
      kind: "diceRolled",
      actorId: player.id,
      notation: "1d20",
      rolls: result.rolls,
      total: result.total,
      purpose: `${label} (DC ${dc})`,
      success: result.success,
    });
    if (result.success) {
      const calmPatch: Record<string, boolean> = {};
      for (const id of foes) {
        calmPatch[id] = true;
        if (isPartyHostile(ctx.model, id)) {
          ctx.apply({ type: "setFlag", scope: "world", key: partyHostileFlag(id), value: false });
        }
      }
      ctx.enqueue({ type: "modulePatch", module: CALMED_MODULE, patch: calmPatch });
      this.liftPlayerLine(ctx);
      ctx.emit({ kind: "stateChanged", summary: `The fight stops — talked down, not won.` });
      ctx.data.combatEndBeat =
        `The appeal lands — weapons lower, the violence goes out of the moment. ` +
        `Describe the stand-down in a sentence or two; nobody else swings.`;
      this.endCombat(ctx);
      return;
    }
    // A failed appeal costs the turn: the player pleaded while the fight raged on without them.
    this.liftPlayerLine(ctx);
    this.driveUntilPlayer(ctx, this.advance(ctx, encounter), hp, player.id, { stopIfPlayerDown: true });
  }


  private driveUntilPlayer(
    ctx: TickContext,
    encounter: CombatEncounter,
    hp: Map<string, number>,
    playerId: string,
    opts?: {
      /**
       * Stop the drive the moment the PLAYER hits the floor (the aggro/ambush paths). Without this
       * an ambush that downed the PC early kept driving — the loop's only exit is the player's
       * LIVE turn — and ground the companions down (Oda 26→3) with the whole fight compressed into
       * the ambush tick (r2 P1). Ordinary rounds keep the old behavior: a fight the player was IN
       * continues around their fallen body (the N9 soft-lock fix depends on it).
       */
      stopIfPlayerDown?: boolean;
    },
  ): void {
    let current = encounter;
    let guard = 0;
    while (current.active && guard < Math.max(1, current.order.length * 3)) {
      guard += 1;
      if (opts?.stopIfPlayerDown && (hp.get(playerId) ?? 0) <= 0) return;
      const actorId = current.order[current.turnIndex];
      if (!actorId) return;
      const actor = ctx.model.entities.get(actorId);
      const unable = actor?.stats?.conditions.includes("unconscious") === true;
      if (actorId === playerId && (hp.get(actorId) ?? 0) > 0 && !unable) return;
      if ((hp.get(actorId) ?? 0) <= 0 || unable) {
        current = this.advance(ctx, current);
        continue;
      }
      const targetId = this.pickTarget(ctx, current, actorId, hp);
      if (!targetId) {
        ctx.data.combatEndBeat ??= `The enemies are gone and the fighting stops. Describe the aftermath in a sentence or two.`;
        this.endCombat(ctx);
        return;
      }
      // A caster enemy may loose a known offensive spell instead of swinging (seeded, id-keyed so
      // the choice never disturbs the shared combat stream). A cast handles its own hp bookkeeping,
      // exactly as `afterSwing` does; on any other actor this falls through to a normal weapon swing.
      if (this.tryEnemyCast(ctx, actorId, targetId, hp, current)) {
        if (this.tryEndCombat(ctx, current, hp)) return;
        current = this.advance(ctx, current);
        continue;
      }
      const swing = this.resolveSwing(ctx, actorId, targetId, hp);
      if (!swing) {
        current = this.advance(ctx, current);
        continue;
      }
      this.afterSwing(ctx, swing, hp);
      if (this.tryEndCombat(ctx, current, hp)) return;
      current = this.advance(ctx, current);
    }
  }

  private resolveSwing(
    ctx: TickContext,
    actorId: string,
    targetId: string,
    hp: Map<string, number>,
    weaponId?: string,
  ): ResolvedSwing | null {
    const actor = ctx.model.entities.get(actorId);
    const target = ctx.model.entities.get(targetId);
    if (!actor || !target) return null;
    const attacker = this.combatantOf(ctx, actor);
    const defender = this.combatantOf(ctx, target);
    if (!attacker || !defender) return null;
    attacker.currentHp = hp.get(actorId) ?? attacker.currentHp;
    defender.currentHp = hp.get(targetId) ?? defender.currentHp;
    const weapon = this.weaponFor(ctx, actor, weaponId);
    const exh = exhaustionAttackMods(exhaustionOf(actor.stats));
    const sm = statusMods(ctx.model, actorId);
    // Advantage sources (5e): a status effect that grants it, or a helpless target — an
    // unconscious/incapacitated foe is struck with advantage. `disadvantage` still cancels it in
    // `rollD20` when both are set (e.g. an exhausted attacker vs a downed foe rolls straight).
    const targetHelpless =
      (hp.get(targetId) ?? defender.currentHp) <= 0 ||
      target.stats?.conditions.includes("unconscious") === true;
    const result = resolveAttack(attacker, defender, weapon, ctx.services.rng, {
      toHit: exh.toHit + sm.attack,
      advantage: sm.advantage || targetHelpless,
      disadvantage: exh.disadvantage || sm.disadvantage,
    });
    const label = `${this.nameOf(ctx, actorId)} → ${this.nameOf(ctx, targetId)} · ${weapon.name} vs AC ${result.targetAc}`;
    this.emitOrDefer(ctx, {
      kind: "diceRolled",
      actorId,
      notation: "1d20",
      rolls: [result.natural],
      total: result.attackRoll,
      purpose: label,
      success: result.hit,
    });
    return { actorId, targetId, result };
  }

  private afterSwing(ctx: TickContext, swing: ResolvedSwing, hp: Map<string, number>): void {
    if (!swing.result.hit || swing.result.damage <= 0) {
      this.recordRoundLine(
        ctx,
        `${this.nameOf(ctx, swing.actorId)} misses ${this.nameOf(ctx, swing.targetId)}`,
      );
      return;
    }
    const before = hp.get(swing.targetId) ?? 0;
    const after = Math.max(0, before - swing.result.damage);
    hp.set(swing.targetId, after);
    ctx.enqueue({ type: "adjustHp", entityId: swing.targetId, by: -swing.result.damage });
    const downed = before > 0 && after === 0;
    if (downed) {
      ctx.enqueue({ type: "setCondition", entityId: swing.targetId, condition: "unconscious", active: true });
      this.lootDowned(ctx, swing.actorId, swing.targetId);
      this.warmPartyOnKill(ctx, swing.actorId, swing.targetId, hp);
      this.awardKillXp(ctx, swing.actorId, swing.targetId);
    }
    // The combat play-by-play: a compact, deterministic tracker line per landed hit (renders as a
    // `· …` stateChanged beat). This replaces the old per-swing LLM narration — the loop reads like a
    // D&D combat tracker and makes no model call, so no swing is a violence-refusal surface.
    const target = ctx.model.entities.get(swing.targetId);
    const maxHp = target ? this.statBlockFor(ctx, target)?.maxHp : undefined;
    const name = this.nameOf(ctx, swing.targetId);
    const crit = swing.result.critical ? " (critical — natural 20)" : "";
    const hpText = maxHp !== undefined ? `${after}/${maxHp} HP` : `${after} HP`;
    // Tracker-style, verb-free so it reads right for any combatant incl. the PC ("You: 3 …").
    this.emitOrDefer(ctx, {
      kind: "stateChanged",
      summary: `${name}: ${swing.result.damage} ${swing.result.damageType}${crit} → ${hpText}${downed ? " (down)" : ""}`,
      changes: { entityId: swing.targetId, hp: after, damage: swing.result.damage },
    });
    this.recordRoundLine(
      ctx,
      `${this.nameOf(ctx, swing.actorId)} hits ${name} for ${swing.result.damage} ${swing.result.damageType}${crit}${downed ? " — down" : ""}`,
    );
  }

  /** Accumulate this tick's swing outcomes for the mid-fight round beat (one line per swing). */
  private recordRoundLine(ctx: TickContext, line: string): void {
    const lines = (ctx.data.combatRoundLines as string[] | undefined) ?? [];
    lines.push(line);
    ctx.data.combatRoundLines = lines;
  }

  /** The chance a spell-carrying enemy opens its turn with a working rather than a weapon swing. */
  private static readonly ENEMY_CAST_CHANCE = 0.6;

  /**
   * A caster enemy may loose a known OFFENSIVE spell at `targetId` instead of swinging. Enemy-side
   * only (companions still fight with steel). The cast-or-swing decision and the spell pick use an
   * id-keyed private RNG (`mulberry32(fnv1a(...))`) so they never perturb the shared combat stream —
   * only the spell's own dice come from `ctx.services.rng`, keeping the fight replay-deterministic.
   * Handles its own hp-map bookkeeping + tracker line exactly as {@link afterSwing}. Returns true
   * iff a spell was cast (the caller then runs the same end/advance path a swing would).
   */
  private tryEnemyCast(
    ctx: TickContext,
    actorId: string,
    targetId: string,
    hp: Map<string, number>,
    encounter: CombatEncounter,
  ): boolean {
    if (this.sideOf(ctx, actorId) !== "enemy") return false;
    const actor = ctx.model.entities.get(actorId);
    if (!actor) return false;
    const stats = this.statBlockFor(ctx, actor);
    if (!stats || stats.spells.length === 0) return false;
    const known = stats.spells
      .map((id) => this.world.spells.find((s) => s.id === id))
      .filter((s): s is Spell => !!s && isOffensiveSpell(s));
    if (known.length === 0) return false;

    // Deterministic per (actor, round, turn) — independent of how many shared draws preceded it.
    const kr = mulberry32(fnv1a(`${actorId}:cast:${encounter.round}:${encounter.turnIndex}`));
    if (kr() >= CombatModule.ENEMY_CAST_CHANCE) return false;
    const spell = known[Math.floor(kr() * known.length)] ?? known[0]!;

    const targetEntity = ctx.model.entities.get(targetId);
    const targetCombatant = targetEntity ? this.combatantOf(ctx, targetEntity) : null;
    if (!targetEntity || !targetCombatant) return false;
    targetCombatant.currentHp = hp.get(targetId) ?? targetCombatant.currentHp;

    const resolution = resolveSpell(stats, actorId, spell, targetCombatant, ctx.services.rng);

    // The deterministic roll line: the caster's spell attack, or the target's saving throw.
    if (resolution.kind === "attack-damage" && resolution.natural !== undefined) {
      this.emitOrDefer(ctx, {
        kind: "diceRolled",
        actorId,
        notation: "1d20",
        rolls: [resolution.natural],
        total: resolution.attackTotal ?? resolution.natural,
        purpose: resolution.label,
        success: resolution.hit,
      });
    } else if (resolution.save && resolution.targetId) {
      this.emitOrDefer(ctx, {
        kind: "diceRolled",
        actorId: resolution.targetId,
        notation: "1d20",
        rolls: [resolution.save.natural],
        total: resolution.save.total,
        purpose: resolution.label,
        success: resolution.save.success,
      });
    }

    const targetName = this.nameOf(ctx, targetId);
    if ((resolution.damage ?? 0) > 0) {
      const before = hp.get(targetId) ?? targetCombatant.currentHp;
      const after = Math.max(0, before - (resolution.damage ?? 0));
      hp.set(targetId, after);
      ctx.enqueue({ type: "adjustHp", entityId: targetId, by: -(resolution.damage ?? 0) });
      const downed = before > 0 && after === 0;
      if (downed) ctx.enqueue({ type: "setCondition", entityId: targetId, condition: "unconscious", active: true });
      const maxHp = this.statBlockFor(ctx, targetEntity)?.maxHp;
      const hpText = maxHp !== undefined ? `${after}/${maxHp} HP` : `${after} HP`;
      const crit = resolution.critical ? " (critical — natural 20)" : "";
      this.emitOrDefer(ctx, {
        kind: "stateChanged",
        summary: `${targetName}: ${resolution.damage} ${resolution.damageType} (${spell.name})${crit} → ${hpText}${downed ? " (down)" : ""}`,
        changes: { entityId: targetId, hp: after, damage: resolution.damage },
      });
      this.recordRoundLine(
        ctx,
        `${this.nameOf(ctx, actorId)}'s ${spell.name} strikes ${targetName} for ${resolution.damage} ${resolution.damageType}${downed ? " — down" : ""}`,
      );
      return true;
    }
    if (resolution.status) {
      ctx.enqueue({ type: "applyStatusEffect", entityId: targetId, effect: resolution.status });
      this.emitOrDefer(ctx, {
        kind: "stateChanged",
        summary: `${targetName}: ${resolution.status.kind} (${spell.name})`,
        changes: { entityId: targetId, status: resolution.status.kind },
      });
      this.recordRoundLine(ctx, `${this.nameOf(ctx, actorId)}'s ${spell.name} leaves ${targetName} ${resolution.status.kind}`);
      return true;
    }
    // A missed spell attack or a made save — the working fizzles, but the enemy's turn is spent.
    this.emitOrDefer(ctx, {
      kind: "stateChanged",
      summary: `${targetName}: unharmed (${spell.name})`,
      changes: { entityId: targetId },
    });
    this.recordRoundLine(ctx, `${this.nameOf(ctx, actorId)}'s ${spell.name} fails to bite — ${targetName} is unharmed`);
    return true;
  }

  private advance(ctx: TickContext, encounter: CombatEncounter): CombatEncounter {
    if (!encounter.active || encounter.order.length === 0) return encounter;
    const turnIndex = encounter.turnIndex + 1 >= encounter.order.length ? 0 : encounter.turnIndex + 1;
    const round = turnIndex === 0 ? encounter.round + 1 : encounter.round;
    ctx.enqueue({ type: "advanceTurn" });
    return { ...encounter, turnIndex, round };
  }

  private tryEndCombat(ctx: TickContext, encounter: CombatEncounter, hp: Map<string, number>): boolean {
    const partyAlive = encounter.order.some((id) => this.sideOf(ctx, id) === "party" && (hp.get(id) ?? 0) > 0);
    const enemyAlive = encounter.order.some((id) => this.sideOf(ctx, id) === "enemy" && (hp.get(id) ?? 0) > 0);
    if (partyAlive && enemyAlive) return false;
    if (enemyAlive && ctx.data.combatStartBeat !== undefined) {
      // The fight OPENED this very tick and the party is already flat. NEVER resolve the defeat —
      // capture, bad end, left-for-dead — inside the same tick the fight began: the player must see
      // the fight before its consequence lands (r2 P1: a line of dialogue, and the next screen was
      // the captivity UI with the whole lost battle visible only in scrollback). SUSPEND instead:
      // return true so every drive loop stops, but leave the encounter ACTIVE with the PC down.
      // The next player turn's downed path re-enters here — start beat gone — and resolves the
      // defeat as its own visible beat.
      return true;
    }
    if (enemyAlive) {
      // Data-driven defeat outcomes (Workstream E): when the world authors a `defeatOutcomes`
      // table, a lost fight resolves by selecting one gate-eligible outcome (seeded weighted pick)
      // instead of the flat 1-HP revival below. A world that authors none — every bundled world —
      // returns null here and falls through to the historic fallback unchanged.
      if (this.tryDefeatOutcome(ctx, encounter, hp)) {
        this.endCombat(ctx);
        return true;
      }
      // A lost fight is a setback, not a dead save file: the PC is left for dead and comes to
      // at 1 HP once the fighting stops (victors sated — the one-shot aggro flag holds, so a
      // monster does not re-maul the fallen). Companions stay down until a rest.
      const player = playerEntity(ctx.model);
      if (player?.stats && (hp.get(player.id) ?? 0) <= 0) {
        ctx.enqueue({ type: "adjustHp", entityId: player.id, by: 1 });
        ctx.enqueue({ type: "setCondition", entityId: player.id, condition: "unconscious", active: false });
      }
      ctx.data.combatEndBeat =
        `The party is overcome and the fight is lost — the foes move on from the fallen. ` +
        `You come to later, barely alive. Describe the grim awakening in a sentence or two.`;
    } else {
      // The party WON. If the PC went down before the last foe fell (a companion landed the killing
      // blow), revive them to 1 HP + clear unconscious — exactly as the lost-fight branch does.
      // Without this, winning-while-downed strands the PC unconscious at 0 HP: a short `rest` will not
      // revive the downed (only End Day does), so a triumphant aftermath would leave state showing a
      // helpless PC and `rest` doing nothing — strictly WORSE than losing (that path auto-revives to
      // 1 HP). Companions still stay down until a rest, as on a loss.
      const player = playerEntity(ctx.model);
      const pcDown = !!player?.stats && (hp.get(player.id) ?? 0) <= 0;
      if (pcDown && player) {
        ctx.enqueue({ type: "adjustHp", entityId: player.id, by: 1 });
        ctx.enqueue({ type: "setCondition", entityId: player.id, condition: "unconscious", active: false });
      }
      // NAME the fallen (live r3 #1): an unnamed "the last foe falls" let the narrator describe the
      // just-killed foe as still up and waiting on the very kill turn. The beat states WHO is down
      // and that they are out of the fight, so the aftermath prose grounds on the defeat.
      const fallenIds = encounter.order.filter(
        (id) => this.sideOf(ctx, id) === "enemy" && (hp.get(id) ?? 0) <= 0 && ctx.model.entities.has(id),
      );
      // XP decoupled from the damage site (07-18 #5 latent class): every enemy DOWN when the party
      // wins earns its kill XP exactly once — swing/spell kills were already credited (the ledger),
      // so only a non-swing down (an authored event's adjustHp/setCondition, a future DoT) actually
      // awards here, instead of ending with a "defeated" beat and no XP.
      const pcId = playerEntity(ctx.model)?.id;
      if (pcId) for (const id of fallenIds) this.awardKillXp(ctx, pcId, id);
      const fallen = fallenIds.map((id) => this.nameOf(ctx, id));
      const fallenText =
        fallen.length > 0
          ? `${fallen.join(", ")} ${fallen.length === 1 ? "is" : "are"} defeated — down, unmoving, out of the fight. `
          : `The last foe falls. `;
      ctx.data.combatEndBeat = pcDown
        ? `${fallenText}You were down, but the fighting has stopped and you come to, barely alive. Describe the grim aftermath in a sentence or two — the fallen do not rise or act.`
        : `${fallenText}The fighting stops. Describe the aftermath in a sentence or two — the fallen do not rise or act.`;
    }
    this.endCombat(ctx);
    return true;
  }

  /**
   * Resolve a lost fight from the composed defeat-outcome POOL — the engine's setting-neutral generics
   * (when `constitution.useGenericDefeatOutcomes` is on) plus the world-custom `defeatOutcomes`. Builds
   * the scenario gate (who won via `victorTags` plus `cause:"combat-defeat"`),
   * then runs the atomic TRANSACTION `resolveDefeatOutcome`: it preflights every effect on a clone and
   * only applies an outcome whose effects ALL would apply (a malformed effect drops the whole outcome and
   * the next-eligible is tried — never a half-apply, never the reducer crash). Effects apply NOW (resolve
   * phase) so the `combatEndBeat` narration in `narrate` reflects the post-effect world. Returns false
   * when the pool is empty or nothing is eligible, so the caller keeps its 1-HP fallback.
   */
  private tryDefeatOutcome(ctx: TickContext, encounter: CombatEncounter, hp: Map<string, number>): boolean {
    const pcId = playerEntity(ctx.model)?.id;
    const custom = (this.world.constitution?.defeatOutcomes ?? []) as DefeatOutcome[];
    // WHO holds you if a captivity outcome fires: the earliest-in-initiative surviving foe. Threaded
    // into the generic library so `beginCaptivity` has a concrete captor for the follow-up arc.
    const captorId = pcId ? this.primaryVictorId(ctx, encounter, hp) : undefined;
    const generics =
      this.world.constitution?.useGenericDefeatOutcomes && pcId
        ? buildGenericDefeatOutcomes(pcId, captorId ?? undefined, {
            safeLocId: ctx.services.campaign.startingState.locationId,
          })
        : [];
    const outcomes = [...generics, ...custom];
    if (outcomes.length === 0) return false;
    const gate = this.defeatGate(ctx, encounter, hp);
    const chosen = resolveDefeatOutcome(outcomes, gate, ctx.services.rng, {
      dryRun: (c) => ctx.dryRun(c),
      apply: (c) => ctx.apply(c),
    });
    if (!chosen) return false;
    // The authoritative outcome text rides the existing end-of-combat narration seam (onNarrate reads
    // `combatEndBeat`), so the brief headers stay byte-stable — no new context.ts block.
    ctx.data.combatEndBeat = chosen.narratorBrief;
    return true;
  }

  /** Build the generic authored flags, victor-tag bag, and cause for a lost fight. */
  private defeatGate(
    ctx: TickContext,
    encounter: CombatEncounter,
    hp: Map<string, number>,
    cause = "combat-defeat",
  ): DefeatGateContext {
    return {
      flags: ctx.model.flags,
      victorTags: this.victorTagsOf(ctx, encounter, hp),
      cause,
      locationId: encounter.locationId ?? undefined,
    };
  }

  /**
   * WHO beat you — the tag bag of the SURVIVING enemy side, the scenario axis a `DefeatOutcome` keys on
   * (`requiresVictorTags` / `blockedByVictorTags`): each victor's `kind`, its truthy entity-flag keys, and
   * (for an NPC) its `factionId`. Deduped; empty when no foe survives (which simply excludes any
   * victor-gated row).
   */
  private victorTagsOf(ctx: TickContext, encounter: CombatEncounter, hp: Map<string, number>): string[] {
    const pcId = playerEntity(ctx.model)?.id;
    const tags = new Set<string>();
    for (const id of encounter.order) {
      if (this.sideOf(ctx, id) !== "enemy" || (hp.get(id) ?? 0) <= 0) continue;
      const e = ctx.model.entities.get(id);
      if (!e) continue;
      tags.add(e.kind);
      for (const [k, v] of Object.entries(e.flags)) if (v) tags.add(k);
      if (e.kind === "npc") {
        const tpl = this.world.npcs.find((n) => n.id === (e.templateId ?? id));
        if (tpl?.factionId) tags.add(tpl.factionId);
      }
    }
    return [...tags];
  }

  /** The captor for a captivity bad end — the earliest-in-initiative SURVIVING enemy (deterministic). */
  private primaryVictorId(ctx: TickContext, encounter: CombatEncounter, hp: Map<string, number>): string | null {
    for (const id of encounter.order) {
      if (this.sideOf(ctx, id) === "enemy" && (hp.get(id) ?? 0) > 0) return id;
    }
    return null;
  }

  /** A party kill strips the fallen foe's carried items to the killer (with a tracker line each). */
  private lootDowned(ctx: TickContext, killerId: string, victimId: string): void {
    const killer = ctx.model.entities.get(killerId);
    const victim = ctx.model.entities.get(victimId);
    if (
      !killer?.stats ||
      !victim?.stats ||
      this.sideOf(ctx, killerId) !== "party" ||
      this.sideOf(ctx, victimId) !== "enemy"
    ) {
      return;
    }
    for (const itemId of [...victim.stats.inventory]) {
      ctx.enqueue({ type: "transferItem", itemId, from: victimId, to: killerId });
      const itemName = this.itemById(itemId)?.name ?? itemId;
      this.emitOrDefer(ctx, {
        kind: "stateChanged",
        summary: `${this.nameOf(ctx, killerId)} takes ${itemName} from ${this.nameOf(ctx, victimId)}.`,
        changes: { itemId, from: victimId, to: killerId },
      });
    }
  }

  /**
   * A party victory over a genuine enemy grants the PC experience scaled to the foe's challenge level.
   * XP is the party's shared advancement — it always accrues to the PC, whoever landed the killing
   * blow. The reducer's `grantXp` folds in the level-ups; the beat previews the same numbers so the
   * tracker reports "+N XP" (and any level reached) without a model call.
   */
  private awardKillXp(ctx: TickContext, killerId: string, victimId: string): void {
    if (this.sideOf(ctx, killerId) !== "party" || this.sideOf(ctx, victimId) !== "enemy") return;
    const pc = playerEntity(ctx.model);
    if (!pc) return;
    // Exactly-once per victim, across ticks AND award sites (afterSwing + the combat-END
    // chokepoints): the durable credit ledger, plus a same-tick scratch because the enqueued
    // patch only reaches the model at commit.
    const tickCredited = (ctx.data.killXpCredited as Set<string> | undefined) ?? new Set<string>();
    const slice = ctx.model.modules[XP_CREDIT_MODULE] as Record<string, boolean> | undefined;
    if (tickCredited.has(victimId) || slice?.[victimId] === true) return;
    tickCredited.add(victimId);
    ctx.data.killXpCredited = tickCredited;
    ctx.enqueue({ type: "modulePatch", module: XP_CREDIT_MODULE, patch: { [victimId]: true } });
    const victim = ctx.model.entities.get(victimId);
    const foeLevel = victim ? this.statBlockFor(ctx, victim)?.level ?? 1 : 1;
    const xp = xpForDefeat(foeLevel);
    // Seed the slice from the PC's AUTHORED level (not the overlaid one) so a first grant starts right;
    // once the entry exists the reducer ignores baseLevel.
    const base = ctx.services.campaign.characters.find((c) => c.id === pc.id)?.stats;
    const baseLevel = base?.level ?? 1;
    // Several foes can drop in ONE tick (a companion swing + the PC's) before any grantXp commits.
    // Preview against a RUNNING entry threaded through ctx.data so the second kill's beat folds in the
    // first kill's XP — previewing against the still-stale slice each time would duplicate or omit a
    // level-up line. Committed state is correct regardless (the reducer folds sequentially); this only
    // fixes the announced numbers.
    const pending = (ctx.data.pendingKillXp as Record<string, ProgressionEntry> | undefined) ?? {};
    const before = pending[pc.id] ?? progressionOf(ctx.model.modules, pc.id, baseLevel);
    const preview = applyXpGain(before, xp);
    pending[pc.id] = preview.next;
    ctx.data.pendingKillXp = pending;
    ctx.enqueue({ type: "grantXp", entityId: pc.id, by: xp, baseLevel });
    // A study credit only helps a caster (the study surface needs an existing known working); a martial
    // is never promised a working it cannot learn.
    const caster = !!base && effectiveStatBlock(base, readProgressionSlice(ctx.model.modules)[pc.id]).spells.length > 0;
    const levelText =
      preview.levelsGained > 0
        ? ` You reach level ${preview.next.level}! (+${preview.hpGain} HP${preview.creditsGained > 0 && caster ? `, a new working to learn` : ""})`
        : "";
    this.emitOrDefer(ctx, {
      kind: "stateChanged",
      summary: `${this.nameOf(ctx, victimId)} is defeated. (+${xp} XP)${levelText}`,
      changes: { xp, entityId: pc.id, level: preview.next.level },
    });
  }

  private endCombat(ctx: TickContext): void {
    ctx.enqueue({ type: "endCombat" });
  }

  private setFallback(ctx: TickContext, trigger: string): void {
    ctx.data.narration = { trigger };
  }

  /**
   * Fold the player's own parked narration line into the combat beat (live 07-18 #3). Only a plain
   * model-bound line is lifted: a `deterministic` refusal must reach the player verbatim through the
   * NarrationModule (no model call), and a `resolved` check turn keeps its RESOLVED-block narration —
   * lifting either would lose contract behavior. The lifted trigger is prepended to whichever combat
   * beat renders this tick (`consumePlayerLine`), so the line is narrated exactly once, in combat.
   *
   * Since 07-24 the four mechanical successes (equip/unequip/buy/sell) are `deterministic` too, so an
   * in-combat equip renders as its own short plain line PLUS the round beat rather than one folded
   * beat. Accepted, and NOT a return of 07-18 #3 (see the comment at the `itemActionTurn` branch
   * above): that bug was a second MODEL beat on a combat-blind brief; these lines cost no model call
   * and re-establish nothing.
   */
  private liftPlayerLine(ctx: TickContext): void {
    const parked = ctx.data.narration as NarrationIntent | undefined;
    if (!parked || parked.deterministic || parked.resolved) return;
    ctx.data.combatPlayerLine = parked.trigger;
    // T7: an intent that carries an `echoFallback` does so because its trigger IS the player's own
    // sentence (freeform, dialogue, grounded freeform — see the engine's resolvePlayer). Carry it
    // ACROSS with the line: without it, a blank or refused narrator on an ambush tick falls to
    // `triggerEcho`, which — having no fallback left — echoes the composed trigger and hands the
    // player their own words back as GM prose, the exact parrot `echoFallback` exists to prevent.
    // Engine-authored lifts (travel, item actions) set no fallback, so their echo is unchanged.
    ctx.data.combatPlayerEcho = parked.echoFallback;
    ctx.data.narration = undefined;
  }

  /** The lifted player line (if any), cleared on read so exactly one beat carries it. */
  private consumePlayerLine(ctx: TickContext): string {
    const line = (ctx.data.combatPlayerLine as string | undefined)?.trim();
    ctx.data.combatPlayerLine = undefined;
    return line ? `${line} ` : "";
  }

  /**
   * The player-safe echo for a beat that swallowed the player's own line (see `liftPlayerLine`):
   * the lifted intent's neutral fallback followed by the beat's own prose, directives stripped.
   * Cleared on read, so — like the line itself — exactly one beat carries it. Undefined when the
   * lifted intent was engine-authored (no fallback), leaving that beat's echo byte-identical.
   */
  private consumeBeatEcho(ctx: TickContext, beat: string): string | undefined {
    const echo = (ctx.data.combatPlayerEcho as string | undefined)?.trim();
    ctx.data.combatPlayerEcho = undefined;
    if (!echo) return undefined;
    return `${echo} ${stripNarratorDirective(beat)}`.trim();
  }

  private async onNarrate(ctx: TickContext): Promise<void> {
    // Only the bookends of a fight are narrated by the model — the scene at the start and the
    // aftermath at the end. Every swing in between already rendered as a deterministic mechanical
    // line, so combat costs ~2 narrator calls per fight (down from one per swing) and the violence
    // play-by-play never reaches a model.
    const start = ctx.data.combatStartBeat as string | undefined;
    // The START beat ("violence erupts — set the scene") grounds on the PRE-resolution model: the foes
    // are present and alive and the room is intact. The END beat ("the aftermath") grounds on the
    // post-queue model. This matters when a fight starts AND ends in one tick (one-shotting a lone foe):
    // sharing the post-queue model would narrate the opener against a calm, foe-absent room (and the
    // cast guard would then suppress the very foe the scene is about).
    if (start)
      await this.narrateBeat(ctx, `${this.consumePlayerLine(ctx)}${start}`, false, this.consumeBeatEcho(ctx, start));
    // Release the aggro path's parked mechanics HERE — right behind the opening prose, and NOT at
    // the end of this method: the mid-round beat below is also model prose, so a tail-only flush
    // would merely move the inversion one beat later ("Combat begins" after the round narration).
    this.flushDeferredEmits(ctx);
    const end = ctx.data.combatEndBeat as string | undefined;
    if (end)
      await this.narrateBeat(ctx, `${this.consumePlayerLine(ctx)}${end}`, true, this.consumeBeatEcho(ctx, end));
    // Mid-fight round beat (live r3 #3): a round that neither opens nor closes the fight used to
    // render as bare dice — a sharp tonal drop from every other turn. One short guarded beat over
    // the round's deterministic outcomes restores prose without re-narrating any number the tracker
    // already showed. Bookend turns keep their single beat (no double narration).
    if (!start && !end) {
      const lines = ctx.data.combatRoundLines as string[] | undefined;
      if (lines && lines.length > 0) {
        // Armament from the MODEL, not narrative momentum (live 07-18 #4: a freeform-dropped club
        // kept "cutting air" in round prose while the mechanical swing was an unarmed strike).
        const player = playerEntity(ctx.model);
        const weapon = player ? this.weaponFor(ctx, player) : UNARMED;
        // `(GM: …)` note form — models copy bare declarative trigger sentences into prose, and this
        // one printed VERBATIM at the run's most dramatic beat ("…down. The player fights with their
        // Dagger", r7 P2). The echo path strips GM notes; the prompt keeps the armament fact.
        const armament =
          weapon.id === UNARMED.id
            ? " (GM: the player is UNARMED this round — bare hands only; never print this note.)"
            : ` (GM: the player's weapon this round is the ${weapon.name}; keep the prose consistent with it and never print this note.)`;
        const round = `Blows are traded — ${lines.join("; ")}.${armament} Narrate this exchange in one or two vivid sentences, keeping every outcome exactly as stated (no new wounds, falls, or escapes).`;
        // A lifted line can reach this beat too (an item-action turn mid-fight opens neither
        // bookend), so it carries the same player-safe echo as the two above.
        await this.narrateBeat(
          ctx,
          `${this.consumePlayerLine(ctx)}${round}`,
          true,
          this.consumeBeatEcho(ctx, round),
        );
      }
    }
    // Tail safety net: a tick that parked mechanics but rendered NO start beat (the aggro helper bailed
    // after `startEncounter` returned an encounter it could not narrate) must still show them. The
    // flush drains, so this is a no-op on the ordinary path.
    this.flushDeferredEmits(ctx);
  }

  private async narrateBeat(
    ctx: TickContext,
    trigger: string,
    postResolution: boolean,
    echoFallback?: string,
  ): Promise<void> {
    // Combat resolves in `react` and commits after `narrate`. For the AFTERMATH (`postResolution`),
    // build the brief against the exact post-queue model the reducer will commit, otherwise the prompt
    // can say “the last foe falls” while its authoritative `Present:` line still lists that foe alive
    // and the combat as active. For the OPENER, use the live pre-resolution model so the foes are still
    // on stage. `structuredClone` preserves Maps; applying the queue here is a pure preview and never
    // touches the live model or emits deltas.
    let model = ctx.model;
    if (postResolution) {
      model = structuredClone(ctx.model);
      for (const command of ctx.queue) applyCommand(model, command);
    }
    const state = toGameState(model);
    // Non-combatant fence (r4 P3): bystanders who "join in" through prose never act mechanically
    // (`startEncounter` deliberately excludes them), so the prose must not show them landing
    // blows — the player priced a stand-or-run decision on help that did not exist.
    const live = readCombat(model);
    const fence = live.active
      ? ` Only these combatants act in this fight: ${live.order.map((id) => this.nameOf(ctx, id)).join(", ")}. ` +
        `Anyone else present is a non-combatant — they may shout, cower, or flee, but they land no blows.`
      : "";
    const fencedTrigger = fence ? `${trigger}${fence}` : trigger;
    const locationName = (id: string): string => this.world.locations.find((l) => l.id === id)?.name ?? id;
    const nctx = buildNarrationContext({
      world: this.world,
      campaign: ctx.services.campaign,
      state,
      recentEvents: ctx.recent,
      trigger: fencedTrigger,
      present: modelPresence(model, this.world),
      exits: modelExits(model, locationName, undefined, frontierExpansionEnabled(this.world)),
      // TURN FACTS from the same authorized ledger the Judge verifies against (names off the
      // pre-commit model, matching the Judge) — a combat beat's brief carries what actually
      // happened this turn (drops, downs, XP), so the prose can't re-arm the player. Empty ⇒
      // omitted, byte-identical.
      turnFacts: turnFactLines(this.world, ctx.model, authorizedCommandsOf(ctx)),
      storySoFar: ctx.services.storySoFar,
    });
    // A beat that swallowed the player's own line carries that line's neutral fallback (T7). It has
    // to be threaded HERE, not just composed into the trigger: the trigger reaches the model, the
    // fallback reaches the SCREEN when the model comes back blank or refusing — and combat is the
    // one place a permissive-but-skittish model may balk (see below).
    if (echoFallback?.trim()) nctx.echoFallback = echoFallback.trim();
    // Combat is the one place a permissive-but-skittish model may balk at describing violence;
    // `looksLikeRefusal` degrades that to the trigger echo instead of leaking the model
    // breaking character. The minor-safety guard (the `blocked` path) is unaffected.
    await narrateGuarded(ctx, state, this.dm, nctx, looksLikeRefusal);
  }

  private combatantOf(ctx: TickContext, entity: Entity): Combatant | null {
    if (!entity.stats) return null;
    const stats = this.statBlockFor(ctx, entity);
    if (!stats) return null;
    // AC reflects what is actually worn (armor base + capped dex + shield); entities with nothing
    // equipped keep their authored armorClass verbatim. Copy-on-diff — content StatBlocks are
    // shared objects and must never be mutated.
    const ac = derivedAc(stats, entity.stats.equipped, (id) => this.itemById(id), statusMods(ctx.model, entity.id).ac);
    return {
      id: entity.id,
      stats: ac === stats.armorClass ? stats : { ...stats, armorClass: ac },
      currentHp: entity.stats.currentHp,
    };
  }

  private statBlockFor(ctx: TickContext, entity: Entity): StatBlock | null {
    let base: StatBlock | null | undefined;
    if (entity.kind === "pc") {
      base = ctx.services.campaign.characters.find((pc) => pc.id === entity.id)?.stats;
    } else if (entity.kind === "monster") {
      base = this.world.monsters.find((m) => m.id === (entity.templateId ?? entity.id))?.stats;
      // Generated lurkers (worldgen-as-explore) carry live entity stats but no content template —
      // synthesize a modest deterministic block around their spawned HP, so on-sight aggro and the
      // player's swing both resolve (a foe you can meet must be a foe you can fight).
      if (!base) base = entity.stats ? { ...GENERATED_MONSTER_BLOCK, maxHp: entity.stats.maxHp } : null;
    } else {
      base = this.world.npcs.find((npc) => npc.id === (entity.templateId ?? entity.id))?.stats;
      // A CONSCRIPTED ally (r5) with no authored StatBlock gets the same deterministic baseline a
      // party recruit gets, mirroring the monster branch's GENERATED_MONSTER_BLOCK fallback above.
      // Gated to `allies` on purpose: this must not quietly make every statless fixture in the
      // world attackable, and it never rewrites authored content the way enrichment would.
      if (!base && (ctx.model.modules.combat as Partial<CombatEncounter> | undefined)?.allies?.includes(entity.id)) {
        base = baselineNpcStats();
      }
    }
    if (!base) return null;
    // Overlay earned progression (level ⇒ proficiency, grown maxHp) so an advanced PC fights at their
    // real level; a foe with no progression entry returns the authored block unchanged.
    const entry = readProgressionSlice(ctx.model.modules)[entity.id];
    return effectiveStatBlock(base, entry, entity.stats?.maxHp);
  }

  private hpProjection(model: WorldModel): Map<string, number> {
    const hp = new Map<string, number>();
    for (const e of model.entities.values()) if (e.stats) hp.set(e.id, e.stats.currentHp);
    return hp;
  }

  private weaponFor(ctx: TickContext, entity: Entity, explicitId?: string): WeaponProfile {
    // An explicit weapon named by the intent (world/masterlist item, then bundled SRD profile).
    // A NAMED thing that resolves to no carried/SRD weapon is an improvised object (a stool, a
    // bottle) — the attacker grabbed it, so the swing lands as an improvised blow, not bare hands.
    // (Checked before "readied steel" so "hit it with the chair" honours the declared object even
    // when a weapon is sheathed.)
    if (explicitId) {
      const item = this.itemById(explicitId);
      if (item && isWeapon(item)) return weaponProfileFromItem(item.id, item.name, item.properties);
      const srd = getWeapon(explicitId);
      if (srd) return srd;
      return IMPROVISED_WEAPON;
    }
    // Readied steel wins: the equipped weapon is the declared fighting stance.
    const equippedId = entity.stats?.equipped?.weapon;
    if (equippedId) {
      const item = this.itemById(equippedId);
      if (item && isWeapon(item)) return weaponProfileFromItem(item.id, item.name, item.properties);
      const srd = getWeapon(equippedId);
      if (srd) return srd;
    }
    // First weapon carried.
    for (const itemId of entity.stats?.inventory ?? []) {
      const item = this.itemById(itemId);
      if (item && isWeapon(item)) return weaponProfileFromItem(item.id, item.name, item.properties);
      const srd = getWeapon(itemId);
      if (srd) return srd;
    }
    // A weaponless monster fights with teeth and claws — every meetable beast is a real threat,
    // never a 1d1 pillow (a frontier lurker carries at most a trinket, so most reach here).
    if (entity.kind === "monster") return NATURAL_WEAPON;
    // Bare hands for a weaponless humanoid.
    return UNARMED;
  }

  /** Resolve an item id: the world's own list first, then the bundled masterlist. */
  private itemById(id: string): ResolvedItem | undefined {
    return resolveItem(this.world, id);
  }

  private pickTarget(ctx: TickContext, encounter: CombatEncounter, actorId: string, hp: Map<string, number>): string | null {
    const enemies = encounter.order.filter((id) => {
      if ((hp.get(id) ?? 0) <= 0) return false;
      return this.sideOf(ctx, id) !== this.sideOf(ctx, actorId);
    });
    enemies.sort((a, b) => {
      const byHp = (hp.get(a) ?? 0) - (hp.get(b) ?? 0);
      if (byHp !== 0) return byHp;
      return encounter.order.indexOf(a) - encounter.order.indexOf(b);
    });
    return enemies[0] ?? null;
  }

  /**
   * Which side a combatant fights on. Party membership is the usual answer, but an ALLY — a
   * bystander who joined the fight without joining the party (r5) — must read as "party" too, or
   * the party swings at them, `tryEndCombat` never sees the field clear, and killing them pays
   * loot and XP. Betrayal still wins: a party-hostile flag flips anyone to the enemy side.
   *
   * Reads the ally list straight off the slice rather than through `readCombat`, which deep-clones
   * the encounter — this is called per candidate per swing.
   */
  /**
   * Who steps in, called or unasked (r5 P3: "no ally acted on any round" while the prose had two
   * of them fighting). Both triggers land here so a joiner is enrolled before the round is driven.
   *
   * CALLED: the player addressed a present non-party NPC during a live fight — the engine already
   * resolved that intent, so this reads its own work rather than sniffing the raw line a second time.
   * UNASKED: the existing bystander-intervention math (`decideIntervention` + `bystanderLeans`),
   * rolled through a PRIVATE keyed rng so the shared stream — and every exact-value combat test —
   * is untouched. Candidates are id-sorted for replay stability.
   *
   * The Director cannot do this: autonomy is hard-muted during combat by design.
   */
  private tryAllyJoins(ctx: TickContext, hp: Map<string, number>): void {
    const encounter = this.activeOrNull(ctx);
    if (!encounter) return;
    const model = ctx.model;
    const loc = encounter.locationId;
    if (!loc) return;
    const pc = playerEntity(model);
    if (!pc) return;
    const called = (ctx.data.combatAid as { targetId?: string } | undefined)?.targetId;

    const candidates = entitiesAt(model, loc)
      .filter((e) => e.kind === "npc" && !e.partyMember && !encounter.order.includes(e.id))
      .filter((e) => !isPartyHostile(model, e.id))
      .filter((e) => (e.stats?.currentHp ?? 1) > 0)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    let considered = false;
    for (const bystander of candidates) {
      const template = this.world.npcs.find((n) => n.id === (bystander.templateId ?? bystander.id));
      if (!template) continue;
      considered = true;
      if (bystander.id !== called) {
        const chance = decideIntervention({
          leans: bystanderLeans(template),
          relationshipToPc: model.relationships.get(bystander.id)?.get(pc.id) ?? 0,
          relationshipToThreat: 0,
        });
        if (!rollIntervention(chance, `join:${bystander.id}:${encounter.round}:${loc}`)) continue;
      }
      // A body is required — `joinCombat` rejects without one, and a helper who cannot swing is
      // worse than none (the fence would name them as a combatant who acts).
      if (!bystander.stats) continue;
      ctx.enqueue({ type: "joinCombat", entityId: bystander.id, ally: true });
      this.emitOrDefer(ctx, {
        kind: "system",
        level: "info",
        message: `${this.nameOf(ctx, bystander.id)} takes your side — they are in the fight.`,
      });
      hp.set(bystander.id, bystander.stats.currentHp);
    }

    // The honest "no one moves" line: only when there
    // WAS someone who could have stepped in and did not.
    if (called && considered && !ctx.queue.some((c) => c.type === "joinCombat")) {
      this.emitOrDefer(ctx, {
        kind: "system",
        level: "info",
        message: "You call for help — but no one moves.",
      });
    }
  }

  private sideOf(ctx: TickContext, id: string): Side {
    const model = ctx.model;
    if (isPartyHostile(model, id)) return "enemy";
    if (model.entities.get(id)?.partyMember) return "party";
    const allies = (model.modules.combat as Partial<CombatEncounter> | undefined)?.allies;
    if (allies?.includes(id)) return "party";
    // An ally who joined THIS tick is not in the slice yet — `joinCombat` commits at the end of the
    // tick. Reading the slice alone calls them an enemy for the rest of it, and since they are
    // spliced in directly after the current turn, the very next slot is theirs: `pickTarget` would
    // hand them the party as their enemy list, and the helper who just stepped in would open by
    // swinging at the player. Honor the queued join.
    return ctx.queue.some((c) => c.type === "joinCombat" && c.entityId === id && c.ally) ? "party" : "enemy";
  }

  /**
   * The durable "already aggroed once" guard. Lives in the `aggro` MODULE SLICE (a flat
   * `Record<entityId, true>`), NOT on `Entity.flags` — a statted monster/NPC's flags are DROPPED on the
   * GameState save/reload round-trip, so keying off `e.flags.aggroed` let a fled/beaten monster ambush
   * the player again on sight after every reload. Module slices round-trip through `model.modules`, so
   * this survives (audit). The flat shape keeps each `modulePatch { [id]: true }` a merge-safe delta.
   */
  private hasAggroed(model: WorldModel, id: string): boolean {
    return (model.modules[AGGRO_MODULE] as Record<string, boolean> | undefined)?.[id] === true;
  }

  private nameOf(ctx: TickContext, id: string): string {
    const entity = ctx.model.entities.get(id);
    // Clean, suffix-stripped label — never a raw registry id or a "Foe#0" instance tag on the
    // combat tracker / initiative line. A missing entity degrades to the (suffix-stripped) id.
    return entity ? displayName(entity) : id.replace(/#\d+$/, "");
  }

  /**
   * Living relationships: when a party-side actor downs an enemy, every surviving companion warms a
   * little toward the PC (shared victory, protection earned). Bounded per kill; the reducer clamps.
   * Skips betrayal downs (the target is still a party member ⇒ not "enemy").
   */
  private warmPartyOnKill(ctx: TickContext, actorId: string, downedId: string, hp: Map<string, number>): void {
    if (this.sideOf(ctx, actorId) !== "party") return;
    if (this.sideOf(ctx, downedId) !== "enemy") return;
    const pcId = playerEntity(ctx.model)?.id;
    if (!pcId) return;
    for (const e of ctx.model.entities.values()) {
      if (!e.partyMember || e.id === pcId) continue;
      if ((hp.get(e.id) ?? e.stats?.currentHp ?? 0) <= 0) continue;
      ctx.apply({ type: "adjustRelationship", actorId: e.id, targetId: pcId, by: COMBAT_ASSIST_WARMTH });
    }
  }

  /**
   * Faction propagation: attacking one member of a faction cools that faction's PRESENT kin toward
   * the PC (individual regard) AND drops the PC's standing with the whole faction — which bleeds to
   * the faction's allies/enemies through the authored matrix (`factionStandingCommands`). Only when
   * the PC is the aggressor. The kin-chill is co-located only; the standing drop is not (a faction
   * hears its own were attacked).
   */
  private propagateFactionChill(ctx: TickContext, attackerId: string, victimId: string): void {
    const pcId = playerEntity(ctx.model)?.id;
    if (!pcId || attackerId !== pcId) return;
    for (const mateId of factionMatesPresent(ctx.model, this.world, victimId, pcId)) {
      ctx.apply({ type: "adjustRelationship", actorId: mateId, targetId: pcId, by: -FACTION_MATE_CHILL });
    }
    for (const cmd of factionStandingCommands(this.world, pcId, factionOf(this.world, victimId), -FACTION_ATTACK_STANDING)) {
      ctx.apply(cmd);
    }
  }

  private markHostileToParty(ctx: TickContext, entityId: string): void {
    const entity = ctx.model.entities.get(entityId);
    if (!entity) return;
    if (!isPartyHostile(ctx.model, entityId)) {
      ctx.apply({ type: "setFlag", scope: "world", key: partyHostileFlag(entityId), value: true });
      ctx.emit({
        kind: "stateChanged",
        summary: `${entity.name} turns hostile to the party.`,
        changes: { entityId, partyHostile: true },
      });
    }
    // Betrayal now has mechanical teeth (2026-07-05 playtest: it was inert — roster + disposition
    // unchanged). A struck companion LEAVES the roster (they are an enemy now, not a member — sideOf
    // already reads the hostile flag) and their regard for the PC craters, both directions, so the
    // party panel and the disposition bar reflect the break.
    if (entity.partyMember) {
      ctx.apply({ type: "setPartyMembership", entityId, member: false });
      const pcId = playerEntity(ctx.model)?.id;
      if (pcId) {
        ctx.apply({ type: "adjustRelationship", actorId: entityId, targetId: pcId, by: -100 });
        ctx.apply({ type: "adjustRelationship", actorId: pcId, targetId: entityId, by: -100 });
      }
    }
  }

  private deliberatePartyAttack(input: string, target: Entity): boolean {
    if (ATTACK_NEGATION_RE.test(input)) return false;
    return this.targetForms(target).some((form) => {
      const targetPattern = escapeRegExp(form);
      if (BETRAYAL_RE.test(input) && new RegExp(`\\b${targetPattern}\\b`, "i").test(input)) return true;
      // A REPLACER FUNCTION, not a replacement string. `escapeRegExp` escapes the dollar sign for
      // the PATTERN, but `$&`/`` $` ``/`$'`/`$1` stay special on the RIGHT of String.replace — so an
      // entity whose name contains `$` followed by a backtick used to compile to a regex with the
      // verb alternation spliced into the middle of the name. It never threw; it silently matched
      // the wrong thing. Reachable: `PUT /api/worlds/:campaignId` takes `name` as free text.
      const splice = (): string => targetPattern;
      if (new RegExp(DIRECT_ATTACK_RE.source.replace("__TARGET__", splice), "i").test(input)) return true;
      return new RegExp(DIRECT_LUNGE_RE.source.replace("__TARGET__", splice), "i").test(input);
    });
  }

  /**
   * The written forms that count as NAMING this target in an attack line: the full display name, the
   * entity id, and each of the name's handle tokens.
   *
   * The handle tokens come from the shared binder's tier-1 filter (`nameHandleTokens`), which drops
   * articles, quantifiers and honorifics. Before that, "Oda the Wayfarer" produced the bare article
   * "the" as a form, so "I attack the wight before it reaches Oda" — the EXACT sentence the
   * friendly-fire guard's own comment says it exists to catch — matched `attack the`, was read as
   * deliberate betrayal, and dropped the flagship companion from the party with −100 regard both
   * ways plus real HP damage. 12 of the 66 names in the original regression corpus carry a stop-word token.
   *
   * The ≥3-char floor STAYS at 3. Raising it to 4 (the audit's first suggestion) also deletes "oda",
   * which makes deliberate betrayal of the flagship companion impossible to express — dropping the
   * noise tokens alone fixes every false positive without costing a single true one.
   */
  private targetForms(target: Entity): string[] {
    return [target.name.toLowerCase(), target.id.toLowerCase(), ...nameHandleTokens(target.name)];
  }
}
