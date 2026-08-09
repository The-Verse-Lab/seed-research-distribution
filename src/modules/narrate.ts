/**
 * narrateGuarded — the guarded narration flow shared by narration producers.
 *
 * Calls the configured DM (streaming tokens to the client), warns on a transport failure, and — THE
 * HARD LINE — on a minor-safety `blocked` verdict emits the firm OOC refusal and STOPS. Only an
 * empty/whitespace result from a NON-blocked call degrades, and it degrades to the deterministic
 * trigger echo (the engine-authored in-fiction line plus the resolved verdict) — there is no
 * offline narrator to fall through to. Centralizing this keeps the blocked-no-fall-through policy
 * a single definition instead of copies that can drift apart.
 *
 * @author Runkai Zhang
 */
import type { GameState } from "../state/types.ts";
import type { DungeonMaster, GenerationResult, NarrationContext } from "../agents/dm.ts";
import { MINOR_SAFETY_REFUSAL } from "../llm/safety.ts";
import type { TickContext } from "../engine/tick.ts";
import type { Command } from "../world/commands.ts";
import { applyCommand } from "../world/reducer.ts";
import { combatPendingInQueue, isCombatActive } from "../world/queries.ts";
import { partyLocationOf, playerEntity } from "../world/model.ts";
import {
  looksLikeName,
  mentionsName,
  screen,
  scrubUnauthorizedArrival,
  stripSentencesMentioning,
  type VerificationBundle,
  type Violation,
} from "../rules/continuity.ts";
import { itemDisplayNameOf, resolveItem } from "../rules/items.ts";
import { placeTokensOf } from "../rules/place-tokens.ts";
import type { ContinuityJudge } from "../agents/judge.ts";
import { dayPhaseOf } from "../agents/context.ts";
import { scrubPlayerEcho, scrubProseArtifacts } from "../llm/prose-scrub.ts";
import { looksLikeRefusal } from "../llm/refusal.ts";
import { exitsFrom } from "../world/map.ts";
import { isFrontierId } from "../world/expansion.ts";
import { recentJourneys } from "../rules/journey.ts";
import { CAMP_LOCATION_ID, readCampSlice } from "../world/camp.ts";
import type { World } from "../content/schema.ts";

/**
 * Max narrator regenerations the Judge will attempt before using deterministic engine prose. One:
 * a second regen roughly doubles the worst-case weave latency on a violating turn (each attempt is
 * a full narrate + a full adjudicate round-trip) for a marginal extra save rate — the first
 * correction fixes the overwhelming majority, and the deterministic trigger echo is a clean floor.
 */
const MAX_JUDGE_REGEN = 1;

/**
 * The model-free floor for a turn whose narrator produced nothing: the engine's own trigger
 * line (already in-fiction, present tense) with the resolved verdict restated. Deterministic,
 * gateway-free — the RescueGateway has already retried/rerouted by the time this fires, so it
 * is the last resort that keeps a turn from ending blank.
 */
/**
 * A process-wide monotonic id minted per streamed narration beat. A single turn can produce several
 * beats (main GM prose plus a combat module beat); tagging each beat's tokens AND its settled
 * event with the same id lets the client key its live buffer per beat, so two beats never collide.
 * Transient by nature (never persisted), so a plain counter is fine — replay carries no tokens.
 */
let narrationBeatCounter = 0;
function nextNarrationBeatId(): number {
  return ++narrationBeatCounter;
}

/**
 * The prompt SEED for a turn driven only by autonomous NPC beats (no player narration intent). It is a
 * META instruction to the narrator, NOT player-safe prose — `triggerEcho` recognizes it so a narrator
 * failure never echoes it to the screen (audit #14). Shared with `NarrationModule` so the two agree.
 */
export const AUTONOMOUS_BEAT_SEED = "The moment continues; react to what the others just did.";

/**
 * The minimum beat shape the echo needs — satisfied by BOTH `NarrationContext["beats"]` (the brief's
 * verbatim-delivery subset) and the fuller `NpcBeat` the modules accumulate on `ctx.data.turnOutcome`.
 */
type EchoableBeat = {
  name: string;
  dialogue?: string;
  lines?: { text: string; mood?: string }[];
  action?: string;
  accepted?: boolean;
};

/**
 * Reconstruct a player-safe echo from the NPC beats themselves (words, or the staged attempt when the
 * NPC only acted), or "" if none. Exported because the NarrationModule's deterministic short-circuit
 * skips the brief that would otherwise weave these beats — a public beat has no other renderer, so
 * without this its words would reach the player through nothing at all.
 */
export function beatEcho(beats: EchoableBeat[] | undefined): string {
  const parts: string[] = [];
  for (const b of beats ?? []) {
    const line = (b.dialogue ?? (b.lines ?? []).map((l) => l.text).join(" ")).trim();
    if (line) parts.push(`${b.name}: "${line}"`);
    // An action-only beat (the Director moved someone, handed something over) is the other half of
    // what the player must not silently miss — its command commits at the end of THIS tick. A beat
    // the dry-run oracle rejected is skipped: it is an attempt that will not land.
    else if (b.action && b.accepted !== false) parts.push(`${b.name} ${b.action}.`);
  }
  return parts.join(" ");
}

export function triggerEcho(nctx: NarrationContext): string {
  const r = nctx.resolved;
  const verdict = r
    ? ` (${r.label}: ${r.success ? "success" : "failure"} — ${r.total}${r.dc !== undefined ? ` vs DC ${r.dc}` : ""}.)`
    : "";
  // A player-safe fallback overrides the raw-trigger echo: the trigger is an authoring
  // instruction that would leak its `(Narrate …)` directive + the doubled action label. Prefer it verbatim
  // — but NEVER at the cost of content the turn really produced. When NPCs spoke this turn, their words
  // ARE the beat; shipping "The moment passes." over the top of them is the shrug the 2026-07-24 playtest
  // called the second-worst feeling in the run. Beats first, placeholder only when there is nothing else.
  if (nctx.echoFallback?.trim()) {
    const spoken = beatEcho(nctx.beats);
    return `${spoken || nctx.echoFallback.trim()}${verdict}`.trim();
  }
  // A beats-only turn's trigger is the META seed above — never echo it. Surface the NPC's own words
  // (the content that lived only in the un-narrated weave block); fall back to neutral in-fiction filler.
  if (nctx.trigger === AUTONOMOUS_BEAT_SEED) {
    return beatEcho(nctx.beats) || NARRATOR_SILENT_FALLBACK;
  }
  const facing = stripNarratorDirective(nctx.trigger);
  return `${facing}${verdict}`.trim() || NARRATOR_SILENT_FALLBACK;
}

