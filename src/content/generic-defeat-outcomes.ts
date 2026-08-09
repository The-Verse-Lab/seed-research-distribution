/**
 * Engine SHARED bad-end library — the fantasy defeat scenarios any world can opt into
 * (`constitution.useGenericDefeatOutcomes`), pooled with its own `defeatOutcomes`. This is what lets a
 * new fantasy world ship with rich, situation-fit bad ends WITHOUT authoring its own table: it just
 * flips the toggle on (the worldsmith does this by default) and the world decides which scenarios apply.
 *
 * The library is FANTASY-flavored (coin, irons, cells, dens, ransom, debt, chains) — the shared setting
 * assumption is a fantasy/medieval world. A non-fantasy world (sci-fi, modern) should NOT toggle this on;
 * it authors its own `defeatOutcomes` instead. Effects stay PORTABLE within that assumption (the player's
 * coins, world flags, the clock — no world-specific location/item/faction ids), so the tables drop into
 * ANY fantasy world unchanged, and the player id is injected by the caller (never hard-coded to `pc.you`).
 *
 * Scenario-keyed on who won: a `"monster"` drags the party to its den, while a humanoid (`"npc"`)
 * may rob, ransom, imprison, or press-gang them. Every row is a combat-defeat consequence.
 *
 * @author Runkai Zhang
 */
import type { Command } from "../world/commands.ts";
import type { DefeatOutcome } from "../rules/defeat-outcomes.ts";
import type { CaptivityKind } from "../rules/captivity.ts";

/** In-world durations (minutes) — how long the party is at the victors' mercy. */
const HOURS_2 = 120;
const HOURS_4 = 240;
const HOURS_8 = 480;

/**
 * Build the shared fantasy pool for `playerId`. Grouped by scenario: a universal floor, the humanoid
 * (`"npc"`) consequences and the monster (`"beast"`) consequences. The combat module filters this by
 * the live victor and cause so each defeat surfaces only its fitting subset.
 */
