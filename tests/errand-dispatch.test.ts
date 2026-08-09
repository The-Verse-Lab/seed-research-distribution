/**
 * Errand dispatch — the intent, the quote, the commit (r5 fix wave).
 *
 * Two turns by design, mirroring the known-roads travel quote: the runner states the terms in
 * their own voice (route, fee, ETA — all computed), and only a bare "yes" spends the coin and
 * sends them. That is how the player learns what an errand costs BEFORE paying for it.
 *
 * The grounding half is tested through `reconcilePlan` directly, because that is where the r4 P1
 * lesson lives: a person the world has only NAMED must be a legal errand subject, or the whole
 * feature misses the case that motivated it.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { mulberry32 } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import { reconcilePlan, type TurnClassifier } from "../src/engine/classify.ts";
import type { ClassifierContext, TurnPlan } from "../src/engine/turn-plan.ts";
import type { GameEvent } from "../src/events/types.ts";
import { readErrandsSlice } from "../src/rules/errands.ts";

function buildPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.dispatch",
    name: "Two Towns",
    summary: "A test world.",
    locations: [
      {
        id: "loc.here",
        name: "The Taproom",
        description: "A low room.",
        npcs: ["npc.brann", "npc.wary"],
        exits: [{ to: "loc.there", name: "the west road", minutes: 60 }],
      },
      {
        id: "loc.there",
        name: "The Broken Crown",
        description: "A drinking hall across the city.",
        npcs: ["npc.sorrel"],
        exits: [{ to: "loc.here", name: "back east", minutes: 60 }],
      },
      { id: "loc.island", name: "The Island", description: "No road runs here." },
    ],
    npcs: [
      {
        id: "npc.brann",
        name: "Brann Coldwater",
        persona: "A fence and rumour-broker.",
        age: 44,
        personalityTemplate: "schemer",
        relationships: { "pc.you": 20 },
      },
      { id: "npc.wary", name: "Hask", persona: "A suspicious dock-hand.", age: 30, relationships: { "pc.you": -60 } },
      { id: "npc.sorrel", name: "Sorrel", persona: "A runaway watching the door.", age: 19 },
      // Ambient scenery: rostered nowhere, and its first token is a LOCATION token. Found live —
      // "go to the Undercroft and ask Brann" bound the subject to "Undercroft Shadow".
      { id: "npc.crowd", name: "Crown Shadow", persona: "A face in the crowd.", age: 30 },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.dispatch",
    name: "Test Campaign",
    worldId: "w.dispatch",
    characters: [
      {
        id: "pc.you",
        name: "You",
        stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 12, armorClass: 10 },
        coins: 500,
        age: 30,
      },
    ],
    startingState: { locationId: "loc.here", party: ["pc.you"], clock: 480 },
  });
  return { world, campaign };
}

function seqClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return { classify: () => Promise.resolve(plans[Math.min(i++, plans.length - 1)]!) };
}

const plan = (over: Partial<TurnPlan>): TurnPlan =>
  ({
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 0.9,
    ...over,
  }) as TurnPlan;

const bringSorrel = (runnerId = "npc.brann") =>
  plan({
    kind: "errand",
    errand: { verb: "bring", runnerId, subjectId: "npc.sorrel", destinationId: null, itemId: null, topic: "" },
  });

async function run(plans: TurnPlan[], inputs: string[]) {
  const engine = new GameEngine({
    classifier: seqClassifier(plans),
    playset: buildPlayset(),
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(7),
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  for (const input of inputs) await engine.submitPlayerInput(input);
  return { engine, events };
}

const narrationText = (events: GameEvent[]): string =>
  events
    .filter((e) => e.kind === "narration")
    .map((e) => (e as { text: string }).text)
    .join("\n");

describe("errand dispatch — quote, then commit", () => {
  test("the first turn QUOTES: nothing moves, no coin is spent, the terms carry real numbers", async () => {
    const { engine, events } = await run([bringSorrel()], ["Brann, bring Sorrel here."]);
    const state = engine.getState();
    expect(state.authoredNpcs?.["npc.brann"]?.locationId ?? "loc.here").toBe("loc.here");
    expect(state.actors["pc.you"]?.coins).toBe(500);
    expect(readErrandsSlice(state.modules).active["npc.brann"]).toBeUndefined();
    // 60 minutes each way, so a real fee and a real ETA are quoted before the player agrees.
    expect(narrationText(events)).toContain("The Broken Crown");
    expect(narrationText(events)).toContain("cp for the trouble");
  });

  test('"yes" commits: the runner leaves, coin moves, and the errand starts ticking', async () => {
    const { engine } = await run([bringSorrel(), plan({})], ["Brann, bring Sorrel here.", "yes"]);
    const state = engine.getState();
    expect(state.authoredNpcs?.["npc.brann"]?.locationId).toBe("loc.there");
    expect(state.actors["pc.you"]?.coins).toBeLessThan(500);
    const errand = readErrandsSlice(state.modules).active["npc.brann"];
    expect(errand?.destinationId).toBe("loc.there");
    expect(errand?.reportLocationId).toBe("loc.here");
    expect(errand?.dueAtClock).toBeGreaterThan(state.clock);
  });

  test("anything other than yes lets the quote lapse — nothing was spent or sent", async () => {
    const { engine } = await run([bringSorrel(), plan({})], ["Brann, bring Sorrel here.", "I look at the fire."]);
    const state = engine.getState();
    expect(state.authoredNpcs?.["npc.brann"]?.locationId ?? "loc.here").toBe("loc.here");
    expect(state.actors["pc.you"]?.coins).toBe(500);
    expect(readErrandsSlice(state.modules).active["npc.brann"]).toBeUndefined();
  });

  test("an explicit no is answered, and still costs nothing", async () => {
    const { engine, events } = await run([bringSorrel(), plan({})], ["Brann, bring Sorrel here.", "no"]);
    expect(narrationText(events)).toContain("stays where they are");
    expect(engine.getState().actors["pc.you"]?.coins).toBe(500);
  });

  test("a hostile runner refuses outright and nothing is armed", async () => {
    const { engine, events } = await run(
      [bringSorrel("npc.wary"), plan({})],
      ["Hask, bring Sorrel here.", "yes"],
    );
    expect(narrationText(events)).toContain("not running anyone's errands");
    expect(readErrandsSlice(engine.getState().modules).active["npc.wary"]).toBeUndefined();
  });

  test("no road ⇒ an honest refusal naming the place, and nothing is armed", async () => {
    const { engine, events } = await run(
      [
        plan({
          kind: "errand",
          errand: { verb: "scout", runnerId: "npc.brann", subjectId: null, destinationId: "loc.island", itemId: null, topic: "" },
        }),
        plan({}),
      ],
      ["Brann, go look at the island.", "yes"],
    );
    expect(narrationText(events)).toContain("The Island");
    expect(readErrandsSlice(engine.getState().modules).active["npc.brann"]).toBeUndefined();
  });

  test("a runner already away is not sent twice", async () => {
    const { engine, events } = await run(
      // NB: the "yes" turn is answered BEFORE the classifier runs, so it consumes no plan.
      [bringSorrel(), bringSorrel()],
      ["Brann, bring Sorrel here.", "yes", "Brann, bring Sorrel here."],
    );
    expect(narrationText(events)).toContain("already away");
    expect(readErrandsSlice(engine.getState().modules).active["npc.brann"]?.destinationId).toBe("loc.there");
  });

  test("an armed quote does NOT survive a reload — no one walks on a word the player never gave", async () => {
    const playset = buildPlayset();
    const store = new InMemoryGameStateStore();
    const deps = {
      classifier: seqClassifier([bringSorrel(), plan({})]),
      playset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(7),
    };
    const first = new GameEngine(deps);
    await first.start();
    await first.submitPlayerInput("Brann, bring Sorrel here.");

    const second = new GameEngine({ ...deps, classifier: seqClassifier([plan({})]) });
    await second.start();
    await second.submitPlayerInput("yes");
    const state = second.getState();
    expect(state.authoredNpcs?.["npc.brann"]?.locationId ?? "loc.here").toBe("loc.here");
    expect(readErrandsSlice(state.modules).active["npc.brann"]).toBeUndefined();
  });
});

describe("the errand pool refuses scenery", () => {
  test("an unrostered crowd template whose name collides with a place is never a legal subject", async () => {
    const { engine, events } = await run(
      [
        plan({
          kind: "errand",
          errand: { verb: "ask", runnerId: "npc.brann", subjectId: "npc.crowd", destinationId: null, itemId: null, topic: "the list" },
        }),
      ],
      ["Brann, go to the Broken Crown and ask after the list."],
    );
    // The engine cannot place scenery, so the errand is refused rather than sending anyone.
    expect(readErrandsSlice(engine.getState().modules).active["npc.brann"]).toBeUndefined();
    expect(narrationText(events)).not.toContain("sets out");
  });
});

describe("the errand pool reads EVERY name in the line", () => {
  /**
   * The subject must be a stranger by EVERY other route into the pool, or the test proves
   * nothing: `errandTargetsFor` also admits anyone the recent transcript named, anyone the
   * player has a relationship with or has witnessed, and anyone rostered somewhere visited.
   * So this fixture gives its NPCs no authored relationships (a related NPC is admitted
   * outright) and no `personalityTemplate` (a proactive NPC chatters, and chatter that says
   * the subject's name puts them in the transcript pool for free). Each test then asserts the
   * transcript pool is EMPTY before asserting the errand pool is not — otherwise a future
   * change to the test gateway's opening beat could make all of this pass vacuously, which is
   * exactly what the first draft of this test did.
   */
  function buildQuietPlayset(): PlaySet {
    const world = WorldSchema.parse({
      id: "w.quiet",
      name: "Two Towns",
      summary: "A test world.",
      locations: [
        {
          id: "loc.here",
          name: "The Taproom",
          description: "A low room.",
          npcs: ["npc.brann"],
          exits: [{ to: "loc.there", name: "the west road", minutes: 60 }],
        },
        {
          id: "loc.there",
          name: "The Broken Crown",
          description: "A drinking hall.",
          npcs: ["npc.sorrel"],
          exits: [{ to: "loc.here", name: "back east", minutes: 60 }],
        },
      ],
      npcs: [
        { id: "npc.brann", name: "Brann Coldwater", persona: "A fence.", age: 44 },
        { id: "npc.sorrel", name: "Sorrel", persona: "A runaway.", age: 19 },
        { id: "npc.crowd", name: "Crown Shadow", persona: "A face in the crowd.", age: 30 },
      ],
    });
    const campaign = CampaignSchema.parse({
      id: "c.quiet",
      name: "Test Campaign",
      worldId: "w.quiet",
      characters: [
        {
          id: "pc.you",
          name: "You",
          stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 12, armorClass: 10 },
          coins: 500,
          age: 30,
        },
      ],
      startingState: { locationId: "loc.here", party: ["pc.you"], clock: 480 },
    });
    return { world, campaign };
  }

  /** Runs one input and hands back the whole context the classifier was actually shown. */
  async function contextFor(input: string): Promise<ClassifierContext> {
    let seen: ClassifierContext | undefined;
    const engine = new GameEngine({
      classifier: {
        classify: (_text, ctx) => {
          seen = ctx;
          return Promise.resolve(plan({}));
        },
      },
      playset: buildQuietPlayset(),
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(7),
    });
    await engine.start();
    await engine.submitPlayerInput(input);
    if (!seen) throw new Error("the classifier was never called");
    return seen;
  }

  const line = "Brann, go find Sorrel and ask her about the list.";

  // The live r5 defect: the line names the PRESENT runner first, so a singular read of
  // `absentNamedInLine` stopped at Brann, dropped him for being present, and never looked at
  // Sorrel — the classifier picked `errand` correctly and then had no legal subject to bind.
  test("a present runner named first does not hide the absent subject named second", async () => {
    const ctx = await contextFor(line);
    expect((ctx.knownAbsentNpcs ?? []).map((n) => n.id)).not.toContain("npc.sorrel");
    expect((ctx.errandTargets?.npcs ?? []).map((n) => n.id)).toContain("npc.sorrel");
  });

  test("the present runner is still kept OUT of the pool — you cannot send someone after themselves", async () => {
    const ctx = await contextFor(line);
    expect((ctx.errandTargets?.npcs ?? []).map((n) => n.id)).not.toContain("npc.brann");
  });

  test("scenery named in the line stays out, however many names the line carries", async () => {
    const ctx = await contextFor("Brann, ask Crown Shadow and Sorrel about the list.");
    expect((ctx.knownAbsentNpcs ?? []).map((n) => n.id)).not.toContain("npc.sorrel");
    expect((ctx.errandTargets?.npcs ?? []).map((n) => n.id)).toContain("npc.sorrel");
    expect((ctx.errandTargets?.npcs ?? []).map((n) => n.id)).not.toContain("npc.crowd");
  });
});

