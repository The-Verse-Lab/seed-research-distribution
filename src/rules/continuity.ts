/**
 * Continuity checks — the deterministic enforcement FLOOR for the Continuity Judge.
 *
 * Pure functions over (prose, ground-truth): no model, no I/O, no randomness. They compare the GM's
 * (or an NPC's) buffered prose against authoritative truth the engine already holds — the present/
 * absent cast, the NPC lines that were placed in this brief, the resolved-mechanics verdict, and the
 * reducer Commands actually authorized this turn — and return typed `Violation`s. This is the code
 * half of the "LLM proposes, code owns truth" contract applied to NARRATION: the model phrases, and
 * these functions refuse to let a phrasing assert something the world never did.
 *
 * DESIGN: deliberately CONSERVATIVE. Every check is tuned to flag only high-confidence violations so
 * a false positive never regenerates good prose; the model tier (`src/agents/judge.ts`) is the
 * arbiter that both confirms these flags and catches the semantic violations a regex cannot. A
 * verifier-model outage degrades to THIS floor (never to shipping unchecked) — so the floor errs
 * toward under-flagging, and the model errs toward recall, and the union is safe without being noisy.
 *
 * @author Runkai Zhang
 */
import type { Command } from "../world/commands.ts";
import { isNameNoiseToken, NAME_FUNCTION_WORDS, nameMentionedIn } from "./name-match.ts";
import { escapeRegExp, stripQuotedSpans } from "../util/text.ts";

/** The kinds of continuity violation the Judge can report. */
export type ViolationKind =
  | "castPresence" // a character known to be elsewhere is staged as present (folds in verifyCast)
  | "verbatimDropped" // an NPC's intended spoken line is missing from the woven prose
  | "inventedMechanics" // a dice/roll/DC claim with no resolved roll and no trigger backing
  | "phantomState" // prose asserts a world change (door opens, item taken, death) no Command authorized
  | "phantomCompanion" // prose stages a companion travelling with a SOLO player (ambient crowd as escort)
  | "spatialDrift" // prose asserts arrival at / travel to a place when no move happened this turn
  | "verbatimRepeat" // prose replays an earlier narration word-for-word (a re-greeting, a re-scene)
  | "establishedContradiction" // prose silently rewrites a prior NPC claim — model tier
  | "ledgerContradiction" // prose denies / re-litigates a fact the world's own ledger records — model tier
  | "phantomSupplies" // prose asserts the party owns/uses provisioning staples the pack does not hold
  | "timeDrift" // prose narrates a night/dawn passing on a turn whose clock did not cross one
  | "phaseDrift" // prose STAGES the current scene at a time of day contradicting the campaign clock
  | "pronounDrift" // prose flips a present character's canonical pronouns/sex (Tier-1 escalates; model arbitrates)
  | "journeyFabrication" // prose stages the scene somewhere other than where the party is, or invents routes out
  | "inventedPlayerSpeech"; // prose quotes the PC saying words the player never typed (§2.5; Tier-1 escalates, model arbitrates)

export interface Violation {
  kind: ViolationKind;
  /** The character / thing at fault (a name, an item, the claim), when there is a discrete one. */
  offender?: string;
  /** Human-readable statement of the defect (telemetry + the correction prompt). */
  detail: string;
  /** A directive fragment fed to the narrator's CONTINUITY CORRECTION on regeneration. */
  correction: string;
}

export interface ContinuityVerdict {
  violations: Violation[];
  /** False only when the semantic verifier was required but unavailable or returned unusable data. */
  semanticVerified?: boolean;
}

/** Minimal structural shape of an NPC beat's spoken line (assignable from `NpcBeat`). */
export interface BeatLike {
  name: string;
  dialogue?: string;
  lines?: { text: string }[];
}

/** Minimal structural shape of a resolved verdict (assignable from `ResolvedMechanics`). */
export interface ResolvedLike {
  label: string;
  success: boolean;
  refused?: boolean;
}

export type VerifyMode = "narration" | "whisper";

/**
 * Everything a check may need. Fields are OPTIONAL and the checks are INPUT-GATED: a `whisper` bundle
 * (no present/absent/beats/resolved) naturally runs only the state-assertion check; a `narration`
 * bundle runs the full set. One `screen()` therefore serves both the GM-prose and NPC-whisper paths.
 */
export interface VerificationBundle {
  prose: string;
  mode: VerifyMode;
  present?: string[];
  absent?: string[];
  beats?: BeatLike[];
  resolved?: ResolvedLike | null;
  /** The turn's trigger line — a number the engine embedded here (heal/damage) authorizes that number. */
  trigger?: string;
  /** Combat active (or opening this tick): suppresses the mechanics-honesty check (damage has no resolved block). */
  isCombat?: boolean;
  /** Names DOWNED this turn (authoritative `setCondition unconscious` commands) — prose that shows any
   *  of them still standing, attacking, or threatening is a phantomState violation (live r3 #1: the
   *  kill-turn prose described the just-defeated foe as "waiting"). */
  downed?: string[];
  /** Commands applied/queued this turn, already filtered to the LEGAL set (doomed commands excluded upstream). */
  authorizedCommands?: Command[];
  /** Prior NPC claims; continuity evidence only, never authoritative world truth. */
  established?: string[];
  /**
   * The world's OWN ledger of what the player has taken on (`recordBriefLines`' rows) — unlike
   * `established`, these ARE authoritative. Prose or an NPC line that denies one of them, or that
   * demands the player prove one, is a `ledgerContradiction` (playtest 07-24 P1: a companion who
   * had walked the whole arc invented "the bond was paid this morning", and the sergeant who signed
   * the bond demanded a docket for it). Omit-when-empty.
   */
  ledger?: string[];
  /** The last few emitted narration texts (oldest-first) — the verbatim-repeat check's memory. */
  recentNarrations?: string[];
  /**
   * The world's PLACE vocabulary (`placeTokensOf`), so a `<Place> <Role>` NPC name cannot be bound
   * by the map alone — r11 P1: "You reach Anchorfall by dusk." flagged the absent "Anchorfall
   * Local", and the absence floor deleted the sentence. Omitted ⇒ the pre-r11 behaviour.
   */
  placeTokens?: ReadonlySet<string>;
  /** Names of the player's actual party companions (from `partyMember`) — the phantom-companion check
   *  fires only when this is EMPTY (a solo player cannot have anyone travelling with them). */
  party?: string[];
  /** True when the player's intent this turn was MOVEMENT — buffers the turn so the spatial-drift check
   *  can regenerate a false-arrival claim even when the move degraded (no move command was issued). */
  movementAttempt?: boolean;
  /** The player entity's id — so the spatial-drift check suppresses only on the PLAYER's own move, not
   *  a bystander NPC's autonomy/routine `moveEntity` this turn (audit #8). */
  playerId?: string;
  /** Display names of everything the PLAYER actually carries — the phantom-supplies check's truth
   *  (r2 P1: "We've got your rations and water" narrated over a pack holding a staff and a hat).
   *  Omit to skip the check entirely (a whisper bundle, tests that don't care). */
  carried?: string[];
  /** Minutes this turn's commit will advance the clock — the time-drift check's truth (r2 P1: a
   *  full narrated night + dawn on a turn the clock refused). Omit to skip the check. */
  clockMinutes?: number;
  /** The day phases this turn legally spans (start phase, and end phase when the advance crosses a
   *  boundary) — the phase-drift check's truth (r3 P2: evening stew scenes narrated against a
   *  morning state for many turns). Omit to skip the check. */
  dayPhases?: string[];
  /** The player's raw typed input for this turn — the invented-player-speech check's truth
   *  (§2.5). Omit (heartbeat/system turns) to skip the check. */
  playerInput?: string;
  /** The phase the PRESENT moment lands in when a long phase-crossing advance ends at an arrival
   *  (playtest r9 F-10): a nine-hour walk spans morning→dusk, so `dayPhases` legitimizes both and
   *  the crossing skip waves the turn through — while "Morning in the Saltmarket" stages the dusk
   *  arrival in daylight. An ESCALATION TRIGGER, not a verdict: staged prose in the opposite phase
   *  class flags, and the model tier arbitrates (departure recaps are legal). Omit to skip. */
  arrivalPhase?: string;
  /** Canonical pronouns of the present cast ("Oda (he/him)") — the pronoun-drift ground truth.
   *  The model tier remains the ARBITER; the Tier-1 `checkPronounDrift` (r4 — the r3 model-only
   *  design never ran because nothing escalated flavor turns) is only an ESCALATION TRIGGER:
   *  same-sentence name + opposite pronoun, suppressed whenever any present cast member could
   *  legitimately carry that pronoun, so a hit costs one judge call and is never player-visible
   *  on its own. */
  presentPronouns?: string[];
  /**
   * Where the party ACTUALLY is, and what actually leads out of it — the journey-fabrication
   * ground truth (r4: a cot-in-the-loft rest narrated the player "waking on the east road out of
   * the city with a six-day journey ahead" while the Navigator read THE UNDERCROFT).
   *
   * `foreign` is pre-filtered by the CALLER: every legal way to name a place from here — this
   * location, its exits and their destinations, the region, the camp anchor, the gazetteer, both
   * ends of a recent journey — is subtracted before the list arrives, so this file stays pure and
   * content-free. Omit to skip the check entirely.
   */
  locale?: { here: string; exits: string[]; foreign: string[] };
  /** The party ARRIVED at `locale.here` this turn (an applied `moveParty` to it) — suppresses the
   *  journey-fabrication return-to-here arm, whose whole premise is that no such arrival happened. */
  arrivedHere?: boolean;
}

/** Below this fraction of a spoken line's words found in the prose, the line counts as dropped. */
export const VERBATIM_MIN_OVERLAP = 0.6;

/**
 * Command types that produce a player-visible, durable world change — the ones a narration could
 * assert. Used by the narrate-path BUFFER predicate: a turn that applied/queued one of these is worth
 * verifying (buffer + Judge), whereas silent bookkeeping (clock, energy, utterance patches, memory)
 * is not. Deliberately excludes the invisible mutations so a pure-flavor turn keeps live streaming.
 */
export const NARRATIVELY_SIGNIFICANT_COMMANDS: ReadonlySet<Command["type"]> = new Set<Command["type"]>([
  "moveEntity",
  "moveParty",
  "transferItem",
  "tradeWith",
  "setExitState",
  "adjustHp",
  "setCondition",
  "adjustCoins",
  "equipItem",
  "spawnEntity",
  "despawnEntity",
  "beginCaptivity",
  "endCaptivity",
  "setQuestState",
  "setObjectiveDone",
  "applyStatusEffect",
  "escalateWardrobeCoverage",
  "enrichNpc",
  "startCombat",
  "endCombat",
  "expandWorld",
  "linkExit",
  "revealCaseFact",
  "resolveCase",
]);

