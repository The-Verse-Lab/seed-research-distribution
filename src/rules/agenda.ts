/**
 * Agenda rules — deterministic NPC stance, resistance DCs, and initiated agenda actions.
 *
 * The model may phrase an NPC's move, but it never decides the stance, DC, action, or outcome.
 * Those are derived here from authored traits plus live relationship/memory state, with no RNG and
 * no writes. Callers route returned commands through the reducer only after the relevant contest.
 *
 * @author Runkai Zhang
 */
import type { Alignment, Campaign, NpcTemplate, World } from "../content/schema.ts";
import { MORALITIES } from "../content/presets/moralities.ts";
import { PERSONALITIES } from "../content/presets/personalities.ts";
import { resolvePreset } from "../content/presets/preset.ts";
import { recallFor } from "../modules/npc-memory/state.ts";
import { resolveSocialModifiers, SOCIAL_MODIFIER_MAX, type SocialModifier, type TargetSignals } from "./social.ts";
import { relationshipProfile, type RelationshipProfile } from "./relationships.ts";
import { factionStandingOf } from "./factions.ts";
import { visibleStateOf } from "./visible-state.ts";
import type { Command } from "../world/commands.ts";
import { cowedEffect } from "./status-effects.ts";
import { itemDisplayNameOf } from "./items.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../world/model.ts";

export type AgendaDisposition = "devoted" | "helpful" | "neutral" | "wary" | "transactional" | "exploitative";
export type AgendaAskApproach = "persuade" | "intimidate" | "bribe";
export type AgendaAskKind =
  | "favor"
  | "information"
  | "move"
  | "surrenderItem"
  | "betray"
  | "harmInnocent"
  | "breakOath"
  | "steal"
  | "lie"
  | "debt";
export type AgendaAbility = "str" | "dex" | "con" | "int" | "wis" | "cha";

export interface AgendaAsk {
  approach: AgendaAskApproach;
  kind: AgendaAskKind;
}

export interface AgendaStance {
  npcId: string;
  targetId: string;
  disposition: AgendaDisposition;
  /** 0..1, how strongly the NPC currently inhabits the disposition. */
  intensity: number;
  relationship: number;
  /** Full relationship profile; `relationship` above is the Friendship axis. */
  relationshipProfile: RelationshipProfile;
  alignment: { id: Alignment | "tn"; good: number; law: number };
  personalityId?: string;
  offLimits: ReadonlySet<AgendaAskKind>;
  /**
   * Workstream F — the appearance/identity social read folded into this stance (present only when
   * the target actually carried perceived signals the observer reacted to; absent = today's stance).
   * Bounded modifiers with reasons; already reflected in `intensity` via a small clamped nudge.
   */
  socialContext?: { modifiers: SocialModifier[] };
}

interface AgendaActionBase {
  targetId: string;
  directive: string;
  summary: string;
}

export type AgendaAction =
  | (AgendaActionBase & {
      kind: "help";
      command: Command;
    })
  | (AgendaActionBase & {
      kind: "manipulate";
      command: Command;
    })
  | (AgendaActionBase & {
      kind: "demand" | "pressure";
      consequence: Command;
      resist: { ability: AgendaAbility; dc: number; label: string };
    });

export interface PendingAgendaPressure {
  npcId: string;
  targetId: string;
  actionKind: "demand" | "pressure";
  summary: string;
  directive: string;
  consequence: Command;
  resist: { ability: AgendaAbility; dc: number; label: string };
}

/** The fair-ask baseline: a plain request, pressed by asking. See `agendaAskOf`. */
export const DEFAULT_AGENDA_ASK: AgendaAsk = { approach: "persuade", kind: "favor" };

/**
 * Every kind `offLimitsFor` (below) can put on an NPC's off-limits set — i.e. the kinds
 * `resistanceDC` can answer with `"refused"`, no roll offered. Kept next to the clamp that reads it
 * so the two can never drift; `tests/agenda.test.ts` walks the whole `AgendaAskKind` union against
 * every alignment/personality and asserts nothing outside this set ever becomes unrollable.
 */
const HARD_REFUSABLE_ASK_KINDS: ReadonlySet<AgendaAskKind> = new Set<AgendaAskKind>([
  "harmInnocent",
  "betray",
  "breakOath",
  "steal",
  "lie",
]);

