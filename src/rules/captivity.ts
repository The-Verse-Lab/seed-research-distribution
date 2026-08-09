/**
 * Captivity mechanics — the pure, deterministic core of the bad-end FOLLOW-UP loop.
 *
 * A lost fight no longer fades to a dead world-flag: the defeat outcome enqueues
 * a `beginCaptivity` command and the player is really HELD — moved to a locked holding location, gear
 * stripped, party scattered, a `captive` condition set. This file owns the pure turn-by-turn LOOP the
 * player plays to get OUT: each captive turn they `labor` (advance toward release + wear the guard
 * down), `endure` (serve time), or `escape` (a real check vs the current DC). Serve the whole term and
 * you are freed; break the guard down and gamble a run for it.
 *
 * Pure and deterministic: no world/model/LLM import,
 * same (slice, action, roll) → same result. The passive per-beat FLAVOUR is picked from a PRIVATE
 * id-keyed rng (`mulberry32(fnv1a(key))`) — zero draws from the shared tick stream, so weaving the loop
 * into a tick never perturbs another seeded mechanic and every beat replays byte-identically. The
 * escape CHECK is a real player roll and is drawn from the shared stream by the caller (like any skill
 * check); this resolver only takes its boolean result, so it stays trivially unit-testable.
 *
 * The `CaptivitySlice` shape lives here (pure data, no world deps) so `rules/` never imports `world/`;
 * `world/captivity.ts` adds the synthetic holding LOCATION + the defaulting reader on top of it.
 *
 * @author Runkai Zhang
 */
import { mulberry32 } from "./dice.ts";

/** WHICH bad end put you here — sets the term length, the escape difficulty, and the flavour. */
export type CaptivityKind =
  | "gaol"
  | "debt-bondage"
  | "lair"
  | "ransom"
  | "arena"
  | "mine"
  | "cult"
  | "nest"
  | "press-ganged";

/** The three things a held player can do with a turn. */
export type CaptivityAction = "labor" | "endure" | "escape";

/**
 * The persisted captivity state (WorldModel.modules.captivity), written ONLY by the reducer
 * (`beginCaptivity` / `endCaptivity` / a per-turn `modulePatch`). Absolute post-state, so it folds
 * idempotently through the generic `modulePatched` delta — no new delta kind, replay-safe by reuse.
 */
export interface CaptivitySlice {
  /** True while the player is held (the loop owns their turns). */
  active: boolean;
  /** The bad end that put them here. */
  kind: CaptivityKind;
  /** The NPC holding them (a jailer or beast), or null for a keeperless hold (a bare cell). */
  captorId: string | null;
  /** The captor's display name at capture (narration survives even if the entity is later culled). */
  captorName: string;
  /** Where the captor was taken FROM — where `endCaptivity` returns them (back to their post). */
  captorOriginLoc: string | null;
  /** The captor's tier before capture — restored on release (they were promoted to persist the arc). */
  captorWasTier: string | null;
  /** Where the PLAYER was captured — where release drops them back. */
  returnLocationId: string | null;
  /** The PC gear confiscated at capture, returned on release (kept in the slice, held by no entity). */
  strippedItems: string[];
  /** Party members dropped at capture, re-admitted on release (the PC is isolated while held). */
  droppedMemberIds: string[];
  /** The current escape-check DC — labour wears it down, a failed break-out stiffens it. */
  escapeDc: number;
  /** Progress toward serving the term out (auto-release at `goal`). */
  progress: number;
  /** Progress needed for release. */
  goal: number;
  /** The captivity day counter — narration + escalation. */
  day: number;
  /** The clock reading at capture (diagnostics). */
  enteredClock: number;
}

/** Per-kind tuning: the term length, escape difficulty, and how fast labour buys release / wears the guard. */
export interface CaptivityConfig {
  /** Progress for auto-release. */
  goal: number;
  /** Starting escape DC. */
  escapeDc: number;
  /** Floor the escape DC can be worn down to by labour (a run is never a sure thing). */
  minEscapeDc: number;
  /** Progress a `labor` turn earns. */
  laborGain: number;
  /** How much a `labor` turn wears the guard down (escape DC drop). */
  laborGuardDrop: number;
  /** Progress an `endure` turn earns (serving time, slower than working). */
  endureGain: number;
  /** How much a FAILED escape stiffens the guard (escape DC rise). */
  escapeFailPenalty: number;
  /** Narration nouns — the place and the keeper, for the follow-up beats. */
  place: string;
  keeper: string;
}

