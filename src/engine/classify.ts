/**
 * Intent classification — turns one line of player input into a TurnPlan.
 *
 * The utility model IS the classifier (owner decision, 2026-07-04): it reads the line with
 * the live world context, and reconcilePlan validates/repairs its output against the real
 * world (ids must ground; anything that doesn't degrades toward freeform — the safe
 * direction). On failure the plan degrades to freeformNarrative, never to a guess: a line
 * the model can't classify is handed to the narrator whole, so the loop can neither stall
 * on a refusal nor misroute a player's phrasing through pattern-matching.
 *
 * @author Runkai Zhang
 */
import type { LlmGateway } from "../llm/gateway.ts";
import { nameMentionedIn, nameTokens } from "../rules/name-match.ts";
import { isWardrobeSlotId } from "../rules/wardrobe.ts";
import { isAskedNotCommitted } from "../rules/asked.ts";
import { matchExit } from "../world/exit-match.ts";
import {
  type CheckAbility,
  type ClassifierContext,
  type TurnPlan,
  TurnPlanSchema,
  freeformPlan,
} from "./turn-plan.ts";

export interface TurnClassifier {
  classify(text: string, ctx: ClassifierContext): Promise<TurnPlan>;
}

const DEFAULT_DC = 13;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Addressee words that mean "whoever keeps the counter here" rather than a particular person —
 *  spoken-addressee corroboration (r10 F-2) passes these for any vendor. */
const GENERIC_VENDOR_WORDS = new Set([
  "merchant", "vendor", "trader", "seller", "dealer", "shopkeep", "shopkeeper", "stallkeep",
  "stallkeeper", "stallholder", "keeper", "clerk", "barkeep", "barkeeper", "barman", "barmaid",
  "innkeep", "innkeeper", "peddler", "monger", "shop", "stall", "counter", "store",
]);

/** Words in an addressee phrase that carry no identity of their own. */
const ADDRESSEE_SKIP_WORDS = new Set([
  "the", "a", "an", "that", "this", "these", "those", "his", "her", "their", "my", "our", "your",
  "its", "old", "young", "good",
]);

/**
 * Whether the player's own words for whom they addressed ("the tanner", "Veil", "the sergeant")
 * can mean this vendor. Deliberately RAW-token (never `nameHandleTokens`): occupation words like
 * "sergeant"/"clerk" are noise-tier for prose mentions but are exactly how a player addresses a
 * merchant, and dropping them here would misaddress every "I ask the sergeant…" at Sergeant Veil.
 * No leftover words (bare pronoun/article) corroborates by default — naming no one accuses no one.
 */
function vendorAnswersTo(spoken: string, vendor: { id: string; name: string }): boolean {
  const words = spoken
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !ADDRESSEE_SKIP_WORDS.has(w));
  if (words.length === 0) return true;
  if (words.every((w) => GENERIC_VENDOR_WORDS.has(w))) return true;
  const surface = new Set(
    nameTokens(`${vendor.name} ${vendor.id.replace(/^[a-z]+\./, "").replace(/[-_]+/g, " ")}`),
  );
  return words.some((w) => surface.has(w));
}

/** The engine-local default: everything is freeform narrative. Safe (the narrator sees the
 * whole line), model-free, and deliberately dumb — real clients inject the LLM classifier;
 * tests inject their own stubs. */
export const freeformClassifier: TurnClassifier = {
  classify() {
    return Promise.resolve(freeformPlan());
  },
};

/**
 * Validate and repair a raw (model-authored) plan against the real world.
 * Throws if the object isn't a structurally valid TurnPlan (caller falls back).
 */
