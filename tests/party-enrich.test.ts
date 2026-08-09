/**
 * NPC enrichment (Phase 2, Stage B) — transient→permanent promotion with a deterministic offline
 * floor. Asserts: the `enrichNpc` reducer validation paths + the atomic record (templateId +
 * durable slice + tier promotion via a lockstep tierChanged delta) with detached delta payloads;
 * a focused replay fold (tier/templateId/slice reconstructed); offline composer determinism
 * (same entity id ⇒ byte-identical template), schema validity, and preset-id validity; the
 * hydration round trip (enrich → save shape → hydrateEnrichments + fromGameState — the template
 * survives into world content, the tier survives on the member); the preserved-nature pillar (a
 * exploitative spawn keeps a matching evil morality — enrichment NEVER softens, and joining writes
 * no relationship/disposition bonus); and the `promoteAndEnrich` entry offline (floor verbatim,
 * mirrored into world.npcs, idempotent re-promotion from the recorded slice with no re-compose).
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { applyCommand } from "../src/world/reducer.ts";
import { reduceDeltas } from "./support/replay.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import { enrichmentsOf, hydrateEnrichments, mirrorEnrichment } from "../src/world/enrichment.ts";
import { safetyCharacterOf } from "../src/world/queries.ts";
import { isMinor } from "../src/safety/minor.ts";
import { composeNpcTemplate, enrichTemplateProse, promoteAndEnrich } from "../src/modules/party/enrich.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import { AlignmentIds, NpcTemplateSchema, type NpcTemplate, type PlaySet } from "../src/content/schema.ts";
import { PERSONALITIES } from "../src/content/presets/personalities.ts";
import type { DeltaEvent, EmittedDelta } from "../src/events/deltas.ts";
import type { TickContext } from "../src/engine/tick.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { loadExample } from "./support/harness.ts";

/** A started engine's projected state → a fresh model seeded from the example world. */
async function exampleModel(): Promise<{ model: WorldModel; playset: PlaySet }> {
  const playset = await loadExample();
  const engine = new GameEngine({ classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(1),
  });
  await engine.start();
  return { model: fromGameState(engine.getState(), playset.world, playset.campaign), playset };
}

/** A runtime NPC with NO template behind it — the enrichment target. */
function spawnDrifter(model: WorldModel, id = "npc.drifter"): void {
  const res = applyCommand(model, {
    type: "spawnEntity",
    entity: {
      id,
      kind: "npc",
      tier: "transient",
      name: "The Drifter",
      locationId: "loc.square",
      stats: { currentHp: 9, maxHp: 9, inventory: ["item.lantern"], coins: 4 },
    },
  });
  expect(res.mutated).toBe(true);
}

/** A minimal TickContext over a bare model — apply routes straight through the reducer. */
function makeCtx(model: WorldModel, playset: PlaySet): TickContext {
  const ctx: TickContext = {
    trigger: { kind: "player", input: "" },
    model,
    services: {
      world: playset.world,
      campaign: playset.campaign,
      gateway: new OfflineGateway(),
      rng: mulberry32(1),
    },
    recent: [],
    data: {},
    queue: [],
    enqueue(cmd) {
      ctx.queue.push(cmd);
    },
    apply: (cmd) => applyCommand(model, cmd),
    applySilent: (cmd) => applyCommand(model, cmd),
    dryRun: (cmd) => applyCommand(structuredClone(model), cmd),
    emit() {},
    state: () => toGameState(model),
  };
  return ctx;
}

const stamp = (pre: EmittedDelta[]): DeltaEvent[] =>
  pre.map((d, i) => ({ ...d, id: `d${i}`, at: 0, seq: i }) as DeltaEvent);

