/**
 * Captivity — the bad-end FOLLOW-UP with real consequences.
 *
 * A lost fight no longer sets a dead world flag: it enqueues `beginCaptivity`
 * and the player is REALLY held — moved to the locked hold, gear stripped, party scattered, a `captive`
 * condition set — then plays a turn-by-turn loop (labor / endure / escape) to get out. These lock:
 *   · the pure loop math (`resolveCaptivityAction`),
 *   · the engine arc end-to-end: capture → held (input gated) → labour to release → freed.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { mulberry32 } from "../src/rules/dice.ts";
import {
  CAPTIVITY_CONFIG,
  classifyCaptivityInput,
  captivityActionOf,
  captivityActionButtons,
  defaultCaptivitySlice,
  resolveCaptivityAction,
  type CaptivityKind,
  type CaptivitySlice,
} from "../src/rules/captivity.ts";
import { coverageRow } from "../src/rules/wardrobe.ts";
import { CAPTIVITY_LOCATION_ID } from "../src/world/captivity.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";
import type { GameEvent } from "../src/events/types.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { captivitySceneOf } from "../src/state/projections.ts";

// ── Pure loop math ───────────────────────────────────────────────────────────────────────────────

function heldSlice(over: Partial<CaptivitySlice> = {}): CaptivitySlice {
  const cfg = CAPTIVITY_CONFIG.gaol;
  return { ...defaultCaptivitySlice(), active: true, kind: "gaol", escapeDc: cfg.escapeDc, goal: cfg.goal, day: 1, ...over };
}

describe("captivity: pure loop math", () => {
  test("labor advances the term AND wears the guard down (DC floored at minEscapeDc)", () => {
    const cfg = CAPTIVITY_CONFIG.gaol;
    const r = resolveCaptivityAction(heldSlice({ progress: 0, escapeDc: cfg.escapeDc }), "labor");
    expect(r.next.progress).toBe(cfg.laborGain);
    expect(r.next.escapeDc).toBe(cfg.escapeDc - cfg.laborGuardDrop);
    expect(r.released).toBe(false);
    expect(r.beat.length).toBeGreaterThan(0);
    // The guard never drops below the floor no matter how much labour is done.
    const worn = resolveCaptivityAction(heldSlice({ escapeDc: cfg.minEscapeDc }), "labor");
    expect(worn.next.escapeDc).toBe(cfg.minEscapeDc);
  });

  test("laboring to the goal auto-releases (served the term)", () => {
    const cfg = CAPTIVITY_CONFIG.gaol;
    const r = resolveCaptivityAction(heldSlice({ progress: cfg.goal - cfg.laborGain }), "labor");
    expect(r.next.progress).toBeGreaterThanOrEqual(cfg.goal);
    expect(r.released).toBe(true);
    expect(r.escaped).toBe(false);
  });

  test("endure serves time slowly (a day passes, no guard drop)", () => {
    const cfg = CAPTIVITY_CONFIG.gaol;
    const r = resolveCaptivityAction(heldSlice({ progress: 1, escapeDc: cfg.escapeDc, day: 3 }), "endure");
    expect(r.next.progress).toBe(1 + cfg.endureGain);
    expect(r.next.escapeDc).toBe(cfg.escapeDc); // endure does not wear the guard
    expect(r.next.day).toBe(4);
  });

  test("a WON escape frees you; a FAILED escape stiffens the guard and costs a day", () => {
    const cfg = CAPTIVITY_CONFIG.gaol;
    const win = resolveCaptivityAction(heldSlice(), "escape", { escapeSucceeded: true });
    expect(win.escaped).toBe(true);
    expect(win.released).toBe(false);

    const fail = resolveCaptivityAction(heldSlice({ escapeDc: cfg.escapeDc, day: 2 }), "escape", { escapeSucceeded: false });
    expect(fail.escaped).toBe(false);
    expect(fail.next.escapeDc).toBe(cfg.escapeDc + cfg.escapeFailPenalty);
    expect(fail.next.day).toBe(3);
  });

  test("beat flavour is deterministic for (kind, action, day) — a private keyed pick, zero shared draws", () => {
    const a = resolveCaptivityAction(heldSlice({ day: 5 }), "labor").beat;
    const b = resolveCaptivityAction(heldSlice({ day: 5 }), "labor").beat;
    expect(a).toBe(b);
  });

  test("free-text classifies to an action, defaulting to endure", () => {
    expect(classifyCaptivityInput("I try to escape through the window")).toBe("escape");
    expect(classifyCaptivityInput("I work the chores to earn trust")).toBe("labor");
    expect(classifyCaptivityInput("I sit and wait, watching")).toBe("endure");
  });

  test("(r8) SEARCHING is not a break-out — the reproduced misfire, fixed at the floor too", () => {
    // The `escape` arm carried the bare token "run", so a line about running one's HANDS over a
    // wall committed the player to a break-out. That branch is not free — a real d20, and on the
    // (likely) failure a permanently raised `escapeDc` and a burned day — so the cue may not be
    // carried by a verb ordinary prose reaches for. `run` now needs a direction or object of flight.
    expect(classifyCaptivityInput("I run my hands along the wall looking for loose stones")).toBe("endure");
    expect(classifyCaptivityInput("I run a finger along the mortar")).toBe("endure");
    // Real flight still lands, by every phrasing the arm is meant to catch.
    expect(classifyCaptivityInput("I run for the door.")).toBe("escape");
    expect(classifyCaptivityInput("I try to escape.")).toBe("escape");
    expect(classifyCaptivityInput("I bolt for the stair.")).toBe("escape");
    expect(classifyCaptivityInput("I slip away while they eat.")).toBe("escape");
    // The cost that made this worth fixing, unchanged for a REAL escape.
    const after = resolveCaptivityAction(heldSlice({ escapeDc: 15 }), "escape", { escapeSucceeded: false });
    expect(after.next.escapeDc).toBeGreaterThan(15);
    expect(after.next.day).toBe(heldSlice({ escapeDc: 15 }).day + 1);
  });

  test("(r8) captivityActionOf: button label, then the closed field, then the prose floor", () => {
    const searching = "I run my hands along the wall looking for loose stones";

    // 1. an exact button label always wins — a clicked card never consults a model at all.
    for (const b of captivityActionButtons()) {
      expect(captivityActionOf(null, b.label)).toBe(b.id);
      expect(captivityActionOf("escape", b.label), b.label).toBe(b.id);
    }

    // 2. the classifier's closed answer keeps the searching line out of the escape branch.
    expect(captivityActionOf("endure", searching)).toBe("endure");
    expect(captivityActionOf("escape", "I sit and wait")).toBe("escape");

    // 3. null/undefined falls to the prose floor — which no longer misreads the searching line, and
    //    whose terminal default stays `endure` for anything unrecognized.
    expect(captivityActionOf(null, searching)).toBe("endure");
    expect(captivityActionOf(undefined, "I try to escape through the window")).toBe("escape");
    expect(captivityActionOf(null, "I hum a tune to myself")).toBe("endure");
  });

  test("new captivity kinds have complete config and beat pools", () => {
    const kinds: CaptivityKind[] = ["arena", "mine", "cult", "nest", "press-ganged"];
    for (const kind of kinds) {
      const cfg = CAPTIVITY_CONFIG[kind];
      expect(cfg.goal, kind).toBeGreaterThan(0);
      expect(cfg.escapeDc, kind).toBeGreaterThan(0);
      for (const action of ["labor", "endure", "escape"] as const) {
        const r = resolveCaptivityAction(heldSlice({ kind, escapeDc: cfg.escapeDc, goal: cfg.goal }), action);
        expect(r.beat.length, `${kind}:${action}`).toBeGreaterThan(0);
      }
    }
  });
});

// ── Engine arc: capture → held → freed ───────────────────────────────────────────────────────────

const pcStats = { abilities: { str: 12, dex: 12, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 24, armorClass: 10 };
const foeStats = { abilities: { str: 18, dex: 14, con: 14, int: 8, wis: 10, cha: 8 }, maxHp: 40, armorClass: 12 };

/** A world whose ONE authored defeat outcome is a guaranteed captivity — deterministic capture. */
function arcPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.arc",
    name: "Archold",
    summary: "A test world.",
    locations: [{ id: "loc.start", name: "The Yard", description: "A muddy yard.", npcs: ["npc.foe"] }],
    npcs: [
      {
        id: "npc.foe",
        name: "Warden",
        persona: "A hard jailer.",
        age: 40,
        stats: foeStats,
        autonomy: { isPartyMember: false, level: "passive" },
      },
    ],
    constitution: {
      defeatOutcomes: [
        {
          id: "test-capture",
          weight: 1,
          requiresCause: ["combat-defeat"],
          effects: [{ type: "beginCaptivity", pcId: "pc.you", captorId: "npc.foe", kind: "gaol" }],
          narratorBrief: "You are overcome and taken.",
        },
      ],
    },
  });
  const campaign = CampaignSchema.parse({
    id: "c.arc",
    name: "Arc Campaign",
    worldId: "w.arc",
    characters: [{ id: "pc.you", name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: "loc.start", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

function losingState(): GameState {
  return {
    campaignId: "c.arc",
    worldId: "w.arc",
    partyLocationId: "loc.start",
    clock: 0,
    party: ["pc.you"],
    companions: [],
    actors: {
      "pc.you": { id: "pc.you", currentHp: 1, locationId: "loc.start", inventory: ["item.torch"], conditions: [] },
      "npc.foe": { id: "npc.foe", currentHp: 40, locationId: "loc.start", inventory: [], conditions: [] },
    },
    quests: {},
    relationships: {},
    autonomy: {},
    modules: { combat: { active: true, locationId: "loc.start", order: ["pc.you", "npc.foe"], turnIndex: 0, round: 1 } },
    flags: {},
  };
}

const attackFoe: TurnClassifier = {
  classify: async (): Promise<TurnPlan> => ({
    kind: "attack",
    targetId: "npc.foe",
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
  }),
};

async function captured(
  opts: { classifier?: TurnClassifier } = {},
): Promise<{ engine: GameEngine; events: GameEvent[]; playset: PlaySet }> {
  const playset = arcPlayset();
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey("c.arc", "pc.you"), losingState());
  const engine = new GameEngine({ playset, store, gateway: new OfflineGateway(), classifier: opts.classifier ?? attackFoe, rng: mulberry32(5) });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  for (let i = 0; i < 8; i++) {
    await engine.submitPlayerInput("I attack the warden");
    if (held(engine)) break;
  }
  return { engine, events, playset };
}

const capOf = (engine: GameEngine): Partial<CaptivitySlice> | undefined =>
  engine.getState().modules?.captivity as Partial<CaptivitySlice> | undefined;

/** Held? — read from the PUBLIC projected state (getModel is private to the engine). */
const held = (engine: GameEngine): boolean => capOf(engine)?.active === true;

describe("captivity: engine arc", () => {
  test("losing the fight REALLY takes the player — held, relocated, gear stripped, card projected", async () => {
    const { engine, playset } = await captured();
    expect(held(engine)).toBe(true);
    const state = engine.getState();
    expect(state.actors["pc.you"]?.locationId).toBe(CAPTIVITY_LOCATION_ID);
    expect(state.actors["pc.you"]?.inventory).toEqual([]); // torch confiscated
    expect(state.actors["pc.you"]?.conditions).toContain("captive");
    // The read model projects captivity so the bad end is VISIBLE, not just prose.
    const card = captivitySceneOf(state);
    expect(card?.kind).toBe("gaol");
    expect(card?.goal).toBe(CAPTIVITY_CONFIG.gaol.goal);
    expect(card?.actions.map((a) => a.id)).toEqual(["labor", "escape", "endure"]);
  });

  test("labouring to the goal FREES the player — back where taken, gear returned, condition cleared", async () => {
    const { engine } = await captured();
    // gaol goal 6, laborGain 2 ⇒ 3 labours serve the term.
    for (let i = 0; i < 6 && held(engine); i++) {
      await engine.submitPlayerInput("I labour at the work set me");
    }
    expect(held(engine)).toBe(false);
    const state = engine.getState();
    expect(state.actors["pc.you"]?.locationId).toBe("loc.start"); // released to the capture site
    expect(state.actors["pc.you"]?.inventory).toEqual(["item.torch"]); // gear returned
    expect(state.actors["pc.you"]?.conditions).not.toContain("captive");
  });

  test("while held, the paper-doll clothing affordance is inert — no silent free re-dress", async () => {
    const { engine } = await captured();
    expect(held(engine)).toBe(true);
    const rowOf = () => (engine.getState().modules?.wardrobe as Record<string, unknown> | undefined)?.["pc.you"];
    expect(rowOf()).toEqual(coverageRow("removed")); // held bare — the capture's forced strip

    // The slot buttons route around resolvePlayer's captivity gate, so submitClothingAction must
    // carry its own: the click is swallowed whole (no patch, no beat) while the hold owns the body.
    await engine.submitAction({ kind: "clothing", slotId: "upper", state: "worn" });
    expect(rowOf()).toEqual(coverageRow("removed"));
    expect(held(engine)).toBe(true);
  });

  test("while held, a world action is ABSORBED by the loop — the player can't just walk out", async () => {
    const { engine } = await captured();
    const before = capOf(engine)?.progress ?? 0;
    // A "move" grounded action while captive: the captivity gate owns the turn (endure), no relocation.
    await engine.submitAction({ kind: "move", exitId: "loc.elsewhere" });
    expect(engine.getState().actors["pc.you"]?.locationId).toBe(CAPTIVITY_LOCATION_ID);
    expect(held(engine)).toBe(true);
    expect(capOf(engine)?.progress ?? 0).toBeGreaterThanOrEqual(before); // a captive turn was served
  });

  test("a captivity action grounds through submitAction (labor button)", async () => {
    const { engine } = await captured();
    const before = capOf(engine)?.progress ?? 0;
    await engine.submitAction({ kind: "captivityAction", actionId: "labor" });
    expect((capOf(engine)?.progress ?? 0)).toBe(before + CAPTIVITY_CONFIG.gaol.laborGain);
  });

});

describe("captivityAction — the closed answer that replaced the verb list (r8 regex audit)", () => {
  /**
   * A classifier that answers the CAPTIVE turn with a closed action while still declaring the
   * attack the capture loop needs. Nothing else about the plan matters: the captivity branch reads
   * exactly one field off it and resolves nothing.
   */
  function namingClassifier(named: () => TurnPlan["captivityAction"]): TurnClassifier {
    return {
      classify: async (): Promise<TurnPlan> => ({
        kind: "attack",
        targetId: "npc.foe",
        destinationLocationId: null,
        check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
        confidence: 1,
        ...(named() ? { captivityAction: named() } : {}),
      }),
    };
  }

  const SEARCHING = "I run my hands along the wall looking for loose stones";

  test("with no named action, searching a wall no longer rolls a break-out (r8, fixed end-to-end)", async () => {
    // The verb list's `escape` arm carried the bare token "run", and the cost was not cosmetic: an
    // escape turn rolls a real d20 and, on failure, permanently raises `escapeDc` and burns the day.
    // Driven through the real engine with NO classifier answer, which is the outage path.
    const { engine, events } = await captured();
    const before = capOf(engine)?.escapeDc ?? 0;
    events.length = 0;

    await engine.submitPlayerInput(SEARCHING);

    expect(events.some((e) => e.kind === "diceRolled" && (e.purpose ?? "").includes("Escape check"))).toBe(false);
    expect(capOf(engine)?.escapeDc ?? 0).toBe(before);
  });

  test("captivityAction 'endure' keeps the same line out of the escape branch", async () => {
    let action: TurnPlan["captivityAction"] = null;
    const { engine, events } = await captured({ classifier: namingClassifier(() => action) });
    const before = capOf(engine)?.escapeDc ?? 0;
    action = "endure";
    events.length = 0;

    await engine.submitPlayerInput(SEARCHING);

    expect(events.some((e) => e.kind === "diceRolled" && (e.purpose ?? "").includes("Escape check"))).toBe(false);
    expect(capOf(engine)?.escapeDc ?? 0).toBe(before);
    expect(held(engine)).toBe(true); // the day was served, not gambled
  });

  test("a clicked button label still resolves without any model answer", async () => {
    // The card submits its LABEL through the one input path; the exact match runs in front of the
    // classifier, so button play is unchanged and costs nothing.
    let action: TurnPlan["captivityAction"] = null;
    const { engine } = await captured({ classifier: namingClassifier(() => action) });
    action = "endure"; // deliberately contradicted by the label below
    const before = capOf(engine)?.progress ?? 0;

    await engine.submitPlayerInput("Labor");

    expect(capOf(engine)?.progress ?? 0).toBeGreaterThan(before);
  });
});
