/**
 * NPC agent — a standing character with persona, goals, memory, and relationships.
 *
 * M1 implements the REACTIVE path: when the player directly addresses a companion, the
 * engine asks for an in-character spoken reply (one dialogue event, no state mutation,
 * no chaining). Autonomous initiative — decide() driven by the heartbeat Director — stays
 * an M2 stub.
 *
 * @author Runkai Zhang
 */
import type { NpcTemplate } from "../content/schema.ts";
import type { GameState } from "../state/types.ts";
import type { LlmGateway } from "../llm/gateway.ts";
import type { ChatMessage } from "../llm/types.ts";
import type { GenerationResult, NarrateOptions } from "./dm.ts";
import { BRIEF_MARKERS } from "../util/markers.ts";
import { NPC_ACT_VERBS, parseNpcAct, type NpcAct } from "../rules/npc-act.ts";
import { MORALITIES } from "../content/presets/moralities.ts";
import { PERSONALITIES } from "../content/presets/personalities.ts";
import { resolvePreset } from "../content/presets/preset.ts";

export interface NpcDecisionContext {
  contextText: string;
  stimulus: string;
  replyDepth: number;
  /**
   * A mechanics-chosen agenda directive. When present, the NPC may phrase this action in character
   * but must not choose a different outcome; autonomy/agenda rules already picked the action.
   */
  agendaDirective?: string;
  /**
   * This NPC's recent memories (already rendered as bullets) from its per-NPC journal (M4 Part B).
   * Injected as a `# YOU REMEMBER` section BEFORE the autonomous-beat marker — grounding the
   * decision in what the NPC remembers — and omitted when empty so a memory-less NPC's prompt is
   * byte-identical to before memory existed. Pure prompt context: carries no state.
   */
  memory?: string[];
  /** Rendered Friendship profile toward the player or target, when relevant. */
  relationship?: string;
  /**
   * Derived per-person conversation history (`# OUR HISTORY` / `# RECENTLY WITH YOU`), the same
   * rendered block the reply path carries (epistemic plan §12.2: the character keeps its
   * continuity when the scene shifts from speaking to acting). Best-effort derived cache —
   * continuity color, NEVER world truth. Omit-when-empty ⇒ byte-identical decide prompts.
   */
  history?: string[];
  /**
   * This NPC's CODE-OWNED case knowledge (mystery wave), already rendered as content lines by
   * `caseBriefForNpc` — knowledge + (possibly-false) beliefs as confident fact, plus the culprit's
   * concealment directive and any distrust rail. Injected as `# THE CASE AS YOU KNOW IT` BEFORE the
   * autonomous-beat marker; omitted when the NPC has no stake so a case-less beat is byte-identical.
   * This also closes the old gap that `decide()` was lore-less. Pure prompt context; carries no state.
   */
  caseFile?: string[];
  /**
   * The CLOSED list of world acts this NPC may legally take right now, already rendered by
   * `renderActCandidates` (src/modules/autonomy/grounding.ts) — injected as `# CANDIDATE ACTIONS`
   * BEFORE the autonomous-beat marker, the same grounding placement as memory/case. It is the ONLY
   * place the ids in the intent's `act` may come from, which is what makes grounding a table lookup
   * instead of a keyword guess. Omitted when nothing is legal, so a scene with no affordances keeps
   * a byte-identical prompt. Pure prompt context: carries no state.
   */
  actCandidates?: string[];
}

export interface NpcIntent {
  text: string;
  urgency: number;
}

/**
 * The RICH structured intent an NPC emits for a PUBLIC turn (reactive `replyTurn`, autonomous
 * `decideTurn`): the words it wants said + the staging it wants to perform, plus grounding/telemetry
 * fields. The DM consumes this and renders ALL public NPC communication as staged prose — the NPC no
 * longer speaks a raw bubble of its own. NEVER used for the private whisper path (that stays verbatim
 * `reply()`), so the enrichment can't leak there.
 */
/**
 * How an NPC delivers a spoken line — a closed, model-chosen vocabulary the client maps to a visual
 * style. The NPC agent tags each line at authoring time (it knows its own intent); the DM never
 * re-decides it. Kept small and generic so any world's NPC can pick one without training.
 */
export const SPEECH_MOODS = [
  "neutral", "warm", "cold", "angry", "afraid", "sad", "playful", "urgent",
] as const;
export type SpeechMood = (typeof SPEECH_MOODS)[number];

/** One spoken line + the mood the NPC delivers it in. */
export interface SpokenLine {
  text: string;
  mood: SpeechMood;
}

/**
 * One ware the NPC's OWN words just put a price on (PROSE-TO-CODE §2.1). Self-reported alongside the
 * speech, never parsed out of it; `priceCp` is copper, so the model converts its own "five gold".
 */
export interface NpcOffer {
  name: string;
  priceCp: number;
}

/** Most offers accepted from one reply — a beat that "prices" a dozen things is not describing a beat. */
export const MAX_REPORTED_OFFERS = 3;

/** A sane upper bound on a self-reported price (10,000 gp) — anything past it is a model fumbling zeros. */
const MAX_OFFER_PRICE_CP = 1_000_000;

