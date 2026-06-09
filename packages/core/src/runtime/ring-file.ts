/**
 * RingFile — a bounded, wrap-around output sink for a background shell's
 * stdout/stderr (design §6 "落盘 8MB 环绕覆盖").
 *
 * Semantics: the logical stream is unbounded, but only the **last N bytes**
 * are retained. When the stream exceeds the cap, the oldest bytes are
 * dropped (`didWrap()` flips true). A dev server's startup banner is
 * disposable; the recent tail is what the agent/user wants.
 *
 * Implementation: an in-memory tail Buffer is authoritative (so `readAll`
 * and the manager's offset math never touch disk), mirrored to a file so a
 * user can `tail`/open it with external tools. The disk mirror is
 * best-effort — if the path is unwritable the in-memory buffer still works
 * and the manager degrades to memory-only (design §7).
 *
 * The on-disk file holds the same retained tail as memory (rewritten on
 * wrap, appended otherwise). We accept the cost of an occasional full
 * rewrite on wrap; for line-oriented dev output at the 8MB cap this is rare
 * and cheap relative to the process's own work.
 */

import {
  openSync,
  writeSync,
  readSync,
  ftruncateSync,
  closeSync,
  fsyncSync,
  fstatSync,
  existsSync,
} from "node:fs";

export class RingFile {
  private buf: Buffer = Buffer.alloc(0);
  private wrapped = false;
  private fd: number | null = null;
  private diskOk = true;
  private readonlyMode = false;
  /** Total bytes ever written to the logical stream (monotonic, NOT capped).
   *  The retained window is the last `min(total, cap)` of these. Readers track
   *  an ABSOLUTE position in this stream so incremental reads survive
   *  wraparound (a window-relative offset would silently skip new data once
   *  the window starts sliding). */
  private total = 0;

  constructor(
    private readonly path: string,
    private readonly capBytes: number,
    /** Read-only: load the EXISTING file's tail into memory and never truncate
     *  or write. Used to surface a recovered orphan shell's already-captured
     *  output (the live process owns the .log in another worker). */
    readonlyExisting = false,
  ) {
    if (readonlyExisting) {
      this.readonlyMode = true;
      this.fd = null;
      try {
        if (existsSync(path)) {
          // Read only the trailing `capBytes`, not the whole file. A reader
          // never keeps more than the cap (see write()), so slurping a
          // multi-MB .log just to discard all but the tail blocks the worker's
          // event loop on startup for nothing (see memory: main sync-fs freeze).
          const rfd = openSync(path, "r");
          try {
            const size = fstatSync(rfd).size;
            const toRead = Math.min(size, capBytes);
            const start = size - toRead;
            const data = Buffer.alloc(toRead);
            if (toRead > 0) readSync(rfd, data, 0, toRead, start);
            this.buf = data;
            this.total = size; // logical stream length stays the full file size
            this.wrapped = size > capBytes;
          } finally {
            closeSync(rfd);
          }
        }
      } catch {
        /* best effort — empty buf on read failure */
      }
      return;
    }
    try {
      // 'w' — truncate/create. One file per shell, owned by this RingFile.
      this.fd = openSync(path, "w");
    } catch {
      this.diskOk = false;
      this.fd = null;
    }
  }

  /** True if the disk mirror is usable (false → memory-only degraded mode). */
  diskAvailable(): boolean {
    return this.diskOk;
  }

  write(chunk: Buffer): void {
    this.total += chunk.length;
    const combined = this.buf.length
      ? Buffer.concat([this.buf, chunk])
      : chunk;

    if (combined.length <= this.capBytes) {
      this.buf = combined;
      this.appendToDisk(chunk);
      return;
    }

    // Over cap: keep only the trailing capBytes.
    this.wrapped = true;
    this.buf = combined.subarray(combined.length - this.capBytes);
    this.rewriteDisk();
  }

  /** Whether any bytes have been discarded by wraparound. */
  didWrap(): boolean {
    return this.wrapped;
  }

  /** The retained tail, decoded as UTF-8. */
  readAll(): string {
    return this.buf.toString("utf8");
  }

  /** Current retained byte length (for the agent read offset math). */
  byteLength(): number {
    return this.buf.length;
  }

  /** Bytes from `offset` (within the retained window) to the end. */
  sliceFrom(offset: number): Buffer {
    const start = Math.max(0, Math.min(offset, this.buf.length));
    return this.buf.subarray(start);
  }

  /** Total bytes ever written to the logical stream (monotonic). Readers use
   *  this as their next cursor after a read. */
  totalWritten(): number {
    return this.total;
  }

  /**
   * Bytes from an ABSOLUTE stream position to the current end. `absOffset` is
   * a value previously returned by {@link totalWritten}. If it points before
   * the retained window (the bytes were discarded by wraparound), returns the
   * whole window. If it's at/after the end, returns empty.
   */
  sliceFromAbsolute(absOffset: number): Buffer {
    const windowStartAbs = this.total - this.buf.length; // abs position of buf[0]
    const rel = absOffset - windowStartAbs;
    const start = Math.max(0, Math.min(rel, this.buf.length));
    return this.buf.subarray(start);
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fsyncSync(this.fd);
      } catch {
        /* best-effort */
      }
      try {
        closeSync(this.fd);
      } catch {
        /* best-effort */
      }
      this.fd = null;
    }
  }

  private appendToDisk(chunk: Buffer): void {
    if (this.fd === null) return;
    try {
      writeSync(this.fd, chunk);
    } catch {
      this.diskOk = false;
    }
  }

  private rewriteDisk(): void {
    if (this.fd === null) return;
    try {
      ftruncateSync(this.fd, 0);
      writeSync(this.fd, this.buf, 0, this.buf.length, 0);
    } catch {
      this.diskOk = false;
    }
  }
}
