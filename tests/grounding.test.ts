/**
 * Grounding + arbitration tests — the pure core of bounded autonomy.
 *
 * groundToCommand (a CLOSED NPC act → a legal action) and arbitration (reply-chain decay +
 * reply-focus) are pure functions of state, so they are tested in isolation: no engine, no gateway,
 * no IO. The world only moves through validated actions, and an act naming anything the actor may
 * not legally do must always degrade to the always-legal `speak` fallback (docs/PROACTIVE-NPCS §5).
 *
 * The first describe pins the r8 regex-audit repro: grounding used to keyword-score a free-text
 * imperative with `confidence = matched / TOTAL tokens`, which dropped a natural sentence naming
 * three real ids and committed deltas for two-word asides. Those exact inputs are asserted below.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import type { Exit } from "../src/content/schema.ts";
import { mulberry32 } from "../src/rules/dice.ts";
import { fromGameState, type WorldModel } from "../src/world/model.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { canTraverse } from "../src/world/traversal.ts";
import {
  actCandidates,
  groundToCommand,
  groundingFallbackReason,
  renderActCandidates,
} from "../src/modules/autonomy/grounding.ts";
import {
  pickReplyTarget,
  replyProbability,
  shouldContinueReply,
} from "../src/director/arbitration.ts";
import { loadThistledown } from "./support/harness.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";

/** A started thistledown model (Maelle is a companion, starting at loc.hart). */
async function thistledownModel(): Promise<WorldModel> {
  const playset = await loadThistledown();
  const engine = new GameEngine({ classifier: heuristicClassifier,
    playset,
    store: new InMemoryGameStateStore(),
    gateway: new OfflineGateway(),
    rng: mulberry32(42),
  });
  await engine.start();
  return fromGameState(engine.getState(), playset.world, playset.campaign);
}

describe("groundToCommand — the r8 repro: prose no longer decides a delta", () => {
  test("the plan the keyword scorer DROPPED now grounds, because the act is named not guessed", async () => {
    // Reproduced against the shipped scorer on this very fixture: the sentence
    //   "I'll walk over to Emrin's Forge and hand the player the sealed letter she asked for."
    // scored 0.167 (2 matched keywords / 16 tokens) and fell UNDER the 0.4 floor — dropped to
    // banter although every id in it was legal. The NPC now names the act instead; the words it
    // says are no longer scored at all, so sentence length cannot demote a real plan.
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });

    const r = groundToCommand("npc.maelle", { do: "move", target: "loc.forge" }, model, world, {
      leadsParty: true,
    });
    expect(r.fellBack).toBe(false);
    expect(r.action).toEqual({ kind: "command", command: { type: "moveParty", to: "loc.forge" } });
  });

  test("'Sit tight.' spoken to the player spends NO energy — an aside is not a rest", async () => {
    // Reproduced: REST_KEYWORDS hit "sit" for 1/2 = 0.5, over the floor, so a two-word line said TO
    // the player committed `adjustEnergy +20` on a depleted NPC. Words carry no act any more: with
    // no `act` on the intent there is nothing to ground, whatever the NPC said.
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "adjustEnergy", entityId: "npc.maelle", by: -20 });

    const r = groundToCommand("npc.maelle", undefined, model, world);
    expect(r.action).toEqual({ kind: "speak" });
    expect(r.confidence).toBe(0);
    // …and the rest verb itself still works when the NPC actually names it.
    const rested = groundToCommand("npc.maelle", { do: "rest" }, model, world);
    expect(rested.action).toEqual({
      kind: "command",
      command: { type: "adjustEnergy", entityId: "npc.maelle", by: 20 },
    });
  });

  test("no verb can nudge a relationship toward a person nobody named", async () => {
    // Reproduced: the word "trust" alone scored 1.0 and committed `adjustRelationship` toward
    // `present[0]` — a bare `target ?? present[0]` default meant the FIRST body in the room ate a
    // gesture the line never addressed. The verb is gone from the closed set entirely: an
    // autonomous beat cannot move a relationship at all, and the DIALOGUE path's clamped
    // `relationshipNudge` (src/modules/dialogue.ts) remains the only way regard moves.
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    const r = groundToCommand(
      "npc.maelle",
      { do: "relationship" as never, target: "pc.you" },
      model,
      world,
    );
    expect(r.action).toEqual({ kind: "speak" });
  });
});

