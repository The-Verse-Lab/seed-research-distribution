/**
 * Proposal-answer tests — a leader's pending proposal can be ANSWERED, not just outwaited.
 *
 * The lifecycle under test (playability fix): the autonomy module's perceive pass still cancels
 * every pending proposal on a player tick (priority-A override), but stashes the cancelled
 * proposals into per-tick scratch; the engine's resolve phase then reads a bounded, deterministic
 * "yes"/"no" off the raw input — an accept enqueues the proposal's grounded commands (reducer-only
 * mutation via the core commit), an explicit decline sets the plan aside visibly, and anything
 * else falls through to normal classification (the historic cancel, now visible). Alongside it,
 * the spam guards: a leader never re-proposes while its own proposal is pending, and after one it
 * cools down for PROPOSAL_COOLDOWN_BEATS of its heartbeat (demoted to plain dialogue).
 *
 * Same conventions as tests/autonomy.test.ts: offline gateway, seeded rng, in-memory store,
 * white-box autonomy patching through the doctored snapshot.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier, heuristicClassify } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { mulberry32, type Rng } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { GameEngine } from "../src/engine/engine.ts";
import type { AutonomyRuntime, GameState } from "../src/state/types.ts";
import type { GameEvent } from "../src/events/types.ts";
import { byKind, loadThistledown, RecordingGateway, type TraceBeat } from "./support/harness.ts";
import type { PlaySet } from "../src/content/schema.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import type { ClassifierContext, TurnPlan } from "../src/engine/turn-plan.ts";

/**
 * The input DSL, decorated with the closed `proposalAnswer` a real classifier fills (r8 regex
 * audit). `answers` maps a verbatim player line to the enum value; anything else classifies exactly
 * as before, so the specs that pin the deterministic word matchers stay honest.
 */
function classifierAnswering(answers: Record<string, TurnPlan["proposalAnswer"]>): TurnClassifier {
  return {
    classify: async (text: string, ctx: ClassifierContext): Promise<TurnPlan> => {
      const plan = heuristicClassify(text, ctx);
      const named = answers[text.trim()];
      return named ? { ...plan, proposalAnswer: named } : plan;
    },
  };
}

const SEED = 42;

interface Built {
  /** The narrator briefs this run — so a spec can assert what the GM was actually shown. */
  gateway: RecordingGateway;
  engine: GameEngine;
  events: GameEvent[];
  /** Public NPC beats across turns — the observable for DM-owned public speech. */
  beats: TraceBeat[];
  store: InMemoryGameStateStore;
  playset: PlaySet;
}

/** A started thistledown engine whose loaded snapshot was white-box patched before start. */
async function build(opts: {
  mutateState?: (s: GameState) => void;
  rng?: Rng;
  /** Override the input DSL — the r8 specs need a plan carrying a closed `proposalAnswer`. */
  classifier?: TurnClassifier;
} = {}): Promise<Built> {
  const playset = await loadThistledown();
  const store = new InMemoryGameStateStore();
  if (opts.mutateState) {
    const seed = new GameEngine({ classifier: heuristicClassifier,
      playset,
      store: new InMemoryGameStateStore(),
      gateway: new OfflineGateway(),
      rng: mulberry32(SEED),
    });
    await seed.start();
    const snapshot = seed.getState();
    opts.mutateState(snapshot);
    await store.save(makeSaveKey(playset.campaign.id, playset.campaign.startingState.party[0]), snapshot);
  }

  const beats: TraceBeat[] = [];
  const gateway = new RecordingGateway();
  const engine = new GameEngine({ classifier: opts.classifier ?? heuristicClassifier,
    playset,
    store,
    gateway,
    rng: opts.rng ?? mulberry32(SEED),
    onTurnTrace: (t) => {
      if (t.npcBeats) beats.push(...t.npcBeats);
    },
  });
  const events: GameEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.start();
  return { engine, events, beats, store, playset, gateway };
}

