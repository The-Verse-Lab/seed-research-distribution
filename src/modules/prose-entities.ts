/**
 * Prose-entity grounding (Workstream A — owner decision 2026-07-05).
 *
 * The GM narrator invents named characters in prose ("the Keeper of Weights", "Rook") that never
 * enter the entity registry, so the next turn a player line "to the Keeper" grounds to null and is
 * absorbed by whoever is actually PRESENT (the classifier is correct to null a prose-only referent;
 * the fix is to make the referent EXIST). This module closes that gap: after the GM prose is emitted,
 * a best-effort utility-role extraction reads the just-narrated text for newly-named characters and
 * SPAWNS them as transient registry NPCs at the party's location — so next turn they are present,
 * addressable, and (for the hostile/exploitative ones) real entities the agenda scorer can see. It
 * runs LAST in the narrate phase and only on a player turn; extraction failure degrades to "no
 * entities" and never blocks or corrupts a turn.
 *
 * DANGER-WEIGHTED GENERATION (owner decision 2026-07-05): a spawned NPC's seeded
 * alignment/personality/`exploitative` — and how MANY are materialized — lean toward evil/exploitative as
 * world `danger` (0..3) rises. Every roll
 * is id-keyed (`mulberry32(fnv1a(...))`), so it draws ZERO from the shared tick rng and replays
 * byte-identically; spawns + enrichment ride the existing `entitySpawned`/`npcEnriched` deltas
 * (no LLM on replay). Danger never touches age or isMinor.
 *
 * @author Runkai Zhang
 */
import { NpcTemplateSchema, type Alignment, type World } from "../content/schema.ts";
import type { LlmGateway } from "../llm/gateway.ts";
import { mulberry32 } from "../rules/dice.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../world/model.ts";
import { combatPendingInQueue, isCombatActive, livingCompanionsWithPc } from "../world/queries.ts";
import { mirrorEnrichment } from "../world/enrichment.ts";
import { fnv1a } from "../worldsmith/seeded.ts";
import {
  dangerWeightedPools,
  extractJson,
  seededIdentityFor,
  seededExploitative,
} from "../worldsmith/reconcile.ts";
import { composeNpcTemplate } from "./party/enrich.ts";
import { regionProfileOf } from "../rules/regions.ts";
import { nameHandleTokens, nameMentionedIn, nameTokens, sharesNameToken } from "../rules/name-match.ts";
import { escapeRegExp } from "../util/text.ts";
import type { TickContext, TickModule } from "../engine/tick.ts";

/** Baseline HP for a spawned prose NPC — modest, so it is a first-class (fightable, present-listed,
 *  actor-projected) entity rather than a statless bystander. Matches the enrichment baseline. */
const PROSE_NPC_HP = 16;
/** Evil-only alignments a narrator-declared villain is drawn from (mirrors reconcile.ts). */
const EVIL_ALIGNMENTS: readonly Alignment[] = ["le", "ne", "ce"];
/** Exploitative-manner archetypes for a narrator-declared villain (mirrors dangerWeightedPools). */
const EXPLOITATIVE_PERSONALITIES = ["brute", "schemer", "zealot", "firebrand"] as const;

