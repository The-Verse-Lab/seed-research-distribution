/**
 * Player↔faction standing — the faction system's living gauge.
 *
 * Authored `World.factions` used to be inert flavour: a name, goals, and a faction↔faction
 * `relationships` matrix nothing at runtime ever read. This module turns factions into a system the
 * player feels. A per-PC standing score (−100..100 toward each faction) rides a module slice
 * (`WorldModel.modules.factionStanding`), moved by the SAME organic events living relationships
 * already emit — quest credit and gifts warm a faction, attacking a member cools it. Standing then
 * bends every member's stance (see `stance()`), and the authored faction↔faction matrix finally
 * matters: a shift with one faction BLEEDS a fraction to its allies (same sign) and enemies
 * (opposite), so helping the river-guild really does sour the tideborn.
 *
 * Content-free reducer contract: the reducer knows nothing of `World.factions` (faction relationship
 * scores are authored CONTENT, not model state), so the ally/enemy bleed is computed HERE at the
 * call site — which has `world` — and returned as a list of plain `adjustFactionStanding` commands
 * the engine/module enqueues. The reducer just clamps + writes + emits one delta per command.
 *
 * Inert by default: a world with no factions, or a PC who has never moved a standing, serializes
 * byte-identically — `readFactionStandingSlice` never materialises the slice and the render/stance
 * helpers return empty/zero.
 *
 * @author Runkai Zhang
 */
import type { Command } from "../world/commands.ts";
import type { World } from "../content/schema.ts";

export const FACTION_STANDING_MIN = -100;
export const FACTION_STANDING_MAX = 100;

/** Faction standing a quest-giver's faction gains when the PC completes their quest. */
export const QUEST_FACTION_WARMTH = 6;
/** Bounds on the faction standing a gift to a member earns that member's faction. */
export const GIFT_FACTION_WARMTH_MIN = 1;
export const GIFT_FACTION_WARMTH_MAX = 4;
/** Standing a faction loses when the PC opens an attack on one of its members. */
export const FACTION_ATTACK_STANDING = 12;
/**
 * Fraction of a primary standing change that bleeds to an allied/enemy faction, scaled by the
 * authored faction↔faction score. Small: a +10 with river-guild bleeds ≈ ±(10·score/100·0.5).
 */
export const FACTION_BLEED_FRACTION = 0.5;

