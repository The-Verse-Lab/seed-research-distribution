/**
 * narrateGuarded — the guarded narration flow shared by engine modules.
 *
 * Locks the one hard-line policy now that both modules delegate here:
 *  1. a `blocked` verdict ⇒ emit the firm OOC refusal and narrate NOTHING (no fall-through to
 *     prose for the very thing the guard refused — not even the trigger echo);
 *  2. an empty/whitespace result from a NON-blocked call ⇒ degrade to the deterministic trigger
 *     echo (the engine-authored line + resolved verdict), never to generated prose;
 *  3. clean prose ⇒ emitted verbatim.
 * Because both narrate paths call this exact function, these cases hold for both by construction.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  castAbsenceEcho,
  castGuardEcho,
  narrateGuarded,
  stripNarratorDirective,
  triggerEcho,
} from "../src/modules/narrate.ts";
import { MINOR_SAFETY_REFUSAL } from "../src/llm/safety.ts";
import type { DungeonMaster, NarrationContext } from "../src/agents/dm.ts";
import type { EmittedEvent } from "../src/events/types.ts";
import type { TickContext } from "../src/engine/tick.ts";

/** A minimal TickContext whose only live surfaces are `emit` (collected) and an absent client. */
function fakeCtx(): { ctx: TickContext; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  const ctx = { services: {}, emit: (e: EmittedEvent) => void events.push(e) } as unknown as TickContext;
  return { ctx, events };
}

/** A DM stub whose narrate returns a fixed verdict. */
const dmReturning = (verdict: { text: string; blocked?: boolean }): DungeonMaster =>
  ({ narrate: async () => verdict }) as unknown as DungeonMaster;

/** A DM stub that STREAMS its text through `opts.onToken` (one delta), then returns it. */
const dmStreaming = (text: string): DungeonMaster =>
  ({
    narrate: async (_s: unknown, _c: unknown, opts?: { onToken?: (d: string) => void }) => {
      opts?.onToken?.(text);
      return { text };
    },
  }) as unknown as DungeonMaster;

/**
 * A DM stub that STREAMS a non-sexual lead-in live (like the guard releasing a safe prefix) and THEN
 * returns a minor-safety `blocked` verdict — the exact mid-stream-block shape the retract path handles.
 */
const dmStreamingThenBlocked = (prefix: string): DungeonMaster =>
  ({
    narrate: async (_s: unknown, _c: unknown, opts?: { onToken?: (d: string) => void }) => {
      opts?.onToken?.(prefix);
      return { text: prefix, blocked: true };
    },
  }) as unknown as DungeonMaster;

/** A ctx whose client records every streamed token WITH the beatId the wrapper bound, plus retracts. */
function fakeCtxWithClient(): {
  ctx: TickContext;
  events: EmittedEvent[];
  tokens: { delta: string; beatId?: number }[];
  retracts: (number | undefined)[];
} {
  const events: EmittedEvent[] = [];
  const tokens: { delta: string; beatId?: number }[] = [];
  const retracts: (number | undefined)[] = [];
  const ctx = {
    services: {
      client: {
        onNarrationToken: (delta: string, beatId?: number) => void tokens.push({ delta, beatId }),
        onNarrationRetract: (beatId?: number) => void retracts.push(beatId),
      },
    },
    emit: (e: EmittedEvent) => void events.push(e),
  } as unknown as TickContext;
  return { ctx, events, tokens, retracts };
}

/** A full-enough tick for the Judge bundle builder, with a client proving candidates stay buffered. */
function fakeCtxWithJudge(judge: object): ReturnType<typeof fakeCtxWithClient> {
  const out = fakeCtxWithClient();
  Object.assign(out.ctx as unknown as Record<string, unknown>, {
    model: { entities: new Map(), modules: {} },
    queue: [],
    data: {},
    dryRun: () => ({ mutated: false }),
  });
  (out.ctx.services as unknown as Record<string, unknown>).judge = judge;
  return out;
}

const STATE = {} as never;
const NCTX = { contextText: "", trigger: "You pry at the rusted grate." } as NarrationContext;

