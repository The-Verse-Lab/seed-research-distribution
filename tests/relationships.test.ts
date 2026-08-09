/** Relationship and living-relationship helpers. */
import { describe, expect, test } from "bun:test";
import {
  CHAT_FRIENDSHIP_CAP,
  clampConvoNudge,
  clampFriendship,
  driftToward,
  factionMatesPresent,
  giftWarmth,
  GIFT_WARMTH_MAX,
  GIFT_WARMTH_MIN,
  relationshipProfileFromState,
} from "../src/rules/relationships.ts";
import type { WorldModel } from "../src/world/model.ts";
import type { World } from "../src/content/schema.ts";

describe("relationship helpers", () => {
  test("clamps Friendship", () => {
    expect(clampFriendship(-150)).toBe(-100);
    expect(clampFriendship(150)).toBe(100);
    expect(clampFriendship(Number.NaN)).toBe(0);
  });

  test("reads Friendship from state with a zero default", () => {
    const state = {
      relationships: { "npc.a": { "pc.you": 12 } },
    };
    expect(relationshipProfileFromState(state, "npc.a", "pc.you")).toEqual({ friendship: 12 });
    expect(relationshipProfileFromState({ relationships: {} }, "npc.a", "pc.you")).toEqual({ friendship: 0 });
  });
});

describe("living-relationship helpers", () => {
  test("clampConvoNudge bounds, rounds, and rejects non-finite", () => {
    expect(clampConvoNudge(1)).toBe(1);
    expect(clampConvoNudge(5)).toBe(2); // clamped to CONVO_NUDGE_MAX
    expect(clampConvoNudge(-9)).toBe(-2);
    expect(clampConvoNudge(1.6)).toBe(2);
    expect(clampConvoNudge("2")).toBe(2);
    expect(clampConvoNudge(Number.NaN)).toBe(0);
    expect(clampConvoNudge(undefined)).toBe(0);
  });

  test("driftToward steps toward the baseline without overshooting", () => {
    expect(driftToward(50, 10, 2)).toBe(48); // warm cools one step down
    expect(driftToward(-30, 5, 2)).toBe(-28); // cold warms one step up
    expect(driftToward(11, 10, 2)).toBe(10); // gap < step ⇒ lands exactly, no overshoot
    expect(driftToward(10, 10, 2)).toBe(10); // at baseline ⇒ unchanged
  });

  test("giftWarmth scales with value and clamps small", () => {
    expect(giftWarmth(0)).toBe(GIFT_WARMTH_MIN);
    expect(giftWarmth(-5)).toBe(GIFT_WARMTH_MIN);
    expect(giftWarmth(25)).toBe(1);
    expect(giftWarmth(10_000)).toBe(GIFT_WARMTH_MAX); // capped
    expect(CHAT_FRIENDSHIP_CAP).toBeGreaterThan(0);
  });

  test("factionMatesPresent finds co-located kin, excluding victim/PC/party", () => {
    const model = {
      entities: new Map([
        ["pc.you", { id: "pc.you", locationId: "loc.square", partyMember: true }],
        ["npc.victim", { id: "npc.victim", locationId: "loc.square", partyMember: false }],
        ["npc.mate", { id: "npc.mate", locationId: "loc.square", partyMember: false }],
        ["npc.mate#2", { id: "npc.mate#2", locationId: "loc.square", partyMember: false }], // spawn instance
        ["npc.ally", { id: "npc.ally", locationId: "loc.square", partyMember: true }], // party ⇒ excluded
        ["npc.elsewhere", { id: "npc.elsewhere", locationId: "loc.docks", partyMember: false }], // far ⇒ excluded
        ["npc.other", { id: "npc.other", locationId: "loc.square", partyMember: false }], // other faction
      ]),
    } as unknown as WorldModel;
    const world = {
      npcs: [
        { id: "npc.victim", factionId: "faction.guild" },
        { id: "npc.mate", factionId: "faction.guild" },
        { id: "npc.ally", factionId: "faction.guild" },
        { id: "npc.elsewhere", factionId: "faction.guild" },
        { id: "npc.other", factionId: "faction.other" },
      ],
    } as unknown as World;
    const mates = factionMatesPresent(model, world, "npc.victim", "pc.you").sort();
    expect(mates).toEqual(["npc.mate", "npc.mate#2"]);
  });

  test("factionMatesPresent is empty when the victim has no faction", () => {
    const model = {
      entities: new Map([["npc.loner", { id: "npc.loner", locationId: "loc.x", partyMember: false }]]),
    } as unknown as WorldModel;
    const world = { npcs: [{ id: "npc.loner" }] } as unknown as World;
    expect(factionMatesPresent(model, world, "npc.loner", "pc.you")).toEqual([]);
  });
});
