/**
 * Content schemas — the campaign infrastructure.
 *
 * A World is a reusable setting (lore, factions, locations, NPCs, monsters, items,
 * spells). A Campaign is played on top of a World. Both are *data*, validated here so
 * the engine can stay generic and worlds can be authored and shared. This file is the
 * single source of truth for those shapes; types flow out of the Zod schemas.
 *
 * @author Runkai Zhang
 */
import { z } from "zod";
import { COMMAND_TYPES, type CommandType } from "../world/commands.ts";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Stable identifier for a content entity (unique within its World/Campaign). */
export const Id = z.string().min(1).describe("Stable, human-readable id, e.g. 'npc.lyra'");

/** Free-prose markdown-ish text block. */
const Prose = z.string();

/** Stable physical features. Clothing lives in inventory items plus the wardrobe slice. */
export const BodySchema = z.object({
  /** Stature — "tall", "short and slight", "5'6\"". */
  height: z.string().default(""),
  /** Frame/musculature — "lean", "broad-shouldered", "soft and round". */
  build: z.string().default(""),
  /** Hair — length, color, style ("shoulder-length oak-brown, loose"). */
  hair: z.string().default(""),
  /** Eyes — color/quality ("pale grey, tired"). */
  eyes: z.string().default(""),
  /** Skin — tone/texture ("olive, weathered"). */
  skin: z.string().default(""),
  /** Facial features — "sharp jaw, freckles, a crooked nose". */
  face: z.string().default(""),
  /** Standing marks — scars, tattoos, brands ("burn scar across one forearm"). */
  distinguishing: z.string().default(""),
});
export type Body = z.infer<typeof BodySchema>;

/**
 * Shared authored identity for both player characters and NPCs. These fields are data and prompt
 * material only; they do not participate in safety gating or mechanics.
 */
export const IdentitySchema = z.object({
  /**
   * Biological sex. The ONLY sex/gender field (owner decision 2026-07-04: `gender`/`perceivedGender`
   * were removed for simplicity — zod strips the stale keys from older saves/worlds on parse). Kept as
   * free text so existing content loads unchanged; it is used only for authored identity and
   * pronoun hints, never to select mechanics.
   */
  sex: z.string().default(""),
  /**
   * The character's persistent physical description (build, face, hair, skin, standing marks),
   * never clothing. What they wear is items/wardrobe, not prose.
   */
  description: Prose.default(""),
  /** Structured physical features used by narrator and NPC context. */
  body: BodySchema.default({}),
  /** Free-text temperament/manner for DM-facing interpretation. */
  personality: Prose.default(""),
  /** Private lore the character knows about themselves or the world. */
  knownLore: Prose.default(""),
  /** Truths the DM/world knows but this character does not know. */
  hiddenLore: Prose.default(""),
  /** How this character LOOKS to an observer — physical read tags ("scarred", "striking", "weathered"). */
  appearanceTags: z.array(z.string()).optional(),
  /** How this character CARRIES themselves — bearing/manner tags ("confident", "guarded", "formal"). */
  presentationTags: z.array(z.string()).optional(),
  /** Social read tags an observer reacts to ("charismatic", "intimidating", "warm"). */
  socialTraits: z.array(z.string()).optional(),
});
export type Identity = z.infer<typeof IdentitySchema>;

/** The classic nine-alignment grid, used for NPC behavioral guidance. */
export const AlignmentIds = ["lg", "ng", "cg", "ln", "tn", "cn", "le", "ne", "ce"] as const;
export const AlignmentSchema = z.enum(AlignmentIds);
export type Alignment = z.infer<typeof AlignmentSchema>;

/** The six 5e ability scores. */
export const AbilityScoresSchema = z.object({
  str: z.number().int(),
  dex: z.number().int(),
  con: z.number().int(),
  int: z.number().int(),
  wis: z.number().int(),
  cha: z.number().int(),
});
export type AbilityScores = z.infer<typeof AbilityScoresSchema>;

// ---------------------------------------------------------------------------
// Proactive-NPC autonomy — see docs/PROACTIVE-NPCS.md
// ---------------------------------------------------------------------------

/**
 * How much initiative an NPC takes. This is the data hook for the Director.
 *  - passive   : acts only when directly addressed
 *  - reactive  : also reacts to others / threats (priority B)
 *  - proactive : also self-initiates — suggestions, banter (priority C)
 *  - leader    : may issue party-level proposals and act on tacit consent
 */
export const AutonomyLevelSchema = z.enum(["passive", "reactive", "proactive", "leader"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

export const AutonomySchema = z.object({
  /** Is this NPC traveling with the party (eligible for autonomous turns)? */
  isPartyMember: z.boolean().default(false),
  /** Initiative tier (see AutonomyLevelSchema). */
  level: AutonomyLevelSchema.default("reactive"),
  /** If true and level is 'leader', proposals auto-execute on tacit player consent. */
  canLead: z.boolean().default(false),
  /** Seconds of idle time before a quiet NPC reconsiders acting. */
  heartbeatSeconds: z.number().positive().default(40),
  /** Reply-chain decay rate α — higher means NPC-to-NPC chatter tapers faster. */
  replyDecayAlpha: z.number().min(0).max(1).default(0.2),
});
export type Autonomy = z.infer<typeof AutonomySchema>;

// ---------------------------------------------------------------------------
// Stat blocks, items, spells, monsters
// ---------------------------------------------------------------------------

/** A combat/skill stat block, shared by NPCs and monsters. */
export const StatBlockSchema = z.object({
  abilities: AbilityScoresSchema,
  maxHp: z.number().int().nonnegative(),
  armorClass: z.number().int(),
  /** Challenge rating or level, advisory for encounter balancing. */
  level: z.number().nonnegative().default(1),
  speed: z.number().int().nonnegative().default(30),
  /** Proficiency-relevant skills/tools, free-form for now. */
  proficiencies: z.array(z.string()).default([]),
  /** Innate or prepared spell ids (reference World.spells). */
  spells: z.array(Id).default([]),
});
export type StatBlock = z.infer<typeof StatBlockSchema>;

export const ItemSchema = z.object({
  id: Id,
  name: z.string(),
  description: Prose.default(""),
  kind: z.enum(["weapon", "armor", "consumable", "tool", "treasure", "quest", "misc"]).default("misc"),
  /** Mechanical hooks (damage dice, AC bonus, etc.) — free-form until M3 rules depth. */
  properties: z.record(z.string(), z.unknown()).default({}),
});
export type Item = z.infer<typeof ItemSchema>;

/** Ability a spell forces a saving throw against, or keys its casting on. */
const SpellSaveAbilitySchema = z.enum(["str", "dex", "con", "int", "wis", "cha"]);

/** Mechanical modifiers a spell-imposed status confers — mirrors `StatusEffectMods` in the rules layer. */
const SpellStatusModsSchema = z
  .object({
    check: z.number().optional(),
    attack: z.number().optional(),
    ac: z.number().optional(),
    energy: z.number().optional(),
    advantage: z.boolean().optional(),
    disadvantage: z.boolean().optional(),
  })
  .default({});

/**
 * The typed mechanic the rules engine (`src/rules/magic.ts`) resolves for a spell. Additive and
 * OPTIONAL — a spell without a `mechanic` casts as narrative-only (spends time/energy, the narrator
 * describes it, no dice), so worlds authored before this layer parse and play unchanged. Discriminated
 * on `kind`:
 *  - attack-damage : spell attack roll vs the target's derived AC; on hit, `dice` damage.
 *  - save-damage   : the target saves vs the caster's spell DC; fail = full `dice`, success = half (if `half`) or none.
 *  - heal          : roll `dice`, restore that many HP to the target (self/ally).
 *  - save-debuff   : the target saves; on failure a status effect (`applyStatusEffect`) is imposed.
 *  - utility       : explicit narrate-only (light, ward, mending) — same as an absent mechanic, self-documenting.
 */
export const SpellMechanicSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("attack-damage"),
    dice: z.string(),
    damageType: z.string().default("force"),
  }),
  z.object({
    kind: z.literal("save-damage"),
    dice: z.string(),
    damageType: z.string().default("force"),
    save: SpellSaveAbilitySchema,
    /** Half damage on a successful save (else the save negates entirely). */
    half: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("heal"),
    dice: z.string(),
  }),
  z.object({
    kind: z.literal("save-debuff"),
    save: SpellSaveAbilitySchema,
    status: z.object({
      /** The status/condition tag mirrored into the target's `conditions[]` for projections. */
      kind: z.string(),
      turnsRemaining: z.number().int().positive().default(3),
      mods: SpellStatusModsSchema,
    }),
  }),
  z.object({ kind: z.literal("utility") }),
]);
export type SpellMechanic = z.infer<typeof SpellMechanicSchema>;

export const SpellSchema = z.object({
  id: Id,
  name: z.string(),
  level: z.number().int().min(0).max(9).default(0),
  description: Prose.default(""),
  /** Free-form prose/flavor hooks (scar text, school, range) — NOT the mechanical contract. */
  effect: z.record(z.string(), z.unknown()).default({}),
  /** Typed mechanic the rules engine resolves; absent ⇒ narrative-only cast. */
  mechanic: SpellMechanicSchema.optional(),
  /** Who the spell targets, for grounding; absent ⇒ inferred from the mechanic kind. */
  targeting: z.enum(["self", "ally", "enemy", "object"]).optional(),
});
export type Spell = z.infer<typeof SpellSchema>;

export const MonsterSchema = z.object({
  id: Id,
  name: z.string(),
  description: Prose.default(""),
  stats: StatBlockSchema,
  /** Item ids carried (loot-on-kill fodder). Copied onto the spawned entity's inventory. */
  inventory: z.array(Id).default([]),
});

