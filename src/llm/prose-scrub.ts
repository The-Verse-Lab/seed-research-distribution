/**
 * Prose-artifact scrub — purely MECHANICAL output hygiene for narrator/NPC prose.
 *
 * Two artifact classes observed live (r3 P4): a leaked brief header ("# NOW The silence
 * outside…" — the model echoing the prompt's markdown scaffolding as its opening), and a stray
 * CJK glitch token mid-Latin-prose ("a sound like breaking石灰岩" — model tokenizer noise).
 *
 * Never content-conditional: this strips prompt scaffolding and glitch
 * glyph runs by SHAPE only. A leaked header is `#`s + an ALL-CAPS scaffolding word run at the
 * very start — only the MARKER is stripped, so prose the model wrote after it on the same line
 * survives, and a model-authored mixed-case markdown title is left alone. CJK runs are removed
 * only when they are a small minority of an otherwise-Latin text — a hypothetical majority-CJK
 * world's prose passes through untouched. A `#` mid-sentence is never touched.
 *
 * @author Runkai Zhang
 */
import { escapeRegExp } from "../util/text.ts";

// "# NOW", "## THE RECORD", "# KNOWN WHEREABOUTS:" — marker + all-caps run, ending at a colon, at
// the boundary before any following word, or at end-of-line.
//
// The boundary used to be `\s+(?=[A-Z][a-z])` — Sentence-case prose ONLY — which let two shapes
// the regex audit reproduced through untouched: `# NOW the silence outside is absolute.` and
// `## THE RECORD you already have stands.` (a lower-case continuation of the header's own
// sentence, which is what a model that echoes scaffolding mid-thought actually writes). Both
// reached the player with the literal marker on the front. Widening to `[A-Za-z]` is safe because
// the ALL-CAPS run before it is already doing the discrimination: a model-authored mixed-case
// markdown title ("# The Vault of Ashes") never matches `[A-Z][A-Z' ]{1,30}` in the first place
// (its second character is lower-case), and only the `#`s + that ALL-CAPS run are ever removed —
// whatever the model wrote after them always survives.
const LEADING_HEADER_RE = /^\s{0,3}#{1,6}\s+[A-Z][A-Z' ]{1,30}(?::\s*|\s+(?=[A-Za-z])|[ \t]*(?:\n|$))/;
const CJK_RUN_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/gu;

/** Fraction of CJK characters above which the text is treated as genuinely CJK-language prose. */
const CJK_MAJORITY_FRACTION = 0.1;

// The brief's # LOCATION grounding labels, exactly as src/agents/context.ts renders them. A
// narrator that regurgitates its own grounding block mid-prose (r4 P3: "--- You carry: … Exits:
// … ---" inside a flight scene, listing exits that contradicted state) is detected by SHAPE:
// a run of lines (or one ---fenced span) carrying at least BRIEF_BLOCK_MIN_LABELS of these
// labels. One label alone is never touched — a letter that reads "Time: dusk" is legitimate prose.
const BRIEF_LINE_LABELS = [
  "You carry:",
  "Exits:",
  "Wielding/worn:",
  "Party:",
  "Time:",
  "Location:",
  "Ambience:",
  "Present:",
];
const BRIEF_BLOCK_MIN_LABELS = 2;

/** True when the line starts with a brief grounding label (after optional leading ---/spaces). */
function briefLabelLine(line: string): boolean {
  const bare = line.replace(/^[-\s]+/, "");
  return BRIEF_LINE_LABELS.some((label) => bare.startsWith(label));
}

/**
 * Strip a regurgitated grounding block: an inline `--- … ---` span carrying ≥2 brief labels, or a
 * run of consecutive label lines (with any `---` fence lines glued to it). Shape-only — never
 * content-conditional (the file's pillar); plain prose never pairs a fence with two labels.
 */
