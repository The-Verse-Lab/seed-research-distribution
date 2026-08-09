/**
 * Loader — read a World + Campaign from disk and validate them.
 *
 * Worlds live as JSON under `worlds/`. Zod validates structure; a second pass checks
 * referential integrity (the campaign points at a real location, companions exist, etc.)
 * so authoring mistakes fail loudly at load time rather than mid-session.
 *
 * @author Runkai Zhang
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CampaignSchema,
  WorldSchema,
  type Campaign,
  type Condition,
  type Effect,
  type PlaySet,
  type World,
} from "./schema.ts";
import { compileAuthoringLayer, type ContentDiagnostic } from "./quest-flow.ts";
import { travelPackEvents } from "./travel-packs.ts";
import { assignCoordinates } from "../world/coords.ts";
import { isInteractiveEffect } from "../rules/npc-events.ts";
import { checkCaseSolvability } from "../rules/cases.ts";
import { PERSONALITIES } from "./presets/personalities.ts";
import { seededIdentityFor } from "../worldsmith/reconcile.ts";

/** The valid personality-archetype ids (the preset roster) — the id-validity set for authoring checks. */
const PERSONALITY_PRESET_IDS = new Set(PERSONALITIES.map((p) => p.id));

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Load and validate a play set (world.json + campaign.json) from a directory. */
export async function loadPlaySetFromDir(dir: string): Promise<PlaySet> {
  return compileAndValidatePlaySet(await loadRawPlaySetFromDir(dir)).playset;
}

/** Load raw authoring JSON without compiling quest flows/interactions into generated events. */
export async function loadRawPlaySetFromDir(dir: string): Promise<PlaySet> {
  const world = WorldSchema.parse(await readJson(join(dir, "world.json")));
  const campaign = CampaignSchema.parse(await readJson(join(dir, "campaign.json")));
  return { world, campaign };
}

/** Normalize, compile high-level authoring, merge packs, and validate the playable content. */
export function compileAndValidatePlaySet(raw: PlaySet): { playset: PlaySet; diagnostics: ContentDiagnostic[] } {
  const world = structuredClone(raw.world);
  const campaign = mergeTravelPacks(structuredClone(raw.campaign));
  normalizeExits(world);
  // Fill-only, deterministic 2D layout for authored/frozen content (map system). Runs once at load,
  // before any expansion re-hydrates coord-bearing generated rooms; leaves any authored/baked coords
  // untouched. Pure passenger content — never read by the reducer/model.
  assignCoordinates(world, campaign.startingState.locationId);
  // Fill-only: no NPC may silently run the NEUTRAL personality (the deterministic personality layer,
  // rules/agenda.ts, keys off `personalityTemplate`). Authored values win; an omission is filled with
  // the same id-keyed derivation ambient/generated NPCs already use — byte-stable, replay-safe.
  fillPersonalityDefaults(world);
  const compiled = compileAuthoringLayer(world, campaign);
  validateReferences(world, compiled.campaign);
  return { playset: { world, campaign: compiled.campaign }, diagnostics: compiled.diagnostics };
}

export function mergeTravelPacks(campaign: Campaign): Campaign {
  if (!campaign.travelEventPacks || campaign.travelEventPacks.length === 0) return campaign;
  const used = new Set(campaign.travelEvents.map((ev) => ev.id));
  const packed = travelPackEvents(campaign.travelEventPacks).filter((ev) => {
    if (used.has(ev.id)) return false;
    used.add(ev.id);
    return true;
  });
  if (packed.length === 0) return campaign;
  return { ...campaign, travelEvents: [...campaign.travelEvents, ...packed] };
}

/**
 * Backward compat: a location with legacy `connections` but no authored `exits` gets its
 * exits derived 1:1 (directed, unlocked, visible). After this, the engine reads only `exits`.
 */
export function normalizeExits(world: World): void {
  for (const loc of world.locations) {
    if (loc.exits.length === 0 && loc.connections.length > 0) {
      loc.exits = loc.connections.map((to) => ({ to, locked: false, hidden: false }));
    }
  }
}

