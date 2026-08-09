/**
 * Worldsmith reconcile — shared, seeded-content utilities that outlived the retired world-genome
 * generator (archive/). These are load-bearing for LIVE gameplay (on-the-fly prose-entity
 * generation during frontier expansion/travel events — src/modules/prose-entities.ts, party
 * enrichment — src/modules/party/enrich.ts, memory summarization) and for the interactive
 * character authoring tools. Nothing here depends on a `WorldGenome` or a generated
 * `PlaySet` — nothing here assembles a whole world.
 *
 * @author Runkai Zhang
 */
import { AlignmentIds, StatBlockSchema, type Alignment, type StatBlock } from "../content/schema.ts";
import { PERSONALITIES } from "../content/presets/personalities.ts";
import { mulberry32 } from "../rules/dice.ts";
import { fnv1a, pick } from "./seeded.ts";

/** The `{`…`}` span of `body`, or null when it holds no brace pair at all. */
function braceSpan(body: string): string | null {
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return body.slice(start, end + 1);
}

/**
 * Extract the JSON object from a model response (tolerates fences/prose).
 *
 * WHY IT LOOKS AT EVERY FENCE. The old shape matched ONE fenced block (`/```(?:json)?…```/`, the
 * first) and searched only inside it, so a model that fenced anything BEFORE its answer lost the
 * answer entirely. Reproduced against the shipped function, with the reply a reasoning model
 * actually gives the character builder:
 *
 *   "Here is my reasoning first:\n```\nThe character should feel weathered.\n```\n
 *    And here is the character:\n```json\n{\"name\":\"Elis Vane\",…}\n```"
 *      => throws "no JSON object in worldsmith output"
 *
 * The prose aside has no braces, so the first block yields nothing and the real payload — sitting
 * in the SECOND fence — is never looked at. Every caller (`party/enrich.ts`, `prose-entities.ts`,
 * `case-testimony`) reads the throw as "the model failed" and drops the whole
 * result, so an ordinary chatty completion silently became an outage.
 *
 * So: try each fenced block in order, then the raw string, and take the first span that actually
 * PARSES. Parsing is the tie-breaker rather than mere brace presence, because an aside can contain
 * braces too. If nothing parses, fall back to the first brace span found (the legacy return — the
 * caller's own `JSON.parse` then throws the informative error); with no braces anywhere at all, the
 * legacy throw stands.
 */
export function extractJson(s: string): string {
  const fenced = [...s.matchAll(/```(?:[a-z]*)?\s*([\s\S]*?)```/gi)].map((m) => m[1] ?? "");
  let firstSpan: string | null = null;
  for (const body of [...fenced, s]) {
    const span = braceSpan(body);
    if (span === null) continue;
    firstSpan ??= span;
    try {
      JSON.parse(span);
      return span;
    } catch {
      // not this block's payload — keep looking
    }
  }
  if (firstSpan !== null) return firstSpan;
  throw new Error("no JSON object in worldsmith output");
}

// `isOfflineModel(m) => m.startsWith("offline")` was DELETED here (regex audit §10a, 2026-07-28).
// Offline mode is not a product feature (Prune Wave, 2026-07-04) — the only thing that ever
// answered to an "offline-*" model id was the TEST gateway, so this was product code sniffing for
// test infrastructure by model-id prefix. Reproduced against the shipped functions: a self-hoster
// (pillar 2) whose LM Studio tag is "offline-llama-3-8b" or "offlinemind-7b" got
//   foldCampaignSummary → the deterministic digest ("a b"), extractGist → ""
// for every call, forever, with no error — rolling summaries, NPC journals and party enrichment
// silently switched off by the name of their model. The four call sites now branch on the two
// STRUCTURAL signals a gateway actually reports (`blocked`, empty text); the test gateway declares
// itself by ANSWERING NOTHING to these four prompts (tests/support/offline-gateway.ts).

/**
 * A baseline statblock for a significant / party-eligible NPC, so it projects into
 * `GameState.actors` (a statless NPC does not — src/world/model.ts) — rigor R5. Modest, competent
 * generalist; deterministic.
 */
export function baselineNpcStats(): StatBlock {
  return StatBlockSchema.parse({
    abilities: { str: 11, dex: 12, con: 12, int: 12, wis: 12, cha: 12 },
    maxHp: 16,
    armorClass: 12,
    level: 2,
  });
}

// ---------------------------------------------------------------------------
// Seeded categorical identity — id-keyed, never drawn from the shared worldsmith stream
// ---------------------------------------------------------------------------

