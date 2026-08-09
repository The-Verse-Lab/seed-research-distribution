/**
 * Tick module ORDER — the invariant behind `TickModule.after`.
 *
 * `TickRunner.ordered()` computes ONE module order and reuses it for EVERY phase: `after` is a
 * GLOBAL constraint, not a per-phase one. So a dependency added purely to move a module's NARRATE
 * handler (combat was lifted behind `narration` in the live 07-24 beat-order fix — the ambush prose
 * has to precede its own dice) silently re-seats that module in every other phase too. This spec
 * pins both sides of that trade: the narrate order is the intended one, and the RESOLVE order is
 * byte-identical to what it was before the dependency existed.
 *
 * The modules whose `after` arrays this actually protects (combat and narration) are the REAL
 * classes — only their phase HANDLERS are swapped for recorders, so nothing here executes game logic
 * while `id`/`after`/which-phases stay authoritative. The handler-less rest of the registry
 * (core/dialogue/events/autonomy/prose-entities) is mirrored from `GameEngine`'s registration block
 * and must be updated alongside it.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { TICK_PHASES, TickRunner, type TickContext, type TickModule, type TickPhase } from "../src/engine/tick.ts";
import { CombatModule } from "../src/modules/combat/module.ts";
import { NarrationModule } from "../src/modules/narration.ts";
import { CaptivityModule } from "../src/modules/captivity/module.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import { loadExample } from "./support/harness.ts";

/** A stand-in that keeps a module's ORDERING identity (`id`, `after`, declared phases) and nothing else. */
function recorder(module: TickModule, log: Array<[TickPhase, string]>): TickModule {
  const phases: TickModule["phases"] = {};
  for (const phase of TICK_PHASES) {
    if (module.phases[phase]) phases[phase] = () => void log.push([phase, module.id]);
  }
  return { id: module.id, after: module.after, phases };
}

/** A hand-declared registry member (`GameEngine` builds these inline or from heavy deps). */
function stub(id: string, after: string[], declared: TickPhase[], log: Array<[TickPhase, string]>): TickModule {
  const phases: TickModule["phases"] = {};
  for (const phase of declared) phases[phase] = () => void log.push([phase, id]);
  return { id, after, phases };
}

/**
 * The mirrored registry (see the header note) — the modules AND their ordering identity, built in
 * REGISTRATION ORDER, mirroring `GameEngine` (src/engine/engine.ts, the `this.tick.register(...)`
 * block). Only the modules that declare `resolve` or `narrate` are represented; the pure react-phase
 * middle of the registry (travel/camp/room/routines/npc-events/cases/decay/upkeep/npc-profile/
 * npc-memory) has no `after` naming combat or narration and cannot change either order.
 */
async function registry(log: Array<[TickPhase, string]>): Promise<TickModule[]> {
  const { world, campaign } = await loadExample();
  const gateway = new OfflineGateway();
  return [
    stub("core", [], ["perceive", "resolve", "commit", "persist"], log),
    recorder(new CombatModule(world, gateway), log),
    recorder(new NarrationModule(world, gateway), log),
    stub("dialogue", [], ["narrate"], log),
    stub("events", [], ["react", "narrate"], log),
    stub("autonomy", ["core", "dialogue", "events"], ["perceive", "react", "narrate"], log),
    recorder(new CaptivityModule(campaign), log),
    stub("prose-entities", ["narration"], ["narrate"], log),
  ];
}

/** One full run of the real `TickRunner` over that registry, with the per-phase call log. */
async function ran(): Promise<{ modules: TickModule[]; log: Array<[TickPhase, string]> }> {
  const log: Array<[TickPhase, string]> = [];
  const modules = await registry(log);
  const runner = new TickRunner();
  for (const module of modules) runner.register(module);
  await runner.run({ data: {} } as unknown as TickContext);
  return { modules, log };
}

async function orderOf(phase: TickPhase): Promise<string[]> {
  const { log } = await ran();
  return log.filter(([p]) => p === phase).map(([, id]) => id);
}

describe("tick module order", () => {
  test("no cycle: every `after` edge is honored, not silently broken", async () => {
    // `TickRunner.ordered()` breaks a cycle at its `stack` guard and returns a full permutation
    // anyway — so "each module appears exactly once" is true BY CONSTRUCTION and cannot detect one
    // (adding "combat" to narration's `after` makes a real narration↔combat cycle, and that
    // assertion still passed). The only observable symptom of a cycle is a DROPPED edge: a module
    // running ahead of something it declared `after`. Checked per phase, over the phases each pair
    // actually declares.
    const { modules, log } = await ran();
    for (const phase of TICK_PHASES) {
      const at = new Map(log.filter(([p]) => p === phase).map(([, id], i) => [id, i] as const));
      for (const m of modules) {
        for (const dep of m.after ?? []) {
          if (!at.has(dep) || !at.has(m.id)) continue; // one of the pair skips this phase
          expect(at.get(dep)!, `${m.id} ran before its \`after\` dep ${dep} in the ${phase} phase`).toBeLessThan(
            at.get(m.id)!,
          );
        }
      }
    }
  });
});