// ---------------------------------------------------------------------------
// Trigger predicates — shared by prebaked events (Campaign.events), Exit barriers, and
// NPC schedule slots
// ---------------------------------------------------------------------------

const QuestStateEnum = z.enum(["hidden", "offered", "active", "complete", "failed"]);

/** The six coarse day phases the campaign clock renders (src/agents/context.ts `dayPhaseOf`).
 *  Declared BEFORE ConditionSchema so the `dayPhase` condition can reference it. */
export const DayPhaseSchema = z.enum(["deep night", "dawn", "morning", "afternoon", "dusk", "night"]);
export type DayPhase = z.infer<typeof DayPhaseSchema>;

/** One predicate clause; a TriggerPredicate is the conjunction (allOf) of these. */
export const ConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("atLocation"), locationId: Id }),
  z.object({ kind: z.literal("inRegion"), regionId: Id }),
  z.object({ kind: z.literal("questState"), questId: Id, state: QuestStateEnum }),
  z.object({ kind: z.literal("flag"), key: z.string(), equals: z.unknown().optional() }),
  z.object({ kind: z.literal("hasItem"), entityId: Id, itemId: Id }),
  z.object({ kind: z.literal("relationshipAtLeast"), actorId: Id, targetId: Id, value: z.number() }),
  /** The PC's standing with a faction (rules/factions.ts, −100..100) is ≥ value — the guild-reputation
   *  gate (better work/quests/gear unlock as standing rises). Absent in legacy worlds ⇒ unaffected. */
  z.object({ kind: z.literal("factionStandingAtLeast"), factionId: Id, value: z.number() }),
  z.object({ kind: z.literal("clockAtLeast"), minutes: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("entityPresent"), entityId: Id, locationId: Id.optional() }),
  z.object({ kind: z.literal("workedOpportunity"), opportunityId: Id, countAtLeast: z.number().int().positive().default(1) }),
  z.object({ kind: z.literal("interactionUsed"), interactionId: Id, locationId: Id.optional() }),
  /** `entityId` absent ⇒ the default entity (the PC) — matches the `giveItem`/`adjustCoins` idiom. */
  z.object({ kind: z.literal("attireState"), entityId: Id.optional(), state: z.enum(["bare", "disheveled"]) }),
  // --- Vulnerability signals (Phase 2, Violet playtest 2026-07-20) — each reuses an existing
  //     runtime computation; a world that authors none evaluates byte-identically. ---
  /** The campaign clock's current day phase is one of these (night-gates ANY event surface). */
  z.object({ kind: z.literal("dayPhase"), phases: z.array(DayPhaseSchema).min(1) }),
  /** No living companion stands with the PC (the opportunity layer's "unaccompanied" read). */
  z.object({ kind: z.literal("partyAlone") }),
  /** The party's current region danger (regionProfileOf, world-danger fallback) is ≥ value. */
  z.object({ kind: z.literal("regionDangerAtLeast"), value: z.number().int() }),
]);
export type Condition = z.infer<typeof ConditionSchema>;

/** A pure, fast predicate: all clauses must hold. Shared by prebaked events and Exit barriers. */
export const TriggerPredicateSchema = z.object({ allOf: z.array(ConditionSchema).default([]) });
export type TriggerPredicate = z.infer<typeof TriggerPredicateSchema>;

// ---------------------------------------------------------------------------
// NPC routines (schedules) — DayPhaseSchema is declared above ConditionSchema
// ---------------------------------------------------------------------------

/** One routine slot: where a scheduled NPC stands (and what they're doing) during given phases. */
export const ScheduleSlotSchema = z.object({
  /** Day phases this slot covers. */
  phases: z.array(DayPhaseSchema).min(1),
  /** Days of week (campaign day % 7) this slot applies; absent ⇒ every day. */
  days: z.array(z.number().int().min(0).max(6)).optional(),
  /** Where the NPC stands during this slot. */
  locationId: Id,
  /** What they're doing — a present-participle phrase ("tending the bar"); feeds presence lines. */
  activity: z.string().default(""),
  /** Weight among same-phase alternates (keyed weighted pick per (npc, day, phase)). */
  weight: z.number().positive().default(1),
  /** Predicate gate — the slot only applies while every clause holds (questState/flag/…).
   *  `atLocation` keeps its party-relative meaning here, same as event triggers. */
  conditions: z.array(ConditionSchema).default([]),
  /** Marks the NPC's post as a social venue while this slot is active (rumor delivery). */
  venue: z.boolean().default(false),
});
export type ScheduleSlot = z.infer<typeof ScheduleSlotSchema>;

/**
 * An NPC's daily/weekly routine. The routines tick module reconciles a scheduled NPC's position
 * to the matching slot at each day-phase boundary through the reducer (an offstage teleport —
 * mechanics in code; the LLM only narrates observed departures/arrivals). Slot choice per
 * (npc, day, phase) is a PRIVATE keyed-rng weighted pick — stable within the phase, replay-safe.
 * Absent ⇒ the NPC never moves on its own (previous behavior, byte-identical).
 */
export const NpcScheduleSchema = z.object({
  slots: z.array(ScheduleSlotSchema).default([]),
  /** Chance per phase the NPC deviates from routine (holds position instead of moving). */
  variance: z.number().min(0).max(1).default(0),
  /** Where the NPC is when no slot matches (home/bed). Absent ⇒ stays wherever it stands. */
  defaultLocationId: Id.optional(),
  /** Activity shown while at the default location. */
  defaultActivity: z.string().optional(),
});
export type NpcSchedule = z.infer<typeof NpcScheduleSchema>;

// ---------------------------------------------------------------------------
// NPCs
// ---------------------------------------------------------------------------

/**
 * Marks an NPC as a merchant the trade intent can do business with. The vendor's STOCK is
 * simply the NPC entity's live inventory (seeded from the template's `inventory`), so buying
 * depletes it and selling grows it — no separate shop ledger. Prices are the item's base cost
 * (src/rules/items.ts `itemBaseCostCp`) × `priceModifier`; vendors do not track their own coins.
 */
/**
 * A SERVICE the vendor performs for a fee — sharpening, repair, appraisal, engraving (r8). A
 * service is work on the PLAYER'S property or person: the fee always flows player→NPC, and when
 * `custody` is set the serviced item stays WITH the NPC until `minutes` have passed (the
 * "ready by evening bell" shape), then comes back through the reducer. This is the authored,
 * programmatic answer to prose service deals resolving as half-price SALES (playtest r7 P1).
 */
export const VendorServiceSchema = z.object({
  id: Id,
  /** Player-facing label ("Sharpen and dress a blade"). */
  label: z.string(),
  /** Fee in copper pieces (1 sp = 10 cp, 1 gp = 100 cp). */
  priceCp: z.number().int().min(0),
  /** The work needs one of the player's carried items ("what am I sharpening?"). */
  needsItem: z.boolean().default(false),
  /** The item stays with the vendor while the work runs; implies `needsItem`. */
  custody: z.boolean().default(false),
  /** In-world minutes until a custody job is ready (0/absent ⇒ while you wait). */
  minutes: z.number().int().min(0).default(0),
});
export type VendorService = z.infer<typeof VendorServiceSchema>;

export const VendorSchema = z.object({
  /** Multiplier on the base price in copper (1.0 = list price; 1.5 = a gouger). */
  priceModifier: z.number().positive().default(1),
  /** Services on offer at this counter (r8) — see VendorServiceSchema. Optional (no default) so
   *  existing `{ priceModifier }` literals — tests, authored worlds — stay assignable unchanged. */
  services: z.array(VendorServiceSchema).optional(),
});
export type Vendor = z.infer<typeof VendorSchema>;

/**
 * A WORK opportunity — honest labor for coin (the job system). Attach one to a location (a
 * job board / place of work) or to an NPC who hires, and the `work` intent turns a shift into
 * a skilled-labor CHECK: the acting PC rolls `ability` vs `dc`; a success pays `wageCp`, a
 * botch `failWageCp`. The coin flows through the reducer's `adjustCoins` command — mechanics in
 * code, the model only narrates the toil. Emergent, NOT a wage-clock: a world authors a handful,
 * and each shift costs the standard time + energy (src/rules/costs.ts `work` row).
 */
export const WorkSchema = z.object({
  id: Id,
  /** Player-facing label ("Haul crates for the dockmaster", "Busk in the market"). */
  label: z.string(),
  /** The ability the labor tests (str = hauling, dex = fine work, cha = busking, …). */
  ability: z.enum(["str", "dex", "con", "int", "wis", "cha"]).default("str"),
  /** Optional skill tag; a matching PC proficiency adds the standard +2 (the check convention). */
  skill: z.string().optional(),
  /** Difficulty of the shift. Clamped to the check band [5,30] at resolve time. */
  dc: z.number().int().min(1).max(40).default(12),
  /** Copper paid on a successful shift. */
  wageCp: z.number().int().positive().default(50),
  /** Copper paid on a botched shift (default 0 — no pay for bad work). */
  failWageCp: z.number().int().nonnegative().default(0),
  /** Optional gate — this shift is only offered/takeable when the predicate holds (the reputation
   *  gate: better-paying work unlocks as guild standing rises via `factionStandingAtLeast`, or after
   *  proving yourself with `workedOpportunity`). Absent ⇒ always available (legacy byte-stable). */
  requires: TriggerPredicateSchema.optional(),
  /**
   * In-world MINUTES the shift takes. Every job used to cost one flat hour, so Anchorfall's
   * "coin at day's end" barge work — authored as a day's labor — resolved in an hour and the
   * playtester read the economy as "a slot machine button" (2026-07-24 P2). Author a real day at
   * 480. Absent ⇒ the flat `TURN_COSTS.work` row, so existing worlds are byte-identical.
   */
  minutes: z.number().int().positive().optional(),
  /**
   * Days that must pass before this shift can be worked again. Nothing bounded repetition before:
   * `workHistory` counted lifetime shifts and its only reader used that as an UNLOCK, so working
   * paid strictly better the more you did it and the board could be farmed. Absent ⇒ repeatable,
   * as before (energy is then the only brake).
   */
  cooldownDays: z.number().int().nonnegative().optional(),
});
export type Work = z.infer<typeof WorkSchema>;