const SEX_POOL = ["female", "male"] as const;
const PERSONALITY_IDS = PERSONALITIES.map((p) => p.id);

/**
 * Categorical identity for one generated NPC/PC: an rng DERIVED from a caller-supplied SALT + id
 * (`mulberry32(fnv1a(`${salt}:${id}`))`) with UNCONDITIONAL fixed-order draws (sex, alignment,
 * personalityTemplate). The salt exists so a constant slug id (npc.companion, a party-enrichment
 * template id) doesn't draw the same identity everywhere it's reused: callers derive it from
 * something that varies per (world/context, seed) — deterministic, zero draws on the shared
 * stream — so same seed ⇒ same identity, different seed ⇒ different people. Optional pools
 * constrain the draw; draw ORDER never changes.
 */
export function seededIdentityFor(
  salt: string,
  id: string,
  pools?: { alignments?: readonly Alignment[]; personalities?: readonly string[] },
): { sex: string; alignment: Alignment; personalityTemplate: string } {
  const rng = mulberry32(fnv1a(`${salt}:${id}`));
  const sex = pick(rng, SEX_POOL);
  const alignment = pick(rng, pools?.alignments ?? AlignmentIds);
  const personalityTemplate = pick(rng, pools?.personalities ?? PERSONALITY_IDS);
  return { sex, alignment, personalityTemplate };
}

/** Evil alignments — the only ones a generated exploitative actor is drawn from. */
const EXPLOITATIVE_ALIGNMENTS: ReadonlySet<Alignment> = new Set<Alignment>(["le", "ne", "ce"]);
/** Share of eligible evil NPCs marked exploitative. */
const EXPLOITATIVE_SHARE = 0.5;

/**
 * A deterministic `exploitative` flag for a generated NPC. Only an evil-aligned NPC is eligible,
 * and only a bounded fraction of those are selected. Uses its own id-keyed stream so it never
 * perturbs identity or shared draws.
 */
export function seededExploitative(
  salt: string,
  id: string,
  alignment: Alignment,
  share: number = EXPLOITATIVE_SHARE,
): boolean {
  if (!EXPLOITATIVE_ALIGNMENTS.has(alignment)) return false;
  return mulberry32(fnv1a(`${salt}:exploitative:${id}`))() < share;
}

/**
 * Danger-weighted alignment + personality POOLS for an on-the-fly generated NPC (the prose-entity
 * path — owner decision 2026-07-05). Higher danger (0..3) skews a generated NPC toward evil
 * alignments and exploitative personalities; danger 0 stays broad/neutral. The weight is encoded as pool
 * MULTIPLICITY, so the existing uniform `pick(rng, pool)` draw (seededIdentityFor) yields the weighted
 * distribution with zero new rng math — same idiom, just a differently-shaped pool. Pure and
 * deterministic (no rng here; it only shapes the pool the id-keyed draw samples). The minor line is
 * untouched: danger biases alignment, personality, exploitative share, and count; never age or isMinor.
 */
export function dangerWeightedPools(danger: number): { alignments: Alignment[]; personalities: string[] } {
  const d = Math.max(0, Math.min(3, Math.round(danger)));
  const rep = <T,>(value: T, copies: number): T[] =>
    Array.from({ length: Math.max(1, Math.round(copies)) }, () => value);
  const evil: Alignment[] = ["le", "ne", "ce"];
  const good: Alignment[] = ["lg", "ng", "cg"];
  const neutral: Alignment[] = ["ln", "tn", "cn"];
  const alignments: Alignment[] = [
    ...evil.flatMap((a) => rep(a, 1 + d * 2)), // d0→1 each, d3→7 each (evil dominates at high danger)
    ...good.flatMap((a) => rep(a, Math.max(1, 4 - d * 1.5))), // d0→4 each, d3→1 each (good thins out)
    ...neutral.flatMap((a) => rep(a, 2)), // flat
  ];
  // Exploitative archetypes rise with danger; gentle ones thin; the rest stay flat. Keys mirror
  // agenda.ts PERSONALITY exploitative weights (brute/schemer/zealot/firebrand lead the exploitation term).
  const exploitativePers = ["brute", "schemer", "zealot", "firebrand"];
  const gentlePers = ["caretaker", "wide-eyed", "stoic-guardian"];
  const otherPers = PERSONALITY_IDS.filter((p) => !exploitativePers.includes(p) && !gentlePers.includes(p));
  const personalities: string[] = [
    ...exploitativePers.flatMap((p) => rep(p, 1 + d * 2)),
    ...gentlePers.flatMap((p) => rep(p, Math.max(1, 3 - d))),
    ...otherPers.flatMap((p) => rep(p, 2)),
  ];
  return { alignments, personalities };
}

