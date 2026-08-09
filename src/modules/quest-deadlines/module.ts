/**
 * Quest-deadlines module — the clock's teeth (2026-07-25 fix wave).
 *
 * Watches every quest that authors `deadlineMinutes`: once the campaign clock passes the absolute
 * `dueAtClock` the engine armed on acceptance (`armQuestDeadlines`, `modules.questDeadlines`),
 * the quest fails through the one writer (`setQuestState failed` at commit) and a narrated beat
 * says so — the authored `deadlineFailText` when present, else a generic window-closed line.
 *
 * Why: the r3 playtest's bond deadline — the game's best pressure device — was pure LLM
 * improvisation ("noon tomorrow", restated on two consecutive days). A clock that never turns
 * teaches the player that postponement is free.
 *
 * UpkeepModule's shape: react phase, player triggers only (heartbeats are untaxed and must not
 * fail quests mid-conversation-lull), beats APPENDED to `ctx.data.eventBeats` (never replaced),
 * registered after EventsModule so its `onReact` overwrite has already happened.
 *
 * @author Runkai Zhang
 */
import type { Campaign } from "../../content/schema.ts";
import type { TickContext, TickModule } from "../../engine/tick.ts";
import { dayPhaseOf } from "../../rules/routine.ts";
import { readQuestDeadlinesSlice } from "../../rules/quest-deadlines.ts";

const MINUTES_PER_DAY = 1440;

/** Module-slice key for the one-shot approach warnings (questId → true once warned). */
const WARNINGS_MODULE = "questDeadlineWarnings";

/** Module-slice key stamping WHEN an active quest's objectives all went done (questId → clock). */
const ALL_DONE_MODULE = "questAllDoneAt";

/**
 * In-world minutes an all-objectives-done quest may stay ACTIVE before the safety net completes it
 * (r7 P1). The grace exists so an AUTHORED settlement scene — the hand-in event with its clerk,
 * counter, and reveal — gets first claim on the moment; the net only closes what authored wiring
 * left stranded (run 7: the bond was consumed by an earlier event, the hand-in's conditions could
 * never all be true again, and a finished quest paid nothing forever).
 */
const COMPLETION_GRACE_MINUTES = 60;

export class QuestDeadlinesModule implements TickModule {
  readonly id = "quest-deadlines";
  readonly after = ["events"];
  readonly phases: TickModule["phases"];

  constructor(private readonly campaign: Campaign) {
    this.phases = { react: (ctx) => this.onReact(ctx) };
  }

