#!/usr/bin/env bun
/**
 * Seed CLI — the interactive single-player client (M1).
 *
 * Reads an action → submits it → renders the event stream → repeats. Narration streams
 * live; dice use a click-to-roll pause when interactive (and auto-roll when input is
 * piped). A reachable LLM endpoint is REQUIRED: a dead one fails fast with an actionable
 * message (there is no offline fallback mode).
 *
 * Input is read via readline's `line` events (not question()), which works for both a TTY
 * and piped stdin — Bun 1.0.0's readline/promises question() hangs on piped input.
 *
 * @author Runkai Zhang
 */
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { createProbedGateway, createStore, loadConfig } from "../config/env.ts";
import { bindCharacter, resolveCharacter } from "../content/character.ts";
import { loadPlaySetFromDir } from "../content/loader.ts";
import { makeLlmClassifier } from "../engine/classify.ts";
import { GameEngine } from "../engine/engine.ts";
import { nearbyLineOf, timeLineOf } from "../agents/context.ts";
import { knownGazetteerIdsOf } from "../world/expansion.ts";
import { exploredLocationIds, regionMeta, revealedLocationIds } from "../world/mapview.ts";
import { rumoredNodes, townNodes } from "../world/roads.ts";
import { regionCentroid } from "../world/coords.ts";
import { UNREGIONED_ID, crossRegionGateways, effectiveRegionOf, layoutRegion } from "../world/gridmap.ts";
import { WorldView } from "../world/queries.ts";
import { LoggingGateway } from "../logging/logging-gateway.ts";
import { turnContext } from "../logging/turn-context.ts";
import type { TraceSink, TurnTrace } from "../logging/types.ts";
import { GuardedGateway } from "../llm/guarded-gateway.ts";
import type { LlmGateway } from "../llm/gateway.ts";
import type { RollRequest } from "../engine/client.ts";
import { makeSaveKey, type GameStateStore, type SaveKey } from "../state/store.ts";
import type { PlaySet } from "../content/schema.ts";
import type { GameEvent } from "../events/types.ts";
import { derivedAc } from "../rules/combat.ts";
import { DEFAULT_MAX_ENERGY } from "../rules/costs.ts";
import { progressionBonusHp, progressionOf, xpToNextFrom } from "../rules/progression.ts";
import { abilityModifier } from "../rules/dice.ts";
import { exhaustionLabel, workingCap } from "../rules/exhaustion.ts";
import { formatCoins, itemDisplayNameOf, resolveItem } from "../rules/items.ts";
import { openDeals, readDealsSlice, renderDeal } from "../rules/deals.ts";
import { partyLeaderOf } from "../rules/party.ts";

const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const boldGreen = (s: string) => `\x1b[1;32m${s}\x1b[0m`;
const boldRed = (s: string) => `\x1b[1;31m${s}\x1b[0m`;

function energyReadout(actor: { energy?: number; maxEnergy?: number; exhaustion?: number } | undefined): string {
  const max = actor?.maxEnergy ?? DEFAULT_MAX_ENERGY;
  const cap = workingCap(actor?.exhaustion ?? 0, max);
  const current = Math.min(actor?.energy ?? max, cap);
  return `${current}/${cap}`;
}

interface CliArgs {
  worldPath?: string;
  character?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--character") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw new Error("usage: --character <id|path>");
      args.character = value;
      i++;
      continue;
    }
    if (arg.startsWith("--character=")) {
      const value = arg.slice("--character=".length);
      if (!value) throw new Error("usage: --character <id|path>");
      args.character = value;
      continue;
    }
    if (!arg.startsWith("-") && !args.worldPath) args.worldPath = arg;
  }
  return args;
}

/** Line reader over stdin that works for both TTY and piped input. */
class LineReader {
  readonly rl: readline.Interface;
  private queue: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private ended = false;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
    this.rl.on("line", (line) => this.push(line));
    this.rl.on("close", () => {
      this.ended = true;
      const w = this.waiting;
      this.waiting = null;
      w?.(null);
    });
  }

  private push(line: string): void {
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w(line);
    } else {
      this.queue.push(line);
    }
  }

  /** Next line, or null at EOF. */
  next(): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  close(): void {
    this.rl.close();
  }
}