/**
 * The danger-scaled share of eligible evil generated NPCs marked `exploitative`. Monotone in danger
 * and clamped: danger0→0.25, danger3→0.85. The evil-only gate in `seededExploitative` still holds.
 */
export function dangerThreatShare(danger: number): number {
  const d = Math.max(0, Math.min(3, danger));
  return Math.max(0, Math.min(0.85, 0.25 + d * 0.2));
}

// ---------------------------------------------------------------------------
// Starting gear (items & economy) — masterlist ids as plain literals, so this stays a
// zero-runtime-coupling posture (tests cross-check every id against src/rules/srd/items.json).
// ---------------------------------------------------------------------------

/** The starting purse, in copper pieces — enough for kit repairs and a few nights, not a potion spree. */
export const STARTING_COINS_CP = 1500;

/**
 * Deterministic class → starting kit (masterlist ids). Unknown classes get the drifter's kit.
 * Order matters — specific families before broad ones. r4 P4 widened the families: an
 * "Investigator" who "kept her instruments" was dealt the drifter's club because only three
 * families existed; the concept text never reaches gear (the compose prompt reserves mechanics
 * for code), so the class word has to carry it.
 */
/**
 * Signature gear the CONCEPT names, in the author's own words → masterlist ids.
 *
 * r5 P4: the builder interviewed the player about a character who "carries a boarding axe and a coil
 * of tarred rope", then dealt a chain shirt, a longsword and a shield. The very first thing the game
 * said about the character contradicted the character they had just agreed to.
 *
 * The class table still owns the MECHANICAL floor (armour, a weapon, the tools of the trade); this
 * reads only what the author actually wrote and adds what they named on top. Deliberately a curated
 * phrase table, not a fuzzy search over 148 item names: a concept is prose, and "a leather-bound
 * ledger" must not deal leather armour. Ordered longest-phrase-first so "hand axe" never resolves
 * through the bare "axe" row.
 */