describe("groundToCommand (closed-act grounding)", () => {
  test("(1) no act named falls back to speak at confidence 0", async () => {
    const model = await thistledownModel();
    const r = groundToCommand("npc.maelle", undefined, model, (await loadThistledown()).world);
    expect(r.action.kind).toBe("speak");
    expect(r.fellBack).toBe(true);
    expect(r.confidence).toBe(0);
  });

  test("(1b) the explicit `none` verb is the same deliberate silence", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    const r = groundToCommand("npc.maelle", { do: "none" }, model, world);
    expect(r.action).toEqual({ kind: "speak" });
    expect(r.confidence).toBe(0);
  });

  test("(2) a non-leader COMPANION is never OFFERED a move — and a named one is refused", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    // Put Maelle on the green, from which Emrin's Forge is a direct, unlocked exit.
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });

    // Maelle is a party companion, not the leader — a self-move walks her out of the party (which
    // never follows) and she is then narrated back into the scene as a phantom (audit #6). The
    // destination is therefore absent from her candidate table, so naming it grounds to nothing.
    expect(actCandidates("npc.maelle", model, world).move).toEqual([]);
    const r = groundToCommand("npc.maelle", { do: "move", target: "loc.forge" }, model, world);
    expect(r.fellBack).toBe(true);
    expect(r.action.kind).toBe("speak");
  });

  test("(3) a move to an unreachable place is refused (and was never offered)", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    // The Warden Barrow is NOT a direct exit from the green (it's woods → barrow).
    const cands = actCandidates("npc.maelle", model, world, { leadsParty: true });
    expect(cands.move.map((m) => m.id)).not.toContain("loc.barrow");
    const r = groundToCommand("npc.maelle", { do: "move", target: "loc.barrow" }, model, world, {
      leadsParty: true,
    });
    expect(r.action.kind).toBe("speak");
    expect(r.fellBack).toBe(true);
    // …and it is reported as a DROP (the NPC named an act that could not happen), not as silence.
    expect(groundingFallbackReason(r)).toEqual({ confidence: 1, reason: "illegal" });
  });

  test("(3b) a HIDDEN exit is never offered — the candidate block is prompt text, not a map dump", async () => {
    // The old scorer only filtered `locked`, so a hidden exit COULD ground; it was never printed,
    // though. This block IS printed, so a hidden way listed here would hand the model a secret
    // passage it could speak aloud. Same filter as every player surface.
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    model.map.exits.set("loc.green", [
      ...(model.map.exits.get("loc.green") ?? []),
      { to: "loc.vault", locked: false, hidden: true, name: "a crack behind the ivy" },
    ]);

    const cands = actCandidates("npc.maelle", model, world, { leadsParty: true });
    expect(cands.move.map((m) => m.id)).not.toContain("loc.vault");
    expect(renderActCandidates(cands).join("\n")).not.toContain("ivy");
    const r = groundToCommand("npc.maelle", { do: "move", target: "loc.vault" }, model, world, {
      leadsParty: true,
    });
    expect(r.action.kind).toBe("speak");
  });

  test("(4) a place NAME instead of an id grounds to nothing — ids only", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    // "Emrin's Forge" is the authored NAME of loc.forge. Matching prose to a destination is exactly
    // the guess this rewrite removed: only the id copied out of `# CANDIDATE ACTIONS` binds.
    const r = groundToCommand("npc.maelle", { do: "move", target: "Emrin's Forge" }, model, world, {
      leadsParty: true,
    });
    expect(r.action.kind).toBe("speak");
  });

  test("an NPC can never ground into world-structure mutations (the closed verb set only)", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    // Even an on-the-nose act naming a flag/quest/spawn must not become that command: the verb is
    // not in NPC_ACT_VERBS, so `parseNpcAct` would have dropped it and the grounder refuses it too.
    for (const verb of ["setFlag", "spawn", "setQuestState", "despawn"]) {
      const r = groundToCommand("npc.maelle", { do: verb as never, target: "quest.any" }, model, world);
      expect(r.action.kind).toBe("speak");
    }
  });
});

