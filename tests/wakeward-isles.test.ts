/** Bundled-content contract for The Wakeward Isles. */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import type { PlaySet } from "../src/content/schema.ts";

const DIR = fileURLToPath(new URL("../worlds/wakeward-isles", import.meta.url));
const loadWakeward = (): Promise<PlaySet> => loadPlaySetFromDir(DIR);

function shortestMinutes(playset: PlaySet, from: string, to: string): number {
  const distances = new Map<string, number>([[from, 0]]);
  const pending = new Set<string>([from]);
  while (pending.size > 0) {
    const current = [...pending].sort((a, b) => (distances.get(a)! - distances.get(b)!))[0]!;
    pending.delete(current);
    const base = distances.get(current)!;
    if (current === to) return base;
    const location = playset.world.locations.find((row) => row.id === current);
    for (const exit of location?.exits ?? []) {
      if (exit.to.startsWith("frontier:")) continue;
      const next = base + (exit.minutes ?? 30);
      if (next < (distances.get(exit.to) ?? Number.POSITIVE_INFINITY)) {
        distances.set(exit.to, next);
        pending.add(exit.to);
      }
    }
  }
  return Number.POSITIVE_INFINITY;
}

describe("Wakeward Isles authored world", () => {
  test("is a connected four-region, twelve-location circuit with no procedural edge", async () => {
    const playset = await loadWakeward();
    expect(playset.world.id).toBe("world.wakeward-isles");
    expect(playset.campaign.id).toBe("camp.wakeward.first-circuit");
    expect(playset.world.regions.map((row) => row.id).sort()).toEqual([
      "bellharbor",
      "cinderhook",
      "highwake",
      "lowmere",
    ]);
    expect(playset.world.locations).toHaveLength(12);
    expect(playset.world.locations.every((row) => row.exits.length > 0)).toBe(true);
    expect(playset.world.locations.flatMap((row) => row.exits).some((exit) => exit.to.startsWith("frontier:"))).toBe(false);
    expect(playset.world.frontierExpansion).toBe(false);

    const start = playset.campaign.startingState.locationId;
    for (const location of playset.world.locations) {
      expect(shortestMinutes(playset, start, location.id), location.id).toBeFinite();
    }
  });

  test("ships the exact recurring cast and legitimate-interest factions", async () => {
    const { world, campaign } = await loadWakeward();
    expect(world.npcs).toHaveLength(12);
    expect(world.factions.map((row) => row.name).sort()).toEqual([
      "Free Ferries",
      "Island Commons",
      "Relay Office",
    ]);
    expect(campaign.startingState.companions).toEqual(["npc.mara-venn"]);
    const mara = world.npcs.find((row) => row.id === "npc.mara-venn")!;
    expect(mara.autonomy).toMatchObject({ isPartyMember: true, level: "proactive", canLead: false });
    expect(world.npcs.filter((row) => row.autonomy.isPartyMember)).toEqual([mara]);
  });

  test("uses structured epistemic authoring for every recurring NPC", async () => {
    const { world } = await loadWakeward();
    expect(world.facts).toHaveLength(36);
    expect(world.facts?.filter((fact) => fact.supersededBy)).toHaveLength(2);
    expect(world.facts?.filter((fact) => fact.tags.includes("distractor")).length).toBeGreaterThanOrEqual(3);
    expect(world.facts?.some((fact) => fact.scope.locationIds.length > 0)).toBe(true);
    expect(world.facts?.some((fact) => fact.scope.regionIds.length > 0)).toBe(true);
    expect(world.facts?.some((fact) => fact.scope.factionIds.length > 0)).toBe(true);
    for (const npc of world.npcs) {
      expect(npc.knowledge.length, npc.id).toBeGreaterThan(0);
      expect(npc.knowledge.every((entry) => typeof entry !== "string"), npc.id).toBe(true);
      expect(npc.privateKnowledge, npc.id).toBeDefined();
      expect(npc.goals.length, npc.id).toBeGreaterThan(0);
      expect(npc.personality.trim().length, npc.id).toBeGreaterThan(0);
      expect(Object.keys(npc.relationships).length, npc.id).toBeGreaterThan(0);
      expect(npc.schedule?.slots.length, npc.id).toBeGreaterThan(0);
    }
  });

  test("keeps all six task families nonlethal and mechanically completable", async () => {
    const playset = await loadWakeward();
    const expected = [
      "quest.clear-glass",
      "quest.cold-passage",
      "quest.missing-manifest",
      "quest.second-bell",
      "quest.shared-stores",
      "quest.true-bearing",
    ];
    expect(playset.campaign.quests.map((row) => row.id).sort()).toEqual(expected);
    expect(playset.world.monsters).toEqual([]);
    expect(playset.world.spells).toEqual([]);
    expect(playset.campaign.travelEvents).toEqual([]);
    expect(playset.campaign.travelEventChance).toBe(0);
    expect(playset.campaign.roomEvents).toEqual([]);
    expect(playset.campaign.roomEventChance).toBe(0);
    expect(playset.world.constitution.useGenericDefeatOutcomes).toBe(false);
    expect(playset.world.constitution.defeatOutcomes).toEqual([]);
    expect(JSON.stringify(playset.campaign.events)).not.toContain('"kind":"ambush"');
    expect(JSON.stringify(playset.campaign.events)).not.toContain('"kind":"adjustHp"');

    const objectiveEffects = new Set(
      playset.campaign.events.flatMap((event) => event.effects).flatMap((effect) =>
        effect.kind === "setObjectiveDone" ? [`${effect.questId}/${effect.objectiveId}`] : []),
    );
    const caseObjectives = new Set(
      playset.campaign.cases.flatMap((row) => row.accusation.successEffects).flatMap((effect) =>
        effect.kind === "setObjectiveDone" ? [`${effect.questId}/${effect.objectiveId}`] : []),
    );
    const completions = new Set(
      playset.campaign.events.flatMap((event) => event.effects).flatMap((effect) =>
        effect.kind === "setQuestState" && effect.state === "complete" ? [effect.questId] : []),
    );
    for (const quest of playset.campaign.quests) {
      for (const objective of quest.objectives) {
        expect(
          objectiveEffects.has(`${quest.id}/${objective.id}`) || caseObjectives.has(`${quest.id}/${objective.id}`),
          `${quest.id}/${objective.id}`,
        ).toBe(true);
      }
      if (quest.id !== "quest.missing-manifest") expect(completions.has(quest.id), quest.id).toBe(true);
      else expect(playset.campaign.cases.some((row) => row.questId === quest.id)).toBe(true);
    }
  });

  test("every deadline comfortably covers its authored critical route", async () => {
    const playset = await loadWakeward();
    const start = playset.campaign.startingState.locationId;
    const routes: Record<string, string[]> = {
      "quest.cold-passage": ["loc.bellharbor-relay", "loc.lowmere-clinic"],
      "quest.second-bell": ["loc.cinder-ferry-yard", "loc.cinder-drydock"],
      "quest.clear-glass": ["loc.cinder-glassworks", "loc.highwake-beacon"],
      "quest.true-bearing": ["loc.highwake-weather", "loc.bellharbor-quay"],
      "quest.shared-stores": ["loc.cinder-drydock", "loc.highwake-weather"],
      "quest.missing-manifest": ["loc.cinder-ferry-yard", "loc.bellharbor-relay", "loc.bellharbor-quay"],
    };
    for (const quest of playset.campaign.quests) {
      let minutes = 0;
      let from = start;
      for (const to of routes[quest.id] ?? []) {
        minutes += shortestMinutes(playset, from, to);
        from = to;
      }
      expect(minutes, quest.id).toBeFinite();
      expect(quest.deadlineMinutes, quest.id).toBeGreaterThanOrEqual(minutes * 2);
      expect(quest.deadlineFailText?.trim().length, quest.id).toBeGreaterThan(0);
    }
  });
});