const SIGNATURE_GEAR: readonly { group: string; re: RegExp; id: string }[] = [
  { group: "axe", re: /\b(?:boarding|hand|belt|throwing|wood)[-\s]?axe(?:s)?\b|\bhatchet(?:s)?\b/i, id: "weapon.handaxe" },
  { group: "axe", re: /\b(?:great|two[-\s]?handed)[-\s]?axe(?:s)?\b/i, id: "weapon.greataxe" },
  { group: "axe", re: /\b(?:battle[-\s]?)?axe(?:s)?\b/i, id: "weapon.battleaxe" },
  { group: "rope", re: /\brope(?:s)?\b|\bcoil of (?:tarred |waxed )?(?:line|cord)\b/i, id: "item.rope-hempen" },
  { group: "hook", re: /\bgrappling[-\s]?(?:hook|iron)\b/i, id: "item.grappling-hook" },
  { group: "pry", re: /\bcrowbar\b|\bpry[-\s]?bar\b|\bjemmy\b/i, id: "item.crowbar" },
  { group: "picks", re: /\block[-\s]?picks?\b|\bpicklocks?\b|\bthieves(?:'|’)? tools\b|\bskeleton keys?\b/i, id: "item.thieves-tools" },
  { group: "light", re: /\blantern\b|\bstorm[-\s]?lamp\b/i, id: "item.lantern-hooded" },
  { group: "light", re: /\btorch(?:es)?\b/i, id: "item.torch" },
  { group: "polearm", re: /\bspear(?:s)?\b|\bboar[-\s]?spear\b/i, id: "weapon.spear" },
  { group: "ranged", re: /\bshort[-\s]?bow\b/i, id: "weapon.shortbow" },
  { group: "ranged", re: /\blong[-\s]?bow\b|\bwar[-\s]?bow\b/i, id: "weapon.longbow" },
  { group: "ranged", re: /\bcrossbow\b|\barbalest\b/i, id: "weapon.light-crossbow" },
  { group: "ranged", re: /\bsling\b/i, id: "weapon.sling" },
  { group: "ranged", re: /\bbow\b/i, id: "weapon.shortbow" },
  { group: "net", re: /\bnet(?:s)?\b/i, id: "weapon.net" },
  { group: "whip", re: /\bwhip\b|\blash\b/i, id: "weapon.whip" },
  { group: "hammer", re: /\bwar[-\s]?hammer\b|\bmaul\b/i, id: "weapon.warhammer" },
  { group: "hammer", re: /\bmace\b/i, id: "weapon.mace" },
  { group: "staff", re: /\bquarter[-\s]?staff\b|\bwalking staff\b|\bwalking stick\b/i, id: "weapon.quarterstaff" },
  { group: "blade", re: /\bgreat[-\s]?sword\b|\bclaymore\b/i, id: "weapon.greatsword" },
  { group: "blade", re: /\bshort[-\s]?sword\b|\bfalchion\b|\bcutlass\b/i, id: "weapon.shortsword" },
  { group: "blade", re: /\bdagger(?:s)?\b|\bknife\b|\bknives\b|\bstiletto\b|\bdirk\b/i, id: "weapon.dagger" },
  { group: "restraint", re: /\bmanacles\b|\bshackles\b|\bleg[-\s]?irons\b/i, id: "item.manacles" },
  { group: "medicine", re: /\bhealer(?:'|’)?s kit\b|\bbandages\b|\bsurgeon(?:'|’)?s (?:bag|kit)\b/i, id: "item.healers-kit" },
  { group: "medicine", re: /\bherbalism\b|\bpoultice(?:s)?\b|\bsimples\b/i, id: "item.herbalism-kit" },
  { group: "faith", re: /\bholy symbol\b|\breliquary\b/i, id: "item.holy-symbol" },
  { group: "arcane", re: /\bspell[-\s]?book\b|\bgrimoire\b/i, id: "item.spellbook" },
  // r7 P4: a "travelling song-keeper who trades in other people's stories" Bard was dealt no
  // instrument at all — the table only knew instrument NAMES, never the words a bard actually
  // uses to describe the trade. Named instruments each deal their own item; the generic
  // bard-concept words fall back to the classic one (a lute) rather than matching nothing.
  { group: "instrument", re: /\blutes?\b/i, id: "item.lute" },
  { group: "instrument", re: /\blyres?\b/i, id: "item.lyre" },
  { group: "instrument", re: /\bflutes?\b/i, id: "item.flute" },
  { group: "instrument", re: /\bdrums?\b/i, id: "item.drum" },
  { group: "instrument", re: /\bfiddles?\b/i, id: "item.fiddle" },
  { group: "instrument", re: /\bpipes?\b/i, id: "item.pipes" },
  { group: "instrument", re: /\bhorns?\b/i, id: "item.horn" },
  { group: "instrument", re: /\b(?:song[-\s]?keepers?|singers?|bards?|minstrels?|musicians?|music|buskers?)\b/i, id: "item.lute" },
  { group: "disguise", re: /\bdisguise(?:s)?\b|\bfalse face\b|\bpaints and wigs\b/i, id: "item.disguise-kit" },
  { group: "fishing", re: /\bfishing\b|\bnets and lines\b/i, id: "item.fishing-tackle" },
  { group: "dig", re: /\bshovel\b|\bspade\b/i, id: "item.shovel" },
  { group: "trap", re: /\bhunting trap\b|\bleg[-\s]?trap\b|\bsnare(?:s)?\b/i, id: "item.hunting-trap" },
  { group: "trap", re: /\bcaltrops\b/i, id: "item.caltrops" },
  { group: "climb", re: /\bclimb(?:ing|er(?:'|’)?s)\b|\bpitons\b/i, id: "item.climbers-kit" },
  { group: "paper", re: /\bledger(?:s)?\b|\bjournal\b|\bnotebook\b|\bchapbook\b/i, id: "item.book" },
  { group: "mirror", re: /\bmirror\b/i, id: "item.mirror-steel" },
  { group: "chain", re: /\bsteel chain\b|\blength of chain\b/i, id: "item.chain" },
];

/** The most SIGNATURE_GEAR ids one concept can add — a kit, not a quartermaster's manifest. */
const MAX_SIGNATURE_ITEMS = 3;

/**
 * Masterlist ids for the gear a character's own concept/appearance/background names, capped and
 * deduped, in the order the table declares them. Empty for prose that names nothing — so a concept
 * the table has no word for changes nothing at all.
 */
export function signatureKitFrom(conceptText: string): string[] {
  if (!conceptText.trim()) return [];
  const out: string[] = [];
  const claimed = new Set<string>();
  for (const row of SIGNATURE_GEAR) {
    if (out.length >= MAX_SIGNATURE_ITEMS) break;
    // One item per group: "a boarding axe" is a handaxe, and must not ALSO deal the generic
    // battleaxe row that the bare word "axe" would match.
    if (claimed.has(row.group) || !row.re.test(conceptText)) continue;
    claimed.add(row.group);
    if (!out.includes(row.id)) out.push(row.id);
  }
  return out;
}

/**
 * A class stem, matched at a WORD START only (r8 regex audit).
 *
 * The bare substring test this replaces read the letters inside another word: reproduced against
 * the shipped function, `startingKitFor("Stranger")` returned `["armor.leather",
 * "weapon.shortsword", "weapon.shortbow"]` — a wanderer with no martial concept at all started the
 * game holding a ranger's blade and bow, off the `ranger` buried in st-RANGER.
 *
 * A word start still covers every inflection a model actually writes for these ("sorcer" ⊂
 * "sorceress", "guard" ⊂ "guardsman", "priest" ⊂ "priestess", "berserker", "hunters"), because the
 * stems are already spelled as prefixes. The few real class words whose stem sits MID-word are
 * listed as stems of their own below rather than by re-opening substring matching.
 */
const kitStem = (...stems: readonly string[]): RegExp => new RegExp(`\\b(?:${stems.join("|")})`, "i");

const KIT_BARBARIAN = kitStem("barbarian", "berserker");
const KIT_FIGHTER = kitStem(
  "paladin", "fighter", "warrior", "soldier", "knight", "guard", "bodyguard", "sellsword", "mercenary",
);
const KIT_INVESTIGATOR = kitStem("investigator", "surveyor", "scribe", "clerk", "detective");
const KIT_ROGUE = kitStem("rogue", "hunter", "manhunter", "headhunter", "ranger", "scout", "thief");
const KIT_MONK = kitStem("monk");
const KIT_CLERIC = kitStem("cleric", "priest");
const KIT_DRUID = kitStem("druid");
const KIT_BARD = kitStem("bard", "minstrel", "charmer");
const KIT_WIZARD = kitStem(
  "wizard", "mage", "battlemage", "archmage", "warmage", "scholar", "sorcer", "warlock", "witch",
);

export function startingKitFor(className: string): string[] {
  const c = className.toLowerCase();
  if (KIT_BARBARIAN.test(c)) return ["armor.hide", "weapon.greataxe"];
  if (KIT_FIGHTER.test(c)) return ["armor.chain-shirt", "weapon.longsword", "armor.shield"];
  if (KIT_INVESTIGATOR.test(c)) return ["armor.leather", "weapon.dagger", "item.thieves-tools"];
  if (KIT_ROGUE.test(c)) return ["armor.leather", "weapon.shortsword", "weapon.shortbow"];
  if (KIT_MONK.test(c)) return ["weapon.quarterstaff"];
  if (KIT_CLERIC.test(c)) return ["armor.scale-mail", "weapon.mace", "armor.shield", "item.holy-symbol"];
  if (KIT_DRUID.test(c)) return ["armor.leather", "weapon.sickle", "item.herbalism-kit"];
  // r7 P4: the floor must carry an instrument even when the concept names no specific one —
  // "leather + a rapier" left a bard with nothing to actually perform with.
  if (KIT_BARD.test(c)) return ["armor.leather", "weapon.rapier", "item.lute"];
  if (KIT_WIZARD.test(c)) return ["weapon.quarterstaff", "weapon.dagger"];
  return ["armor.leather", "weapon.club"];
}

/**
 * Rations + water every composed kit gets on top of the class floor and named gear — r7 P4: SR's
 * roads run 6-8 hours between towns and camping spends a ration (`src/rules/upkeep.ts`), but a
 * freshly built character started with neither. Two days of food is a buffer past the first
 * night on the road, not a stockpile.
 */
export const STARTING_PROVISIONS: readonly string[] = ["item.rations", "item.rations", "item.waterskin"];

/**
 * Top `kit` up so it holds at least every id/count in STARTING_PROVISIONS, without over-adding
 * what the floor or a signature phrase already dealt (id-by-id, so one already-present ration
 * tops up by one more, never stacks a third). Order-preserving; never removes anything.
 */
export function withStartingProvisions(kit: readonly string[]): string[] {
  const out = [...kit];
  const need = new Map<string, number>();
  for (const id of STARTING_PROVISIONS) need.set(id, (need.get(id) ?? 0) + 1);
  for (const [id, count] of need) {
    let have = out.filter((x) => x === id).length;
    while (have < count) {
      out.push(id);
      have += 1;
    }
  }
  return out;
}
