/**
 * Continuity Judge — the verification-only agent.
 *
 * Every other agent PROPOSES and PHRASES within a scoped view (the classifier reads a line, the DM
 * sees the brief + secret lore, an NPC sees only its own slice). The Judge is their mirror image: it
 * is OMNISCIENT and it only VERIFIES. Given the buffered prose plus the authoritative truth the engine
 * already holds — the present/absent cast, the NPC lines placed in this brief, the resolved verdict,
 * the reducer commands actually authorized this turn, and attributed prior claims — it returns the
 * continuity violations that must be corrected before the prose reaches the player. It never mutates,
 * never enqueues, never phrases fiction.
 *
 * TWO TIERS:
 *   Tier 1 — the deterministic floor (`src/rules/continuity.ts` `screen`): pure, instant, always runs.
 *   Tier 2 — this model pass (utility role, temp 0, JSON): confirms/refutes the Tier-1 flags (killing
 *            false positives the regex is too blunt to avoid) and adds the SEMANTIC violations a regex
 *            cannot see — an implied state change, a contradiction of an established fact.
 *
 * THE FAIL-CLOSED CONTRACT: the model tier is best-effort. Any transport/parse failure degrades to the
 * Tier-1 verdict — NEVER to shipping unchecked. That is the whole reason the floor exists, and it is
 * why the old fail-OPEN `verifyCast` (which shipped the prose on any error) is retired into this agent.
 *
 * @author Runkai Zhang
 */
import type { World } from "../content/schema.ts";
import type { Command } from "../world/commands.ts";
import type { LlmGateway } from "../llm/gateway.ts";
import {
  looksLikeName,
  mentionsName,
  screen,
  type ContinuityVerdict,
  type VerificationBundle,
  type Violation,
  type ViolationKind,
} from "../rules/continuity.ts";

/** A per-kind default correction, so a model-surfaced violation always carries a usable directive. */
const DEFAULT_CORRECTION: Record<ViolationKind, string> = {
  castPresence: "That character is not in this scene — do not mention, quote, stage, or move them.",
  verbatimDropped: "Deliver the NPC's exact words, staged inside your prose.",
  inventedMechanics: "Do not state any dice roll, DC, or numeric result — no roll was made this turn.",
  phantomState: "That change did not happen this turn — do not narrate it as having occurred.",
  phantomCompanion:
    "No one travels with the player — do not describe anyone accompanying, following, or falling into step beside them; any locals nearby are background, not companions.",
  spatialDrift:
    "The party did not travel this turn — do not describe arriving at, entering, or reaching another place; stay where the player already is.",
  verbatimRepeat:
    "You are replaying an earlier moment word-for-word — write fresh prose for what is new this turn only; no re-greeting or restating prior exchanges.",
  establishedContradiction:
    "Preserve what the NPC previously claimed without treating that claim as objective world truth.",
  ledgerContradiction:
    "That is in the world's own record — it happened. Acknowledge it as fact: no one denies it, forgets it, or demands the player prove it. They may resent it, refuse to act on it, or argue about what it MEANS, but not about whether it happened.",
  phantomSupplies:
    "The party does not have those supplies — nothing of the kind is carried. Do not narrate owning, packing, or using them; the lack is real.",
  timeDrift:
    "No night passes and no dawn arrives this turn — the clock has not moved to another day. Stay inside the current moment and time of day.",
  inventedPlayerSpeech:
    "Do not put quoted words in the player's mouth — they speak only what they actually typed; keep their real words or narrate their intent without inventing a spoken line.",
  phaseDrift:
    "The scene stays at the clock's current time of day — do not stage the present moment at another hour; plans, memories, and deadlines may reference other times.",
  pronounDrift:
    "That character's pronouns are canon — restore the shown he/him or she/her; do not change their sex.",
  journeyFabrication:
    "The scene stays where the player actually is — do not stage it in another place, at a distance or direction from the current location, or on a road out of it, and do not invent exits or routes this location does not have.",
};

/**
 * The kinds the model tier may SURFACE. Derived from {@link DEFAULT_CORRECTION}, whose
 * `Record<ViolationKind, …>` type makes it the one tsc-exhaustive list in the file — a hand-kept
 * second copy had already drifted (phantomSupplies and timeDrift were declared in `ViolationKind`
 * but missing here, so `coerceViolation` silently dropped them and the prompt never offered them).
 * Deriving it means a new kind is accepted, listed in the prompt, and given a correction by adding
 * exactly one entry above.
 */
