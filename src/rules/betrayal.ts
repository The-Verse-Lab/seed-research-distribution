/**
 * Betrayal state — a durable world flag marking an NPC that has turned hostile to the party.
 *
 * Party membership can be dropped when the betrayal happens, but the flag records intent: this was
 * not a neutral bystander, it was someone who turned from inside the camp.
 */
import type { WorldModel } from "../world/model.ts";

export const PARTY_HOSTILE_FLAG_PREFIX = "partyHostile.";

export function partyHostileFlag(entityId: string): string {
  return `${PARTY_HOSTILE_FLAG_PREFIX}${entityId}`;
}

export function isPartyHostile(model: WorldModel, entityId: string): boolean {
  return model.flags[partyHostileFlag(entityId)] === true;
}