describe("errand grounding (reconcilePlan) — a NAMED person is a legal subject", () => {
  const baseCtx = (over: Partial<ClassifierContext> = {}): ClassifierContext => ({
    playerActorId: "pc.you",
    locationId: "loc.here",
    locationName: "The Taproom",
    exits: [],
    presentEntities: [{ id: "npc.brann", name: "Brann Coldwater" }],
    companionIds: [],
    ...over,
  });

  const raw = (over: Record<string, unknown> = {}) => ({
    kind: "errand" as const,
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 0.9,
    errand: { verb: "bring", runnerId: "npc.brann", subjectId: "npc.sorrel", destinationId: null, itemId: null, topic: "", ...over },
  });

  test("a subject in ERRAND_TARGETS grounds — this is the r4 'she's here' lead becoming actionable", () => {
    const out = reconcilePlan(
      raw() as never,
      baseCtx({ errandTargets: { npcs: [{ id: "npc.sorrel", name: "Sorrel" }], places: [] } }),
    );
    expect(out.kind).toBe("errand");
    expect(out.errand?.subjectId).toBe("npc.sorrel");
  });

  test("a subject NOT in the pool drops the payload and degrades the kind", () => {
    const out = reconcilePlan(raw() as never, baseCtx({ errandTargets: { npcs: [], places: [] } }));
    expect(out.kind).toBe("freeformNarrative");
    expect(out.errand).toBeUndefined();
  });

  test("a runner who is not PRESENT can never be sent", () => {
    const out = reconcilePlan(
      raw({ runnerId: "npc.elsewhere" }) as never,
      baseCtx({ errandTargets: { npcs: [{ id: "npc.sorrel", name: "Sorrel" }], places: [] } }),
    );
    expect(out.kind).toBe("freeformNarrative");
  });

  test("scout grounds on a place, not a person", () => {
    const out = reconcilePlan(
      raw({ verb: "scout", subjectId: null, destinationId: "loc.there" }) as never,
      baseCtx({ errandTargets: { npcs: [], places: [{ id: "loc.there", name: "The Broken Crown" }] } }),
    );
    expect(out.kind).toBe("errand");
    expect(out.errand?.destinationId).toBe("loc.there");
  });
});
