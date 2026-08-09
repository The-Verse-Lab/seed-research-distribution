/**
 * Combat module state — read-only views over `model.modules.combat`.
 *
 * The live writer is the reducer/replay slice accessor in `world/module-slices.ts`. This file
 * returns copies for modules that need to inspect combat without creating or mutating the slice.
 *
 * @author Runkai Zhang
 */
import {
  cloneCombatEncounter,
  defaultCombatEncounter,
  type CombatEncounter,
} from "../../rules/combat-state.ts";
import type { WorldModel } from "../../world/model.ts";

export type { CombatEncounter };

export function readCombat(model: WorldModel): CombatEncounter {
  const s = model.modules.combat as Partial<CombatEncounter> | undefined;
  const d = defaultCombatEncounter();
  return cloneCombatEncounter({
    active: s?.active ?? d.active,
    locationId: s?.locationId ?? d.locationId,
    order: s?.order ?? d.order,
    allies: s?.allies ?? d.allies,
    turnIndex: s?.turnIndex ?? d.turnIndex,
    round: s?.round ?? d.round,
  });
}