export function buildGenericDefeatOutcomes(
  playerId: string,
  captorId?: string,
  opts: { safeLocId?: string } = {},
): DefeatOutcome[] {
  const coins = (by: number): Command => ({ type: "adjustCoins", entityId: playerId, by });
  const flag = (key: string): Command => ({ type: "setFlag", scope: "world", key, value: true });
  const clock = (by: number): Command => ({ type: "advanceClock", by });
  // The REAL consequence: `beginCaptivity` actually TAKES the player — moves them to the locked hold,
  // strips their gear, scatters the party, and hands their turns to the captivity loop (labor/endure/
  // escape → release). The captor is the surviving foe passed by the trigger site; a keeperless
  // capture (`captorId` absent) still holds the player.
  const captivity = (kind: CaptivityKind): Command => ({
    type: "beginCaptivity",
    pcId: playerId,
    captorId: captorId ?? null,
    kind,
  });
  const wound = (): Command => ({
    type: "applyStatusEffect",
    entityId: playerId,
    effect: {
      kind: "maimed",
      turnsRemaining: 6,
      mods: { check: -2, attack: -2, energy: 2 },
      source: "crippling-wound",
    },
  });

  return [
    // ── Universal floor: every defeat has a stake ────────────────────────────────────────────────
    {
      id: "left-for-dead",
      weight: 2,
      tags: ["nonlethal", "loss"],
      requiresCause: ["combat-defeat"],
      effects: [flag("defeated"), clock(HOURS_2)],
      narratorBrief:
        "You are beaten down and left for dead as the victors move on. You come to some time later, " +
        "battered and alone in the aftermath. Describe the grim awakening in a sentence or two.",
    },
    {
      id: "crippling-wound",
      weight: 2,
      tags: ["injury", "loss"],
      requiresCause: ["combat-defeat"],
      effects: [wound(), coins(-25), clock(HOURS_4)],
      narratorBrief:
        "You survive, but not cleanly: a brutal wound leaves you limping and slow, every movement " +
        "costing more than it should. Describe coming to with the injury and the lost hours, in a sentence or two.",
    },

    // ── Beaten by a HUMANOID foe (bandits, brigands, a hostile watch) ─────────────────────────────
    {
      id: "robbery",
      weight: 3,
      tags: ["nonlethal", "loss"],
      requiresVictorTags: ["npc"],
      requiresCause: ["combat-defeat"],
      // Coins clamp at 0 in the reducer, so a broke party simply loses nothing — the setback stands.
      effects: [coins(-50)],
      narratorBrief:
        "You are overcome. The victors rifle the fallen, take every coin and trinket worth the weight, " +
        "and leave you breathing in the dirt. Describe coming to — robbed, hurting, but alive — in a sentence or two.",
    },
    {
      id: "ransomed",
      weight: 1,
      tags: ["custody", "ransom"],
      requiresVictorTags: ["npc"],
      requiresCause: ["combat-defeat"],
      effects: [captivity("ransom"), clock(HOURS_8)],
      narratorBrief:
        "You are worth more alive: bound, hooded, and hauled off, a ransom demand sent out in your name. " +
        "Describe waking as a hostage awaiting a price to be paid, in a sentence or two.",
    },
    {
      id: "pressed-into-labor",
      weight: 2,
      tags: ["debt", "servitude"],
      requiresVictorTags: ["npc"],
      requiresCause: ["combat-defeat"],
      effects: [captivity("debt-bondage"), clock(HOURS_8)],
      narratorBrief:
        "Spared the blade for your back: a debt of coin and blood is set against your name, to be labored " +
        "off in a chained work-gang under a hard eye. Describe the terms forced on you, in a sentence or two.",
    },
    {
      id: "thrown-in-gaol",
      weight: 2,
      tags: ["custody", "captivity"],
      requiresVictorTags: ["npc"],
      requiresCause: ["combat-defeat"],
      effects: [captivity("gaol"), clock(HOURS_8)],
      narratorBrief:
        "Beaten and disarmed, you are dragged away in irons and thrown in a cold holding cell, watched and " +
        "waiting. Describe the grim captivity and the hours already lost, in a sentence or two.",
    },
    {
      id: "thrown-to-the-pit",
      weight: 1,
      tags: ["captivity", "arena"],
      requiresVictorTags: ["npc"],
      requiresCause: ["combat-defeat"],
      effects: [captivity("arena"), clock(HOURS_8)],
      narratorBrief:
        "Your victors sell your strength instead of spilling it: you wake beneath the stands, numbered for " +
        "the fighting pit and watched by the pit-master. Describe the arena captivity in a sentence or two.",
    },
    {
      id: "sent-to-the-mines",
      weight: 1,
      tags: ["captivity", "labor"],
      requiresVictorTags: ["npc"],
      requiresCause: ["combat-defeat"],
      effects: [captivity("mine"), clock(HOURS_8)],
      narratorBrief:
        "You are marched below daylight and set to work in the deep gallery, debt and punishment made one " +
        "under the overseer's tally. Describe waking in the mines in a sentence or two.",
    },
    {
      id: "held-for-rite",
      weight: 1,
      tags: ["captivity", "cult"],
      requiresVictorTags: ["npc"],
      requiresCause: ["combat-defeat"],
      effects: [captivity("cult"), clock(HOURS_4)],
      narratorBrief:
        "Your defeat becomes an omen to them: you wake in an undercroft, kept alive for a rite whose hour is " +
        "being prepared. Describe the dread and the guarded chance to endure or flee, in a sentence or two.",
    },
    {
      id: "press-ganged",
      weight: 1,
      tags: ["captivity", "labor"],
      requiresVictorTags: ["npc"],
      requiresCause: ["combat-defeat"],
      effects: [captivity("press-ganged"), clock(HOURS_8)],
      narratorBrief:
        "You are worth a berth and a chain: dragged aboard before dawn, you wake in a ship's hold with the " +
        "bosun already counting your labor. Describe the press-gang captivity in a sentence or two.",
    },
    ...(opts.safeLocId
      ? [
          {
            id: "cast-out",
            weight: 1,
            tags: ["exile", "loss"],
            requiresVictorTags: ["npc"],
            requiresCause: ["combat-defeat"],
            effects: [
              { type: "moveEntity", entityId: playerId, to: opts.safeLocId, teleport: true } satisfies Command,
              coins(-80),
              clock(HOURS_8),
            ],
            narratorBrief:
              "Your victors do not keep you — they strip you, drag you far from the fight, and cast you out " +
              "with only pain and distance for company. Describe waking far from where you fell, in a sentence or two.",
          } satisfies DefeatOutcome,
        ]
      : []),

    // ── Beaten by a MONSTER / beast (a lair, a maw, a larder) ─────────────────────────────────────
    {
      id: "dragged-to-lair",
      weight: 2,
      tags: ["captivity", "beast"],
      requiresVictorTags: ["monster"],
      requiresCause: ["combat-defeat"],
      effects: [captivity("lair"), clock(HOURS_4)],
      narratorBrief:
        "The beast does not finish you — it takes you. You wake dragged deep into its den, penned in the " +
        "reek and the dark, its next meal kept fresh. Describe the grim waking in its lair, in a sentence or two.",
    },
    {
      id: "hoarded-as-prey",
      weight: 1,
      tags: ["captivity", "beast"],
      requiresVictorTags: ["monster"],
      effects: [captivity("lair"), clock(HOURS_8)],
      requiresCause: ["combat-defeat"],
      narratorBrief:
        "You are hauled off and stashed with the rest of the creature's hoard — bound, half-cocooned, or " +
        "caged among old bones, kept against a later hunger. Describe waking as stored prey, in a sentence or two.",
    },
    {
      id: "cocooned-in-nest",
      weight: 2,
      tags: ["captivity", "beast"],
      requiresVictorTags: ["monster"],
      effects: [captivity("nest"), clock(HOURS_4)],
      requiresCause: ["combat-defeat"],
      narratorBrief:
        "The creature does not eat you yet — it wraps and stores you in a silk-choked nest where every strand " +
        "tugs against escape. Describe waking in the brood's dark in a sentence or two.",
    },

  ];
}