  private onReact(ctx: TickContext): void {
    if (ctx.trigger.kind !== "player") return;
    const model = ctx.model;
    this.completeStranded(ctx);
    const armed = readQuestDeadlinesSlice(model.modules);
    const warned = (model.modules[WARNINGS_MODULE] as Record<string, boolean> | undefined) ?? {};
    // The clock advances at COMMIT (after react), so read the PROSPECTIVE end-of-turn clock —
    // otherwise a turn whose own time cost crosses the deadline (an 8-hour march, exactly the
    // large jumps known-roads travel introduces) would not fire until the NEXT unrelated turn,
    // detaching the failure beat from the action that caused it (review finding #1).
    const advance =
      ctx.data.advancesClock !== false && typeof ctx.data.clockMinutes === "number" ? ctx.data.clockMinutes : 0;
    const clockAtCommit = model.clock + Math.max(0, advance);
    for (const quest of this.campaign.quests) {
      if (!quest.deadlineMinutes) continue;
      const dueAt = armed[quest.id];
      if (dueAt === undefined) continue;
      if (model.quests.get(quest.id) !== "active") continue;
      // A same-tick settlement wins at the buzzer: if this turn already queued a state change for
      // this quest (a claim lodged AS the window closes), the deadline defers to it.
      if (ctx.queue.some((c) => c.type === "setQuestState" && c.questId === quest.id)) continue;
      if (clockAtCommit <= dueAt) {
        // APPROACH WARNING (r6 P3): the best pressure device in the game used to resolve with no
        // telegraph at all — ACTIVE through two turns of the final morning, then a rumour-styled
        // line. Once, at the last stretch, say the clock is running out on the LEDGER channel too.
        const warnWindow = Math.min(MINUTES_PER_DAY / 2, Math.max(60, Math.floor(quest.deadlineMinutes / 4)));
        if (!warned[quest.id] && dueAt - clockAtCommit <= warnWindow) {
          ctx.enqueue({ type: "modulePatch", module: WARNINGS_MODULE, patch: { [quest.id]: true } });
          const dueDay = Math.floor(dueAt / MINUTES_PER_DAY) + 1;
          ctx.emit({
            kind: "stateChanged",
            summary: `"${quest.name}" — the window is closing: due by ${dayPhaseOf(dueAt)}, day ${dueDay}.`,
          });
          const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
          beats.push(
            `Time is running out on "${quest.name}" — it must be settled by ${dayPhaseOf(dueAt)} on day ${dueDay}. ` +
              `Let the world remark on the closing window (a board notice, a word from someone who knows).`,
          );
          ctx.data.eventBeats = beats;
        }
        continue;
      }
      // Past due and still active: the window closes NOW, through the one writer at commit.
      ctx.enqueue({ type: "setQuestState", questId: quest.id, state: "failed" });
      // A quest failure is LEDGER news, not ambient rumour (r6 P3): the prose beat stays, but the
      // journal flip also lands as a system line the player cannot read past.
      ctx.emit({ kind: "stateChanged", summary: `Quest failed: ${quest.name}.` });
      const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
      beats.push(
        quest.deadlineFailText?.trim() ||
          `The window on "${quest.name}" has closed — the chance is gone, and the world has moved on.`,
      );
      ctx.data.eventBeats = beats;
      ctx.data.persist = true;
    }
  }

  /**
   * The completion SAFETY NET (r7 P1): an ACTIVE quest whose objectives are ALL done completes —
   * and pays, via the engine's reward hook on the state change — once it has sat finished for
   * {@link COMPLETION_GRACE_MINUTES}. Quest completion is a state fact, not a favor an authored
   * event may or may not fire; the grace only yields the settlement SCENE to authored wiring.
   */
  private completeStranded(ctx: TickContext): void {
    const model = ctx.model;
    const done = (model.modules.objectives as Record<string, Record<string, boolean>> | undefined) ?? {};
    const stamps = (model.modules[ALL_DONE_MODULE] as Record<string, number> | undefined) ?? {};
    const advance =
      ctx.data.advancesClock !== false && typeof ctx.data.clockMinutes === "number" ? ctx.data.clockMinutes : 0;
    const clockAtCommit = model.clock + Math.max(0, advance);
    for (const quest of this.campaign.quests) {
      if (quest.objectives.length === 0) continue;
      if (model.quests.get(quest.id) !== "active") continue;
      const ticked = done[quest.id] ?? {};
      if (!quest.objectives.every((o) => ticked[o.id] ?? o.done)) continue;
      // An authored settlement queued THIS tick owns the moment (the hand-in event's complete).
      if (ctx.queue.some((c) => c.type === "setQuestState" && c.questId === quest.id)) continue;
      const since = stamps[quest.id];
      if (since === undefined) {
        ctx.enqueue({ type: "modulePatch", module: ALL_DONE_MODULE, patch: { [quest.id]: model.clock } });
        continue;
      }
      if (clockAtCommit - since < COMPLETION_GRACE_MINUTES) continue;
      ctx.enqueue({ type: "setQuestState", questId: quest.id, state: "complete" });
      ctx.emit({ kind: "stateChanged", summary: `Quest complete: ${quest.name}.` });
      const beats = (ctx.data.eventBeats as string[] | undefined) ?? [];
      beats.push(
        `"${quest.name}" is settled — everything it asked has been done, and the matter closes for good ` +
          `(dues paid, word sent). Let the closure land in a sentence; do not reopen it.`,
      );
      ctx.data.eventBeats = beats;
      ctx.data.persist = true;
    }
  }
}
