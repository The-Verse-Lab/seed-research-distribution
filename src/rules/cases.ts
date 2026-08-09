/**
 * Cases — the epistemic spine of the mystery/collaborative-deduction layer.
 *
 * The core architectural claim (see docs + the mystery wave plan): who-knows-which-case-fact is
 * CODE-OWNED data, never an LLM memory. The authored {@link Case} carries the ground truth (GM-only)
 * and the per-NPC starting knowledge/beliefs; everything learned or dropped IN PLAY lives in the
 * persisted `modules.cases` slice, mutated ONLY by the reducer (revealCaseFact/npcLearnCaseFact/…)
 * and read back into prompts as per-NPC blocks. This module is the pure analogue of `progression.ts`:
 * state-free helpers the reducer, the brief builder, and the solvability test all agree on.
 *
 * Effective NPC knowledge = authored `knows` ∪ runtime `learned`. Effective beliefs (possibly FALSE
 * red herrings, rendered to the NPC as confident knowledge) = authored `believes` − runtime `dropped`.
 * Both are sparse diffs over the authored content so a case with no play-progress serialises tiny.
 *
 * @author Runkai Zhang
 */
import type { Campaign, Case } from "../content/schema.ts";
import type { GameState } from "../state/types.ts";

/** The reducer/replay module key for the runtime slice (`WorldModel.modules.cases`). */
export const CASES_MODULE = "cases";

/** Per-NPC credibility band — the player's standing in THIS npc's eyes (0 = neutral trust). */
export const CREDIBILITY_MIN = -5;
export const CREDIBILITY_MAX = 5;
/** At/below this the NPC treats the player as a known liar (a distrust rail joins its brief). */
export const DISTRUST_THRESHOLD = -2;
/** Hard cap on the per-case claim ledger so a pathological session can't grow the slice unbounded. */
export const CLAIMS_CAP = 40;
/** How many withheld fact ids one NPC remembers — bounded for the same reason. */
export const WITHHELD_CAP = 12;
/** Minimum in-world minutes between an NPC's proactive case shares (Director urge cooldown). */
export const SHARE_COOLDOWN_MINUTES = 60;
/** A finite, JSON-safe "never shared / never accused" sentinel (−∞ would break the reducer's
 *  non-finite guard and JSON round-trips). Any real clock minus this clears every cooldown. */
export const NEVER = -1_000_000;

export type CaseStatus = "open" | "solved" | "failed";

/**
 * What the player did with a fact in front of an NPC. `withhold` is the r4 P2 fix: an explicit
 * refusal to show evidence ("you'll get a look — at the pages that don't touch you") used to be
 * executed as its OPPOSITE, and once the misclassification was fixed it recorded nothing at all.
 * Refusing is a move in a mystery, so the world remembers it.
 */
export type CaseClaimStance = "assert" | "contradict" | "withhold";

/** How a player assertion landed against an NPC's epistemic state (the lie/credibility ledger). */
export interface CaseClaim {
  /** The NPC the claim was made to. */
  npcId: string;
  /** The fact (or herring) id asserted or contradicted. */
  factId: string;
  /** Assert it as true, deny it, or refuse to show it at all. */
  stance: CaseClaimStance;
  /** True when the claim contradicted something the NPC KNOWS — a caught lie (credibility damage). */
  caught: boolean;
  /** In-world minute the claim was made. */
  clock: number;
}

/** The sparse, in-play diff over an NPC's authored case knowledge. */
export interface NpcCaseState {
  /** Fact ids learned in play — union with authored `knows` = the NPC's effective knowledge. */
  learned: string[];
  /** Belief (herring) ids the NPC has stopped believing — subtracted from authored `believes`. */
  dropped: string[];
  /** Fact ids this NPC has already voiced to the party (proactive-share dedup). */
  toldPlayer: string[];
  /** The player's credibility with THIS npc, clamped to [{@link CREDIBILITY_MIN}, {@link CREDIBILITY_MAX}]. */
  credibility: number;
  /** In-world minute of this NPC's last proactive share (share cooldown clock). */
  lastShareClock: number;
  /**
   * Fact ids the player has explicitly REFUSED to show this NPC (r5). Optional and absent from
   * {@link defaultNpcCaseState} so a fresh state serializes byte-identically; every reader takes
   * `?? []`. Invariant: `withheld ∩ learned = ∅` — showing a fact later clears the hold-out.
   */
  withheld?: string[];
}

