/**
 * TURN FACTS — compact authoritative lines describing the player-salient state changes the
 * reducer actually performed (or will legally perform at commit) this turn.
 *
 * The inverse of the continuity checks: `src/rules/continuity.ts` catches prose asserting a
 * change that never happened; this module TELLS the narrator what DID happen, rendered into
 * the brief as the `=== TURN FACTS ===` block (src/agents/context.ts). Whitelisted to the
 * command kinds a player can perceive — silent bookkeeping (clock, energy, module patches,
 * memory) never bloats the prompt, so a bookkeeping-only turn keeps a byte-identical brief.
 *
 * Pure formatting over (world content, model, commands): no I/O, no mutation, no model.
 *
 * @author Runkai Zhang
 */
import type { Command } from "../world/commands.ts";
import type { WorldModel } from "../world/model.ts";
import { playerEntity } from "../world/model.ts";
import type { World } from "../content/schema.ts";
import { formatCoins, itemDisplayNameOf, resolveItem } from "./items.ts";

/** Command kinds that produce a change the player can SEE — the only ones worth a fact line. */
export const TURN_FACT_COMMANDS: ReadonlySet<Command["type"]> = new Set<Command["type"]>([
  "transferItem",
  "tradeWith",
  "adjustCoins",
  "equipItem",
  "setCondition",
  "grantXp",
  "moveParty",
  "revealCaseFact",
  "resolveCase",
]);

/** Hard cap on rendered lines so a pathological turn can never flood the prompt. */
const MAX_FACT_LINES = 12;

/**
 * Render the authorized-command set into player-salient fact lines (empty ⇒ the caller omits
 * the block entirely). Names resolve against the PRE-commit model — entities present at turn
 * start — matching how the Judge names the same commands; an unknown id degrades to the id.
 */
export function turnFactLines(
  world: Pick<World, "items" | "locations">,
  model: WorldModel,
  commands: Command[],
): string[] {
  const playerId = playerEntity(model)?.id;
  const nameOf = (id: string | null): string => {
    if (!id) return "";
    if (id === playerId) return "You";
    return model.entities.get(id)?.name ?? id;
  };
  const isPlayer = (id: string | null): boolean => id !== null && id === playerId;
  const itemName = (id: string): string => resolveItem(world, id)?.name ?? itemDisplayNameOf(id);
  const locName = (id: string): string => world.locations.find((l) => l.id === id)?.name ?? id;

  const lines: string[] = [];
  for (const c of commands) {
    if (lines.length >= MAX_FACT_LINES) break;
    switch (c.type) {
      case "transferItem": {
        const item = itemName(c.itemId);
        if (isPlayer(c.from) && c.to === null) {
          lines.push(`You set down the ${item} — it is no longer in your possession.`);
        } else if (c.from === null && isPlayer(c.to)) {
          lines.push(`You picked up the ${item} — it is now in your pack.`);
        } else if (isPlayer(c.from) && c.to) {
          lines.push(`You gave the ${item} to ${nameOf(c.to)}.`);
        } else if (c.from && isPlayer(c.to)) {
          lines.push(`${nameOf(c.from)} gave you the ${item}.`);
        } else {
          lines.push(`The ${item} passed from ${nameOf(c.from) || "the world"} to ${nameOf(c.to) || "the ground"}.`);
        }
        break;
      }
      case "tradeWith": {
        const item = itemName(c.itemId);
        const vendor = nameOf(c.vendorId);
        lines.push(
          c.direction === "buy"
            ? `You bought the ${item} from ${vendor} for ${formatCoins(c.priceCp)}.`
            : `You sold the ${item} to ${vendor} for ${formatCoins(c.priceCp)}.`,
        );
        break;
      }
      case "adjustCoins": {
        if (c.by === 0) break;
        const who = nameOf(c.entityId);
        const amount = formatCoins(Math.abs(c.by));
        lines.push(
          who === "You"
            ? c.by < 0
              ? `You paid out ${amount} — your purse is lighter by exactly that.`
              : `You received ${amount} into your purse.`
            : `${who} ${c.by < 0 ? "paid out" : "received"} ${amount}.`,
        );
        break;
      }
      case "equipItem": {
        const who = nameOf(c.entityId);
        const verb = who === "You" ? "You" : who;
        lines.push(
          c.itemId
            ? `${verb} equipped the ${itemName(c.itemId)}.`
            : `${verb} unequipped the ${c.slot}.`,
        );
        break;
      }
      case "setCondition": {
        const who = nameOf(c.entityId);
        const be = who === "You" ? "are" : "is";
        if (c.active && c.condition === "unconscious") {
          lines.push(`${who} went DOWN — unconscious.`);
        } else if (c.active) {
          lines.push(`${who} ${be} now ${c.condition}.`);
        } else {
          lines.push(`${who} ${be} no longer ${c.condition}.`);
        }
        break;
      }
      case "grantXp": {
        lines.push(`${nameOf(c.entityId)} gained ${c.by} XP.`);
        break;
      }
      case "moveParty": {
        lines.push(
          c.solo ? `You moved to ${locName(c.to)}.` : `You and your party moved to ${locName(c.to)}.`,
        );
        break;
      }
      case "revealCaseFact": {
        // The narrator MUST treat this as established evidence — never invent or contradict it.
        lines.push(`EVIDENCE (established fact — do not embellish or contradict): ${c.factText}`);
        break;
      }
      case "resolveCase": {
        lines.push(c.status === "solved" ? `The case is SOLVED.` : `The case has ended in FAILURE.`);
        break;
      }
      default:
        break;
    }
  }
  return lines;
}