describe("narrateGuarded — the shared blocked-no-fall-through policy", () => {
  test("blocked ⇒ firm OOC refusal, no narration of any kind", async () => {
    const { ctx, events } = fakeCtx();

    await narrateGuarded(ctx, STATE, dmReturning({ text: "", blocked: true }), NCTX);

    expect(events.some((e) => e.kind === "system" && e.message === MINOR_SAFETY_REFUSAL)).toBe(true);
    // The load-bearing assertion: a block never falls through to ANY prose, echo included.
    expect(events.some((e) => e.kind === "narration")).toBe(false);
  });

  test("empty non-blocked result ⇒ degrades to the deterministic trigger echo", async () => {
    const { ctx, events } = fakeCtx();

    await narrateGuarded(ctx, STATE, dmReturning({ text: "   " }), NCTX);

    const narration = events.filter((e) => e.kind === "narration");
    expect(narration.length).toBe(1);
    expect(narration[0]).toMatchObject({ text: "You pry at the rusted grate." });
    expect(events.some((e) => e.kind === "system" && e.message === MINOR_SAFETY_REFUSAL)).toBe(false);
  });

  test("clean prose ⇒ emitted verbatim (no echo)", async () => {
    const { ctx, events } = fakeCtx();

    await narrateGuarded(ctx, STATE, dmReturning({ text: "The hearth pops." }), NCTX);

    const narration = events.filter((e) => e.kind === "narration");
    expect(narration.length).toBe(1);
    expect(narration[0]).toMatchObject({ text: "The hearth pops." });
  });

  test("a refusal detector treats break-character prose as empty ⇒ trigger echo stands in", async () => {
    const { ctx, events } = fakeCtx();

    await narrateGuarded(ctx, STATE, dmReturning({ text: "I can't describe that." }), NCTX, (t) =>
      t.startsWith("I can't"),
    );

    const narration = events.filter((e) => e.kind === "narration");
    expect(narration.length).toBe(1);
    expect(narration[0]).toMatchObject({ text: "You pry at the rusted grate." });
  });
});