// ---------------------------------------------------------------------------
// Epistemic layer — canonical world facts + per-NPC knowledge grants
// (NPC-EPISTEMIC-CONTEXT-PLAN §7). All additive: worlds that author none parse
// and re-serialize byte-identically, and every reader folds absence to empty.
// ---------------------------------------------------------------------------

/**
 * Temporal status of a canonical fact. `current` answers practical present-day questions;
 * `historical`/`defunct` may NEVER be phrased as the current answer (hard invariant 6/7 of the
 * epistemic plan) — they answer only history questions or trail a current answer as color.
 * `rumor` is hearsay at the world level: retrievable, but always qualified and never authoritative.
 */
export const FACT_KINDS = ["current", "historical", "defunct", "rumor"] as const;

/**
 * Who plausibly knows a fact. This is ACCESS, not player-facing secrecy: "common" = anyone;
 * "local" = people whose home/current region (or roster location) is in scope; "faction" = members
 * of a scoped faction; "professional" = characters whose own authored knowledge shares a domain;
 * "restricted" = only NPCs holding an explicit knowledge entry that names this fact id.
 * Player-secret world truth stays where it already lives: secret-tagged `World.lore` (DM-only).
 */
export const FACT_ACCESS = ["common", "local", "faction", "professional", "restricted"] as const;

/**
 * One canonical, code-addressable proposition of world truth (epistemic plan §7.1). Facts carry
 * what prose lore cannot: temporal status, plausible-access scope, and supersession — so code (not
 * semantic retrieval) decides which proposition answers "where is the closest guild?" today.
 * Mutable CURRENT truth (what the reducer owns) always outranks a static fact; these rows are the
 * authored baseline. `validFrom`/`validUntil` are narrative-era labels ("twenty years ago"), never
 * game-clock values.
 */
