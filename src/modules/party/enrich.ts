/**
 * Party enrichment — the transient→permanent promotion composer (Phase 2, Stage B).
 *
 * When an NPC without a full authored template joins the party it becomes a permanent fixture,
 * so it needs everything an authored NPC has: identity, persona, alignment, personality,
 * knownLore/hiddenLore, a statblock. `composeNpcTemplate` is the deterministic OFFLINE floor —
 * a complete, schema-valid template built from what the entity ALREADY IS (its name, location,
 * live stats/inventory, and any partial npc/monster template behind its templateId), with
 * personality/morality drawn as seeded picks keyed to the entity id so the same NPC always
 * enriches identically. An optional guarded LLM pass may deepen the three prose slots; offline
 * or guard-blocked it falls back to the floor verbatim, so promotion never stalls or fails.
 *
 * Enrichment composes the character from what the NPC already appears to be and never softens it
 * toward friendliness: an exploitative template stays exploitative, hostile natures stay hostile,
 * and party membership grants no disposition bonus. The guarded gateway remains in force.
 *
 * The command path mirrors world expansion: the module composes (LLM work happens HERE), the
 * `enrichNpc` command carries only the finished template, the reducer records it, and the
 * engine-side mirror + `hydrateEnrichments()` keep `world.npcs` in sync (src/world/enrichment.ts).
 *
 * @author Runkai Zhang
 */
import { z } from "zod";
import {
  AlignmentIds,
  NpcTemplateSchema,
  StatBlockSchema,
  type NpcTemplate,
  type World,
} from "../../content/schema.ts";
import { MORALITIES } from "../../content/presets/moralities.ts";
import { PERSONALITIES } from "../../content/presets/personalities.ts";
import { resolvePreset } from "../../content/presets/preset.ts";
import type { LlmGateway } from "../../llm/gateway.ts";
import { mulberry32 } from "../../rules/dice.ts";
import { baselineNpcStats, extractJson } from "../../worldsmith/reconcile.ts";
import { fnv1a, pick } from "../../worldsmith/seeded.ts";
import type { Entity } from "../../world/entity.ts";
import { enrichmentsOf, mirrorEnrichment } from "../../world/enrichment.ts";
import type { TickContext } from "../../engine/tick.ts";

/**
 * Exploitative natures draw from the evil moralities — the template already declared what this NPC
 * is, and enrichment preserves it (no softening). Everyone else draws UNIFORMLY from the full
 * nine-alignment grid: no bias toward good either, because membership is mechanically neutral.
 */
const EXPLOITATIVE_ALIGNMENTS = ["le", "ne", "ce"] as const;

/** Archetypes compatible with an exploitative nature, never a soft rewrite. */
const EXPLOITATIVE_PERSONALITY_IDS = ["brute", "schemer", "hedonist", "trickster", "firebrand", "survivor"] as const;

const PERSONALITY_IDS = PERSONALITIES.map((p) => p.id);

/** Manner-of-speech tags — small generic pool; content-specific voices stay author-side. */
const VOICE_TAGS = [
  "clipped and to the point",
  "slow and deliberate",
  "quick and teasing",
  "gravel-voiced",
  "soft-spoken",
  "blunt to the edge of rude",
  "wry, fond of understatement",
  "formal, old-fashioned turns of phrase",
  "coarse, laughs easily",
  "given to proverbs and sayings",
] as const;

/** Role nouns flavored with the spawn location at compose time ("<role> around <place>"). */
const SOCIAL_ROLES = [
  "odd-jobber",
  "peddler",
  "hunter",
  "laborer",
  "ferry hand",
  "hired guard",
  "regular at the common fire",
  "wanderer",
  "keeper of small debts",
  "fixture",
] as const;

/** Small likes/dislikes — enough for a scene to stay consistent about. */
const PREFERENCE_POOL = [
  "likes strong drink",
  "likes coin paid up front",
  "likes a warm fire and no questions",
  "likes gossip more than is wise",
  "likes quiet corners",
  "avoids crowds",
  "avoids lawmen and their ledgers",
  "avoids deep water",
  "avoids owing favors",
  "avoids talk of the dead",
] as const;

