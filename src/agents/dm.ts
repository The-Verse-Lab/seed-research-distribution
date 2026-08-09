/**
 * Dungeon Master agent — narrates scenes and adjudicated outcomes.
 *
 * The GM voices the world and minor NPCs and describes results, but never invents
 * mechanical numbers. When a NarrationContext carries a `resolved` verdict, the GM
 * narrates THAT exact outcome — it is a renderer of the result, not its decider. Output
 * streams via the narrator role; the engine emits one terminal narration event.
 *
 * @author Runkai Zhang
 */
import type { World } from "../content/schema.ts";
import type { GameState } from "../state/types.ts";
import type { LlmGateway } from "../llm/gateway.ts";
import type { ChatMessage } from "../llm/types.ts";

/**
 * A generated agent line plus the safety outcome. `blocked` is set iff the GuardedGateway refused
 * the generation (minor-safety) — the caller then renders a firm OOC refusal and does NOT fall
 * back to offline narration. Shared by the DM and NPC agents.
 */
export interface GenerationResult {
  text: string;
  blocked?: boolean;
  /**
   * The provider stopped at the token cap with prose still to write — `finish_reason: "length"` on a
   * NON-empty completion. The empty-and-length case (a reasoning model that spent the whole budget
   * thinking) is already retried inside the provider; this is its sibling, where the model spent
   * PART of the budget thinking and the visible prose was cut instead. r11: 10 of 120 sweep turns
   * shipped a sentence that stops mid-clause, one of them 41 characters long, with nothing flagged
   * anywhere — `providerFinishReason` reached the gateway and no caller read it.
   */
  truncated?: boolean;
}

/** A resolved rules verdict to be narrated as authoritative fact. */
export interface ResolvedMechanics {
  /** Human label, e.g. "Dexterity (Stealth) check". Built by the engine, not the model. */
  label: string;
  dc?: number;
  total: number;
  success: boolean;
  critical: "success" | "failure" | null;
  /** True for a mechanics hard-refusal where no roll was allowed. */
  refused?: boolean;
  /** Optional additive combat details; the RESOLVED MECHANICS header stays byte-stable. */
  damage?: number;
  damageType?: string;
  /**
   * Optional binding instruction appended to the block (e.g. "the player REFUSED — a lost roll is
   * pressure overcoming resistance, never willing compliance"). Engine-authored, not the model.
   */
  note?: string;
}

/**
 * The scene that owns this turn, for the per-scene narrator stance (Concordia transfer #8,
 * `NEXT_GAME_MASTER`). Derived from world state by `narrationSceneOf` (src/agents/context.ts) with
 * the same precedence the scene-narrowed classifier uses. Absent ⇒ free play ⇒ byte-identical
 * prompt — the stance paragraph and the brief-block drops only exist while a scene is live.
 */
export type NarratorScene = "combat" | "captivity" | "lodging";

/**
 * Per-scene GM stance — CRAFT guidance only (register, pacing, focus). Deliberately not a whole
 * swapped GM: every hard rule (mechanics honesty, cast discipline, authorship, content gates)
 * stays identical across scenes; what changes is the voice asked of the same narrator.
 */
const SCENE_STANCES: Record<NarratorScene, string> = {
  combat: [
    "",
    "Scene stance — COMBAT is live:",
    "- Narrate in tight, kinetic beats: short sentences, concrete positions, cause and effect. Every line advances the fight.",
    "- Keep the camera on the fight — no shop talk, no scenery tours, no reminiscence. End on the pressure of the next move.",
  ].join("\n"),
  captivity: [
    "",
    "Scene stance — the player is HELD:",
    "- Narrate the weight of confinement: small sensory detail, the captor's presence, time pressing. Options should be felt as constraints.",
    "- Do not soften the imbalance or invent comforts the scene has not granted.",
  ].join("\n"),
  lodging: [
    "",
    "Scene stance — the player is ABED in a rented room:",
    "- Quiet register: rest, the room, sound through the walls, the body unwinding. Keep it brief unless something intrudes on the quiet.",
  ].join("\n"),
};

