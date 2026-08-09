/**
 * Party integration tests — Phase 2 Stage D: travel, combat, and presence for PROMOTED members.
 *
 * Stage C proved the invite/leave/leadership flows; this suite proves a freshly promoted member
 * is a full companion everywhere else: `moveParty` carries them (membership IS the flag the
 * reducer walks), the dialogue module answers them when addressed (the live-agent map is keyed
 * off `partyMember`, not the authored companions list), the autonomy Director lets an appointed
 * promoted member heartbeat-propose, combat puts them on the party's side (friendly-fire guard
 * included), and the significant tier keeps them from ever being culled.
 *
 * Leaving the party MID-FIGHT is deliberately out of scope for this phase (noted in the plan):
 * the leave gate resolves on ordinary ticks; combat ticks route through the combat module first.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import type { GameEvent } from "../src/events/types.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import type { Entity } from "../src/world/entity.ts";
import type { WorldModel } from "../src/world/model.ts";
import { cullTransients, worldMaintenance } from "../src/world/maintenance.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { byKind, loadThistledown, type TraceBeat } from "./support/harness.ts";

const SEED = 7;

interface Built {
  engine: GameEngine;
  events: GameEvent[];
  /** Public NPC beats across turns — the observable for DM-owned public speech. */
  beats: TraceBeat[];
}