interface CliCtx {
  engine: GameEngine;
  store: GameStateStore;
  saveKey: SaveKey;
  playset: PlaySet;
  reader: LineReader;
  streamedThisTurn: boolean;
  /** True while a "thinking…" indicator is on screen (reasoning models). */
  thinking: boolean;
}

function displayName(ctx: CliCtx, id: string): string {
  const pc = ctx.playset.campaign.characters.find((c) => c.id === id);
  if (pc) return pc.name;
  return ctx.playset.world.npcs.find((n) => n.id === id)?.name ?? id;
}

/** Erase the "thinking…" indicator line, if showing, before printing real output. */
function clearThinking(ctx: CliCtx): void {
  if (ctx.thinking) {
    process.stdout.write("\r\x1b[2K");
    ctx.thinking = false;
  }
}

/** Dev-only one-line turn trace (Workstream D) — printed under a turn when SEED_DEV_TRACE is on. */
function printTrace(ctx: CliCtx, t: TurnTrace): void {
  const bits: string[] = [];
  if (t.classifierKind) {
    const tgt = t.classifierTargetId ? ` → ${displayName(ctx, t.classifierTargetId)}` : "";
    const conf = t.classifierConfidence !== undefined ? ` (${t.classifierConfidence.toFixed(2)})` : "";
    bits.push(`intent ${t.classifierKind}${tgt}${conf}`);
  }
  if (t.fallback) bits.push(`freeform-fallback: ${t.fallback}`);
  // Distinct names only — two beats by the same actor printed "npc: Oda, Oda" (r9 F-15).
  if (t.npcBeats?.length) bits.push(`npc: ${[...new Set(t.npcBeats.map((b) => b.name))].join(", ")}`);
  if (bits.length) console.log(dim(`  [trace] ${bits.join(" · ")}`));
}

function render(ctx: CliCtx, e: GameEvent): void {
  clearThinking(ctx);
  switch (e.kind) {
    case "system": {
      const tag = e.level === "error" ? red("[error]") : e.level === "warn" ? yellow("[warn]") : dim("[system]");
      console.log(`${tag} ${dim(e.message)}`);
      break;
    }
    case "narration":
      if (ctx.streamedThisTurn) {
        process.stdout.write("\n");
        ctx.streamedThisTurn = false;
      } else {
        console.log(`\n${e.text}`);
      }
      break;
    case "dialogue": {
      const to = e.toId ? dim(` (to ${displayName(ctx, e.toId)})`) : "";
      console.log(`\n${bold(cyan(displayName(ctx, e.actorId)))}${to}: ${e.text}`);
      break;
    }
    case "diceRolled": {
      const dice = e.rolls.length > 1 ? `[${e.rolls.join(", ")}]` : `[${e.rolls[0] ?? "?"}]`;
      const verdict =
        e.success === undefined ? "" : e.success ? "  → " + boldGreen("SUCCESS") : "  → " + boldRed("FAILURE");
      const crit = e.rolls.includes(20) ? "  " + boldGreen("CRIT") : e.rolls.includes(1) ? "  " + boldRed("FUMBLE") : "";
      console.log(`\n${yellow("🎲")} ${e.purpose ?? e.notation}  ${e.notation} ${dice} = ${bold(String(e.total))}${verdict}${crit}`);
      break;
    }
    case "stateChanged":
      // `quiet` receipts are metadata-only: the deterministic narration line already shows them.
      if (e.quiet !== true) console.log(dim(`  · ${e.summary}`));
      break;
    case "npcProposal":
      console.log(yellow(`\n◆ ${displayName(ctx, e.actorId)} proposes: ${e.proposal}`));
      console.log(dim("  say yes to go along — anything else declines"));
      break;
    case "questOffered": {
      const pitch = e.description ? ` — ${e.description}` : "";
      console.log(yellow(`\n◈ A task is on offer: ${bold(e.name)}${pitch}`));
      console.log(dim(`  say "I accept" to take it on, or decline it`));
      break;
    }
    // Authoritative state deltas are the machine-readable record; the CLI renders the
    // human-facing stateChanged / dialogue / narration beats instead, so deltas are silent.
    case "entityMoved":
    case "entitySpawned":
    case "entityDespawned":
    case "tierChanged":
    case "hpChanged":
    case "conditionChanged":
    case "itemTransferred":
    case "coinsChanged":
    case "equipmentChanged":
    case "relationshipChanged":
    case "questStateChanged":
    case "objectiveChanged":
    case "clockAdvanced":
    case "flagSet":
    case "modulePatched":
    case "npcMemoryRecorded":
    case "npcMemoryCleared":
    case "npcFactLearned":
    case "partyMembershipChanged":
    case "partyLeaderChanged":
    case "partyLeaveDenied":
    case "npcEnriched":
    case "combatStarted":
    case "combatTurnAdvanced":
    case "combatEnded":
    case "combatJoined":
    case "worldExpanded":
    case "exitLinked":
    case "exitStateChanged":
    case "energyChanged":
    case "exhaustionChanged":
    case "factionStandingChanged":
      break;
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
    }
  }
}