export interface NarrationContext {
  /** Full assembled brief (world/location/present/recent + the # NOW trigger + resolved). */
  contextText: string;
  /** The grounded action being narrated (also embedded in contextText under # NOW). */
  trigger: string;
  /**
   * Player-safe fallback prose used INSTEAD of the raw `trigger` when the narrator produces nothing
   * (reasoning-burn empty / OOC refusal). The default echo restates `trigger`, which is fine for a
   * plain grounded action but LEAKS authoring instructions for triggers that embed a `(Narrate …)`
   * directive. When set, `triggerEcho` returns this instead. Omitted ⇒ historic echo.
   */
  echoFallback?: string;
  resolved?: ResolvedMechanics;
  /**
   * GM-ONLY secret lore (already rendered as bullets) from read-only retrieval. THE PRIVACY
   * BOUNDARY: this is appended to the DM's own user message in `narrate()` and lives there ONLY —
   * it is deliberately NOT part of `contextText`, so it never reaches the shared brief or any NPC
   * `reply()`/`decide()` prompt (which consume `contextText`). The GM may act on this hidden canon;
   * the player-facing brief and NPCs never see it. Omitted when empty ⇒ byte-identical narrate
   * message for a no-secret world. Pure prompt context: it carries no state and changes nothing.
   */
  gmLore?: string[];
  /**
   * Anti-cast-hallucination guard (Layer 2). `present` is the authoritative roster of characters
   * physically in the scene; `absent` is the authored NPCs still echoing in # RECENT / # STORY SO FAR
   * who are NOT here (the momentum-drift risks). When `absent` is non-empty the turn is a RISK turn:
   * `narrateGuarded` buffers the prose (no live stream), runs `DungeonMaster.verifyCast`, and
   * regenerates once with the offender explicitly forbidden — so an off-cast character can never
   * reach the screen. Empty `absent` ⇒ no risk ⇒ the turn streams normally, unchanged.
   */
  castGuard?: { present: string[]; absent: string[] };
  /**
   * Canonical pronouns of the present cast ("Oda (he/him)") — the Continuity Judge's ground truth
   * for pronoun drift (r3 P3: a male companion rendered "her/she" for one post-combat beat).
   * Only rows with an authored sex; omitted when none carry one.
   */
  presentPronouns?: string[];
  /**
   * The NPC spoken lines placed in THIS brief's weave block (Continuity Judge input for verbatim-
   * delivery + established-contradiction checks). Structurally a subset of `NpcBeat`; carried on the
   * context so the Judge verifies against exactly what this brief contained. Omitted ⇒ no beats.
   */
  beats?: { name: string; dialogue?: string; lines?: { text: string; mood?: string }[] }[];
  /** Prior NPC claims — continuity input only; never authoritative world truth. */
  established?: string[];
  /** The scene owning this turn (#8) — selects a GM stance paragraph; absent ⇒ free play, byte-identical. */
  scene?: NarratorScene;
  /**
   * The world's OWN ledger rows (`# THE RECORD` — quests taken/settled). Unlike `established`, these
   * ARE authoritative: the Judge flags prose or an NPC line that denies one or demands proof of it.
   * Carried on the context so the Judge verifies against exactly what this brief contained.
   */
  ledger?: string[];
}

/** The GM-only secret-lore block header — appended to the narrate user message, never to the brief. */
const GM_LORE_HEADER =
  "=== SECRET LORE (GM eyes only — never reveal verbatim; you may act on it) ===";