/** True when any command in the set would produce a player-visible durable change (buffer predicate). */
export function hasSignificantChange(cmds: Command[] = []): boolean {
  return cmds.some((c) => NARRATIVELY_SIGNIFICANT_COMMANDS.has(c.type));
}

/** Lowercase, punctuation-stripped, single-spaced — the shared normal form for word matching. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Salient (non-noise, length ≥ 3) lowercase word tokens of a name/phrase. The noise predicate is
 * the SHARED one (`src/rules/name-match.ts`), so the article/honorific table can no longer drift
 * between this floor and the eight other sites that ask the same question. Note this is still the
 * OVER-INCLUSIVE tier-1 set — it is used for place names (`checkJourneyFabrication`) and item names
 * (`mentionsName`, which the engine calls with "iron lantern"), where an ordinary English word IS
 * the identity. The person-facing checks below use the stricter binder instead.
 */
function salientTokens(name: string): string[] {
  return normalize(name)
    .split(" ")
    .filter((t) => !isNameNoiseToken(t));
}

/** True when `token` appears as a whole word in already-normalized `hay`. */
function wordPresent(hay: string, token: string): boolean {
  return new RegExp(`(?:^| )${escapeRegExp(token)}(?:$| )`).test(hay);
}

/**
 * True when `name`'s salient tokens appear in already-normalized `hay` IN ORDER AND ADJACENT — one
 * phrase, not a scatter. Connective noise ("of", "the") between them is allowed, so a name may lose
 * or gain its article between the roster and the prose ("The Widow of the Tor" ⇢ "widow of the tor",
 * "The Long Market" ⇢ "long market") without changing the answer.
 *
 * This is the PLACE-name analogue of `src/rules/name-match.ts`'s phrase tier, and it exists for the
 * same reason: against `foreign: ["The Long Market"]`, an all-salient-tokens-present test staged the
 * party in the Long Market on "You are standing in the market, and the long day is only starting."
 * (reproduced 07-27). Authored places often use ordinary nouns, so scattered tokens are
 * a coincidence and adjacency is the evidence. A name with no salient token at all ("The One") has
 * no handle here and binds nothing.
 */
function phrasePresent(hay: string, name: string): boolean {
  const tokens = salientTokens(name);
  if (tokens.length === 0) return false;
  const source = tokens.map((t) => escapeRegExp(t)).join(String.raw`(?:\s+(?:the|of|a|an|and))*\s+`);
  return new RegExp(`(?:^| )${source}(?:$| )`).test(hay);
}

/** True when every salient token of `name` appears as a whole word in `text`. */
export function mentionsName(text: string, name: string): boolean {
  const tokens = salientTokens(name);
  if (tokens.length === 0) return false;
  const hay = normalize(text);
  return tokens.every((t) => wordPresent(hay, t));
}

/**
 * SHAPE test for "this string is a character's name, not a sentence". The model judge returns a
 * free-text `offender` slot, and a live r5 turn came back with its whole explanation in it — which
 * the absence floor then printed to the player verbatim: `There is no sign of The prose references
 * 'Jessup' as a named character with a gate-post and a cart, but Jessup is not in the PRESENT list.
 * here.` A name is short and starts with a capital.
 *
 * "Short, unpunctuated, capitalized" was not enough IN EITHER DIRECTION, both reproduced 07-27:
 *   • it still passed short sentences straight to the player's screen — `looksLikeName("Jessup is
 *     not present")` and `looksLikeName("The prose references Jessup")` were both true, and the
 *     floor would have printed "There is no sign of Jessup is not present here."
 *   • it rejected three names in the original regression roster — "Osric, the Tithe-Clerk"
 *     and "Alda Umber, the Countess of Umberwick" on the comma, "The Widow of the Tor" on the
 *     four-word cap — so a genuine cast violation against any of them dropped its offender and the
 *     floor fell all the way back to the trigger echo.
 * The rule that separates the two is the one English itself uses: a NAME is a run of capitalized
 * words joined by connectives ("the", "of", "and", "von"…), and a SENTENCE has a lowercase content
 * word in it ("is", "not", "references", "prose"). Commas are allowed because authored names carry
 * them; sentence-enders and quotes are not, because a name never contains one.
 */