/** Workstream F "how you are perceived" pools — neutral physical/manner/social reads for the resolver. */
const APPEARANCE_TAGS = ["weathered", "striking", "plain", "scarred", "youthful", "imposing", "wiry", "unremarkable"] as const;
const PRESENTATION_TAGS = ["confident", "guarded", "easygoing", "formal", "brash", "reserved", "watchful", "blunt"] as const;
const SOCIAL_TRAITS = ["charismatic", "aloof", "warm", "intimidating", "earnest", "sly", "dour", "affable"] as const;

const filled = (s: string | undefined, fallback: string): string => (s?.trim() ? s : fallback);

/** Two DISTINCT seeded picks in exactly two rng draws (collision shifts to the next slot). */
function pickTwo<T>(rng: () => number, arr: readonly T[]): [T, T] {
  const i = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  const j = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return [arr[i] as T, arr[j === i ? (j + 1) % arr.length : j] as T];
}

/**
 * The deterministic offline floor: a COMPLETE, schema-valid NpcTemplate from what the entity
 * already is. Pure in (world content, entity) — same entity id + same state ⇒ a byte-identical
 * template. The template id is the ENTITY id (what the reducer's `enrichNpc` validation
 * expects): enrichment names THIS individual, so a spawned instance (`npc.guard#1`) records its
 * own template instead of overwriting the shared authored one every sibling resolves from. Any
 * partial template behind the entity's original templateId still seeds the floor's content.
 */
export function composeNpcTemplate(world: World, entity: Entity): NpcTemplate {
  const templateId = entity.templateId ?? entity.id;
  // Whatever partial content already describes this entity seeds the floor: an authored NPC
  // template keeps every authored field; a monster spawn template lends description + stats.
  const baseNpc = world.npcs.find((n) => n.id === templateId);
  const baseMonster = world.monsters.find((m) => m.id === templateId);
  // The id-keyed derived rng (fnv1a + mulberry32, shared via worldsmith/seeded.ts).
  const rng = mulberry32(fnv1a(entity.id));
  const exploitative = baseNpc?.exploitative ?? false;

  // Draw the seeded picks UNCONDITIONALLY, in a fixed order, so the stream stays stable however
  // many of them the base template overrides. New draws append at the END of the order (the sex
  // pick came later than alignment/personality) so a given entity id keeps its earlier picks.
  const alignmentPick = pick(rng, exploitative ? EXPLOITATIVE_ALIGNMENTS : AlignmentIds);
  const personalityPick = pick(rng, exploitative ? EXPLOITATIVE_PERSONALITY_IDS : PERSONALITY_IDS);
  const sexPick = pick(rng, ["female", "male"] as const);
  // Workstream A profile draws — appended AFTER sexPick (stream stability, see above). Ages are
  // explicitly 18+ (19–66): a runtime spawn is never an ambiguous-age participant.
  const agePick = 19 + Math.floor(rng() * 48);
  const voicePicks = pickTwo(rng, VOICE_TAGS);
  const rolePick = pick(rng, SOCIAL_ROLES);
  const preferencePicks = pickTwo(rng, PREFERENCE_POOL);
  // Workstream F perceived-signal draws — appended at the END of the stream (after preferences) so
  // every earlier draw for a given entity id stays byte-stable and existing saves are untouched.
  const appearancePicks = pickTwo(rng, APPEARANCE_TAGS);
  const presentationPicks = pickTwo(rng, PRESENTATION_TAGS);
  const socialTraitPicks = pickTwo(rng, SOCIAL_TRAITS);
  const alignment = baseNpc?.alignment ?? alignmentPick;
  const personalityId = baseNpc?.personalityTemplate ?? personalityPick;
  const sex = filled(baseNpc?.sex, sexPick);
  const morality = resolvePreset(MORALITIES, alignment);
  const archetype = resolvePreset(PERSONALITIES, personalityId);

  const locName =
    (entity.locationId ? world.locations.find((l) => l.id === entity.locationId)?.name : undefined) ?? "the road";

  // The statblock keeps the entity's LIVE maxHp (fromGameState re-derives maxHp from the
  // template, so this is what makes the body survive a reload unchanged).
  const baseStats = baseNpc?.stats ?? baseMonster?.stats ?? baselineNpcStats();
  const stats = StatBlockSchema.parse({
    ...structuredClone(baseStats),
    maxHp: entity.stats?.maxHp ?? baseStats.maxHp,
  });

  const archetypeLine = archetype ? `${archetype.label}: ${archetype.description}` : "";
  const moralityLine = morality ? `${morality.label} — ${morality.description}` : "";

  const candidate = {
    ...(baseNpc ? structuredClone(baseNpc) : {}),
    id: entity.id,
    name: entity.name,
    summary: filled(baseNpc?.summary, `${entity.name}, lately of ${locName}.`),
    persona: filled(
      baseNpc?.persona,
      [`${entity.name} of ${locName}.`, archetypeLine, moralityLine].filter(Boolean).join(" "),
    ),
    description: filled(
      baseNpc?.description,
      filled(baseMonster?.description, `${entity.name} carries the look of ${locName}: worn, watchful, unmistakably themselves.`),
    ),
    personality: filled(baseNpc?.personality, archetypeLine || `Takes ${locName} as it comes.`),
    knownLore: filled(baseNpc?.knownLore, `${entity.name} knows the paths, debts, and grudges around ${locName}.`),
    hiddenLore: filled(
      baseNpc?.hiddenLore,
      `${entity.name} does not know what the road that led to ${locName} still holds against them.`,
    ),
    goals:
      baseNpc && baseNpc.goals.length > 0
        ? [...baseNpc.goals]
        : [exploitative ? `Keep feeding the appetite that made ${entity.name} what they are` : `See what lies past ${locName}`],
    knowledge:
      baseNpc && baseNpc.knowledge.length > 0 ? [...baseNpc.knowledge] : [`The ground and rumors around ${locName}`],
    stats,
    inventory: entity.stats ? [...entity.stats.inventory] : [...(baseNpc?.inventory ?? [])],
    sex,
    alignment,
    personalityTemplate: personalityId,
    // A flagged minor never gains a seeded 18+ age; an authored age always survives verbatim.
    age: baseNpc?.age ?? (baseNpc?.isMinor ? undefined : agePick),
    voiceTags: baseNpc?.voiceTags ?? [...voicePicks],
    socialRole: baseNpc?.socialRole ?? `${rolePick} around ${locName}`,
    preferences: baseNpc?.preferences ?? [...preferencePicks],
    // Workstream F perceived signals — authored tags survive verbatim; otherwise the seeded picks.
    appearanceTags: baseNpc?.appearanceTags ?? [...appearancePicks],
    presentationTags: baseNpc?.presentationTags ?? [...presentationPicks],
    socialTraits: baseNpc?.socialTraits ?? [...socialTraitPicks],
    // Declared nature is PRESERVED verbatim — a exploitative NPC stays exploitative in the party.
    exploitative,
  };
  return NpcTemplateSchema.parse(candidate);
}

