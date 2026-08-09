/**
 * Transcript export — render the game event log to Markdown, or bundle to JSON.
 *
 * Pure functions; the viewer supplies a name resolver (from the persisted playset) so
 * actor ids become readable names.
 *
 * @author Runkai Zhang
 */
import type { GameEvent } from "../events/types.ts";

export interface ExportOptions {
  title?: string;
  /** Resolve an actor id (e.g. "npc.lyra") to a display name. */
  nameOf?: (id: string) => string;
}

/** Render the narrative transcript (system noise omitted) as Markdown. */
export function transcriptToMarkdown(events: GameEvent[], opts: ExportOptions = {}): string {
  const name = opts.nameOf ?? ((id: string) => id);
  const out: string[] = [`# ${opts.title ?? "Seed transcript"}`, ""];

  for (const e of events) {
    switch (e.kind) {
      case "narration":
        out.push(e.text, "");
        break;
      case "dialogue":
        out.push(`**${name(e.actorId)}${e.toId ? ` (to ${name(e.toId)})` : ""}:** ${e.text}`, "");
        break;
      case "diceRolled": {
        const verdict = e.success === undefined ? "" : e.success ? " — success" : " — failure";
        out.push(`> 🎲 ${e.purpose ?? e.notation}: rolled ${e.total}${verdict}`, "");
        break;
      }
      case "stateChanged":
        out.push(`*${e.summary}*`, "");
        break;
      default:
        break; // system / npcProposal / delta: not narrative
    }
  }
  return out.join("\n");
}

export interface TranscriptBundle {
  campaignId: string;
  characterId?: string;
  exportedAt: number;
  events: GameEvent[];
  state?: unknown;
  /** Every logged LLM call — role, model, request messages, response text, reasoning/thinking,
   *  token counts, latency. The agent/model layer the prose transcript alone can't show. */
  llm?: unknown[];
  /** Per-turn traces: classifier kind/target/confidence, NPC beats, dropped actions, model calls. */
  traces?: unknown[];
  /** id → display name, so the bundle is self-describing. */
  names?: Record<string, string>;
}

/** A self-contained JSON bundle of a play session — prose events, full state, and (when supplied)
 *  the model-call log + per-turn traces + name map, so an export is a complete debugging artifact. */
export function transcriptToJson(bundle: TranscriptBundle): string {
  return JSON.stringify(bundle, null, 2);
}