/**
 * The shared per-kind table. Values chosen so the loop is a real, escapable grind (a handful of turns),
 * not a dead end and not a formality: labour buys release in ~4–5 turns OR wears the guard down for a
 * gamble; a beast's `lair` is short but a high fixed-DC bolt for the exit.
 */
export const CAPTIVITY_CONFIG: Record<CaptivityKind, CaptivityConfig> = {
  gaol: {
    goal: 6, escapeDc: 14, minEscapeDc: 8,
    laborGain: 2, laborGuardDrop: 2, endureGain: 1, escapeFailPenalty: 1,
    place: "the holding cell", keeper: "the gaoler",
  },
  "debt-bondage": {
    goal: 8, escapeDc: 13, minEscapeDc: 8,
    laborGain: 2, laborGuardDrop: 1, endureGain: 1, escapeFailPenalty: 1,
    place: "the work-gang", keeper: "the taskmaster",
  },
  lair: {
    goal: 5, escapeDc: 15, minEscapeDc: 11,
    laborGain: 1, laborGuardDrop: 1, endureGain: 1, escapeFailPenalty: 1,
    place: "the beast's den", keeper: "the beast",
  },
  ransom: {
    goal: 6, escapeDc: 14, minEscapeDc: 9,
    laborGain: 1, laborGuardDrop: 1, endureGain: 1, escapeFailPenalty: 1,
    place: "the ransom-hold", keeper: "your captor",
  },
  arena: {
    goal: 12, escapeDc: 17, minEscapeDc: 10,
    laborGain: 3, laborGuardDrop: 1, endureGain: 1, escapeFailPenalty: 2,
    place: "the fighting pit", keeper: "the pit-master",
  },
  mine: {
    goal: 12, escapeDc: 15, minEscapeDc: 9,
    laborGain: 3, laborGuardDrop: 1, endureGain: 1, escapeFailPenalty: 1,
    place: "the deep gallery", keeper: "the overseer",
  },
  cult: {
    goal: 7, escapeDc: 16, minEscapeDc: 9,
    laborGain: 1, laborGuardDrop: 2, endureGain: 1, escapeFailPenalty: 2,
    place: "the undercroft", keeper: "the hierophant",
  },
  nest: {
    goal: 5, escapeDc: 19, minEscapeDc: 8,
    laborGain: 1, laborGuardDrop: 4, endureGain: 1, escapeFailPenalty: 1,
    place: "the silk-choked nest", keeper: "the brood",
  },
  "press-ganged": {
    goal: 10, escapeDc: 18, minEscapeDc: 8,
    laborGain: 2, laborGuardDrop: 3, endureGain: 1, escapeFailPenalty: 2,
    place: "the ship's hold", keeper: "the bosun",
  },
};

/** FNV-1a over a string — the stable per-key seed (mirrors the private copy in travel-events.ts). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A fresh, inactive slice — the reader default (`world/captivity.ts`) and the post-release reset. */
export function defaultCaptivitySlice(): CaptivitySlice {
  return {
    active: false,
    kind: "gaol",
    captorId: null,
    captorName: "",
    captorOriginLoc: null,
    captorWasTier: null,
    returnLocationId: null,
    strippedItems: [],
    droppedMemberIds: [],
    escapeDc: 0,
    progress: 0,
    goal: 0,
    day: 0,
    enteredClock: 0,
  };
}