export interface NpcTurnIntent {
  /** The exact words the NPC wants said this beat (may be "" for a silent action). */
  visibleSpeech: string;
  /**
   * The spoken line(s) as an ORDERED, mood-tagged list — the structured form of `visibleSpeech`.
   * Present only when the model returned the structured `speech` array (a plain-string speech, or the
   * non-JSON fallback, leaves it undefined ⇒ the DM/client treat the whole line as one neutral line).
   * `visibleSpeech` is always the flattened join, so every existing consumer is untouched.
   */
  lines?: SpokenLine[];
  /** Detailed physical staging/action the NPC wants to perform (gestures, movement) — omitted if pure speech. */
  visibleAction?: string;
  /** WHY — the NPC's private motive/scheming. NEVER shown to the player, bystanders, or the public wire. */
  privateIntent?: string;
  /**
   * The CLOSED world act the NPC attempts this beat (feeds grounding); omitted when it only speaks.
   *
   * This replaced a free-text `desiredCommand` imperative that a twelve-list keyword net in
   * `src/modules/autonomy/grounding.ts` had to guess a reducer Command from — an intent classifier
   * on the delta path, and an inverted one ("I'll walk over to Emrin's Forge and hand the player
   * the sealed letter she asked for." scored 0.167 and was dropped; "Sit tight." scored 0.5 and
   * spent an `adjustEnergy`). The verb comes from a closed list and every id is copied verbatim
   * from the `# CANDIDATE ACTIONS` block of this NPC's own brief, so grounding is a table lookup.
   */
  desiredAct?: NpcAct;
  /** Entity ids/names the NPC is addressing or acting on. */
  targets?: string[];
  /** The NPC's 0..1 self-rated confidence in this beat (telemetry; never on the public wire). */
  confidence?: number;
  /** Discrete claims the NPC voices this beat — remembered as claims, never promoted to world truth. */
  factsAsserted?: string[];
  /**
   * Which `# ANSWER FACTS` handles/ids the NPC actually STATED aloud this beat (epistemic plan
   * §13.3). CLOSED list: the dialogue module grounds each token against the packet's handle map
   * and drops anything unlisted, so this can teach a co-located listener only facts the speaker
   * really held and voiced. Internal — never player-visible, never world truth by itself.
   */
  factIdsUsed?: string[];
  /** Handles/ids the NPC knew were relevant and deliberately withheld. Telemetry only. */
  factIdsWithheld?: string[];
  /**
   * Wares this beat's own words put on sale, as a STRUCTURED SELF-REPORT (PROSE-TO-CODE §2.1): an
   * NPC who prices a lantern aloud has made an offer, and the trade counter honours it
   * (`src/rules/pending-offers.ts`). Capped at {@link MAX_REPORTED_OFFERS} and parsed strictly —
   * a row missing either field is dropped. Deliberately NOT extracted from the prose: no regex
   * ever reads a model's sentence for a price.
   */
  offers?: NpcOffer[];
  /** Carried from the thin NpcIntent for the autonomy Director's arbitration. */
  urgency?: number;
  /**
   * Living relationships: how this exchange shifted the NPC's regard for the person they addressed,
   * a small signed integer the NPC's own agent proposes. Code clamps it to ±2 and caps cumulative
   * chat-earned friendship — the model phrases and proposes, code owns the gauge.
   */
  relationshipNudge?: number;
  /**
   * Minor-safety block flag: true when the guard blocked this generation. Internal ONLY — never on the
   * public wire. When set, `visibleSpeech` holds the guard's OOC refusal and callers must surface it
   * as-is (never re-narrate it in character).
   */
  blocked?: boolean;
}

/**
 * The JSON contract the model fills for a structured public turn. Kept model-friendly (short keys, an
 * explicit example) and parsed defensively — a model that ignores it and returns a plain line still
 * works (the raw line becomes `visibleSpeech`). This text is the FINAL instruction of the turn brief.
 */
/**
 * The verbs actually named on a rendered `# CANDIDATE ACTIONS` block (r13 fix — see
 * `buildIntentJsonInstruction`). Reads the same `- "verb": ...` rows `renderActCandidates`
 * (src/modules/autonomy/grounding.ts) writes; a continuation row like `  (for "give", ...)` is
 * indented past the leading `- "` and never matches, so "give" is only counted once. "none" is
 * always legal (naming nothing is always a valid choice) and is added unconditionally.
 */
export function actVerbsOffered(candidateLines: readonly string[] | undefined): string[] {
  const verbs = new Set<string>(["none"]);
  for (const line of candidateLines ?? []) {
    const m = /^- "(\w+)":/.exec(line);
    if (m?.[1]) verbs.add(m[1]);
  }
  return [...verbs];
}

/**
 * The JSON contract the model fills for a structured public turn. Kept model-friendly (short keys, an
 * explicit example) and parsed defensively — a model that ignores it and returns a plain line still
 * works (the raw line becomes `visibleSpeech`). This text is the FINAL instruction of the turn brief.
 *
 * `actVerbs` is the CLOSED set the "do" enum in the schema advertises. Before r13 this was always the
 * full static `NPC_ACT_VERBS` list, regardless of whether the actor's own `# CANDIDATE ACTIONS` block
 * offered any target for a given verb — so a companion with an empty `take_job` candidate list (not
 * party leader, nothing on offer) still saw `take_job` presented as a normal choice in the schema, and
 * would sometimes name it against an invented target, always grounding to a dropped `illegal` act
 * (playtest fixture-work t8/t18: Oda naming `take_job` for dock work he was never offered as a legal
 * candidate). Restricting the enum to what this actor can actually do closes that affordance instead
 * of relying on prose instructions the model doesn't reliably follow.
 */
function buildIntentJsonInstruction(actVerbs: readonly string[]): string {
  return [
  `Respond ONLY with a single JSON object describing your turn — no prose, no markdown fences, nothing outside it:`,
  `{`,
  `  "speech": [{ "say": "one line you speak ALOUD", "mood": "neutral" }],`,
  `  "action": "what you physically DO, in detail — gestures, movement, staging (omit if you only speak)",`,
  `  "motive": "your private reason for acting this way (never shown to anyone)",`,
  `  "act": { "do": "${actVerbs.join("|")}", "target": "<an exact id from # CANDIDATE ACTIONS>", "to": "<recipient id — \\"give\\" only>" },`,
  `  "targets": ["who you address or act on"],`,
  `  "confidence": 0.0,`,
  `  "facts": ["any concrete facts you state as true this beat"],`,
  `  "factsUsed": ["F1"],`,
  `  "offers": [{ "name": "brass lantern", "priceCp": 500 }],`,
  `  "relationship": 0`,
  `}`,
  `"speech" is an ORDERED list of the lines you say ALOUD — one object per line, in the order you speak them (use [] if you stay silent). Put ONLY spoken words in "say" — never stage directions, gestures, or actions (those go in "action"). Never describe yourself in the third person inside "say": a sentence like "<your name> stays still, watching" is narration and belongs in "action", not in your mouth. Each line's "mood" is HOW you deliver it: one of neutral, warm, cold, angry, afraid, sad, playful, urgent. You are only stating your intent — the narrator will stage and phrase the scene around your words; do not narrate yourself.`,
  `"relationship" is an integer from -2 to 2: how this exchange changed your regard for the person you spoke to. Use 0 unless they genuinely earned warmth (kindness, help, shared danger) or coldness (insult, threat, betrayal). Small kindnesses are +1; nothing they merely say earns a jump.`,
  `"factsUsed" lists the [F#] handles of the # ANSWER FACTS lines whose content you actually STATED aloud this beat — copied exactly, [] if none or if your brief carries no such block. Never write the handles into your spoken words.`,
  // §2.1: an NPC who prices a thing aloud has made a binding offer, and the counter must be able to
  // honour it. Captured as a self-report because the alternative is a regex reading model prose for
  // a number — the pattern this codebase does not use.
  `"offers" lists any goods YOUR OWN WORDS this beat put on sale with a price — [] (or omit it) unless you actually named both a thing and what it costs. "name" is the ware as you called it; "priceCp" is that price converted to COPPER pieces — 1 gold = 100 copper, 1 silver = 10 copper, so "five gold" is 500, "two silver" is 20, "eight copper" is 8. Convert; never write the number you said. At most three, and only what you are genuinely willing to sell to the person you are speaking to — the counter will hold you to the price.`,
  // The act is a CLOSED form, not an imperative sentence: the free-text `command` it replaced was
  // keyword-scored into a reducer Command, which meant a natural sentence naming three real ids
  // was dropped as banter while a two-word aside spent a delta (r8 regex audit; see
  // src/rules/npc-act.ts). The model now NAMES the act; code owns whether it is possible.
  `"act" is the ONE world action you attempt this beat. It is a CLOSED form: "do" MUST be one of the verbs listed above, and "target" MUST be copied character-for-character from an id in your brief's \`# CANDIDATE ACTIONS\` block — that block lists everything you can legally do from where you stand right now. Never invent an id, never write a sentence or a place NAME in "target", and never name a target that is not on that list: an unlisted action simply does not happen. If your brief carries no \`# CANDIDATE ACTIONS\` block, or nothing on it fits, answer { "do": "none" } and let your words carry the beat.`,
  // Location grounding (reported: Oda told the player he'd "be at the Eel's Rest" — a tavern that
  // does not exist). The NPC agent owns its OWN choices, but only inside the world that exists: it
  // may move to a REAL reachable exit, never promise to be at an invented place. (The DM may invent
  // places for scene colour — the NPC agent may not, because its words become a fact others must
  // find it by.)
  `Speak and act ONLY within places that exist: the location you are in and the destinations on your brief's \`Exits:\` line. NEVER invent a tavern, inn, house, street, or landmark that is not in your brief, and never tell anyone you will be somewhere that does not exist. If you mean to leave, name a REAL reachable destination id as the "move" target and refer to that same real place in your speech. The same holds for people: never name a person or vendor as findable who is not in your brief or your notes.`,
  ].join("\n");
}

