/**
 * Heartbeat scheduler — periodic "consider acting" ticks for autonomous NPCs.
 *
 * Each NPC ticks on its own interval (autonomy.heartbeatSeconds). A tick is only an
 * *opportunity* to act; the Director decides whether anything actually happens. Real
 * timer plumbing is provided; wiring it to the Director is M2.
 *
 * @author Runkai Zhang
 */
export type HeartbeatCallback = (npcId: string) => void;

export class HeartbeatScheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  /** Registrations survive a temporary pause in active play. */
  private intervals = new Map<string, number>();
  private callback: HeartbeatCallback | null = null;
  private paused = false;

  /** Set the function invoked on each NPC's tick. */
  onTick(callback: HeartbeatCallback): void {
    this.callback = callback;
  }

  /** Register or update an NPC's heartbeat interval (seconds). */
  register(npcId: string, seconds: number): void {
    this.disarm(npcId);
    this.intervals.set(npcId, seconds);
    if (this.paused) return;
    this.arm(npcId, seconds);
  }

  private arm(npcId: string, seconds: number): void {
    const timer = setInterval(() => this.callback?.(npcId), seconds * 1000);
    // Background pacing must not keep the process alive on its own (so a CLI/test that's done
    // can exit even with heartbeats armed). Guard `unref` for non-Node timer shims.
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(npcId, timer);
  }

  unregister(npcId: string): void {
    this.disarm(npcId);
    this.intervals.delete(npcId);
  }

  private disarm(npcId: string): void {
    const existing = this.timers.get(npcId);
    if (existing) clearInterval(existing);
    this.timers.delete(npcId);
  }

  /** Temporarily stop ticks without forgetting which NPCs must resume later. Idempotent. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    for (const id of [...this.timers.keys()]) this.disarm(id);
  }

  /** Resume every registration retained by {@link pause}. Idempotent. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const [id, seconds] of this.intervals) this.arm(id, seconds);
  }

  /**
   * Stop all heartbeats and FORGET their registrations (e.g. on session end, or the autonomy module's
   * per-combat suspend). This does NOT set the viewer-pause flag: combat ends by re-`register()`ing
   * every companion, and setting `paused` here would make those re-registrations silently no-op (they
   * early-return while paused), leaving NPCs permanently inert after the first fight. Viewer-pause is a
   * SEPARATE concern owned only by {@link pause}/{@link resume}; a fresh `register()` re-arms whenever a
   * viewer is present. On session end no `register()` follows, so nothing re-arms.
   */
  stop(): void {
    for (const id of [...this.timers.keys()]) this.disarm(id);
    this.intervals.clear();
  }
}
