/**
 * World maintenance — the tier-driven culling/freezing the core runs around a tick.
 *
 * Tiers decide what survives leaving the player's view (src/world/entity.ts):
 *  - transient   : spawned extras; despawned once the party is no longer co-located.
 *  - tracked     : position remembered; "frozen" (not simulated) when far — a no-op today
 *                  since nothing off-screen is simulated until the autonomy module (Phase 6).
 *  - significant : never culled.
 *
 * Pure: returns the Commands to run through the reducer; the caller applies them. Spawn-on-entry
 * from location `spawns` rules + region pools is owned by the AmbientLifeModule
 * (src/modules/ambient-life/module.ts), which spawns transient extras this pass then reaps.
 *
 * @author Runkai Zhang
 */
import type { Command } from "./commands.ts";
import { entitiesAt, type WorldModel } from "./model.ts";

/** Despawn transient entities that are no longer where the party is. `spare` ids are exempt. */
export function cullTransients(model: WorldModel, partyLoc: string | null, spare?: ReadonlySet<string>): Command[] {
  const present = new Set(partyLoc ? entitiesAt(model, partyLoc).map((e) => e.id) : []);
  const cmds: Command[] = [];
  for (const e of model.entities.values()) {
    if (e.tier === "transient" && !present.has(e.id) && !spare?.has(e.id)) {
      cmds.push({ type: "despawnEntity", entityId: e.id });
    }
  }
  return cmds;
}

/**
 * All maintenance commands for the party's current location. Cull only — spawn-on-entry is owned
 * by the AmbientLifeModule. Runs once per tick at the core module's commit chokepoint, so every
 * path that can move the party (player resolve, react-phase leader moveParty) is covered. `spare`
 * exempts entities born in the same commit (an authored "spawn elsewhere" effect must not be
 * applied and reaped in one breath — normal tier semantics resume next tick).
 */
export function worldMaintenance(model: WorldModel, partyLoc: string | null, spare?: ReadonlySet<string>): Command[] {
  return cullTransients(model, partyLoc, spare);
}
