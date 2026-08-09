/**
 * Character library — standalone reusable player characters and playset binding.
 *
 * A library character is just a CharacterSchema object on disk. Binding stays at the
 * content/load boundary: the engine already seeds PCs from campaign.characters plus
 * startingState.party, so no runtime state writer needs to know about the library.
 *
 * @author Runkai Zhang
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReferences } from "./loader.ts";
import { CharacterSchema, type Character, type PlaySet } from "./schema.ts";

const DEFAULT_CHARACTER_DIR = fileURLToPath(new URL("../../characters", import.meta.url));

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function characterDir(dir?: string): string {
  return absolute(dir ?? process.env.SEED_CHARACTER_DIR ?? DEFAULT_CHARACTER_DIR);
}

function looksLikePath(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith(".") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.endsWith(".json")
  );
}

/** Load and validate one standalone CharacterSchema JSON file. */
export async function loadCharacterFromFile(path: string): Promise<Character> {
  const source = absolute(path);
  try {
    return CharacterSchema.parse(await readJson(source));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load character "${source}": ${detail}`);
  }
}

/**
 * Resolve either a filesystem path or a bare library id. Bare ids load from
 * `$SEED_CHARACTER_DIR/<id>.json`, or repo-root `characters/<id>.json` by default.
 */
export async function resolveCharacter(idOrPath: string, dir?: string): Promise<Character> {
  const key = idOrPath.trim();
  if (!key) throw new Error("Character id/path is empty.");
  const source = looksLikePath(key) ? key : join(characterDir(dir), `${key}.json`);
  return loadCharacterFromFile(source);
}

/**
 * Rewrite authored references to the replaced player-slot id onto the bound character, so a
 * dropped-in library character inherits the campaign's player-directed content: NPC standing keyed
 * to the original PC, and every clause/effect/command anywhere in the world or campaign that targets
 * it. Mutates the (already-cloned) playset in place. The default path (priorPrimary === bound.id)
 * never calls this.
 */
function remapPlayerReferences(playset: PlaySet, fromId: string, toId: string): void {
  // Relationship rows are KEYED by entity id, so rebinding one is a RENAME (move the row and drop
  // the old key), not a value rewrite — the value-guarded walk below only ever sees values, so this
  // pair stays explicit.
  for (const npc of playset.world.npcs) {
    const standing = npc.relationships[fromId];
    if (standing !== undefined) {
      npc.relationships[toId] = standing;
      delete npc.relationships[fromId];
    }
  }
  // Everything else that names the player slot is a REFERENCE, wherever it sits: prebaked-event
  // triggers and effects (including a `check`'s nested onSuccess/onFail arrays), the quest-flow and
  // location-interaction authoring sources those events compile from, travel events, NPC personal
  // events, schedule-slot conditions, work gates, and the authored defeat-outcome Commands.
  //
  // This used to be a hand-maintained switch over four effect kinds and two clause kinds, and it
  // rotted exactly as you would expect: `transferItem.from`/`to`, `giveItem.to`, the optional
  // `target` on adjustCoins/adjustEnergy/adjustExhaustion, `attireState.entityId` and every nested
  // `check` branch were never rebound. Because the `hasItem` GATE was remapped and the matching
  // `transferItem` was not, every quest hand-in in a shipped world was unfinishable for a library
  // character: the item minted into a ghost `pc.you` entity and the reducer rejected the transfer.
  //
  // So walk the whole content tree instead, VALUE-guarded — only a string whose WHOLE value equals
  // the old player-slot id is rewritten. A location `to`, a spawn `templateId`, an item id, a flag
  // `key`, a monster `captorId`, a line of prose: none of them ever equal the PC id, so they pass
  // through untouched. The point is that a NEW effect or condition kind is covered the day it is
  // authored rather than the day someone remembers to extend a switch.
  deepSwapIds(playset.world, fromId, toId);
  const campaign = playset.campaign as unknown as Record<string, unknown>;
  for (const key of Object.keys(campaign)) {
    // `campaign.characters` is the ONE exclusion: a character entry's `id` is its identity, not a
    // reference to the player slot. bindCharacter appends the bound sheet ALONGSIDE the default one,
    // so rewriting the default entry's id would leave two sheets answering to the same id and every
    // `characters.find((c) => c.id === pcId)` in the engine would resolve the stale one.
    if (key === "characters") continue;
    deepSwapIds(campaign[key], fromId, toId);
  }
}

/** Rewrite every string in `value` (arrays/objects walked in place) that EQUALS `fromId` to `toId`. */
function deepSwapIds(value: unknown, fromId: string, toId: string): void {
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (v === fromId) record[key] = toId;
    else if (typeof v === "object") deepSwapIds(v, fromId, toId);
  }
}

/** Bind a library character into the primary PC slot without mutating the input playset. */
export function bindCharacter(playset: PlaySet, character: Character): PlaySet {
  const bound = CharacterSchema.parse(character);
  const npcIds = new Set(playset.world.npcs.map((n) => n.id));
  if (npcIds.has(bound.id)) {
    throw new Error(`Cannot bind character "${bound.id}": id collides with a world NPC.`);
  }
  const locationIds = new Set(playset.world.locations.map((l) => l.id));
  if (!locationIds.has(playset.campaign.startingState.locationId)) {
    throw new Error(
      `Cannot bind character "${bound.id}": startingState.locationId "${playset.campaign.startingState.locationId}" is not a world location.`,
    );
  }

  const priorPrimary = playset.campaign.startingState.party[0];
  const next = structuredClone(playset);
  let replaced = false;
  next.campaign.characters = next.campaign.characters.map((c) => {
    if (c.id !== bound.id) return c;
    replaced = true;
    return bound;
  });
  if (!replaced) next.campaign.characters.push(bound);

  const rest = next.campaign.startingState.party.slice(1).filter((id) => id !== bound.id);
  next.campaign.startingState = {
    ...next.campaign.startingState,
    party: [bound.id, ...rest],
  };
  // A campaign authors NPC standing and event targeting against a fixed player-slot id; rebind them
  // to the chosen character so it inherits that player-directed content. The no-character default path
  // never reaches bindCharacter, and re-binding the same id is a no-op here.
  if (priorPrimary !== undefined && priorPrimary !== bound.id) {
    remapPlayerReferences(next, priorPrimary, bound.id);
  }
  validateReferences(next.world, next.campaign);
  return next;
}