function stripBriefBlocks(text: string): string {
  // Inline form: fence + ≥2 labels inside one physical line-span — cut the fenced span only.
  let out = text.replace(/---[^\n]*?---/g, (span) => {
    const labelCount = BRIEF_LINE_LABELS.filter((label) => span.includes(label)).length;
    return labelCount >= BRIEF_BLOCK_MIN_LABELS ? " " : span;
  });
  // Line-run form: consecutive label/fence lines with ≥2 labels drop as one block.
  const lines = out.split("\n");
  const keep: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (briefLabelLine(lines[i]!) || /^\s*---+\s*$/.test(lines[i]!)) {
      let j = i;
      let labels = 0;
      while (j < lines.length && (briefLabelLine(lines[j]!) || /^\s*---+\s*$/.test(lines[j]!))) {
        if (briefLabelLine(lines[j]!)) labels += 1;
        j += 1;
      }
      if (labels >= BRIEF_BLOCK_MIN_LABELS) {
        i = j;
        continue;
      }
    }
    keep.push(lines[i]!);
    i += 1;
  }
  out = keep.join("\n");
  return out === text ? text : out.replace(/[^\S\n]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Strip a verbatim re-print of the PLAYER'S OWN typed line from narrator prose (r7 P2: the input
 * re-appeared inside the GM paragraph wrapped in doubled quotes, on both combat-start turns —
 * doubling the reading load at the most important moments; the YOU block above already shows it).
 * Shape-only: an exact (whitespace-insensitive) copy of the player's line, 24+ chars, is removed
 * together with any quote marks hugging it; shorter fragments and paraphrases are never touched.
 */
export function scrubPlayerEcho(text: string, playerLine: string): string {
  const line = playerLine.trim();
  if (line.length < 24) return text;
  // QUOTE-WRAPPED copies only — the live defect re-printed the input inside doubled quote marks.
  // An unquoted retelling stays: the deterministic test narrator (and honest prose) may weave the
  // player's action in its own voice, and that is not the artifact.
  const tokens = line.split(/\s+/).map(escapeRegExp);
  const re = new RegExp(`[«“”"']{1,3}\\s*${tokens.join("\\s+")}\\s*[»“”"']{1,3}`, "g");
  const out = text.replace(re, " ");
  if (out === text) return text;
  return out
    .replace(/["“”]{2,}/g, '"')
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
}

export function scrubProseArtifacts(text: string): string {
  let out = text;
  // Leaked brief headers: strip LEADING scaffolding markers only (stacked ones too — a model
  // that echoes "# NOW" sometimes echoes the next header with it).
  for (let i = 0; i < 4 && LEADING_HEADER_RE.test(out); i++) {
    out = out.replace(LEADING_HEADER_RE, "").trimStart();
  }
  // Regurgitated grounding blocks (r4 P3): "--- You carry: … Exits: … ---" mid-prose.
  out = stripBriefBlocks(out);
  // Engine dialect (r6 P3): the narrator reading the plumbing aloud ("the two authorized exits
  // are behind you"). A tiny fixed phrase table — shape-safe, never content-conditional.
  // `authori[sz]ed` because the shipped pattern was US-spelling-only and a model writing British
  // English says "the two authorised exits are behind you" — reproduced, passed through verbatim.
  out = out
    .replace(/\bauthori[sz]ed exits\b/gi, (m) => (m[0] === "A" ? "Ways out" : "ways out"))
    .replace(/\bauthori[sz]ed exit\b/gi, (m) => (m[0] === "A" ? "Way out" : "way out"));
  // Glitch glyph runs: remove CJK runs only when they are a small minority of the text.
  const cjkChars = [...out.matchAll(CJK_RUN_RE)].reduce((sum, m) => sum + m[0].length, 0);
  if (cjkChars > 0 && out.length > 0 && cjkChars / out.length < CJK_MAJORITY_FRACTION) {
    out = out.replace(CJK_RUN_RE, "").replace(/[^\S\n]{2,}/g, " ");
  }
  return out;
}
