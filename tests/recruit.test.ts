/**
 * Guild-hall recruitment tests (the hall-as-hub wave, Phase B) — the recruit-board projection
 * (`recruitBoardOf`), hiring a mercenary off the board (`resolveHireMercenary`), joining an NPC
 * leader's crew as a FOLLOWER (`resolveJoinParty`, the mirror of invite), and the contested leave
 * gate engaging the moment an NPC leader is signed on with. Offline gateway + scripted classifier
 * throughout — every assertion is deterministic.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";
import type { TurnPlan } from "../src/engine/turn-plan.ts";
import type { TurnClassifier } from "../src/engine/classify.ts";
import { mulberry32, type Rng } from "../src/rules/dice.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import { byKind } from "./support/harness.ts";
import { partyLeaderOf, type PartySlice } from "../src/rules/party.ts";
import {
  recruitDayOf,
  recruitOfferId,
  seededMercName,
  type PartyWagesSlice,
  type RecruitBoardSlice,
} from "../src/rules/recruit.ts";
import { recruitBoardOf } from "../src/state/projections.ts";
import type { RecruitBoardRef } from "../src/state/projections.ts";

const PC = "pc.you";
const HALL = "loc.hall";
const LEADER = "npc.captain";
const LOITERER = "npc.rook";
const HIRE_CP = 40;
const WAGE_CP = 5;
const SLOTS = 2;

const pcStats = { abilities: { str: 12, dex: 12, con: 10, int: 10, wis: 12, cha: 12 }, maxHp: 16, armorClass: 10 };

/** A guild hall with a 2-slot recruit board, a leader-capable NPC (canLead), and an ordinary
 *  present NPC — neither in the party at start. */
function hallPlayset(): PlaySet {
  const world = WorldSchema.parse({
    id: "w.hall",
    name: "Hall Recruitment Test",
    summary: "A guild hall with a board of sellswords for hire.",
    locations: [
      {
        id: HALL,
        name: "The Broken Crown",
        description: "A guild hall with beds and a board of contracts.",
        npcs: [LEADER, LOITERER],
        guild: {
          name: "The Broken Crown",
          recruits: { hireCp: HIRE_CP, wageCp: WAGE_CP, slots: SLOTS },
        },
      },
    ],
    npcs: [
      {
        id: LEADER,
        name: "Captain Ase",
        summary: "A hard-eyed company captain.",
        persona: "Blunt, commanding, weighs every recruit before taking them on.",
        autonomy: { isPartyMember: false, level: "leader", canLead: true },
      },
      {
        id: LOITERER,
        name: "Rook",
        persona: "Idle, watchful, minds their own business.",
        autonomy: { isPartyMember: false, level: "reactive" },
      },
    ],
  });
  const campaign = CampaignSchema.parse({
    id: "c.hall",
    name: "Hall Recruitment Campaign",
    worldId: world.id,
    characters: [{ id: PC, name: "You", stats: pcStats, age: 30 }],
    startingState: { locationId: HALL, party: [PC], companions: [] },
  });
  return { world, campaign };
}

/** The PC alone at the hall, carrying `coins`. `relationships` lets a test seed a hostile leader. */
function hallState(coins: number, relationships: Record<string, Record<string, number>> = {}): GameState {
  return {
    campaignId: "c.hall",
    worldId: "w.hall",
    partyLocationId: HALL,
    clock: 600, // day 0
    party: [PC],
    companions: [],
    actors: {
      [PC]: { id: PC, currentHp: pcStats.maxHp, locationId: HALL, inventory: [], conditions: [], coins },
    },
    quests: {},
    relationships,
    autonomy: {},
    modules: {},
    flags: {},
  };
}

function planOf(partial: Partial<TurnPlan>): TurnPlan {
  return {
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 1,
    ...partial,
  };
}
function scriptedClassifier(plans: TurnPlan[]): TurnClassifier {
  let i = 0;
  return { classify: () => Promise.resolve(plans[Math.min(i++, plans.length - 1)] ?? planOf({})) };
}

/** A scripted RNG: pushed values are consumed in order; anything unscripted draws the filler. */
function scriptedRng(filler = 0.31): { rng: Rng; script: number[] } {
  const script: number[] = [];
  return { rng: () => (script.length > 0 ? (script.shift() as number) : filler), script };
}

async function engineWith(
  playset: PlaySet,
  plans: TurnPlan[],
  opts: { coins?: number; rng?: Rng; relationships?: Record<string, Record<string, number>> } = {},
): Promise<GameEngine> {
  const store = new InMemoryGameStateStore();
  const state = hallState(opts.coins ?? 100, opts.relationships ?? {});
  await store.save(makeSaveKey(playset.campaign.id, PC), state);
  return new GameEngine({
    classifier: scriptedClassifier(plans),
    playset,
    store,
    gateway: new OfflineGateway(),
    rng: opts.rng ?? mulberry32(11),
  });
}

