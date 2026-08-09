/**
 * Automated playtest harness — the standing scenario set (Concordia transfer #5).
 *
 * Six Wakeward Isles runs, one per authored task family. Turn caps are modest — live tokens are
 * real money; raise `--turns` only for an explicitly authorized deep run. Seeds are fixed so the
 * mechanics reproduce; model prose can still vary.
 *
 * @author Runkai Zhang
 */
import { fileURLToPath } from "node:url";
import type { Scenario } from "./types.ts";

const WAKEWARD = fileURLToPath(new URL("../../worlds/wakeward-isles", import.meta.url));

export const SCENARIOS: Scenario[] = [
  {
    id: "wakeward-cold-passage",
    worldDir: WAKEWARD,
    characterId: "pc.you",
    goal: "Accept Cold Passage, protect the tonic from direct sun, and deliver it to Reedbank Clinic on time.",
    persona: "A careful new circuit runner who checks custody and storage requirements before moving cargo.",
    maxTurns: 16,
    seed: 101,
  },
  {
    id: "wakeward-second-bell",
    worldDir: WAKEWARD,
    characterId: "pc.you",
    goal: "Accept Second Bell, verify the current ferry order, and reach the Cinderhook repair berth through the service gate.",
    persona: "A punctual runner who confirms revisions and asks Mara for bounded help when access requires her token.",
    maxTurns: 16,
    seed: 202,
  },
  {
    id: "wakeward-clear-glass",
    worldDir: WAKEWARD,
    characterId: "pc.you",
    goal: "Accept Clear Glass, collect the current-pattern lens, and complete the Far Beacon calibration.",
    persona: "A methodical runner who distinguishes superseded instructions from the current calibration card.",
    maxTurns: 18,
    seed: 303,
  },
  {
    id: "wakeward-true-bearing",
    worldDir: WAKEWARD,
    characterId: "pc.you",
    goal: "Accept True Bearing, obtain the signed pressure trace, and post the safer cove route at Bellharbor Quay.",
    persona: "A weather-conscious runner who treats local expertise as authoritative and names route choices clearly.",
    maxTurns: 16,
    seed: 404,
  },
  {
    id: "wakeward-shared-stores",
    worldDir: WAKEWARD,
    characterId: "pc.you",
    goal: "Accept Shared Stores, collect the measured pump seal, and restore Highwake's rain-tank reserve.",
    persona: "A commons-minded runner who explains allocations and keeps a precise item handoff record.",
    maxTurns: 18,
    seed: 505,
  },
  {
    id: "wakeward-missing-manifest",
    worldDir: WAKEWARD,
    characterId: "pc.you",
    goal: "Accept Missing Manifest, compare all three records, and publish the evidence-backed correction without inventing blame.",
    persona: "A patient investigator who shares evidence, revises hypotheses, and distinguishes a good-faith mistake from missing cargo.",
    maxTurns: 20,
    seed: 606,
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