/**
 * Fill-only: stamp a deterministic `personalityTemplate` on any NPC that omits one, so the
 * deterministic personality layer (`rules/agenda.ts` `stance`/`personalityBaseline`/`bystanderLeans`/
 * `chooseLeaderDiscipline`) never silently reads NEUTRAL for a hand-authored world. Mirrors
 * `normalizeExits` — mutate the just-parsed world in place, once, before play. Reuses the SAME
 * id-keyed `seededIdentityFor` derivation ambient/generated NPCs already get, so a filled value is
 * byte-stable across reloads and replay-safe. An authored value always wins (only `undefined` is
 * filled), and the pool is the preset roster, so a filled id is always valid.
 */
export function fillPersonalityDefaults(world: World): void {
  for (const npc of world.npcs) {
    if (npc.personalityTemplate === undefined) {
      npc.personalityTemplate = seededIdentityFor("", npc.id).personalityTemplate;
    }
  }
}

/** Cross-checks that ids referenced by the campaign exist in the world. */
export function validateReferences(world: World, campaign: Campaign): void {
  const fail = (msg: string): never => {
    throw new Error(`World/Campaign mismatch: ${msg}`);
  };

  if (campaign.worldId !== world.id) {
    fail(`campaign.worldId "${campaign.worldId}" does not match world.id "${world.id}"`);
  }

  const locationIds = new Set(world.locations.map((l) => l.id));
  const npcIds = new Set(world.npcs.map((n) => n.id));
  const start = campaign.startingState;

  // A misspelled `personalityTemplate` silently no-ops (resolvePreset warns, never throws → the NPC
  // runs NEUTRAL). Fail loud here instead, the same way every other authoring mistake in this pass
  // does, so a typo can't ship a blank-personality NPC.
  for (const npc of world.npcs) {
    if (npc.personalityTemplate !== undefined && !PERSONALITY_PRESET_IDS.has(npc.personalityTemplate)) {
      fail(`NPC "${npc.id}" has unknown personalityTemplate "${npc.personalityTemplate}"`);
    }
  }

  // Spatial integrity: every exit (and any location NPC) must resolve to a real entity.
  // A `frontier:` exit is the deliberate exception — an ungenerated edge the engine expands
  // into a real pocket when the party travels through it (src/world/expansion.ts).
  for (const loc of world.locations) {
    for (const exit of loc.exits) {
      if (exit.to.startsWith("frontier:")) continue;
      if (!locationIds.has(exit.to)) fail(`location "${loc.id}" has an exit to unknown location "${exit.to}"`);
    }
    for (const npcId of loc.npcs) {
      if (!npcIds.has(npcId)) fail(`location "${loc.id}" lists unknown NPC "${npcId}"`);
    }
  }

  if (!locationIds.has(start.locationId)) {
    fail(`startingState.locationId "${start.locationId}" is not a world location`);
  }
  for (const npcId of start.companions) {
    if (!npcIds.has(npcId)) fail(`starting companion "${npcId}" is not a world NPC`);
  }
  for (const scene of campaign.scenes) {
    if (!locationIds.has(scene.locationId)) {
      fail(`scene "${scene.id}" references unknown location "${scene.locationId}"`);
    }
  }
  if (start.openingSceneId && !campaign.scenes.some((s) => s.id === start.openingSceneId)) {
    fail(`openingSceneId "${start.openingSceneId}" is not a campaign scene`);
  }

  validateEventReferences(world, campaign, locationIds, npcIds, fail);
  validateCases(campaign, npcIds, new Set(world.items.map((i) => i.id)), fail);
  validateWorldFacts(world, locationIds, npcIds, fail);
  // Intentionally do NOT walk `campaign.travelEvents`: shared packs use synthetic `foe.*` ambush
  // templates that combat resolves through its generated-monster fallback.
}

/**
 * Epistemic-layer integrity (NPC-EPISTEMIC-CONTEXT-PLAN Phase 1): every id a world fact or a
 * structured NPC knowledge grant names must resolve, fact ids are unique, the supersession graph
 * is acyclic, and a grant carries at least one proposition (factId or statement). A typo here is
 * a fact no access rule can ever match — silent at play time, so it fails at load instead.
 */