export interface NpcReplyContext {
  /** The same assembled brief the DM gets, for shared grounding. */
  contextText: string;
  /** The player's line addressed to this NPC (verbatim). */
  playerLine: string;
  /** Display name of the speaker, for the prompt. */
  fromName: string;
  /** How this NPC currently feels toward the speaker (−100..100), for tone. */
  toward?: number;
  /**
   * Relevant lore snippets (already rendered as bullets) from read-only retrieval (M4) — the NPC's
   * own `knowledge[]` plus PUBLIC world lore, relevant to the player's line. Injected as a
   * `# RELEVANT LORE` section BEFORE `# DIRECT ADDRESS` (grounding, not the screened current line),
   * and omitted when empty. NPCs never receive secret lore (it is excluded at the index). Pure
   * prompt context: it carries no state.
   */
  lore?: string[];
  /**
   * This NPC's recent memories (already rendered as bullets) from its per-NPC journal (M4 Part B).
   * Injected as a `# YOU REMEMBER` section BEFORE `# DIRECT ADDRESS` (grounding, ahead of the
   * screened current line), and omitted when empty so a memory-less NPC's prompt is byte-identical
   * to before memory existed (the same placement contract as `lore`). Pure prompt context.
   */
  memory?: string[];
  /** Rendered Friendship profile toward the speaker, when relevant. */
  relationship?: string;
  /**
   * This NPC's derived per-person history (statefulness #2+#3) — already rendered as a block by
   * `renderHistoryBlock` (`# OUR HISTORY` + `# RECENTLY WITH YOU`), so it is spread verbatim BEFORE
   * `# DIRECT ADDRESS`. Omitted when empty (byte-identical prompt). Best-effort derived cache; carries
   * no world state (mirrors the campaign rolling summary's posture, outside the replay invariant).
   */
  history?: string[];
  /**
   * A mechanics-chosen outcome for THIS reply (e.g. "you have just agreed to join the party").
   * Mirrors decide()'s `agendaDirective` contract: the NPC may phrase the outcome in character but
   * must not change it — decisions are code's, phrasing is the model's. Omitted when absent so
   * every existing reply prompt stays byte-identical.
   */
  directive?: string;
  /**
   * Known-whereabouts facts about an asked-about scheduled NPC (already rendered as bullets) —
   * injected as `# KNOWN WHEREABOUTS` BEFORE `# DIRECT ADDRESS`, the same grounding placement as
   * lore/memory. Whether this replier knows them is decided in code (region/faction/relationship)
   * before injection; omitted when absent so every existing reply prompt stays byte-identical.
   */
  whereabouts?: string[];
  /**
   * This NPC's CODE-OWNED case knowledge (mystery wave), already rendered as content lines by
   * `caseBriefForNpc`. Injected as `# THE CASE AS YOU KNOW IT` BEFORE `# DIRECT ADDRESS`, the same
   * grounding placement as lore/whereabouts; omitted when the NPC has no stake so an ordinary reply
   * prompt stays byte-identical. See {@link NpcDecisionContext.caseFile}.
   */
  caseFile?: string[];
  /**
   * Numbers-free `# WORK ON OFFER` facts (already rendered as bullets) — the authoritative job the
   * live board carries here, injected BEFORE `# DIRECT ADDRESS` when a `workInquiry` was routed to
   * this NPC so the reply POINTS the asker at real work in character. Which job (or none) is code's
   * decision; the wage/DC/Take affordance lives in the WorkCard, never in the spoken line. Omitted
   * when absent so every ordinary reply prompt stays byte-identical.
   */
  workLead?: string[];
  /**
   * Code-gated `# ERRAND ON OFFER` terms (r5) — the route, fee and ETA for an errand the player
   * just asked this NPC to run. Every figure is computed; the reply states them in character and
   * changes none of them. Omitted when absent so ordinary reply prompts stay byte-identical.
   */
  errandQuote?: string[];
  /**
   * The epistemic packet's ANSWER lines (NPC-EPISTEMIC-CONTEXT-PLAN first slice), already rendered
   * by `renderEpistemicBlocks` — the code-selected current/historical facts this character may
   * answer the player's question from, with temporal qualifiers spelled out. Injected as
   * `# ANSWER FACTS` BEFORE `# RELEVANT LORE` (authoritative selection precedes semantic
   * retrieval); omitted when empty so every existing reply prompt stays byte-identical.
   */
  answerFacts?: string[];
  /**
   * Concealment cues for relevant-but-withheld knowledge (disclosure below its bar): topic +
   * behavioral instruction ONLY — the secret text never enters the prompt. Injected as
   * `# WHAT YOU WILL NOT DISCLOSE` immediately before `# DIRECT ADDRESS`; omitted when empty.
   */
  disclosure?: string[];
}