/** A started thistledown engine (offline, seeded) with Bett already invited into the party. */
async function buildWithBett(): Promise<Built> {
  const playset = await loadThistledown();
  const beats: TraceBeat[] = [];
  const engine = new GameEngine({ classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(SEED),
    onTurnTrace: (t) => {
      if (t.npcBeats) beats.push(...t.npcBeats);
    },
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  await engine.submitPlayerInput("Bett, come with us"); // neutral disposition — always accepts
  expect(engine.getState().companions).toContain("npc.bett");
  events.length = 0;
  beats.length = 0;
  return { engine, events, beats };
}

describe("travel — moveParty walks the partyMember flag, promoted members included", () => {
  test("a freshly promoted member follows the party across two locations", async () => {
    const { engine, events } = await buildWithBett();

    await engine.submitPlayerInput("I head to Brackenford Green");
    let s = engine.getState();
    expect(s.partyLocationId).toBe("loc.green");
    // The promoted member AND the authored companions all moved on the same flag.
    expect(s.actors["npc.bett"]?.locationId).toBe("loc.green");
    expect(s.actors["npc.maelle"]?.locationId).toBe("loc.green");
    expect(s.actors["npc.dorran"]?.locationId).toBe("loc.green");

    await engine.submitPlayerInput("I head to the Old Ford");
    s = engine.getState();
    expect(s.partyLocationId).toBe("loc.ford");
    expect(s.actors["npc.bett"]?.locationId).toBe("loc.ford");

    // Every hop moved the member through the reducer (entityMoved deltas, no side writes).
    const bettMoves = byKind(events, "entityMoved").filter((d) => d.entityId === "npc.bett");
    expect(bettMoves.map((d) => d.to)).toEqual(["loc.green", "loc.ford"]);
  });

  test("a non-member location NPC does NOT follow the party", async () => {
    const { engine } = await buildWithBett();
    await engine.submitPlayerInput("I head to Brackenford Green");
    // Emrin (forge, never invited) stayed put — membership, not presence, is what travels.
    const emrin = engine.presentEntities().find((e) => e.id === "npc.emrin");
    expect(emrin).toBeUndefined();
  });
});

describe("dialogue + heartbeat — companion enumeration is the partyMember flag", () => {
  test("a promoted member replies when addressed by name", async () => {
    const { engine, beats } = await buildWithBett();

    await engine.submitPlayerInput("Bett, what do you make of the road ahead?");

    // A promoted member's PUBLIC reply is a DM-narrated beat, not a raw dialogue bubble.
    const replies = beats.filter((b) => b.actorId === "npc.bett");
    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect((replies[0]?.dialogue?.length ?? 0)).toBeGreaterThan(0);
  });

  test("an appointed promoted member self-initiates on a quiet heartbeat (priority C)", async () => {
    const { engine, events, beats } = await buildWithBett();

    // Passive by authored template: an un-appointed heartbeat does nothing at all.
    await engine.tickHeartbeat("npc.bett");
    expect(byKind(events, "npcProposal")).toHaveLength(0);
    expect(beats.filter((b) => b.actorId === "npc.bett")).toHaveLength(0);

    await engine.submitPlayerInput("Make Bett the leader");
    expect(byKind(events, "partyLeaderChanged")).toHaveLength(1);
    events.length = 0;
    beats.length = 0;

    // Appointed, the SAME beat now self-initiates. Enriched Bett carries authored agenda goals,
    // so the Director's C-priority realize routes her line through the agenda path (a DM-narrated
    // beat + pending pressure) rather than a bare proposal — exactly what an authored leader would
    // do. Tacit-consent proposal EXECUTION for a promoted leader is covered by the offline playtest
    // (playtest/scripts/party-offline.ts) via the same machinery party-flows tests white-box.
    await engine.tickHeartbeat("npc.bett");
    const selfInitiated = [
      ...beats.filter((b) => b.actorId === "npc.bett"),
      ...byKind(events, "npcProposal").filter((d) => d.actorId === "npc.bett"),
    ];
    expect(selfInitiated.length).toBeGreaterThanOrEqual(1);
  });
});

describe("combat — a promoted member fights on the party's side", () => {
  /** Walk the party from the Hart to the Warden Barrow (spawns the wight via prebaked event). */
  async function walkToBarrow(engine: GameEngine): Promise<void> {
    for (const line of [
      "I head to Brackenford Green",
      "I head to the Old Ford",
      "I head into the woods",
      "I head down the barrow path",
    ]) {
      await engine.submitPlayerInput(line);
    }
    expect(engine.getState().partyLocationId).toBe("loc.barrow");
  }

  test("the member enters initiative with the party and swings at the party's foe", async () => {
    const { engine, events } = await buildWithBett();
    await walkToBarrow(engine);
    expect(byKind(events, "entitySpawned").some((d) => d.entityId === "mon.barrowwight#0")).toBe(true);
    events.length = 0;

    // First strike (or the wight's on-sight aggro) opens the fight; keep swinging until it ends.
    for (let swings = 0; swings < 16; swings++) {
      const combat = engine.getState().modules?.combat as { active?: boolean } | undefined;
      if (!combat?.active && swings > 0) break;
      await engine.submitPlayerInput("I attack the barrow wight");
    }

    const started = byKind(events, "combatStarted");
    expect(started.length).toBeGreaterThanOrEqual(1);
    // The promoted member rolled initiative alongside the authored party, against the wight.
    expect(started[0]!.encounter.order).toContain("npc.bett");
    expect(started[0]!.encounter.order).toContain("mon.barrowwight#0");

    // The member actually fought: their swings are real attack rolls against the foe.
    const bettSwings = byKind(events, "diceRolled").filter((d) => d.actorId === "npc.bett");
    expect(bettSwings.length).toBeGreaterThanOrEqual(1);
    expect(bettSwings.every((d) => d.purpose?.includes("Barrow Wight"))).toBe(true);

    const combat = engine.getState().modules?.combat as { active?: boolean } | undefined;
    expect(combat?.active).toBeFalsy();
  });

  test("the friendly-fire guard shields a promoted member from a fuzzy player attack", async () => {
    const { engine, events } = await buildWithBett();
    const hpBefore = engine.getState().actors["npc.bett"]?.currentHp;

    await engine.submitPlayerInput("I strike the wight before it reaches Bett");

    // The blow is checked: no combat forms, no damage lands, the member is untouched.
    expect(byKind(events, "combatStarted")).toHaveLength(0);
    expect(byKind(events, "hpChanged").filter((d) => d.entityId === "npc.bett")).toHaveLength(0);
    expect(engine.getState().actors["npc.bett"]?.currentHp).toBe(hpBefore!);
    const narration = byKind(events, "narration");
    expect(narration.length).toBeGreaterThanOrEqual(1);
    expect(narration[0]!.text).toContain("stands at your side");
  });
});

describe("culling — the significant tier is never reaped, promoted members included", () => {
  /** A minimal model: the PC at home, a promoted member + a transient extra left far away. */
  function farAwayModel(): WorldModel {
    const entity = (partial: Partial<Entity> & Pick<Entity, "id" | "kind" | "tier">): Entity => ({
      name: partial.id,
      locationId: null,
      partyMember: false,
      flags: {},
      ...partial,
    });
    return {
      campaignId: "c",
      worldId: "w",
      clock: 0,
      entities: new Map<string, Entity>([
        ["pc.you", entity({ id: "pc.you", kind: "pc", tier: "significant", locationId: "loc.home", partyMember: true })],
        // The edge under test: a promoted (significant) member stranded far from the party —
        // they never SHOULD be far (moveParty carries them), but the invariant must hold anyway.
        ["npc.joined", entity({ id: "npc.joined", kind: "npc", tier: "significant", locationId: "loc.far", partyMember: true })],
        ["npc.tracked", entity({ id: "npc.tracked", kind: "npc", tier: "tracked", locationId: "loc.far" })],
        ["mon.extra", entity({ id: "mon.extra", kind: "monster", tier: "transient", locationId: "loc.far" })],
      ]),
      map: { exits: new Map() },
      quests: new Map(),
      relationships: new Map(),
      modules: {},
      flags: {},
    };
  }

  test("cullTransients despawns ONLY the transient extra — significant and tracked survive", () => {
    const model = farAwayModel();
    const cmds = cullTransients(model, "loc.home");
    expect(cmds).toEqual([{ type: "despawnEntity", entityId: "mon.extra" }]);
    // The full maintenance pass agrees (culling is all there is today).
    expect(worldMaintenance(model, "loc.home")).toEqual(cmds);
  });
});
