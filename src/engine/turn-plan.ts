/**
 * TurnPlan — the advisory classification of one player input.
 *
 * Produced once per turn by the utility model (or the deterministic heuristic). It is
 * METADATA only: it never carries narration prose or dice numbers. The engine maps a
 * TurnPlan onto typed Actions and resolves any check in code — the model never authors
 * an Action or a number.
 *
 * @author Runkai Zhang
 */
import { z } from "zod";
import { KNOWLEDGE_ASK_KINDS, KNOWLEDGE_LOCALITIES, KNOWLEDGE_TIMEFRAMES } from "../knowledge/types.ts";

export const TurnKindSchema = z.enum([
  "dialogueToNpc",
  "movement",
  "attemptRequiringCheck",
  "attack",
  "rest",
  "enterCamp",
  "endDay",
  "rentRoom",
  "wakeInRoom",
  "hireMercenary",
  "itemAction",
  "cast",
  "learn",
  "clothing",
  "trade",
  "tradeBatch",
  "service",
  "work",
  "workInquiry",
  "locationInteraction",
  "partyAction",
  "questAction",
  "caseAction",
  "errand",
  "freeformNarrative",
  "metaOOC",
]);
export type TurnKind = z.infer<typeof TurnKindSchema>;

export const TurnItemVerbSchema = z.enum(["equip", "unequip", "use", "give", "read", "drop", "pickup"]);

/** Item-verb payload for kind === "itemAction". Ids are grounded by the engine, never trusted. */
export const TurnItemSchema = z.object({
  verb: TurnItemVerbSchema,
  /** A carried item id from context, else null (the engine degrades to freeform). */
  itemId: z.string().nullable().default(null),
  /** Recipient for "give" — MUST be a present entity id from context, else null. */
  targetId: z.string().nullable().default(null),
});

/** Clothing payload for kind === "clothing" — the player adjusting garments WORN on their own
 *  body ("I strip off my clothes", "I pull my hood back up"). The slot stays a plain string here
 *  (this file deliberately imports nothing but zod); reconcilePlan grounds it against the real
 *  wardrobe slot vocabulary (or "all" = every slot this character dresses) and degrades the plan
 *  to freeform on anything else — the itemAction precedent. */
export const TurnClothingSchema = z.object({
  /** A wardrobe slot id ("upper", "head", …) or "all" for the whole body. Validated by the engine. */
  slot: z.string(),
  state: z.enum(["worn", "displaced", "removed"]),
});

/** Cast payload for kind === "cast". Ids are grounded by the engine against the caster's known
 *  spells / present entities, never trusted. */
export const TurnCastSchema = z.object({
  /** A known spell id from context (the SPELLS: list), else null (the engine degrades to freeform). */
  spellId: z.string().nullable().default(null),
  /** The target entity — a present entity id from context for a targeted spell, else null (self/object). */
  targetId: z.string().nullable().default(null),
});

/** Learn payload for kind === "learn" — the player acquiring a new spell ("learn brine-lash",
 *  "study the frost-ward scroll", "have the Saltmother teach me witch-cold bolt"). Ids are grounded
 *  by the engine against the LEARNABLE list (study pool / present trainers / carried scrolls). */
export const TurnLearnSchema = z.object({
  /** A learnable spell id from context (the LEARN: list), else null (the engine degrades to freeform). */
  spellId: z.string().nullable().default(null),
  /** Which acquisition surface the player named — a level-up study credit, a present trainer, or a
   *  carried scroll — else null (no stated preference). The EXPLICIT discriminator that separates a
   *  deliberate "study" from an unstated preference; a bare `sourceId: null` could mean either. */
  source: z.enum(["study", "trainer", "scroll"]).nullable().default(null),
  /** The source the player named — a present trainer id or a carried scroll id, else null (study/unstated). */
  sourceId: z.string().nullable().default(null),
});

export const TradeDirectionSchema = z.enum(["buy", "sell"]);

/** Trade payload for kind === "trade". Ids are grounded by the engine, never trusted. */
export const TurnTradeSchema = z.object({
  direction: TradeDirectionSchema,
  /** Buy: an id from the vendor's stock; sell: a carried item id. Else null (degrades to freeform). */
  itemId: z.string().nullable().default(null),
  /** The merchant — MUST be a present vendor id from context, else null. */
  vendorId: z.string().nullable().default(null),
  /** Units the player asked for ("two rations" ⇒ 2); null/absent ⇒ 1. The engine caps by stock and
   *  coin at resolve time (r3 P3: typed quantities were silently dropped to one). Optional in AND
   *  out so pre-quantity literals and stubs stay assignable unchanged. */
  quantity: z.number().int().min(1).nullable().optional(),
  /** r10 F-2 — the line ASKS (price/worth/availability) without committing: the engine answers with
   *  a quote and moves nothing. Optional in AND out so pre-r10 literals/stubs stay assignable. */
  inquiry: z.boolean().nullable().optional(),
  /** r10 F-3 — the player's OWN words for the ware, verbatim ("old belt knife"); null when the line
   *  only points at it ("I'll take it"). The resolver corroborates the id guess against these words
   *  and refuses honestly instead of executing a substituted item. Optional in AND out. */
  itemWords: z.string().nullable().optional(),
  /** r10 F-2 — the player's words for WHOM they addressed ("the tanner"); null when unaddressed.
   *  Reconcile drops the payload (kind survives) when these words name someone other than the
   *  grounded vendor, so the wrong merchant is never charged. Optional in AND out. */
  vendorWords: z.string().nullable().optional(),
});

