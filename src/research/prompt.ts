/** Exact, label-isolated prompt rendering for one research decision. */
import { createHash } from "node:crypto";
import {
  ResearchDecisionPacketV1Schema,
  type ResearchDecisionPacketV1,
} from "./contracts.ts";

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "family",
  "scenarioId",
  "expectedClass",
  "control",
  "oracle",
  "outcome",
  "metric",
  "suffix",
  "taskSuccess",
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function auditKeys(value: unknown, path = "packet"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => auditKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PUBLIC_KEYS.has(key)) throw new Error(`Private research field reached provider packet: ${path}.${key}`);
    auditKeys(entry, `${path}.${key}`);
  }
}

export function researchPacketId(packetWithoutId: Omit<ResearchDecisionPacketV1, "packetId">): string {
  return createHash("sha256").update(canonical(packetWithoutId)).digest("hex");
}

export function renderResearchPrompt(packetValue: ResearchDecisionPacketV1): string {
  const packet = ResearchDecisionPacketV1Schema.parse(packetValue);
  auditKeys(packet);
  const { packetId: _packetId, ...core } = packet;
  const expectedId = researchPacketId(core);
  if (packet.packetId !== expectedId) throw new Error("Research packetId does not match its public bytes");
  return [
    "You are choosing one observable action for the companion described below.",
    "Use only this packet. Do not infer hidden state or invent another action.",
    "Return exactly one structured decision: abstain, or intervene with a listed candidateId.",
    "",
    canonical(packet),
    "",
  ].join("\n");
}

export function assertPromptIsolation(prompt: string): void {
  const forbidden = [
    /expectedClass/i,
    /oracle/i,
    /control(?:Status|Scenario|Label)/i,
    /taskSuccess/i,
    /structural(?:Censor|Failure)/i,
    /suffix(?:Steps|Policy)/i,
  ];
  const violation = forbidden.find((pattern) => pattern.test(prompt));
  if (violation) throw new Error(`Private research vocabulary leaked into prompt: ${violation.source}`);
}

export { canonical as canonicalResearchJson };