describe("enrichNpc — reducer validation + the atomic record", () => {
  test("rejects unknown entities, non-NPC kinds, and a mismatched template id; mutates nothing", async () => {
    const { model, playset } = await exampleModel();
    spawnDrifter(model);
    const template = composeNpcTemplate(playset.world, model.entities.get("npc.drifter")!);
    const before = toGameState(model);

    const unknown = applyCommand(model, { type: "enrichNpc", npcId: "npc.ghost", template });
    expect(unknown.rejected?.reason).toContain("unknown entity");

    const pc = applyCommand(model, { type: "enrichNpc", npcId: "pc.you", template });
    expect(pc.rejected?.reason).toContain("only NPCs");

    applyCommand(model, {
      type: "spawnEntity",
      entity: { id: "mob.rat", kind: "monster", tier: "transient", name: "Rat", locationId: "loc.square", stats: { currentHp: 7, maxHp: 7 } },
    });
    const monster = applyCommand(model, { type: "enrichNpc", npcId: "mob.rat", template });
    expect(monster.rejected?.reason).toContain("only NPCs");
    applyCommand(model, { type: "despawnEntity", entityId: "mob.rat" });

    // The drifter has no templateId, so the template id must be the entity id itself.
    const mismatched = applyCommand(model, {
      type: "enrichNpc",
      npcId: "npc.drifter",
      template: { ...structuredClone(template), id: "npc.somebody-else" },
    });
    expect(mismatched.rejected?.reason).toContain('must be "npc.drifter"');

    expect(toGameState(model)).toEqual(before); // rejected commands mutated nothing
  });

  test("records the template, sets templateId, and promotes the tier — deltas detached + lockstep", async () => {
    const { model, playset } = await exampleModel();
    spawnDrifter(model);
    const entity = model.entities.get("npc.drifter")!;
    expect(entity.templateId).toBeUndefined();
    const template = composeNpcTemplate(playset.world, entity);

    const res = applyCommand(model, { type: "enrichNpc", npcId: "npc.drifter", template });
    expect(res.mutated).toBe(true);
    expect(res.deltas).toEqual([
      { kind: "npcEnriched", npcId: "npc.drifter", template },
      { kind: "tierChanged", entityId: "npc.drifter", tier: "significant" },
    ]);
    expect(entity.templateId).toBe("npc.drifter");
    expect(entity.tier).toBe("significant");
    expect(enrichmentsOf(model.modules)["npc.drifter"]).toEqual(template);

    // The delta's template is a detached copy — mutating it cannot bypass the reducer.
    const carried = (res.deltas[0] as { template: NpcTemplate }).template;
    carried.name = "Somebody Else";
    expect(enrichmentsOf(model.modules)["npc.drifter"]?.name).toBe("The Drifter");

    // Identical repeat is a full noop; a CHANGED template re-records (no tierChanged this time).
    expect(applyCommand(model, { type: "enrichNpc", npcId: "npc.drifter", template }).mutated).toBe(false);
    const revised = { ...structuredClone(template), summary: "The Drifter, changed by the road." };
    const again = applyCommand(model, { type: "enrichNpc", npcId: "npc.drifter", template: revised });
    expect(again.mutated).toBe(true);
    expect(again.deltas).toEqual([{ kind: "npcEnriched", npcId: "npc.drifter", template: revised }]);
    expect(enrichmentsOf(model.modules)["npc.drifter"]?.summary).toBe("The Drifter, changed by the road.");
  });

  test("promote:false records the profile WITHOUT the tier bump; a later default call promotes", async () => {
    const { model, playset } = await exampleModel();
    spawnDrifter(model);
    const entity = model.entities.get("npc.drifter")!;
    const template = composeNpcTemplate(playset.world, entity);

    const profiled = applyCommand(model, { type: "enrichNpc", npcId: "npc.drifter", template, promote: false });
    expect(profiled.mutated).toBe(true);
    expect(profiled.deltas).toEqual([{ kind: "npcEnriched", npcId: "npc.drifter", template }]); // NO tierChanged
    expect(entity.tier).toBe("transient"); // still culled like any bystander
    expect(entity.templateId).toBe("npc.drifter"); // identity bound to THIS individual
    expect(enrichmentsOf(model.modules)["npc.drifter"]).toEqual(template);

    // Identical repeat with promote:false is a full noop — observation ticks stay quiet.
    expect(applyCommand(model, { type: "enrichNpc", npcId: "npc.drifter", template, promote: false }).mutated).toBe(false);

    // The later DEFAULT call (party join) promotes the already-recorded profile: one tierChanged.
    const promoted = applyCommand(model, { type: "enrichNpc", npcId: "npc.drifter", template });
    expect(promoted.mutated).toBe(true);
    expect(promoted.deltas.filter((d) => d.kind === "tierChanged")).toEqual([
      { kind: "tierChanged", entityId: "npc.drifter", tier: "significant" },
    ]);
    expect(entity.tier).toBe("significant");
  });

  test("replay fold reconstructs templateId, tier, and the slice from the deltas", async () => {
    const { model, playset } = await exampleModel();
    const seed = structuredClone(model); // the fold target: the same pristine seed

    const deltas: EmittedDelta[] = [];
    const spawn = applyCommand(model, {
      type: "spawnEntity",
      entity: {
        id: "npc.drifter",
        kind: "npc",
        tier: "transient",
        name: "The Drifter",
        locationId: "loc.square",
        stats: { currentHp: 9, maxHp: 9, inventory: ["item.lantern"], coins: 4 },
      },
    });
    deltas.push(...spawn.deltas);
    const template = composeNpcTemplate(playset.world, model.entities.get("npc.drifter")!);
    const enrich = applyCommand(model, { type: "enrichNpc", npcId: "npc.drifter", template });
    expect(enrich.mutated).toBe(true);
    deltas.push(...enrich.deltas);

    reduceDeltas(seed, stamp(deltas));

    const folded = seed.entities.get("npc.drifter")!;
    expect(folded.tier).toBe("significant");
    expect(folded.templateId).toBe("npc.drifter");
    expect(enrichmentsOf(seed.modules)["npc.drifter"]).toEqual(template);
    expect(toGameState(seed)).toEqual(toGameState(model));
  });
});