/** One newly-named character the extractor surfaced. */
interface ProseNpc {
  name: string;
  disposition?: "hostile" | "neutral" | "friendly";
  /** Gender the PROSE established via pronouns/nouns ("she/woman"→female, "he/man"→male). Undefined
   *  when the prose gave no signal — then the seeded rng draw stands (byte-identical to prior). */
  sex?: "male" | "female";
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** A deterministic id-safe slug from a display name ("the Keeper of Weights" → "keeper-of-weights"). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The tokens of a name that could denote a specific person — the shared tier-1 set
 * (`src/rules/name-match.ts`), so "the Keeper of Weights" keys on `weights` and a bare "the Keeper"
 * keys on NOTHING. An article, a preposition and an office are all names for a KIND of person.
 */
const salientTokens = nameHandleTokens;

/**
 * Whether `name` already denotes an existing entity — ANY shared salient token counts as the same
 * individual (a prose "Rook" is "Rook Underwine"; "the Keeper" is "the Keeper of Weights"). Errs
 * toward NOT spawning a duplicate, the safe direction for registry hygiene.
 */
function matchesExistingName(name: string, existing: string[]): boolean {
  if (salientTokens(name).length === 0) return true; // no salient token → junk, never spawn
  return existing.some((ex) => sharesNameToken(name, ex));
}

// Common capitalized words that are NOT proper-name introductions — a cheap cost gate only (below).
// Function-class words only (pronouns, prepositions, conjunctions, adverbs, indefinites): a content
// noun ("Rain", "Wind") is NOT listed, because a character can carry it as a name — the
// lowercase-elsewhere check in `mightIntroduceEntity` handles recurring common nouns instead.
const CAP_STOP = new Set(
  [
    "the", "a", "an", "and", "but", "or", "so", "then", "yet", "for", "nor", "as", "if", "when", "while",
    "you", "your", "yours", "yourself", "i", "me", "my", "we", "us", "our", "he", "him", "his", "she", "her",
    "hers", "they", "them", "their", "it", "its", "this", "that", "these", "those", "here", "there", "now",
    "no", "not", "yes", "do", "does", "did", "is", "are", "was", "were", "be", "been", "being", "have", "has",
    "had", "will", "would", "can", "could", "may", "might", "must", "shall", "should", "what", "who", "whom",
    "whose", "which", "why", "how", "where", "with", "without", "from", "into", "onto", "upon", "over", "under",
    "before", "after", "again", "still", "even", "only", "just", "perhaps", "maybe", "something", "someone",
    "nothing", "everything", "somewhere",
    // r10 latency audit — the module-trace finding was 6–12s of utility latency per turn emitting
    // nothing; most of it was sentence-initial function words the old list missed.
    "outside", "inside", "above", "below", "behind", "beneath", "between", "beyond", "across", "around",
    "along", "against", "toward", "towards", "through", "past", "near", "away", "back", "down", "up", "out",
    "off", "once", "twice", "soon", "later", "tonight", "today", "tomorrow", "yesterday", "meanwhile",
    "suddenly", "finally", "somehow", "instead", "already", "almost", "everywhere", "anywhere", "nowhere",
    "whatever", "whoever", "whenever", "wherever", "anything", "anyone", "anybody", "everybody", "nobody",
    "none", "neither", "either", "because", "though", "although", "unless", "until", "since", "during",
    "despite", "within", "beside", "besides", "amid", "among", "at", "on", "in", "by", "to", "of",
  ].map((w) => w),
);

/**
 * Capitalized multi-letter tokens of a passage — the cost gate's candidate names.
 *
 * UNICODE, not ASCII (r8 regex audit). The old `\b[A-Z][a-zA-Z'’-]{2,}\b` could not see a capital
 * outside A–Z, and `\b` itself is ASCII-only, so an accented name matched nothing at all:
 *
 *   mightIntroduceEntity("Élodie sets a bowl of stew on the counter…", new Set())  =>  false
 *
 * — the gate reported "no plausible new name", the extractor never ran, and Élodie stayed a
 * prose-only ghost the player could not address next turn. Non-ASCII names are ordinary in the
 * genre and nothing else in the pipeline is ASCII-bound. So: `\p{Lu}` for the head, `\p{L}` for the
 * body, and explicit non-letter/digit lookaround in place of `\b`.
 */
function capitalizedTokens(prose: string): string[] {
  return [...prose.matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}'’-]{2,}(?![\p{L}\p{N}])/gu)].map((m) => m[0]);
}

/** The double-quoted spans (straight or curly) of a passage, as [start, end) index pairs. */
function quotedSpans(prose: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const quoted = /"[^"]*"|“[^”]*”/g;
  let q: RegExpExecArray | null;
  while ((q = quoted.exec(prose)) !== null) spans.push([q.index, q.index + q[0].length]);
  return spans;
}

