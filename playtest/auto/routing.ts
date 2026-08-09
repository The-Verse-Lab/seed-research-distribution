/**
 * Automated playtest loop — fix-stage model routing.
 *
 * A round is not a fixed amount of work. Two confirmed auditor findings in one scenario is a
 * mechanical close; a REGRESSED finding whose last two fixes both missed is a diagnosis problem
 * that a cheap pass will get wrong a third time and then commit. Flat-rating the fixer either
 * overpays for the easy rounds or underpowers the hard ones — and the hard ones are exactly where
 * a wrong patch costs a whole extra sweep to discover.
 *
 * So the tier is derived from the triage the loop already computed. The signals are the ledger's,
 * not a guess: how many findings, how confirmed, how many scenarios and classes they span, and —
 * the one that dominates — how many times someone already tried and failed to fix them.
 *
 * NOT part of the measurement surface (`ledger.ts`'s MEASUREMENT_FILES). Changing how hard the
 * fixer thinks cannot change what counts as a finding, so a routing change must not invalidate a
 * FIXED verdict.
 *
 * This routes the FIX stage only — a Claude Code subprocess. The sweep's PC-driver and the prose
 * judge run on the game endpoint in `.env` (the narrator/utility roles), and are untouched by any
 * of this.
 *
 * @author Runkai Zhang
 */
import type { TriageItem } from "./ledger.ts";

export type FixModel = "claude-sonnet-5" | "claude-opus-5" | "claude-fable-5";
export type FixEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface FixTier {
  model: FixModel;
  effort: FixEffort;
  /**
   * Whether to hand the fixer the `ultracode` opt-in — multi-agent workflows, adversarial
   * verification of each diagnosis before it commits. Expensive, and only worth it where a single
   * pass has ALREADY been shown to be wrong.
   */
  ultracode: boolean;
  /** One line, printed by the loop and stored in the round's triage JSON. */
  reason: string;
}

/** Named so the thresholds argue for themselves at the call site. */
const MECHANICAL_MAX_ITEMS = 2;
const BROAD_ROUND_ITEMS = 8;
const BROAD_ROUND_CLASSES = 3;
const DIAGNOSIS_STUCK_ATTEMPTS = 2;
const DIAGNOSIS_DESPERATE_ATTEMPTS = 3;

/**
 * Pick the tier for one round's actionable set.
 *
 * Escalation ladder, most-significant first:
 *
 *  - **Desperate** (some finding has survived 3+ fix attempts): Fable 5 at `max`, with ultracode.
 *    Three wrong diagnoses is not a thinking-budget problem any more — it wants independent
 *    attempts that can disagree with each other.
 *  - **Stuck** (a REGRESSED finding, or one with 2+ prior attempts): Fable 5 at `xhigh`, ultracode.
 *    The cheap read of the trace has already been tried and was wrong.
 *  - **Broad** (many findings across many classes): Fable 5 at `xhigh`, no ultracode. Volume, not
 *    subtlety — one strong pass with room to hold the whole round.
 *  - **Mechanical** (≤2 findings, all confirmed, all new, one scenario, nobody has tried yet):
 *    Sonnet 5 at `medium`. Confirmed signatures point at their own cause.
 *  - **Default**: Opus 5 at `high`.
 */
export function routeFixTier(actionable: TriageItem[]): FixTier {
  if (actionable.length === 0) {
    return { model: "claude-sonnet-5", effort: "low", ultracode: false, reason: "nothing actionable" };
  }

  const attempts = Math.max(...actionable.map((i) => i.entry.fixAttempts.length));
  const regressed = actionable.filter((i) => i.verdict === "regressed").length;
  const classes = new Set(actionable.map((i) => i.entry.class)).size;
  const scenarios = new Set(actionable.map((i) => i.entry.scenarioId)).size;
  const allConfirmed = actionable.every((i) => i.entry.confidence === "confirmed");
  const allNew = actionable.every((i) => i.verdict === "new");

  if (attempts >= DIAGNOSIS_DESPERATE_ATTEMPTS) {
    return {
      model: "claude-fable-5",
      effort: "max",
      ultracode: true,
      reason: `a finding has survived ${attempts} fix attempts — three wrong diagnoses wants independent attempts, not a bigger budget`,
    };
  }

  if (regressed > 0 || attempts >= DIAGNOSIS_STUCK_ATTEMPTS) {
    return {
      model: "claude-fable-5",
      effort: "xhigh",
      ultracode: true,
      reason:
        regressed > 0
          ? `${regressed} regressed finding(s) — a fix that worked was undone; find what, do not re-patch`
          : `${attempts} prior fix attempts missed — the cheap read of the trace is already known wrong`,
    };
  }

  if (actionable.length >= BROAD_ROUND_ITEMS && classes >= BROAD_ROUND_CLASSES) {
    return {
      model: "claude-fable-5",
      effort: "xhigh",
      ultracode: false,
      reason: `${actionable.length} findings across ${classes} classes — volume, not subtlety`,
    };
  }

  if (actionable.length <= MECHANICAL_MAX_ITEMS && allConfirmed && allNew && scenarios === 1 && attempts === 0) {
    return {
      model: "claude-sonnet-5",
      effort: "medium",
      ultracode: false,
      reason: `${actionable.length} new confirmed finding(s) in one scenario — mechanical close`,
    };
  }

  return {
    model: "claude-opus-5",
    effort: "high",
    ultracode: false,
    reason: `${actionable.length} finding(s), ${classes} class(es), ${scenarios} scenario(s) — ordinary round`,
  };
}

/** Explicit `--tier` override from the CLI: pin the family, keep the derived effort/ultracode. */
export function pinModel(tier: FixTier, family: "sonnet" | "opus" | "fable"): FixTier {
  const model = ({ sonnet: "claude-sonnet-5", opus: "claude-opus-5", fable: "claude-fable-5" } as const)[family];
  return { ...tier, model, reason: `${tier.reason} (model pinned to ${family})` };
}
