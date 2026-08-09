/**
 * Stage 4 (goal-directed decision framing) — focused tests for `situationHint`, the pure,
 * code-derived live-fact nudge appended to both `idleStimulus` and `worldStimulus`
 * (src/modules/autonomy/module.ts). Exercised directly against a hand-built WorldModel/TickContext
 * (no engine, no gateway calls) so each fact rule (depleted / barred way / fallen holder) is
 * asserted in isolation and deterministically.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { AutonomyModule, situationHint, type AutonomyDialogueItem } from "../src/modules/autonomy/module.ts";
import { NpcAgent } from "../src/agents/npc.ts";
import { HeartbeatScheduler } from "../src/director/heartbeat.ts";
import { CampaignSchema, WorldSchema, type Exit } from "../src/content/schema.ts";
import { fromGameState } from "../src/world/model.ts";
import type { GameState } from "../src/state/types.ts";
import type { TickContext } from "../src/engine/tick.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

/**
 * Build a minimal two-location world (`loc.a` --exits--> `loc.b`) with one deciding NPC
 * (`npc.test`) at `loc.a`, plus whatever extra actors/exits a scenario needs, and wrap it in a
 * bare-bones TickContext. `situationHint` only ever reads `ctx.model` and `ctx.services.world`,
 * so every other TickContext member is a never-called stub.
 */
function fixture(opts: {
  exits?: Exit[];
  npcActor?: Partial<GameState["actors"][string]>;
  otherActors?: Record<string, GameState["actors"][string]>;
  /** Raw (pre-`WorldSchema.parse`) NPC template literals — kept `unknown[]` so a minimal test
   *  literal (no `canLead`/`heartbeatSeconds`/…) still parses; zod fills in every default. */
  otherNpcTemplates?: unknown[];
}): TickContext {
  const world = WorldSchema.parse({
    id: "w.hint",
    name: "Hint World",
    summary: "A test fixture.",
    locations: [
      { id: "loc.a", name: "The Yard", description: "", exits: opts.exits ?? [] },
      { id: "loc.b", name: "The Vault", description: "" },
    ],
    npcs: [
      { id: "npc.test", name: "Tess", persona: "A test NPC.", autonomy: { isPartyMember: true, level: "proactive" } },
      ...(opts.otherNpcTemplates ?? []),
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.hint",
    name: "Hint Campaign",
    worldId: "w.hint",
    characters: [{ id: "pc.you", name: "You", stats: STATS, inventory: [] }],
    startingState: { locationId: "loc.a", party: ["pc.you"], companions: ["npc.test"] },
  });

  const actors = {
    "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.a", inventory: [], conditions: [] },
    "npc.test": {
      id: "npc.test",
      currentHp: 10,
      locationId: "loc.a",
      inventory: [],
      conditions: [],
      ...opts.npcActor,
    },
    ...(opts.otherActors ?? {}),
  } as unknown as GameState["actors"];

  const gs: GameState = {
    campaignId: "c.hint",
    worldId: "w.hint",
    partyLocationId: "loc.a",
    clock: 0,
    party: ["pc.you"],
    companions: ["npc.test"],
    actors,
    quests: {},
    relationships: {},
    autonomy: {},
    modules: { autonomy: {} },
    flags: {},
  };
  const model = fromGameState(gs, world, campaign);

  return {
    trigger: { kind: "heartbeat", npcId: "npc.test" },
    model,
    services: { world, campaign, gateway: new OfflineGateway(), rng: () => 0 },
    recent: [],
    data: {},
    queue: [],
    enqueue: () => {},
    apply: () => ({ deltas: [], mutated: false }),
    dryRun: () => ({ deltas: [], mutated: false }),
    applySilent: () => ({ deltas: [], mutated: false }),
    emit: () => {},
    state: () => gs,
  };
}

