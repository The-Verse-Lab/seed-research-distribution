/**
 * Quest deadlines — the value shape for "this quest turns at a real hour on the real clock".
 *
 * A quest may author `deadlineMinutes` (relative, from acceptance). The engine arms an ABSOLUTE
 * `dueAtClock` into this slice on the active transition (post-command hook, all accept channels),
 * and the quest-deadlines tick module fails the quest once the campaign clock passes it. THE
 * RECORD renders the armed due phase/day on the quest's row, so NPC dialogue can stop improvising
 * due dates — a stated deadline that contradicts the row is a `ledgerContradiction`.
 *
 * Why it exists (2026-07-25 playtest): the bond deadline — the game's best pressure device — was
 * pure LLM improvisation ("noon tomorrow", restated on two consecutive days) with no machinery
 * behind it; postponement was free and the clock had no teeth.
 *
 * @author Runkai Zhang
 */

/** The `model.modules` key: questId → absolute campaign minute the quest fails at. */
export const QUEST_DEADLINES_MODULE = "questDeadlines";

export type QuestDeadlinesSlice = Record<string, number>;

/** Defaulting reader — absent slice reads as no armed deadlines. */
export function readQuestDeadlinesSlice(modules: Record<string, unknown>): QuestDeadlinesSlice {
  return (modules[QUEST_DEADLINES_MODULE] as QuestDeadlinesSlice | undefined) ?? {};
}
