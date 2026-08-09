/**
 * The movement domain — reaching for a place by name, walking known roads, forcing a barred way,
 * and expanding the frontier when the player walks off the authored map.
 *
 * Lifted verbatim out of `GameEngine` (see `resolvers/host.ts` for the contract). The rule this
 * domain exists to hold: the party moves BY CHOICE. A destination is only reached when the player
 * asked for it and the route actually admits them — no proposal, no prose, and no side effect ever
 * relocates the party on its own (playtest r3: seven involuntary relocations in one run).
 *
 * @author Runkai Zhang
 */
import type { Campaign, World } from "../../content/schema.ts";
import type { GameEvent } from "../../events/types.ts";
import { resolvedFromCheck, resolvedHardRefusal } from "../../agents/context.ts";
import { evalPredicate, standardEvalLookups } from "../../modules/events/module.ts";
import type { NarrationIntent } from "../../modules/narration.ts";
import { resolveCheck } from "../../rules/checks.ts";
import type { CombatEncounter } from "../../rules/combat-state.ts";
import { escapeAbility, escapeDc, type EscapeFoe } from "../../rules/escape.ts";
import { costOf, scaledEnergy, DEFAULT_TURN_MINUTES } from "../../rules/costs.ts";
import { exhaustionMoveFactor, exhaustionOf } from "../../rules/exhaustion.ts";
import { barrierDescription } from "../../rules/exit-state.ts";
import { resolveItem } from "../../rules/items.ts";
import { isOrdinaryWord } from "../../rules/name-match.ts";
import { escapeRegExp } from "../../util/text.ts";
import { statusMods } from "../../rules/status-effects.ts";
import { norm, tokensOf } from "../../world/exit-match.ts";
import { FRONTIER_PREFIX, frontierExpansionEnabled, generatePocket, isFrontierId, realizedGazetteerIdsOf, slugOfName, visitedFlag } from "../../world/expansion.ts";
import { exitsFrom as mapExitsFrom } from "../../world/map.ts";
import { partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";
import { findRoute, firstBarredLeg } from "../../world/pathfind.ts";
import { isCombatActive } from "../../world/queries.ts";
import { barredExitsAt, type ExitVerdict } from "../../world/traversal.ts";
import { capitalize, describeWalkDuration } from "./phrasing.ts";
import type { TickContext } from "../tick.ts";
import type { CheckAbility, TurnPlan } from "../turn-plan.ts";

/**
 * Words that NAME an obstacle of each barrier kind — keyed on the closed `ExitBarrier["kind"]`
 * enum (`src/content/schema.ts`), so "I pick the lock" and "I force the ward" name the thing they
 * are aimed at even when the authored description never uses that word. See `matchBarredExit`.
 *
 * Entry criterion, learned by trying the alternatives against real lines: a word belongs here only
 * when a forcing/picking verb aimed at it is almost always aimed at a WAY THROUGH. `stone`, `rock`
 * and `fall` were tried for rubble and dropped — "I break my fast with bread and stone-hard cheese"
 * scored the collapsed shaft. `seal` was tried for magical and dropped — "I break the seal on the
 * letter" scored the ward.
 *
 * `lock`/`latch` are the one deliberate compromise: they are the MECHANISM, not the way, so a lock
 * named on some other object ("I force the lock on the strongbox") will bind a barred door standing
 * in the same room. They stay because "I pick the lock" is the single most natural way a player
 * attacks a locked exit, and dropping them makes that bare line resolve as a generic check that
 * cannot open anything.
 */
const BARRIER_KIND_HANDLES: Record<NonNullable<ExitVerdict["exit"]["barrier"]>["kind"], readonly string[]> = {
  door: ["door", "doors", "doorway", "lock", "latch"],
  gate: ["gate", "gates", "grate", "grille", "portcullis", "lock", "latch"],
  rubble: ["rubble", "debris", "collapse", "scree", "blockage"],
  magical: ["ward", "wards", "warding", "magic", "magical", "barrier", "spell", "sigil"],
};

/** The weighted score `matchBarredExit` requires: one NAME handle, or two of the barrier's own
 *  description words. Anything less is an incidental word, not an aimed attempt. */
const MIN_BARRIER_SCORE = 2;

/** Comparison tokens for `matchBarredExit`: the shared exit-matcher normalization (stop-words
 *  dropped) plus a 3-character floor, so `the`/`for`/`out` can never score. */
function matchBarredExitTokens(text: string): Set<string> {
  return new Set([...tokensOf(text)].filter((t) => t.length > 2));
}

/**
 * Relation words a SENTENCE-shaped exit name is strung together with. They identify no obstacle, so
 * they are dropped from an authored exit name before it can hand out a NAME handle — see
 * `matchBarredExit`. `isOrdinaryWord` (the repo's one closed common-word list) covers the nouns and
 * adjectives, but it is built for deciding whether a token can name a PERSON, so it has no reason to
 * carry prepositions; `tokensOf`'s own stop-words cover `into`/`toward`/`past`/`over` and stop there.
 * Kept LOCAL rather than pushed into either shared list: dropping these from destination grounding
 * (`matchExitInProse`) is a different question with different controls.
 */
const EXIT_NAME_RELATION_WORDS: ReadonlySet<string> = new Set([
  "through", "across", "along", "onto", "upon", "beyond", "under", "beneath", "within",
  "around", "behind", "between", "from", "via", "near", "off", "where", "whose",
]);
import { locationNameOf } from "./names.ts";
import { pcCheckMods } from "./checks.ts";

/**
 * A journey quoted last turn, awaiting the player's word — where, how far, how long. Engine-private
 * and deliberately unpersisted (good for exactly one following turn): a quote that survived a reload
 * would walk the party somewhere they never agreed to go.
 */
export interface PendingTravel {
  destId: string;
  destName: string;
  totalMinutes: number;
  armedAtClock: number;
}

/**
 * Price the current turn as a REAL movement to `destinationLocationId` — the one movement-pricing
 * rule (authored exit minutes when the edge declares them, exhaustion move factor, energy scaled
 * by duration), shared by the classified-movement branch of `resolvePlan` and the proposal-accept
 * path (an agreed "let's move" is a journey, not a 1-minute spoken beat).
 */
export function priceMovementTurn(ctx: TickContext, destinationLocationId: string | null | undefined): void {
  const model = ctx.model;
  const cost = costOf("movement");
  if (cost.minutes <= 0) return;
  const exhaustionLevel = exhaustionOf(playerEntity(model)?.stats);
  // Distance is AUTHORED, not assumed: an exit may declare how long its crossing takes, and the
  // flat cost-table row is only the default for the ones that don't. The playtest's west road was
  // narrated (and planned around) as an eight-hour march and cost thirty minutes, which is why
  // two in-fiction nights never turned the day over. Energy scales with the same ratio — a march
  // that takes sixteen times as long is sixteen times the toil.
  const authored = exitMinutes(model, destinationLocationId ?? null);
  const minutes = authored ?? cost.minutes;
  ctx.data.clockMinutes = Math.round(minutes * exhaustionMoveFactor(exhaustionLevel));
  ctx.data.energyCost = authored && cost.energy > 0 ? scaledEnergy(cost.energy, authored, cost.minutes) : cost.energy;
}

/**
 * THE PRICE OF WALKING OUT OF A FIGHT (r11 F-5, owner decision 2026-08-01).
 *
 * Before this, a plain movement line spoken mid-fight moved the party, reaped the encounter and
 * despawned every hostile with no `diceRolled` anywhere on the turn: the exploit-sweep row "flee
 * with no consequence" was open, and the fiction kept an ally swinging in a fight the engine had
 * already deleted. A disengage is now a real contested escape: the better of shoving through
 * (STR/Athletics) and slipping out (DEX/Acrobatics) against a DC set by the toughest foe and the
 * size of the circle.
 *
 * Success ⇒ `null`, and the caller moves exactly as before (byte-identical flee path). Failure ⇒ a
 * resolved refusal intent: the party stays, the turn is SPENT (`ctx.data.combatTurnSpent`, which the
 * combat module honours by passing initiative on), and the other side gets its round.
 *
 * ONE chokepoint, called at the top of the movement branch, so every mid-fight route out — a
 * grounded exit, a named reach, a multi-leg break, the destination-less bolt — is priced the same.
 * Zero foes standing (a reap-worthy stale encounter) is not a disengage: it passes straight through.
 */
export async function resolveDisengage(ctx: TickContext): Promise<NarrationIntent | null> {
  const model = ctx.model;
  if (!isCombatActive(model)) return null;
  const player = playerEntity(model);
  if (!player) return null;
  // A downed PC is handled by its own gate upstream; nobody rolls to break away at 0 HP.
  if ((player.stats?.currentHp ?? 1) <= 0) return null;
  const enc = model.modules.combat as Partial<CombatEncounter> | undefined;
  const at = enc?.locationId ?? null;
  if (!at || partyLocationOf(model) !== at) return null; // already elsewhere — nothing to break away from
  const allies = new Set(enc?.allies ?? []);
  const foes: EscapeFoe[] = [];
  for (const id of enc?.order ?? []) {
    if (id === player.id || allies.has(id)) continue;
    const e = model.entities.get(id);
    if (!e || e.partyMember || e.locationId !== at) continue;
    if ((e.stats?.currentHp ?? 0) <= 0) continue;
    // Level lives on the CONTENT stat block, never on the live entity (which carries only HP and
    // conditions) — an unstatted or generated foe counts as level 1, exactly as the combat module's
    // own `levelOf` does.
    const template = e.templateId ?? e.id;
    const block =
      ctx.services.world.monsters.find((m) => m.id === template)?.stats ??
      ctx.services.world.npcs.find((n) => n.id === template)?.stats;
    foes.push({ id: e.id, name: e.name, level: block?.level ?? 1 });
  }
  if (foes.length === 0) return null; // no one left to escape FROM — the module reaps this tick
  const dc = escapeDc(foes);
  const abilities = ctx.services.campaign.characters.find((c) => c.id === player.id)?.stats.abilities;
  const pick = escapeAbility(abilities?.str ?? 10, abilities?.dex ?? 10);
  const label = `${pick.ability === "str" ? "Strength" : "Dexterity"} (${pick.skill}): break off and get out`;
  const foeNames = foes.map((f) => f.name).join(", ");
  if (ctx.services.client?.promptRoll) {
    await ctx.services.client.promptRoll({
      actorId: player.id,
      ability: pick.ability,
      skill: pick.skill,
      dc,
      label: `${label} (${foeNames}) — success and the break is clean; failure and you are still in it. DC ${dc}.`,
    });
  }
  const smods = statusMods(model, player.id);
  const result = resolveCheck(
    { abilityScore: pick.score, dc, bonus: smods.check, advantage: smods.advantage, disadvantage: smods.disadvantage },
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
  if (result.success) return null;
  // Failure spends the combat turn exactly as an item action does — the combat module passes
  // initiative on, so the foes answer the attempt in the same tick.
  ctx.data.combatTurnSpent = { actorId: player.id };
  ctx.data.clockMinutes = 1;
  ctx.data.energyCost = 0;
  ctx.emit({ kind: "stateChanged", summary: `You try to break away, and ${foeNames} cuts you off.` });
  return {
    trigger:
      `You try to break off and get clear, and ${foeNames} will not let you — the way out closes and the ` +
      `fight still has you. Narrate the failed break in a sentence or two; the party does NOT leave.`,
    resolved: resolvedFromCheck(`${label} (DC ${dc})`, result),
  } satisfies NarrationIntent;
}

/**
 * The real ways out of a room, as a short player-facing list — the degrade/refusal receipts' shared
 * truth (r14). Visible exits only; a frontier exit counts ONLY where expansion is on (an authored
 * named frontier may coexist with `frontierExpansion:false` — a receipt advertising a way the engine then
 * refuses as impassable would be its own lie). Named exits speak their authored name; unnamed ones
 * degrade to the destination's name. Capped at four.
 */
export function waysOnFrom(ctx: TickContext, from: string): string[] {
  const world = ctx.services.world;
  return mapExitsFrom(ctx.model.map, from)
    .filter((e) => !e.hidden && (frontierEnabled(world) || !isFrontierId(e.to)))
    .map((e) => e.name?.trim() || (isFrontierId(e.to) ? "" : locationNameOf(world, e.to)))
    .filter((n) => n.length > 0)
    .slice(0, 4);
}

/**
 * A "does not follow" notice (playtest #8): the NPC the player was JUST addressing, when they are a
 * NON-member still standing at the place the party just left. Stateless — reads the player's most
 * recent line from `recent` (a `dialogue` event carrying the addressed `toId`); a non-address last
 * line (a freeform action, a look) has no `toId`, so nothing fires and a mere passer-by is never
 * flagged. Best-effort prose clarity so a would-be companion doesn't just vanish, never a hard fact.
 */
export function leftBehindNotice(fromLoc: string | null, model: WorldModel, recent: GameEvent[]): string | null {
  if (!fromLoc) return null;
  const playerId = playerEntity(model)?.id ?? "pc.you";
  // The NPC named in the player's most recent ADDRESS (a `dialogue` event carrying a `toId`) within a
  // short window. Scanning for the toId (not merely the last line) is robust whether or not `recent`
  // already includes this turn's own toId-less travel line — a look/wander in between doesn't erase
  // that they were just talking to someone who is now being left behind.
  let addressedId: string | undefined;
  for (const e of recent.slice(-8).reverse()) {
    if (!e || e.kind !== "dialogue" || e.actorId !== playerId) continue;
    const toId = (e as { toId?: string }).toId;
    if (toId) {
      addressedId = toId;
      break;
    }
  }
  if (!addressedId) return null;
  const npc = model.entities.get(addressedId);
  if (!npc || npc.kind !== "npc" || npc.partyMember || npc.locationId !== fromLoc) return null;
  return `${npc.name} stays behind — they are not travelling with you`;
}

/**
 * Open-world REACH: the player named a place that isn't a listed exit. Movement obeys the SAME
 * grounding contract as every other player intent (item/cast/trade/quest/…) — a named target either
 * resolves to something REAL or degrades to an in-place beat; it NEVER fabricates world state from
 * arbitrary words. Two routes, strictest first, then the safe degrade:
 *   1) an EXISTING location by unique normalized name — wire a discovered direct edge and go (reuse,
 *      never a duplicate: "go back to the tavern"; covers prior reach terminals + realized rumors);
 *   2) an UNREALIZED gazetteer entry by name — generate a 2–3 room approach whose TERMINAL room IS
 *      that authored place (author canon materialized on demand);
 *   otherwise — the place exists NOWHERE in the authored world: stay put and let the narrator handle
 *   the reference in fiction (no fabricated room, no teleport, and — because the party did not move —
 *   no state/prose desync). The old third route minted a wilderness pocket from the player's words, which is
 *   what turned a "blue door" prop into a location and a city walk into a forest. Authored `frontier:`
 *   exits are a SEPARATE path (`expandFrontier`) and remain the way the map grows. All mutation flows
 *   through the reducer's typed commands (deterministic, seeded, replay-safe).
 */
export function reachOpenWorld(
  ctx: TickContext,
  requestedName: string,
  /** Arm the engine's one-turn journey quote. Travel is BY CHOICE: the quote is spoken this turn
   *  and only the player's next word spends it, so the resolver hands the quote out rather than
   *  parking it somewhere that could survive a reload. */
  arm: (quote: PendingTravel) => void,
): NarrationIntent {
  const model = ctx.model;
  const world = ctx.services.world;
  const from = partyLocationOf(model);
  if (!from) return { trigger: "You look for a way onward, but the way is lost." };
  const wanted = norm(requestedName);
  if (!wanted) return { trigger: `You look for a way onward. ${requestedName}` };

  // The player named the room they already stand in — no reach, no generation; describe moving
  // about it in place (a fresh pocket titled after the current location would be a duplicate).
  // A full narrated in-place scene is a BEAT, not a refusal — priced as one (r4: these were the
  // exact turns that let an unlimited number of scenes fit inside one morning).
  const fromLoc = world.locations.find((l) => l.id === from);
  if (fromLoc && norm(fromLoc.name) === wanted) {
    ctx.data.clockMinutes = DEFAULT_TURN_MINUTES;
    ctx.data.energyCost = 0;
    return { trigger: `You move about ${fromLoc.name}. Narrate what the player does here.` };
  }

  // 1) Reuse an EXISTING location the player named (unique normalized-name match, never the room you
  //    stand in). Prior reach terminals + realized gazetteer rooms live in world.locations, so this
  //    is what keeps "go back to X" from spawning a second X.
  //
  // The VISITED gate, relaxed (r9 F-5's second face, caught by the first auto-harness run): the
  // old rule admitted only places the party had STOOD, because pre-routing this branch minted a
  // direct wormhole exit — matching a remote or secret room's name teleported past every barrier.
  // Routing removed that hazard: travel now walks REAL passable, visible exits leg by leg
  // (`findRoute` skips hidden/frontier/barred edges), so an unvisited but road-connected town a
  // quest just named ("last counted through Ashford, half a day west") is reachable exactly as the
  // fiction says — by walking there, quoted and priced. What remains protected: an UNVISITED place
  // with NO open route (secret rooms, gated interiors) falls through to the same cast-about branch
  // as a place that exists nowhere — naming it reveals nothing. Visited places keep their honest
  // barred/"no known road" lines (the player has stood there; the road's existence is not a secret).
  // When both a visited and an unvisited location share the name, the visited one wins.
  const named = world.locations.filter((l) => l.id !== from && norm(l.name) === wanted);
  const visitedNamed = named.filter((l) => model.flags[visitedFlag(l.id)] === true);
  const byName = visitedNamed.length > 0 ? visitedNamed : named;
  if (byName.length === 1) {
    // KNOWN-ROADS TRAVEL (2026-07-25 fix wave). The old body minted a minutes-less direct exit
    // and teleported — which made every re-visit a flat 30-minute hop (the playtest's 8.3-hour
    // west road re-ran for free on day 2, permanently) and let a speech act the classifier
    // misread as movement relocate the party across the map in one beat. Now the party WALKS:
    // route along existing passable exits, price the summed authored minutes, and — because a
    // cross-map journey is a real commitment — a multi-leg trip is QUOTED first and executes
    // only on the player's next-turn confirmation. No exit is ever minted.
    const dest = byName[0]!;
    const destVisited = model.flags[visitedFlag(dest.id)] === true;
    const route = findRoute(model, from, dest.id, { defaultLegMinutes: costOf("movement").minutes });
    if (!route || route.legs.length === 0) {
      // Only a VISITED destination earns the honest travel refusal — the player has stood there,
      // so the road (or its barring) is knowledge they own. An unvisited name with no open route
      // reveals nothing: fall through to the gazetteer/in-place branches below, exactly like a
      // place that exists nowhere.
      if (destVisited) {
        ctx.data.clockMinutes = 1;
        ctx.data.energyCost = 0;
        const barred = firstBarredLeg(model, from, dest.id, { defaultLegMinutes: costOf("movement").minutes });
        if (barred) {
          const barredName = locationNameOf(ctx.services.world, barred.to);
          return {
            trigger:
              `The way to ${dest.name} runs through ${barredName}, and that way is closed to you just now. ` +
              `Narrate the party finding the road barred; do not move them.`,
            echoFallback: `The way to ${dest.name} runs through ${barredName}, and that way is closed just now.`,
          } satisfies NarrationIntent;
        }
        return {
          trigger:
            `No known road leads from here to ${dest.name} — you would have to find the way first. ` +
            `Narrate the party taking stock; do not move them.`,
          echoFallback: `No known road leads from here to ${dest.name} — you would have to find the way first.`,
        } satisfies NarrationIntent;
      }
    } else if (route.legs.length === 1) {
      // Adjacent after all (the classifier just failed to ground the exit id): execute exactly
      // like a grounded move over the REAL edge — authored minutes and all.
      const moved = ctx.apply({ type: "moveParty", to: dest.id });
      if (!moved.mutated && partyLocationOf(model) !== dest.id) {
        ctx.data.clockMinutes = 1;
        ctx.data.energyCost = 0;
        return { trigger: `You try to make your way back to ${dest.name}, but find no way there just now.` };
      }
      priceMovementTurn(ctx, dest.id);
      ctx.emit({
        kind: "stateChanged",
        summary: `The party makes their way to ${dest.name}.`,
        changes: { partyLocationId: dest.id },
      });
      return {
        trigger: destVisited
          ? `You make your way to ${dest.name}, a place you have been before. Narrate the arrival and what has changed since.`
          : `You make your way to ${dest.name} for the first time. Narrate the arrival and what first strikes the senses.`,
      } satisfies NarrationIntent;
    } else {
      // Multi-leg. Mid-combat there is no quoting and no cross-map dash: the party breaks ONE leg
      // toward the named place (the combat module reaps the abandoned fight on this tick), exactly
      // as far as legs actually carry in a round.
      if (isCombatActive(model)) {
        const firstLeg = route.legs[0]!;
        if (ctx.apply({ type: "moveParty", to: firstLeg.to }).mutated) {
          const legName = locationNameOf(ctx.services.world, firstLeg.to);
          ctx.emit({
            kind: "stateChanged",
            summary: `The party flees toward ${dest.name}, making it as far as ${legName}.`,
            changes: { partyLocationId: firstLeg.to },
          });
          return { trigger: `You break and run toward ${dest.name}, making it as far as ${legName}.` } satisfies NarrationIntent;
        }
        ctx.data.clockMinutes = 1;
        ctx.data.energyCost = 0;
        return { trigger: `You look for a way out toward ${dest.name}, but find none.` } satisfies NarrationIntent;
      }
      // Confirmed? A quote for this same destination armed LAST turn (scratch handoff from
      // resolvePlayer) means the player just re-committed by naming it again — walk it now.
      const quoted = ctx.data.pendingTravel as
        | { destId: string; destName: string; totalMinutes: number; armedAtClock: number }
        | undefined;
      if (quoted && quoted.destId === dest.id) {
        return executeKnownRoadsTravel(ctx, dest.id, dest.name);
      }
      // Quote the journey and arm the confirmation. The quote itself is a spoken beat, not travel.
      arm({
        destId: dest.id,
        destName: dest.name,
        totalMinutes: route.totalMinutes,
        armedAtClock: model.clock,
      });
      ctx.data.clockMinutes = DEFAULT_TURN_MINUTES;
      ctx.data.energyCost = 0;
      const via = route.legs.slice(0, -1).map((l) => locationNameOf(ctx.services.world, l.to));
      const viaNote = via.length > 0 ? ` by way of ${via.join(", ")}` : "";
      const timeNote = describeWalkDuration(route.totalMinutes);
      // The quote is a MECHANICAL fact with a one-turn confirmation window — it must reach the
      // screen deterministically. Playtest r9 F-5: the trigger below carried the whole offer, the
      // narrator wrote an unrelated scene over it, and the player watched an explicit "Travel to
      // Anchorfall" vanish without a word (then re-asked leg by leg). Receipts, not relays.
      ctx.emit({
        kind: "stateChanged",
        summary: `The road to ${dest.name} is ${timeNote}${viaNote} — name it again to set out.`,
        changes: {},
      });
      return {
        trigger:
          `The road to ${dest.name} is a real journey — ${timeNote}${viaNote}. The party has not set ` +
          `out yet: narrate them weighing the road ahead. Say the word — or name ${dest.name} again — and they commit.`,
        echoFallback:
          `The road to ${dest.name} is ${timeNote}${viaNote}. Say the word — or name it again — and you set out.`,
      } satisfies NarrationIntent;
    }
  }

  // 2) Realize an UNREALIZED gazetteer entry the player named — authored canon, materialized on
  //    demand (the 2–3 room approach's TERMINAL room IS that place). This is the ONLY reach that
  //    still generates: the place already exists in the authored world as a rumor; we just build it.
  const realized = realizedGazetteerIdsOf(model.modules);
  const entry = (world.gazetteer ?? []).find((g) => norm(g.name) === wanted && !realized.has(g.id));

  // Otherwise the named place exists NOWHERE in the authored world (no known location above, no
  // gazetteer entry) — OR frontier expansion is disabled for this world, so even a matched
  // gazetteer rumor is not realized on demand. Degrade to an in-place beat — the grounding contract
  // every other intent obeys. The party does NOT move and NOTHING is fabricated; the narrator
  // handles the reference in fiction. (The former per-world `openWorldReach` flag is gone; the old
  // path fabricated a wilderness pocket here, which minted phantom places off in-scene props.)
  if (!entry || !frontierEnabled(ctx.services.world)) {
    // Both degrade branches below hand the narrator a FULL in-place scene (an approach beat or a
    // cast-about-and-look beat) — that is a beat, priced as one, not a 1-minute refusal (r4: a
    // dozen of exactly these turns fit inside a single frozen morning).
    ctx.data.clockMinutes = DEFAULT_TURN_MINUTES;
    ctx.data.energyCost = 0;
    // 3) An authored SUB-FEATURE of the room the party already stands in — a phrase the location's
    //    own description or an interaction label dangles ("the deep vaults" inside the Undercroft's
    //    prose, T6). Not a separate place, so no move and no mint: hand the narrator an in-place
    //    approach beat instead of the flat "no way there" refusal. WHOLE-TOKEN matching against
    //    this room's authored text only (review finding: substring containment let "the inn" match
    //    "innkeeper" and "salt mere" match "Saltmere", claiming a distinct place was part of this
    //    room) — never an intent net, and never the removed mint-from-words route.
    const wantedTokens = [...tokensOf(requestedName)];
    const localTokens = tokensOf(
      [fromLoc?.description ?? "", ...(fromLoc?.interactions ?? []).map((i) => i.label)].join(" "),
    );
    if (wantedTokens.length > 0 && wantedTokens.every((t) => localTokens.has(t))) {
      return {
        trigger:
          `${requestedName} is part of ${fromLoc?.name ?? "this place"} itself — close at hand, not a ` +
          `journey away. Narrate the player drawing nearer to it within this scene: what bars or beckons, ` +
          `what they see as they approach. Do NOT move them to a new location or invent one.`,
        // Blank-narrator floor: the trigger leads with the raw `${requestedName}` (an arbitrary player
        // noun-phrase), so a name-free echo avoids splicing it mid-sentence and keeps its terminal stop.
        echoFallback: `That is part of ${fromLoc?.name ?? "this place"} itself — close at hand, not a journey away.`,
      } satisfies NarrationIntent;
    }
    // Receipts, not relays (the r9 F-5 rule, applied to the degrade): the refusal must reach the
    // screen MECHANICALLY, where prose cannot overwrite it. r14 (fixture-combat t6–t8) ran this exact
    // degrade three turns straight — "the split-stone where the glass-road forks" grounds nowhere,
    // the trigger told the narrator not to move, the narrator wrote approach prose over the refusal,
    // and the player, shown no receipt, asked again and again. Name the dead ask and the real ways
    // out; the narrator can dress it, but the fact stands on its own line.
    const ways = waysOnFrom(ctx, from);
    ctx.emit({
      kind: "stateChanged",
      summary:
        `No way from here leads to “${requestedName}” — it is not a place you can walk to from where ` +
        `you stand.${ways.length > 0 ? ` Ways on from here: ${ways.join(", ")}.` : ""}`,
      changes: {},
    });
    return {
      trigger:
        `You cast about for ${requestedName}, but no way here leads straight to it — it is not a place ` +
        `you can simply walk to from where you stand. Narrate the player looking for the way and what ` +
        `they actually see around them here; do NOT move them to a new place or invent one.`,
      // Blank-narrator floor: splicing `${requestedName}` after "cast about for" doubles the preposition
      // when the player's phrase leads with one ("…for back toward the crowd"), and the directive-strip
      // eats the terminal period. A name-free echo sidesteps both.
      echoFallback:
        `You look for a way there, but no path leads straight to it from where you stand — it is not ` +
        `a place you can simply walk to from here.`,
    } satisfies NarrationIntent;
  }

  const frontierId = `${FRONTIER_PREFIX}reach-${slugOfName(requestedName)}`;
  const pocket = generatePocket(world, from, frontierId, ctx.services.rng, realized, {
    name: requestedName,
    forcedGazetteerId: entry.id,
  });
  const entrance = pocket.locations[0];
  const res = ctx.apply({
    type: "expandWorld",
    fromLocationId: from,
    viaExitTo: frontierId,
    locations: pocket.locations,
    ...(pocket.realizedGazetteerId !== undefined ? { realizedGazetteerId: pocket.realizedGazetteerId } : {}),
    ...(pocket.emergentTown !== undefined ? { emergentTown: pocket.emergentTown } : {}),
  });
  if (!res.mutated || !entrance) {
    return { trigger: `You set out toward ${requestedName}, but the way defeats you for now.` };
  }
  // Mirror generated content into the cache the narrator/CLI read names from (the reducer owns the
  // model + durable slice; world.locations is the derived projection — hydrateExpansions rebuilds it
  // on load). Retarget the consumed frontier if present, else the reducer appended origin→entrance.
  const have = new Set(world.locations.map((l) => l.id));
  for (const loc of pocket.locations) if (!have.has(loc.id)) world.locations.push(structuredClone(loc));
  const holder = world.locations.find((l) => l.id === from);
  if (holder) {
    let retargeted = false;
    for (const exit of holder.exits) {
      if (exit.to === frontierId) {
        exit.to = entrance.id;
        retargeted = true;
      }
    }
    if (!retargeted && !holder.exits.some((e) => e.to === entrance.id)) {
      holder.exits.push({ to: entrance.id, name: `to ${entrance.name}`, locked: false, hidden: false });
    }
  }
  for (const spawn of pocket.spawns) ctx.apply({ type: "spawnEntity", entity: spawn });
  ctx.apply({ type: "moveParty", to: entrance.id });
  ctx.emit({
    kind: "stateChanged",
    summary: `The party sets out toward ${requestedName}, entering ${entrance.name}.`,
    changes: { partyLocationId: entrance.id, expandedVia: frontierId },
  });
  // When the pocket realizes a gazetteer entry, hand the narrator the breadcrumb as fact — the
  // rumored place lies at the far end of this approach.
  const realizedEntry =
    pocket.realizedGazetteerId !== undefined
      ? (world.gazetteer ?? []).find((g) => g.id === pocket.realizedGazetteerId)
      : undefined;
  const towardNote = realizedEntry
    ? ` ${realizedEntry.name}, the rumored ${realizedEntry.kind}, lies at the end of this way.`
    : "";
  return {
    trigger:
      `You set out toward ${requestedName}; the way leads on into ${entrance.name}.${towardNote} ` +
      `Narrate setting out and what first strikes the senses here.`,
  } satisfies NarrationIntent;
}

/**
 * Walk a CONFIRMED known-roads journey: re-pathfind (state may have drifted since the quote),
 * apply one `moveParty` per leg — every leg an adjacent, reducer-validated traversal, never a
 * teleport — and price the turn with the summed authored minutes at the one commit chokepoint.
 * A mid-route rejection stops the party honestly where they stand.
 */
export function executeKnownRoadsTravel(ctx: TickContext, destId: string, destName: string): NarrationIntent {
  const model = ctx.model;
  const from = partyLocationOf(model);
  if (!from) return { trigger: "You look for the road, but the way is lost." };
  if (from === destId) {
    ctx.data.clockMinutes = 1;
    ctx.data.energyCost = 0;
    return { trigger: `You are already at ${destName}.` };
  }
  const cost = costOf("movement");
  const route = findRoute(model, from, destId, { defaultLegMinutes: cost.minutes });
  if (!route || route.legs.length === 0) {
    ctx.data.clockMinutes = 1;
    ctx.data.energyCost = 0;
    return { trigger: `You set out for ${destName}, but the way is no longer open.` };
  }
  let traveledMinutes = 0;
  let reached = from;
  for (const leg of route.legs) {
    if (!ctx.apply({ type: "moveParty", to: leg.to }).mutated) break;
    traveledMinutes += leg.minutes;
    reached = leg.to;
  }
  if (reached === from) {
    ctx.data.clockMinutes = 1;
    ctx.data.energyCost = 0;
    return { trigger: `You set out for ${destName}, but the first stretch of road is closed to you.` };
  }
  const exhaustionLevel = exhaustionOf(playerEntity(model)?.stats);
  ctx.data.clockMinutes = Math.round(traveledMinutes * exhaustionMoveFactor(exhaustionLevel));
  ctx.data.energyCost = cost.energy > 0 ? scaledEnergy(cost.energy, traveledMinutes, cost.minutes) : 0;
  const arrivedName = locationNameOf(ctx.services.world, reached);
  const leftBehind = leftBehindNotice(from, model, ctx.recent);
  if (reached !== destId) {
    ctx.emit({
      kind: "stateChanged",
      summary: `The party sets out for ${destName}, but the road stops them at ${arrivedName}.`,
      changes: { partyLocationId: reached },
    });
    return {
      trigger:
        `You take the road toward ${destName}, but the way on from ${arrivedName} is closed — the ` +
        `journey ends here for now. Narrate the interrupted road.`,
    } satisfies NarrationIntent;
  }
  ctx.emit({
    kind: "stateChanged",
    summary: `The party travels the known roads to ${destName}.`,
    changes: { partyLocationId: destId },
  });
  return {
    trigger:
      `You travel the known roads to ${destName} — ${describeWalkDuration(traveledMinutes)} on foot.` +
      `${leftBehind ? ` (${leftBehind})` : ""} Narrate the journey passing and the arrival.`,
  } satisfies NarrationIntent;
}

/**
 * FAR travel referents for the classifier's `KNOWN_PLACES` line (r9 F-5's classifier face: with
 * only adjacent EXITS in view, "head west toward Ashford" had nothing to bind and the model
 * shrugged an explicit travel commitment into freeform). Three sources, deduped, current room +
 * adjacent exits excluded (those are EXITS' job), capped:
 *
 * 1. Places an OFFERED/ACTIVE quest names VERBATIM (word-bounded, case-insensitive, closed
 *    candidate list = the authored roster — the case-testimony matcher's discipline, never NER).
 *    The overdue-caravan notice says "last counted through Ashford": the moment that quest is on
 *    the table, Ashford is a place the player knowingly heads for.
 * 2. Unrealized gazetteer rumors (their reach path realizes them on demand).
 * 3. Visited places (the travel-back affordance), alphabetical for determinism.
 *
 * Names are the payload; the ids ride along for telemetry but never ground
 * `destinationLocationId` (EXITS-only rule) — the movement resolver owns routing and refusal.
 */
export function knownPlacesFor(
  model: WorldModel,
  world: World,
  campaign: Campaign,
  cap = 16,
): Array<{ id: string; name: string }> {
  const from = partyLocationOf(model);
  const exclude = new Set<string>(from ? [from, ...mapExitsFrom(model.map, from).map((e) => e.to)] : []);
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  const push = (id: string, name: string): void => {
    if (!name || seen.has(id) || exclude.has(id)) return;
    seen.add(id);
    out.push({ id, name });
  };
  const liveQuests = (campaign.quests ?? []).filter((q) => {
    const st = model.quests.get(q.id) ?? q.state;
    return st === "offered" || st === "active";
  });
  for (const q of liveQuests) {
    const text = `${q.name}\n${q.description}`;
    for (const loc of world.locations) {
      if (seen.has(loc.id) || exclude.has(loc.id)) continue;
      if (new RegExp(`\\b${escapeRegExp(loc.name)}\\b`, "i").test(text)) push(loc.id, loc.name);
    }
  }
  const realized = realizedGazetteerIdsOf(model.modules);
  for (const g of world.gazetteer ?? []) if (!realized.has(g.id)) push(g.id, g.name);
  const visited = world.locations
    .filter((l) => model.flags[visitedFlag(l.id)] === true)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const l of visited) push(l.id, l.name);
  return out.slice(0, cap);
}

/** True if a companion (a non-PC party member) is co-located with the PC — used to word a solo
 *  departure only when there is actually someone to leave behind. */
export function hasCompanionsHere(model: WorldModel): boolean {
  const loc = partyLocationOf(model);
  const playerId = playerEntity(model)?.id;
  for (const e of model.entities.values()) {
    if (e.partyMember && e.id !== playerId && e.locationId === loc) return true;
  }
  return false;
}

/**
 * Is procedural frontier expansion enabled for the loaded world? Read directly off the raw world
 * (no compiled-model layer). Gates BOTH generation triggers (frontier crossing, gazetteer reach)
 * and every frontier-offering surface — never the reducer/replay/hydrate path, so existing pockets
 * always replay regardless.
 */
/** Whether worldgen-as-explore is on for this world (the reversible `frontierExpansion` flag). */
export function frontierEnabled(world: World): boolean {
  return frontierExpansionEnabled(world);
}

/**
 * Consume a frontier exit: generate the pocket behind it (deterministic, seeded — identical
 * offline), apply it through the reducer's `expandWorld` chokepoint, mirror the generated
 * content into the world's content cache (names/descriptions for the narrator/CLI), spawn
 * anything lurking, and walk the party in. The pocket's far end opens a NEW frontier, so a
 * long exploration campaign never hits a final wall.
 */
export function expandFrontier(ctx: TickContext, frontierId: string): NarrationIntent {
  const model = ctx.model;
  const world = ctx.services.world;
  const from = partyLocationOf(model);
  if (!from) return { trigger: "You look for a way onward, but the way is lost." };

  // Realized gazetteer entries come from the durable expansion slice, so the seeded pick below
  // only ever draws from entries the party has NOT already reached (Phase 4 — author canon
  // guides exploration; the pocket is shaped toward the picked entry, its terminal room IS it).
  const pocket = generatePocket(world, from, frontierId, ctx.services.rng, realizedGazetteerIdsOf(model.modules));
  const entrance = pocket.locations[0];
  const res = ctx.apply({
    type: "expandWorld",
    fromLocationId: from,
    viaExitTo: frontierId,
    locations: pocket.locations,
    ...(pocket.realizedGazetteerId !== undefined ? { realizedGazetteerId: pocket.realizedGazetteerId } : {}),
    ...(pocket.emergentTown !== undefined ? { emergentTown: pocket.emergentTown } : {}),
  });
  if (!res.mutated || !entrance) {
    return { trigger: "You press toward the unexplored edge, but the way defeats you for now." };
  }
  // Mirror into the content cache the narrator/CLI/classifier read names from. The reducer owns
  // the model (map + durable expansion slice); world.locations is the derived projection of the
  // same payload — hydrateExpansions() rebuilds this exact mirror on every load.
  const have = new Set(world.locations.map((l) => l.id));
  for (const loc of pocket.locations) if (!have.has(loc.id)) world.locations.push(structuredClone(loc));
  for (const exit of world.locations.find((l) => l.id === from)?.exits ?? []) {
    if (exit.to === frontierId) exit.to = entrance.id;
  }
  for (const spawn of pocket.spawns) ctx.apply({ type: "spawnEntity", entity: spawn });

  ctx.apply({ type: "moveParty", to: entrance.id });
  ctx.emit({
    kind: "stateChanged",
    summary: `The party presses beyond the known paths into ${entrance.name}.`,
    changes: { partyLocationId: entrance.id, expandedVia: frontierId },
  });
  // When the pocket realizes a gazetteer entry, hand the narrator the breadcrumb as fact — the
  // rumored place lies at the far end of this pocket (deterministic template; the model only
  // phrases it).
  const realizedEntry =
    pocket.realizedGazetteerId !== undefined
      ? (world.gazetteer ?? []).find((g) => g.id === pocket.realizedGazetteerId)
      : undefined;
  const towardNote = realizedEntry
    ? ` The way ahead shows signs of ${realizedEntry.name}, the rumored ${realizedEntry.kind} travelers speak of.`
    : "";
  return {
    trigger:
      `You leave the mapped paths behind and enter ${entrance.name} — uncharted ground.${towardNote} ` +
      `Narrate the crossing into unknown territory and what first strikes the senses here.`,
  } satisfies NarrationIntent;
}

/**
 * A movement attempt onto a barred exit (Workstream H). The passive open paths run first —
 * a satisfied `condition` predicate, then the right key in the player's inventory — and either
 * unlocks the exit (a real `setExitState` through the reducer, so it persists and replays) and
 * walks the party through. Otherwise the obstacle is narrated AS an obstacle, with honest
 * hints at the active paths (picking, forcing) the barrier actually offers. Trigger text
 * carries the full meaning: offline, it is echoed verbatim.
 */
export function resolveBarredMove(
  ctx: TickContext,
  verdict: ExitVerdict,
  from: string,
  dest: string,
  destName: string,
): NarrationIntent {
  const model = ctx.model;
  const barrier = verdict.exit.barrier;
  const desc = barrierDescription(barrier);
  const player = playerEntity(model);

  // The COMPLETE lookup bundle (regex audit §10d). This used to pass `{ regionOf }` alone, and
  // because every `EvalLookups` resolver is fail-closed that made a `regionDangerAtLeast` barrier
  // clause false FOREVER — the door was permanently sealed with no error anywhere. `attireState`
  // was subtler: without `occupiedOf` it fell back to all six coverage slots, so a stripped PC the
  // brief's own `Attire:` line calls "bare" failed a `state: "bare"` barrier clause.
  const conditionOpens =
    barrier?.condition !== undefined &&
    evalPredicate(
      barrier.condition,
      model,
      from,
      undefined,
      standardEvalLookups(ctx.services.world, ctx.services.campaign.characters),
    );
  const keyId = barrier?.keyItemId;
  const heldKey = keyId !== undefined && player?.stats?.inventory.includes(keyId) ? keyId : undefined;

  if (conditionOpens || heldKey !== undefined) {
    ctx.apply({ type: "setExitState", locationId: from, to: dest, state: "open" });
    // A barred FRONTIER exit must GROW its pocket, not move the party onto the raw `frontier:`
    // sentinel id (a mapless phantom room). `expandFrontier` generates the pocket + retargets the
    // exit, and `applyExpansion` migrates the "open" overlay just set above onto the entrance key so
    // its own internal moveParty passes the barrier. Mirrors the unbarred frontier path (audit #10).
    if (isFrontierId(dest)) {
      const preface =
        heldKey !== undefined
          ? `You unlock ${desc} with the ${resolveItem(ctx.services.world, heldKey)?.name ?? heldKey} and pass through. `
          : `${capitalize(desc)} no longer bars the way. `;
      if (!frontierEnabled(ctx.services.world)) {
        // Frontier expansion disabled: the barrier opens, but there is no authored crossing beyond
        // it to travel into — degrade to an impassable beat rather than mint a pocket.
        ctx.data.clockMinutes = 1;
        ctx.data.energyCost = 0;
        return { trigger: `${preface}Beyond it the way simply ends — there is no crossing here.` };
      }
      const expanded = expandFrontier(ctx, dest);
      return { ...expanded, trigger: `${preface}${expanded.trigger}` };
    }
    const res = ctx.apply({ type: "moveParty", to: dest });
    if (res.mutated) {
      ctx.emit({
        kind: "stateChanged",
        summary: `The way to ${destName} opens — the party moves through.`,
        changes: { partyLocationId: dest },
      });
      if (heldKey !== undefined) {
        const keyName = resolveItem(ctx.services.world, heldKey)?.name ?? heldKey;
        return {
          trigger: `You unlock ${desc} with the ${keyName} and pass through. You travel to ${destName}.`,
        };
      }
      return { trigger: `${capitalize(desc)} no longer bars the way. You travel to ${destName}.` };
    }
  }

  const hints: string[] = [];
  if (keyId !== undefined) hints.push("the right key would open it");
  if (barrier?.dc !== undefined && verdict.state === "locked") hints.push("the lock might be picked");
  if (barrier?.breakDc !== undefined) hints.push("it could be forced");
  const hint = hints.length > 0 ? ` Perhaps ${hints.join(", or ")}.` : "";
  const stateWord = verdict.state === "blocked" ? "chokes the path" : "bars the way";
  // A rattled door is priced like the engine's other hard refusals — never the travel row.
  ctx.data.clockMinutes = 1;
  ctx.data.energyCost = 0;
  return {
    trigger: `You cannot reach ${destName}: ${desc} ${stateWord}.${hint}`,
    resolved: resolvedHardRefusal(`Passage to ${destName}`),
  };
}

/**
 * A skill check aimed at a barred exit (Workstream H): "pick the lock" rolls dex against the
 * barrier's `dc` and unlocks on success; "force the door" rolls str against `breakDc` and
 * BREAKS it — permanently open, and audibly so. Returns null when the input isn't a barrier
 * attempt (no barred exit here, no matching verb, no matching exit), letting the generic
 * check resolve as before. All state changes ride `setExitState` through the reducer.
 */
export async function resolveBarrierCheck(
  ctx: TickContext,
  plan: TurnPlan,
  input: string,
): Promise<NarrationIntent | null> {
  const model = ctx.model;
  const loc = partyLocationOf(model);
  if (loc === null) return null;
  // Hidden exits are undiscovered — the player has never seen them, so no check may target
  // one (the flee path and every player surface filter hidden the same way).
  const barred = barredExitsAt(model, loc).filter((v) => !v.exit.hidden);
  if (barred.length === 0) return null;

  const forcing = /\b(force|forces|pry|pries|break|breaks|smash|smashes|bash|bashes|kick|kicks|shoulder|shoulders|ram|rams|batter|batters)\b/i.test(input);
  const picking = /\b(pick|picks|lockpick|lockpicks|jimmy|jimmies|unfasten|unfastens|unlock|unlocks|unbar|unbars)\b/i.test(input);
  if (!forcing && !picking) return null;

  // The input must NAME the obstacle (exit label, destination, or the barrier's own words) —
  // never a blind fallback: "I break open the crate" beside the town's one locked gate is a
  // crate check, not a jailbreak.
  const target = matchBarredExit(ctx, input, barred);
  if (!target) return null;

  const destName = locationNameOf(ctx.services.world, target.exit.to);
  const desc = barrierDescription(target.exit.barrier);
  const verb: "force" | "pick" = forcing && !picking ? "force" : picking && !forcing ? "pick" : plan.check.ability === "str" ? "force" : "pick";

  const dc = verb === "pick" ? target.exit.barrier?.dc : target.exit.barrier?.breakDc;
  if (dc === undefined || (verb === "pick" && target.state !== "locked")) {
    const why =
      verb === "pick"
        ? `${capitalize(desc)} offers no lock your fingers can better.`
        : `${capitalize(desc)} will not yield to muscle.`;
    return { trigger: why, resolved: resolvedHardRefusal(`${verb === "pick" ? "Picking" : "Forcing"} ${desc}`) };
  }

  const player = playerEntity(model)?.id ?? ctx.state().party[0] ?? "pc.you";
  const ability: CheckAbility = verb === "pick" ? "dex" : "str";
  const skill = verb === "pick" ? "sleight of hand" : "athletics";
  const pc = ctx.services.campaign.characters.find((c) => c.id === player);
  const abilityScore = pc ? pc.stats.abilities[ability] : 10;
  const bonus = pc?.stats.proficiencies.includes(skill) ? 2 : 0;
  const label = `${verb === "pick" ? "Pick" : "Force"}: ${desc} (${destName})`;
  const mods = pcCheckMods(model);
  const effectiveDc = dc + mods.dcAdjustment;

  if (ctx.services.client?.promptRoll) {
    await ctx.services.client.promptRoll({
      actorId: player,
      ability,
      skill,
      dc: effectiveDc,
      label: `${label}, DC ${effectiveDc}`,
    });
  }

  const smods = statusMods(ctx.model, player);
  const result = resolveCheck(
    { abilityScore, dc: effectiveDc, bonus: bonus + smods.check, disadvantage: mods.disadvantage || smods.disadvantage },
    ctx.services.rng,
  );
  ctx.emit({
    kind: "diceRolled",
    actorId: player,
    notation: "1d20",
    rolls: result.rolls,
    total: result.total,
    purpose: `${label} (DC ${effectiveDc})`,
    success: result.success,
  });

  if (result.success) {
    const state = verb === "pick" ? "open" : "broken";
    ctx.apply({ type: "setExitState", locationId: loc, to: target.exit.to, state });
    ctx.emit({
      kind: "stateChanged",
      summary:
        verb === "pick"
          ? `The way to ${destName} is unlocked.`
          : `The way to ${destName} is broken open.`,
      changes: { locationId: loc, to: target.exit.to, exitState: state },
    });
    return {
      trigger:
        verb === "pick"
          ? `You work at ${desc} until the lock gives — the way to ${destName} stands open.`
          : `You throw yourself against ${desc} until it gives way with a crash — the way to ${destName} is broken open.`,
      resolved: resolvedFromCheck(label, result),
    };
  }
  return {
    trigger:
      verb === "pick"
        ? `You work at ${desc}, but the lock defeats you.`
        : `You strain against ${desc}, but it holds fast.`,
    resolved: resolvedFromCheck(label, result),
  };
}

/**
 * The barred exit the input names (exit label, destination, barrier kind, or the barrier's own
 * words), if any — the guard that decides whether a forcing/picking line rolls against a real
 * obstacle, whose success writes `setExitState … broken` through the reducer.
 *
 * WHY IT IS WEIGHTED, r8 regex audit. The old test was "any shared token of 3+ characters" over
 * a label that CONCATENATES the barrier's authored DESCRIPTION — and a description is a
 * sentence, not a label. One reproduced ward is authored as "no wall bars the way,
 * only a pressure in the air that turns most travelers back…", so its token bag holds `the`,
 * `way`, `only`, `back`, `most`, `hard`, `will`. Reproduced against the shipped method:
 *
 *   "I force my way through the crowd to the counter"  => the ward   (shared token: "way")
 *   "I break the seal on the letter"                   => the ward   (shared token: "the")
 *   "I break open the crate"                           => a locked door to "The Cellar" ("the")
 *
 * — three lines about furniture and strangers, each one rolling a break-out against a DC-22
 * magical barrier and, on a good roll, tearing a permanent hole in the world map.
 *
 * So the handles are ranked by how much they identify the obstacle. NAME handles — the exit
 * label, the destination, and the closed-enum kind's own words — are worth 2 on their own: "I
 * force the door" is unambiguous. DESCRIPTION words are worth 1, so it takes two of them to
 * carry a match alone; a single incidental word never does. `MIN_BARRIER_SCORE` is 2 for exactly
 * that reason. A miss costs the player a generic check on a real attempt; a wrong hit rewrites
 * the map, so the asymmetry is deliberate.
 *
 * AND AN EXIT NAME IS A SENTENCE TOO, r8 review. The ordinary-word filter went on the description
 * and stopped there, but authored exit names can be prose — one regression exit is
 * "through the sealed gate into the frozen highland" — so `through` was a full-weight NAME handle
 * worth 2 all by itself. Reproduced against the shipped method, three lines about crowds and
 * weather each armed a DC-24 Strength check that on success commits `setExitState "broken"` and
 * opens the frozen highland permanently:
 *
 *   "I force my way through the crowd to the counter"  => loc.northreach-highland
 *   "I break through the line of dockhands"            => loc.northreach-highland
 *   "I push through the fog toward the lamps"          => loc.northreach-highland
 *
 * The authored NAME is therefore filtered exactly as the description is (ordinary words, plus the
 * relation words a sentence is strung together with). The DESTINATION label and the closed-enum
 * kind handles keep full weight and are NOT filtered — they are labels, not prose, and they are
 * what a genuine attempt actually says: "I break into the cellar" has "cellar" and nothing else.
 */
export function matchBarredExit(
ctx: TickContext,input: string, barred: ExitVerdict[]): ExitVerdict | undefined {
  const words = matchBarredExitTokens(input);
  if (words.size === 0) return undefined;
  let best: { verdict: ExitVerdict; score: number } | undefined;
  for (const v of barred) {
    const named = matchBarredExitTokens(locationNameOf(ctx.services.world, v.exit.to));
    for (const t of matchBarredExitTokens(v.exit.name ?? "")) {
      if (!isOrdinaryWord(t) && !EXIT_NAME_RELATION_WORDS.has(t)) named.add(t);
    }
    for (const t of BARRIER_KIND_HANDLES[v.exit.barrier?.kind ?? "door"]) named.add(t);
    // An authored description is a SENTENCE, so its ordinary English words are dropped outright
    // (`isOrdinaryWord`, the repo's one closed common-word list): "the way", "back", "the air"
    // identify no obstacle, and two of them riding along in an unrelated line is precisely how
    // "I shoulder my way past the drunks and take the back stairs" scored the ward.
    const described = new Set(
      [...matchBarredExitTokens(barrierDescription(v.exit.barrier))].filter(
        (t) => !isOrdinaryWord(t) && !EXIT_NAME_RELATION_WORDS.has(t),
      ),
    );
    let score = 0;
    for (const w of named) if (words.has(w)) score += 2;
    for (const w of described) if (!named.has(w) && words.has(w)) score += 1;
    if (score >= MIN_BARRIER_SCORE && (best === undefined || score > best.score)) {
      best = { verdict: v, score };
    }
  }
  return best?.verdict;
}

/**
 * The authored crossing time (minutes) of the exit the party is about to take, or null when the
 * edge declares none — in which case the flat `TURN_COSTS.movement` row stands and travel behaves
 * exactly as it always has. Read off the live map, so a mutated/expanded world is priced too.
 */
export function exitMinutes(model: WorldModel, destinationId: string | null): number | null {
  if (!destinationId) return null;
  const from = partyLocationOf(model);
  if (!from) return null;
  const exit = mapExitsFrom(model.map, from).find((e) => e.to === destinationId);
  return exit?.minutes ?? null;
}
