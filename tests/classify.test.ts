/**
 * Classifier tests — the LLM classifier (the ONLY product classifier) and its
 * validate/repair pass. The model path is exercised directly through a scripted gateway:
 * canned JSON in, grounded TurnPlan out, freeform on double failure — never a guess.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  buildClassifyUserMessage,
  CLASSIFIER_SYSTEM_PROMPT,
  makeLlmClassifier,
  reconcilePlan,
  TURN_PLAN_JSON_SCHEMA,
} from "../src/engine/classify.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { CompletionChunk, CompletionResult, EmbeddingResult } from "../src/llm/types.ts";
import { TurnKindSchema, type ClassifierContext } from "../src/engine/turn-plan.ts";

const CTX: ClassifierContext = {
  playerActorId: "pc.you",
  locationId: "loc.tavern",
  locationName: "The Ashen Tankard",
  exits: [{ id: "loc.square", name: "Emberford Square" }],
  presentEntities: [
    { id: "npc.lyra", name: "Lyra Vane" },
    { id: "npc.brann", name: "Brann" },
  ],
  companionIds: ["npc.lyra"],
};

const ITEM_CTX: ClassifierContext = {
  ...CTX,
  presentEntities: [...CTX.presentEntities, { id: "npc.bett", name: "Bett" }],
  carriedItems: [
    { id: "item.potion-healing", name: "Potion of Healing" },
    { id: "weapon.longsword", name: "Longsword" },
    { id: "weapon.dagger", name: "Dagger" },
    { id: "armor.chain-shirt", name: "Chain Shirt" },
  ],
};

const QUEST_CTX: ClassifierContext = {
  ...CTX,
  offeredQuests: [{ id: "quest.caravan", name: "The Missing Caravan" }],
};

const baseCheck = { warranted: false, ability: null, skill: null, dc: null, reason: "" };

// ---------------------------------------------------------------------------
// The LLM path — scripted utility-role gateway
// ---------------------------------------------------------------------------

/** A gateway whose utility role replies with each scripted answer in turn (a thrown Error
 * entry rejects). Prose/embedding roles are never expected here and throw loudly. */
function scriptedGateway(replies: Array<string | Error>): { gateway: LlmGateway; calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  const gateway: LlmGateway = {
    complete(role): Promise<CompletionResult> {
      if (role !== "utility") throw new Error(`unexpected role ${role} in classifier test`);
      const reply = replies[Math.min(i, replies.length - 1)]!;
      calls.push(i);
      i += 1;
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ text: reply, model: "scripted" });
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<CompletionChunk> {
      throw new Error("classifier never streams");
    },
    embed(): Promise<EmbeddingResult> {
      throw new Error("classifier never embeds");
    },
  };
  return { gateway, calls };
}

const movementJson = JSON.stringify({
  kind: "movement",
  targetId: null,
  destinationLocationId: "loc.square",
  item: null,
  trade: null,
  party: null,
  quest: null,
  check: { warranted: false, ability: null, skill: null, dc: null, reason: "travel" },
  confidence: 0.9,
});