/** One line of a caller-confirmed shopping basket (kind === "tradeBatch"). The engine re-validates
 * every line
 *  at resolve time (stock, purse, price), so a stale basket degrades honestly per line. */
export const TurnTradeBatchLineSchema = z.object({
  direction: TradeDirectionSchema,
  itemId: z.string(),
  quantity: z.number().int().min(1).max(99).default(1),
});

/** Basket payload for kind === "tradeBatch": one vendor, many lines, ONE turn, ONE narrated beat.
 *  The r7 fix for "four Buy clicks ≈ four minutes": provisioning is a single exchange now. */
export const TurnTradeBatchSchema = z.object({
  vendorId: z.string(),
  lines: z.array(TurnTradeBatchLineSchema).min(1).max(24),
});

/**
 * Service payload for kind === "service" — the player engaging a present NPC's SERVICE (sharpening,
 * repair, appraisal…): a fee for work, never a sale. `serviceId` grounds against the vendor's
 * authored `vendor.services`; `itemId` is the carried item the work is on (custody services keep it
 * until due). This kind exists because r7's classifier read "dress it properly and name your price"
 * as SELLING the rapier — a money-printing inversion. An ungrounded payload keeps the KIND (the
 * trade precedent) so the engine can refuse honestly with the NPC's real service list.
 */
export const TurnServiceSchema = z.object({
  /** The present NPC asked to do the work — MUST be a present entity id from context, else null. */
  npcId: z.string().nullable().default(null),
  /** An authored service id from the NPC's SERVICES list, else null. */
  serviceId: z.string().nullable().default(null),
  /** The carried item the work is on, else null (services that need no item). */
  itemId: z.string().nullable().default(null),
});

/** Work payload for kind === "work". The opportunity id is grounded by the engine, never trusted. */
export const TurnWorkSchema = z.object({
  /** A present work-opportunity id from context, else null (the engine degrades to freeform). */
  opportunityId: z.string().nullable().default(null),
});

/** Location-interaction payload for kind === "locationInteraction". */
export const TurnLocationInteractionSchema = z.object({
  /** An authored interaction id from the current location, else null (degrades to freeform). */
  interactionId: z.string().nullable().default(null),
});

/** Lodging payload for kind === "rentRoom" — which bed the player asked for. The tier id is grounded
 *  by the engine against the current hall's `guild.lodging.tiers`, never trusted. Absent/null ⇒ the
 *  engine picks the cheapest tier the player can afford (a bare "rent a room for the night"). */
export const TurnLodgingSchema = z.object({
  /** A lodging-tier id from the hall's board, else null (engine picks the cheapest affordable). */
  tierId: z.string().nullable().default(null),
});

/** Wake payload for kind === "wakeInRoom" — what the line MEANS: sleep the night through, or get
 *  up now. Playtest r9 F-13: "I bar the door, lie down, and sleep" at dusk (18:13, before the
 *  20:00 night line) fell to the clock fallback and ROSE the player who asked to sleep. The
 *  classifier states the intent; null keeps the clock fallback (daylight rises, night sleeps). */
export const TurnWakeSchema = z.object({
  intent: z.enum(["sleep", "rise"]).nullable().default(null),
});

export const TurnPartyVerbSchema = z.enum(["invite", "leave", "appointLeader", "join"]);
export type TurnPartyVerb = z.infer<typeof TurnPartyVerbSchema>;

/** Party payload for kind === "partyAction". Ids are grounded by the engine, never trusted. */
export const TurnPartySchema = z.object({
  verb: TurnPartyVerbSchema,
  /** Invite/appoint/join target — MUST be a present entity id from context. For "join" it is the
   *  present NPC LEADER the player is signing on WITH (the PC becomes their follower). Null for
   *  "leave", and for "appointLeader" when the player takes the lead themselves (the PC-leads default). */
  targetId: z.string().nullable().default(null),
});

export const TurnErrandVerbSchema = z.enum(["ask", "bring", "scout", "fetch"]);
export type TurnErrandVerb = z.infer<typeof TurnErrandVerbSchema>;

/**
 * Errand payload for kind === "errand" (r5): the player asks a PRESENT person to go somewhere the
 * player is NOT going, do one bounded thing, and come back. Every id is grounded by the engine —
 * `runnerId` against the present cast, `subjectId`/`destinationId` against ERRAND_TARGETS (which
 * includes people the world has only NAMED, so the r4 "she's here, three tables to your left"
 * lead is reachable) — and never trusted.
 */
export const TurnErrandSchema = z.object({
  verb: TurnErrandVerbSchema,
  /** Who goes. MUST be a present entity id. */
  runnerId: z.string().nullable().default(null),
  /** Who they go TO ("ask") or go FETCH ("bring"). An ERRAND_TARGETS npc id. */
  subjectId: z.string().nullable().default(null),
  /** Where they go ("scout"/"fetch"). An ERRAND_TARGETS place id; derived from the subject otherwise. */
  destinationId: z.string().nullable().default(null),
  /** What to buy ("fetch"). An item id. */
  itemId: z.string().nullable().default(null),
  /** What to ask about ("ask") — matched against the subject's authored knowledge, never invented. */
  topic: z.string().default(""),
});

/** Recruit payload for kind === "hireMercenary" — which board offer the player took. The offer id is
 *  grounded by the engine against the current hall's generated board, never trusted. Click-only. */
