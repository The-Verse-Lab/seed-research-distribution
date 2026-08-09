/**
 * Party flow tests — Phase 2 Stage C: invite / leave / leadership wired end-to-end.
 *
 * Exercises the heuristic classifier's partyAction routing, the CODE-only invite decision
 * (`decideInvite` off the agenda stance + one seeded roll), Stage-B promotion on join, the
 * contested leave gate (first ask vs `resistanceDC`, then contested escape vs the leader-derived
 * `pressureDc`), and leadership appointment feeding the autonomy Director's proposal machinery.
 * Offline gateway + scripted/seeded RNGs throughout — every assertion is deterministic.
 *
 * THE PILLAR under test: party membership is mechanically neutral and morally unfiltered — no
 * relationship bonus on join, exploitative NPCs may join (never hard-blocked), and an NPC
 * leader who refuses to let the player go stays fully playable (refusal → denied record →
 * contested escape with a real price on failure). No moral filtering anywhere.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { stanceTemplateFor } from "../src/engine/resolvers/party.ts";
import type { TickContext } from "../src/engine/tick.ts";
import type { NpcTemplate, PlaySet } from "../src/content/schema.ts";
import type { GameEvent } from "../src/events/types.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { mulberry32, type Rng } from "../src/rules/dice.ts";
import {
  ESCAPE_GRUDGE,
  HOSTILE_RELATIONSHIP_MAX,
  OPPORTUNISTIC_JOIN_CHANCE,
  WARM_RELATIONSHIP_MIN,
  decideInvite,
  escapeAbility,
  escapeAbilityFrom,
  type PartySlice,
} from "../src/rules/party.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import type { AutonomyRuntime, GameState } from "../src/state/types.ts";
import { GameEngine } from "../src/engine/engine.ts";
import { stance } from "../src/rules/agenda.ts";
import { fromGameState } from "../src/world/model.ts";
import type { Entity } from "../src/world/entity.ts";
import { byKind, LeaderPlanGateway, loadThistledown, type TraceBeat } from "./support/harness.ts";

const SEED = 42;

// --- Pure decision units ----------------------------------------------------

describe("decideInvite — the coded answer matrix (no LLM, no moral filter)", () => {
  test("devoted and helpful join genuinely regardless of the roll", () => {
    for (const disposition of ["devoted", "helpful"] as const) {
      for (const roll of [0, 0.999]) {
        expect(decideInvite({ disposition, relationship: 0 }, roll)).toEqual({
          accept: true,
          motive: "genuine",
        });
      }
    }
  });

  test("a warm bond joins genuinely even on a wary temperament", () => {
    expect(decideInvite({ disposition: "wary", relationship: WARM_RELATIONSHIP_MIN }, 0.9)).toEqual({
      accept: true,
      motive: "genuine",
    });
  });

  test("wary and transactional join guardedly — their own reasons, their own price", () => {
    for (const disposition of ["wary", "transactional"] as const) {
      expect(decideInvite({ disposition, relationship: 0 }, 0.9)).toEqual({
        accept: true,
        motive: "guarded",
      });
    }
  });

  test("neutral joins — pretty much any NPC can be asked", () => {
    expect(decideInvite({ disposition: "neutral", relationship: 0 }, 0.9)).toEqual({
      accept: true,
      motive: "genuine",
    });
  });

  test("exploitative: one seeded roll decides — refusal OR joining to exploit, never a hard block", () => {
    const s = { disposition: "exploitative" as const, relationship: 0 };
    expect(decideInvite(s, OPPORTUNISTIC_JOIN_CHANCE)).toEqual({ accept: false, motive: "opportunist" });
    expect(decideInvite(s, OPPORTUNISTIC_JOIN_CHANCE - 0.01)).toEqual({ accept: true, motive: "opportunist" });
  });

  test("open hostility routes through the same opportunist gate whatever the disposition", () => {
    const hostile = { disposition: "helpful" as const, relationship: HOSTILE_RELATIONSHIP_MAX };
    expect(decideInvite(hostile, 0.9)).toEqual({ accept: false, motive: "opportunist" });
    expect(decideInvite(hostile, 0.1)).toEqual({ accept: true, motive: "opportunist" });
  });
});

describe("escapeAbility — the contested-escape ability from phrasing", () => {
  test("fighting free is str, talking out is cha, slipping away is the dex default", () => {
    expect(escapeAbility("I fight my way out of this camp")).toBe("str");
    expect(escapeAbility("I try to talk my way out")).toBe("cha");
    expect(escapeAbility("I leave the party")).toBe("dex");
  });

  test("(r8) the verb that GOVERNS the escape wins — the reproduced misfire, fixed", () => {
    // The `str` arm was tested first and carried a bare "force", so a line whose only forcing is of
    // a SMILE rolled Strength. On a Charisma character that is a contest on their worst stat, and
    // the failure branch applies the leader's consequence — not cosmetic. The verbal arm is now
    // tested first, and `force` no longer counts when its object is an expression or a manner.
    expect(escapeAbility("I force a smile and sweet-talk my way out")).toBe("cha");
    // A genuinely physical escape is untouched, including one that still says "force".
    expect(escapeAbility("I force the door and shove past him")).toBe("str");
    expect(escapeAbility("I fight free of his grip")).toBe("str");
    expect(escapeAbility("I wrestle out of the hold")).toBe("str");
    // And the terminal default is still dex.
    expect(escapeAbility("I slip away while he looks elsewhere")).toBe("dex");
  });

  test("(r8 review) a DISCLAIMED or FOREIGN verb does not govern the escape — the inverted misfire", () => {
    // The CHA-first reorder fixed one direction and inverted the other: one verbal token anywhere
    // won, including a token the line explicitly refuses, and including one the CAPTOR is doing.
    // All three scored `cha` against the shipped ordering (reproduced) — a Charisma contest for a
    // plainly physical break-out, with the leader's consequence on the failure branch.
    expect(escapeAbility("I shove him aside, no more talk")).toBe("str");
    expect(escapeAbility("I overpower him before he can charm me")).toBe("str");
    expect(escapeAbility("I break his grip and shove past, refusing to beg or plead")).toBe("str");
    expect(escapeAbility("I wrestle free without a word of persuasion")).toBe("str");

    // The verbal escape the reorder was written for is untouched, and so is every other control:
    // a disclaimer only ever removes its OWN clause.
    expect(escapeAbility("I force a smile and sweet-talk my way out")).toBe("cha");
    expect(escapeAbility("I refuse to wait, so I sweet-talk the guard")).toBe("cha");
    expect(escapeAbility("I have no choice but to talk my way out")).toBe("cha");
    expect(escapeAbility("I bluff my way past the guard")).toBe("cha");
    expect(escapeAbility("I force the door and shove past him")).toBe("str");
    expect(escapeAbility("I slip away while his back is turned")).toBe("dex");
  });
});

describe("escapeAbilityFrom — the classifier's closed answer in front of the verb list (r8)", () => {
  test("a named ability wins outright, including over the 'force a smile' misfire", () => {
    expect(escapeAbilityFrom("cha", "I force a smile and sweet-talk my way out")).toBe("cha");
    expect(escapeAbilityFrom("str", "I slip quietly out of the camp")).toBe("str");
    expect(escapeAbilityFrom("dex", "I fight my way out")).toBe("dex");
  });

  test("null/undefined falls to the floor, whose terminal default is dex", () => {
    // A classifier outage runs the prose floor. That floor is now hardened rather than frozen: the
    // reproduced misfire is fixed there too, so an outage no longer costs the player the roll.
    expect(escapeAbilityFrom(null, "I fight my way out of this camp")).toBe("str");
    expect(escapeAbilityFrom(undefined, "I try to talk my way out")).toBe("cha");
    expect(escapeAbilityFrom(null, "I leave the party")).toBe("dex");
    expect(escapeAbilityFrom(undefined, "I force a smile and sweet-talk my way out")).toBe("cha");
  });
});

// --- Engine-level flows ------------------------------------------------------

interface Built {
  engine: GameEngine;
  events: GameEvent[];
  /** Public NPC beats across turns — the observable for DM-owned public speech. */
  beats: TraceBeat[];
  playset: PlaySet;
}

