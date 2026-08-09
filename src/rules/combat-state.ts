/**
 * Combat state — the encounter lifecycle slice stored at `model.modules.combat`.
 *
 * This is the SSOT spine for turn-based combat: the reducer writes it through typed commands,
 * and replay folds absolute post-state deltas back into the same shape. The pure dice/math
 * resolver lives in `combat.ts`; this file owns only the mutable encounter value type and
 * its default.
 *
 * @author Runkai Zhang
 */

export interface CombatEncounter {
  active: boolean;
  /** Location where the encounter is running. Null when inactive. */
  locationId: string | null;
  /** Combatant ids in initiative order. */
  order: string[];
  /**
   * Combatants who fight ON THE PARTY'S SIDE without being party members (r5).
   *
   * Side is otherwise recomputed from `partyMember`, which means pushing a helpful bystander into
   * `order` would silently make them a FOE: the party would swing at them, `tryEndCombat` would
   * never see the field clear, and killing them would pay loot and XP. An ally list is the minimum
   * state that carries side; it is folded absolutely with the rest of the encounter.
   */
  allies: string[];
  /** Index into `order` for the current turn. */
  turnIndex: number;
  /** 1-based while active; 0 when inactive. */
  round: number;
}

/** A fresh inactive combat slice — the single source of the slice's default value. */
export function defaultCombatEncounter(): CombatEncounter {
  return { active: false, locationId: null, order: [], allies: [], turnIndex: 0, round: 0 };
}

/** Deep-copy the encounter so commands/deltas cannot leak mutable arrays. */
export function cloneCombatEncounter(encounter: CombatEncounter): CombatEncounter {
  return {
    active: encounter.active,
    locationId: encounter.locationId,
    order: [...encounter.order],
    allies: [...(encounter.allies ?? [])],
    turnIndex: encounter.turnIndex,
    round: encounter.round,
  };
}

export function combatEncounterEqual(a: CombatEncounter, b: CombatEncounter): boolean {
  return (
    a.active === b.active &&
    a.locationId === b.locationId &&
    a.turnIndex === b.turnIndex &&
    a.round === b.round &&
    a.order.length === b.order.length &&
    a.order.every((id, i) => id === b.order[i]) &&
    (a.allies ?? []).length === (b.allies ?? []).length &&
    (a.allies ?? []).every((id, i) => id === (b.allies ?? [])[i])
  );
}
