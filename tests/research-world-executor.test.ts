import { describe, expect, test } from "bun:test";

import {
  ResearchWorldExecutor,
  canonicalResearchJson,
  foldResearchDeltas,
  hashResearchValue,
  keyedResearchTravelMinutes,
} from "../src/research/world/index.ts";

const WORLD = {
  version: 1,
  worldId: "world.test",
  campaignId: "campaign.test",
  playerId: "player",
  companionId: "companion",
  partyEntityIds: ["player", "companion"],
  entities: [
    { id: "player", locationId: "dock", inventory: [] },
    { id: "companion", locationId: "dock", inventory: [] },
    { id: "mara", locationId: "dock", inventory: ["weather-chart"] },
    { id: "culprit", locationId: "vault", inventory: [] },
  ],
  locations: [
    {
      id: "dock",
      exits: [
        { to: "market", minutes: 10, initialState: "open" },
        { to: "vault", minutes: 4, initialState: "locked" },
      ],
    },
    { id: "market", exits: [{ to: "dock", minutes: 10, initialState: "open" }] },
    { id: "vault", exits: [{ to: "dock", minutes: 4, initialState: "open" }] },
  ],
  facts: [
    { id: "route-safe" },
    { id: "evidence-a" },
    { id: "evidence-b" },
  ],
  quests: [{ id: "investigation", initialState: "active", objectiveIds: ["identify-culprit"] }],
  cases: [
    {
      id: "missing-manifest",
      questId: "investigation",
      culpritId: "culprit",
      evidenceFactIds: ["evidence-a", "evidence-b"],
      requiredEvidenceFactIds: ["evidence-a", "evidence-b"],
      successEffects: [
        {
          kind: "setObjective",
          questId: "investigation",
          objectiveId: "identify-culprit",
          done: true,
        },
      ],
    },
  ],
  events: [
    {
      id: "market-completes-quest",
      when: "onEnterLocation",
      trigger: {
        allOf: [
          { kind: "atLocation", locationId: "market" },
          { kind: "questState", questId: "investigation", state: "active" },
        ],
      },
      effects: [
        { kind: "setQuestState", questId: "investigation", state: "complete" },
        { kind: "transferItem", itemId: "weather-chart", from: "mara", to: "player" },
      ],
      once: "campaign",
    },
    {
      id: "market-objective-same-tick",
      when: "onEnterLocation",
      trigger: {
        allOf: [
          { kind: "atLocation", locationId: "market" },
          { kind: "questState", questId: "investigation", state: "active" },
        ],
      },
      effects: [
        {
          kind: "setObjective",
          questId: "investigation",
          objectiveId: "identify-culprit",
          done: true,
        },
      ],
      once: "campaign",
    },
    {
      id: "must-not-see-same-tick-item",
      when: "onEnterLocation",
      trigger: {
        allOf: [
          { kind: "atLocation", locationId: "market" },
          { kind: "hasItem", entityId: "player", itemId: "weather-chart" },
        ],
      },
      effects: [{ kind: "discloseFacts", factIds: ["route-safe"] }],
      once: "campaign",
    },
  ],
  mechanics: { travelMinuteJitter: 2 },
} as const;

describe("ResearchWorldExecutor movement and events", () => {
  test("moves the party, freezes same-tick predicates, and applies matching events in authored order", () => {
    const executor = new ResearchWorldExecutor(WORLD, { setup: { mechanicsSeed: "panel-seed-1" } });
    const seed = executor.seedSnapshot();
    const result = executor.moveParty("market");
    const snapshot = executor.snapshot();

    expect(result.accepted).toBe(true);
    expect(result.eventsFired).toEqual(["market-completes-quest", "market-objective-same-tick"]);
    expect(snapshot.firedEventIds).toEqual(["market-completes-quest", "market-objective-same-tick"]);
    expect(snapshot.entities.player?.locationId).toBe("market");
    expect(snapshot.entities.companion?.locationId).toBe("market");
    expect(snapshot.entities.mara?.locationId).toBe("dock");
    expect(snapshot.entities.player?.inventory).toEqual(["weather-chart"]);
    expect(snapshot.playerKnownFactIds).toEqual([]);
    expect(snapshot.quests.investigation).toBe("complete");
    expect(snapshot.objectives.investigation?.["identify-culprit"]).toBe(true);
    expect(result.travelMinutes).toBeDefined();
    expect(snapshot.clock).toBe(result.travelMinutes!);
    expect(result.travelMinutes!).toBeGreaterThanOrEqual(8);
    expect(result.travelMinutes!).toBeLessThanOrEqual(12);

    expect(foldResearchDeltas(seed, executor.deltas())).toEqual(snapshot);
    expect(result.afterStateHash).toBe(executor.stateHash());
    executor.assertReplayInvariant();
  });

  test("rejects non-adjacent and locked movement without changing state, then honors an explicit exit update", () => {
    const executor = new ResearchWorldExecutor(WORLD);
    const initialHash = executor.stateHash();

    expect(executor.moveParty("nowhere")).toMatchObject({ accepted: false, reasonCode: "not_adjacent", deltas: [] });
    expect(executor.moveParty("vault")).toMatchObject({ accepted: false, reasonCode: "exit_not_open", deltas: [] });
    expect(executor.stateHash()).toBe(initialHash);
    expect(executor.deltas()).toEqual([]);

    expect(
      executor.execute({ kind: "setExitState", locationId: "dock", to: "vault", state: "open" }),
    ).toMatchObject({ accepted: true, mutated: true });
    expect(executor.moveParty("vault")).toMatchObject({ accepted: true, eventsFired: [] });
    expect(executor.snapshot().locationId).toBe("vault");
    executor.assertReplayInvariant();
  });

  test("marks campaign events once and never replays their effects on later entries", () => {
    const executor = new ResearchWorldExecutor(WORLD);
    expect(executor.moveParty("market").eventsFired).toEqual([
      "market-completes-quest",
      "market-objective-same-tick",
    ]);
    executor.moveParty("dock");
    expect(executor.moveParty("market").eventsFired).toEqual(["must-not-see-same-tick-item"]);
    expect(executor.snapshot().playerKnownFactIds).toEqual(["route-safe"]);
    executor.moveParty("dock");
    expect(executor.moveParty("market").eventsFired).toEqual([]);
    executor.assertReplayInvariant();
  });

  test("rolls a composite move back if an authored event effect is rejected", () => {
    const invalidEffectWorld = {
      ...WORLD,
      events: [
        {
          ...WORLD.events[0],
          effects: [
            WORLD.events[0].effects[0],
            { ...WORLD.events[0].effects[1], itemId: "not-held" },
          ],
        },
        ...WORLD.events.slice(1),
      ],
    };
    const executor = new ResearchWorldExecutor(invalidEffectWorld);
    const before = executor.stateHash();
    expect(() => executor.moveParty("market")).toThrow(/item_not_held/);
    expect(executor.stateHash()).toBe(before);
    expect(executor.deltas()).toEqual([]);
    executor.assertReplayInvariant();
  });
});