export const WorldFactSchema = z.object({
  id: Id,
  /** The proposition itself, phrased as a statement of fact the model may voice. */
  statement: Prose,
  /** Entities/locations/factions/items this fact is ABOUT (grounds subject matching). */
  subjectIds: z.array(Id).default([]),
  /** Retrieval topics ("guilds", "trade", "history") — free vocabulary, no forced taxonomy. */
  domains: z.array(z.string()).default([]),
  kind: z.enum(FACT_KINDS).default("current"),
  /** Where/for whom this fact is plausibly known (see FACT_ACCESS). Empty ⇒ unscoped. */
  scope: z
    .object({
      locationIds: z.array(Id).default([]),
      /** Region TAGS (`Location.region` strings), not `world.regions[]` rows — same rule as `inRegion`. */
      regionIds: z.array(z.string()).default([]),
      factionIds: z.array(Id).default([]),
    })
    .default({}),
  access: z.enum(FACT_ACCESS).default("common"),
  /** Narrative-era label for when this became true ("after the Sundering"). Display/authoring only. */
  validFrom: z.string().optional(),
  /** Narrative-era label for when it STOPPED being true. Set ⇒ the fact can never answer a current ask. */
  validUntil: z.string().optional(),
  /** The fact that replaced this one. Set ⇒ this fact is history; the chain must be acyclic (loader). */
  supersededBy: Id.optional(),
  /** Where the proposition comes from, for authoring provenance ("guild charter rolls"). */
  sourceLabel: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type WorldFact = z.infer<typeof WorldFactSchema>;

/** How willing the holder is to SAY a thing they know (epistemic plan §6.6). Knowing ≠ volunteering. */
export const DISCLOSURE_MODES = ["open", "asked-only", "reluctant", "trust", "never", "misdirect"] as const;

/**
 * One structured knowledge grant: this NPC knows a proposition — either a canonical world fact
 * (`factId`) or a personal statement with no global row (`statement`; at least one is required,
 * enforced by the loader). Familiarity/certainty qualify HOW they know it; `disclosure` decides
 * whether the exact text may enter a reply packet at the current relationship, or only a
 * concealment cue (`topic` is the spoiler-free label those cues use). Legacy plain-string
 * `knowledge[]` entries remain valid — they parse unchanged and keep feeding semantic retrieval.
 */
export const NpcKnowledgeEntrySchema = z.object({
  /** Canonical fact this grant references (preferred when the proposition is shared world truth). */
  factId: Id.optional(),
  /** Personal proposition, second person ("You were there when…"). Used when no world fact fits. */
  statement: Prose.optional(),
  /** Short public label for concealment cues ("why the guild fell") — shown INSTEAD of the secret. */
  topic: z.string().optional(),
  domains: z.array(z.string()).default([]),
  familiarity: z.enum(["heard-of", "competent", "expert", "firsthand"]).default("competent"),
  certainty: z.enum(["rumor", "uncertain", "confident", "certain"]).default("confident"),
  /** Where they got it ("saw it happen", "tavern talk"). Provenance, kept out of the packet text. */
  source: z.string().optional(),
  learnedAt: z.string().optional(),
  lastConfirmedAt: z.string().optional(),
  disclosure: z
    .object({
      mode: z.enum(DISCLOSURE_MODES).default("open"),
      /** Friendship gauge floor for `trust` mode (−100..100). Absent ⇒ the code default (50). */
      minFriendship: z.number().min(-100).max(100).optional(),
      /** Why they hold it back — behavioral color for the concealment cue, never the secret itself. */
      reason: z.string().optional(),
    })
    .default({ mode: "open" }),
});
export type NpcKnowledgeEntry = z.infer<typeof NpcKnowledgeEntrySchema>;

/**
 * A significant NPC defined at the World level. When traveling with the party, this is
 * also the agent the Director may schedule for autonomous turns.
 */
export const NpcTemplateSchema = z.object({
  id: Id,
  name: z.string(),
  /** Short summary the GM/clients show. */
  summary: z.string().default(""),
  /** The in-character system prompt seed — voice, manner, values. */
  persona: Prose,
  /** Legacy physical-description prose (mirrors {@link IdentitySchema.description}); clothing
   * lives in items/wardrobe. Structured facets live in `body` (from IdentitySchema.shape). */
  appearance: Prose.default(""),
  ...IdentitySchema.shape,
  /** What this NPC wants; drives proactive behavior. */
  goals: z.array(z.string()).default([]),
  /**
   * What this NPC knows (seeds memory; gated by retrieval at play time). Accepts BOTH legacy plain
   * strings and structured {@link NpcKnowledgeEntrySchema} grants (epistemic plan §7.2) — readers
   * that need flat text fold through `knowledgeStatements` (src/knowledge/facts.ts).
   */
  knowledge: z.array(z.union([z.string(), NpcKnowledgeEntrySchema])).default([]),
  /**
   * Secrets this NPC KNOWS but conceals (epistemic plan §7.3) — the fix for `hiddenLore`'s split
   * semantics: hiddenLore is truth the character does NOT know (GM-only), while these entries are
   * the character's own guarded knowledge, filtered per-turn by their disclosure policy. Below the
   * disclosure bar only a `topic` concealment cue reaches the prompt, never the statement text.
   */
  privateKnowledge: z.array(NpcKnowledgeEntrySchema).optional(),
  /**
   * Truths about this NPC that the DM knows and the character does NOT (epistemic plan §7.3) — the
   * explicit successor to `hiddenLore`'s strict meaning. NEVER enters any NPC prompt on any path.
   */
  gmTruth: Prose.optional(),
  /** Relationship scores toward other entities by id (−100..100). */
  relationships: z.record(Id, z.number().min(-100).max(100)).default({}),
  /** Optional faction membership. */
  factionId: Id.optional(),
  /** Combat/skill stats (optional for purely social NPCs). */
  stats: StatBlockSchema.optional(),
  /** Item ids carried at spawn — a vendor's stock, or an armed NPC's sidearm. */
  inventory: z.array(Id).default([]),
  /** Present ⇒ this NPC trades; stock = the entity's inventory (see VendorSchema). */
  vendor: VendorSchema.optional(),
  /** Work this NPC hires for (the job system) — offered whenever the NPC is present. Optional/additive. */
  work: z.array(WorkSchema).optional(),
  /** Spells this NPC will TEACH a co-located caster (a spell tutor / mentor) — one of the magic
   *  acquisition surfaces. Each entry references a World.spell; `costCoins` is the tuition (0 = free).
   *  Optional/additive — absent ⇒ the NPC teaches nothing. */
  teaches: z
    .array(z.object({ spellId: Id, costCoins: z.number().int().nonnegative().default(0) }))
    .default([]),
  /** NPC-only alignment preset id; PCs remain player-driven and do not declare alignment here. */
  alignment: AlignmentSchema.optional(),
  /** NPC-only personality archetype preset id. */
  personalityTemplate: Id.optional(),
  /**
   * In-world age in years. Optional; feeds the minor-safety guard's declared-participant
   * protection (a sub-18 NPC present in the scene is protected regardless of prose distance).
   */
  age: z.number().int().nonnegative().optional(),
  /** Explicit minor flag for the minor-safety guard (supplements `age`; either marks a minor). */
  isMinor: z.boolean().optional(),
  /**
   * Explicit author-declared 18+ flag for the minor-safety guard. Narrower than it sounds: it
   * does NOT grant an unconditional pass — it only lets an unambiguous minor-coded word the model
   * generates (e.g. a stray "child" echoing a "childlike"/petite/waifish description) be routed to
   * the model judge instead of an instant block, for output already known to involve only declared
   * confirmed 18+ participants. The declared-minor and assault-verb paths are never affected.
   */
  ageIsAdult: z.boolean().optional(),
  /** Manner-of-speech tags ("clipped", "proverb-quoting") the NPC agent voices consistently. */
  voiceTags: z.array(z.string()).optional(),
  /** The NPC's place in the location's social fabric ("ferry hand around the docks"). */
  socialRole: z.string().optional(),
  /** Small likes/dislikes ("likes strong drink", "avoids priests") that keep scenes consistent. */
  preferences: z.array(z.string()).optional(),
  /** Observer-side reactive lines this NPC holds ("dislikes arrogance", "wary of authority") — read
   *  against a target's perceived appearance/presentation signals to color disposition. */
  boundaries: z.array(z.string()).optional(),
  /**
   * Marks a HOSTILE NPC that preys on the party — one that reads the PC as something to be used,
   * robbed or leaned on rather than dealt with. Default false. Feeds the `exploitative` stance in
   * `rules/agenda.ts`, which raises the contest DC on demands and pressure and keeps such an NPC
   * out of the ambient-background classification. It grants no mechanic of its own.
   */
  exploitative: z.boolean().default(false),
  /** Proactive-NPC configuration. */
  autonomy: AutonomySchema.default({}),
  /** Daily/weekly routine (day-phase slots). Absent ⇒ the NPC never moves on its own. */
  schedule: NpcScheduleSchema.optional(),
  /** Personal random events (co-located scenes / offstage rumors). Absent ⇒ none. */
  events: z.array(z.lazy(() => NpcEventSchema)).optional(),
});
export type NpcTemplate = z.infer<typeof NpcTemplateSchema>;

// ---------------------------------------------------------------------------
// World geography & lore
// ---------------------------------------------------------------------------

/**
 * What bars an exit and how it opens (Workstream H). CONTENT only — the authored, immutable
 * description of the obstacle. The mutable answer to "is it locked RIGHT NOW?" lives in the
 * WorldModel's `exitState` overlay slice (src/rules/exit-state.ts), written only by the reducer's
 * `setExitState` — so runtime lock changes persist and replay like every other fact.
 *
 * A barrier's INITIAL state derives from its kind: `rubble` starts "blocked" (a physical
 * obstruction — force is the only way through), everything else starts "locked". Open paths:
 *  - `keyItemId`: holding the item opens it on the way through (no roll);
 *  - `condition`: the predicate holding opens it (quest state, a flag, …);
 *  - `dc`: a finesse check (lockpicking, unfastening) unlocks it → "open";
 *  - `breakDc`: brute force breaks it → "broken" (permanently open, and audibly so).
 * A barrier authoring NONE of these is impassable until something else (an event, a scripted
 * `setExitState`) opens it. Barriers are directed like the exits they ride; the reducer mirrors
 * a state change onto the reverse exit when one exists (a door is one object seen from two sides).
 */
export const ExitBarrierSchema = z.object({
  kind: z.enum(["door", "gate", "rubble", "magical"]).default("door"),
  /** Item id that opens this barrier when carried (checked against the mover's inventory). */
  keyItemId: Id.optional(),
  /** DC to pick/unfasten (a dex check) — success unlocks. Absent ⇒ cannot be picked. */
  dc: z.number().int().min(1).max(40).optional(),
  /** DC to force/break (a str check) — success breaks it open for good. Absent ⇒ cannot be forced. */
  breakDc: z.number().int().min(1).max(40).optional(),
  /**
   * Predicate that opens the barrier: evaluated at the moment of a traversal attempt, and when
   * it holds the exit is opened PERMANENTLY (a real `setExitState` — it does not re-lock if the
   * predicate later turns false). Player-attempt-time only; NPC movement never evaluates it.
   */
  condition: TriggerPredicateSchema.optional(),
  /** Player-facing description of the obstacle ("a rusted iron gate"); defaults by kind. */
  description: z.string().optional(),
});
export type ExitBarrier = z.infer<typeof ExitBarrierSchema>;

/**
 * A first-class exit out of a location. Replaces the bare `connections: Id[]` graph: same
 * shape whether authored or generated. The loader normalizes legacy `connections` into
 * `exits` (src/content/loader.ts), so older worlds load unchanged.
 */
export const ExitSchema = z.object({
  /** Destination location id. */
  to: Id,
  /** Optional compass/relative direction ("north", "down"). */
  direction: z.string().optional(),
  /** Optional player-facing label ("the oak door"); defaults to the destination name. */
  name: z.string().optional(),
  locked: z.boolean().default(false),
  /** Hidden until discovered — not shown as an exit or offered to the classifier. */
  hidden: z.boolean().default(false),
  /**
   * The obstacle on this exit, if any (Workstream H). Additive: barrier-less exits parse, play,
   * and render byte-identically to before the field existed. `locked: true` WITHOUT a barrier
   * keeps its legacy meaning — impassable, no unlock path.
   */
  barrier: ExitBarrierSchema.optional(),
  /**
   * In-world MINUTES this crossing takes. Travel used to cost one flat 30-minute row for every hop,
   * so the 2026-07-24 playtest's eight-hour march down the west road — narrated as an eight-hour
   * march, planned around as an eight-hour march — moved the clock half an hour, and the day never
   * turned over. Author it where the fiction has a distance; absent ⇒ the flat cost-table row, so
   * every existing world and test travels exactly as before.
   */
  minutes: z.number().int().positive().optional(),
});
export type Exit = z.infer<typeof ExitSchema>;

/** A rule for spawning transient extras into a location on entry (a market crowd, a pack). */
export const SpawnRuleSchema = z.object({
  /** World.npcs / World.monsters template to instantiate. */
  templateId: Id,
  tier: z.enum(["transient", "tracked", "significant"]).default("transient"),
  /** Maximum simultaneously present from this rule. */
  max: z.number().int().positive().default(1),
});
export type SpawnRule = z.infer<typeof SpawnRuleSchema>;

/**
 * Marks a location as an ADVENTURE GUILD hall — the only building where paid work and generic
 * bounties are acquired. Owner decision (2026-07-22): jobs stopped being ambient/scattered; the
 * job board (`Location.work[]`) is now surfaced ONLY at a `guild` location, and generic bounties are
 * offered by entering a hall while its guildmaster is present (ordinary quest-offer events anchored
 * to the hall). Story quests keep their own diegetic givers and are unaffected.
 *
 * A location-level marker: the labor still lives in `Location.work[]`; this flag is the gate. The
 * `clerkId` NPC is the diegetic VOICE of the board (a `workInquiry` routes through them). Optional/
 * no-default ⇒ worlds without a guild re-serialize byte-identically (`campLocation` precedent), and
 * a location that authors `work[]` WITHOUT `guild` simply never surfaces it — that IS the invariant.
 */
/**
 * A single rentable lodging TIER at a guild hall (the "hall as hub" wave). Renting a room teleports
 * the PC ALONE into the synthetic private room (`src/world/lodging.ts`, the camp precedent) for the
 * night — full recovery on waking, but the privacy is the risk: a `private` tier escapes the
 * public-venue exploitation damp (the room is not a `guild` location, so `opportunity.ts` scores it
 * isolated), so a room-events intrusion can strike a lone sleeper. A `shared bunk` tier
 * (`private: false`) stays cheap and safe (co-lodgers damp the drive) — the coin ↔ privacy ↔ safety
 * trade. All numbers are data; the resolver (`resolveRentRoom`) is the coin/affordability authority.
 */
export const LodgingTierSchema = z.object({
  id: Id,
  /** Player-facing label ("a private room", "a bunk in the common loft"). */
  label: z.string(),
  /** Copper charged per night, paid at rent time via `adjustCoins`. */
  nightlyCp: z.number().int().nonnegative().default(20),
  /** A private room spikes exploitation opportunity (isolated, no crowd); a shared bunk stays damped. */
  private: z.boolean().default(true),
});
export type LodgingTier = z.infer<typeof LodgingTierSchema>;

export const LodgingSchema = z.object({
  /** Flavor name for the beds on offer ("the cots under the eaves"). Optional. */
  roomName: z.string().optional(),
  /** The rentable tiers — at least one. The UI surfaces each as a "bed down" affordance. */
  tiers: z.array(LodgingTierSchema).min(1),
});
export type Lodging = z.infer<typeof LodgingSchema>;

export const GuildSchema = z.object({
  /** Player-facing hall name ("The Broken Crown contract-hall"). */
  name: z.string(),
  /** The guildmaster NPC who VOICES the board for a workInquiry. Absent ⇒ the claims-board fixture line. */
  clerkId: Id.optional(),
  /** The confederation/company that runs the hall (e.g. `faction.free-lances`) — flavor/UI tag only. */
  factionId: Id.optional(),
  /** Rentable beds at this hall (the hall-as-hub wave). Absent ⇒ no lodging, world re-serializes
   *  byte-identically (the `guild` no-default precedent). */
  lodging: LodgingSchema.optional(),
  /** A hireable-mercenary board at this hall (the hall-as-hub wave). Absent ⇒ no merc board. The
   *  offers are generated deterministically per (hall, day, slot) — the reducer never persists the
   *  roster, only which slots were hired. */
  recruits: z.object({
    /** Upfront coin to sign a sellsword on. */
    hireCp: z.number().int().nonnegative().default(40),
    /** Per-day wage owed to a hired merc (spent by the Phase-C upkeep tick). */
    wageCp: z.number().int().nonnegative().default(5),
    /** How many mercenaries stand on the board at once (refreshed daily). */
    slots: z.number().int().positive().max(6).default(3),
  }).optional(),
});
export type Guild = z.infer<typeof GuildSchema>;

export const LocationSchema = z.object({
  id: Id,
  name: z.string(),
  description: Prose.default(""),
  /** Legacy directed graph; normalized into `exits` by the loader. */
  connections: z.array(Id).default([]),
  /** First-class exits (authored or generated). Empty → derived from `connections`. */
  exits: z.array(ExitSchema).default([]),
  /** Optional region this location belongs to (anchors generate-then-freeze map gen). */
  region: Id.optional(),
  /** Transient-extra spawn rules evaluated on party entry. */
  spawns: z.array(SpawnRuleSchema).default([]),
  /** NPC ids typically present. Seeded as tracked entities at this location. */
  npcs: z.array(Id).default([]),
  /** Work available HERE (the job system) — a job board. Surfaced ONLY when `guild` is present (owner
   *  decision 2026-07-22: jobs are guild-only, never ambient). Optional/additive. */
  work: z.array(WorkSchema).optional(),
  /** Marks this location an adventure-guild hall (gates `work[]` + hosts bounty offers). Optional. */
  guild: GuildSchema.optional(),
  /** Author-friendly inspectables/rumors/secrets/etc. Compiled into ordinary prebaked events at load. */
  interactions: z.array(z.lazy(() => LocationInteractionSchema)).optional(),
  /**
   * 2D map coordinates. Dead-reckoned at generation (src/world/expansion.ts) or stamped by the
   * loader's fill-only layout pass (src/world/coords.ts). PURE PASSENGER CONTENT — the reducer and
   * WorldModel read only `exits`, never x/y, so coordinates ride the existing `worldExpanded` delta
   * and persist as JSON with no new delta kind. Optional/no-default: worlds authored before the map
   * system parse and re-serialize byte-identically; readers treat absence as "unplaced".
   */
  x: z.number().optional(),
  y: z.number().optional(),
});
export type Location = z.infer<typeof LocationSchema>;

export const FactionSchema = z.object({
  id: Id,
  name: z.string(),
  description: Prose.default(""),
  goals: z.array(z.string()).default([]),
  /** Standing toward other factions by id (−100..100). */
  relationships: z.record(Id, z.number().min(-100).max(100)).default({}),
});
export type Faction = z.infer<typeof FactionSchema>;

export const LoreEntrySchema = z.object({
  id: Id,
  title: z.string(),
  body: Prose,
  /** Tags for retrieval/grouping. */
  tags: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// World constitution
// ---------------------------------------------------------------------------

/** Feature toggles an author flips to steer engine registration. */
export const ContentTogglesSchema = z.object({
  /**
   * First-class scene registry + terminator watchdog (Concordia transfer #6): mirrors the live
   * scene-shaped slices into `modules.scenes` rows and force-ends a combat its own reap stranded
   * (the reap runs only on player ticks; the watchdog runs on every tick). OFF by default —
   * off ⇒ the module is never registered and every existing world's event stream is byte-identical.
   */
  scenes: z.boolean().default(false),
});

/**
 * One authored defeat consequence (Workstream E). Additive + optional; a world that authors none
 * keeps the historic 1-HP revival on a lost fight (the selector returns null → the caller falls
 * back). `effects` mirror reducer `Command`s as permissive records — the reducer is the sole
 * validator of a command at apply time, so this schema does not re-encode the Command union (it
 * would drift); the runtime `DefeatOutcome` type in `src/rules/defeat-outcomes.ts` is the typed
 * shape authors code against.
 */
export const DefeatOutcomeSchema = z.object({
  id: Id,
  /** Relative weight for the seeded pick (> 0 to be selectable). */
  weight: z.number().positive(),
  tags: z.array(z.string()).optional(),
  /** Excluded if ANY of these world flags is truthy. */
  blockedByFlags: z.array(z.string()).optional(),
  /** Excluded unless ALL of these world flags are truthy. */
  requiredFlags: z.array(z.string()).optional(),
  /** Scenario gate — WHO beat you (ANY-of): a `factionId`, an entity `kind`, or a truthy
   *  entity-flag key on a surviving victor. Lets one world offer different bad ends per foe. */
  requiresVictorTags: z.array(z.string()).optional(),
  /** Scenario gate — excluded if a surviving victor carries ANY of these tags (mirror of the above). */
  blockedByVictorTags: z.array(z.string()).optional(),
  /** Scenario gate — HOW the bad end was reached (for example `"combat-defeat"`). */
  requiresCause: z.array(z.string()).optional(),
  /** Reducer commands. Permissive shape, but each effect's `type` is checked against the known command
   *  vocabulary here so a typo fails at WORLD-LOAD (not mid-tick); the runtime preflight + the reducer's
   *  default case remain the net for anything dynamic. */
  effects: z
    .array(
      z
        .record(z.string(), z.any())
        .refine(
          (e) => typeof e.type === "string" && COMMAND_TYPES.has(e.type as CommandType),
          (e) => ({ message: `unknown defeat-outcome effect type: ${String((e as { type?: unknown }).type)}` }),
        ),
    )
    .default([]),
  /** Authoritative "this happened" text handed to the narrator. */
  narratorBrief: z.string(),
});

/**
 * A world's constitution — the authored steering layer. Optional/defaulted throughout.
 */
export const WorldConstitutionSchema = z.object({
  toggles: ContentTogglesSchema.default({}),
  /**
   * Runtime-readable world DIFFICULTY 0–3 (0 cozy … 3 deadly), persisted from the genome `danger`
   * dial by the worldsmith. Defaults to 1 so every existing world validates unchanged. Read by the
   * threat ecology as a frequency multiplier and available to any future difficulty-aware rule.
   */
  danger: z.number().int().min(0).max(3).default(1),
  /**
   * Optional data-driven defeat outcomes (Workstream E). Empty (the default) ⇒ a lost fight keeps
   * the historic 1-HP revival, UNLESS `useGenericDefeatOutcomes` is on. When authored, these WORLD-CUSTOM
   * outcomes are pooled with the engine generics (if toggled) and a lost fight selects one gate-eligible
   * outcome by a seeded weighted pick — scenario-fit via victor-tag / cause gates.
   */
  defeatOutcomes: z.array(DefeatOutcomeSchema).default([]),
  /**
   * Opt IN to the engine's SHARED FANTASY bad-end library (`buildGenericDefeatOutcomes`) — pooled with
   * any world-custom `defeatOutcomes` at defeat time, so a fantasy world gets rich, situation-fit bad
   * ends (robbed by brigands, dragged to a beast's lair) WITHOUT authoring its own.
   * Default false so every existing non-fantasy/legacy world is byte-identical; the worldsmith turns it on
   * for generated worlds. Effects are portable within the fantasy assumption (player coins / world flags /
   * clock). A non-fantasy world (sci-fi, modern) should leave this off and author its own
   * `defeatOutcomes` instead.
   */
  useGenericDefeatOutcomes: z.boolean().default(false),
});
export type WorldConstitution = z.infer<typeof WorldConstitutionSchema>;

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/**
 * One gazetteer entry — a rumored or known point of interest beyond the playable map (the hybrid
 * world shape). Guidance surfaces such as the brief's `Nearby:` line read these as
 * the author-canon breadcrumb trail; Phase 4 teaches the worldsmith to seed them and frontier
 * expansion to REALIZE them (the terminal pocket room becomes the entry). Pure content — no state.
 */
export const GazetteerEntrySchema = z.object({
  id: Id,
  name: z.string(),
  /** Coarse one-word category, rendered as the entry's kind tag ("Thornmere (town)"). */
  kind: z.enum(["city", "town", "ruin", "wilds", "poi"]),
  /** Player-facing one-liner ("a swamp town, somewhere east"). */
  summary: z.string().default(""),
  /** Optional region this entry belongs to. */
  region: z.string().optional(),
  /** Optional adventure hooks anchored on this place. */
  hooks: z.array(z.string()).optional(),
});
export type GazetteerEntry = z.infer<typeof GazetteerEntrySchema>;

/**
 * A first-class REGION — the steering layer that lets one world play at many tempos. Keyed by the
 * existing `Location.region` / `GazetteerEntry.region` tag (a region row's `id` matches those
 * strings). Every field is optional/defaulted, and `WorldSchema.regions` defaults to `[]`, so a
 * world that authors none re-serializes byte-identically and `regionProfileOf` (src/rules/regions.ts)
 * returns the world-level fallback everywhere — no behavior changes until a world opts in.
 *
 * AUTHORING RULE: `ambientPool` / `threatPool` must reference GENERIC crowd / monster templates,
 * never a scheduled roster NPC (an NPC listed in some `Location.npcs`). Ambient extras spawn as
 * `template#n` transient instances the RoutineModule never reconciles; pointing a pool at a real
 * roster NPC would clone a scheduled character. A test guards this.
 */
export const RegionSchema = z.object({
  id: Id,
  name: z.string(),
  /** Player-facing one-liner (unused by the engine today; authoring/editor convenience). */
  summary: z.string().default(""),
  /**
   * Region difficulty 0–3. ABSENT ⇒ inherits `WorldConstitution.danger` (kept optional so the
   * resolver distinguishes "unset" from "authored the world default"). Feeds threat ecology and
   * the exploitation scorer as a frequency dial; it never touches the minor-safety line.
   */
  danger: z.number().int().min(0).max(3).optional(),
  /** Foot-traffic / popularity 0–3 (1 = the neutral middle). Scales ambient-NPC density + crowd prose. */
  crowd: z.number().min(0).max(3).default(1),
  /** Multiplier on `campaign.travelEventChance` for arrivals in this region (1 = unchanged). */
  eventRate: z.number().min(0).default(1),
  /** Region-flavored ambient extras spawned on entry (farmers/merchants vs raiders). Reuses SpawnRule. */
  ambientPool: z.array(SpawnRuleSchema).default([]),
  /** Off-roster threats that may ambient-spawn in dangerous wilds. */
  threatPool: z.array(SpawnRuleSchema).default([]),
  /** Override the danger-derived threat share (0..1). ABSENT ⇒ `dangerThreatShare(effectiveDanger)`. */
  threatShare: z.number().min(0).max(1).optional(),
});
export type Region = z.infer<typeof RegionSchema>;

export const WorldSchema = z.object({
  id: Id,
  name: z.string(),
  /** One-paragraph pitch of the setting. */
  summary: z.string().default(""),
  /**
   * Authored narration STYLE for the GM's prose — a short list of tone/register directives the DM
   * system prompt follows (register, sentence rhythm, imagery to favor/avoid). OPTIONAL/no-default:
   * absent ⇒ the GM prompt is byte-identical to before this existed and the world re-serializes
   * unchanged (gazetteer/campLocation precedent). Authored per-world; exposed in the world editor.
   */
  style: z.array(z.string()).optional(),
  lore: z.array(LoreEntrySchema).default([]),
  /**
   * Canonical world facts — the epistemic layer's operational propositions (temporal status,
   * plausible access, supersession; see {@link WorldFactSchema}). OPTIONAL with no default
   * (gazetteer precedent): an unauthored world parses and re-serializes byte-identically, and
   * every reader folds absence to the empty list. Prose `lore` stays the reference/flavor layer;
   * facts are what code SELECTS from when a question needs the right truth, not the nearest text.
   */
  facts: z.array(WorldFactSchema).optional(),
  factions: z.array(FactionSchema).default([]),
  locations: z.array(LocationSchema).default([]),
  npcs: z.array(NpcTemplateSchema).default([]),
  monsters: z.array(MonsterSchema).default([]),
  items: z.array(ItemSchema).default([]),
  spells: z.array(SpellSchema).default([]),
  /** Optional setting-specific rule overrides, applied over the bundled SRD. */
  houseRules: z.record(z.string(), z.unknown()).default({}),
  /**
   * Rumored/known points of interest beyond the playable map (hybrid-gazetteer shape). OPTIONAL
   * with no default: an unauthored world parses (and re-serializes) byte-identically, and every
   * reader folds absence to the empty list. Phase 4 wires worldsmith seeding + realization.
   */
  gazetteer: z.array(GazetteerEntrySchema).optional(),
  /**
   * First-class regions keyed by the `Location.region` tag. ABSENT/empty ⇒ `regionProfileOf`
   * (src/rules/regions.ts) falls back to `constitution.danger` everywhere ⇒ every existing world is
   * byte-identical and fully inert. Authored per-world; steers event rate, ambient density, and the
   * threat ecology per region.
   */
  regions: z.array(RegionSchema).default([]),
  /**
   * Per-frontier probability that pure-wander expansion mints a brand-new EMERGENT town — a
   * settlement NOT in the gazetteer, placed where the party wandered to (src/world/expansion.ts).
   * Rolled from an id-keyed private rng (per frontier id), so it never perturbs the shared seeded
   * stream. OPTIONAL/no-default: absent ⇒ off (only rumored/gazetteer towns appear), and existing
   * worlds re-serialize byte-identically. Playable worlds opt in by authoring a value.
   */
  emergentTownChance: z.number().min(0).max(1).optional(),
  /**
   * Opt-in seeded routines: when true, every named NPC WITHOUT an authored `schedule` gets a
   * conservative derived one at RUNTIME (days at its roster location, dusk at a keyed same-region
   * social venue — `deriveSchedule` in src/rules/routine.ts). Derived data only: never written
   * into content, never round-tripped by the editor; an authored `schedule` always wins.
   * OPTIONAL/no-default: absent ⇒ off, existing worlds byte-identical and fully inert.
   */
  seededRoutines: z.boolean().optional(),
  /**
   * Opt-in formative memories: when true, an NPC with little or no lived history recalls a handful
   * of beats DERIVED from its own authored role, faction, strongest bond and first goal
   * (`formativeMemories` in src/rules/formative-memory.ts), so a character does not read as though
   * it began existing when the player walked in. Derived data only: never written into the model,
   * never a delta, never round-tripped by the editor, and always ranked BELOW real recorded beats.
   * OPTIONAL/no-default: absent ⇒ off, existing worlds byte-identical and fully inert.
   */
  formativeMemories: z.boolean().optional(),
  /**
   * Master switch for procedural frontier expansion. ABSENT/true ⇒ crossing a `frontier:` exit mints
   * a pocket and naming an unrealized gazetteer rumor realizes it (default behavior). FALSE ⇒ both
   * generation triggers are inert and every frontier edge is suppressed from offering surfaces
   * (classifier grounding, CLI exit lists, narrator brief, leader nudge), while any
   * already-generated pockets still replay/reload verbatim (the reducer/replay/hydrate path is never
   * gated). A retained `frontier:` exit under FALSE is thus latent content — invisible and un-takeable
   * until the flag flips back to true. OPTIONAL/no-default (NOT `.default(true)`): absent ⇒ enabled
   * and existing worlds re-serialize byte-identically (emergentTownChance/seededRoutines precedent).
   */
  frontierExpansion: z.boolean().optional(),
  /**
   * Optional per-world theming for the synthetic Camp location (BG3-style long rest). NARROW by
   * design — name + description ONLY, so an author can never give Camp exits/coords and accidentally
   * make it explorable (the fixed id + empty exits are always stamped by `resolveCampLocation`,
   * src/world/camp.ts). Absent ⇒ a generic default Camp. Optional/no-default ⇒ existing worlds
   * re-serialize byte-identically.
   */
  campLocation: z.object({ name: z.string().default("Camp"), description: Prose.default("") }).optional(),
  /**
   * Optional per-world theming for the synthetic Captivity hold (bad-end follow-up). Same NARROW
   * shape + guard posture as `campLocation` — name + description ONLY, so a themed hold can never be
   * given exits/coords and made explorable (the fixed id + empty exits are always stamped by
   * `resolveCaptivityLocation`, src/world/captivity.ts). Absent ⇒ a generic default hold. Optional/
   * no-default ⇒ existing worlds re-serialize byte-identically.
   */
  captivityLocation: z.object({ name: z.string().default("Captivity"), description: Prose.default("") }).optional(),
  /** The authored steering layer. Defaulted so existing worlds validate unchanged. */
  constitution: WorldConstitutionSchema.default({}),
});
export type World = z.infer<typeof WorldSchema>;

// ---------------------------------------------------------------------------
// Player characters
// ---------------------------------------------------------------------------

export const CharacterSchema = z.object({
  id: Id,
  name: z.string(),
  ...IdentitySchema.shape,
  ancestry: z.string().default(""),
  class: z.string().default(""),
  level: z.number().int().positive().default(1),
  stats: StatBlockSchema,
  /**
   * In-world age in years. Optional; feeds the minor-safety guard (a sub-18 PC is protected by
   * id whenever present in the scene, regardless of prose distance).
   */
  age: z.number().int().nonnegative().optional(),
  /** Explicit minor flag for the minor-safety guard (supplements `age`; either marks a minor). */
  isMinor: z.boolean().optional(),
  /** Explicit author-declared 18+ flag for the minor-safety guard — see the NPC field of the same name. */
  ageIsAdult: z.boolean().optional(),
  /** Item ids currently carried. */
  inventory: z.array(Id).default([]),
  /** Starting purse in copper pieces. Optional so pre-economy characters parse unchanged. */
  coins: z.number().int().nonnegative().optional(),
  backstory: Prose.default(""),
});
export type Character = z.infer<typeof CharacterSchema>;

// ---------------------------------------------------------------------------
// Campaign: scenes, quests, starting state
// ---------------------------------------------------------------------------

export const QuestObjectiveSchema = z.object({
  id: Id,
  description: z.string(),
  done: z.boolean().default(false),
});

export const QuestSchema = z.object({
  id: Id,
  name: z.string(),
  description: Prose.default(""),
  objectives: z.array(QuestObjectiveSchema).default([]),
  /** "offered" = visibly on the table, awaiting the player's opt-in (accept → active, decline → hidden). */
  state: z.enum(["hidden", "offered", "active", "complete", "failed"]).default("hidden"),
  /**
   * Copper paid to the player the moment this quest transitions to "complete" (the engine's
   * `grantQuestReward` hook, mirroring the offer-surfacing hook). Optional so pre-reward quests
   * parse unchanged; absent/0 ⇒ narrative-only completion, exactly as before.
   */
  rewardCoins: z.number().int().nonnegative().optional(),
  /** Item ids materialized into the player's pack on completion (alongside `rewardCoins`).
   *  Optional/additive — pre-reward quests and raw fixtures parse unchanged. */
  rewardItems: z.array(Id).optional(),
  /** Experience awarded to the player on completion (folds into the `progression` slice, cascading
   *  level-ups). Optional/additive — absent/0 ⇒ no XP, exactly as before. */
  rewardXp: z.number().int().nonnegative().optional(),
  /**
   * The NPC who gave the quest. On completion the giver's regard for the PC warms (living
   * relationships, `grantQuestReward`). Optional/additive — absent ⇒ no relationship change.
   */
  giver: Id.optional(),
  /**
   * Minutes from ACCEPTANCE until this quest auto-fails (2026-07-25: deadlines with teeth). On the
   * active transition the engine arms an absolute `dueAtClock` into `modules.questDeadlines`
   * (`armQuestDeadlines`), THE RECORD renders the due phase/day on the quest's row, and the
   * quest-deadlines tick module fails the quest once the campaign clock passes it. Optional/
   * additive — absent ⇒ no deadline, exactly as before.
   */
  deadlineMinutes: z.number().int().positive().optional(),
  /**
   * The narrated beat when the deadline lapses (preferred over the engine's generic "the window
   * has closed" line). Optional/additive; only meaningful alongside `deadlineMinutes`.
   */
  deadlineFailText: Prose.optional(),
});
export type Quest = z.infer<typeof QuestSchema>;

export const QuestFlowTemplateSchema = z.enum([
  "delivery",
  "bounty",
  "investigation",
  "workReputation",
  "escort",
  "retrieveAndReturn",
  "unlockPassage",
  "factionIntroduction",
]);

export const QuestFlowInlineQuestSchema = QuestSchema.omit({ id: true }).partial().extend({ id: Id.optional() });

export const QuestFlowBeatSchema = z.object({
  locationId: Id.optional(),
  npcId: Id.optional(),
  text: Prose.default(""),
  conditions: z.array(ConditionSchema).default([]),
  effects: z.array(z.lazy(() => EffectSchema)).default([]),
  once: z.enum(["campaign", "visit", "always"]).default("campaign"),
});
export type QuestFlowBeat = z.infer<typeof QuestFlowBeatSchema>;

export const QuestFlowStageSchema = QuestFlowBeatSchema.extend({
  id: Id,
  objectiveId: Id.optional(),
});
export type QuestFlowStage = z.infer<typeof QuestFlowStageSchema>;

export const QuestFlowHandInSchema = QuestFlowBeatSchema.extend({
  objectiveId: Id.optional(),
  itemId: Id.optional(),
});
export type QuestFlowHandIn = z.infer<typeof QuestFlowHandInSchema>;

export const QuestFlowFailStateSchema = QuestFlowBeatSchema.extend({
  id: Id,
});

export const QuestFlowSchema = z.object({
  id: Id,
  questId: Id,
  template: QuestFlowTemplateSchema.default("delivery"),
  quest: QuestFlowInlineQuestSchema.optional(),
  offer: QuestFlowBeatSchema.optional(),
  acceptance: QuestFlowBeatSchema.optional(),
  stages: z.array(QuestFlowStageSchema).default([]),
  handIn: QuestFlowHandInSchema.optional(),
  failStates: z.array(QuestFlowFailStateSchema).default([]),
});
export type QuestFlow = z.infer<typeof QuestFlowSchema>;

export const LocationInteractionKindSchema = z.enum([
  "inspectable",
  "rumor",
  "secret",
  "localJob",
  "hazard",
  "clue",
  "factionNotice",
  "exitReveal",
]);

export const LocationInteractionSchema = z.object({
  id: Id,
  kind: LocationInteractionKindSchema.default("inspectable"),
  mode: z.enum(["auto", "action"]).default("action"),
  label: z.string().optional(),
  text: Prose.default(""),
  conditions: z.array(ConditionSchema).default([]),
  effects: z.array(z.lazy(() => EffectSchema)).default([]),
  revealExit: z.object({ to: Id, name: z.string().optional() }).optional(),
  once: z.enum(["campaign", "visit", "always"]).default("campaign"),
});
export type LocationInteraction = z.infer<typeof LocationInteractionSchema>;

export const SceneSchema = z.object({
  id: Id,
  name: z.string(),
  locationId: Id,
  /** GM-facing setup notes / read-aloud seed. */
  setup: Prose.default(""),
  /** NPC ids staged in this scene. */
  npcs: z.array(Id).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

/** Where and how a campaign begins. */
export const StartingStateSchema = z.object({
  locationId: Id,
  /** Campaign clock at start, in minutes (day = 1440; 480 = 08:00 morning). Absent ⇒ 0. */
  clock: z.number().int().nonnegative().optional(),
  /** PC ids in the starting party. */
  party: z.array(Id).default([]),
  /** NPC ids accompanying the party at the start. */
  companions: z.array(Id).default([]),
  /** Opening scene id, if any. */
  openingSceneId: Id.optional(),
});

// ---------------------------------------------------------------------------
// Prebaked events — authored trigger→effect beats (the events module, Phase 5).
// The trigger-predicate shapes (ConditionSchema / TriggerPredicateSchema) live above the
// geography section, since Exit barriers share them.
// ---------------------------------------------------------------------------

/** A scripted consequence. Non-narrate effects expand to reducer commands. */
const EffectBaseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("narrate"), text: z.string() }),
  z.object({ kind: z.literal("setFlag"), key: z.string(), value: z.unknown().optional() }),
  z.object({ kind: z.literal("setQuestState"), questId: Id, state: QuestStateEnum }),
  z.object({ kind: z.literal("setObjectiveDone"), questId: Id, objectiveId: Id, done: z.boolean().default(true) }),
  z.object({ kind: z.literal("adjustRelationship"), actorId: Id, targetId: Id, by: z.number() }),
  z.object({
    kind: z.literal("spawn"),
    templateId: Id,
    locationId: Id,
    tier: z.enum(["transient", "tracked", "significant"]).default("transient"),
  }),
  z.object({ kind: z.literal("adjustHp"), entityId: Id, by: z.number().int() }),
  z.object({ kind: z.literal("setCondition"), entityId: Id, condition: z.string(), active: z.boolean().default(true) }),
  z.object({ kind: z.literal("adjustCoins"), by: z.number().int(), target: Id.optional() }),
  z.object({ kind: z.literal("adjustEnergy"), by: z.number().int(), target: Id.optional() }),
  z.object({ kind: z.literal("adjustExhaustion"), by: z.number().int(), target: Id.optional() }),
  z.object({ kind: z.literal("transferItem"), itemId: Id, from: Id.nullable(), to: Id.nullable() }),
  z.object({
    kind: z.literal("setExitState"),
    locationId: Id,
    to: Id,
    state: z.enum(["open", "locked", "blocked", "broken"]),
  }),
  z.object({ kind: z.literal("linkExit"), fromLocationId: Id, to: Id, name: z.string().optional() }),
  // --- travel-event effects (expanded by TravelEventsModule; inert in prebaked events) ---
  /** Materialize an item straight into an entity's pack (default: the player). The courier's hand-off. */
  z.object({ kind: z.literal("giveItem"), itemId: Id, to: Id.optional() }),
  /** Spawn a hostile body and immediately open deterministic combat. */
  z.object({
    kind: z.literal("ambush"),
    templateId: Id,
    locationId: Id.optional(),
    hp: z.number().int().positive().optional(),
    name: z.string().optional(),
    tier: z.enum(["transient", "tracked", "significant"]).default("tracked"),
  }),
  /** Pin an NPC's routine to a location for N days (module-owned: NpcEventsModule folds it into a
   *  routines modulePatch and relocates the NPC immediately; inert in other expanders). `npcId`
   *  absent ⇒ the NPC the firing event belongs to. */
  z.object({
    kind: z.literal("routineOverride"),
    npcId: Id.optional(),
    locationId: Id,
    activity: z.string().optional(),
    days: z.number().int().positive().default(1),
  }),
  /** Reveal a case fact to the player (mystery wave). Usable in any interaction/event/quest beat; the
   *  expander (`effectToCommand`, with the campaign in hand) resolves the fact's text + the present
   *  witnesses into a `revealCaseFact` command. Blocked on `anywhere`-scope NPC events by the loader —
   *  an offstage rumor must never hand the player evidence (see `isInteractiveEffect`). */
  z.object({ kind: z.literal("revealCaseFact"), caseId: Id, factId: Id }),
]);
type EffectBase = z.infer<typeof EffectBaseSchema>;
type CheckEffect = {
  kind: "check";
  ability: keyof AbilityScores;
  dc: number;
  bonus?: number;
  onSuccess: Effect[];
  onFail: Effect[];
};
export type Effect = EffectBase | CheckEffect;

const CheckEffectSchema: z.ZodType<CheckEffect, z.ZodTypeDef, unknown> = z.object({
  kind: z.literal("check"),
  ability: z.enum(["str", "dex", "con", "int", "wis", "cha"]),
  dc: z.number().int(),
  bonus: z.number().int().optional(),
  onSuccess: z.lazy(() => z.array(EffectSchema)).default([]),
  onFail: z.lazy(() => z.array(EffectSchema)).default([]),
});
export const EffectSchema: z.ZodType<Effect, z.ZodTypeDef, unknown> = z.union([EffectBaseSchema, CheckEffectSchema]);

export const PrebakedEventSchema = z.object({
  id: Id,
  /** When the events module considers this beat. */
  when: z.enum(["onEnterLocation", "onTick", "onCommand"]).default("onEnterLocation"),
  trigger: TriggerPredicateSchema.default({ allOf: [] }),
  effects: z.array(EffectSchema).default([]),
  /** Fire once per campaign, once per location-visit, or every time the trigger holds. */
  once: z.enum(["campaign", "visit", "always"]).default("campaign"),
});
export type PrebakedEvent = z.infer<typeof PrebakedEventSchema>;

/**
 * A DoL-style random travel event — rolled on ARRIVAL at a new location by the TravelEventsModule.
 * The eligible set (predicate holds + `once`/cooldown clear) is weighted-picked with a private keyed
 * RNG. Reuses the shared Effect + Condition vocabulary; `weight` and `cooldownMoves` are the only
 * new dials. `once: "always"` (the default) may re-fire; `"campaign"` fires at most once per playthrough.
 */
export const TravelEventSchema = z.object({
  id: Id,
  /** Relative selection weight within the eligible set (higher ⇒ more likely). */
  weight: z.number().positive().default(1),
  /** Moves that must pass after this fires before it may fire again (0 ⇒ no per-event cooldown). */
  cooldownMoves: z.number().int().nonnegative().default(0),
  /** Fire once per campaign, or on every eligible roll ("always"). No "visit" — travel events are move-scoped. */
  once: z.enum(["campaign", "always"]).default("always"),
  trigger: TriggerPredicateSchema.default({ allOf: [] }),
  effects: z.array(EffectSchema).default([]),
  /**
   * Whether this event may fire while the party is at Camp (long rest). OPTIONAL/no-default: absent ⇒
   * DERIVED — camp-safe iff no effect spawns or ambushes an adversary (a courier can find you at
   * camp, a random attack cannot). An explicit value overrides the derivation. See `isCampSafe`
   * in src/rules/travel-events.ts. Existing worlds re-serialize byte-identically.
   */
  campSafe: z.boolean().optional(),
});
export type TravelEvent = z.infer<typeof TravelEventSchema>;

/**
 * A personal random event on an NPC template — rolled once per (npc, day-phase) by the
 * NpcEventsModule with private keyed rng. `scope` decides how it lands: `"co-located"` plays out
 * on screen (eligible only while the player shares the NPC's effective location); `"anywhere"`
 * applies its effects offstage and queues each `narrate` text as a RUMOR delivered later at a
 * social venue. Reuses the shared Effect + Condition vocabulary; day-based cooldowns replay
 * exactly. The loader refuses interactive effects (check/ambush, giveItem without
 * an explicit `to`) on `"anywhere"` events — offstage life must not reach into the player's turn.
 */
export const NpcEventSchema = z.object({
  id: Id,
  /** Day phases this event may fire in; absent ⇒ any phase. */
  phases: z.array(DayPhaseSchema).optional(),
  /** Days of week (campaign day % 7); absent ⇒ every day. */
  days: z.array(z.number().int().min(0).max(6)).optional(),
  trigger: TriggerPredicateSchema.default({ allOf: [] }),
  scope: z.enum(["co-located", "anywhere"]).default("co-located"),
  /** Chance this event fires in an eligible (npc, day, phase) — ONE keyed roll per phase. */
  chance: z.number().min(0).max(1).default(1),
  /** Days that must pass after a fire before this event may fire again (0 ⇒ none). */
  cooldownDays: z.number().int().nonnegative().default(0),
  once: z.enum(["campaign", "always"]).default("always"),
  /** Relative selection weight when several of this NPC's events fire the same phase. */
  weight: z.number().positive().default(1),
  effects: z.array(EffectSchema).default([]),
});
export type NpcEvent = z.infer<typeof NpcEventSchema>;

// --- Mystery & collaborative deduction (the cases layer) --------------------------------------
/** The evidentiary category of a case fact — the six axes an accusation is proven along. */
export const CaseFactKindSchema = z.enum(["motive", "means", "opportunity", "timeline", "physical", "testimony"]);
export type CaseFactKind = z.infer<typeof CaseFactKindSchema>;

/** One atomic piece of case evidence. `core` facts are the ones an accusation can require as proof. */
export const CaseFactSchema = z.object({
  id: Id,
  text: Prose,
  kind: CaseFactKindSchema,
  /** A load-bearing fact (proof material). Non-core facts are colour/corroboration. */
  core: z.boolean().default(false),
});
export type CaseFact = z.infer<typeof CaseFactSchema>;

/** A believed-false lead. Refuted the moment any `refutedBy` fact reaches the player/an NPC. */
export const CaseRedHerringSchema = z.object({
  id: Id,
  text: Prose,
  /** Fact ids whose surfacing overturns this herring (≥1 required — solvability). */
  refutedBy: z.array(Id).default([]),
});
export type CaseRedHerring = z.infer<typeof CaseRedHerringSchema>;

/** A declarative manifest entry: "this fact becomes learnable HERE". Cross-checked by the loader
 *  against the actual `revealCaseFact` effects, and it powers the pure solvability test. */
export const CaseClueSchema = z.object({
  id: Id,
  /** Fact ids this clue surfaces (≥1). */
  revealsFactIds: z.array(Id).min(1),
  /** How the clue is delivered — an examined interaction, a fired event, or NPC testimony. */
  via: z.enum(["interaction", "event", "testimony"]),
  /** Optional pointer to the interaction/event/npc that carries the reveal (loader cross-check). */
  sourceId: Id.optional(),
  /**
   * Physical evidence this clue leaves in the player's hands — item ids minted alongside the
   * reveal (r5). On the CLUE rather than the fact because one clue can surface several facts while
   * handing over one or two objects, and because keeping a fact a pure proposition is what
   * structurally protects the invariant the mystery wave established: **custody is item state,
   * knowledge is case state.** Dropping or selling these NEVER un-reveals what the player learned.
   * Named distinctly from `sourceId`, which already points at the delivery mechanism.
   * Optional with NO default ⇒ existing campaigns re-serialize byte-identically.
   */
  evidenceItemIds: z.array(Id).optional(),
});
export type CaseClue = z.infer<typeof CaseClueSchema>;

/** One NPC's starting epistemic state within a case (the code-owned belief seed injected to prompts). */
export const NpcCaseKnowledgeSchema = z.object({
  /** Fact ids this NPC holds as KNOWN truth at case start. */
  knows: z.array(Id).default([]),
  /** Red-herring ids this NPC genuinely (falsely) BELIEVES — rendered as confident knowledge. */
  believes: z.array(Id).default([]),
  /** Red-herring ids this NPC knowingly PUSHES to mislead (the culprit's active misdirection). */
  asserts: z.array(Id).default([]),
});
export type NpcCaseKnowledge = z.infer<typeof NpcCaseKnowledgeSchema>;

/** The GM-only ground truth of a case (appended to the secret-lore DM channel, never the NPC brief). */
export const CaseTruthSchema = z.object({
  culpritId: Id,
  method: Prose,
  motive: Prose,
  summary: Prose,
});
export type CaseTruth = z.infer<typeof CaseTruthSchema>;

/** How an accusation resolves in code — what must be proven, the budget, and the culprit's reaction. */
export const CaseAccusationSchema = z.object({
  /** Core fact ids that must all be player-known for a correct accusation to succeed (proof gate). */
  requiredCoreFacts: z.array(Id).default([]),
  /** Wrong-accusation budget; exhausting it fails the case. */
  maxWrongAccusations: z.number().int().positive().default(3),
  /** The culprit's reaction to a proven, correct accusation. */
  culpritResponse: z.enum(["surrender", "fight", "flee"]).default("surrender"),
  /** Effects run on a correct+proven accusation (beyond the code-driven quest completion). */
  successEffects: z.array(EffectSchema).default([]),
  /** Effects run on each wrong accusation. */
  wrongAccusationEffects: z.array(EffectSchema).default([]),
  /** Effects run when the wrong-accusation budget is exhausted (case failed). */
  failEffects: z.array(EffectSchema).default([]),
});
export type CaseAccusation = z.infer<typeof CaseAccusationSchema>;

/** A hand-authored mystery. `questId` binds its lifecycle to an ordinary quest (banner/rewards). */
export const CaseSchema = z.object({
  id: Id,
  name: z.string(),
  /** The quest whose state mirrors this case's lifecycle (offered→active→completed/failed). */
  questId: Id,
  truth: CaseTruthSchema,
  facts: z.array(CaseFactSchema).default([]),
  redHerrings: z.array(CaseRedHerringSchema).default([]),
  clues: z.array(CaseClueSchema).default([]),
  /** Per-NPC starting knowledge, keyed by npc id. */
  npcKnowledge: z.record(Id, NpcCaseKnowledgeSchema).default({}),
  accusation: CaseAccusationSchema,
});
export type Case = z.infer<typeof CaseSchema>;

export const CampaignSchema = z.object({
  id: Id,
  name: z.string(),
  /** The World this campaign is played on. */
  worldId: Id,
  synopsis: Prose.default(""),
  /** Player characters available/created for this campaign. */
  characters: z.array(CharacterSchema).default([]),
  scenes: z.array(SceneSchema).default([]),
  quests: z.array(QuestSchema).default([]),
  /** High-level authoring shorthand compiled into ordinary quests + Campaign.events at load. */
  questFlows: z.array(QuestFlowSchema).optional(),
  /** Authored trigger→effect beats, evaluated each tick by the events module. */
  events: z.array(PrebakedEventSchema).default([]),
  /** DoL-style random events rolled on travel (arrival at a new location). Empty ⇒ the system is inert. */
  travelEvents: z.array(TravelEventSchema).default([]),
  /** Bundled shared random-event packs to append at load/generation time. Optional for byte-stable old worlds. */
  travelEventPacks: z.array(z.string()).optional(),
  /** Base per-move probability that ANY travel event fires. 0 (default) ⇒ never rolls (existing worlds inert). */
  travelEventChance: z.number().min(0).max(1).default(0),
  /** Overnight events rolled each turn while the PC sleeps in a rented room. A separate table from
   *  `travelEvents` keeps road encounters out of beds and room intrusions off roads. Empty ⇒ inert. */
  roomEvents: z.array(TravelEventSchema).default([]),
  /** Base per-overnight-turn probability that ANY room event fires. 0 (default) ⇒ never rolls. */
  roomEventChance: z.number().min(0).max(1).default(0),
  /** Hand-authored mysteries (the collaborative-deduction layer). Empty ⇒ the system is fully inert. */
  cases: z.array(CaseSchema).default([]),
  startingState: StartingStateSchema,
});
export type Campaign = z.infer<typeof CampaignSchema>;

/** A World + a Campaign that references it — the unit the engine loads to play. */
export const PlaySetSchema = z.object({
  world: WorldSchema,
  campaign: CampaignSchema,
});
export type PlaySet = z.infer<typeof PlaySetSchema>;
