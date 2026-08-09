/**
 * The r11 sweep's findings, pinned.
 *
 * Every case below was REPRODUCED live at commit `d48af5c` — either in the 120-turn automated sweep
 * (`playtest/auto/reports/2026-08-01T22-54-44-*`) or in the Chrome pass on the same build. The
 * place-name binder half of the round lives in `tests/name-match.test.ts`, beside the r5 cases it
 * belongs with.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { reconcilePlan } from "../src/engine/classify.ts";
import type { ClassifierContext } from "../src/engine/turn-plan.ts";
import { isAskedNotCommitted } from "../src/rules/asked.ts";
import { isCoinQuantity } from "../src/engine/resolvers/items.ts";
import { NARRATOR_HICCUP_LINE, TRUNCATED_NOTICE } from "../src/modules/narrate.ts";

const CHECK = { warranted: false, ability: null, skill: null, dc: null, reason: "" };

function ctx(overrides: Partial<ClassifierContext> = {}): ClassifierContext {
  return {
    playerActorId: "pc.you",
    locationId: "loc.anchorfall",
    locationName: "Anchorfall",
    exits: [],
    presentEntities: [{ id: "npc.veil", name: "Sergeant Veil" }],
    companionIds: [],
    carriedItems: [
      { id: "item.mage-hat", name: "Wide-Brimmed Mage Hat" },
      { id: "item.rations", name: "Rations (1 day)" },
    ],
    vendors: [
      {
        id: "npc.veil",
        name: "Sergeant Veil",
        stock: [{ id: "item.rations", name: "Rations (1 day)" }],
      },
    ],
    ...overrides,
  } as ClassifierContext;
}

const tradePlan = (trade: Record<string, unknown>) => ({
  kind: "trade",
  targetId: null,
  destinationLocationId: null,
  check: CHECK,
  item: null,
  trade,
  confidence: 0.8,
});

const dialoguePlan = (effects: unknown) => ({
  kind: "dialogueToNpc",
  targetId: "npc.veil",
  destinationLocationId: null,
  check: CHECK,
  effects,
  confidence: 0.9,
});

describe("R11-1 — a question is never an execution", () => {
  // THE LIVE CASE, browser pass: this exact sentence SOLD the hat off the player's head
  // ("You sell the Wide-Brimmed Mage Hat to Sergeant Veil for 7 sp 5 cp.") on one pass and correctly
  // quoted a price on the very next regenerate. The classifier's `inquiry` flag is the difference,
  // and it flipped on identical input — so the floor decides it deterministically.
  const HAT_ASK = "Sergeant Veil, would you take my mage hat for three copper?";

  test("REPRO — the model saying inquiry:false does not make a sell-question a sale", () => {
    const plan = reconcilePlan(
      tradePlan({ direction: "sell", itemId: "item.mage-hat", vendorId: "npc.veil", inquiry: false }),
      ctx(),
      HAT_ASK,
    );
    expect(plan.trade?.inquiry).toBe(true);
  });

  test("the model saying inquiry:true is of course still honoured", () => {
    const plan = reconcilePlan(
      tradePlan({ direction: "buy", itemId: "item.rations", vendorId: "npc.veil", inquiry: true }),
      ctx(),
      "I buy the rations.",
    );
    expect(plan.trade?.inquiry).toBe(true);
  });

  test("a COMMITTED line is untouched — the floor only ever pushes toward the question", () => {
    for (const line of ["I buy the rations.", "I'll take the rations.", "I'll take the spear — how much?"]) {
      const plan = reconcilePlan(
        tradePlan({ direction: "buy", itemId: "item.rations", vendorId: "npc.veil", inquiry: false }),
        ctx(),
        line,
      );
      expect(plan.trade?.inquiry).toBeUndefined();
    }
  });

  // THE OTHER HALF, fixture-trade t20: the same class escaping the trade channel entirely. The line
  // classified `dialogueToNpc` (so `classifierTrade` was null and the inquiry gate never ran) and
  // the freeform coin channel took the number out of the sentence: "You hand over 3 cp to Sergeant
  // Veil." The player had OFFERED TO SELL a ration and was charged 3 cp for nothing.
  test("REPRO — an asked line drops a spendCoins effect: offering to sell is not paying", () => {
    const plan = reconcilePlan(
      dialoguePlan([{ type: "spendCoins", amountCp: 3, itemId: null, toNpcId: "npc.veil" }]),
      ctx(),
      "I ask Sergeant Veil if she'll take my extra ration for three copper.",
    );
    expect(plan.effects ?? []).toEqual([]);
  });

  test("a committed payment still pays — the channel is not disabled, only gated on the ask", () => {
    const plan = reconcilePlan(
      dialoguePlan([{ type: "spendCoins", amountCp: 3, itemId: null, toNpcId: "npc.veil" }]),
      ctx(),
      "I hand Veil three copper for her trouble.",
    );
    expect(plan.effects).toEqual([{ type: "spendCoins", amountCp: 3, itemId: null, toNpcId: "npc.veil" }]);
  });

  test("the floor's own contract: asked vs committed, on the shapes the sweep produced", () => {
    for (const asked of [
      "Sergeant Veil, would you take my mage hat for three copper?",
      "I ask Sergeant Veil if she'll take my extra ration for three copper.",
      "how much for the lantern?",
      "Do you have a spear?",
    ]) {
      expect(isAskedNotCommitted(asked)).toBe(true);
    }
    for (const committed of [
      "I buy the lantern.",
      "I'll take the spear.",
      "I sell my waterskin.",
      "Sold.",
      "I take the rations for 5 sp and the waterskin for 2 sp.",
      "I head to the market.",
    ]) {
      expect(isAskedNotCommitted(committed)).toBe(false);
    }
  });
});

describe("R11-3 — coin is a purse balance, never an object", () => {
  // fixture-trade t23: `I pocket the six coppers` minted `item.six-coppers` from nothing
  // (`itemTransferred item.six-coppers null → pc.you`, "You take the Six Coppers."). The unattended
  // branch's content guard is `namedInRecentProse`, and the narrator's own sentence about the
  // player's PURSE BALANCE satisfied it — while the same prose had just said the coppers were the
  // vendor's: "counted, hers, and not coming back."
  test("REPRO — the r11 mint is refused", () => {
    expect(isCoinQuantity("item.six-coppers", "Six Coppers")).toBe(true);
  });

  test("every shape money is spelled in", () => {
    for (const [id, name] of [
      ["item.six-coppers", "Six Coppers"],
      ["item.3-cp", "3 Cp"],
      ["item.a-silver", "A Silver"],
      ["item.handful-of-coins", "Handful Of Coins"],
      ["item.coins", "Coins"],
    ] as const) {
      expect(isCoinQuantity(id, name)).toBe(true);
    }
  });

  test("an object that is merely MADE of a metal is still a real object", () => {
    for (const [id, name] of [
      ["item.copper-kettle", "Copper Kettle"],
      ["item.silver-locket", "Silver Locket"],
      ["item.gold-ring", "Gold Ring"],
      ["item.coin-purse", "Coin Purse"],
      ["item.rope-hempen-50-ft", "Rope, Hempen (50 ft)"],
    ] as const) {
      expect(isCoinQuantity(id, name)).toBe(false);
    }
  });
});

describe("R11-6 — the player's notice is not an operator's notice", () => {
  // r10 F-6 made the empty-narrator degrade honest; r11 found it honest to the wrong audience —
  // the message named `SEED_RESCUE_*` on the player's screen mid-scene, and the sweep judge called
  // it the immersion break. The cause and remedy belong in the console and the trace.
  test("no notice the player reads names an environment variable", () => {
    for (const line of [NARRATOR_HICCUP_LINE, TRUNCATED_NOTICE]) {
      expect(line).not.toMatch(/SEED_[A-Z_]+/);
      expect(line).not.toMatch(/\benv(?:ironment)?\b/i);
    }
  });

  test("both still say the world hiccuped, not that the player did nothing", () => {
    expect(TRUNCATED_NOTICE).toMatch(/cut short/i);
    expect(NARRATOR_HICCUP_LINE.length).toBeGreaterThan(40);
  });
});