describe("composeNpcTemplate — the deterministic offline floor", () => {
  test("same entity ⇒ byte-identical, schema-valid template with catalog preset ids", async () => {
    const { model, playset } = await exampleModel();
    spawnDrifter(model);
    const entity = model.entities.get("npc.drifter")!;

    const a = composeNpcTemplate(playset.world, entity);
    const b = composeNpcTemplate(playset.world, entity);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // byte-identical — seeded from the entity id

    expect(NpcTemplateSchema.safeParse(a).success).toBe(true);
    expect(AlignmentIds).toContain(a.alignment!);
    expect(PERSONALITIES.map((p) => p.id)).toContain(a.personalityTemplate!);

    // Composed FROM WHAT THE ENTITY ALREADY IS: its id, name, live body, and carried goods.
    expect(a.id).toBe("npc.drifter");
    expect(a.name).toBe("The Drifter");
    expect(a.stats?.maxHp).toBe(9); // the live maxHp — what fromGameState re-derives on reload
    expect(a.inventory).toEqual(["item.lantern"]);
    expect(a.persona.length).toBeGreaterThan(0);
    expect(a.knownLore.length).toBeGreaterThan(0);
    expect(a.hiddenLore.length).toBeGreaterThan(0);
  });

  test("an authored base template keeps its authored voice (persona/summary survive)", async () => {
    const { model, playset } = await exampleModel();
    // Give brann a body (the Stage-A promotion move), then compose — npc.brann IS authored.
    applyCommand(model, { type: "despawnEntity", entityId: "npc.brann" });
    applyCommand(model, {
      type: "spawnEntity",
      entity: {
        id: "npc.brann",
        kind: "npc",
        tier: "tracked",
        name: "Brann",
        locationId: "loc.tavern",
        templateId: "npc.brann",
        stats: { currentHp: 12, maxHp: 12 },
      },
    });
    const authored = playset.world.npcs.find((n) => n.id === "npc.brann")!;
    const composed = composeNpcTemplate(playset.world, model.entities.get("npc.brann")!);
    expect(composed.id).toBe("npc.brann");
    expect(composed.persona).toBe(authored.persona);
    expect(composed.summary).toBe(authored.summary);
    expect(composed.goals).toEqual(authored.goals);
    expect(composed.stats?.maxHp).toBe(12); // live body still wins the maxHp
  });

  test("a exploitative nature is PRESERVED: matching evil morality, no softening, no join bonus", async () => {
    const { model, playset } = await exampleModel();
    // Author a exploitative template into the world, then spawn its entity — "what it already is".
    playset.world.npcs.push(
      NpcTemplateSchema.parse({
        id: "npc.vex",
        name: "Vex",
        persona: "A patient hunter of travellers.",
        exploitative: true,
      }),
    );
    applyCommand(model, {
      type: "spawnEntity",
      entity: {
        id: "npc.vex",
        kind: "npc",
        tier: "tracked",
        name: "Vex",
        locationId: "loc.square",
        templateId: "npc.vex",
        stats: { currentHp: 14, maxHp: 14 },
      },
    });

    const composed = composeNpcTemplate(playset.world, model.entities.get("npc.vex")!);
    expect(composed.exploitative).toBe(true); // the declared nature survives enrichment verbatim
    expect(["le", "ne", "ce"]).toContain(composed.alignment!); // morality MATCHES the nature
    expect(["brute", "schemer", "hedonist", "trickster", "firebrand", "survivor"]).toContain(
      composed.personalityTemplate!,
    );

    // Enrichment + join is mechanically NEUTRAL: no relationship/disposition bonus rides promotion,
    // and downstream systems see the member like any other NPC.
    const relationshipsBefore = structuredClone(
      Object.fromEntries([...model.relationships].map(([k, m]) => [k, Object.fromEntries(m)])),
    );
    applyCommand(model, { type: "enrichNpc", npcId: "npc.vex", template: composed });
    applyCommand(model, { type: "setPartyMembership", entityId: "npc.vex", member: true });
    expect(Object.fromEntries([...model.relationships].map(([k, m]) => [k, Object.fromEntries(m)]))).toEqual(
      relationshipsBefore,
    );
    expect(enrichmentsOf(model.modules)["npc.vex"]?.exploitative).toBe(true);
  });
});