function prose(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A never-stall fallback for an autonomous beat. Silence is data, not dialogue: emitting a literal
 * phrase such as "observe quietly" made transport/model failures appear to be intentional character
 * speech. Goals are private motivations, so they are never used as a fallback either.
 */
const SILENT_FALLBACK = "";

export class NpcAgent {
  constructor(
    private readonly gateway: LlmGateway,
    readonly template: NpcTemplate,
    /** Optional model-specific directive prepended to the prompt. */
    private readonly systemPrefix = "",
  ) {}

  /**
   * In-character system prompt, seeded from persona and goals.
   *
   * SECURITY NOTE: world/NPC text is treated as trusted (author-authored) content today.
   * When world *sharing* lands (roadmap M6), an untrusted persona/summary could attempt
   * prompt injection from the system role; at that point this identity should move into a
   * user-role data block instead. Safe for self-authored worlds.
   */
  buildSystemPrompt(): string {
    const privateNotes = this.privateIdentityLines();
    const base = [
      `You are ${this.template.name}. ${this.template.summary}`,
      this.template.persona,
      // PRIVATE drives, not lines: authored goals often read like quest directives ("Recover the
      // true record"), and a bare "Your goals:" list gets recited verbatim as on-the-nose dialogue
      // (2026-07-05 playtest leak). Frame them as motivations the NPC ACTS on but never announces.
      this.template.goals.length
        ? `Your private motivations (they drive how you act; never recite or announce them as dialogue): ${this.template.goals.join("; ")}.`
        : "",
      ...privateNotes,
      // The people-side twin of the place rail in INTENT_JSON_INSTRUCTION (same principle: an
      // NPC's words become a fact others must find it by). r13 sweep: Sela minted "Corin" in the
      // way-house back rooms, Veil minted the vendor "Solen's", Brann mutated rostered Sable Renn
      // into "Sable Jenkins" — each a concrete findable lead the player then chased for 3–6 turns
      // into honest engine refusals. Storytelling stays free; only false FINDABLE leads are barred.
      "Tales, rumors, and people from your past or far away are yours to speak of freely. But never direct anyone TO a named person, shop, or vendor as somewhere they can actually go and find them, unless that name already appears in your notes or your brief (Present:, # KNOWN WHEREABOUTS, # ANSWER FACTS, # RELEVANT LORE). If you know of no such person, say so plainly in your own voice — a name you invent becomes a false trail others will waste days chasing.",
      "Speak and act only as this character. Stay in-world.",
    ]
      .filter(Boolean)
      .join("\n");
    return this.systemPrefix ? `${this.systemPrefix}\n\n${base}` : base;
  }

  /**
   * DM-facing private notes for THIS NPC only. `hiddenLore` is deliberately excluded: it is a truth
   * the NPC does not know, so it belongs in the GM-only channel, never in this character's prompt.
   */
  private privateIdentityLines(): string[] {
    const lines: string[] = [];
    const sex = prose(this.template.sex);
    const description = prose(this.template.description) ?? prose(this.template.appearance);
    const personality = prose(this.template.personality);
    const knownLore = prose(this.template.knownLore);
    const alignment = resolvePreset(MORALITIES, this.template.alignment);
    const personalityTemplate = resolvePreset(PERSONALITIES, this.template.personalityTemplate);
    const socialRole = prose(this.template.socialRole);
    const voiceTags = (this.template.voiceTags ?? []).map((t) => t.trim()).filter(Boolean);
    const preferences = (this.template.preferences ?? []).map((p) => p.trim()).filter(Boolean);

    // Identity grounding (Workstream A groundwork): who this body is and what others see.
    // Each line is omit-when-empty, so pre-identity templates keep byte-identical prompts.
    if (sex) lines.push(`You are ${sex}.`);
    if (this.template.age !== undefined) lines.push(`You are ${this.template.age} years old.`);
    if (description) lines.push(`What others see: ${description}`);
    if (socialRole) lines.push(`Your place: ${socialRole}.`);
    if (voiceTags.length > 0) lines.push(`Your manner of speech: ${voiceTags.join("; ")}.`);
    if (preferences.length > 0) lines.push(`You like/avoid: ${preferences.join("; ")}.`);
    if (personality) lines.push(`Your personality: ${personality}`);
    if (alignment) lines.push(`Your alignment is ${alignment.label}: ${alignment.guidance}`);
    if (personalityTemplate) {
      lines.push(`Your personality archetype is ${personalityTemplate.label}: ${personalityTemplate.guidance}`);
    }
    if (knownLore) lines.push(`Private lore you know: ${knownLore}`);
    if (lines.length === 0) return [];
    return [
      "Private character notes (let these guide behavior; do not recite them verbatim unless the fiction calls for it):",
      ...lines,
    ];
  }

  /** Reactive in-character reply when the player directly addresses this companion. */
  async reply(_state: GameState, ctx: NpcReplyContext, opts: NarrateOptions = {}): Promise<GenerationResult> {
    const feeling = ctx.relationship
      ? `\n(Your current relationship with ${ctx.fromName}: ${ctx.relationship}.)`
      : ctx.toward !== undefined
        ? `\n(How you currently feel about ${ctx.fromName}: ${ctx.toward} on a -100..100 scale.)`
        : "";
    // Relevant lore (read-only retrieval, M4 Part A) and recalled memory (M4 Part B) sit BEFORE
    // `# DIRECT ADDRESS` — grounding context, not the screened current line — and are EACH omitted
    // when empty, so an NPC with no relevant knowledge AND no memories gets a byte-identical prompt
    // to before either existed. Answer facts (code-SELECTED truth) precede lore (retrieved prose);
    // lore (canon) precedes memory (personal continuity).
    const answerFactsBlock =
      ctx.answerFacts && ctx.answerFacts.length > 0 ? [`# ANSWER FACTS`, ...ctx.answerFacts, ``] : [];
    const loreLines = ctx.lore && ctx.lore.length > 0 ? [`# RELEVANT LORE`, ...ctx.lore, ``] : [];
    const memoryLines = ctx.memory && ctx.memory.length > 0 ? [`# YOU REMEMBER`, ...ctx.memory, ``] : [];
    const relationshipLines = ctx.relationship ? [`# RELATIONSHIP CONTEXT`, `- ${ctx.relationship}`, ``] : [];
    // Derived semantic history (`# OUR HISTORY` / `# RECENTLY WITH YOU`) — already a rendered block.
    const historyLines = ctx.history && ctx.history.length > 0 ? ctx.history : [];
    const whereaboutsBlock =
      ctx.whereabouts && ctx.whereabouts.length > 0 ? [`# KNOWN WHEREABOUTS`, ...ctx.whereabouts, ``] : [];
    const caseFileBlock =
      ctx.caseFile && ctx.caseFile.length > 0 ? [`# THE CASE AS YOU KNOW IT`, ...ctx.caseFile, ``] : [];
    const workLeadBlock =
      ctx.workLead && ctx.workLead.length > 0 ? [`# WORK ON OFFER`, ...ctx.workLead, ``] : [];
    const errandQuoteBlock =
      ctx.errandQuote && ctx.errandQuote.length > 0
        ? [`# ERRAND ON OFFER`, ...ctx.errandQuote.map((t) => `- ${t}`), `State these terms as your own; do not change them.`, ``]
        : [];
    // Concealment cues sit LAST before the address — the nearest instruction to the line they guard.
    const disclosureBlock =
      ctx.disclosure && ctx.disclosure.length > 0
        ? [`# WHAT YOU WILL NOT DISCLOSE`, ...ctx.disclosure.map((t) => `- ${t}`), ``]
        : [];
    const directiveLines = ctx.directive
      ? [`Mechanics directive: ${ctx.directive} Phrase this outcome in character; do not change it or decide differently.`]
      : [];
    const user = [
      ctx.contextText,
      ``,
      ...answerFactsBlock,
      ...loreLines,
      ...memoryLines,
      ...relationshipLines,
      ...historyLines,
      ...whereaboutsBlock,
      ...caseFileBlock,
      ...workLeadBlock,
      ...errandQuoteBlock,
      ...disclosureBlock,
      BRIEF_MARKERS.directAddress,
      `${ctx.fromName} says to you: "${ctx.playerLine}"${feeling}`,
      ...directiveLines,
      ``,
      `Reply in character as ${this.template.name}, in one to four sentences of spoken dialogue. Speak only your own words — do not narrate the scene, act for the player, or describe dice.`,
      `If the context carries an Attire:, Visibly:, or Body: line, that is what you physically perceive of ${ctx.fromName} right now — notice it (a glance, a remark, a shift in tone) rather than ignoring it.`,
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: this.buildSystemPrompt() },
      { role: "user", content: user },
    ];

    let text = "";
    let blocked = false;
    try {
      for await (const chunk of this.gateway.stream("narrator", {
        messages,
        temperature: opts.temperature ?? 0.8,
        // Reasoning models reason MORE for a tightly-constrained in-character line than for
        // open narration, so give the spoken reply ample headroom or it arrives empty.
        maxTokens: opts.maxTokens ?? 1024,
      })) {
        if (chunk.reasoning) opts.onReasoning?.(chunk.reasoning);
        if (chunk.blocked) blocked = true;
        if (chunk.delta) {
          text += chunk.delta;
          opts.onToken?.(chunk.delta);
        }
      }
    } catch (err) {
      // Keep a partial reply that already streamed; surface the error only if empty.
      if (!text) throw err;
    }
    return { text: text.trim(), blocked };
  }

  /**
   * Autonomous decision — the THIN, prose-only beat (one free-text sentence of intent). The
   * Director drives the structured {@link decideTurn} instead, because a world act must be NAMED
   * from a closed list, not read out of a sentence (src/rules/npc-act.ts); this path is retained
   * for prompt-shape specs and carries no act at all — its line is words only. Mirrors reply()'s
   * stream structure (same maxTokens headroom
   * so reasoning models don't arrive empty). Offline-safe: on ANY error or empty output it
   * returns a safe fallback intent drawn from the character's first goal, so a heartbeat tick can
   * never hang or throw — the never-stall guarantee.
   */
  async decide(_state: GameState, ctx: NpcDecisionContext, opts: NarrateOptions = {}): Promise<NpcIntent> {
    // Recalled memory (M4 Part B) sits BEFORE the autonomous-beat marker — grounding the decision in
    // what the NPC remembers — and is omitted when empty so a memory-less NPC's decide prompt is
    // byte-identical to before memory existed.
    const memoryLines = ctx.memory && ctx.memory.length > 0 ? [`# YOU REMEMBER`, ...ctx.memory, ``] : [];
    const relationshipLines = ctx.relationship ? [`# RELATIONSHIP CONTEXT`, `- ${ctx.relationship}`, ``] : [];
    const historyLines = ctx.history && ctx.history.length > 0 ? ctx.history : [];
    const caseFileBlock =
      ctx.caseFile && ctx.caseFile.length > 0 ? [`# THE CASE AS YOU KNOW IT`, ...ctx.caseFile, ``] : [];
    const user = [
      ctx.contextText,
      ``,
      ...memoryLines,
      ...relationshipLines,
      ...historyLines,
      ...caseFileBlock,
      BRIEF_MARKERS.autonomousBeat,
      ctx.stimulus,
      ctx.agendaDirective
        ? `Mechanics directive: ${ctx.agendaDirective} Phrase this action in character; do not change the action or decide whether it succeeds.`
        : "",
      `(Answer with the SINGLE LINE your character SAYS OUT LOUD — spoken words only. No narration, no stage directions, no asterisks, no quotation marks, no third-person or first-person action description. Just the words as they leave your mouth.)`,
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: this.buildSystemPrompt() },
      { role: "user", content: user },
    ];

    let text = "";
    let blocked = false;
    try {
      for await (const chunk of this.gateway.stream("narrator", {
        messages,
        temperature: opts.temperature ?? 0.8,
        maxTokens: opts.maxTokens ?? 1024,
      })) {
        if (chunk.reasoning) opts.onReasoning?.(chunk.reasoning);
        if (chunk.blocked) blocked = true;
        if (chunk.delta) {
          text += chunk.delta;
          opts.onToken?.(chunk.delta);
        }
      }
    } catch {
      // Swallow: a broken gateway must not stall a heartbeat. Fall through to the safe fallback.
    }

    // A minor-safety block on an autonomous beat makes the NPC silent: discard the model text and
    // use the safe fallback, so the visible OOC refusal is reserved for
    // player-facing generations (narrate/reply) and a blocked beat can never stall the heartbeat.
    const trimmed = blocked ? "" : text.trim();
    if (trimmed) return { text: trimmed, urgency: 0 };
    // Never-stall, but NEVER leak the goal: goals are private motivations the character must not
    // recite (buildSystemPrompt), and this hard fallback bypasses the model — so falling back to
    // `goals[0]` made a gateway hiccup speak the secret motive verbatim. Degrade to a neutral beat.
    return { text: SILENT_FALLBACK, urgency: 0 };
  }

  /**
   * Collect a full completion for the structured-intent methods: gather text + the minor-safety
   * `blocked` flag, and RETURN any error rather than throwing (the caller decides). Deliberately does
   * NOT forward tokens to `opts.onToken` — the raw JSON intent must never reach the player's screen
   * (the DM narrates the beat later). `reply()`/`decide()` keep their own inline loops (untouched).
   */
  private async streamRaw(
    messages: ChatMessage[],
    opts: NarrateOptions,
  ): Promise<{ text: string; blocked: boolean; error: unknown }> {
    let text = "";
    let blocked = false;
    let error: unknown = null;
    try {
      for await (const chunk of this.gateway.stream("narrator", {
        messages,
        temperature: opts.temperature ?? 0.8,
        maxTokens: opts.maxTokens ?? 1024,
      })) {
        if (chunk.reasoning) opts.onReasoning?.(chunk.reasoning);
        if (chunk.blocked) blocked = true;
        if (chunk.delta) text += chunk.delta;
      }
    } catch (err) {
      error = err;
    }
    return { text: text.trim(), blocked, error };
  }

  /**
   * PUBLIC reactive turn (the DM-owned successor to `reply()` for public address): same brief as
   * `reply()`, but the final instruction asks for a structured `NpcTurnIntent` (words + staging +
   * motive + desired command + facts) that the DM renders into staged prose. Never streams the raw
   * JSON to the player. On a minor-safety block, returns `{blocked:true}` carrying the OOC refusal.
   * On a parse failure or a non-JSON model, falls back to treating the whole line as spoken words
   * (never-stall). PRIVATE address must keep using `reply()` — this method is public-only.
   */
  async replyTurn(_state: GameState, ctx: NpcReplyContext, opts: NarrateOptions = {}): Promise<NpcTurnIntent> {
    const feeling = ctx.relationship
      ? `\n(Your current relationship with ${ctx.fromName}: ${ctx.relationship}.)`
      : ctx.toward !== undefined
        ? `\n(How you currently feel about ${ctx.fromName}: ${ctx.toward} on a -100..100 scale.)`
        : "";
    const answerFactsBlock =
      ctx.answerFacts && ctx.answerFacts.length > 0 ? [`# ANSWER FACTS`, ...ctx.answerFacts, ``] : [];
    const loreLines = ctx.lore && ctx.lore.length > 0 ? [`# RELEVANT LORE`, ...ctx.lore, ``] : [];
    const memoryLines = ctx.memory && ctx.memory.length > 0 ? [`# YOU REMEMBER`, ...ctx.memory, ``] : [];
    const relationshipLines = ctx.relationship ? [`# RELATIONSHIP CONTEXT`, `- ${ctx.relationship}`, ``] : [];
    const historyLines = ctx.history && ctx.history.length > 0 ? ctx.history : [];
    const whereaboutsBlock =
      ctx.whereabouts && ctx.whereabouts.length > 0 ? [`# KNOWN WHEREABOUTS`, ...ctx.whereabouts, ``] : [];
    const caseFileBlock =
      ctx.caseFile && ctx.caseFile.length > 0 ? [`# THE CASE AS YOU KNOW IT`, ...ctx.caseFile, ``] : [];
    const workLeadBlock =
      ctx.workLead && ctx.workLead.length > 0 ? [`# WORK ON OFFER`, ...ctx.workLead, ``] : [];
    const errandQuoteBlock =
      ctx.errandQuote && ctx.errandQuote.length > 0
        ? [`# ERRAND ON OFFER`, ...ctx.errandQuote.map((t) => `- ${t}`), `State these terms as your own; do not change them.`, ``]
        : [];
    const disclosureBlock =
      ctx.disclosure && ctx.disclosure.length > 0
        ? [`# WHAT YOU WILL NOT DISCLOSE`, ...ctx.disclosure.map((t) => `- ${t}`), ``]
        : [];
    const directiveLines = ctx.directive
      ? [`Mechanics directive: ${ctx.directive} Phrase this outcome in character; do not change it or decide differently.`]
      : [];
    const user = [
      ctx.contextText,
      ``,
      ...answerFactsBlock,
      ...loreLines,
      ...memoryLines,
      ...relationshipLines,
      ...historyLines,
      ...whereaboutsBlock,
      ...caseFileBlock,
      ...workLeadBlock,
      ...errandQuoteBlock,
      ...disclosureBlock,
      BRIEF_MARKERS.directAddress,
      `${ctx.fromName} says to you: "${ctx.playerLine}"${feeling}`,
      ...directiveLines,
      ``,
      buildIntentJsonInstruction(NPC_ACT_VERBS),
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: this.buildSystemPrompt() },
      { role: "user", content: user },
    ];
    const { text, blocked, error } = await this.streamRaw(messages, opts);
    // Mirror reply(): surface a hard gateway error only when nothing streamed at all.
    if (!text && error) throw error;
    return this.intentFrom(blocked ? null : parseNpcTurnIntent(text), text, blocked);
  }

  /**
   * PUBLIC autonomous turn (the DM-owned successor to `decide()`): same brief as `decide()`, but
   * emits a structured `NpcTurnIntent`. Keeps decide()'s never-stall guarantee — ANY error, empty
   * output, or minor-safety block yields a silent fallback intent, so a heartbeat
   * can never hang. Never streams the raw JSON. The module grounds the closed `desiredAct` into a
   * legal command by table lookup (grounding remains code's job); the model's output is phrasing and
   * a NAMED act, never truth.
   */
  async decideTurn(_state: GameState, ctx: NpcDecisionContext, opts: NarrateOptions = {}): Promise<NpcTurnIntent> {
    const memoryLines = ctx.memory && ctx.memory.length > 0 ? [`# YOU REMEMBER`, ...ctx.memory, ``] : [];
    const relationshipLines = ctx.relationship ? [`# RELATIONSHIP CONTEXT`, `- ${ctx.relationship}`, ``] : [];
    const historyLines = ctx.history && ctx.history.length > 0 ? ctx.history : [];
    const caseFileBlock =
      ctx.caseFile && ctx.caseFile.length > 0 ? [`# THE CASE AS YOU KNOW IT`, ...ctx.caseFile, ``] : [];
    // The closed act table (r8): the only ids the model's `act` may name. Omit-when-empty.
    const candidateBlock =
      ctx.actCandidates && ctx.actCandidates.length > 0
        ? [`# CANDIDATE ACTIONS`, ...ctx.actCandidates, ``]
        : [];
    const user = [
      ctx.contextText,
      ``,
      ...memoryLines,
      ...relationshipLines,
      ...historyLines,
      ...caseFileBlock,
      ...candidateBlock,
      BRIEF_MARKERS.autonomousBeat,
      ctx.stimulus,
      ctx.agendaDirective
        ? `Mechanics directive: ${ctx.agendaDirective} Phrase this action in character; do not change the action or decide whether it succeeds.`
        : "",
      buildIntentJsonInstruction(actVerbsOffered(ctx.actCandidates)),
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: this.buildSystemPrompt() },
      { role: "user", content: user },
    ];
    const { text, blocked } = await this.streamRaw(messages, opts);
    const parsed = blocked ? null : parseNpcTurnIntent(text);
    const intent = this.intentFrom(parsed, text, blocked);
    // Never-stall + blocked-goes-silent: a blocked or empty beat remains genuinely silent (the
    // visible OOC refusal is reserved for player-facing paths; an autonomous beat just stays quiet).
    if (blocked || !intent.visibleSpeech.trim()) {
      if (!intent.visibleAction && !intent.desiredAct) {
        // Same rule as decide(): a hard fallback must not recite the private goal. Neutral beat.
        return { visibleSpeech: SILENT_FALLBACK, urgency: 0 };
      }
    }
    return intent;
  }

  /**
   * Fold a parsed intent (or a parse failure) into a complete NpcTurnIntent. A minor-safety block
   * returns the OOC refusal carried as `visibleSpeech` with `blocked:true` (never re-narrated). A
   * parse failure / empty JSON falls back to the whole raw line as spoken words (never-stall) — the
   * DM then renders it, and grounding still sees the keywords it carries.
   */
  private intentFrom(parsed: Partial<NpcTurnIntent> | null, raw: string, blocked: boolean): NpcTurnIntent {
    if (blocked) return { visibleSpeech: raw, blocked: true, urgency: 0 };
    // A successfully PARSED object is structured output — valid even when it carries only
    // non-visible fields (motive/facts/targets/confidence). That is deliberate silence, NOT a parse
    // failure: `visibleSpeech` defaults to empty. The old `hasField` gate treated a motive-only
    // intent as unparsed and dumped the raw JSON (private motive included) into the player's dialogue.
    if (parsed) {
      // Seatbelt for the spoken-words-only contract: a model that narrates its OWN blocking inside
      // "say" would ship stage direction as a quotation (live D2, 07-17). Scrub per line; a line
      // scrubbed to nothing is dropped (silence over broken prose).
      const scrubbedLines = parsed.lines
        ?.map((l) => ({ ...l, text: scrubSelfNarration(l.text, this.template.name) }))
        .filter((l) => l.text.length > 0);
      return {
        visibleSpeech: scrubSelfNarration(parsed.visibleSpeech ?? "", this.template.name),
        lines: scrubbedLines && scrubbedLines.length > 0 ? scrubbedLines : undefined,
        visibleAction: parsed.visibleAction,
        privateIntent: parsed.privateIntent,
        desiredAct: parsed.desiredAct,
        targets: parsed.targets,
        confidence: parsed.confidence,
        factsAsserted: parsed.factsAsserted,
        factIdsUsed: parsed.factIdsUsed,
        factIdsWithheld: parsed.factIdsWithheld,
        offers: parsed.offers,
        urgency: parsed.urgency ?? 0,
        relationshipNudge: parsed.relationshipNudge,
      };
    }
    // Parse FAILED. The raw-line fallback (never-stall) exists for a plain-prose model that ignored
    // the JSON instruction — but a JSON-SHAPED string is a garbled/truncated intent (a partial
    // `{"speech":"We…`, or an object whose fields we didn't recognize) and must NEVER be spoken
    // verbatim: that would leak braces, transport fragments, or a private motive to the screen.
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return { visibleSpeech: "", urgency: 0 };
    return { visibleSpeech: trimmed, urgency: 0 };
  }
}