/** The passive per-action flavour pools — a beat the DM narrates. Keyed-rng picked (zero shared draws). */
const BEATS: Record<CaptivityAction, Record<CaptivityKind, string[]>> = {
  labor: {
    gaol: [
      "You scrub the cell block and haul slop buckets under a bored guard's eye, earning a sliver of trust.",
      "You keep your head down and do the work set you, marking the guards' rounds as you go.",
    ],
    "debt-bondage": [
      "You break your back on the work-gang, another mark struck off the ledger against your name.",
      "You labour till your hands bleed, the overseer counting the day's toil toward your debt.",
    ],
    lair: [
      "You make yourself useful sorting the beast's hoard, and it watches you a little less closely.",
      "You tend the den's filth and keep still, learning the creature's habits.",
    ],
    ransom: [
      "You run errands for your keepers while the ransom bird flies, biding your time.",
      "You play the compliant hostage, and the watch on you slackens by a hair.",
    ],
    arena: [
      "You survive another bout in the pit, earning bruises, breath, and a little less scrutiny.",
      "You drill under the pit-master's eye, learning which gates stick and which guards tire first.",
    ],
    mine: [
      "You swing a pick in the deep gallery until your shoulders burn, another tally scratched beside your name.",
      "You haul ore through the sunless tunnels, marking the overseer's habits while the chain slackens.",
    ],
    cult: [
      "You carry censers and wash ritual stone, counting whispers and exits beneath the chanting.",
      "You play the docile offering while the cult readies its rite, stealing fragments of their schedule.",
    ],
    nest: [
      "You worry at the webbing and drag refuse from the brood's tunnels, loosening strands by patient inches.",
      "You tend the cocooned dark, learning where the silk is weakest and when the brood looks away.",
    ],
    "press-ganged": [
      "You haul line and scrub decks under the bosun's lash, learning the watch and the shape of the hold.",
      "You work the bilge until the ship rolls in your bones, buying a little trust from exhausted sailors.",
    ],
  },
  endure: {
    gaol: ["Another day bleeds by in the cell. You wait, and you watch."],
    "debt-bondage": ["Another day on the chain. The ledger is long, but shorter than yesterday."],
    lair: ["You survive another day in the reek of the den, keeping still and breathing shallow."],
    ransom: ["Another day a hostage. Somewhere, a price is being haggled over your head."],
    arena: ["Another day beneath the arena. You mend, breathe, and listen to the crowd above."],
    mine: ["Another shift ends in darkness. Dust coats your tongue, but the count moves on."],
    cult: ["Another bell passes under the chanting. The rite draws nearer, and you keep your nerve."],
    nest: ["Another day cocooned in the brood's dark. You stay still enough to be overlooked."],
    "press-ganged": ["Another watch at sea. The boards groan, the hold stinks, and land is only a rumor."],
  },
  escape: {
    gaol: ["You palm a pin and work the lock, heart in your throat."],
    "debt-bondage": ["You slip your chains and make for the tree line while the overseer's back is turned."],
    lair: ["You wait for the beast to drowse, then bolt for the mouth of the den."],
    ransom: ["You jump your guard and run for it while the hold sleeps."],
    arena: ["You dive for the service gate while the pit-master's attention snaps to the crowd."],
    mine: ["You duck into a side-cut and follow stale air toward a crack of daylight."],
    cult: ["You slip from the chalked circle before the rite can close around you."],
    nest: ["You tear at the cocoon and lunge through the silk before the brood can answer."],
    "press-ganged": ["You wait for rough weather, then bolt for the rail and the dark water beyond."],
  },
};

/** Pick a beat deterministically from the pool for (kind, action, day) — private keyed rng, no shared draws. */
function beatFor(kind: CaptivityKind, action: CaptivityAction, day: number): string {
  const pool = BEATS[action][kind];
  if (pool.length === 0) return "";
  const idx = Math.floor(mulberry32(fnv1a(`captivity-beat:${kind}:${action}:${day}`))() * pool.length);
  return pool[Math.min(idx, pool.length - 1)] ?? pool[0]!;
}

/** The outcome of one captive turn: the next slice + whether the term is served / the run succeeded. */
export interface CaptivityActionResult {
  next: CaptivitySlice;
  /** True when progress reached the goal — the term is served, release is automatic. */
  released: boolean;
  /** True when an `escape` check passed — the player is out. */
  escaped: boolean;
  /** The flavour beat for this action (release/escape are narrated by the caller). */
  beat: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Resolve ONE captive turn against the slice — pure. `labor` advances the term AND wears the escape DC
 * down (buying either an eventual auto-release or a safer run); `endure` only serves time; `escape`
 * takes the caller's pre-rolled `escapeSucceeded` (a real d20 check vs `slice.escapeDc`, drawn from the
 * shared stream by the module) — a success frees them, a failure stiffens the guard and costs a day.
 * Returns the next absolute slice, whether the term is now served, whether the run got out, and the beat.
 */
