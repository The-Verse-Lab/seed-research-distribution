/**
 * ScenesModule — the scene registry + terminator watchdog (Concordia transfer #6).
 *
 * React phase, every tick, ANY trigger — heartbeats included, which is the point: the subsystems'
 * own exits (combat's reap above all) run inside player-trigger resolve paths, so a scene stranded
 * between player turns had nothing watching it. Three duties, all through the reducer:
 *
 * 1. MIRROR — open a `modules.scenes` row when a scene-shaped slice goes live (combat, captivity,
 *    or lodging), close it (`endedBy:"subsystem"`) when the slice ends itself.
 * 2. WATCH — evaluate the declared terminator for each open scene (`SCENE_TERMINATORS`); a scene
 *    that "should already be over" accrues `stuckTicks`.
 * 3. ENFORCE — combat only (v1): two consecutive stuck evaluations with no `endCombat` already in
 *    the queue ⇒ enqueue the end itself and mark the row `endedBy:"terminator"`. One tick of grace
 *    lets the owning subsystem's commit-time end land first, so on ordinary player ticks the
 *    watchdog only ever OBSERVES the reap doing its job (the comparison the transfer plan asked
 *    for). A silent system event records every enforcement — rubric-visible, never player prose.
 *
 * Registration is gated on `world.constitution.toggles.scenes` (off ⇒ never registered ⇒ every
 * existing world/test byte-identical). Rows ride the generic `modulePatch` command with the FULL
 * post-state array (absolute, replay-safe, FIFO-capped) — no new delta kind.
 *
 * @author Runkai Zhang
 */
import type { TickContext, TickModule } from "../../engine/tick.ts";
import {
  SCENES_CAP,
  SCENES_MODULE,
  sceneShouldEnd,
  scenesSliceOf,
  detectScenes,
  type SceneRow,
} from "../../rules/scenes.ts";

export class ScenesModule implements TickModule {
  readonly id = "scenes";
  /** After the scene-owning subsystems' react handlers, so this tick's own exits are visible. */
  readonly after = ["combat", "captivity"];
  readonly phases: TickModule["phases"] = { react: (ctx) => this.onReact(ctx) };

  /** Monotonic per-process suffix so two same-clock scenes of one kind never collide on id. */
  private seq = 0;

  private onReact(ctx: TickContext): void {
    const model = ctx.model;
    const clock = model.clock ?? 0;
    const slice = scenesSliceOf(model.modules);
    const live = detectScenes(model);
    const liveKinds = new Set(live.map((s) => s.kind));
    let changed = false;
    const rows: SceneRow[] = slice.rows;

    // Close rows whose subsystem ended the scene on its own.
    for (const row of rows) {
      if (row.endedAtClock === undefined && !liveKinds.has(row.kind)) {
        row.endedAtClock = clock;
        row.endedBy = "subsystem";
        delete row.stuckTicks;
        changed = true;
      }
    }

    // Open rows for scenes that just went live.
    for (const view of live) {
      const open = rows.find((r) => r.kind === view.kind && r.endedAtClock === undefined);
      if (open) {
        // Participants can grow mid-scene (call-for-aid sweeps a bystander into the order).
        const merged = [...new Set([...open.participants, ...view.participants])];
        if (merged.length !== open.participants.length) {
          open.participants = merged;
          changed = true;
        }
        continue;
      }
      this.seq += 1;
      rows.push({
        id: `${view.kind}#${this.seq}@${clock}`,
        kind: view.kind,
        locationId: view.locationId,
        participants: view.participants,
        premise: view.premise,
        startedAtClock: clock,
      });
      changed = true;
    }

    // The watchdog: evaluate declared terminators on open rows.
    for (const row of rows) {
      if (row.endedAtClock !== undefined) continue;
      const reason = liveKinds.has(row.kind) ? sceneShouldEnd(model, row.kind) : null;
      if (reason === null) {
        if (row.stuckTicks !== undefined) {
          delete row.stuckTicks;
          changed = true;
        }
        continue;
      }
      // The owning subsystem already enqueued its own end this tick — that is the healthy path;
      // the row closes as "subsystem" next tick when the slice reads inactive.
      if (row.kind === "combat" && ctx.queue.some((c) => c.type === "endCombat")) continue;
      const stuck = (row.stuckTicks ?? 0) + 1;
      row.stuckTicks = stuck;
      changed = true;
      if (row.kind === "combat" && stuck >= 2) {
        ctx.enqueue({ type: "endCombat" });
        row.endedAtClock = clock;
        row.endedBy = "terminator";
        delete row.stuckTicks;
        // A system-channel notice, not prose: the same meta surface deadline failures use. The
        // fight is over because nothing is left of it — say so plainly, and let the trace carry
        // the diagnostic (`scene-terminated`) for the rubric.
        ctx.emit({
          kind: "system",
          level: "warn",
          message: `scene-terminated: ${row.kind} — ${reason}.`,
        });
        ctx.data.persist = true;
      }
    }

    if (changed) {
      const bounded = rows.length > SCENES_CAP ? rows.slice(rows.length - SCENES_CAP) : rows;
      ctx.enqueue({ type: "modulePatch", module: SCENES_MODULE, patch: { rows: bounded } });
    }
  }
}