/** Patch one companion's autonomy runtime in both projections fromGameState may read. */
function setAutonomy(s: GameState, npcId: string, patch: Partial<AutonomyRuntime>): void {
  const base: AutonomyRuntime = s.autonomy[npcId] ?? { talking: false, replyDepth: 0, lastActedAt: 0 };
  const next = { ...base, ...patch };
  s.autonomy[npcId] = next;
  s.modules = s.modules ?? {};
  const mod = (s.modules.autonomy as Record<string, AutonomyRuntime> | undefined) ?? {};
  mod[npcId] = next;
  s.modules.autonomy = mod;
}

/** Seed Maelle (thistledown's leader) with a live pending proposal: move the party to the green. */
function seedProposal(s: GameState): void {
  setAutonomy(s, "npc.maelle", {
    pendingProposal: {
      commands: [{ type: "moveParty", to: "loc.green" }],
      // Un-expired: the answer path must not depend on tacit-consent timing.
      expiresAt: Date.now() + 60_000,
      text: "Let's make for the green.",
    },
  });
}

describe("proposal answers — the player's yes/no reaches a pending proposal", () => {
  test("(P1) 'yes' on the next tick applies the stored commands with an agree beat", async () => {
    const { engine, events, gateway } = await build({ mutateState: seedProposal });
    expect(engine.getState().partyLocationId).toBe("loc.hart");
    events.length = 0;

    await engine.submitPlayerInput("yes, lead on");

    // The proposal's grounded command executed through the core commit: the party moved.
    expect(engine.getState().partyLocationId).toBe("loc.green");
    const beats = byKind(events, "stateChanged").filter((e) => e.summary.includes("agree"));
    expect(beats).toHaveLength(1);
    expect(beats[0]?.summary).toBe("You agree to Maelle Ashfield's plan.");

    // The GM's `# NOW` line must NOT carry the leader's spoken plan. That slot holds the PLAYER's
    // own words on every other turn, so appending the companion's line there taught the model those
    // were the player's too — and it expanded them into paragraphs of invented player dialogue
    // (2026-07-24 playtest P2: a three-sentence tactical speech quoted as the player's own). The
    // plan still reaches the narrator, attributed, through the authoritative consequences block.
    const brief = gateway.briefs.find((b) => b.includes("You agree to Maelle Ashfield's plan")) ?? "";
    expect(brief).toBeTruthy();
    const now = brief.slice(brief.indexOf("# NOW"));
    expect(now).toContain("You agree to Maelle Ashfield's plan.");
    expect(now.slice(0, now.indexOf("==="))).not.toContain("Let's make for the green");
    expect(brief).toContain(`Maelle Ashfield proposed: "Let's make for the green."`);
    expect(brief).toContain("not the player's");
  });

  test("(P2) an explicit 'no' applies nothing and sets the plan aside visibly", async () => {
    const { engine, events } = await build({ mutateState: seedProposal });
    events.length = 0;

    await engine.submitPlayerInput("No, hold position.");

    expect(engine.getState().partyLocationId).toBe("loc.hart");
    const beats = byKind(events, "stateChanged").filter((e) => e.summary.includes("set aside"));
    expect(beats).toHaveLength(1);
    expect(beats[0]?.summary).toBe("Maelle Ashfield's plan is set aside.");
    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal).toBeUndefined();
  });

  test("(P3) anything else drops the plan and the input still resolves normally", async () => {
    const { engine, events } = await build({ mutateState: seedProposal });
    events.length = 0;

    await engine.submitPlayerInput("I look around the room.");

    // Nothing of the proposal applied, no answer beat either way…
    expect(engine.getState().partyLocationId).toBe("loc.hart");
    const answers = byKind(events, "stateChanged").filter(
      (e) => e.summary.includes("agree") || e.summary.includes("set aside"),
    );
    expect(answers).toHaveLength(0);
    // …the proposal is cancelled (priority-A override, exactly as before) — and a COMPATIBLE turn
    // no longer prints the nag line (r6 P3: it fired while the player bought gear FOR the plan).
    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal).toBeUndefined();
    const drops = byKind(events, "stateChanged").filter((e) => e.summary.includes("lets the plan drop"));
    expect(drops).toHaveLength(0);
    // …and the input fell through to normal classification and was narrated.
    expect(byKind(events, "narration").length).toBeGreaterThanOrEqual(1);
  });

  test("(r6 P3) the drop line is reserved for a turn that CONTRADICTS the plan (walking away)", async () => {
    const { engine, events } = await build({ mutateState: seedProposal });
    events.length = 0;

    await engine.submitPlayerInput("let's head to the green");

    const drops = byKind(events, "stateChanged").filter((e) => e.summary.includes("lets the plan drop"));
    expect(drops).toHaveLength(1);
  });

  test("(r8 regex audit) the body part is not the verb — nodding off does not walk away", async () => {
    // The contradiction sniff carried a bare `\bhead\b`, which is the body part far more often than
    // the verb of travel. Reproduced against the shipped engine with Maelle's plan standing: "I rest
    // my head against the cold wall for a moment." printed "Maelle Ashfield lets the plan drop." —
    // the player was marked down on the ledger for walking away while sitting still.
    for (const line of [
      "I rest my head against the cold wall for a moment.",
      "I shake my head, slowly.",
      "I keep my head down and count the coins again.",
    ]) {
      const { engine, events } = await build({ mutateState: seedProposal });
      events.length = 0;
      await engine.submitPlayerInput(line);
      const drops = byKind(events, "stateChanged").filter((e) => e.summary.includes("lets the plan drop"));
      expect(drops, line).toHaveLength(0);
    }
  });

  test("(r8 regex audit) `head` WITH a direction still prints the drop line", async () => {
    // The other direction: a complement is what makes it travel, so these must keep contradicting.
    for (const line of ["I head north up the lane", "we head back to the crossroads"]) {
      const { engine, events } = await build({ mutateState: seedProposal });
      events.length = 0;
      await engine.submitPlayerInput(line);
      const drops = byKind(events, "stateChanged").filter((e) => e.summary.includes("lets the plan drop"));
      expect(drops, line).toHaveLength(1);
    }
  });

  test("(P12) an accept of a plan armed at ANOTHER location refuses — the moment has passed", async () => {
    // 2026-07-25 P1: the commands bake an absolute destination grounded where the proposal was
    // ARMED; a "yes" after the party has moved on must never fire them (the stale AGREE that
    // teleported the playtest party a day's road backwards).
    const { engine, events } = await build({
      mutateState: (s) =>
        setAutonomy(s, "npc.maelle", {
          pendingProposal: {
            commands: [{ type: "moveParty", to: "loc.green" }],
            expiresAt: Date.now() + 60_000,
            text: "Let's make for the green.",
            originLocationId: "loc.green", // armed elsewhere; the party stands at loc.hart
          },
        }),
    });
    events.length = 0;

    await engine.submitPlayerInput("yes");

    expect(engine.getState().partyLocationId).toBe("loc.hart"); // nothing moved
    expect(byKind(events, "stateChanged").filter((e) => e.summary.includes("agree"))).toHaveLength(0);
    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal).toBeUndefined(); // spent
  });

  test("(P13) with TWO pending proposals, a typed 'yes' answers the DISPLAYED card (leader-first)", async () => {
    // 2026-07-25 P1: the visible proposal is leader-first, but the engine executed stashed[0] in
    // plain slice order — the player agreed to "get inside Vellmere" and a different companion's
    // stale move ran. The stash now mirrors the card order.
    const { engine, events } = await build({
      mutateState: (s) => {
        // Seed DORRAN first so slice order alone would answer him — the leader gate must win.
        setAutonomy(s, "npc.dorran", {
          pendingProposal: {
            commands: [{ type: "adjustHp", entityId: "npc.dorran", by: -1 }],
            expiresAt: Date.now() + 60_000,
            text: "I'll scout ahead alone.",
          },
        });
        seedProposal(s); // Maelle: moveParty → loc.green
        s.modules = s.modules ?? {};
        s.modules.party = { leaderId: "npc.maelle", pendingLeave: {} };
      },
    });
    events.length = 0;

    await engine.submitPlayerInput("yes");

    // The appointed leader's (displayed) plan executed; the other companion's did not.
    expect(engine.getState().partyLocationId).toBe("loc.green");
    expect(byKind(events, "hpChanged")).toHaveLength(0);
    const beats = byKind(events, "stateChanged").filter((e) => e.summary.includes("agree"));
    expect(beats[0]?.summary).toBe("You agree to Maelle Ashfield's plan.");
    // The SIBLING's cancelled plan still drops VISIBLY — the "yes" consumed only the answered card.
    const drops = byKind(events, "stateChanged").filter((e) => e.summary.includes("lets the plan drop"));
    expect(drops).toHaveLength(1);
    expect(drops[0]?.summary).toContain("Dorran");
  });

  test("(P14) an answerProposal ACTION answers ITS OWN card by fromId, not stashed[0]", async () => {
    const { engine, events } = await build({
      mutateState: (s) => {
        seedProposal(s); // Maelle first in slice order: stashed[0] without the fromId thread
        setAutonomy(s, "npc.dorran", {
          pendingProposal: {
            commands: [{ type: "adjustHp", entityId: "npc.dorran", by: -1 }],
            expiresAt: Date.now() + 60_000,
            text: "I'll scout ahead alone.",
          },
        });
      },
    });
    events.length = 0;

    await engine.submitAction({ kind: "answerProposal", proposalKind: "leader", fromId: "npc.dorran", accept: true });

    // Dorran's card was clicked: HIS plan ran; Maelle's move did not ride the same "yes".
    expect(byKind(events, "hpChanged").filter((d) => d.entityId === "npc.dorran")).toHaveLength(1);
    expect(engine.getState().partyLocationId).toBe("loc.hart");
    // Maelle's cancelled sibling plan drops visibly, never silently.
    const drops = byKind(events, "stateChanged").filter((e) => e.summary.includes("lets the plan drop"));
    expect(drops).toHaveLength(1);
    expect(drops[0]?.summary).toContain("Maelle");
  });

  test("(P15) an agreed MOVE is priced as movement, not as a 1-minute spoken beat", async () => {
    const { engine } = await build({ mutateState: seedProposal });
    const clockBefore = engine.getState().clock;

    await engine.submitPlayerInput("yes, lead on");

    expect(engine.getState().partyLocationId).toBe("loc.green");
    // The hart→green exit has no authored minutes, so the movement cost-table row (30 min) applies
    // — the point is it is no longer the 2026-07-25 free 1-minute teleport.
    expect(engine.getState().clock - clockBefore).toBe(30);
  });

  test("(P7) a mixed sentence starting with an assent word is NOT an accept — nothing executes", async () => {
    const { engine, events } = await build({ mutateState: seedProposal });
    events.length = 0;

    await engine.submitPlayerInput("Okay, but first let me talk to Bett about the road.");

    // The review-confirmed regression: a bare prefix match marched the party off mid-sentence.
    expect(engine.getState().partyLocationId).toBe("loc.hart");
    const answers = byKind(events, "stateChanged").filter(
      (e) => e.summary.includes("agree") || e.summary.includes("set aside"),
    );
    expect(answers).toHaveLength(0);
    // Falls through to normal classification — the input is handled (here: "talk to Bett"
    // grounds as a public address, so Bett replies in character), not swallowed.
    const handled = events.filter((e) => e.kind === "narration" || (e.kind === "dialogue" && e.actorId !== "pc.you"));
    expect(handled.length).toBeGreaterThanOrEqual(1);
  });

  test("(P8) a question starting with 'wait' is NOT a decline — it reaches the classifier", async () => {
    const { engine, events } = await build({ mutateState: seedProposal });
    events.length = 0;

    await engine.submitPlayerInput("Wait, what's at the green? Is it dangerous?");

    const answers = byKind(events, "stateChanged").filter(
      (e) => e.summary.includes("agree") || e.summary.includes("set aside"),
    );
    expect(answers).toHaveLength(0);
    expect(byKind(events, "narration").length).toBeGreaterThanOrEqual(1);
  });

  test("(P5) after an accept, the pending proposal is gone from the autonomy runtime", async () => {
    const { engine } = await build({ mutateState: seedProposal });

    await engine.submitPlayerInput("yes");

    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal).toBeUndefined();
  });

  test("(P9) role-played assent accepts the plan — the climax the closed vocabulary lost", async () => {
    // The 2026-07-24 playtest's worst moment: the leader proposed, the player answered in the
    // leader's own words, and — matching neither answer regex — the grounded plan was destroyed on
    // the way to the classifier. The turn resolved to the bare fail-closed line "The moment passes."
    // The answer used to come from `isProposalEcho` (string containment over the proposal's own
    // words); it is now the classifier's closed `proposalAnswer`, and the beat still lands.
    const { engine, events } = await build({
      mutateState: seedProposal,
      classifier: classifierAnswering({ "Let's make for the green.": "accept" }),
    });
    events.length = 0;

    await engine.submitPlayerInput("Let's make for the green.");

    expect(engine.getState().partyLocationId).toBe("loc.green");
    const beats = byKind(events, "stateChanged").filter((e) => e.summary.includes("agree"));
    expect(beats).toHaveLength(1);
    expect(byKind(events, "narration").some((n) => n.text.trim() === "The moment passes.")).toBe(false);
  });

  test("(P10) a line the model calls 'neither' is not assent — nothing executes", async () => {
    // Shares "green" with the plan but adds "alone" — a different intention, not an echo.
    const { engine, events } = await build({
      mutateState: seedProposal,
      classifier: classifierAnswering({ "Green, but alone.": "neither" }),
    });
    events.length = 0;

    await engine.submitPlayerInput("Green, but alone.");

    expect(engine.getState().partyLocationId).toBe("loc.hart");
    expect(byKind(events, "stateChanged").filter((e) => e.summary.includes("agree"))).toHaveLength(0);
  });

  test("(P11) a decline that reuses the leader's words is still a decline", async () => {
    const { engine, events } = await build({
      mutateState: seedProposal,
      classifier: classifierAnswering({ "Not the green.": "decline" }),
    });
    events.length = 0;

    await engine.submitPlayerInput("Not the green.");

    expect(engine.getState().partyLocationId).toBe("loc.hart");
    expect(byKind(events, "stateChanged").filter((e) => e.summary.includes("agree"))).toHaveLength(0);
  });

  test("(P16, r8) 'Not the mine.' against a plan that says 'not' does NOT move the party", async () => {
    // THE REPRODUCED MISFIRE. `isProposalEcho` asked only "is every content word of the answer
    // already in the proposal?", so a rejection assembled out of the proposal's OWN vocabulary
    // scored ACCEPT. Executed against the shipped predicate, with the leader's plan reading
    // "We should head for the mine, not the road":
    //     words("Not the mine.")           = ["not", "the", "mine"]
    //     words(plan) ⊇ {"not", "the", "mine"}  ⇒ isProposalEcho === true  ⇒ accept
    // …and the stashed `moveParty` walked the whole party to the mine the player had just refused.
    // The deterministic decline matcher does not save it either: PROPOSAL_DECLINE_RE anchors on
    // "no"/"not yet"/"not now", and a bare leading "Not" matches none of them.
    const seedMinePlan = (s: GameState): void => {
      setAutonomy(s, "npc.maelle", {
        pendingProposal: {
          commands: [{ type: "moveParty", to: "loc.green" }],
          expiresAt: Date.now() + 60_000,
          text: "We should head for the mine, not the road.",
        },
      });
    };
    const { engine, events } = await build({
      mutateState: seedMinePlan,
      classifier: classifierAnswering({ "Not the mine.": "decline" }),
    });
    events.length = 0;

    await engine.submitPlayerInput("Not the mine.");

    expect(engine.getState().partyLocationId).toBe("loc.hart");
    expect(byKind(events, "stateChanged").filter((e) => e.summary.includes("agree"))).toHaveLength(0);
    // …and it lands as an explicit decline, not a silent fall-through.
    expect(byKind(events, "stateChanged").some((e) => e.summary.includes("set aside"))).toBe(true);
  });

  test("(r8 review) a PERIOD does not defeat the concessive guard — 'Fine. But not that way.'", async () => {
    // THE REPRODUCED MISFIRE. `PROPOSAL_ACCEPT_RE`'s negative lookahead spanned only whitespace and
    // a COMMA, so ending the answer word with a period slipped straight past it — and `lexicalAccept`
    // is computed FIRST, so the classifier was never consulted and the leader's stashed `moveParty`
    // executed on a flat rejection. Executed against the shipped regex:
    //     "Fine, but not the mine."   accept:false   ← the comma form was handled
    //     "Fine. But not that way."   accept:TRUE    ← the party walks that way
    //     "Fine. Not the mine."       accept:TRUE
    //     "Yes. But wait."            accept:TRUE
    //     "OK. Though I doubt it."    accept:TRUE
    for (const line of ["Fine. But not that way.", "Fine. Not the mine.", "Yes. But wait.", "OK. Though I doubt it."]) {
      const { engine, events } = await build({
        mutateState: seedProposal,
        classifier: classifierAnswering({ [line]: "decline" }),
      });
      events.length = 0;

      await engine.submitPlayerInput(line);

      expect(engine.getState().partyLocationId).toBe("loc.hart");
      expect(byKind(events, "stateChanged").filter((e) => e.summary.includes("agree"))).toHaveLength(0);
      expect(byKind(events, "stateChanged").some((e) => e.summary.includes("set aside"))).toBe(true);
    }
  });

  test("(r8 review) …and a PLAIN 'Fine.' still accepts for free, with no model consulted", async () => {
    // The other direction: the qualifier gap must not swallow the ordinary answer. A bare "Fine."
    // (and "Yes.", "OK.") still matches lexically, executes the plan, and costs zero classifier
    // calls — the free-matchers-in-front ordering the r8 migration rests on.
    let calls = 0;
    const counting: TurnClassifier = {
      classify: async (text: string, ctx: ClassifierContext): Promise<TurnPlan> => {
        calls += 1;
        return heuristicClassify(text, ctx);
      },
    };
    const { engine, events } = await build({ mutateState: seedProposal, classifier: counting });
    events.length = 0;
    const before = calls;

    await engine.submitPlayerInput("Fine.");

    expect(engine.getState().partyLocationId).toBe("loc.green");
    expect(byKind(events, "stateChanged").filter((e) => e.summary.includes("agree"))).toHaveLength(1);
    expect(calls - before).toBe(0);
  });

  test("(P17, r8) a plan with NO proposalAnswer falls through — the safe branch mutates nothing", async () => {
    // A double classifier failure yields `freeformPlan()`, which carries no `proposalAnswer` at all.
    // The documented degrade is "neither": the proposal stays cancelled and the line classifies
    // normally. The same line that accepts in P9 must therefore do nothing here.
    const { engine, events } = await build({ mutateState: seedProposal });
    events.length = 0;

    await engine.submitPlayerInput("Let's make for the green.");

    expect(engine.getState().partyLocationId).toBe("loc.hart");
    expect(byKind(events, "stateChanged").filter((e) => e.summary.includes("agree"))).toHaveLength(0);
  });
});