/**
 * A started thistledown engine (offline, deterministic). `mutatePlayset` tweaks content before
 * construction; `mutateState` white-box-patches a valid snapshot (autonomy/party bookkeeping)
 * before start — the autonomy-test pattern.
 */
async function build(
  opts: {
    mutateState?: (s: GameState) => void;
    mutatePlayset?: (p: PlaySet) => void;
    rng?: Rng;
    /** Script the NPC's own turn intent — the proposal path requires a closed `act` that
     *  GROUNDS to a real command; a leader's act-less advice stays plain dialogue. */
    gateway?: OfflineGateway;
  } = {},
): Promise<Built> {
  const playset = await loadThistledown();
  opts.mutatePlayset?.(playset);

  const store = new InMemoryGameStateStore();
  if (opts.mutateState) {
    const seedEngine = new GameEngine({ classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(SEED),
    });
    await seedEngine.start();
    const snapshot = seedEngine.getState();
    opts.mutateState(snapshot);
    await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), snapshot);
  }

  const beats: TraceBeat[] = [];
  const engine = new GameEngine({ classifier: heuristicClassifier,
    playset,
    store,
    gateway: opts.gateway ?? new OfflineGateway(),
    rng: opts.rng ?? mulberry32(SEED),
    onTurnTrace: (t) => {
      if (t.npcBeats) beats.push(...t.npcBeats);
    },
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  events.length = 0;
  return { engine, events, beats, playset };
}

/** A scripted RNG: pushed values are consumed in order; anything unscripted draws the filler. */
function scriptedRng(filler = 0.31): { rng: Rng; script: number[] } {
  const script: number[] = [];
  return { rng: () => (script.length > 0 ? (script.shift() as number) : filler), script };
}

function partySliceOf(engine: GameEngine): PartySlice {
  return (engine.getState().modules?.party as PartySlice | undefined) ?? { leaderId: null, pendingLeave: {} };
}

function enrichedOf(engine: GameEngine): Record<string, NpcTemplate> {
  return (
    (engine.getState().modules?.enrichment as { npcs?: Record<string, NpcTemplate> } | undefined)?.npcs ?? {}
  );
}

/** Mark thistledown's innkeeper as authored exploitative opposition. */
function exploitativeBett(p: PlaySet): void {
  const bett = p.world.npcs.find((n) => n.id === "npc.bett");
  if (!bett) throw new Error("no npc.bett in thistledown");
  bett.exploitative = true;
  bett.alignment = "ne";
}

describe("party invite — the decision is code, the phrasing is the model's", () => {
  test("a neutral NPC joins: membership + Stage-B promotion, and NO relationship change (the pillar)", async () => {
    const { engine, events, beats } = await build();
    const relationshipsBefore = JSON.stringify(engine.getState().relationships);

    await engine.submitPlayerInput("Bett, come with us");

    // Membership flipped through the reducer; the slice stays at its PC-leads default.
    expect(byKind(events, "partyMembershipChanged")).toEqual([
      expect.objectContaining({ entityId: "npc.bett", member: true }),
    ]);
    expect(engine.getState().companions).toContain("npc.bett");
    expect(partySliceOf(engine)).toEqual({ leaderId: null, pendingLeave: {} });

    // Stage-B promotion rode the join: enriched template recorded + tier now significant.
    expect(byKind(events, "npcEnriched")).toEqual([expect.objectContaining({ npcId: "npc.bett" })]);
    expect(byKind(events, "tierChanged")).toEqual([
      expect.objectContaining({ entityId: "npc.bett", tier: "significant" }),
    ]);
    expect(enrichedOf(engine)["npc.bett"]).toBeDefined();

    // The acceptance line comes from the normal dialogue path (live companion agent) — a public
    // NPC line is now a DM-narrated beat, not a raw dialogue bubble.
    expect(beats.some((b) => b.actorId === "npc.bett")).toBe(true);

    // THE PILLAR: joining applies zero relationship/disposition bonus.
    expect(JSON.stringify(engine.getState().relationships)).toBe(relationshipsBefore);
  });

  test("FOLLOWING a present non-party NPC recruits them too — 'keep up with Bett' is an invite (Oda-whiplash fix)", async () => {
    // The mirror of "come with us": the player falling in with a guiding NPC forms one party through
    // the SAME code-only invite decision. Before this, "keep up with Oda" classified as idle dialogue,
    // so the NPC never joined and the continuity judge snapped the escort prose back to "I'm not your
    // guide" — a visible reversal. Now the recruit is honest: the NPC becomes a real companion.
    const { engine, events } = await build();

    await engine.submitPlayerInput("keep up with Bett");

    expect(byKind(events, "partyMembershipChanged")).toEqual([
      expect.objectContaining({ entityId: "npc.bett", member: true }),
    ]);
    expect(engine.getState().companions).toContain("npc.bett");
  });

  test("following an EXISTING companion is NOT a re-invite — 'keep up with Maelle' churns no membership", async () => {
    const { engine, events } = await build();
    // Maelle already travels with the player; falling in beside her is flavor, not a fresh invite.
    await engine.submitPlayerInput("keep up with Maelle");
    expect(byKind(events, "partyMembershipChanged")).toHaveLength(0);
  });

  test("covert trailing is NOT a recruit — 'sneak after Bett' routes to stealth, never an invite", async () => {
    const { engine, events } = await build();
    await engine.submitPlayerInput("sneak after Bett");
    expect(byKind(events, "partyMembershipChanged")).toHaveLength(0);
    expect(engine.getState().companions).not.toContain("npc.bett");
  });

  test("a exploitative NPC may refuse — and nothing about them is softened by the ask", async () => {
    const { engine, events } = await build({ mutatePlayset: exploitativeBett, rng: () => 0.99 });
    const relationshipsBefore = JSON.stringify(engine.getState().relationships);

    await engine.submitPlayerInput("Bett, come with us");

    expect(byKind(events, "partyMembershipChanged")).toHaveLength(0);
    expect(byKind(events, "npcEnriched")).toHaveLength(0);
    expect(engine.getState().companions).not.toContain("npc.bett");
    const narration = byKind(events, "narration");
    expect(narration.length).toBeGreaterThanOrEqual(1);
    expect(narration[0]!.text).toContain("refuses to join");
    expect(JSON.stringify(engine.getState().relationships)).toBe(relationshipsBefore);
  });

  test("a exploitative NPC may JOIN to exploit (seeded roll) — nature preserved verbatim", async () => {
    const { engine, events } = await build({ mutatePlayset: exploitativeBett, rng: () => 0.2 });
    const relationshipsBefore = JSON.stringify(engine.getState().relationships);

    await engine.submitPlayerInput("Bett, come with us");

    expect(byKind(events, "partyMembershipChanged")).toEqual([
      expect.objectContaining({ entityId: "npc.bett", member: true }),
    ]);
    expect(engine.getState().companions).toContain("npc.bett");

    // Enrichment kept the declared nature: exploitative stays true, the evil alignment survives.
    const template = enrichedOf(engine)["npc.bett"];
    expect(template?.exploitative).toBe(true);
    expect(template?.alignment).toBe("ne");

    // No softening, no bonus: relationships are byte-identical across the opportunist join.
    expect(JSON.stringify(engine.getState().relationships)).toBe(relationshipsBefore);
  });
});

describe("party leave — free under the PC, contested under an NPC leader", () => {
  test("with no explicit leader the party releases instantly — no dice, no gate", async () => {
    const { engine, events } = await build();

    await engine.submitPlayerInput("I leave the party");

    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "partyMembershipChanged")).toEqual([
      expect.objectContaining({ entityId: "npc.maelle", member: false }),
      expect.objectContaining({ entityId: "npc.dorran", member: false }),
    ]);
    expect(engine.getState().companions).toEqual([]);
    expect(partySliceOf(engine)).toEqual({ leaderId: null, pendingLeave: {} });
  });

  test("an NPC leader may grant the leave: one social check, membership cleared, no grudge", async () => {
    const { rng, script } = scriptedRng();
    const { engine, events } = await build({ rng });
    await engine.submitPlayerInput("Make Maelle the leader");
    expect(partySliceOf(engine).leaderId).toBe("npc.maelle");
    const relationshipsBefore = JSON.stringify(engine.getState().relationships);
    events.length = 0;

    script.push(0.999); // natural 20 on the release ask
    await engine.submitPlayerInput("I leave the party");

    const rolls = byKind(events, "diceRolled");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]!.purpose).toContain("release persuade resistance");
    expect(rolls[0]!.success).toBe(true);
    expect(engine.getState().companions).toEqual([]);
    expect(partySliceOf(engine)).toEqual({ leaderId: null, pendingLeave: {} });
    // A granted leave costs nothing — no grudge, no bonus.
    expect(JSON.stringify(engine.getState().relationships)).toBe(relationshipsBefore);
  });

  test("a refused leave records the denial and keeps the player in the party", async () => {
    const { rng, script } = scriptedRng();
    const { engine, events } = await build({ rng });
    await engine.submitPlayerInput("Make Maelle the leader");
    events.length = 0;

    script.push(0); // natural 1 on the release ask
    await engine.submitPlayerInput("I leave the party");

    const rolls = byKind(events, "diceRolled");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]!.success).toBe(false);
    expect(byKind(events, "partyLeaveDenied")).toEqual([expect.objectContaining({ entityId: "pc.you" })]);
    expect(partySliceOf(engine).pendingLeave["pc.you"]).toBeDefined();
    // Still in: nobody released.
    expect(byKind(events, "partyMembershipChanged")).toHaveLength(0);
    expect(engine.getState().companions).toEqual(["npc.maelle", "npc.dorran"]);
  });

  test("contested escape SUCCESS: freed after a denial, and the leader takes the grudge", async () => {
    const { rng, script } = scriptedRng();
    const { engine, events } = await build({ rng });
    await engine.submitPlayerInput("Make Maelle the leader");
    script.push(0); // ask refused → denial recorded
    await engine.submitPlayerInput("I leave the party");
    events.length = 0;

    script.push(0.999); // natural 20 on the escape
    await engine.submitPlayerInput("I leave the party");

    const rolls = byKind(events, "diceRolled");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]!.purpose).toContain("Escape");
    expect(rolls[0]!.success).toBe(true);
    expect(engine.getState().companions).toEqual([]);
    expect(partySliceOf(engine)).toEqual({ leaderId: null, pendingLeave: {} });
    // Breaking free is the one party move that DOES move a relationship — the leader's grudge.
    expect(byKind(events, "relationshipChanged")).toEqual([
      expect.objectContaining({ actorId: "npc.maelle", targetId: "pc.you", by: ESCAPE_GRUDGE }),
    ]);
  });

  test("contested escape FAILURE: still held, and the leader's consequence lands", async () => {
    const { rng, script } = scriptedRng();
    const { engine, events } = await build({ rng });
    await engine.submitPlayerInput("Make Maelle the leader");
    script.push(0); // ask refused → denial recorded
    await engine.submitPlayerInput("I leave the party");
    events.length = 0;

    script.push(0); // natural 1 on the escape
    await engine.submitPlayerInput("I leave the party");

    const rolls = byKind(events, "diceRolled");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]!.purpose).toContain("Escape");
    expect(rolls[0]!.success).toBe(false);
    // Still in the party, the denial still standing (the next attempt is another escape)...
    expect(engine.getState().companions).toEqual(["npc.maelle", "npc.dorran"]);
    expect(partySliceOf(engine).pendingLeave["pc.you"]).toBeDefined();
    // ...and the leader's agenda-chosen consequence applied (neutral Maelle: a relationship cost).
    expect(byKind(events, "relationshipChanged")).toEqual([
      expect.objectContaining({ actorId: "npc.maelle", targetId: "pc.you", by: -3 }),
    ]);
    const narration = byKind(events, "narration");
    expect(narration[0]!.text).toContain("catches you");
  });
});

