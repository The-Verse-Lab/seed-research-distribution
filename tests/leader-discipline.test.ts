/**
 * Leader disciplinary authority over the PC (Feature 3) — focused, pure tests for
 * `chooseLeaderDiscipline` (src/rules/agenda.ts). A party leader's CORPORAL discipline of the player
 * is emergent from its per-PC stance (alignment + personality + relationship) plus accumulated
 * grievance — no authored flag. Exercised against a hand-built WorldModel + a real `stance()` read
 * (no engine, no gateway), asserting the OUTCOME: a strike (`adjustHp`) from a cruel leader, a cowing
 * (`applyStatusEffect`) from a colder tyrant, escalation under grievance, and a hard `null` for a
 * warm or harm-averse leader. One reducer round-trip confirms the consequence actually lands.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type Alignment } from "../src/content/schema.ts";
import { fromGameState, type WorldModel } from "../src/world/model.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { chooseLeaderDiscipline, stance } from "../src/rules/agenda.ts";
import type { GameState } from "../src/state/types.ts";
import type { World, Campaign } from "../src/content/schema.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 20, armorClass: 10 };

/** A leader (`npc.lead`) and the PC (`pc.you`) co-located at `loc.a`, with the leader's authored
 *  morality/personality/relationship/exploitative set for the scenario. Returns the pieces the pure
 *  chooser needs plus the leader template. */
function setup(opts: {
  alignment: Alignment;
  personality?: string;
  rel?: number;
  exploitative?: boolean;
}): { model: WorldModel; world: World; campaign: Campaign; template: World["npcs"][number] } {
  const world = WorldSchema.parse({
    id: "w.d",
    name: "Discipline World",
    summary: "A test fixture.",
    locations: [{ id: "loc.a", name: "The Yard", description: "" }],
    npcs: [
      {
        id: "npc.lead",
        name: "Cass",
        persona: "A test leader.",
        alignment: opts.alignment,
        ...(opts.personality ? { personalityTemplate: opts.personality } : {}),
        ...(opts.exploitative ? { exploitative: true } : {}),
        relationships: { "pc.you": opts.rel ?? 0 },
        stats: STATS,
        autonomy: { isPartyMember: true, level: "leader", canLead: true },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.d",
    name: "Discipline Campaign",
    worldId: "w.d",
    characters: [{ id: "pc.you", name: "You", stats: STATS, inventory: [] }],
    quests: [],
    startingState: { locationId: "loc.a", party: ["pc.you"], companions: ["npc.lead"] },
  });
  const gs: GameState = {
    campaignId: "c.d",
    worldId: "w.d",
    partyLocationId: "loc.a",
    clock: 0,
    party: ["pc.you"],
    companions: ["npc.lead"],
    actors: {
      "pc.you": { id: "pc.you", currentHp: 20, locationId: "loc.a", inventory: [], conditions: [] },
      "npc.lead": { id: "npc.lead", currentHp: 20, locationId: "loc.a", inventory: [], conditions: [] },
    } as unknown as GameState["actors"],
    quests: {},
    // stance() reads the live model relationship graph (not the template's authored starting value),
    // so seed the leader→PC Friendship here for the scenario.
    relationships: { "npc.lead": { "pc.you": opts.rel ?? 0 } },
    autonomy: {},
    modules: { autonomy: {} },
    flags: {},
  };
  const model = fromGameState(gs, world, campaign);
  return { model, world, campaign, template: world.npcs[0]! };
}

function disciplineOf(opts: Parameters<typeof setup>[0], grievance = 0) {
  const { model, world, campaign, template } = setup(opts);
  const s = stance(template, "pc.you", model, world, campaign);
  return { action: chooseLeaderDiscipline(template, s, grievance, model, world), model, disposition: s.disposition };
}

describe("chooseLeaderDiscipline (Feature 3)", () => {
  test("a cruel exploitative leader (ce / brute, soured relationship) STRIKES the PC — and it lands", () => {
    const { action, model } = disciplineOf({ alignment: "ce", personality: "brute", rel: -70, exploitative: true });
    expect(action).not.toBeNull();
    expect(action!.kind).toBe("demand");
    if (action!.kind === "demand") {
      expect(action!.consequence.type).toBe("adjustHp");
      expect(action!.resist.ability).toBe("dex");
      // A failed resist applies the strike through the reducer — the PC actually takes the hurt.
      const before = model.entities.get("pc.you")!.stats!.currentHp;
      applyCommand(model, action!.consequence);
      expect(model.entities.get("pc.you")!.stats!.currentHp).toBeLessThan(before);
    }
  });

  test("a colder tyrant (le / schemer) COWS the PC (applyStatusEffect) rather than striking — and it lands", () => {
    // Grievance tips a stern-but-not-exploitative leader into the corporal tier as a cowing, not a blow.
    const { action, model } = disciplineOf({ alignment: "le", personality: "schemer", rel: -40 }, 2);
    expect(action).not.toBeNull();
    if (action && action.kind === "demand") {
      expect(action.consequence.type).toBe("applyStatusEffect");
      applyCommand(model, action.consequence);
      expect(model.entities.get("pc.you")!.stats!.conditions).toContain("cowed");
    }
  });

  test("a GOOD / caretaker leader never disciplines the body (harm off-limits ⇒ null)", () => {
    expect(disciplineOf({ alignment: "lg", personality: "caretaker", rel: 0 }, 3).action).toBeNull();
    // Even a bare good alignment (harmInnocent off-limits) refuses corporal discipline.
    expect(disciplineOf({ alignment: "ng", rel: -20 }, 3).action).toBeNull();
  });

  test("a WARM leader (devoted / high regard) never disciplines", () => {
    expect(disciplineOf({ alignment: "ng", rel: 85 }).action).toBeNull();
  });

  test("grievance escalates: a stern evil leader that wouldn't act cold DOES once it nurses a grudge", () => {
    const calm = disciplineOf({ alignment: "ne", personality: "schemer", rel: -30 }, 0).action;
    const aggrieved = disciplineOf({ alignment: "ne", personality: "schemer", rel: -30 }, 3).action;
    expect(calm).toBeNull();
    expect(aggrieved).not.toBeNull();
  });
});