const EnrichProseSchema = z.object({
  description: z.string().default(""),
  knownLore: z.string().default(""),
  hiddenLore: z.string().default(""),
});

export const ENRICH_SYSTEM_PROMPT = [
  "You deepen a tabletop-RPG NPC who is becoming a permanent companion. You will receive the",
  "character as JSON. Reply with STRICT JSON only — an object with exactly these string fields:",
  '{"description": "...", "knownLore": "...", "hiddenLore": "..."}.',
  "description: 2-3 sentences of physical presence. knownLore: 2-3 sentences of what THEY know",
  "(their past, their secrets they keep). hiddenLore: 2-3 sentences of truths about them they do",
  "NOT know themselves. Write from what the character already is — keep the given personality and",
  "morality exactly, including cruel, selfish, or exploitative natures. Do not soften anyone, do not",
  "moralize, do not make them friendlier than their nature.",
].join(" ");

/** The three prose slots the deepen pass may touch; anything in `frozenSlots` stays verbatim. */
export type ProseSlot = "description" | "knownLore" | "hiddenLore";

/**
 * Optional model pass over the floor's three prose slots, slot-wise (the worldsmith
 * `elaborate()` merge pattern: a blank/omitted slot keeps the floor's text, any failure returns
 * the floor VERBATIM). Runs on the guarded `creative` role — screened by the minor-safety guard
 * exactly like `narrator`, in every mode. Play narration stays on `narrator`; this is authoring
 * prose, so it rides the dedicated creative-writing model when one is configured. `frozenSlots`
 * pins a slot to the floor's text no matter what the model returns — the freeze rule for
 * identity the player has already observed (Workstream A, promotion without a ledger).
 */