describe("party leadership — appointment feeds the Director's proposal machinery", () => {
  test("appointing a member sets the slice, and their heartbeat now proposes", async () => {
    const { engine, events } = await build({
      gateway: new LeaderPlanGateway({
        act: { do: "move", target: "loc.green" },
        visibleSpeech: "We make for the green while the light holds.",
      }),
    });

    // Before the appointment: Dorran is a reactive non-leader — a quiet heartbeat proposes nothing.
    await engine.tickHeartbeat("npc.dorran");
    expect(byKind(events, "npcProposal")).toHaveLength(0);

    await engine.submitPlayerInput("Make Dorran the leader");
    expect(byKind(events, "partyLeaderChanged")).toEqual([
      expect.objectContaining({ party: expect.objectContaining({ leaderId: "npc.dorran" }) }),
    ]);
    expect(partySliceOf(engine).leaderId).toBe("npc.dorran");

    // After: the appointed leader self-initiates a party-level proposal on a quiet heartbeat —
    // when its intent is a real plan. (A leader's command-less advice is plain dialogue now; a card
    // with `commands: []` was the 2026-07-24 playtest's proposal churn.)
    events.length = 0;
    await engine.tickHeartbeat("npc.dorran");
    const proposals = byKind(events, "npcProposal");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.actorId).toBe("npc.dorran");
  });

  test("tacit consent: the appointed leader's expired MOVEMENT plan nudges, never moves (2026-07-25)", async () => {
    const { engine, events } = await build({
      mutateState: (s) => {
        s.modules = s.modules ?? {};
        s.modules.party = { leaderId: "npc.dorran", pendingLeave: {} } satisfies PartySlice;
        const base: AutonomyRuntime = s.autonomy["npc.dorran"] ?? {
          talking: false,
          replyDepth: 0,
          lastActedAt: 0,
        };
        const next = {
          ...base,
          lastActedAt: Date.now(), // fresh dedup stamp: no NEW proposal competes this beat
          pendingProposal: {
            commands: [{ type: "moveEntity" as const, entityId: "npc.dorran", to: "loc.green" }],
            expiresAt: Date.now() - 1000,
          },
        };
        s.autonomy["npc.dorran"] = next;
        const mod = (s.modules.autonomy as Record<string, AutonomyRuntime> | undefined) ?? {};
        mod["npc.dorran"] = next;
        s.modules.autonomy = mod;
      },
    });

    await engine.tickHeartbeat("npc.dorran");

    // Movement ban on silence: the appointed leader's machinery is live (the plan IS consumed),
    // but a stale moveEntity never executes without the player's word.
    const moves = byKind(events, "entityMoved").filter((d) => d.entityId === "npc.dorran");
    expect(moves).toHaveLength(0);
    expect(engine.getState().autonomy["npc.dorran"]?.pendingProposal).toBeUndefined();
  });

  test("appointing takes the reducer's member gate: a stranger cannot be handed the lead", async () => {
    const { engine } = await build();

    await engine.submitPlayerInput("Make Bett the leader");

    // Bett is present but NOT a member — the reducer rejects, the slice stays at its default.
    expect(partySliceOf(engine).leaderId).toBeNull();
  });

  test("the player reclaims the lead — CONTESTED: the sitting NPC leader may yield on one social check", async () => {
    const { rng, script } = scriptedRng();
    const { engine, events } = await build({ rng });
    await engine.submitPlayerInput("Make Maelle the leader");
    expect(partySliceOf(engine).leaderId).toBe("npc.maelle");
    events.length = 0;

    script.push(0.999); // natural 20: the leader yields
    await engine.submitPlayerInput("make me the leader again");

    const rolls = byKind(events, "diceRolled");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]!.purpose).toContain("step-down");
    expect(byKind(events, "partyLeaderChanged")).toEqual([
      expect.objectContaining({ party: expect.objectContaining({ leaderId: null }) }),
    ]);
    expect(partySliceOf(engine).leaderId).toBeNull();
  });

  test("the leave-gate bypass is CLOSED: a denied leave escalates the usurp to the same contested escape", async () => {
    const { rng, script } = scriptedRng();
    const { engine, events } = await build({ rng });
    await engine.submitPlayerInput("Make Maelle the leader");

    // Denied leave first: the leader has asserted her hold.
    script.push(0);
    await engine.submitPlayerInput("I leave the party");
    expect(partySliceOf(engine).pendingLeave["pc.you"]).toBeDefined();
    events.length = 0;

    // "make me the leader" is now the SAME contested escape — no free deposition.
    script.push(0);
    await engine.submitPlayerInput("make me the leader");
    const heldRolls = byKind(events, "diceRolled");
    expect(heldRolls).toHaveLength(1);
    expect(heldRolls[0]!.purpose).toContain("Escape");
    expect(heldRolls[0]!.success).toBe(false);
    expect(partySliceOf(engine).leaderId).toBe("npc.maelle"); // she keeps the lead
    // ...and the failed grab has a price, exactly like a failed escape.
    expect(byKind(events, "relationshipChanged")).toEqual([
      expect.objectContaining({ actorId: "npc.maelle", targetId: "pc.you", by: -3 }),
    ]);
    events.length = 0;

    // Breaking her hold takes the real contested roll — and costs her regard.
    script.push(0.999);
    await engine.submitPlayerInput("make me the leader");
    expect(partySliceOf(engine).leaderId).toBeNull();
    expect(partySliceOf(engine).pendingLeave).toEqual({}); // the broken hold's record is erased
    expect(
      byKind(events, "relationshipChanged").some(
        (d) => d.actorId === "npc.maelle" && d.targetId === "pc.you" && d.by === ESCAPE_GRUDGE,
      ),
    ).toBe(true);
    // Members are NOT released by a usurp — only the lead changed hands.
    expect(engine.getState().companions).toEqual(["npc.maelle", "npc.dorran"]);
    events.length = 0;

    // With the hold broken the leave is free — but the player PAID the contest to get here.
    await engine.submitPlayerInput("I leave the party");
    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(engine.getState().companions).toEqual([]);
  });

  test("a first-turn usurp is gated too, and a denial there escalates the LEAVE gate (one shared hold)", async () => {
    const { rng, script } = scriptedRng();
    const { engine, events } = await build({ rng });
    await engine.submitPlayerInput("Make Maelle the leader");
    events.length = 0;

    script.push(0); // natural 1: the leader refuses to step down
    await engine.submitPlayerInput("make me the leader");
    const askRolls = byKind(events, "diceRolled");
    expect(askRolls).toHaveLength(1);
    expect(askRolls[0]!.purpose).toContain("step-down persuade resistance");
    expect(partySliceOf(engine).leaderId).toBe("npc.maelle");
    expect(byKind(events, "partyLeaveDenied")).toEqual([expect.objectContaining({ entityId: "pc.you" })]);
    events.length = 0;

    // The refusal recorded the hold: the next LEAVE is already the contested escape.
    script.push(0);
    await engine.submitPlayerInput("I leave the party");
    const escRolls = byKind(events, "diceRolled");
    expect(escRolls).toHaveLength(1);
    expect(escRolls[0]!.purpose).toContain("Escape");
    expect(engine.getState().companions).toEqual(["npc.maelle", "npc.dorran"]);
  });

  test("a DOWNED leader (0 HP) contests nothing — the hold breaks with the body", async () => {
    const { engine, events } = await build({
      mutateState: (s) => {
        s.modules = s.modules ?? {};
        s.modules.party = { leaderId: "npc.maelle", pendingLeave: {} } satisfies PartySlice;
        s.actors["npc.maelle"] = { ...s.actors["npc.maelle"]!, currentHp: 0, conditions: ["unconscious"] };
      },
    });
    expect(partySliceOf(engine).leaderId).toBe("npc.maelle");

    await engine.submitPlayerInput("I leave the party");

    expect(byKind(events, "diceRolled")).toHaveLength(0); // no contest from an unconscious body
    expect(engine.getState().companions).toEqual([]);
    expect(partySliceOf(engine)).toEqual({ leaderId: null, pendingLeave: {} });
    const narration = byKind(events, "narration");
    expect(narration[0]!.text).toContain("no state to hold");
  });
});

