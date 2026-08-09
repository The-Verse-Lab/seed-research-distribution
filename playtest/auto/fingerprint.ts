/**
 * Automated playtest loop — stable finding identity across rounds.
 *
 * The whole loop (sweep → triage → fix → sweep) turns on one question the report format cannot
 * answer on its own: *is this the same bug coming back?* Turn numbers move, prose excerpts move,
 * the live model moves — so a report-to-report diff over `summary` reads every round as a fresh
 * page of findings, which is exactly the treadmill the loop exists to end.
 *
 * A fingerprint is `scenario::class::key`: the scenario it reproduces in, the failure class, and
 * the within-class discriminator the scorer named (`Finding.key` — an auditor kind, a grounding
 * reason, the classifier kind that relocated the party). Reports recorded before `key` existed
 * fall back to a normalized summary: quoted spans, digits and ids collapsed, so "party moved
 * loc.a → loc.b on a dialogueToNpc turn" and the same thing two locations over agree.
 *
 * Deliberately COARSE. Two distinct free-prose payments in one scenario share a fingerprint, and
 * that is the point — the ledger tracks a *failure mode under a scenario*, not an incident. A
 * fingerprint that split per incident would never be seen twice and could never be called fixed.
 *
 * @author Runkai Zhang
 */
import type { Finding } from "./types.ts";

/** Quoted spans, numbers, and dotted ids carry the incident, not the failure mode — collapse them. */
export function normalizeKey(text: string): string {
  return text
    .replace(/[“"'‘’”][^“"'‘’”]*[“"'‘’”]/g, "§") // quoted excerpts: the model's words, not the bug's
    .replace(/\b[a-z]+\.[a-z0-9_.-]+\b/gi, "§") // entity ids (loc.a, pc.you, npc.oda)
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 90);
}

/**
 * The stable identity of a finding, scoped to the scenario it reproduces in.
 *
 * Scenario-scoped on purpose: the same auditor finding in a cargo scenario and a route scenario
 * can come from different code paths (a custody receipt vs a movement beat eating the line),
 * and a fix landing in one should not silently mark the other closed.
 */
export function fingerprint(scenarioId: string, finding: Finding): string {
  const key = finding.key?.trim() || normalizeKey(finding.summary);
  return `${scenarioId}::${finding.class}::${key}`;
}

/** Human-facing short label for a fingerprint (drops the scenario, which the report already says). */
export function labelOf(fp: string): string {
  const parts = fp.split("::");
  return parts.slice(1).join("/");
}

/** Group a scenario's findings by fingerprint, keeping the first as the exemplar. */
export function groupByFingerprint(
  scenarioId: string,
  findings: Finding[],
): Map<string, { count: number; exemplar: Finding; turns: number[] }> {
  const out = new Map<string, { count: number; exemplar: Finding; turns: number[] }>();
  for (const f of findings) {
    const fp = fingerprint(scenarioId, f);
    const prev = out.get(fp);
    if (prev) {
      prev.count += 1;
      prev.turns.push(f.turn);
      // Prefer a confirmed exemplar over a review one — the fix agent should read the strong case.
      if (prev.exemplar.confidence === "review" && f.confidence === "confirmed") prev.exemplar = f;
    } else {
      out.set(fp, { count: 1, exemplar: f, turns: [f.turn] });
    }
  }
  return out;
}
