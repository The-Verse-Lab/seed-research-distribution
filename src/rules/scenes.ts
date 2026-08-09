/**
 * First-class scenes + terminators (Concordia transfer #6).
 *
 * Seed already runs scene-shaped subsystems — combat, captivity, lodging — and each
 * hand-rolls its own exit. Two shipped bug classes (the r7 stranded fight, the quest-deadline
 * misses) were both "a scene that would not end", fixed one incident at a time. Concordia models
 * this directly: a scene has participants, a premise, and a DECLARED termination condition that a
 * component evaluates every step. This module ports the shape, not the framework:
 *
 * - A `modules.scenes` slice mirrors the live scene-shaped slices into explicit rows
 *   `{id, kind, locationId, participants, premise, startedAtClock}` — queryable state for the
 *   Observatory and the per-scene narrator (#8), written only via the reducer (`modulePatch`,
 *   absolute post-state rows, replay-safe, FIFO-capped).
 * - A TERMINATOR TABLE declares, per kind, when a scene should already be over. Terminators are
 *   CODE (like Concordia's `Terminate` component), never persisted; they read the model and return
 *   a reason or null. The tick module evaluates them EVERY tick — including heartbeats, which is
 *   the structural point: combat's own reap runs only inside its player-trigger resolve path
 *   (combat/module.ts:300), so a fight stranded between player turns froze every heartbeat until
 *   the next player line. The watchdog cannot be suspended.
 *
 * Everything here is pure functions over the model; the tick module (src/modules/scenes/module.ts)
 * owns the writes. Slice readers return COPIES (the routines-wave gotcha: a shared row object
 * written back would dirty snapshots).
 *
 * @author Runkai Zhang
 */
import type { WorldModel } from "../world/model.ts";
import { partyLocationOf, playerEntity } from "../world/model.ts";
import { isCombatActive } from "../world/queries.ts";
import { readCombat } from "../modules/combat/state.ts";
import { isCaptive, readCaptivitySlice } from "../world/captivity.ts";
import { isAtLodging } from "../world/lodging.ts";

export const SCENES_MODULE = "scenes";
/** Rows kept in the slice (open + recently ended) — enough history to debug a session, bounded. */
export const SCENES_CAP = 12;

export type SceneKind = "combat" | "captivity" | "lodging";

/** One scene the registry tracks. Open while `endedAtClock` is absent. */
export interface SceneRow {
  id: string;
  kind: SceneKind;
  locationId: string | null;
  participants: string[];
  /** One-line human statement of what the scene IS — display/telemetry, never parsed. */
  premise: string;
  startedAtClock: number;
  /** Consecutive watchdog evaluations that said "should already be over" (see terminators). */
  stuckTicks?: number;
  endedAtClock?: number;
  /** Who closed it: the owning subsystem's own exit, or the terminator watchdog. */
  endedBy?: "subsystem" | "terminator";
}

export interface ScenesSlice {
  rows: SceneRow[];
}

/** Defaulting, COPY-returning slice reader. */
export function scenesSliceOf(modules: Record<string, unknown>): ScenesSlice {
  const raw = modules[SCENES_MODULE] as Partial<ScenesSlice> | undefined;
  return { rows: (raw?.rows ?? []).map((r) => ({ ...r, participants: [...r.participants] })) };
}

/** The open row of a kind, if any (there is at most one per kind by construction). */
export function openSceneOf(modules: Record<string, unknown>, kind: SceneKind): SceneRow | undefined {
  return scenesSliceOf(modules).rows.find((r) => r.kind === kind && r.endedAtClock === undefined);
}

/** A live scene the detector sees this tick — the row shape minus bookkeeping. */
export interface SceneView {
  kind: SceneKind;
  locationId: string | null;
  participants: string[];
  premise: string;
}

const nameOf = (model: WorldModel, id: string): string => model.entities.get(id)?.name ?? id;

/**
 * The scenes live RIGHT NOW, derived purely from the subsystem slices. Precedence is not needed —
 * several can be live at once (a fight in a rented room); the registry mirrors all of them.
 */
export function detectScenes(model: WorldModel): SceneView[] {
  const out: SceneView[] = [];
  if (isCombatActive(model)) {
    const enc = readCombat(model);
    const foes = enc.order.filter((id) => {
      const e = model.entities.get(id);
      return !!e && !e.partyMember && !enc.allies.includes(id);
    });
    out.push({
      kind: "combat",
      locationId: enc.locationId,
      participants: [...enc.order],
      premise: `A fight at ${enc.locationId ?? "?"} against ${foes.map((f) => nameOf(model, f)).join(", ") || "no one"}.`,
    });
  }
  if (isCaptive(model)) {
    const slice = readCaptivitySlice(model);
    const pc = playerEntity(model)?.id;
    out.push({
      kind: "captivity",
      locationId: partyLocationOf(model),
      participants: [...(pc ? [pc] : []), ...(slice.captorId ? [slice.captorId] : [])],
      premise: `Held (${slice.kind ?? "captive"})${slice.captorId ? ` by ${nameOf(model, slice.captorId)}` : ""}.`,
    });
  }
  if (isAtLodging(model)) {
    const pc = playerEntity(model)?.id;
    out.push({
      kind: "lodging",
      locationId: partyLocationOf(model),
      participants: pc ? [pc] : [],
      premise: "Abed in a rented room.",
    });
  }
  return out;
}

/**
 * The terminator table — per kind, "this scene should already be over BECAUSE …" or null.
 *
 * Combat's predicate is deliberately a mirror of `reapStaleCombat`'s trigger condition (the party
 * fled the field, or no enemy stands on it) so the watchdog and the subsystem can be compared: on
 * player ticks the reap fires first and the watchdog sees a clean end; on ticks the reap never
 * runs, the watchdog is the only thing standing between a dead fight and frozen heartbeats.
 * Captivity and lodging have no watchdog predicate yet — their exits are turn-driven and a
 * stuck one needs design, not a forced despawn; the registry still records them.
 */
export const SCENE_TERMINATORS: Partial<Record<SceneKind, (model: WorldModel) => string | null>> = {
  combat: (model) => {
    const enc = readCombat(model);
    if (!enc.active) return null;
    const partyLoc = partyLocationOf(model);
    if (partyLoc !== enc.locationId) return "the party has left the field";
    const foeStands = enc.order.some((id) => {
      const e = model.entities.get(id);
      return (
        !!e &&
        !e.partyMember &&
        !enc.allies.includes(id) &&
        (e.stats?.currentHp ?? 0) > 0 &&
        e.locationId === enc.locationId
      );
    });
    return foeStands ? null : "no enemy is standing on the field";
  },
};

/** Evaluate the terminator for a kind — null when the scene is fine (or has no declared terminator). */
export function sceneShouldEnd(model: WorldModel, kind: SceneKind): string | null {
  return SCENE_TERMINATORS[kind]?.(model) ?? null;
}
