/**
 * Epistemic packet composer — the smallest truthful, relevant, disclosable slice of what ONE
 * character knows about ONE spoken question (NPC-EPISTEMIC-CONTEXT-PLAN §9).
 *
 * Deterministic and model-free: access gating, then relevance (token/subject match), then
 * temporal resolution, then disclosure. The LLM classifier supplied the question frame; the
 * reply model phrases the survivors. No stage here draws RNG, writes state, or calls a model.
 *
 * @author Runkai Zhang
 */
import type { NpcKnowledgeEntry, NpcTemplate, World, WorldFact } from "../content/schema.ts";
import type { NpcLearnedFact } from "../rules/npc-knowledge.ts";
import { canAccessFact } from "./access.ts";
import { GUILD_QUERY_TOKENS, projectGuildFacts, structuredKnowledgeOf, worldFactsOf } from "./facts.ts";
import { selectForTimeframe } from "./temporal.ts";
import type { EpistemicLine, KnowledgeAsk, NpcEpistemicPacket } from "./types.ts";

export interface EpistemicComposeInput {
  world: World;
  /** Stable template id of the replying NPC (runtime entities resolve to this before calling). */
  npcTemplateId: string;
  npcName: string;
  /** The player's spoken line, verbatim — the semantic query. */
  playerLine: string;
  /** Classifier knowledge frame; absent ⇒ safe default general/any (history still never current). */
  ask?: KnowledgeAsk;
  /** This NPC's friendship toward the asker (−100..100) — the trust-disclosure input. */
  friendship?: number;
  /** The party's current location + its live adjacent rooms (from the WorldModel map view). */
  locationId: string | null;
  adjacentLocationIds?: readonly string[];
  /**
   * Facts this NPC LEARNED at runtime (the reducer-owned `npcKnowledge` slice, plan §7.6), keyed
   * by fact id. A learned fact is an explicit grant — accessible even where the authored tier
   * would refuse — carried at the LEARNED certainty: rumor/uncertain hearsay renders qualified in
   * the beliefs section, told/witnessed knowledge answers directly.
   */
  learned?: Record<string, NpcLearnedFact>;
}

/** Deterministic packet budget (plan §21) — measured before tuning, generous enough for tests. */
const BUDGET = { authoritative: 6, history: 3, beliefs: 2, constraints: 3 } as const;

/** Relevance floors: a world fact needs one real hit; a guarded secret needs a genuine subject hit. */
const FACT_RELEVANCE_FLOOR = 1;
const SECRET_RELEVANCE_FLOOR = 2;

/** Default friendship floor for `trust` disclosure when the entry authors none (plan §13.2). */
export const DEFAULT_TRUST_FLOOR = 50;

const STOPWORDS = new Set([
  "the", "and", "was", "were", "are", "you", "your", "for", "with", "that", "this", "what",
  "where", "who", "why", "how", "does", "did", "has", "have", "had", "can", "could", "will",
  "would", "there", "here", "from", "not", "its", "their", "they", "them", "when", "which",
  "one", "any", "all", "but", "out", "into", "been", "being", "about", "still", "just", "did",
  "used", "use", "get", "got", "tell", "know", "knows",
]);

/** Lowercase content tokens (length ≥ 3, stopwords out), with a cheap plural fold ("guilds"→"guild"). */
export function queryTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw);
    if (raw.length >= 4 && raw.endsWith("s")) out.add(raw.slice(0, -1));
  }
  return out;
}

/** Count how many of `candidates` appear in the query token set (plural-folded both ways). */
function overlap(query: ReadonlySet<string>, candidates: Iterable<string>): number {
  let hits = 0;
  for (const c of candidates) {
    if (query.has(c)) hits += 1;
  }
  return hits;
}

/** Relevance of a world fact to the line/frame: subject grounding outranks raw word overlap. */
function factScore(fact: WorldFact, query: ReadonlySet<string>, ask: KnowledgeAsk | undefined): number {
  let score = overlap(query, queryTokens(`${fact.statement} ${fact.domains.join(" ")} ${fact.tags.join(" ")}`));
  if (ask?.subjectId && fact.subjectIds.includes(ask.subjectId)) score += 4;
  return score;
}

/** Relevance of a personal knowledge entry (statement + topic + domains). */
function entryScore(entry: NpcKnowledgeEntry, query: ReadonlySet<string>, ask: KnowledgeAsk | undefined): number {
  const text = `${entry.statement ?? ""} ${entry.topic ?? ""} ${entry.domains.join(" ")}`;
  let score = overlap(query, queryTokens(text));
  if (ask?.subjectId && entry.factId === ask.subjectId) score += 4;
  return score;
}