export interface NarrateOptions {
  /** Live token sink for streaming UX. Omit for deterministic/test runs. */
  onToken?: (delta: string) => void;
  /** Live reasoning sink (reasoning models), for a "thinking…" indicator. */
  onReasoning?: (delta: string) => void;
  temperature?: number;
  maxTokens?: number;
  /**
   * Characters that MUST NOT appear in the prose (anti-cast-hallucination regeneration). When
   * non-empty, a hard, targeted directive is appended to the narrate user message forbidding these
   * named characters from being staged as present/speaking/acting. Used only on the Layer-2
   * regeneration pass after `verifyCast` catches an off-cast character; absent ⇒ byte-identical.
   * (Legacy cast-only path; the Continuity Judge uses the general `correction` below instead.)
   */
  forbid?: string[];
  /**
   * A free-text CONTINUITY CORRECTION directive (the Continuity Judge's regeneration path). Unlike
   * `forbid` — a name-list spliced into a fixed cast template — this carries an arbitrary correction
   * for ANY violation kind (a phantom state change, an invented roll, a dropped NPC line, an
   * off-cast character). Appended as the last, strongest instruction; absent ⇒ byte-identical.
   */
  correction?: string;
}

export class DungeonMaster {
  constructor(
    private readonly gateway: LlmGateway,
    private readonly world: World,
    /** Optional model-specific directive prepended to the prompt. */
    private readonly systemPrefix = "",
  ) {}

