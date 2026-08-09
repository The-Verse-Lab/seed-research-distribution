/**
 * StatusEffectsModule — decrements temporary effects once per public player turn.
 *
 * Effects themselves are reducer truth (`modules.statusEffects`). This module is only the tick
 * owner: it computes the absolute post-tick slice, clears condition mirrors that no remaining
 * effect still needs, and writes the slice back through `modulePatch`.
 */
import type { TickContext, TickModule } from "../../engine/tick.ts";
import {
  chilledEffect,
  cloneStatusEffectSlice,
  defaultStatusEffectSlice,
  exposureEffectFor,
  type StatusEffect,
  type StatusEffectSlice,
} from "../../rules/status-effects.ts";
import { occupiedCoverageOf } from "../../rules/visible-state.ts";
import { playerEntity } from "../../world/model.ts";

const START_SLICE_KEY = "statusEffectsStart";

function readSlice(ctx: TickContext): StatusEffectSlice {
  const d = defaultStatusEffectSlice();
  const slice = ctx.model.modules.statusEffects as Partial<StatusEffectSlice> | undefined;
  return {
    active: Object.fromEntries(
      Object.entries(slice?.active ?? d.active).map(([id, effects]) => [
        id,
        effects.map((effect) => ({
          kind: effect.kind,
          turnsRemaining: effect.turnsRemaining,
          mods: { ...effect.mods },
          ...(effect.source !== undefined ? { source: effect.source } : {}),
        })),
      ]),
    ),
  };
}

export class StatusEffectsModule implements TickModule {
  readonly id = "statusEffects";
  readonly after = ["core"];
  readonly phases: TickModule["phases"] = {
    perceive: (ctx) => this.onPerceive(ctx),
    commit: (ctx) => this.onCommit(ctx),
  };

  private onPerceive(ctx: TickContext): void {
    if (ctx.trigger.kind !== "player") return;
    if (ctx.trigger.toId !== undefined) return;
    ctx.data[START_SLICE_KEY] = readSlice(ctx);
    // Below the start-snapshot on purpose: a PC already bare when this tick begins gets `chilled`
    // ensured here — BEFORE resolve/narrate — so this tick's own check roll and brief already see
    // it instead of lagging a turn behind "Attire: bare". Since it lands after the snapshot above,
    // the decrement in commit (which only ticks effects present at both start and current) treats
    // a same-tick creation as absent-at-start and leaves it at full duration for this tick.
    this.ensureExposureIfNewlyBare(ctx);
  }

  private onCommit(ctx: TickContext): void {
    if (ctx.trigger.kind !== "player") return;
    if (ctx.trigger.toId !== undefined) return;

    this.decrementEffects(ctx);
    // Runs after decrementing, so a still-bare PC's `chilled` is pinned back to full duration
    // for THIS tick's end-state — a redressed PC is left at whatever the decrement above just
    // computed, so it decays to zero over its own remaining duration instead of being cleared here.
    this.refreshExposureIfStillBare(ctx);
  }

  private decrementEffects(ctx: TickContext): void {
    const start = ctx.data[START_SLICE_KEY] as StatusEffectSlice | undefined;
    if (!start || Object.keys(start.active).length === 0) return;
    const current = readSlice(ctx);
    if (Object.keys(current.active).length === 0) return;

    const next: StatusEffectSlice = { active: {} };
    const clears: Array<{ entityId: string; kind: string }> = [];
    let changed = false;

    const startCounts = new Map<string, number>();
    for (const [entityId, effects] of Object.entries(start.active)) {
      for (const effect of effects) {
        const key = `${entityId}:${effectKey(effect)}`;
        startCounts.set(key, (startCounts.get(key) ?? 0) + 1);
      }
    }

    for (const [entityId, effects] of Object.entries(current.active)) {
      const kept: StatusEffect[] = [];
      const expiredKinds = new Set<string>();
      for (const effect of effects) {
        const key = `${entityId}:${effectKey(effect)}`;
        const shouldTick = (startCounts.get(key) ?? 0) > 0;
        if (shouldTick) startCounts.set(key, (startCounts.get(key) ?? 0) - 1);
        const turnsRemaining = shouldTick ? effect.turnsRemaining - 1 : effect.turnsRemaining;
        if (turnsRemaining <= 0) {
          expiredKinds.add(effect.kind);
          changed = true;
        } else {
          kept.push({ ...effect, turnsRemaining, mods: { ...effect.mods } });
          if (turnsRemaining !== effect.turnsRemaining) changed = true;
        }
      }
      if (kept.length > 0) next.active[entityId] = kept;
      for (const kind of expiredKinds) {
        if (!kept.some((effect) => effect.kind === kind)) clears.push({ entityId, kind });
      }
    }

    if (!changed) return;
    for (const clear of clears) {
      ctx.apply({ type: "setCondition", entityId: clear.entityId, condition: clear.kind, active: false });
    }
    ctx.apply({ type: "modulePatch", module: "statusEffects", patch: { active: cloneStatusEffectSlice(next).active } });
  }