/** The last-resort placeholder {@link triggerEcho} returns when a turn produced NOTHING player-safe
 *  to echo — exported so the settle point can recognize it and be honest about the degrade instead
 *  of shipping four words that read as "you did nothing" (r10 F-6). */
export const NARRATOR_SILENT_FALLBACK = "The moment passes.";

/** The honest player-turn replacement for the placeholder above: the WORLD hiccuped, the player
 *  did not do nothing (r10 F-6 — both sweep judges named the silent stretch the worst moment). */
export const NARRATOR_HICCUP_LINE =
  "The world seems to hold its breath — whatever was about to answer you slips away untold, and nothing comes of it.";

/** Said on the system channel when the narrator hit the token cap mid-sentence and the wider retry
 *  did too (r11 P2). The prose still ships — a cut scene beats no scene — but the cut is NAMED, not
 *  left for the player to read as the GM trailing off. */
export const TRUNCATED_NOTICE =
  "The narrator ran out of room mid-sentence and the scene above is cut short. Nothing was lost from the world — ask again, or say \"go on\", to hear the rest.";

/** How much wider the truncation retry goes. The reasoning band a hybrid model burns before writing
 *  is roughly fixed, so multiplying the budget buys prose, not more thinking — the same reasoning
 *  the provider's empty-and-length retry uses (`EMPTY_LENGTH_RETRY_MIN_TOKENS` × 4). */
const TRUNCATION_RETRY_TOKENS = 8192;

/**
 * One buffered re-narration at a budget the cap cannot reach. Buffered deliberately: the first
 * candidate may already be on screen, and two live streams of the same beat would interleave.
 * Returns null when the retry fails, blanks, or truncates again — the caller then keeps the original
 * and says so on the system channel.
 */
async function regenerateTruncated(
  dm: DungeonMaster,
  state: GameState,
  nctx: NarrationContext,
  onReasoning?: (delta: string) => void,
): Promise<string | null> {
  try {
    const retry = await dm.narrate(state, nctx, { onReasoning, maxTokens: TRUNCATION_RETRY_TOKENS });
    if (retry.blocked || retry.truncated || !retry.text.trim()) return null;
    return retry.text;
  } catch (err) {
    console.error("Truncation retry failed", err);
    return null;
  }
}

/**
 * The head of an engine-authored authoring directive: the imperative verbs the trigger builders
 * actually use ("Describe the aftermath…", "Narrate the escape…", "Set the ambush scene…",
 * "Let the closure land…", "do not narrate individual blows"). Anchored — this tests the START of
 * a sentence, never a substring.
 */
