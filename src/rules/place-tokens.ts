/**
 * The world's PLACE vocabulary — every token that names somewhere rather than someone.
 *
 * A name token is evidence about a person only if it could not just as easily be the map. With an NPC
 * named `<Place> <Role>`, the role may be an ordinary word and the place may be the only remaining
 * matcher token; a sentence merely naming the location would then bind the person and could trigger
 * a false cast-presence violation. Keeping this rule in the shared binder ensures every consumer of
 * `findNameMention` applies the same place-token suppression. The complete authored person name still
 * binds normally.
 *
 * @author Runkai Zhang
 */
import type { World } from "../content/schema.ts";

/** Below this length a token is too generic to be worth suppressing ("tor", "the", "old"). */
const MIN_PLACE_TOKEN = 3;

/** Built once per world object — the set is read on every narration and never mutated. */
const CACHE = new WeakMap<World, ReadonlySet<string>>();

/**
 * Every lowercase token of every authored place name: locations, regions, and the gazetteer. These
 * are the tokens a person's name may NOT be bound by on their own — the whole name, spelled out and
 * capitalized, still binds (see `findNameMention`'s `fullName` tier), which is the honest reading:
 * A place token names the map; the complete `<Place> <Role>` string names the person.
 */
export function placeTokensOf(world: World): ReadonlySet<string> {
  const cached = CACHE.get(world);
  if (cached) return cached;
  const tokens = new Set<string>();
  const add = (name: string | undefined): void => {
    for (const token of (name ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= MIN_PLACE_TOKEN) tokens.add(token);
    }
  };
  for (const location of world.locations ?? []) add(location.name);
  for (const region of world.regions ?? []) add(region.name);
  for (const entry of world.gazetteer ?? []) add(entry.name);
  CACHE.set(world, tokens);
  return tokens;
}
