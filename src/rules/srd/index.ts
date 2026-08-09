/**
 * SRD loader — typed access to the bundled 5e SRD subset.
 *
 * The JSON files in this directory are local data, validated once at module load.
 * Rules math stays in the resolver modules that consume these profiles.
 *
 * @author Runkai Zhang
 */
import { z } from "zod";
import weaponsData from "./weapons.json" with { type: "json" };
import conditionsData from "./conditions.json" with { type: "json" };

export const WeaponProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  damage: z.string().min(1),
  damageType: z.string().min(1),
  category: z.enum(["simple", "martial"]),
  finesse: z.boolean(),
  ranged: z.boolean(),
  versatile: z.string().min(1).nullable(),
});
export type WeaponProfile = z.infer<typeof WeaponProfileSchema>;

export const ConditionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().min(1),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const SRD_WEAPONS: readonly WeaponProfile[] = z.array(WeaponProfileSchema).parse(weaponsData);
export const SRD_CONDITIONS: readonly Condition[] = z.array(ConditionSchema).parse(conditionsData);

const weaponById = new Map(SRD_WEAPONS.map((weapon) => [weapon.id, weapon] as const));
const conditionById = new Map(SRD_CONDITIONS.map((condition) => [condition.id, condition] as const));

const unarmed = weaponById.get("weapon.unarmed");
if (!unarmed) throw new Error("bundled SRD data must include weapon.unarmed");

/** The unarmed-strike fallback, always available to combat resolution. */
export const UNARMED: WeaponProfile = unarmed;

const naturalWeapon = weaponById.get("weapon.natural");
if (!naturalWeapon) throw new Error("bundled SRD data must include weapon.natural");
/** A beast's teeth/claws — the fallback for a weaponless MONSTER, so any meetable foe has bite. */
export const NATURAL_WEAPON: WeaponProfile = naturalWeapon;

const improvisedWeapon = weaponById.get("weapon.improvised");
if (!improvisedWeapon) throw new Error("bundled SRD data must include weapon.improvised");
/** A grabbed object (stool, bottle) — the fallback when an attack names a non-weapon thing. */
export const IMPROVISED_WEAPON: WeaponProfile = improvisedWeapon;

export function getWeapon(id: string): WeaponProfile | undefined {
  return weaponById.get(id);
}

export function getCondition(id: string): Condition | undefined {
  return conditionById.get(id);
}

/**
 * Resolve a weapon profile from a World's free-form item properties, falling back to the bundled
 * SRD entry by id, then to unarmed. This keeps authored worlds loose while the combat resolver
 * consumes a typed profile.
 */
export function weaponProfileFromItem(
  itemId: string,
  name: string,
  properties: Record<string, unknown>,
): WeaponProfile {
  const srd = weaponById.get(itemId);
  const damage = typeof properties.damage === "string" ? properties.damage : srd?.damage;
  if (!damage) return UNARMED;
  const ranged =
    typeof properties.ranged === "boolean" ? properties.ranged : srd?.ranged ?? properties.range !== undefined;
  return WeaponProfileSchema.parse({
    id: itemId,
    name,
    damage,
    damageType:
      typeof properties.damageType === "string"
        ? properties.damageType
        : srd?.damageType ?? (ranged ? "piercing" : "bludgeoning"),
    category:
      properties.category === "simple" || properties.category === "martial"
        ? properties.category
        : srd?.category ?? "simple",
    finesse: typeof properties.finesse === "boolean" ? properties.finesse : srd?.finesse ?? false,
    ranged,
    versatile: typeof properties.versatile === "string" ? properties.versatile : srd?.versatile ?? null,
  });
}
