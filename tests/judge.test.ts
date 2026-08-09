/**
 * ContinuityJudge — unit coverage for the two-tier adjudication + the fail-closed contract.
 *
 * A scriptable stub gateway lets each test drive the Tier-2 model verdict (or force an outage) and
 * assert both the returned violations AND whether the model was consulted at all — so the escalation
 * gate (no model call on a clean flavor turn) and the degrade-to-Tier-1-on-failure guarantee are both
 * pinned, not just eyeballed.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { CompletionChunk, CompletionRequest, CompletionResult, EmbeddingResult, LlmRole } from "../src/llm/types.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { World } from "../src/content/schema.ts";
import { ContinuityJudge, VIOLATION_KINDS } from "../src/agents/judge.ts";
import type { VerificationBundle } from "../src/rules/continuity.ts";

class StubGateway implements LlmGateway {
  calls: { role: LlmRole; req: CompletionRequest }[] = [];
  constructor(private readonly responder: (req: CompletionRequest) => string | Error) {}
  complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push({ role, req });
    const r = this.responder(req);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({ text: r, model: "stub" });
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<CompletionChunk> {
    throw new Error("stream unused in judge tests");
  }
  embed(): Promise<EmbeddingResult> {
    return Promise.resolve({ vectors: [], model: "stub" });
  }
}

const world = { name: "Testland" } as unknown as World;
const verdict = (violations: unknown[]): string => JSON.stringify({ violations });

describe("ContinuityJudge.adjudicate", () => {
  test("clean flavor turn: Tier-1 passes and the model is NEVER consulted", async () => {
    const gw = new StubGateway(() => new Error("must not be called"));
    const judge = new ContinuityJudge(gw, world);
    const bundle: VerificationBundle = { prose: "The tide slides up the black sand.", mode: "narration" };
    const out = await judge.adjudicate(bundle);
    expect(out.violations).toHaveLength(0);
    expect(out.semanticVerified).toBe(true);
    expect(gw.calls).toHaveLength(0);
  });

  test("Tier-1 flag confirmed by the model is kept, on the utility role", async () => {
    const gw = new StubGateway(() => verdict([{ kind: "phantomState", detail: "door", correction: "no" }]));
    const judge = new ContinuityJudge(gw, world);
    const out = await judge.adjudicate({ prose: "The door swings open.", mode: "narration", authorizedCommands: [] });
    expect(out.violations).toHaveLength(1);
    expect(out.violations[0]?.kind).toBe("phantomState");
    expect(out.semanticVerified).toBe(true);
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0]?.role).toBe("utility");
  });

  test("Tier-1 flag DISMISSED by the model is dropped (false-positive kill)", async () => {
    const gw = new StubGateway(() => verdict([]));
    const judge = new ContinuityJudge(gw, world);
    const out = await judge.adjudicate({ prose: "The door swings open.", mode: "narration", authorizedCommands: [] });
    expect(out.violations).toHaveLength(0);
  });

  test("model FAILURE degrades to the Tier-1 verdict (fail-closed)", async () => {
    const gw = new StubGateway(() => new Error("verifier outage"));
    const judge = new ContinuityJudge(gw, world);
    const out = await judge.adjudicate({ prose: "The door swings open.", mode: "narration", authorizedCommands: [] });
    expect(out.violations).toHaveLength(1);
    expect(out.semanticVerified).toBe(false);
    expect(out.violations[0]?.kind).toBe("phantomState");
  });

  test("escalates on absent cast even when Tier-1 is clean, and keeps the model's semantic flag", async () => {
    const gw = new StubGateway(() => verdict([{ kind: "castPresence", offender: "Oda", detail: "staged", correction: "gone" }]));
    const judge = new ContinuityJudge(gw, world);
    // 'Oda' is not word-matched in the prose, so Tier-1 is clean, but absent!=[] forces escalation.
    const out = await judge.adjudicate({
      prose: "A shadow that could only be your companion lingers at the treeline.",
      mode: "narration",
      present: [],
      absent: ["Oda"],
    });
    expect(gw.calls).toHaveLength(1);
    expect(out.violations[0]?.kind).toBe("castPresence");
  });

  test("a malformed model response degrades to Tier-1 rather than throwing", async () => {
    const gw = new StubGateway(() => "not json at all");
    const judge = new ContinuityJudge(gw, world);
    const out = await judge.adjudicate({ prose: "The door swings open.", mode: "narration", authorizedCommands: [] });
    expect(out.violations).toHaveLength(1);
    expect(out.semanticVerified).toBe(false);
  });

  test("whisper with established facts escalates and reports a contradiction", async () => {
    const gw = new StubGateway(() =>
      verdict([{ kind: "establishedContradiction", detail: "claims never met", correction: "you have met" }]),
    );
    const judge = new ContinuityJudge(gw, world);
    const out = await judge.adjudicate({
      prose: "I have never laid eyes on you before, stranger.",
      mode: "whisper",
      established: ["The NPC and the player are old friends."],
    });
    expect(gw.calls).toHaveLength(1);
    expect(out.violations[0]?.kind).toBe("establishedContradiction");
  });

  test("force:true re-adjudicates even when the escalation gate would skip Tier-2", async () => {
    // Regression for the regeneration path: a retry that rephrases a semantic contradiction is Tier-1
    // clean and carries no absent/established signal, so `shouldEscalate` returns false — but the
    // caller KNOWS the turn had a violation, so it forces a full Tier-2 pass. The model must be
    // consulted and its verdict returned rather than the (empty) Tier-1 floor.
    const gw = new StubGateway(() =>
      verdict([{ kind: "phantomState", detail: "the barrier is still barred", correction: "the way is not open" }]),
    );
    const judge = new ContinuityJudge(gw, world);
    const bundle = { prose: "The way ahead lies open before you.", mode: "narration" as const, authorizedCommands: [] };
    // Without force, this clean-Tier-1 no-signal bundle short-circuits (model NEVER consulted).
    const skipped = await judge.adjudicate(bundle);
    expect(gw.calls).toHaveLength(0);
    expect(skipped.violations).toHaveLength(0);
    // With force, Tier-2 runs and its semantic flag is returned.
    const forced = await judge.adjudicate(bundle, { force: true });
    expect(gw.calls).toHaveLength(1);
    expect(forced.violations[0]?.kind).toBe("phantomState");
  });

  test("NARRATION with established facts escalates too (not just whispers)", async () => {
    // Regression: `shouldEscalate` used to gate established-fact checking on `mode === "whisper"`, so
    // ordinary narration that contradicts an established fact (no regex/absent hit) skipped Tier-2 and
    // shipped unchecked. It must escalate and surface the semantic contradiction.
    const gw = new StubGateway(() =>
      verdict([{ kind: "establishedContradiction", detail: "the bridge was said to be intact", correction: "the bridge stands" }]),
    );
    const judge = new ContinuityJudge(gw, world);
    const out = await judge.adjudicate({
      prose: "You gaze at the collapsed bridge, its span long since fallen into the ravine.",
      mode: "narration",
      authorizedCommands: [],
      established: ["The stone bridge over the ravine is intact and passable."],
    });
    expect(gw.calls).toHaveLength(1);
    expect(out.violations[0]?.kind).toBe("establishedContradiction");
  });
});

describe("ContinuityJudge — active combat escalation (r4-A/E phantom kill/peace)", () => {
  test("isCombat forces Tier-2 even on a clean, signal-free bundle", async () => {
    const gw = new StubGateway(() =>
      verdict([{ kind: "phantomState", detail: "declares the revenant dead", correction: "it still stands" }]),
    );
    const judge = new ContinuityJudge(gw, world);
    // No Tier-1 flag, no absent cast, no established facts — pre-fix this shipped unchecked, letting
    // loot-turn prose kill a live foe ("the Revenant is down") the dice never touched.
    const out = await judge.adjudicate({
      prose: "The Revenant is down — a heap of salt-crusted rags. You crouch and search the body.",
      mode: "narration",
      authorizedCommands: [],
      isCombat: true,
    });
    expect(gw.calls).toHaveLength(1);
    expect(out.violations[0]?.kind).toBe("phantomState");
    expect(out.semanticVerified).toBe(true);
  });

  test("the combat ground-truth line reaches the model; absent on peaceful turns", async () => {
    const gw = new StubGateway(() => verdict([]));
    const judge = new ContinuityJudge(gw, world);
    await judge.adjudicate({ prose: "You circle the wolf.", mode: "narration", authorizedCommands: [], isCombat: true });
    const combatPrompt = gw.calls[0]?.req.messages.find((m) => m.role === "user")?.content ?? "";
    expect(combatPrompt).toContain("COMBAT IS ACTIVE");
    expect(combatPrompt).toContain("still sheathed");
    // A non-combat escalation (established facts) must NOT carry the combat line.
    await judge.adjudicate({
      prose: "The bridge stands.",
      mode: "narration",
      authorizedCommands: [],
      established: ["The bridge is intact."],
    });
    const calmPrompt = gw.calls[1]?.req.messages.find((m) => m.role === "user")?.content ?? "";
    expect(calmPrompt).not.toContain("COMBAT IS ACTIVE");
  });

  test("a foe downed this turn escalates (even outside formal combat) and is pinned in the prompt (r3 #1)", async () => {
    // The kill-turn inversion: mechanics said "defeated (+35 XP)" while prose said "It has not
    // fallen. It is waiting." The bundle's `downed` names must reach the model as ground truth so
    // still-fighting prose about a fallen foe reads as phantomState — the INVERSE of the "declares a
    // live foe dead" rule the combat line already carries.
    const gw = new StubGateway(() =>
      verdict([{ kind: "phantomState", detail: "shows the fallen revenant still fighting", correction: "it is down" }]),
    );
    const judge = new ContinuityJudge(gw, world);
    const out = await judge.adjudicate({
      prose: "The revenant's claw rakes across your ribs. It has not fallen. It is waiting.",
      mode: "narration",
      authorizedCommands: [
        { type: "setCondition", entityId: "mon.salt-revenant", condition: "unconscious", active: true },
      ],
      downed: ["Salt Revenant"],
    });
    expect(gw.calls).toHaveLength(1);
    const prompt = gw.calls[0]?.req.messages.find((m) => m.role === "user")?.content ?? "";
    expect(prompt).toContain("DOWNED THIS TURN");
    expect(prompt).toContain("Salt Revenant");
    // The authorized-command summary carries the salient id, not a bare "setCondition".
    expect(prompt).toContain("setCondition(mon.salt-revenant unconscious=on)");
    expect(out.violations[0]?.kind).toBe("phantomState");
  });

  test("combat escalation still fails closed on a verifier outage", async () => {
    const gw = new StubGateway(() => new Error("verifier outage"));
    const judge = new ContinuityJudge(gw, world);
    const out = await judge.adjudicate({
      prose: "The fight rages on.",
      mode: "narration",
      authorizedCommands: [],
      isCombat: true,
    });
    expect(out.semanticVerified).toBe(false);
  });
});

describe("ContinuityJudge — r3 fix-wave kinds (pronounDrift / phaseDrift prompt surfaces)", () => {
  test("a model-surfaced pronounDrift is accepted, and the canonical PRONOUNS line reaches the prompt", async () => {
    const gw = new StubGateway(() =>
      verdict([{ kind: "pronounDrift", offender: "Oda", detail: "he rendered she", correction: "" }]),
    );
    const judge = new ContinuityJudge(gw, world);
    const out = await judge.adjudicate({
      prose: "Oda plants her shortsword and spits.",
      mode: "narration",
      absent: ["Ghost"], // escalation signal so Tier-2 runs
      presentPronouns: ["Oda (he/him)"],
    });
    expect(out.violations.some((v) => v.kind === "pronounDrift")).toBe(true);
    // An empty correction falls back to the compile-enforced default for the kind.
    expect(out.violations.find((v) => v.kind === "pronounDrift")?.correction).toContain("pronouns are canon");
    const user = gw.calls[0]?.req.messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("PRONOUNS (canonical): Oda (he/him).");
    const system = gw.calls[0]?.req.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("pronounDrift");
  });

  test("the TIME OF DAY line reaches the prompt when the bundle spans phases; absent otherwise", async () => {
    const gw = new StubGateway(() => verdict([]));
    const judge = new ContinuityJudge(gw, world);
    await judge.adjudicate({
      prose: "The road bends.",
      mode: "narration",
      absent: ["Ghost"],
      dayPhases: ["morning"],
    });
    const withTime = gw.calls[0]?.req.messages.find((m) => m.role === "user")?.content ?? "";
    expect(withTime).toContain("TIME OF DAY (authoritative clock): morning.");
    gw.calls.length = 0;
    await judge.adjudicate({ prose: "The road bends.", mode: "narration", absent: ["Ghost"] });
    const without = gw.calls[0]?.req.messages.find((m) => m.role === "user")?.content ?? "";
    expect(without).not.toContain("TIME OF DAY");
  });

  test("EVERY ViolationKind is offerable to the model tier — the desync pin", async () => {
    // The "Valid kinds:" list was hand-written and had drifted: phantomSupplies and timeDrift were
    // declared in ViolationKind but missing from the prompt, so the model tier could never SURFACE
    // either — only confirm them as Tier-1 flags. Both the accepted set and the prompt list now
    // derive from DEFAULT_CORRECTION (the one tsc-exhaustive Record<ViolationKind, …>), so this
    // pins the last hand-written link: that the derived list actually reaches the system prompt.
    const gw = new StubGateway(() => verdict([]));
    await new ContinuityJudge(gw, world).adjudicate({ prose: "x", mode: "narration", absent: ["Ghost"] });
    const system = gw.calls[0]?.req.messages.find((m) => m.role === "system")?.content ?? "";
    const valid = system.slice(system.indexOf("Valid kinds:"));
    expect(VIOLATION_KINDS.size).toBeGreaterThan(10);
    for (const kind of VIOLATION_KINDS) expect(valid).toContain(kind);
  });

  test("the PLACE line reaches the prompt when the bundle carries a locale; absent otherwise", async () => {
    const gw = new StubGateway(() => verdict([]));
    const judge = new ContinuityJudge(gw, world);
    await judge.adjudicate({
      prose: "The road bends.",
      mode: "narration",
      absent: ["Ghost"],
      locale: { here: "The Undercroft", exits: ["the stair up"], foreign: ["Vellmere"] },
    });
    const withPlace = gw.calls[0]?.req.messages.find((m) => m.role === "user")?.content ?? "";
    expect(withPlace).toContain('PLACE (authoritative): the scene is IN "The Undercroft"');
    expect(withPlace).toContain("Its ONLY routes out are: the stair up.");
    gw.calls.length = 0;
    await judge.adjudicate({ prose: "The road bends.", mode: "narration", absent: ["Ghost"] });
    const without2 = gw.calls[0]?.req.messages.find((m) => m.role === "user")?.content ?? "";
    expect(without2).not.toContain("PLACE (authoritative)");
  });
  test("a model that answers with its EXPLANATION in the offender slot: cast violation dropped", async () => {
    // r5 P1, verbatim off the transcript: the offender slot came back as a whole sentence and the
    // absence floor printed it to the player — "There is no sign of The prose references 'Jessup' as
    // a named character with a gate-post and a cart, but Jessup is not in the PRESENT list. here."
    // A cast violation IS its person: with nobody nameable there is nothing to forbid, so it dies here.
    const gw = new StubGateway(() =>
      verdict([
        {
          kind: "castPresence",
          offender:
            "The prose references 'Jessup' as a named character with a gate-post and a cart, but Jessup is not in the PRESENT list.",
          detail: "Jessup is not present",
          correction: "drop him",
        },
      ]),
    );
    const out = await new ContinuityJudge(gw, world).adjudicate({
      prose: "You lift the oilcloth on the cart.",
      mode: "narration",
      present: ["A drover"],
      absent: ["Kella Vane"],
    });
    expect(out.violations).toHaveLength(0);
  });

  test("an explanation that NAMES a roster member snaps back to that name", async () => {
    const gw = new StubGateway(() =>
      verdict([
        {
          kind: "castPresence",
          offender: "the prose stages Kella Vane here although she is elsewhere",
          detail: "staged",
          correction: "drop her",
        },
      ]),
    );
    const out = await new ContinuityJudge(gw, world).adjudicate({
      prose: "Kella leans on the rail.",
      mode: "narration",
      present: ["A drover"],
      absent: ["Kella Vane"],
    });
    expect(out.violations).toHaveLength(1);
    expect(out.violations[0]?.offender).toBe("Kella Vane");
  });

  test("a non-cast violation keeps its unusable offender but survives (the correction still applies)", async () => {
    const gw = new StubGateway(() =>
      verdict([{ kind: "phantomState", offender: "the door is described as opening", detail: "d", correction: "c" }]),
    );
    const out = await new ContinuityJudge(gw, world).adjudicate({
      prose: "The door swings open.",
      mode: "narration",
      authorizedCommands: [],
    });
    expect(out.violations).toHaveLength(1);
    expect(out.violations[0]?.kind).toBe("phantomState");
    expect(out.violations[0]?.offender).toBeUndefined();
  });
});