describe("groundToCommand — the widened NPC vocabulary (equip / unequip / open-barrier)", () => {
  /** A barred iron-gate exit off the green toward a vault, with the given obstacle (map fixture). */
  const ironGate = (barrier: Exit["barrier"]): Exit => ({
    to: "loc.vault",
    locked: false,
    hidden: false,
    name: "the iron gate",
    barrier,
  });

  /** Append an exit to a location's edge list on the live model map (the review-regressions idiom). */
  const addExit = (model: WorldModel, from: string, exit: Exit): void => {
    model.map.exits.set(from, [...(model.map.exits.get(from) ?? []), exit]);
  };

  test("(equip) a dagger owned grounds to equipItem in the one slot it fits", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "transferItem", itemId: "weapon.dagger", from: null, to: "npc.maelle" });

    // The slot is CODE's answer, not the model's: the act names the item, the table names the slot.
    expect(actCandidates("npc.maelle", model, world).equip).toContainEqual(
      expect.objectContaining({ id: "weapon.dagger", slot: "weapon" }),
    );
    const r = groundToCommand("npc.maelle", { do: "equip", target: "weapon.dagger" }, model, world);
    expect(r.fellBack).toBe(false);
    expect(r.action).toEqual({
      kind: "command",
      command: { type: "equipItem", entityId: "npc.maelle", slot: "weapon", itemId: "weapon.dagger" },
    });
  });

  test("(equip) an item the NPC does NOT own falls back to speak", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    // No dagger in Maelle's inventory — the act has no legal row, so nothing grounds.
    const r = groundToCommand("npc.maelle", { do: "equip", target: "weapon.dagger" }, model, world);
    expect(r.action.kind).toBe("speak");
    expect(r.fellBack).toBe(true);
  });

  test("(equip) an owned item that fits no slot (a consumable) falls back to speak", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "transferItem", itemId: "item.honeycakes", from: null, to: "npc.maelle" });
    // Owned, but content says it is not equippable — slot fit is the enqueuer's gate.
    const r = groundToCommand("npc.maelle", { do: "equip", target: "item.honeycakes" }, model, world);
    expect(r.action.kind).toBe("speak");
    expect(r.fellBack).toBe(true);
  });

  test("(unequip) an EQUIPPED dagger grounds to a null-item equipItem (the reducer's vacate form)", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "transferItem", itemId: "weapon.dagger", from: null, to: "npc.maelle" });
    applyCommand(model, { type: "equipItem", entityId: "npc.maelle", slot: "weapon", itemId: "weapon.dagger" });

    const r = groundToCommand("npc.maelle", { do: "unequip", target: "weapon.dagger" }, model, world);
    expect(r.fellBack).toBe(false);
    expect(r.action).toEqual({
      kind: "command",
      command: { type: "equipItem", entityId: "npc.maelle", slot: "weapon", itemId: null },
    });
  });

  test("(unequip) a carried-but-not-equipped item falls back to speak", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "transferItem", itemId: "weapon.dagger", from: null, to: "npc.maelle" });
    // In the pack, not on the belt — there is nothing to take off, so no row forms.
    const r = groundToCommand("npc.maelle", { do: "unequip", target: "weapon.dagger" }, model, world);
    expect(r.action.kind).toBe("speak");
    expect(r.fellBack).toBe(true);
  });

  test("(open) a gate whose KEY is held grounds to setExitState — and the reducer accepts it", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    addExit(
      model,
      "loc.green",
      ironGate({ kind: "gate", keyItemId: "item.vaultkey", description: "a heavy iron gate, padlocked" }),
    );
    applyCommand(model, { type: "transferItem", itemId: "item.vaultkey", from: null, to: "npc.maelle" });

    const r = groundToCommand("npc.maelle", { do: "open", target: "loc.vault" }, model, world);
    expect(r.fellBack).toBe(false);
    expect(r.action.kind).toBe("command");
    if (r.action.kind === "command") {
      expect(r.action.command).toEqual({ type: "setExitState", locationId: "loc.green", to: "loc.vault", state: "open" });
      // The grounded command is legal end-to-end: the one writer applies it and the way opens.
      const res = applyCommand(model, r.action.command);
      expect(res.mutated).toBe(true);
      expect(canTraverse(model, "loc.green", "loc.vault")).toBe(true);
    }
  });

  test("(open) a TRUE barrier condition is the other passive path", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    // clockAtLeast 0 always holds — the passive condition path, no key anywhere.
    addExit(model, "loc.green", ironGate({ kind: "gate", condition: { allOf: [{ kind: "clockAtLeast", minutes: 0 }] } }));

    const r = groundToCommand("npc.maelle", { do: "open", target: "loc.vault" }, model, world);
    expect(r.action).toEqual({
      kind: "command",
      command: { type: "setExitState", locationId: "loc.green", to: "loc.vault", state: "open" },
    });
  });

  test("(open) with NO key held the gate is not on the open table at all", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    addExit(
      model,
      "loc.green",
      ironGate({ kind: "gate", keyItemId: "item.vaultkey", description: "a heavy iron gate, padlocked" }),
    );
    // Maelle holds no key and no condition opens it — unopenable ⇒ never offered, never grounded.
    expect(actCandidates("npc.maelle", model, world).open).toEqual([]);
    const r = groundToCommand("npc.maelle", { do: "open", target: "loc.vault" }, model, world);
    expect(r.action.kind).toBe("speak");
    expect(r.fellBack).toBe(true);
    expect(canTraverse(model, "loc.green", "loc.vault")).toBe(false);
  });

  test("(open) a HIDDEN barred exit is never offered — the same filter every player surface applies", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    addExit(model, "loc.green", {
      ...ironGate({ kind: "gate", keyItemId: "item.vaultkey", description: "a heavy iron gate, padlocked" }),
      hidden: true,
    });
    applyCommand(model, { type: "transferItem", itemId: "item.vaultkey", from: null, to: "npc.maelle" });

    expect(actCandidates("npc.maelle", model, world).open).toEqual([]);
    const r = groundToCommand("npc.maelle", { do: "open", target: "loc.vault" }, model, world);
    expect(r.action.kind).toBe("speak");
    expect(canTraverse(model, "loc.green", "loc.vault")).toBe(false);
  });

  // Regex audit §10d. `canOpenBarrier` handed `evalPredicate` a hand-picked `{ regionOf }` bundle,
  // and every EvalLookups resolver is FAIL-CLOSED, so two whole condition kinds could never hold at
  // a barrier — the door was sealed forever with nothing logged. Both repros below were run against
  // the shipped function on this very fixture (`loc.green` sits in a region of danger 1): the
  // `regionDangerAtLeast: 0` gate offered `open: []` and ground to `speak`, while the identical
  // `clockAtLeast: 0` gate above opened.
  describe("(open) the barrier seam gets the COMPLETE lookup bundle", () => {
    test("a regionDangerAtLeast condition can hold — and still fails when the danger is short", async () => {
      const world = (await loadThistledown()).world;
      const model = await thistledownModel();
      applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
      // loc.green's region reads danger 1 (regionProfileOf), so 0 must open and 3 must not.
      addExit(model, "loc.green", ironGate({ kind: "gate", condition: { allOf: [{ kind: "regionDangerAtLeast", value: 0 }] } }));
      expect(actCandidates("npc.maelle", model, world).open).toEqual([
        { id: "loc.vault", label: "the iron gate → loc.vault — a locked gate" },
      ]);
      expect(groundToCommand("npc.maelle", { do: "open", target: "loc.vault" }, model, world).action).toEqual({
        kind: "command",
        command: { type: "setExitState", locationId: "loc.green", to: "loc.vault", state: "open" },
      });

      const shut = await thistledownModel();
      applyCommand(shut, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
      addExit(shut, "loc.green", ironGate({ kind: "gate", condition: { allOf: [{ kind: "regionDangerAtLeast", value: 3 }] } }));
      expect(actCandidates("npc.maelle", shut, world).open).toEqual([]);
      expect(groundToCommand("npc.maelle", { do: "open", target: "loc.vault" }, shut, world).action.kind).toBe("speak");
    });

    test("an attireState condition reads the SAME coverage baseline as every other surface", async () => {
      const playset = await loadThistledown();
      const world = playset.world;
      const characters = playset.campaign.characters;
      const gate = ironGate({ kind: "gate", condition: { allOf: [{ kind: "attireState", state: "bare" }] } });

      // A stripped PC: top and bottoms removed. `visibleStateOf`/the brief's `Attire:` line and an
      // authored `attireState` event all call this "bare" — the barrier used to disagree, because
      // without `occupiedOf` it judged against all six coverage slots and saw four still "worn".
      const stripped = await thistledownModel();
      applyCommand(stripped, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
      const pcId = [...stripped.entities.values()].find((e) => e.kind === "pc")!.id;
      stripped.modules.wardrobe = { [pcId]: { upper: "removed", lower: "removed" } };
      addExit(stripped, "loc.green", gate);
      expect(actCandidates("npc.maelle", stripped, world, { characters }).open).toHaveLength(1);

      // The other direction: a dressed PC leaves the same gate shut.
      const dressed = await thistledownModel();
      applyCommand(dressed, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
      dressed.modules.wardrobe = { [pcId]: { upper: "worn", lower: "worn" } };
      addExit(dressed, "loc.green", gate);
      expect(actCandidates("npc.maelle", dressed, world, { characters }).open).toEqual([]);
    });
  });
});

describe("groundToCommand — barrier-attempt / rest / loot", () => {
  /** A barred iron-gate exit off the green toward a vault, with the given obstacle (map fixture). */
  const ironGate = (barrier: Exit["barrier"]): Exit => ({
    to: "loc.vault",
    locked: false,
    hidden: false,
    name: "the iron gate",
    barrier,
  });
  const addExit = (model: WorldModel, from: string, exit: Exit): void => {
    model.map.exits.set(from, [...(model.map.exits.get(from) ?? []), exit]);
  };

  test("(pick) no key, a dc, still locked — classifies a barrierAttempt the MODULE will roll", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    // A pickable lock the NPC has NO key/condition for: a risky roll, not a free open.
    addExit(model, "loc.green", ironGate({ kind: "gate", dc: 15, description: "a heavy iron gate, padlocked" }));

    const r = groundToCommand("npc.maelle", { do: "pick", target: "loc.vault" }, model, world);
    expect(r.fellBack).toBe(false);
    expect(r.action).toEqual({
      kind: "barrierAttempt",
      verb: "pick",
      ability: "dex",
      locationId: "loc.green",
      to: "loc.vault",
      dc: 15,
      barrierDesc: "a heavy iron gate, padlocked",
      destName: "loc.vault",
    });
  });

  test("(pick) a barrier with NO dc is not pickable (falls back to speak)", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    // No dc, no breakDc, no key: unpickable, unforceable, unopenable → no row at all.
    addExit(model, "loc.green", ironGate({ kind: "gate", description: "a heavy iron gate, padlocked" }));

    const r = groundToCommand("npc.maelle", { do: "pick", target: "loc.vault" }, model, world);
    expect(r.action.kind).toBe("speak");
    expect(r.fellBack).toBe(true);
  });

  test("(pick) a dc on a NOT-'locked' barrier (rubble starts blocked) is not pickable", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    // Rubble starts "blocked", never "locked" — there is no lock to pick. dc present, no breakDc.
    addExit(model, "loc.green", ironGate({ kind: "rubble", dc: 12, description: "a fall of rubble" }));

    const r = groundToCommand("npc.maelle", { do: "pick", target: "loc.vault" }, model, world);
    expect(r.action.kind).toBe("speak");
    expect(r.fellBack).toBe(true);
  });

  test("(force) a breakDc classifies a str barrierAttempt", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    addExit(model, "loc.green", ironGate({ kind: "gate", breakDc: 18, description: "a heavy iron gate, padlocked" }));

    const r = groundToCommand("npc.maelle", { do: "force", target: "loc.vault" }, model, world);
    expect(r.fellBack).toBe(false);
    if (r.action.kind === "barrierAttempt") {
      expect(r.action.verb).toBe("force");
      expect(r.action.ability).toBe("str");
      expect(r.action.dc).toBe(18);
      expect(r.action.to).toBe("loc.vault");
      expect(r.action.locationId).toBe("loc.green");
    } else {
      throw new Error(`expected a barrierAttempt, got ${r.action.kind}`);
    }
  });

  test("(open beats pick) a HELD KEY means the gate is offered as `open` and NOT as `pick`", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    // Both a dc (pickable) AND a key held: the passive open path must win (free open > risk), and
    // the risky verb must not even be offered, or the model could pick a lock it holds the key to.
    addExit(
      model,
      "loc.green",
      ironGate({ kind: "gate", dc: 15, keyItemId: "item.vaultkey", description: "a padlocked iron gate" }),
    );
    applyCommand(model, { type: "transferItem", itemId: "item.vaultkey", from: null, to: "npc.maelle" });

    const cands = actCandidates("npc.maelle", model, world);
    expect(cands.open.map((c) => c.id)).toEqual(["loc.vault"]);
    expect(cands.pick).toEqual([]);
    const r = groundToCommand("npc.maelle", { do: "open", target: "loc.vault" }, model, world);
    expect(r.action).toEqual({
      kind: "command",
      command: { type: "setExitState", locationId: "loc.green", to: "loc.vault", state: "open" },
    });
  });

  test("(rest) a DEPLETED actor's rest tops off exactly the missing energy", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    // Drain 30 energy so the actor is below its ceiling; recovery is the full missing amount, and
    // the NUMBER is code's (derived from the energy model) — the act names no amount.
    applyCommand(model, { type: "adjustEnergy", entityId: "npc.maelle", by: -30 });

    const r = groundToCommand("npc.maelle", { do: "rest" }, model, world);
    expect(r.fellBack).toBe(false);
    expect(r.action).toEqual({
      kind: "command",
      command: { type: "adjustEnergy", entityId: "npc.maelle", by: 30 },
    });
  });

  test("(rest) a FULL actor is not offered a rest, and naming one changes nothing", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    // Energy is full (absent = full): no rest row, so the act grounds to speech.
    expect(actCandidates("npc.maelle", model, world).rest).toBe(0);
    const r = groundToCommand("npc.maelle", { do: "rest" }, model, world);
    expect(r.action.kind).toBe("speak");
    expect(r.fellBack).toBe(true);
  });

  test("(loot) an item on a DOWNED present holder grounds to transferItem", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    applyCommand(model, {
      type: "spawnEntity",
      entity: {
        id: "npc.bandit",
        kind: "monster",
        tier: "transient",
        name: "bandit",
        locationId: "loc.green",
        stats: { currentHp: 0, maxHp: 8, conditions: ["unconscious"], inventory: ["weapon.dagger"] },
      },
    });

    // The HOLDER comes from the table, never from the act — an NPC cannot name a source it wasn't offered.
    const r = groundToCommand("npc.maelle", { do: "loot", target: "weapon.dagger" }, model, world);
    expect(r.fellBack).toBe(false);
    expect(r.action).toEqual({
      kind: "command",
      command: { type: "transferItem", itemId: "weapon.dagger", from: "npc.bandit", to: "npc.maelle" },
    });
  });

  test("(loot) a CONSCIOUS holder is not lootable (that would be theft) → speak", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    applyCommand(model, {
      type: "spawnEntity",
      entity: {
        id: "npc.bandit",
        kind: "monster",
        tier: "transient",
        name: "bandit",
        locationId: "loc.green",
        stats: { currentHp: 8, maxHp: 8, conditions: [], inventory: ["weapon.dagger"] },
      },
    });

    expect(actCandidates("npc.maelle", model, world).loot).toEqual([]);
    const r = groundToCommand("npc.maelle", { do: "loot", target: "weapon.dagger" }, model, world);
    expect(r.action.kind).toBe("speak");
    expect(r.fellBack).toBe(true);
  });
});