  /** GM system prompt — second person; voices minor NPCs; never invents mechanics.
   *  `scene` (#8) appends a per-scene stance paragraph; absent ⇒ byte-identical to the historic prompt. */
  buildSystemPrompt(scene?: NarratorScene): string {
    // P1 — the authored per-world narrative style, omit-when-empty (absent ⇒ byte-identical prompt).
    const styleLines = (this.world.style ?? []).map((s) => s.trim()).filter(Boolean);
    const styleBlock =
      styleLines.length > 0
        ? ["", "Narrative style (authored for this world — follow it):", ...styleLines.map((s) => `- ${s}`)]
        : [];
    const base = [
      `You are the Game Master of "${this.world.name}", a tabletop role-playing game.`,
      this.world.summary,
      ...styleBlock,
      "",
      "Your job:",
      `- Narrate vividly, in the SECOND PERSON ("you see…", "you feel…"), addressing the player directly.`,
      "- You are the ONLY voice of every NPC. When an NPC ACTIONS THIS TURN block is present, DELIVER each NPC's exact words to the player, woven into vivid staged prose — set the moment (their gesture, glance, movement, how they draw near) and quote their words inside your narration (e.g. *She catches your sleeve, leans close, and murmurs, \"…\"*). Never drop, summarize away, or reorder the words; render their staging/action as it happens. Do not print bare \"Name: line\" dialogue — always stage it.",
      // P3 — length by weight, not a fixed count.
      "- Advance the fiction from what the player just did. Be concrete and sensory; 1–3 short paragraphs. Match length to the beat: a routine action earns one tight paragraph — save three for major turns, never pad.",
      "- Only describe what follows from the established world, location, and recent events.",
      "- When the brief carries an Attire: or Visibly: line, characters present notice — weave a glance, remark, or reaction into the scene rather than silently ignoring it.",
      "",
      "Hard rules:",
      "- NEVER invent dice results, hit points, DCs, or any mechanical number. When a RESOLVED MECHANICS block is present, narrate that exact outcome as fact — do not re-roll, soften, or contradict it.",
      // Backstop to the classifier: a genuinely uncertain attempt should have arrived with a
      // RESOLVED MECHANICS verdict. If it did NOT, do not silently decide it in the player's favor.
      "- If the player attempts something whose success is genuinely in doubt (a skilled, contested, or risky task — talking someone around, tallying a manifest right, spotting a hidden thing, forcing a door) and there is NO RESOLVED MECHANICS block, do NOT declare that they succeed or fail. Narrate the effort and the moment it hangs on — the NPC waiting on the result, the strain, the half-done work — and leave the payoff unresolved for the roll to settle. Only narrate a definite success or failure when a RESOLVED MECHANICS block tells you which it was.",
      // The phantom-transaction drift (live 07-18 #1: a freeform "purchase" narrated as accepted while
      // the purse never changed). Possessions and payments are MECHANICAL: only the engine moves them,
      // and when it does the change is listed in TURN FACTS / RESOLVED / CONSEQUENCES.
      "- Never state that items, coins, or gear changed hands — bought, sold, paid, accepted, given, taken, pocketed, handed over — unless a `=== TURN FACTS`, `=== RESOLVED MECHANICS`, or `=== CONSEQUENCES` block backs that exact exchange. Without that backing the deal is still OPEN: the player may offer, haggle, or lay coins on the counter, but the goods stay where they are and the payment is NOT yet accepted — narrate the attempt and leave the exchange unresolved. Never invent a price, a change of purse, or an NPC accepting payment on your own.",
      "- If an NPC action in the weave block is marked REJECTED, do NOT narrate it as succeeding — show the attempt failing or falling short, never its intended effect.",
      // The phantom-provisioning drift (r2 P1: "We've got your rations and water" over a pack that
      // held a staff and a hat — the player crossed a desert believing they were provisioned).
      "- The `You carry:` line is the COMPLETE list of what the player owns. Never narrate the player or party possessing, packing, using, or being handed supplies — rations, water, rope, tools, gear — that are not on that line (or granted by a TURN FACTS/RESOLVED block this turn). If they failed to buy provisions, they DO NOT have provisions: let the lack show. An NPC must not claim the party is provisioned when the line says otherwise.",
      "- `# PRIOR NPC CLAIMS` records what NPCs said, not objective truth. Preserve who claimed what; never turn a claim into canon unless authored lore or code-state supports it. An NPC may lie or be mistaken.",
      "- Do not speak or decide for the player character. Do not skip past the player's next choice.",
      // Playtest 07-24 P2/P4 — the two ways the GM took the character away from the player. Both are
      // about AUTHORSHIP, not about sensation: the second-person mandate above still stands, and the
      // hostile content still requires narrating fear, pain, and resistance honestly. What is
      // forbidden is inventing the player's WORDS and asserting their INNER LIFE as settled fact.
      "- The player character's quotation marks may contain ONLY words the player actually typed this turn. When they agree, consent, or go along with something, narrate the agreement and what follows — a nod, a shouldered pack, the party moving — but do NOT compose speeches for them. If a companion's plan is quoted in the brief, those are the COMPANION's words: never re-attribute them to the player.",
      "- Do not narrate the player character's interior as established fact — what they want, feel about a choice, believe, intend, have already decided, or have 'already figured out'. Their motives are the player's to declare. Describe the world, their body, and what happens to them; leave the reading of it to them. (\"That's the one that tugs at you, isn't it?\" is exactly the overreach — it answers a question only the player may answer.)",
      // An NPC's quotation marks are for SPOKEN WORDS only — the reported bug was Oda 'saying' a
      // third-person stage direction ("Violet extends her hand and a flame appears") and inventing a
      // player action that never happened.
      "- An NPC's quotation marks contain ONLY the words they say aloud. NEVER put narration, stage directions, or a description of anyone's actions inside an NPC's quotes — a movement or gesture is YOUR prose, unquoted. And never invent, repeat, or attribute an action to the player character that they did not actually take this turn; describe only what the player really did.",
      // Anti-hallucination of the cast — the reported Oda-still-beside-you drift. The `Present:` line
      // is the COMPLETE and AUTHORITATIVE roster of who is physically in the scene; a `Not present`
      // line (when shown) names characters who are elsewhere and must NOT be depicted here.
      "- The `Present:` line is the COMPLETE and ONLY set of characters physically in the scene right now. NEVER depict, quote, address, or narrate an action for any character who is not on that line — even if they appeared moments ago under # RECENT or # STORY SO FAR. A companion or NPC the player walked away from is GONE: do not carry them along, do not have them speak or follow. If `Present:` says you are alone, you are ALONE. If a `Not present` line names someone, they are elsewhere — never place them in this scene.",
      // Pronoun canon (r3 P3: Oda rendered "her/she" for one post-combat beat; the Taker drifted
      // male→"the woman" across days). The tag is data, not flavor — the prose may never flip it.
      "- The pronoun tag on a `Present:` row — (he/him) or (she/her) — and the sex shown on a `# CANON NAMES` row are CANON. Always use that character's shown pronouns and sex; never flip a he to a she (or the reverse) mid-scene, whatever the surrounding prose suggests.",
      // Party vs background — the reported "four locals followed me from the start" drift. The ambient
      // crowd (`(local)` rows) is scenery, and the `Party:` line is the AUTHORITATIVE roster of who
      // actually travels with the player; a stale summary claiming otherwise must be ignored.
      "- The `Party:` line is the COMPLETE and ONLY list of who travels WITH the player. A present row marked `(local)` is ambient background — a face in the crowd, not a companion. You may sketch such people as scene colour, but NEVER name them, give them a through-line, have them follow the player between places, or describe them as travelling with / accompanying / joining the party. If `Party:` says the player travels alone, they travel alone no matter how many `(local)` people stand nearby — ignore any earlier prose or summary that says otherwise.",
      // The INVERSE drift (reported): a present TRACKED character narrated as LEAVING — walking off,
      // "gone before you can call after him" — while the game still has them right here. You do NOT
      // decide what a companion or named NPC does; their choices/movements are theirs (delivered in the
      // `NPC ACTIONS THIS TURN` block). Whether they leave is a MECHANICAL move the engine resolves; it
      // shows up as their absence from `Present:` on a LATER turn. This binds real cast ONLY — the
      // ambient `(local)` crowd is exempt (it is scenery the engine reaps automatically on the next move,
      // so letting a face in the crowd drift off is natural, not a phantom departure).
      "- You never DECIDE what a party companion or named NPC on the `Present:` line does. They STAY in the scene: NEVER narrate such a character leaving, walking away, exiting, or heading elsewhere UNLESS an `NPC ACTIONS THIS TURN` entry explicitly says they move. They may turn from the conversation, but remain physically here until the game itself moves them. This does NOT apply to `(local)` background people — they may drift by or melt back into the crowd as ordinary scene motion; simply never give them a name, a through-line, or party membership.",
      // Anti spatial/geography drift: the map is the engine's, not the GM's. Colour (naming a distant
      // tavern, a keep on the ridge) is fine; presenting a non-exit place as reachable-this-turn, or
      // asserting travel the engine did not perform, desyncs state from the prose.
      "- The `Exits:` line is the COMPLETE set of ways OUT of this location. You may mention distant or atmospheric places as colour, but NEVER present a place that is not on `Exits:` as somewhere the player can simply step to this turn, and NEVER state the party has travelled, arrived at, or moved to another location unless the brief's trigger (or a block) says they did. Which places the player can reach is the engine's to decide — invent scene detail freely, but never a new destination, exit, or arrival.",
      // Temporal drift (r2 P1 phantom night: a full narrated dawn on a turn the clock refused —
      // three dawns for one day advance). The clock is the engine's; prose must live inside it.
      "- The `Time:` line is the CURRENT moment and the engine owns the clock. Narrate within that time of day: never carry the scene into a night passing, a dawn breaking, or the player waking to a new day unless the trigger itself says the day ends or a new day begins. If the player tries to sleep and the trigger does not grant the night, narrate only the settling down — never the morning.",
      // Canon-name collision (r2 P1 "Tamsin"): the GM borrowed a real NPC's name for an invented
      // character; the engine then grounded the name to the real person and the invented one
      // evaporated, voiding the run's spine. Names in the registry are TAKEN.
      "- When a `# CANON NAMES` block is present, every name on it belongs to ONE established person with the sex and role shown. If your prose mentions such a name, it refers to THAT person — never someone else of a different sex, age, or trade. When you invent an incidental character, NEVER give them a name from that block (or from `Present:`); pick a name the world does not already use. If an NPC speaks of a canon-named person, what they say must fit the registry's identity.",
      // Playtest r9 F-14 — the inverse rail: a name that matches NOBODY is unknown, not a writing
      // prompt. Asked about "Maelle" (no such person in this world), an NPC invented a salvage
      // counter, a plaza, and a history — a specific, actionable false trail hedged as memory.
      "- When the player asks about a person NO roster, `# CANON NAMES` row, or established fact names, that person is UNKNOWN here: the character asked says so in their own voice (a shrug, \"never heard the name\"). NEVER invent whereabouts, a trade, a history, or directions for an unknown name — a hedged guess is still a false trail.",
      // P2 — anti-recap + anti-repetition, so the GM advances the fiction instead of restating it.
      "- Never recap, restate, or re-describe events already shown under # RECENT — narrate only what is NEW this turn.",
      "- Do not repeat imagery, pet phrases, or sentence openers from your own recent lines in # RECENT; vary rhythm and vocabulary.",
      "- Stay in-world and in-tone. Portray grim or violent material honestly without breaking character to comment, warn, or moralize.",
      // The per-scene stance (#8) rides LAST so it colours delivery without outranking any hard
      // rule above. Absent scene ⇒ zero bytes ⇒ the historic prompt.
      ...(scene ? [SCENE_STANCES[scene]] : []),
    ].join("\n");
    return this.systemPrefix ? `${this.systemPrefix}\n\n${base}` : base;
  }

