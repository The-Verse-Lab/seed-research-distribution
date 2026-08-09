/**
 * OfflineGateway — the deterministic, network-free TEST gateway.
 *
 * TEST INFRASTRUCTURE ONLY. The product has no offline mode (owner decision, 2026-07-04:
 * an unreachable endpoint is an error surfaced to the player, never silently-templated
 * play). This gateway survives so the engine's unit suite runs hermetic and byte-stable:
 * the narrator role echoes the trigger (and restates any resolved verdict) and embeddings
 * hash deterministically.
 *
 * The four DERIVED-MEMORY prompts (campaign summary, NPC gist, NPC history fold, party
 * enrichment) are answered with the EMPTY STRING. Until 2026-07-28 the product recognised
 * this gateway instead, by `res.model.startsWith("offline")` — a test-only concept living in
 * `src/`, which silently switched all three features off for any self-hoster whose model tag
 * began "offline" (regex audit §10a). The signal now runs the right way round: the stub
 * declares it has nothing to say, and the product's existing empty-reply floor takes over.
 *
 * @author Runkai Zhang
 */
import type { LlmGateway } from "../../src/llm/gateway.ts";
import type {
  ChatMessage,
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  LlmRole,
} from "../../src/llm/types.ts";
import { BRIEF_MARKERS } from "../../src/util/markers.ts";
import { chunkWords } from "../../src/util/text.ts";
import { SUMMARY_SYSTEM_PROMPT } from "../../src/memory/summary.ts";
import { FOLD_SYSTEM_PROMPT, GIST_SYSTEM_PROMPT } from "../../src/memory/npc-history.ts";
import { ENRICH_SYSTEM_PROMPT } from "../../src/modules/party/enrich.ts";

/** The derived-memory system prompts this stub answers with nothing (see the file header). */
const SILENT_SYSTEM_PROMPTS: readonly string[] = [
  SUMMARY_SYSTEM_PROMPT,
  GIST_SYSTEM_PROMPT,
  FOLD_SYSTEM_PROMPT,
  ENRICH_SYSTEM_PROMPT,
];

export class OfflineGateway implements LlmGateway {
  complete(role: LlmRole, req: CompletionRequest): Promise<CompletionResult> {
    // Matched on the EXACT exported prompt constant, not a substring of player-reachable text, so
    // nothing a player types can silence a role.
    if (req.messages.some((m) => m.role === "system" && SILENT_SYSTEM_PROMPTS.includes(m.content))) {
      return Promise.resolve({ text: "", model: `offline-${role}` });
    }
    // Only `utility` gets the structured stub; `creative` answers EXACTLY like `narrator`
    // (same deterministic prose for the same request), so worldsmith/builders/enrichment
    // stay byte-deterministic offline regardless of which prose role they request.
    const text = role === "utility" ? offlineUtility() : offlineNarration(req.messages);
    return Promise.resolve({ text, model: `offline-${role}` });
  }

  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const { text } = await this.complete(role, req);
    for (const token of chunkWords(text)) yield { delta: token, done: false };
    yield { delta: "", done: true };
  }

  embed(_role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return Promise.resolve({ vectors: texts.map(hashToVec), model: "offline-embed" });
  }
}

// --- deterministic helpers (exported for direct unit tests) ----------------

function lastUserContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return m.content;
  }
  return "";
}

/** Text under a `# HEADER` line, up to the next heading / fence / end. */
function section(text: string, header: string): string {
  const idx = text.indexOf(header);
  if (idx === -1) return "";
  const after = text.slice(idx + header.length);
  const stop = after.search(/\n(?:===|# )/);
  return (stop === -1 ? after : after.slice(0, stop)).trim();
}

export function offlineNarration(messages: ChatMessage[]): string {
  const content = lastUserContent(messages);

  // Companion reply — keyed on the engine-controlled header, not a player-injectable
  // phrase, so a player typing 'he says to you: "..."' can't trigger the reply stub.
  if (content.includes(BRIEF_MARKERS.directAddress)) {
    return `I hear you. (Offline reply — set an LLM endpoint for live companion dialogue.)`;
  }

  if (content.includes(BRIEF_MARKERS.autonomousBeat)) {
    const directive = content.match(/Mechanics directive:\s*([\s\S]*?)\s+Phrase this action in character;/);
    if (directive?.[1]?.trim()) {
      return `${directive[1].trim()} (Offline autonomous line — set an LLM endpoint for richer NPC intent.)`;
    }
  }

  const now = section(content, BRIEF_MARKERS.now) || "Something stirs in the dark.";
  // Only restate a verdict from THIS turn's authoritative resolved block (matched on the
  // exact engine header) — not a roll in the RECENT transcript or player-supplied text.
  const resolvedIdx = content.indexOf("=== RESOLVED MECHANICS");
  const resolved = resolvedIdx >= 0 ? content.slice(resolvedIdx) : "";
  const verdict = /\bSUCCESS\b/.test(resolved)
    ? " The attempt succeeds."
    : /\bFAILURE\b/.test(resolved)
      ? " The attempt fails."
      : "";
  return `${now}${verdict} The scene holds, waiting on what you do next. (Offline narrator — set an LLM endpoint for richer prose.)`;
}

export function offlineUtility(): string {
  // Keeps OfflineGateway a total LlmGateway (the guard judge and the LLM classifier may
  // hit the utility role in specs); the stub is a safe freeform plan.
  return JSON.stringify({
    kind: "freeformNarrative",
    targetId: null,
    destinationLocationId: null,
    check: { warranted: false, ability: null, skill: null, dc: null, reason: "" },
    confidence: 0.2,
  });
}

/** Fixed 8-dim deterministic pseudo-embedding. Unblocks M4 wiring; not semantic. */
export function hashToVec(text: string): number[] {
  const v = new Array<number>(8).fill(0);
  for (let i = 0; i < text.length; i++) {
    const bucket = i % 8;
    v[bucket] = ((v[bucket] ?? 0) + text.charCodeAt(i)) % 997;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