describe("groundToCommand — give needs BOTH ids, from the table", () => {
  test("an owned item to a PRESENT recipient grounds to transferItem", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "transferItem", itemId: "item.honeycakes", from: null, to: "npc.maelle" });

    const r = groundToCommand(
      "npc.maelle",
      { do: "give", target: "item.honeycakes", to: "pc.you" },
      model,
      world,
    );
    expect(r.fellBack).toBe(false);
    expect(r.action).toEqual({
      kind: "command",
      command: { type: "transferItem", itemId: "item.honeycakes", from: "npc.maelle", to: "pc.you" },
    });
  });

  test("a give with NO recipient named is refused — who receives it is a delta, so it is named", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "transferItem", itemId: "item.honeycakes", from: null, to: "npc.maelle" });
    // The old scorer defaulted an unnamed target to `present[0]`; nothing defaults now.
    const r = groundToCommand("npc.maelle", { do: "give", target: "item.honeycakes" }, model, world);
    expect(r.action.kind).toBe("speak");
    expect(groundingFallbackReason(r)).toEqual({ confidence: 1, reason: "illegal" });
  });

  test("a recipient who is NOT present is refused", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "transferItem", itemId: "item.honeycakes", from: null, to: "npc.maelle" });
    const r = groundToCommand(
      "npc.maelle",
      { do: "give", target: "item.honeycakes", to: "npc.nobody" },
      model,
      world,
    );
    expect(r.action.kind).toBe("speak");
  });
});