function validateWorldFacts(
  world: World,
  locationIds: Set<string>,
  npcIds: Set<string>,
  fail: (msg: string) => never,
): void {
  const facts = world.facts ?? [];
  const factIds = new Set<string>();
  for (const f of facts) {
    if (factIds.has(f.id)) fail(`world fact "${f.id}" is declared twice`);
    factIds.add(f.id);
  }

  const regionIds = regionIdsOf(world);
  const factionIds = factionIdsOf(world);
  const subjectPool = new Set([
    ...npcIds,
    ...locationIds,
    ...factionIds,
    ...world.items.map((i) => i.id),
    ...world.monsters.map((m) => m.id),
  ]);

  for (const f of facts) {
    const where = `world fact "${f.id}"`;
    for (const s of f.subjectIds) {
      if (!subjectPool.has(s)) fail(`${where} subject references unknown entity "${s}"`);
    }
    for (const id of f.scope.locationIds) {
      if (!locationIds.has(id)) fail(`${where} scope references unknown location "${id}"`);
    }
    for (const id of f.scope.regionIds) {
      if (!regionIds.has(id)) fail(`${where} scope references unknown region "${id}"`);
    }
    for (const id of f.scope.factionIds) {
      if (!factionIds.has(id)) fail(`${where} scope references unknown faction "${id}"`);
    }
    if (f.supersededBy !== undefined && !factIds.has(f.supersededBy)) {
      fail(`${where} supersededBy references unknown fact "${f.supersededBy}"`);
    }
  }

  // Supersession chains must terminate — a cycle would make every member permanently "history"
  // with no living successor, which is an authoring error, not a temporal state.
  const nextOf = new Map(facts.filter((f) => f.supersededBy).map((f) => [f.id, f.supersededBy as string]));
  for (const start of nextOf.keys()) {
    const seen = new Set<string>([start]);
    let cur = nextOf.get(start);
    while (cur !== undefined) {
      if (seen.has(cur)) fail(`world fact "${start}" is part of a supersession cycle (at "${cur}")`);
      seen.add(cur);
      cur = nextOf.get(cur);
    }
  }

  // Structured knowledge grants (union entries + privateKnowledge): each must carry a proposition
  // and any named fact must exist.
  for (const npc of world.npcs) {
    const grants = [
      ...npc.knowledge.filter((k): k is Exclude<(typeof npc.knowledge)[number], string> => typeof k !== "string"),
      ...(npc.privateKnowledge ?? []),
    ];
    for (const g of grants) {
      const where = `NPC "${npc.id}" knowledge entry`;
      if (!g.factId && !(g.statement ?? "").trim()) {
        fail(`${where} carries neither a factId nor a statement`);
      }
      if (g.factId && !factIds.has(g.factId)) {
        fail(`${where} references unknown world fact "${g.factId}"`);
      }
    }
  }
}

/**
 * Cases integrity (mystery wave): the questId/culprit/npcKnowledge ids resolve, the pure solvability
 * invariant holds (`checkCaseSolvability`), and the declarative clue manifest is BACKED — every
 * interaction/event clue's facts are actually surfaced by a `revealCaseFact` effect somewhere in the
 * (already compiled) campaign events, every testimony clue's facts are known by some NPC, and any
 * declared physical evidence names a real world item. A
 * caseless campaign walks nothing. Fails loud so an unsolvable/unbacked mystery can never ship.
 */
