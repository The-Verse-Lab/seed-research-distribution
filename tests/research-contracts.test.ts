import { describe, expect, test } from "bun:test";
import {
  ResearchDecisionPacketV1Schema,
  parseResearchDecision,
  type ResearchDecisionPacketV1,
} from "../src/research/contracts.ts";
import {
  assertPromptIsolation,
  renderResearchPrompt,
  researchPacketId,
} from "../src/research/prompt.ts";

function packet(): ResearchDecisionPacketV1 {
  const core = {
    schemaVersion: 1 as const,
    actor: { id: "actor.companion", name: "Mara", persona: "A careful routekeeper." },
    controlledGoals: ["Help without taking over the runner's decision."],
    visibleState: {
      location: "Relay House",
      clock: "09:10",
      playerInventory: ["sealed tonic"],
      companionInventory: ["insulated wrap"],
      exits: [{ destination: "Reedbank Clinic", state: "open" as const }],
      task: { title: "Cold Passage", objective: "Deliver protected tonic", status: "active" as const },
    },
    companionKnownFacts: [{ id: "fact.1", text: "Direct sun spoils the tonic." }],
    playerKnownFacts: [],
    candidates: [{ candidateId: "candidate-1", modality: "act" as const, description: "Give the insulated wrap to the runner." }],
  };
  return ResearchDecisionPacketV1Schema.parse({ ...core, packetId: researchPacketId(core) });
}

describe("research public contracts", () => {
  test("accepts exactly abstention or one grounded candidate", () => {
    expect(parseResearchDecision({ choice: "abstain" })).toEqual({ choice: "abstain" });
    expect(parseResearchDecision(
      { choice: "intervene", candidateId: "candidate-1" },
      new Set(["candidate-1"]),
    )).toEqual({ choice: "intervene", candidateId: "candidate-1" });
    expect(() => parseResearchDecision({ choice: "intervene", candidateId: "candidate-2" }, new Set(["candidate-1"])))
      .toThrow(/Unknown candidateId/);
    expect(() => parseResearchDecision({ choice: "abstain", candidateId: "candidate-1" })).toThrow();
    expect(() => parseResearchDecision({ choice: "intervene" })).toThrow();
    expect(() => parseResearchDecision({ choice: "wait" })).toThrow();
  });

  test("renders deterministic exact bytes without private experimental fields", () => {
    const first = renderResearchPrompt(packet());
    const second = renderResearchPrompt(structuredClone(packet()));
    expect(new TextEncoder().encode(first)).toEqual(new TextEncoder().encode(second));
    expect(first).toContain('"candidateId":"candidate-1"');
    expect(first).not.toMatch(/family|scenarioId|expectedClass|oracle|suffix|taskSuccess/i);
    expect(() => assertPromptIsolation(first)).not.toThrow();
  });

  test("rejects changed packet bytes and private-key smuggling", () => {
    const changed = packet();
    changed.controlledGoals = ["A changed goal"];
    expect(() => renderResearchPrompt(changed)).toThrow(/packetId/);

    const smuggled = { ...packet(), family: "cold-passage" };
    expect(() => renderResearchPrompt(smuggled as ResearchDecisionPacketV1)).toThrow();
  });
});
