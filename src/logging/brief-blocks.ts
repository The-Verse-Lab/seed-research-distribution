/**
 * Brief composition — attribute an assembled prompt's bytes to the blocks that produced them.
 *
 * The narrator brief (`src/agents/context.ts`) is one concatenated string, and its literal headers
 * (`# WORLD`, `# LOCATION`, `# RECENT`, `# NOW`, `=== RESOLVED MECHANICS`) are a byte-stable tested
 * contract. That contract IS the block boundary, so a brief's composition can be recovered by
 * PARSING it rather than by instrumenting the assembly — read-only, zero risk to a byte-stable
 * prompt, and it works just as well on an `llm_calls` row read back weeks after the turn.
 *
 * The point is answering "what is actually in this prompt, and what is it costing me" without
 * reading 5KB of text: which block is 60% of the brief, which optional line is present this turn,
 * what the transcript window costs against the lore retrieval.
 *
 * Invariant (pinned by spec): every byte lands in exactly one block — the block sizes sum to the
 * input's byte length. Nothing is silently unattributed.
 *
 * @author Runkai Zhang
 */

/** One `Label:` line broken out inside a structural block (`Exits:`, `Present:`, `Party:` …). */
export interface BriefLabel {
  /** The label with any parenthetical qualifier stripped (`Party (these and ONLY these…)` → `Party`). */
  label: string;
  bytes: number;
}

/** One `# HEADER`-delimited section of an assembled brief. */
export interface BriefBlock {
  /**
   * The normalized header — the stable identity of the block across turns. A titled header loses
   * its title (`# LOCATION — Ashen Gate` → `# LOCATION`) and a qualified one loses its parenthetical
   * (`# CANON NAMES (already taken)` → `# CANON NAMES`), so the same block groups turn over turn.
   */
  key: string;
  /** The header line verbatim, title and all. Equals `key` for an untitled block. */
  header: string;
  /** Bytes this block contributes to the brief, header line included. */
  bytes: number;
  /** Lines this block contributes, header line included. */
  lines: number;
  /**
   * A ~4-bytes-per-token estimate. A SIZING AID for spotting which block dominates a prompt, NOT
   * the model's tokenizer — never reconcile it against a provider's reported `promptTokens`.
   */
  approxTokens: number;
  /** `Label:` lines inside the block, when the block is a structural one (see {@link LABELLED_BLOCKS}). */
  labels?: BriefLabel[];
}

/** Content before the first header (in practice: nothing — `# WORLD` opens every brief). */
export const PREAMBLE_KEY = "(preamble)";

/**
 * The blocks whose bodies are LINE-STRUCTURED rather than prose, so a `Label:` line in them is
 * genuinely a field and worth its own row.
 *
 * Deliberately a closed list. `# RECENT` is a transcript where `Lyra: "…"` is a speaker, not a
 * field; breaking labels out there would turn every line of dialogue into a spurious row. Bytes are
 * unaffected either way — an un-broken-out line still counts toward its block, so the sum invariant
 * holds regardless of what is on this list.
 */
export const LABELLED_BLOCKS: readonly string[] = ["# LOCATION", "# YOU"];

/** `# H` … `### H` — the brief's section headers. */
const HEADER_RE = /^#{1,3} \S/;
/** `=== RESOLVED MECHANICS`, `=== TURN FACTS` — the resolved-region markers. */
const RULE_RE = /^={3,}\s*\S/;
/** A field line: a capitalized label, then a colon, then a space or end of line. */
const LABEL_RE = /^([A-Z][^:\n]{0,80}):(?: |$)/;

const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * Normalize a header to its stable key: drop a closing rule (`===`), then a trailing parenthetical,
 * then an em-dash title.
 *
 * The order is load-bearing, and every step of it is a real header in the brief:
 * `=== SECRET LORE (GM eyes only — never quote verbatim) ===` needs its closing rule gone before the
 * parenthetical is at the end to be matched, and needs the parenthetical gone before the em-dash
 * split — that dash lives INSIDE the parenthetical, and splitting first would cut the key mid-phrase
 * and leave an unbalanced paren hanging off it.
 */
function normalizeHeader(header: string): string {
  const withoutRule = header.replace(/\s*=+$/, "");
  const withoutQualifier = withoutRule.replace(/\s*\([^)]*\)\s*$/, "");
  const [base] = withoutQualifier.split(" — ");
  return (base ?? withoutQualifier).trim();
}

/** Same normalization for a field label (`Party (these and ONLY these travel with you)` → `Party`). */
function normalizeLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * Split an assembled brief into its blocks, with the byte/line/approx-token cost of each.
 *
 * An empty input yields an empty list. Text before the first header is reported under
 * {@link PREAMBLE_KEY} so it can never vanish.
 */
export function briefBlocks(text: string): BriefBlock[] {
  if (!text) return [];
  const lines = text.split("\n");
  const blocks: BriefBlock[] = [];
  let current: BriefBlock | null = null;

  // `key` is passed explicitly for the preamble: it is a sentinel, not a header, and running it
  // through `normalizeHeader` would strip it to "" (its whole text is a parenthetical).
  const open = (header: string, key = normalizeHeader(header)): BriefBlock => {
    const block: BriefBlock = { key, header, bytes: 0, lines: 0, approxTokens: 0 };
    blocks.push(block);
    return block;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // n lines carry n-1 separators, so charging every line but the last for its `\n` makes the
    // block sizes sum to exactly `byteLength(text)`.
    const cost = byteLength(line) + (i < lines.length - 1 ? 1 : 0);
    const isHeader = HEADER_RE.test(line) || RULE_RE.test(line);
    if (isHeader) current = open(line.trim());
    else if (!current) current = open(PREAMBLE_KEY, PREAMBLE_KEY);

    current.bytes += cost;
    current.lines += 1;

    if (!isHeader && LABELLED_BLOCKS.includes(current.key)) {
      const label = LABEL_RE.exec(line)?.[1];
      if (label) (current.labels ??= []).push({ label: normalizeLabel(label), bytes: cost });
    }
  }

  for (const b of blocks) b.approxTokens = Math.round(b.bytes / 4);
  return blocks;
}

/** A logged chat message, as `llm_calls.request` stores it. */
interface LoggedMessage {
  role?: unknown;
  content?: unknown;
}

/**
 * Pull the assembled brief out of a logged request's messages.
 *
 * The brief is the message carrying the `# NOW` cut point — the one header every assembled brief
 * embeds. Failing that (an NPC reply prompt, a classifier call), the longest message is the closest
 * thing to a brief the call has. Returns null when the request holds no usable message at all, so
 * callers can say "not a brief" instead of rendering a breakdown of a system prompt.
 */
export function briefFromMessages(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  const texts = (messages as LoggedMessage[])
    .map((m) => (typeof m?.content === "string" ? m.content : ""))
    .filter((c) => c.length > 0);
  if (texts.length === 0) return null;
  const withNow = texts.find((c) => c.includes("# NOW"));
  if (withNow) return withNow;
  return texts.reduce((longest, c) => (c.length > longest.length ? c : longest), texts[0]!);
}