describe("makeLlmClassifier (the product classifier)", () => {
  test("the prompt distinguishes an in-world work request from metaOOC (N3)", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("point me to the fastest, safest paying work");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("NOT metaOOC");
  });

  test("r3 fix-wave prompt pins: high-stakes deception rolls, quantities survive", () => {
    // A high-stakes lie to a guarded NPC is a cha/Deception check, never plain dialogue (r3 P4).
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("HIGH-STAKES lie or deception");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("the roll decides whether the lie lands");
    // Typed buy quantities reach the trade payload (r3 P3: "two rations" silently bought one).
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("trade.quantity is the NUMBER of units");
  });

  test("r4 fix-wave prompt pins: roofed sleep is lodging, refusal never presents, improvisation rolls", () => {
    // "Take a cot in the loft" fired MAKE CAMP: spent a ration, charged no coin, and the camp
    // narrator invented a road (r4 P1). A named cot/bunk/loft/room under an authored roof is rentRoom.
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("authored ROOF is never enterCamp");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("take a cot in the loft");
    // An explicit withholding was executed as "You lay the evidence before Lys" (r4 P2).
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("REFUSING or WITHHOLDING is never caseAction");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("actually SHOW the evidence now");
    // A described fire-brand maneuver was flattened into the default club swing (r4 P2).
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("snatching a burning brand");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("even mid-combat");
  });

  test("r5 fix-wave prompt pin: addressing an absent person stays dialogueToNpc", () => {
    // The player was told "she's here", addressed her, and the turn degraded to freeform — whose
    // echo is the content-free "The moment passes." (r4 P1). The engine can only answer honestly
    // if the intent still arrives as dialogueToNpc with a null target.
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('is STILL "dialogueToNpc", with targetId null');
    // Refusal stopped being executed as its opposite in r4; r5 makes it RECORD something.
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"withhold", is for the REFUSAL described above');
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("Withholding never teaches them the fact");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("do not downgrade it to\n  freeformNarrative");
  });

  test("valid model JSON grounds to a movement plan", async () => {
    const { gateway } = scriptedGateway([movementJson]);
    const plan = await makeLlmClassifier(gateway).classify("go to the square", CTX);
    expect(plan.kind).toBe("movement");
    expect(plan.destinationLocationId).toBe("loc.square");
  });

  test("fenced/prose-wrapped JSON is still extracted", async () => {
    const { gateway } = scriptedGateway(["Here you go:\n```json\n" + movementJson + "\n```"]);
    const plan = await makeLlmClassifier(gateway).classify("go to the square", CTX);
    expect(plan.kind).toBe("movement");
  });

  test("one bad reply is retried transparently; the retry's answer wins", async () => {
    const { gateway, calls } = scriptedGateway(["not json at all", movementJson]);
    const plan = await makeLlmClassifier(gateway).classify("go to the square", CTX);
    expect(plan.kind).toBe("movement");
    expect(calls.length).toBe(2);
  });

  test("two failures degrade to freeform (never a guess) and report through onFallback", async () => {
    const { gateway } = scriptedGateway([new Error("boom"), new Error("boom again")]);
    let reported = "";
    const plan = await makeLlmClassifier(gateway, (reason) => {
      reported = reason;
    }).classify("I attack Brann", CTX);
    expect(plan.kind).toBe("freeformNarrative");
    expect(plan.targetId).toBeNull();
    expect(reported).toContain("boom");
  });

  test("a hallucinated destination is not trusted as an exit — nulled, and reached as a named place", async () => {
    const raw = JSON.parse(movementJson);
    raw.destinationLocationId = "loc.moon";
    const { gateway } = scriptedGateway([JSON.stringify(raw)]);
    const plan = await makeLlmClassifier(gateway).classify("go to the moon", CTX);
    // The bogus id is NOT trusted as a listed exit (nulled) — but the line stays a movement: the
    // engine reaches the named place on the fly rather than refusing (B1 open-world reach).
    expect(plan.kind).toBe("movement");
    expect(plan.destinationLocationId).toBeNull();
    expect(plan.movementMiss).toBe(true);
  });

  test("a refusal-shaped reply (no JSON) degrades to freeform after the retry", async () => {
    const { gateway, calls } = scriptedGateway(["I cannot classify that request."]);
    const plan = await makeLlmClassifier(gateway).classify("do the thing", CTX);
    expect(plan.kind).toBe("freeformNarrative");
    expect(calls.length).toBe(2);
  });
});

