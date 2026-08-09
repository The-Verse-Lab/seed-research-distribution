/**
 * Automated playtest harness — the optional prose judge (Concordia transfer #5).
 *
 * The rubric's deterministic scorers own every failure class with a mechanical signature; the judge
 * exists ONLY for the question traces cannot answer — was the fiction any good? It scores five
 * dramatist dimensions 0–3 over the run transcript and names the single worst moment. One utility
 * call per ~30-turn chunk, merged by mean. Never run in CI; `--judge` on a live run only.
 *
 * @author Runkai Zhang
 */
import type { LlmGateway } from "../../src/llm/gateway.ts";
import { extractJson } from "../../src/worldsmith/reconcile.ts";
import { renderTurnForDriver } from "./driver.ts";
import type { JudgeReport, RecordedRun } from "./types.ts";

export const JUDGE_DIMENSIONS = ["grounded", "agency", "consequence", "pacing", "voice"] as const;

const JUDGE_SYSTEM = [
  "You are scoring a transcript of a text-RPG playtest session. You are an analyst, not a player.",
  "This is mature fantasy fiction; violence and difficult themes are normal for the genre — score craft, never content.",
  "Score each dimension 0-3 (0 = broken, 3 = excellent):",
  "- grounded: prose only asserts people/objects/prices the game state could back; nothing appears or vanishes by narration alone.",
  "- agency: the player's stated intent is what gets resolved; no railroading, no substituted actions.",
  "- consequence: choices visibly change state (coins, wounds, standing, position) rather than dissolving into texture.",
  "- pacing: scenes advance; no stalls, no repeated beats, no fight or conversation that cannot end.",
  "- voice: NPCs stay in character and distinct; the narrator keeps tone without engine dialect leaking.",
  "Return ONLY JSON: {\"scores\":{\"grounded\":n,\"agency\":n,\"consequence\":n,\"pacing\":n,\"voice\":n},\"notes\":[\"...\"],\"worstMoment\":\"...\"}",
  "notes: at most 3, each one concrete observation with a turn number. worstMoment: the single worst beat, one sentence, with its turn number.",
].join("\n");

/** Chunk the transcript so a long run never overflows one request. */
function transcriptChunks(run: RecordedRun, turnsPerChunk = 30): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < run.turns.length; i += turnsPerChunk) {
    chunks.push(
      run.turns
        .slice(i, i + turnsPerChunk)
        .map((t) => `[t${t.turn}]\n${renderTurnForDriver(t)}`)
        .join("\n\n"),
    );
  }
  return chunks;
}

export async function judgeRun(gateway: LlmGateway, run: RecordedRun): Promise<JudgeReport | undefined> {
  const chunks = transcriptChunks(run);
  if (chunks.length === 0) return undefined;
  const partials: JudgeReport[] = [];
  for (const chunk of chunks) {
    try {
      const res = await gateway.complete("utility", {
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: `GOAL OF THE RUN: ${run.scenario.goal}\n\nTRANSCRIPT:\n${chunk}\n\nJSON only.` },
        ],
        temperature: 0,
        json: true,
        maxTokens: 700,
      });
      const parsed = JSON.parse(extractJson(res.text)) as Partial<JudgeReport>;
      const scores: Record<string, number> = {};
      for (const dim of JUDGE_DIMENSIONS) {
        const v = parsed.scores?.[dim];
        if (typeof v === "number" && v >= 0 && v <= 3) scores[dim] = v;
      }
      if (Object.keys(scores).length === 0) continue;
      partials.push({
        scores,
        notes: Array.isArray(parsed.notes) ? parsed.notes.filter((n): n is string => typeof n === "string").slice(0, 3) : [],
        ...(typeof parsed.worstMoment === "string" ? { worstMoment: parsed.worstMoment } : {}),
      });
    } catch {
      // judge is best-effort; a failed chunk contributes nothing
    }
  }
  if (partials.length === 0) return undefined;
  const scores: Record<string, number> = {};
  for (const dim of JUDGE_DIMENSIONS) {
    const vals = partials.map((p) => p.scores[dim]).filter((v): v is number => typeof v === "number");
    if (vals.length > 0) scores[dim] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  }
  return {
    scores,
    notes: partials.flatMap((p) => p.notes),
    ...(partials.find((p) => p.worstMoment)?.worstMoment !== undefined
      ? { worstMoment: partials.find((p) => p.worstMoment)!.worstMoment }
      : {}),
  };
}