export const TurnRecruitSchema = z.object({
  /** A merc-board offer id from context, else null (the engine refuses if it can't ground). */
  offerId: z.string().nullable().default(null),
});

export const TurnQuestVerbSchema = z.enum(["accept", "decline"]);
export type TurnQuestVerb = z.infer<typeof TurnQuestVerbSchema>;

/** Quest payload for kind === "questAction". Ids are grounded by the engine, never trusted. */
export const TurnQuestSchema = z.object({
  verb: TurnQuestVerbSchema,
  /** An OFFERED quest id from context, else null (the engine degrades to freeform). */
  questId: z.string().nullable().default(null),
});

export const CheckAbilitySchema = z.enum(["str", "dex", "con", "int", "wis", "cha"]);
export type CheckAbility = z.infer<typeof CheckAbilitySchema>;

/**
 * The persistent IMPACT of the turn (Phase 3 — the consequence floor), set by the LLM classifier so
 * the engine can bind a real, carried-forward trace to a transgression or a social ask instead of
 * narrating varied prose around unchanged state (playtest #1). Additive + FULLY defaulted: an old plan
 * or a scripted-classifier stub with no `impact` parses to a neutral `none/none/null` ⇒ NO consequence,
 * so nothing regresses and the deterministic test suite is untouched. `victimId` is grounded against
 * present entities in `reconcilePlan` (→ null if absent), exactly like `targetId`.
 */
/**
 * A PHYSICAL side-effect proposal riding a freeform/dialogue line (the grounded-freeform channel):
 * the player's prose hands over money or objects, and the classifier ALSO proposes the mechanical
 * transfer so the engine can mint a real reducer command instead of letting the narrator fabricate
 * one (the recurring "prose-only transaction" class). Ids/amounts are PROPOSALS — `reconcilePlan`
 * grounds each against the world (purse, carried items, floor, present entities) and drops what
 * doesn't ground; the engine is the resolve-time authority. Buy/sell is deliberately EXCLUDED —
 * commerce with a vendor is kind `trade`. Fields stay permissive here (a malformed amount must not
 * fail the whole plan parse); grounding is where strictness lives.
 */
export const TurnEffectSchema = z.object({
  type: z.enum(["spendCoins", "giveItem", "dropItem", "pickupItem", "acceptItem", "makeDeal", "dealAction"]),
  /** Copper pieces for spendCoins (1 sp = 10 cp, 1 gp = 100 cp); null/ignored otherwise. */
  amountCp: z.number().nullable().default(null),
  /** The carried (give/drop), floor (pickup), or received (accept — free-form, slugged) item id. */
  itemId: z.string().nullable().default(null),
  /** The present recipient for giveItem / an aimed spendCoins; the present GIVER for acceptItem. */
  toNpcId: z.string().nullable().default(null),
  /** give/drop only: units the line parts with ("I dump ALL FOUR rations" ⇒ 4). Capped by the real
   *  stack at grounding; absent/1 ⇒ one (r7 P3: the whole-stack sacrifice deducted a single unit).
   *  Optional in AND out so legacy effect literals stay assignable. */
  quantity: z.number().int().min(1).nullable().optional(),
  /** makeDeal only (§2.2): the settled bargain in ONE short clause, naming both obligations
   *  ("first refusal on any glass I bring back, for 20% over market"). Stored verbatim as the deal's
   *  terms — the player-safe sentence every surface reuses. Optional in AND out so legacy effect
   *  literals stay assignable. */
  terms: z.string().nullable().optional(),
  /** dealAction only (§2.2): what just happened to the standing deal with `toNpcId`. */
  dealState: z.enum(["honoured", "broken"]).nullable().optional(),
});
export type TurnEffect = z.infer<typeof TurnEffectSchema>;

export const TurnImpactSchema = z.object({
  /** What kind of harm/benefit the action carried. `none` = a neutral/flavor beat (no trace). */
  domain: z.enum(["social", "property", "violence", "deception", "none"]).default("none"),
  /** How serious it was (scales every effect). */
  severity: z.enum(["none", "minor", "serious", "grave"]).default("none"),
  /** The specific present entity the action landed on (a person/property owner), else null. */
  victimId: z.string().nullable().default(null),
});
export type TurnImpact = z.infer<typeof TurnImpactSchema>;

export const TurnCaseVerbSchema = z.enum(["accuse", "present"]);
export type TurnCaseVerb = z.infer<typeof TurnCaseVerbSchema>;

/** Case payload for kind === "caseAction" (mystery wave). `accuse` names a suspect + cites the proof
 *  facts; `present` shows evidence to an NPC. Ids are PROPOSALS — `reconcilePlan` grounds `suspectId`
 *  against present/known suspects and `factIds` against the player's ESTABLISHED facts, and fills the
 *  engine-owned `caseId` from the active-case context (never model-authored). */
export const TurnCaseSchema = z.object({
  verb: TurnCaseVerbSchema,
  /** The accused (accuse) or the NPC shown evidence (present) — a present entity id, else null. */
  suspectId: z.string().nullable().default(null),
  /** Fact ids the player cites/presents — grounded against their known facts (dropped if unknown). */
  factIds: z.array(z.string()).default([]),
  /** Engine-derived (reconcilePlan), NOT model-authored: the active case this action targets. */
  caseId: z.string().nullable().default(null),
});
export type TurnCase = z.infer<typeof TurnCaseSchema>;