  // First-time-bare-this-tick only: a PC not already carrying `chilled` gets it via the reducer's
  // existing single-command dual-write (push + condition mirror) — correct here because "not
  // already active" was just confirmed, so there is no duplicate-entry risk.
  private ensureExposureIfNewlyBare(ctx: TickContext): void {
    const pcId = playerEntity(ctx.model)?.id;
    if (!pcId || !this.isExposed(ctx, pcId)) return;
    const alreadyActive = (readSlice(ctx).active[pcId] ?? []).some((effect) => effect.kind === "chilled");
    if (alreadyActive) return; // steady-state refresh (commit) owns it from here
    ctx.apply({ type: "applyStatusEffect", entityId: pcId, effect: chilledEffect() });
  }

  // Every other bare tick: `chilled` already exists (ensured above on the first one) but the
  // decrement just ran it down, so pin it back to full duration — exposure can never lapse
  // mid-strip. Not bare is a no-op, leaving whatever the decrement above just computed to run out
  // on its own, so redressing earns a short grace instead of an instant cure. `applyStatusEffect`
  // can't be reused here (it always pushes, never replaces), so this mirrors decrementEffects'
  // own dual-write — a full modulePatch snapshot plus the setCondition mirror.
  private refreshExposureIfStillBare(ctx: TickContext): void {
    const pcId = playerEntity(ctx.model)?.id;
    if (!pcId || !this.isExposed(ctx, pcId)) return;

    const current = readSlice(ctx);
    const fresh = chilledEffect();
    const existing = current.active[pcId] ?? [];
    const already = existing.find((effect) => effect.kind === fresh.kind);
    if (already?.turnsRemaining === fresh.turnsRemaining) return;

    const next = cloneStatusEffectSlice(current);
    next.active[pcId] = [...existing.filter((effect) => effect.kind !== fresh.kind), fresh];
    ctx.apply({ type: "setCondition", entityId: pcId, condition: fresh.kind, active: true });
    ctx.apply({ type: "modulePatch", module: "statusEffects", patch: { active: cloneStatusEffectSlice(next).active } });
  }

  private isExposed(ctx: TickContext, pcId: string): boolean {
    // `services` is optional chained only for lightweight test harnesses that build a TickContext
    // without it (real ticks always carry it) — occupancy from the PC's own sheet is what keeps
    // this agreeing with the brief's `Attire:` line instead of demanding all six coverage slots.
    const character = ctx.services?.campaign.characters.find((c) => c.id === pcId);
    return exposureEffectFor(ctx.model, pcId, occupiedCoverageOf(character));
  }
}

function effectKey(effect: StatusEffect): string {
  return JSON.stringify({
    kind: effect.kind,
    turnsRemaining: effect.turnsRemaining,
    mods: {
      check: effect.mods.check ?? 0,
      attack: effect.mods.attack ?? 0,
      ac: effect.mods.ac ?? 0,
      energy: effect.mods.energy ?? 0,
      disadvantage: effect.mods.disadvantage === true,
    },
    source: effect.source ?? "",
  });
}