describe("narrateGuarded — per-beat streaming id (playtest bug #1: multi-beat truncation)", () => {
  test("the settled narration event carries a numeric beatId matching its streamed tokens", async () => {
    const { ctx, events, tokens } = fakeCtxWithClient();

    await narrateGuarded(ctx, STATE, dmStreaming("The hearth pops."), NCTX);

    const narration = events.filter((e) => e.kind === "narration");
    expect(narration.length).toBe(1);
    const beatId = (narration[0] as { beatId?: number }).beatId;
    expect(typeof beatId).toBe("number");
    // Every token this beat streamed carries the SAME id the settled event finalizes — that binding is
    // what lets the client key its live buffer per beat instead of merging two beats into one stub.
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) expect(t.beatId).toBe(beatId);
  });

  test("two beats in one turn get DISTINCT ids (so their client buffers never collide)", async () => {
    const { ctx, events } = fakeCtxWithClient();

    await narrateGuarded(ctx, STATE, dmStreaming("Beat one."), NCTX);
    await narrateGuarded(ctx, STATE, dmStreaming("Beat two."), NCTX);

    const ids = events.filter((e) => e.kind === "narration").map((e) => (e as { beatId?: number }).beatId);
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("narrateGuarded — mid-stream block retracts the dangling live beat (audit #7)", () => {
  test("a beat blocked AFTER streaming a live prefix retracts that beatId, emits the refusal, no prose", async () => {
    const { ctx, events, tokens, retracts } = fakeCtxWithClient();

    await narrateGuarded(ctx, STATE, dmStreamingThenBlocked("The lantern gutters as"), NCTX);

    // The safe prefix WAS streamed live (leaving a stub on a real client)…
    expect(tokens.length).toBeGreaterThan(0);
    const streamedId = tokens[0]!.beatId;
    expect(typeof streamedId).toBe("number");
    // …so exactly that beat is retracted, so the client drops the stub before the refusal lands.
    expect(retracts).toEqual([streamedId]);
    // The hard line still holds: the firm OOC refusal fires and NO prose (echo included) is emitted.
    expect(events.some((e) => e.kind === "system" && e.message === MINOR_SAFETY_REFUSAL)).toBe(true);
    expect(events.some((e) => e.kind === "narration")).toBe(false);
  });

  test("a block on a NON-streamed beat retracts nothing (no live stub to remove)", async () => {
    const { ctx, events, retracts } = fakeCtxWithClient();

    // A DM that never streams (buffered turn) but blocks: there is no live buffer, so no retract.
    await narrateGuarded(ctx, STATE, dmReturning({ text: "", blocked: true }), NCTX);

    expect(retracts).toEqual([]);
    expect(events.some((e) => e.kind === "system" && e.message === MINOR_SAFETY_REFUSAL)).toBe(true);
  });
});

describe("narrateGuarded — semantic verification is a release gate", () => {
  test("a verifier outage releases no model tokens and uses deterministic engine prose", async () => {
    const { ctx, events, tokens } = fakeCtxWithJudge({
      adjudicate: async () => ({ violations: [], semanticVerified: false }),
    });

    await narrateGuarded(ctx, STATE, dmStreaming("The invented gate opens."), NCTX);

    expect(tokens).toEqual([]);
    expect(events.filter((e) => e.kind === "narration")).toEqual([
      expect.objectContaining({ text: "You pry at the rusted grate." }),
    ]);
  });

  test("persistent continuity violations never degrade to a least-bad generated candidate", async () => {
    const { ctx, events, tokens } = fakeCtxWithJudge({
      adjudicate: async () => ({
        semanticVerified: true,
        violations: [
          {
            kind: "phantomState",
            detail: "the gate opened without a command",
            correction: "Keep the gate closed.",
          },
        ],
      }),
    });
    let calls = 0;
    const dm = {
      narrate: async () => {
        calls++;
        return { text: "The invented gate opens." };
      },
    } as unknown as DungeonMaster;

    await narrateGuarded(ctx, STATE, dm, NCTX);

    expect(calls).toBe(2); // initial candidate + the one bounded correction (MAX_JUDGE_REGEN = 1)
    expect(tokens).toEqual([]);
    expect(events.filter((e) => e.kind === "narration")).toEqual([
      expect.objectContaining({ text: "You pry at the rusted grate." }),
    ]);
  });
});

describe("narrateGuarded — the turn auditor records the ARBITER's verdict, not the raw floor (r12)", () => {
  // "The heavy door swings open before you." trips the Tier-1 door pattern with no authorizing
  // command — the shape of every r12 sweep finding: an over-inclusive floor flag on prose the
  // semantic tier is the designated arbiter for.
  const DOOR = "The heavy door swings open before you.";

  test("prose the Judge positively CLEARED records no audit violations", async () => {
    const { ctx, events } = fakeCtxWithJudge({
      adjudicate: async () => ({ violations: [], semanticVerified: true }),
    });

    await narrateGuarded(ctx, STATE, dmReturning({ text: DOOR }), NCTX);

    expect(events.filter((e) => e.kind === "narration")).toEqual([expect.objectContaining({ text: DOOR })]);
    expect((ctx.data as Record<string, unknown>).auditViolations).toBeUndefined();
  });

  test("without a Judge, the raw Tier-1 screen remains the machine record", async () => {
    const { ctx, events } = fakeCtxWithClient();
    Object.assign(ctx as unknown as Record<string, unknown>, {
      model: { entities: new Map(), modules: {} },
      queue: [],
      data: {},
      dryRun: () => ({ mutated: false }),
    });

    await narrateGuarded(ctx, STATE, dmReturning({ text: DOOR }), NCTX);

    expect(events.filter((e) => e.kind === "narration")).toEqual([expect.objectContaining({ text: DOOR })]);
    const audit = (ctx.data as Record<string, unknown>).auditViolations as { kind: string }[];
    expect(audit?.some((v) => v.kind === "phantomState")).toBe(true);
  });

  test("a floor-enforced turn (regens exhausted) still audits the SHIPPED text with the raw screen", async () => {
    // The Judge keeps confirming a violation; the floor replaces the prose with the trigger echo.
    // The echo carries no phantom claim, so the raw screen of the shipped text is clean — but the
    // path must go through the raw screen (cleared=false), not the arbiter-cleared skip.
    const { ctx } = fakeCtxWithJudge({
      adjudicate: async () => ({
        semanticVerified: true,
        violations: [{ kind: "phantomState", detail: "gate", correction: "Keep the gate closed." }],
      }),
    });

    await narrateGuarded(ctx, STATE, dmReturning({ text: DOOR }), NCTX);

    const audit = (ctx.data as Record<string, unknown>).auditViolations as { kind: string }[] | undefined;
    expect(audit ?? []).toEqual([]);
  });

  test("the engine's OWN echo is never audited — there is no model claim to screen (r13)", async () => {
    // r13 shipped four confirmed findings off one deterministic line: the narrator returned nothing,
    // so the engine emitted its trigger echo including the honest left-behind notice, and the Tier-1
    // floor read that notice as a castPresence violation (it names an absent NPC on purpose) AND a
    // phantomCompanion (the accompaniment phrase, negated). Engine prose is composed from committed
    // truth; screening it can only manufacture violations.
    const { ctx } = fakeCtxWithClient();
    Object.assign(ctx as unknown as Record<string, unknown>, {
      model: { entities: new Map(), modules: {} },
      queue: [],
      data: {},
      dryRun: () => ({ mutated: false }),
    });
    const echoNctx = {
      contextText: "",
      trigger: "You travel to Anchorfall. The heavy door swings open before you.",
      castGuard: { present: [], absent: ["Brann Coldwater"] },
    } as unknown as NarrationContext;

    await narrateGuarded(ctx, STATE, dmReturning({ text: "   " }), echoNctx);

    expect((ctx.data as Record<string, unknown>).auditViolations).toBeUndefined();
  });

  test("a Judge fail-closed floor that ships ENGINE prose is never audited (r14)", async () => {
    // fixture-work t7, three rounds running: the judge failed closed on a travel turn, the floor shipped
    // the deterministic echo whose own honest left-behind notice names the absent NPC, and the raw
    // screen recorded a castPresence violation off the engine's own absence device. Floor text that
    // is engine-composed (absence echo / trigger echo) carries no model claim to screen.
    const { ctx } = fakeCtxWithJudge({
      adjudicate: async () => ({
        semanticVerified: false,
        violations: [
          { kind: "castPresence", offender: "Sergeant Veil", detail: "elsewhere", correction: "Do not mention them." },
        ],
      }),
    });
    const nctx = {
      contextText: "",
      trigger: "You travel to Fenwall. (Sergeant Veil stays behind — they are not travelling with you)",
      castGuard: { present: [], absent: ["Sergeant Veil"] },
    } as unknown as NarrationContext;

    // One short all-offending sentence: the strip leaves nothing shippable, so the floor falls to
    // engine prose (the absence echo / trigger echo) — the exact r14 leak path.
    await narrateGuarded(ctx, STATE, dmReturning({ text: "Sergeant Veil stays behind at her board." }), nctx);

    expect((ctx.data as Record<string, unknown>).auditViolations).toBeUndefined();
  });

  test("a Judge floor that keeps SCRUBBED MODEL prose still audits it (the skip tracks provenance)", async () => {
    const { ctx } = fakeCtxWithJudge({
      adjudicate: async () => ({
        semanticVerified: false,
        violations: [
          { kind: "castPresence", offender: "Sergeant Veil", detail: "elsewhere", correction: "Do not mention them." },
        ],
      }),
    });
    const nctx = {
      contextText: "",
      trigger: "You pry at the rusted grate.",
      castGuard: { present: [], absent: ["Sergeant Veil"] },
    } as unknown as NarrationContext;

    // The Veil sentence is stripped; the surviving model prose (> 60 chars) still asserts a door
    // opening no command authorized — the raw screen of SHIPPED MODEL text keeps its record.
    await narrateGuarded(
      ctx,
      STATE,
      dmReturning({
        text:
          "Sergeant Veil waves from the road. The heavy door swings open before you onto the long candlelit hall beyond.",
      }),
      nctx,
    );

    const audit = (ctx.data as Record<string, unknown>).auditViolations as { kind: string }[] | undefined;
    expect(audit?.some((v) => v.kind === "phantomState")).toBe(true);
    expect(audit?.some((v) => v.kind === "castPresence")).toBe(false);
  });

  test("MODEL prose carrying the same claims is still audited (the skip is not a blanket mute)", async () => {
    const { ctx } = fakeCtxWithClient();
    Object.assign(ctx as unknown as Record<string, unknown>, {
      model: { entities: new Map(), modules: {} },
      queue: [],
      data: {},
      dryRun: () => ({ mutated: false }),
    });
    const nctx = {
      contextText: "",
      trigger: "You pry at the rusted grate.",
      castGuard: { present: [], absent: ["Brann Coldwater"] },
    } as unknown as NarrationContext;

    // The legacy cast-guard tier clears it (the semantic call is the arbiter for mention-vs-staged);
    // the raw Tier-1 screen of the SHIPPED model prose is what this test pins.
    const dm = {
      narrate: async () => ({
        text: "Brann Coldwater falls into step beside you and the heavy door swings open.",
      }),
      verifyCast: async () => [],
    } as unknown as DungeonMaster;

    await narrateGuarded(ctx, STATE, dm, nctx);

    const audit = (ctx.data as Record<string, unknown>).auditViolations as { kind: string }[] | undefined;
    expect(audit?.map((v) => v.kind).sort()).toEqual(["castPresence", "phantomCompanion", "phantomState"]);
  });
});

describe("narrateGuarded — SEED_JUDGE_STREAM_CLEAN streams provably-clean judged turns live", () => {
  /** Flip the opt-in on for a judged ctx. */
  const enableStreamClean = (ctx: TickContext): void => {
    (ctx.services as unknown as Record<string, unknown>).judgeStreamClean = true;
  };

  test("a pre-gen-clean turn streams tokens live and settles the streamed prose (no retract)", async () => {
    const { ctx, events, tokens, retracts } = fakeCtxWithJudge({
      adjudicate: async () => ({ violations: [], semanticVerified: true }),
    });
    enableStreamClean(ctx);

    await narrateGuarded(ctx, STATE, dmStreaming("The hearth pops."), NCTX);

    // Live streaming restored despite a configured Judge: tokens reached the client mid-generation
    // (the release-gate tests above prove the SAME shape BUFFERS when the flag is off).
    expect(tokens.map((t) => t.delta)).toEqual(["The hearth pops."]);
    expect(retracts).toEqual([]);
    const narration = events.filter((e) => e.kind === "narration");
    expect(narration.length).toBe(1);
    expect(narration[0]).toMatchObject({ text: "The hearth pops." });
  });

  test("an escalation-risk turn (established facts) still BUFFERS even with the flag on", async () => {
    const { ctx, tokens } = fakeCtxWithJudge({
      adjudicate: async () => ({ violations: [], semanticVerified: true }),
    });
    enableStreamClean(ctx);
    const withFact = { ...NCTX, established: ["The bridge is out."] } as NarrationContext;

    await narrateGuarded(ctx, STATE, dmStreaming("You cross the bridge."), withFact);

    // Established facts are a pre-generation escalation risk — ineligible, so the buffer holds and no
    // token leaks live before the Judge has verified.
    expect(tokens).toEqual([]);
  });

  test("a streamed candidate the Judge replaces is retracted before the corrected prose settles", async () => {
    const { ctx, events, tokens, retracts } = fakeCtxWithJudge({
      adjudicate: async () => ({
        semanticVerified: true,
        violations: [
          { kind: "phantomState", detail: "the gate opened without a command", correction: "Keep the gate closed." },
        ],
      }),
    });
    enableStreamClean(ctx);

    await narrateGuarded(ctx, STATE, dmStreaming("The invented gate opens."), NCTX);

    // The original streamed live...
    expect(tokens.map((t) => t.delta)).toEqual(["The invented gate opens."]);
    // ...then the Judge flagged it: the stale live stub is retracted and the deterministic echo settles
    // (flash-then-retract — the accepted cost of the opt-in on the rare post-stream flag).
    expect(retracts.length).toBe(1);
    expect(events.filter((e) => e.kind === "narration")).toEqual([
      expect.objectContaining({ text: "You pry at the rusted grate." }),
    ]);
  });
});

describe("triggerEcho", () => {
  test("strips combat scene-setting directives with qualifiers (N1)", () => {
    const echo = triggerEcho({
      contextText: "",
      trigger:
        "Crag Wolf turns on You — no words, only violence. Set the ambush scene in a sentence or two; do not narrate individual blows.",
    } as NarrationContext);

    expect(echo).toBe("Crag Wolf turns on You — no words, only violence");
    expect(echo).not.toContain("Set the ambush scene");
    expect(echo).not.toContain("do not narrate");
  });

  test("restates the resolved verdict when mechanics are present", () => {
    const echo = triggerEcho({
      contextText: "",
      trigger: "You pick the lock.",
      resolved: { label: "Dexterity (Stealth) check", dc: 13, total: 17, success: true, critical: null },
    } as NarrationContext);
    expect(echo).toContain("You pick the lock.");
    expect(echo).toContain("success");
    expect(echo).toContain("17");
    expect(echo).toContain("DC 13");
  });

  test("never returns an empty string", () => {
    expect(triggerEcho({ contextText: "", trigger: "  " } as NarrationContext).length).toBeGreaterThan(0);
  });

  test("prefers echoFallback over the raw trigger, so an event never leaks its authoring brief", () => {
    // The observed leak: an action label doubled with the appended bad-end narratorBrief.
    const echo = triggerEcho({
      contextText: "",
      trigger: "Give in\n\n(Narrate the imposed beat.)\n\nYour captor frames release as a price you now owe: a tribute-bond.",
      echoFallback: "The moment ends, and its cost settles over you.",
    } as NarrationContext);
    expect(echo).toBe("The moment ends, and its cost settles over you.");
    expect(echo).not.toContain("Give in");
    expect(echo).not.toContain("Narrate");
    expect(echo).not.toContain("tribute-bond");
  });
});

describe("castAbsenceEcho — honest absence over the shrug (r4)", () => {
  const nctx = { contextText: "", trigger: "seed" } as NarrationContext;

  test("all-castPresence violations name the missing character instead of 'The moment passes.'", () => {
    const echo = castAbsenceEcho([{ kind: "castPresence", offender: "Sorrel" }], nctx);
    expect(echo).toBe("There is no sign of Sorrel here.");
  });

  test("multiple offenders list; NPC beats still surface first", () => {
    const echo = castAbsenceEcho(
      [
        { kind: "castPresence", offender: "Sorrel" },
        { kind: "castPresence", offender: "Toller" },
      ],
      {
        ...nctx,
        beats: [{ name: "Brann", dialogue: "She was here. I paid for the cup myself." }],
      } as NarrationContext,
    );
    expect(echo).toContain('Brann: "She was here. I paid for the cup myself."');
    expect(echo).toContain("There is no sign of Sorrel and Toller here.");
  });

  test("a mixed violation set stays on the generic echo path (returns null)", () => {
    expect(
      castAbsenceEcho([{ kind: "castPresence", offender: "Sorrel" }, { kind: "timeDrift" }], nctx),
    ).toBeNull();
    expect(castAbsenceEcho([{ kind: "castPresence" }], nctx)).toBeNull(); // no named offender
    expect(castAbsenceEcho([], nctx)).toBeNull();
  });

  test("castGuardEcho adapts the legacy path's bare offender NAMES to the same floor", () => {
    expect(castGuardEcho(["Sorrel"], nctx)).toBe("There is no sign of Sorrel here.");
    expect(castGuardEcho([], nctx)).toBeNull();
    expect(castGuardEcho(["  "], nctx)).toBeNull();
  });

  // ── r5: what the floor is allowed to SAY ───────────────────────────────────────────────────────

  test("an offender that is a sentence, not a name, never reaches the page", () => {
    const junk = "The prose references 'Jessup' as a named character with a cart, but Jessup is not present.";
    expect(castAbsenceEcho([{ kind: "castPresence", offender: junk }], nctx)).toBeNull();
  });

  test("someone standing right here is never announced absent", () => {
    // The r5 transcript, verbatim: Oda's own reply ended "There is no sign of Oda the Wayfarer here."
    expect(
      castAbsenceEcho([{ kind: "castPresence", offender: "Oda the Wayfarer" }], nctx, { present: ["Oda"] }),
    ).toBeNull();
  });

  test("a name the turn's roster never knew is dropped (no phantom people to chase)", () => {
    expect(
      castAbsenceEcho([{ kind: "castPresence", offender: "One of the Standing" }], nctx, {
        present: ["Oda"],
        absent: ["Kella Vane"],
      }),
    ).toBeNull();
    expect(
      castAbsenceEcho([{ kind: "castPresence", offender: "Kella Vane" }], nctx, {
        present: ["Oda"],
        absent: ["Kella Vane"],
      }),
    ).toBe("There is no sign of Kella Vane here.");
  });

  test("the turn's OUTCOME survives the absence line (a successful check is never blanked)", () => {
    // r5 P1: WISDOM (PERCEPTION) DC 13 → 15, SUCCESS, and the entire prose the player received was
    // "There is no sign of Bram here."
    const resolvedNctx = {
      ...nctx,
      echoFallback: "It works — the attempt holds, though the full telling is lost to the moment.",
      resolved: { label: "Wisdom (perception) check", success: true, total: 15, dc: 13 },
    } as NarrationContext;
    const echo = castAbsenceEcho([{ kind: "castPresence", offender: "Bram" }], resolvedNctx);
    expect(echo).toContain("It works");
    expect(echo).toContain("Wisdom (perception) check: success — 15 vs DC 13.");
    expect(echo).toContain("There is no sign of Bram here.");
  });
});

/**
 * r5: r4 shipped the honest-absence floor on the regen-EXHAUSTED branch only. A verifier outage
 * still knows who is absent (`adjudicate` returns the Tier-1 screen's own violations alongside
 * `semanticVerified:false`, and `castPresence` is deterministic), so that branch must name the
 * absence too. These drive the real `narrateGuarded` flow rather than the pure helper.
 */
describe("narrateGuarded — a verifier outage on an absent-cast turn names the absence", () => {
  const nctx = {
    contextText: "",
    trigger: "You look for her.",
    castGuard: { present: ["Brann Coldwater"], absent: ["Sorrel"] },
  } as NarrationContext;

  test("semanticVerified:false with castPresence violations ⇒ the named absence, not the shrug", async () => {
    const judge = {
      adjudicate: async () => ({
        violations: [{ kind: "castPresence", offender: "Sorrel", detail: "", correction: "" }],
        semanticVerified: false,
      }),
    };
    const { ctx, events } = fakeCtxWithJudge(judge);

    await narrateGuarded(ctx, STATE, dmReturning({ text: "Sorrel leans back and smiles." }), nctx);

    const narration = events.filter((e) => e.kind === "narration");
    expect(narration.length).toBe(1);
    expect((narration[0] as { text: string }).text).toContain("There is no sign of Sorrel here.");
    expect((narration[0] as { text: string }).text).not.toContain("The moment passes.");
  });

  test("semanticVerified:false with a NON-cast violation keeps the generic deterministic echo", async () => {
    const judge = {
      adjudicate: async () => ({
        violations: [{ kind: "timeDrift", detail: "", correction: "" }],
        semanticVerified: false,
      }),
    };
    const { ctx, events } = fakeCtxWithJudge(judge);

    await narrateGuarded(ctx, STATE, dmReturning({ text: "Dawn breaks over the road." }), nctx);

    const narration = events.filter((e) => e.kind === "narration");
    expect(narration.length).toBe(1);
    expect((narration[0] as { text: string }).text).toBe("You look for her.");
  });

  test("prose that only MENTIONS the absent character keeps everything else it said (r5)", async () => {
    // The whole turn used to die for one stray sentence — a successful search of a sheep pen came
    // back as nothing but the absence stub. Scrub the sentence, ship the findings.
    const judge = {
      adjudicate: async () => ({
        violations: [{ kind: "castPresence", offender: "Sorrel", detail: "", correction: "" }],
        semanticVerified: false,
      }),
    };
    const { ctx, events } = fakeCtxWithJudge(judge);
    const prose =
      "The pen gate hangs on one hinge, and the mud below it holds two sets of prints. Sorrel would know whose boot that was. " +
      "The deeper set stops dead at the wall, as if whoever made it was carrying something heavy.";

    await narrateGuarded(ctx, STATE, dmReturning({ text: prose }), nctx);

    const text = (events.find((e) => e.kind === "narration") as { text: string }).text;
    expect(text).toContain("two sets of prints");
    expect(text).toContain("carrying something heavy");
    expect(text).not.toContain("Sorrel");
  });
});

describe("stripNarratorDirective — trailing directives only (regex audit §8g)", () => {
  // The shipped shape was one `/^(.*?)…\.*$/is` match: the LAZY head found the FIRST
  // directive-shaped sentence anywhere in the trigger and the greedy `.*$` under `/s` ate every
  // sentence after it. Both of these were reproduced against the shipped function; both triggers
  // carry the player's own typed line (engine.ts's `You speak to X: "…"` and the freeform echo).
  test("a directive-shaped sentence with real prose after it is prose, and survives whole", () => {
    const line = "You keep your voice low. Don't move, you tell the guard. Then you slip the knife from your boot.";
    expect(stripNarratorDirective(line)).toBe(line); // was: "You keep your voice low"
  });

  test("a cut is never taken inside an open quote", () => {
    const line = 'You speak to Oda: "I tell him to hurry. Don\'t wait for the guard."';
    expect(stripNarratorDirective(line)).toBe(line); // was: 'You speak to Oda: "I tell him to hurry'
  });

  // …and every engine-authored directive still strips, byte-for-byte as before.
  test("the shipped engine directives all still strip", () => {
    const cases: [string, string][] = [
      [
        "Crag Wolf turns on You — no words, only violence. Set the ambush scene in a sentence or two; do not narrate individual blows.",
        "Crag Wolf turns on You — no words, only violence",
      ],
      [
        "The ploy works — the threat loses interest and withdraws from the fight. Describe the disengagement in a sentence or two; nobody swings again.",
        "The ploy works — the threat loses interest and withdraws from the fight",
      ],
      [
        "You come to later, barely alive. Describe the grim awakening in a sentence or two.",
        "You come to later, barely alive",
      ],
      [
        "The fighting stops. Describe the aftermath in a sentence or two — the fallen do not rise or act.",
        "The fighting stops",
      ],
      [
        "Blows are traded — Oda hits the wight for 5; the wight misses. Narrate this exchange in one or two vivid sentences, keeping every outcome exactly as stated (no new wounds, falls, or escapes).",
        "Blows are traded — Oda hits the wight for 5; the wight misses",
      ],
      [
        "You are FREE — you break out of the cell and get clear before the alarm can rise. Narrate the escape and the player back on the outside, gear reclaimed.",
        "You are FREE — you break out of the cell and get clear before the alarm can rise",
      ],
      [
        '"The bond is settled" is settled — everything it asked has been done, and the matter closes for good (dues paid, word sent). Let the closure land in a sentence; do not reopen it.',
        '"The bond is settled" is settled — everything it asked has been done, and the matter closes for good (dues paid, word sent)',
      ],
    ];
    for (const [input, want] of cases) expect(stripNarratorDirective(input)).toBe(want);
  });

  test("(GM: …) notes are still stripped wherever they sit", () => {
    expect(
      stripNarratorDirective(
        "You pry at the rusted grate (GM: they have been here before — do not restage the arrival you already gave it; open on what has changed since: the hour, who is about, what is different.)",
      ),
    ).toBe("You pry at the rusted grate");
  });
});

/**
 * r11 P2 — the token cap cut the prose mid-clause. `finish_reason: "length"` on a NON-EMPTY
 * completion is the sibling of the reasoning-burn case the provider already retries: there the
 * model spent the whole budget thinking and returned nothing; here it spent PART of it and the
 * visible sentence was severed. Ten of the sweep's 120 turns shipped one — 41 to 1088 characters,
 * always ending mid-clause, and nothing anywhere flagged it. One of them was the whole turn:
 * "The chalk is fresh, the letters blocky and".
 */
describe("truncated narration (r11 P2)", () => {
  /** First call truncates; the retry (which the wrapper makes at a wider budget) finishes. */
  const dmTruncatingThenWhole = (stump: string, whole: string): DungeonMaster => {
    let calls = 0;
    return {
      narrate: async (_s: unknown, _c: unknown, opts?: { onToken?: (d: string) => void }) => {
        calls += 1;
        if (calls === 1) {
          opts?.onToken?.(stump);
          return { text: stump, truncated: true };
        }
        return { text: whole };
      },
    } as unknown as DungeonMaster;
  };

  /** Every call truncates — the retry buys nothing, so the notice has to carry the honesty. */
  const dmAlwaysTruncating = (stump: string): DungeonMaster =>
    ({ narrate: async () => ({ text: stump, truncated: true }) }) as unknown as DungeonMaster;

  test("REPRO — a cut-off turn is re-narrated at a wider budget and the whole scene ships", async () => {
    const { ctx, events } = fakeCtx();
    const whole = "The chalk is fresh, the letters blocky and squared-off — a working hand, not a clerk's.";

    await narrateGuarded(ctx, STATE, dmTruncatingThenWhole("The chalk is fresh, the letters blocky and", whole), NCTX);

    const narration = events.filter((e) => e.kind === "narration");
    expect(narration.length).toBe(1);
    expect(narration[0]).toMatchObject({ text: whole });
    // A retry that worked is invisible: no notice, nothing for the player to read about it.
    expect(events.some((e) => e.kind === "system" && e.code === "narrator-truncated")).toBe(false);
  });

  test("a live stub is RETRACTED before the fuller prose settles", async () => {
    const { ctx, events, tokens, retracts } = fakeCtxWithClient();
    const whole = "The chalk is fresh, the letters blocky and squared-off — a working hand.";

    await narrateGuarded(ctx, STATE, dmTruncatingThenWhole("The chalk is fresh, the letters blocky and", whole), NCTX);

    expect(tokens.length).toBeGreaterThan(0); // the stump really did reach the screen
    expect(retracts.length).toBe(1); // ...and was pulled back
    expect(events.filter((e) => e.kind === "narration")[0]).toMatchObject({ text: whole });
  });

  test("when the retry truncates too, the prose still ships — and the cut is NAMED", async () => {
    const { ctx, events } = fakeCtx();
    const stump = "The chalk is fresh, the letters blocky and";

    await narrateGuarded(ctx, STATE, dmAlwaysTruncating(stump), NCTX);

    expect(events.filter((e) => e.kind === "narration")[0]).toMatchObject({ text: stump });
    const notice = events.find((e) => e.kind === "system" && e.code === "narrator-truncated");
    expect(notice).toBeDefined();
    // r11 P2's other half: what the player reads must not be an operator's remedy.
    expect((notice as { message: string }).message).not.toMatch(/SEED_[A-Z_]+/);
  });

  test("an untruncated turn is untouched — no retry, no notice", async () => {
    const { ctx, events } = fakeCtx();

    await narrateGuarded(ctx, STATE, dmReturning({ text: "A whole, finished sentence." }), NCTX);

    expect(events.filter((e) => e.kind === "narration")[0]).toMatchObject({ text: "A whole, finished sentence." });
    expect(events.some((e) => e.kind === "system" && e.code === "narrator-truncated")).toBe(false);
  });
});