/** A claim the player makes about a case fact WHILE talking to an NPC (the lie/credibility side-channel,
 *  mystery wave). Rides the SAME classifier call as a `dialogueToNpc` line — no extra model call, the
 *  effects-channel precedent. `assert` shares a fact the player holds as true (the NPC comes to know it);
 *  `contradict` DENIES a fact — a lie the NPC catches (credibility/standing damage) only when it KNOWS
 *  the fact to be true. `factId` is grounded against the player's ESTABLISHED facts in `reconcilePlan`;
 *  `caseId` is engine-filled from the active case (never model-authored). */
export const TurnCaseClaimSchema = z.object({
  factId: z.string(),
  stance: z.enum(["assert", "contradict", "withhold"]),
  /** Engine-derived (reconcilePlan), NOT model-authored: the active case this claim targets. */
  caseId: z.string().nullable().default(null),
});
export type TurnCaseClaim = z.infer<typeof TurnCaseClaimSchema>;

export const TurnCheckSchema = z.object({
  /** Only true for kind === "attemptRequiringCheck". */
  warranted: z.boolean(),
  ability: CheckAbilitySchema.nullable().default(null),
  /** Free-form skill label for flavor/proficiency, e.g. "stealth". */
  skill: z.string().nullable().default(null),
  /** Suggested DC; engine clamps to [5, 30]. */
  dc: z.number().int().min(1).max(40).nullable().default(null),
  reason: z.string().default(""),
  /**
   * What the attempt is FOR, from a closed set. `disengage` means the whole point was to break off
   * from a hostile — shake it, hide from it, slip past it — as opposed to `harm` (an attack by
   * another name) or `other`.
   *
   * The combat module's evasion-calm reads this. It used to keyword-match the model's free-text
   * `reason` plus the player's raw line, which put an unconstrained string in charge of a durable
   * delta: a PASSED attack check whose prose merely contained "throw"/"feed"/"dump"/"hide" — e.g.
   * "I throw the table over onto the wight" — ended the encounter and permanently calmed every foe.
   * Optional and nullable (the additive-field convention used across this schema), so an older plan
   * — or a classifier that omits the field — parses unchanged and simply never triggers the calm.
   * That is the safe direction: the fight merely continues.
   */
  purpose: z.enum(["disengage", "harm", "other"]).nullable().optional(),
});

