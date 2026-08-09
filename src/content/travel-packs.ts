/**
 * Shared travel-event packs — bundled, world-agnostic road life.
 *
 * The pack data lives beside the SRD JSON and validates once at module load. Campaigns opt in with
 * `travelEventPacks`; the loader appends the matching events after authored events so local content
 * wins id collisions and the weighted-pick bucket order stays stable.
 *
 * @author Runkai Zhang
 */
import { z } from "zod";
import travelPacksData from "../rules/srd/travel-packs.json" with { type: "json" };
import { TravelEventSchema, type TravelEvent } from "./schema.ts";

const TravelPackSchema = z.object({
  id: z.string().min(1),
  events: z.array(TravelEventSchema),
});
type TravelPack = z.infer<typeof TravelPackSchema>;

export const CORE_PACK_IDS = ["core-ambient", "core-road-danger", "core-fortune"] as const;

const TRAVEL_PACKS: readonly TravelPack[] = z.array(TravelPackSchema).parse(travelPacksData);
const packById = new Map(TRAVEL_PACKS.map((pack) => [pack.id, pack] as const));

export function travelPackEvents(ids: readonly string[]): TravelEvent[] {
  const events: TravelEvent[] = [];
  const seenPacks = new Set<string>();
  for (const id of ids) {
    if (seenPacks.has(id)) continue;
    seenPacks.add(id);
    const pack = packById.get(id);
    if (!pack) throw new Error(`Unknown travel event pack "${id}"`);
    events.push(...structuredClone(pack.events));
  }
  return events;
}

export function coreTravelEvents(): TravelEvent[] {
  return travelPackEvents(CORE_PACK_IDS);
}