function validateCases(
  campaign: Campaign,
  npcIds: Set<string>,
  itemIds: Set<string>,
  fail: (msg: string) => never,
): void {
  if (campaign.cases.length === 0) return;
  const questIds = new Set(campaign.quests.map((q) => q.id));

  // caseId → the fact ids some authored `revealCaseFact` effect actually surfaces (incl. nested
  // `check` branches). Compiled quest flows are already folded into `campaign.events` by this point.
  const revealed = new Map<string, Set<string>>();
  const collectReveals = (effects: readonly Effect[]): void => {
    for (const eff of effects) {
      if (eff.kind === "revealCaseFact") {
        const set = revealed.get(eff.caseId) ?? new Set<string>();
        set.add(eff.factId);
        revealed.set(eff.caseId, set);
      } else if (eff.kind === "check") {
        collectReveals(eff.onSuccess);
        collectReveals(eff.onFail);
      }
    }
  };
  for (const ev of campaign.events) collectReveals(ev.effects);

  for (const c of campaign.cases) {
    const where = `case "${c.id}"`;
    if (!questIds.has(c.questId)) fail(`${where} references unknown quest "${c.questId}"`);
    if (!npcIds.has(c.truth.culpritId)) fail(`${where} culprit "${c.truth.culpritId}" is not a world NPC`);
    for (const npcId of Object.keys(c.npcKnowledge)) {
      if (!npcIds.has(npcId)) fail(`${where} npcKnowledge references unknown NPC "${npcId}"`);
    }
    for (const problem of checkCaseSolvability(c)) fail(`${where}: ${problem}`);

    const revealedForCase = revealed.get(c.id) ?? new Set<string>();
    for (const clue of c.clues) {
      if (clue.via === "testimony") {
        const known = clue.revealsFactIds.some((fid) =>
          Object.values(c.npcKnowledge).some((k) => k.knows.includes(fid)),
        );
        if (!known) fail(`${where} testimony clue "${clue.id}" reveals facts no NPC knows`);
      } else {
        for (const fid of clue.revealsFactIds) {
          if (!revealedForCase.has(fid)) {
            fail(`${where} clue "${clue.id}" (via ${clue.via}) declares fact "${fid}" but no revealCaseFact effect surfaces it`);
          }
        }
      }
      // Physical evidence (r5): the objects must exist, and testimony hands nothing over — a spoken
      // account leaves no item behind, so declaring one there is an authoring mistake.
      for (const itemId of clue.evidenceItemIds ?? []) {
        if (clue.via === "testimony") {
          fail(`${where} clue "${clue.id}" is testimony and cannot carry evidence item "${itemId}"`);
        }
        if (!itemIds.has(itemId)) fail(`${where} clue "${clue.id}" evidence item "${itemId}" is not a world item`);
      }
    }
  }
}

/** The id sets a predicate clause may reference — shared by event triggers and schedule slots. */
interface ReferenceSets {
  locationIds: Set<string>;
  questIds: Set<string>;
  entityIds: Set<string>;
  itemIds: Set<string>;
  workIds: Set<string>;
  /** Region ids an `inRegion` clause may name — see `regionIdsOf` for why this is a UNION. */
  regionIds: Set<string>;
  /** Faction ids a `factionStandingAtLeast` clause may name — see `factionIdsOf`. */
  factionIds: Set<string>;
}

/**
 * The region ids that actually EXIST for matching purposes. `inRegion` compares against
 * `regionOfLocation`, which reads a location's own `region` string — a `world.regions[]` row is
 * optional flavour/danger metadata, and several shipped fixtures tag locations with a region they
 * never declare. So the legal set is the UNION of both, or this check would reject working content.
 */
function regionIdsOf(world: World): Set<string> {
  return new Set([
    ...world.regions.map((r) => r.id),
    ...world.locations.map((l) => l.region).filter((r): r is string => !!r),
  ]);
}

/** Same shape for factions: the authored roster, plus every id membership/guild rows actually use. */
function factionIdsOf(world: World): Set<string> {
  return new Set([
    ...world.factions.map((f) => f.id),
    ...world.npcs.map((n) => n.factionId).filter((f): f is string => !!f),
    ...world.locations.map((l) => l.guild?.factionId).filter((f): f is string => !!f),
  ]);
}

/**
 * Clause-level integrity for a predicate list (`TriggerPredicate.allOf` / a schedule slot's
 * `conditions`): every id a clause names must resolve. `label` keeps the historic message shape —
 * events pass "trigger" (byte-identical failures), schedule slots pass "condition".
 */
