/**
 * Defeat-outcome tests (Workstream E, slim).
 *
 * The pure selector: seeded determinism, world/scenario gates, and all-excluded → null. Plus an
 * engine integration: a world that authors an outcome resolves a lost fight from the table (effects apply as
 * reducer commands), while a world with NO table keeps the historic 1-HP revival unchanged.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { NpcTemplateSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { GameState } from "../src/state/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { loadExample, SEED } from "./support/harness.ts";
import {
  resolveDefeatOutcome,
  selectDefeatOutcome,
  type DefeatGateContext,
  type DefeatOutcome,
  type DefeatOutcomeIo,
} from "../src/rules/defeat-outcomes.ts";
import { buildGenericDefeatOutcomes } from "../src/content/generic-defeat-outcomes.ts";
import { COMMAND_TYPES, type Command } from "../src/world/commands.ts";
import { applyCommand } from "../src/world/reducer.ts";
import type { WorldModel } from "../src/world/model.ts";
import { statusMods } from "../src/rules/status-effects.ts";
import { resolveCheck } from "../src/rules/checks.ts";

// ---------------------------------------------------------------------------
// The pure selector
// ---------------------------------------------------------------------------

/** A minimal outcome (only the fields the selector reads). */
function outcome(partial: Partial<DefeatOutcome> & { id: string }): DefeatOutcome {
  return {
    weight: 1,
    effects: [],
    narratorBrief: `The fight is lost — outcome ${partial.id}.`,
    ...partial,
  };
}

const openGate: DefeatGateContext = {
  flags: {},
  victorTags: [],
  cause: "combat-defeat",
};

function defeatModel(): WorldModel {
  return {
    campaignId: "c.defeat",
    worldId: "w.defeat",
    clock: 0,
    entities: new Map([
      [
        "pc.you",
        {
          id: "pc.you",
          kind: "pc",
          tier: "significant",
          name: "You",
          locationId: "loc.start",
          stats: { currentHp: 10, maxHp: 10, conditions: [], inventory: [], coins: 100 },
          partyMember: true,
          flags: {},
        },
      ],
    ]),
    map: { exits: new Map([["loc.start", []], ["loc.safe", []]]) },
    quests: new Map(),
    relationships: new Map(),
    modules: {},
    flags: {},
  };
}

describe("selectDefeatOutcome (pure)", () => {
  test("is deterministic: same outcomes + gate + fresh rng → identical pick across runs", () => {
    const outcomes = [
      outcome({ id: "a", weight: 1 }),
      outcome({ id: "b", weight: 2 }),
      outcome({ id: "c", weight: 3 }),
    ];
    const runA = Array.from({ length: 12 }, () => {
      const rng = mulberry32(SEED);
      return selectDefeatOutcome(outcomes, openGate, rng)?.id;
    });
    // Every fresh-seeded draw is identical (pure over the rng sequence).
    expect(new Set(runA).size).toBe(1);

    // And a walked sequence reproduces itself exactly.
    const rng1 = mulberry32(SEED);
    const rng2 = mulberry32(SEED);
    const seqA = Array.from({ length: 20 }, () => selectDefeatOutcome(outcomes, openGate, rng1)?.id);
    const seqB = Array.from({ length: 20 }, () => selectDefeatOutcome(outcomes, openGate, rng2)?.id);
    expect(seqA).toEqual(seqB);
    // The weighted pick actually spreads across the pool over a run (not a stuck single id).
    expect(new Set(seqA).size).toBeGreaterThan(1);
  });

  test("world-flag gates: blockedByFlags excludes on a truthy flag; requiredFlags needs all truthy", () => {
    const blocked = [outcome({ id: "peacetime", blockedByFlags: ["at_war"] })];
    expect(selectDefeatOutcome(blocked, { ...openGate, flags: { at_war: true } }, mulberry32(SEED))).toBeNull();
    expect(selectDefeatOutcome(blocked, { ...openGate, flags: { at_war: false } }, mulberry32(SEED))?.id).toBe(
      "peacetime",
    );

    const gated = [outcome({ id: "in-dungeon", requiredFlags: ["in_dungeon", "torch_lit"] })];
    // Missing one required flag → excluded.
    expect(selectDefeatOutcome(gated, { ...openGate, flags: { in_dungeon: true } }, mulberry32(SEED))).toBeNull();
    // All required flags truthy → eligible.
    expect(
      selectDefeatOutcome(gated, { ...openGate, flags: { in_dungeon: true, torch_lit: 1 } }, mulberry32(SEED))?.id,
    ).toBe("in-dungeon");
  });

  test("a non-positive weight is never selectable", () => {
    expect(selectDefeatOutcome([outcome({ id: "z", weight: 0 })], openGate, mulberry32(SEED))).toBeNull();
  });

  test("all-excluded → null (caller falls back)", () => {
    const outcomes = [
      outcome({ id: "a", requiredFlags: ["missing"] }),
      outcome({ id: "b", blockedByFlags: ["x"] }),
    ];
    expect(selectDefeatOutcome(outcomes, { ...openGate, flags: { x: true } }, mulberry32(SEED))).toBeNull();
    // An empty table is also null.
    expect(selectDefeatOutcome([], openGate, mulberry32(SEED))).toBeNull();
  });
});