/** Word-bounded occurrences of `token` in `prose` (case-insensitive, Unicode lookaround for `\b`). */
function tokenOccurrences(prose: string, token: string): RegExpExecArray[] {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(token)}(?![\\p{L}\\p{N}])`, "giu");
  return [...prose.matchAll(re)];
}

/**
 * A pure COST gate: does the prose plausibly introduce a new proper-named character? Collects
 * capitalized multi-letter tokens, drops common words + names already present + location-name tokens,
 * and returns true if any candidate survives. This never classifies MEANING — it only decides whether
 * to spend a utility call; when in doubt it returns true (the extractor then does the real work).
 *
 * TIGHTENED (r10 latency audit — the module trace showed 6–12s of utility latency per turn, emitting
 * nothing on every sampled turn). Three structural drops, each mirroring a filter the SPAWN path
 * already enforces, so gating them out of the CALL loses no spawn the module would have kept:
 * - a quantifier/kind-noun head (`NON_NAME_HEADS`) is never a person (`isProperPersonName`);
 * - a token that also appears LOWERCASE in the passage is a common noun ("Rain fell… the rain"),
 *   and a real name is never written lowercase;
 * - a token occurring ONLY inside quoted dialogue was talked about, not staged
 *   (`mentionedOnlyInsideQuotes` drops the extracted name later anyway).
 */
function mightIntroduceEntity(prose: string, knownTokens: Set<string>): boolean {
  const caps = capitalizedTokens(prose);
  if (caps.length === 0) return false;
  let spans: Array<[number, number]> | undefined;
  for (const tok of caps) {
    const lower = tok.toLowerCase();
    if (CAP_STOP.has(lower)) continue;
    if (knownTokens.has(lower)) continue;
    if (NON_NAME_HEADS.has(lower)) continue;
    const occ = tokenOccurrences(prose, tok);
    if (occ.some((m) => { const h = m[0][0]!; return h === h.toLowerCase() && h !== h.toUpperCase(); })) continue;
    spans ??= quotedSpans(prose);
    if (spans.length > 0 && occ.every((m) => spans!.some(([s, e]) => m.index >= s && m.index < e))) continue;
    return true;
  }
  return false;
}

/**
 * Words a person's name never contains: quantifiers, pronoun-ish words, and bare kind-nouns. The r5
 * run minted "One of the Standing" out of "the oldest standing stone" and then carried it for the
 * rest of the session — every later scene ended "There is no sign of One of the Standing here.", and
 * the bare word "One" rendered as a clickable character link in the client.
 *
 * PLURALS ARE ENTRIES OF THEIR OWN (r8 regex audit). The set was singular-only, so the kind-noun
 * test it exists for was skipped by exactly the phrasings the extractor reaches for when it reads a
 * crowd as a character — reproduced end-to-end through the module: prose "Figures in the Fog move
 * along the ridge above the road, three of them, spears up…" spawned the registry NPC
 * `npc.prose.figures-in-the-fog`, an addressable, fightable, schedule-carrying "person" made of fog.
 * `man` was blocked and `men` was not; a plural head is if anything WORSE evidence of one
 * individual than its singular.
 */
const NON_NAME_HEADS = new Set([
  "one", "two", "three", "four", "five", "someone", "somebody", "anyone", "another", "other", "others",
  "each", "every", "everyone", "all", "both", "few", "many", "several", "some", "none", "half", "most",
  "nobody", "person", "persons", "people", "man", "men", "woman", "women", "boy", "boys", "girl",
  "girls", "child", "children", "figure", "figures", "stranger", "strangers", "folk", "folks",
  "crowd", "crowds", "group", "groups", "pair", "rider", "riders", "guard", "guards", "villager",
  "villagers", "local", "locals",
]);

/**
 * True when the prose capitalizes `token` somewhere a sentence does not FORCE the capital — the
 * cheap proper-noun test. "One of them spits into the dust" only ever capitalizes "One" at a
 * sentence start; "…beside Rook, the ferryman" capitalizes Rook mid-sentence.
 */
function capitalizedMidSentence(prose: string, token: string): boolean {
  const lower = prose.toLowerCase();
  for (let at = lower.indexOf(token); at !== -1; at = lower.indexOf(token, at + 1)) {
    const before = prose[at - 1];
    const after = prose[at + token.length];
    if (before !== undefined && /[a-z0-9]/i.test(before)) continue; // mid-word
    if (after !== undefined && /[a-z0-9]/i.test(after)) continue;
    const head = prose[at]!;
    if (head !== head.toUpperCase() || head === head.toLowerCase()) continue; // not capitalized here
    let k = at - 1;
    while (k >= 0 && /[\s"'“‘(]/.test(prose[k]!)) k -= 1;
    if (k >= 0 && !/[.!?;:]/.test(prose[k]!)) return true;
  }
  return false;
}

/**
 * SHAPE gate on an extracted name: a quantifier head is never a person, and a real proper name is
 * either written verbatim in the passage or capitalized somewhere the sentence did not force it.
 * Never content-conditional — this reads capitalization, not meaning.
 */
function isProperPersonName(name: string, prose: string): boolean {
  const tokens = salientTokens(name);
  if (tokens.length === 0) return false;
  // The quantifier test reads the RAW token surface, never the salient one: the shared binder
  // correctly drops "one" as noise before it can bind anybody, but here the presence of "one" is
  // exactly the evidence we are looking for — "One of the Standing" is scenery wearing a name.
  if (nameTokens(name).some((t) => NON_NAME_HEADS.has(t))) return false;
  if (prose.includes(name.trim())) return true;
  return tokens.some((t) => capitalizedMidSentence(prose, t));
}

/** True with the given probability from a PRIVATE id-keyed rng (zero shared-stream draws). */
function keyedRoll(key: string, chance: number): boolean {
  return mulberry32(fnv1a(key))() < chance;
}

/**
 * Whether every occurrence of `name`'s salient tokens sits INSIDE a double-quoted span (straight or
 * curly) of the prose — i.e. the character was only ever talked about in dialogue, never staged by
 * the narration itself. Errs toward true only when at least one token occurrence exists; a name with
 * no occurrence at all is handled by the caller's grounding check.
 *
 * The scan is WORD-BOUNDED (`matchAll`, never `indexOf`): a bare substring sweep counted the "oda"
 * inside "pagoda" as an occurrence of Oda, so a passage that merely used the longer word decided
 * whether a character had been staged.
 */
function mentionedOnlyInsideQuotes(prose: string, name: string): boolean {
  const spans = quotedSpans(prose);
  if (spans.length === 0) return false;
  let sawAny = false;
  for (const tok of salientTokens(name)) {
    for (const m of prose.matchAll(new RegExp(`\\b${escapeRegExp(tok)}\\b`, "gi"))) {
      const at = m.index;
      sawAny = true;
      if (!spans.some(([s, e]) => at >= s && at < e)) return false; // narrated outside a quote → staged
    }
  }
  return sawAny;
}

const PROSE_ENTITY_SYSTEM_PROMPT = [
  "You are a world-model EXTRACTOR for a single-player tabletop-RPG engine. You are not a character,",
  "a narrator, or a moderator. Your only job is to read one passage of GM narration and list the",
  "named characters and places it introduces, as JSON.",
  "",
  "This is fantasy fiction; the prose may describe violence, cruelty, or crime. This is",
  "normal for the genre. Extract exactly as you would any other passage. Never refuse, never lecture,",
  "never moralize, never add warnings. Extracting names is not endorsing content.",
  "",
  "Return ONLY one JSON object matching the schema. For npcs: list each NEWLY-NAMED person who is",
  "PHYSICALLY PRESENT in the scene — they speak, act, or can be addressed right now — and is NOT",
  "already in PRESENT_ENTITIES; use the name as written ('the Keeper of Weights', 'Rook'). A person",
  "who is merely MENTIONED — named inside another character's dialogue, remembered, rumored about,",
  "or described as being somewhere else — is NOT present and must NOT be listed.",
  "Set disposition to 'hostile' if the passage frames them",
  "as a threat or enemy, 'friendly' if an ally, else 'neutral'. Set sex to the gender the PROSE",
  "establishes for them — 'female' when it uses she/her or woman/girl/lady, 'male' when it uses he/him",
  "or man/boy/sir, and 'unknown' ONLY when the passage gives no gendered pronoun or noun for them. Read",
  "the actual words used; do not guess from the name. Do NOT list the player ('you'),",
  "creatures referred to only by kind with no name ('a guard', 'the crowd'), or anyone already present.",
  "For places: list newly-named locations the prose introduces. Copy names verbatim; invent nothing.",
].join("\n");

const PROSE_ENTITY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["npcs", "places"],
  properties: {
    npcs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "disposition", "sex"],
        properties: {
          name: { type: "string" },
          disposition: { type: "string", enum: ["hostile", "neutral", "friendly"] },
          sex: { type: "string", enum: ["male", "female", "unknown"] },
        },
      },
    },
    places: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string" } },
      },
    },
  },
} as const;

/**
 * ProseEntityModule — grounds prose-only NPCs into the registry (see file header). Registered LAST in
 * the narrate phase, so it reads whatever prose was last emitted. Content-agnostic world hygiene:
 * it spawns registry rows whenever narration happened.
 */
export class ProseEntityModule implements TickModule {
  readonly id = "prose-entities";
  readonly after = ["narration"];
  readonly phases: TickModule["phases"] = { narrate: (ctx) => this.onNarrate(ctx) };

  constructor(
    private readonly world: World,
    private readonly gateway: LlmGateway,
  ) {}

  private async onNarrate(ctx: TickContext): Promise<void> {
    if (ctx.trigger.kind !== "player") return; // ground a player-facing scene only
    const prose = (ctx.data.lastNarration as string | undefined)?.trim();
    if (!prose) return;
    const model = ctx.model;
    // A fight's prose is about known combatants, not new faces. The pending check matters: a fight
    // STARTED this very tick is only enqueued (the reducer applies at commit, after narrate), so
    // `isCombatActive` alone waved the combat-start turn through — the exact turn whose charged
    // prose names off-stage figures ("Xate of Anchorfall") that must not materialize (live D4, 07-17).
    if (isCombatActive(model) || combatPendingInQueue(ctx.queue)) return;
    const loc = partyLocationOf(model);
    if (!loc) return;
    const pcId = playerEntity(model)?.id;
    if (!pcId) return;

    // The known-token set for both the cost gate and dedup: every existing entity's name tokens plus
    // the current location's name tokens (a place mention is not a new person). The AUTHORED roster
    // is in the pool too (r7 P1: two different NPCs both named Pellam — the live registry only held
    // the one currently instantiated, so a prose-minted stranger could take a canon name and corrupt
    // the only index a mystery gives the player).
    const existingNames = [
      ...[...model.entities.values()].map((e) => e.name),
      ...this.world.npcs.map((n) => n.name).filter((n): n is string => !!n),
    ];
    // The cost gate wants the RAW token surface, not the distinctive one: an already-known "Coast
    // Farmhand" should still suppress the capitalized "Coast" in the prose, or the gate spends a
    // utility call on every scene that mentions the coast road.
    const known = new Set<string>();
    for (const nm of existingNames) for (const t of nameTokens(nm)) known.add(t);
    // EVERY authored place and region name, not just the current location's (r10 latency audit):
    // "the road to Umberwick" is not a new person, and with only the local name in the set every
    // scene that mentioned a neighbor fired a 6–12s utility call. A genuine NPC sharing a place
    // token still gates in via its OTHER tokens; a full name-collision is exactly what
    // `matchesExistingName` already refuses to spawn.
    for (const l of this.world.locations) for (const t of nameTokens(l.name)) known.add(t);
    for (const r of this.world.regions) for (const t of nameTokens(r.name)) known.add(t);
    const locName = this.world.locations.find((l) => l.id === loc)?.name;

    if (!mightIntroduceEntity(prose, known)) return; // cheap skip when no plausible new name

    const extracted = await this.extract(prose, model, loc, locName ?? loc);
    if (extracted.length === 0) return;

    // Region danger overrides the world default (unregioned ⇒ the region resolver returns
    // constitution.danger, so this is byte-identical there). The region's threatShare likewise
    // falls back to dangerThreatShare(danger), so a no-region world spawns exactly as before.
    const profile = regionProfileOf(this.world, loc);
    const danger = clamp(profile.danger, 0, 3);

    // Dedup against existing entities + a once-per-campaign flag (so a name spawns exactly once).
    const fresh = extracted.filter((n) => {
      const slug = slugify(n.name);
      if (!slug) return false;
      if (model.flags[`prose.spawned.${slug}`]) return false;
      return !matchesExistingName(n.name, existingNames);
    });
    if (fresh.length === 0) return;

    // Danger scales COUNT + which names win the slots: a deadlier world materializes more, threatening
    // faces first; a cozy world keeps fewer, friendlier faces first (rank ascending = preferred).
    const rank = (d: ProseNpc["disposition"]): number => (d === "hostile" ? 0 : d === "neutral" ? 1 : 2);
    const ordered = [...fresh].sort((a, b) =>
      danger >= 2 ? rank(a.disposition) - rank(b.disposition) : rank(b.disposition) - rank(a.disposition),
    );
    // A per-candidate keep-roll thins AMBIENT names (hostile ones always materialize); more survive at
    // high danger. Private id-keyed rng ⇒ replay-safe, shifts nothing.
    const keepChance = clamp(0.4 + danger * 0.15, 0, 0.9);
    const kept = ordered.filter(
      (n) => n.disposition === "hostile" || keyedRoll(`${this.world.name}:prosekeep:${slugify(n.name)}`, keepChance),
    );
    const maxSpawn = 1 + danger;

    const share = profile.threatShare;
    for (const cand of kept.slice(0, maxSpawn)) {
      this.spawnProseNpc(ctx, cand, loc, pcId, danger, share);
    }
  }

  /** Spawn one extracted NPC with a danger-weighted seeded identity, then record its template. */
  private spawnProseNpc(
    ctx: TickContext,
    cand: ProseNpc,
    loc: string,
    pcId: string,
    danger: number,
    threatShare: number,
  ): void {
    const model = ctx.model;
    const slug = slugify(cand.name);
    let spawnId = `npc.prose.${slug}`;
    for (let n = 1; model.entities.has(spawnId); n++) spawnId = `npc.prose.${slug}#${n}`;

    const hostile = cand.disposition === "hostile";
    // A narrator-declared villain draws evil plus an exploitative manner; everyone else takes the
    // danger-weighted pools and share.
    const identity = hostile
      ? seededIdentityFor(this.world.name, spawnId, {
          alignments: EVIL_ALIGNMENTS,
          personalities: [...EXPLOITATIVE_PERSONALITIES],
        })
      : seededIdentityFor(this.world.name, spawnId, dangerWeightedPools(danger));
    const exploitative = hostile || seededExploitative(this.world.name, spawnId, identity.alignment, threatShare);

    const spawn = ctx.apply({
      type: "spawnEntity",
      entity: {
        id: spawnId,
        kind: "npc",
        tier: "transient",
        name: cand.name,
        locationId: loc,
        stats: { currentHp: PROSE_NPC_HP, maxHp: PROSE_NPC_HP },
      },
    });
    if (spawn.rejected) return;

    // Compose the rich offline floor from the fresh entity, then OVERRIDE the seeded categoricals with
    // the danger-rolled ones (composeNpcTemplate draws them UNIFORM — not danger-aware — so we must
    // pass the danger identity in). The template is recorded now so stance() can read the
    // danger-weighted lean immediately; NpcProfileModule sees the recorded profile next tick and no-ops.
    const ent = model.entities.get(spawnId);
    if (!ent) return;
    // Gender is the ONE facet the prose already fixed (the GM said "a broad-shouldered woman… her
    // grey hair"): honor what was narrated so a later brief can't flip the pronouns. The rng draw
    // only stands when the prose gave no gender signal (cand.sex undefined) — byte-identical there.
    const sex = cand.sex ?? identity.sex;
    const template = NpcTemplateSchema.parse({
      ...composeNpcTemplate(this.world, ent),
      sex,
      alignment: identity.alignment,
      personalityTemplate: identity.personalityTemplate,
      exploitative,
    });
    const enr = ctx.apply({ type: "enrichNpc", npcId: spawnId, template, promote: false });
    if (enr.mutated) mirrorEnrichment(this.world, template);

    // A narrator-declared villain starts antagonistic toward the PC.
    if (hostile) ctx.apply({ type: "adjustRelationship", actorId: spawnId, targetId: pcId, by: -60 });

    // Once-per-campaign: never re-spawn this name, however many scenes mention it.
    ctx.apply({ type: "setFlag", scope: "world", key: `prose.spawned.${slug}`, value: true });
    ctx.data.persist = true;
  }

  /**
   * Best-effort utility-role extraction over the emitted prose (mirrors the classifier call shape:
   * `complete("utility", {temperature:0, json:true})`, one transparent retry, degrade to []). Never
   * throws — a failure means "no entities this turn".
   */
  private async extract(prose: string, model: TickContext["model"], loc: string, locName: string): Promise<ProseNpc[]> {
    const present =
      entitiesAt(model, loc)
        .map((e) => `${e.id}=${e.name}`)
        .join(", ") || "(none)";
    const user = [
      `NARRATION:\n${prose.slice(0, 2400)}`,
      `LOCATION: ${loc} "${locName}"`,
      `PRESENT_ENTITIES: ${present}`,
      `SCHEMA: ${JSON.stringify(PROSE_ENTITY_JSON_SCHEMA)}`,
      `Respond with one JSON object only.`,
    ].join("\n");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.gateway.complete("utility", {
          messages: [
            { role: "system", content: PROSE_ENTITY_SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
          temperature: 0,
          json: true,
          // The answer is a few names as JSON — never a page. A tight budget trims tail latency on
          // plain models; the provider self-raises it for reasoning models (EMPTY_LENGTH retry).
          maxTokens: 512,
        });
        const parsed = JSON.parse(extractJson(res.text)) as { npcs?: unknown };
        if (!Array.isArray(parsed.npcs)) return [];
        // Prose authorizes nothing it did not actually name. The extractor is a utility model reading
        // the narration; a returned name whose salient tokens never appear in the prose is a pure
        // fabrication (a hallucinated actor, potentially hostile — see the disposition mapping below),
        // and spawning it would invert the engine's causality (commands author prose, never the
        // reverse). Drop any name not grounded in the passage. The grounding test is the shared
        // word-bounded binder, not a substring sweep: `includes` let an extracted "Oda" ride on the
        // word "pagoda". Capitals are not demanded here (surface `uncased`, despite the haystack
        // being prose) — `isProperPersonName` below owns the capitalization argument, and this step
        // only asks whether the passage said the word.
        const out: ProseNpc[] = [];
        for (const raw of parsed.npcs) {
          if (!raw || typeof raw !== "object") continue;
          const name = typeof (raw as ProseNpc).name === "string" ? (raw as ProseNpc).name.trim() : "";
          if (!name) continue;
          if (!nameMentionedIn(prose, name, { surface: "uncased" })) continue;
          // Grounded in the passage is not the same as being a PERSON: the extractor also reads
          // scenery as a character ("One of the Standing" from a standing stone). A name that
          // isn't shaped like one never becomes a registry row (r5 P1).
          if (!isProperPersonName(name, prose)) continue;
          // A name that occurs ONLY inside quoted dialogue was talked ABOUT, not staged: an NPC
          // invoking "Xate of Anchorfall" mid-speech must not conjure Xate into the room (live D4,
          // 07-17). Someone actually present is also named by the surrounding narration; erring
          // toward NOT spawning is the safe direction (matchesExistingName's precedent).
          if (mentionedOnlyInsideQuotes(prose, name)) continue;
          const d = (raw as ProseNpc).disposition;
          const s = (raw as { sex?: unknown }).sex;
          out.push({
            name,
            disposition: d === "hostile" || d === "friendly" ? d : "neutral",
            ...(s === "male" || s === "female" ? { sex: s } : {}),
          });
        }
        return out;
      } catch {
        // transient model/JSON error — retry once, then give up quietly
      }
    }
    return [];
  }
}
