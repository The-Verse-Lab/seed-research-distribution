/**
 * Playtest r9 F-2 — a location description's props must stop being asserted once taken.
 *
 * The authored wreck text stages the bond-writ "beside the strongbox" forever; after the
 * `giveItem` event hands it to the player, the brief carried FOUR lines saying it still lay
 * there and one inventory line saying it didn't — the narrator (and Oda's decide brief) sided
 * with the scene text for three scenes running. `takenPropLines` is the deterministic
 * counterweight: content-derived, state-checked, omit-when-empty.
 *
 * Author: Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { takenPropLines } from "../src/agents/context.ts";
import type { Campaign } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

const events = [
  {
    id: "ev.find",
    when: "onEnterLocation",
    once: "campaign",
    trigger: { allOf: [{ kind: "atLocation", locationId: "loc.wreck" }] },
    effects: [
      { kind: "narrate", text: "…the caravan's bond-writ." },
      { kind: "giveItem", itemId: "item.writ", to: "pc.you" },
    ],
  },
] as unknown as Campaign["events"];

const world = { items: [{ id: "item.writ", name: "The W-47 Guild Bond", kind: "misc" }] } as never;

const stateWith = (inventory: string[]): GameState =>
  ({ actors: { "pc.you": { name: "You", inventory } } }) as unknown as GameState;

describe("takenPropLines (r9 F-2)", () => {
  test("an event-given item now held mints an explicit not-here correction", () => {
    const lines = takenPropLines({ events }, world, stateWith(["item.writ"]), "loc.wreck");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("The W-47 Guild Bond");
    expect(lines[0]).toContain("NO LONGER lying here");
    expect(lines[0]).toContain("the player carries it");
  });

  test("nothing held ⇒ byte-stable empty (the event has not fired yet)", () => {
    expect(takenPropLines({ events }, world, stateWith([]), "loc.wreck")).toHaveLength(0);
  });

  test("another location's events never leak corrections here", () => {
    expect(takenPropLines({ events }, world, stateWith(["item.writ"]), "loc.elsewhere")).toHaveLength(0);
  });

  test("an NPC holder is named, not called the player", () => {
    const s = { actors: { "npc.oda": { name: "Oda the Wayfarer", inventory: ["item.writ"] } } } as unknown as GameState;
    const lines = takenPropLines({ events }, world, s, "loc.wreck");
    expect(lines[0]).toContain("Oda the Wayfarer carries it");
  });
});