/** Deterministic ordering: authority desc, then id asc — stable across runs and platforms. */
function byAuthority(a: EpistemicLine, b: EpistemicLine): number {
  if (a.authority !== b.authority) return b.authority - a.authority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function factLine(fact: WorldFact, temporal: EpistemicLine["temporal"], authority: number): EpistemicLine {
  return {
    id: fact.id,
    text: fact.statement,
    source: "authored",
    temporal,
    certainty: fact.kind === "rumor" ? "rumor" : "certain",
    authority,
  };
}

/**
 * The disclosure verdict for one guarded entry at the current relationship: `speak` puts the
 * statement in the packet; `conceal` injects only a behavioral cue built from `topic`/`reason`;
 * `drop` keeps it out entirely (not relevant enough, or nothing to say).
 */
function disclosureVerdict(entry: NpcKnowledgeEntry, friendship: number | undefined): "speak" | "conceal" {
  switch (entry.disclosure.mode) {
    case "open":
    case "asked-only": // relevance IS the ask — these only enter the packet when the line touches them
    case "reluctant":
      return "speak";
    case "trust":
      return (friendship ?? 0) >= (entry.disclosure.minFriendship ?? DEFAULT_TRUST_FLOOR) ? "speak" : "conceal";
    case "never":
    case "misdirect":
      return "conceal";
  }
}

/** The concealment cue for a withheld entry — topic + reason only, NEVER the statement text. */
function concealmentCue(entry: NpcKnowledgeEntry): string {
  const topic = entry.topic?.trim() || "this subject";
  const why = entry.disclosure.reason?.trim();
  // "Never invent a substitute explanation" is load-bearing: live-verified (2026-07-31, deepseek
  // flash) that without it a model asked the withheld question confabulates a plausible ALTERNATIVE
  // history instead of deflecting — worse than the secret, because it plants false canon.
  const evade =
    entry.disclosure.mode === "misdirect"
      ? "Steer them elsewhere without revealing that there is anything to hide."
      : "Deflect, refuse, or go silent in your own voice — do not reveal it, do not hint at the specifics, and NEVER invent a substitute explanation or alternative story in its place. Not knowing more is what you show them.";
  return `You know more about ${topic} than you will say${why ? ` (${why})` : ""}. ${evade}`;
}

/** One personal entry as a speakable packet line. */
function entryLine(entry: NpcKnowledgeEntry, idx: number, prefix: string): EpistemicLine {
  const reluctant = entry.disclosure.mode === "reluctant";
  return {
    id: entry.factId ?? `${prefix}.${idx}`,
    text: `${entry.statement ?? ""}${reluctant ? " (You part with this reluctantly — keep it short unless pressed.)" : ""}`,
    source: entry.certainty === "rumor" || entry.certainty === "uncertain" ? "belief" : "authored",
    temporal: "timeless",
    certainty: entry.certainty,
    authority: entry.familiarity === "firsthand" ? 80 : 70,
  };
}

/**
 * Compose the packet. Pure; safe on any world (no facts, no guilds, no structured knowledge ⇒
 * every section empty and the caller renders nothing, keeping existing prompts byte-identical).
 */
export function composeEpistemicPacket(input: EpistemicComposeInput): NpcEpistemicPacket {
  const { world, ask } = input;
  const npc = world.npcs.find((n) => n.id === input.npcTemplateId);
  const empty: NpcEpistemicPacket = {
    observer: { id: input.npcTemplateId, name: input.npcName },
    ...(ask ? { request: ask } : {}),
    authoritative: [],
    history: [],
    beliefs: [],
    disclosureConstraints: [],
    unknowns: [],
    factIds: [],
  };
  if (!npc) return empty;

  const query = queryTokens(input.playerLine);
  const currentRegion = input.locationId
    ? world.locations.find((l) => l.id === input.locationId)?.region
    : undefined;

  // --- World facts: access (authored tiers OR runtime-learned grant) → relevance → temporal ---
  const learnedOf = (factId: string): NpcLearnedFact | undefined => input.learned?.[factId];
  const accessible = worldFactsOf(world).filter(
    (f) =>
      learnedOf(f.id) !== undefined ||
      canAccessFact(world, npc, f, { currentRegionId: currentRegion, currentLocationId: input.locationId }),
  );
  const scored = accessible
    .map((fact) => ({ fact, score: factScore(fact, query, ask) }))
    .filter(({ score }) => score >= FACT_RELEVANCE_FLOOR);
  // Hearsay routing: a rumor-KIND fact, or one this NPC only heard as rumor/uncertain, is a
  // belief — always qualified, never the direct answer.
  const heardOnly = (fact: WorldFact): boolean => {
    const rec = learnedOf(fact.id);
    return rec !== undefined && (rec.certainty === "rumor" || rec.certainty === "uncertain");
  };
  const rumors = scored.filter(({ fact }) => fact.kind === "rumor" || heardOnly(fact));
  const timeframe = ask?.timeframe ?? "any";
  const { answer, context } = selectForTimeframe(
    scored.filter(({ fact }) => fact.kind !== "rumor" && !heardOnly(fact)).map(({ fact }) => fact),
    timeframe,
  );

  const authoritative: EpistemicLine[] = answer.map((fact) =>
    factLine(fact, timeframe === "historical" ? "historical" : "current", 85),
  );
  const history: EpistemicLine[] = context.map((fact) =>
    factLine(fact, timeframe === "historical" ? "current" : "historical", 60),
  );
  const beliefs: EpistemicLine[] = rumors.map(({ fact }) => ({
    ...factLine(fact, "timeless", 40),
    source: "belief" as const,
    certainty: learnedOf(fact.id)?.certainty ?? "rumor",
  }));

  // --- Code-owned projections: live guild capabilities answer current institution asks -------
  const wantsCurrent = timeframe !== "historical";
  if (wantsCurrent && overlap(query, GUILD_QUERY_TOKENS) > 0) {
    authoritative.push(...projectGuildFacts(world, input.locationId, input.adjacentLocationIds ?? []));
  }

  // --- Personal knowledge: structured grants + guarded secrets, disclosure-filtered ----------
  const disclosureConstraints: string[] = [];
  const speakEntry = (entry: NpcKnowledgeEntry, idx: number, prefix: string, floor: number): void => {
    if (entryScore(entry, query, ask) < floor) return;
    if (!entry.statement && !entry.factId) return;
    if (disclosureVerdict(entry, input.friendship) === "conceal") {
      disclosureConstraints.push(concealmentCue(entry));
      return;
    }
    // A grant that only NAMES a world fact speaks that fact's statement (if accessible above,
    // it is already in the packet — don't duplicate it here).
    if (!entry.statement) return;
    const line = entryLine(entry, idx, prefix);
    if (line.certainty === "rumor" || line.certainty === "uncertain") beliefs.push(line);
    else authoritative.push(line);
  };
  structuredKnowledgeOf(npc).forEach((entry, idx) => speakEntry(entry, idx, `kn.${npc.id}`, FACT_RELEVANCE_FLOOR));
  (npc.privateKnowledge ?? []).forEach((entry, idx) => speakEntry(entry, idx, `pk.${npc.id}`, SECRET_RELEVANCE_FLOOR));

  // --- Budget + ordering (deterministic) ------------------------------------------------------
  authoritative.sort(byAuthority);
  history.sort(byAuthority);
  beliefs.sort(byAuthority);

  const packet: NpcEpistemicPacket = {
    observer: { id: npc.id, name: input.npcName },
    ...(ask ? { request: ask } : {}),
    authoritative: authoritative.slice(0, BUDGET.authoritative),
    history: history.slice(0, BUDGET.history),
    beliefs: beliefs.slice(0, BUDGET.beliefs),
    disclosureConstraints: disclosureConstraints.slice(0, BUDGET.constraints),
    unknowns: [],
    factIds: [],
  };

  // --- Unknown is a valid answer (hard invariant 10) ------------------------------------------
  const framedQuestion = ask !== undefined && ask.kind !== "general";
  if (
    framedQuestion &&
    packet.authoritative.length === 0 &&
    packet.history.length === 0 &&
    packet.beliefs.length === 0 &&
    packet.disclosureConstraints.length === 0
  ) {
    packet.unknowns.push(
      "You have no real knowledge that answers this. Say so plainly, in your own voice — do not invent an answer or guess one into being.",
    );
  }

  packet.factIds = [
    ...new Set(
      [...packet.authoritative, ...packet.history, ...packet.beliefs]
        .map((l) => l.id)
        .filter((id) => !id.startsWith("proj.") && !id.startsWith("kn.") && !id.startsWith("pk.")),
    ),
  ];
  return packet;
}
