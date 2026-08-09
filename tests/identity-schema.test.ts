/**
 * Character identity schema defaults and back-compat loading.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { AlignmentSchema, CharacterSchema, IdentitySchema, NpcTemplateSchema } from "../src/content/schema.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 8, armorClass: 10 };

describe("IdentitySchema", () => {
  test("stale gender keys from older content are stripped on parse (field removal back-compat)", () => {
    const parsed = IdentitySchema.parse({ gender: "woman", perceivedGender: "woman", sex: "female" });
    expect(parsed.sex).toBe("female");
    expect("gender" in parsed).toBe(false);
    expect("perceivedGender" in parsed).toBe(false);
  });

  test("keeps shared identity fields defaulted for back-compatible authored content", () => {
    expect(IdentitySchema.parse({})).toEqual({
      sex: "",
      description: "",
      body: { height: "", build: "", hair: "", eyes: "", skin: "", face: "", distinguishing: "" },
      personality: "",
      knownLore: "",
      hiddenLore: "",
    });
  });

  test("CharacterSchema gets identity defaults without fixed alignment", () => {
    const pc = CharacterSchema.parse({
      id: "pc.you",
      name: "You",
      stats: STATS,
      backstory: "You remember the old road.",
      alignment: "lg",
    });

    expect(pc.sex).toBe("");
    expect(pc.description).toBe("");
    expect(pc.personality).toBe("");
    expect(pc.knownLore).toBe("");
    expect(pc.hiddenLore).toBe("");
    expect(pc.backstory).toBe("You remember the old road.");
    expect((pc as Record<string, unknown>).alignment).toBeUndefined();
  });

  test("NpcTemplateSchema keeps appearance while adding shared identity and NPC-only presets", () => {
    const npc = NpcTemplateSchema.parse({
      id: "npc.veil",
      name: "Vey",
      persona: "Soft-spoken broker.",
      appearance: "A silver pin catches the light.",
      description: "Tall, precise, and never quite still.",
      personality: "Courteous until crossed.",
      knownLore: "Knows which bridge is watched.",
      hiddenLore: "Does not know the signet is cursed.",
      alignment: "ln",
      personalityTemplate: "schemer",
    });

    expect(npc.appearance).toBe("A silver pin catches the light.");
    expect(npc.description).toBe("Tall, precise, and never quite still.");
    expect(npc.personality).toBe("Courteous until crossed.");
    expect(npc.knownLore).toBe("Knows which bridge is watched.");
    expect(npc.hiddenLore).toBe("Does not know the signet is cursed.");
    expect(npc.alignment).toBe("ln");
    expect(npc.personalityTemplate).toBe("schemer");
  });

  test("NPC alignment is restricted to the bundled nine ids", () => {
    expect(AlignmentSchema.options).toEqual(["lg", "ng", "cg", "ln", "tn", "cn", "le", "ne", "ce"]);
    expect(() => NpcTemplateSchema.parse({ id: "npc.bad", name: "Bad", persona: "Terse.", alignment: "lawful-ish" })).toThrow();
  });
});

describe("bundled playsets", () => {
  test("existing worlds load and receive defaulted identity fields", async () => {
    for (const name of ["thistledown", "example", "black-concord"]) {
      const { world, campaign } = await loadPlaySetFromDir(fileURLToPath(new URL(`fixtures/worlds/${name}`, import.meta.url)));
      for (const npc of world.npcs) {
        expect(typeof npc.description).toBe("string");
        expect(typeof npc.personality).toBe("string");
        expect(typeof npc.knownLore).toBe("string");
        expect(typeof npc.hiddenLore).toBe("string");
      }
      for (const pc of campaign.characters) {
        expect(typeof pc.description).toBe("string");
        expect(typeof pc.personality).toBe("string");
        expect(typeof pc.knownLore).toBe("string");
        expect(typeof pc.hiddenLore).toBe("string");
      }
    }
  });
});
