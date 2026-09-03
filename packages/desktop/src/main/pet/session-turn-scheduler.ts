/**
 * Deciding how one more message joins a session that may already be running.
 *
 * Extracted from the Mimi chat scheduler so the IM→Work-Session bridge uses
 * the same algorithm rather than a second, subtly different one. The hard part
 * is not choosing run-vs-steer; it is knowing whether a steer was actually
 * consumed. The engine rejects a steer outright when no run is active for that
 * session (engine.ts enqueueSteer), and the truth about "is it running" lives
 * in the worker process, so a main-side check is always a guess by the time
 * the request lands.
 *
 * The resolution is to ask, then confirm:
 *
 *   1. steer rejected           → run it as a normal turn
 *   2. steer_injected observed  → consumed, this message is part of that turn
 *   3. otherwise unsteer:
 *        removed=false         → the turn loop already took it (consumed)
 *        removed=true          → we took it back; run it as a normal turn
 *   4. any transport failure    → treat as not consumed and run it
 *
 * Every outcome is safe to retry because the caller carries a stable
 * clientMessageId, so a message that is re-run after an ambiguous failure is
 * deduplicated downstream rather than written twice.
 */

export type SteerOutcome = "consumed" | "not-consumed";

export interface SteerProbe {
  /** Ask the engine to splice this text into the running turn. */
  steer(): Promise<{ accepted: boolean }>;
  /** True once a steer_injected event named this entry. */
  wasInjected(): boolean;
  /** Take the entry back. `removed: false` means the loop already used it. */
  unsteer(): Promise<{ removed: boolean }>;
  /** Resolves when the run this steer targeted has settled. */
  runDone(): Promise<void>;
}

/**
 * Run the ask-then-confirm sequence. Never throws: an unknown state resolves
 * to "not-consumed" so the message is re-run rather than silently dropped.
 * Losing a user's message is worse than briefly risking a duplicate that the
 * clientMessageId will collapse.
 */
export async function resolveSteerOutcome(probe: SteerProbe): Promise<SteerOutcome> {
  let accepted: boolean;
  try {
    accepted = (await probe.steer()).accepted;
  } catch {
    // A bridge restart is equivalent to a rejected steer.
    return "not-consumed";
  }
  if (!accepted) return "not-consumed";

  await probe.runDone().catch(() => undefined);
  if (probe.wasInjected()) return "consumed";

  try {
    // removed=false means the running loop already consumed the entry. This
    // also confirms consumption for bridges with no live event stream.
    return (await probe.unsteer()).removed ? "not-consumed" : "consumed";
  } catch {
    return "not-consumed";
  }
}

/**
 * Serializes admission decisions so two concurrent messages cannot both
 * believe they are the leader for the same session. Callers do the smallest
 * possible amount of work inside the critical section: decide, then act
 * outside it.
 */
export class AdmissionGate {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/**
 * Where an accepted inbound message went. `queued` covers both the native
 * next-turn case and an external runtime that has no steer support at all.
 */
export type InboundDisposition = "ran" | "steered" | "queued";