/** The persisted runtime state of one case. Absent ⇒ the case is untouched (all-authored). */
export interface CaseRuntime {
  /** Fact ids the PLAYER currently knows (the only facts the GM brief may surface as evidence). */
  playerKnown: string[];
  /** Per-NPC in-play diffs, keyed by npc id. */
  npcState: Record<string, NpcCaseState>;
  /** The bounded claim/lie ledger (newest last, capped at {@link CLAIMS_CAP}). */
  claims: CaseClaim[];
  /** How many wrong accusations the player has spent (budget = accusation.maxWrongAccusations). */
  wrongAccusations: number;
  /** Lifecycle: open until the player solves it or exhausts the accusation budget. */
  status: CaseStatus;
}

export type CasesSlice = Record<string, CaseRuntime>;

/** A fresh, untouched runtime for a case. */
export function defaultCaseRuntime(): CaseRuntime {
  return { playerKnown: [], npcState: {}, claims: [], wrongAccusations: 0, status: "open" };
}

/** A fresh per-NPC state (neutral credibility, no shares yet). */
export function defaultNpcCaseState(): NpcCaseState {
  return { learned: [], dropped: [], toldPlayer: [], credibility: 0, lastShareClock: NEVER };
}

/** Read the cases slice off a modules bag (defaults to empty — pre-mystery saves parse clean). */
export function readCasesSlice(modules: Record<string, unknown> | undefined): CasesSlice {
  const slice = modules?.[CASES_MODULE];
  return slice && typeof slice === "object" ? (slice as CasesSlice) : {};
}

/** The runtime for one case, or a fresh default (never a shared/frozen reference — callers spread it). */
export function caseRuntimeOf(modules: Record<string, unknown> | undefined, caseId: string): CaseRuntime {
  return readCasesSlice(modules)[caseId] ?? defaultCaseRuntime();
}

/** One NPC's runtime state within a case runtime, or a fresh default. */
export function npcCaseStateOf(runtime: CaseRuntime | undefined, npcId: string): NpcCaseState {
  return runtime?.npcState[npcId] ?? defaultNpcCaseState();
}

/** Clamp a credibility value into the legal band. */
export function clampCredibility(value: number): number {
  return Math.max(CREDIBILITY_MIN, Math.min(CREDIBILITY_MAX, Math.round(value)));
}

/** Append a claim to a bounded ledger, dropping the oldest past {@link CLAIMS_CAP}. Pure. */
export function pushClaim(claims: readonly CaseClaim[], claim: CaseClaim): CaseClaim[] {
  const next = [...claims, claim];
  return next.length > CLAIMS_CAP ? next.slice(next.length - CLAIMS_CAP) : next;
}

/** Facts this NPC treats as KNOWN truth: authored `knows` ∪ runtime `learned` (deduped, order-stable). */
export function effectiveKnown(caseDef: Case, runtime: CaseRuntime | undefined, npcId: string): string[] {
  const authored = caseDef.npcKnowledge[npcId]?.knows ?? [];
  const learned = npcCaseStateOf(runtime, npcId).learned;
  return unionStable(authored, learned);
}

/** Herrings this NPC still BELIEVES: authored `believes` − runtime `dropped` (a false-belief may be
 *  overturned in play by a witnessed refutation). */
export function effectiveBeliefs(caseDef: Case, runtime: CaseRuntime | undefined, npcId: string): string[] {
  const authored = caseDef.npcKnowledge[npcId]?.believes ?? [];
  const dropped = new Set(npcCaseStateOf(runtime, npcId).dropped);
  return authored.filter((id) => !dropped.has(id));
}

/** Herrings this NPC knowingly PUSHES (the culprit's active misdirection) — authored, never earned. */
export function assertedHerrings(caseDef: Case, npcId: string): string[] {
  return caseDef.npcKnowledge[npcId]?.asserts ?? [];
}

/** Whether an NPC's proactive share cooldown has cleared at the given in-world clock. */
export function shareCooldownClear(state: NpcCaseState, clock: number): boolean {
  return clock - state.lastShareClock >= SHARE_COOLDOWN_MINUTES;
}

/** One case fact an NPC could proactively volunteer to the party this beat (the Director share pick). */
export interface CaseShare {
  caseId: string;
  factId: string;
  factText: string;
}