describe("one classifier call per turn — the invariant the r8 migration rests on (r8)", () => {
  /**
   * Several closed-field readers live in `resolvePlayer` branches that RETURN before the main
   * classification. If any of them classified independently, a turn would silently cost TWO utility
   * calls — the exact thing `classifyOnce` (per-tick memoization) exists to prevent. The proposal
   * branch is the sharpest case: it consults the plan and then FALLS THROUGH to normal resolution,
   * so a naive implementation classifies the same line twice.
   */
  function countingClassifier(): { classifier: TurnClassifier; calls: () => number } {
    let calls = 0;
    return {
      classifier: {
        classify: async (text: string, ctx: ClassifierContext): Promise<TurnPlan> => {
          calls += 1;
          return heuristicClassify(text, ctx);
        },
      },
      calls: () => calls,
    };
  }

  test("a shaped non-answer consults the plan AND falls through on a single call", async () => {
    const { classifier, calls } = countingClassifier();
    const { engine } = await build({ mutateState: seedProposal, classifier });
    const before = calls();

    // Shaped (≤5 words, no "?") but matched by neither word matcher, so the branch asks the model
    // for `proposalAnswer` — and, getting none, hands the SAME plan to the main resolution below.
    await engine.submitPlayerInput("Green, but alone.");

    expect(calls() - before).toBe(1);
  });

  test("a lexical 'yes' consults no model at all — the free matchers stay in front", async () => {
    const { classifier, calls } = countingClassifier();
    const { engine } = await build({ mutateState: seedProposal, classifier });
    const before = calls();

    await engine.submitPlayerInput("yes, lead on");

    expect(calls() - before).toBe(0);
  });
});