/**
 * Distill a decide() intent into the line the character actually SAYS — the display-side seatbelt
 * for models that disobey the spoken-words-only contract and return first-person stage direction
 * wrapping a quote ("I grunt …, and say flatly, \"Right—we walk.\"").
 *
 * Pure, deterministic, never empty:
 *  - If the text contains double-quoted spans (straight or curly), the spoken line is the quoted
 *    contents, joined in order (quotes stripped) — the narration around them is discarded.
 *  - Otherwise leading/trailing *asterisk action* spans are stripped, then stray markdown emphasis
 *    markers; whitespace collapses.
 *  - If stripping leaves nothing, fall back to the raw trim (a line is always better than silence).
 *
 * Strip third-person SELF-narration from a spoken line — the display-side seatbelt for a model that
 * bleeds its own stage direction into "say" ("Oda stays still, hands loose at his sides… What are
 * you here for?" live D2, 07-17). A sentence that names the SPEAKER in the third person is never
 * genuine dialogue — people don't narrate themselves mid-sentence — UNLESS it also carries a
 * first-person pronoun ("I am Oda", "call me Oda of the roads" stay). Pure and conservative: only
 * sentences naming the speaker are dropped; third-person sentences about OTHERS ("He owes me coin.")
 * are untouched. Returns "" when nothing survives (deliberate silence beats broken narration).
 */
