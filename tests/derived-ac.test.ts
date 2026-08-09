/**
 * derivedAc tests — AC from what is actually worn (armor base + capped dex + shield).
 *
 * The resolve fn is backed by the bundled masterlist via `resolveItem` on an item-less world,
 * so the table exercises the exact data combat consumes at runtime.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import type { StatBlock } from "../src/content/schema.ts";
import { derivedAc } from "../src/rules/combat.ts";
import { resolveItem, type ResolvedItem } from "../src/rules/items.ts";
import type { Equipped } from "../src/world/entity.ts";

const resolve = (id: string): ResolvedItem | undefined => resolveItem({ items: [] }, id);

function stats(armorClass: number, dex: number): Pick<StatBlock, "armorClass" | "abilities"> {
  return { armorClass, abilities: { str: 10, dex, con: 10, int: 10, wis: 10, cha: 10 } };
}

describe("derivedAc", () => {
  test("nothing equipped keeps the authored armorClass verbatim (monsters, unequipped humanoids)", () => {
    expect(derivedAc(stats(13, 18), undefined, resolve)).toBe(13);
    expect(derivedAc(stats(13, 18), {}, resolve)).toBe(13);
  });

  test("light armor adds the full dex modifier (dexCap null = uncapped)", () => {
    // leather: base 11 · dex 18 (+4) → 15
    expect(derivedAc(stats(10, 18), { armor: "armor.leather" }, resolve)).toBe(15);
  });

  test("medium armor caps dex at +2", () => {
    // chain shirt: base 13 · dex 18 (+4, capped 2) → 15
    expect(derivedAc(stats(10, 18), { armor: "armor.chain-shirt" }, resolve)).toBe(15);
    // an agile scout gains nothing past the cap, a slow one keeps their +1
    expect(derivedAc(stats(10, 12), { armor: "armor.chain-shirt" }, resolve)).toBe(14);
  });

  test("heavy armor ignores the dex modifier entirely (SRD 5.1 — negative dex does not bite)", () => {
    // plate: base 18 · dex 18 (+4, ignored) → 18
    expect(derivedAc(stats(10, 18), { armor: "armor.plate" }, resolve)).toBe(18);
    // dex 8 (-1) is ignored too: plate is 18 flat, chain mail 16 flat
    expect(derivedAc(stats(10, 8), { armor: "armor.plate" }, resolve)).toBe(18);
    expect(derivedAc(stats(10, 8), { armor: "armor.chain-mail" }, resolve)).toBe(16);
    // medium armor's +2 is a true cap: negative dex still applies (chain shirt 13 − 1 = 12)
    expect(derivedAc(stats(10, 8), { armor: "armor.chain-shirt" }, resolve)).toBe(12);
  });

  test("a shield stacks +2 on top of worn armor", () => {
    expect(derivedAc(stats(10, 18), { armor: "armor.plate", shield: "armor.shield" }, resolve)).toBe(20);
    expect(derivedAc(stats(10, 14), { armor: "armor.leather", shield: "armor.shield" }, resolve)).toBe(15);
  });

  test("a shield alone still adds to the authored armorClass fallback", () => {
    expect(derivedAc(stats(12, 10), { shield: "armor.shield" }, resolve)).toBe(14);
  });

  test("an unresolvable or non-armor equipped id falls back to the authored armorClass", () => {
    expect(derivedAc(stats(14, 18), { armor: "armor.of-nowhere" }, resolve)).toBe(14);
    // a weapon jammed into the armor slot is not wearable armor
    expect(derivedAc(stats(14, 18), { armor: "weapon.longsword" }, resolve)).toBe(14);
    // a non-shield in the shield slot adds nothing
    expect(derivedAc(stats(14, 18), { shield: "weapon.dagger" }, resolve)).toBe(14);
  });
});