async function promptRoll(ctx: CliCtx, req: RollRequest): Promise<{ proceed: boolean }> {
  process.stdout.write("\n" + cyan(`[press Enter to roll: ${req.label}]`));
  const typed = (await ctx.reader.next())?.trim() ?? "";
  if (typed) console.log(dim("(taken as your go-ahead to roll)"));
  return { proceed: true };
}

// --- slash commands (client-side, no model calls) --------------------------

type SlashHandler = (ctx: CliCtx, args: string) => boolean | Promise<boolean>;

const COMMANDS: Record<string, SlashHandler> = {
  "/help": () => {
    console.log(
      [
        dim("Commands:"),
        "  /look   — describe where you are",
        "  /who    — who is here",
        "  /state  — quests, time, location",
        "  /map    — the discovered map + roads",
        "  /sheet  — your character sheet",
        "  /save   — checkpoint the game",
        "  /restart— wipe this campaign + logs, start over",
        "  /quit   — leave (also Ctrl-D)",
        dim('Otherwise, just type what you do. Address a companion by name, e.g. "Lyra, what\'s the plan?"'),
      ].join("\n"),
    );
    return true;
  },
  "/look": (ctx) => {
    const view = new WorldView(ctx.playset.world, ctx.playset.campaign, ctx.engine.getState());
    const loc = view.location();
    console.log(`\n${bold(loc?.name ?? view.partyLocationId())}\n${loc?.description ?? ""}`);
    const exits = view.exitsFrom().map((e) => e.name).join(", ");
    console.log(dim(`Exits: ${exits || "none"}`));
    // Gazetteer breadcrumbs — same omit-when-empty line the narrator brief renders, one formatter
    // (entries the party has actually reached — realized AND arrived at — render ", known").
    const nearby = nearbyLineOf(ctx.playset.world, knownGazetteerIdsOf(ctx.engine.getState()));
    if (nearby) console.log(dim(nearby));
    // Model-sourced presence (same source /who uses) so a look at the room also names who is in
    // it — omit-when-empty, matching the narrator brief's Present: line.
    const present = ctx.engine.presentEntities();
    if (present.length > 0) {
      // r11 P4 — a settlement spawns up to four ambient crowd members off ONE template, so this
      // line read "Anchorfall Local, Anchorfall Local, Anchorfall Local, Anchorfall Local" and the
      // two people who matter were lost in it. Collapse repeats to a count. Display only: the
      // entities are genuinely distinct, and the narrator brief's own `Present:` line — the tested
      // complete-cast contract the cast guard reads — is untouched.
      const counts = new Map<string, number>();
      for (const e of present) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
      const rendered = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
      console.log(dim(`Present: ${rendered.join(", ")}`));
    }
    return true;
  },
  "/who": (ctx) => {
    // Model-sourced presence (matches what the narrator sees): includes statless authored NPCs
    // and spawned foes the legacy GameState.actors projection omits.
    const here = ctx.engine.presentEntities();
    // Who leads the party (Phase 2 slice): null means the PC leads by default — no marker,
    // since /who lists everyone BUT you. An appointed NPC leader gets the crown.
    const leaderId = partyLeaderOf(ctx.engine.getState().modules ?? {});
    console.log(dim("Here with you:"));
    if (here.length === 0) {
      console.log(dim("  (no one else here)"));
      return true;
    }
    for (const e of here) {
      const roles: string[] = [];
      if (e.partyMember) roles.push("companion");
      if (e.id === leaderId) roles.push("leader");
      if (roles.length === 0 && e.kind === "monster") roles.push("hostile");
      const tag = roles.length > 0 ? ` (${roles.join(", ")})` : "";
      const doing = e.activity ? ` — ${e.activity}` : "";
      const habit = e.knownHabit ? dim(` (${e.knownHabit})`) : "";
      console.log(`  • ${e.name}${dim(tag)}${doing}${habit}`);
    }
    return true;
  },
  "/state": (ctx) => {
    const s = ctx.engine.getState();
    const view = new WorldView(ctx.playset.world, ctx.playset.campaign, s);
    const loc = ctx.playset.world.locations.find((l) => l.id === s.partyLocationId)?.name ?? s.partyLocationId;
    // r11 P4: the terminal used to print the raw minute counter ("+501 min") where
    // the narrator's own brief read "morning · day 1". A minute delta is not
    // a time of day, and the clock is the one piece of state every rest/travel/deadline decision
    // turns on. `timeLineOf` is the brief's own builder, so all three surfaces now agree by
    // construction.
    console.log(`\n${dim("Location:")} ${loc}    ${dim(timeLineOf(s.clock))}`);
    const player = s.party[0] ?? "pc.you";
    const actor = s.actors[player];
    console.log(dim(`Energy: ${energyReadout(actor)}`));
    if ((actor?.exhaustion ?? 0) > 0) {
      console.log(dim(`Exertion: ${exhaustionLabel(actor?.exhaustion ?? 0)} (${actor?.exhaustion ?? 0}/6)`));
    }
    const combat = s.modules?.combat as { active?: boolean; round?: number; turnIndex?: number; order?: string[] } | undefined;
    if (combat?.active && combat.order?.length) {
      console.log(dim(`In combat — round ${combat.round ?? 1}, turn ${(combat.turnIndex ?? 0) + 1}/${combat.order.length}:`));
      for (const id of combat.order) {
        const band = view.hpBand(id);
        console.log(`  • ${view.name(id)}${band ? dim(` (${band})`) : ""}`);
      }
    }
    const party = s.companions.filter((id) => s.actors[id]);
    if (party.length) {
      console.log(dim("Party:"));
      for (const id of party) {
        const band = view.hpBand(id);
        console.log(`  • ${view.name(id)}${band ? dim(` (${band})`) : ""}`);
      }
    }
    const active = ctx.playset.campaign.quests.filter((q) => s.quests[q.id] === "active");
    if (active.length) {
      console.log(dim("Active quests:"));
      for (const q of active) console.log(`  • ${q.name}`);
    }
    // Standing deals (§2.2): agreements struck and not yet closed. Omit-when-empty, like every
    // other section here — a campaign with no bargains prints exactly what it printed before.
    const deals = openDeals(readDealsSlice(s.modules ?? {}));
    if (deals.length) {
      console.log(dim("Standing deals:"));
      for (const d of deals) console.log(`  • ${renderDeal(d, player)}`);
    }
    return true;
  },
  "/map": (ctx) => {
    // Discrete tile grid of the current region from `gridmap.layoutRegion`. North is up. Cells:
    // `@` party, `#` town,
    // `▣` a room with a drillable interior, `.` explored, `·` glimpsed-but-unexplored. Interior
    // sub-grids render in place when the party is standing in one. Cross-region gateways listed below.
    const world = ctx.playset.world;
    const s = ctx.engine.getState();
    const partyId = s.partyLocationId;
    if (!partyId) {
      console.log(dim("No map yet."));
      return true;
    }
    const revealed = revealedLocationIds(world, s);
    const explored = exploredLocationIds(world, s);
    const byId = new Map(world.locations.map((l) => [l.id, l] as const));
    const here = byId.get(partyId);
    const regionId = here ? effectiveRegionOf(here) : UNREGIONED_ID;
    const full = layoutRegion(world, regionId, ctx.playset.campaign.startingState.locationId);
    const cellOf = new Map(full.map((c) => [c.id, c] as const));
    // If the party is inside an interior, show THAT sub-grid; otherwise the region surface.
    const interiorFocus = cellOf.get(partyId)?.interiorOf ?? null;
    const cells = full.filter((c) => revealed.has(c.id) && (c.interiorOf ?? null) === interiorFocus);
    if (cells.length === 0) {
      console.log(dim("No map yet."));
      return true;
    }
    const townIds = new Set(townNodes(ctx.playset, s).map((t) => t.id));
    // A `▣` drill hint is honest only when the interior holds at least one revealed
    // child — else a glimpsed parent advertises a sub-grid the player can't see yet.
    const revealedInteriorParents = new Set<string>();
    for (const c of full) if (c.interiorOf && revealed.has(c.id)) revealedInteriorParents.add(c.interiorOf);
    const minC = Math.min(...cells.map((c) => c.col));
    const minR = Math.min(...cells.map((c) => c.row));
    const maxC = Math.max(...cells.map((c) => c.col));
    const maxR = Math.max(...cells.map((c) => c.row));
    const grid: string[][] = Array.from({ length: maxR - minR + 1 }, () =>
      new Array<string>(maxC - minC + 1).fill(" "),
    );
    for (const c of cells) {
      const ch =
        c.id === partyId
          ? "@"
          : townIds.has(c.id)
            ? "#"
            : c.hasInterior && revealedInteriorParents.has(c.id)
              ? "▣"
              : explored.has(c.id)
                ? "."
                : "·";
      grid[c.row - minR]![c.col - minC] = ch;
    }
    const crumb = interiorFocus
      ? `${regionMeta(regionId).name} › ${here?.name ?? interiorFocus}`
      : regionId === UNREGIONED_ID
        ? "Map"
        : regionMeta(regionId).name;
    console.log("");
    console.log(dim(`— ${crumb} —`));
    for (const row of grid) console.log(dim(row.join(" ")));
    console.log(dim("@ you   # town   ▣ interior   . room   · unexplored"));
    if (interiorFocus) {
      console.log(dim("(take an up/out exit to return to the surface)"));
    } else {
      // Fog: BOTH endpoints revealed — a gateway to a still-hidden room would leak its region name.
      const gates = crossRegionGateways(world).filter(
        (g) => g.fromRegion === regionId && revealed.has(g.fromId) && revealed.has(g.toId),
      );
      if (gates.length > 0) {
        const parts = gates.map(
          (g) => `${g.direction} → ${regionMeta(g.toRegion).name} (${byId.get(g.toId)?.name ?? g.toId})`,
        );
        console.log(dim(`Gateways: ${parts.join(", ")}`));
      }
      // Rumored places anchored to THIS region — the grid-era text equivalent of the old `?` markers
      // (positioned rumors), with a coarse bearing off the region centroid. Not-yet-reached entries.
      const gazRegion = new Map((world.gazetteer ?? []).map((g) => [g.id, g.region] as const));
      const rumors = rumoredNodes(ctx.playset, s).filter((r) => {
        const gr = gazRegion.get(r.id);
        return regionId === UNREGIONED_ID ? gr === undefined : gr === regionId;
      });
      if (rumors.length > 0) {
        const centroid = regionCentroid(world, regionId === UNREGIONED_ID ? undefined : regionId);
        const dirOf = (n: { x: number; y: number }): string => {
          if (!centroid) return "somewhere";
          const dx = n.x - centroid.x;
          const dy = n.y - centroid.y;
          return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "east" : "west") : dy < 0 ? "north" : "south";
        };
        console.log(dim(`Rumored: ${rumors.map((r) => `${r.name} (${dirOf(r)})`).join(", ")}`));
      }
    }
    return true;
  },
  "/sheet": (ctx) => {
    const s = ctx.engine.getState();
    const player = s.party[0] ?? "pc.you";
    const pc = ctx.playset.campaign.characters.find((c) => c.id === player);
    const actor = s.actors[player];
    if (!pc) return true;
    const ab = pc.stats.abilities;
    const mods = (Object.keys(ab) as (keyof typeof ab)[])
      .map((k) => `${k.toUpperCase()} ${ab[k]} (${abilityModifier(ab[k]) >= 0 ? "+" : ""}${abilityModifier(ab[k])})`)
      .join("  ");
    // Names resolve World.items first, then the bundled masterlist (one lookup order everywhere).
    const nameOf = (id: string): string => resolveItem(ctx.playset.world, id)?.name ?? itemDisplayNameOf(id);
    const equipped = actor?.equipped ?? {};
    // AC is the DERIVED number combat actually resolves against (armor base + capped dex +
    // shield) — the sheet must agree with the tracker, not restate the authored baseline.
    const ac = derivedAc(pc.stats, equipped, (id) => resolveItem(ctx.playset.world, id));
    // Overlay earned progression: effective level, grown maxHp, XP toward the next level.
    const prog = progressionOf(s.modules, player, pc.stats.level);
    const level = Math.max(pc.level, prog.level);
    const maxHp = pc.stats.maxHp + progressionBonusHp(prog, pc.stats.level);
    console.log(`\n${bold(pc.name)} — ${pc.ancestry} ${pc.class} ${level}`);
    console.log(`HP ${actor?.currentHp ?? maxHp}/${maxHp}    AC ${ac}`);
    const toNext = xpToNextFrom(prog);
    console.log(dim(`XP ${prog.xp}${toNext > 0 ? `  (${toNext} to next level)` : "  (max level)"}`));
    // A study credit is usable only by a caster (the study surface builds on an existing known
    // working); a martial character is never told to "learn <spell>" with nothing to learn from.
    const isCaster = pc.stats.spells.length > 0 || prog.learned.length > 0;
    if (prog.credits > 0 && isCaster) {
      console.log(dim(`You may learn ${prog.credits} new working${prog.credits === 1 ? "" : "s"} — say "learn <spell>".`));
    }
    console.log(dim(`Energy: ${energyReadout(actor)}`));
    if ((actor?.exhaustion ?? 0) > 0) {
      console.log(dim(`Exertion: ${exhaustionLabel(actor?.exhaustion ?? 0)} (${actor?.exhaustion ?? 0}/6)`));
    }
    console.log(dim(mods));
    console.log(dim(`Coins: ${formatCoins(actor?.coins ?? 0)}`));
    const slots = (["weapon", "armor", "shield"] as const)
      .map((slot) => `${slot} ${equipped[slot] ? nameOf(equipped[slot]!) : "—"}`)
      .join("   ");
    console.log(dim(`Equipped: ${slots}`));
    // Stacked render: repeated ids ARE the stack ("Potion of Healing ×2").
    const counts = new Map<string, number>();
    for (const id of actor?.inventory ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    const inv = [...counts.entries()].map(([id, n]) => (n > 1 ? `${nameOf(id)} ×${n}` : nameOf(id)));
    console.log(dim(`Inventory: ${inv.join(", ") || "(empty)"}`));
    return true;
  },
  "/save": (ctx) => {
    void ctx.store.save(ctx.saveKey, ctx.engine.getState());
    console.log(dim("✓ saved."));
    return true;
  },
  "/restart": async (ctx) => {
    process.stdout.write(yellow("This wipes this campaign's progress and logs. Type 'yes' to confirm: "));
    const ans = (await ctx.reader.next())?.trim().toLowerCase();
    if (ans === "yes") {
      ctx.streamedThisTurn = false;
      await ctx.engine.restart();
    } else {
      console.log(dim("Restart cancelled."));
    }
    return true;
  },
  "/quit": () => false,
};