describe("proposal spam guards — pending gate + cooldown", () => {
  test("(P4) a leader with a live pending proposal does NOT re-propose on its heartbeat", async () => {
    const { engine, events } = await build({
      mutateState: (s) =>
        setAutonomy(s, "npc.maelle", {
          // Stale dedup stamp — the OLD duplicate race: without the pending gate this beat
          // would emit a fresh proposal and slide the expiry forward.
          lastActedAt: 0,
          pendingProposal: {
            commands: [{ type: "moveParty", to: "loc.green" }],
            expiresAt: Date.now() + 120_000, // un-expired: tacit consent must not fire either
            text: "Let's make for the green.",
          },
        }),
    });
    events.length = 0;

    await engine.tickHeartbeat("npc.maelle");

    expect(byKind(events, "npcProposal")).toHaveLength(0);
    expect(byKind(events, "dialogue")).toHaveLength(0);
    // The standing proposal is untouched — its expiry no longer slides forward.
    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal).toBeDefined();
  });

  test("(P6) within the cooldown a leader's C-beat is plain dialogue, not a proposal", async () => {
    const { engine, events, beats } = await build({
      // A just-consumed/cancelled proposal: lastProposedAt is fresh, nothing pending. Within
      // 3× the leader's heartbeat the spontaneous line must be demoted to plain dialogue.
      mutateState: (s) => setAutonomy(s, "npc.maelle", { lastProposedAt: Date.now() }),
    });
    events.length = 0;
    beats.length = 0;

    await engine.tickHeartbeat("npc.maelle");

    // "Plain dialogue" is now a DM-narrated beat (not a proposal, not a raw dialogue bubble).
    expect(byKind(events, "npcProposal")).toHaveLength(0);
    const lines = beats.filter((b) => b.actorId === "npc.maelle");
    expect(lines).toHaveLength(1);
    expect((lines[0]?.dialogue ?? "").length).toBeGreaterThan(0);
    // Cooldown demotion arms no machinery: still no pending proposal afterwards.
    expect(engine.getState().autonomy["npc.maelle"]?.pendingProposal).toBeUndefined();
  });
});
