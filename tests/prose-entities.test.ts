/**
 * Prose-entity grounding (ASK 1) — a character the GM narrates into a scene becomes a real registry
 * entity, so the next turn's "to the Keeper" grounds instead of mis-routing to whoever is PRESENT.
 * Engine-wired: a stub gateway narrates prose naming a new character and scripts the utility-role
 * EXTRACTOR's npc list; the module spawns it (transient, at the party location), records a template,
 * and stamps a once-per-campaign flag. Replay-safe via the existing entitySpawned/npcEnriched deltas.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { heuristicClassifier } from "./support/test-classifier.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { CompletionRequest, CompletionResult, LlmRole } from "../src/llm/types.ts";

/** Narrates prose that names a new character and, for the prose-entity EXTRACTOR call, returns a
 *  scripted npc list. Everything else falls back to the deterministic offline stub. */
class ProseGateway extends OfflineGateway {
  constructor(
    private readonly prose: string,
    private readonly npcs: unknown,
  ) {
    super();
  }
  override complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    if (role === "utility") {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("EXTRACTOR")) {
        return Promise.resolve({ text: JSON.stringify({ npcs: this.npcs, places: [] }), model: "stub-utility" });
      }
    }
    if (role === "narrator" || role === "creative") {
      return Promise.resolve({ text: this.prose, model: `stub-${role}` });
    }
    return super.complete(role, req);
  }
}