describe("classifier kind contract", () => {
  test("the JSON-schema kinds are all recognized by the TurnKind Zod schema", () => {
    const jsonKinds = TURN_PLAN_JSON_SCHEMA.properties.kind.enum;
    for (const kind of jsonKinds) expect(TurnKindSchema.safeParse(kind).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reconcilePlan — the shared grounding/repair pass
// ---------------------------------------------------------------------------

describe("reconcilePlan — movement miss (open-world reach)", () => {
  const rawMove = (dest: string | null) => ({
    kind: "movement",
    targetId: null,
    destinationLocationId: dest,
    check: baseCheck,
    confidence: 0.9,
  });

  test("a grounded movement passes through with no miss flag", () => {
    const p = reconcilePlan(rawMove("loc.square"), CTX);
    expect(p.kind).toBe("movement");
    expect(p.destinationLocationId).toBe("loc.square");
    expect(p.movementMiss).toBeUndefined();
  });

  test("a movement to a place with no matching exit STAYS movement, flags the miss, carries the name", () => {
    const p = reconcilePlan({ ...rawMove(null), destinationName: "the pens" }, CTX);
    expect(p.kind).toBe("movement");
    expect(p.destinationLocationId).toBeNull();
    expect(p.movementMiss).toBe(true);
    expect(p.destinationName).toBe("the pens");
  });

  test("solo travels through on any movement — grounded OR a reach miss", () => {
    const grounded = reconcilePlan({ ...rawMove("loc.square"), solo: true }, CTX);
    expect(grounded.kind).toBe("movement");
    expect(grounded.solo).toBe(true);
    // A solo flag now SURVIVES an ungrounded (reach) movement too — the party still splits.
    const missed = reconcilePlan({ ...rawMove("loc.nope"), solo: true }, CTX);
    expect(missed.kind).toBe("movement");
    expect(missed.movementMiss).toBe(true);
    expect(missed.solo).toBe(true);
  });
});

describe("reconcilePlan — fuzzy exit grounding (W1)", () => {
  // A richer exit surface: prose names, a direction, and a state tag on one name.
  const FUZZY_CTX: ClassifierContext = {
    ...CTX,
    exits: [
      { id: "loc.square", name: "Emberford Square", direction: "north" },
      { id: "loc.mill", name: "The Old Mill (locked)", direction: "west" },
    ],
  };
  const rawMove = (dest: string | null) => ({
    kind: "movement",
    targetId: null,
    destinationLocationId: dest,
    check: baseCheck,
    confidence: 0.9,
  });

  test("a prose place name (not an id) grounds to its exit", () => {
    const p = reconcilePlan(rawMove("Emberford Square"), FUZZY_CTX);
    expect(p.kind).toBe("movement");
    expect(p.destinationLocationId).toBe("loc.square");
  });

  test("a direction word grounds via the authored exit direction", () => {
    const p = reconcilePlan(rawMove("west"), FUZZY_CTX);
    expect(p.kind).toBe("movement");
    expect(p.destinationLocationId).toBe("loc.mill");
  });

  test("a substring/partial name grounds by unique token overlap", () => {
    const p = reconcilePlan(rawMove("the square"), FUZZY_CTX);
    expect(p.destinationLocationId).toBe("loc.square");
  });

  test("the raw player line grounds even when the model's guess is null", () => {
    const p = reconcilePlan(rawMove(null), FUZZY_CTX, "I head to the old mill");
    expect(p.kind).toBe("movement");
    expect(p.destinationLocationId).toBe("loc.mill");
  });

  test("an ambiguous destination doesn't guess an exit — stays movement + movementMiss (reach)", () => {
    const ambiguous: ClassifierContext = {
      ...CTX,
      exits: [
        { id: "loc.old-mill", name: "The Old Mill" },
        { id: "loc.new-mill", name: "The New Mill" },
      ],
    };
    // A tie won't pick old-mill vs new-mill (destinationLocationId nulled), but the line stays a
    // movement — the engine reaches "the mill" (reuse/generate) rather than refusing.
    const p = reconcilePlan(rawMove("the mill"), ambiguous);
    expect(p.kind).toBe("movement");
    expect(p.destinationLocationId).toBeNull();
    expect(p.movementMiss).toBe(true);
  });

  test("a prose-only place the map can't back → movement + movementMiss (open-world reach)", () => {
    const p = reconcilePlan(rawMove("Tanner's Bridge"), FUZZY_CTX, "I cross Tanner's Bridge");
    expect(p.kind).toBe("movement");
    expect(p.destinationLocationId).toBeNull();
    expect(p.movementMiss).toBe(true);
    expect(p.destinationName).toBe("Tanner's Bridge");
  });
});

describe("reconcilePlan — questAction grounding", () => {
  const rawQuestPlan = (questId: string | null) => ({
    kind: "questAction",
    targetId: null,
    destinationLocationId: null,
    check: baseCheck,
    quest: { verb: "accept", questId },
    confidence: 0.9,
  });

  test("a grounded questAction passes through with its payload", () => {
    const p = reconcilePlan(rawQuestPlan("quest.caravan"), QUEST_CTX);
    expect(p.kind).toBe("questAction");
    expect(p.quest).toEqual({ verb: "accept", questId: "quest.caravan" });
  });

  test("a hallucinated quest id is repaired to the SINGLE offered quest", () => {
    const p = reconcilePlan(rawQuestPlan("quest.invented"), QUEST_CTX);
    expect(p.kind).toBe("questAction");
    expect(p.quest).toEqual({ verb: "accept", questId: "quest.caravan" });
  });

  test("no offered quests ⇒ the kind downgrades to freeform and the payload drops", () => {
    const p = reconcilePlan(rawQuestPlan("quest.caravan"), CTX);
    expect(p.kind).toBe("freeformNarrative");
    expect(p.quest).toBeUndefined();
  });

  test("a hallucinated id with SEVERAL offers drops (no blind pick)", () => {
    const multi: ClassifierContext = {
      ...CTX,
      offeredQuests: [
        { id: "quest.caravan", name: "The Missing Caravan" },
        { id: "quest.ward", name: "The Souring Ward" },
      ],
    };
    expect(reconcilePlan(rawQuestPlan("quest.invented"), multi).kind).toBe("freeformNarrative");
  });
});

describe("reconcilePlan (LLM-output repair)", () => {
  test("drops a hallucinated targetId not present in context", () => {
    const raw = { kind: "dialogueToNpc", targetId: "npc.ghost", destinationLocationId: null, check: baseCheck, confidence: 0.9 };
    expect(reconcilePlan(raw, CTX).targetId).toBeNull();
  });

  // r13 — the addressee's spoken name (targetName): late-bind a classifier id-miss to the present
  // entity the model already meant, or carry the name so the engine can answer a phantom honestly.
  test("targetName late-binds a null targetId to the unique present entity it names", () => {
    const raw = { kind: "dialogueToNpc", targetId: null, targetName: "Lyra", destinationLocationId: null, check: baseCheck, confidence: 0.9 };
    const p = reconcilePlan(raw, CTX, "Lyra, what do you make of this?");
    expect(p.targetId).toBe("npc.lyra");
    expect(p.targetName).toBeUndefined();
  });

  test("a targetName matching nobody present is carried for the phantom-absence answer", () => {
    const raw = { kind: "dialogueToNpc", targetId: null, targetName: "Corin", destinationLocationId: null, check: baseCheck, confidence: 0.9 };
    const p = reconcilePlan(raw, CTX, "Corin, join me.");
    expect(p.targetId).toBeNull();
    expect(p.targetName).toBe("Corin");
  });

  test("targetName without rawInput corroboration never binds (fail-closed), but still carries", () => {
    const raw = { kind: "dialogueToNpc", targetId: null, targetName: "Lyra", destinationLocationId: null, check: baseCheck, confidence: 0.9 };
    const p = reconcilePlan(raw, CTX, "I speak to the woman by the hearth.");
    expect(p.targetId).toBeNull();
    expect(p.targetName).toBe("Lyra");
  });

  test("an ambiguous targetName (two present matches) never binds", () => {
    const twins: ClassifierContext = {
      ...CTX,
      presentEntities: [
        { id: "npc.vane-a", name: "Sister Vane" },
        { id: "npc.vane-b", name: "Mother Vane" },
      ],
    };
    const raw = { kind: "dialogueToNpc", targetId: null, targetName: "Vane", destinationLocationId: null, check: baseCheck, confidence: 0.9 };
    const p = reconcilePlan(raw, twins, "Vane, a word.");
    expect(p.targetId).toBeNull();
    expect(p.targetName).toBe("Vane");
  });

  test("targetName never rides a non-dialogue kind or a bound target", () => {
    const moved = reconcilePlan(
      { kind: "movement", targetId: null, targetName: "Corin", destinationLocationId: "loc.square", check: baseCheck, confidence: 0.9 },
      CTX,
      "I head for the square.",
    );
    expect(moved.targetName).toBeUndefined();
    const bound = reconcilePlan(
      { kind: "dialogueToNpc", targetId: "npc.brann", targetName: "Brann", destinationLocationId: null, check: baseCheck, confidence: 0.9 },
      CTX,
      "Brann, talk.",
    );
    expect(bound.targetId).toBe("npc.brann");
    expect(bound.targetName).toBeUndefined();
  });

  test("keeps an unreachable-destination movement as movement (open-world reach), not freeform", () => {
    const raw = { kind: "movement", targetId: null, destinationLocationId: "loc.moon", check: baseCheck, confidence: 0.9 };
    const p = reconcilePlan(raw, CTX);
    expect(p.kind).toBe("movement");
    expect(p.destinationLocationId).toBeNull();
    expect(p.movementMiss).toBe(true);
  });

  test("clamps an out-of-range DC into the playable band", () => {
    const raw = {
      kind: "attemptRequiringCheck",
      targetId: null,
      destinationLocationId: null,
      check: { warranted: true, ability: "str", skill: "athletics", dc: 38, reason: "x" },
      confidence: 0.5,
    };
    expect(reconcilePlan(raw, CTX).check.dc).toBe(30);
  });

  test("throws on structurally invalid input so the caller can fall back", () => {
    expect(() => reconcilePlan({ nope: true }, CTX)).toThrow();
  });

  test("a grounded itemAction passes through with its payload", () => {
    const raw = {
      kind: "itemAction",
      targetId: null,
      destinationLocationId: null,
      check: baseCheck,
      item: { verb: "use", itemId: "item.potion-healing", targetId: null },
      confidence: 0.9,
    };
    const p = reconcilePlan(raw, ITEM_CTX);
    expect(p.kind).toBe("itemAction");
    expect(p.item).toMatchObject({ verb: "use", itemId: "item.potion-healing" });
  });

  test("an itemAction naming an uncarried item downgrades to freeform", () => {
    const raw = {
      kind: "itemAction",
      targetId: null,
      destinationLocationId: null,
      check: baseCheck,
      item: { verb: "use", itemId: "item.hallucinated", targetId: null },
      confidence: 0.9,
    };
    expect(reconcilePlan(raw, ITEM_CTX).kind).toBe("freeformNarrative");
    // and so does one with no payload at all
    expect(reconcilePlan({ ...raw, item: null }, ITEM_CTX).kind).toBe("freeformNarrative");
  });

  test("pickup grounds against FLOOR_ITEMS, not the carried pool (the drop inverse, 07-18 #2)", () => {
    const raw = {
      kind: "itemAction",
      targetId: null,
      destinationLocationId: null,
      check: baseCheck,
      item: { verb: "pickup", itemId: "weapon.club", targetId: null },
      confidence: 0.9,
    };
    // On the floor here ⇒ grounds, even though the club is NOT carried.
    const floorCtx = { ...ITEM_CTX, floorItems: [{ id: "weapon.club", name: "Club" }] };
    const p = reconcilePlan(raw, floorCtx);
    expect(p.kind).toBe("itemAction");
    expect(p.item).toMatchObject({ verb: "pickup", itemId: "weapon.club" });
    // Not on this floor ⇒ the payload drops and the kind degrades (nothing to mint from).
    expect(reconcilePlan(raw, ITEM_CTX).kind).toBe("freeformNarrative");
    // A CARRIED id is not a pickup target either — the pools are disjoint on purpose.
    const carriedOnly = { ...raw, item: { ...raw.item, itemId: "weapon.dagger" } };
    expect(reconcilePlan(carriedOnly, floorCtx).kind).toBe("freeformNarrative");
  });

  test("a give-recipient not present is dropped from the payload", () => {
    const raw = {
      kind: "itemAction",
      targetId: null,
      destinationLocationId: null,
      check: baseCheck,
      item: { verb: "give", itemId: "weapon.dagger", targetId: "npc.ghost" },
      confidence: 0.9,
    };
    expect(reconcilePlan(raw, ITEM_CTX).item?.targetId).toBeNull();
  });

  test("a grounded partyAction passes through with its payload", () => {
    const raw = {
      kind: "partyAction",
      targetId: "npc.lyra",
      destinationLocationId: null,
      check: baseCheck,
      party: { verb: "invite", targetId: "npc.lyra" },
      confidence: 0.9,
    };
    const p = reconcilePlan(raw, CTX);
    expect(p.kind).toBe("partyAction");
    expect(p.party).toEqual({ verb: "invite", targetId: "npc.lyra" });
  });

  test("an invite or appoint naming an absent entity downgrades to freeform", () => {
    const raw = {
      kind: "partyAction",
      targetId: null,
      destinationLocationId: null,
      check: baseCheck,
      party: { verb: "invite", targetId: "npc.ghost" },
      confidence: 0.9,
    };
    expect(reconcilePlan(raw, CTX).kind).toBe("freeformNarrative");
    expect(
      reconcilePlan({ ...raw, party: { verb: "appointLeader", targetId: "npc.ghost" } }, CTX).kind,
    ).toBe("freeformNarrative");
    // and no payload at all drops the kind too
    expect(reconcilePlan({ ...raw, party: null }, CTX).kind).toBe("freeformNarrative");
  });

  test("leave keeps a PRESENT dismissal target, drops a hallucinated one; a null appoint is the PC taking the lead", () => {
    const raw = {
      kind: "partyAction",
      targetId: null,
      destinationLocationId: null,
      check: baseCheck,
      party: { verb: "leave", targetId: "npc.ghost" },
      confidence: 0.9,
    };
    // A hallucinated dismissal target degrades to the full-leave null — never an invented id.
    expect(reconcilePlan(raw, CTX).party).toEqual({ verb: "leave", targetId: null });
    // A grounded one survives: dismissing a single present companion.
    expect(reconcilePlan({ ...raw, party: { verb: "leave", targetId: "npc.lyra" } }, CTX).party).toEqual({
      verb: "leave",
      targetId: "npc.lyra",
    });
    expect(
      reconcilePlan({ ...raw, party: { verb: "appointLeader", targetId: null } }, CTX).party,
    ).toEqual({ verb: "appointLeader", targetId: null });
  });
});

describe("buildClassifyUserMessage — WORK render carries wage/ability/DC (finding #9)", () => {
  test("renders wage/ability/DC so the classifier can pick the higher-paying job", () => {
    const ctx: ClassifierContext = {
      ...CTX,
      workOpportunities: [
        { id: "work.haul", label: "Haul crates", wageCp: 80, ability: "str", dc: 13 },
        { id: "work.busk", label: "Busk", wageCp: 20, ability: "cha", dc: 10 },
      ],
    };
    const msg = buildClassifyUserMessage("what's the best-paying work?", ctx);
    expect(msg).toContain("work.haul=Haul crates (80cp, str DC13)");
    expect(msg).toContain("work.busk=Busk (20cp, cha DC10)");
  });

  test("a wageless work ref renders bare id=label (additive — no crash, no fields)", () => {
    const ctx: ClassifierContext = { ...CTX, workOpportunities: [{ id: "work.x", label: "Odd jobs" }] };
    expect(buildClassifyUserMessage("work", ctx)).toContain("WORK: work.x=Odd jobs");
  });

  test("PRESENT_ENTITIES marks party members so the classifier can branch the follow direction", () => {
    // CTX has npc.lyra as a companion, npc.brann as a present stranger. The marker lets the model
    // route "keep up with Brann" (a NON-party guide → invite) apart from "keep up with Lyra" (an
    // existing companion → flavor/movement, no re-invite).
    const msg = buildClassifyUserMessage("keep up with Brann", CTX);
    expect(msg).toContain("npc.lyra=Lyra Vane (in your party)");
    expect(msg).toContain("npc.brann=Brann");
    expect(msg).not.toContain("npc.brann=Brann (in your party)");
  });
})

describe("reconcilePlan — impact grounding (Phase 3 consequence floor)", () => {
  test("a plan with NO impact field still parses; impact defaults to a neutral none", () => {
    const p = reconcilePlan(
      { kind: "freeformNarrative", targetId: null, destinationLocationId: null, check: baseCheck, confidence: 0.5 },
      CTX,
    );
    expect(p.impact).toBeDefined();
    expect(p.impact?.domain).toBe("none");
    expect(p.impact?.severity).toBe("none");
    expect(p.impact?.victimId).toBeNull();
  });

  test("impact.victimId is grounded against present entities (nulled when absent, kept when present)", () => {
    const raw = {
      kind: "attemptRequiringCheck",
      targetId: null,
      destinationLocationId: null,
      check: { ...baseCheck, warranted: true },
      impact: { domain: "violence", severity: "serious", victimId: "npc.ghost" },
      confidence: 0.9,
    };
    const nulled = reconcilePlan(raw, CTX);
    expect(nulled.impact?.domain).toBe("violence");
    expect(nulled.impact?.victimId).toBeNull(); // npc.ghost is not present ⇒ never trusted

    const present = reconcilePlan({ ...raw, impact: { domain: "violence", severity: "serious", victimId: "npc.brann" } }, CTX);
    expect(present.impact?.victimId).toBe("npc.brann"); // brann IS in presentEntities
  });
})

describe("reconcilePlan — trade survives ungrounded (r4-C fabricated-merchant fix)", () => {
  const rawTrade = (trade: unknown) => ({
    kind: "trade",
    targetId: null,
    destinationLocationId: null,
    trade,
    check: baseCheck,
    confidence: 0.9,
  });
  const VENDOR_CTX: ClassifierContext = {
    ...ITEM_CTX,
    vendors: [
      {
        id: "npc.bett",
        name: "Bett",
        stock: [{ id: "item.rations", name: "Rations" }, { id: "weapon.club", name: "Club" }],
      },
    ],
  };

  test("no vendor present: the KIND stays trade with a null payload (engine refuses honestly)", () => {
    const p = reconcilePlan(rawTrade({ direction: "buy", itemId: "weapon.dagger", vendorId: null }), ITEM_CTX);
    expect(p.kind).toBe("trade");
    expect(p.trade).toBeUndefined();
  });

  test("a vendor grounds but the ware is NOT in stock: the item id passes through untouched", () => {
    // The engine is the resolve-time authority — it answers "Bett has no Dagger to sell you",
    // which only works if the ungrounded item id survives reconciliation.
    const p = reconcilePlan(rawTrade({ direction: "buy", itemId: "weapon.dagger", vendorId: "npc.bett" }), VENDOR_CTX);
    expect(p.kind).toBe("trade");
    expect(p.trade).toEqual({ direction: "buy", itemId: "weapon.dagger", vendorId: "npc.bett" });
  });

  test("the only vendor is defaulted in when the model left vendorId null", () => {
    const p = reconcilePlan(rawTrade({ direction: "sell", itemId: "item.potion-healing", vendorId: null }), VENDOR_CTX);
    expect(p.trade?.vendorId).toBe("npc.bett");
  });

  test("a stocked buy still grounds exactly as before", () => {
    const p = reconcilePlan(rawTrade({ direction: "buy", itemId: "item.rations", vendorId: "npc.bett" }), VENDOR_CTX);
    expect(p.kind).toBe("trade");
    expect(p.trade).toEqual({ direction: "buy", itemId: "item.rations", vendorId: "npc.bett" });
  });

  test("r10 F-2 → r14: a misaddressed BUY survives demoted to a FORCED inquiry — never an execution", () => {
    // "I ask the tanner the price…" grounded to the salient clerk and bought from the wrong NPC.
    // The r10 guard dropped the whole payload; r14 keeps the guard's teeth (inquiry is FORCED, so
    // nothing can execute) while the ask's own words survive to the kind/quote machinery — the
    // fixture-trade t2/t3 "cheapest blade at the smith's stall" ask died with the dropped payload.
    const p = reconcilePlan(
      rawTrade({ direction: "buy", itemId: "item.rations", vendorId: "npc.bett", vendorWords: "the tanner" }),
      VENDOR_CTX,
    );
    expect(p.kind).toBe("trade");
    expect(p.trade?.vendorId).toBe("npc.bett");
    expect(p.trade?.inquiry).toBe(true);
    expect(p.trade?.vendorWords).toBe("the tanner");
  });

  test("r14: a misaddressed buy's itemWords ride the demotion (the kind ask reaches the counter)", () => {
    const p = reconcilePlan(
      rawTrade({
        direction: "buy",
        itemId: null,
        vendorId: "npc.bett",
        vendorWords: "the smith",
        itemWords: "your cheapest blade",
      }),
      VENDOR_CTX,
    );
    expect(p.trade?.inquiry).toBe(true);
    expect(p.trade?.itemWords).toBe("your cheapest blade");
  });

  test("r14: a misaddressed SELL still drops the payload whole (its exploit was the execution)", () => {
    const p = reconcilePlan(
      rawTrade({ direction: "sell", itemId: "item.potion-healing", vendorId: "npc.bett", vendorWords: "the tanner" }),
      VENDOR_CTX,
    );
    expect(p.kind).toBe("trade");
    expect(p.trade).toBeUndefined();
  });

  test("r10 F-2: vendorWords matching the vendor's own name or a generic merchant word corroborate", () => {
    for (const vendorWords of ["Bett", "the merchant", "the shopkeeper"]) {
      const p = reconcilePlan(
        rawTrade({ direction: "buy", itemId: "item.rations", vendorId: "npc.bett", vendorWords }),
        VENDOR_CTX,
      );
      expect(p.trade?.vendorId).toBe("npc.bett");
      expect(p.trade?.vendorWords).toBe(vendorWords);
    }
  });

  test("r10 F-2/F-3: inquiry + itemWords ride reconciliation into the plan; absent fields stay absent", () => {
    const p = reconcilePlan(
      rawTrade({
        direction: "buy",
        itemId: "item.rations",
        vendorId: "npc.bett",
        inquiry: true,
        itemWords: "a day of rations",
      }),
      VENDOR_CTX,
    );
    expect(p.trade?.inquiry).toBe(true);
    expect(p.trade?.itemWords).toBe("a day of rations");
    const bare = reconcilePlan(rawTrade({ direction: "buy", itemId: "item.rations", vendorId: "npc.bett" }), VENDOR_CTX);
    expect(bare.trade).toEqual({ direction: "buy", itemId: "item.rations", vendorId: "npc.bett" });
  });

  test("the prompt tells the model commerce is ALWAYS kind trade — never a narrated deal", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("ANY clear\n  commerce attempt is kind \"trade\"");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("never narrate a deal yourself");
  });
});

describe("reconcilePlan — bare work defaults to the obvious shift (r4-C)", () => {
  const rawWork = (opportunityId: string | null) => ({
    kind: "work",
    targetId: null,
    destinationLocationId: null,
    work: { opportunityId },
    check: baseCheck,
    confidence: 0.9,
  });
  const WORK_CTX: ClassifierContext = {
    ...CTX,
    workOpportunities: [
      { id: "work.barge", label: "Load the barges", wageCp: 70, ability: "str", dc: 12 },
      { id: "work.messages", label: "Run messages", wageCp: 80, ability: "dex", dc: 13 },
    ],
  };

  test("a null opportunity id with SEVERAL offers defaults to the lowest-DC shift", () => {
    const p = reconcilePlan(rawWork(null), WORK_CTX);
    expect(p.kind).toBe("work");
    expect(p.work?.opportunityId).toBe("work.barge");
  });

  test("a named offer still wins over the default; a hallucinated one still drops to freeform", () => {
    expect(reconcilePlan(rawWork("work.messages"), WORK_CTX).work?.opportunityId).toBe("work.messages");
    expect(reconcilePlan(rawWork("work.ghost-job"), WORK_CTX).kind).toBe("freeformNarrative");
  });

  test("the prompt pins the bare-verb rule", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('A bare "work"');
  });
});

describe("the closed answer fields — schema, prompt, and reconcile (r8 regex audit)", () => {
  // Seven regexes that read open-ended prose and whose answer became a DELTA were migrated onto
  // closed TurnPlan fields, following the `check.purpose` pattern. Three properties have to hold
  // for that to be safe, and all three are pinned here: the model can only produce values from the
  // closed list, an ordinary turn's prompt is byte-identical to before, and a missing answer
  // survives the parse (so every reader reaches its documented safe default).

  const rawWith = (over: Record<string, unknown>) => ({
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: baseCheck,
    confidence: 0.9,
    ...over,
  });

  test("every closed field round-trips through reconcilePlan", () => {
    const plan = reconcilePlan(
      rawWith({
        pressureAnswer: "refuse",
        socialAsk: { approach: "bribe", kind: "information" },
        speechAct: "callForAid",
        proposalAnswer: "decline",
        captivityAction: "endure",
        escapeAbility: "cha",
        dialogueAsk: "whereabouts",
      }),
      CTX,
    );
    expect(plan.pressureAnswer).toBe("refuse");
    expect(plan.socialAsk).toEqual({ approach: "bribe", kind: "information" });
    expect(plan.speechAct).toBe("callForAid");
    expect(plan.proposalAnswer).toBe("decline");
    expect(plan.captivityAction).toBe("endure");
    expect(plan.escapeAbility).toBe("cha");
    expect(plan.dialogueAsk).toBe("whereabouts");
    // …but only "whereabouts" is carried: "other" IS the absent default at the single reader, so an
    // ordinary spoken turn's plan stays byte-identical to a pre-r8 one.
    expect(reconcilePlan(rawWith({ dialogueAsk: "other" }), CTX).dialogueAsk).toBeUndefined();
  });

  test("a plan that omits them all parses unchanged, and every field is absent", () => {
    // This is the shape a pre-r8 persisted plan, a scripted test stub, and `freeformPlan()` (the
    // double-failure floor) all have. Absent ⇒ each reader falls to its regex/default branch.
    const plan = reconcilePlan(rawWith({}), CTX);
    for (const key of [
      "pressureAnswer",
      "socialAsk",
      "speechAct",
      "proposalAnswer",
      "captivityAction",
      "escapeAbility",
      "dialogueAsk",
    ] as const) {
      expect(plan[key], key).toBeUndefined();
    }
  });

  test("a value outside the closed list is REJECTED, not smuggled through", () => {
    // The whole premise is that the model may only NAME an answer from a fixed list. `steal` is a
    // legal socialAsk kind but an illegal captivityAction; the parse must throw rather than let an
    // unconstrained string reach a reducer command.
    expect(() => reconcilePlan(rawWith({ captivityAction: "steal" }), CTX)).toThrow();
    expect(() => reconcilePlan(rawWith({ escapeAbility: "wis" }), CTX)).toThrow();
    expect(() => reconcilePlan(rawWith({ socialAsk: { approach: "persuade", kind: "escort" } }), CTX)).toThrow();
    expect(() => reconcilePlan(rawWith({ dialogueAsk: "location" }), CTX)).toThrow();
  });

  test("each field is offered to the model with its full enum in the embedded schema", () => {
    const props = TURN_PLAN_JSON_SCHEMA.properties as unknown as Record<string, { enum?: readonly unknown[] }>;
    expect(props.pressureAnswer?.enum).toEqual(["comply", "refuse", "neutral", null]);
    expect(props.speechAct?.enum).toEqual(["deescalate", "callForAid", "other", null]);
    expect(props.proposalAnswer?.enum).toEqual(["accept", "decline", "neither", null]);
    expect(props.captivityAction?.enum).toEqual(["labor", "endure", "escape", null]);
    expect(props.escapeAbility?.enum).toEqual(["str", "dex", "cha", null]);
    expect(props.dialogueAsk?.enum).toEqual(["whereabouts", "other", null]);
    // Situational, so deliberately NOT in the top-level `required` list (the impact/effects
    // precedent): an ordinary turn omits them entirely.
    expect(TURN_PLAN_JSON_SCHEMA.required as readonly string[]).not.toContain("pressureAnswer");
  });

  test("the situational context lines are OMIT-WHEN-ABSENT — an ordinary turn is byte-identical", () => {
    const plain = buildClassifyUserMessage("I look around", CTX);
    for (const marker of ["BODY_STATE: CAPTIVE", "COMBAT: ACTIVE", "PENDING_DEMAND", "PENDING_PROPOSAL", "ROUTINES: KNOWN"]) {
      expect(plain, marker).not.toContain(marker);
    }
    // …and each flag adds exactly its own line, so the model is answering a question it can SEE.
    expect(buildClassifyUserMessage("x", { ...CTX, captive: true })).toContain("BODY_STATE: CAPTIVE");
    expect(buildClassifyUserMessage("x", { ...CTX, inCombat: true })).toContain("COMBAT: ACTIVE");
    expect(buildClassifyUserMessage("x", { ...CTX, routinesKnown: true })).toContain("ROUTINES: KNOWN");
    expect(
      buildClassifyUserMessage("x", { ...CTX, pendingDemand: { npcName: "Veressa", summary: "demands the coin" } }),
    ).toContain("PENDING_DEMAND: Veressa demands the coin");
    expect(
      buildClassifyUserMessage("x", { ...CTX, pendingProposal: { npcName: "Maelle", text: "Let's make for the green." } }),
    ).toContain('PENDING_PROPOSAL: Maelle proposed: "Let\'s make for the green."');
  });

  test("the prompt teaches the two reproduced misfires by name", () => {
    // A closed field is only as good as the guidance behind it, and both of these are lines the
    // regexes got wrong in play: an escort request read as theft, and a concessive answer read as
    // compliance. Pinned so a prompt edit cannot quietly drop the calibration.
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('("can you take me to the market?") is a favor, not a theft');
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('pry it from me.") is "refuse"');
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('Searching a wall for loose stones is "endure", not "escape"');
    // The name binder's whole third surface hangs off this one distinction — "dray" the
    // quartermaster vs "dray" the cart — so the calibration line is pinned too.
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"we should hitch the dray before dark" is about a cart');
  });
})
