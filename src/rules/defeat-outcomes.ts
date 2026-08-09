/**
 * Defeat outcomes — data-driven consequences for a lost fight (Workstream E, slim).
 *
 * A world MAY author a table of `DefeatOutcome`s. When it does, a lost fight (party overcome,
 * a foe still standing) resolves by SELECTING one authored outcome — deterministically, by a
 * seeded weighted pick over the gate-eligible survivors — instead of the flat 1-HP revival. A
 * world that authors none keeps the historic 1-HP fallback (the caller falls through on `null`).
 *
 * This file is PURE and deterministic: same (outcomes, gate context, rng sequence) → same pick.
 * It reads only generic world/scenario gates; it never touches the model or the LLM. The `effects`
 * are reducer `Command`s carrying absolute post-state — the caller applies them through the single
 * writer and the reducer decides.
 *
 * @author Runkai Zhang
 */
import type { Command } from "../world/commands.ts";
import type { CommandResult } from "../world/reducer.ts";

/**
 * One authored defeat consequence. `effects` apply via the reducer (the single writer); the
 * narrator receives `narratorBrief` as the authoritative "this happened" text — it never chooses
 * the outcome. Gate fields are optional, so a bare `{ id, weight, effects, narratorBrief }` is valid.
 */
export interface DefeatOutcome {
  id: string;
  /** Relative weight for the seeded pick (must be > 0 to be selectable). */
  weight: number;
  tags?: string[];
  /** Excluded if ANY of these world flags is truthy. */
  blockedByFlags?: string[];
  /** Excluded unless ALL of these world flags are truthy. */
  requiredFlags?: string[];
  /** Scenario axis — WHO beat you. Eligible only if the victor bag contains any requested faction,
   * entity kind, or truthy entity-flag key. Absent means victor-agnostic. */
  requiresVictorTags?: string[];
  /** Scenario axis — excluded if the victor bag contains ANY of these tags (the mirror of the above). */
  blockedByVictorTags?: string[];
  /** Scenario axis — HOW the bad end was reached. Eligible only if the gate's `cause` is one of
   * these; absent means cause-agnostic. */
  requiresCause?: string[];
  /** Applied via the reducer (absolute post-state Commands). */
  effects: Command[];
  /** Authoritative "this happened" text handed to the GM narrator. */
  narratorBrief: string;
}

/**
 * The gate facts the caller resolves from live state before selecting. The selector treats these
 * as authoritative, keeping this file pure and free of engine/LLM dependencies.
 */
export interface DefeatGateContext {
  /** World flags, read for `blockedByFlags` / `requiredFlags` gating. */
  flags: Record<string, unknown>;
  /** WHO beat you — the derived tag bag of surviving victors (faction/kind/entity-flags),
   *  the caller resolves from live state. Read for `requiresVictorTags` / `blockedByVictorTags`. Empty
   *  when unknown (e.g. no surviving foe), which simply excludes any victor-gated outcome. */
  victorTags: string[];
  /** HOW the bad end was reached (for example `"combat-defeat"`). Read for `requiresCause`. */
  cause: string;
  /** WHERE it happened (the encounter's location id), for a future `requiresLocation` gate. Optional. */
  locationId?: string;
}

/** Is `outcome` eligible under the authored gates? */
function eligible(outcome: DefeatOutcome, gate: DefeatGateContext): boolean {
  // World-flag gates: any blocking flag truthy excludes; any required flag falsy excludes.
  if (outcome.blockedByFlags?.some((k) => Boolean(gate.flags[k]))) return false;
  if (outcome.requiredFlags?.some((k) => !gate.flags[k])) return false;
  // Scenario gates: any required victor/cause match is sufficient; any blocked victor excludes.
  if (outcome.requiresVictorTags && !outcome.requiresVictorTags.some((t) => gate.victorTags.includes(t)))
    return false;
  if (outcome.blockedByVictorTags?.some((t) => gate.victorTags.includes(t))) return false;
  if (outcome.requiresCause && !outcome.requiresCause.includes(gate.cause)) return false;
  // A non-positive weight is never selectable (a disabled/authoring-error row).
  return outcome.weight > 0;
}

/**
 * Filter `outcomes` by the gates, then pick ONE by seeded weight (a single `rng()` call, scanned
 * against the cumulative weight of the survivors). Returns `null` when nothing is eligible — the
 * caller then uses its existing fallback (the 1-HP revival). Pure + deterministic.
 */
export function selectDefeatOutcome(
  outcomes: DefeatOutcome[],
  gate: DefeatGateContext,
  rng: () => number,
): DefeatOutcome | null {
  const pool = outcomes.filter((o) => eligible(o, gate));
  if (pool.length === 0) return null;
  const total = pool.reduce((sum, o) => sum + o.weight, 0);
  if (total <= 0) return null;
  // One draw, cumulative-weight scan. `rng()` ∈ [0,1); scale to the total weight.
  let roll = rng() * total;
  for (const outcome of pool) {
    roll -= outcome.weight;
    if (roll < 0) return outcome;
  }
  // Floating-point guard: `roll` can land on `total` exactly — fall to the last survivor.
  return pool[pool.length - 1] ?? null;
}

/** The mutation seam the transaction drives — the caller supplies the single writer (the tick context). */
export interface DefeatOutcomeIo {
  /** Validate a command against a CLONE of the model: mutates nothing, returns `rejected` if it would
   *  not apply (`TickContext.dryRun`). */
  dryRun: (cmd: Command) => CommandResult;
  /** Apply a command now through the single writer, emitting its deltas (`TickContext.apply`). */
  apply: (cmd: Command) => CommandResult;
}

/**
 * The bad-end TRANSACTION: select a gate-eligible outcome by seeded weight, PREFLIGHT every effect on a
 * clone (`dryRun`), and only if they ALL would apply, apply them for real and return the outcome. This
 * is what makes an outcome atomic — a malformed or inapplicable effect (an unknown `type`, a move to a
 * missing room) drops the WHOLE outcome before anything mutates, and the next-eligible outcome is tried;
 * when none survive it returns `null` and the caller keeps its fallback (the 1-HP revival / neutral
 * release). Preflight is per-effect on the pre-apply state, so effects must be independent absolute
 * post-state commands (the defeat vocabulary — flags/coins/clock/move — is); a dependent pair fails
 * closed (safe). Determinism holds: a rejected pick consumes an rng draw, then re-picks from the rest.
 */
export function resolveDefeatOutcome(
  outcomes: DefeatOutcome[],
  gate: DefeatGateContext,
  rng: () => number,
  io: DefeatOutcomeIo,
): DefeatOutcome | null {
  let pool = outcomes;
  while (pool.length > 0) {
    const chosen = selectDefeatOutcome(pool, gate, rng);
    if (!chosen) return null;
    const preflightClean = chosen.effects.every((effect) => !io.dryRun(effect).rejected);
    if (preflightClean) {
      for (const effect of chosen.effects) io.apply(effect);
      return chosen;
    }
    // Authoring-error path (best effort): drop this outcome and re-pick from what remains.
    pool = pool.filter((o) => o !== chosen);
  }
  return null;
}