export function looksLikeName(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || t.length > 40) return false;
  const words = t.split(/\s+/);
  if (words.length > 6) return false;
  if (/[.!?;:"'“”()\[\]]/.test(t)) return false;
  if (!/^[A-Z]/.test(t)) return false;
  // Every word is either capitalized or a connective the shared name table already calls noise.
  return words.every((w) => {
    const bare = w.replace(/[^A-Za-z0-9'’-]/g, "");
    if (!bare) return false;
    return /^[A-Z0-9]/.test(bare) || NAME_FUNCTION_WORDS.has(bare.toLowerCase());
  });
}

/**
 * Drop only the SENTENCES that mention one of `names`, keeping the rest of the prose. The absence
 * floor's alternative is to discard the whole turn, which in the r5 run threw away the entire result
 * of a successful perception check because one sentence mentioned an absent farmer. Returns "" when
 * nothing survives, so callers can still fall through to their echo.
 *
 * This DELETES prose from the player's screen, so it takes the strict binder (`nameMentionedIn`),
 * not the over-inclusive token set: on the shipped roster the old rule cut "The room goes quiet as
 * the tide turns." out of a turn because an absent "Lys the Quiet" was on the list and the ordinary
 * adjective "quiet" counted as her name.
 */
export function stripSentencesMentioning(
  prose: string,
  names: string[],
  placeTokens?: ReadonlySet<string>,
): string {
  const binding = names.filter((n) => n.trim().length > 0);
  if (binding.length === 0) return prose.trim();
  const sentences = prose.match(/[^.!?]+(?:[.!?]+["'”’)]*|$)/g) ?? [prose];
  const kept = sentences.filter((s) => !binding.some((name) => nameMentionedIn(s, name, { placeTokens })));
  return kept.join("").replace(/\s{2,}/g, " ").trim();
}

/**
 * #2 (+ verifyCast fold) — a character on the `absent` roster (known to be elsewhere) whose name
 * appears in the prose. Over-inclusive by design: it flags any word-boundary mention, not only a
 * staged presence, because it is the FAIL-CLOSED floor for a model-tier outage. The model tier
 * refines mention-vs-staged.
 *
 * A name that SHARES any salient token with someone PRESENT is skipped whole. It used to have only
 * the shared token filtered out, which left the remainder to fire: a roster styled "Oda the
 * Wayfarer" against a present "Oda" kept `wayfarer`, so the absence floor printed "There is no sign
 * of Oda the Wayfarer here." directly under Oda's own reply (r5 P1). One shared salient token means
 * one person under two stylings far more often than it means two people. That skip keeps the
 * over-inclusive tier-1 token set, because a MISS there is what reopens the r5 bug.
 *
 * The mention test itself is the strict shared binder. "Over-inclusive by design" was never a
 * licence to bind a person on an ordinary English word: the authored NPC "Lys the Quiet" fired this
 * violation — and, through `stripSentencesMentioning`, deleted the sentence — on "The room goes
 * quiet as the tide turns.", a sentence that names nobody.
 */
export function checkCastPresence(
  prose: string,
  present: string[] = [],
  absent: string[] = [],
  placeTokens?: ReadonlySet<string>,
  /**
   * Names that SPOKE a public beat this turn. A beat is engine truth — the NPC really said it, here,
   * this tick — and `checkVerbatimDelivery` (same `screen` call, same bundle) flags the narrator for
   * DROPPING that line. Without this exemption the two checks contradict each other outright: r13
   * fixture-work t10 had Lys the Quiet speak a case fact and the autonomy module queue a departure in the
   * same narrate phase, so the queue-applied preview listed her absent while her line was still
   * required verbatim. Whoever spoke was present when they spoke; a queued exit does not retract it.
   */
  speakers: string[] = [],
  /**
   * The engine's own trigger for this turn. A name the TRIGGER hands the narrator is an authorized
   * mention — the `checkMechanicsHonesty` rule, applied to people: the travel trigger's honest
   * left-behind notice ("(Sergeant Veil stays behind — they are not travelling with you)") INSTRUCTS
   * the narrator to convey that absent NPC's absence, and the raw screen then flagged every dutiful
   * mention, pitting the correction ("do not mention") against the trigger for the whole regen
   * budget (r14, fixture-work t7: 114 s of judge churn ending in a floored echo). What this costs: a turn
   * whose trigger names an absent NPC will not ESCALATE on that name alone — the same trade
   * `checkMechanicsHonesty` makes for numbers, and the trigger only ever names them in absence.
   */
  trigger = "",
): Violation[] {
  if (!normalize(prose)) return [];
  const presentTokens = new Set(present.flatMap(salientTokens));
  const spokeTokens = new Set(speakers.flatMap(salientTokens));
  const out: Violation[] = [];
  for (const name of absent) {
    if (salientTokens(name).some((t) => presentTokens.has(t))) continue;
    if (salientTokens(name).some((t) => spokeTokens.has(t))) continue;
    if (trigger && nameMentionedIn(trigger, name, { placeTokens })) continue;
    if (nameMentionedIn(prose, name, { placeTokens })) {
      out.push({
        kind: "castPresence",
        offender: name,
        detail: `${name} is elsewhere but is referenced in the scene`,
        correction: `${name} is NOT in this scene — they are elsewhere. Do not mention, quote, stage, or move them; do not have them accompany the player.`,
      });
    }
  }
  return out;
}

/**
 * #5 — each NPC beat's intended spoken line must survive into the woven prose. Tolerant of a live
 * model's light punctuation/capitalization edits (normalized substring OR ≥ `VERBATIM_MIN_OVERLAP`
 * word overlap); flags only a line that was clearly dropped or gutted.
 */
export function checkVerbatimDelivery(prose: string, beats: BeatLike[] = []): Violation[] {
  const hay = normalize(prose);
  const out: Violation[] = [];
  for (const b of beats) {
    const spoken = (b.dialogue ?? (b.lines ?? []).map((l) => l.text).join(" ")).trim();
    if (!spoken) continue;
    const norm = normalize(spoken);
    if (!norm || hay.includes(norm)) continue;
    const toks = norm.split(" ").filter(Boolean);
    if (toks.length === 0) continue;
    const found = toks.filter((t) => wordPresent(hay, t)).length;
    if (found / toks.length < VERBATIM_MIN_OVERLAP) {
      out.push({
        kind: "verbatimDropped",
        offender: b.name,
        detail: `${b.name}'s spoken line was dropped or heavily altered: "${spoken}"`,
        correction: `Deliver ${b.name}'s exact words, staged inside your prose: "${spoken}".`,
      });
    }
  }
  return out;
}

// Dice/roll vocabulary that should never surface to the player when no roll was resolved.
const DICE_VOCAB =
  /\b(dc\s*\d+|rolls?\s+(a\s+)?(natural\s+)?\d+|rolled\s+(a\s+)?(natural\s+)?\d+|natural\s+(20|1|twenty|one)|saving\s+throw|\bd20\b|a\s+roll\s+of\s+\d+)\b/i;

/**
 * #3 — the GM narrated a dice result / roll / DC when NO roll was resolved this turn. Skipped in
 * combat (attack/spell damage travels to the GM as plain trigger text, not a resolved block) and
 * skipped whenever a resolved verdict exists (narrating that outcome is correct). A number that
 * appears verbatim in the `trigger` was engine-authored (a heal/damage echo) and is authorized.
 */
export function checkMechanicsHonesty(
  prose: string,
  resolved: ResolvedLike | null | undefined,
  trigger = "",
  isCombat = false,
): Violation[] {
  if (isCombat || resolved) return [];
  const m = prose.match(DICE_VOCAB);
  if (!m) return [];
  if (trigger && normalize(trigger).includes(normalize(m[0]))) return [];
  return [
    {
      kind: "inventedMechanics",
      detail: `Prose states a mechanic ("${m[0].trim()}") but no roll was resolved this turn`,
      correction: `Do not state any dice roll, DC, or numeric result — no roll was made. Narrate the effort and leave the outcome hanging for the roll to settle.`,
    },
  ];
}

// Fragments of the inbound-payment pattern below — the one entry too long to stay readable as a
// single literal. Each piece IS an idiom guard, which is why they are named rather than inlined:
// `PAY_QUANT` forces a counted amount, so a colour adjective ("her gold hair", "the gold-leafed
// ledger") can never read as money; `PAY_COIN` accepts only unambiguously monetary nouns (plural
// coppers/silvers, a coin purse) or a COUNTED denomination; the verb lists carry third-person and
// past inflections ONLY — admitting the bare stems would drag in both the modal offer forms ("will
// hand you fifty silver") and the PC-pays-OUT sentences the payment family above already owns; and
// `PAY_LANDING` demands the coin actually reach the player.
//
// The verb lists carry the whole DEPOSIT family (counts/drops/tosses/puts/lays/sets beside hands),
// not just the hand-off verbs: with only `hands` and the particled `counts out`, the commonest live
// phrasings walked straight through — "She counts fifty silver into your palm." was legal while the
// identical sentence WITH "out" flagged, i.e. coverage turned on an optional particle. Past forms
// are admitted only where they DIFFER from their bare stem (`counted`, `dropped`, `tossed`, `laid`):
// `put`/`set` are spelled like their own stems, so listing them would pull the modal offer ("he will
// put fifty silver into your hand when the job is done") into the landing arm.
//
// Three verb lists, because the arms differ in strength:
//   • `PAY_VERB` (the LANDING arm) takes past tense too — "she counted out fifty silver and pushed
//     it across to you" demonstrably reaches the player.
//   • `PAY_VERB_NOW` stays PRESENT-only so an NPC recalling a real past payment in dialogue ("I paid
//     you three silver last week") is never mistaken for one landing now.
//   • `PAY_VERB_HANDOFF` drives the LANDING-LESS `<verb> you <coin>` arm, and is `PAY_VERB_NOW`
//     minus the verbs with a habitual/generic reading on a direct `you`. `pays` is the big one: "the
//     run pays you thirty silver when the crates are ashore", "this work pays you two silver a day",
//     "nobody here pays you in coin up front" are terms QUOTES with no coin moved — the same class
//     the offer guard and the purchase family's price-quote guard keep legal, and the class the
//     modal form ("he will pay you fifty silver…") is pinned legal on. `puts`/`lays`/`sets` go with
//     it ("that sets you back fifty silver"). A genuinely eventive `pays` still trips the landing
//     arm, which names where the coin goes.
const PAY_QUANT =
  String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty|fifty|sixty|eighty|hundred|some|several|a\s+few|a\s+handful\s+of|a\s+(?:stack|fistful|purse|pouch|pile)\s+of)`;
const PAY_COIN =
  String.raw`(?:coins?|coppers|silvers|coin[-\s]?purse|purse\s+of\s+(?:coin|silver|gold|copper)s?|${PAY_QUANT}[-\s](?:silver|gold|copper|mark)s?)`;
const PAY_VERB_NOW =
  String.raw`(?:counts(?:\s+out)?|pushes|slides|hands|pays|presses|passes|deals\s+out|drops|tosses|puts|lays|sets)`;
const PAY_VERB_HANDOFF =
  String.raw`(?:counts(?:\s+out)?|pushes|slides|hands|presses|passes|deals\s+out|drops|tosses)`;
const PAY_VERB =
  String.raw`(?:${PAY_VERB_NOW}|counted(?:\s+out)?|pushed|slid|handed|paid|pressed|passed|dealt\s+out|dropped|tossed|laid)`;
// A surface hand-off ("across the counter") is deliberately NOT a landing: ambient market and tavern
// coin crosses counters constantly ("at the stall beside you a fishwife counts out coppers across the
// counter"), and the direction is unconstrained, so it read the player's OWN coin leaving ("the
// night-clerk slides your coins across the desk") as money arriving. Genuinely player-directed prose
// still lands here through the explicit alternatives — "across the table TO YOU", "across the counter
// INTO YOUR palm".
const PAY_LANDING =
  String.raw`(?:to\s+you\b|your\s+way\b|into\s+your\s+(?:hand|palm|purse|pack|pocket|fist|lap)\b)`;
const PAY_ADVANCE = String.raw`(?:advance|retainer|down\s+payment|earnest\s+money)`;
// The OFFER guard: a promise, offer, pledge, vow, debt or posted/quoted term is not a payment
// ("Veil promises you an advance of fifty silver on delivery" must stay legal), exactly as a quoted
// price stays legal for the purchase family. Genuinely sentence-scoped (`[^.?!]*` — Bun/JSC supports
// the unbounded variable-length lookbehind), and the stem may be followed by any non-word character,
// so "Oda offers, with the flat calm of someone who has done this a hundred times, a retainer of
// twenty silver" guards on the `offers` that is right there in the sentence.
//
// It rides ONLY the two `PAY_ADVANCE` arms, where offer-vs-payment is genuinely ambiguous. On the
// landing arms it was a liability: an unrelated idiom disabled the whole screen for its sentence
// ("She offers a nod and hands you a purse of coins", "He owes the tavern a week of rent, and hands
// you twenty gold" both went clean — a REAL phantom payment missed). Those arms do not need it:
// they demand a physical landing on the player, so "promises you fifty silver", "will pay you fifty
// silver", "owes you fifty silver" and "I paid you three silver last week" stay legal without it.
const PAY_OFFER = String.raw`(?<!\b(?:promis|offer|pledg|swear|swor|vow|owe|quot|name|list|post|advertis)\w{0,3}[^\w.?!][^.?!]*)`;
// The DEMAND guard, on the landing-LESS `<verb> you <coin>` arm only. That arm reads the coin as
// having reached the player from the verb alone, and a bill presented to the player is spelled the
// same way: "The gatewright presses you FOR five silver before the gate opens." and "He hands you a
// bill FOR two silver and waits." both flagged a phantom inbound payment — money the player was
// being ASKED for, narrated as money received. A `for` inside the same short window is the demand's
// own preposition; a genuine landing never needs it ("hands you a purse of coins for the ferry"
// puts its `for` past the coin, outside the window, and still fires).
const PAY_DEMAND = String.raw`(?![^.?!]{0,16}?\bfor\b)`;
const PAID_TO_PLAYER = new RegExp(
  String.raw`(?:` +
    String.raw`\b${PAY_VERB}\b[^.?!]{0,40}?\b${PAY_COIN}\b[^.?!]{0,32}?\b${PAY_LANDING}` +
    String.raw`|\b${PAY_VERB_HANDOFF}\s+you\b${PAY_DEMAND}[^.?!]{0,16}?\b${PAY_COIN}\b` +
    String.raw`|${PAY_OFFER}\b${PAY_ADVANCE}\b[^.?!]{0,12}\bof\s+${PAY_QUANT}\s+(?:coins?|coppers?|silvers?|silver|gold|marks?)\b` +
    String.raw`|${PAY_OFFER}\b${PAY_QUANT}[-\s](?:silver|gold|copper|mark)s?\s+${PAY_ADVANCE}\b` +
    String.raw`|\byour\s+(?:purse|pouch)\s+(?:is\s+|feels?\s+|grows?\s+|hangs?\s+)?(?:heavier|fatter)\b` +
    String.raw`)`,
  "i",
);

/**
 * NEGATION guard — the change-verb must not be under a negation in the same clause. It is spliced in
 * IMMEDIATELY before the verb (or, where several arms start with one, in front of the shared group),
 * because a lookbehind only means anything at the offset the verb actually begins.
 *
 * Reproduced against the shipped patterns (07-27 audit, §8 harden): five ordinary "the way stays
 * shut" sentences each raised a `phantomState` flag and sent the turn back for regeneration with a
 * correction telling the narrator to write what it had ALREADY written —
 *   "The door does not give way."          "The bolt will not slide free."
 *   "The gate refuses to swing open."      "The lock does not click free."
 *   "The hatch never falls open on its own."
 * — and the same blindness read a denial as a death or a hand-off: "He does not lie dead; he is
 * breathing, barely.", "Nobody falls dead here tonight.", "She does not hand you the letter.",
 * "He will not hand over the ledger."
 *
 * Two words of slack is enough for the auxiliary run a negation actually sits in ("does not give",
 * "refuses to swing", "will never quite give") and short enough that the previous clause's negation
 * cannot reach across. It over-suppresses on the rare appositive ("The door, not the gate, swings
 * open.") — the SAFE direction for a floor that is documented to err toward under-flagging, with the
 * model tier still above it.
 *
 * The gap is `(?:\s+\w+){0,2}\s+` and NOT the more natural `[^.?!]{0,24}`, for cost: a lookbehind
 * that leads an alternative is evaluated at EVERY index of the prose, and the character-count form
 * makes that 25 backtracking widths per index instead of 3. Measured on 4000 chars of ordinary
 * narration, the death pattern alone went 0.03 ms → 15.4 ms with the character form and one guard
 * per arm; the word form, with the guard hoisted in front of the arms that share it, holds it at
 * 0.6 ms. Never move a guard like this to the head of a pattern without re-timing it.
 */
const NEG_GUARD = String.raw`(?<!(?:\b(?:not|never|no|nor|neither|nobody|nothing|refuses?|refused|fails?|failed|unable)|n['’]t)\b(?:\s+\w+){0,2}\s+)`;

/**
 * `dead` is also an INTENSIFIER, and the death arm's `is (now) dead` / `falls dead` shapes cannot
 * tell the two apart on their own. Reproduced: "The room is dead quiet.", "The market is dead still
 * at this hour.", "The air is dead calm.", "The lane is dead silent.", "He is dead certain the ferry
 * ran yesterday." and "The room falls dead quiet." each asserted a phantom DEATH. The list is CLOSED
 * (same discipline as the name tables): a word missing from it merely leaves the sentence flagged as
 * before — the model tier arbitrates — and never widens the pattern.
 */
const DEAD_IDIOM_TAIL = String.raw`(?!\s+(?:quiet|quietly|still|silent|silence|calm|calmly|certain|sure|right|wrong|serious|set|drunk|asleep|tired|ahead|level|straight|slow|stop|end|ends|weight|air|ground|water|land|wood|letter|drop|reckoning|centre|center|heat|last|of\b|man['’]s|men['’]s))`;

/**
 * High-confidence phantom-state patterns. Each fires only when its prose pattern is present AND none
 * of its authorizing Command types were applied/queued this turn. Kept small and tight on purpose —
 * a false positive here regenerates good prose, so the model tier owns the nuanced cases.
 */
const STATE_PATTERNS: {
  re: RegExp;
  kinds: Command["type"][];
  label: string;
  correction: string;
  /**
   * Optional payload-aware authorizer, overriding the bare `kinds`-present check when the command
   * TYPE alone is too coarse (a heal and a killing blow are both `adjustHp`). Returns true when the
   * turn's commands genuinely authorize the prose pattern.
   */
  authorized?: (commands: Command[]) => boolean;
}[] = [
  {
    // The barrier's own motion verbs. The stem list is the pattern's whole reach, and it shipped with
    // nine — so the equally ordinary INTRANSITIVE ways a door moves walked straight through on a turn
    // that authorized nothing: "The door groans open and cold air comes in.", "The gate yawns open
    // ahead of you.", "The hatch eases open under your hand.", "The trapdoor shudders open.", "The
    // portcullis rattles open.", "The door edges open.", "The door pops open." (all MISS before, all
    // FLAG now). Only barrier-moves-itself verbs are added: a TRANSITIVE player action ("you push the
    // door open") is not added, because walking through an unlatched door emits `moveParty` and no
    // `setExitState`, so admitting it would flag ordinary movement prose every time.
    re: new RegExp(
      String.raw`\b(?:door|doors|gate|gates|hatch|grate|lock|bolt|latch|portcullis|trapdoor)\b[^.?!]{0,40}${NEG_GUARD}\b(?:swings?|creaks?|clicks?|springs?|bursts?|slides?|grinds?|falls?|breaks?|gives?|groans?|yawns?|eases?|shudders?|judders?|rattles?|scrapes?|edges?|pops?)\b[^.?!]{0,12}\b(?:open|free|wide|way|apart|inward|outward)\b` +
        String.raw`|${NEG_GUARD}\b(?:unlocks?|unbolts?|unbars?|unlatches?)\b`,
      "i",
    ),
    kinds: ["setExitState"],
    label: "a door or barrier opened / unlocked",
    correction:
      "No barrier was opened, unlocked, or broken this turn — the way remains exactly as it was. Do not describe it opening, giving way, or clicking free.",
  },
  {
    // One shared negation guard in front of the arms that need it (four separate copies cost 4× the
    // scan for the same answer); `is (now) dead` needs none, because "is not dead" cannot match a
    // pattern that demands the two words adjacent.
    re: new RegExp(
      String.raw`${NEG_GUARD}\b(?:` +
        String.raw`(?:falls?|drops?|slumps?|crumples?|collapses?)\s+(?:down\s+)?dead\b${DEAD_IDIOM_TAIL}` +
        String.raw`|lies?\s+dead\b${DEAD_IDIOM_TAIL}` +
        String.raw`|falls?\s+lifeless\b` +
        String.raw`|draws?\s+(?:their|his|her)\s+last\s+breath\b` +
        String.raw`)` +
        String.raw`|\bis\s+(?:now\s+)?(?:dead\b${DEAD_IDIOM_TAIL}|slain|killed|lifeless)\b`,
      "i",
    ),
    // A death claim is authorized ONLY by a real down-signal — a despawn, or a `setCondition` that
    // actually applies a down/dead status. Bare `adjustHp` is EXCLUDED: it fires on every heal/graze/
    // kill alike, so keying off it let a non-lethal hit (e.g. a wounding spell mid-combat) authorize a
    // phantom death that the "corpse" then contradicts by acting next turn (audit #9). A genuine down
    // always co-emits `setCondition unconscious` (combat swing + spell-cast down paths).
    kinds: ["setCondition", "despawnEntity"],
    label: "a character died",
    correction:
      "No one died or fell this turn. Do not narrate a death, a killing blow, or a body dropping — the character is still on their feet.",
    authorized: (commands) =>
      commands.some(
        (c) =>
          c.type === "despawnEntity" ||
          (c.type === "setCondition" &&
            c.active !== false &&
            ["unconscious", "dead", "dying", "downed"].includes(c.condition)),
      ),
  },
  {
    // `hand` is a NOUN as often as it is a verb, and a BARE STEM as often as a finite one, so the
    // "over the" arm asserted a completed transfer on all four of these (reproduced 07-27):
    //   "She warms her hands over the brazier."      "He rubs his hands over the map, thinking."
    //   `"Hand over the coin," she says.`            "She wants you to hand over the writ."
    // Two guards, because they are two different mistakes:
    //   • the NOUN reading always carries a determiner of its own ("her/his/their/your/both hands"),
    //     and the verb reading never can — its subject is a name or a noun ("the drover hands
    //     over…") — so a possessive/quantifier immediately before it disqualifies the match;
    //   • a DEMAND and an intention are spelled with the bare stem ("hand over"), an EVENT with the
    //     finite verb ("hands over") or an explicit second-person subject ("you hand over"). An NPC
    //     ordering the player to hand something over has moved nothing yet.
    // Every genuine hand-off still fires: "Oda hands you the letter.", "The drover hands over the
    // ledger.", "You hand over the writ and she reads it.", "He hands it to you."
    // `lift` left the take-verb list (r12): as a steal-synonym it is rare, and as RAISE it is
    // everywhere — "You lift the flame high" (a carried brand, held up to see) asserted a phantom
    // hand-off. The unambiguous take verbs stay; a genuine prose theft is the model tier's call.
    re: new RegExp(
      String.raw`\byou\s+(?:pocket|stow|snatch|pilfer|claim)\s+(?:the|a|an|his|her|their|its)\b` +
        String.raw`|${NEG_GUARD}(?<!\b(?:her|his|its|their|your|my|our|the|these|those|both|two)\s)\b(?:hands?\s+(?:you\s+the|it\s+to\s+you)|hands\s+over\s+the|you\s+hand\s+over\s+the)\b` +
        String.raw`|\bslips?\s+(?:it|the\b[^.?!]{0,20})\s+into\s+your\b` +
        String.raw`|\bdrops?\s+(?:it|the\b[^.?!]{0,20})\s+into\s+your\s+(?:pack|pocket|palm|hand|bag)\b`,
      "i",
    ),
    kinds: ["transferItem", "tradeWith", "beginCaptivity", "endCaptivity"],
    label: "an item changed hands",
    correction:
      "No item changed hands this turn. Do not describe taking, receiving, pocketing, or being handed anything.",
  },
  // The phantom-payment family (live 07-18 #1: "the two silver coins clink… Stew's on the hook"
  // narrated over an unchanged purse). Prose asserting coins were PAID or physically changed hands,
  // authorized only by a real coin/trade command. Second-person payment verbs demand a currency word
  // nearby; the clink/imagery arm requires a coin noun AND a directional landing so ambient jingling
  // stays legal.
  //
  // TWO things this comment used to CLAIM and the pattern did not do (both reproduced 07-27):
  //  • "'you pay attention' / 'pay a heavy toll' never trip" held only while no currency word was in
  //    reach. "You pay no mind to the tab the drunk is running." and "You pay attention to the fee
  //    chalked on the board." both flagged. The metaphor objects are now a closed lookahead on `pay`
  //    itself, so the idiom is excluded by its OBJECT rather than by luck.
  //  • the imagery arm's coin noun was `coins?|coppers?|silvers?|gold` — bare `gold` and singular
  //    `silver` are COLOURS as much as currency, so "Her gold hair spills across the pillow.", "The
  //    gold light of the lamp spills into the room.", "Lamplight, thin and silver, scatters across
  //    the water." and "Gold thread scatters across the table as she cuts it." each asserted a
  //    phantom payment. It now takes `PAY_COIN`, the same unambiguously-monetary noun set the
  //    inbound family already uses (plural coppers/silvers, coins, a purse, a COUNTED denomination),
  //    so "The coins clink into the bowl." still fires and a colour never does.
  {
    re: new RegExp(
      String.raw`\byou\s+(?:pay(?!\s+(?:attention|heed|homage|court|respects?|no\s+(?:mind|heed|attention)|(?:close|little|scant)\s+attention))|hand\s+over|count\s+out)\b[^.?!]{0,50}\b(?:coins?|coppers?|silvers?|gold|fee|fare|tab|bill)\b` +
        String.raw`|\b${PAY_COIN}\b[^.?!]{0,32}\b(?:clink|chink|spill|scatter)(?:s|ing|ed)?\b[^.?!]{0,28}\b(?:into|onto|across)\b` +
        String.raw`|\byour\s+purse\s+(?:is\s+|feels?\s+|grows?\s+)?(?:lighter|thinner)\b` +
        String.raw`|\bcoins?\s+chang(?:e|ed|ing)\s+hands\b`,
      "i",
    ),
    kinds: ["adjustCoins", "tradeWith"],
    label: "coins were paid or changed hands",
    correction:
      "No coins actually moved this turn — the player's purse is unchanged and no payment completed. The offer or gesture may stand, but do not narrate payment being accepted, coins landing in anyone's hand, or a purse growing lighter.",
  },
  // The phantom INBOUND-payment family (live 07-24 #D1: "a 50-silver advance handed over at signing"
  // narrated over a quest ACCEPT that moved no coin at all — quest coin is paid exclusively by
  // `grantQuestReward` on `state === "complete"`, and the accept branch only sets the quest state).
  // Every arm of the payment family above is PC-pays-OUT, so an NPC paying the PLAYER was entirely
  // unscreened; on an otherwise quiet turn `shouldEscalate` (src/agents/judge.ts) then declines to
  // wake the model tier, and the invented coin entered the fiction unchallenged — the player went on
  // to believe they were carrying money they had never been given. Three shapes: an NPC verb landing
  // coin ON the player, an "advance/retainer/down payment of N <currency>", and a purse growing
  // heavier. See the PAY_* fragments above for the idiom guards that keep "pay attention", "pays
  // off", "a heavy toll", "hands you a letter" (an item — that is the transferItem pattern) and any
  // promised-on-delivery sum legal.
  {
    re: PAID_TO_PLAYER,
    kinds: ["adjustCoins", "tradeWith"],
    label: "coins were paid TO the player",
    correction:
      "No coin actually moved this turn — the player's purse is unchanged. The offer, promise, or gesture may stand, but do not narrate a payment landing, coin being counted into the player's hand, or a purse growing heavier.",
  },
  // The phantom-purchase family (r4 #2 / 07-18 #1): prose closing a sale that no `tradeWith` (or
  // coin movement) performed. "you buy it/the X" is completion phrasing; the idiom guard keeps
  // "buy time / buy a moment" legal. Offer-phrasing ("it's yours for two silver") is deliberately
  // NOT matched — a vendor quoting a price is legitimate negotiation, not a completed sale.
  {
    re: /\byou\s+(?:buy|purchase)\s+(?:(?:the|a|an)\s+(?!time\b|moment\b)|it\b|some\s+(?!time\b))|\b(?:deal|sale|purchase|bargain|transaction)\s+(?:is\s+)?(?:done|struck|sealed|made|complete|completed)\b|\bsold\s+(?:it|the\b[^.?!]{0,24})\s+to\s+you\b/i,
    kinds: ["tradeWith", "adjustCoins"],
    label: "a purchase or sale completed",
    correction:
      "No purchase or sale completed this turn — no goods and no coin moved. Keep the negotiation open: do not narrate the deal closing, goods being handed over, or payment settling.",
  },
];

/**
 * #1 — prose asserts a durable world change that no reducer Command authorized this turn (the silent
 * narration↔state desync). `authorizedCommands` must already be the LEGAL set (the caller excludes
 * commands whose dry-run would reject, so a doomed NPC action can never launder a phantom claim).
 */
export function checkStateAssertions(prose: string, authorizedCommands: Command[] = []): Violation[] {
  const kinds = new Set(authorizedCommands.map((c) => c.type));
  const out: Violation[] = [];
  for (const p of STATE_PATTERNS) {
    if (!p.re.test(prose)) continue;
    const authorized = p.authorized ? p.authorized(authorizedCommands) : p.kinds.some((k) => kinds.has(k));
    if (!authorized) {
      out.push({
        kind: "phantomState",
        detail: `Prose asserts ${p.label} but no command authorized it this turn`,
        correction: p.correction,
      });
    }
  }
  return out;
}

/** Minimum exact word-run shared with a recent narration for `verbatimRepeat` to fire. */
export const VERBATIM_REPEAT_MIN_RUN = 12;

/** Longest common CONTIGUOUS token run between two token arrays (classic DP, rolling row). */
function longestCommonRun(a: string[], b: string[]): string[] {
  let best = 0;
  let bestEnd = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = (prev[j - 1] ?? 0) + 1;
        if ((cur[j] ?? 0) > best) {
          best = cur[j] ?? 0;
          bestEnd = i;
        }
      }
    }
    prev = cur;
  }
  return a.slice(bestEnd - best, bestEnd);
}

/**
 * Verbatim repetition — the candidate shares a ≥ `VERBATIM_REPEAT_MIN_RUN`-word EXACT run with a
 * recent narration (live 07-18 #3: Sela's greeting replayed word-for-word a scene later). Twelve
 * exact words in a row is string identity, not stylistic echo, so this is deterministic-authoritative:
 * the model tier confirms semantics elsewhere but has nothing to arbitrate here. A run contained in a
 * REQUIRED NPC beat line is exempt — those lines MUST repeat verbatim by contract.
 */
export function checkVerbatimRepeat(
  prose: string,
  recentNarrations: string[] = [],
  beats: BeatLike[] = [],
): Violation[] {
  const hay = normalize(prose).split(" ").filter(Boolean);
  if (hay.length < VERBATIM_REPEAT_MIN_RUN) return [];
  const beatTexts = beats
    .map((b) => normalize(b.dialogue ?? (b.lines ?? []).map((l) => l.text).join(" ")))
    .filter(Boolean);
  for (const recent of recentNarrations) {
    const old = normalize(recent).split(" ").filter(Boolean);
    if (old.length < VERBATIM_REPEAT_MIN_RUN) continue;
    const run = longestCommonRun(hay, old);
    if (run.length < VERBATIM_REPEAT_MIN_RUN) continue;
    const snippet = run.join(" ");
    if (beatTexts.some((b) => b.includes(snippet))) continue;
    return [
      {
        kind: "verbatimRepeat",
        detail: `Prose repeats earlier narration word-for-word ("${snippet.length > 90 ? `${snippet.slice(0, 90)}…` : snippet}")`,
        correction:
          "You are replaying an earlier moment word-for-word — that scene was already shown and must not repeat. Write FRESH prose for what is NEW this turn only: no re-greeting, no restating prior offers or prices, no replaying any earlier exchange.",
      },
    ];
  }
  return [];
}

// Accompaniment phrasing — a claim that someone TRAVELS WITH the player. Kept tight (explicit
// "with you" / "beside you" / "your companions" forms) so ordinary crowd prose ("the crowd presses
// AROUND you") never trips it. Ambiguous "followed you" / "joined you" are deliberately excluded.
// The "(at|by) your side" form REQUIRES a person-indicating motion verb (walks/keeps pace/lingers
// …) shortly before it. The old BARE form matched worn gear/objects ("your dagger hangs at your side",
// "the tankard sits by your side"), so a SOLO player's ordinary equipment prose tripped a
// phantomCompanion flag and got needlessly regenerated toward stilted "you are alone" phrasing (audit
// #15). The verb guard keeps a real person-at-your-side ("a woman keeps pace at your side") while
// dropping gear (hangs/sits/rests — not accompaniment verbs).
//
// That verb list still let the gear back in through its STATIC members (07-27 audit, reproduced):
// "Your cloak stays at your side, sodden." flagged a phantom companion, and `remain`/`stand` carry
// the same object reading ("a stack of crates stands at your side"). Objects stay, remain and stand
// exactly as they hang and sit — so the arm now takes LOCOMOTION verbs only, the ones that mean the
// subject is moving ALONG WITH the player. `linger` survives because a lantern does not linger. What
// this costs is a bystander merely STANDING beside a solo player, which is not the accompaniment
// claim the check exists for; the model tier still sees the turn. `press` went with them: it was
// already dead here anyway (`press` + the `(?:s|ing)?` suffix cannot spell "presses"), and ambient
// crowd is the one thing this check must never call a companion.
// `walk(?:s|ing)? with you` is ADDED for the opposite reason — it is the plainest accompaniment
// phrasing in English and only the "beside/alongside" spellings were covered.
const COMPANION_PHRASE =
  /\b(?:accompan(?:y|ies|ied|ying)\s+you|travell?(?:s|ing)?\s+(?:with|beside|alongside)\s+you|fall(?:s|ing|en)?\s+into\s+step\s+(?:with|beside|alongside)\s+you|walk(?:s|ing)?\s+(?:with|beside|alongside)\s+you|(?:walk|stride|march|pad|jog|ride|keep|linger|hurr(?:y|ies|ying))(?:s|ing)?\s+(?:\w+\s+){0,3}(?:at|by)\s+your\s+side|your\s+(?:companions?|escort|entourage|retinue))\b/gi;

// A DENIAL of accompaniment is the OPPOSITE of the claim this check exists for. The engine's own
// left-behind notice — "Brann Coldwater stays behind — they are not travelling with you" — matched
// the accompaniment arm verbatim and shipped a phantomCompanion violation against engine truth (r13,
// fixture-combat t8 + fixture-work t18); a narrator repeating that fact in its own words does the same.
// Scanned as a BACKWARD look over the clause rather than a lookbehind glued to the pattern head: the
// pattern already leads with an alternation, and the NEG_GUARD note above measures what a leading
// lookbehind costs there (0.03 ms → 15.4 ms on 4000 chars). Clause = back to the nearest sentence or
// dash break, so "not" from a previous sentence cannot excuse a real escort claim.
const COMPANION_NEGATOR = /\b(?:not|never|no|nobody|none|without)\b|n['’]t\b/i;
const CLAUSE_BREAK = /[.!?;:—–]/g;

/** Whether the prose makes an UN-negated accompaniment claim. */
function companionClaimIn(prose: string): boolean {
  COMPANION_PHRASE.lastIndex = 0;
  for (const m of prose.matchAll(COMPANION_PHRASE)) {
    const at = m.index ?? 0;
    let clauseStart = 0;
    CLAUSE_BREAK.lastIndex = 0;
    for (const b of prose.slice(0, at).matchAll(CLAUSE_BREAK)) clauseStart = (b.index ?? 0) + 1;
    if (!COMPANION_NEGATOR.test(prose.slice(clauseStart, at))) return true;
  }
  return false;
}

/**
 * A phantom companion — prose staging someone TRAVELLING WITH the player when the party is empty (the
 * reported "four locals followed me from the start": ambient crowd narrated as an escort). Fires ONLY
 * when the player is SOLO (no party companion present), where an accompaniment claim is unambiguously
 * false; with real companions present the phrasing may be legitimate and the model tier disambiguates.
 */
export function checkPhantomCompanion(prose: string, party: string[] = []): Violation[] {
  if (party.length > 0) return [];
  // Accompaniment is a STAGING claim, and staging is the narrator's business (the checkPhaseDrift
  // precedent): an NPC saying "I'll take that walk with you" is an OFFER of company, not company
  // (r12, fixture-travel t1 — a recruit pitch flagged a phantom escort). Quoted spans are excluded; the
  // narrator's own "she falls into step beside you" still fires.
  const stripped = stripQuotedSpans(prose);
  if (!companionClaimIn(stripped)) return [];
  return [
    {
      kind: "phantomCompanion",
      detail: "Prose stages a companion travelling with the player, but the party is empty (the player is alone)",
      correction:
        "The player travels ALONE — no one accompanies them. Do not describe anyone travelling with, accompanying, or falling into step beside the player, and do not call anyone their companion. Any locals nearby are passing background, not party.",
    },
  ];
}

// Arrival/travel phrasing — a claim the player reached or entered a NEW place. Tight forms only, so
// ordinary in-place prose ("you step to the window", "you reach for the cup") never trips it.
const ARRIVAL_PHRASE =
  /\byou\s+(?:arrive\s+(?:at|in)|make\s+your\s+way\s+(?:in)?to\s+(?:the|a|an)|find\s+yoursel(?:f|ves)\s+(?:standing\s+)?(?:in|at|before|inside)\s+(?:the|a|an|another)|step\s+out\s+into\s+(?:the|a|an)|cross\s+(?:the\s+threshold\s+)?into\s+(?:the|a|an))\b/i;

// The r10 F-1 tail of the same claim, in two shapes the tight forms miss:
//  · an NPC WALKS the player somewhere ("he leads you up out of the market's racket into the
//    tilted plazas", "she brings you to the shrine", "you follow him into the underhall") — the
//    dominant shape of the fixture-social six-turn excursion, invisible to a you-subject regex;
//  · a you-subject motion verb into a CAPITALIZED named place ("you push into the Wreck and
//    Riddle", "you head into the Saltmarket"). The capital requirement is the precision gate:
//    "you push into the crowd" and "you step into the lamplight" are in-place color and must
//    survive; a proper-noun object is a location claim.
const LED_ARRIVAL_PHRASE =
  /\b(?:lead(?:s|ing)?|walk(?:s|ing)?|guide(?:s|ing)?|bring(?:s|ing)?|steer(?:s|ing)?)\s+you\s+(?:[\w'’-]+\s+){0,6}?into\s+(?:the|a|an)\b|\byou\s+follow\s+(?:[\w'’-]+\s+){0,3}?into\s+(?:the|a|an)\b/i;
const NAMED_ARRIVAL_PHRASE =
  /\b[Yy]ou\s+(?:push(?:\s+your\s+way)?|step|duck|head|turn|slip|make\s+it)\s+(?:out\s+)?(?:in)?to\s+(?:the\s+|a\s+|an\s+)?[A-Z]/;

/** Whether one sentence claims the player reached/entered/was walked into a place. */
export function claimsArrival(sentence: string): boolean {
  return (
    ARRIVAL_PHRASE.test(sentence) || LED_ARRIVAL_PHRASE.test(sentence) || NAMED_ARRIVAL_PHRASE.test(sentence)
  );
}

/**
 * Spatial drift — prose asserts the party ARRIVED at or entered a new place when NO travel happened
 * this turn (no move/expand command authorized). The narrator claiming a location change the engine
 * did not make — the exact desync the open-world reach degrade is designed to avoid. Skipped in combat
 * (positional "you reach the wight" is melee, not travel) and whenever a real move DID occur.
 */
export function checkSpatialDrift(
  prose: string,
  authorizedCommands: Command[] = [],
  isCombat = false,
  playerId?: string,
): Violation[] {
  if (isCombat) return [];
  const kinds = new Set(authorizedCommands.map((c) => c.type));
  // A bystander NPC's own `moveEntity` (autonomy/routines wander) is NOT proof the PLAYER travelled —
  // suppress only on the PLAYER's own move (captivity/defeat teleports use `moveEntity` for the PC),
  // else a single ambient NPC step silently disabled this guard on the exact turn it was built for
  // (a proactive NPC moved + the GM hallucinated an arrival). (audit #8)
  const playerMoved = authorizedCommands.some((c) => c.type === "moveEntity" && c.entityId === playerId);
  if (kinds.has("moveParty") || kinds.has("expandWorld") || kinds.has("linkExit") || playerMoved) return [];
  if (!claimsArrival(prose)) return [];
  return [
    {
      kind: "spatialDrift",
      detail: "Prose asserts the party arrived at or entered a place, but no travel happened this turn",
      correction:
        "The party did NOT travel this turn and is still in the same location. Do not describe arriving at, entering, reaching, or setting out for another place; narrate what happens where the player already stands.",
    },
  ];
}

/**
 * r10 F-1 rail — the enforcement half of {@link checkSpatialDrift}, always on. The Continuity
 * Judge is opt-in and the turn auditor is telemetry, so this class shipped fifteen relocations in
 * the r10 sweep and every castPresence violation downstream followed the moved fiction. A freeform
 * turn may invent detail; it may NOT narrate arrival: drop exactly the sentences that claim one
 * (the r6 absence-floor pattern — offending sentences only, the rest of the turn survives), and
 * return "" when nothing survives so the caller falls to its deterministic echo. Suppressed by the
 * same authorized-travel evidence as the check — a real move keeps its arrival prose.
 */
export function scrubUnauthorizedArrival(
  prose: string,
  authorizedCommands: Command[] = [],
  isCombat = false,
  playerId?: string,
): string {
  if (checkSpatialDrift(prose, authorizedCommands, isCombat, playerId).length === 0) return prose;
  const scrubbed = prose
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split(/(?<=[.!?…]["”’']?)\s+/)
        .filter((sentence) => !claimsArrival(sentence))
        .join(" ")
        .trim(),
    )
    .filter((paragraph) => paragraph.length > 0);
  return scrubbed.join("\n\n").trim();
}

/**
 * The deterministic Tier-1 pass: run every check whose inputs the bundle carries. Narration bundles
 * exercise the full set; whisper bundles (the NPC's own first-person voice) exercise only the
 * state-assertion check — the established-fact contradiction check for whispers is semantic and lives
 * in the model tier.
 */
/** Second-person staging: the prose is asserting where the scene IS, not remembering or planning. */
const HERE_STAGING_RE =
  /\byou\s+(?:are|stand|sit|wait|lie|linger|crouch|kneel|find\s+yoursel(?:f|ves))\b|\bhere\s+(?:in|on|at)\b|\baround\s+you\b/i;

/**
 * Proper-noun evidence for a FOREIGN place bind whose salient handle is a single ordinary word.
 *
 * "The Old Quarter" reduces to the one salient token "quarter" ("old" is name-table noise), and a
 * one-token phrase match is no phrase at all — it bound "Around you the quarter goes about its
 * business" (the district the party is standing IN) and "you … quarter the visible roads" (the
 * VERB) as stagings of a place across the map (r12, fixture-combat t4 / fixture-travel t14). English marks
 * the difference itself: a NAME is capitalized in prose, a common noun/verb is not. Multi-token
 * names keep the adjacency rule unchanged — the phrase is already the evidence there.
 */
function placeNameEvidenced(sentence: string, name: string): boolean {
  const tokens = salientTokens(name);
  if (tokens.length !== 1) return true;
  const t = tokens[0]!;
  return new RegExp(String.raw`(?:^|[^A-Za-z])${t[0]!.toUpperCase()}${escapeRegExp(t.slice(1))}(?:$|[^a-z])`).test(
    sentence,
  );
}

/**
 * #journeyFabrication Tier-1 — an ESCALATION TRIGGER (the `pronounDrift` doctrine), covering the
 * gap `spatialDrift` is structurally blind to. `spatialDrift` asks "did you claim to ARRIVE on a
 * turn with no move?"; this asks "are you claiming to BE somewhere else, or offering roads that do
 * not exist?" The r4 defect contained no arrival verb at all, and any real move this turn
 * SUPPRESSES spatialDrift entirely — which is precisely when prose about the wrong destination is
 * most dangerous. So this check reads the current location, never the authorized-command set, and
 * `movementAttempt` deliberately does not silence it: a move to A narrated as a move to B is the
 * defect, not an exemption.
 *
 * Two sub-checks, one violation per prose:
 *  1. DISPLACEMENT — a distance/direction/return-to phrase anchored on the place the party is IN
 *     ("some miles west of Vellmere", "back east to Vellmere", "outside the Undercroft"). Needs no
 *     content at all, which is why it is the reliable half.
 *  2. FOREIGN STAGING — one sentence carrying both a present-scene locative and a foreign location
 *     name, the name matched as a PHRASE (`phrasePresent`). Authored places can be generic-noun
 *     phrases ("The Long Market", "The Deep Hall", "The Auction Yard"), so neither a `some()` match
 *     ("around you the yard is quiet") nor an every-token-somewhere match ("standing in the market,
 *     and the long day is only starting") is evidence — only adjacency is.
 */
export function checkJourneyFabrication(
  prose: string,
  locale?: VerificationBundle["locale"],
  /** The party genuinely arrived at `here` THIS turn (an applied `moveParty` to it) — real arrival
   *  prose legally says "the road delivers you back into <here>", so the return-to-here arm is
   *  suppressed (r12: a true east-road return to Anchorfall flagged its own arrival). */
  arrivedHere = false,
): Violation[] {
  const here = locale?.here?.trim();
  if (!here) return [];
  const correction =
    `The scene is IN ${here} — the party has not left it. Do not stage this moment on a road, at a ` +
    `distance or direction from ${here}, or in any other place` +
    (locale!.exits.length > 0
      ? `, and offer no route out of here except: ${locale!.exits.join("; ")}.`
      : `.`) +
    ` Narrate what is actually here.`;

  const anchor = escapeRegExp(here);
  const DIR = "north|south|east|west|north-?east|north-?west|south-?east|south-?west|upriver|downriver";
  // A ROAD word is required between a direction and an "out of" — otherwise "the north wall of the
  // Undercroft" and "the east gate of the Undercroft" (interior features, perfectly legal) flag.
  const ROAD = "road|roads|track|tracks|path|paths|way|lane|stair|stairs|trail|route|gate";
  const displacement = [
    // "some miles west of X", "two hours short of X"
    new RegExp(`\\b(?:miles?|leagues?|hours?|days?|paces?)\\s+(?:\\w+\\s+){0,3}(?:of|from|outside|beyond|past|short of)\\s+(?:the\\s+)?${anchor}\\b`, "i"),
    // "west of X" — the bare compass form
    new RegExp(`\\b(?:${DIR})\\s+(?:of\\s+)?(?:the\\s+)?${anchor}\\b`, "i"),
    // "the east road out of X" — the r4 cot-to-camp shape
    new RegExp(`\\b(?:${DIR})?\\s*(?:${ROAD})\\s+(?:out of|away from|leading (?:out )?(?:of|from)|from)\\s+(?:the\\s+)?${anchor}\\b`, "i"),
    // "outside X", "beyond X", "well past X" — with the two readings that are NOT displacement
    // subtracted (both reproduced 07-27, `here = "The Undercroft"`):
    //   • a possessive names a FEATURE OF here, not a position relative to it. "You look past the
    //     Undercroft's altar to the far wall." and "someone shouts past the Undercroft's inner door"
    //     staged the scene exactly where the party stands, and flagged. The guard rides this arm
    //     ONLY: on the compass arm a possessive is still displacement ("miles west of Vellmere's
    //     walls" is genuinely outside Vellmere).
    //   • "FROM outside X" is something reaching the party from beyond the walls, which places them
    //     INSIDE. "The noise from outside the Undercroft never quite stops." flagged.
    new RegExp(`(?<!\\bfrom\\s)\\b(?:outside|beyond|past|away from|out of)\\s+(?:the\\s+)?${anchor}\\b(?!['’]s)`, "i"),
    // "back east to X" — offering a return to the place you are standing in. Suppressed on a turn
    // that ARRIVED here: "The west road delivers you back into Anchorfall" over a real moveParty is
    // the arrival, not a fabrication (r12).
    ...(arrivedHere ? [] : [new RegExp(`\\bback\\s+(?:\\w+\\s+)?(?:to|toward|towards|into)\\s+(?:the\\s+)?${anchor}\\b`, "i")]),
  ];
  // Staging is the NARRATOR's business (the checkPhaseDrift precedent): a quoted NPC line is where
  // plans and offers get said out loud — "if you're of a mind to walk out of Anchorfall, I'll take
  // that walk with you" is an OFFER, not the scene leaving Anchorfall (r12, fixture-travel t1). The model
  // tier still sees the full prose, so a spoken invented-route claim stays its call.
  const staged = stripQuotedSpans(prose);
  if (displacement.some((re) => re.test(staged))) {
    return [
      {
        kind: "journeyFabrication",
        offender: here,
        detail: `Prose stages the scene at a distance or direction from ${here}, which is where the party actually is`,
        correction,
      },
    ];
  }

  for (const sentence of staged.split(/(?<=[.!?])\s+/)) {
    if (!HERE_STAGING_RE.test(sentence)) continue;
    const hay = normalize(sentence);
    if (!hay) continue;
    for (const name of locale!.foreign) {
      if (phrasePresent(hay, name) && placeNameEvidenced(sentence, name)) {
        return [
          {
            kind: "journeyFabrication",
            offender: name,
            detail: `Prose stages the present scene at ${name}, but the party is in ${here}`,
            correction,
          },
        ];
      }
    }
  }
  return [];
}

// PC speech-attribution shapes, both quote styles: `you say, "…"` / `"…," you murmur`. The verb
// list is deliberately the common dialogue tags only — staging verbs ("you nod", "you reach")
// carry no quote and never match.
const PC_SPEECH_VERBS =
  "say|says|said|reply|replies|replied|murmur|murmurs|mutter|mutters|whisper|whispers|call|calls|answer|answers|ask|asks|offer|offers|tell|tells|breathe|breathes|manage|manages|add|adds|snap|snaps|growl|growls";
// Real quoted spans only, PAIRED like `stripQuotedSpans` pairs them. The old window regexes keyed
// on any single quote character, so between two adjacent NPC lines the CLOSING quote of one and the
// OPENING quote of the next read as a span — `…helm." She nods at the door. "You tell me…` flagged
// the unquoted stage direction ` She nods at the door. ` as the player's invented speech, because
// the NPC's next line happened to start with "You tell" (r12, fixture-social t9).
const QUOTE_SPAN_RE = /"([^"]*)"|“([^”]*)”/g;
const PC_ATTRIB_BEFORE_RE = new RegExp(String.raw`\byou\s+(?:${PC_SPEECH_VERBS})\b[^"“.!?]{0,40}$`, "i");
const PC_ATTRIB_AFTER_RE = new RegExp(String.raw`^[,—–\s]*you\s+(?:${PC_SPEECH_VERBS})\b`, "i");

/**
 * #inventedPlayerSpeech (PROSE-TO-CODE §2.5) — narration QUOTING the PC saying words the player
 * never typed. The prompt rule ("quoted PC lines must be substrings of real input") had no check;
 * the run-6 report caught the GM inventing a full spoken line for Tam. Tier-1 here is an
 * ESCALATION TRIGGER, not a verdict (the pronounDrift precedent): a quoted span attributed to the
 * player that is not a substring of their real input flags, and the model tier arbitrates — a
 * legitimate paraphrase or an NPC echoing the player costs one judge call, never a regen. One-word
 * spans are skipped ("Yes," you manage — harmless glue the model adds constantly).
 */
export function checkPlayerQuoteFidelity(prose: string, playerInput?: string): Violation[] {
  if (playerInput === undefined) return [];
  const input = normalize(playerInput);
  QUOTE_SPAN_RE.lastIndex = 0;
  for (const m of prose.matchAll(QUOTE_SPAN_RE)) {
    const raw = m[1] ?? m[2] ?? "";
    const span = normalize(raw);
    if (span.split(" ").filter(Boolean).length < 2) continue;
    if (input.includes(span)) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    // Attribution windows around the PAIRED span: `you say, "…"` before the open quote, or
    // `"…," you murmur` after the close — the same shapes the old regexes accepted.
    const attributed =
      PC_ATTRIB_BEFORE_RE.test(prose.slice(Math.max(0, start - 60), start)) ||
      PC_ATTRIB_AFTER_RE.test(prose.slice(end, end + 40));
    if (!attributed) continue;
    return [
      {
        kind: "inventedPlayerSpeech",
        detail: `Prose quotes the player saying "${raw.slice(0, 80)}" — words they never typed`,
        correction:
          "Do not put quoted words in the player's mouth. The player speaks only what they actually typed; keep their real words, or narrate their intent without inventing a spoken line for them.",
      },
    ];
  }
  return [];
}

export function screen(bundle: VerificationBundle): Violation[] {
  const out: Violation[] = [];
  if (bundle.mode === "narration") {
    out.push(
      ...checkCastPresence(
        bundle.prose,
        bundle.present,
        bundle.absent,
        bundle.placeTokens,
        (bundle.beats ?? []).map((b) => b.name),
        bundle.trigger,
      ),
    );
    out.push(...checkVerbatimDelivery(bundle.prose, bundle.beats));
    out.push(...checkMechanicsHonesty(bundle.prose, bundle.resolved ?? null, bundle.trigger, bundle.isCombat));
    out.push(...checkPhantomCompanion(bundle.prose, bundle.party));
    out.push(...checkSpatialDrift(bundle.prose, bundle.authorizedCommands, bundle.isCombat, bundle.playerId));
    out.push(...checkVerbatimRepeat(bundle.prose, bundle.recentNarrations, bundle.beats));
    out.push(...checkPhantomSupplies(bundle.prose, bundle.carried));
    out.push(...checkTimeDrift(bundle.prose, bundle.clockMinutes));
    out.push(...checkPhaseDrift(bundle.prose, bundle.dayPhases, bundle.clockMinutes, bundle.arrivalPhase));
    out.push(...checkPronounDrift(bundle.prose, bundle.presentPronouns));
    out.push(...checkJourneyFabrication(bundle.prose, bundle.locale, bundle.arrivedHere === true));
    out.push(...checkPlayerQuoteFidelity(bundle.prose, bundle.playerInput));
  }
  out.push(...checkStateAssertions(bundle.prose, bundle.authorizedCommands));
  return out;
}

/**
 * Provisioning staples prose loves to hand the party for free (r2 P1: three failed purchases, then
 * "the new supplies at your hand" / "We've got your rations and water" — the player crossed a desert
 * believing they were provisioned). Deliberately a SHORT list of survival goods: generic nouns
 * ("supplies", "gear") and one-off scene objects stay legal — only a specific staple asserted as
 * POSSESSED when the pack holds nothing like it trips the check.
 */
const SUPPLY_STAPLES: { re: RegExp; token: string; label: string }[] = [
  { re: /\brations?\b/i, token: "ration", label: "rations" },
  { re: /\bwater-?skins?\b/i, token: "waterskin", label: "a waterskin" },
  { re: /\bprovisions\b/i, token: "provision", label: "provisions" },
  { re: /\bbedrolls?\b/i, token: "bedroll", label: "a bedroll" },
  { re: /\btents?\b/i, token: "tent", label: "a tent" },
];

/**
 * #phantomSupplies — prose asserts the party OWNS/USES a provisioning staple the player does not
 * carry. Possession phrasings only ("your rations", "we've got water and rations", "she hands you
 * the waterskin" is the transferItem pattern's job); talk ABOUT the staple — buying it, lacking it,
 * needing it, being refused it — stays legal via the negation guard. Skipped when `carried` is
 * absent (caller opted out).
 */
export function checkPhantomSupplies(prose: string, carried?: string[]): Violation[] {
  if (!carried) return [];
  const carriedNorm = carried.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, ""));
  const out: Violation[] = [];
  for (const staple of SUPPLY_STAPLES) {
    if (!staple.re.test(prose)) continue;
    if (carriedNorm.some((n) => n.includes(staple.token))) continue;
    // Possession assertion: "your/our <staple>", "we (have) got <…> <staple>", "you check your <staple>".
    const possessed = new RegExp(
      String.raw`\b(?:your|our)\s+(?:\w+\s+){0,2}${staple.re.source}|\bwe(?:'ve| have)?\s+got\b[^.?!]{0,40}${staple.re.source}`,
      "i",
    );
    if (!possessed.test(prose)) continue;
    // Negation/commerce guard: a sentence about lacking, needing, or buying the staple is legal.
    const context = new RegExp(
      String.raw`\b(?:no|not|without|out\s+of|lack|lacks|lacking|need|needs|needed|buy|buys|buying|sell|sells|selling|price|cost|costs)\b[^.?!]{0,50}${staple.re.source}`,
      "i",
    );
    if (context.test(prose)) continue;
    out.push({
      kind: "phantomSupplies",
      offender: staple.label,
      detail: `Prose asserts the party has ${staple.label}, but nothing like it is carried`,
      correction: `The party does NOT have ${staple.label} — nothing of the kind is in anyone's pack. Do not narrate owning, using, packing, or being provisioned with it; the lack is real and may bite.`,
    });
  }
  return out;
}

/** A night/dawn PASSING needs the clock to actually cross one — anything under this many minutes cannot. */
const NIGHT_CROSSING_MINUTES = 300;

/**
 * #timeDrift — prose narrates a night passing / a dawn arriving on a turn whose clock advance cannot
 * contain one (r2 P1: three narrated dawns for one day advance; the failed rough-sleep turn delivered
 * "First light. Ready when you are." while authoritative state held afternoon). Passage assertions only —
 * deadlines ("till dawn", "by dawn"), plans, and time-of-day scenery stay legal.
 */
export function checkTimeDrift(prose: string, clockMinutes?: number): Violation[] {
  if (clockMinutes === undefined || clockMinutes >= NIGHT_CROSSING_MINUTES) return [];
  const passage =
    /\b(?:the\s+night\s+passes|dawn\s+(?:comes|breaks|arrives|finds)\b|first\s+light\s+(?:comes|breaks|arrives|finds)\b|morning\s+(?:comes|arrives|finds)\b|you\s+(?:wake|awaken|come\s+awake)\s+(?:to|at|with|in)\b|you\s+sleep\s+(?:through\s+the\s+night|until\s+(?:dawn|morning|first\s+light)|till\s+(?:dawn|morning))\b)/i;
  if (!passage.test(prose)) return [];
  return [
    {
      kind: "timeDrift",
      detail: `Prose narrates a night/dawn passing on a turn advancing only ${clockMinutes} minutes`,
      correction:
        "No night passes this turn and no dawn arrives — the clock has NOT moved to another day. Stay inside the current moment and time of day; if the player tried to sleep, narrate only the attempt or the settling down, never the waking.",
    },
  ];
}

/** Coarse day/dark buckets for the phase-drift check — the conservative floor the regex tier can hold. */
const DAY_PHASES: ReadonlySet<string> = new Set(["dawn", "morning", "afternoon"]);
const DARK_PHASES: ReadonlySet<string> = new Set(["dusk", "evening", "night", "deep night"]);

/**
 * Predicative PRESENT-SCENE time-of-day markers only (r3 P2: evening stew scenes against a morning
 * state). Each marker is a clause that STAGES the scene at an hour — never a deadline idiom ("by
 * dusk"), a plan ("we leave at dawn"), or a memory: those don't match these shapes, which is the
 * whole false-positive defense. Kept deliberately short; the model tier owns the fine judgment.
 *
 * The defense held for NARRATION and leaked on SPEECH, because a quoted line is exactly where a plan
 * or a memory gets said out loud, in the predicative present, by someone who is not the narrator.
 * Against a morning clock (reproduced 07-27): `"The moon rises before we reach the ford," Oda says.`,
 * `"Night has fallen on better men than you," she says, and laughs.` and `Brann leans in. "The sun
 * sets and the gate shuts. Be quick."` each raised a phaseDrift and sent a perfectly good turn back
 * for regeneration — one of which was a DEADLINE, the very idiom the paragraph above promises is
 * safe. `checkPhaseDrift` therefore tests the prose with double-quoted spans removed; the markers are
 * about how the GM STAGES the scene, and nothing an NPC says is staging.
 */
const DARK_SCENE_RE =
  // Object-based night staging joins the celestial forms (PROSE-TO-CODE §2.6): a scene can assert
  // night without naming the sky — banking the fire for the night, bedrolls going out, embers
  // burned low. Kept to forms that IMPLY bedding down at day's end; a cold campfire or a midday
  // "embers" mention stays legal.
  /\b(?:night\s+has\s+fallen|darkness\s+(?:falls|has\s+fallen|settles)|dusk\s+(?:settles|gathers|deepens)\b|the\s+sun\s+(?:sets|sinks|is\s+setting|has\s+set|dips\s+below)|stars\s+(?:prick|glitter|wheel|come\s+out)|the\s+moon\s+(?:rises|hangs|climbs)|the\s+evening\s+(?:air|light|crowd|meal|stew)|bank(?:s|ed|ing)?\s+the\s+(?:camp)?fire\s+for\s+the\s+night|roll(?:s|ed|ing)?\s+out\s+(?:the|your|their)\s+bedrolls?|embers?\s+burn(?:s|ed|ing)?\s+low\s+in\s+the\s+dark)\b/i;
const DAY_SCENE_RE =
  /\b(?:the\s+sun\s+(?:rises|climbs|is\s+high|hangs\s+high|beats\s+down)|(?:the\s+)?morning\s+(?:light|sun|air|mist)|the\s+midday\s+(?:sun|heat|crowd)|noon\s+sun)\b/i;

/**
 * #phaseDrift — prose stages the CURRENT scene at a time of day the campaign clock contradicts.
 * Input-gated on `dayPhases` (caller opt-in, like `carried`/`clockMinutes`); skipped on turns that
 * legitimately cross a night (`clockMinutes >= NIGHT_CROSSING_MINUTES` — a real rest/march narrates
 * the hours between its endpoints). Coarse day-vs-dark bucket comparison only: flags only prose
 * asserting a bucket that matches NEITHER phase the turn spans, so dusk scenery on a dusk clock —
 * or on a turn ENDING at dusk — never trips it.
 */
export function checkPhaseDrift(
  prose: string,
  dayPhases?: string[],
  clockMinutes?: number,
  arrivalPhase?: string,
): Violation[] {
  if (!dayPhases || dayPhases.length === 0) return [];
  if (clockMinutes !== undefined && clockMinutes >= NIGHT_CROSSING_MINUTES) {
    // A long crossing legally references both ends of the road — but when it ENDS at an arrival,
    // the present scene is the arrival, and staging it in the OPPOSITE phase class is the r9 F-10
    // lie ("Morning in the Saltmarket" written over `Time: dusk`). Escalation trigger only: the
    // model tier arbitrates, so a legitimate departure recap costs one judge call, never a regen.
    if (arrivalPhase === undefined) return [];
    const staged = stripQuotedSpans(prose);
    const arrivesDark = DARK_PHASES.has(arrivalPhase);
    const arrivesDay = DAY_PHASES.has(arrivalPhase);
    if (arrivesDark && DAY_SCENE_RE.test(staged)) {
      return [
        {
          kind: "phaseDrift",
          detail: `Prose stages the arrival in daylight while the journey ends at ${arrivalPhase}`,
          correction: `The journey ends at ${arrivalPhase} — the arrival scene happens then. The road behind may be recalled at its own hours, but the PRESENT moment must be staged at ${arrivalPhase}, not in daylight.`,
        },
      ];
    }
    if (arrivesDay && DARK_SCENE_RE.test(staged)) {
      return [
        {
          kind: "phaseDrift",
          detail: `Prose stages the arrival at dusk/night while the journey ends at ${arrivalPhase}`,
          correction: `The journey ends at ${arrivalPhase} — the arrival scene happens then. The road behind may be recalled at its own hours, but the PRESENT moment must be staged at ${arrivalPhase}, not at dusk or night.`,
        },
      ];
    }
    return [];
  }
  const spansDay = dayPhases.some((p) => DAY_PHASES.has(p));
  const spansDark = dayPhases.some((p) => DARK_PHASES.has(p));
  const out: Violation[] = [];
  // Staging is the NARRATOR's business — see DARK_SCENE_RE's header for the three quoted lines this
  // dropped. An NPC's "the moon rises before we reach the ford" is a plan, not a clock reading.
  const staged = stripQuotedSpans(prose);
  if (DARK_SCENE_RE.test(staged) && !spansDark && spansDay) {
    out.push({
      kind: "phaseDrift",
      detail: `Prose stages the scene at dusk/night while the clock reads ${dayPhases.join("/")}`,
      correction: `The scene is currently ${dayPhases[0]} — narrate within that time of day; do not stage the present moment at dusk or night. Plans, memories, and deadlines may reference other hours.`,
    });
  } else if (DAY_SCENE_RE.test(staged) && !spansDay && spansDark) {
    out.push({
      kind: "phaseDrift",
      detail: `Prose stages the scene in daylight while the clock reads ${dayPhases.join("/")}`,
      correction: `The scene is currently ${dayPhases[0]} — narrate within that time of day; do not stage the present moment in daylight. Plans, memories, and deadlines may reference other hours.`,
    });
  }
  return out;
}

const MALE_PRONOUN_RE = /(?:^| )(?:he|him|his|himself)(?:$| )/;
const FEMALE_PRONOUN_RE = /(?:^| )(?:she|her|hers|herself)(?:$| )/;

/**
 * #pronounDrift Tier-1 — an ESCALATION TRIGGER, not a verdict (r4: "Lys ... does not pretend SHE
 * only just found him", flipping a suspect's sex mid-turn; the r3 model-only check never ran
 * because a clean flavor turn never escalated). A sentence that names ONE present cast member and
 * carries the opposite-sex pronoun flags — but ONLY when no present cast member of that pronoun's
 * sex exists (the pronoun may legitimately refer to them) and no other cast name shares the
 * sentence (ambiguous referent — never their fault). Every hit escalates to the model tier, which
 * remains the arbiter; a false positive costs one judge call and is never player-visible.
 */
export function checkPronounDrift(prose: string, presentPronouns?: string[]): Violation[] {
  if (!presentPronouns || presentPronouns.length === 0) return [];
  const cast: { name: string; sex: "male" | "female" }[] = [];
  for (const row of presentPronouns) {
    const m = row.match(/^(.*)\((he\/him|she\/her)\)\s*$/);
    if (m) cast.push({ name: m[1]!.trim(), sex: m[2] === "he/him" ? "male" : "female" });
  }
  if (cast.length === 0) return [];
  const malesPresent = cast.some((c) => c.sex === "male");
  const femalesPresent = cast.some((c) => c.sex === "female");
  const out: Violation[] = [];
  const flagged = new Set<string>();
  for (const sentence of prose.split(/(?<=[.!?…])\s+/)) {
    const hay = normalize(sentence);
    if (!hay) continue;
    for (const member of cast) {
      if (flagged.has(member.name)) continue;
      // WHICH member the sentence names is a person-binding question, so it takes the strict shared
      // binder — the same rule `checkCastPresence` and the absence floor were moved to. The old
      // `salientTokens(...).some()` bound a person on ONE ordinary English word: with only "Lys the
      // Quiet (she/her)" present, "The room goes quiet as the ferryman shakes his head." and "The
      // night is quiet; he counts the crates twice." both escalated a pronoun drift for Lys, and
      // "Coast Farmhand (she/her)" was named by the word "coast" in "The coast road is empty and he
      // walks it alone." (all three reproduced 07-27). A hit costs a judge call, so a false one is
      // paid for on every quiet flavor turn. `nameMentionedIn` defaults to the `prose` surface: this
      // is narrator prose, where a staged person is capitalized.
      if (!nameMentionedIn(sentence, member.name)) continue;
      // The opposite pronoun has a legitimate present referent — not a drift Tier 1 can call.
      if (member.sex === "male" ? femalesPresent : malesPresent) continue;
      // Another cast name in the same sentence makes the referent ambiguous — skip. This one keeps
      // the over-inclusive token set ON PURPOSE, and the asymmetry with the bind above is the point:
      // a hit here SUPPRESSES the flag, so a loose match errs toward silence, which is the safe
      // direction for a trigger that spends a judge call.
      const others = cast.filter((o) => o.name !== member.name);
      if (others.some((o) => salientTokens(o.name).some((t) => wordPresent(hay, t)))) continue;
      const oppositeRe = member.sex === "male" ? FEMALE_PRONOUN_RE : MALE_PRONOUN_RE;
      if (!oppositeRe.test(hay)) continue;
      const canonical = member.sex === "male" ? "he/him" : "she/her";
      const opposite = member.sex === "male" ? "she/her" : "he/him";
      flagged.add(member.name);
      out.push({
        kind: "pronounDrift",
        offender: member.name,
        detail: `${member.name} (${canonical}) is referred to with ${opposite} in the same sentence`,
        correction: `${member.name} is ${canonical} — never ${opposite}. Fix every pronoun that refers to ${member.name}.`,
      });
    }
  }
  return out;
}