describe("composeNpcTemplate — Workstream A profile draws (age/voice/role/preferences)", () => {
  test("the floor carries an explicit 18+ age and full seeded profile fields", async () => {
    const { model, playset } = await exampleModel();
    spawnDrifter(model);
    const composed = composeNpcTemplate(playset.world, model.entities.get("npc.drifter")!);

    expect(composed.age).toBeGreaterThanOrEqual(19); // never an ambiguous-age runtime spawn
    expect(composed.age).toBeLessThanOrEqual(66);
    expect(composed.isMinor).toBeUndefined();
    expect(composed.voiceTags).toHaveLength(2);
    expect(new Set(composed.voiceTags).size).toBe(2); // distinct
    expect(composed.preferences).toHaveLength(2);
    expect(new Set(composed.preferences).size).toBe(2);
    // Location-flavored social role: the drifter stands in loc.square ("Town Square").
    expect(composed.socialRole).toContain(" around ");
    expect(composed.socialRole).toContain(playset.world.locations.find((l) => l.id === "loc.square")!.name);
  });

  test("draw-order regression pin: a fixed entity id keeps its PRE-CHANGE picks", async () => {
    // These are npc.drifter's seeded picks from BEFORE the profile draws existed. New draws
    // must APPEND after sexPick — if any of these move, the rng stream broke for saved worlds.
    const { model, playset } = await exampleModel();
    spawnDrifter(model);
    const composed = composeNpcTemplate(playset.world, model.entities.get("npc.drifter")!);
    expect(composed.alignment).toBe("ln");
    expect(composed.personalityTemplate).toBe("zealot");
    expect(composed.sex).toBe("female");
  });

  test("authored age/isMinor and profile fields survive VERBATIM; a flagged minor never gains a 18+ age", async () => {
    const { model, playset } = await exampleModel();
    playset.world.npcs.push(
      NpcTemplateSchema.parse({
        id: "npc.ward",
        name: "The Ward",
        persona: "A quiet charge.",
        age: 12,
        isMinor: true,
        voiceTags: ["AUTHORED-VOICE"],
        socialRole: "AUTHORED-ROLE",
        preferences: ["AUTHORED-PREFERENCE"],
      }),
      NpcTemplateSchema.parse({
        id: "npc.stray",
        name: "The Stray",
        persona: "A hungry shadow.",
        isMinor: true, // flagged, no authored age
      }),
    );
    for (const id of ["npc.ward", "npc.stray"]) {
      applyCommand(model, {
        type: "spawnEntity",
        entity: { id, kind: "npc", tier: "tracked", name: id, locationId: "loc.square", templateId: id, stats: { currentHp: 6, maxHp: 6 } },
      });
    }

    const ward = composeNpcTemplate(playset.world, model.entities.get("npc.ward")!);
    expect(ward.age).toBe(12);
    expect(ward.isMinor).toBe(true);
    expect(ward.voiceTags).toEqual(["AUTHORED-VOICE"]);
    expect(ward.socialRole).toBe("AUTHORED-ROLE");
    expect(ward.preferences).toEqual(["AUTHORED-PREFERENCE"]);

    const stray = composeNpcTemplate(playset.world, model.entities.get("npc.stray")!);
    expect(stray.isMinor).toBe(true);
    expect(stray.age).toBeUndefined(); // the seeded 18+ age never lands on a flagged minor
  });

  test("pre-profile content still parses (new fields optional) and the floor stays schema-valid", () => {
    const legacy = NpcTemplateSchema.parse({ id: "npc.old", name: "Old One", persona: "Was here first." });
    expect(legacy.voiceTags).toBeUndefined();
    expect(legacy.socialRole).toBeUndefined();
    expect(legacy.preferences).toBeUndefined();
  });
});

