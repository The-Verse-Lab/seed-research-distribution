/**
 * Small phrasing helpers shared by the domain resolvers.
 *
 * These build the player-facing fragments a resolver hands the narrator — a list of things, the
 * spoken name of an ability. They lived as module-locals in `GameEngine`; the split needs them in
 * one place both sides can import without a cycle.
 *
 * @author Runkai Zhang
 */
import type { CheckAbility } from "../turn-plan.ts";

/** "a" · "a and b" · "a, b and c" — plain-English list for narration triggers. */
export function naturalList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Upper-case the first character — sentence-start for a fragment built from data. */
export function capitalize(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** Deterministic plain-English walking time for travel quotes ("about five hours' walk"). */
export function describeWalkDuration(minutes: number): string {
  if (minutes < 45) return "a short walk";
  if (minutes < 90) return "about an hour's walk";
  const hours = Math.round(minutes / 60);
  const words = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  return `about ${words[hours] ?? String(hours)} hours' walk`;
}

/** The spoken name of a check ability — what a beat says instead of the three-letter key. */
export const ABILITY_NAMES: Record<CheckAbility, string> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};
