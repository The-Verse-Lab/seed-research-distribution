/**
 * The typed GROUNDED action — an affordance resolved to an unambiguous intent.
 *
 * A grounded action names its target directly (an exit id, a present NPC, a held item, an offered
 * quest) instead of arriving as prose to be classified, so `engine.submitAction` skips the
 * classifier entirely. The engine still performs every existence, location, and gate check.
 *
 * @author Runkai Zhang
 */
import type { WardrobeSlotState } from "../rules/wardrobe.ts";

/**
 * A typed, GROUNDED player action. Each variant names a target directly and maps 1:1 to a
 * `TurnPlan` the engine builds without the LLM classifier. The engine validates absent targets,
 * locations, and gates; the reducer remains the only state writer.
 */
export type GroundedAction =
  | { kind: "move"; exitId: string }
  | { kind: "equip"; itemId: string; slot?: string }
  | { kind: "unequip"; slot: string }
  | { kind: "useItem"; itemId: string }
  | { kind: "give"; itemId: string; toId: string }
  | { kind: "acceptQuest"; questId: string }
  | { kind: "declineQuest"; questId: string }
  | {
      kind: "answerProposal";
      proposalKind: "leader";
      fromId: string;
      accept: boolean;
    }
  | { kind: "rest" }
  | { kind: "enterCamp" }
  | { kind: "endDay" }
  | { kind: "rentRoom"; tierId: string }
  | { kind: "wakeInRoom" }
  | { kind: "recruitNpc"; targetId: string }
  | { kind: "joinParty"; leaderId: string }
  | { kind: "hireMerc"; offerId: string }
  | { kind: "trade"; direction: "buy" | "sell"; itemId: string; vendorId: string }
  /** A confirmed shopping basket: one vendor, many lines, one turn.
   * Every line re-validates against current stock, purse, and prices. */
  | {
      kind: "tradeBatch";
      vendorId: string;
      lines: { direction: "buy" | "sell"; itemId: string; quantity?: number }[];
    }
  /** Engage an authored vendor SERVICE (sharpen/repair/appraise…) — a fee for work, never a sale.
   *  `itemId` names the carried item the work is on when the service needs one. */
  | { kind: "serviceBuy"; vendorId: string; serviceId: string; itemId?: string }
  | { kind: "work"; opportunityId: string }
  | { kind: "locationInteraction"; interactionId: string }
  | { kind: "captivityAction"; actionId: string }
  | { kind: "clothing"; slotId: string; state: WardrobeSlotState }
  | { kind: "attack"; targetId: string };