export function reconcilePlan(raw: unknown, ctx: ClassifierContext, rawInput = ""): TurnPlan {
  const parsed = TurnPlanSchema.parse(raw); // throws → caller falls back to freeform
  const presentIds = new Set(ctx.presentEntities.map((e) => e.id));

  let targetId = parsed.targetId && presentIds.has(parsed.targetId) ? parsed.targetId : null;
  // The addressee's spoken name, confessed by the classifier (r13). Two jobs, both only for
  // dialogueToNpc: (1) LATE-BIND a classifier id-miss — the model named a person who IS present
  // ("Brann") but returned a null/hallucinated id; a UNIQUE token-subset match against present
  // entities, corroborated in the player's own line via the shared binder, recovers the id the
  // model already meant (never a DIFFERENT entity: every spoken token must belong to the match's
  // name). (2) When nothing binds, CARRY the name so the engine can answer the phantom addressee
  // honestly ("There is no sign of anyone called Corin here.") instead of the content-free stub —
  // an NPC reply can mint a findable person the roster never had (Sela's "Corin"), and dropping
  // the name here was what left the turn unanswerable. Fail-closed: no name, ambiguity, or a
  // missing rawInput corroboration ⇒ exactly today's behavior.
  const spokenName =
    parsed.kind === "dialogueToNpc" && typeof parsed.targetName === "string"
      ? parsed.targetName.trim().slice(0, 60)
      : "";
  if (parsed.kind === "dialogueToNpc" && targetId === null && spokenName) {
    const spokenTokens = nameTokens(spokenName).filter((t) => !ADDRESSEE_SKIP_WORDS.has(t));
    if (spokenTokens.length > 0) {
      const matches = ctx.presentEntities.filter((e) => {
        const entityTokens = new Set(nameTokens(e.name));
        return spokenTokens.every((t) => entityTokens.has(t));
      });
      if (matches.length === 1 && nameMentionedIn(rawInput, matches[0]!.name, { surface: "uncased" })) {
        targetId = matches[0]!.id;
      }
    }
  }
  // Ground the destination against the real exits: exact id first (prior behavior), then a
  // conservative fuzzy fold (normalized name/direction, then a UNIQUE token-overlap match of the
  // model's guess OR the raw player line). An ambiguous tie stays null → the honest miss below.
  const dest = matchExit(parsed.destinationLocationId, rawInput, ctx.exits, ctx.locationId, parsed.destinationName);

  // The item payload must name an item the player actually carries — EXCEPT `pickup`, whose target
  // is by definition NOT carried: it grounds against this location's floor instead (FLOOR_ITEMS).
  // A give-recipient must be present. A hallucinated id drops the payload (and the kind, below).
  const carriedIds = new Set((ctx.carriedItems ?? []).map((i) => i.id));
  const floorIds = new Set((ctx.floorItems ?? []).map((i) => i.id));
  const rawItem = parsed.item ?? null;
  const itemPool = rawItem?.verb === "pickup" ? floorIds : carriedIds;
  const item =
    rawItem && rawItem.itemId && itemPool.has(rawItem.itemId)
      ? {
          verb: rawItem.verb,
          itemId: rawItem.itemId,
          targetId: rawItem.targetId && presentIds.has(rawItem.targetId) ? rawItem.targetId : null,
        }
      : null;

  // The cast payload must name a spell the caster actually KNOWS (the SPELLS: list); its target,
  // when set, must be a present entity (a null target is a self/object cast). A hallucinated spell
  // id drops the payload (and downgrades the kind below) → freeform, the itemAction precedent.
  const knownSpellIds = new Set((ctx.knownSpells ?? []).map((s) => s.id));
  const rawCast = parsed.cast ?? null;
  const cast =
    rawCast && rawCast.spellId && knownSpellIds.has(rawCast.spellId)
      ? {
          spellId: rawCast.spellId,
          targetId: rawCast.targetId && presentIds.has(rawCast.targetId) ? rawCast.targetId : null,
        }
      : null;

  // The learn payload must name a spell on the LEARNABLE list (a study-credit pick, a present
  // trainer's offer, or a carried scroll); an ungrounded id drops the payload (and the kind, below).
  // A named source, when it matches a real backing option, is kept as a hint; the engine re-derives
  // the actual source/cost at resolution, so a wrong hint never mis-charges.
  const learnable = ctx.learnableSpells ?? [];
  const rawLearn = parsed.learn ?? null;
  let learn: { spellId: string; source: "study" | "trainer" | "scroll" | null; sourceId: string | null } | null =
    null;
  if (rawLearn && rawLearn.spellId) {
    const candidates = learnable.filter((l) => l.id === rawLearn.spellId);
    if (candidates.length > 0) {
      // Resolve to a SPECIFIC offer — by the sourceId the model copied, else the source label it
      // named, else the sole option when there is only one. The engine re-derives cost/availability
      // at resolution, so a wrong pick never mis-charges; the point of grounding here is to carry the
      // player's stated surface (esp. "study", which has no id to copy) through to the resolver.
      const bySourceId = rawLearn.sourceId ? candidates.find((l) => l.sourceId === rawLearn.sourceId) : undefined;
      const bySource = rawLearn.source ? candidates.find((l) => l.source === rawLearn.source) : undefined;
      const chosen = bySourceId ?? bySource ?? (candidates.length === 1 ? candidates[0] : undefined);
      learn = chosen
        ? { spellId: chosen.id, source: chosen.source, sourceId: chosen.sourceId ?? null }
        : { spellId: rawLearn.spellId, source: null, sourceId: null };
    }
  }

  // The clothing payload's slot must be a real wardrobe slot id (or the whole-body "all") — the
  // one payload vocabulary that grounds against CODE, not scene context. An unrecognized slot
  // drops the payload (and the kind, below) → freeform, the itemAction degrade precedent.
  const rawClothing = parsed.clothing ?? null;
  const clothing =
    rawClothing && (rawClothing.slot === "all" || isWardrobeSlotId(rawClothing.slot))
      ? { slot: rawClothing.slot, state: rawClothing.state }
      : null;

  // The trade payload needs a present vendor (defaulting to the only one when the model left it
  // null). The ITEM is deliberately passed through UNGROUNDED: the engine is the resolve-time
  // authority and refuses honestly per case (not in stock, not carried, no price) — filtering it
  // here would collapse those distinct truths into freeform, where the narrator fabricates a
  // completed deal instead (live r4-C). No vendor present ⇒ the payload stays null but the KIND
  // survives (see below), so the engine can say "no merchant here" rather than roleplay one.
  const vendors = ctx.vendors ?? [];
  const rawTrade = parsed.trade ?? null;
  let trade: TurnPlan["trade"] = null;
  if (rawTrade) {
    // A null itemId SURVIVES (a browse — "show me what you sell" — the engine answers with the
    // real counter), and a hallucinated vendorId beside exactly one real stall repairs to that
    // stall (the model clearly meant the only merchant here). Only a vendor-less room drops the
    // payload — the kind still survives to the honest "no merchant" refusal (see below).
    const vendor =
      (rawTrade.vendorId ? vendors.find((v) => v.id === rawTrade.vendorId) : undefined) ??
      (vendors.length === 1 ? vendors[0] : undefined);
    // THE ADDRESSEE GUARD (r7 P1, the rapier exploit). The sole-vendor repair above is right for
    // "I buy a ration" in a market with one stall — and catastrophically wrong when the player is
    // DEALING WITH SOMEONE ELSE: "I hand him the rapier, name your price" aimed at a prose
    // die-cutter repaired its vendor to Sergeant Veil and SOLD the weapon at half list. A sell
    // whose addressed target is not the vendor it repaired to is no sale at all: drop the payload,
    // keep the kind, and the engine answers honestly with who actually keeps a counter here.
    const addressedElsewhere =
      parsed.targetId !== null &&
      presentIds.has(parsed.targetId) &&
      vendor !== undefined &&
      parsed.targetId !== vendor.id;
    // THE SPOKEN-ADDRESSEE GUARD (r10 F-2, the tanner exploit — the guard above is blind to it
    // because the model grounded "the tanner" to the salient clerk BEFORE targetId reached us).
    // The model now carries the player's own words for whom they addressed; when those words name
    // neither a generic merchant nor the vendor it chose, the deal is with someone this room does
    // not have — drop the payload, keep the kind, and the honest no-payload path answers with who
    // actually keeps a counter here. No spoken addressee (null/pronoun) corroborates by default.
    const spokenVendor = (rawTrade.vendorWords ?? "").trim();
    const vendorMisaddressed =
      spokenVendor.length > 0 && vendor !== undefined && !vendorAnswersTo(spokenVendor, vendor);
    // r14 (fixture-trade t2/t3, the b45258d gap): the spoken-addressee guard below rightly refuses to
    // EXECUTE against a stall the player never addressed ("the smith's stall" where no smith
    // exists) — but dropping the whole payload also threw away the ask's own words, so "what's
    // your cheapest blade?" fell to the generic capped browse and the kind-filtered answer never
    // ran. Keep the guard's teeth where they bite (nothing may execute) and keep the ask: a
    // misaddressed BUY survives DEMOTED to a forced inquiry at the stallkeeper who is actually
    // here — quote-only by construction, the same "who actually keeps a counter" teach, now about
    // the thing the player asked for. Misaddressed SELLS stay dropped: their exploit was the
    // execution itself (r7 rapier, r10 tanner), and a sell quote volunteered by the wrong vendor
    // reads as an offer nobody made.
    const demotedBuy = vendor !== undefined && vendorMisaddressed && rawTrade.direction === "buy";
    if (vendor && (demotedBuy || (!(rawTrade.direction === "sell" && addressedElsewhere) && !vendorMisaddressed))) {
      trade = {
        direction: rawTrade.direction,
        itemId: rawTrade.itemId ?? null,
        vendorId: vendor.id,
        // Pass a stated multi-unit count through; 1/absent stays absent so the wire and every
        // pre-quantity assertion remain byte-identical.
        ...(Number.isInteger(rawTrade.quantity) && (rawTrade.quantity as number) > 1
          ? { quantity: rawTrade.quantity as number }
          : {}),
        // r10 F-2/F-3 — the inquiry flag and the player's verbatim ware words ride to the resolver
        // (quote-not-execute; corroborate-or-refuse). Omit-when-absent keeps pre-r10 plans and every
        // byte-level assertion on existing fixtures unchanged.
        // r11 P1 — the flag is a MODEL judgment and it flips on identical input: the same
        // "would you take my mage hat for three copper?" sold the worn hat on one pass and quoted a
        // price on the next. `isAskedNotCommitted` is the deterministic floor under it, and it only
        // ever pushes toward the question — a line that states a commitment is never forced.
        // A demoted misaddressed buy is FORCED to the question — the guard's whole point is that
        // no execution may ride a repaired addressee (see above); the floor and the model flag
        // keep their existing say everywhere else.
        ...(rawTrade.inquiry === true || demotedBuy || isAskedNotCommitted(rawInput) ? { inquiry: true } : {}),
        ...(typeof rawTrade.itemWords === "string" && rawTrade.itemWords.trim().length > 0
          ? { itemWords: rawTrade.itemWords.trim() }
          : {}),
        ...(spokenVendor.length > 0 ? { vendorWords: spokenVendor } : {}),
      };
    }
  }

  // The service payload (r8). Ground the host against PRESENT entities and the service against
  // that vendor's authored list; the carried item against the pack. Everything degrades to null
  // rather than dropping the KIND — the engine's honest-refusal path guarantees the player keeps
  // their property, which is the entire point of the kind existing.
  const rawService = parsed.service ?? null;
  let service: TurnPlan["service"] = null;
  if (rawService || parsed.kind === "service") {
    const npcId =
      rawService?.npcId && presentIds.has(rawService.npcId)
        ? rawService.npcId
        : parsed.targetId && presentIds.has(parsed.targetId)
          ? parsed.targetId
          : null;
    const host = npcId ? vendors.find((v) => v.id === npcId) : undefined;
    const serviceId =
      rawService?.serviceId && (host?.services ?? []).some((s) => s.id === rawService.serviceId)
        ? rawService.serviceId
        : null;
    const itemId = rawService?.itemId && carriedIds.has(rawService.itemId) ? rawService.itemId : null;
    service = { npcId, serviceId, itemId };
  }
  // THE SERVICE-VERB BACKSTOP IS GONE (r8 regex audit). It re-routed any `sell` whose RAW LINE
  // contained sharpen/hone/dress/repair/… to `service`, and "dress" is an ordinary noun: "I sell the
  // dress to Brann." matched, the sale became an appraisal, and the player was charged the service
  // fee for a garment they meant to sell (reproduced against the shipped regex). The backstop was
  // reading open-ended prose to override the classifier's own answer about the same sentence — and
  // the prompt already carries an explicit, worked sell-vs-service section (see
  // CLASSIFIER_SYSTEM_PROMPT: "SELLING is ONLY parting with goods FOR COIN, stated as such … Handing
  // an item over for WORK to be done ON it … is kind \"service\", NEVER trade with direction
  // \"sell\""), so the model is already told the exact distinction the regex was second-guessing.

  // The work payload must name an opportunity on offer HERE. A NON-null id that doesn't match
  // drops the payload (and the kind, below) → freeform, so a hallucinated job never mints coin.
  // A NULL id with the kind committed (a bare "work") defaults to the obvious shift: the only
  // offer, or the lowest-DC one when several are posted (the same "clearest" default the work
  // inquiry answers with) — live r4-C typed the canonical verb twice and got flavor prose.
  const workOffers = ctx.workOpportunities ?? [];
  const rawWork = parsed.work ?? null;
  let work: TurnPlan["work"] = null;
  if (rawWork) {
    const defaultOffer = [...workOffers].sort(
      (a, b) => (a.dc ?? Number.POSITIVE_INFINITY) - (b.dc ?? Number.POSITIVE_INFINITY),
    )[0];
    const opportunityId = rawWork.opportunityId
      ? workOffers.some((w) => w.id === rawWork.opportunityId)
        ? rawWork.opportunityId
        : null
      : (defaultOffer?.id ?? null);
    if (opportunityId) work = { opportunityId };
  }

  const interactionOffers = ctx.locationInteractions ?? [];
  const interactionIds = new Set(interactionOffers.map((i) => i.id));
  const rawInteraction = parsed.interaction ?? null;
  const interaction =
    rawInteraction?.interactionId && interactionIds.has(rawInteraction.interactionId)
      ? { interactionId: rawInteraction.interactionId }
      : null;

  // The party payload's target must be a PRESENT entity for invite/appoint (a hallucinated id
  // drops the payload); "leave" needs none (a full leave) but MAY name a present member being
  // dismissed singly — an ungrounded one degrades to the full-leave null, the pre-dismissal
  // shape. A null appoint target is the player taking the lead themselves. Kind-level
  // npc/membership checks live in the engine's resolution.
  const rawParty = parsed.party ?? null;
  let party: TurnPlan["party"] = null;
  if (rawParty) {
    if (rawParty.verb === "leave") {
      party = {
        verb: "leave",
        targetId: rawParty.targetId && presentIds.has(rawParty.targetId) ? rawParty.targetId : null,
      };
    } else if (rawParty.targetId && presentIds.has(rawParty.targetId)) {
      party = { verb: rawParty.verb, targetId: rawParty.targetId };
    } else if (rawParty.verb === "appointLeader" && !rawParty.targetId) {
      party = { verb: "appointLeader", targetId: null };
    }
  }

  // The errand payload (r5). The RUNNER must be present — you can only send someone standing in
  // front of you. The subject/destination ground against ERRAND_TARGETS, which deliberately
  // includes people the world has merely NAMED: that is the entire point of the feature, and a
  // pool built only from met-and-seen NPCs would exclude exactly the lead the player was just
  // handed. Nothing grounds ⇒ the payload drops (and the kind, below).
  const errandNpcIds = new Set((ctx.errandTargets?.npcs ?? []).map((n) => n.id));
  const errandPlaceIds = new Set((ctx.errandTargets?.places ?? []).map((p) => p.id));
  const rawErrand = parsed.errand ?? null;
  let errand: TurnPlan["errand"] = null;
  if (rawErrand && rawErrand.runnerId && presentIds.has(rawErrand.runnerId)) {
    const subjectId = rawErrand.subjectId && errandNpcIds.has(rawErrand.subjectId) ? rawErrand.subjectId : null;
    const destinationId =
      rawErrand.destinationId && errandPlaceIds.has(rawErrand.destinationId) ? rawErrand.destinationId : null;
    const needsSubject = rawErrand.verb === "ask" || rawErrand.verb === "bring";
    const anchored = needsSubject ? subjectId !== null : destinationId !== null;
    if (anchored) {
      errand = {
        verb: rawErrand.verb,
        runnerId: rawErrand.runnerId,
        subjectId,
        destinationId,
        itemId: rawErrand.itemId ?? null,
        topic: rawErrand.topic ?? "",
      };
    }
  }

  // The quest payload must name a quest currently ON OFFER — a hallucinated/stale id is dropped,
  // then repaired to the single offered quest when there is exactly one (the model clearly meant
  // the only offer on the table). Nothing grounds ⇒ the payload drops (and the kind, below).
  const offeredQuests = ctx.offeredQuests ?? [];
  const offeredIds = new Set(offeredQuests.map((q) => q.id));
  const rawQuest = parsed.quest ?? null;
  let quest: TurnPlan["quest"] = null;
  if (rawQuest) {
    const questId =
      rawQuest.questId && offeredIds.has(rawQuest.questId)
        ? rawQuest.questId
        : offeredQuests.length === 1
          ? offeredQuests[0]!.id
          : null;
    if (questId) quest = { verb: rawQuest.verb, questId };
  }

  // The case payload (mystery wave). Ground the suspect against the active case's SUSPECTS (present
  // NPCs) and the cited facts against the player's ESTABLISHED facts. `accuse` needs a named suspect;
  // `present` needs a suspect AND ≥1 known fact. An ungrounded payload drops (and the kind, below).
  // `caseId` is engine-owned, filled from the active-case context.
  const activeCase = ctx.activeCase;
  const suspectIds = new Set((activeCase?.suspects ?? []).map((s) => s.id));
  const knownFactIds = new Set((activeCase?.knownFacts ?? []).map((f) => f.id));
  const rawCase = parsed.case ?? null;
  let caseAction: TurnPlan["case"] = null;
  if (rawCase && activeCase) {
    const suspectId = rawCase.suspectId && suspectIds.has(rawCase.suspectId) ? rawCase.suspectId : null;
    const factIds = rawCase.factIds.filter((id) => knownFactIds.has(id));
    if (rawCase.verb === "accuse" && suspectId) {
      caseAction = { verb: "accuse", suspectId, factIds, caseId: activeCase.caseId };
    } else if (rawCase.verb === "present" && suspectId && factIds.length > 0) {
      caseAction = { verb: "present", suspectId, factIds, caseId: activeCase.caseId };
    }
  }

  // Case claims (mystery lie/credibility side-channel) — ground each against the player's ESTABLISHED
  // facts (same surface as `present`; the player can only assert/deny what they actually know) and fill
  // the engine-owned caseId from the active case. Ride ONLY a `dialogueToNpc` line (a claim needs an
  // addressed NPC); capped so a runaway list can't spam the ledger. Ungrounded ⇒ silently dropped.
  const caseClaims: NonNullable<TurnPlan["caseClaims"]> = [];
  if (activeCase && parsed.kind === "dialogueToNpc") {
    for (const raw of parsed.caseClaims ?? []) {
      if (caseClaims.length >= 3) break;
      if (knownFactIds.has(raw.factId)) {
        caseClaims.push({ factId: raw.factId, stance: raw.stance, caseId: activeCase.caseId });
      }
    }
  }

  // An item action grounded to no carried item has nothing to act on — same for a trade/party/quest.
  // A movement whose id didn't ground is DIFFERENT: it STAYS `movement` and is FLAGGED (movementMiss)
  // so the engine REACHES the named place — reuse an existing/known location, realize a gazetteer
  // entry, or generate a fresh pocket on the fly — then actually moves the party (2026-07-06: the
  // old honest-refusal downgrade let the narrator invent an ungrounded journey, desyncing state).
  const movementMiss = parsed.kind === "movement" && !dest;
  let kind = parsed.kind;
  // SETTLE-THEN-MOVE (§2.4 / r11 F-11). The walk half survives ONLY when the settle half is one of
  // the kinds a later turn cannot recover for you — a taken quest, a closed trade, a party change, a
  // dialogue line that actually moved goods — AND the destination grounds to a real EXIT of the room
  // the player is standing in. Everything else (an ungrounded name, a reach, a frontier, a plan for
  // tomorrow, a freeform line the narrator already sees whole) drops back to the honest
  // `droppedIntent` note. Narrow by construction: this is not a general two-action machine.
  const SETTLE_KINDS = new Set(["questAction", "trade", "partyAction", "dialogueToNpc"]);
  const secondaryMove = ((): { destinationLocationId: string; destinationName: string | null } | null => {
    const raw = parsed.secondaryMove;
    if (!raw || parsed.kind === "movement" || !SETTLE_KINDS.has(parsed.kind)) return null;
    const to = matchExit(raw.destinationLocationId, "", ctx.exits, ctx.locationId, raw.destinationName);
    if (!to || to === ctx.locationId) return null;
    return { destinationLocationId: to, destinationName: (raw.destinationName ?? "").trim() || null };
  })();
  // `tradeBatch` is typed-action-only (a caller builds it directly, bypassing this
  // function). A model that emits it from typed language gets the browse it meant: the counter
  // opens, nothing silently executes.
  if (kind === "tradeBatch") {
    kind = "trade";
    if (!trade && vendors.length === 1) trade = { direction: "buy", itemId: null, vendorId: vendors[0]!.id };
  }
  if (kind === "itemAction" && !item) kind = "freeformNarrative";
  if (kind === "cast" && !cast) kind = "freeformNarrative";
  if (kind === "learn" && !learn) kind = "freeformNarrative";
  if (kind === "clothing" && !clothing) kind = "freeformNarrative";
  // "trade" deliberately SURVIVES an ungrounded payload (unlike its siblings): the engine answers
  // with an honest deterministic refusal ("no merchant is at hand here"), whereas the freeform
  // downgrade let the narrator invent a vendor and a completed deal that contradicted the sheet
  // (live r4-C). A null payload can mint nothing — resolveTrade applies no command without one.
  if (kind === "work" && !work) kind = "freeformNarrative";
  if (kind === "locationInteraction" && !interaction) kind = "freeformNarrative";
  if (kind === "partyAction" && !party) kind = "freeformNarrative";
  if (kind === "errand" && !errand) kind = "freeformNarrative";
  if (kind === "questAction" && !quest) kind = "freeformNarrative";
  if (kind === "caseAction" && !caseAction) kind = "freeformNarrative";

  const check =
    kind === "attemptRequiringCheck"
      ? {
          warranted: true,
          ability: parsed.check.ability ?? ("wis" as CheckAbility),
          skill: parsed.check.skill,
          dc: clamp(parsed.check.dc ?? DEFAULT_DC, 5, 30),
          reason: parsed.check.reason,
          purpose: parsed.check.purpose ?? null,
        }
      : {
          warranted: false,
          ability: null,
          skill: null,
          dc: null,
          reason: parsed.check.reason,
          purpose: null,
        };

  // The clean place name the player named — the model's own field first, then its id-guess as a
  // fallback title (never a regex over rawInput). Carried on EVERY movement so the engine's
  // open-world reach can title a generated destination (or match an existing/known place) whenever
  // the id didn't ground. Null for non-movement.
  const reachName =
    kind === "movement"
      ? (parsed.destinationName ?? "").trim() || (parsed.destinationLocationId ?? "").trim() || null
      : null;

  // Ground the impact's victimId against present entities (null if absent) — the same discipline as
  // targetId, so a consequence can never land on a hallucinated actor. domain/severity are the model's
  // read; a neutral `none` (the default, and what every scripted stub yields) earns no consequence.
  const rawImpact = parsed.impact;
  const impact = {
    domain: rawImpact?.domain ?? ("none" as const),
    severity: rawImpact?.severity ?? ("none" as const),
    victimId: rawImpact?.victimId && presentIds.has(rawImpact.victimId) ? rawImpact.victimId : null,
  };

  // Ground the physical side-effect proposals (the grounded-freeform channel). Each effect either
  // grounds fully against the world — a sane positive copper amount, a carried item, a floor item,
  // a present recipient — or is DROPPED; a proposal set that grounds to nothing marks the plan
  // `effectsDropped` so the engine can say honestly that nothing changed hands. Only the freeform/
  // dialogue kinds carry effects (other kinds already have their own mechanical channel), and the
  // count is capped so a runaway proposal list can never spam the reducer.
  // `questAction` carries them too (r5 P2, live-reproduced): the salvage clerk's fee was paid in the
  // SAME sentence that took the contract — "I count five silver onto the counter for the bond" — and
  // because the accept outranked the transfer, the fee that made the contract binding cost nothing.
  // `attemptRequiringCheck` is the same shape once more (r14, fixture-travel t8, live): "I fling a fistful
  // of copper at the revenant's eyes and break for the door" is a declared maneuver whose success is
  // uncertain, so the CHECK outranked the transfer — the narrator wrote "the coppers leave your hand
  // in a scatter" and the purse read 150 before and 150 after. Parting with property under a roll (a
  // bribe slipped while sneaking past, coins thrown as a distraction, a thing shoved into someone's
  // hands mid-scramble) is still parting with it; the check decides whether the ACT works, never
  // whether the property moved.
  const rawEffects =
    kind === "freeformNarrative" ||
    kind === "dialogueToNpc" ||
    kind === "questAction" ||
    kind === "attemptRequiringCheck"
      ? (parsed.effects ?? [])
      : [];
  const effects: NonNullable<TurnPlan["effects"]> = [];
  let effectsDropped = false;
  let coinsDropped = false;
  for (const eff of rawEffects) {
    if (effects.length >= 3) break;
    if (eff.type === "spendCoins") {
      const amount =
        typeof eff.amountCp === "number" && Number.isSafeInteger(eff.amountCp) && eff.amountCp > 0
          ? Math.min(eff.amountCp, 100_000)
          : null;
      // r11 P1 — a QUESTION never pays. Live: "I ask Sergeant Veil if she'll take my extra ration
      // for three copper." classified `dialogueToNpc`, so the trade rail's inquiry gate was never
      // consulted, and this channel lifted the number straight out of the sentence — the player
      // OFFERED to sell and was charged 3 cp for nothing. The number in an asked line is the price
      // being discussed, not a payment being made.
      if (amount && isAskedNotCommitted(rawInput)) {
        effectsDropped = true;
        continue;
      }
      if (amount) {
        // The payee is the NPC being ADDRESSED, not the most salient roster name (r6 P3: a bond
        // paid to a prose clerk three fictional blocks away was credited to Sergeant Veil because
        // the classifier had to copy SOME present id). Prefer the plan's own target; fall back to
        // the model's proposal only when it grounds; otherwise leave it unowned — never reassign
        // a payment to a bystander.
        const addressed = parsed.targetId && presentIds.has(parsed.targetId) ? parsed.targetId : null;
        let proposed = eff.toNpcId && presentIds.has(eff.toNpcId) ? eff.toNpcId : null;
        // A payment the model routed to a party COMPANION the line never names is the r7 tip bug
        // ("I leave two silver on the crate beside the cup" — Pellam's room — paid Oda): the money
        // was for the person the scene is about, and copying the most salient roster id landed it
        // on the bystander. Unowned beats mis-owned: the coins still leave the purse, nobody is
        // falsely credited. An ADDRESSED companion (the player talking to them) still gets paid.
        if (!addressed && proposed && (ctx.companionIds ?? []).includes(proposed)) {
          const name = ctx.presentEntities.find((e) => e.id === proposed)?.name ?? "";
          // The naive per-token containment this used to hand-roll defeated the guard on exactly
          // the companion it was written for: "Oda the Wayfarer" yields the token "the", so the r7
          // repro line ("I leave two silver on the crate beside the cup") named him after all and
          // the tip landed on the bystander again. It only ever worked for companions whose display
          // name happens to carry no article. `rawInput` is player-typed, so no capital is required
          // (`uncased`) — but not `player-query` either: this guard decides who gets PAID, and a
          // wrong hit here is the r7 tip bug itself. The strict surface is the one that keeps the
          // money unowned rather than mis-owned.
          const namedInLine = name.trim().length > 0 && nameMentionedIn(rawInput, name, { surface: "uncased" });
          if (!namedInLine) proposed = null;
        }
        effects.push({
          type: "spendCoins",
          amountCp: amount,
          itemId: null,
          toNpcId: addressed ?? proposed,
        });
      } else {
        effectsDropped = true;
        coinsDropped = true;
      }
    } else if (eff.type === "giveItem") {
      if (eff.itemId && carriedIds.has(eff.itemId) && eff.toNpcId && presentIds.has(eff.toNpcId)) {
        effects.push({
          type: "giveItem",
          amountCp: null,
          itemId: eff.itemId,
          toNpcId: eff.toNpcId,
          // A stated multi-unit part-with ("all four rations") rides through; the engine caps by
          // the real stack at resolve. 1/absent stays absent — pre-quantity literals unchanged.
          ...(Number.isInteger(eff.quantity) && (eff.quantity as number) > 1 ? { quantity: Math.min(99, eff.quantity as number) } : {}),
        });
      } else effectsDropped = true;
    } else if (eff.type === "dropItem") {
      if (eff.itemId && carriedIds.has(eff.itemId)) {
        effects.push({
          type: "dropItem",
          amountCp: null,
          itemId: eff.itemId,
          toNpcId: null,
          ...(Number.isInteger(eff.quantity) && (eff.quantity as number) > 1 ? { quantity: Math.min(99, eff.quantity as number) } : {}),
        });
      } else effectsDropped = true;
    } else if (eff.type === "pickupItem") {
      if (eff.itemId && floorIds.has(eff.itemId)) {
        effects.push({ type: "pickupItem", amountCp: null, itemId: eff.itemId, toNpcId: null });
      } else effectsDropped = true;
    } else if (eff.type === "acceptItem") {
      // NPC → PC hand-over (playtest V1: the effects channel was strictly PC-outbound, so "she ties
      // her ribbon on your wrist" grounded to NOTHING). The giver must be PRESENT; the item id is a
      // free proposal (the object usually exists only in prose) normalized to a stable slug the
      // engine conjures — `transferItem {from: null}` is the established quest-reward precedent.
      // r5 P2: the same channel with NO giver is how a prose-born object on a counter or a stair
      // becomes real ("I fold Veil's sealed note into my coat" moved nothing, and the note was
      // never producible again). The engine still refuses to mint anything the recent prose did
      // not actually put in the scene.
      const slug = slugItemId(eff.itemId);
      const giver = eff.toNpcId && presentIds.has(eff.toNpcId) ? eff.toNpcId : null;
      if (slug && (giver || !eff.toNpcId)) {
        effects.push({
          type: "acceptItem",
          amountCp: null,
          itemId: slug,
          toNpcId: giver,
        });
      } else effectsDropped = true;
    } else if (eff.type === "makeDeal") {
      // §2.2 — terms settled aloud become a standing row. Grounding is the same rule the physical
      // effects follow: the counterparty must be PRESENT (a bargain is struck with someone in the
      // room), and terms that survive normalization to nothing ground to nothing.
      const terms = (eff.terms ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      const other = eff.toNpcId && presentIds.has(eff.toNpcId) ? eff.toNpcId : null;
      if (terms && other) {
        effects.push({ type: "makeDeal", amountCp: null, itemId: null, toNpcId: other, terms });
      } else effectsDropped = true;
    } else if (eff.type === "dealAction") {
      // Honour/break reported by the classifier. WHICH deal is code's call (the engine picks the
      // most recent open one with this party) — the model never names a row id.
      const other = eff.toNpcId && presentIds.has(eff.toNpcId) ? eff.toNpcId : null;
      const dealState = eff.dealState === "honoured" || eff.dealState === "broken" ? eff.dealState : null;
      if (dealState) {
        effects.push({ type: "dealAction", amountCp: null, itemId: null, toNpcId: other, dealState });
      } else effectsDropped = true;
    }
  }

  return {
    kind,
    targetId,
    // Carried ONLY when a dialogue addressee stayed unbound — the engine's phantom-absence line
    // consumes it; omit-when-bound/absent keeps every other plan byte-identical (r13).
    ...(kind === "dialogueToNpc" && targetId === null && spokenName ? { targetName: spokenName } : {}),
    destinationLocationId: dest,
    destinationName: reachName,
    check,
    impact,
    ...(kind === "itemAction" && item ? { item } : {}),
    ...(kind === "cast" && cast ? { cast } : {}),
    ...(kind === "learn" && learn ? { learn } : {}),
    ...(kind === "clothing" && clothing ? { clothing } : {}),
    ...(kind === "trade" && trade ? { trade } : {}),
    ...(kind === "service" && service ? { service } : {}),
    ...(kind === "work" && work ? { work } : {}),
    ...(kind === "locationInteraction" && interaction ? { interaction } : {}),
    ...(kind === "partyAction" && party ? { party } : {}),
    ...(kind === "errand" && errand ? { errand } : {}),
    ...(kind === "questAction" && quest ? { quest } : {}),
    ...(kind === "caseAction" && caseAction ? { case: caseAction } : {}),
    // A rented bed may name a tier off the board, or none — the engine picks the cheapest affordable
    // when `tierId` is null, so an ungrounded `rentRoom` still resolves rather than degrading.
    ...(kind === "rentRoom" ? { lodging: { tierId: parsed.lodging?.tierId ?? null } } : {}),
    // "Sleep" and "get up" are opposite intents sharing one kind — carry which one the line meant
    // (r9 F-13: an explicit sleep at dusk used to fall to the clock fallback and RISE).
    ...(kind === "wakeInRoom" ? { wake: { intent: parsed.wake?.intent ?? null } } : {}),
    // §2.4 honest drop — carried only when the model actually named a dropped half, and never on
    // freeform (the narrator sees the whole line there; nothing is silently lost). Length-capped:
    // this is a ledger note, not a second prompt.
    ...(kind !== "freeformNarrative" && (parsed.droppedIntent ?? "").trim()
      ? { droppedIntent: (parsed.droppedIntent ?? "").trim().slice(0, 120) }
      : {}),
    ...(secondaryMove ? { secondaryMove } : {}),
    ...(caseClaims.length > 0 ? { caseClaims } : {}),
    ...(movementMiss ? { movementMiss: true } : {}),
    ...(effects.length > 0 ? { effects } : {}),
    ...(effectsDropped && effects.length === 0 ? { effectsDropped: true } : {}),
    ...(coinsDropped ? { coinsDropped: true } : {}),
    // "I go alone" — a solo travel flag; meaningful on any movement, grounded or reached.
    ...(kind === "movement" && parsed.solo ? { solo: true } : {}),
    // The closed answer fields (r8 regex audit). Each rides through UNGROUNDED — they name a
    // category, never an id, so there is nothing to ground them against; the enums in
    // `TurnPlanSchema` are the whole validation, and anything outside them was already rejected by
    // the parse above. Omit-when-null so a plan without them is byte-identical to a pre-r8 plan and
    // every reader falls to its documented safe default.
    ...(parsed.pressureAnswer ? { pressureAnswer: parsed.pressureAnswer } : {}),
    ...(parsed.socialAsk ? { socialAsk: parsed.socialAsk } : {}),
    ...(parsed.speechAct ? { speechAct: parsed.speechAct } : {}),
    ...(parsed.proposalAnswer ? { proposalAnswer: parsed.proposalAnswer } : {}),
    ...(parsed.captivityAction ? { captivityAction: parsed.captivityAction } : {}),
    ...(parsed.escapeAbility ? { escapeAbility: parsed.escapeAbility } : {}),
    // Only "whereabouts" is worth carrying: "other" IS the absent default at the one reader, and
    // omitting it keeps an ordinary spoken turn's plan byte-identical to a pre-r8 one.
    ...(parsed.dialogueAsk === "whereabouts" ? { dialogueAsk: "whereabouts" as const } : {}),
    // The knowledge frame rides through with its subject grounded or dropped: the id must be one
    // the context actually offered (present, known-absent, or an exit) — the classifier can frame
    // a question, never mint an entity. Omit-when-null keeps ordinary plans byte-identical.
    ...(parsed.knowledgeAsk
      ? {
          knowledgeAsk: {
            kind: parsed.knowledgeAsk.kind,
            timeframe: parsed.knowledgeAsk.timeframe,
            locality: parsed.knowledgeAsk.locality,
            subjectId: groundKnowledgeSubject(parsed.knowledgeAsk.subjectId, ctx),
          },
        }
      : {}),
    confidence: parsed.confidence,
  };
}

/** A knowledgeAsk subject must be an id the context offered; anything else grounds to null. */
function groundKnowledgeSubject(subjectId: string | null | undefined, ctx: ClassifierContext): string | null {
  if (!subjectId) return null;
  const pool = new Set([
    ...ctx.presentEntities.map((e) => e.id),
    ...(ctx.knownAbsentNpcs ?? []).map((e) => e.id),
    ...ctx.exits.map((e) => e.id),
  ]);
  return pool.has(subjectId) ? subjectId : null;
}

/**
 * Normalize an acceptItem proposal's free-form item reference ("grey ribbon", "Grey Ribbon",
 * "item.grey-ribbon") to a stable `item.*` slug the engine can conjure and later match on discard.
 * Pure string normalization — NOT an intent heuristic; the LLM decided the intent, this only shapes
 * the id. Null when nothing id-worthy survives.
 */
function slugItemId(raw: string | null | undefined): string | null {
  const body = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^(item|weapon|armor|apparel)\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!body) return null;
  const prefix = (raw ?? "").trim().toLowerCase().match(/^(weapon|armor|apparel)\./)?.[1] ?? "item";
  return `${prefix}.${body}`;
}