/**
 * The social ask a player's line makes, for the stance DC and the hard-refusal rules.
 *
 * `named` is the classifier's CLOSED answer (`TurnPlan.socialAsk`) and wins outright when present:
 * the model may only pick one of the ten authored kinds, and `resistanceDC`/`offLimitsFor` remain
 * the sole authority over the number and over whether the ask is refusable at all.
 *
 * Null/absent ⇒ the prose cascade WITH ITS TEETH PULLED. The cascade is where the r8 audit's
 * reproduced misfire lives: a bare `take` arm read "Please take the lantern back to the smith." as
 * `kind:"steal"`, which `offLimitsFor` turns into an unrollable hard refusal for any good/lawful
 * NPC — so the most helpful person in town answered an errand with a flat no and no roll at all.
 * The arm itself is fixed below (an errand names where the thing is going; a theft does not), but a
 * word-list can never be TRUSTED with a verdict that removes the player's roll, and the classifier
 * emits `null` "otherwise", so this path runs constantly rather than only during an outage.
 *
 * So the clamp is on the one thing that is unarguable: a kind the floor picked that
 * `offLimitsFor` could make unrollable (`HARD_REFUSABLE_ASK_KINDS`) collapses to the baseline
 * `favor`. Everything else the cascade decides — the APPROACH, and the kinds that only move a
 * number (`information`/`move`/`surrenderItem`/`debt`/`favor`) — passes through untouched, because
 * being wrong there costs a couple of DC points, not the turn. A hard refusal is still fully
 * reachable: the classifier may name `steal`/`betray`/`breakOath`/`harmInnocent`/`lie` and
 * `resistanceDC`/`offLimitsFor` remain the sole authority over the number and over whether an ask
 * is refusable at all.
 */
export function agendaAskOf(
  named: AgendaAsk | null | undefined,
  text: string,
  fallback: AgendaAskApproach = "persuade",
): AgendaAsk {
  if (named) return named;
  const inferred = inferAgendaAsk(text, fallback);
  return HARD_REFUSABLE_ASK_KINDS.has(inferred.kind)
    ? { approach: inferred.approach, kind: DEFAULT_AGENDA_ASK.kind }
    : inferred;
}

/**
 * The `take` object-phrase, up to the end of its clause. `take` is the most overloaded verb in
 * English, so it reads as theft only with a possessive/article-led object ("take his purse", "take
 * the ledger") and never a person ("take me to the market") or an idiom ("take a look").
 */
const TAKE_OBJECT_RE =
  /\btake\b\s+(?:his|her|their|its|my|our|the|that|those|these)\s+(?!way\b|look\b|care\b|leave\b)[^.,;!?]*/i;
/**
 * What redeems that object-phrase: an ERRAND names where the thing is GOING — "take the writ TO
 * the guildhall", "take the lantern BACK TO the smith", "take that crate DOWN TO the dock" — and a
 * theft never does. Reproduced against the shipped arm, all four of those scored `steal` and drew
 * an unrollable refusal from the lawful NPC the errand was being asked of (r8 audit).
 */
const ERRAND_DESTINATION_RE = /\bto\b\s+\w/i;

/** Whether a `take` in this line reads as theft rather than as an errand. See the two regexes above. */
function takeReadsAsTheft(lower: string): boolean {
  const phrase = TAKE_OBJECT_RE.exec(lower)?.[0];
  return phrase !== undefined && !ERRAND_DESTINATION_RE.test(phrase);
}

/** Infer the social ask category from player prose for stance DC and hard-refusal rules. */
export function inferAgendaAsk(text: string, fallback: AgendaAskApproach = "persuade"): AgendaAsk {
  const lower = text.toLowerCase();
  const approach: AgendaAskApproach =
    /\b(bribe|pay|buy|coin|price)\b/.test(lower)
      ? "bribe"
      : /\b(intimidate|threaten|scare|menace|coerce|force|blackmail|extort)\b/.test(lower)
        ? "intimidate"
        : fallback;

  const kind: AgendaAskKind =
    /\b(betray|turn on|sell out|abandon|forsake)\b/.test(lower)
      ? "betray"
      : /\b(harm|hurt|kill|murder|slaughter)\b.*\b(innocent|child|civilian|helpless|bystander)\b/.test(lower)
        ? "harmInnocent"
        : /\b(break|violate)\b.*\b(oath|vow|contract|law|promise)\b/.test(lower)
          ? "breakOath"
          : // `steal` is an OFF-LIMITS kind for most authored NPCs, so a false hit here is not a
            // wrong DC — `offLimitsFor` turns it into a flat refusal with no roll the player cannot
            // argue with. The bare `take` used to carry it, and "take" is the most overloaded verb
            // in English: "Can you take me to the market?" and "Would you take a look at this writ?"
            // both scored `steal`, so the friendliest NPC in town stonewalled a request for
            // directions (reproduced, r8 audit). Narrowing it to a possessive/article-led object
            // spared those two but not the ERRAND, which has exactly that shape: "Please take the
            // lantern back to the smith." / "Take the ledger to Mira for me, would you?" / "Can you
            // take that crate down to the dock?" all still scored `steal` and drew the same
            // unrollable refusal (reproduced again, r8 review). The distinguisher is the
            // DESTINATION — an errand says where the thing is going, a theft does not.
            // `steal`/`rob` are unambiguous and stay bare.
            /\b(steal|rob)\b/.test(lower) || takeReadsAsTheft(lower)
            ? "steal"
            : /\b(lie|deceive|frame|forge)\b/.test(lower)
              ? "lie"
              : /\b(give|hand|surrender|part with|turn over)\b/.test(lower)
                ? "surrenderItem"
                : /\b(debt|owe|favor)\b/.test(lower)
                  ? "debt"
                  : /\b(tell|explain|reveal|information|secret)\b/.test(lower)
                    ? "information"
                    : /\b(move|leave|go|step aside|stand down|come with)\b/.test(lower)
                      ? "move"
                      : "favor";
  return { approach, kind };
}

