/**
 * Pathfinding over the live map (src/world/pathfind.ts) — the known-roads travel primitive.
 * Deterministic Dijkstra: authored minutes weigh edges, hidden/frontier/barred exits are not
 * roads, and the same map always yields the same route.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import { fromGameState, type WorldModel } from "../src/world/model.ts";
import { findRoute, firstBarredLeg } from "../src/world/pathfind.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

interface Loc {
  id: string;
  name: string;
  exits: { to: string; minutes?: number; locked?: boolean; hidden?: boolean }[];
}

function modelOf(locs: Loc[]): WorldModel {
  const world = WorldSchema.parse({
    id: "w.path",
    name: "Pathworld",
    summary: "A world of roads.",
    locations: locs.map((l) => ({
      id: l.id,
      name: l.name,
      description: `${l.name}.`,
      exits: l.exits.map((e) => ({
        to: e.to,
        name: `to ${e.to}`,
        locked: e.locked ?? false,
        hidden: e.hidden ?? false,
        ...(e.minutes !== undefined ? { minutes: e.minutes } : {}),
      })),
    })),
    npcs: [],
  });
  const campaign = CampaignSchema.parse({
    id: "c.path",
    name: "Path Campaign",
    worldId: "w.path",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    startingState: { locationId: locs[0]!.id, party: ["pc.you"], companions: [] },
  });
  const playset: PlaySet = { world, campaign };
  const gs = {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: locs[0]!.id,
    clock: 0,
    party: ["pc.you"],
    companions: [],
    actors: { "pc.you": { id: "pc.you", currentHp: 10, locationId: locs[0]!.id, inventory: [], conditions: [] } },
    quests: {},
    relationships: {},
    autonomy: {},
    modules: {},
    flags: {},
  };
  return fromGameState(gs as never, playset.world, playset.campaign);
}

describe("findRoute", () => {
  test("sums authored minutes along the cheapest chain", () => {
    const model = modelOf([
      { id: "a", name: "A", exits: [{ to: "b", minutes: 60 }] },
      { id: "b", name: "B", exits: [{ to: "a", minutes: 60 }, { to: "c", minutes: 120 }] },
      { id: "c", name: "C", exits: [{ to: "b", minutes: 120 }] },
    ]);
    const route = findRoute(model, "a", "c");
    expect(route).not.toBeNull();
    expect(route!.legs.map((l) => l.to)).toEqual(["b", "c"]);
    expect(route!.totalMinutes).toBe(180);
  });

  test("prefers the cheaper road even with more legs; un-minuted edges cost the default", () => {
    const model = modelOf([
      // Direct a→d costs 500; the a→b→c→d chain costs 30+30+30 = 90 (default legs).
      { id: "a", name: "A", exits: [{ to: "d", minutes: 500 }, { to: "b" }] },
      { id: "b", name: "B", exits: [{ to: "c" }] },
      { id: "c", name: "C", exits: [{ to: "d" }] },
      { id: "d", name: "D", exits: [] },
    ]);
    const route = findRoute(model, "a", "d");
    expect(route!.legs.map((l) => l.to)).toEqual(["b", "c", "d"]);
    expect(route!.totalMinutes).toBe(90);
    // The caller can widen the default leg cost.
    expect(findRoute(model, "a", "d", { defaultLegMinutes: 200 })!.totalMinutes).toBe(500);
  });

  test("hidden and frontier exits are not roads; a barred leg blocks the route", () => {
    const model = modelOf([
      { id: "a", name: "A", exits: [{ to: "b", hidden: true }, { to: "frontier:x" }, { to: "c", locked: true }] },
      { id: "b", name: "B", exits: [] },
      { id: "c", name: "C", exits: [] },
    ]);
    expect(findRoute(model, "a", "b")).toBeNull(); // hidden
    expect(findRoute(model, "a", "c")).toBeNull(); // locked
    const barred = firstBarredLeg(model, "a", "c");
    expect(barred).not.toBeNull();
    expect(barred!.to).toBe("c"); // the refusal can name the obstacle
    expect(firstBarredLeg(model, "a", "b")).toBeNull(); // hidden is invisible even to the blind pass
  });

  test("deterministic: equal-cost forks always pick the same road; from===to is an empty route", () => {
    const locs: Loc[] = [
      { id: "a", name: "A", exits: [{ to: "m1", minutes: 10 }, { to: "m2", minutes: 10 }] },
      { id: "m1", name: "M1", exits: [{ to: "z", minutes: 10 }] },
      { id: "m2", name: "M2", exits: [{ to: "z", minutes: 10 }] },
      { id: "z", name: "Z", exits: [] },
    ];
    const first = findRoute(modelOf(locs), "a", "z")!.legs.map((l) => l.to);
    for (let i = 0; i < 5; i++) {
      expect(findRoute(modelOf(locs), "a", "z")!.legs.map((l) => l.to)).toEqual(first);
    }
    expect(findRoute(modelOf(locs), "a", "a")).toEqual({ legs: [], totalMinutes: 0 });
    expect(findRoute(modelOf(locs), "z", "a")).toBeNull(); // directed graph — no way back
  });
});
