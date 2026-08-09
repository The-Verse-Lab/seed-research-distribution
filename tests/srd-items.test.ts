/**
 * SRD item masterlist tests — the bundled equipment data and its resolution helpers.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { ItemSchema, WorldSchema } from "../src/content/schema.ts";
import {
  MASTER_ITEMS,
  armorCategory,
  getMasterItem,
  isArmor,
  isConsumable,
  isShield,
  isWeapon,
  itemBaseCostCp,
  itemFitsSlot,
  resolveItem,
  type ResolvedItem,
} from "../src/rules/items.ts";
import { SRD_WEAPONS, weaponProfileFromItem } from "../src/rules/srd/index.ts";
import itemsData from "../src/rules/srd/items.json" with { type: "json" };

const DICE = /^\d+d\d+/;

function world(items: unknown[] = []) {
  return WorldSchema.parse({ id: "world.test", name: "Test World", items });
}

describe("items.json masterlist", () => {
  test("every entry parses against ItemSchema", () => {
    for (const entry of itemsData) expect(() => ItemSchema.parse(entry)).not.toThrow();
  });

  test("ids are unique", () => {
    const ids = MASTER_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("is a curated list of roughly 150 entries (SRD gear + the shared apparel set)", () => {
    expect(MASTER_ITEMS.length).toBeGreaterThanOrEqual(140);
    expect(MASTER_ITEMS.length).toBeLessThanOrEqual(160);
  });

  test("carries a shared apparel set the paper-doll can render", () => {
    const apparel = MASTER_ITEMS.filter((item) => item.id.startsWith("apparel."));
    expect(apparel.length).toBeGreaterThanOrEqual(20);
    for (const item of apparel) expect(item.properties?.apparel).toBe(true);
  });

  test("every entry has a name, a description, and an integer copper price", () => {
    for (const item of MASTER_ITEMS) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(Number.isInteger(item.baseCostCp)).toBe(true);
      expect(item.baseCostCp).toBeGreaterThanOrEqual(0);
    }
  });

  test("every weapon entry yields a sane WeaponProfile via weaponProfileFromItem", () => {
    const weapons = MASTER_ITEMS.filter((item) => item.kind === "weapon");
    expect(weapons.length).toBeGreaterThan(0);
    for (const item of weapons) {
      const profile = weaponProfileFromItem(item.id, item.name, item.properties);
      expect(profile.id).toBe(item.id);
      expect(profile.damage).toMatch(DICE);
      expect(profile.damageType.length).toBeGreaterThan(0);
      expect(profile.category).toBe(item.properties.category as "simple" | "martial");
      expect(typeof profile.finesse).toBe("boolean");
      expect(profile.ranged).toBe(item.properties.ranged as boolean);
    }
  });

  test("weapon entries agree with the bundled weapons.json where ids overlap", () => {
    // Combat-fallback pseudo-weapons are not carriable items — you don't buy "bare hands", a
    // monster's teeth, or a grabbed chair from a vendor, so they have no masterlist (items.json)
    // row. They arm a swing purely in code (weaponFor's unarmed/natural/improvised fallbacks).
    const combatFallbacks = new Set(["weapon.unarmed", "weapon.natural", "weapon.improvised"]);
    for (const srd of SRD_WEAPONS) {
      if (combatFallbacks.has(srd.id)) continue;
      const item = getMasterItem(srd.id);
      expect(item).toBeDefined();
      expect(item?.properties.damage).toBe(srd.damage);
      expect(item?.properties.damageType).toBe(srd.damageType);
      expect(item?.properties.category).toBe(srd.category);
    }
  });

  test("every armor entry carries a category and a numeric ac", () => {
    const armors = MASTER_ITEMS.filter((item) => item.kind === "armor");
    expect(armors.length).toBeGreaterThanOrEqual(13); // 12 suits + shield
    for (const item of armors) {
      expect(["light", "medium", "heavy", "shield"]).toContain(armorCategory(item) ?? "missing");
      expect(Number.isInteger(item.properties.ac)).toBe(true);
    }
  });

  test("armor dex caps follow the SRD pattern per category", () => {
    for (const item of MASTER_ITEMS.filter((entry) => entry.kind === "armor")) {
      const cap = item.properties.dexCap;
      switch (armorCategory(item)) {
        case "light":
          expect(cap).toBeNull();
          break;
        case "medium":
          expect(cap).toBe(2);
          break;
        case "heavy":
          expect(cap).toBe(0);
          break;
      }
      expect(typeof item.properties.stealthDisadvantage).toBe("boolean");
    }
  });

  test("healing potions carry heal dice at both tiers", () => {
    expect(getMasterItem("item.potion-healing")?.properties.heal).toBe("2d4+2");
    expect(getMasterItem("item.potion-healing-greater")?.properties.heal).toBe("4d4+4");
  });
});

describe("resolveItem()", () => {
  test("finds masterlist entries by id, price included", () => {
    const item = resolveItem(world(), "weapon.greatsword");
    expect(item?.name).toBe("Greatsword");
    expect(item?.baseCostCp).toBe(5000);
  });

  test("a World's own item overrides the masterlist by id", () => {
    const w = world([
      { id: "weapon.longsword", name: "Rusted Longsword", kind: "weapon", properties: { damage: "1d6" } },
    ]);
    const item = resolveItem(w, "weapon.longsword");
    expect(item?.name).toBe("Rusted Longsword");
    expect(item?.baseCostCp).toBeUndefined();
    // Still feeds the combat resolver: override damage wins, SRD fills the rest by id.
    const profile = weaponProfileFromItem(item!.id, item!.name, item!.properties);
    expect(profile.damage).toBe("1d6");
    expect(profile.damageType).toBe("slashing");
  });

  test("unknown ids resolve to undefined", () => {
    expect(resolveItem(world(), "item.nonexistent")).toBeUndefined();
  });
});

describe("item helpers", () => {
  test("kind guards classify masterlist entries", () => {
    expect(isWeapon(getMasterItem("weapon.dagger")!)).toBe(true);
    expect(isArmor(getMasterItem("armor.plate")!)).toBe(true);
    expect(isArmor(getMasterItem("armor.shield")!)).toBe(false);
    expect(isShield(getMasterItem("armor.shield")!)).toBe(true);
    expect(isShield(getMasterItem("armor.plate")!)).toBe(false);
    expect(isConsumable(getMasterItem("item.potion-healing")!)).toBe(true);
    expect(isConsumable(getMasterItem("item.rope-hempen")!)).toBe(false);
  });

  test("guards never throw on malformed properties", () => {
    const malformed = [
      { id: "item.broken", name: "Broken", description: "", kind: "armor", properties: {} },
      { id: "item.odd", name: "Odd", description: "", kind: "armor", properties: { category: 42, ac: "high" } },
      { id: "item.bare", name: "Bare", description: "", kind: "consumable", properties: { heal: 7 } },
    ] as ResolvedItem[];
    for (const item of malformed) {
      expect(() => {
        isWeapon(item);
        isArmor(item);
        isShield(item);
        isConsumable(item);
        armorCategory(item);
        itemBaseCostCp(item);
      }).not.toThrow();
    }
    expect(armorCategory(malformed[1]!)).toBeUndefined();
    expect(isArmor(malformed[0]!)).toBe(true); // missing category still counts as wearable
    expect(isConsumable(malformed[2]!)).toBe(true); // kind wins even with odd heal value
  });

  test("itemFitsSlot gates each equip slot by kind/category (the enqueuer-side check)", () => {
    const dagger = getMasterItem("weapon.dagger")!;
    const plate = getMasterItem("armor.plate")!;
    const shield = getMasterItem("armor.shield")!;
    const potion = getMasterItem("item.potion-healing")!;
    expect(itemFitsSlot(dagger, "weapon")).toBe(true);
    expect(itemFitsSlot(plate, "armor")).toBe(true);
    expect(itemFitsSlot(shield, "shield")).toBe(true);
    // Wrong kind/category never fits: a potion equips nowhere, a shield is not wearable armor.
    expect(itemFitsSlot(potion, "weapon")).toBe(false);
    expect(itemFitsSlot(potion, "armor")).toBe(false);
    expect(itemFitsSlot(potion, "shield")).toBe(false);
    expect(itemFitsSlot(shield, "armor")).toBe(false);
    expect(itemFitsSlot(plate, "shield")).toBe(false);
    expect(itemFitsSlot(dagger, "armor")).toBe(false);
  });

  test("itemBaseCostCp prefers own price, then properties, then the masterlist by id", () => {
    expect(itemBaseCostCp(getMasterItem("item.torch")!)).toBe(1);
    const authored = ItemSchema.parse({
      id: "item.house-brew",
      name: "House Brew",
      kind: "consumable",
      properties: { costCp: 42 },
    });
    expect(itemBaseCostCp(authored)).toBe(42);
    // A world override without a price keeps the SRD price for its id.
    const override = ItemSchema.parse({ id: "weapon.longsword", name: "Rusted Longsword", kind: "weapon" });
    expect(itemBaseCostCp(override)).toBe(1500);
    const unknown = ItemSchema.parse({ id: "item.unpriced", name: "Unpriced" });
    expect(itemBaseCostCp(unknown)).toBe(0);
  });
});
