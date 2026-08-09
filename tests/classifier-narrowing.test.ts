/**
 * Scene-narrowed classifier schema (Concordia transfer #4, `NEXT_ACTION_SPEC`). Pins: ordinary
 * turns embed THE full schema object (byte-identical prompt); scene turns embed the same schema
 * with `kind.enum` cut; precedence combat > captive > abed; and `reconcilePlan` stays
 * the ONE reconciler — a plan whose kind falls outside the narrowed enum still validates against
 * the full type instead of erroring (narrowing shapes the ASK, never the acceptance).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  buildClassifyUserMessage,
  reconcilePlan,
  sceneSchemaKeyFor,
  schemaForContext,
  TURN_PLAN_JSON_SCHEMA,
} from "../src/engine/classify.ts";
import type { ClassifierContext } from "../src/engine/turn-plan.ts";

const ctx = (over: Partial<ClassifierContext> = {}): ClassifierContext => ({
  playerActorId: "pc.you",
  locationId: "loc.a",
  locationName: "The Yard",
  exits: [],
  presentEntities: [],
  companionIds: [],
  ...over,
});

function kindsOf(schema: Record<string, unknown>): string[] {
  const props = schema.properties as { kind: { enum: string[] } };
  return props.kind.enum;
}

describe("scene-narrowed classifier schema", () => {
  test("an ordinary turn gets THE full schema object — reference-equal, prompt byte-identical", () => {
    expect(sceneSchemaKeyFor(ctx())).toBe("full");
    expect(schemaForContext(ctx())).toBe(TURN_PLAN_JSON_SCHEMA as unknown as Record<string, unknown>);
  });

  test("combat narrows the kinds: no shopping mid-melee, parley and flight stay", () => {
    const schema = schemaForContext(ctx({ inCombat: true }));
    const kinds = kindsOf(schema);
    expect(kinds).toContain("attack");
    expect(kinds).toContain("dialogueToNpc"); // talk it down
    expect(kinds).toContain("movement"); // flee
    expect(kinds).toContain("freeformNarrative"); // the safety valve is never narrowed away
    expect(kinds).not.toContain("trade");
    expect(kinds).not.toContain("rentRoom");
    expect(kinds).not.toContain("workInquiry");
  });

  test("only kind.enum differs from the full schema — every other byte is the same", () => {
    const narrowed = schemaForContext(ctx({ inCombat: true }));
    const restored = {
      ...narrowed,
      properties: {
        ...(narrowed.properties as Record<string, unknown>),
        kind: (TURN_PLAN_JSON_SCHEMA as unknown as { properties: { kind: unknown } }).properties.kind,
      },
    };
    expect(JSON.stringify(restored)).toBe(JSON.stringify(TURN_PLAN_JSON_SCHEMA));
  });

  test("precedence: combat owns the turn over abed; captivity owns it otherwise", () => {
    expect(sceneSchemaKeyFor(ctx({ inCombat: true, abed: true }))).toBe("combat");
    expect(sceneSchemaKeyFor(ctx({ captive: true, abed: true }))).toBe("captive");
    expect(sceneSchemaKeyFor(ctx({ abed: true }))).toBe("abed");
  });

  test("abed keeps the rise and sleep verbs", () => {
    expect(kindsOf(schemaForContext(ctx({ abed: true })))).toContain("wakeInRoom");
  });

  test("the user message embeds the narrowed schema on a combat turn, the full one otherwise", () => {
    const combatMsg = buildClassifyUserMessage("I swing at the reaver", ctx({ inCombat: true }));
    expect(combatMsg).toContain('"attack"');
    expect(combatMsg).not.toContain('"enterCamp"'); // only ever appears inside the schema JSON
    const plainMsg = buildClassifyUserMessage("I look around", ctx());
    expect(plainMsg).toContain('"enterCamp"');
  });

  test("ONE reconciler: a kind outside the narrowed enum still validates against the full type", () => {
    const raw = {
      kind: "rest",
      targetId: null,
      destinationLocationId: null,
      check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
      item: null,
      confidence: 0.9,
    };
    const plan = reconcilePlan(raw, ctx({ inCombat: true }), "I catch my breath");
    expect(plan.kind).toBe("rest"); // narrowing never forks acceptance — the resolver owns combat rules
  });
});