export const TurnPlanSchema = z.object({
  kind: TurnKindSchema,
  /** Addressed/targeted entity id — MUST be one present in context, else null. */
  targetId: z.string().nullable().default(null),
  /** kind === "dialogueToNpc" only: the addressee's PROPER NAME exactly as the player spoke it
   *  ("Corin", "Sable Jenkins"), carried when `targetId` failed to ground — an NPC reply can mint a
   *  findable person the roster has never had (r13: Sela's "Corin"), and without the spoken name the
   *  engine could only answer with the content-free stub. Null when the player addresses someone by
   *  role/description only ("the carter") or names no one. `.nullable().optional()`, never
   *  `.default(null)` (the closed-answer-field convention below — a default would make it required
   *  in the inferred type and break every literal stub in tests/). */
  targetName: z.string().nullable().optional(),
  /** Movement destination — MUST be a connected-location id from context, else null. */
  destinationLocationId: z.string().nullable().default(null),
  /** kind === "movement" only: the place NAME the player named, verbatim ("the Almshouse", "north
   *  gate") — filled for a movement even when destinationLocationId also grounds to an exit. When the
   *  id doesn't ground, the engine's open-world reach titles a generated destination (or matches an
   *  existing/known place) from this. Optional/absent for non-movement (additive — old plans parse
   *  unchanged). */
  destinationName: z.string().nullable().optional(),
  /** kind === "movement" only: the player travels ALONE, leaving companions behind (a party split
   *  — "I go alone", "slip away without them"). Absent/false ⇒ the whole party travels together. */
  solo: z.boolean().optional(),
  check: TurnCheckSchema,
  /** Only for kind === "itemAction"; absent/null otherwise (additive — old plans parse unchanged). */
  item: TurnItemSchema.nullable().optional(),
  /** Only for kind === "cast"; absent/null otherwise (additive — old plans parse unchanged). */
  cast: TurnCastSchema.nullable().optional(),
  /** Only for kind === "learn"; absent/null otherwise (additive — old plans parse unchanged). */
  learn: TurnLearnSchema.nullable().optional(),
  /** Only for kind === "clothing"; absent/null otherwise (additive — old plans parse unchanged). */
  clothing: TurnClothingSchema.nullable().optional(),
  /** Only for kind === "trade"; absent/null otherwise (additive — old plans parse unchanged). */
  trade: TurnTradeSchema.nullable().optional(),
  /** Only for kind === "tradeBatch" (typed basket); absent/null otherwise (additive). */
  tradeBatch: TurnTradeBatchSchema.nullable().optional(),
  /** Only for kind === "service"; absent/null otherwise (additive — old plans parse unchanged). */
  service: TurnServiceSchema.nullable().optional(),
  /** Only for kind === "work"; absent/null otherwise (additive — old plans parse unchanged). */
  work: TurnWorkSchema.nullable().optional(),
  /** Only for kind === "rentRoom"; absent/null otherwise (additive — old plans parse unchanged). */
  lodging: TurnLodgingSchema.nullable().optional(),
  /** Only for kind === "wakeInRoom"; absent/null otherwise (additive — old plans parse unchanged). */
  wake: TurnWakeSchema.nullable().optional(),
  /** Only for kind === "hireMercenary"; absent/null otherwise (additive — old plans parse unchanged). */
  recruit: TurnRecruitSchema.nullable().optional(),
  /** Only for kind === "locationInteraction"; absent/null otherwise (additive). */
  interaction: TurnLocationInteractionSchema.nullable().optional(),
  /** Only for kind === "partyAction"; absent/null otherwise (additive — old plans parse unchanged). */
  party: TurnPartySchema.nullable().optional(),
  /** Only for kind === "errand"; absent/null otherwise (additive — old plans parse unchanged). */
  errand: TurnErrandSchema.nullable().optional(),
  /** Only for kind === "questAction"; absent/null otherwise (additive — old plans parse unchanged). */
  quest: TurnQuestSchema.nullable().optional(),
  /** Only for kind === "caseAction"; absent/null otherwise (additive — old plans parse unchanged). */
  case: TurnCaseSchema.nullable().optional(),
  /** Case claims riding a `dialogueToNpc` line (mystery lie/credibility side-channel — additive/optional,
   *  old plans + scripted stubs parse unchanged). After `reconcilePlan` holds only claims grounded to a
   *  known fact + active case; the engine resolves each against the addressed NPC's epistemic state. */
  caseClaims: z.array(TurnCaseClaimSchema).nullable().optional(),
  /** Engine-derived (reconcilePlan), NOT model-authored: set when a movement's destination didn't
   *  ground to any real exit. The plan STAYS `movement` (no longer degrades to freeform) — the engine
   *  reads this as the signal to REACH the named place: reuse an existing/known location, realize a
   *  gazetteer entry, or generate a fresh pocket on the fly (worldgen-as-explore), then actually move
   *  the party there so projected state stays synced with the prose. Absent ⇒ the destination grounded to a
   *  listed exit (or the line isn't a movement). */
  movementMiss: z.boolean().optional(),
  /** PROSE-TO-CODE §2.4 — the classifier's own confession that the line carried a SECOND actionable
   *  intent this plan does not represent ("Oda, we go west — just the two of us": one kind, and the
   *  party change silently vanished). A short phrase naming the dropped half; the engine surfaces
   *  it as an honest ledger note, so silence can never be the failure mode. Null/absent ⇒ the whole
   *  line is represented. */
  droppedIntent: z.string().nullable().optional(),
  /**
   * PROSE-TO-CODE §2.4, the SETTLE-THEN-MOVE half (r11 F-11). A line that closes business AND walks
   * ("I take the salvage claim and head west on the road") is one sentence players write constantly,
   * and picking either half alone loses the other. The classifier now makes the SETTLE the plan —
   * the half a later turn cannot recover — and hands the walk over here; the engine executes it
   * AFTER the settle commits. Deliberately narrow: a lone GROUNDED adjacent exit, carried only by a
   * settle kind, never a reach/frontier/multi-leg/mid-fight move. `reconcilePlan` drops it whenever
   * any of that fails, and the ordinary `droppedIntent` note covers what is left. Absent ⇒ the line
   * carried no second half (every pre-r11 plan and every scripted stub).
   */
  secondaryMove: z
    .object({
      destinationLocationId: z.string().nullable(),
      destinationName: z.string().nullable(),
    })
    .nullable()
    .optional(),
  /** Grounded physical side-effects riding a freeform/dialogue line (additive/optional — old plans
   *  and every scripted stub parse unchanged). After `reconcilePlan` this holds ONLY effects that
   *  grounded; the engine mints them through the reducer. */
  effects: z.array(TurnEffectSchema).nullable().optional(),
  /** Engine-derived (reconcilePlan), NOT model-authored: the classifier proposed ≥1 physical effect
   *  but NONE grounded — the honest "nothing actually changed hands" note rides the narration so the
   *  turn cannot silently read as a completed transfer. Absent ⇒ nothing was proposed or dropped. */
  effectsDropped: z.boolean().optional(),
  /** Engine-derived (reconcilePlan): a spendCoins effect was proposed but dropped (malformed/zero
   *  amount). Only THIS suppresses the ambient coin-gift rescue — a dropped ITEM transfer (a vest
   *  the player doesn't yet own) must not shield a real prose payment from the ledger (r6 exploit). */
  coinsDropped: z.boolean().optional(),
  /** Persistent impact of the turn (Phase 3) — additive/optional like every other per-kind field, so a
   *  hand-built plan or a scripted stub may omit it (⇒ the binder treats it as a neutral `none`).
   *  `reconcilePlan` always fills it (grounded), so a real classified turn always carries one. */
  impact: TurnImpactSchema.optional(),

  // --- Closed answer fields (r8 regex audit, the `check.purpose` pattern) -----------------------
  // Each of these replaces a regex that was reading OPEN-ENDED natural language whose answer became
  // a DELTA. The model may only NAME the answer from a closed list; code still owns the number, the
  // refusal, and the mutation. All are `.nullable().optional()` (never `.default(null)`, which would
  // make them REQUIRED in the inferred type and break every literal stub in tests/), and every one
  // degrades to the branch that was safe BEFORE the model was consulted.

  /**
   * The player's answer to a standing NPC demand/press (`PendingAgendaPressure`). Read by
   * `resolveAgendaPressure`: `comply` hands the thing over with NO roll, `refuse` is a real resist
   * (+2 for standing firm) and TELLS the fiction the player refused, `neutral` resolves on the bare
   * roll.
   *
   * It replaces `pressureAnswerOf`'s two word-lists, which read the "fine" in "Fine. But you will
   * have to pry it from me." as compliance — the item transferred with no roll and the RESOLVED
   * block instructed the narrator to describe a willing handover of a thing the player had just
   * refused to give up (reproduced against the shipped regex, r8 audit).
   *
   * Null/absent ⇒ the prose floor with `comply` CLAMPED OUT (`pressureAnswerFrom`): the floor may
   * still say `refuse`, which is safe because it only adds +2 to the player's own resist, and
   * anything else — including a `comply` it thinks it read — resolves as `neutral`, the bare
   * contested roll that an unrecognized line has always drawn. No absent answer can reach the free
   * handover.
   */
  pressureAnswer: z.enum(["comply", "refuse", "neutral"]).nullable().optional(),
  /**
   * Which CLOSED social ask the player just made of a present NPC — the stance/DC lookup key.
   * `resistanceDC` and `offLimitsFor` stay the sole authority over the number and over whether the
   * ask is refusable at all; the model only names which of the ten authored kinds was asked.
   *
   * It replaces `inferAgendaAsk`'s cascade, whose `/\b(steal|rob|take)\b/` arm read "Can you take me
   * to the market?" as `kind:"steal"` — an off-limits ask for most NPCs, so the single most helpful
   * person in town answered a request for directions with an unrollable hard refusal (reproduced,
   * r8 audit).
   *
   * Null/absent ⇒ that cascade, minus its teeth (`agendaAskOf`): it still picks the approach and the
   * kinds that merely move a number, but any kind `offLimitsFor` could turn UNROLLABLE — `steal`,
   * `betray`, `breakOath`, `harmInnocent`, `lie` — collapses to the fair-ask baseline `favor`. So a
   * classifier outage can only make an ask easier, never mint a hard refusal.
   */
  socialAsk: z
    .object({
      approach: z.enum(["persuade", "intimidate", "bribe"]),
      kind: z.enum([
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
      ]),
    })
    .nullable()
    .optional(),
  /**
   * What a line spoken during a LIVE fight is DOING: ending it (`deescalate`), calling a bystander
   * into it (`callForAid`), or neither (`other`). Read by the engine's call-for-aid gate and by the
   * combat module's parley trigger — the two readers of the same `DEESCALATION_RE`.
   *
   * The regex answered both questions with one word-list, so mid-fight "Brann, stop him!" — a plain
   * order to a companion — was scored as a parley instead of a call for aid, and "Enough of this —
   * kill it!" (the `enough` arm) opened a surrender bid on a line that declared an attack. Both
   * reproduced against the shipped regex.
   *
   * Null/absent ⇒ the readers fall back to `DEESCALATION_RE`, so a classifier outage and every
   * scripted stub behave EXACTLY as before. The code-side addressing gate (`addressesTheFight`)
   * still runs on top: the model may name the speech act, never who is in the fight.
   */
  speechAct: z.enum(["deescalate", "callForAid", "other"]).nullable().optional(),
  /**
   * The player's answer to a leader's pending proposal. Read by the PROPOSAL ANSWER branch AFTER
   * its two deterministic word matchers have failed, replacing `isProposalEcho` — the containment
   * test that read "Not the mine." as assent (every content word appears in a proposal that named
   * the mine) and moved the whole party there on the leader's stashed `moveParty`. Reproduced.
   *
   * Null/absent ⇒ `neither`: the plan stays cancelled and the line classifies normally, which is
   * the historic fall-through and the only branch that mutates nothing.
   */
  proposalAnswer: z.enum(["accept", "decline", "neither"]).nullable().optional(),
  /**
   * Which captivity action a held player's line is. Read by `CaptivityModule`, replacing
   * `classifyCaptivityInput`'s verb list — whose `/\brun\b/` arm scored "I run my hands along the
   * wall looking for loose stones" as a break-out attempt: a real d20, a permanently raised
   * `escapeDc`, and a burned captivity day for a line that was searching, not running. Reproduced.
   *
   * Null/absent ⇒ the regex, then its own `endure` default — the passive branch that costs the
   * player nothing but the day they were already serving.
   */
  captivityAction: z.enum(["labor", "endure", "escape"]).nullable().optional(),
  /**
   * Which ability a contested escape from a party leader rolls. Replaces `escapeAbility`'s verb
   * list, whose `/\bforce\b/` arm rolled STRENGTH on "I force a smile and sweet-talk my way out" —
   * a CHA character's talk-out resolved on their worst stat, and the failure branch applied the
   * leader's consequence. Reproduced.
   *
   * Null/absent ⇒ the regex, then its own `dex` default (slipping away), so a classifier outage
   * behaves exactly as today.
   */
  escapeAbility: z.enum(["str", "dex", "cha"]).nullable().optional(),
  /**
   * What a line SPOKEN to a present NPC is asking for. `whereabouts` = the line asks where somebody
   * is, or how to find them; `other` = every other spoken line, including one that merely MENTIONS a
   * person or a thing.
   *
   * Unlike its siblings this one replaces no regex — it supplies evidence no regex could have. The
   * name binder (`src/rules/name-match.ts`) cannot tell "where can i find dray?" from "i hitch the
   * dray and load the crates": "dray" is both the quartermaster and a cart, and the ONLY difference
   * is what the line is doing. So the binder's loosest surface (`player-query`, which lets the whole
   * name bind uncapitalized) is armed by this field and nothing else — read exactly once, by
   * `whereaboutsFor` in `src/modules/dialogue.ts`, to decide whether a lowercase "dray" may be read
   * as a person before looking up his routine.
   *
   * Null/absent ⇒ the binder keeps the `uncased` surface — TODAY's behaviour, where such a name is
   * reachable only when the player capitalizes it. That is the safe branch in both directions: a
   * classifier outage (or any scripted stub, or the private-whisper path, which never classifies at
   * all) merely costs the convenience, and can never conjure a person out of a common noun.
   */
  dialogueAsk: z.enum(["whereabouts", "other"]).nullable().optional(),
  /**
   * The knowledge-request frame for a line SPOKEN to a present NPC (epistemic plan §8): what kind
   * of answer it asks for, which timeframe, and how local — the evidence embeddings cannot supply
   * ("where is a guild?" means a usable hall NOW; "what happened to your guild?" means history).
   * The raw line stays the semantic query; code selects the facts (src/knowledge/packet.ts); this
   * frame only steers current-vs-historical priority. `subjectId` must ground against classifier
   * candidates or is dropped in reconcile. Null/absent ⇒ the safe default (general/any) — and the
   * standing invariant that a historical fact never renders as a current answer holds regardless,
   * so a classifier outage can never substitute a defunct institution for a live one.
   */
  knowledgeAsk: z
    .object({
      kind: z.enum(KNOWLEDGE_ASK_KINDS),
      timeframe: z.enum(KNOWLEDGE_TIMEFRAMES).default("any"),
      locality: z.enum(KNOWLEDGE_LOCALITIES).default("unspecified"),
      subjectId: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type TurnPlan = z.infer<typeof TurnPlanSchema>;

// --- Context handed to the classifier (and heuristic) ----------------------

export interface ClassifierEntityRef {
  id: string;
  name: string;
  /** For exit refs only (additive): the authored compass/relative direction ("north", "down"),
   *  when set — a directional handle the fuzzy exit matcher can ground "go north" against. */
  direction?: string;
}

/** A present merchant and what's on their counter — the trade grounding targets. */
export interface ClassifierVendorRef {
  id: string;
  name: string;
  /** The vendor's stock (deduped — repeated ids are stacks), id + display name. */
  stock: ClassifierEntityRef[];
  /** Authored services on this counter (r8) — the `service` grounding targets. Optional so every
   *  pre-service caller/test keeps a byte-identical prompt. */
  services?: ClassifierEntityRef[];
  /**
   * Wares this vendor PRICED ALOUD in the current scene but does not stock (§2.1, `pendingOffers`).
   * Grounding targets exactly like stock: the classifier copies the offered NAME as `trade.itemId`
   * so the resolver can cash the vendor's own quote. Without them the model reaches for the nearest
   * stocked id instead and buys a substitute — live 07-31, a spare oiled-wool cloak Veil had just
   * priced was classified as her `apparel.shirt`. Omit-when-empty (byte-identical prompt).
   */
  offers?: { name: string; priceCp: number }[];
}

/** A work opportunity on offer here (location job board or a present hirer) — the `work` grounding target. */
export interface ClassifierWorkRef {
  id: string;
  /** The player-facing label ("Haul crates for the dockmaster"). */
  label: string;
  /** Copper paid on a successful shift — so the classifier can pick the higher-paying job when asked
   *  (finding #9). Optional/additive: absent ⇒ the wage isn't rendered, and no id/grounding changes. */
  wageCp?: number;
  /** The ability the labor tests (str/dex/…) — rendered so "the job I'm best at" can be reasoned about. */
  ability?: string;
  /** Difficulty of the shift. */
  dc?: number;
}

/** An authored interaction available at this location. */
export interface ClassifierInteractionRef {
  id: string;
  label: string;
  kind: string;
}

/** A spell the player could acquire right now — the `learn` grounding target. */
export interface ClassifierLearnRef {
  id: string;
  name: string;
  /** Where it comes from: a level-up study credit, a present trainer, or a carried scroll. */
  source: "study" | "trainer" | "scroll";
  /** The trainer/scroll id backing this option (absent for the study pool). */
  sourceId?: string;
  /** Coin cost (trainer tuition); absent/0 ⇒ free. */
  costCoins?: number;
}

export interface ClassifierContext {
  playerActorId: string;
  locationId: string;
  locationName: string;
  /** Reachable connected locations — the ONLY legal movement destinations. */
  exits: ClassifierEntityRef[];
  /**
   * FAR places the player knows of beyond the adjacent exits — visited locations, places named by
   * an offered/active quest, unrealized gazetteer rumors (r9 F-5's classifier face: with only
   * EXITS in view, "head west toward Ashford" had no referent and the model shrugged it into
   * freeform while the narrator walked an imaginary road). Referents for `destinationName` only —
   * `destinationLocationId` still grounds exclusively against EXITS; the movement resolver owns
   * routing/refusal for far names. Optional and omit-when-empty: absent ⇒ byte-identical prompt.
   */
  knownPlaces?: ClassifierEntityRef[];
  /** Addressable entities present here (companions + location NPCs). */
  presentEntities: ClassifierEntityRef[];
  /** Subset of presentEntities that are standing companion agents (can reply). */
  companionIds: string[];
  /** Items the player carries (id + display name) — the itemAction grounding targets. Optional
   *  so pre-economy callers/tests need no change; absent means no item matching happens. */
  carriedItems?: ClassifierEntityRef[];
  /** Items lying on THIS location's floor (id + display name) — the `pickup` grounding targets
   *  (the inverse of `drop`). Optional; absent means pickup never grounds. */
  floorItems?: ClassifierEntityRef[];
  /** Spells the player knows (id + display name) — the `cast` grounding targets. Optional so
   *  pre-magic callers/tests need no change; absent means no spell matching happens. */
  knownSpells?: ClassifierEntityRef[];
  /** Present merchants (template has `vendor`) and their stock — the trade grounding targets.
   *  Optional for the same reason; absent means no trade matching happens. */
  vendors?: ClassifierVendorRef[];
  /** Work available here (location + present hirers) — the `work` grounding targets. Optional so
   *  pre-job callers/tests need no change; absent means no work matching happens. */
  workOpportunities?: ClassifierWorkRef[];
  /** Location interactions the player may intentionally trigger here. */
  locationInteractions?: ClassifierInteractionRef[];
  /** True while the player is ABED in a rented room — a line that leaves the room must get them up
   *  first (`wakeInRoom`), or the turn narrates a trip their body never made (r5 P1). Omitted
   *  otherwise, so an ordinary turn's prompt is byte-identical. */
  abed?: boolean;
  /** Quests currently in state "offered" (id + display name) — the ONLY legal questAction
   *  targets. Optional so pre-quest callers/tests need no change; absent means no matching. */
  offeredQuests?: ClassifierEntityRef[];
  /** Spells the player can acquire here (study credits + present trainers + carried scrolls) — the
   *  `learn` grounding targets. Optional; absent means no learn matching happens. */
  learnableSpells?: ClassifierLearnRef[];
  /**
   * Facts the world's own ledger already records as TRUE of this player — the quests they have taken
   * or settled. A line that merely RESTATES one of these is not an attempt at anything: the world
   * does not roll dice to decide whether its own signed contract happened (playtest 07-24 P1, where
   * "we signed the bond" drew a Persuasion DC 15 and the failure entrenched an NPC's confabulation).
   * Optional; absent means the classifier reasons exactly as before.
   */
  establishedFacts?: ClassifierEntityRef[];
  /** The active case (mystery wave) — the suspects the player may accuse and the facts they may
   *  present, the `caseAction` grounding targets. Optional/absent when no case is active, so caseless
   *  play stays byte-identical. `knownFacts` uses each fact's short text as its display `name`. */
  activeCase?: {
    caseId: string;
    suspects: ClassifierEntityRef[];
    knownFacts: ClassifierEntityRef[];
  };
  /**
   * Authored NPCs the player has been TOLD about but who are NOT here — names lifted from the
   * recent transcript by `absentReferencedNames` (the same pool that feeds the brief's `Not
   * present` line). These are NOT addressable: `targetId` still grounds only to
   * `presentEntities`. They exist so an intent ABOUT an absent person (send someone to fetch
   * them, go ask after them) can name a real id instead of inventing one — r4's P1 was a person
   * the world produced in prose and then could not ground. Optional/omit-when-empty so a turn
   * that mentions nobody absent keeps a byte-identical prompt.
   */
  knownAbsentNpcs?: ClassifierEntityRef[];
  /**
   * The legal `errand` grounding pool (r5) — people and places the player could plausibly send
   * someone to. NPCs: `knownAbsentNpcs` ∪ anyone the player has a relationship with, has been
   * sighted, or rosters at a visited location. Places: everywhere visited, plus anywhere a real
   * road reaches. Code-derived, so the classifier can never mint an id for a person or place the
   * world has never shown. Optional/omit-when-empty ⇒ byte-identical prompt without it.
   */
  errandTargets?: { npcs: ClassifierEntityRef[]; places: ClassifierEntityRef[] };

  // --- Situational flags for the closed answer fields (r8) ---------------------------------------
  // Each one gates ONE block of prompt guidance, the way `abed` gates the wake rule. Every flag is
  // omit-when-absent, so an ordinary turn's user message stays byte-identical to today's.

  /** A standing NPC demand/press the player's line is ANSWERING (name + what was demanded). Set only
   *  while a `PendingAgendaPressure` is live ⇒ `pressureAnswer` guidance appears on exactly that turn. */
  pendingDemand?: { npcName: string; summary: string };
  /** A party leader's pending proposal the player's line may be answering (name + the spoken plan).
   *  Set only while a cancelled proposal is stashed ⇒ `proposalAnswer` guidance on exactly that turn. */
  pendingProposal?: { npcName: string; text: string };
  /** True while the player is HELD CAPTIVE — the turn is a captivity action (labor/endure/escape),
   *  never an ordinary check. Omitted otherwise. */
  captive?: boolean;
  /** True while a combat encounter is live — a spoken line is a de-escalation, a call for aid, or
   *  neither, and `speechAct` names which. Omitted otherwise. */
  inCombat?: boolean;
  /** True when this world has people who keep KNOWN ROUTINES (any NPC with an authored or derived
   *  schedule), so "where can I find X?" is a question the engine can actually answer and
   *  `dialogueAsk` is worth asking for. Omitted in a world with no schedules at all — every
   *  fixture world in tests/ — so those prompts stay byte-identical. */
  routinesKnown?: boolean;
  /** True when this world carries an epistemic layer (authored `World.facts`), so a spoken line's
   *  knowledge frame (`knowledgeAsk`) is worth asking for. Omitted in fact-less worlds — every
   *  fixture world in tests/ — so those prompts stay byte-identical. */
  factsKnown?: boolean;
}

/** A neutral, never-refusing default plan (the safe fallback). */
export function freeformPlan(): TurnPlan {
  return {
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 0.4,
  };
}