/** A stub gateway whose narrator role returns a canned completion (the online-path probe). */
function cannedGateway(text: string, blocked = false, model = "canned-model"): LlmGateway {
  return {
    complete: () => Promise.resolve({ text, model, ...(blocked ? { blocked: true } : {}) }),
    stream: async function* () {
      yield { text };
    },
    embed: () => Promise.resolve({ vectors: [], model }),
  } as unknown as LlmGateway;
}

describe("enrichTemplateProse — the guarded, slot-wise prose pass", () => {
  test("offline and guard-blocked completions fall back to the floor VERBATIM", async () => {
    const { model, playset } = await exampleModel();
    spawnDrifter(model);
    const floor = composeNpcTemplate(playset.world, model.entities.get("npc.drifter")!);

    const offline = await enrichTemplateProse(new OfflineGateway(), playset.world, floor);
    expect(offline).toEqual(floor);

    // A guard refusal (the one hard line) — the deterministic floor stands; promotion never fails.
    const blocked = await enrichTemplateProse(cannedGateway("", true), playset.world, floor);
    expect(blocked).toEqual(floor);

    // Garbled output also drops to the floor (never a half-formed template).
    const garbled = await enrichTemplateProse(cannedGateway("not json at all"), playset.world, floor);
    expect(garbled).toEqual(floor);

    // An EMPTY completion floors on its own branch now, not via the JSON.parse throw (§10a).
    const silent = await enrichTemplateProse(cannedGateway("   \n "), playset.world, floor);
    expect(silent).toEqual(floor);
  });

  // Regex audit §10a: `isOfflineModel(res.model)` used to sit on this branch, so a self-hoster whose
  // model tag begins "offline" got the unenriched floor for every companion promotion — silently.
  test("a model tagged \"offline-llama-3-8b\" is a real model — its prose is merged", async () => {
    const { model, playset } = await exampleModel();
    spawnDrifter(model);
    const floor = composeNpcTemplate(playset.world, model.entities.get("npc.drifter")!);
    const gateway = cannedGateway(
      JSON.stringify({ description: "A scarred silhouette in a road-stained coat." }),
      false,
      "offline-llama-3-8b",
    );

    const merged = await enrichTemplateProse(gateway, playset.world, floor);
    expect(merged.description).toBe("A scarred silhouette in a road-stained coat.");
  });

  test("model prose merges SLOT-WISE: filled slots overlay, blank slots keep the floor", async () => {
    const { model, playset } = await exampleModel();
    spawnDrifter(model);
    const floor = composeNpcTemplate(playset.world, model.entities.get("npc.drifter")!);
    const gateway = cannedGateway(
      JSON.stringify({ description: "A scarred silhouette in a road-stained coat.", knownLore: "  " }),
    );

    const merged = await enrichTemplateProse(gateway, playset.world, floor);
    expect(merged.description).toBe("A scarred silhouette in a road-stained coat.");
    expect(merged.knownLore).toBe(floor.knownLore); // blank slot keeps the floor
    expect(merged.hiddenLore).toBe(floor.hiddenLore); // omitted slot keeps the floor
    // Everything mechanical is untouched by the prose pass — the model fills prose slots only.
    expect(merged.alignment).toBe(floor.alignment!);
    expect(merged.personalityTemplate).toBe(floor.personalityTemplate!);
    expect(merged.stats).toEqual(floor.stats!);
    expect(merged.exploitative).toBe(floor.exploitative);
  });
});