/**
 * The single case fact this NPC should proactively SHARE with the party this beat, or null. The
 * proactive-collaboration counterpart to {@link renderCaseFileForNpc}'s "not yet told" nudge: the
 * Director surfaces it in the idle stimulus (so the model phrases it) AND the realize path mints the
 * matching `revealCaseFact`/`markCaseFactShared` when the NPC actually speaks — code owns which fact
 * enters the ledger, never the model. Gated on the share cooldown ({@link SHARE_COOLDOWN_MINUTES});
 * the fact must be one the NPC holds as KNOWN (authored ∪ learned), has NOT yet told the party, and
 * the player does NOT already know. Priority: a CORE fact first (accusation-relevant), then a herring
 * REFUTER (surfacing it lets a false belief be overturned), then the first unshared fact. PURE — reads
 * the campaign + runtime, writes nothing; deterministic across cases (campaign order) so the seeded
 * Director stream stays stable. Returns null (byte-identical idle beat) whenever nothing is shareable.
 */
export function planCaseShare(campaign: Campaign, state: GameState, npcId: string, clock: number): CaseShare | null {
  const slice = readCasesSlice(state.modules);
  for (const c of campaign.cases) {
    if (state.quests[c.questId] !== "active") continue;
    const runtime = slice[c.id];
    if (runtime && runtime.status !== "open") continue;
    const npcState = npcCaseStateOf(runtime, npcId);
    if (!shareCooldownClear(npcState, clock)) continue;
    // Reciprocity, and the one MECHANICAL consequence of withholding: a person you have stonewalled
    // stops volunteering. Nothing else about them changes, and showing them anything clears it.
    if ((npcState.withheld ?? []).length > 0) continue;
    const told = new Set(npcState.toldPlayer);
    const playerKnows = new Set(runtime?.playerKnown ?? []);
    const candidates = effectiveKnown(c, runtime, npcId).filter((id) => !told.has(id) && !playerKnows.has(id));
    if (candidates.length === 0) continue;
    const core = new Set(c.facts.filter((f) => f.core).map((f) => f.id));
    const refuters = new Set(c.redHerrings.flatMap((h) => h.refutedBy));
    const pick =
      candidates.find((id) => core.has(id)) ?? candidates.find((id) => refuters.has(id)) ?? candidates[0]!;
    const factText = c.facts.find((f) => f.id === pick)?.text ?? pick;
    return { caseId: c.id, factId: pick, factText };
  }
  return null;
}

/** How a player {@link CaseClaim} lands against an NPC's epistemic state. `learn` — a truthful share
 *  (the player asserts a fact they hold; the NPC comes to know it, and any belief that fact refutes is
 *  overturned). `caught` — a lie the NPC sees through (the player DENIES a fact the NPC KNOWS true:
 *  credibility + standing damage). `noop` — a denial the NPC has no basis to catch (it does not know
 *  the fact): the lie lands socially but moves no case state and costs nothing. */
export type CaseClaimVerdict = "learn" | "caught" | "noop" | "withheld";

/**
 * The verdict for one player case claim against ONE npc (pure — the reducer/engine applies it). The
 * `factId` is always a fact the PLAYER established (grounded to `playerKnown` in the classifier), so an
 * `assert` is always truthful ⇒ the NPC LEARNS it. A `contradict` denies that same true fact — a lie,
 * CAUGHT only when this NPC already knows the fact (authored ∪ learned); against an NPC ignorant of it,
 * the denial is a `noop` (no one can prove the player wrong, so no penalty — the design's harmless bluff).
 */
export function classifyCaseClaim(
  caseDef: Case,
  runtime: CaseRuntime | undefined,
  npcId: string,
  stance: CaseClaimStance,
  factId: string,
): CaseClaimVerdict {
  if (stance === "withhold") return "withheld";
  if (stance === "assert") return "learn";
  return effectiveKnown(caseDef, runtime, npcId).includes(factId) ? "caught" : "noop";
}

/**
 * The per-NPC `# THE CASE AS YOU KNOW IT` content for ONE case (no top header — the prompt builder
 * wraps it). Knowledge and (possibly-false) beliefs render IDENTICALLY as confident knowledge — the
 * NPC cannot tell a fact from a believed herring. The culprit gets the truth + a concealment
 * directive; a caught-lying distrust rail joins at credibility ≤ {@link DISTRUST_THRESHOLD}. Returns
 * `[]` when the NPC has NO stake in this case (omit-when-empty — byte-identical prompt).
 */