describe("actCandidates / renderActCandidates — the brief block the act is chosen from", () => {
  test("the block offers exactly what is legal, id first", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    // Maelle stays where the party is (loc.hart), so there are recipients to hand something to.
    applyCommand(model, { type: "transferItem", itemId: "item.honeycakes", from: null, to: "npc.maelle" });

    const lines = renderActCandidates(actCandidates("npc.maelle", model, world, { leadsParty: true }));
    const block = lines.join("\n");
    // Every id the model is allowed to copy appears verbatim, under its verb, with words after it.
    expect(block).toContain(`"move": loc.green`);
    expect(block).toContain(`"use": item.honeycakes (Honeyed Cakes)`);
    expect(block).toContain(`"give": item.honeycakes (Honeyed Cakes)`);
    expect(block).toContain(`for "give", also set "to"`);
    expect(block).toContain("pc.you");
    // Nothing illegal is advertised: full energy ⇒ no rest row, no barred exits ⇒ no open/pick/force.
    expect(block).not.toContain(`"rest"`);
    expect(block).not.toContain(`"open"`);
    expect(block).not.toContain(`"pick"`);
    expect(block).not.toContain(`"take_job"`);
  });

  test("an affordance-less scene renders NO block at all (omit-when-empty)", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    // A statless, party-bound companion with nothing carried, standing where it cannot move: the
    // brief keeps its pre-candidate shape rather than carrying an empty header.
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    const bare = actCandidates("npc.maelle", model, world);
    expect(bare.move).toEqual([]);
    expect(renderActCandidates({ ...bare, give: [], recipients: [], use: [], equip: [], rest: 0 })).toEqual([]);
  });

  test("a LEADER is offered the party's destinations and the jobs on the board; an ordinary companion neither", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    const offeredQuests = [{ id: "quest.salt", name: "Salt Run" }];

    const leader = actCandidates("npc.maelle", model, world, { leadsParty: true, offeredQuests });
    expect(leader.move.map((m) => m.id)).toContain("loc.forge");
    expect(leader.take_job.map((q) => q.id)).toEqual(["quest.salt"]);

    const companion = actCandidates("npc.maelle", model, world, { offeredQuests });
    expect(companion.move).toEqual([]);
    expect(companion.take_job).toEqual([]);
  });
});

