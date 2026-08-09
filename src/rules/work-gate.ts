/**
 * Work reputation gate (the hall-as-hub wave, Phase C).
 *
 * A `Work` row may carry a `requires` predicate (schema.ts) — the guild-reputation gate that unlocks
 * better shifts as standing rises. The board surfaces (classifier + wire + resolve authority) all
 * need the SAME visible/takeable set, so all three ask this one function.
 *
 * IT IS NOT ITS OWN EVALUATOR ANY MORE (regex audit §10b, 2026-07-28). It used to walk
 * `requires.allOf` itself and understand exactly two clause kinds (`factionStandingAtLeast`,
 * `workedOpportunity`), treating everything else as satisfied — a second, divergent reading of the
 * shared `TriggerPredicate` type that FAILED OPEN. Reproduced against the shipped function with an
 * empty PC:
 *
 *   workRequiresMet({allOf:[{kind:"hasItem",   entityId:"pc.you", itemId:"item.guild-seal"}]}) => true
 *   workRequiresMet({allOf:[{kind:"questState",questId:"quest.bond", state:"complete"}]})      => true
 *   workRequiresMet({allOf:[{kind:"flag",      key:"vouched", equals:true}]})                  => true
 *
 * — every one of them a gate the author wrote and the board simply ignored. There is now ONE
 * predicate evaluator in the codebase (`evalPredicate`, src/modules/events/module.ts): a work gate
 * means exactly what the same clause means on an event trigger or an exit barrier. Pure, no model,
 * no rng.
 *
 * @author Runkai Zhang
 */
import type { Character, TriggerPredicate, World } from "../content/schema.ts";
import { evalPredicate, standardEvalLookups } from "../modules/events/module.ts";
import { partyLocationOf, type WorldModel } from "../world/model.ts";

/**
 * Whether a work row's `requires` gate is satisfied right now. Evaluated at the party's current
 * location, which is where the board is being read — an `atLocation`/`inRegion` clause on a shift
 * therefore means "while you are standing here", the same reading the engine's resolve-time
 * authority gets. No `requires` ⇒ always offered (the overwhelmingly common case, unchanged).
 */
export function workRequiresMet(
  requires: TriggerPredicate | undefined,
  model: WorldModel,
  world: World,
  characters: readonly Character[],
): boolean {
  if (!requires) return true;
  return evalPredicate(requires, model, partyLocationOf(model), undefined, standardEvalLookups(world, characters));
}
