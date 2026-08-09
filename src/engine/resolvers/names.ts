/**
 * Display-name lookups shared by the domain resolvers.
 *
 * Every domain needs to phrase a beat about a thing whose id it holds, and each was carrying its
 * own copy of the same fallback chain on `GameEngine`. These are pure reads over authored content
 * plus the live model — no commands, no events — so they take exactly the data they need rather
 * than a host.
 *
 * All of them fall back to the raw id rather than throwing: a name is for a sentence, and a missing
 * one should read oddly in the log, never end a turn.
 *
 * @author Runkai Zhang
 */
import type { Campaign, World } from "../../content/schema.ts";
import { itemDisplayNameOf, resolveItem } from "../../rules/items.ts";
import { FRONTIER_FALLBACK_NAME, isFrontierId } from "../../world/expansion.ts";
import { displayName } from "../../world/entity.ts";
import type { WorldModel } from "../../world/model.ts";

/** Display name of an item id — the resolved master/world item, else the id's own readable form. */
export function itemNameOf(world: World, itemId: string): string {
  return resolveItem(world, itemId)?.name ?? itemDisplayNameOf(itemId);
}

/** Display name of a location id. A frontier edge has no authored name yet — it gets the
 *  wanderer's label the brief already shows for it, never a raw `frontier:` id. */
export function locationNameOf(world: World, id: string): string {
  if (isFrontierId(id)) return FRONTIER_FALLBACK_NAME;
  return world.locations.find((l) => l.id === id)?.name ?? id;
}

/** Display name of a quest id. */
export function questNameOf(campaign: Campaign, questId: string): string {
  return campaign.quests.find((q) => q.id === questId)?.name ?? questId;
}

/**
 * Display name of an NPC id. The live entity wins over the authored template — a spawned or
 * enriched NPC carries the name the player has actually been shown.
 */
export function npcNameOf(model: WorldModel, world: World, npcId: string): string {
  const entity = model.entities.get(npcId);
  if (entity) return displayName(entity);
  return world.npcs.find((n) => n.id === npcId)?.name ?? npcId;
}

/** Display name of an actor id — PC or NPC — for summary lines. */
export function actorNameOf(world: World, campaign: Campaign, id: string): string {
  return (
    campaign.characters.find((c) => c.id === id)?.name ??
    world.npcs.find((n) => n.id === id)?.name ??
    id
  );
}
