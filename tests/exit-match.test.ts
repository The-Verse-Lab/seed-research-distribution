/**
 * Fuzzy exit-matcher tests — matchExit grounds a movement destination against the real exits by
 * exact id, then normalized name/direction equality, then a UNIQUE token-overlap. An ambiguous
 * tie (or a prose-only place the map can't back) returns null: the matcher never guesses.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { type ExitCandidate, matchExit, matchExitInProse } from "../src/world/exit-match.ts";

const EXITS: ExitCandidate[] = [
  { id: "loc.square", name: "Emberford Square", direction: "north" },
  { id: "loc.mill", name: "The Old Mill (locked)", direction: "west" },
  { id: "loc.docks", name: "Fishmarket Docks" },
];

describe("matchExit", () => {
  test("exact id membership wins (prior behavior preserved)", () => {
    expect(matchExit("loc.square", "", EXITS)).toBe("loc.square");
  });

  test("normalized name equality grounds a prose name to its id", () => {
    expect(matchExit("Emberford Square", "", EXITS)).toBe("loc.square");
  });

  test("a trailing state tag on the exit name is stripped before matching", () => {
    expect(matchExit("The Old Mill", "", EXITS)).toBe("loc.mill");
  });

  test("a direction word grounds via the authored direction (name-agnostic)", () => {
    expect(matchExit("west", "", EXITS)).toBe("loc.mill");
  });

  test("a raw player line grounds by token overlap when the guess is empty", () => {
    expect(matchExit(null, "let's head to the docks", EXITS)).toBe("loc.docks");
  });

  test("a substring/partial name grounds by unique token overlap", () => {
    expect(matchExit("the square", "", EXITS)).toBe("loc.square");
  });

  test("an ambiguous overlap (a tie) stays honest and returns null", () => {
    const twoMills: ExitCandidate[] = [
      { id: "loc.old-mill", name: "The Old Mill" },
      { id: "loc.new-mill", name: "The New Mill" },
    ];
    // "mill" overlaps both equally → tie → null (never a blind pick).
    expect(matchExit("the mill", "", twoMills)).toBeNull();
  });

  test("a prose-only place the map can't back returns null (honest miss)", () => {
    expect(matchExit("Tanner's Bridge", "I cross Tanner's Bridge", EXITS)).toBeNull();
  });

  test("a generic-only overlap with an unmatched distinctive token stays an honest miss (r4)", () => {
    // The r4 playtest teleport: "the muster hall" shared only "hall" with the Freelance Hall and
    // silently moved the party to the wrong district. Generic place-words never bind alone when
    // the query carries a distinctive token the exit lacks.
    const anchorfall: ExitCandidate[] = [
      { id: "loc.hall", name: "The Freelance Hall" },
      { id: "loc.old-quarter", name: "The Old Quarter" },
    ];
    expect(matchExit("the muster hall", "I go to the muster hall", anchorfall)).toBeNull();
    expect(matchExit(null, "", anchorfall, undefined, "the muster hall")).toBeNull();
    // But naming the real place still binds — a distinctive token matched.
    expect(matchExit("the freelance hall", "", anchorfall)).toBe("loc.hall");
  });

  test("a fully-matched generic query still binds (subset rule: 'the square' is the Square)", () => {
    expect(matchExit("the square", "", EXITS)).toBe("loc.square");
    const dockses: ExitCandidate[] = [{ id: "loc.docks", name: "The Docks" }];
    expect(matchExit("the docks", "", dockses)).toBe("loc.docks");
  });

  test("never resolves to the current room", () => {
    expect(matchExit("loc.square", "", EXITS, "loc.square")).toBeNull();
    // and the current room is excluded from token/name matching too
    expect(matchExit("Emberford Square", "", EXITS, "loc.square")).toBeNull();
  });

  test("no exits ⇒ null", () => {
    expect(matchExit("anywhere", "go anywhere", [])).toBeNull();
  });
});

describe("matchExitInProse (a spoken plan's destination — r5 P3)", () => {
  const anchorfall: ExitCandidate[] = [
    { id: "loc.dockmire", name: "The Dockmire" },
    { id: "loc.old-quarter", name: "The Old Quarter" },
    { id: "loc.anchorfall", name: "Anchorfall" },
  ];

  test("a plan naming a place the map does not carry binds nothing", () => {
    // The r5 AGREE bug, verbatim: this plan names the salvage office, and the party was walked to a
    // flooded work-dock instead.
    expect(
      matchExitInProse("the bond's held by the River Guild salvage office — we'll pull the paper", anchorfall),
    ).toBeNull();
  });

  test("a shared generic place-word never binds a destination on its own", () => {
    expect(matchExitInProse("we'll work the dock district for a name", anchorfall)).toBeNull();
  });

  test("naming the place binds it", () => {
    expect(matchExitInProse("we should try the Old Quarter before dark", anchorfall)).toBe("loc.old-quarter");
    expect(matchExitInProse("meet me down in the Dockmire", anchorfall)).toBe("loc.dockmire");
  });

  test("a terse whole-query match still binds (subset rule)", () => {
    expect(matchExitInProse("to the docks", [{ id: "loc.docks", name: "The Docks" }])).toBe("loc.docks");
  });

  test("an ambiguous plan (two exits, one token each) stays honest", () => {
    expect(matchExitInProse("we could try Anchorfall or the Dockmire, either one", anchorfall)).toBeNull();
  });

  test("never resolves to the room the speaker is standing in", () => {
    expect(matchExitInProse("we stay in the Dockmire tonight", anchorfall, "loc.dockmire")).toBeNull();
  });
});
