/**
 * Reasoning-tag filtering for "thinking" models.
 *
 * Some models stream their chain-of-thought INLINE as <think>…</think> or
 * <thinking>…</thinking> inside the normal content channel (rather than a separate
 * reasoning_content field). This strips those tags out of the visible text and surfaces
 * the thinking separately, so it never leaks into narration but can still drive a
 * "thinking…" indicator. The streaming filter is robust to tags split across chunks.
 *
 * @author Runkai Zhang
 */
const OPEN_TAGS = ["<thinking>", "<think>"] as const;
const CLOSE_TAGS = ["</thinking>", "</think>"] as const;
const MAX_TAG_LEN = Math.max(...[...OPEN_TAGS, ...CLOSE_TAGS].map((t) => t.length));

export interface FilterOutput {
  /** Visible content, with reasoning tags removed. */
  content: string;
  /** Extracted reasoning/thinking text. */
  reasoning: string;
}

interface TagHit {
  index: number;
  length: number;
}

/** Earliest occurrence of any tag in buf, or null. */
function earliestTag(buf: string, tags: readonly string[]): TagHit | null {
  let best: TagHit | null = null;
  for (const t of tags) {
    const i = buf.indexOf(t);
    if (i !== -1 && (best === null || i < best.index)) best = { index: i, length: t.length };
  }
  return best;
}

/** Length of buf safe to emit now, holding back a trailing run that could be a partial tag. */
function safeEmitLen(buf: string, tags: readonly string[]): number {
  const maxHold = Math.min(buf.length, MAX_TAG_LEN - 1);
  for (let k = maxHold; k >= 1; k--) {
    const suffix = buf.slice(buf.length - k);
    if (tags.some((t) => t.startsWith(suffix))) return buf.length - k;
  }
  return buf.length;
}

/**
 * Stateful streaming filter. Feed deltas through push(); call flush() once the stream
 * ends to drain any held-back tail.
 */
export class ThinkingFilter {
  private buf = "";
  private inThink = false;

  push(delta: string): FilterOutput {
    this.buf += delta;
    let content = "";
    let reasoning = "";

    for (;;) {
      if (!this.inThink) {
        const hit = earliestTag(this.buf, OPEN_TAGS);
        if (hit) {
          content += this.buf.slice(0, hit.index);
          this.buf = this.buf.slice(hit.index + hit.length);
          this.inThink = true;
          continue;
        }
        const safe = safeEmitLen(this.buf, OPEN_TAGS);
        content += this.buf.slice(0, safe);
        this.buf = this.buf.slice(safe);
        break;
      } else {
        const hit = earliestTag(this.buf, CLOSE_TAGS);
        if (hit) {
          reasoning += this.buf.slice(0, hit.index);
          this.buf = this.buf.slice(hit.index + hit.length);
          this.inThink = false;
          continue;
        }
        const safe = safeEmitLen(this.buf, CLOSE_TAGS);
        reasoning += this.buf.slice(0, safe);
        this.buf = this.buf.slice(safe);
        break;
      }
    }

    return { content, reasoning };
  }

  flush(): FilterOutput {
    // Whatever remains: reasoning if we were mid-think (e.g. truncated), else content.
    const out: FilterOutput = this.inThink
      ? { content: "", reasoning: this.buf }
      : { content: this.buf, reasoning: "" };
    this.buf = "";
    return out;
  }
}

/** One-shot strip for a complete (non-streamed) response. */
export function stripThinking(text: string): FilterOutput {
  const f = new ThinkingFilter();
  const a = f.push(text);
  const b = f.flush();
  return { content: a.content + b.content, reasoning: a.reasoning + b.reasoning };
}