export const VIOLATION_KINDS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_CORRECTION));

export class ContinuityJudge {
  constructor(
    private readonly gateway: LlmGateway,
    private readonly world: World,
    /** Optional model id for the Tier-2 verdict calls (SEED_JUDGE_MODEL) — served on the utility
     *  role's endpoint; unset keeps the role's configured model (r9 F-10 follow-up). */
    private readonly model?: string,
  ) {}

  /**
   * The one entry point. Runs Tier-1 always; escalates to the model tier only when there is something
   * for it to arbitrate (a Tier-1 flag, an absent-cast staging risk, or — for a whisper — established
   * facts to contradict), so a clean flavor turn never pays a model round-trip. Returns the final
   * violation set; empty ⇒ the prose is clear to emit.
   */
  async adjudicate(bundle: VerificationBundle, opts?: { force?: boolean }): Promise<ContinuityVerdict> {
    const tier1 = screen(bundle);
    // `force` bypasses the cost gate: a regeneration retry is ALWAYS fully re-adjudicated, because we
    // only reach a retry after a real violation, and a rephrased semantic contradiction (phantomState /
    // establishedContradiction) can leave Tier-1 clean — `shouldEscalate` would then wave it through.
    if (!opts?.force && !shouldEscalate(bundle, tier1)) return { violations: tier1, semanticVerified: true };
    try {
      const violations = await this.modelAdjudicate(bundle, tier1);
      // Deterministic-authoritative kinds the model tier may not waive: an exact ≥12-word repeat is
      // string identity, not semantics — there is nothing for the arbiter to arbitrate, and it never
      // saw the recent-narration texts anyway. Union them back in (deduped by kind).
      const kept = new Set(violations.map((v) => v.kind));
      const deterministic = tier1.filter((v) => v.kind === "verbatimRepeat" && !kept.has(v.kind));
      return { violations: [...violations, ...deterministic], semanticVerified: true };
    } catch {
      // Tell callers that required semantic verification did not happen. They can fall back to
      // deterministic engine prose rather than mistaking an empty Tier-1 set for model approval.
      return { violations: tier1, semanticVerified: false };
    }
  }

  /** The Tier-2 model pass. Throws on an unusable response so `adjudicate` degrades to Tier-1. */
  private async modelAdjudicate(bundle: VerificationBundle, tier1: Violation[]): Promise<Violation[]> {
    const res = await this.gateway.complete("utility", {
      ...(this.model !== undefined ? { model: this.model } : {}),
      messages: [
        { role: "system", content: this.systemPrompt(bundle.mode) },
        { role: "user", content: userPrompt(bundle, tier1) },
      ],
      temperature: 0,
      // Generous on purpose: a hybrid reasoning model (deepseek-v4-flash) thinks for ~400–900
      // tokens before the first content token, so a tight cap comes back EMPTY at finish=length —
      // and an unusable verdict fails this turn closed, replacing good narrator prose with the
      // trigger echo (live finding #6, r2). The verdict JSON itself is tiny; the headroom is for
      // the thinking. The provider's empty-at-length retry backstops models that think even longer.
      maxTokens: 2048,
      json: true,
      // Per-request thinking-off: the verdict is a tiny JSON object — chain-of-thought buys nothing
      // and, on a hybrid reasoning model, burns 400–900 tokens per escalated turn (the "JUDGE burn").
      // Independent of the utility role's global SEED_UTILITY_THINKING, so the classifier keeps CoT.
      // The 2048 ceiling stays as a backstop for endpoints that ignore the disable flag.
      thinking: "off",
    });
    const parsed = JSON.parse(extractJsonObject(res.text)) as unknown;
    const raw = (parsed as { violations?: unknown })?.violations;
    if (!Array.isArray(raw)) throw new Error("no violations array");
    const roster = rosterNames(bundle);
    return raw.map((v) => coerceViolation(v, roster)).filter((v): v is Violation => v !== null);
  }