const ALIGNMENT_LEANS: Record<Alignment, { good: number; law: number }> = {
  lg: { good: 1, law: 1 },
  ng: { good: 1, law: 0 },
  cg: { good: 1, law: -1 },
  ln: { good: 0, law: 1 },
  tn: { good: 0, law: 0 },
  cn: { good: 0, law: -1 },
  le: { good: -1, law: 1 },
  ne: { good: -1, law: 0 },
  ce: { good: -1, law: -1 },
};

const PERSONALITY: Record<string, { warmth: number; wary: number; transactional: number; exploitative: number }> = {
  "stoic-guardian": { warmth: 0.12, wary: 0.08, transactional: 0, exploitative: 0 },
  trickster: { warmth: 0, wary: 0, transactional: 0.18, exploitative: 0.05 },
  zealot: { warmth: 0.02, wary: 0.18, transactional: 0, exploitative: 0.08 },
  schemer: { warmth: -0.06, wary: 0.12, transactional: 0.22, exploitative: 0.12 },
  hedonist: { warmth: 0.05, wary: 0, transactional: 0.2, exploitative: 0.03 },
  caretaker: { warmth: 0.28, wary: -0.05, transactional: 0, exploitative: -0.08 },
  brute: { warmth: -0.12, wary: 0.1, transactional: 0.04, exploitative: 0.24 },
  sage: { warmth: 0.06, wary: 0.03, transactional: 0, exploitative: 0 },
  firebrand: { warmth: 0.02, wary: 0.12, transactional: 0, exploitative: 0.08 },
  recluse: { warmth: -0.1, wary: 0.22, transactional: 0, exploitative: 0 },
  charmer: { warmth: 0.14, wary: 0, transactional: 0.12, exploitative: 0.03 },
  survivor: { warmth: -0.04, wary: 0.2, transactional: 0.12, exploitative: 0.04 },
  "wide-eyed": { warmth: 0.18, wary: -0.1, transactional: 0, exploitative: -0.06 },
};
const NEUTRAL_PERSONALITY = { warmth: 0, wary: 0, transactional: 0, exploitative: 0 } as const;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function samePlace(model: WorldModel, a: string, b: string): boolean {
  const ae = model.entities.get(a);
  const be = model.entities.get(b);
  return !!ae?.locationId && ae.locationId === be?.locationId;
}

function memoryLean(model: WorldModel, npcId: string): number {
  let lean = 0;
  for (const entry of recallFor(model, npcId)) {
    const summary = entry.summary.toLowerCase();
    if (entry.kind === "relationship") {
      if (summary.includes("warmed")) lean += 0.08;
      if (summary.includes("cooled")) lean -= 0.08;
    } else if (entry.kind === "questResolved") {
      lean += 0.04;
    } else if (entry.kind === "addressed") {
      lean += 0.02;
    } else if (entry.kind === "traveled") {
      lean += 0.01;
    }
  }
  return clamp(lean, -0.2, 0.2);
}

function offLimitsFor(
  alignment: { good: number; law: number },
  personalityId: string | undefined,
  relationship: number,
): ReadonlySet<AgendaAskKind> {
  const out = new Set<AgendaAskKind>();
  if (alignment.good > 0) out.add("harmInnocent");
  if (alignment.good > 0.5) out.add("betray");
  if (alignment.law > 0) {
    out.add("breakOath");
    out.add("betray");
  }
  if (alignment.good > 0 && alignment.law > 0) {
    out.add("steal");
    out.add("lie");
  }
  if (personalityId === "caretaker" || personalityId === "stoic-guardian") out.add("harmInnocent");
  if (relationship >= 70) out.add("betray");
  return out;
}

function itemName(world: World, itemId: string): string {
  // Never leak the raw id into player-facing labels: fall back to the SRD masterlist name, then
  // to a humanized slug ("item.potion-healing" → "Potion Healing"), never to the id itself.
  return world.items.find((i) => i.id === itemId)?.name ?? itemDisplayNameOf(itemId);
}

function targetName(model: WorldModel, id: string): string {
  return model.entities.get(id)?.name ?? id;
}