const partySliceOf = (engine: GameEngine): PartySlice =>
  (engine.getState().modules?.party as PartySlice | undefined) ?? { leaderId: null, pendingLeave: {} };
const recruitBoardSliceOf = (engine: GameEngine): RecruitBoardSlice =>
  (engine.getState().modules?.recruitBoard as RecruitBoardSlice | undefined) ?? { hired: [] };
const partyWagesSliceOf = (engine: GameEngine): PartyWagesSlice =>
  (engine.getState().modules?.partyWages as PartyWagesSlice | undefined) ?? {};

// ---------------------------------------------------------------------------------------------

describe("seededMercName — PC-name collision avoidance (r4)", () => {
  test("colliding first name rerolls (surname kept); non-colliding boards are byte-identical", () => {
    // Find an offer id whose default draw is a known first name, then avoid exactly that name.
    let offerId = "";
    let first = "";
    let last = "";
    for (let slot = 0; slot < 64 && !offerId; slot++) {
      const id = recruitOfferId("loc.hall", 0, slot);
      const [f, l] = seededMercName(id).split(" ");
      if (f && l) {
        offerId = id;
        first = f;
        last = l;
      }
    }
    expect(offerId).not.toBe("");

    // Collision: the first name changes, the surname does not, and the result avoids the PC name.
    const avoided = seededMercName(offerId, `${first} Vane`);
    expect(avoided.split(" ")[0]).not.toBe(first);
    expect(avoided.split(" ")[1]).toBe(last);
    expect(avoided.split(" ")[0]!.toLowerCase()).not.toBe(first.toLowerCase());

    // Non-collision: byte-identical to the unavoided draw. Deterministic across calls.
    expect(seededMercName(offerId, "Unrelated Person")).toBe(`${first} ${last}`);
    expect(seededMercName(offerId, `${first} Vane`)).toBe(avoided);
    expect(seededMercName(offerId)).toBe(`${first} ${last}`);
  });
});

describe("recruitBoardOf — the pure hall projection", () => {
  test("same (hall, day) yields identical offer ids + names across calls (pure/deterministic)", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, []);
    await engine.start();
    const state = engine.getState();

    const first = recruitBoardOf(playset, state);
    const second = recruitBoardOf(playset, state);
    expect(first).toEqual(second);
    expect(first?.mercs).toHaveLength(SLOTS);
    expect(first?.mercs.every((m) => m.name.trim().length > 0)).toBe(true);
  });

  test("a different in-world day yields different offer ids", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, []);
    await engine.start();
    const state = engine.getState();

    const day0 = recruitBoardOf(playset, state) as RecruitBoardRef;
    const day1 = recruitBoardOf(playset, { ...state, clock: state.clock + 1440 }) as RecruitBoardRef;

    const idsDay0 = new Set(day0.mercs.map((m) => m.offerId));
    const idsDay1 = day1.mercs.map((m) => m.offerId);
    expect(idsDay1.some((id) => idsDay0.has(id))).toBe(false);
    // And the ids are exactly the deterministic (hall, day, slot) formula.
    expect(idsDay0).toEqual(new Set([recruitOfferId(HALL, 0, 0), recruitOfferId(HALL, 0, 1)]));
    expect(new Set(idsDay1)).toEqual(new Set([recruitOfferId(HALL, 1, 0), recruitOfferId(HALL, 1, 1)]));
  });

  test("a hired offer id is filtered off the board", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, []);
    await engine.start();
    const state = engine.getState();
    const board = recruitBoardOf(playset, state) as RecruitBoardRef;
    const takenId = board.mercs[0]!.offerId;

    const withHire: GameState = {
      ...state,
      modules: { ...state.modules, recruitBoard: { hired: [takenId] } satisfies RecruitBoardSlice },
    };
    const after = recruitBoardOf(playset, withHire) as RecruitBoardRef;
    expect(after.mercs.map((m) => m.offerId)).not.toContain(takenId);
    expect(after.mercs).toHaveLength(SLOTS - 1);
  });

  test("a hall with no guild.recruits shows no mercs (loiterers/leaders unaffected)", async () => {
    const playset = hallPlayset();
    playset.world.locations.find((l) => l.id === HALL)!.guild!.recruits = undefined;
    const engine = await engineWith(playset, []);
    await engine.start();
    const board = recruitBoardOf(playset, engine.getState());

    expect(board?.mercs).toEqual([]);
    expect(board?.leaders.map((l) => l.id)).toContain(LEADER);
    expect(board?.loiterers.map((l) => l.id)).toContain(LOITERER);
  });

  test("a leader-capable present NPC lands in `leaders`, an ordinary one in `loiterers`, and party members are excluded", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, []);
    await engine.start();
    const state = engine.getState();
    const board = recruitBoardOf(playset, state) as RecruitBoardRef;

    expect(board.leaders).toEqual([expect.objectContaining({ id: LEADER, name: "Captain Ase" })]);
    expect(board.loiterers).toEqual([expect.objectContaining({ id: LOITERER, name: "Rook" })]);

    // Once a candidate is a party member (companion), the board no longer lists them.
    const withCompanion: GameState = { ...state, companions: [...state.companions, LOITERER] };
    const after = recruitBoardOf(playset, withCompanion) as RecruitBoardRef;
    expect(after.loiterers.map((l) => l.id)).not.toContain(LOITERER);
    expect(after.leaders.map((l) => l.id)).toContain(LEADER); // untouched
  });

  test("ambient `template#n` crowd instances are kept off the loiterer list (only individuated NPCs)", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, []);
    await engine.start();
    const state = engine.getState();

    // An AmbientLifeModule extra: a statless `#n` instance of a generic template, present at the hall.
    // Several such extras share one label, so surfacing them reads as duplicate nameless [RECRUIT] rows.
    const ambientId = `${LOITERER}#0`;
    const withCrowd: GameState = {
      ...state,
      authoredNpcs: { ...(state.authoredNpcs ?? {}), [ambientId]: { locationId: HALL, flags: {}, tier: "transient" } },
    };
    const board = recruitBoardOf(playset, withCrowd) as RecruitBoardRef;
    const ids = board.loiterers.map((l) => l.id);
    expect(ids).toContain(LOITERER); // the authored NPC present as itself still surfaces
    expect(ids).not.toContain(ambientId); // the ambient crowd instance is filtered out
  });
});