  private systemPrompt(mode: VerificationBundle["mode"]): string {
    const subject =
      mode === "whisper"
        ? "an NPC's private spoken line (first person — the NPC's OWN words)"
        : "the Game Master's narration of a scene";
    return [
      `You are the continuity checker for "${this.world.name}". You judge ${subject} against the authoritative game state.`,
      "You are given ground truth (cast, required NPC lines, resolved mechanics, and authorized commands) plus PRIOR NPC CLAIMS. Claims are evidence of what a speaker said, not objective world truth; NPCs may lie or be mistaken.",
      "Return the FINAL list of continuity violations. Confirm only genuine conflicts with ground truth. For prior claims, flag only prose that silently rewrites who claimed what or makes the same speaker contradict itself without explanation; do not promote a claim to canon and do not flag an authored/code-grounded revelation that the claim was false.",
      "Grim or violent prose is NOT a violation. You judge ONLY factual continuity with the game state, never tone or taste.",
      "Two location/party violations to watch for: phantomCompanion — the prose stages someone travelling WITH, accompanying, or falling into step beside the player when the PARTY line shows no such companion (ambient background people are NOT companions); spatialDrift — the prose says the party arrived at, entered, or reached another place when the authorized commands show NO travel happened this turn.",
      "One more, and it outranks the rest: THE RECORD is the world's own ledger of what the player has taken on. It is authoritative in a way PRIOR NPC CLAIMS are not. Any line that denies a recorded fact, professes ignorance of it, or makes the player prove it is a ledgerContradiction — characters may resent or refuse, but the world never forgets its own commitments. Rows marked [TRAVELED] are journeys the party really made; a line claiming such a journey has not happened is a ledgerContradiction.",
      "phaseDrift — the prose stages the CURRENT scene at a time of day contradicting the authoritative clock (an evening meal narrated on a morning clock). A character PLANNING or REMEMBERING another hour (\"we leave at dawn\", \"till morning\") is NOT a violation; only present-scene staging counts.",
      "pronounDrift — the prose refers to a present character with pronouns or a sex contradicting the PRONOUNS (canonical) line. One flipped he→she is a violation; an in-fiction disguise or misreading is only legal when the ground truth says so.",
      "journeyFabrication — the prose stages the CURRENT scene somewhere other than the PLACE line, gives a distance or direction from it as if standing outside it, claims a journey the party did not make, or offers a road/track/path out of here that is not on its route list. Characters PLANNING or REMEMBERING another place are NOT violating this; only present-scene staging and invented routes count.",
      // Derived, never hand-written: the literal list had silently drifted out of sync with
      // ViolationKind (phantomSupplies and timeDrift were declared but absent here, so the model
      // tier could never SURFACE either — only confirm them as Tier-1 flags). A list computed from
      // the accepted set cannot drift again.
      `Respond with STRICT JSON only: {"violations":[{"kind":"...","offender":"...","detail":"...","correction":"..."}]}. Use an empty array if the prose is fully consistent. Valid kinds: ${[...VIOLATION_KINDS].join(", ")}. "correction" is a short directive telling the narrator how to fix it.`,
    ].join("\n");
  }
}

/** Escalate to the model only when it has something to arbitrate — bounds cost on clean turns. */
function shouldEscalate(bundle: VerificationBundle, tier1: Violation[]): boolean {
  if (tier1.length > 0) return true;
  if ((bundle.absent?.length ?? 0) > 0) return true; // cast-staging risk — semantic staging check
  // Established facts risk an `establishedContradiction` in BOTH modes: ordinary narration can
  // contradict a fact just as a whisper can, and Tier-1 (regex) can't detect a semantic contradiction
  // or a phantom state change. Escalate whenever the turn carries facts the prose could contradict.
  if ((bundle.established?.length ?? 0) > 0) return true;
  // An active fight is a standing high-contradiction risk Tier-1 cannot see: prose for a NON-attack
  // intent routinely declares a live foe dead ("the Revenant is down") or paints an attacker as
  // not-yet-hostile ("his blade still sheathed" the turn it struck) — both observed live (r4-A/E).
  // Foe status is engine truth; only the semantic tier can hold prose to it.
  if (bundle.isCombat) return true;
  // Someone fell this turn — kill-turn prose contradicting the defeat (r3 #1) is exactly what the
  // semantic tier exists to catch, even when the fight ends outside a formal combat encounter.
  if ((bundle.downed?.length ?? 0) > 0) return true;
  return false;
}