export function renderCaseFileForNpc(caseDef: Case, runtime: CaseRuntime | undefined, npcId: string): string[] {
  const known = effectiveKnown(caseDef, runtime, npcId);
  const beliefs = effectiveBeliefs(caseDef, runtime, npcId);
  const asserted = assertedHerrings(caseDef, npcId);
  const isCulprit = caseDef.truth.culpritId === npcId;
  if (known.length === 0 && beliefs.length === 0 && asserted.length === 0 && !isCulprit) return [];

  const state = npcCaseStateOf(runtime, npcId);
  const factText = (id: string): string => caseDef.facts.find((f) => f.id === id)?.text ?? id;
  const herringText = (id: string): string => caseDef.redHerrings.find((h) => h.id === id)?.text ?? id;
  const assertedSet = new Set(asserted);
  const toldSet = new Set(state.toldPlayer);

  const lines: string[] = [`In the matter of "${caseDef.name}":`];
  for (const id of known) {
    const untold = toldSet.has(id) ? "" : " — you have NOT yet told the party this";
    lines.push(`- You are certain: ${factText(id)}${untold}`);
  }
  // A false belief the NPC genuinely holds — rendered as fact, NOT flagged as a guess (that is the point).
  for (const id of beliefs) {
    if (assertedSet.has(id)) continue; // knowingly-pushed herrings are covered by the culprit block
    lines.push(`- You are certain: ${herringText(id)}`);
  }
  if (isCulprit) {
    lines.push(
      `YOU did this — ${caseDef.truth.summary} CONCEAL it. Volunteer nothing that points at you; ` +
        `deflect calmly and never confess unless cornered with hard proof.`,
    );
  }
  for (const id of asserted) {
    lines.push(`- Steer suspicion toward this (you know it is a lie): ${herringText(id)}`);
  }
  if (state.credibility <= DISTRUST_THRESHOLD) {
    lines.push(`The player has been caught lying to you — weigh their claims with open suspicion.`);
  }
  // COUNT only, never the fact text: an NPC who was refused does not thereby learn what they were
  // refused. Deliberately inside the stake-gated block above — railing a stakeless NPC would start
  // feeding them a case file naming a case they know nothing about.
  const withheld = (state.withheld ?? []).length;
  if (withheld > 0) {
    lines.push(
      `The player HAS evidence in this matter and refused to show you ${withheld === 1 ? "it" : `${withheld} things`}. ` +
        `You do NOT know what it says. Press for it, bargain for it, or give less in return — but never ` +
        `speak as though you had been shown it.`,
    );
  }
  return lines;
}

/**
 * The full `# THE CASE AS YOU KNOW IT` content lines for an NPC across every ACTIVE case they have a
 * stake in (quest `active`, runtime open). The prompt builders wrap this in the header block; the
 * dialogue/autonomy callers compute it beside `whereaboutsFor`. Omit-when-empty.
 */
export function caseBriefForNpc(campaign: Campaign, state: GameState, npcId: string): string[] {
  const slice = readCasesSlice(state.modules);
  const lines: string[] = [];
  for (const c of campaign.cases) {
    if (state.quests[c.questId] !== "active") continue;
    const runtime = slice[c.id];
    if (runtime && runtime.status !== "open") continue;
    lines.push(...renderCaseFileForNpc(c, runtime, npcId));
  }
  return lines;
}

/** Terminal sentence punctuation only — closing quotes and brackets are NOT in here, see below. */
const FACT_TAIL_PUNCT_RE = /[.;,!?…\s]+$/u;