describe("groundingFallbackReason (Workstream C slim — dropped-action telemetry)", () => {
  test("a clean grounding is NOT a drop (null)", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    // A LEADER's move grounds cleanly (moveParty — the whole party follows), so it is not a drop.
    const r = groundToCommand("npc.maelle", { do: "move", target: "loc.forge" }, model, world, {
      leadsParty: true,
    });
    expect(r.fellBack).toBe(false);
    expect(groundingFallbackReason(r)).toBeNull();
  });

  test("a pure-conversation beat (no act named, confidence 0) is NOT a drop", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    const r = groundToCommand("npc.maelle", undefined, model, world);
    expect(r.confidence).toBe(0);
    expect(groundingFallbackReason(r)).toBeNull();
  });

  test("a NAMED act that isn't on the legal table → an illegal drop", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    // The NPC named a destination it was never offered: the attempt is recorded so the Turns
    // inspector shows WHICH act never happened, instead of the fallback being silent.
    const r = groundToCommand("npc.maelle", { do: "move", target: "loc.nowhere" }, model, world, {
      leadsParty: true,
    });
    expect(r.fellBack).toBe(true);
    expect(groundingFallbackReason(r)).toEqual({ confidence: 1, reason: "illegal" });
  });

  test("the legacy `low-confidence` reason is still classified (old traces carry it)", () => {
    expect(groundingFallbackReason({ action: { kind: "speak" }, confidence: 0.2, fellBack: true })).toEqual({
      confidence: 0.2,
      reason: "low-confidence",
    });
  });
});