function preferredDemandItem(model: WorldModel, world: World, targetId: string): string | null {
  const inv = model.entities.get(targetId)?.stats?.inventory ?? [];
  if (inv.length === 0) return null;
  const rank = (itemId: string): number => {
    const kind = world.items.find((i) => i.id === itemId)?.kind ?? "misc";
    switch (kind) {
      case "treasure":
        return 0;
      case "misc":
        return 1;
      case "consumable":
        return 2;
      case "tool":
        return 3;
      case "weapon":
        return 4;
      case "armor":
        return 5;
      case "quest":
        return 6;
      default:
        return 7;
    }
  };
  return [...inv].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

function firstGiftItem(model: WorldModel, actorId: string): string | null {
  return model.entities.get(actorId)?.stats?.inventory?.[0] ?? null;
}

/**
 * The DC an NPC's applied pressure imposes on its target — how hard this NPC clamps down, from
 * disposition, intensity, and grudge. Used for autonomous demand/pressure resists and for the
 * party leave-gate's contested escape (the leader-derived DC).
 */
export type PressureAnswer = "comply" | "refuse" | "neutral";

const PRESSURE_REFUSE_RE =
  /\b(no+|nope|never|refuse|won't|will not|shan't|not yours|not happening|back off|hands off|over my dead|keep your hands|that's mine|that is mine|it's mine|is mine\b|mine,?\s+and|keeping it|i'm keeping|give (it|that|them) back|give me (it|that|them) back|you'?re not (taking|having|getting|walking)|you (can|cannot|can't) (not )?take|let go|unhand)\b/i;
// Every alternative is OBJECT-BEARING: a phrase that can only mean handing the thing over. The bare
// discourse marker "fine" used to lead this list, and it is the one alternative a REFUSAL can also
// say — "Fine. But you will have to pry it from me." scored `comply`, and comply is the branch that
// transfers the item with NO ROLL and tells the narrator the player gave it up willingly. Genuine
// compliance is unaffected because it always carries an object too ("Fine. Take it, it's yours."
// still matches on `take it` and `it's yours`). Same discipline as the closed answer lists in
// Nothing belongs here that a refusal can also say.
const PRESSURE_COMPLY_RE =
  /\b(take it|take them|here,? take|hand (it|them|over)|hands? (it|them) over|as you (ask|wish)|i give in|go on then|reluctantly (hand|give|surrender)|i (comply|yield|surrender)|it's yours|they'?re yours)\b/i;

// …and OBJECT-BEARING is still not enough on its own, because a refusal can put the SAME object
// phrase inside a dare or a condition. Reproduced against the shipped list (r8 review), every one
// of these scored `comply` — the branch that transfers the item with no roll:
//
//   "You'll have to take it from my corpse."                 (`take it`,   trailing defiance)
//   "Go on then, try and take it."                           (`go on then`, a dare)
//   "As you wish — but I'll die before it leaves my hand."   (`as you wish`, concessive)
//
// So a comply cue is vetoed when defiance governs it, checked on BOTH sides of the cue — the same
// two-sided parsing discipline used by other response detectors, and for
// the same reason: a prefix-only guard is structurally blind to "…, try and take it" and a
// suffix-only guard is blind to "over my dead body, take it". The lead window stops at clause
// punctuation so a disclaimer cannot reach across sentences; the trail deliberately crosses it,
// because "As you wish — but I'll die first." IS the shape. A wrongly vetoed concession costs the
// player a contested roll they were going to win; a missed veto costs them the item outright.
const COMPLY_DEFIANCE_LEAD_RE =
  /\b(?:no|not|never|won'?t|will not|refuse|rather|sooner|over my dead|like hell|as if|before|the day|you'?ll have to|you will have to|try (?:and|to)|when hell freezes)\b[^.?!]{0,40}$/i;
const COMPLY_DEFIANCE_TRAIL_RE =
  /^[\s\S]{0,60}?\b(?:from my (?:cold |dead |cold, dead )*(?:hands?|corpse|fingers|grip)|over my dead body|not a chance|no chance|no way|never|not while|not happening|i won'?t|i will not|i'?ll die|i would die|i'?d die|pry it|try (?:and|to) (?:take|have|get|make|stop)|hell no|nope)\b/i;

/**
 * Read the player's answer to an NPC's demand/press. Refusal is checked first ("give it back"
 * contains "give"). Anything uncommitted stays neutral and resolves on the bare roll.
 *
 * PROSE FLOOR ONLY (r8 regex audit). Word-lists cannot read a concessive sentence: "Fine. But you
 * will have to pry it from me." hit PRESSURE_COMPLY_RE's old `fine` arm and scored **comply** — the
 * demanded item transfers with NO roll, and the RESOLVED block tells the narrator the player handed
 * it over willingly (reproduced against the shipped regex). The authority is the classifier's closed
 * `TurnPlan.pressureAnswer`; this survives as the double-failure floor, reached through
 * `pressureAnswerFrom` below — which additionally never lets this function's `comply` through.
 */
export function pressureAnswerOf(input: string): PressureAnswer {
  if (PRESSURE_REFUSE_RE.test(input)) return "refuse";
  const re = new RegExp(PRESSURE_COMPLY_RE.source, "gi");
  for (let m = re.exec(input); m !== null; m = re.exec(input)) {
    if (COMPLY_DEFIANCE_LEAD_RE.test(input.slice(0, m.index))) continue;
    if (COMPLY_DEFIANCE_TRAIL_RE.test(input.slice(m.index + m[0].length))) continue;
    return "comply";
  }
  return "neutral";
}

/**
 * The player's answer to a standing demand: the classifier's CLOSED answer when it named one,
 * otherwise the prose floor above.
 *
 * `comply` is the only branch that mutates WITHOUT A ROLL, so an absent answer must never land
 * there. The prose floor cannot be trusted with that call: it is the very net this migration
 * replaced, and word-lists keep finding new ways to read a refusal as agreement — "You'll have to
 * take it from my corpse." / "Go on then, try and take it." / "As you wish — but I'll die before it
 * leaves my hand." all scored `comply` against the shipped list (reproduced, r8 review). The floor's
 * cue guard now vetoes those, but the guarantee cannot rest on a word-list being exhaustive.
 *
 * So the clamp is structural and lives HERE: on a classifier miss the floor may say `refuse` —
 * safe, because it only adds +2 to the player's own resist — and ANY `comply` it returns is clamped
 * to `neutral`, the bare contested roll, which is what an unanswered demand should be. A player who
 * genuinely gives in loses nothing they cannot lose on the roll they then make. `named` is trusted
 * only as one of the three enum values; the DC (`pressureDc`) and the consequence command stay
 * entirely code-side.
 */
export function pressureAnswerFrom(named: PressureAnswer | null | undefined, input: string): PressureAnswer {
  if (named) return named;
  const floor = pressureAnswerOf(input);
  return floor === "comply" ? "neutral" : floor;
}

/**
 * The DC an NPC's applied pressure imposes on its target — how hard this NPC clamps down, from
 * disposition, intensity, and grudge. Used for autonomous demand/pressure resists and for the
 * party leave-gate's contested escape (the leader-derived DC).
 */
export function pressureDc(stanceValue: AgendaStance, severe: boolean): number {
  const disposition = stanceValue.disposition;
  // Calibrated against a level-1 PC (+0..+2 in the resisting ability): an everyday press should be
  // a real contest, not a near-certain loss. Exploitative peaks around DC 16–18, transactional 13–15.
  const base =
    disposition === "exploitative"
      ? 14
      : disposition === "transactional"
        ? 12
        : disposition === "wary"
          ? 11
          : 10;
  const intensity = Math.round(stanceValue.intensity * (severe ? 4 : 3));
  const relationship = stanceValue.relationship < 0 ? Math.round(Math.abs(stanceValue.relationship) / 25) : 0;
  return clamp(base + intensity + relationship, 8, 24);
}

/**
 * Read the perceived social signals a target presents. Tags live on the entity's NpcTemplate identity,
 * so they come from `world.npcs`
 * for an NPC target and are simply absent for a bare-PC target (no F signals ⇒ no modifiers).
 *
 * `visibleKeywords` layers in what the target can be SEEN as right now (attire, status effects) via
 * `visibleStateOf` — the same derivation the narrator brief and the memory beat use — so a target's
 * live state reads socially the same way an authored trait would.
 */
function targetSignalsFor(
  targetId: string,
  model: WorldModel,
  world: World,
  campaign: Campaign | undefined,
): TargetSignals {
  const ent = model.entities.get(targetId);
  const tmpl = world.npcs.find((n) => n.id === (ent?.templateId ?? targetId));
  const character = campaign?.characters.find((c) => c.id === targetId);
  return {
    appearanceTags: tmpl?.appearanceTags,
    presentationTags: tmpl?.presentationTags,
    socialTraits: tmpl?.socialTraits,
    visibleKeywords: visibleStateOf(model, targetId, character).flatMap((f) => f.socialKeywords),
  };
}

/**
 * Derive the current stance of `npc` toward `targetId` from traits, relationship, and memory.
 * `campaign` is OPTIONAL (additive, Workstream F): supplied, it lets the appearance/identity read
 * gate a PC target's minor status from the sheet; omitted, existing call sites behave unchanged.
 */
export function stance(
  npc: NpcTemplate,
  targetId: string,
  model: WorldModel,
  world: World,
  campaign?: Campaign,
): AgendaStance {
  const morality = resolvePreset(MORALITIES, npc.alignment);
  const alignmentId = (morality?.id as Alignment | undefined) ?? "tn";
  const alignment = ALIGNMENT_LEANS[alignmentId];
  const personality = resolvePreset(PERSONALITIES, npc.personalityTemplate);
  const personalityId = personality?.id;
  const p = personalityId ? (PERSONALITY[personalityId] ?? NEUTRAL_PERSONALITY) : NEUTRAL_PERSONALITY;
  const profile = relationshipProfile(model, npc.id, targetId);
  const relationship = profile.friendship;
  const rel = relationship / 100;
  const memory = memoryLean(model, npc.id);
  // Living faction system: how the target (when it is the PC) stands with THIS npc's faction bends
  // the read — a faction ally is met warmer, a faction enemy warier. −1..1, 0 when the npc has no
  // faction or the target has no standing (so a factionless world is byte-identical). History still
  // dominates: the band here is modest and bounded.
  const factionStand = factionStandingOf(model.modules, targetId, npc.factionId) / 100;

  const warmth = rel * 0.55 + alignment.good * 0.2 + p.warmth + memory + factionStand * 0.3;
  const wary = Math.max(0, -rel * 0.35 + p.wary - alignment.good * 0.05 + Math.max(0, -factionStand) * 0.25);
  const transactional =
    p.transactional + (alignment.good < 0 ? 0.08 : 0) + (Math.abs(rel) < 0.25 ? 0.06 : 0);
  const exploitation =
    -alignment.good * 0.35 +
    p.exploitative +
    Math.max(0, -rel) * 0.25 +
    Math.max(0, -factionStand) * 0.15 +
    (npc.exploitative ? 0.4 : 0);

  let disposition: AgendaDisposition;
  if (relationship >= 70 && warmth >= 0.55) disposition = "devoted";
  else if (exploitation >= 0.65 && relationship <= 20) disposition = "exploitative";
  else if (warmth >= 0.32) disposition = "helpful";
  else if (transactional >= 0.22 || (alignment.good < 0 && relationship >= -10)) disposition = "transactional";
  else if (wary >= 0.22 || warmth <= -0.2) disposition = "wary";
  else disposition = "neutral";

  const driver =
    disposition === "exploitative"
      ? exploitation
      : disposition === "transactional"
        ? transactional
        : disposition === "wary"
          ? wary
          : Math.abs(warmth);

  let intensity = clamp(driver, 0, 1);

  // Workstream F — the appearance/identity social read. Pure + bounded: the observer's
  // preferences/boundaries/socialTraits meet the target's perceived signals; the net of the
  // approach axes (trust+respect) minus the aversion axes (fear+hostility) becomes a small
  // CLAMPED nudge on intensity (±0.15 at the extreme). It never forces a disposition, never touches
  // offLimits, and when the target carries no signals `resolveSocialModifiers` returns [] ⇒ nudge 0
  // ⇒ the stance is byte-identical to the pre-F world.
  const signals = targetSignalsFor(targetId, model, world, campaign);
  const modifiers = resolveSocialModifiers(
    {
      preferences: npc.preferences,
      boundaries: npc.boundaries,
      socialTraits: npc.socialTraits,
    },
    signals,
  );
  const sumOf = (axes: SocialModifier["axis"][]): number =>
    modifiers.filter((m) => axes.includes(m.axis)).reduce((acc, m) => acc + m.delta, 0);
  const rawNudge = sumOf(["trust", "respect"]) - sumOf(["fear", "hostility"]);
  const nudge = (clamp(rawNudge, -SOCIAL_MODIFIER_MAX, SOCIAL_MODIFIER_MAX) / SOCIAL_MODIFIER_MAX) * 0.15;
  intensity = clamp(intensity + nudge, 0, 1);

  return {
    npcId: npc.id,
    targetId,
    disposition,
    intensity,
    relationship,
    relationshipProfile: profile,
    alignment: { id: alignmentId, ...alignment },
    personalityId,
    offLimits: offLimitsFor(alignment, personalityId, relationship),
    socialContext: modifiers.length ? { modifiers } : undefined,
  };
}

/**
 * The alignment/personality leans a bystander-intervention decision reads (owner decision
 * 2026-07-05). Exported so `src/rules/intervention.ts` reuses the ALIGNMENT_LEANS/PERSONALITY tables
 * rather than duplicating them.
 */
export interface BystanderLeans {
  /** Alignment good axis (−1..1): a good streak makes intervening likelier. */
  good: number;
  /** Personality warmth: warm archetypes step in; cold ones hang back (can be negative). */
  warmth: number;
  /** Personality exploitative weight: a exploitative bystander is complicit, not a rescuer. */
  exploitative: number;
}

/**
 * Read an NPC's bystander-intervention leans from its alignment + personality (the SAME tables
 * `stance()` uses). Pure; absent presets read as neutral (all-zero leans).
 */
export function bystanderLeans(npc: NpcTemplate): BystanderLeans {
  const morality = resolvePreset(MORALITIES, npc.alignment);
  const alignmentId = (morality?.id as Alignment | undefined) ?? "tn";
  const personality = resolvePreset(PERSONALITIES, npc.personalityTemplate);
  const p = personality?.id ? (PERSONALITY[personality.id] ?? NEUTRAL_PERSONALITY) : NEUTRAL_PERSONALITY;
  return { good: ALIGNMENT_LEANS[alignmentId].good, warmth: p.warmth, exploitative: p.exploitative };
}

/**
 * The friendship value an NPC naturally settles toward over time (the decay target), derived from
 * the SAME alignment/personality tables `stance()` reads — so warm archetypes settle above 0 and
 * cold/exploitative ones below it, with no stored per-NPC baseline. Bounded to a modest band: history
 * (quests, gifts, betrayals) still dominates; this is only where an untouched relationship rests.
 */
export function personalityBaseline(npc: NpcTemplate): number {
  const morality = resolvePreset(MORALITIES, npc.alignment);
  const alignmentId = (morality?.id as Alignment | undefined) ?? "tn";
  const good = ALIGNMENT_LEANS[alignmentId].good;
  const personality = resolvePreset(PERSONALITIES, npc.personalityTemplate);
  const p = personality?.id ? (PERSONALITY[personality.id] ?? NEUTRAL_PERSONALITY) : NEUTRAL_PERSONALITY;
  const lean = p.warmth + good * 0.2 - p.wary * 0.3 - p.exploitative * 0.5;
  return clamp(Math.round(lean * 40), -25, 30);
}

/** The DC a player must beat to move this NPC on an ask, or "refused" for hard limits. */
export function resistanceDC(_npc: NpcTemplate, ask: AgendaAsk, stanceValue: AgendaStance): number | "refused" {
  if (stanceValue.offLimits.has(ask.kind)) return "refused";

  const dispositionMod: Record<AgendaDisposition, number> = {
    devoted: -5,
    helpful: -3,
    neutral: 0,
    wary: 2,
    transactional: 1,
    exploitative: 4,
  };
  // Base 11 (not 12): a neutral stranger at level 1 should be beatable more often than not on a
  // fair ask — social play is the game's core verb, so the math must not punish attempting it.
  let dc = 11 + dispositionMod[stanceValue.disposition] - Math.round(stanceValue.relationship / 20);

  if (ask.approach === "persuade") {
    if (stanceValue.disposition === "helpful" || stanceValue.disposition === "devoted") dc -= 2;
    if (stanceValue.disposition === "exploitative") dc += 2;
  } else if (ask.approach === "intimidate") {
    dc += stanceValue.alignment.law > 0 || stanceValue.alignment.good > 0 ? 3 : 0;
    dc += stanceValue.disposition === "exploitative" ? 2 : 0;
  } else if (ask.approach === "bribe") {
    dc += stanceValue.alignment.good > 0 ? 4 : 0;
    dc += stanceValue.alignment.law > 0 ? 2 : 0;
    dc -= stanceValue.disposition === "transactional" || stanceValue.disposition === "exploitative" ? 3 : 0;
  }

  if (ask.kind === "surrenderItem" || ask.kind === "debt") dc += 1;
  if (ask.kind === "steal" || ask.kind === "lie") dc += 2;

  const intensityMod =
    stanceValue.disposition === "helpful" || stanceValue.disposition === "devoted"
      ? -Math.round(stanceValue.intensity * 3)
      : Math.round(stanceValue.intensity * 4);
  return clamp(dc + intensityMod, 5, 30);
}

/**
 * The entity flag a WON debt-press sets on its target. Exported so the consequence literal and
 * the re-press guard below can never drift: once the target carries this flag, the debt is held
 * and pressing it again is a soft-lock, not drama (a live-playtest defect — the same "presses a
 * debt" CHA-resist consumed three consecutive player turns).
 */
export function debtFlagKey(npcId: string): string {
  return `debt_to_${npcId.replace(/[^A-Za-z0-9_.-]+/g, "_")}`;
}

/** Deterministically choose the agenda action this NPC initiates on an autonomous beat. */
export function chooseAgendaAction(
  npc: NpcTemplate,
  stanceValue: AgendaStance,
  model: WorldModel,
  world: World,
): AgendaAction | null {
  const actor = model.entities.get(npc.id);
  const target = model.entities.get(stanceValue.targetId);
  if (!actor || !target || !samePlace(model, actor.id, target.id)) return null;

  const targetLabel = targetName(model, target.id);
  if (stanceValue.disposition === "devoted" || stanceValue.disposition === "helpful") {
    const itemId = firstGiftItem(model, npc.id);
    if (itemId) {
      return {
        kind: "help",
        targetId: target.id,
        command: { type: "transferItem", itemId, from: npc.id, to: target.id },
        directive: `Offer ${itemName(world, itemId)} to ${targetLabel} as concrete help.`,
        summary: `offers ${itemName(world, itemId)}`,
      };
    }
    return {
      kind: "help",
      targetId: target.id,
      command: { type: "adjustRelationship", actorId: npc.id, targetId: target.id, by: 2 },
      directive: `Bolster ${targetLabel} with genuine support and make clear you are on their side.`,
      summary: "offers support",
    };
  }

  if (stanceValue.disposition === "exploitative" || stanceValue.disposition === "transactional") {
    const itemId = preferredDemandItem(model, world, target.id);
    if (itemId) {
      const label = `${npc.name} demands ${itemName(world, itemId)}`;
      return {
        kind: "demand",
        targetId: target.id,
        consequence: { type: "transferItem", itemId, from: target.id, to: npc.id },
        resist: { ability: "cha", dc: pressureDc(stanceValue, true), label },
        directive: `Demand ${itemName(world, itemId)} from ${targetLabel}; this is pressure, not a gift.`,
        summary: `demands ${itemName(world, itemId)}`,
      };
    }
    // A WON press is settled business: once the target already carries this NPC's debt flag,
    // pressing the identical debt again is spam, not leverage — the NPC has nothing further to
    // extract here, so it initiates nothing this beat (plain dialogue instead).
    if (target.flags?.[debtFlagKey(npc.id)] === true) return null;
    return {
      kind: "pressure",
      targetId: target.id,
      consequence: {
        type: "setFlag",
        scope: "entity",
        entityId: target.id,
        key: debtFlagKey(npc.id),
        value: true,
      },
      resist: { ability: "cha", dc: pressureDc(stanceValue, false), label: `${npc.name} presses a debt` },
      directive: `Press ${targetLabel} to accept a debt to you, making the social cost explicit.`,
      summary: "presses a debt",
    };
  }

  if (stanceValue.disposition === "wary" && stanceValue.intensity >= 0.35) {
    return {
      kind: "manipulate",
      targetId: target.id,
      command: { type: "adjustRelationship", actorId: npc.id, targetId: target.id, by: -2 },
      directive: `Keep ${targetLabel} at arm's length and make your distrust clear without taking their agency.`,
      summary: "withdraws trust",
    };
  }

  return null;
}

/**
 * Cruelty at/above which a leader's discipline reaches the BODY (a strike or a cowing) rather than a
 * mere social press. Below it an aggrieved leader still presses socially (chooseAgendaAction's job).
 */
const CORPORAL_CRUELTY_MIN = 0.6;

/**
 * Feature 3 — a party LEADER's proactive CORPORAL discipline of the player, or null when this leader
 * wouldn't raise a hand. PC-only (the caller passes a PC-targeted stance). Only the bodily tier lives
 * here; the social press (dock / debt / seize an item) stays chooseAgendaAction's, so a leader who
 * isn't cruel enough returns null and the caller falls through to the ordinary press.
 *
 * Gating is purely emergent — no authored flag. A warm leader (devoted/helpful) never disciplines; a
 * leader whose alignment/personality puts harm off-limits (good/lawful/caretaker — `stance.offLimits`
 * carries `harmInnocent`) never reaches this tier; otherwise a `cruelty` scalar (evil lean + exploitative
 * personality + how far the relationship has soured + accumulated `grievance`) decides whether, and
 * how hard, the leader acts. An exploitative leader beats (a small `adjustHp` strike scaled by the
 * grudge); a colder disciplinarian COWS (a brief `cowed` debuff). Either is armed as an ordinary
 * PendingAgendaPressure the PC RESISTS (dodge / steel) — on a failed resist the reducer applies it
 * (engine.resolveAgendaPressure). Pure/deterministic like chooseAgendaAction; exported for tests.
 */
export function chooseLeaderDiscipline(
  npc: NpcTemplate,
  s: AgendaStance,
  grievance: number,
  model: WorldModel,
  world: World,
): AgendaAction | null {
  void world; // content lookup not needed here (mirrors chooseAgendaAction's signature for the caller)
  const actor = model.entities.get(npc.id);
  const target = model.entities.get(s.targetId);
  if (!actor || !target || !samePlace(model, actor.id, target.id)) return null;
  // A warm leader keeps its hands down; a harm-averse one (good/lawful/caretaker) never gets physical.
  if (s.disposition === "devoted" || s.disposition === "helpful") return null;
  if (s.offLimits.has("harmInnocent")) return null;

  const p = PERSONALITY[s.personalityId ?? ""] ?? NEUTRAL_PERSONALITY;
  const cruelty = clamp(
    -s.alignment.good * 0.3 + p.exploitative + (Math.max(0, -s.relationship) / 100) * 0.3 + grievance * 0.12,
    0,
    1.5,
  );
  if (cruelty < CORPORAL_CRUELTY_MIN) return null;

  const targetLabel = targetName(model, target.id);
  // Grievance hardens the response: a nursed grudge makes it harder to dodge and (for a strike) hurts more.
  const dc = pressureDc(s, true) + Math.min(6, Math.floor(grievance) * 2);

  if (s.disposition === "exploitative") {
    const strike = Math.min(6, 2 + Math.floor(grievance));
    return {
      kind: "demand",
      targetId: target.id,
      consequence: { type: "adjustHp", entityId: target.id, by: -strike },
      resist: { ability: "dex", dc, label: `${npc.name} strikes ${targetLabel}` },
      directive: `Discipline ${targetLabel} with a short, sharp blow for stepping out of line — punishment from the one who leads, not a brawl.`,
      summary: "strikes you for stepping out of line",
    };
  }
  return {
    kind: "demand",
    targetId: target.id,
    consequence: { type: "applyStatusEffect", entityId: target.id, effect: cowedEffect() },
    resist: { ability: "cha", dc, label: `${npc.name} cows ${targetLabel}` },
    directive: `Put ${targetLabel} back in their place with cold authority until they flinch — authority asserted, no blow struck.`,
    summary: "cows you back into line",
  };
}

/** The default target for autonomous agenda: the player character at the party location. */
export function agendaTarget(model: WorldModel): string | null {
  const player = playerEntity(model);
  const loc = partyLocationOf(model);
  if (!player || !loc) return null;
  return entitiesAt(model, loc).some((e) => e.id === player.id) ? player.id : null;
}