function validateConditions(
  clauses: Condition[],
  where: string,
  label: string,
  sets: ReferenceSets,
  fail: (msg: string) => never,
): void {
  const bad = (what: string, kind: string, id: string): never =>
    fail(`${where} ${label} ${what} references unknown ${kind} "${id}"`);
  for (const c of clauses) {
    switch (c.kind) {
      case "atLocation":
        if (!sets.locationIds.has(c.locationId)) bad("atLocation", "location", c.locationId);
        break;
      case "questState":
        if (!sets.questIds.has(c.questId)) bad("questState", "quest", c.questId);
        break;
      case "hasItem":
        if (!sets.entityIds.has(c.entityId)) bad("hasItem", "entity", c.entityId);
        if (!sets.itemIds.has(c.itemId)) bad("hasItem", "item", c.itemId);
        break;
      case "relationshipAtLeast":
        if (!sets.entityIds.has(c.actorId)) bad("relationshipAtLeast actor", "entity", c.actorId);
        if (!sets.entityIds.has(c.targetId)) bad("relationshipAtLeast target", "entity", c.targetId);
        break;
      case "entityPresent":
        if (!sets.entityIds.has(c.entityId)) bad("entityPresent", "entity", c.entityId);
        if (c.locationId !== undefined && !sets.locationIds.has(c.locationId)) {
          bad("entityPresent", "location", c.locationId);
        }
        break;
      case "workedOpportunity":
        if (!sets.workIds.has(c.opportunityId)) bad("workedOpportunity", "work opportunity", c.opportunityId);
        break;
      case "interactionUsed":
        if (c.locationId !== undefined && !sets.locationIds.has(c.locationId)) {
          bad("interactionUsed", "location", c.locationId);
        }
        break;
      case "attireState":
        if (c.entityId !== undefined && !sets.entityIds.has(c.entityId)) {
          bad("attireState", "entity", c.entityId);
        }
        break;
      // Regex audit §10c: `inRegion` and `factionStandingAtLeast` had NO case here at all, so a
      // typo'd region loaded green and the gate it guards was simply never true again. Reproduced on
      // the example fixture: an event trigger of `{kind:"inRegion", regionId:"region.nope"}` and one
      // of `{kind:"factionStandingAtLeast", factionId:"faction.nope"}` both loaded without a word,
      // while the neighbouring `atLocation:"loc.nope"` was rejected.
      case "inRegion":
        if (!sets.regionIds.has(c.regionId)) bad("inRegion", "region", c.regionId);
        break;
      case "factionStandingAtLeast":
        if (!sets.factionIds.has(c.factionId)) bad("factionStandingAtLeast", "faction", c.factionId);
        break;
      case "flag":
      case "clockAtLeast":
      // The vulnerability signals name no id — they read the clock, the party, the region profile
      // and the exploitation gauge. Listed EXPLICITLY rather than falling through a default, so the
      // exhaustiveness guard below catches the next clause kind someone adds.
      case "dayPhase":
      case "partyAlone":
      case "regionDangerAtLeast":
        break; // no id to resolve
      default: {
        // A new `Condition` kind must decide, here, what it references. Without this the compiler
        // was silent and the answer defaulted to "nothing" — which is how §10c happened.
        const unreachable: never = c;
        throw new Error(`unhandled condition kind in content validation: ${JSON.stringify(unreachable)}`);
      }
    }
  }
}

/** The id sets an effect may reference — the clause sets plus spawn templates + quest objectives. */
interface EffectReferenceSets extends ReferenceSets {
  npcIds: Set<string>;
  templateIds: Set<string>;
  objectiveIds: Map<string, Set<string>>;
}