describe("party dismissal — 'part ways with X' releases ONE member, never the band", () => {
  test("under the PC's own lead a named dismissal is free and touches only that member", async () => {
    const { engine, events } = await build();

    await engine.submitPlayerInput("I part ways with Dorran");

    expect(byKind(events, "diceRolled")).toHaveLength(0);
    expect(byKind(events, "partyMembershipChanged")).toEqual([
      expect.objectContaining({ entityId: "npc.dorran", member: false }),
    ]);
    expect(engine.getState().companions).toEqual(["npc.maelle"]); // Maelle untouched
    const change = byKind(events, "stateChanged").find((e) => e.summary.includes("part ways"));
    expect(change?.summary).not.toContain("disbands"); // a dismissal is not a disband
  });

  test("under an NPC leader even a single dismissal runs the contested gate (no picking the party apart)", async () => {
    const { rng, script } = scriptedRng();
    const { engine, events } = await build({ rng });
    await engine.submitPlayerInput("Make Maelle the leader");
    events.length = 0;

    script.push(0.999); // the leader grants it
    await engine.submitPlayerInput("I part ways with Dorran");

    const rolls = byKind(events, "diceRolled");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]!.purpose).toContain("release");
    expect(engine.getState().companions).toEqual(["npc.maelle"]);
    expect(partySliceOf(engine).leaderId).toBe("npc.maelle"); // her hold on the REST persists
  });

  test("dismissing the LEADER by name is contested and, granted, ends their hold", async () => {
    const { rng, script } = scriptedRng();
    const { engine, events } = await build({ rng });
    await engine.submitPlayerInput("Make Maelle the leader");
    events.length = 0;

    script.push(0.999);
    await engine.submitPlayerInput("I part ways with Maelle");

    expect(byKind(events, "diceRolled")).toHaveLength(1);
    expect(engine.getState().companions).toEqual(["npc.dorran"]); // Dorran stays
    expect(partySliceOf(engine).leaderId).toBeNull(); // the departing leader's slice reset
  });
});

