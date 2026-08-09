/**
 * The engine surface a domain resolver is allowed to touch.
 *
 * `GameEngine` grew into one 9k-line class because every resolver was a private method with the
 * whole object in scope. Splitting it needs a stated contract, and this is it: a resolver reads the
 * authored content, reads the world model, applies reducer commands, and emits events. Nothing else
 * — no store, no gateway, no per-turn engine scratch. A domain that genuinely needs more takes it as
 * an explicit parameter, which makes the exception visible instead of ambient.
 *
 * The one-writer rule is unchanged: `apply` is the engine's own `apply`, which routes to the reducer
 * and stamps the turn's command ledger. A resolver still never mutates the model itself.
 *
 * Most resolvers run inside a tick and should take a `TickContext` directly — it already carries
 * everything here plus the per-turn scratch. {@link hostOf} bridges the two so a tick-scoped
 * resolver can call a host-scoped helper without the engine threading a second parameter. The bare
 * host exists for the paths that run OUTSIDE a tick (delta handlers, effect application), where
 * there is no `TickContext` to hand around.
 *
 * @author Runkai Zhang
 */
import type { Campaign, World } from "../../content/schema.ts";
import type { EmittedEvent } from "../../events/types.ts";
import type { Command } from "../../world/commands.ts";
import type { WorldModel } from "../../world/model.ts";
import type { CommandResult } from "../../world/reducer.ts";
import type { TickContext } from "../tick.ts";

/** What a resolver may do to the world. See the module header for why it is this small. */
export interface EngineHost {
  readonly world: World;
  readonly campaign: Campaign;
  /** The live world model. A function, not a field — the engine's model is replaced on load/rewind. */
  model(): WorldModel;
  /** Apply a command through the reducer, emitting its deltas. The ONLY write path. */
  apply(cmd: Command): CommandResult;
  /** Emit a narrative/system event. */
  emit(ev: EmittedEvent): void;
}

/** View a tick context as an {@link EngineHost} — the same primitives under the narrower contract. */
export function hostOf(ctx: TickContext): EngineHost {
  return {
    world: ctx.services.world,
    campaign: ctx.services.campaign,
    model: () => ctx.model,
    apply: (cmd) => ctx.apply(cmd),
    emit: (ev) => ctx.emit(ev),
  };
}