/** The opener that a given trailing mark closes. Straight quotes open and close with themselves. */
const OPENER_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{", "”": "“", "’": "‘", '"': '"', "'": "'" };

/**
 * Is the LAST character of `text` a stray closer — a mark with no opener anywhere before it? Only
 * the pair belonging to that one character is consulted, never a global balance sweep: counting
 * `'` across the whole string would call `The reeve's men said "go"` unbalanced because of the
 * possessive, and peel a perfectly good closing double quote.
 */
function trailingCloserIsStray(text: string): boolean {
  const last = text[text.length - 1]!;
  const opener = OPENER_OF[last];
  if (opener === undefined) return false;
  return !text.slice(0, -1).includes(opener);
}

/**
 * Join authored fact texts into ONE clause, stripping each one's terminal punctuation so the
 * caller's own sentence-ending period is the only one. r4 P2 shipped "…the secret he died over.."
 * because every authored fact text already ends in a stop and the template added another. Stripping
 * per-fact rather than only at the tail also keeps an interior ".;" out of a two-fact join.
 *
 * The strip class used to be `[.;,!?…"')\s]+` — greedy, and it ate the CLOSING quote/bracket along
 * with the stop, leaving the opener stranded. Both reproduced against shipped `joinFactTexts`:
 *   · `The note read "burn it".` → `The note read "burn it`
 *   · `He signed it (twice).`    → `He signed it (twice`
 * Facts are quoted verbatim into the GM's `# CASE` block and an NPC's case file, so a fact that
 * opens a quote it never closes is a grounding hazard, not a cosmetic one. Now: strip terminal
 * SENTENCE punctuation; peel a trailing closer only while it is STRAY (no opener before it); and
 * for a closer that IS matched, lift the stop out from behind it (`…over it."` → `…over it"`) so
 * the balanced pair survives AND the caller's period still stands alone.
 */
export function joinFactTexts(texts: readonly string[]): string {
  return texts
    .map((t) => {
      let out = t.trim().replace(FACT_TAIL_PUNCT_RE, "");
      // A stray closer is punctuation noise: drop it and whatever stop it was hiding.
      while (out.length > 0 && trailingCloserIsStray(out)) {
        out = out.slice(0, -1).replace(FACT_TAIL_PUNCT_RE, "");
      }
      // A MATCHED closer stays; only the stop tucked inside it goes.
      const matched = out.match(/^(.*?)([.;,!?…\s]+)(["'”’)\]}]+)$/u);
      return matched ? `${matched[1]}${matched[3]}` : out;
    })
    .filter((t) => t.length > 0)
    .join("; ");
}

export function unionStable(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  const seen = new Set(a);
  for (const x of b) if (!seen.has(x)) { out.push(x); seen.add(x); }
  return out;
}

/**
 * The thesis-grade solvability invariant, as a pure content check. Returns a list of human-readable
 * problems (empty ⇒ the case is jointly solvable BY CONSTRUCTION). Covers everything internal to the
 * {@link Case} content; the clue-manifest↔effect cross-check (does a declared clue actually carry a
 * matching `revealCaseFact` somewhere) needs the campaign's events and lives in the loader.
 */
export function checkCaseSolvability(caseDef: Case): string[] {
  const problems: string[] = [];
  const factIds = new Set(caseDef.facts.map((f) => f.id));
  const coreIds = caseDef.facts.filter((f) => f.core).map((f) => f.id);
  const required = caseDef.accusation.requiredCoreFacts;
  const culpritId = caseDef.truth.culpritId;

  // The set of facts a player can EVER learn: any clue's reveals ∪ any NPC's authored knowledge.
  const reachable = new Set<string>();
  for (const clue of caseDef.clues) for (const id of clue.revealsFactIds) reachable.add(id);
  for (const know of Object.values(caseDef.npcKnowledge)) for (const id of know.knows) reachable.add(id);

  // Clue targets and accusation facts must resolve to real facts.
  for (const clue of caseDef.clues) {
    for (const id of clue.revealsFactIds) {
      if (!factIds.has(id)) problems.push(`clue ${clue.id} reveals unknown fact ${id}`);
    }
  }
  for (const id of required) {
    if (!factIds.has(id)) problems.push(`accusation requires unknown fact ${id}`);
  }

  // Every core fact — and specifically every required-to-accuse fact — must be reachable.
  for (const id of coreIds) {
    if (!reachable.has(id)) problems.push(`core fact ${id} is unreachable (no clue reveals it, no NPC knows it)`);
  }
  for (const id of required) {
    if (factIds.has(id) && !reachable.has(id)) problems.push(`required fact ${id} is unreachable`);
  }

  // Collaboration by construction: no single NPC's authored knowledge covers the whole required set,
  // and the culprit specifically lacks at least one required fact (they can't be a solving shortcut).
  const requiredSet = new Set(required);
  if (required.length > 0) {
    for (const [npcId, know] of Object.entries(caseDef.npcKnowledge)) {
      const covers = required.every((id) => know.knows.includes(id));
      if (covers) problems.push(`npc ${npcId} single-handedly knows every required fact — no collaboration forced`);
    }
    const culpritKnows = caseDef.npcKnowledge[culpritId]?.knows ?? [];
    if (required.every((id) => culpritKnows.includes(id))) {
      problems.push(`culprit ${culpritId} knows every required fact — must lack at least one`);
    }
    void requiredSet;
  }

  // Every red herring must be refutable, and each refuter must be a real, reachable fact.
  for (const herring of caseDef.redHerrings) {
    if (herring.refutedBy.length === 0) problems.push(`red herring ${herring.id} has no refuter`);
    for (const id of herring.refutedBy) {
      if (!factIds.has(id)) problems.push(`red herring ${herring.id} refuted by unknown fact ${id}`);
      else if (!reachable.has(id)) problems.push(`red herring ${herring.id} refuter ${id} is unreachable`);
    }
  }

  return problems;
}