describe("party persistence — agents track membership across reload and restart", () => {
  test("a released authored companion is NOT re-armed as a live agent by a fresh engine.start()", async () => {
    const playset = await loadThistledown();
    const store = new InMemoryGameStateStore();
    const engineA = new GameEngine({ classifier: heuristicClassifier,
      playset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(SEED),
    });
    await engineA.start();
    await engineA.submitPlayerInput("I leave the party");
    expect(engineA.getState().companions).toEqual([]);
    engineA.stop();

    // A fresh process over the same save: the constructor arms the authored companions, start()
    // must drop them again — released members must not wake up with heartbeats and proposals.
    const engineB = new GameEngine({ classifier: heuristicClassifier,
      playset,
      store,
      gateway: new OfflineGateway(),
      rng: mulberry32(SEED + 1),
    });
    const events: GameEvent[] = [];
    engineB.subscribe((e) => events.push(e));
    await engineB.start();
    expect(engineB.getState().companions).toEqual([]);
    const agents = (engineB as unknown as { npcs: Map<string, unknown> }).npcs;
    expect([...agents.keys()]).toEqual([]); // no agents for non-members

    // And a heartbeat for the released NPC is inert: no dialogue, no proposal.
    events.length = 0;
    await engineB.tickHeartbeat("npc.maelle");
    expect(byKind(events, "npcProposal")).toHaveLength(0);
    expect(byKind(events, "dialogue").filter((d) => d.actorId === "npc.maelle")).toHaveLength(0);
    engineB.stop();
  });

  test("restart() restores the AUTHORED templates — no enriched carry-over into a fresh campaign", async () => {
    const { engine, playset } = await build();
    const authoredBett = structuredClone(playset.world.npcs.find((n) => n.id === "npc.bett")!);
    expect(authoredBett.stats).toBeUndefined(); // authored Bett is statless

    await engine.submitPlayerInput("Bett, come with us");
    expect(engine.getState().companions).toContain("npc.bett");
    // The enrichment mirror replaced her authored entry with a full statted template...
    expect(playset.world.npcs.find((n) => n.id === "npc.bett")?.stats).toBeDefined();

    await engine.restart();

    // ...and restart un-mirrored it: the fresh campaign reads authored content only.
    expect(playset.world.npcs.find((n) => n.id === "npc.bett")).toEqual(authoredBett);
    expect(enrichedOf(engine)).toEqual({});
    expect(engine.getState().companions).not.toContain("npc.bett");
    engine.stop();
  });
});