async function repl(ctx: CliCtx): Promise<void> {
  for (;;) {
    process.stdout.write("\n> ");
    const raw = await ctx.reader.next();
    if (raw === null) break; // EOF
    const line = raw.trim();
    if (line === "") {
      console.log(dim("(type an action, or /help)"));
      continue;
    }
    if (line.startsWith("/")) {
      const cmd = line.split(/\s+/)[0]?.toLowerCase() ?? "";
      const handler = COMMANDS[cmd];
      if (!handler) {
        console.log(dim(`unknown command ${cmd} — try /help`));
        continue;
      }
      if (!(await handler(ctx, line.slice(cmd.length).trim()))) break;
      continue;
    }
    // Scope the per-turn display flags so a prior error can't bleed into this turn.
    ctx.streamedThisTurn = false;
    ctx.thinking = false;
    try {
      await ctx.engine.submitPlayerInput(line);
    } catch (err) {
      clearThinking(ctx);
      ctx.streamedThisTurn = false;
      console.log(red(`[error] ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  // World to play: a path arg, then $SEED_WORLD_DIR, else the bundled Wakeward Isles campaign.
  const worldArg = args.worldPath ?? process.env.SEED_WORLD_DIR;
  const worldDir = worldArg
    ? isAbsolute(worldArg)
      ? worldArg
      : resolve(process.cwd(), worldArg)
    : fileURLToPath(new URL("../../worlds/wakeward-isles", import.meta.url));

  const loaded = await loadPlaySetFromDir(worldDir);
  const characterArg = args.character ?? process.env.SEED_CHARACTER;
  const playset = characterArg?.trim()
    ? bindCharacter(loaded, await resolveCharacter(characterArg))
    : loaded;
  const saveKey = makeSaveKey(
    playset.campaign.id,
    playset.campaign.startingState.party[0] ?? playset.campaign.characters[0]?.id,
  );
  const store = await createStore(config);
  store.savePlayset(playset.campaign.id, playset); // lets the Observatory resolve names
  // No offline fallback: a dead endpoint is an actionable error, never silently-templated play.
  let gateway: LlmGateway;
  try {
    gateway = await createProbedGateway(config);
  } catch (err) {
    console.error(red(`\n✖ ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }
  // Wrap the gateway so every model call is logged to the DB (best-effort; never blocks a turn).
  const logged = new LoggingGateway(gateway, store, playset.campaign.id, (role) => config.gateway[role].model);

  const interactive = Boolean(process.stdin.isTTY);
  const reader = new LineReader();
  let engineRef!: GameEngine;
  const ctx: CliCtx = {
    get engine() {
      return engineRef;
    },
    store,
    saveKey,
    playset,
    reader,
    streamedThisTurn: false,
    thinking: false,
  };

  engineRef = new GameEngine({
    playset,
    store,
    gateway: logged,
    systemPrefix: config.systemPrefix,
    continuityJudge: config.continuityJudge,
    ...(config.judgeModel !== undefined ? { judgeModel: config.judgeModel } : {}),
    judgeStreamClean: config.judgeStreamClean,
    lore: config.lore,
    dataDir: config.dataDir,
    embeddingModel: config.gateway.embedding.model,
    summary: config.summary,
    classifier: makeLlmClassifier(logged, (reason) => {
      console.warn(dim(`[classifier] model path failed twice — freeform fallback (${reason})`));
      // Carry the fallback reason into the turn trace (Workstream D / G leftover); best-effort.
      const scratch = turnContext.getStore();
      if (scratch) scratch.fallback = reason;
    }),
    // Per-turn trace (Workstream D): persist ALWAYS (Observatory "Turns" view); print a dim line in
    // play only when SEED_DEV_TRACE is on. Off ⇒ transcript is byte-identical to today.
    onTurnTrace: (trace) => {
      (store as Partial<TraceSink>).recordTurnTrace?.(trace);
      if (config.devTrace) printTrace(ctx, trace);
    },
    client: {
      // Click-to-roll only when interactive; piped input auto-rolls.
      promptRoll: interactive ? (req) => promptRoll(ctx, req) : undefined,
      onNarrationToken: (delta) => {
        clearThinking(ctx);
        ctx.streamedThisTurn = true;
        process.stdout.write(delta);
      },
      onReasoningToken: () => {
        if (!ctx.thinking) {
          process.stdout.write(dim("  ⋯ the GM is thinking…"));
          ctx.thinking = true;
        }
      },
    },
  });
  engineRef.subscribe((e) => render(ctx, e));

  // The minor-safety guard reads the live present-character ages on each screen (declared-minor
  // protection). Wire it now that the engine exists. `gateway` is the GuardedGateway itself (the
  // LoggingGateway wraps it), so set the provider on it directly.
  if (!(gateway instanceof GuardedGateway)) {
    throw new Error("minor-safety gateway composition failed: GuardedGateway is required");
  }
  gateway.setContextProvider(() => engineRef.currentSafetyContext());

  // Banner
  console.log(bold("\n✶ Seed ✶"));
  console.log(dim(`narrator: ${config.gateway.narrator.model} @ ${config.gateway.narrator.baseUrl}\n`));

  // Double-Ctrl-C to quit (terminal mode only).
  let lastSigint = 0;
  reader.rl.on("SIGINT", () => {
    const now = Date.now();
    if (now - lastSigint < 2000) {
      engineRef.stop();
      reader.close();
      process.exit(0);
    }
    lastSigint = now;
    process.stdout.write("\n" + dim("(press Ctrl-C again to quit, or type /quit)\n"));
  });

  await engineRef.start();
  console.log(dim("\nType what you do. /help for commands.\n"));
  await repl(ctx);

  engineRef.stop(); // cancel the autonomy heartbeat so no proposal fires after we say goodbye
  reader.close();
  if ("close" in store && typeof (store as { close?: unknown }).close === "function") {
    (store as { close(): void }).close();
  }
  console.log(dim("\nUntil next time.\n"));
}

main().catch((err: unknown) => {
  console.error(`\x1b[31mSeed failed:\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
