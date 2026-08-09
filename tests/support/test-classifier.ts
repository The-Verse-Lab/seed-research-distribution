/**
 * TEST-ONLY input DSL — NOT part of the product.
 *
 * The old heuristic regex classifier, retired from the engine (owner decision, 2026-07-04:
 * the LLM classifier is THE classifier; live play never regex-guesses a player's line). It
 * survives here solely so deterministic engine tests can drive TurnPlans from the canonical
 * input phrasings ("go to the green", "I attack the wight", "Bett, come with us") without a
 * model. It makes NO claim about how live input is understood — do not grow it; new intents
 * go into the LLM prompt/schema and get scripted stubs in new tests.
 *
 * @author Runkai Zhang
 */
import type { TurnClassifier } from "../../src/engine/classify.ts";
import {
  type CheckAbility,
  type ClassifierContext,
  type ClassifierEntityRef,
  type TurnPartyVerb,
  type TurnPlan,
  type TurnQuestVerb,
  freeformPlan,
} from "../../src/engine/turn-plan.ts";

const DEFAULT_DC = 13;

const SPEAK_RE = /^\s*["“'`]|^\s*(say|says|tell|ask|asks|whisper|reply|answer|greet|talk|speak)\b/i;
const MOVE_RE = /\b(go|move|walk|head|travel|enter|leave|exit|depart|return)\b/i;
// Fleeing is movement (the disengage): an active fight ends when the party breaks away.
const FLEE_RE = /\b(flee|retreat|bolt|make a break|run(?:s)? (?:for|to|toward|away|out|back))\b/i;
const REST_RE = /\b(rest|sleep|nap|make camp|bed down|take (?:a )?(?:long |short )?rest|settle in for the night)\b/i;
const ATTACK_RE = /\b(attack|hit|strike|stab|shoot|swing|slash|kill|fight|punch|kick|lunge|charge)\b/i;
// Routine world-interaction verbs. Used to stop a line that merely NAMES an NPC mid-action
// ("help burn the coat with Maelle") from being misread as dialogue TO them — it's an action the
// DM should narrate. (Speech-led lines hit SPEAK_RE first; ability verbs hit step 4 first.)
const ACTION_RE =
  /\b(take|takes|grab|grabs|pull|push|open|opens|close|shut|light|lights|burn|burns|ignite|douse|pour|pours|drink|drinks|eat|eats|throw|throws|cut|cuts|tie|untie|break|breaks|use|uses|give|gives|hand|drop|drops|carry|place|put|build|dig|plant|offer|offers|mix|brew|scrape|smear|apply|wield|draw|sheathe|wear|help|helps|burn)\b/i;

// Item actions (Phase 1 items & economy): a handling verb PLUS a carried item named in the line.
// They fire only when a carried item matches, so bare verbs ("use the winch") fall through to the
// existing kinds. `don` excludes "don't"; unequip is checked first so "take off" beats "wear".
const ITEM_UNEQUIP_RE = /\b(unequip|remove|doff|stow|sheathe|take off|put away)\b/i;
const ITEM_EQUIP_RE = /\b(equip|wield|wear|don(?!['’]t)|ready|strap on|put on)\b/i;
const ITEM_GIVE_RE = /\b(give|hand|pass|offer)\b/i;
const ITEM_USE_RE = /\b(drink|quaff|swig|gulp|imbibe|use|apply|eat)\b/i;

// Trade (Phase 1 items & economy): commerce verbs PLUS a matching item — against the player's own
// inventory for selling, against a present vendor's stock for buying. Sell verbs are checked first
// (they're unambiguous); "barter" leans buy but falls through to the sell match when the named item
// is carried rather than stocked. No vendor present ⇒ no trade classification at all.
const TRADE_SELL_RE = /\b(sell|pawn|fence|hawk)\b/i;
const TRADE_BUY_RE = /\b(buy|purchase|barter|pay (?:.{0,12})?for)\b/i;

// Party actions (Phase 2): joining, leaving, and leadership of the traveling party. The nets are
// deliberately narrow — an invite/appointment fires only when a PRESENT entity is named in the
// line, and leaving needs the party/group noun — so ordinary travel ("I leave the tavern") and
// banter fall through to the existing kinds. All are negation-guarded like the item/trade nets.
const PARTY_INVITE_RE = /\b(?:join (?:me|us)|come with (?:me|us)|travel with|come along|recruit)\b/i;
// The MIRROR of invite: the player falling in with / following a present NPC who is guiding them
// forms one party just the same. Grounded to a PRESENT entity below, excludes an existing companion
// (no re-invite) and hostile/covert trailing (tail/shadow/sneak → the stealth/attack nets own those).
const PARTY_FOLLOW_RE =
  /\b(?:keep (?:up|pace) with|fall in (?:with|behind)|go with|stay (?:with|close to|near)|stick with|accompany|walk (?:with|alongside)|follow(?: after)?)\b/i;
const FOLLOW_HOSTILE_RE = /\b(?:tail|shadow|sneak|stalk|ambush|rob|jump|corner|attack|kill|hunt)\b/i;
const PARTY_LEAVE_RE =
  /\b(?:leave|leaving|quit|quitting|abandon|abandoning|depart|departing)\b[^.!?]{0,40}\b(?:party|group|company|band)\b|\bpart ways\b|\bgo my own way\b|\bstrike out on my own\b/i;
/** "part ways WITH …" names who is being parted from — grounded below, never a blind disband. */
const PART_WAYS_WITH_RE = /\bpart ways with\b/i;
// Appointment covers the hand-over family too: "pass/give/hand leadership" (the NOUN — a bare
// "leader" after a transfer verb stays an item give: "hand this to our leader Maelle"), "pass/
// give/hand the lead TO someone" (the lookahead keeps "hand the lead rope" an item), and the
// direct address "you lead (now/us)" — but never "you lead the way/charge" (movement/banter).
const PARTY_APPOINT_RE =
  /\b(?:appoint|make|name|elect|choose|promote)\b[^.!?]{0,40}\bleader(?:ship)?\b|\b(?:pass|give|hand)(?:s|ed|ing)?\b[^.!?]{0,40}\bleadership\b|\b(?:pass|give|hand)(?:s|ed|ing)?\b[^.!?]{0,30}\b(?:the )?lead\b(?=\s*(?:of\b|to\b|over\b|[,.!?]|$))|\blet\b[^.!?]{0,30}\blead\b|\btake(?:s)? (?:back )?the lead\b|\byou (?:lead|take the lead)\b(?!\s+the\b)|\byou(?:['’]re| are) (?:the |our )?leader\b/i;
// The player claiming the lead themselves — resolves to "reset to the PC-leads default".
const PARTY_SELF_LEAD_RE =
  /\bmake me (?:the )?leader\b|\bi(?:['’]ll| will)? take (?:back )?the lead\b|\bi take (?:back )?the lead\b/i;

// Quest actions (Phase 3): accepting or declining a task currently ON OFFER. Both nets need an
// offered quest to ground against (by FULL name, or the only one on offer when the line carries a
// task noun), so ordinary uses of "accept"/"refuse" ("I accept her apology") fall through to the
// existing kinds — the safe direction. Decline verbs are checked first: a decline often reads
// like negation ("I want no part of it"), and it must not be swallowed by the negation guard.
// The "I’ll/I will do|take" alternation REQUIRES the ‘ll/will — a bare "I do"/"I take" rides
// inside far too many ordinary sentences ("what should I do about the offer?"). The noun list
// deliberately excludes everyday words like "offer"/"work" ("I refuse to work with her" must
// never decline a quest); the deterministic offer notice steers players to "task" phrasing.
const QUEST_DECLINE_RE =
  /\b(?:decline|refuse|reject|turn (?:it |that |this )?down|pass on|want no part|not interested)\b/i;
const QUEST_ACCEPT_RE =
  /\b(?:accept|take (?:on|up)|agree to|sign on|i(?:['’]ll| will) (?:do|take)|count me in)\b/i;
const QUEST_NOUN_RE = /\b(?:task|quest|job|contract|errand|commission)\b/i;
const LOCATION_INTERACTION_RE = /\b(?:inspect|examine|read|check|study|ask|listen|probe|look at|look into)\b/i;

// Direction/intent guards for the item & trade nets. A negated verb ("I don't drink it") must
// never execute the action; "sell ME the dagger" asks the VENDOR to sell (a buy, never a sale of
// the player's own matching item); "give/hand ME the torch" asks someone ELSE to hand it over
// (never a player give); "what would you pay for my dagger?" is price talk, not a transaction.
// Guarded lines fall through to dialogue/check/freeform — the safe direction for a heuristic.
const NEGATION_RE =
  /\b(?:do(?:es)?n['’]?t|do not|does not|won['’]?t|will not|never|can['’]?t|cannot|couldn['’]?t|shouldn['’]?t|wouldn['’]?t|refuse to|not going to|decide[sd]? not to)\b/i;
const ITEM_REQUEST_RE =
  /\b(?:give|hand|pass|offer)\s+(?:me|us)\b|\b(?:give|hand|pass|offer)\b[^.!?]{0,40}\bto\s+(?:me|us)\b/i;
const TRADE_SELL_TO_PLAYER_RE = /\b(?:sell|pawn|fence|hawk)\s+(?:me|us)\b/i;
const TRADE_INQUIRY_RE = /\b(?:what|how much|how many)\b[^.!?]*\b(?:pay|cost|costs|worth|price|charge)\b/i;

const ABILITY_VERBS: Array<[RegExp, CheckAbility, string]> = [
  [/\b(force|pry|break|smash|lift|shove|grapple|wrench|heave|burst|hurl)\b/i, "str", "athletics"],
  [/\b(sneak|hide|climb|balance|pick|lockpick|sleight|tumble|leap|dodge|slip|creep|swipe|steal|disarm)\b/i, "dex", "stealth"],
  [/\b(endure|resist|withstand|brace|hold (?:my |your )?breath)\b/i, "con", "endurance"],
  [/\b(recall|remember|investigate|decipher|study|calculate|appraise|deduce)\b/i, "int", "investigation"],
  [/\b(search|listen|perceive|track|sense|spot|notice|scan|examine|inspect)\b/i, "wis", "perception"],
  [/\b(persuade|convince|intimidate|deceive|lie|charm|bluff|haggle|threaten|perform|coax|seduce)\b/i, "cha", "persuasion"],
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NAME_WORD_STOP = new Set(["the", "a", "an", "dame", "sir", "lady", "lord", "brother", "sister", "mother", "father", "sergeant", "captain"]);


function nameForms(name: string): string[] {
  const lower = name.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length >= 3 && !NAME_WORD_STOP.has(w));
  return [lower, ...words];
}

/** First present entity whose name (or salient first name) appears in the text. */
function findEntity(text: string, ctx: ClassifierContext): string | null {
  const lower = text.toLowerCase();
  for (const e of ctx.presentEntities) {
    for (const form of nameForms(e.name)) {
      if (new RegExp(`\\b${escapeRe(form)}\\b`).test(lower)) return e.id;
    }
  }
  return null;
}

/** A strong exit signal: the exit's full name or id appears verbatim in the text. The name's
 * leading article is ignored ("a burned track…" still matches "take the burned track…"). */
function findExitStrong(text: string, ctx: ClassifierContext): string | null {
  const lower = text.toLowerCase();
  for (const ex of ctx.exits) {
    const name = bareExitName(ex.name).toLowerCase().replace(/^(?:a|an|the)\s+/, "");
    if (lower.includes(name) || lower.includes(ex.id.toLowerCase())) return ex.id;
  }
  return null;
}

/** First item in the list whose name appears in the text. Full-name matches win across the whole
 * list before salient-word matches, so "potion of greater healing" isn't swallowed by a plain
 * healing potion carried in an earlier slot. */
function findItemIn(text: string, items: ClassifierEntityRef[]): string | null {
  const lower = text.toLowerCase();
  for (const item of items) {
    const full = item.name.toLowerCase().replace(/^(?:a|an|the)\s+/, "");
    if (full && lower.includes(full)) return item.id;
  }
  for (const item of items) {
    for (const form of nameForms(item.name)) {
      if (new RegExp(`\\b${escapeRe(form)}\\b`).test(lower)) return item.id;
    }
  }
  return null;
}

/** First carried item whose name appears in the text. */
function findCarriedItem(text: string, ctx: ClassifierContext): string | null {
  return findItemIn(text, ctx.carriedItems ?? []);
}

/** Item-action detection: a handling verb plus a carried item named in the line, else null. */
function classifyItemAction(text: string, ctx: ClassifierContext): TurnPlan | null {
  const itemId = findCarriedItem(text, ctx);
  if (!itemId) return null;
  // A negated line ("I don't drink the potion") or a request for someone ELSE to hand an item
  // over ("hand me the torch, Lyra") is never a player item action — fall through.
  if (NEGATION_RE.test(text) || ITEM_REQUEST_RE.test(text)) return null;
  const verb = ITEM_UNEQUIP_RE.test(text)
    ? ("unequip" as const)
    : ITEM_EQUIP_RE.test(text)
      ? ("equip" as const)
      : ITEM_GIVE_RE.test(text)
        ? ("give" as const)
        : ITEM_USE_RE.test(text)
          ? ("use" as const)
          : null;
  if (!verb) return null;
  // "use the rope to CLIMB the cliff" is a risky attempt, not consumption: when a generic
  // use/apply rides an ability verb, the check net (step 4) owns the line — the item is context
  // in the input the narrator sees. Unambiguous consumption (drink/eat/quaff) stays an item use.
  if (verb === "use" && /\b(?:use|uses|apply|applies)\b/i.test(text) && ABILITY_VERBS.some(([re]) => re.test(text))) {
    return null;
  }
  const targetId = verb === "give" ? findEntity(text, ctx) : null;
  return {
    ...freeformPlan(),
    kind: "itemAction",
    targetId,
    item: { verb, itemId, targetId },
    confidence: 0.7,
  };
}

/** Trade detection: a commerce verb plus an item matched against the right side of the counter —
 * the player's inventory when selling, a present vendor's stock when buying — else null. The
 * vendor is the one named in the line when any is, otherwise the first (usually only) one. */
function classifyTrade(text: string, ctx: ClassifierContext): TurnPlan | null {
  const vendors = ctx.vendors ?? [];
  if (vendors.length === 0) return null;
  // Negated commerce ("I won't sell it") and price inquiries ("what would you pay for my
  // dagger?") are conversation, never an executed transaction — fall through.
  if (NEGATION_RE.test(text) || TRADE_INQUIRY_RE.test(text)) return null;
  const named = vendors.find((v) => nameForms(v.name).some((form) => new RegExp(`\\b${escapeRe(form)}\\b`).test(text.toLowerCase())));
  // "sell ME a dagger" asks the vendor to sell — the player is BUYING, so the sell net must
  // not fire on their own carried dagger; the request routes through the buy net instead.
  const sellToPlayer = TRADE_SELL_TO_PLAYER_RE.test(text);
  if (TRADE_SELL_RE.test(text) && !sellToPlayer) {
    const itemId = findCarriedItem(text, ctx);
    if (!itemId) return null;
    const vendor = named ?? vendors[0]!;
    return {
      ...freeformPlan(),
      kind: "trade",
      targetId: vendor.id,
      trade: { direction: "sell", itemId, vendorId: vendor.id },
      confidence: 0.7,
    };
  }
  if (TRADE_BUY_RE.test(text) || sellToPlayer) {
    for (const vendor of named ? [named] : vendors) {
      const itemId = findItemIn(text, vendor.stock);
      if (itemId) {
        return {
          ...freeformPlan(),
          kind: "trade",
          targetId: vendor.id,
          trade: { direction: "buy", itemId, vendorId: vendor.id },
          confidence: 0.7,
        };
      }
    }
    // "barter" with nothing stocked matching: bartering AWAY something carried is a sell.
    if (/\bbarter\b/i.test(text)) {
      const itemId = findCarriedItem(text, ctx);
      if (itemId) {
        const vendor = named ?? vendors[0]!;
        return {
          ...freeformPlan(),
          kind: "trade",
          targetId: vendor.id,
          trade: { direction: "sell", itemId, vendorId: vendor.id },
          confidence: 0.65,
        };
      }
    }
  }
  return null;
}

/** Party-action detection: invite/leave/appoint-leader nets, negation-guarded. Invite and appoint
 * fire only when a PRESENT entity is named (or, for appoint, the player claims the lead
 * themselves) — an unresolved "who" falls through to dialogue/freeform, the safe direction. */
function classifyPartyAction(text: string, ctx: ClassifierContext): TurnPlan | null {
  if (NEGATION_RE.test(text)) return null;
  const plan = (verb: TurnPartyVerb, targetId: string | null): TurnPlan => ({
    ...freeformPlan(),
    kind: "partyAction",
    targetId,
    party: { verb, targetId },
    confidence: 0.7,
  });
  // Travel that merely borrows party phrasing must STAY movement: "I travel with Maelle to the
  // barrow" and "I take the lead and head to the old barrow" carry a move verb AND ground to a
  // real exit — the movement net owns those lines (invite/self-lead only; an explicit
  // leave/appoint-by-name keeps its party meaning).
  const movesSomewhere = (MOVE_RE.test(text) || FLEE_RE.test(text)) && findExit(text, ctx) !== null;
  if (PARTY_APPOINT_RE.test(text)) {
    if (PARTY_SELF_LEAD_RE.test(text)) return movesSomewhere ? null : plan("appointLeader", null);
    const targetId = findEntity(text, ctx);
    if (targetId) return plan("appointLeader", targetId);
    return null;
  }
  if (PARTY_LEAVE_RE.test(text)) {
    // "part ways with X": X must ground. A named COMPANION makes it a single dismissal (that
    // member only, never a whole-party disband); anything else ("part ways with the caravan")
    // is conversation and falls through — the safe direction.
    if (PART_WAYS_WITH_RE.test(text)) {
      const targetId = findEntity(text, ctx);
      return targetId && ctx.companionIds.includes(targetId) ? plan("leave", targetId) : null;
    }
    return plan("leave", null);
  }
  if (PARTY_INVITE_RE.test(text)) {
    if (movesSomewhere) return null;
    const targetId = findEntity(text, ctx);
    if (targetId) return plan("invite", targetId);
  }
  // "keep up with Oda" / "follow the old man": falling in with a present NON-party NPC is an invite
  // (they must agree to travel with you). An existing companion needs no re-invite; hostile/covert
  // trailing and lines that move to a real exit fall through to the stealth/attack/movement nets.
  if (PARTY_FOLLOW_RE.test(text) && !FOLLOW_HOSTILE_RE.test(text) && !movesSomewhere) {
    const targetId = findEntity(text, ctx);
    if (targetId && !ctx.companionIds.includes(targetId)) return plan("invite", targetId);
  }
  return null;
}

/** A quest ON OFFER whose FULL name appears in the text (leading article ignored). Quests ground
 * on the whole name ONLY — never the per-word `nameForms` pass — because quest names are
 * sentence-like phrases ("What Stirs Beyond Emberford") whose individual words (what/stirs/
 * beyond) are everyday vocabulary; word-level matching would turn ordinary lines ("I refuse to
 * say what I saw") into quest mutations. */
function findQuestByName(text: string, offered: ClassifierEntityRef[]): string | null {
  const lower = text.toLowerCase();
  for (const q of offered) {
    const full = q.name.toLowerCase().replace(/^(?:a|an|the)\s+/, "");
    if (full && lower.includes(full)) return q.id;
  }
  return null;
}

/** Quest-action detection: an accept/decline verb grounded to a quest ON OFFER — by FULL name, or
 * the single offered quest when the line carries a task noun. No offered quests ⇒ never fires. The
 * decline net runs first (decline language often looks like negation); the accept net is
 * negation-guarded so "I won't accept the job" falls through to freeform — the safe direction. */
function classifyQuestAction(text: string, ctx: ClassifierContext): TurnPlan | null {
  const offered = ctx.offeredQuests ?? [];
  if (offered.length === 0) return null;
  const verb: TurnQuestVerb | null = QUEST_DECLINE_RE.test(text)
    ? "decline"
    : QUEST_ACCEPT_RE.test(text) && !NEGATION_RE.test(text)
      ? "accept"
      : null;
  if (!verb) return null;
  const byName = findQuestByName(text, offered);
  const questId = byName ?? (offered.length === 1 && QUEST_NOUN_RE.test(text) ? offered[0]!.id : null);
  if (!questId) return null;
  return {
    ...freeformPlan(),
    kind: "questAction",
    quest: { verb, questId },
    confidence: 0.7,
  };
}

function findLocationInteraction(text: string, ctx: ClassifierContext): string | null {
  const lower = text.toLowerCase();
  for (const interaction of ctx.locationInteractions ?? []) {
    const label = interaction.label.toLowerCase().replace(/^(?:a|an|the)\s+/, "");
    if (label && lower.includes(label)) return interaction.id;
    if (lower.includes(interaction.id.toLowerCase())) return interaction.id;
    for (const form of nameForms(interaction.label)) {
      if (new RegExp(`\\b${escapeRe(form)}\\b`).test(lower)) return interaction.id;
    }
  }
  return null;
}

function classifyLocationInteraction(text: string, ctx: ClassifierContext): TurnPlan | null {
  if (!LOCATION_INTERACTION_RE.test(text)) return null;
  const interactionId = findLocationInteraction(text, ctx);
  return interactionId
    ? { ...freeformPlan(), kind: "locationInteraction", interaction: { interactionId }, confidence: 0.7 }
    : null;
}

/** A present entity named at the very start of the input (a vocative, e.g. "Lyra, …"). */
function findVocative(text: string, ctx: ClassifierContext): string | null {
  const lower = text.trim().toLowerCase();
  for (const e of ctx.presentEntities) {
    for (const form of nameForms(e.name)) {
      if (lower.startsWith(form)) {
        const after = lower.slice(form.length);
        if (after === "" || /^[\s,:.!?]/.test(after)) return e.id;
      }
    }
  }
  return null;
}

/** Three-letter function words that ride inside exit labels ("back the way you came") — never
 * salient, so they must not score. Three-letter PLACE nouns ("Tor", "Fen" — both in shipped
 * gazetteers) stay countable: dropping every short word sent "head toward the tor" backward,
 * because both generated exit labels hit only "toward" and the tie kept the earliest exit. */
const EXIT_WORD_STOP = new Set([
  "the", "and", "for", "you", "via", "way", "its", "her", "his", "our", "out", "off", "not", "but",
]);

/** The exit best named by the text. A FULL name/id match (the player typed the label verbatim,
 * e.g. clicking-and-retyping "on toward Rushdown Fen") beats everything; otherwise exits compete
 * on how MANY salient name/id words the text hits, not on declaration order — so "head toward
 * Rushdown Fen" walks toward the Fen instead of bouncing off "back toward the entrance" merely
 * because that exit was pushed first and also contains "toward". Salient means 4+ letters, or a
 * 3-letter word that isn't a stop word — short place nouns ("the tor", "the fen") must route.
 * Atmospheric exit labels ("the tax-road into the city") often omit the destination's name, so
 * the destination id's slug words ("loc.tallow-market" → tallow, market) count too. Ties keep
 * the earliest exit (stable). */
/** Exit display names may carry a runtime state tag (" (locked)" etc. — Workstream H); matching
 * must see the bare label, or "go to Emberford Square" stops full-name matching
 * "Emberford Square (locked)". */
function bareExitName(name: string): string {
  return name.replace(/\s*\((?:locked|blocked|broken open)\)\s*$/i, "");
}

function findExit(text: string, ctx: ClassifierContext): string | null {
  const lower = text.toLowerCase();
  for (const ex of ctx.exits) {
    if (lower.includes(bareExitName(ex.name).toLowerCase()) || lower.includes(ex.id.toLowerCase())) return ex.id;
  }
  let best: string | null = null;
  let bestHits = 0;
  for (const ex of ctx.exits) {
    const words = [
      ...bareExitName(ex.name).toLowerCase().split(/\s+/),
      ...ex.id.toLowerCase().replace(/^(loc|gen|frontier)[.:]/, "").split(/[-_.:]+/),
    ].filter((w) => w.length >= 4 || (w.length === 3 && !EXIT_WORD_STOP.has(w)));
    const hits = new Set(words.filter((w) => new RegExp(`\\b${escapeRe(w)}\\b`).test(lower))).size;
    if (hits > bestHits) {
      best = ex.id;
      bestHits = hits;
    }
  }
  return best;
}

/** Pure, deterministic intent classifier. Never refuses; falls back to freeform. */
export function heuristicClassify(text: string, ctx: ClassifierContext): TurnPlan {
  const t = text.trim();
  if (!t) return freeformPlan();

  // 1. Speech (quote or speech verb).
  if (SPEAK_RE.test(t)) {
    return { ...freeformPlan(), kind: "dialogueToNpc", targetId: findEntity(t, ctx), confidence: 0.6 };
  }

  // 1b. Party membership/leadership — BEFORE the vocative net ("Vex, join us" is an invite, not
  // mere address) and before movement ("I leave the party" is not travel out of the room).
  const partyAction = classifyPartyAction(t, ctx);
  if (partyAction) return partyAction;

  // 1b2. Quest opt-in — accepting/declining a task ON OFFER, before the vocative/other nets so
  // "I accept the task, Maelle" is the opt-in, not mere address. Grounded: no offer, no fire.
  const questAction = classifyQuestAction(t, ctx);
  if (questAction) return questAction;

  // 1c. Vocative — a name at the very start ("Lyra, …") is addressing them, even if the
  // rest of the line contains words like "move" that would otherwise look like other kinds.
  const vocative = findVocative(t, ctx);
  if (vocative) {
    return { ...freeformPlan(), kind: "dialogueToNpc", targetId: vocative, confidence: 0.65 };
  }

  // 2a. Rest — recovery intent ("make camp", "take a long rest").
  if (REST_RE.test(t)) {
    return { ...freeformPlan(), kind: "rest", confidence: 0.7 };
  }

  // 2. Movement — a movement verb (fleeing counts: it is the combat disengage), or an exact
  // location name/id, signals travel. A bare salient name-word ("square") only counts as a
  // destination when a move verb is present, so "examine the square table" isn't misread as travel.
  if (MOVE_RE.test(t) || FLEE_RE.test(t) || findExitStrong(t, ctx)) {
    return { ...freeformPlan(), kind: "movement", destinationLocationId: findExit(t, ctx), confidence: 0.7 };
  }

  // 3. Attack.
  if (ATTACK_RE.test(t)) {
    return { ...freeformPlan(), kind: "attack", targetId: findEntity(t, ctx), confidence: 0.6 };
  }

  // 3b. Trade — buy/sell with a present merchant. Before item handling so "offer to sell my
  //     dagger" is commerce, not a give; it needs BOTH a commerce verb and a matched item, so
  //     bare "buy time" or vendor-less markets fall through.
  const trade = classifyTrade(t, ctx);
  if (trade) return trade;

  // 3c. Item handling — equip/stow/drink/give of an item the player actually carries. After
  //     attack (violence with a named weapon stays an attack), before the ability-verb net.
  const itemAction = classifyItemAction(t, ctx);
  if (itemAction) return itemAction;

  const interaction = classifyLocationInteraction(t, ctx);
  if (interaction) return interaction;

  // 4. Uncertain attempt → ability check.
  for (const [re, ability, skill] of ABILITY_VERBS) {
    if (re.test(t)) {
      return {
        kind: "attemptRequiringCheck",
        targetId: findEntity(t, ctx),
        destinationLocationId: null,
        check: { warranted: true, ability, skill, dc: DEFAULT_DC, reason: `${skill} attempt` },
        confidence: 0.6,
      };
    }
  }

  // 5. Addressing someone by name without a speech verb — UNLESS the line is a world action that
  //    merely names them ("help burn the coat with Maelle" is an action, not dialogue to her).
  const named = findEntity(t, ctx);
  if (named && !ACTION_RE.test(t)) {
    return { ...freeformPlan(), kind: "dialogueToNpc", targetId: named, confidence: 0.5 };
  }

  // 6. Freeform.
  return freeformPlan();
}

export const heuristicClassifier: TurnClassifier = {
  classify(text, ctx) {
    return Promise.resolve(heuristicClassify(text, ctx));
  },
};