export type StandingBand = "allied" | "friendly" | "neutral" | "wary" | "hostile";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Base template id behind a spawn instance id (`tpl#3` → `tpl`). */
function baseTemplateId(id: string): string {
  return id.replace(/#\d+$/, "");
}

/**
 * The faction an entity belongs to, read from the authored template (matched by id, then by spawn
 * base-id), never the runtime Entity — statted-NPC `Entity.flags` drop on reload. Undefined when the
 * entity has no template or no `factionId`.
 */
export function factionOf(world: World, npcId: string): string | undefined {
  return (
    world.npcs.find((n) => n.id === npcId)?.factionId ??
    world.npcs.find((n) => n.id === baseTemplateId(npcId))?.factionId
  );
}

/**
 * Persisted player↔faction standing (`WorldModel.modules.factionStanding`). Written only through the
 * reducer's `adjustFactionStanding` command (typed `factionStandingChanged` delta, replay-safe);
 * never `Entity.flags`.
 */
export interface FactionStandingSlice {
  /** pcId → factionId → standing (−100..100). */
  byPc: Record<string, Record<string, number>>;
}

/**
 * Defaulting COPY-reader (the `readRoutinesSlice` idiom) — never materialises the slice, so a world
 * that never moves a standing serialises byte-identically.
 */
export function readFactionStandingSlice(modules: Record<string, unknown> | undefined): FactionStandingSlice {
  const slice = modules?.factionStanding as Partial<FactionStandingSlice> | undefined;
  return { byPc: structuredClone(slice?.byPc ?? {}) };
}

/**
 * The PC's current standing toward a faction (0 when never moved / unknown). Takes the `modules`
 * bag directly (shared by `WorldModel` and the `GameState` projection), so both the stance layer and
 * read-only consumers can use it.
 */
export function factionStandingOf(
  modules: Record<string, unknown> | undefined,
  pcId: string,
  factionId: string | undefined,
): number {
  if (!factionId) return 0;
  const slice = modules?.factionStanding as Partial<FactionStandingSlice> | undefined;
  return clamp(slice?.byPc?.[pcId]?.[factionId] ?? 0, FACTION_STANDING_MIN, FACTION_STANDING_MAX);
}

/** Warmth a gift of the given copper value earns the recipient's faction (~1 / 50cp, clamped small). */
export function giftFactionWarmth(valueCp: number): number {
  if (!Number.isFinite(valueCp) || valueCp <= 0) return GIFT_FACTION_WARMTH_MIN;
  return Math.max(GIFT_FACTION_WARMTH_MIN, Math.min(GIFT_FACTION_WARMTH_MAX, Math.round(valueCp / 50)));
}

/**
 * A primary standing change with `factionId`, plus the ally/enemy BLEED it induces through the
 * authored faction↔faction matrix (P2). Each returned command is an `adjustFactionStanding` the
 * caller applies/enqueues through the reducer. The primary is emitted even for an unknown/unauthored
 * faction (the slice is faction-id keyed, not gated on `World.factions`); only the bleed needs the
 * authored `relationships`. A bled delta that rounds to 0 is dropped. Deterministic, no rng.
 */
export function factionStandingCommands(
  world: World,
  pcId: string,
  factionId: string | undefined,
  by: number,
): Command[] {
  if (!factionId || !Number.isFinite(by) || by === 0) return [];
  const out: Command[] = [{ type: "adjustFactionStanding", pcId, factionId, by }];
  const faction = world.factions.find((f) => f.id === factionId);
  if (!faction) return out;
  for (const [otherId, score] of Object.entries(faction.relationships)) {
    if (otherId === factionId || !score) continue;
    const bled = Math.round(by * (score / 100) * FACTION_BLEED_FRACTION);
    if (bled !== 0) out.push({ type: "adjustFactionStanding", pcId, factionId: otherId, by: bled });
  }
  return out;
}

/** Band a standing (−100..100) into a legible label for projections and briefs. */
export function standingBand(score: number): StandingBand {
  if (score >= 60) return "allied";
  if (score >= 20) return "friendly";
  if (score <= -60) return "hostile";
  if (score <= -20) return "wary";
  return "neutral";
}

/**
 * The PC's non-neutral faction standings as brief facts for the narrator (`# FACTION STANDING`),
 * omit-when-empty. Only factions the PC has actually moved off zero appear, most-extreme first;
 * deterministic tie-break by faction id.
 */
export function factionStandingLines(
  modules: Record<string, unknown> | undefined,
  world: World,
  pcId: string,
  /** Restrict to ONE faction's standing (Phase 2 observer scoping: an NPC reads only its own). */
  onlyFactionId?: string,
): string[] {
  const slice = modules?.factionStanding as Partial<FactionStandingSlice> | undefined;
  const row = slice?.byPc?.[pcId];
  if (!row) return [];
  const rows = Object.entries(row)
    .map(([id, raw]) => ({ id, score: clamp(raw, FACTION_STANDING_MIN, FACTION_STANDING_MAX) }))
    .filter((r) => r.score !== 0)
    .filter((r) => onlyFactionId === undefined || r.id === onlyFactionId)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || (a.id < b.id ? -1 : 1));
  return rows.map((r) => {
    const name = world.factions.find((f) => f.id === r.id)?.name ?? r.id;
    return `- ${name}: ${standingBand(r.score)} (${r.score > 0 ? "+" : ""}${r.score})`;
  });
}