export function scrubSelfNarration(text: string, speakerName: string): string {
  const stop = new Set(["the", "of", "and", "von", "van", "der", "den", "del", "la", "le"]);
  const tokens = speakerName
    .split(/[^a-zA-Z0-9'’-]+/)
    .filter((t) => t.length >= 3)
    .map((t) => t.toLowerCase())
    .filter((t) => !stop.has(t));
  if (tokens.length === 0) return text.trim();
  const firstPerson = /(?:\b(?:me|my|mine|myself|we|our|us)\b|\bI\b|\bI['’]\w+)/;
  const sentences = text.trim().split(/(?<=[.!?…])\s+/);
  const kept = sentences.filter((s) => {
    const lower = s.toLowerCase();
    const namesSelf = tokens.some((t) => new RegExp(`\\b${t}\\b`).test(lower));
    return !namesSelf || firstPerson.test(s);
  });
  return kept.join(" ").trim();
}

/** A single whitespace character, `\s` exactly — the class {@link stripTrailingActionBeats} inherits
 *  from the regex it replaces (so \f, \v, NBSP and the unicode spaces keep counting). */
const WHITESPACE_CHAR = /\s/;

/**
 * Strip a run of trailing `*action beat*` spans — the LINEAR replacement for
 * `/(?:\s*\*[^*]*\*\s*)+$/`, which was a catastrophic-backtracking hazard on unbounded model output.
 *
 * In that regex `\s*` sits at BOTH the head and the tail of a `+`-repeated group, so the whitespace
 * between two beats can be attributed to either side: a k-beat run has ~2^k parses and the engine
 * must try every one of them before the `$` anchor is allowed to fail. Measured on this repo's Bun,
 * through `spokenLineOf` itself, on `"He waits. " + "*he shifts* ".repeat(k) + "and then nothing."`:
 * k=18 → 25ms, k=20 → 98ms, k=22 → 390ms, k=26 → 1166ms — clean doubling on a 339-character line,
 * i.e. well inside what a model returns, blocking a single-threaded server once per NPC line. Worse,
 * past ~k=24 JSC abandons the match at its backtracking ceiling and reports NO MATCH, so on exactly
 * the slow inputs the strip silently no-opped and raw `*stage direction*` reached the player — the
 * opposite of this function's job (verified: a 30-beat line kept its final beat where a 20-beat one
 * lost it). The shape is player-steerable ("reply only in action beats, no quotes"), so it is live.
 *
 * Peeling units off the right is equivalent to the regex, not merely close to it: `[^*]*` cannot
 * span an asterisk, so every unit holds exactly two and the pairing is forced — there is nothing to
 * guess, hence nothing to backtrack over. Each character is visited a bounded number of times.
 *
 * The LEADING sibling (`/^(?:\s*\*[^*]*\*\s*)+/`) is genuinely safe and stays a regex: `^` gives it
 * a single start position and nothing follows the group, so the greedy first pass either succeeds
 * outright or fails outright, with no anchor to force a retry. Verified at 200 beats: 0.01ms.
 */
function stripTrailingActionBeats(text: string): string {
  let cut = text.length;
  for (;;) {
    // The unit's trailing `\s*` …
    let close = cut;
    while (close > 0 && WHITESPACE_CHAR.test(text[close - 1]!)) close--;
    // … then its closing `*` …
    if (close === 0 || text[close - 1] !== "*") break;
    // … then `[^*]*` back to the opening `*`. An unbalanced asterisk is not a beat: stop, don't eat.
    let open = close - 2;
    while (open >= 0 && text[open] !== "*") open--;
    if (open < 0) break;
    // … and finally the unit's leading `\s*`, which the regex folded into its own match too.
    let start = open;
    while (start > 0 && WHITESPACE_CHAR.test(text[start - 1]!)) start--;
    cut = start;
  }
  return cut === text.length ? text : text.slice(0, cut);
}

/**
 * Distill a decide() intent into the line the character actually SAYS — the display-side seatbelt
 * for models that disobey the spoken-words-only contract and return first-person stage direction
 * wrapping a quote ("I grunt …, and say flatly, \"Right—we walk.\"").
 *
 * Pure, deterministic, never empty:
 *  - If the text contains double-quoted spans (straight or curly), the spoken line is the quoted
 *    contents, joined in order (quotes stripped) — the narration around them is discarded.
 *  - Otherwise leading/trailing *asterisk action* spans are stripped, then stray markdown emphasis
 *    markers; whitespace collapses.
 *  - If stripping leaves nothing, fall back to the raw trim (a line is always better than silence).
 *
 * DISPLAY ONLY: grounding (src/modules/autonomy/grounding.ts) keeps the RAW intent text — the
 * discarded narration often carries the movement/give keywords grounding scores.
 *
 * The trailing-beat strip is {@link stripTrailingActionBeats}, not a regex — see the note there.
 */
export function spokenLineOf(text: string): string {
  const raw = text.trim();
  const spans: string[] = [];
  const quoted = /"([^"]*)"|“([^”]*)”/g;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(raw)) !== null) {
    const inner = (m[1] ?? m[2] ?? "").trim();
    if (inner) spans.push(inner);
  }
  if (spans.length > 0) return spans.join(" ").replace(/\s+/g, " ").trim();

  const withoutLeadingBeats = raw.replace(/^(?:\s*\*[^*]*\*\s*)+/, ""); // leading *action beats*
  const stripped = stripTrailingActionBeats(withoutLeadingBeats) // trailing *action beats*
    .replace(/[*_]+/g, "") // stray markdown emphasis markers
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : raw;
}

/**
 * Defensively parse a model's structured turn-intent JSON. Tolerates prose/markdown-fence wrapping by
 * extracting the first `{ … }` block. Accepts either the short model-facing keys (`speech`/`action`/
 * `motive`/`command`/`facts`) or the interface names (`visibleSpeech`/…). Returns the recognized
 * fields (all optional); returns null when no JSON object parses — the caller then treats the raw
 * text as spoken words (the never-stall fallback). NEVER throws.
 */
/**
 * Parse the model's `speech` field, tolerant of three shapes: a plain string (legacy / a model that
 * ignored the list format — one un-tagged line, no `lines`), an array of strings (one neutral line
 * each), or the structured array of `{ say|text|line, mood|tone }`. Returns the flattened `text` (for
 * `visibleSpeech`, which every existing consumer reads) plus the mood-tagged `lines` when the array
 * form was used. Unknown moods clamp to "neutral"; empties are dropped; returns undefined for silence.
 */
function parseSpeech(v: unknown): { text: string; lines?: SpokenLine[] } | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t ? { text: t } : undefined;
  }
  if (!Array.isArray(v)) return undefined;
  const moods = SPEECH_MOODS as readonly string[];
  const lines: SpokenLine[] = [];
  for (const entry of v) {
    if (typeof entry === "string") {
      const t = entry.trim();
      if (t) lines.push({ text: t, mood: "neutral" });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const say = [o.say, o.text, o.line].find((x): x is string => typeof x === "string" && x.trim().length > 0);
    if (!say) continue;
    const rawMood = [o.mood, o.tone].find((x): x is string => typeof x === "string");
    const mood = (rawMood ?? "").toLowerCase().trim();
    lines.push({ text: say.trim(), mood: moods.includes(mood) ? (mood as SpeechMood) : "neutral" });
  }
  if (lines.length === 0) return undefined;
  return { text: lines.map((l) => l.text).join(" "), lines };
}

