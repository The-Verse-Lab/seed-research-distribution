/**
 * Automated playtest harness — the PC driver (Concordia transfer #5).
 *
 * The driver is the "player": given the scenario goal/persona and a rolling window of what just
 * happened, it produces the next player line, which the harness feeds to `engine.submitPlayerInput`.
 * Two implementations: an LLM driver (live runs) and a script driver (deterministic smoke + tests).
 * The LLM driver runs on the `utility` role — a player line is short and cheap; the expensive prose
 * stays with the narrator under test.
 *
 * @author Runkai Zhang
 */
import type { LlmGateway } from "../../src/llm/gateway.ts";
import type { GameEvent } from "../../src/events/types.ts";
import type { RecordedTurn, Scenario, StateSnapshot } from "./types.ts";

/** What the driver sees before choosing the next line. */
export interface DriverView {
  turn: number;
  maxTurns: number;
  snapshot: StateSnapshot;
  /** The last few turns, oldest first, already rendered to compact text. */
  recent: string[];
  /**
   * The driver already declared the goal met, and the harness kept it playing for coverage — this
   * is its own `DONE:` reason. A finding is only cleared by a run that reached past its evidence
   * depth, so a goal met on turn 4 of 20 used to end the round having measured nothing.
   */
  goalMetNote?: string;
}

export interface Driver {
  /** The next player line, or null to stop (goal declared met/abandoned). */
  next(view: DriverView): Promise<string | null>;
  /** The driver's `DONE:` note once it has stopped, if any. */
  readonly note?: string;
}

/** Deterministic driver over a fixed list of lines (probe scripts, offline tests). */
export class ScriptDriver implements Driver {
  private at = 0;
  constructor(private readonly lines: string[]) {}
  next(): Promise<string | null> {
    return Promise.resolve(this.at < this.lines.length ? this.lines[this.at++]! : null);
  }
}