function userPrompt(bundle: VerificationBundle, tier1: Violation[]): string {
  const lines: string[] = [];
  if (bundle.mode === "narration") {
    lines.push(`PRESENT (the only characters who may be staged here): ${(bundle.present ?? []).join(", ") || "(no one — the player is ALONE)"}`);
    lines.push(`ELSEWHERE (never valid to stage as present): ${(bundle.absent ?? []).join(", ") || "(none)"}`);
    lines.push(`PARTY (the ONLY people travelling with the player; anyone else present is NOT a companion): ${(bundle.party ?? []).join(", ") || "(none — the player travels ALONE)"}`);
    const spoken = (bundle.beats ?? [])
      .map((b) => (b.dialogue ?? (b.lines ?? []).map((l) => l.text).join(" ")).trim())
      .filter(Boolean);
    if (spoken.length > 0) {
      lines.push(`NPC LINES THAT MUST BE DELIVERED VERBATIM: ${spoken.map((s) => `"${s}"`).join(" | ")}`);
      // The one exception, and the reason public NPC speech needs no separate round-trip: a required
      // line is required PROSE, not licensed CANON. If it denies THE RECORD it is the violation —
      // dropping it is correct, and flagging it verbatimDropped would protect the fabrication
      // (playtest 07-24: the companion's "the bond was paid this morning" entered as ground truth).
      if ((bundle.ledger?.length ?? 0) > 0) {
        lines.push(
          "A required line is NOT automatically true: if one of them contradicts THE RECORD below, report it as ledgerContradiction — do NOT also report it as verbatimDropped.",
        );
      }
    }
    lines.push(
      bundle.resolved
        ? `A roll WAS resolved this turn: ${bundle.resolved.label} → ${bundle.resolved.success ? "success" : "failure"}. Narrating that outcome is correct; inventing a DIFFERENT number is not.`
        : `NO roll was resolved this turn — the prose must not state any dice result, DC, or definite success/failure of an uncertain task.`,
    );
    if (bundle.isCombat) {
      lines.push(
        "COMBAT IS ACTIVE this turn. Every combatant not covered by an authorized command or resolved mechanics is still alive, hostile, and fighting. Prose that declares a foe dead, defeated, fled, or harmless — or that paints the scene as calm, at peace, or pre-fight (an attacker who \"has not moved\", a weapon \"still sheathed\" after they struck) — is a phantomState violation.",
      );
    }
    if ((bundle.downed?.length ?? 0) > 0) {
      lines.push(
        `DOWNED THIS TURN (authoritative — they fell and are OUT of the fight): ${bundle.downed!.join(", ")}. Prose that shows any of them still standing, attacking, waiting to strike, or otherwise able to act is a phantomState violation; the narration must show them fallen.`,
      );
    }
  }
  if (bundle.mode === "narration" && (bundle.presentPronouns?.length ?? 0) > 0) {
    lines.push(`PRONOUNS (canonical): ${bundle.presentPronouns!.join(", ")}.`);
  }
  if (bundle.mode === "narration" && (bundle.dayPhases?.length ?? 0) > 0) {
    lines.push(
      `TIME OF DAY (authoritative clock): ${bundle.dayPhases!.join(" → ")}. Only present-scene staging can violate this; plans, memories, and deadlines referencing other hours are legal.`,
    );
  }
  if (bundle.mode === "narration" && bundle.locale?.here) {
    lines.push(
      `PLACE (authoritative): the scene is IN "${bundle.locale.here}"` +
        (bundle.locale.exits.length > 0
          ? `. Its ONLY routes out are: ${bundle.locale.exits.join("; ")}.`
          : `, which has no routes out.`) +
        ` Prose that stages the present scene anywhere else, gives a distance or direction from it as if standing outside it, or lists any other road leading out of here is journeyFabrication.`,
    );
  }
  lines.push(`WORLD CHANGES AUTHORIZED THIS TURN (command + salient ids): ${summarizeCommands(bundle)}`);
  if ((bundle.established?.length ?? 0) > 0) {
    lines.push(`PRIOR NPC CLAIMS (speaker continuity only; NOT objective world truth): ${bundle.established!.join("; ")}`);
  }
  if ((bundle.ledger?.length ?? 0) > 0) {
    lines.push(
      `THE RECORD (the world's OWN ledger — authoritative, unlike prior claims): ${bundle.ledger!.join("; ")}. ` +
        `Prose or a line that denies one of these, claims not to know of it, or demands the player prove it is a ledgerContradiction. ` +
        `Disagreeing about what it MEANS, or refusing to act on it, is fine — denying that it happened is not.`,
    );
  }
  if (tier1.length > 0) lines.push(`SUSPECTED ISSUES to confirm or dismiss: ${tier1.map((v) => `[${v.kind}${v.offender ? ` ${v.offender}` : ""}] ${v.detail}`).join(" | ")}`);
  lines.push("", bundle.mode === "whisper" ? "NPC LINE:" : "PROSE:", bundle.prose);
  return lines.join("\n");
}

