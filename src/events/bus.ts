/**
 * EventBus — fan-out of game events to subscribers.
 *
 * Producers emit partial events (no id/seq/time); the bus stamps them and notifies
 * listeners. The same interface feeds the CLI and research listeners with producers and
 * consumers unchanged. `at` is stamped here — the one place wall-clock time enters the
 * system — so pure logic stays deterministic.
 *
 * @author Runkai Zhang
 */
import type { EmittedEvent, GameEvent } from "./types.ts";

export type EventListener = (event: GameEvent) => void;

export interface EventBus {
  /** Stamp an event without broadcasting it; used for durable-but-silent bookkeeping. */
  stamp(event: EmittedEvent): GameEvent;
  /** Broadcast an event that has already been stamped. Used after an authoritative commit succeeds. */
  publish(event: GameEvent): void;
  /** Stamp and broadcast an event; returns the fully-formed event. */
  emit(event: EmittedEvent): GameEvent;
  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void;
  /** Set the next seq (for seeding from a persisted log). Optional per implementation. */
  reseed?(startSeq: number): void;
  /** The seq that will be assigned to the next emitted event (for per-turn trace windows). */
  currentSeq?(): number;
}

export interface InProcessEventBusOptions {
  /** The seq to assign to the next emitted event. Defaults to 0. */
  startSeq?: number;
}

export class InProcessEventBus implements EventBus {
  private listeners = new Set<EventListener>();
  private seq: number;

  constructor(opts: InProcessEventBusOptions = {}) {
    this.seq = opts.startSeq ?? 0;
  }

  /** Reseed the counter — only valid before any event is emitted in a session. */
  reseed(startSeq: number): void {
    this.seq = startSeq;
  }

  /** The seq the next emitted event will carry (used to bracket a turn's trace window). */
  currentSeq(): number {
    return this.seq;
  }

  stamp(event: EmittedEvent): GameEvent {
    return {
      ...event,
      id: crypto.randomUUID(),
      at: Date.now(),
      seq: this.seq++,
    } as GameEvent;
  }

  emit(event: EmittedEvent): GameEvent {
    const full = this.stamp(event);
    this.publish(full);
    return full;
  }

  publish(event: GameEvent): void {
    // One broken UI/telemetry subscriber must not abort publication to later listeners after the
    // authoritative transaction has already committed.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Subscribers are observation-only. Their faults cannot roll back committed gameplay.
      }
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