describe("shared fantasy library: scenario buckets pick the right list per victor", () => {
  const generics = buildGenericDefeatOutcomes("pc.you");
  // selectDefeatOutcome on a SINGLETON pool returns the row iff it is gate-eligible → an eligibility probe.
  const eligibleIds = (gate: DefeatGateContext): string[] =>
    generics.filter((o) => selectDefeatOutcome([o], gate, mulberry32(SEED))?.id === o.id).map((o) => o.id);

  test("a MONSTER victory selects beast rows plus the universal floor, never humanoid rows", () => {
    const ids = eligibleIds({ ...openGate, victorTags: ["monster"], cause: "combat-defeat" });
    expect(ids).toContain("dragged-to-lair");
    expect(ids).toContain("hoarded-as-prey");
    expect(ids).toContain("cocooned-in-nest");
    expect(ids).toContain("left-for-dead");
    expect(ids).toContain("crippling-wound");
    expect(ids).not.toContain("robbery"); // humanoid-only
  });

  test("a HUMANOID victory selects robbery, custody, labor, and universal rows", () => {
    const ids = eligibleIds({ ...openGate, victorTags: ["npc"], cause: "combat-defeat" });
    for (const id of [
      "robbery",
      "ransomed",
      "pressed-into-labor",
      "thrown-in-gaol",
      "thrown-to-the-pit",
      "sent-to-the-mines",
      "held-for-rite",
      "press-ganged",
      "crippling-wound",
      "left-for-dead",
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(ids).not.toContain("dragged-to-lair"); // beast-only
  });

  test("cast-out is built only when a safe fallback location is supplied", () => {
    expect(buildGenericDefeatOutcomes("pc.you").some((o) => o.id === "cast-out")).toBe(false);
    const withSafe = buildGenericDefeatOutcomes("pc.you", undefined, { safeLocId: "loc.safe" });
    expect(withSafe.some((o) => o.id === "cast-out")).toBe(true);
    const ids = withSafe
      .filter((o) =>
        selectDefeatOutcome([o], { ...openGate, victorTags: ["npc"], cause: "combat-defeat" }, mulberry32(SEED)),
      )
      .map((o) => o.id);
    expect(ids).toContain("cast-out");
  });

  test("every ordinary defeat resolves something", () => {
    for (const victor of [["monster"], ["npc"]] as string[][]) {
      const pick = selectDefeatOutcome(generics, { ...openGate, victorTags: victor, cause: "combat-defeat" }, mulberry32(SEED));
      expect(pick, `victor=${victor}`).not.toBeNull();
    }
  });

  test("every effect is a KNOWN command type (portable + preflight-clean in any world)", () => {
    for (const o of generics) {
      for (const e of o.effects) expect(COMMAND_TYPES.has(e.type), `${o.id}:${e.type}`).toBe(true);
    }
  });

  test("every coin effect targets the injected player id", () => {
    const coins = generics.flatMap((o) => o.effects).filter((e) => e.type === "adjustCoins");
    expect(coins.length).toBeGreaterThan(0);
    for (const e of coins) expect((e as { entityId: string }).entityId).toBe("pc.you");
  });

  test("crippling-wound applies a temporary mechanical status effect", () => {
    const live = defeatModel();
    const row = buildGenericDefeatOutcomes("pc.you").find((o) => o.id === "crippling-wound");
    expect(row).toBeDefined();
    for (const effect of row!.effects) applyCommand(live, effect);

    expect(live.entities.get("pc.you")?.stats?.conditions).toContain("maimed");
    expect(statusMods(live, "pc.you")).toMatchObject({ check: -2, attack: -2, energy: 2 });
    const result = resolveCheck({ abilityScore: 10, dc: 10, bonus: statusMods(live, "pc.you").check }, () => 0.45);
    expect(result.success).toBe(false);
  });

  test("cast-out relocates the PC to the safe fallback and strips coin", () => {
    const live = defeatModel();
    const row = buildGenericDefeatOutcomes("pc.you", undefined, { safeLocId: "loc.safe" }).find((o) => o.id === "cast-out");
    expect(row).toBeDefined();
    for (const effect of row!.effects) applyCommand(live, effect);

    expect(live.entities.get("pc.you")?.locationId).toBe("loc.safe");
    expect(live.entities.get("pc.you")?.stats?.coins).toBe(20);
    expect(live.clock).toBe(480);
  });
});

describe("scenario gates + resolveDefeatOutcome transaction", () => {
  test("requiresVictorTags is ANY-of; blockedByVictorTags excludes; requiresCause is ANY-of", () => {
    const guildOnly = [outcome({ id: "guild-custody", requiresVictorTags: ["guild.red"] })];
    expect(selectDefeatOutcome(guildOnly, openGate, mulberry32(SEED))).toBeNull();
    expect(selectDefeatOutcome(guildOnly, { ...openGate, victorTags: ["guild.red"] }, mulberry32(SEED))?.id).toBe(
      "guild-custody",
    );

    const notWatch = [outcome({ id: "robbery", blockedByVictorTags: ["faction.watch"] })];
    expect(selectDefeatOutcome(notWatch, { ...openGate, victorTags: ["faction.watch"] }, mulberry32(SEED))).toBeNull();
    expect(selectDefeatOutcome(notWatch, { ...openGate, victorTags: ["npc"] }, mulberry32(SEED))?.id).toBe("robbery");

    const ambushOnly = [outcome({ id: "ambush-loss", requiresCause: ["ambush", "combat-defeat"] })];
    expect(selectDefeatOutcome(ambushOnly, openGate, mulberry32(SEED))?.id).toBe("ambush-loss");
    expect(selectDefeatOutcome(ambushOnly, { ...openGate, cause: "duel" }, mulberry32(SEED))).toBeNull();
  });

  test("preflights + applies atomically; a malformed effect drops the WHOLE outcome (no partial apply)", () => {
    const applied: Command[] = [];
    const io: DefeatOutcomeIo = {
      // Only setFlag would apply; anything else "rejects" (mirrors the reducer's default-case armor).
      dryRun: (c) =>
        c.type === "setFlag" ? { deltas: [], mutated: false } : { deltas: [], mutated: false, rejected: { command: c, reason: "unknown" } },
      apply: (c) => {
        applied.push(c);
        return { deltas: [], mutated: true };
      },
    };
    const good = outcome({ id: "good", weight: 1, effects: [{ type: "setFlag", scope: "world", key: "a", value: true }] });
    const bad = outcome({
      id: "bad",
      weight: 999, // heavily favored, but preflight-rejected
      effects: [
        { type: "setFlag", scope: "world", key: "b", value: true },
        { type: "explode" } as unknown as Command,
      ],
    });
    const chosen = resolveDefeatOutcome([good, bad], openGate, mulberry32(SEED), io);
    expect(chosen?.id).toBe("good");
    // Nothing from "bad" landed — not even its valid first effect. Only "good"'s effect applied.
    expect(applied).toEqual([{ type: "setFlag", scope: "world", key: "a", value: true }]);
  });

  test("returns null when every outcome fails preflight (caller keeps its fallback)", () => {
    const io: DefeatOutcomeIo = {
      dryRun: (c) => ({ deltas: [], mutated: false, rejected: { command: c, reason: "nope" } }),
      apply: () => ({ deltas: [], mutated: true }),
    };
    const bad = outcome({ id: "bad", effects: [{ type: "boom" } as unknown as Command] });
    expect(resolveDefeatOutcome([bad], openGate, mulberry32(SEED), io)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Engine integration: a forced defeat in a world that authors a custom outcome
// ---------------------------------------------------------------------------

function planOf(partial: Partial<TurnPlan>): TurnPlan {
  return {
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
    ...partial,
  };
}

function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return {
    classify: async () => {
      const plan = plans[Math.min(i, plans.length - 1)] ?? planOf({});
      i += 1;
      return plan;
    },
  };
}

/** A tough bandit at the tavern so a 1-HP soloing PC is reliably defeated. */
function withBandit(base: PlaySet, banditHp: number): PlaySet {
  const playset = structuredClone(base);
  playset.world.npcs.push(
    NpcTemplateSchema.parse({
      id: "npc.bandit",
      name: "Bandit",
      summary: "A desperate road-cutter with a raised knife.",
      persona: "Cruel, jumpy, and direct.",
      appearance: "A wiry bandit in a patched coat.",
      goals: ["Survive the fight"],
      knowledge: [],
      relationships: {},
      age: 30,
      stats: {
        abilities: { str: 14, dex: 10, con: 10, int: 9, wis: 10, cha: 8 },
        maxHp: banditHp,
        armorClass: 1,
        level: 1,
        speed: 30,
        proficiencies: [],
        spells: [],
      },
      autonomy: { isPartyMember: false, level: "passive", canLead: false, heartbeatSeconds: 40, replyDecayAlpha: 0.2 },
    }),
  );
  playset.world.locations.find((loc) => loc.id === "loc.tavern")?.npcs.push("npc.bandit");
  return playset;
}

function seededState(playset: PlaySet): GameState {
  return {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.tavern",
    clock: 0,
    party: ["pc.you"],
    companions: [],
    actors: {
      "pc.you": { id: "pc.you", currentHp: 1, locationId: "loc.tavern", inventory: ["item.lantern"], conditions: [] },
      "npc.bandit": { id: "npc.bandit", currentHp: 30, locationId: "loc.tavern", inventory: [], conditions: [] },
    },
    quests: Object.fromEntries(playset.campaign.quests.map((q) => [q.id, q.state])) as GameState["quests"],
    relationships: {},
    autonomy: {},
    modules: { combat: { active: true, locationId: "loc.tavern", order: ["pc.you", "npc.bandit"], turnIndex: 0, round: 1 } },
    flags: {},
  };
}

async function makeEngine(playset: PlaySet, state: GameState) {
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(playset.campaign.id, "pc.you"), state);
  const engine = new GameEngine({
    playset,
    store,
    gateway: new OfflineGateway(),
    classifier: scriptedClassifier([planOf({ kind: "attack", targetId: "npc.bandit" })]),
    rng: mulberry32(SEED),
  });
  const events: GameEvent[] = [];
  engine.subscribe((event) => events.push(event));
  await engine.start();
  events.length = 0;
  return { engine, events };
}

const byKind = (events: GameEvent[], kind: GameEvent["kind"]): GameEvent[] => events.filter((e) => e.kind === kind);

/** Author a single imprisonment outcome (flag + clock) on the world's constitution. */
function withDefeatTable(base: PlaySet): PlaySet {
  const playset = structuredClone(base);
  playset.world.constitution.defeatOutcomes = [
    {
      id: "imprisonment",
      weight: 1,
      tags: ["custody"],
      effects: [
        { type: "setFlag", scope: "world", key: "captive", value: true },
        { type: "advanceClock", by: 480 },
      ],
      narratorBrief: "You are beaten down and dragged away in irons, waking in a cold cell.",
    },
  ];
  return playset;
}

describe("data-driven defeat outcomes (engine)", () => {
  test("a world that authors an outcome resolves a lost fight from the table (effects apply as commands)", async () => {
    const playset = withDefeatTable(withBandit(await loadExample(), 30));
    const { engine, events } = await makeEngine(playset, seededState(playset));

    // Swing until the tough bandit downs the 1-HP PC and the fight ends (deterministic rng).
    for (let i = 0; i < 12; i++) {
      await engine.submitPlayerInput("I attack the bandit");
      if (!(engine.getState().modules?.combat as { active?: boolean }).active) break;
    }

    const state = engine.getState();
    expect((state.modules?.combat as { active?: boolean }).active).toBe(false);
    // The authored outcome applied via reducer commands: the captive flag is set and the clock rolled.
    expect(state.flags?.captive).toBe(true);
    expect(state.clock).toBeGreaterThanOrEqual(480);
    // …carried by real deltas (single writer), not a direct mutation.
    const flagDeltas = byKind(events, "flagSet").filter((e) => "key" in e && e.key === "captive");
    expect(flagDeltas.length).toBeGreaterThan(0);
    expect(byKind(events, "clockAdvanced").length).toBeGreaterThan(0);
    // The outcome REPLACES the 1-HP revival: the PC was NOT nudged back to 1 by the fallback path.
    // (The imprisonment brief is authoritative; no adjustHp +1 revival fired.)
    expect(state.actors["pc.you"]?.currentHp).toBe(0);
    // Combat ended cleanly.
    expect(byKind(events, "combatEnded").length).toBeGreaterThan(0);
  });

  test("BACKWARD-COMPAT: a world with NO defeatOutcomes still revives the PC at 1 HP", async () => {
    // Same forced defeat, but the world authors no table → the historic fallback runs untouched.
    const playset = withBandit(await loadExample(), 30);
    expect(playset.world.constitution.defeatOutcomes).toEqual([]);
    const { engine } = await makeEngine(playset, seededState(playset));

    for (let i = 0; i < 12; i++) {
      await engine.submitPlayerInput("I attack the bandit");
      if (!(engine.getState().modules?.combat as { active?: boolean }).active) break;
    }

    const state = engine.getState();
    expect((state.modules?.combat as { active?: boolean }).active).toBe(false);
    // The 1-HP revival: playable again, unconscious cleared, no captive flag from any table.
    expect(state.actors["pc.you"]?.currentHp).toBe(1);
    expect(state.actors["pc.you"]?.conditions).not.toContain("unconscious");
    expect(state.flags?.captive).toBeUndefined();
  });
});