/** Render one recorded turn to the compact text block the driver reads. */
export function renderTurnForDriver(t: RecordedTurn): string {
  const lines: string[] = [`> ${t.input}`];
  for (const e of t.events) {
    if ((e as { silent?: boolean }).silent) continue;
    switch (e.kind) {
      case "narration":
        lines.push(e.text);
        break;
      case "dialogue":
        lines.push(`${e.actorId}: "${e.text}"`);
        break;
      case "stateChanged":
        if (!e.quiet) lines.push(`· ${e.summary}`);
        break;
      case "diceRolled":
        lines.push(`· ${e.purpose ?? e.notation}: ${e.total}${e.success === undefined ? "" : e.success ? " (success)" : " (failure)"}`);
        break;
      case "system":
        lines.push(`[system] ${e.message}`);
        break;
      case "questOffered":
        lines.push(`[quest offered] ${e.name}: ${e.description}`);
        break;
      case "npcProposal":
        lines.push(`[proposal] ${e.proposal}`);
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

/** Assemble the driver's view from the recorded turns (last `window` of them). */
export function driverViewOf(
  turns: RecordedTurn[],
  snapshot: StateSnapshot,
  maxTurns: number,
  window = 3,
  charBudget = 6000,
  goalMetNote?: string,
): DriverView {
  const recent: string[] = [];
  let spent = 0;
  for (const t of turns.slice(-window)) {
    const text = renderTurnForDriver(t);
    spent += text.length;
    recent.push(text);
  }
  // Trim oldest-first if over budget — the driver needs the latest scene most.
  while (recent.length > 1 && spent > charBudget) {
    const dropped = recent.shift()!;
    spent -= dropped.length;
  }
  return { turn: turns.length + 1, maxTurns, snapshot, recent, ...(goalMetNote ? { goalMetNote } : {}) };
}

export const DRIVER_DONE_PREFIX = "DONE:";

/** Pure prompt builder — exported for tests. */
export function buildDriverMessages(
  scenario: Scenario,
  view: DriverView,
): Array<{ role: "system" | "user"; content: string }> {
  // Past the goal the driver keeps playing for COVERAGE: the scenario's goal is unchanged (it
  // lives in scenarios.ts and is a measurement file), but a run that stops the moment the goal
  // lands measures only the opening. Keep it in character and let it choose its own next thread.
  const system = [
    "You are playtesting a text RPG. You control the PLAYER CHARACTER — never the GM, never NPCs.",
    `PERSONA: ${scenario.persona}`,
    `GOAL: ${scenario.goal}`,
    "",
    "Each turn, read the recent scene and reply with EXACTLY ONE player input line, in character.",
    "Rules:",
    "- One line only. No quotes around it, no markdown, no explanations, under 25 words.",
    "- Speak/act as the player would type: \"I ask the innkeeper about work\", \"I head north to the mill\".",
    view.goalMetNote
      ? "- Push toward whatever your persona wants NEXT. If a path is blocked twice, try a different approach — do not repeat a failing line."
      : "- Push toward the GOAL. If a path is blocked twice, try a different approach — do not repeat a failing line.",
    "- React to what NPCs actually said; use names the scene established.",
    view.goalMetNote
      ? [
          `- The GOAL IS ALREADY MET ("${view.goalMetNote}"). Do NOT reply ${DRIVER_DONE_PREFIX} — keep playing.`,
          "  Carry on living in this world: follow up on what you just did, spend what you earned, chase",
          "  something that caught your eye, or go somewhere new. Stay in character and keep acting.",
        ].join("\n")
      : `- If the goal is COMPLETE or clearly impossible, reply with the single line "${DRIVER_DONE_PREFIX} <one-sentence reason>".`,
  ].join("\n");
  const status = [
    `Turn ${view.turn} of ${view.maxTurns}.`,
    view.snapshot.locationId ? `Location: ${view.snapshot.locationId}` : "",
    view.snapshot.hp !== null ? `HP: ${view.snapshot.hp}` : "",
    view.snapshot.coins !== null ? `Coins (cp): ${view.snapshot.coins}` : "",
    view.snapshot.combatActive ? "COMBAT IS ACTIVE — fight, talk it down, or flee." : "",
  ]
    .filter(Boolean)
    .join("\n");
  const recent = view.recent.length > 0 ? `RECENT PLAY:\n${view.recent.join("\n---\n")}` : "This is the opening turn.";
  return [
    { role: "system", content: system },
    { role: "user", content: `${recent}\n\n${status}\n\nYour next player line:` },
  ];
}

/** Normalize a raw model completion to one submittable player line. */
export function normalizeDriverLine(raw: string): string {
  let line = raw.trim().split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  // Strip wrapping quotes/backticks the model may add despite instructions.
  line = line.replace(/^["'“”`>\s]+/, "").replace(/["'“”`\s]+$/, "");
  if (line.length > 300) line = line.slice(0, 300);
  return line;
}

export class LlmDriver implements Driver {
  note?: string;
  private stuckFallbacks = 0;
  constructor(
    private readonly gateway: LlmGateway,
    private readonly scenario: Scenario,
  ) {}

  async next(view: DriverView): Promise<string | null> {
    try {
      const res = await this.gateway.complete("utility", {
        messages: buildDriverMessages(this.scenario, view),
        temperature: 0.6,
        maxTokens: 128,
      });
      const line = normalizeDriverLine(res.text);
      if (line.toUpperCase().startsWith(DRIVER_DONE_PREFIX)) {
        this.note = line.slice(DRIVER_DONE_PREFIX.length).trim();
        return null;
      }
      if (line) {
        this.stuckFallbacks = 0;
        return line;
      }
    } catch {
      // fall through to the stuck fallback below
    }
    // Empty/errored completion: look around once or twice, then give up rather than loop.
    this.stuckFallbacks += 1;
    if (this.stuckFallbacks > 2) return null;
    return "I take stock of my surroundings.";
  }
}

/** True when a run's stop came from the driver running dry vs. declaring done. */
export function driverStuck(driver: Driver): boolean {
  return driver instanceof LlmDriver && driver.note === undefined;
}

/** Re-exported for the harness loop's typing convenience. */
export type { GameEvent };