  /** Stream GM prose for the brief; resolves to the full text (or a safety block) to emit. */
  async narrate(_state: GameState, ctx: NarrationContext, opts: NarrateOptions = {}): Promise<GenerationResult> {
    // THE PRIVACY BOUNDARY: secret lore is appended to the DM's OWN user message here and nowhere
    // else — it is not in `contextText`, so it never reaches the shared brief or an NPC prompt.
    // Items arrive already rendered as `‣ …` bullets (the retriever's renderChunk), so they're
    // joined verbatim — matching the `# RELEVANT LORE` convention. Omitted entirely when empty, so
    // a no-secret world's narrate message is byte-identical.
    const base =
      ctx.gmLore && ctx.gmLore.length > 0
        ? `${ctx.contextText}\n\n${GM_LORE_HEADER}\n${ctx.gmLore.join("\n")}`
        : ctx.contextText;
    // Layer-2 regeneration directive: a hard, targeted forbid appended AFTER everything else so it
    // is the last (and strongest) instruction the model reads. Empty ⇒ byte-identical narrate message.
    const forbid = (opts.forbid ?? []).map((n) => n.trim()).filter(Boolean);
    const correction = opts.correction?.trim();
    // Two correction sources, appended AFTER the brief so they are the last (strongest) thing read.
    // `forbid` keeps its exact legacy template (byte-identical for the cast-guard tests); `correction`
    // carries the Judge's free-text directive. Both absent ⇒ byte-identical narrate message.
    let userContent = base;
    if (forbid.length > 0) {
      userContent += `\n\n=== CONTINUITY CORRECTION (obey exactly) ===\nThe following characters are NOT in this scene — they are elsewhere. Do NOT mention them as present, do NOT give them dialogue, actions, gestures, or movement, and do NOT have them accompany the player: ${forbid.join(", ")}. Rewrite the moment with them entirely absent.`;
    }
    if (correction) {
      userContent += `\n\n=== CONTINUITY CORRECTION (obey exactly) ===\n${correction} Rewrite the moment so it matches authoritative game state and preserves attributed claim history, and change nothing else.`;
    }
    const messages: ChatMessage[] = [
      { role: "system", content: this.buildSystemPrompt(ctx.scene) },
      { role: "user", content: userContent },
    ];
    let text = "";
    let blocked = false;
    let finishReason: string | undefined;
    try {
      for await (const chunk of this.gateway.stream("narrator", {
        messages,
        temperature: opts.temperature ?? 0.8,
        // Generous headroom: reasoning models spend a few hundred tokens "thinking" before any
        // prose, and the cap only truncates — the model stops on its own when finished. Bumped
        // from 1024 after long, high-detail narration was observed cutting off mid-sentence; the
        // narrator is the primary carrier of the game's experience, worth the extra headroom.
        maxTokens: opts.maxTokens ?? 2048,
      })) {
        if (chunk.reasoning) opts.onReasoning?.(chunk.reasoning);
        if (chunk.blocked) blocked = true;
        if (chunk.providerFinishReason) finishReason = chunk.providerFinishReason;
        if (chunk.delta) {
          text += chunk.delta;
          opts.onToken?.(chunk.delta);
        }
      }
    } catch (err) {
      // A mid-stream failure (timeout, dropped connection): keep whatever prose already
      // streamed to the player; only surface the error if nothing was salvaged.
      if (!text) throw err;
    }
    const trimmed = text.trim();
    return {
      text: trimmed,
      blocked,
      // Non-empty is the whole distinction: empty + length is the provider's reasoning-burn retry,
      // already handled a layer down. Blocked prose is cut by the guard on purpose, not by the cap.
      ...(finishReason === "length" && trimmed !== "" && !blocked ? { truncated: true } : {}),
    };
  }

