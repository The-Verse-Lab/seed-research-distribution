import type { ResearchExitState, ResearchQuestState } from "./schema";

export type ResearchWorldCommand =
  | { kind: "moveParty"; to: string }
  | { kind: "discloseFacts"; factIds: string[] }
  | { kind: "transferItem"; itemId: string; from: string | null; to: string | null }
  | { kind: "setExitState"; locationId: string; to: string; state: ResearchExitState }
  | { kind: "setQuestState"; questId: string; state: ResearchQuestState }
  | { kind: "setObjective"; questId: string; objectiveId: string; done: boolean }
  | { kind: "revealCaseEvidence"; caseId: string; factId: string }
  | {
      kind: "resolveCase";
      caseId: string;
      status: "solved" | "failed";
      suspectId?: string;
      citedEvidenceFactIds?: string[];
    }
  | { kind: "advanceClock"; minutes: number }
  | { kind: "markEventFired"; eventId: string };
