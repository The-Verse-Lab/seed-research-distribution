/**
 * Observer-safe scene projection (NPC-EPISTEMIC-CONTEXT-PLAN Phase 2, §18.4/§18.5): an NPC-audience
 * brief drops narrator-only authority — other NPCs' motive summaries, the player's pack and purse,
 * the player-known `# CASE` evidence, un-participated record rows, and out-of-faction standing —
 * while the GM brief (absent audience) stays byte-identical.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { buildNarrationContext, type ContextInput } from "../src/agents/context.ts";
import { modelExits, modelPresence } from "../src/world/queries.ts";
import { fromGameState } from "../src/world/model.ts";
import { CaseSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { heuristicClassifier } from "./support/test-classifier.ts";

/** Emberford with a dressed, provisioned PC, a journey, a dealing with Brann, and standings. */
async function scene(): Promise<{ playset: PlaySet; state: GameState }> {
  const playset = await loadPlaySetFromDir(fileURLToPath(new URL("fixtures/worlds/example", import.meta.url)));
  const engine = new GameEngine({
    classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
  });
  await engine.start();
  const base = engine.getState();
  const pc = base.party[0]!;
  const state: GameState = {
    ...base,
    actors: {
      ...base.actors,
      [pc]: {
        ...base.actors[pc]!,
        inventory: ["item.rope", "item.rope"],
        coins: 137,
        equipped: { weapon: "weapon.dagger" },
      },
    },
    modules: {
      ...base.modules,
      journey: { log: [{ fromId: "loc.tavern", toId: "loc.square", atClock: 30 }] },
      exchanges: {
        nextId: 2,
        records: [
          {
            id: 1,
            day: 0,
            minute: 45,
            npcId: "npc.brann",
            npcName: "Brann",
            kind: "buy",
            lines: [],
            coinsCp: -12,
            note: "Bought a mug of ale from Brann for 12cp",
          },
        ],
      },
      factionStanding: { byPc: { [pc]: { "faction.lanterns": 30 } } },
    },
  };
  return { playset, state };
}

function briefFor(playset: PlaySet, state: GameState, audience?: ContextInput["audience"]): string {
  const model = fromGameState(state, playset.world, playset.campaign);
  return buildNarrationContext({
    world: playset.world,
    campaign: playset.campaign,
    state,
    recentEvents: [],
    trigger: "You look about.",
    ...(audience ? { audience } : {}),
    present: modelPresence(model, playset.world),
    exits: modelExits(model, (id) => id),
  }).contextText;
}

describe("Phase 2 — observer-safe scene projection", () => {
  test("another NPC's motive summary reaches the GM, never an NPC audience", async () => {
    const { playset, state } = await scene();
    const gm = briefFor(playset, state);
    const forBrann = briefFor(playset, state, { kind: "npc", npcId: "npc.brann" });

    // Lyra's authored summary carries history/subtext — GM keeps it, Brann sees only her surface.
    expect(gm).toContain("A sharp-eyed ranger-captain");
    expect(forBrann).not.toContain("A sharp-eyed ranger-captain");
    expect(forBrann).toContain("Lyra");
    expect(forBrann).toContain("(with you)");
    // Brann's own summary is equally absent from his own brief — identity lives in his system prompt.
    expect(forBrann).not.toContain("hears everything and forgets nothing");
  });

  test("the pack and purse are concealed from an NPC; the visibly-worn kit is not", async () => {
    const { playset, state } = await scene();
    const gm = briefFor(playset, state);
    const forBrann = briefFor(playset, state, { kind: "npc", npcId: "npc.brann" });

    expect(gm).toContain("You carry:");
    expect(gm).toContain("1 gp 3 sp 7 cp"); // the purse, via formatCoins
    expect(forBrann).not.toContain("You carry:");
    expect(forBrann).not.toContain("1 gp 3 sp 7 cp");
    // Equipped gear is on the body — observable by anyone.
    expect(forBrann).toContain("Wielding/worn:");
  });

  test("record rows follow participation: companion keeps the arc, a bystander keeps only its own deals", async () => {
    const { playset, state } = await scene();
    const gm = briefFor(playset, state);
    const forLyra = briefFor(playset, state, { kind: "npc", npcId: "npc.lyra" });
    const forBrann = briefFor(playset, state, { kind: "npc", npcId: "npc.brann" });

    // GM: everything.
    expect(gm).toContain("- [TAKEN] The Missing Caravan");
    expect(gm).toContain("- [TRAVELED]");
    expect(gm).toContain("- [DEALT] Bought a mug of ale");

    // Lyra is a party member: she walked the arc (the 07-24 P1 this ledger was built for).
    expect(forLyra).toContain("- [TAKEN] The Missing Caravan");
    expect(forLyra).toContain("- [TRAVELED]");

    // Brann gave no quest and made no journey — but the ale deal is HIS.
    expect(forBrann).not.toContain("- [TAKEN]");
    expect(forBrann).not.toContain("- [TRAVELED]");
    expect(forBrann).toContain("- [DEALT] Bought a mug of ale");
  });

  test("player-known case evidence never enters an NPC brief", async () => {
    const { playset, state } = await scene();
    const withCase: PlaySet = {
      ...playset,
      campaign: {
        ...playset.campaign,
        cases: [
          CaseSchema.parse({
            id: "case.t",
            name: "The Cellar Ledger",
            questId: "quest.missing-caravan",
            truth: { culpritId: "npc.brann", method: "m", motive: "m", summary: "s" },
            facts: [{ id: "f1", text: "The cellar ledger page was torn out.", kind: "physical", core: true }],
            accusation: {},
          }),
        ],
      },
    };
    const caseState: GameState = {
      ...state,
      modules: { ...state.modules, cases: { "case.t": { status: "open", playerKnown: ["f1"] } } },
    };
    const gm = briefFor(withCase, caseState);
    const forBrann = briefFor(withCase, caseState, { kind: "npc", npcId: "npc.brann" });

    expect(gm).toContain("# CASE — The Cellar Ledger");
    expect(gm).toContain("The cellar ledger page was torn out.");
    expect(forBrann).not.toContain("# CASE");
    expect(forBrann).not.toContain("cellar ledger page");
  });

  test("faction standing reaches only the observer's own faction; the roster registry stays GM-only", async () => {
    const { playset, state } = await scene();
    const gm = briefFor(playset, state);
    const forLyra = briefFor(playset, state, { kind: "npc", npcId: "npc.lyra" }); // faction.lanterns
    const forBrann = briefFor(playset, state, { kind: "npc", npcId: "npc.brann" }); // factionless

    expect(gm).toContain("# FACTION STANDING");
    expect(forLyra).toContain("# FACTION STANDING"); // her own faction's read of the PC
    expect(forBrann).not.toContain("# FACTION STANDING");
    // Canon-name registry is anti-invention scaffolding for the GM alone.
    expect(gm.includes("# CANON NAMES") || playset.world.npcs.length <= 2).toBe(true);
    expect(forBrann).not.toContain("# CANON NAMES");
  });

  test("an explicit gm audience is byte-identical to no audience at all", async () => {
    const { playset, state } = await scene();
    expect(briefFor(playset, state, { kind: "gm" })).toBe(briefFor(playset, state));
  });
});