/** Extract the first balanced JSON object from a model response (tolerates fences/prose). */
function extractJson(s: string): string {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence?.[1] ?? s;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON object in classifier output");
  return body.slice(start, end + 1);
}

export function buildClassifyUserMessage(text: string, ctx: ClassifierContext): string {
  const exits = ctx.exits.map((e) => `${e.id}=${e.name}`).join(", ") || "(none)";
  // Mark present entities already travelling with the player. The classifier needs this to branch
  // the FOLLOW direction: falling in with a NON-party NPC who is guiding you is an invite (they must
  // agree to travel with you first), whereas following a companion already "(in your party)" is just
  // movement/flavor — no re-invite. companionIds is present-scoped in buildClassifierContext.
  const companionSet = new Set(ctx.companionIds ?? []);
  const present =
    ctx.presentEntities
      .map((e) => `${e.id}=${e.name}${companionSet.has(e.id) ? " (in your party)" : ""}`)
      .join(", ") || "(none)";
  const carried = (ctx.carriedItems ?? []).map((i) => `${i.id}=${i.name}`).join(", ") || "(none)";
  const floor = (ctx.floorItems ?? []).map((i) => `${i.id}=${i.name}`).join(", ");
  const spells = (ctx.knownSpells ?? []).map((s) => `${s.id}=${s.name}`).join(", ") || "(none)";
  const learnable =
    (ctx.learnableSpells ?? [])
      .map((l) => `${l.id}=${l.name} (${l.source}${l.sourceId ? ` via ${l.sourceId}` : ""}${l.costCoins ? `, ${l.costCoins}cp` : ""})`)
      .join(", ") || "(none)";
  const vendors =
    (ctx.vendors ?? [])
      .map(
        (v) =>
          `${v.id}=${v.name} stocking [${v.stock.map((i) => `${i.id}=${i.name}`).join(", ")}]${
            v.services && v.services.length > 0
              ? ` services [${v.services.map((s) => `${s.id}=${s.name}`).join(", ")}]`
              : ""
          }${
            // §2.1 — wares this vendor priced ALOUD but does not stock. Named, not id'd, because the
            // name is what they said; the resolver matches the player's ask back against it.
            v.offers && v.offers.length > 0
              ? ` offered aloud [${v.offers.map((o) => `"${o.name}" (${o.priceCp}cp)`).join(", ")}]`
              : ""
          }`,
      )
      .join("; ") || "(none)";
  const offered = (ctx.offeredQuests ?? []).map((q) => `${q.id}=${q.name}`).join(", ") || "(none)";
  const established = (ctx.establishedFacts ?? []).map((f) => `${f.id}=${f.name}`).join("; ");
  const knownAbsent = (ctx.knownAbsentNpcs ?? []).map((n) => `${n.id}=${n.name}`).join(", ");
  const errandNpcs = (ctx.errandTargets?.npcs ?? []).map((n) => `${n.id}=${n.name}`).join(", ");
  const errandPlaces = (ctx.errandTargets?.places ?? []).map((p) => `${p.id}=${p.name}`).join(", ");
  const activeCase = ctx.activeCase
    ? `${ctx.activeCase.caseId} suspects=[${ctx.activeCase.suspects.map((s) => `${s.id}=${s.name}`).join(", ")}] known_facts=[${ctx.activeCase.knownFacts.map((f) => `${f.id}=${f.name}`).join("; ")}]`
    : "";
  const work =
    (ctx.workOpportunities ?? [])
      .map(
        (w) =>
          `${w.id}=${w.label}${w.wageCp !== undefined ? ` (${w.wageCp}cp${w.ability ? `, ${w.ability}` : ""}${w.dc !== undefined ? ` DC${w.dc}` : ""})` : ""}`,
      )
      .join(", ") || "(none)";
  const interactions =
    (ctx.locationInteractions ?? []).map((i) => `${i.id}=${i.label} (${i.kind})`).join(", ") || "(none)";
  return [
    `PLAYER_INPUT: ${text}`,
    `LOCATION: ${ctx.locationId} "${ctx.locationName}"`,
    // Omit-when-not-abed, so every ordinary turn keeps a byte-identical prompt.
    ...(ctx.abed ? ["BODY_STATE: ABED — the player is in a rented bed and has not left the room."] : []),
    // The r8 situational flags. Each one arms exactly one closed answer field, and each is
    // omit-when-absent for the same reason `abed` is: an ordinary turn's message is byte-identical.
    ...(ctx.captive ? ["BODY_STATE: CAPTIVE — the player is being held; this turn is a captivity action."] : []),
    ...(ctx.inCombat ? ["COMBAT: ACTIVE — a fight is under way right now."] : []),
    ...(ctx.routinesKnown
      ? ["ROUTINES: KNOWN — people here keep habits a local could describe, so a spoken line may be ASKING WHERE SOMEBODY IS."]
      : []),
    ...(ctx.factsKnown
      ? ["WORLD_FACTS: KNOWN — this world tracks current and historical truth separately, so a spoken question carries a knowledgeAsk frame."]
      : []),
    ...(ctx.pendingDemand
      ? [`PENDING_DEMAND: ${ctx.pendingDemand.npcName} ${ctx.pendingDemand.summary} — the player's line answers this.`]
      : []),
    ...(ctx.pendingProposal
      ? [`PENDING_PROPOSAL: ${ctx.pendingProposal.npcName} proposed: "${ctx.pendingProposal.text}" — the player's line may answer it.`]
      : []),
    `EXITS: ${exits}`,
    // Omit-when-empty: far-but-known travel referents (r9 F-5's classifier face). Names only for
    // the model's benefit — ids here never ground destinationLocationId (EXITS-only rule holds).
    ...((ctx.knownPlaces ?? []).length > 0
      ? [`KNOWN_PLACES (farther off — reachable by road, travel is a journey): ${ctx.knownPlaces!.map((p) => `${p.id}=${p.name}`).join(", ")}`]
      : []),
    `PRESENT_ENTITIES: ${present}`,
    `CARRIED_ITEMS: ${carried}`,
    // Omit-when-empty: most floors are bare, and an absent line keeps the prompt byte-identical.
    ...(floor ? [`FLOOR_ITEMS: ${floor}`] : []),
    `SPELLS: ${spells}`,
    `LEARNABLE: ${learnable}`,
    `VENDORS: ${vendors}`,
    `WORK: ${work}`,
    `INTERACTIONS: ${interactions}`,
    `OFFERED_QUESTS: ${offered}`,
    // Omit-when-empty: a player who has taken nothing adds no line, so the prompt stays byte-identical.
    ...(established ? [`ESTABLISHED_FACTS: ${established}`] : []),
    // Omit-when-empty: no active case ⇒ no line, so caseless play keeps a byte-identical prompt.
    ...(activeCase ? [`ACTIVE_CASE: ${activeCase}`] : []),
    // Omit-when-empty for the same reason. NOT addressable — see the schema note on `targetId`.
    ...(knownAbsent ? [`KNOWN_ABSENT: ${knownAbsent}`] : []),
    // The only legal `errand` subject/destination ids. Omit-when-empty.
    ...(errandNpcs || errandPlaces ? [`ERRAND_TARGETS: people=[${errandNpcs}] places=[${errandPlaces}]`] : []),
    // Scene-narrowed variant (#4): ordinary turns embed THE full schema object — byte-identical
    // prompt; a scene turn embeds the same schema with `kind.enum` cut to what the scene affords.
    `SCHEMA: ${JSON.stringify(schemaForContext(ctx))}`,
    `Respond with one JSON object only.`,
  ].join("\n");
}

