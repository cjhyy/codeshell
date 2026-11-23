import type { CredentialSnapshot } from "@cjhyy/code-shell-core";

/** Run, cancel and other worker inputs preserve their relative order while
 * their predecessor's asynchronous credential snapshot is being prepared. */
export class WorkerCredentialInputs {
  private generation = -1;
  private pending?: Promise<unknown>;
  private queuedBytes = 0;
  private delivering = false;
  private current(generation: number) {
    if (generation !== this.generation) {
      this.generation = generation;
      this.pending = undefined;
      this.queuedBytes = 0;
    }
  }
  private append<T>(run: () => Promise<T> | T): Promise<T> {
    const work = (this.pending ?? Promise.resolve()).then(run);
    const settled = work.then(
      () => {},
      () => {},
    );
    this.pending = settled;
    void settled.then(() => {
      if (this.pending === settled) this.pending = undefined;
    });
    return work;
  }
  write(generation: number, line: string, send: () => boolean): boolean {
    this.current(generation);
    if (!this.pending || this.delivering) return send();
    const bytes = Buffer.byteLength(line) + 1;
    if (this.queuedBytes + bytes > 16 * 1024 * 1024) return false;
    this.queuedBytes += bytes;
    void this.append(() => {
      if (generation !== this.generation) return;
      this.queuedBytes -= bytes;
      send();
    }).catch(() => {});
    return true;
  }
  snapshot(
    generation: number,
    build: () => Promise<CredentialSnapshot>,
    deliver: (value: CredentialSnapshot) => void,
  ): Promise<void> {
    this.current(generation);
    return this.append(async () => {
      if (generation !== this.generation) return;
      const value = await build();
      if (generation !== this.generation) return;
      this.delivering = true;
      try {
        deliver(value);
      } finally {
        this.delivering = false;
      }
    });
  }
}