/** Effect-level integrity, shared by prebaked/travel-shaped events and NPC personal events. */
function validateEffects(
  effects: Effect[],
  where: string,
  sets: EffectReferenceSets,
  fail: (msg: string) => never,
): void {
  const checkLocation = (id: string, what: string): void => {
    if (!sets.locationIds.has(id)) fail(`${where} ${what} references unknown location "${id}"`);
  };
  const checkQuest = (id: string, what: string): void => {
    if (!sets.questIds.has(id)) fail(`${where} ${what} references unknown quest "${id}"`);
  };
  const checkEntity = (id: string, what: string): void => {
    if (!sets.entityIds.has(id)) fail(`${where} ${what} references unknown entity "${id}"`);
  };
  const checkItem = (id: string, what: string): void => {
    if (!sets.itemIds.has(id)) fail(`${where} ${what} references unknown item "${id}"`);
  };

  for (const eff of effects) {
    switch (eff.kind) {
      case "setQuestState":
        checkQuest(eff.questId, "effect setQuestState");
        break;
      case "setObjectiveDone":
        checkQuest(eff.questId, "effect setObjectiveDone");
        if (!sets.objectiveIds.get(eff.questId)?.has(eff.objectiveId)) {
          fail(`${where} effect setObjectiveDone references unknown objective "${eff.objectiveId}" in quest "${eff.questId}"`);
        }
        break;
      case "adjustRelationship":
        checkEntity(eff.actorId, "effect adjustRelationship actor");
        checkEntity(eff.targetId, "effect adjustRelationship target");
        break;
      case "spawn":
        if (!sets.templateIds.has(eff.templateId)) {
          fail(`${where} effect spawn references unknown template "${eff.templateId}"`);
        }
        checkLocation(eff.locationId, "effect spawn");
        break;
      case "adjustHp":
        checkEntity(eff.entityId, "effect adjustHp");
        break;
      case "setCondition":
        checkEntity(eff.entityId, "effect setCondition");
        break;
      case "giveItem":
        checkItem(eff.itemId, "effect giveItem");
        if (eff.to !== undefined) checkEntity(eff.to, "effect giveItem target");
        break;
      case "transferItem":
        checkItem(eff.itemId, "effect transferItem");
        if (eff.from !== null) checkEntity(eff.from, "effect transferItem source");
        if (eff.to !== null) checkEntity(eff.to, "effect transferItem target");
        break;
      case "setExitState":
        checkLocation(eff.locationId, "effect setExitState");
        if (!eff.to.startsWith("frontier:")) checkLocation(eff.to, "effect setExitState");
        break;
      case "linkExit":
        checkLocation(eff.fromLocationId, "effect linkExit origin");
        checkLocation(eff.to, "effect linkExit target");
        break;
      case "ambush":
        if (!sets.templateIds.has(eff.templateId) && !eff.templateId.startsWith("foe.")) {
          fail(`${where} effect ambush references unknown template "${eff.templateId}"`);
        }
        if (eff.locationId !== undefined) checkLocation(eff.locationId, "effect ambush");
        break;
      case "routineOverride":
        if (eff.npcId !== undefined && !sets.npcIds.has(eff.npcId)) {
          fail(`${where} effect routineOverride references unknown NPC "${eff.npcId}"`);
        }
        checkLocation(eff.locationId, "effect routineOverride");
        break;
      case "narrate":
      case "setFlag":
      case "adjustCoins":
      case "adjustEnergy":
      case "adjustExhaustion":
      case "check":
        break; // no id to resolve
    }
  }
}

/**
 * Prebaked-event + NPC-schedule/-event integrity: every id a trigger clause, effect, schedule
 * slot, or personal event names must resolve, so an authoring typo fails at load instead of
 * silently never firing (or firing against a ghost) at play time. Walks `ev.trigger.allOf`,
 * `ev.effects`, every `npc.schedule` slot, every `npc.events` entry — and (regex audit §10c) the
 * two OTHER places a `TriggerPredicate`/item id hides in authored content: `Exit.barrier`
 * (`keyItemId` and `condition`) and `Work.requires`. Neither was walked; both were reproduced
 * loading green against the example fixture with `item.nope` / `loc.nope` in them, which means a
 * mistyped key was an exit that could never be unlocked and a mistyped gate was a shift that never
 * appeared, in both cases with nothing said at load.
 */
