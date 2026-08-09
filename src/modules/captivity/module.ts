/**
 * Captivity module — the tick spine of the bad-end FOLLOW-UP loop.
 *
 * Once `beginCaptivity` has taken the player (the reducer moved them to the locked hold, stripped
 * their gear, scattered the party), this module owns their turns until they get out:
 *
 *  - resolve: while held, READ the player's line as a captivity action (labor / endure / escape — the
 *    the same text-driven gating used by other bounded scenes, so no new classifier kind is needed), resolve it
 *    in code (`src/rules/captivity.ts`), advance the persisted slice through the generic `modulePatch`,
 *    and PARK a follow-up beat for the DM. Serve the term (`progress ≥ goal`) or win an escape check
 *    and it enqueues `endCaptivity` — the player is really turned loose, back where they were taken,
 *    gear returned, party re-admitted.
 * All passive cadence/flavour is a PRIVATE id-keyed roll (zero shared-stream draws → replay-safe); the
 * escape CHECK is a real d20 vs the current DC drawn from the shared stream, like any skill check. The
 *
 * @author Runkai Zhang
 */
import type { Campaign } from "../../content/schema.ts";
import { playerEntity } from "../../world/model.ts";
import { isCaptive, readCaptivitySlice } from "../../world/captivity.ts";
import {
  CAPTIVITY_CONFIG,
  captivityActionOf,
  resolveCaptivityAction,
} from "../../rules/captivity.ts";
import { resolveCheck } from "../../rules/checks.ts";
import { abilityModifier } from "../../rules/dice.ts";
import { exhaustionCheckMods, exhaustionOf } from "../../rules/exhaustion.ts";
import { statusMods } from "../../rules/status-effects.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import type { TurnPlan } from "../../engine/turn-plan.ts";

export class CaptivityModule implements TickModule {
  readonly id = "captivity";
  readonly phases: TickModule["phases"];

  constructor(private readonly campaign: Campaign) {
    this.phases = {
      resolve: (ctx) => this.onResolve(ctx),
    };
  }

  /** The player's held turn: read the line as an action, resolve it, advance the slice, park a beat. */
  private onResolve(ctx: TickContext): void {
    if (ctx.trigger.kind !== "player") return;
    // A private aside (toId) never drives the loop — it neither labours nor escapes.
    if (ctx.trigger.toId !== undefined) return;
    const model = ctx.model;
    if (!isCaptive(model)) return;
    const slice = readCaptivitySlice(model);
    const cfg = CAPTIVITY_CONFIG[slice.kind];
    const input = ctx.trigger.input.trim();
    // The action, in reader order: an exact button label, then the classifier's closed
    // `captivityAction`, then the prose floor (r8 regex audit). Core stashed the classified plan on
    // `ctx.data.captivityPlan` — it resolves nothing from it, so there is no double-roll; the only
    // thing read here is the one enum. The floor's `/\brun\b/` arm scored "I run my hands along the
    // wall looking for loose stones" as a break-out attempt, which is a real d20, a permanently
    // raised escapeDc and a burned captivity day for a line that was searching (reproduced).
    const action = captivityActionOf(
      (ctx.data.captivityPlan as TurnPlan | undefined)?.captivityAction,
      input,
    );

    // Escape is a real check vs the CURRENT DC — the shared seeded stream, like any skill check. The
    // PC's own STR/DEX (whichever is better) modifies it; an unknown character defaults to a flat 10.
    let escapeSucceeded = false;
    let rollLine = "";
    if (action === "escape") {
      const pcId = playerEntity(model)?.id ?? "";
      const pc = this.campaign.characters.find((c) => c.id === pcId);
      const abilityScore = Math.max(pc?.stats.abilities.str ?? 10, pc?.stats.abilities.dex ?? 10);
      const exh = exhaustionCheckMods(exhaustionOf(model.entities.get(pcId)?.stats));
      const dc = slice.escapeDc + exh.dcAdjustment;
      const smods = statusMods(model, pcId);
      const result = resolveCheck(
        { abilityScore, dc, bonus: smods.check, disadvantage: exh.disadvantage || smods.disadvantage },
        ctx.services.rng,
      );
      escapeSucceeded = result.success;
      rollLine = ` (Escape check: ${result.total} vs DC ${dc} — ${result.success ? "success" : "failure"}.)`;
      ctx.emit({
        kind: "diceRolled",
        actorId: pcId,
        notation: `1d20 + ${abilityModifier(abilityScore)}`,
        rolls: result.rolls,
        total: result.total,
        purpose: `Escape check (DC ${dc})`,
        success: result.success,
      });
    }

    const res = resolveCaptivityAction(slice, action, { escapeSucceeded });

    if (res.escaped) {
      ctx.apply({ type: "endCaptivity", outcome: "escaped" });
      ctx.data.narration = {
        trigger:
          `${res.beat}${rollLine}\n\nYou are FREE — you break out of ${cfg.place} and get clear before the ` +
          `alarm can rise. Narrate the escape and the player back on the outside, gear reclaimed.`,
      };
      ctx.emit({ kind: "system", level: "info", message: `Captivity: escaped from ${slice.kind}.` });
      return;
    }
    if (res.released) {
      ctx.apply({ type: "endCaptivity", outcome: "served" });
      ctx.data.narration = {
        trigger:
          `${res.beat}\n\nYour time is served — ${slice.captorName} turns you loose at last. Narrate the ` +
          `release and the player back on the outside, their belongings returned.`,
      };
      ctx.emit({ kind: "system", level: "info", message: `Captivity: term served (${slice.kind}) — released.` });
      return;
    }

    // Still held: advance the persisted loop (progress / escape DC / day) and park the follow-up beat.
    ctx.apply({ type: "modulePatch", module: "captivity", patch: { ...res.next } });
    ctx.data.narration = {
      trigger:
        `${res.beat}${rollLine}\n\n(Day ${res.next.day} in ${cfg.place}, held by ${slice.captorName}. ` +
        `Progress ${res.next.progress}/${res.next.goal} toward release; escape DC ${res.next.escapeDc}. ` +
        `You remain captive — you can labour, endure, or attempt escape. Narrate this beat of captivity.)`,
    };
  }

}