describe("ResearchWorldExecutor state operations", () => {
  test("discloses facts and transfers items with replayable absolute deltas", () => {
    const executor = new ResearchWorldExecutor(WORLD);
    const seed = executor.seedSnapshot();

    expect(executor.discloseFacts(["route-safe", "route-safe"])).toMatchObject({ accepted: true, mutated: true });
    expect(executor.transferItem("weather-chart", "mara", "player")).toMatchObject({
      accepted: true,
      mutated: true,
    });
    expect(executor.discloseFacts(["route-safe"])).toMatchObject({ accepted: true, mutated: false, deltas: [] });
    expect(executor.snapshot().playerKnownFactIds).toEqual(["route-safe"]);
    expect(executor.snapshot().entities.mara?.inventory).toEqual([]);
    expect(executor.snapshot().entities.player?.inventory).toEqual(["weather-chart"]);
    expect(foldResearchDeltas(seed, executor.deltas())).toEqual(executor.snapshot());
  });

  test("validates terminal case evidence and applies resolution effects exactly once", () => {
    const executor = new ResearchWorldExecutor(WORLD);
    executor.discloseFacts(["evidence-a", "evidence-b"]);
    executor.execute({ kind: "revealCaseEvidence", caseId: "missing-manifest", factId: "evidence-a" });
    executor.execute({ kind: "revealCaseEvidence", caseId: "missing-manifest", factId: "evidence-b" });
    const beforeAttempt = executor.stateHash();

    expect(
      executor.resolveCase({
        caseId: "missing-manifest",
        suspectId: "mara",
        citedEvidenceFactIds: ["evidence-a", "evidence-b"],
      }),
    ).toMatchObject({ accepted: false, reasonCode: "wrong_suspect", deltas: [] });
    expect(executor.stateHash()).toBe(beforeAttempt);
    expect(
      executor.resolveCase({
        caseId: "missing-manifest",
        suspectId: "culprit",
        citedEvidenceFactIds: ["evidence-a"],
      }),
    ).toMatchObject({ accepted: false, reasonCode: "missing_required_evidence", deltas: [] });

    const solved = executor.resolveCase({
      caseId: "missing-manifest",
      suspectId: "culprit",
      citedEvidenceFactIds: ["evidence-a", "evidence-b"],
    });
    expect(solved).toMatchObject({ accepted: true, mutated: true });
    expect(executor.snapshot().cases["missing-manifest"]?.status).toBe("solved");
    expect(executor.snapshot().objectives.investigation?.["identify-culprit"]).toBe(true);
    expect(executor.snapshot().quests.investigation).toBe("complete");
    expect(
      executor.resolveCase({
        caseId: "missing-manifest",
        suspectId: "culprit",
        citedEvidenceFactIds: ["evidence-a", "evidence-b"],
      }),
    ).toMatchObject({ accepted: false, reasonCode: "case_terminal", deltas: [] });
    executor.assertReplayInvariant();
  });
});

describe("research mechanics and canonical state", () => {
  test("is repeatable for a seed and varies only through the keyed mechanics seed", () => {
    const durations = Array.from({ length: 20 }, (_, index) =>
      keyedResearchTravelMinutes({
        seed: `seed-${index}`,
        worldId: "world.test",
        campaignId: "campaign.test",
        from: "dock",
        to: "market",
        departureClock: 0,
        baseMinutes: 10,
        jitter: 2,
      })
    );
    expect(new Set(durations).size).toBeGreaterThan(1);

    const first = new ResearchWorldExecutor(WORLD, { setup: { mechanicsSeed: "same-seed" } });
    const second = new ResearchWorldExecutor(WORLD, { setup: { mechanicsSeed: "same-seed" } });
    expect(first.moveParty("market").travelMinutes).toBe(second.moveParty("market").travelMinutes);
    expect(first.stateHash()).toBe(second.stateHash());
    expect(first.deltas()).toEqual(second.deltas());
  });

  test("canonical hashing ignores object insertion order but preserves array order", () => {
    expect(canonicalResearchJson({ z: 3, a: { d: 4, b: 2 } })).toBe('{"a":{"b":2,"d":4},"z":3}');
    expect(hashResearchValue({ b: 2, a: 1 })).toBe(hashResearchValue({ a: 1, b: 2 }));
    expect(hashResearchValue({ a: [1, 2] })).not.toBe(hashResearchValue({ a: [2, 1] }));
  });
});
