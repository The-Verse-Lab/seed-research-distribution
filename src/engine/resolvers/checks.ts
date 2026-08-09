/**
 * The check modifiers every domain resolver has to apply before it rolls.
 *
 * One line, but it was reached for from six private methods across five domains, so the split needs
 * it somewhere all of them can see. Exhaustion is the only modifier the PC carries into a check that
 * is not already on the stat block — a tired character rolls worse at everything.
 *
 * @author Runkai Zhang
 */
import { exhaustionCheckMods, exhaustionOf } from "../../rules/exhaustion.ts";
import { playerEntity, type WorldModel } from "../../world/model.ts";

/** The PC's current check modifiers from exhaustion. Safe on a model with no player yet. */
export function pcCheckMods(model: WorldModel): ReturnType<typeof exhaustionCheckMods> {
  return exhaustionCheckMods(exhaustionOf(playerEntity(model)?.stats));
}