/**
 * Parse the self-reported `offers` array (§2.1) STRICTLY: an entry needs a non-empty name AND a
 * positive integer copper price, or it is dropped — a half-filled row is a model guessing, and a
 * guessed price becomes a real transaction at the counter. Capped at {@link MAX_REPORTED_OFFERS}.
 * Returns undefined when nothing survives, so a beat that offered nothing stays byte-identical.
 */
function parseOffers(value: unknown): NpcOffer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: NpcOffer[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const name = [o.name, o.item, o.what].find((x): x is string => typeof x === "string" && x.trim().length > 0);
    const priceRaw = [o.priceCp, o.price_cp].find((x): x is number => typeof x === "number" && Number.isFinite(x));
    if (!name || priceRaw === undefined) continue;
    const priceCp = Math.round(priceRaw);
    if (priceCp <= 0 || priceCp > MAX_OFFER_PRICE_CP) continue;
    out.push({ name: name.trim().slice(0, 60), priceCp });
    if (out.length >= MAX_REPORTED_OFFERS) break;
  }
  return out.length > 0 ? out : undefined;
}

export function parseNpcTurnIntent(raw: string): Partial<NpcTurnIntent> | null {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const arr = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
    return out.length > 0 ? out : undefined;
  };
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  const out: Partial<NpcTurnIntent> = {};
  const speech = parseSpeech(obj.speech ?? obj.visibleSpeech);
  if (speech) {
    out.visibleSpeech = speech.text;
    if (speech.lines) out.lines = speech.lines;
  }
  const action = str(obj.action) ?? str(obj.visibleAction);
  if (action !== undefined) out.visibleAction = action;
  const motive = str(obj.motive) ?? str(obj.privateIntent) ?? str(obj.why);
  if (motive !== undefined) out.privateIntent = motive;
  // The CLOSED act (r8). `parseNpcAct` returns undefined for a malformed object, an unknown verb, or
  // the deliberate "none" — all of which ground to plain speech, the safe branch. A model that still
  // emits the retired free-text `command` string is IGNORED here rather than half-parsed: a sentence
  // is not an id, and guessing one from it is the keyword net this replaced.
  const act = parseNpcAct(obj.act ?? obj.desiredAct);
  if (act !== undefined) out.desiredAct = act;
  const targets = arr(obj.targets);
  if (targets) out.targets = targets;
  const confidence = num(obj.confidence);
  if (confidence !== undefined) out.confidence = Math.max(0, Math.min(1, confidence));
  const facts = arr(obj.facts) ?? arr(obj.factsAsserted);
  if (facts) out.factsAsserted = facts;
  const used = arr(obj.factsUsed) ?? arr(obj.factIdsUsed);
  if (used) out.factIdsUsed = used;
  const withheld = arr(obj.factsWithheld) ?? arr(obj.factIdsWithheld);
  if (withheld) out.factIdsWithheld = withheld;
  const offers = parseOffers(obj.offers);
  if (offers) out.offers = offers;
  const nudge = num(obj.relationship) ?? num(obj.relationshipNudge);
  if (nudge !== undefined) out.relationshipNudge = nudge;
  return out;
}