describe("situationHint (Stage 4 live-fact nudge)", () => {
  test("a full-energy NPC with no barred exit and no fallen holder gets no hint at all", () => {
    const ctx = fixture({});
    expect(situationHint(ctx, "npc.test")).toBe("");
  });

  test("depleted energy (below ~60% of max) surfaces the 'worn down' fragment", () => {
    const ctx = fixture({ npcActor: { energy: 10, maxEnergy: 100 } });
    const hint = situationHint(ctx, "npc.test");
    expect(hint).toContain("worn down");
  });

  test("energy at exactly the 60% threshold does NOT count as depleted", () => {
    const ctx = fixture({ npcActor: { energy: 60, maxEnergy: 100 } });
    expect(situationHint(ctx, "npc.test")).toBe("");
  });

  test("a non-hidden barred exit surfaces the 'barred' fragment naming the destination + obstacle", () => {
    const ctx = fixture({
      exits: [
        {
          to: "loc.b",
          locked: false,
          hidden: false,
          barrier: { kind: "door", dc: 12, description: "a heavy oak door" },
        },
      ],
    });
    const hint = situationHint(ctx, "npc.test");
    expect(hint).toContain("barred");
    expect(hint).toBe(" The way to The Vault is barred (a heavy oak door).");
  });

  test("a HIDDEN barred exit is never surfaced", () => {
    const ctx = fixture({
      exits: [
        {
          to: "loc.b",
          locked: false,
          hidden: true,
          barrier: { kind: "door", dc: 12, description: "a heavy oak door" },
        },
      ],
    });
    expect(situationHint(ctx, "npc.test")).toBe("");
  });

  test("a defeated (hp <= 0) present holder carrying items surfaces the 'fallen' fragment", () => {
    const ctx = fixture({
      otherNpcTemplates: [
        { id: "npc.foe", name: "Foe", persona: "A downed foe.", autonomy: { isPartyMember: false, level: "passive" } },
      ],
      otherActors: {
        "npc.foe": { id: "npc.foe", currentHp: 0, locationId: "loc.a", inventory: ["itm.sword"], conditions: [] },
      },
    });
    const hint = situationHint(ctx, "npc.test");
    expect(hint).toContain("fallen");
    expect(hint).toBe(" Foe lies fallen nearby.");
  });

  test("an unconscious (but hp > 0) present holder carrying items also counts as fallen", () => {
    const ctx = fixture({
      otherNpcTemplates: [
        { id: "npc.foe", name: "Foe", persona: "A downed foe.", autonomy: { isPartyMember: false, level: "passive" } },
      ],
      otherActors: {
        "npc.foe": {
          id: "npc.foe",
          currentHp: 5,
          locationId: "loc.a",
          inventory: ["itm.sword"],
          conditions: ["unconscious"],
        },
      },
    });
    expect(situationHint(ctx, "npc.test")).toContain("fallen");
  });

  test("a defeated present holder with an EMPTY inventory is not lootable, so no fragment", () => {
    const ctx = fixture({
      otherNpcTemplates: [
        { id: "npc.foe", name: "Foe", persona: "A downed foe.", autonomy: { isPartyMember: false, level: "passive" } },
      ],
      otherActors: {
        "npc.foe": { id: "npc.foe", currentHp: 0, locationId: "loc.a", inventory: [], conditions: [] },
      },
    });
    expect(situationHint(ctx, "npc.test")).toBe("");
  });

  test("two applicable facts join into a single terse hint (worn down + fallen holder)", () => {
    const ctx = fixture({
      npcActor: { energy: 5, maxEnergy: 100 },
      otherNpcTemplates: [
        { id: "npc.foe", name: "Foe", persona: "A downed foe.", autonomy: { isPartyMember: false, level: "passive" } },
      ],
      otherActors: {
        "npc.foe": { id: "npc.foe", currentHp: 0, locationId: "loc.a", inventory: ["itm.sword"], conditions: [] },
      },
    });
    const hint = situationHint(ctx, "npc.test");
    expect(hint).toContain("worn down");
    expect(hint).toContain("fallen");
  });
});

// ===========================================================================
// Wiring: the private `idleStimulus` builder (a proactive COMPANION's heartbeat) actually calls
// `situationHint` and carries the Stage 4 active reframing. Drives the real AutonomyModule's react
// phase directly (mirrors tests/autonomy.test.ts's `worldFixture` pattern) rather than re-testing
// the pure function in isolation — this is the one seam that would silently rot if `idleStimulus`
// stopped calling `situationHint` or a typo crept into the reworded text.
// ===========================================================================
describe("idleStimulus wiring (Stage 4)", () => {
  test("a proactive companion's heartbeat stimulus carries the active reframing + a live-fact hint", async () => {
    const ctx = fixture({ npcActor: { energy: 10, maxEnergy: 100 } });
    const world = ctx.services.world;
    const template = world.npcs.find((n) => n.id === "npc.test")!;
    const npcs = new Map([["npc.test", new NpcAgent(ctx.services.gateway, template)]]);
    const module = new AutonomyModule(npcs, new HeartbeatScheduler(), world, () => 0);

    await module.phases.react!(ctx);

    const queue = (ctx.data.autonomyDialogue as AutonomyDialogueItem[] | undefined) ?? [];
    expect(queue).toHaveLength(1);
    const stimulus = queue[0]?.stimulus ?? "";
    expect(stimulus).toContain("Act on what matters to you");
    expect(stimulus).toContain("worn down");
    // The OLD passive framing is gone.
    expect(stimulus).not.toContain("Is there something you want to do or say");
  });
});
