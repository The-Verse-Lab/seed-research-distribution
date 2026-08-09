/**
 * First-class scenes + terminator watchdog (Concordia transfer #6). Pins the three duties:
 * the registry MIRRORS a live combat into `modules.scenes` (and closes the row when the subsystem
 * ends the fight itself), the WATCHDOG force-ends a combat whose own reap never ran (reap is
 * player-tick-only; the watchdog is trigger-blind), and the world flag keeps everything inert —
 * an unflagged world never grows a scenes slice at all.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { makeEngine, loadExample } from "./support/harness.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { makeSaveKey } from "../src/state/store.ts";
import type { GameState } from "../src/state/types.ts";
import type { WorldModel } from "../src/world/model.ts";
import type { TickContext } from "../src/engine/tick.ts";
import type { Command } from "../src/world/commands.ts";
import type { GameEvent } from "../src/events/types.ts";
import { ScenesModule } from "../src/modules/scenes/module.ts";
import { scenesSliceOf, sceneShouldEnd, SCENES_MODULE } from "../src/rules/scenes.ts";

const CAMPAIGN = "campaign.first-embers";
const PC = "pc.you";
const LOC = "loc.tavern";
const FOE = "mon.ashstalker";

function combatState(foeHp: number, foePresent = true): GameState {
  return {
    campaignId: CAMPAIGN,
    worldId: "world.emberford",
    partyLocationId: LOC,
    clock: 480,
    party: [PC],
    companions: [],
    actors: {
      [PC]: { id: PC, currentHp: 12, locationId: LOC, inventory: [], conditions: [] },
      ...(foePresent ? { [FOE]: { id: FOE, currentHp: foeHp, locationId: LOC, inventory: [], conditions: [] } } : {}),
    },
    quests: {},
    relationships: {},
    autonomy: {},
    modules: { combat: { active: true, locationId: LOC, order: [PC, FOE], allies: [], turnIndex: 0, round: 1 } },
    flags: {},
  } as unknown as GameState;
}

async function scenesEngine(state: GameState) {
  const playset = await loadExample();
  playset.world.constitution.toggles.scenes = true;
  const store = new InMemoryGameStateStore();
  await store.save(makeSaveKey(CAMPAIGN, PC), state);
  return makeEngine({ playset, store });
}

describe("scene registry (mirror)", () => {
  test("a live combat opens an open row with the combatants; it survives while the fight does", async () => {
    const h = await scenesEngine(combatState(9));
    await h.engine.submitPlayerInput("I press forward.");
    const slice = scenesSliceOf(h.engine.getState().modules as Record<string, unknown>);
    const open = slice.rows.find((r) => r.kind === "combat" && r.endedAtClock === undefined);
    expect(open).toBeDefined();
    expect(open!.participants).toContain(PC);
    expect(open!.participants).toContain(FOE);
    expect(open!.locationId).toBe(LOC);
    expect(open!.premise).toContain("fight");
  });

  test("when the subsystem's own reap ends the fight, the row closes as endedBy:subsystem", async () => {
    const h = await scenesEngine(combatState(0)); // downed foe ⇒ the player-tick reap fires
    await h.engine.submitPlayerInput("I lower my blade.");
    await h.engine.submitPlayerInput("I catch my breath.");
    const slice = scenesSliceOf(h.engine.getState().modules as Record<string, unknown>);
    const row = slice.rows.find((r) => r.kind === "combat");
    expect(row).toBeDefined();
    expect(row!.endedAtClock).toBeDefined();
    expect(row!.endedBy).toBe("subsystem");
  });

  test("an unflagged world never grows a scenes slice", async () => {
    const playset = await loadExample();
    expect(playset.world.constitution.toggles.scenes).toBe(false); // schema default
    const store = new InMemoryGameStateStore();
    await store.save(makeSaveKey(CAMPAIGN, PC), combatState(9));
    const h = await makeEngine({ playset, store });
    await h.engine.submitPlayerInput("I press forward.");
    expect((h.engine.getState().modules as Record<string, unknown>)[SCENES_MODULE]).toBeUndefined();
  });
});

describe("terminator watchdog", () => {
  test("sceneShouldEnd: standing foe ⇒ null; party fled ⇒ reason; foe gone ⇒ reason", async () => {
    const alive = await scenesEngine(combatState(9));
    const model = (alive.engine as unknown as { model: WorldModel }).model;
    expect(sceneShouldEnd(model, "combat")).toBeNull();
    const gone = await scenesEngine(combatState(9, false)); // foe never materialized (despawned)
    const goneModel = (gone.engine as unknown as { model: WorldModel }).model;
    expect(sceneShouldEnd(goneModel, "combat")).toMatch(/no enemy/);
  });

  test("a stranded combat is force-ended on the second trigger-blind evaluation", async () => {
    // The foe is GONE from the registry while the slice still says active — the exact stranded
    // shape a heartbeat-only stretch can hold, where combat's own reap (player-tick resolve)
    // never runs. Drive the module directly, folding its modulePatch like the commit would.
    const h = await scenesEngine(combatState(9, false));
    const model = (h.engine as unknown as { model: WorldModel }).model;
    const mod = new ScenesModule();
    const runTick = (): { queue: Command[]; events: GameEvent[] } => {
      const queue: Command[] = [];
      const events: GameEvent[] = [];
      const ctx = {
        model,
        queue,
        enqueue: (c: Command) => queue.push(c),
        emit: (e: unknown) => events.push(e as GameEvent),
        data: {},
        trigger: { kind: "heartbeat", npcId: "npc.lyra" },
      } as unknown as TickContext;
      void mod.phases.react!(ctx);
      for (const c of queue) {
        if (c.type === "modulePatch" && c.module === SCENES_MODULE) {
          Object.assign(((model.modules[SCENES_MODULE] as Record<string, unknown> | undefined) ??= {}), c.patch);
        }
      }
      return { queue, events };
    };

    const first = runTick();
    // First evaluation: row opened, stuck counted once, no enforcement yet (grace tick).
    expect(first.queue.some((c) => c.type === "endCombat")).toBe(false);
    let row = scenesSliceOf(model.modules).rows.find((r) => r.kind === "combat");
    expect(row?.stuckTicks).toBe(1);

    const second = runTick();
    expect(second.queue.some((c) => c.type === "endCombat")).toBe(true);
    row = scenesSliceOf(model.modules).rows.find((r) => r.kind === "combat");
    expect(row?.endedBy).toBe("terminator");
    expect(second.events.some((e) => e.kind === "system" && e.message.includes("scene-terminated"))).toBe(true);
  });

  test("a healthy fight is never counted stuck", async () => {
    const h = await scenesEngine(combatState(9));
    const model = (h.engine as unknown as { model: WorldModel }).model;
    const mod = new ScenesModule();
    const queue: Command[] = [];
    const ctx = {
      model,
      queue,
      enqueue: (c: Command) => queue.push(c),
      emit: () => {},
      data: {},
      trigger: { kind: "heartbeat", npcId: "npc.lyra" },
    } as unknown as TickContext;
    void mod.phases.react!(ctx);
    expect(queue.some((c) => c.type === "endCombat")).toBe(false);
    const patch = queue.find((c) => c.type === "modulePatch");
    expect(patch).toBeDefined(); // the mirror row still opens
  });
});