describe("enrichment — hydration round trip (the expansion twin)", () => {
  test("enrich → save shape → hydrateEnrichments + fromGameState: template + tier survive", async () => {
    const { model, playset } = await exampleModel();
    spawnDrifter(model);
    applyCommand(model, { type: "setPartyMembership", entityId: "npc.drifter", member: true });
    const template = composeNpcTemplate(playset.world, model.entities.get("npc.drifter")!);
    expect(applyCommand(model, { type: "enrichNpc", npcId: "npc.drifter", template }).mutated).toBe(true);
    mirrorEnrichment(playset.world, template); // the engine-side content mirror at promotion time

    // Persist and reload into FRESH world content — a process restart, not the same objects.
    const saved = JSON.parse(JSON.stringify(toGameState(model)));
    const fresh = await loadExample();
    expect(fresh.world.npcs.some((n) => n.id === "npc.drifter")).toBe(false); // authored content has no drifter
    hydrateEnrichments(fresh.world, saved.modules); // the engine.start() order: hydrate BEFORE fromGameState
    const restored = fromGameState(saved, fresh.world, fresh.campaign);

    expect(fresh.world.npcs.find((n) => n.id === "npc.drifter")).toEqual(template);
    const drifter = restored.entities.get("npc.drifter")!;
    expect(drifter.tier).toBe("significant"); // the promotion survived the reload
    expect(drifter.templateId).toBe("npc.drifter");
    expect(drifter.partyMember).toBe(true);
    expect(drifter.stats?.maxHp).toBe(9); // re-derived from the hydrated template
    expect(enrichmentsOf(restored.modules)["npc.drifter"]).toEqual(template);

    // Idempotent: hydrating again neither duplicates nor drifts the mirror.
    const count = fresh.world.npcs.length;
    hydrateEnrichments(fresh.world, saved.modules);
    expect(fresh.world.npcs.length).toBe(count);
  });

  test("a SPAWNED INSTANCE of an authored template enriches under its OWN id — the shared template survives", async () => {
    const { model, playset } = await exampleModel();
    const authoredLyra = structuredClone(playset.world.npcs.find((n) => n.id === "npc.lyra")!);
    // The events-module spawn pattern: entity id `<templateId>#n`, templateId set, name diverged.
    applyCommand(model, {
      type: "spawnEntity",
      entity: {
        id: "npc.lyra#0",
        kind: "npc",
        tier: "tracked",
        name: "Lyra's Twin",
        locationId: "loc.square",
        templateId: "npc.lyra",
        stats: { currentHp: 12, maxHp: 12 },
      },
    });
    applyCommand(model, { type: "setPartyMembership", entityId: "npc.lyra#0", member: true });

    const template = composeNpcTemplate(playset.world, model.entities.get("npc.lyra#0")!);
    expect(template.id).toBe("npc.lyra#0"); // named for THIS individual, not the shared template
    expect(template.persona).toBe(authoredLyra.persona); // seeded from what she already is

    // A template still carrying the SHARED id is rejected — the overwrite path is closed.
    const collided = applyCommand(model, {
      type: "enrichNpc",
      npcId: "npc.lyra#0",
      template: { ...structuredClone(template), id: "npc.lyra" },
    });
    expect(collided.rejected?.reason).toContain('must be "npc.lyra#0"');

    expect(applyCommand(model, { type: "enrichNpc", npcId: "npc.lyra#0", template }).mutated).toBe(true);
    expect(model.entities.get("npc.lyra#0")?.templateId).toBe("npc.lyra#0"); // retargeted at herself
    mirrorEnrichment(playset.world, template);
    // The authored entry is untouched — every sibling entity still resolves the authored Lyra.
    expect(playset.world.npcs.find((n) => n.id === "npc.lyra")).toEqual(authoredLyra);
    expect(playset.world.npcs.find((n) => n.id === "npc.lyra#0")).toEqual(template);

    // Wound her, then the full reload round trip: identity and true maxHp both survive.
    applyCommand(model, { type: "adjustHp", entityId: "npc.lyra#0", by: -7 });
    const saved = JSON.parse(JSON.stringify(toGameState(model)));
    const fresh = await loadExample();
    hydrateEnrichments(fresh.world, saved.modules);
    const restored = fromGameState(saved, fresh.world, fresh.campaign);

    const twin = restored.entities.get("npc.lyra#0")!;
    expect(twin.name).toBe("Lyra's Twin"); // not the raw id
    expect(twin.templateId).toBe("npc.lyra#0"); // the template link survived
    expect(twin.stats?.currentHp).toBe(5);
    expect(twin.stats?.maxHp).toBe(12); // the wound did NOT bake into max HP
    // And the authored Lyra reloads as her authored self.
    expect(fresh.world.npcs.find((n) => n.id === "npc.lyra")).toEqual(authoredLyra);
    expect(restored.entities.get("npc.lyra")?.name).toBe(authoredLyra.name);
  });

  test("an enriched AUTHORED npc replaces its world entry on hydration (no duplicate id)", async () => {
    const { model, playset } = await exampleModel();
    applyCommand(model, { type: "despawnEntity", entityId: "npc.brann" });
    applyCommand(model, {
      type: "spawnEntity",
      entity: {
        id: "npc.brann",
        kind: "npc",
        tier: "tracked",
        name: "Brann",
        locationId: "loc.tavern",
        templateId: "npc.brann",
        stats: { currentHp: 12, maxHp: 12 },
      },
    });
    const template = composeNpcTemplate(playset.world, model.entities.get("npc.brann")!);
    applyCommand(model, { type: "enrichNpc", npcId: "npc.brann", template });

    const saved = JSON.parse(JSON.stringify(toGameState(model)));
    const fresh = await loadExample();
    hydrateEnrichments(fresh.world, saved.modules);
    const matches = fresh.world.npcs.filter((n) => n.id === "npc.brann");
    expect(matches).toHaveLength(1); // replaced, not appended
    expect(matches[0]).toEqual(template);
  });
});