export function resolveCaptivityAction(
  slice: CaptivitySlice,
  action: CaptivityAction,
  opts: { escapeSucceeded?: boolean } = {},
): CaptivityActionResult {
  const cfg = CAPTIVITY_CONFIG[slice.kind];
  const next: CaptivitySlice = { ...slice };
  let escaped = false;

  if (action === "labor") {
    next.progress = slice.progress + cfg.laborGain;
    next.escapeDc = clamp(slice.escapeDc - cfg.laborGuardDrop, cfg.minEscapeDc, slice.escapeDc);
    next.day = slice.day + 1;
  } else if (action === "endure") {
    next.progress = slice.progress + cfg.endureGain;
    next.day = slice.day + 1;
  } else {
    // escape
    if (opts.escapeSucceeded) {
      escaped = true;
    } else {
      next.escapeDc = slice.escapeDc + cfg.escapeFailPenalty;
      next.day = slice.day + 1;
    }
  }

  const released = !escaped && next.progress >= next.goal;
  return { next, released, escaped, beat: beatFor(slice.kind, action, slice.day) };
}

/** One captivity action as a click affordance; its label carries the keyword the classifier recovers. */
export interface CaptivityActionButton {
  id: CaptivityAction;
  label: string;
  hint: string;
}

/** The ordered captivity action menu — the single source the read model exposes and the engine resolves. */
export function captivityActionButtons(): CaptivityActionButton[] {
  return [
    { id: "labor", label: "Labor", hint: "Work — earn your way toward release and wear the guard down." },
    { id: "escape", label: "Attempt escape", hint: "Gamble a break-out against the current escape DC." },
    { id: "endure", label: "Endure", hint: "Keep your head down and serve the time." },
  ];
}

/**
 * The captivity action a held player's turn is, in reader order:
 *   1. an EXACT button label ("Labor" / "Attempt escape" / "Endure") — free, deterministic, and the
 *      only thing a typed captivity action can ever be;
 *   2. the classifier's CLOSED `TurnPlan.captivityAction`;
 *   3. `classifyCaptivityInput`'s prose floor, and finally its own `endure` default.
 *
 * Step 2 exists because step 3's `/\b(escape|flee|run|…)\b/` arm reads "I run my hands along the
 * wall looking for loose stones" as a break-out: a real d20, a permanently raised `escapeDc`, and a
 * burned captivity day for a line that was searching, not running (reproduced against the shipped
 * regex, r8 audit). With no model answer the order degrades to today's behavior exactly, and the
 * terminal default stays `endure` — the branch that costs the player nothing but the served day.
 */
export function captivityActionOf(named: CaptivityAction | null | undefined, input: string): CaptivityAction {
  const label = input.trim().toLowerCase();
  const clicked = captivityActionButtons().find((b) => b.label.toLowerCase() === label);
  if (clicked) return clicked.id;
  return named ?? classifyCaptivityInput(input);
}

/** Classify a free-text captive line into an action. Defaults to `endure` (a passive turn is served time). */
export function classifyCaptivityInput(input: string): CaptivityAction {
  const s = input.toLowerCase();
  // `escape` is the only branch that COSTS the player state on a misread — a real d20, a permanently
  // raised `escapeDc`, and a burned captivity day — so its cues must not be carried by a verb that
  // ordinary prose reaches for. Bare `run` did exactly that: "I run my hands along the wall looking
  // for loose stones" was charged as a jailbreak (reproduced, r8 audit). `run` now needs a direction
  // or an object of flight, and `bolt` (also a door part, in a cell) needs the same.
  if (
    /\b(escape|flee|break\s*out|break\s*free|slip\s*away|get\s*away|pick\s*the\s*lock)\b/.test(s) ||
    /\brun\b\s*(?:for|to|towards?|out|off|away|past|through|down|up|at\b)/.test(s) ||
    /\bbolt\b\s*(?:for|to|towards?|out|off|away|past|through|down|up)/.test(s)
  ) {
    return "escape";
  }
  if (/\b(labor|labour|work|toil|comply|obey|serve|dig|haul|chore|cooperate)\b/.test(s)) return "labor";
  return "endure";
}