  /**
   * Layer-2 cast-consistency check (anti-hallucination guarantee). Given the authoritative present
   * cast and the GM's prose, ask the utility model whether any character NOT in the cast is DEPICTED
   * AS PHYSICALLY PRESENT — speaking, acting, gesturing, moving, or accompanying the player. Mere
   * mentions, memories, or references to absent people are NOT violations; only a character actually
   * staged in the scene is. Returns the offender display-names (empty ⇒ consistent).
   *
   * Best-effort by contract: any transport/parse failure returns no offenders, so a verifier outage
   * degrades to the Layer-1 grounding (already strong) rather than blocking the turn. The utility
   * role is a small/fast model; temperature 0 for a stable verdict.
   */
  async verifyCast(prose: string, present: string[], absent: string[]): Promise<string[]> {
    const cast = present.length > 0 ? present.join(", ") : "(no one — the player is ALONE)";
    const system = [
      "You are a strict continuity checker for a tabletop RPG scene.",
      "You are given the AUTHORITATIVE list of characters physically present in the scene, and the GM's prose.",
      "Find every character who is DEPICTED AS PHYSICALLY PRESENT in the prose — speaking, acting, gesturing, moving, reacting, or accompanying the player — but who is NOT in the present cast.",
      "Do NOT flag mere mentions, memories, thoughts about, or references to characters who are elsewhere; only flag a character actually STAGED as present in the current moment.",
      'Respond with STRICT JSON only: {"offenders": ["Name", ...]}. Use an empty array if the prose is consistent with the cast.',
    ].join("\n");
    const user = [
      `PRESENT CAST (the only characters who may be staged as here): ${cast}`,
      `KNOWN TO BE ELSEWHERE (never valid to stage as present): ${absent.join(", ") || "(none listed)"}`,
      "",
      "GM PROSE:",
      prose,
    ].join("\n");
    try {
      const res = await this.gateway.complete("utility", {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        maxTokens: 200,
        json: true,
        // Tiny JSON verdict — no chain-of-thought needed; disable per-request so a hybrid reasoning
        // model doesn't burn the budget thinking (independent of the utility role's global knob).
        thinking: "off",
      });
      const parsed = JSON.parse(extractJsonObject(res.text));
      const offenders = Array.isArray(parsed?.offenders) ? parsed.offenders : [];
      return offenders.filter((o: unknown): o is string => typeof o === "string" && o.trim().length > 0);
    } catch {
      return [];
    }
  }
}

/**
 * Extract the first JSON object from a model response that may be wrapped in prose or ```json fences.
 * Falls back to the whole string (so a clean JSON reply parses directly). Verifier-only helper.
 */
function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}
