/**
 * Public, versioned contracts for the research-only decision benchmark.
 *
 * These shapes deliberately contain only observable inputs and public-safe outputs. Family names,
 * experimental labels, oracle outcomes, suffix policies, metrics, credentials, and hidden reasoning
 * never cross the provider boundary.
 *
 * @author Runkai Zhang
 */
import { z } from "zod";

export const ResearchFactV1Schema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
}).strict();

export const ResearchCandidateV1Schema = z.object({
  candidateId: z.string().min(1),
  modality: z.enum(["inform", "act"]),
  description: z.string().min(1),
}).strict();

export const ResearchVisibleStateV1Schema = z.object({
  location: z.string().min(1),
  clock: z.string().min(1),
  playerInventory: z.array(z.string()),
  companionInventory: z.array(z.string()),
  exits: z.array(z.object({
    destination: z.string().min(1),
    state: z.enum(["open", "locked", "blocked", "broken"]),
  }).strict()),
  task: z.object({
    title: z.string().min(1),
    objective: z.string().min(1),
    status: z.enum(["active", "complete", "failed"]),
  }).strict(),
}).strict();

export const ResearchDecisionPacketV1Schema = z.object({
  schemaVersion: z.literal(1),
  packetId: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    persona: z.string().min(1),
  }).strict(),
  controlledGoals: z.array(z.string().min(1)).min(1),
  visibleState: ResearchVisibleStateV1Schema,
  companionKnownFacts: z.array(ResearchFactV1Schema),
  playerKnownFacts: z.array(ResearchFactV1Schema),
  candidates: z.array(ResearchCandidateV1Schema).length(1),
}).strict();

export const ResearchDecisionSchema = z.discriminatedUnion("choice", [
  z.object({ choice: z.literal("abstain") }).strict(),
  z.object({
    choice: z.literal("intervene"),
    candidateId: z.string().min(1),
  }).strict(),
]);

/** Canonical decision JSON Schema. Provider adapters wrap/narrow it for vendor compatibility. */
export const RESEARCH_DECISION_JSON_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: { choice: { const: "abstain" } },
      required: ["choice"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        choice: { const: "intervene" },
        candidateId: { type: "string", minLength: 1 },
      },
      required: ["choice", "candidateId"],
      additionalProperties: false,
    },
  ],
} as const;

export const ResearchUsageV1Schema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
}).strict();

export const ResearchAttemptStatusV1Schema = z.enum([
  "valid",
  "invalid-json",
  "invalid-schema",
  "refusal",
  "timeout",
  "rate-limit",
  "provider-error",
  "model-drift",
]);

/** Closed, public-safe categories. Provider-controlled error text never enters an attempt record. */
export const ResearchProviderErrorClassV1Schema = z.enum([
  "timeout",
  "network-error",
  "invalid-request",
  "authentication-error",
  "permission-error",
  "not-found",
  "provider-timeout",
  "conflict",
  "request-too-large",
  "rate-limit",
  "provider-internal",
  "provider-unavailable",
  "http-error",
  "invalid-provider-envelope",
  "returned-model-mismatch",
  "missing-returned-model",
  "refusal",
  "incomplete-response",
  "missing-finish-reason",
  "missing-stop-reason",
  "missing-response-status",
  "missing-visible-output",
  "invalid-json",
  "schema-validation-error",
  "grounding-error",
  "missing-parsed-decision",
  "runtime-provider-exception",
  "interrupted-process",
]);

export const ResearchProviderAttemptV1Schema = z.object({
  schemaVersion: z.literal(1),
  attemptId: z.string().min(1),
  provider: z.enum(["google", "anthropic", "openai", "fake"]),
  configuredModel: z.string().min(1),
  returnedModel: z.string().min(1).optional(),
  status: ResearchAttemptStatusV1Schema,
  latencyMs: z.number().int().nonnegative(),
  requestId: z.string().min(1).optional(),
  responseId: z.string().min(1).optional(),
  visibleOutput: z.string().optional(),
  parsedDecision: ResearchDecisionSchema.optional(),
  usage: ResearchUsageV1Schema.optional(),
  stopReason: z.string().optional(),
  errorClass: ResearchProviderErrorClassV1Schema.optional(),
}).strict();

export const ResearchProviderRequestV1Schema = z.object({
  attemptId: z.string().min(1),
  prompt: z.string().min(1),
  packet: ResearchDecisionPacketV1Schema,
  timeoutMs: z.number().int().positive(),
}).strict();

export const ResearchBranchResultV2Schema = z.object({
  mechanicsSeed: z.number().int().min(0).max(0xffff_ffff),
  branch: z.enum(["candidate", "silence"]),
  status: z.enum(["completed", "expected-task-stop", "structural-censor"]),
  taskSuccess: z.boolean(),
  groundingAccepted: z.boolean(),
  endStateHash: z.string().regex(/^[a-f0-9]{64}$/),
  cost: z.object({
    clockMinutes: z.number().nonnegative(),
    interventionBurden: z.number().nonnegative(),
  }).strict(),
  failureReason: z.string().optional(),
}).strict();

export const OracleQualificationCellV2Schema = z.object({
  cellId: z.string().min(1),
  scenarioId: z.string().min(1),
  family: z.string().min(1),
  modality: z.enum(["informing", "instrumental"]),
  expectedClass: z.enum(["signal", "noise"]),
  condition: z.object({
    asymmetry: z.union([z.literal(0), z.literal(0.3), z.literal(0.7)]),
    incentive: z.enum(["cooperative", "mixed"]),
  }).strict(),
  stableLabel: z.enum(["signal", "noise"]),
  branches: z.array(ResearchBranchResultV2Schema).length(10),
}).strict();