function buildPlayset(extraLocations: Array<Record<string, unknown>> = []): PlaySet {
  const world = WorldSchema.parse({
    id: "w.prose",
    name: "Prosehold",
    summary: "A test world.",
    constitution: { danger: 2 },
    locations: [
      { id: "loc.room", name: "The Counting Room", description: "Scales and ledgers line the walls.", npcs: [] },
      ...extraLocations,
    ],
    npcs: [],
  });
  const campaign = CampaignSchema.parse({
    id: "c.prose",
    name: "Prose Test",
    worldId: "w.prose",
    characters: [
      { id: "pc.you", name: "You", stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 12, armorClass: 10 }, age: 30 },
    ],
    startingState: { locationId: "loc.room", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

function start(gateway: LlmGateway, extraLocations: Array<Record<string, unknown>> = []): Promise<GameEngine> {
  const engine = new GameEngine({
    classifier: heuristicClassifier,
    playset: buildPlayset(extraLocations),
    store: new InMemoryGameStateStore(),
    gateway,
    rng: mulberry32(1),
  });
  return engine.start().then(() => engine);
}

/** Narrates fixed prose and COUNTS extractor calls (returning no npcs), so a spec can pin whether
 *  the cost gate spent a utility call at all — the r10 latency finding was exactly that spend. */
class CountingGateway extends OfflineGateway {
  extractorCalls = 0;
  constructor(private readonly prose: string) {
    super();
  }
  override complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    if (role === "utility") {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("EXTRACTOR")) {
        this.extractorCalls += 1;
        return Promise.resolve({ text: JSON.stringify({ npcs: [], places: [] }), model: "stub-utility" });
      }
    }
    if (role === "narrator" || role === "creative") {
      return Promise.resolve({ text: this.prose, model: `stub-${role}` });
    }
    return super.complete(role, req);
  }
}

const KEEPER_ID = "npc.prose.the-keeper-of-weights";

describe("prose-entity grounding (ASK 1)", () => {
  test("a narrator-named character is spawned into the registry at the party location", async () => {
    const gateway = new ProseGateway(
      "The Keeper of Weights sets down the scales and watches you.",
      [{ name: "the Keeper of Weights", disposition: "hostile" }],
    );
    const engine = await start(gateway);
    await engine.submitPlayerInput("I look around the chamber.");
    const state = engine.getState();
    // It is now a real, actor-projected entity at the room.
    expect(state.actors[KEEPER_ID]).toBeDefined();
    expect(state.actors[KEEPER_ID]?.locationId).toBe("loc.room");
    // Once-per-campaign flag stamped; a hostile prose NPC starts antagonistic to the PC.
    expect(state.flags?.["prose.spawned.the-keeper-of-weights"]).toBe(true);
    expect(state.relationships[KEEPER_ID]?.["pc.you"]).toBe(-60);
  });

  test("the same name is not re-spawned on a later turn (once-per-campaign)", async () => {
    const gateway = new ProseGateway(
      "The Keeper of Weights lingers by the door.",
      [{ name: "the Keeper of Weights", disposition: "hostile" }],
    );
    const engine = await start(gateway);
    await engine.submitPlayerInput("I look around the chamber.");
    await engine.submitPlayerInput("I look again, slowly.");
    const state = engine.getState();
    expect(state.actors[KEEPER_ID]).toBeDefined();
    expect(state.actors[`${KEEPER_ID}#1`]).toBeUndefined(); // no duplicate
  });

  test("prose-established gender wins over the seeded rng draw (no pronoun flip)", async () => {
    // The GM narrated Gretta as a woman; the extractor reports sex:female. The spawned template MUST
    // carry that gender rather than a blind id-keyed roll, so a later brief can't flip her pronouns.
    const gateway = new ProseGateway(
      "A broad-shouldered woman named Gretta hefts a crate; her grey hair is cropped short.",
      [{ name: "Gretta", disposition: "friendly", sex: "female" }],
    );
    const engine = await start(gateway);
    let enrichedSex: string | undefined;
    engine.subscribe((ev) => {
      if (ev.kind === "npcEnriched" && ev.npcId === "npc.prose.gretta") {
        enrichedSex = (ev as { template: { sex?: string } }).template.sex;
      }
    });
    await engine.submitPlayerInput("I approach the woman.");
    expect(engine.getState().actors["npc.prose.gretta"]).toBeDefined();
    expect(enrichedSex).toBe("female");
  });

  test("a name absent from the narration is DROPPED — no manufactured actor (audit #5)", async () => {
    // The prose introduces an "Iron Door" (so the cost gate fires the extractor), but the extractor
    // HALLUCINATES a hostile "Vorlag the Reaver" that never appears in the passage. The membership
    // guard must drop it — prose may only realize a character it actually named, never invent one
    // (potentially exploitative) that inverts the engine's causality.
    const gateway = new ProseGateway(
      "A cold draft moves through the Counting Room; beyond the Iron Door a bell tolls twice.",
      [{ name: "Vorlag the Reaver", disposition: "hostile" }],
    );
    const engine = await start(gateway);
    await engine.submitPlayerInput("I look around the chamber.");
    const actors = Object.keys(engine.getState().actors);
    expect(actors.some((id) => id.includes("vorlag") || id.includes("reaver"))).toBe(false);
    expect(actors.some((id) => id.startsWith("npc.prose."))).toBe(false);
  });

  test("a name mentioned ONLY inside quoted dialogue is NOT staged — no phantom actor (D4 07-17)", async () => {
    // Live D4: the Salt Revenant merely NAMED "Xate of Anchorfall" in its speech and Xate was
    // promoted into the present roster as a statted threat. A character every occurrence of whose
    // name sits inside a quotation was talked ABOUT, not staged — it must not materialize.
    const gateway = new ProseGateway(
      'The Keeper of Weights leans close. "Xate of Anchorfall will hear of this," it rasps. "Xate forgets nothing."',
      [
        { name: "the Keeper of Weights", disposition: "neutral" },
        { name: "Xate of Anchorfall", disposition: "hostile" },
      ],
    );
    const engine = await start(gateway);
    await engine.submitPlayerInput("I hold my ground.");
    const actors = Object.keys(engine.getState().actors);
    // The Keeper is narrated OUTSIDE the quotes (staged) ⇒ spawns; Xate lives only inside them ⇒ dropped.
    expect(actors).toContain(KEEPER_ID);
    expect(actors.some((id) => id.includes("xate") || id.includes("anchorfall"))).toBe(false);
  });

  test("scenery read as a person is DROPPED — no quantifier-headed 'character' (r5 P1)", async () => {
    // The r5 run turned "the oldest standing stone" into a person called "One of the Standing" and
    // carried it for the rest of the session: every later scene ended "There is no sign of One of
    // the Standing here.", and the bare word "One" rendered as a clickable character link.
    const gateway = new ProseGateway(
      "One of the Standing stones leans out of the barrow line, older than the rest. The wind moves in the grass.",
      [{ name: "One of the Standing", disposition: "neutral" }],
    );
    const engine = await start(gateway);
    await engine.submitPlayerInput("I walk the stone circle.");
    const actors = Object.keys(engine.getState().actors);
    expect(actors.some((id) => id.includes("standing") || id.includes("one-of"))).toBe(false);
    expect(actors.some((id) => id.startsWith("npc.prose."))).toBe(false);
  });

  test("a PLURAL kind-noun is scenery too — 'Figures in the Fog' never becomes a person (r8 audit)", async () => {
    // `NON_NAME_HEADS` was singular-only, so the shape gate that exists for exactly this case was
    // skipped by the phrasings the extractor actually reaches for when it reads a crowd as a
    // character: `man` was blocked and `men` was not. Reproduced end-to-end through the module —
    // this passage spawned the registry NPC `npc.prose.figures-in-the-fog`, an addressable,
    // fightable, template-carrying "person" made of weather.
    const gateway = new ProseGateway(
      "Figures in the Fog move along the ridge above the road, three of them, spears up, and do not call down.",
      [{ name: "Figures in the Fog", disposition: "hostile" }],
    );
    const engine = await start(gateway);
    await engine.submitPlayerInput("I watch the ridge.");
    const actors = Object.keys(engine.getState().actors);
    expect(actors.some((id) => id.startsWith("npc.prose."))).toBe(false);
  });

  test("an ACCENTED name still spawns — the cost gate is not ASCII-only (r8 audit)", async () => {
    // `mightIntroduceEntity` collected candidates with `\b[A-Z]…\b`; neither `[A-Z]` nor `\b` sees
    // a non-ASCII capital, so a passage whose only proper noun is accented reported "no plausible
    // new name", the extractor never ran, and Élodie stayed a prose-only ghost the player could not
    // address on the next turn. Reproduced: with the old pattern this run spawned nothing at all.
    const gateway = new ProseGateway(
      "Élodie sets a bowl of stew on the counter and waits, sleeves rolled to the elbow.",
      [{ name: "Élodie", disposition: "hostile", sex: "female" }],
    );
    const engine = await start(gateway);
    await engine.submitPlayerInput("I sit down at the counter.");
    const spawned = Object.keys(engine.getState().actors).filter((id) => id.startsWith("npc.prose."));
    expect(spawned).toHaveLength(1);
    // The id slug is ASCII (slugify drops what it cannot spell), but the DISPLAY name is verbatim.
    const model = (engine as unknown as { model: { entities: Map<string, { name: string }> } }).model;
    expect(model.entities.get(spawned[0]!)?.name).toBe("Élodie");
  });

  test("the quoted-only scan is word-bounded — 'pagoda' no longer stages 'Oda' (r8 audit)", async () => {
    // `mentionedOnlyInsideQuotes` swept the prose with `indexOf`, so the "oda" buried inside
    // "pagoda" counted as an occurrence OUTSIDE the quotes — which is the module's definition of
    // "the narration staged them". A character who was only ever talked ABOUT therefore spawned,
    // purely because an unrelated longer word happened to contain their name.
    const gateway = new ProseGateway(
      'The pagoda leans over the water, tiles green with rot. The clerk says, "Oda took the ferry east."',
      [{ name: "Oda", disposition: "neutral" }],
    );
    const engine = await start(gateway);
    await engine.submitPlayerInput("I study the tower.");
    const actors = Object.keys(engine.getState().actors);
    expect(actors.some((id) => id.includes("oda"))).toBe(false);
    expect(actors.some((id) => id.startsWith("npc.prose."))).toBe(false);
  });

  test("inert by default: the offline gateway returns no npcs ⇒ nothing is spawned", async () => {
    const engine = await start(new OfflineGateway());
    await engine.submitPlayerInput("I look around the chamber.");
    const actors = Object.keys(engine.getState().actors);
    expect(actors.some((id) => id.startsWith("npc.prose."))).toBe(false);
  });
});

describe("prose-entity COST gate (r10 latency audit — no utility call for a non-name)", () => {
  test("a NEIGHBOR location's name does not fire the extractor", async () => {
    // Only the CURRENT location's tokens were known, so "the road to Umberwick Toll" spent a
    // 6–12s utility call every scene that mentioned a neighbor. Every authored place name is a
    // known token now.
    const gateway = new CountingGateway("The road bends toward Umberwick Toll, and the wind carries salt.");
    const engine = await start(gateway, [
      { id: "loc.toll", name: "Umberwick Toll", description: "A toll bar on the coast road.", npcs: [] },
    ]);
    await engine.submitPlayerInput("I look down the road.");
    expect(gateway.extractorCalls).toBe(0);
  });

  test("a name spoken ONLY inside quoted dialogue does not fire the extractor", async () => {
    // The spawn path already drops a quote-only name (`mentionedOnlyInsideQuotes`), so spending the
    // call on one was pure waste.
    const gateway = new CountingGateway('The clerk shrugs. "Marrec owes me silver," he says.');
    const engine = await start(gateway);
    await engine.submitPlayerInput("I wait at the counter.");
    expect(gateway.extractorCalls).toBe(0);
  });

  test("a quantifier/kind-noun head does not fire the extractor", async () => {
    // `isProperPersonName` already refuses "Villagers" as a person; the gate now mirrors it.
    const gateway = new CountingGateway("Villagers crowd the well, shouting over one another.");
    const engine = await start(gateway);
    await engine.submitPlayerInput("I push through the crowd.");
    expect(gateway.extractorCalls).toBe(0);
  });

  test("a sentence-initial common noun that recurs lowercase does not fire the extractor", async () => {
    // "Rain … the rain": a real name is never written lowercase, so a lowercase recurrence marks a
    // common noun and the capitalized head was only the sentence's doing.
    const gateway = new CountingGateway("Rain hammers the road all night, and by dawn the rain has drowned the ford.");
    const engine = await start(gateway);
    await engine.submitPlayerInput("I pull my hood up.");
    expect(gateway.extractorCalls).toBe(0);
  });

  test("a genuinely new proper name STILL fires the extractor exactly once", async () => {
    const gateway = new CountingGateway("Élodie sets a bowl of stew on the counter and waits.");
    const engine = await start(gateway);
    await engine.submitPlayerInput("I sit down at the counter.");
    expect(gateway.extractorCalls).toBe(1);
  });
});