function summarizeCommands(bundle: VerificationBundle): string {
  const cmds = bundle.authorizedCommands ?? [];
  if (cmds.length === 0) return "(none — no durable world change this turn)";
  // Carry the SALIENT identifier of each narratively-significant command — still pure code reading the
  // authoritative Command objects (no new LLM trust for state) — so an escalated Judge can catch a
  // WRONG actor / item / destination / amount / quest, not merely a wrong command TYPE: the right
  // command type over the wrong payload used to pass unremarked (audit #8). Unlisted types degrade to
  // their bare name; identical descriptors dedup (distinct ids stay distinct).
  const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
  const describe = (c: Command): string => {
    switch (c.type) {
      case "moveParty":
        return `moveParty(to=${c.to})`;
      case "moveEntity":
        return `moveEntity(${c.entityId}→${c.to})`;
      case "transferItem":
        return `transferItem(item=${c.itemId}, from=${c.from ?? "world"}, to=${c.to ?? "world"})`;
      case "adjustHp":
        return `adjustHp(${c.entityId} ${sign(c.by)})`;
      case "adjustCoins":
        return `adjustCoins(${c.entityId} ${sign(c.by)})`;
      case "adjustRelationship":
        return `adjustRelationship(${c.actorId}→${c.targetId} ${sign(c.by)})`;
      case "setQuestState":
        return `setQuestState(${c.questId}=${c.state})`;
      case "spawnEntity":
        return `spawnEntity(${c.entity.id}${c.entity.name ? `="${c.entity.name}"` : ""})`;
      case "despawnEntity":
        return `despawnEntity(${c.entityId})`;
      case "setExitState":
        return `setExitState(${c.locationId}→${c.to}=${c.state})`;
      case "setCondition":
        return `setCondition(${c.entityId} ${c.condition}=${c.active ? "on" : "off"})`;
      default:
        return c.type;
    }
  };
  return [...new Set(cmds.map(describe))].join(", ");
}

/**
 * Snap a model-returned `offender` to a name the world actually knows, or drop it.
 *
 * The slot is free text and a live r5 model filled it with its own explanation — which the absence
 * floor printed to the player verbatim ("There is no sign of The prose references 'Jessup' as a
 * named character with a gate-post and a cart, but Jessup is not in the PRESENT list. here."). An
 * exact roster hit wins; failing that, the roster name the sentence is ABOUT; failing that, a
 * name-shaped string stands (an off-roster prose figure is still a usable correction directive);
 * anything else is not a name and is dropped.
 */
function sanitizeOffender(raw: string, roster: string[]): string | undefined {
  const s = raw.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (!s) return undefined;
  const exact = roster.find((n) => n.trim().toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const about = roster.find((n) => mentionsName(s, n));
  if (about) return about;
  return looksLikeName(s) ? s : undefined;
}

/** Every name this turn's ground truth knows — the target set `sanitizeOffender` snaps to. */
function rosterNames(bundle: VerificationBundle): string[] {
  return [
    ...(bundle.present ?? []),
    ...(bundle.absent ?? []),
    ...(bundle.party ?? []),
    ...(bundle.downed ?? []),
    ...(bundle.beats ?? []).map((b) => b.name),
  ].filter((n) => typeof n === "string" && n.trim());
}

/** Validate + normalize one model-returned violation; returns null when unusable (dropped, not thrown). */
function coerceViolation(raw: unknown, roster: string[] = []): Violation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === "string" && VIOLATION_KINDS.has(r.kind) ? (r.kind as ViolationKind) : null;
  if (!kind) return null;
  const offender =
    typeof r.offender === "string" && r.offender.trim() ? sanitizeOffender(r.offender, roster) : undefined;
  // A cast violation IS its person: with no nameable offender there is nothing to forbid on
  // regeneration and nothing honest to tell the player, and the r5 run showed what shipping one
  // anyway costs — a whole turn (a legitimate look at an unattended cart) replaced by a stub.
  if (!offender && kind === "castPresence") return null;
  const detail = typeof r.detail === "string" && r.detail.trim() ? r.detail.trim() : kind;
  const correction =
    typeof r.correction === "string" && r.correction.trim() ? r.correction.trim() : DEFAULT_CORRECTION[kind];
  return { kind, offender, detail, correction };
}

/**
 * Extract the first JSON object from a response that may be wrapped in prose or ```json fences. Falls
 * back to the whole string so a clean JSON reply parses directly. (Mirrors the DM's verifier helper.)
 */
function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}