const DIRECTIVE_HEAD_RE =
  /^(?:(?:Describe|Narrate|Reflect|Keep(?:ing)?|Avoid|Let\s+the|Write|Ground\s+the|Open\s+on|Do\s+not|Don['’]t|Never)\b|Set\s+(?:the\s+)?(?:[\w-]+\s+){0,3}scene\b)/i;

/** The same directive introduced by an em-dash inside a sentence ("… — Describe the arc."). */
const DIRECTIVE_EMDASH_TAIL_RE = new RegExp(
  `\\s*—\\s*(?:${DIRECTIVE_HEAD_RE.source.slice(1)})[^.!?\\n]*[.!?]*\\s*$`,
  "is",
);

/**
 * Split into sentence chunks that CONCATENATE BACK to the input exactly (delimiters and the
 * whitespace after them ride with the chunk they close). `;` is deliberately NOT a boundary:
 * engine directives use it internally ("Set the scene in a sentence or two; do not narrate
 * individual blows"), and splitting there would orphan the second clause.
 */
function sentenceChunks(text: string): string[] {
  const out: string[] = [];
  const re = /[.!?]+["'”’)\]]*[^\S\n]*|\n+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(text.slice(start, m.index + m[0].length));
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** True when the prefix leaves a double-quote open — a cut there would strand the opening mark. */
function insideOpenQuote(prefix: string): boolean {
  const straight = (prefix.match(/"/g) ?? []).length;
  const open = (prefix.match(/[“«]/g) ?? []).length;
  const close = (prefix.match(/[”»]/g) ?? []).length;
  return straight % 2 === 1 || open !== close;
}

/**
 * Strip LLM-directive text from a narrator trigger so the player-facing echo never leaks authoring
 * instructions. Three shapes, all engine-authored:
 *   1. `(GM: …)` notes — stripped wherever they appear (the r7 restage/armament leaks);
 *   2. `(Already resolved …)` ledger preambles (the grounded-effects lead);
 *   3. TRAILING imperative directives ("Describe …", "Narrate …", "Set the scene …",
 *      "do not restage …", "open on …", "keeping every outcome …").
 * The rest of the trigger is in-world prose — keep it verbatim.
 *
 * (3) used to be one `/^(.*?)…\.*$/is` match: the LAZY head found the FIRST directive-shaped
 * sentence anywhere in the trigger and the greedy `.*$` under `/s` ate everything after it. Two
 * reproduced losses, both on triggers that carry the player's own typed line (engine.ts's
 * `You speak to X: "…"` and the freeform echo):
 *   · `You keep your voice low. Don't move, you tell the guard. Then you slip the knife from your
 *     boot.` → `You keep your voice low` — two sentences of the player's action deleted;
 *   · `You speak to Oda: "I tell him to hurry. Don't wait for the guard."` →
 *     `You speak to Oda: "I tell him to hurry` — cut inside the quote, opening mark left dangling.
 * Now the scan runs from the END and stops at the first sentence that is not directive-headed, and
 * it will not cut at a point that leaves a quote open. Every directive the trigger builders in this
 * tree emit sits at the tail, so all of them still strip byte-for-byte (the seven shipped strings
 * are pinned in tests/narrate-guarded.test.ts); a directive-shaped sentence with real prose after
 * it is prose, and stays. Nothing directive-shaped at the tail ⇒ the text is returned whole (the
 * safe branch — a leaked directive is a cosmetic loss, a deleted sentence of the player's action
 * is not).
 */
export function stripNarratorDirective(text: string): string {
  const out = text
    .replace(/\s*\(GM:[^)]*\)/gi, "")
    .replace(/\s*\(Already resolved[^)]*\)/gi, "");
  const chunks = sentenceChunks(out);
  let end = chunks.length;
  while (end > 0 && DIRECTIVE_HEAD_RE.test(chunks[end - 1]!.trimStart())) {
    // A cut is only legal on a quote-balanced boundary — see the second reproduced loss above.
    if (insideOpenQuote(chunks.slice(0, end - 1).join(""))) break;
    end -= 1;
  }
  let kept = chunks.slice(0, end).join("");
  // The em-dash form rides INSIDE the last surviving sentence, so it is bounded to that sentence
  // and can no longer reach the ones after it.
  const trimmedTail = kept.replace(DIRECTIVE_EMDASH_TAIL_RE, "");
  const cut = end < chunks.length || trimmedTail !== kept;
  kept = trimmedTail;
  // Trailing punctuation is trimmed ONLY off a cut point (the directive rode a comma/em-dash);
  // untouched prose keeps its own full stop.
  if (cut && kept.trim()) return kept.trim().replace(/[.,;]\s*$/, "");
  return out.trim();
}

/** Run one guarded narration and emit it. */
export async function narrateGuarded(
  ctx: TickContext,
  state: GameState,
  dm: DungeonMaster,
  nctx: NarrationContext,
  /**
   * Optional detector for an assistant-voice REFUSAL of ordinary (non-minor) content — e.g. a
   * safety-tuned model declining to narrate combat violence. When supplied and it matches, the
   * non-empty refusal prose is treated as empty so we degrade to the trigger echo instead of
   * emitting the model breaking character. The minor-safety `blocked` path is unaffected — it
   * never falls through to any prose.
   */
  refusalAsEmpty?: (text: string) => boolean,
): Promise<void> {
  // One id for this beat: the same value tags every streamed token AND the settled event below, so
  // the client keys its live buffer per beat and concurrent beats (main prose + a module beat) never
  // merge into one truncated stub. The wrapper binds it, so `dm.narrate`'s own `onToken` is unchanged.
  const beatId = nextNarrationBeatId();
  const client = ctx.services.client;
  const onToken = client?.onNarrationToken;
  const judge = ctx.services.judge;
  const guard = nctx.castGuard;
  // A configured Judge is a release gate, not a post-hoc auditor: buffer every generated candidate so
  // no token can reach the player before semantic verification finishes. With no Judge, retain the
  // legacy cast-risk buffering behavior.
  const base = judge ? buildBundleBase(ctx, nctx) : undefined;
  // Opt-in fast path (SEED_JUDGE_STREAM_CLEAN): stream a JUDGED turn live when it is provably
  // non-escalating BEFORE generation — no absent cast, no established facts, not in combat, nobody
  // downed. On such a turn the Judge's first pass makes NO model call (`shouldEscalate` is false), so
  // the only thing the buffer catches is a post-generation Tier-1 flag — which we screen after the
  // stream (via `runJudge`) and retract+regenerate on the rare hit. Restores time-to-first-token on
  // the common flavor/exploration turn. Requires a live token sink; anything not eligible still buffers.
  const streamCleanEligible =
    ctx.services.judgeStreamClean === true &&
    !!judge &&
    !!base &&
    !!onToken &&
    (base.absent?.length ?? 0) === 0 &&
    (base.established?.length ?? 0) === 0 &&
    !base.isCombat &&
    (base.downed?.length ?? 0) === 0;
  const buffer = (!!judge || (!!guard && guard.absent.length > 0)) && !streamCleanEligible;
  // True once a token has actually reached the client live — the precondition for a mid-stream block
  // to have left a visible stub (so the retract below fires only when there is genuinely one to drop).
  let streamed = false;
  let result: GenerationResult = { text: "" };
  try {
    result = await dm.narrate(state, nctx, {
      onToken:
        !buffer && onToken
          ? (delta) => {
              streamed = true;
              onToken(delta, beatId);
            }
          : undefined,
      onReasoning: client?.onReasoningToken,
    });
  } catch (err) {
    console.error("Narrator generation failed", err);
    ctx.emit({
      kind: "system",
      level: "warn",
      message: "The Game Master could not narrate that turn; the resolved action is shown plainly.",
    });
  }
  // r11 P2 — the cap cut the prose mid-clause. `finish_reason: "length"` on a NON-empty completion
  // is the sibling of the reasoning-burn case the provider already retries: there, thinking ate the
  // whole budget and the text came back empty; here it ate part of it and the visible sentence was
  // severed. Ten of 120 sweep turns shipped one of these — 41 to 1088 characters, always ending
  // mid-clause, never flagged. Retry ONCE at a budget that clears the thinking band, BUFFERED (no
  // second live stream), and keep whichever candidate actually finished. This runs before the Judge
  // so verification sees the whole scene, not the stump.
  if (result.truncated && result.text.trim()) {
    const wider = await regenerateTruncated(dm, state, nctx, client?.onReasoningToken);
    if (wider && wider.trim() !== result.text.trim()) {
      // Whatever already reached the screen is a fragment of a sentence the model has now rewritten;
      // drop it before the fuller prose settles (the same retraction the block and Judge paths use).
      if (streamed) client?.onNarrationRetract?.(beatId);
      result = { ...result, text: wider, truncated: false };
      streamed = false;
    } else {
      // The retry truncated too, or produced nothing better. Ship the prose (a cut scene beats no
      // scene) but SAY so on the system channel — the r11 finding was that this failed silently.
      ctx.emit({
        kind: "system",
        level: "warn",
        code: "narrator-truncated",
        message: TRUNCATED_NOTICE,
      });
    }
  }
  // The one hard line: a block surfaces the firm OOC refusal and stops — never any fall-through
  // (which would generate prose for the very thing the guard refused).
  if (result.blocked) {
    // If this beat streamed a live lead-in (already on the player's screen), the settling `narration`
    // event below never fires — leaving a dangling half-sentence stub. Retract it FIRST so the client
    // drops the live buffer before the refusal banner lands. Fires only when a token actually streamed
    // (`streamed`); a buffered or input-blocked beat put nothing on screen, so there is nothing to
    // remove. The retracted prefix is provably non-sexual (the guard freezes live release the instant
    // any sexual signal appears), so no flagged content was ever shown.
    if (streamed) client?.onNarrationRetract?.(beatId);
    ctx.emit({ kind: "system", level: "warn", message: MINOR_SAFETY_REFUSAL });
    return;
  }
  // Mechanical artifact scrub at the settle point (r3 P4: a narration opening with a literal
  // "# NOW" header line; a stray CJK glitch token mid-prose). The settled `narration` event
  // replaces the client's live beat buffer, so streamed and non-streamed paths both end clean.
  let text = scrubProseArtifacts(result.text);
  // A provider that refuses ordinary content (e.g. combat violence) returns non-empty refusal prose
  // that is neither minor-safety `blocked` nor empty. When the caller supplies a detector, treat
  // such a response as empty so the trigger echo stands in instead of the model breaking character.
  // (The refusal is still recorded in the LLM call log.)
  if (refusalAsEmpty && text.trim() && refusalAsEmpty(text)) text = "";
  // True when the semantic tier POSITIVELY cleared the exact prose being shipped — the audit below
  // then records the arbiter's verdict (nothing) instead of re-running the raw Tier-1 floor on it.
  let judgeCleared = false;
  // True when the prose that ships is the ENGINE's own deterministic stand-in (the trigger/beat echo
  // or a cast-guard floor), not model output. The Tier-1 screen exists to catch the MODEL asserting
  // things the world did not do; engine prose is composed from committed truth, so screening it can
  // only manufacture false violations. r13 shipped four of them off one line: the trigger echo's own
  // honest left-behind notice — "You travel to Anchorfall. (Brann Coldwater stays behind — they are
  // not travelling with you)" — was read as a castPresence violation (it names an absent NPC, which
  // is the whole point of the notice) AND a phantomCompanion (the accompaniment phrase, negated).
  let engineAuthored = false;
  if (text.trim()) {
    if (judge && base) {
      // The Continuity Judge path: nothing BUFFERED is released until the candidate is semantically
      // verified. On a stream-clean turn the candidate already streamed live; `runJudge` returns it
      // unchanged when clean (no model call), so the common case is a no-op here.
      const judged = await runJudge(dm, state, nctx, judge, base, text, client?.onReasoningToken);
      const verified = judged.text;
      judgeCleared = judged.cleared;
      // A fail-closed floor that swapped in ENGINE prose (absence echo / trigger echo) must not be
      // re-screened below — same rule as every other engine-authored path, one step later (r14,
      // fixture-work t7: the screened travel echo's left-behind notice shipped a false castPresence).
      if (judged.engineFloor) engineAuthored = true;
      // If we streamed the original live and the Judge REPLACED it (a post-stream Tier-1 flag
      // escalated, then a correction/regeneration or a fail-closed echo changed the prose), retract
      // the now-stale live stub before the corrected prose settles — the same mechanism the
      // minor-safety block path uses. Value-inequality is deliberate: an identical regen needs no retract.
      if (streamCleanEligible && streamed && verified !== text) client?.onNarrationRetract?.(beatId);
      text = verified;
    } else if (guard && guard.absent.length > 0) {
      // ===== LEGACY cast-guard path (Judge disabled) =====
      // Verify both the initial and replacement candidates. An unavailable verifier or a replacement
      // that remains invalid falls back to deterministic engine prose, never unchecked model prose.
      try {
        const offenders = await dm.verifyCast(text, guard.present, guard.absent);
        if (offenders.length > 0) {
          const retry = await dm.narrate(state, nctx, {
            onReasoning: client?.onReasoningToken,
            forbid: offenders,
          });
          // r5: both floors here KNOW the offending names, so they get the same honest absence
          // line the Judge path gives (r4 shipped `castAbsenceEcho` on the regen-exhausted
          // branch only, leaving the Judge-disabled path shrugging).
          if (!retry.blocked && retry.text.trim()) {
            const remaining = await dm.verifyCast(retry.text, guard.present, guard.absent);
            if (remaining.length === 0) {
              text = retry.text;
            } else {
              text = castGuardEcho(remaining, nctx, guard) ?? triggerEcho(nctx);
              engineAuthored = true;
            }
          } else {
            text = castGuardEcho(offenders, nctx, guard) ?? triggerEcho(nctx);
            engineAuthored = true;
          }
        }
      } catch (err) {
        console.error("Cast verification failed", err);
        text = triggerEcho(nctx);
        engineAuthored = true;
      }
    }
  }
  // A Judge regeneration is fresh model prose — scrub it too (idempotent on already-clean text).
  if (text.trim()) text = scrubProseArtifacts(text);
  // r10 F-1 RAIL — always on, judge or no judge: prose may invent detail, never ARRIVAL. On a turn
  // that authorized no travel, the sentences claiming one are dropped (the fiction relocating while
  // the state stands still was the r10 sweep's dominant lie, and every castPresence violation
  // downstream followed the moved scene). A real move suppresses inside the scrub itself. Bare test
  // harness contexts (no model/data) skip the rail — the product tick always carries both.
  if (text.trim() && ctx.model && ctx.data) {
    text = scrubUnauthorizedArrival(
      text,
      authorizedCommandsOf(ctx),
      isCombatActive(ctx.model) || (ctx.queue ? combatPendingInQueue(ctx.queue) : false),
      playerEntity(ctx.model)?.id,
    );
  }
  // The player's own typed line re-printed inside the paragraph (r7 P2, both combat-start turns):
  // the YOU block already shows it — a verbatim copy in the narration is pure reading tax.
  // (`ctx.trigger` is optional-chained: bare test harness contexts omit the trigger entirely.)
  const trig = ctx.trigger as { kind?: string; input?: string } | undefined;
  if (text.trim() && trig?.kind === "player" && trig.input) text = scrubPlayerEcho(text, trig.input);
  if (!text.trim()) {
    text = triggerEcho(nctx);
    engineAuthored = true;
    // r10 F-6 — eight sweep turns consumed the player's line, burned 40–80 s each and shipped four
    // words that read as "you did nothing". When the echo is the bare placeholder ON A PLAYER TURN
    // (narrator empty, no beats, no player-safe trigger), be honest that the WORLD hiccuped: in
    // fiction on the prose channel, mechanically on the system channel. Autonomous quiet turns keep
    // the terse placeholder — no player line was consumed there.
    if (text === NARRATOR_SILENT_FALLBACK && trig?.kind === "player") {
      text = NARRATOR_HICCUP_LINE;
      // r11 P2 — the notice the player reads must not name an environment variable. The r10 F-6
      // message put `SEED_RESCUE_*` on screen mid-scene and the sweep judge called it the immersion
      // break. The cause and its remedy are an OPERATOR's business: they go to the console (and the
      // LLM-call log the Observatory already reads), and the player is told only what they need —
      // the world hiccuped, their line was not spent, say it again.
      console.warn(
        "[narrate] narrator returned nothing for a player turn (even after retry). Configure SEED_RESCUE_BASE_URL/MODEL to reroute empty completions to a fallback model.",
      );
      ctx.emit({
        kind: "system",
        level: "warn",
        code: "narrator-empty",
        message: "The story stalled for a moment — nothing you did was lost. Try that line again, or say it another way.",
      });
    } else if (trig?.kind === "player") {
      // r13 honesty gap: a set echoFallback (every dialogue turn) suppressed ALL telemetry, so six
      // mute 45–141s turns in one sweep shipped with zero operator signal. The player-facing echo
      // stays (it spends the line honestly); the empty narrator still gets said out loud where an
      // operator can see it.
      console.warn(
        "[narrate] narrator returned nothing for a player turn (even after retry); settled on the trigger echo. Configure SEED_RESCUE_BASE_URL/MODEL to reroute empty completions to a fallback model.",
      );
    }
  }
  // Turn auditor (best-effort telemetry, the process half of the honesty work): record the
  // deterministic Tier-1 screen of the FINAL emitted prose on the tick scratch for the turn trace.
  // When the semantic tier POSITIVELY cleared this exact prose, the arbiter's verdict IS the
  // record: the Tier-1 floor is over-inclusive BY DESIGN (mention-vs-staged is the model tier's
  // call — see checkCastPresence), so re-screening prose the Judge just cleared logged a known
  // false-positive class on every legal mention of an absent name (r12: 12 of 12 sweep audit
  // findings were this shape). Without a Judge — or when it enforced a floor instead of clearing —
  // the raw screen remains the ONLY machine record of a phantom transaction/state claim, so
  // scripted live runs can report violations automatically instead of a human eyeballing
  // transcripts. Never blocks, never regenerates, never throws.
  //
  // `engineAuthored` prose is skipped for the same reason, one step earlier: there is no model claim
  // to screen. The echo IS the engine's own record of what happened.
  try {
    const violations =
      judgeCleared || engineAuthored ? [] : screen({ ...(base ?? buildBundleBase(ctx, nctx)), prose: text });
    if (violations.length > 0 && ctx.data) {
      const list = (ctx.data.auditViolations as { kind: string; detail: string }[] | undefined) ?? [];
      list.push(...violations.map((v) => ({ kind: v.kind, detail: v.detail })));
      ctx.data.auditViolations = list;
    }
  } catch {
    // Audit is telemetry — a fault here must never break or slow the turn.
  }
  // Stash the emitted prose so the prose-entity module (narrate phase, runs last) can read what the
  // GM just narrated and ground any newly-named characters into the registry. Additive + best-effort:
  // nothing reads it unless that module is registered, and a missing `data` scratch is a no-op.
  if (ctx.data) ctx.data.lastNarration = text;
  ctx.emit({ kind: "narration", text, beatId });
}

/**
 * Detector for an assistant-voice REFUSAL, distinct from GM prose — used by the narration, combat
 * and combat modules so a provider that declines to narrate violence degrades to the trigger echo
 * rather than leaking the model breaking character.
 *
 * ONE implementation, re-exported from `src/llm/refusal.ts` (the rescue/reroute path's own
 * predicate). This module used to carry a second, weaker copy of the same name and job: a
 * `startsWith` scan over a lowercase prefix list. The regex audit executed both and it failed in
 * BOTH directions —
 *   · missed `**I'm sorry, I can't continue this scene.**` and `> I'm sorry, I can't…` (position 0
 *     is a markdown fence, not the refusal), so the model's break-in-character shipped as GM prose;
 *   · flagged the ordinary NPC line `Sorry, love. The price is the price.` as a refusal (the bare
 *     `"sorry,"` prefix), throwing a good narration away for the deterministic echo.
 * The shared predicate answers `true` on the two missed shapes and `false` on the false positive
 * (pinned in tests/combat-module.test.ts). Re-exported rather than re-pointed at the call sites so
 * the three `refusalAsEmpty` references keep working unchanged.
 */
export { looksLikeRefusal };

/**
 * The turn's AUTHORIZED command set: the tick's applied ledger (`ctx.data.turnCommands`) plus the
 * STILL-LEGAL pending queue. The queue is dry-run SEQUENTIALLY on ONE working clone — mirroring the
 * real commit loop's order (engine.ts) — not each command independently against the pre-queue model.
 * Independent dry-runs let two queued spawns both validate against the same free id (`template#0`);
 * at commit the first lands and the second REJECTS, but narration had already blessed both. Folding
 * on one clone means the second correctly rejects against the already-applied first, so the result
 * matches commit-time truth. Dry-run only — the real mutation stays the reducer at commit (audit #6).
 *
 * The ONE ledger derivation shared by the Judge's bundle (below) and the brief's TURN FACTS block
 * (narration + combat modules) — the two must never disagree about what happened.
 */
export function authorizedCommandsOf(ctx: TickContext): Command[] {
  const applied = (ctx.data.turnCommands as Command[] | undefined) ?? [];
  // Per-tick memo: this runs 2–3× per narrate (turn-facts + the Judge bundle + combat's own facts),
  // each call structuredClone-ing the whole model to dry-run the queue. The applied ledger and the
  // queue are append-only until they drain at commit, and this is never called after commit — so an
  // (appliedLen:queueLen) signature uniquely identifies the set within a tick. Same signature ⇒ reuse;
  // a later phase appending changes the length and recomputes. `ctx.data` is per-tick — no cross-tick
  // leak. Callers treat the result read-only (map/filter/spread), so sharing the array is safe.
  const sig = `${applied.length}:${ctx.queue.length}`;
  const memo = ctx.data.authorizedMemo as { sig: string; cmds: Command[] } | undefined;
  if (memo && memo.sig === sig) return memo.cmds;
  const work = structuredClone(ctx.model);
  const legalQueue = ctx.queue.filter((c) => !applyCommand(work, c).rejected);
  const cmds = [...applied, ...legalQueue];
  ctx.data.authorizedMemo = { sig, cmds };
  return cmds;
}

/**
 * Assemble the Continuity Judge's ground-truth bundle (everything but the prose, which is swapped per
 * candidate). The authorized-command set comes from `authorizedCommandsOf` (the shared ledger
 * derivation), so a doomed NPC action can never launder a phantom claim. `beats`/`resolved`/
 * `established`/`castGuard` ride on `nctx` (the single source of truth the brief was built from).
 */
function buildBundleBase(ctx: TickContext, nctx: NarrationContext): VerificationBundle {
  const authorized = authorizedCommandsOf(ctx);
  // The player's ACTUAL party companions co-located this turn (code-truth from `partyMember`) — the
  // phantom-companion check fires only when this is empty. Computed here off the model so the guard
  // never depends on prose or a derived cache.
  const playerId = playerEntity(ctx.model)?.id;
  const partyLoc = partyLocationOf(ctx.model);
  const party = [...ctx.model.entities.values()]
    .filter((e) => e.partyMember && e.id !== playerId && e.locationId === partyLoc)
    .map((e) => e.name);
  // Who went DOWN this turn (authoritative unconscious flips) — lets the Judge hold kill-turn prose
  // to the defeat instead of only guarding the inverse ("live foe declared dead"). Names resolve off
  // the model; an already-culled entity degrades to its id.
  const downed = authorized
    .filter(
      (c): c is Extract<Command, { type: "setCondition" }> =>
        c.type === "setCondition" && c.condition === "unconscious" && c.active,
    )
    .map((c) => ctx.model.entities.get(c.entityId)?.name ?? c.entityId);
  // The last few emitted narrations — the verbatim-repeat check's memory (live 07-18 #3: a greeting
  // replayed word-for-word a scene later). Four is plenty: repetition further back reads as callback,
  // not staleness, and the run threshold is high enough that flavor echoes never trip it.
  const recentNarrations = (ctx.recent ?? [])
    .filter((e): e is Extract<(typeof ctx.recent)[number], { kind: "narration" }> => e.kind === "narration")
    .slice(-4)
    .map((e) => e.text);
  // THIS turn's event beats join the repeat corpus (playtest r9 F-6): an authored `narrate` effect
  // prints its own block BEFORE the GM narrates, and `ctx.recent` only reaches back to the turn's
  // start — so the GM restating the hand-in beat (Veil's line verbatim, twice on one screen) was
  // invisible to the verbatim-repeat check. The "ALREADY HAPPENING" brief block says do-not-restate;
  // this makes the screen enforce it, through the same deterministic-authoritative regen path.
  const turnEventTexts = (ctx.data.turnOutcome as { events?: string[] } | undefined)?.events ?? [];
  recentNarrations.push(...turnEventTexts);
  // The player's REAL pack (display names) — the phantom-supplies check's truth. Read off the live
  // entity so a mid-tick transfer is already reflected; name resolution is the caller's brief's job,
  // so raw ids degrade to their id string (the check normalizes).
  const player = playerEntity(ctx.model);
  const carried = (player?.stats?.inventory ?? []).map((id) => resolveItem(ctx.services.world, id)?.name ?? itemDisplayNameOf(id));
  // Minutes this turn will advance the clock (resolve-phase pricing) — the time-drift check's truth.
  const clockMinutes = typeof ctx.data.clockMinutes === "number" ? ctx.data.clockMinutes : 0;
  // The day phases this turn legally spans (start + end of its clock advance) — the phase-drift
  // check's truth (r3 P2: evening scenery narrated against morning state for many turns).
  const dayPhases = [...new Set([dayPhaseOf(ctx.model.clock), dayPhaseOf(ctx.model.clock + clockMinutes)])];
  const bundleTrig = ctx.trigger as { kind?: string; input?: string } | undefined;
  // On a movement turn whose advance crosses phases, the PRESENT scene is the arrival — its phase
  // arms the r9 F-10 escalation trigger in checkPhaseDrift (only meaningful when the long-crossing
  // skip would otherwise wave the turn through; harmless when start == end).
  const arrivalPhase =
    ctx.data.movementAttempt === true && dayPhases.length > 1 ? dayPhaseOf(ctx.model.clock + clockMinutes) : undefined;
  const locale = buildLocale(ctx);
  const placeTokens = placeTokensFor(ctx);
  // A moveParty already APPLIED this turn has moved the model, so the party's current location IS
  // the arrival — real return prose ("the road delivers you back into Anchorfall") is then legal
  // (r12). Queued-not-applied moves point at a destination that is not `partyLoc` yet, so they
  // don't attest an arrival — correct, because the scene is still staged at the origin.
  const arrivedHere =
    partyLoc !== null && authorized.some((c) => c.type === "moveParty" && c.to === partyLoc);
  return {
    prose: "",
    mode: "narration",
    present: nctx.castGuard?.present,
    absent: nctx.castGuard?.absent,
    beats: nctx.beats,
    resolved: nctx.resolved ?? null,
    trigger: nctx.trigger,
    isCombat: isCombatActive(ctx.model) || combatPendingInQueue(ctx.queue),
    downed,
    authorizedCommands: authorized,
    established: nctx.established,
    ledger: nctx.ledger,
    recentNarrations,
    ...(placeTokens ? { placeTokens } : {}),
    party,
    movementAttempt: ctx.data.movementAttempt === true,
    ...(playerId !== undefined ? { playerId } : {}),
    carried,
    clockMinutes,
    dayPhases,
    ...(arrivalPhase !== undefined ? { arrivalPhase } : {}),
    // §2.5 — quoted-PC-speech fidelity truth: the player's real typed line (player turns only).
    ...(bundleTrig?.kind === "player" && bundleTrig.input !== undefined ? { playerInput: bundleTrig.input } : {}),
    ...(nctx.presentPronouns !== undefined ? { presentPronouns: nctx.presentPronouns } : {}),
    ...(locale ? { locale } : {}),
    ...(arrivedHere ? { arrivedHere } : {}),
  };
}

/**
 * The world's place vocabulary, or undefined where there is no world to read (the narrate specs
 * build a ctx with no `services.world`). Cached per world by `placeTokensOf`, so this is a map
 * lookup per turn.
 */
function placeTokensFor(ctx: TickContext): ReadonlySet<string> | undefined {
  const world = ctx.services?.world as World | undefined;
  return world ? placeTokensOf(world) : undefined;
}

/**
 * Where the party is, what really leads out, and every authored place name that would be a LIE to
 * stage this scene at — the `journeyFabrication` ground truth.
 *
 * The whitelist is subtracted HERE rather than in the pure check, so `continuity.ts` stays
 * content-free. Legal ways to name a place from here: this location; every visible exit's label and
 * its destination's name; the region; the camp return anchor and the camp itself; the gazetteer;
 * and both ends of every recent journey (the party may reminisce about a road it actually walked).
 *
 * Every dereference is optional: the narrate tests build a ctx with neither `services.world` nor
 * `model.map`, and `exitsFrom` throws on an undefined map.
 */
function buildLocale(ctx: TickContext): VerificationBundle["locale"] | undefined {
  const world = ctx.services?.world as World | undefined;
  const hereId = ctx.model ? partyLocationOf(ctx.model) : null;
  if (!world || !hereId) return undefined;
  const hereLoc = world.locations?.find((l) => l.id === hereId);
  if (!hereLoc?.name) return undefined;

  const legal = new Set<string>([hereLoc.name.toLowerCase()]);
  const exits: string[] = [];
  for (const exit of ctx.model.map ? exitsFrom(ctx.model.map, hereId) : []) {
    if (exit.hidden || isFrontierId(exit.to)) continue;
    if (!exit.name) continue;
    exits.push(exit.name);
    legal.add(exit.name.toLowerCase());
    const dest = world.locations?.find((l) => l.id === exit.to);
    if (dest?.name) legal.add(dest.name.toLowerCase());
  }
  const region = world.regions?.find((r) => r.id === hereLoc.region);
  if (region?.name) legal.add(region.name.toLowerCase());
  if (hereLoc.region) legal.add(hereLoc.region.toLowerCase());
  for (const entry of world.gazetteer ?? []) legal.add(entry.name.toLowerCase());
  const camp = readCampSlice(ctx.model);
  for (const id of [camp?.returnLocationId, CAMP_LOCATION_ID]) {
    const name = id ? world.locations?.find((l) => l.id === id)?.name : undefined;
    if (name) legal.add(name.toLowerCase());
  }
  for (const leg of recentJourneys(ctx.model.modules ?? {})) {
    for (const id of [leg.fromId, leg.toId]) {
      const name = world.locations?.find((l) => l.id === id)?.name;
      if (name) legal.add(name.toLowerCase());
    }
  }
  const foreign = (world.locations ?? [])
    .map((l) => l.name)
    .filter((name): name is string => !!name && !legal.has(name.toLowerCase()));
  return { here: hereLoc.name, exits, foreign };
}

/** Join the distinct correction directives from a violation set into one regeneration instruction. */
function composeCorrection(violations: Violation[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const v of violations) {
    const c = v.correction.trim();
    if (c && !seen.has(c)) {
      seen.add(c);
      parts.push(c);
    }
  }
  return parts.join(" ");
}

/**
 * Adjudicate buffered prose, regenerate with targeted corrections, and release only a candidate that
 * passes the semantic Judge. The FIRST pass is `force:false`: a clean flavor turn — the common case,
 * with no Tier-1 flag / absent-cast risk / established fact to contradict — does NOT escalate, so
 * `adjudicate` returns `semanticVerified:true` with no model round-trip and the prose ships as-is.
 * Only a turn that WARRANTED semantic verification (it escalated) and then hit a verifier OUTAGE gets
 * `semanticVerified:false`; that (and any un-correctable violation) fails closed to deterministic
 * engine prose — there is no "least bad" player-visible candidate. This narrows the WIP's original
 * `force:true` (which routed EVERY turn through the model and collapsed clean prose to a bare echo on
 * any hiccup) to only the genuinely at-risk turns.
 */
async function runJudge(
  dm: DungeonMaster,
  state: GameState,
  nctx: NarrationContext,
  judge: ContinuityJudge,
  base: VerificationBundle,
  text: string,
  onReasoning?: (delta: string) => void,
): Promise<{ text: string; cleared: boolean; engineFloor: boolean }> {
  try {
    const verdict = await judge.adjudicate({ ...base, prose: text });
    // An escalated turn whose model tier went down (never a clean turn — that stays semanticVerified:true
    // without a model call) fails closed to deterministic engine prose rather than shipping unverified
    // at-risk prose.
    // r5: a verifier outage on an ABSENT-cast turn still knows WHO is absent — `adjudicate`
    // returns the Tier-1 screen's own violations alongside `semanticVerified:false`, and
    // `castPresence` is deterministic (continuity.ts). Name the absence rather than shrugging;
    // `castAbsenceEcho` returns null on an empty or mixed set, so this is purely additive.
    if (verdict.semanticVerified === false) {
      const floor = absentCastFloor(verdict.violations, nctx, text, base);
      return { text: floor.text, cleared: false, engineFloor: floor.engineComposed };
    }
    if (verdict.violations.length === 0) return { text, cleared: true, engineFloor: false };
    let lastViolations = verdict.violations;
    let lastText = text;
    let correction = composeCorrection(verdict.violations);
    for (let i = 0; i < MAX_JUDGE_REGEN && correction; i++) {
      const retry = await dm.narrate(state, nctx, { onReasoning, correction });
      if (retry.blocked || !retry.text.trim()) break;
      const retryVerdict = await judge.adjudicate({ ...base, prose: retry.text }, { force: true });
      // `retryVerdict`, not `verdict` — the first pass's violations are stale by now.
      if (retryVerdict.semanticVerified === false) {
        const floor = absentCastFloor(retryVerdict.violations, nctx, retry.text, base);
        return { text: floor.text, cleared: false, engineFloor: floor.engineComposed };
      }
      if (retryVerdict.violations.length === 0) return { text: retry.text, cleared: true, engineFloor: false };
      lastViolations = retryVerdict.violations;
      lastText = retry.text;
      correction = composeCorrection(retryVerdict.violations);
    }
    const floor = absentCastFloor(lastViolations, nctx, lastText, base);
    return { text: floor.text, cleared: false, engineFloor: floor.engineComposed };
  } catch (err) {
    console.error("Continuity verification failed", err);
    return { text: triggerEcho(nctx), cleared: false, engineFloor: true };
  }
}

/**
 * Honest fail-closed floor for a turn the judge could not scrub of ABSENT-cast references: name the
 * absence instead of the shrug (r4 P1: a paid-for meeting with an absent NPC returned two stacked
 * "The moment passes." stubs — the player learned nothing, twice, at 90 seconds a turn). Applies
 * only when EVERY surviving violation is castPresence with a named offender; any other mix keeps
 * the generic echo (the offense may not be about anyone's whereabouts).
 *
 * `castGuardEcho` is the same floor for the LEGACY cast-guard path (Judge disabled), which carries
 * bare offender NAMES rather than violations.
 */
export function castGuardEcho(
  offenders: string[],
  nctx: NarrationContext,
  roster?: { present?: string[]; absent?: string[] },
): string | null {
  return castAbsenceEcho(
    offenders.filter((o) => o.trim()).map((offender) => ({ kind: "castPresence", offender })),
    nctx,
    roster,
  );
}

/**
 * The offenders this floor may NAME to the player: cast violations only, each carrying a string that
 * is shaped like a name, is not someone standing right here, and — when the turn's roster is known —
 * is on it. Every one of those filters is a live r5 defect: a judge that answered with its own
 * explanation in the offender slot, a floor that announced a present companion's absence under his
 * own reply, and stubs naming figures ("One of the Standing") the world never had.
 */
function nameableOffenders(
  violations: { kind: string; offender?: string }[],
  roster?: { present?: string[]; absent?: string[] },
): string[] | null {
  if (violations.length === 0) return null;
  if (!violations.every((v) => v.kind === "castPresence" && v.offender?.trim())) return null;
  const present = (roster?.present ?? []).filter((n) => n.trim());
  const absent = (roster?.absent ?? []).filter((n) => n.trim());
  const names = [...new Set(violations.map((v) => v.offender!.trim()))].filter((name) => {
    if (!looksLikeName(name)) return false;
    if (present.some((p) => sameName(p, name))) return false;
    return absent.length === 0 || absent.some((a) => sameName(a, name));
  });
  return names.length > 0 ? names : null;
}

/** Loose name identity: exact match, or one name's salient tokens all appearing in the other. */
function sameName(a: string, b: string): boolean {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  return mentionsName(a, b) || mentionsName(b, a);
}

export function castAbsenceEcho(
  violations: { kind: string; offender?: string }[],
  nctx: NarrationContext,
  roster?: { present?: string[]; absent?: string[] },
): string | null {
  const names = nameableOffenders(violations, roster);
  if (!names) return null;
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const absence = `There is no sign of ${list} here.`;
  // The absence must never be the WHOLE turn when the turn produced something: NPC words first,
  // then the engine's own outcome line for a resolved action. r5 P1 spent a successful DC-13
  // perception check on "There is no sign of Bram here." and nothing else — the roll had already
  // succeeded, and the player learned only that rolling is pointless.
  const body = beatEcho(nctx.beats) || outcomeEcho(nctx);
  return body ? `${body} ${absence}` : absence;
}

/** The engine's own player-safe line for whatever this turn resolved, or "" when it resolved nothing. */
function outcomeEcho(nctx: NarrationContext): string {
  const fallback = nctx.echoFallback?.trim();
  if (!fallback) return "";
  const r = nctx.resolved;
  const verdict = r
    ? ` (${r.label}: ${r.success ? "success" : "failure"} — ${r.total}${r.dc !== undefined ? ` vs DC ${r.dc}` : ""}.)`
    : "";
  return `${fallback}${verdict}`;
}

/** Shortest kept remainder worth shipping instead of the echo — below this it reads as a fragment. */
const MIN_SCRUBBED_PROSE = 60;

/**
 * The floor for prose the Judge could not clear of ABSENT-cast references. Preferred order:
 *   1. the same prose with only the offending SENTENCES removed (the rest of the turn was fine —
 *      r5 lost whole scenes, including a successful check's findings, to one stray mention),
 *   2. the honest absence line, carrying the turn's own outcome,
 *   3. the deterministic trigger echo.
 */
function absentCastFloor(
  violations: { kind: string; offender?: string }[],
  nctx: NarrationContext,
  text: string,
  roster?: { present?: string[]; absent?: string[]; placeTokens?: ReadonlySet<string> },
): { text: string; engineComposed: boolean } {
  const names = nameableOffenders(violations, roster);
  if (names && text.trim()) {
    // The SAME binder the violation was raised with — a floor that deletes on a looser rule than the
    // one that flagged can cut a sentence nothing ever objected to (r11: "Anchorfall" ⇒ the man).
    const kept = stripSentencesMentioning(text, names, roster?.placeTokens);
    if (kept.length >= MIN_SCRUBBED_PROSE) return { text: kept, engineComposed: false };
  }
  // The absence echo and the trigger echo are ENGINE prose, composed from committed truth — the
  // caller must not hand them back to the Tier-1 screen (r14, fixture-work t7: the judge fail-closed to
  // the travel echo, whose own honest "(Sergeant Veil stays behind…)" notice was then screened and
  // recorded as a castPresence violation — the engine flagging its own absence device, three rounds
  // running). The stripped-prose branch above stays MODEL prose and keeps its screen.
  return { text: castAbsenceEcho(violations, nctx, roster) ?? triggerEcho(nctx), engineComposed: true };
}
