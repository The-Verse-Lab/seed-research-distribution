/**
 * EngineClient — optional callbacks the engine invokes during a turn.
 *
 * This is how a client participates in a turn without
 * leaking transport into the engine or making the event log non-serializable:
 *  - onNarrationToken: live streaming of narrator deltas (the durable log still gets one
 *    terminal narration event).
 *  - promptRoll: lets the client gate a dice roll ("press Enter to roll"). Omit it and
 *    the engine rolls immediately (tests, non-interactive runs).
 *
 * @author Runkai Zhang
 */
export interface RollRequest {
  actorId: string;
  ability: "str" | "dex" | "con" | "int" | "wis" | "cha";
  skill?: string;
  dc: number;
  /** Pre-formatted label, e.g. "DEX (Stealth) check, DC 14". */
  label: string;
}

export interface RollGateResult {
  /** M1: always true once the player commits. Reserved for future "decline" UX. */
  proceed: boolean;
}

export interface EngineClient {
  /** Block until the player commits to the roll. Absent → engine rolls immediately. */
  promptRoll?(req: RollRequest): Promise<RollGateResult>;
  /**
   * Live narrator delta sink. Absent → no streaming, just the terminal event. `beatId` (when the
   * caller supplies one) identifies which narration beat this delta belongs to, so a client can key
   * concurrent streams and never merge two beats into one buffer.
   */
  onNarrationToken?(delta: string, beatId?: number): void;
  /**
   * Retract an in-flight streamed beat. Fired when a beat streamed live (its non-sexual lead-in
   * already on screen) is then STOPPED by the minor-safety guard mid-stream: the settling `narration`
   * event never comes, so a live client would be left with a dangling half-sentence stub under a
   * blinking cursor, followed by the refusal banner. On this signal the client deletes the live buffer
   * for `beatId` before the refusal notice lands. A client that never streamed this beat (buffered, or
   * a non-live transport like the terminal) simply has nothing to remove — the call is a safe no-op.
   */
  onNarrationRetract?(beatId?: number): void;
  /** Live reasoning sink (reasoning models) for a "thinking…" indicator during the pause. */
  onReasoningToken?(delta: string): void;
}