export const OracleQualificationV2Schema = z.object({
  schemaVersion: z.literal(2),
  artifactKind: z.literal("seed.research.oracle-qualification"),
  suiteHash: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime(),
  executionCount: z.literal(1440),
  qualified: z.boolean(),
  failures: z.array(z.string()),
  cells: z.array(OracleQualificationCellV2Schema).length(144),
}).strict();

export const LiveTrialResultV1Schema = z.object({
  schemaVersion: z.literal(1),
  artifactKind: z.literal("seed.research.live-trial"),
  trialId: z.string().min(1),
  cellId: z.string().min(1),
  scenarioId: z.string().min(1),
  family: z.string().min(1),
  modality: z.enum(["informing", "instrumental"]),
  expectedClass: z.enum(["signal", "noise"]),
  condition: z.object({
    asymmetry: z.union([z.literal(0), z.literal(0.3), z.literal(0.7)]),
    incentive: z.enum(["cooperative", "mixed"]),
  }).strict(),
  replicate: z.number().int().positive(),
  modelAttempt: ResearchProviderAttemptV1Schema,
  parsedChoice: ResearchDecisionSchema,
  grounding: z.object({
    accepted: z.boolean(),
    candidateId: z.string().optional(),
    reason: z.string().optional(),
  }).strict(),
  chosenBranches: z.array(ResearchBranchResultV2Schema).length(5),
  silenceBranches: z.array(ResearchBranchResultV2Schema).length(5),
  taskSuccessRate: z.number().min(0).max(1),
  regret: z.number().min(0).max(1),
  failureClassification: ResearchAttemptStatusV1Schema.optional(),
}).strict();

export interface ResearchProvider {
  readonly providerId: "google" | "anthropic" | "openai" | "fake";
  readonly model: string;
  decide(request: ResearchProviderRequestV1): Promise<ResearchProviderAttemptV1>;
}

export interface ResearchAnalysisV1 {
  schemaVersion: 1;
  artifactKind: "seed.research.analysis";
  generatedAt: string;
  intentionToEvaluate: ResearchAnalysisSliceV1;
  validResponseSensitivity: ResearchAnalysisSliceV1;
  byModel: Record<string, ResearchAnalysisSliceV1>;
  byModality: Record<string, ResearchAnalysisSliceV1>;
  byAsymmetry: Record<string, ResearchAnalysisSliceV1>;
  byIncentive: Record<string, ResearchAnalysisSliceV1>;
  byFamily: Record<string, ResearchAnalysisSliceV1>;
  coverage: {
    totalTrials: number;
    validTrials: number;
    validityRate: number;
    refusals: number;
    refusalRate: number;
    timeouts: number;
    timeoutRate: number;
    rateLimits: number;
    rateLimitRate: number;
    invalidJsonFailures: number;
    invalidJsonFailureRate: number;
    invalidSchemaFailures: number;
    invalidSchemaFailureRate: number;
    modelDrifts: number;
    modelDriftRate: number;
    groundingFailures: number;
    groundingFailureRate: number;
    providerErrors: number;
    providerErrorRate: number;
  };
  familyVariance: {
    familyCount: number;
    identifiableFamilyCount: number;
    meanDPrime: number | null;
    sampleVarianceDPrime: number | null;
  };
  powerSizing: {
    status: "estimated" | "unavailable";
    currentFamilyCount: number;
    identifiableFamilyCount: number;
    alpha: 0.05;
    targetPower: 0.8;
    method: "two-sided-normal-approximation";
    recommendedHeldOutFamilies: number | null;
    note: string;
  };
}

export interface ResearchAnalysisSliceV1 {
  trials: number;
  hits: number;
  misses: number;
  falseAlarms: number;
  correctRejections: number;
  dPrime: number | null;
  criterion: number | null;
  meanTaskSuccess: number;
  /** Mean chosen-branch task success minus the matched forced-silence branch. */
  meanTaskSuccessDelta: number;
  meanRegret: number;
  confidenceIntervals?: Record<string, { low: number; high: number } | null>;
}

export type ResearchDecisionPacketV1 = z.infer<typeof ResearchDecisionPacketV1Schema>;
export type ResearchDecision = z.infer<typeof ResearchDecisionSchema>;
export type ResearchProviderAttemptV1 = z.infer<typeof ResearchProviderAttemptV1Schema>;
export type ResearchProviderErrorClassV1 = z.infer<typeof ResearchProviderErrorClassV1Schema>;
export type ResearchProviderRequestV1 = z.infer<typeof ResearchProviderRequestV1Schema>;
export type ResearchBranchResultV2 = z.infer<typeof ResearchBranchResultV2Schema>;
export type OracleQualificationCellV2 = z.infer<typeof OracleQualificationCellV2Schema>;
export type OracleQualificationV2 = z.infer<typeof OracleQualificationV2Schema>;
export type LiveTrialResultV1 = z.infer<typeof LiveTrialResultV1Schema>;

export function parseResearchDecision(value: unknown, candidateIds?: ReadonlySet<string>): ResearchDecision {
  const decision = ResearchDecisionSchema.parse(value);
  if (decision.choice === "intervene" && candidateIds && !candidateIds.has(decision.candidateId)) {
    throw new Error(`Unknown candidateId: ${decision.candidateId}`);
  }
  return decision;
}