describe("promoteAndEnrich — the Stage-C entry, offline", () => {
  test("offline: the floor lands verbatim (deterministic), mirrored into world.npcs, tier promoted", async () => {
    const { model, playset } = await exampleModel();
    const ctx = makeCtx(model, playset);
    spawnDrifter(model);
    applyCommand(model, { type: "setPartyMembership", entityId: "npc.drifter", member: true });
    const expected = composeNpcTemplate(playset.world, model.entities.get("npc.drifter")!);

    await promoteAndEnrich(ctx, "npc.drifter");

    // Offline gateway ⇒ the deterministic floor VERBATIM (no model prose, no stall).
    expect(enrichmentsOf(model.modules)["npc.drifter"]).toEqual(expected);
    expect(playset.world.npcs.find((n) => n.id === "npc.drifter")).toEqual(expected);
    expect(model.entities.get("npc.drifter")?.tier).toBe("significant");
    expect(model.entities.get("npc.drifter")?.templateId).toBe("npc.drifter");
  });

  test("re-promotion replays the RECORDED template (no re-compose) and stays idempotent", async () => {
    const { model, playset } = await exampleModel();
    const ctx = makeCtx(model, playset);
    spawnDrifter(model);
    await promoteAndEnrich(ctx, "npc.drifter");
    const recorded = structuredClone(enrichmentsOf(model.modules)["npc.drifter"]!);
    const npcCount = playset.world.npcs.length;

    // Change the world content the composer would read — the recorded template must still win.
    model.entities.get("npc.drifter")!.name = "The Drifter";
    await promoteAndEnrich(ctx, "npc.drifter");

    expect(enrichmentsOf(model.modules)["npc.drifter"]).toEqual(recorded);
    expect(playset.world.npcs.length).toBe(npcCount); // replaced in place, never duplicated
  });

  test("an authored significant companion is left untouched (nothing recorded, nothing rewritten)", async () => {
    const { model, playset } = await exampleModel();
    const ctx = makeCtx(model, playset);
    const authoredLyra = structuredClone(playset.world.npcs.find((n) => n.id === "npc.lyra")!);
    expect(model.entities.get("npc.lyra")?.tier).toBe("significant");

    await promoteAndEnrich(ctx, "npc.lyra");

    expect(enrichmentsOf(model.modules)["npc.lyra"]).toBeUndefined();
    expect(playset.world.npcs.find((n) => n.id === "npc.lyra")).toEqual(authoredLyra);
  });
});