describe("arbitration (reply-chain decay + reply-focus)", () => {
  test("(5) a fresh chain (depth 0) always continues", () => {
    expect(shouldContinueReply(0, 0.2, mulberry32(42))).toBe(true);
  });

  test("(6) a long chain (depth 6, α 0.2) terminates", () => {
    // P(6) = max(0, 1 − 5·0.2) = 0 → never continues, regardless of the roll.
    expect(shouldContinueReply(6, 0.2, mulberry32(42))).toBe(false);
  });

  test("(7) reply-focus prefers the higher-relationship candidate", () => {
    const target = pickReplyTarget(
      ["npc.dorran", "npc.thistle"],
      { "npc.dorran": 55, "npc.thistle": -10 },
      mulberry32(42),
    );
    expect(target).toBe("npc.dorran");
  });

  test("(8) replyProbability(3, 0.2) === 0.6", () => {
    expect(replyProbability(3, 0.2)).toBeCloseTo(0.6, 10);
  });
});

describe("groundToCommand — leader + consumable targets (Feature 1)", () => {
  test("a LEADER's move grounds to moveParty (the whole party follows)", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    const r = groundToCommand("npc.maelle", { do: "move", target: "loc.forge" }, model, world, {
      leadsParty: true,
    });
    expect(r.fellBack).toBe(false);
    expect(r.action).toEqual({ kind: "command", command: { type: "moveParty", to: "loc.forge" } });
  });

  test("a NON-leader, NON-party WORLD NPC's move still grounds to a self-only moveEntity", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    // Strip party membership: a PRESENT non-party world NPC is free to wander its own world on a beat —
    // only a party COMPANION's self-move is suppressed (audit #6). So this path stays byte-identical.
    applyCommand(model, { type: "setPartyMembership", entityId: "npc.maelle", member: false });
    const r = groundToCommand("npc.maelle", { do: "move", target: "loc.forge" }, model, world);
    expect(r.action).toEqual({
      kind: "command",
      command: { type: "moveEntity", entityId: "npc.maelle", to: "loc.forge" },
    });
  });

  test("a NON-leader COMPANION's move is dropped — it must not walk itself out of the party", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "moveEntity", entityId: "npc.maelle", to: "loc.green" });
    const r = groundToCommand("npc.maelle", { do: "move", target: "loc.forge" }, model, world);
    expect(r.fellBack).toBe(true);
    expect(r.action.kind).toBe("speak");
  });

  test("a LEADER takes up an ON-OFFER job → setQuestState active", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    const r = groundToCommand("npc.maelle", { do: "take_job", target: "quest.salt" }, model, world, {
      leadsParty: true,
      offeredQuests: [{ id: "quest.salt", name: "Salt Run" }],
    });
    expect(r.fellBack).toBe(false);
    expect(r.action).toEqual({
      kind: "command",
      command: { type: "setQuestState", questId: "quest.salt", state: "active" },
    });
  });

  test("a NON-leader cannot ground into setQuestState — the job act is refused", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    // No leadsParty ⇒ no accept-job row, even with an offered quest on the table.
    const r = groundToCommand("npc.maelle", { do: "take_job", target: "quest.salt" }, model, world, {
      offeredQuests: [{ id: "quest.salt", name: "Salt Run" }],
    });
    expect(r.action.kind).toBe("speak");
    expect(r.fellBack).toBe(true);
  });

  test("a quest that is NOT on offer cannot be accepted, even by a leader", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    const r = groundToCommand("npc.maelle", { do: "take_job", target: "quest.hidden" }, model, world, {
      leadsParty: true,
      offeredQuests: [{ id: "quest.salt", name: "Salt Run" }],
    });
    expect(r.action.kind).toBe("speak");
  });

  test("using an owned consumable classifies as consumeItem (the module rolls it)", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "transferItem", itemId: "item.honeycakes", from: null, to: "npc.maelle" });
    const r = groundToCommand("npc.maelle", { do: "use", target: "item.honeycakes" }, model, world);
    expect(r.fellBack).toBe(false);
    expect(r.action).toEqual({ kind: "consumeItem", itemId: "item.honeycakes" });
  });

  test("using a NON-consumable the NPC owns forms no row → speak", async () => {
    const world = (await loadThistledown()).world;
    const model = await thistledownModel();
    applyCommand(model, { type: "transferItem", itemId: "weapon.dagger", from: null, to: "npc.maelle" });
    const r = groundToCommand("npc.maelle", { do: "use", target: "weapon.dagger" }, model, world);
    expect(r.action.kind).toBe("speak");
    expect(r.fellBack).toBe(true);
  });
});