function validateEventReferences(
  world: World,
  campaign: Campaign,
  locationIds: Set<string>,
  npcIds: Set<string>,
  fail: (msg: string) => never,
): void {
  const itemIds = new Set(world.items.map((i) => i.id));
  const workIds = new Set([
    ...world.locations.flatMap((l) => l.work ?? []).map((w) => w.id),
    ...world.npcs.flatMap((n) => n.work ?? []).map((w) => w.id),
  ]);
  const templateIds = new Set([...npcIds, ...world.monsters.map((m) => m.id)]);
  // An "entity" a condition/effect may target: a world NPC or a campaign PC.
  const entityIds = new Set([...npcIds, ...campaign.characters.map((c) => c.id)]);
  const questIds = new Set(campaign.quests.map((q) => q.id));
  const objectiveIds = new Map(
    campaign.quests.map((q) => [q.id, new Set(q.objectives.map((o) => o.id))] as const),
  );
  const sets: ReferenceSets = {
    locationIds,
    questIds,
    entityIds,
    itemIds,
    workIds,
    regionIds: regionIdsOf(world),
    factionIds: factionIdsOf(world),
  };
  const effectSets: EffectReferenceSets = { ...sets, npcIds, templateIds, objectiveIds };

  for (const ev of campaign.events) {
    const where = `event "${ev.id}"`;
    validateConditions(ev.trigger.allOf, where, "trigger", sets, fail);
    validateEffects(ev.effects, where, effectSets, fail);
  }

  // Exit barriers (§10c): a `keyItemId` naming no real item is a door with no key in the world, and
  // a `condition` naming a ghost id is a door that never opens by itself. Both are silent at play
  // time — the move path just narrates the obstacle — so they fail here instead.
  for (const loc of world.locations) {
    for (const exit of loc.exits) {
      const barrier = exit.barrier;
      if (!barrier) continue;
      const where = `location "${loc.id}" exit to "${exit.to}" barrier`;
      if (barrier.keyItemId !== undefined && !itemIds.has(barrier.keyItemId)) {
        fail(`${where} keyItemId references unknown item "${barrier.keyItemId}"`);
      }
      if (barrier.condition) validateConditions(barrier.condition.allOf, where, "condition", sets, fail);
    }
  }

  // Work gates (§10c): `Work.requires` is a full TriggerPredicate and is now evaluated as one
  // (src/rules/work-gate.ts), so a typo'd id there hides a shift from the board forever.
  const workRows = [
    ...world.locations.flatMap((l) => (l.work ?? []).map((w) => [`location "${l.id}"`, w] as const)),
    ...world.npcs.flatMap((n) => (n.work ?? []).map((w) => [`NPC "${n.id}"`, w] as const)),
  ];
  for (const [owner, w] of workRows) {
    if (w.requires) validateConditions(w.requires.allOf, `${owner} work "${w.id}"`, "requires", sets, fail);
  }

  // Routine integrity: schedule slots move NPCs via teleport — the reducer deliberately skips
  // traversal AND destination-existence checks on that path, so a typo'd location would silently
  // strand an NPC in a ghost room. Fail at load instead. Slot conditions get the same clause
  // checks as event triggers.
  for (const npc of world.npcs) {
    const sched = npc.schedule;
    if (!sched) continue;
    const where = `NPC "${npc.id}" schedule`;
    if (sched.defaultLocationId && !locationIds.has(sched.defaultLocationId)) {
      fail(`${where} defaultLocationId references unknown location "${sched.defaultLocationId}"`);
    }
    for (const slot of sched.slots) {
      if (!locationIds.has(slot.locationId)) {
        fail(`${where} slot references unknown location "${slot.locationId}"`);
      }
      validateConditions(slot.conditions, where, "condition", sets, fail);
    }
  }

  // NPC personal events: same trigger/effect integrity, plus the offstage restriction — an
  // `"anywhere"` event applies while the player is elsewhere, so it may not roll the PC, open a
  // scene/fight, or drop items into the player's pack.
  for (const npc of world.npcs) {
    for (const ev of npc.events ?? []) {
      const where = `NPC "${npc.id}" event "${ev.id}"`;
      validateConditions(ev.trigger.allOf, where, "trigger", sets, fail);
      validateEffects(ev.effects, where, effectSets, fail);
      if (ev.scope === "anywhere" && ev.effects.some(isInteractiveEffect)) {
        fail(
          `${where} has scope "anywhere" but carries an interactive effect (check/ambush/giveItem without "to") — offstage events must not reach the player`,
        );
      }
    }
  }
}