describe("promoteAndEnrich — the freeze rule over an observed profile (Workstream A)", () => {
  test("promotion keeps the OBSERVED description verbatim; lore deepens; identity survives byte-for-byte", async () => {
    const { model, playset } = await exampleModel();
    spawnDrifter(model);
    // First observation (the NpcProfileModule move): the floor recorded WITHOUT promotion.
    const observed = composeNpcTemplate(playset.world, model.entities.get("npc.drifter")!);
    expect(applyCommand(model, { type: "enrichNpc", npcId: "npc.drifter", template: observed, promote: false }).mutated).toBe(true);
    expect(model.entities.get("npc.drifter")?.tier).toBe("transient");

    // The invite, with a creative gateway that rewrites ALL THREE prose slots.
    const ctx = makeCtx(model, playset);
    ctx.services.gateway = cannedGateway(
      JSON.stringify({
        description: "A COMPLETELY DIFFERENT FACE.",
        knownLore: "DEEPENED-KNOWN",
        hiddenLore: "DEEPENED-HIDDEN",
      }),
    );
    await promoteAndEnrich(ctx, "npc.drifter");

    const promoted = enrichmentsOf(model.modules)["npc.drifter"]!;
    expect(promoted.description).toBe(observed.description); // the face the player saw — FROZEN
    expect(promoted.knownLore).toBe("DEEPENED-KNOWN"); // never player-visible — may deepen
    expect(promoted.hiddenLore).toBe("DEEPENED-HIDDEN");
    // Transient-stated identity survives promotion verbatim (doc acceptance).
    expect(promoted.sex).toBe(observed.sex!);
    expect(promoted.age).toBe(observed.age!);
    expect(promoted.alignment).toBe(observed.alignment!);
    expect(promoted.personalityTemplate).toBe(observed.personalityTemplate!);
    expect(promoted.socialRole).toBe(observed.socialRole!);
    expect(promoted.voiceTags).toEqual(observed.voiceTags!);
    expect(promoted.preferences).toEqual(observed.preferences!);
    expect(model.entities.get("npc.drifter")?.tier).toBe("significant"); // the promotion half fired
    expect(playset.world.npcs.find((n) => n.id === "npc.drifter")).toEqual(promoted); // mirror follows
  });

  test("a recorded, already-significant NPC re-applies with ZERO gateway calls", async () => {
    const { model, playset } = await exampleModel();
    spawnDrifter(model);
    const ctx = makeCtx(model, playset);
    await promoteAndEnrich(ctx, "npc.drifter"); // records + promotes (offline floor)
    const recorded = structuredClone(enrichmentsOf(model.modules)["npc.drifter"]!);

    let calls = 0;
    ctx.services.gateway = {
      complete: () => {
        calls++;
        return Promise.resolve({ text: "{}", model: "counted" });
      },
      stream: async function* () {
        calls++;
        yield { text: "" };
      },
      embed: () => Promise.resolve({ vectors: [], model: "counted" }),
    } as unknown as LlmGateway;
    await promoteAndEnrich(ctx, "npc.drifter");

    expect(calls).toBe(0); // the reload path is pure replay
    expect(enrichmentsOf(model.modules)["npc.drifter"]).toEqual(recorded);
  });

  test("minor gating: an authored-minor spawn keeps its minor facts through profile AND promotion", async () => {
    const { model, playset } = await exampleModel();
    playset.world.npcs.push(
      NpcTemplateSchema.parse({
        id: "npc.cub",
        name: "The Cub",
        persona: "Underfoot.",
        age: 12,
        isMinor: true,
      }),
    );
    // The events-module spawn shape: instance id, templateId at the authored minor.
    applyCommand(model, {
      type: "spawnEntity",
      entity: { id: "npc.cub#0", kind: "npc", tier: "transient", name: "The Cub", locationId: "loc.square", templateId: "npc.cub", stats: { currentHp: 4, maxHp: 4 } },
    });
    const profile = composeNpcTemplate(playset.world, model.entities.get("npc.cub#0")!);
    expect(profile.age).toBe(12); // authored minor facts survive the composer verbatim
    expect(profile.isMinor).toBe(true);
    applyCommand(model, { type: "enrichNpc", npcId: "npc.cub#0", template: profile, promote: false });
    mirrorEnrichment(playset.world, profile);

    // The canonical safety join resolves the profiled facts through the mirror.
    const cub = safetyCharacterOf(model, playset.world, playset.campaign, "npc.cub#0");
    expect(isMinor(cub)).toBe(true); // the canonical minor-safety predicate holds

    // And a plain profiled 18+ character resolves as one — the unknown-age hole is closed.
    spawnDrifter(model);
    const profiled = composeNpcTemplate(playset.world, model.entities.get("npc.drifter")!);
    applyCommand(model, { type: "enrichNpc", npcId: "npc.drifter", template: profiled, promote: false });
    mirrorEnrichment(playset.world, profiled);
    const drifter = safetyCharacterOf(model, playset.world, playset.campaign, "npc.drifter");
    expect(drifter.age).toBe(profiled.age!);
    expect(isMinor(drifter)).toBe(false);
  });
});