describe("stance keying — a spawned instance reads and writes relationships under its ENTITY id", () => {
  test("stanceTemplateFor rekeys a shared authored template to the entity, so hostility is SEEN", async () => {
    const { engine, playset } = await build();
    const authoredBett = playset.world.npcs.find((n) => n.id === "npc.bett")!;
    const twin: Entity = {
      id: "npc.bett#0",
      kind: "npc",
      tier: "tracked",
      name: "Bett's Twin",
      locationId: "loc.hart",
      templateId: "npc.bett",
      stats: { currentHp: 8, maxHp: 8, conditions: [], inventory: [] },
      partyMember: false,
      flags: {},
    };

    // The stance-template lookup lives in the party resolver (the `GameEngine` split). It reads the
    // world and the engine's companion roster off a tick context, so a stub of those two suffices.
    const ctx = {
      services: {
        world: playset.world,
        companions: {
          templateFor: (e: Entity) => playset.world.npcs.find((n) => n.id === (e.templateId ?? e.id)),
        },
      },
    } as unknown as TickContext;
    const template = stanceTemplateFor(ctx, twin);
    expect(template.id).toBe("npc.bett#0"); // keyed to the ENTITY, not the shared template
    expect(template.persona).toBe(authoredBett.persona); // content still the authored character

    // The rekeyed template reads the relationship row grudges/consequences are WRITTEN under.
    const model = fromGameState(engine.getState(), playset.world, playset.campaign);
    model.relationships.set("npc.bett#0", new Map([["pc.you", -80]]));
    const hostile = stance(template, "pc.you", model, playset.world);
    expect(hostile.relationship).toBe(-80);
    expect(decideInvite(hostile, 0.9).accept).toBe(false); // an enemy is SEEN, not read as neutral

    // The un-rekeyed authored template reads its own seeded Friendship, not the twin's grudge.
    const blind = stance(authoredBett, "pc.you", model, playset.world);
    expect(blind.relationship).toBe(authoredBett.relationships["pc.you"] ?? 0);
    expect(blind.relationship).not.toBe(-80);
  });
});
