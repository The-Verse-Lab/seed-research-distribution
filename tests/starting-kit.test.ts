/**
 * Starting kit mapping — deterministic class → gear (used by the interactive character builder
 * and, formerly, world generation). Extracted from worldsmith-gear.test.ts when the generated-world
 * gear-placement suite was archived alongside the retired world builder.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signatureKitFrom, startingKitFor, withStartingProvisions } from "../src/worldsmith/reconcile.ts";

describe("starting kit mapping", () => {
  test("classes map deterministically; unknown classes get the drifter's kit", () => {
    expect(startingKitFor("Fighter")).toEqual(["armor.chain-shirt", "weapon.longsword", "armor.shield"]);
    expect(startingKitFor("a grizzled warrior")).toEqual(["armor.chain-shirt", "weapon.longsword", "armor.shield"]);
    expect(startingKitFor("Rogue")).toEqual(["armor.leather", "weapon.shortsword", "weapon.shortbow"]);
    expect(startingKitFor("hunter")).toEqual(["armor.leather", "weapon.shortsword", "weapon.shortbow"]);
    expect(startingKitFor("Wizard")).toEqual(["weapon.quarterstaff", "weapon.dagger"]);
    expect(startingKitFor("hedge mage")).toEqual(["weapon.quarterstaff", "weapon.dagger"]);
    expect(startingKitFor("wanderer")).toEqual(["armor.leather", "weapon.club"]);
  });

  test("the r4 families: concept-adjacent classes stop falling to the drifter's club", () => {
    // The r4 run's Investigator "kept her instruments" and was dealt a club + leather.
    expect(startingKitFor("Investigator")).toEqual(["armor.leather", "weapon.dagger", "item.thieves-tools"]);
    expect(startingKitFor("a disgraced imperial surveyor")).toEqual(["armor.leather", "weapon.dagger", "item.thieves-tools"]);
    expect(startingKitFor("Barbarian")).toEqual(["armor.hide", "weapon.greataxe"]);
    expect(startingKitFor("Paladin")).toEqual(["armor.chain-shirt", "weapon.longsword", "armor.shield"]);
    expect(startingKitFor("sellsword")).toEqual(["armor.chain-shirt", "weapon.longsword", "armor.shield"]);
    expect(startingKitFor("Monk")).toEqual(["weapon.quarterstaff"]);
    expect(startingKitFor("Cleric")).toEqual(["armor.scale-mail", "weapon.mace", "armor.shield", "item.holy-symbol"]);
    expect(startingKitFor("Druid")).toEqual(["armor.leather", "weapon.sickle", "item.herbalism-kit"]);
    // r7 P4: the floor must carry an instrument even when the concept names no specific one.
    expect(startingKitFor("Bard")).toEqual(["armor.leather", "weapon.rapier", "item.lute"]);
    expect(startingKitFor("wandering scholar")).toEqual(["weapon.quarterstaff", "weapon.dagger"]);
  });

  test("a class stem inside another word deals nothing — 'Stranger' is not a ranger (r8 audit)", () => {
    // Reproduced against the shipped mapping: startingKitFor("Stranger") returned the ROGUE row
    // (leather + shortsword + shortbow) off the letters inside st-RANGER, so a character whose
    // whole concept is "a stranger" began the game armed like a scout.
    expect(startingKitFor("Stranger")).toEqual(["armor.leather", "weapon.club"]);
    expect(startingKitFor("a stranger off the salt road")).toEqual(["armor.leather", "weapon.club"]);
    // …and the word start still binds every inflection the model actually writes.
    expect(startingKitFor("Ranger")).toEqual(["armor.leather", "weapon.shortsword", "weapon.shortbow"]);
    expect(startingKitFor("rangers of the fen")).toEqual(["armor.leather", "weapon.shortsword", "weapon.shortbow"]);
    expect(startingKitFor("Guardsman")).toEqual(["armor.chain-shirt", "weapon.longsword", "armor.shield"]);
    expect(startingKitFor("Priestess")).toEqual(["armor.scale-mail", "weapon.mace", "armor.shield", "item.holy-symbol"]);
    expect(startingKitFor("Sorceress")).toEqual(["weapon.quarterstaff", "weapon.dagger"]);
    // The compound class words the word-start rule would otherwise drop are stems of their own.
    expect(startingKitFor("battlemage")).toEqual(["weapon.quarterstaff", "weapon.dagger"]);
    expect(startingKitFor("a bodyguard for hire")).toEqual(["armor.chain-shirt", "weapon.longsword", "armor.shield"]);
  });

  test("every id any family can deal exists in the SRD masterlist", () => {
    const masterlist = JSON.parse(
      readFileSync(fileURLToPath(new URL("../src/rules/srd/items.json", import.meta.url)), "utf8"),
    ) as { id: string }[];
    const ids = new Set(masterlist.map((i) => i.id));
    const classes = [
      "Fighter", "Rogue", "Wizard", "wanderer", "Investigator", "Barbarian", "Paladin",
      "Monk", "Cleric", "Druid", "Bard", "sellsword", "surveyor", "scholar",
    ];
    for (const cls of classes) {
      for (const id of startingKitFor(cls)) {
        expect(ids.has(id), `${cls} deals unknown item ${id}`).toBe(true);
      }
    }
  });
});

describe("signature gear — the concept the builder just interviewed you about (r5 P4)", () => {
  test("the named signature items are dealt", () => {
    // The r5 report, verbatim: this concept produced a chain shirt, a longsword and a shield.
    expect(signatureKitFrom("a harbour brawler who carries a boarding axe and a coil of tarred rope")).toEqual([
      "weapon.handaxe",
      "item.rope-hempen",
    ]);
  });

  test("one item per group — 'boarding axe' never also deals the generic battleaxe", () => {
    const kit = signatureKitFrom("a boarding axe, well used");
    expect(kit).toEqual(["weapon.handaxe"]);
  });

  test("prose that names no gear changes nothing", () => {
    expect(signatureKitFrom("a quiet woman who reads people the way others read weather")).toEqual([]);
    expect(signatureKitFrom("")).toEqual([]);
  });

  test("a leather-bound ledger is not leather armour (curated phrases, not fuzzy search)", () => {
    expect(signatureKitFrom("keeps a leather-bound ledger of every debt owed her")).toEqual(["item.book"]);
  });

  test("capped at three — a kit, not a quartermaster's manifest", () => {
    const kit = signatureKitFrom("carries a spear, a sling, a lantern, a shovel, rope, a mirror and manacles");
    expect(kit).toHaveLength(3);
  });

  test("every id the table can deal exists in the SRD masterlist", () => {
    const masterlist = JSON.parse(
      readFileSync(fileURLToPath(new URL("../src/rules/srd/items.json", import.meta.url)), "utf8"),
    ) as { id: string }[];
    const ids = new Set(masterlist.map((i) => i.id));
    const concepts = [
      "boarding axe", "greataxe", "battleaxe", "rope", "grappling hook", "crowbar", "lockpicks",
      "lantern", "torch", "spear", "shortbow", "longbow", "crossbow", "sling", "a bow", "net", "whip",
      "warhammer", "mace", "quarterstaff", "greatsword", "shortsword", "dagger", "manacles",
      "healer's kit", "herbalism", "holy symbol", "spellbook", "disguises", "fishing", "shovel",
      "snares", "caltrops", "climbing", "ledger", "mirror", "length of chain",
      "lute", "lyre", "flute", "drum", "fiddle", "pipes", "horn", "minstrel", "busker", "song-keeper",
    ];
    for (const concept of concepts) {
      const kit = signatureKitFrom(concept);
      expect(kit.length, `"${concept}" named nothing`).toBeGreaterThan(0);
      for (const id of kit) expect(ids.has(id), `"${concept}" deals unknown item ${id}`).toBe(true);
    }
  });
});

describe("signature gear — instrument words (r7 P4 — a bard with no instrument)", () => {
  test("named instruments each deal their own item", () => {
    expect(signatureKitFrom("carries a lute everywhere")).toEqual(["item.lute"]);
    expect(signatureKitFrom("plays a lyre at court")).toEqual(["item.lyre"]);
    expect(signatureKitFrom("a simple wooden flute")).toEqual(["item.flute"]);
    expect(signatureKitFrom("beats a marching drum")).toEqual(["item.drum"]);
    expect(signatureKitFrom("scrapes out reels on a fiddle")).toEqual(["item.fiddle"]);
    expect(signatureKitFrom("a set of reed pipes")).toEqual(["item.pipes"]);
    expect(signatureKitFrom("blows a hunting horn between verses")).toEqual(["item.horn"]);
  });

  test("generic bard-concept words fall back to a lute instead of naming nothing", () => {
    // The r7 report, verbatim: this concept named no specific instrument and was dealt none at all.
    expect(signatureKitFrom("a travelling song-keeper who trades in other people's stories")).toEqual(["item.lute"]);
    expect(signatureKitFrom("a minstrel with a fine singing voice")).toEqual(["item.lute"]);
    expect(signatureKitFrom("a busker who trades songs for coin")).toEqual(["item.lute"]);
  });

  test("an instrument phrase never also matches a weapon group", () => {
    // "horn" and "pipes" read nothing like the existing weapon/tool phrases (whip, spear, ...).
    expect(signatureKitFrom("a battered horn slung on a cord")).toEqual(["item.horn"]);
    expect(signatureKitFrom("keeps her pipes wrapped in oilcloth")).toEqual(["item.pipes"]);
  });

  test("one instrument per group — naming two instruments still deals only the first matched", () => {
    const kit = signatureKitFrom("plays drum and horn for coin");
    expect(kit).toEqual(["item.drum"]); // table order, not sentence order
  });
});

describe("starting provisions — rations and a waterskin on top of the floor (r7 P4)", () => {
  test("tops up a bare kit to two rations and a waterskin", () => {
    const kit = withStartingProvisions(["armor.leather", "weapon.rapier"]);
    expect(kit.filter((i) => i === "item.rations")).toHaveLength(2);
    expect(kit.filter((i) => i === "item.waterskin")).toHaveLength(1);
    expect(kit).toEqual(["armor.leather", "weapon.rapier", "item.rations", "item.rations", "item.waterskin"]);
  });

  test("dedupes against provisions the phrase table already dealt — never stacks past the target count", () => {
    const kit = withStartingProvisions(["armor.leather", "item.rations", "item.waterskin"]);
    expect(kit.filter((i) => i === "item.rations")).toHaveLength(2); // one already present + one topped up
    expect(kit.filter((i) => i === "item.waterskin")).toHaveLength(1); // already present, none added
  });

  test("a kit that already meets the target is left untouched", () => {
    const kit = ["item.rations", "item.rations", "item.waterskin", "weapon.dagger"];
    expect(withStartingProvisions(kit)).toEqual(kit);
  });
});
