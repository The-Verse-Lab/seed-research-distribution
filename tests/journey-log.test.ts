/**
 * Journey memory (2026-07-25 fix wave) — the reducer's `moveParty` records every real party
 * movement into the bounded `modules.journey` log, so `# THE RECORD` can render `[TRAVELED]`
 * rows and an NPC can never again deny a road the party walked. Teleports (camp/room/captivity
 * scene framing) never log. Replay-safe: the `modulePatched` delta carries the ABSOLUTE log.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { DeltaEvent } from "../src/events/deltas.ts";
import { JOURNEY_LOG_CAP, readJourneySlice } from "../src/rules/journey.ts";
import { fromGameState, toGameState, type WorldModel } from "../src/world/model.ts";
import { applyCommand } from "../src/world/reducer.ts";
import { reduceDeltas } from "./support/replay.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

/** A ring of rooms so the party can walk in circles forever. */
function ringPlayset(): PlaySet {
  const ids = ["loc.a", "loc.b", "loc.c"];
  const world = WorldSchema.parse({
    id: "w.ring",
    name: "Ringworld",
    summary: "Around and around.",
    locations: ids.map((id, i) => ({
      id,
      name: id.toUpperCase(),
      description: `${id}.`,
      exits: [
        { to: ids[(i + 1) % ids.length]!, name: "onward", locked: false, hidden: false },
        { to: ids[(i + 2) % ids.length]!, name: "backward", locked: false, hidden: false },
      ],
    })),
    npcs: [],
  });
  const campaign = CampaignSchema.parse({
    id: "c.ring",
    name: "Ring Campaign",
    worldId: "w.ring",
    characters: [{ id: "pc.you", name: "You", stats: STATS, age: 30 }],
    startingState: { locationId: "loc.a", party: ["pc.you"], companions: [] },
  });
  return { world, campaign };
}

function modelOf(playset: PlaySet): WorldModel {
  const gs = {
    campaignId: playset.campaign.id,
    worldId: playset.world.id,
    partyLocationId: "loc.a",
    clock: 480,
    party: ["pc.you"],
    companions: [],
    actors: { "pc.you": { id: "pc.you", currentHp: 10, locationId: "loc.a", inventory: [], conditions: [] } },
    quests: {},
    relationships: {},
    autonomy: {},
    modules: {},
    flags: {},
  };
  return fromGameState(gs as never, playset.world, playset.campaign);
}

describe("journey log", () => {
  test("a real moveParty appends a leg with the departure clock and emits the absolute log", () => {
    const model = modelOf(ringPlayset());
    const res = applyCommand(model, { type: "moveParty", to: "loc.b" });
    expect(res.rejected).toBeUndefined();
    const patched = res.deltas.find((d) => d.kind === "modulePatched" && d.module === "journey");
    expect(patched).toBeDefined();
    const slice = readJourneySlice(model.modules);
    expect(slice.log).toEqual([{ fromId: "loc.a", toId: "loc.b", atClock: 480 }]);
  });

  test("the log is bounded: cap-plus-one moves keep only the newest JOURNEY_LOG_CAP legs", () => {
    const model = modelOf(ringPlayset());
    const ids = ["loc.a", "loc.b", "loc.c"];
    for (let i = 0; i < JOURNEY_LOG_CAP + 3; i++) {
      const to = ids[(i + 1) % ids.length]!;
      applyCommand(model, { type: "moveParty", to });
    }
    const log = readJourneySlice(model.modules).log;
    expect(log.length).toBe(JOURNEY_LOG_CAP);
    // The newest entry is the last move made.
    expect(log[log.length - 1]!.toId).toBe(ids[(JOURNEY_LOG_CAP + 3) % ids.length]!);
  });

  test("teleports never log — camp/room scene framing is not a journey", () => {
    const model = modelOf(ringPlayset());
    applyCommand(model, { type: "moveParty", to: "loc.b", teleport: true });
    expect(readJourneySlice(model.modules).log).toEqual([]);
  });

  test("snapshot == fold(deltas) across a travel chain (replay invariant)", () => {
    const playset = ringPlayset();
    const live = modelOf(playset);
    const seed = modelOf(playset);
    const deltas: DeltaEvent[] = [];
    let seq = 0;
    for (const to of ["loc.b", "loc.c", "loc.a", "loc.b"]) {
      const res = applyCommand(live, { type: "moveParty", to });
      for (const d of res.deltas) deltas.push({ ...d, id: `d${seq}`, at: 0, seq: seq++ } as DeltaEvent);
    }
    const folded = reduceDeltas(seed, deltas);
    expect(toGameState(folded)).toEqual(toGameState(live));
    expect(readJourneySlice(folded.modules).log.length).toBe(4);
  });
});