export async function enrichTemplateProse(
  gateway: LlmGateway,
  world: World,
  floor: NpcTemplate,
  frozenSlots?: ReadonlySet<ProseSlot>,
): Promise<NpcTemplate> {
  try {
    const res = await gateway.complete("creative", {
      messages: [
        { role: "system", content: ENRICH_SYSTEM_PROMPT },
        {
          role: "user",
          content: `World: ${world.name}\nCharacter:\n${JSON.stringify(
            {
              name: floor.name,
              summary: floor.summary,
              persona: floor.persona,
              personality: floor.personality,
              alignment: floor.alignment,
              exploitative: floor.exploitative,
              description: floor.description,
              knownLore: floor.knownLore,
              hiddenLore: floor.hiddenLore,
            },
            null,
            1,
          )}`,
        },
      ],
      temperature: 0.8,
      json: true,
      maxTokens: 1024,
    });
    // A guard refusal or nothing said at all ⇒ the floor verbatim. (Regex audit §10a: the third
    // arm of this test used to be `res.model.startsWith("offline")`, which handed a self-hoster
    // running "offline-llama-3-8b" the unenriched floor for every companion promotion. The empty
    // check that replaces it is the one this branch was actually missing — an empty completion
    // reached `JSON.parse("")` and only degraded via the catch below.)
    if (res.blocked || !res.text.trim()) return floor;
    const parsed = EnrichProseSchema.parse(JSON.parse(extractJson(res.text)));
    const slot = (name: ProseSlot): string =>
      frozenSlots?.has(name) ? floor[name] : parsed[name].trim() || floor[name];
    return NpcTemplateSchema.parse({
      ...structuredClone(floor),
      description: slot("description"),
      knownLore: slot("knownLore"),
      hiddenLore: slot("hiddenLore"),
    });
  } catch {
    // Unreachable model, garbled JSON, schema mismatch — the deterministic floor stands.
    return floor;
  }
}

/**
 * The promotion entry Stage C's invite flow awaits: compose (floor + optional guarded prose),
 * apply the `enrichNpc` command (templateId + durable slice + tier promotion through the
 * reducer, the only writer), then mirror the finished template into the `world.npcs` content
 * cache exactly like the engine mirrors expansions — `hydrateEnrichments()` rebuilds the same
 * mirror on load. Applies immediately via `ctx.apply` (the mirror must follow the command), so
 * call it from resolve/react and await it. Idempotent: an already-PROMOTED recorded NPC
 * re-applies its RECORDED template verbatim (no LLM, no re-generation — deterministic across
 * reloads); an already-significant, never-recorded NPC (an authored companion) is left
 * untouched. A first-sight PROFILE (recorded but still transient/tracked — NpcProfileModule)
 * becomes the promotion floor: its observed `description` is frozen, its lore slots deepen.
 */
export async function promoteAndEnrich(ctx: TickContext, npcId: string): Promise<void> {
  const entity = ctx.model.entities.get(npcId);
  if (!entity || entity.kind !== "npc") return;
  const world = ctx.services.world;

  const recorded = enrichmentsOf(ctx.model.modules)[npcId];
  if (recorded && entity.tier === "significant") {
    // Already promoted (a reload / re-invite): the recorded template replays VERBATIM.
    const res = ctx.apply({ type: "enrichNpc", npcId, template: structuredClone(recorded) });
    if (!res.rejected) mirrorEnrichment(world, recorded);
    return;
  }
  // Never recorded and already significant ⇒ a fully-authored fixture; nothing to compose.
  if (!recorded && entity.tier === "significant") return;

  // An observed first-sight profile (recorded, not yet significant) IS the floor — promotion
  // deepens it rather than recomposing. The `description` slot is FROZEN: the face the player
  // already saw stays verbatim; knownLore/hiddenLore (never player-visible) may still deepen.
  // Structured identity (sex/age/alignment/personality/role/voice/preferences) survives by
  // construction — the deepen pass only ever touches the three prose slots.
  const floor = recorded ? structuredClone(recorded) : composeNpcTemplate(world, entity);
  const frozen = recorded ? new Set<ProseSlot>(["description"]) : undefined;
  const template = await enrichTemplateProse(ctx.services.gateway, world, floor, frozen);
  const res = ctx.apply({ type: "enrichNpc", npcId, template });
  if (res.mutated) mirrorEnrichment(world, template);
}