/**
 * LLM-backed classifier: utility model → validate/repair → freeform as the last-resort floor.
 * One transparent retry absorbs transient model errors; if both attempts fail the line goes to
 * the narrator whole as freeformNarrative — never through pattern-matching (regex guessed
 * players' dynamic phrasing wrong too often to be a fallback). Every fallback is reported
 * through `onFallback` so it shows up in logs instead of masquerading as a model decision.
 */
export function makeLlmClassifier(
  gateway: LlmGateway,
  onFallback?: (reason: string) => void,
): TurnClassifier {
  return {
    async classify(text, ctx) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await gateway.complete("utility", {
            messages: [
              { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
              { role: "user", content: buildClassifyUserMessage(text, ctx) },
            ],
            temperature: 0,
            json: true,
          });
          return reconcilePlan(JSON.parse(extractJson(res.text)), ctx, text);
        } catch (err) {
          lastError = err;
        }
      }
      try {
        onFallback?.(lastError instanceof Error ? lastError.message : String(lastError));
      } catch {
        // telemetry must never break a turn
      }
      return freeformPlan();
    },
  };
}

export const TURN_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "targetId", "targetName", "destinationLocationId", "destinationName", "check", "item", "cast", "learn", "clothing", "trade", "work", "interaction", "party", "quest", "confidence"],
  properties: {
    kind: {
      type: "string",
      // The day-rolling kinds (`enterCamp`/`endDay`/`rentRoom`/`wakeInRoom`) were MISSING from this
      // enum, and the schema is embedded verbatim in the classifier prompt — so the model could
      // never emit them, and `resolveEndDay`/`resolveWakeInRoom` (the ONLY two paths that cross a
      // 1440-minute boundary) were unreachable from typed language. "I sleep the night at the inn"
      // collapsed into `rest`, an hour's breather that explicitly does not roll the day. That is why
      // the 2026-07-24 playtest sat on "day 1" through two in-fiction nights — and why everything
      // keyed on the DAY (upkeep settlement, routine-override expiry, npc-event cooldowns) was inert.
      enum: ["dialogueToNpc", "movement", "attemptRequiringCheck", "attack", "rest", "enterCamp", "endDay", "rentRoom", "wakeInRoom", "hireMercenary", "itemAction", "cast", "learn", "clothing", "trade", "tradeBatch", "service", "work", "workInquiry", "locationInteraction", "partyAction", "questAction", "caseAction", "errand", "freeformNarrative", "metaOOC"],
    },
    lodging: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["tierId"],
      properties: {
        tierId: { type: ["string", "null"] },
      },
    },
    wake: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["intent"],
      properties: {
        intent: { type: ["string", "null"], enum: ["sleep", "rise", null] },
      },
    },
    droppedIntent: { type: ["string", "null"] },
    secondaryMove: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["destinationLocationId", "destinationName"],
      properties: {
        destinationLocationId: { type: ["string", "null"] },
        destinationName: { type: ["string", "null"] },
      },
    },
    targetId: { type: ["string", "null"] },
    targetName: { type: ["string", "null"] },
    destinationLocationId: { type: ["string", "null"] },
    destinationName: { type: ["string", "null"] },
    solo: { type: "boolean" },
    item: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["verb", "itemId", "targetId"],
      properties: {
        verb: { type: "string", enum: ["equip", "unequip", "use", "give", "read", "drop", "pickup"] },
        itemId: { type: ["string", "null"] },
        targetId: { type: ["string", "null"] },
      },
    },
    cast: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["spellId", "targetId"],
      properties: {
        spellId: { type: ["string", "null"] },
        targetId: { type: ["string", "null"] },
      },
    },
    learn: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["spellId", "source", "sourceId"],
      properties: {
        spellId: { type: ["string", "null"] },
        source: { enum: ["study", "trainer", "scroll", null] },
        sourceId: { type: ["string", "null"] },
      },
    },
    clothing: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["slot", "state"],
      properties: {
        slot: {
          type: "string",
          enum: ["head", "face", "neck", "over-upper", "upper", "under-upper", "hands", "over-lower", "lower", "under-lower", "feet", "all"],
        },
        state: { type: "string", enum: ["worn", "displaced", "removed"] },
      },
    },
    trade: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["direction", "itemId", "vendorId", "quantity", "inquiry", "itemWords", "vendorWords"],
      properties: {
        direction: { type: "string", enum: ["buy", "sell"] },
        itemId: { type: ["string", "null"] },
        vendorId: { type: ["string", "null"] },
        quantity: { type: ["integer", "null"] },
        inquiry: { type: ["boolean", "null"] },
        itemWords: { type: ["string", "null"] },
        vendorWords: { type: ["string", "null"] },
      },
    },
    service: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["npcId", "serviceId", "itemId"],
      properties: {
        npcId: { type: ["string", "null"] },
        serviceId: { type: ["string", "null"] },
        itemId: { type: ["string", "null"] },
      },
    },
    work: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["opportunityId"],
      properties: {
        opportunityId: { type: ["string", "null"] },
      },
    },
    interaction: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["interactionId"],
      properties: {
        interactionId: { type: ["string", "null"] },
      },
    },
    party: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["verb", "targetId"],
      properties: {
        verb: { type: "string", enum: ["invite", "leave", "appointLeader", "join"] },
        targetId: { type: ["string", "null"] },
      },
    },
    errand: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["verb", "runnerId", "subjectId", "destinationId", "itemId", "topic"],
      properties: {
        verb: { type: "string", enum: ["ask", "bring", "scout", "fetch"] },
        runnerId: { type: ["string", "null"] },
        subjectId: { type: ["string", "null"] },
        destinationId: { type: ["string", "null"] },
        itemId: { type: ["string", "null"] },
        topic: { type: "string" },
      },
    },
    quest: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["verb", "questId"],
      properties: {
        verb: { type: "string", enum: ["accept", "decline"] },
        questId: { type: ["string", "null"] },
      },
    },
    case: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["verb", "suspectId", "factIds"],
      properties: {
        verb: { type: "string", enum: ["accuse", "present"] },
        suspectId: { type: ["string", "null"] },
        factIds: { type: "array", items: { type: "string" } },
      },
    },
    caseClaims: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["factId", "stance"],
        properties: {
          factId: { type: "string" },
          stance: { type: "string", enum: ["assert", "contradict", "withhold"] },
        },
      },
    },
    check: {
      type: "object",
      additionalProperties: false,
      required: ["warranted", "ability", "skill", "dc", "reason", "purpose"],
      properties: {
        warranted: { type: "boolean" },
        ability: { type: ["string", "null"], enum: ["str", "dex", "con", "int", "wis", "cha", null] },
        skill: { type: ["string", "null"] },
        dc: { type: ["integer", "null"], minimum: 5, maximum: 30 },
        reason: { type: "string" },
        // What the attempt is FOR, in a closed set. Read by the combat module's evasion-calm, which
        // used to keyword-match the model's own free-text `reason` plus the player's line — so a
        // passed ATTACK check ("I throw the table over onto the wight") ended the encounter and
        // durably calmed every foe. The model NAMES the purpose; code still owns the consequence.
        purpose: { type: ["string", "null"], enum: ["disengage", "harm", "other", null] },
      },
    },
    impact: {
      type: "object",
      additionalProperties: false,
      required: ["domain", "severity", "victimId"],
      properties: {
        domain: { type: "string", enum: ["social", "property", "violence", "deception", "none"] },
        severity: { type: "string", enum: ["none", "minor", "serious", "grave"] },
        victimId: { type: ["string", "null"] },
      },
    },
    // --- The closed answer fields (r8 regex audit) ---------------------------------------------
    // Each replaces a regex that read open-ended prose and whose answer became a DELTA. They are
    // SITUATIONAL — the user message only carries the matching context line when the situation is
    // live — so they are deliberately NOT in the top-level `required` list (the `impact`/`effects`
    // precedent): an ordinary turn omits them, they arrive null, and every reader falls to its
    // documented safe default. Code still owns the DC, the refusal, and the mutation.
    pressureAnswer: { type: ["string", "null"], enum: ["comply", "refuse", "neutral", null] },
    socialAsk: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["approach", "kind"],
      properties: {
        approach: { type: "string", enum: ["persuade", "intimidate", "bribe"] },
        kind: {
          type: "string",
          enum: [
            "favor",
            "information",
            "move",
            "surrenderItem",
            "betray",
            "harmInnocent",
            "breakOath",
            "steal",
            "lie",
            "debt",
          ],
        },
      },
    },
    speechAct: { type: ["string", "null"], enum: ["deescalate", "callForAid", "other", null] },
    proposalAnswer: { type: ["string", "null"], enum: ["accept", "decline", "neither", null] },
    captivityAction: { type: ["string", "null"], enum: ["labor", "endure", "escape", null] },
    escapeAbility: { type: ["string", "null"], enum: ["str", "dex", "cha", null] },
    // Not a regex replacement — evidence no regex could supply. "where can i find dray?" and "i
    // hitch the dray and load the crates" are the same word; only the ASK distinguishes the
    // quartermaster from the cart, and the name binder's loosest surface is armed by this alone.
    dialogueAsk: { type: ["string", "null"], enum: ["whereabouts", "other", null] },
    // The knowledge-request frame (epistemic layer). Same posture as dialogueAsk: the frame is
    // evidence about what the LINE ASKS, never a truth decision — code selects the facts.
    knowledgeAsk: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["kind", "timeframe", "locality", "subjectId"],
      properties: {
        kind: {
          type: "string",
          enum: [
            "current-location",
            "current-service",
            "current-status",
            "whereabouts",
            "history",
            "explanation",
            "rumor-opinion",
            "general",
          ],
        },
        timeframe: { type: "string", enum: ["current", "historical", "any"] },
        locality: { type: "string", enum: ["here", "nearby", "region", "world", "unspecified"] },
        subjectId: { type: ["string", "null"] },
      },
    },
    effects: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "amountCp", "itemId", "toNpcId", "quantity", "terms", "dealState"],
        properties: {
          type: {
            type: "string",
            enum: ["spendCoins", "giveItem", "dropItem", "pickupItem", "acceptItem", "makeDeal", "dealAction"],
          },
          amountCp: { type: ["integer", "null"] },
          itemId: { type: ["string", "null"] },
          toNpcId: { type: ["string", "null"] },
          quantity: { type: ["integer", "null"] },
          terms: { type: ["string", "null"] },
          dealState: { type: ["string", "null"], enum: ["honoured", "broken", null] },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

/**
 * Scene-narrowed schema variants (Concordia transfer #4, `NEXT_ACTION_SPEC`).
 *
 * The classifier used to see the same broad kind enum whatever was happening; in combat, an unrelated
 * scene, captivity or a rented bed the plausible action space is a fraction of that, and a whole
 * recurring bug class came from the surplus (the servile-"work" idiom hijacking the economy
 * classifier, question-read-as-travel). The narrowing is STRUCTURAL, not semantic: the scene state
 * comes from the world model (the same flags that already print `COMBAT: ACTIVE` etc. in the user
 * message), the variant only shrinks `kind.enum`, and `reconcilePlan` stays the ONE reconciler
 * validating against the FULL TurnPlanSchema — so a model that answers outside the narrowed enum
 * still reconciles instead of erroring, and no behavior forks downstream. The system prompt is
 * untouched (it is the provider-cache-stable half of the call); only the user message's embedded
 * SCHEMA narrows.
 *
 * Precedence mirrors scene ownership: combat > captivity > abed. Kinds are
 * kept GENEROUS on purpose — a scene lists everything a player could sanely mean in it (parley in
 * combat is dialogue; reaching for a blade mid-scene is itemAction); only the kinds that require a
 * different SITUATION (shopping mid-melee, renting a room from a bed) are cut.
 */
const SCENE_KIND_SETS = {
  combat: [
    "dialogueToNpc", "movement", "attemptRequiringCheck", "attack", "cast",
    "itemAction", "clothing", "partyAction", "freeformNarrative", "metaOOC",
  ],
  captive: [
    "dialogueToNpc", "movement", "attemptRequiringCheck", "attack",
    "itemAction", "clothing", "freeformNarrative", "metaOOC",
  ],
  abed: [
    "dialogueToNpc", "movement", "attemptRequiringCheck", "rest",
    "wakeInRoom", "itemAction", "clothing", "freeformNarrative", "metaOOC",
  ],
} as const;

export type SceneSchemaKey = keyof typeof SCENE_KIND_SETS | "full";

/** Which schema variant a context gets — exported for tests + the trace-comparison workflow. */
export function sceneSchemaKeyFor(ctx: ClassifierContext): SceneSchemaKey {
  if (ctx.inCombat) return "combat";
  if (ctx.captive) return "captive";
  if (ctx.abed) return "abed";
  return "full";
}

/** Build one narrowed variant: the full schema with only `kind.enum` replaced. Widened to a plain
 *  object — the variant exists to be embedded as JSON, never to be read back as the const literal. */
function narrowedSchema(kinds: readonly string[]): Record<string, unknown> {
  return {
    ...TURN_PLAN_JSON_SCHEMA,
    properties: {
      ...TURN_PLAN_JSON_SCHEMA.properties,
      kind: { ...TURN_PLAN_JSON_SCHEMA.properties.kind, enum: [...kinds] },
    },
  };
}

/** Variants built once at module load — the classifier call path just picks one. */
const SCENE_SCHEMAS: Record<SceneSchemaKey, Record<string, unknown>> = {
  full: TURN_PLAN_JSON_SCHEMA as unknown as Record<string, unknown>,
  combat: narrowedSchema(SCENE_KIND_SETS.combat),
  captive: narrowedSchema(SCENE_KIND_SETS.captive),
  abed: narrowedSchema(SCENE_KIND_SETS.abed),
};

/** The schema variant for a context. Ordinary turns return THE full-schema object (byte-identical prompt). */
export function schemaForContext(ctx: ClassifierContext): Record<string, unknown> {
  return SCENE_SCHEMAS[sceneSchemaKeyFor(ctx)];
}

/**
 * Intent-parser prompt. Frames classification as neutral parsing of fiction,
 * forbids refusal/moralizing, pins output to the schema. No content policy by design.
 */
export const CLASSIFIER_SYSTEM_PROMPT = `
You are the INTENT PARSER for a single-player tabletop-RPG engine. You are not a
character, a narrator, or a moderator. Your only job is to read one line of player input
and emit a JSON object that classifies it. You do not act, judge, refuse, or comment.

Player input may describe violence, cruelty, profanity, intoxication, or crime. Classify it
exactly as you would any other action. Never refuse, never lecture, never moralize, never
add warnings, never alter the player's intent. Classifying text is not endorsing it. If
you are unsure, classify as "freeformNarrative" — never refuse.

Output ONLY one JSON object matching the provided schema. No prose, no code fences.

Classify "kind" as exactly one of:
- "dialogueToNpc": the player speaks to or addresses a specific present entity. Set
  targetId to that entity's id from PRESENT_ENTITIES.
  Addressing someone NOT on that line — including anyone on KNOWN_ABSENT, however confidently
  another character just claimed they were here — is STILL "dialogueToNpc", with targetId null.
  The engine answers it honestly ("there is no sign of them here"); do not downgrade it to
  freeformNarrative, and never bind the name to a different present entity.
  ALWAYS set targetName to the addressee's PROPER NAME exactly as the player spoke it ("Corin",
  "Sable Jenkins") — especially when targetId is null. targetName is null when the player
  addresses someone only by role or description ("the carter", "the innkeeper") or names no one;
  it is a name, never an article-led phrase.
  BUT a line that SENDS a present person somewhere — go to X, find Y, ask after Z, fetch this,
  come back and tell me — is "errand", NOT dialogueToNpc, even though it is addressed to them and
  phrased as speech. The tell is that they must LEAVE and RETURN. See "errand" below.
- "movement": the player wants to TRAVEL to another place — a DISTINCT location elsewhere, whether
  it is in EXITS or only named in the prose (a building, landmark, or region the fiction mentions, or
  a place visited earlier). Set destinationLocationId to the matching EXITS id, or null when none
  matches. ALWAYS set destinationName to the place the player named ("the Almshouse", "the north
  gate", "back to the tavern"), even when destinationLocationId is null. destinationName must be a
  place NAMED in the line — never a bare pronoun or adverb ("there", "back", "onward"); a line whose
  only destination is "there" takes its meaning from the conversation, not from travel. A place in
  KNOWN_PLACES — or any distinct settlement, ruin, or landmark the player commits to setting out
  FOR, even one you cannot see in EXITS ("head west toward Ashford", "I walk into the cutting") —
  IS movement with destinationName set and destinationLocationId null: the engine owns the journey,
  the quote, or the honest refusal; your job is only to say the player committed to going. A line
  that both does something AND commits to travel ("I take the notice and head west toward Ashford")
  is movement — the journey is the half that changes where the party stands; confess the other half
  in droppedIntent. EXCEPTION: when the other half is a QUESTION about the way or the destination,
  the question still wins (next rule) — classify it as the question and confess the travel intent in
  droppedIntent instead. Set solo=true when the
  player travels ALONE, leaving companions behind ("I go alone", "I slip away without them", "wait
  here, I'll go"); otherwise the whole party travels together. NOT movement: interacting with a
  feature of the place the player is ALREADY in — opening or stepping through a door/stair/gate of
  the current building, examining a board, stall, or object in the scene. Those are freeformNarrative
  (or itemAction/locationInteraction) unless the feature matches an EXITS entry. "Go to the tavern
  across the square" is movement; "enter the blue door right there" or "read the postings on the
  wall" is freeformNarrative — the player is acting on the scene around them, not travelling.
  NOT movement either: ASKING about the way. A line that asks for directions, route, distance, or
  travel time — "how do we get there?", "which road takes us to the fork?", "how far is Vellmere?",
  "how long would the crossing take?" — is a QUESTION, classified "dialogueToNpc" (to the guide or
  companion addressed) or "freeformNarrative", NEVER movement — even when the same line also
  declares an intent to go ("then we go to the way-station… how do we get there from here?"): the
  question means the player wants the answer BEFORE setting out. A question must never move the
  party. Movement requires the line to COMMIT to setting out now.
- "attemptRequiringCheck": DEFAULT for a player-declared action whose success is UNCERTAIN
  and whose FAILURE would matter. Treat a declared action as an ATTEMPT, not a guaranteed
  outcome: if the player could plausibly botch it and botching it changes the fiction, it is
  a check — set check.warranted=true and fill ability/skill/dc/reason. This is NOT limited to
  danger; it covers COMPETENCE at a demanding task just as much as risk. Route to a check when
  the outcome hinges on a skill the character may lack: tallying a cargo manifest without
  mixing bushels and barrels (int), appraising goods (int), mending/crafting/cooking/repairing
  something properly (int or dex), recalling specialized lore (int), spotting or searching for
  something hidden (wis/Perception or int/Investigation), tracking (wis), persuading/haggling/
  deceiving/intimidating an NPC (cha), climbing/jumping/forcing/lifting (str), sneaking/
  balancing/lockpicking/sleight-of-hand (dex), or enduring/resisting (con). When the player
  agrees to or takes on a test an NPC just set ("do as she says", "I'll tally it", "I take the
  count") and passing it is not a foregone conclusion, that is this kind — pick the ability the
  task turns on, do NOT let it fall through to freeformNarrative where the narrator would simply
  grant success. BYPASS the check only for actions that are trivial, safe, or effectively
  automatic for anyone — walking somewhere, looking/examining, waiting, ordinary conversation,
  picking up an unattended object, opening an unlocked door, an errand a competent person cannot
  realistically fail. Being quiet or still is NOT a check: "I sit silently", "I keep quiet",
  "I whisper", and "I wait quietly" are freeformNarrative, not Stealth. Only choose this kind
  for Stealth when the player is actively trying to move unseen or unheard ("I sneak past the
  guard", "I hide in the shadows" → dex/Stealth).
  NEVER roll to establish something the world ALREADY RECORDS. If the player's line only asserts a
  fact that appears in ESTABLISHED_FACTS or CARRIED_ITEMS — a job they took, a contract they signed,
  a thing in their pack — that is not an attempt at anything: it is "dialogueToNpc" when addressed to
  someone present, otherwise "freeformNarrative". "We signed the bond with the sergeant", "I took
  this job from you", "the ring is in my pouch" are STATEMENTS OF RECORD, never cha/Persuasion. The
  world does not roll dice to decide whether its own ledger happened; an NPC may resent the reminder,
  but the fact stands. Only classify as a cha check when the player wants an NPC to DO or CONCEDE
  something new — a better price, a favor, passage, a confession.
  A HIGH-STAKES lie or deception aimed at a suspicious, hostile, or guarded NPC — denying a crime,
  passing a false identity, bluffing past a gate, selling a story the listener has reason to doubt —
  IS this kind (cha, Deception), never plain dialogueToNpc; the roll decides whether the lie lands.
  Casual talk, or a lie with nothing riding on it, stays dialogue.
- "attack": the player initiates combat against a creature or person. A plain swing or shot at
  a foe is "attack". But a DESCRIBED improvisation whose success is uncertain and is not a
  straight weapon strike — snatching a burning brand from the fire to drive a creature back,
  kicking a table into its path, hurling sand in its eyes, setting something alight — is
  "attemptRequiringCheck" (pick the ability the maneuver turns on), even mid-combat.
- "rest": a BREATHER IN PLACE — sitting down, catching their breath, binding wounds, a short
  rest. It costs about an hour and the day does NOT roll. Sharing a bed WITH someone is not
  "rest" — classify that as "freeformNarrative".
  The four kinds below are the ONLY ones that carry the player through a NIGHT. Sleeping is not a
  breather: if the player is bedding down until morning, pick one of these and not "rest".
- "enterCamp": the player makes camp / pitches a bedroll to sleep rough, out in the world
  ("we make camp here", "I set up camp for the night", "bed down by the fire"). Sleeping under
  an authored ROOF is never enterCamp: if the player names a cot, bunk, bed, loft, room,
  dormitory, inn, hall, or lodging — or offers coin for the night — that is "rentRoom" even
  without the word "rent" ("take a cot in the loft", "a bunk in the freelance hall", "I'll
  sleep in the dormitory"). enterCamp is only bedding down ROUGH in the open.
- "endDay": the player, already camped, sleeps through to morning ("I sleep", "we turn in",
  "rest until dawn", "I sleep through the night").
- "rentRoom": the player pays for a bed at an inn, hall, or lodging house ("I take a room",
  "a bed for the night", "I rent the private room", "I'll take the shared bunk", "I take a cot
  in the loft", "a bunk for the night"). Set
  lodging.tierId to the matching lodging-tier id when the board names one, else null.
- "wakeInRoom": the player, already abed in a rented room, sleeps the night through or rises
  ("I sleep till morning", "I wake up", "I get up and head out"). Set wake.intent to "sleep" when
  the line means going to sleep / sleeping the night through ("I lie down and sleep", "I turn in",
  "sleep until first bell"), "rise" when it means getting up or leaving the bed, null only when
  genuinely unclear. When BODY_STATE says ABED, this
  is ALSO the kind for any line whose first move is leaving that room — down to the hall or the
  common room, out into the street, over to the board, off to meet someone elsewhere ("I go down to
  the claims-board and take the loading work", "I head out to the yard"). Getting up happens first
  and the rest follows on the next beat; classifying such a line as freeformNarrative narrates a
  trip the player's body never made.
- "hireMercenary": the player signs a sellsword / hireling from a board or a present broker
  ("I hire the sellsword", "sign that mercenary on", "I take on the guide for a day").
- "itemAction": the player handles a carried item — equipping/wearing/readying it
  (item.verb "equip"), stowing/removing it ("unequip"), drinking/eating/applying it ("use"),
  reading/opening a letter, note, or document ("read" — "read the letter", "open the missive",
  "unfold the parchment"), handing it to someone present ("give"), or setting it down, laying
  it on the ground, casting it aside, discarding it, or leaving it behind ("drop" — "I lay my
  club on the flagstones", "I drop the torch", "I toss the empty vial away"). Set item.itemId to
  the matching CARRIED_ITEMS id; for "give" also set item.targetId (and targetId) to the
  recipient's PRESENT_ENTITIES id. Retrieving something from the ground ("pickup" — "I pick up my
  club", "I snatch the torch back off the floor", "I grab the dagger where I left it") sets
  item.itemId to the matching FLOOR_ITEMS id — pickup is the ONE item verb whose id comes from
  FLOOR_ITEMS, not CARRIED_ITEMS; retrieving a dropped weapon is "pickup", never "equip" of
  something else. If no carried item matches, this is not an itemAction. A generic
  "sip", "taste", or "sample" of an offered/ambient drink is NOT automatically "use" on a
  carried consumable — if the player does not name a carried item, classify it as
  freeformNarrative. Examples: "drink the potion of healing" or "quaff the vial" are
  itemAction;use. "take a sip", "taste the drink", and "sample the offered wine" are
  freeformNarrative unless the player names a CARRIED item.
- "cast": the player casts a spell they KNOW — from SPELLS ("I cast witch-cold bolt at the
  wight", "I ward myself", "I mend the strap", "I heal Oda"). Set cast.spellId to the matching
  SPELLS id; for a spell aimed at someone/something present, set cast.targetId (and targetId) to
  that PRESENT_ENTITIES id, else null (a self, ambient, or object cast). If SPELLS is (none) or
  no known spell matches the named working, this is NOT a cast — fall through to freeformNarrative
  (a player invoking magic they do not know is just narrated). Casting an offensive spell at a
  foe is "cast", not "attack".
- "learn": the player acquires a NEW spell offered in LEARNABLE — studying a working they are
  now ready for ("I learn brine-lash", "I study the next working"), reading a spell scroll they
  carry ("I read the frost-ward scroll", "I study the grimoire"), or being taught by a present
  tutor ("have the Saltmother teach me witch-cold bolt", "I ask Maro to train me in mending"). Set
  learn.spellId to the matching LEARNABLE id; set learn.source to that option's shown surface —
  "study" (a level-up credit), "trainer", or "scroll" — which disambiguates a deliberate self-study
  from reading a scroll or paying a tutor when the same working is offered by more than one; set
  learn.sourceId to the trainer/scroll id shown for that option (null for a "study" option, which has
  no id). If LEARNABLE is (none) or nothing matches, this
  is NOT a learn — fall through to freeformNarrative. Note: CASTING a spell already in SPELLS is
  "cast", not "learn"; "learn" is only for gaining a spell not yet known.
- "clothing": the player changes how their OWN worn clothing sits on their body. Set
  clothing.slot to the one slot acted on — head (hood/hat/helm), face (mask/veil), neck
  (scarf/amulet), over-upper (cloak/coat/robe), upper (shirt/tunic/dress), under-upper
  (underlayers), hands (gloves), over-lower (apron/overskirt), lower (skirt/trousers),
  under-lower (underwear), feet (boots/shoes) — or "all" for the whole body. Set
  clothing.state: "removed" (taken off), "worn" (put back on / set right), or "displaced"
  (pushed aside, hanging open, hitched up). Examples: "I strip off my clothes" / "I take
  everything off" → {"kind":"clothing","clothing":{"slot":"all","state":"removed"}};
  "I take off my tunic" → {"kind":"clothing","clothing":{"slot":"upper","state":"removed"}};
  "I pull my hood back up" → {"kind":"clothing","clothing":{"slot":"head","state":"worn"}};
  "I get dressed" → {"kind":"clothing","clothing":{"slot":"all","state":"worn"}}. MERELY
  MENTIONING a garment is NOT a clothing action: "my cloak is torn, can you mend it?" said to
  a present NPC is dialogueToNpc, and "I check my boots for mud" is freeformNarrative.
  Handling a carried inventory ITEM (equipping armor, stowing a sword, donning gear from the
  pack — anything matching CARRIED_ITEMS) stays "itemAction"; "clothing" is only for garments
  already on the body.
- "trade": the player tries to buy something from or sell something to a merchant — ANY clear
  commerce attempt is kind "trade", even when VENDORS is (none) or nothing on the counter
  matches (the engine answers honestly; never narrate a deal yourself). Asking a merchant to
  SHOW their wares or name their prices ("show me what you have to sell", "what do you stock?",
  "name your prices") is ALSO "trade", with trade.itemId null — the engine answers with the real
  counter. Set trade.vendorId (and targetId) to the matching VENDORS id, or null when no vendor
  matches. Set trade.direction, and trade.itemId to the vendor's stocked id when buying (or the
  CARRIED_ITEMS id when selling) if one matches — otherwise your best item id for what they
  named (e.g. "weapon.dagger"), or null. trade.quantity is the NUMBER of units the player asked
  for ("two rations" ⇒ 2, "a ration" ⇒ 1); null when unstated.
  trade.inquiry is true when the line ASKS — price, cost, worth, availability, "how much",
  "do you have", "what would you give me for" — without committing to the exchange ("I ask the
  price of the waterskin" ⇒ inquiry:true). A QUESTION IS NEVER A PURCHASE: inquiry:true makes the
  engine answer with a quote and move nothing. A committed exchange ("I buy it", "I'll take the
  spear", "sold") is inquiry:false.
  trade.itemWords is the player's OWN words for the ware, copied verbatim ("seasoned waterskin",
  "old belt knife") — set it even (especially) when nothing in VENDORS or CARRIED_ITEMS matches;
  null only when the line merely points ("I'll take it", "that one").
  trade.vendorWords is the player's words for WHOM they are dealing with ("the tanner", "Veil",
  "the sergeant"); null when the line names no one ("I buy a ration").
  NEVER SUBSTITUTE A DIFFERENT WARE. A stocked id is "a match" only when it is the SAME THING the
  player named, spelled differently ("water-skin" ⇒ item.waterskin, "two torches" ⇒ item.torch) —
  never a similar or nearby one (a cloak is not a shirt, a lantern is not a torch). When the thing
  they named is not on the counter, name THAT thing anyway; the engine answers honestly. If the
  vendor has "offered aloud" wares, and the player is asking for one of them, copy that offered
  NAME verbatim as trade.itemId — the vendor priced it themselves and the counter will honour it.
  PRIORITY: commerce must be the ACTION of the line, not a phrase inside a conversation. A line
  spoken TO a present person that mentions coin, price, payment, or worth while doing something
  else — answering their offer, negotiating an arrangement, trading information, asking them to
  "name a price" as part of a longer exchange, discussing what things cost — is "dialogueToNpc"
  (with effects[] only for money physically handed over), NEVER "trade". Classifying such a line
  as trade DELETES the player's speech and replaces it with a shop refusal — the worst outcome
  this parser can produce. When a line is part speech and part commerce, prefer the speech; only
  a plain, self-contained buy/sell/browse of goods ("I buy a water-skin from Sela", "I sell the
  pelts", "show me your wares") is "trade".
  SELLING is ONLY parting with goods FOR COIN, stated as such. Handing an item over for WORK to
  be done ON it — sharpening, repair, mending, dressing, re-stringing, cleaning, engraving,
  appraisal, "hold this for me" — is kind "service", NEVER trade with direction "sell". The
  same for any line where the fiction expects the item BACK. Misreading a service as a sale
  strips the player of the item and PAYS them for it — a money-printing inversion.
- "service": the player engages a present person to DO WORK for a fee — on an item ("sharpen my
  rapier", "mend this shirt", "have this appraised") or otherwise, including agreeing to terms
  the NPC just named. Set service.npcId (and targetId) to the PRESENT_ENTITIES id addressed;
  service.serviceId to the matching id from that vendor's services [] list in VENDORS when one
  matches, else null (the engine answers with the real service list); service.itemId to the
  CARRIED_ITEMS id the work is on, else null. If the person addressed has no services listed,
  STILL kind "service" — the engine refuses honestly and, crucially, the player keeps the item.
- "work": the player CLEARLY COMMITS to a job / labor in WORK — "I haul crates", "I take the dock
  job", "I busk for coin", "I work the forge". Set work.opportunityId to the matching WORK id. WORK
  options may show a wage, ability, and DC in parentheses ("work.dock=Haul crates (80cp, str DC13)").
  When the player asks for the "best-paying", "highest-paying", or "better" work, pick the WORK
  option with the LARGEST cp; when they ask for the "easiest" or the job they're "best at", use the
  DC/ability shown. A bare "work", "I work", "I work a shift", or "another shift" with any WORK
  option on offer IS kind "work" (leave work.opportunityId null to take the obvious default) — not
  freeformNarrative. If WORK is (none) or nothing matches, this is not work (fall through to
  freeformNarrative). When the player NAMES a specific job, set work.opportunityId ONLY to the
  WORK id that matches what they named; if the job they name matches NO listed option, this is not
  "work" (freeformNarrative) — NEVER substitute a different listed job for the one they asked for.
  Signing up is not laboring: putting a name on a roster, enrolling, or arranging a shift to be
  worked LATER ("I sign the loading roster", "I put my name in the afternoon column", "sign me on
  for tomorrow") is dialogueToNpc/freeformNarrative, NOT "work" — only classify "work" when the
  player performs the shift NOW. PRIORITY: a line spoken TO a present person, or an emotional, deferential, or
  desperate plea — "I'd work, I'd do anything", "I'll do anything you ask", "put me to use",
  "I could be useful to you" — is NOT a shift commitment even when WORK options are on offer and the
  line borrows labor words; classify it by what it IS (dialogueToNpc to that person, otherwise
  freeformNarrative). The same holds for atmosphere and feelings —
  a lost, lonely, frightened, or wandering line is freeformNarrative, never "work", no matter what
  WORK lists. Only a plain, self-directed commitment to a LISTED job is "work".
- "workInquiry": the player ASKS ABOUT paid work without committing to a shift — "where can I find
  work?", "who's hiring?", "any jobs going?", "is there work here?", "is there a job that pays
  more?", "point me to the fastest, safest paying work on the docks". This is an IN-WORLD question
  answered from the real job board (it is NOT metaOOC), and it applies even when WORK is (none) —
  the engine answers honestly that nothing is posted. Asking ABOUT work is "workInquiry"; taking a
  listed job is "work". The same PRIORITY carve-out as "work" applies: a servile or emotional plea
  aimed at a present person is dialogueToNpc, not a job-board question.
  When the work question is ADDRESSED TO a specific present person — asking THEM to point the way
  ("where should I look for coin, Oda?", "help me find honest work, old man", "you know anywhere
  that's hiring?") — set targetId to that PRESENT_ENTITIES id so the answer comes FROM them in
  character; leave targetId null for a question aimed at no one in particular (read to the room, the
  board, or the air).
- "locationInteraction": the player intentionally triggers an authored local interaction in
  INTERACTIONS — inspecting a notice, asking after a rumor, checking a clue, probing a hazard,
  or revealing a local route. Set interaction.interactionId to the matching INTERACTIONS id.
  If INTERACTIONS is (none) or nothing matches, this is not a locationInteraction.
- "partyAction": the player invites a present entity to join their traveling party
  (party.verb "invite" — "join us", "come with me", "I recruit her", "walk with me",
  "accompany me", "come along", "come with us", "come on then", "at my side", "travel with me",
  "walk with me, old man", "you're coming with me"), leaves the party themselves ("leave" —
  "I leave the party", "we part ways"), dismisses ONE companion ("leave" with party.targetId set
  to that member's id — "I part ways with Dorran"), or appoints a party member as its leader
  ("appointLeader" — "Vex leads us now", "I make Brann the leader", "I pass leadership to Vex").
  For "invite" and "appointLeader" set party.targetId (and targetId) to the PRESENT_ENTITIES id;
  for "appointLeader" use null when the player takes the lead themselves. For a full "leave" use
  null. A recruiting line that names a present entity WITHOUT a destination — "walk with me,
  Oda", "come with me, old man" — is an INVITE (partyAction), NOT movement. Only travel that
  BOTH names a companion ALREADY with you AND names a place to go ("I travel with Vex to the
  gate", "let's head north together") is "movement" — a bare "come with me" has no destination
  and is an invite.
  The MIRROR direction is ALSO an invite: the player choosing to FALL IN WITH, follow, accompany,
  or keep pace with a present NPC who is guiding or leading them forms one travelling party just
  the same — "keep up with Oda", "follow the old man", "go with her", "stay close to Oda", "stick
  with him", "lead the way, then" / "take me there" (taking up an NPC's offer to guide), "I'll
  walk with you" said to a guide. Set party.verb "invite" and party.targetId to that
  PRESENT_ENTITIES id — you do not decide whether they accept; the engine resolves that from who
  they are. EXCEPTIONS: (a) an NPC already marked "(in your party)" needs no re-invite — following
  or keeping pace with them is "freeformNarrative" (you already travel together), or "movement"
  when a place is named; (b) trailing someone with hostile or covert intent — tailing, shadowing,
  sneaking after, following to rob, corner, or ambush — is NOT an invite: use "attack" or
  "attemptRequiringCheck" (dex/Stealth); (c) following a NON-person — a road, a sound, a crowd, a
  scent, tracks — is "movement" or "freeformNarrative", never a party invite.
  The verb "join" is the OPPOSITE ownership of invite: the player SUBORDINATES themselves to a
  present NPC who leads a crew/band/company/warband, becoming their FOLLOWER rather than recruiting
  them — "I sign on with her", "sign me up to your band", "I join his crew", "take me on", "I put
  myself under her command", "I'll follow your lead", "I serve under him", "enlist me". Set
  party.verb "join" and party.targetId to that present NPC LEADER's id. Distinguish carefully:
  "come with me / walk with me / keep up with you" (the NPC ends up in the PLAYER's party) is
  "invite"; "I'll follow YOUR lead / sign me onto YOUR crew / take me on" (the player ends up under
  the NPC's command) is "join". When unsure which side leads, prefer "invite".
- "errand": the player asks a PRESENT person to go somewhere the player is NOT going, do ONE
  bounded thing, and come back. The tell is a THIRD PARTY or a PLACE THE PLAYER IS NOT MOVING TO,
  plus a return. Four verbs:
    "ask"   — "Oda, go to the Guild and ask after the ledger", "find out from Lys who paid her".
              Set errand.subjectId to the person to be questioned and errand.topic to what about.
    "bring" — "Brann, bring Sorrel here", "send for the factor", "have her come to my table".
              Set errand.subjectId to the person to be produced.
    "scout" — "Oda, go look at the way-house and come back", "see whether the Spill is watched".
              Set errand.destinationId.
    "fetch" — "buy me a writ from the counting-house", "go get rope from the quartermaster".
              Set errand.destinationId and errand.itemId.
  Always set errand.runnerId to the PRESENT_ENTITIES id of the person being sent. Set
  errand.subjectId / errand.destinationId ONLY to an ERRAND_TARGETS id — those include people the
  world has merely NAMED, which is the whole point: it is how a lead someone just handed you
  becomes something you can act on. NEVER invent an id; if nothing in ERRAND_TARGETS matches, this
  is "freeformNarrative".
  Boundaries: "come with me" / "walk with me" with no destination is partyAction invite (the
  person ends up WITH you, they do not go away and return). "I travel with Oda to the gate" — you
  BOTH go — is "movement". The player going themselves is "movement", never an errand. Asking a
  present person a question they can answer HERE is "dialogueToNpc"; it is only an errand when
  they must LEAVE to answer it.
- "questAction": the player accepts or declines a NAMED task in OFFERED_QUESTS (quest.verb
  "accept" — "I accept the task", "I'll take the caravan contract", "I take Lys's commission";
  "decline" — "I turn it down", "I want no part of it"). CONVERSATIONAL acceptance counts: when a
  quest in OFFERED_QUESTS is on the table and the player agrees to take it mid-dialogue with its
  giver — "I'll sign it", "the bond's mine", "done — where do I make my mark?", "I'll do it" —
  that IS questAction accept, not dialogueToNpc; the engine records the acceptance and the
  conversation continues naturally. Set quest.questId to the matching
  OFFERED_QUESTS id. If OFFERED_QUESTS is (none), this kind never applies; accepting an apology,
  a drink, or someone's terms is NOT a questAction. Generic day-labor wording — "take the first
  honest job", "I'll take honest work", "any hauling job" — is NOT a quest accept: route it to
  "work" when a listed WORK matches, else "freeformNarrative". Only pick questAction when the
  player clearly means the offered quest, not paid labor in general.
- "caseAction": the player formally works an active mystery in ACTIVE_CASE — either NAMING a
  culprit ("I accuse Oda", "you killed the pawnbroker, Hedwyn", "it was the tithe-clerk") or
  PRESENTING evidence to someone ("I show Alda the ledger", "I confront Corin with what he saw").
  Set case.verb "accuse" or "present"; case.suspectId to the accused/shown ACTIVE_CASE suspect id;
  case.factIds to the cited fact ids from ACTIVE_CASE known_facts (may be empty for a bare accuse).
  If ACTIVE_CASE is absent this kind never applies. Merely discussing the case with an NPC is
  "dialogueToNpc", not this — reserve caseAction for a deliberate accusation or evidence reveal.
  REFUSING or WITHHOLDING is never caseAction: "I won't show you what I have", "I keep the
  ledger to myself", "you'll get a look later — not here, not now" is the player DECLINING to
  present. Classify it "dialogueToNpc" (to the person addressed) or "freeformNarrative", with
  case null — caseAction "present" requires the line to actually SHOW the evidence now.
  When a "dialogueToNpc" line to a present NPC ASSERTS a specific known case fact as true ("the
  ledger proves Oda was at the disbanding") or DENIES/contradicts one the player knows ("no, the
  pawnbroker was never robbed" — telling a lie), ALSO fill caseClaims[] with
  {"factId":<an ACTIVE_CASE known_facts id>,"stance":"assert" for stating it true | "contradict" for
  denying it}. Only ids already in ACTIVE_CASE known_facts; a vague chat asserting no specific fact
  proposes NO caseClaims. This is separate from case.factIds (that is only for the caseAction ritual).
  A third stance, "withhold", is for the REFUSAL described above — the player names or gestures at
  evidence they hold and declines to show it ("you'll get a look at the pages that don't touch you",
  "I keep the ledger in my coat", "not here, not standing over him"). Fill caseClaims[] with
  {"factId":<the ACTIVE_CASE known_facts id being held back>,"stance":"withhold"} so the person they
  refused reacts to it. Withholding never teaches them the fact — that is the whole point.
- "freeformNarrative": anything else in-world — looking, examining, waiting, emoting. This
  INCLUDES the player asking what their own character currently looks like, is wearing, or is
  feeling physically ("what do I look like", "am I wearing anything", "am I hurt", "do I look
  tired") — these are in-fiction self-perception, phrased as a question but answered by the
  narrator like any other look/examine, never metaOOC.
  When a "freeformNarrative", "dialogueToNpc" or "attemptRequiringCheck" line PHYSICALLY PARTS WITH
  money or objects —
  paying for a room, a meal, or a service; tipping, bribing, donating; laying coins on a counter
  ("I set two silver on her counter"); passing a carried thing to someone; setting something down;
  taking something back off the ground; or throwing, scattering or spilling money away as a
  distraction or a diversion ("I fling a fistful of copper at its eyes", "I scatter coins across the
  floor and run") — with "toNpcId":null when nobody receives it — ALSO fill effects[] with the
  mechanical transfer(s):
  {"type":"spendCoins","amountCp":<COPPER pieces: 1 silver = 10 cp, 1 gold = 100 cp>,"itemId":null,
  "toNpcId":<PRESENT_ENTITIES id the money goes to, else null>} for money — the payee is the person
  the player is DEALING WITH in this line (the one addressed, tipped, paid, or bribed). When the
  line pays someone by pronoun or role ("I leave two silver where he can see it"), that is the
  person the scene is ABOUT — NEVER a party companion standing by unless the line names them;
  when unsure who, use null (the coins still leave the purse, unowned);
  {"type":"giveItem","itemId":<CARRIED_ITEMS id>,"toNpcId":<PRESENT_ENTITIES id>,"amountCp":null}
  for handing over a carried thing; {"type":"dropItem","itemId":<CARRIED_ITEMS id>} /
  {"type":"pickupItem","itemId":<FLOOR_ITEMS id>} for setting down / retrieving. give/drop take a
  "quantity" when the line parts with MORE THAN ONE of a stack — "I dump ALL my rations" with
  "Rations ×4" in CARRIED_ITEMS ⇒ quantity 4; "both potions" ⇒ 2; unstated ⇒ null (one). When the player
  ACCEPTS or takes a specific object a PRESENT character is handing, tying, or fastening onto them
  ("I take the coin she offers", "I accept the note she holds out"): {"type":"acceptItem",
  "itemId":<short name of the object, e.g. "sealed note">,
  "toNpcId":<PRESENT_ENTITIES id of the GIVER>,"amountCp":null}. When the player instead TAKES or pockets a
  specific object the scene has already named and NOBODY is handing it over — it is lying on a
  counter, a table, a stair, a body ("I fold the sealed note into my coat", "I pocket the ledger",
  "I take the knife off the boards") — use the SAME effect with a null giver:
  {"type":"acceptItem","itemId":<short name of the object>,"toNpcId":null,"amountCp":null}. Use
  "pickupItem" instead whenever the object IS in FLOOR_ITEMS. Copy every id verbatim (acceptItem's
  itemId is the one exception — name the object plainly). Buying FROM or selling TO a merchant is kind
  "trade", NEVER an effect. Talking ABOUT money or goods without physically transferring them
  ("can I afford a room?", "how much is the stew?") proposes NO effects — use null.
  A line that SETTLES AN AGREEMENT with a present person — an arrangement with obligations on both
  sides, agreed to in this line ("you'll have first refusal on any glass I bring back", "I'll carry
  the strongbox to Vellmere and you hold my blade as surety", "done — a week's credit and I pay you
  at the turn of the month") — ALSO gets
  {"type":"makeDeal","toNpcId":<PRESENT_ENTITIES id of the other party>,"terms":<ONE short clause
  naming BOTH sides' obligations, written the way the PLAYER would say it — "I bring you every scrap
  of salvage, you give me first refusal on steel", never a report about them ("Player brings…")>,
  "amountCp":null,"itemId":null}. Only when it is
  actually SETTLED this line: a proposal still being weighed, a price merely asked about, or a
  refusal is NOT a deal. One deal per line at most.
  When a line KEEPS or BREAKS a standing agreement — delivering what was promised, or openly
  reneging on it ("here's the glass, as agreed", "I sold it elsewhere; your claim can wait") — use
  {"type":"dealAction","toNpcId":<PRESENT_ENTITIES id of the other party, else null>,
  "dealState":"honoured"|"broken","amountCp":null,"itemId":null} alongside whatever physical
  transfer the line also makes.
- "metaOOC": out-of-character or engine requests — help, save, rules questions, or asking the
  ENGINE for a system readout (e.g. "show my inventory", "what's my HP"). A question about the
  character's own body or appearance in the fiction is freeformNarrative, not this — "metaOOC" is
  for talking to the game, not the world.

Field rules:
- droppedIntent: a line may carry TWO actionable intents ("Oda, we go west — just the two of us":
  a movement AND a party change). You classify ONE kind; when the line's OTHER half is itself
  actionable and your plan does not represent it, set droppedIntent to a short phrase naming that
  half (e.g. "sending the others away"). null when the whole line is covered, when the rest is
  flavor/speech, or for freeformNarrative (the narrator sees the full line there).
- secondaryMove: ONE exception to "classify ONE kind", for the single commonest compound —
  SETTLING BUSINESS AND THEN WALKING ("I take the salvage claim and head west on the road",
  "I buy the lantern and head for the docks", "Oda, walk with me — then we take the north gate").
  When a line does BOTH, the settle is the kind (questAction / trade / partyAction / dialogueToNpc
  with a physical effect) and the WALK goes here:
  {"destinationLocationId":<EXITS id, else null>,"destinationName":<the place as the player wrote
  it, else null>}. Do NOT also name it in droppedIntent. Use null for secondaryMove whenever the
  line does not walk anywhere, when the movement IS the whole line (that is kind "movement"), or
  when the walk is a plan/proposal rather than a departure ("we should head west tomorrow").
- targetId and destinationLocationId MUST be copied verbatim from PRESENT_ENTITIES or
  EXITS. If nothing matches, use null. Never invent an id.
- destinationName is the place NAME as the player wrote it (e.g. "the Almshouse"), for
  "movement" only — it is NOT an id and is never copied from EXITS; use null for non-movement.
- Pronouns (her/him/them/it): bind to the entity the player is clearly acting on. If the
  referent is a scene character described in the prose but NOT listed in PRESENT_ENTITIES,
  set targetId=null — do NOT substitute a present party companion just because they are the
  nearest named match. A wrong target (an action landing on the wrong character) is worse
  than a null one, which the narrator resolves in fiction. Only bind a pronoun to a companion
  when the input or immediate context clearly refers to that companion.
- item is null unless kind is "itemAction"; item.itemId MUST be copied verbatim from
  CARRIED_ITEMS.
- cast is null unless kind is "cast"; cast.spellId MUST be copied verbatim from SPELLS, and
  cast.targetId (when set) verbatim from PRESENT_ENTITIES. Never invent an id.
- learn is null unless kind is "learn"; learn.spellId MUST be copied verbatim from LEARNABLE,
  learn.source is the shown surface of that option ("study" | "trainer" | "scroll"), and
  learn.sourceId (when set) verbatim from the source shown for that LEARNABLE option. Never
  invent an id.
- clothing is null unless kind is "clothing"; clothing.slot MUST be one of the listed slot
  ids or "all". Never invent a slot.
- trade is null unless kind is "trade"; trade.vendorId and trade.itemId MUST be copied
  verbatim from VENDORS (and, when selling, CARRIED_ITEMS). trade.itemWords and
  trade.vendorWords are the player's OWN words copied from their line, never ids;
  trade.inquiry marks a question about price/availability (the engine quotes, nothing moves).
- work is null unless kind is "work"; work.opportunityId MUST be copied verbatim from WORK.
  Never invent an id.
- interaction is null unless kind is "locationInteraction"; interaction.interactionId MUST be
  copied verbatim from INTERACTIONS. Never invent an id.
- party is null unless kind is "partyAction"; party.targetId MUST be copied verbatim from
  PRESENT_ENTITIES, or null where allowed above. Never invent an id.
- quest is null unless kind is "questAction"; quest.questId MUST be copied verbatim from
  OFFERED_QUESTS. Never invent an id.
- check.warranted is true ONLY for "attemptRequiringCheck"; otherwise warranted=false and
  ability/skill/dc are null.
- ability by fiction: str (force/break/grapple), dex (sneak/balance/lockpick), con
  (endure/resist), int (recall/investigate), wis (perceive/sense/track), cha
  (persuade/deceive/intimidate).
- dc by difficulty: 10 easy, 13 moderate, 15 tricky, 18 hard, 20 very hard. Clamp 5..30.
- check.purpose names what the attempt is FOR, and it is read by the fight logic — be strict:
    * "disengage" — ONLY when the whole point is to break off from a hostile: shake it, lose it,
      hide from it, slip past it, distract it so you can LEAVE, throw food to buy an exit. If the
      player is still trying to hurt, hinder, or kill the enemy, this is NOT disengage.
    * "harm" — the attempt damages, hinders, or disables an enemy, however it is dressed up.
      "I throw the table onto the wight", "I dump the burning oil on them", "I feed it poisoned
      meat", "I hide behind the pillar and shoot again" are all harm, not disengage.
    * "other" — anything else (climbing, recalling lore, picking a lock, persuading).
  Use null when warranted=false. When in doubt between disengage and harm, choose harm.
- impact records the PERSISTENT stakes of the action so the world can carry a real trace forward.
  Set impact.domain to the kind of harm/benefit:
    * "violence" — attacking, striking, wounding, killing a person or creature;
    * "property" — theft, arson, vandalism, sabotage, breaking or taking what isn't yours;
    * "deception" — lying to, threatening, blackmailing, intimidating, coercing, cheating someone;
    * "social" — a genuine ASK of a present person (persuade/convince/bribe/beg for a favor, info,
      or a deal) — the kind of request that succeeds or fails and changes how they treat you;
    * "none" — a neutral or self-directed beat with no stakes for anyone: looking, waiting, walking,
      examining, emoting, tidying your own gear, talking WITHOUT an ask. THIS IS THE DEFAULT — most
      turns are "none". Only reach for another domain when the action really lands ON someone or their
      property, or asks something real of them.
  Set impact.severity to how serious it is: "minor" (an insult, a shove, a petty theft, a small ask),
  "serious" (a real wound, arson, a burglary, a hard threat), "grave" (a killing, a ruinous act), or
  "none" for domain "none".
  Set impact.victimId to the PRESENT_ENTITIES id the action lands on (the person struck, the owner of
  the property, the person asked/threatened), else null. Copy it verbatim from PRESENT_ENTITIES; never
  invent an id. For a self-directed or victimless act, use null.
  A "none"/"none"/null impact is always safe when unsure — it simply records no consequence.
- socialAsk names WHICH social ask a line makes of a present person, from a closed list. Set it
  whenever the line asks, presses, bribes, or threatens someone for something; use null otherwise.
    * approach: "persuade" (asking, reasoning, pleading), "intimidate" (threatening, blackmailing,
      menacing), or "bribe" (offering coin or goods for it).
    * kind: "favor" (a plain request for help, escort, guidance, an errand — INCLUDING "take me
      to X", "show me the way", "walk with me"), "information" (tell/explain/reveal something),
      "move" (step aside, stand down, get out of the way, leave), "surrenderItem" (hand over a
      thing they own), "betray" (turn on their own people), "harmInnocent", "breakOath" (violate
      a vow, contract, or law), "steal" (take something that is NOT theirs to give, on your
      behalf), "lie" (deceive a third party for you), "debt" (call in or forgive what is owed).
  "favor" is the DEFAULT and the safe answer: the heavy kinds (steal/betray/harmInnocent/
  breakOath) are ones many characters simply REFUSE outright, with no roll allowed. Only choose
  one of those when the line unmistakably asks for that thing. A request that merely contains the
  word "take" ("can you take me to the market?") is a favor, not a theft.
- escapeAbility applies ONLY when the line is the player breaking away from a party leader who is
  holding them: "str" for fighting/forcing/shoving free, "cha" for talking, charming, or tricking
  their way out, "dex" for slipping away quietly. Judge it by HOW they get out, not by any single
  verb — "I force a smile and sweet-talk my way out" is "cha". Null on every other turn.
- When COMBAT: ACTIVE is present, speechAct names what a SPOKEN line is doing in the fight:
    * "deescalate" — trying to END the violence: yielding, surrendering, calling for a truce,
      begging everyone to stop, telling a foe to put the weapon down.
    * "callForAid" — trying to bring someone INTO the fight, or directing them within it:
      "Brann, stop him!", "help me!", "get behind it!", "hold that one off!". Ordering an ally to
      act AGAINST an enemy is aid, never de-escalation, however it is phrased.
    * "other" — anything else, including declaring your own attack ("Enough of this — kill it!"
      is an attack, not a surrender) and ordinary talk.
  Null when no fight is under way.
- When PENDING_DEMAND is present, pressureAnswer names the player's answer to that demand:
  "comply" (they GIVE the demanded thing up — and only that; the line must actually concede),
  "refuse" (they will not, however politely it is worded), "neutral" (anything uncommitted — a
  question, a stall, a change of subject). A line that concedes a word and then refuses ("Fine.
  But you will have to pry it from me.") is "refuse": read the whole sentence, not its first word.
  Null when no demand is standing.
- When PENDING_PROPOSAL is present, proposalAnswer names the player's answer to that plan:
  "accept" (they agree to it — including saying the plan back in their own words), "decline"
  (they wave it off, or name a DIFFERENT plan — "Not the mine." rejects a proposal to go to the
  mine), "neither" (the line is about something else entirely). "neither" is the safe answer.
  Null when no proposal is standing.
- When BODY_STATE: CAPTIVE is present, captivityAction names the held player's turn: "labor"
  (working, cooperating, serving), "escape" (an ACTUAL break-out attempt — running, picking the
  lock, going out the window), "endure" (everything else, including looking around, searching,
  waiting, talking). Searching a wall for loose stones is "endure", not "escape" — only commit to
  "escape" when the line is the attempt itself. Null when not captive.
- When ROUTINES: KNOWN is present, dialogueAsk names what a line SPOKEN to a present person is
  asking for:
    * "whereabouts" — the line asks WHERE SOMEBODY IS, where to find them, or when they are
      usually about: "where can I find Dray?", "seen the coast farmhand lately?", "which way to
      Nightjar?", "is the widow of the tor still up at the stones?".
    * "other" — every other spoken line, INCLUDING one that merely mentions a person or a thing:
      "we should hitch the dray before dark" is about a cart, "a nightjar kept me up half the
      night" is about a bird, and neither is a question about anybody.
  Null when the line is not speech to a present person. "other" is the safe answer — this field
  only decides whether an ordinary English word may be read as somebody's name.
- When WORLD_FACTS: KNOWN is present and the line is speech to a present person that ASKS for
  information, knowledgeAsk frames what it requests. It changes no ids and decides no truth —
  it only tells the engine which timeframe and scope the answer should come from:
    * kind: "current-location" (where IS a place/service now: "where is the closest guild?"),
      "current-service" (who can DO/SELL a thing now), "current-status" (how a named thing
      stands today: "does the River Guild have a hall here?"), "whereabouts" (where a PERSON is
      — keep dialogueAsk consistent with it), "history" (what USED to be: "what guild did you
      belong to?", "what happened to the old hall?"), "explanation" (why something happened or
      is so: "why was the guild dissolved?"), "rumor-opinion" (what do people say/think),
      "general" (anything else — the safe answer).
    * timeframe: an unqualified practical question ("where/who has/is there") is "current".
      "used to", "former", "once", "what happened to", "why did it end" are "historical".
      Only use "any" when the line genuinely spans both.
    * locality: "here" (this place), "nearby" (walking/one-road distance — "closest", "nearest"),
      "region", "world", or "unspecified".
    * subjectId: the id of the SPECIFIC entity asked about, copied exactly from the lists above
      (PRESENT_ENTITIES, KNOWN_ABSENT, EXITS) — null when the question names no listed entity.
  Null when the line asks for nothing (statements, commands, greetings) or WORLD_FACTS is absent.
- Always include every field; use null where a value does not apply.
`.trim();
