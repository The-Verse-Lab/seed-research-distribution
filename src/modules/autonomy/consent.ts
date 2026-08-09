/**
 * The Director's consent gate — which grounded NPC commands may fire WITHOUT the player's word.
 *
 * Playtest r9 finding F-1 ("idle-to-win"): a leader's plan executed on silence. The player idled
 * five minutes composing a question; the Director walked the party two locations west and completed
 * a quest objective on the way. Two surfaces did it — tacit consent (an expired `pendingProposal`
 * consumed on a quiet heartbeat) and the direct-act branch (grounding produced a command while the
 * proposal path was closed by the cooldown) — and each was patched with its own hand-written
 * denylist of command *types*. A denylist fails open: every verb added to {@link groundToCommand}
 * afterwards is auto-executable until somebody remembers to list it. `take_job`
 * (`setQuestState` offered→active) is exactly that case — it shipped after the movement ban and
 * committed the party to a job nobody answered.
 *
 * So this is an ALLOWLIST, evaluated in code, defaulting to "ask first". The rule it encodes:
 *
 *   **An NPC may act unasked only on ITSELF and its own property. Anything that moves the player,
 *   spends the player's things, or commits the party to something needs an actual answer.**
 *
 * A blocked command is not lost — it stays a spoken nudge and (on the proposal path) the standing
 * card the player can still answer "yes" to. The answer path (engine `resolvePlayer`, the accept
 * branch) is unaffected by everything here: an explicit yes executes the plan whole, movement
 * included. That is the whole design — consent is the difference between the two paths.
 *
 * Pure: no I/O, no rng, no state writes. `path` distinguishes the two callers because they differ
 * on exactly one verb — a leader's SELF move (`moveEntity` at itself):
 *  - `direct`: legal. An NPC walking off on its own heartbeat is ordinary NPC life (routines rely
 *    on the same freedom) and binds the player to nothing.
 *  - `tacit`: refused. A *plan put to the table* to move, met with silence, dies as a nudge — the
 *    2026-07-25 wave counted seven involuntary relocations traced to stale movement plans firing,
 *    and a leader walking out alone on its own expired plan splits the party just as silently.
 *
 * @author Runkai Zhang
 */
import type { Command } from "../../world/commands.ts";
import { playerEntity, type WorldModel } from "../../world/model.ts";

/** Which surface is asking: an expired proposal consumed on silence, or an unasked direct act. */
export type ConsentPath = "tacit" | "direct";

/** Why a command needs the player's word. `unclassified` is the fail-closed default. */
export type ConsentReason = "movement" | "commitment" | "custody" | "unclassified";

export interface ConsentBlock {
  reason: ConsentReason;
  /** The command type, for telemetry (never player-facing prose). */
  command: string;
}

/**
 * Does `command`, taken by `actorId` with nobody having said yes, need the player's consent?
 *
 * @returns the block (with its reason) when the NPC must wait, or `null` when it may just act.
 */
export function consentBlockFor(
  command: Command,
  opts: { actorId: string; path: ConsentPath; model: WorldModel },
): ConsentBlock | null {
  const { actorId, path, model } = opts;
  const block = (reason: ConsentReason): ConsentBlock => ({ reason, command: command.type });
  const playerId = playerEntity(model)?.id;

  switch (command.type) {
    // The party goes where the PLAYER chose to go — typed travel, a clicked exit, or an explicit
    // yes to a fresh plan. Never on a heartbeat, on either path.
    case "moveParty":
      return block("movement");

    case "moveEntity":
      // Moving anyone but yourself is never an unasked act (grounding only ever builds the self
      // form; the check is here so a future caller can't slip the PC through).
      if (command.entityId !== actorId) return block("movement");
      return path === "tacit" ? block("movement") : null;

    // Self-scoped upkeep: the NPC's own gear, its own body, its own stamina. Binds nobody.
    case "equipItem":
    case "adjustHp":
    case "adjustEnergy":
    case "adjustExhaustion":
      return command.entityId === actorId ? null : block("unclassified");

    // Opening a way it can legally open is a physical act the NPC performs, not a decision made for
    // the player — and the seeded pick/force path (`barrierAttempt`) already acts unasked, so
    // gating the key-in-hand case would be incoherent.
    case "setExitState":
      return null;

    case "transferItem":
      // Giving away its OWN property is the NPC's to decide (the recipient can drop it).
      if (command.from === actorId) return null;
      // Taking is different. Off the player or a party member — never unasked. Off anyone else
      // (looting a defeated stranger, picking something off the ground) is the NPC's own act.
      if (command.to !== actorId) return block("custody");
      if (command.from === null) return null;
      if (command.from === playerId) return block("custody");
      return model.entities.get(command.from)?.partyMember === true ? block("custody") : null;

    // Taking up a job, flipping a quest, spending the party's coin, dragging someone into the
    // party: commitments made in the player's name. These are precisely what a proposal is FOR.
    case "setQuestState":
    case "setObjectiveDone":
    case "adjustCoins":
    case "tradeWith":
    case "grantXp":
    case "learnSpell":
      return block("commitment");

    // Everything else — world structure, flags, spawns, module slices, and every verb added after
    // this file was written — is refused until somebody classifies it here on purpose.
    default:
      return block("unclassified");
  }
}

/**
 * The first command in a plan that needs the player's word, or `null` when the whole plan is the
 * NPC's own business to enact.
 */
export function consentBlockInPlan(
  commands: readonly Command[],
  opts: { actorId: string; path: ConsentPath; model: WorldModel },
): ConsentBlock | null {
  for (const c of commands) {
    const block = consentBlockFor(c, opts);
    if (block) return block;
  }
  return null;
}