// ---------------------------------------------------------------------------------------------

describe("resolveHireMercenary — hiring off the board", () => {
  test("hiring slot 0 charges coin, spawns a live companion at the hall, and records the seat + wage", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, [], { coins: 100 });
    await engine.start();
    const day = recruitDayOf(engine.getState().clock);
    const offerId = recruitOfferId(HALL, day, 0);
    const before = recruitBoardOf(playset, engine.getState()) as RecruitBoardRef;
    const offerName = before.mercs.find((m) => m.offerId === offerId)!.name;

    await engine.submitAction({ kind: "hireMerc", offerId });

    const s = engine.getState();
    expect(s.actors[PC]!.coins).toBe(100 - HIRE_CP);
    const merc = s.actors[offerId];
    expect(merc).toBeTruthy();
    expect(merc!.locationId).toBe(HALL);
    // The board offer carried a real, seeded sellsword name; the hire derives the SAME identity from
    // the same offer id (the GameState actor projection doesn't surface a display-name field — the
    // name rides the entity + names map — so we assert on the board name it was hired from).
    expect(offerName.trim().length).toBeGreaterThan(0);
    expect(s.companions).toContain(offerId); // partyMember === true, projected as a companion
    expect(recruitBoardSliceOf(engine).hired).toContain(offerId);
    expect(partyWagesSliceOf(engine)[offerId]).toBe(WAGE_CP);
  });

  test("re-hiring the same (already taken) offer is refused — no double charge, no second spawn", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, [], { coins: 100 });
    await engine.start();
    const offerId = recruitOfferId(HALL, recruitDayOf(engine.getState().clock), 0);
    await engine.submitAction({ kind: "hireMerc", offerId });
    const coinsAfterFirstHire = engine.getState().actors[PC]!.coins;

    await engine.submitAction({ kind: "hireMerc", offerId });

    expect(engine.getState().actors[PC]!.coins).toBe(coinsAfterFirstHire);
    // Still exactly one entry for this offer id — no duplicate charge landed.
    expect(recruitBoardSliceOf(engine).hired.filter((id) => id === offerId)).toHaveLength(1);
  });

  test("too little coin refuses the hire — no charge, no spawn", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, [], { coins: HIRE_CP - 1 });
    await engine.start();
    const offerId = recruitOfferId(HALL, recruitDayOf(engine.getState().clock), 0);

    await engine.submitAction({ kind: "hireMerc", offerId });

    const s = engine.getState();
    expect(s.actors[PC]!.coins).toBe(HIRE_CP - 1);
    expect(s.actors[offerId]).toBeUndefined();
    expect(recruitBoardSliceOf(engine).hired).toEqual([]);
  });

  test("a forged/off-board offer id is refused", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, [], { coins: 100 });
    await engine.start();

    await engine.submitAction({ kind: "hireMerc", offerId: "merc.forged.999.0" });

    const s = engine.getState();
    expect(s.actors[PC]!.coins).toBe(100);
    expect(s.actors["merc.forged.999.0"]).toBeUndefined();
    expect(recruitBoardSliceOf(engine).hired).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("resolveJoinParty — signing on WITH a present leader (mode 3, the mirror of invite)", () => {
  test("joining a present canLead leader flips who leads: the leader becomes a party member and partyLeaderOf, the PC follows", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, []);
    await engine.start();

    await engine.submitAction({ kind: "joinParty", leaderId: LEADER });

    const s = engine.getState();
    expect(s.actors[LEADER]).toBeTruthy();
    expect(s.companions).toContain(LEADER);
    expect(partyLeaderOf(s.modules ?? {})).toBe(LEADER);
    expect(partySliceOf(engine).leaderId).toBe(LEADER);
  });

  test("a subsequent leave attempt is CONTESTED (not a free release) once an NPC leader is signed on with", async () => {
    const playset = hallPlayset();
    const { rng, script } = scriptedRng();
    const engine = await engineWith(
      playset,
      [planOf({ kind: "partyAction", targetId: null, party: { verb: "leave", targetId: null } })],
      { rng },
    );
    await engine.start();
    await engine.submitAction({ kind: "joinParty", leaderId: LEADER });
    expect(partyLeaderOf(engine.getState().modules ?? {})).toBe(LEADER);

    const events: import("../src/events/types.ts").GameEvent[] = [];
    engine.subscribe((e) => events.push(e));
    script.push(0); // natural 1 on the release ask — guaranteed denial, never a free release
    await engine.submitPlayerInput("I want to leave your company.");

    const rolls = byKind(events, "diceRolled");
    expect(rolls).toHaveLength(1); // the contested-hold ask, not an instant unopposed release
    expect(rolls[0]!.success).toBe(false);
    expect(byKind(events, "partyLeaveDenied")).toEqual([expect.objectContaining({ entityId: PC })]);
    // Still bound: nobody was released, the leader still leads.
    expect(byKind(events, "partyMembershipChanged")).toHaveLength(0);
    expect(engine.getState().companions).toContain(LEADER);
    expect(partyLeaderOf(engine.getState().modules ?? {})).toBe(LEADER);
    const narration = byKind(events, "narration");
    expect(narration.some((n) => n.text.includes("refuses to let you leave the party"))).toBe(true);
  });

  test("joining a NON-leader present NPC is refused — it points the player at inviting instead, and sets no leader", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, []);
    await engine.start();

    await engine.submitAction({ kind: "joinParty", leaderId: LOITERER });

    const s = engine.getState();
    expect(s.actors[LOITERER]).toBeFalsy();
    expect(s.companions).not.toContain(LOITERER);
    expect(partyLeaderOf(s.modules ?? {})).toBeNull();
  });

  test("a stance-refusing (hostile) leader refuses to sign the PC on — no membership, no leader change", async () => {
    const playset = hallPlayset();
    // Deeply hostile toward the PC (<= HOSTILE_RELATIONSHIP_MAX) routes decideInvite to the
    // Opportunist gate: a roll at the threshold forces the refusal branch deterministically.
    const engine = await engineWith(playset, [], { rng: () => 0.99, relationships: { [LEADER]: { [PC]: -60 } } });
    await engine.start();

    await engine.submitAction({ kind: "joinParty", leaderId: LEADER });

    const s = engine.getState();
    expect(s.actors[LEADER]).toBeFalsy();
    expect(s.companions).not.toContain(LEADER);
    expect(partyLeaderOf(s.modules ?? {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("classifier `join` verb — a scripted plan resolves to resolveJoinParty, never a regex net", () => {
  // The heuristic test-input DSL (tests/support/test-classifier.ts) is FROZEN and has no net for
  // the new "join" verb (owner rule: never grow it — new intents get scripted stubs instead). This
  // exercises the plan shape a real classifier would emit, exactly as `reconcilePlan` would leave it.
  test("a partyAction/join plan makes the PC follow the named leader", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, [
      planOf({ kind: "partyAction", targetId: LEADER, party: { verb: "join", targetId: LEADER } }),
    ]);
    await engine.start();

    await engine.submitPlayerInput("I throw in with the captain's crew.");

    const s = engine.getState();
    expect(s.companions).toContain(LEADER);
    expect(partyLeaderOf(s.modules ?? {})).toBe(LEADER);
  });

  test("(mirror) a partyAction/invite plan still makes the NPC join the PC's party, with the PC leading", async () => {
    const playset = hallPlayset();
    const engine = await engineWith(playset, [
      planOf({ kind: "partyAction", targetId: LOITERER, party: { verb: "invite", targetId: LOITERER } }),
    ]);
    await engine.start();

    await engine.submitPlayerInput("Rook, come with us.");

    const s = engine.getState();
    expect(s.companions).toContain(LOITERER);
    // Ownership is the OPPOSITE of join: no NPC leader was set, so the PC leads by default.
    expect(partyLeaderOf(s.modules ?? {})).toBeNull();
  });
});
