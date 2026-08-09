/**
 * Shared travel packs — loader merge and content invariants.
 *
 * The bundled core packs are world-agnostic data. Authored events stay first and win id collisions;
 * pack events may use synthetic ambush foes, but must not reference world-specific items/NPCs.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, TravelEventSchema, type Effect } from "../src/content/schema.ts";
import { mergeTravelPacks } from "../src/content/loader.ts";
import { CORE_PACK_IDS, coreTravelEvents, travelPackEvents } from "../src/content/travel-packs.ts";
import { isCampSafe } from "../src/rules/travel-events.ts";

function campaign(over: Record<string, unknown> = {}) {
  return CampaignSchema.parse({
    id: "c.pack",
    name: "Pack Campaign",
    worldId: "w.pack",
    startingState: { locationId: "loc.start", party: ["pc.you"], companions: [] },
    ...over,
  });
}

function effects(ev: { effects: Effect[] }): Effect[] {
  const out: Effect[] = [];
  const walk = (eff: Effect): void => {
    out.push(eff);
    if (eff.kind === "check") {
      eff.onSuccess.forEach(walk);
      eff.onFail.forEach(walk);
    }
  };
  ev.effects.forEach(walk);
  return out;
}

describe("mergeTravelPacks", () => {
  test("absent travelEventPacks is a byte-identical no-op", () => {
    const before = campaign({ travelEvents: [{ id: "tev.local", effects: [{ kind: "narrate", text: "local" }] }] });
    const json = JSON.stringify(before);
    const after = mergeTravelPacks(before);
    expect(after).toBe(before);
    expect(JSON.stringify(after)).toBe(json);
  });

  test("appends pack events after authored events, with author ids winning collisions", () => {
    const local = {
      id: "tev.core.wildflowers",
      weight: 9,
      effects: [{ kind: "narrate", text: "A local road beat wins." }],
    };
    const before = campaign({ travelEventPacks: ["core-ambient"], travelEvents: [local] });
    const after = mergeTravelPacks(before);
    const ambient = travelPackEvents(["core-ambient"]);

    expect(after.travelEvents[0]?.id).toBe("tev.core.wildflowers");
    expect(after.travelEvents[0]?.effects[0]).toEqual({ kind: "narrate", text: "A local road beat wins." });
    expect(after.travelEvents.filter((ev) => ev.id === "tev.core.wildflowers")).toHaveLength(1);
    expect(after.travelEvents).toHaveLength(ambient.length);
  });
});

describe("coreTravelEvents", () => {
  test("all core events parse and avoid world-specific effect kinds", () => {
    const events = coreTravelEvents();
    expect(CORE_PACK_IDS).toEqual(["core-ambient", "core-road-danger", "core-fortune"]);
    expect(events.length).toBeGreaterThanOrEqual(19);

    for (const ev of events) {
      expect(() => TravelEventSchema.parse(ev)).not.toThrow();
      for (const eff of effects(ev)) {
        expect(eff.kind).not.toBe("giveItem");
        expect(eff.kind).not.toBe("spawn");
      }
    }
  });

  test("camp-safety is derived from ambush effects, including nested checks", () => {
    const events = coreTravelEvents();
    const unsafeIds = events.filter((ev) => !isCampSafe(ev)).map((ev) => ev.id);
    expect(unsafeIds).toContain("tev.core.ambush-bandit");
    expect(unsafeIds).toContain("tev.core.ambush-wolves");
    expect(unsafeIds).toContain("tev.core.bandit-or-fight");
    expect(isCampSafe(events.find((ev) => ev.id === "tev.core.wayshrine")!)).toBe(true);
  });
});
