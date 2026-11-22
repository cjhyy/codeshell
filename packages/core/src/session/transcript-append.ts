import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname } from "node:path";
import type { TranscriptEvent } from "../types.js";

export function defaultTranscriptWriter(filePath: string, data: string): void {
  // Use one append-mode descriptor so concurrent OS writers cannot overwrite
  // one another. Also repair the record boundary after a crash-torn final line;
  // otherwise the next valid event is concatenated to the fragment and both
  // are discarded on replay.
  const fd = openSync(filePath, "a+", 0o600);
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    appendLineToDescriptor(fd, data);
  } finally {
    closeSync(fd);
  }
}

function appendLineToDescriptor(fd: number, data: string): void {
  const size = fstatSync(fd).size;
  let prefix = "";
  if (size > 0) {
    const lastByte = Buffer.allocUnsafe(1);
    readSync(fd, lastByte, 0, 1, size - 1);
    if (lastByte[0] !== 0x0a) prefix = "\n";
  }
  appendFileSync(fd, prefix + data, "utf-8");
}

/** Hold the checked file identity across receipt id lookup and atomic JSONL append. */
export function withVerifiedAppend(
  filePath: string,
  use: (fd: number, appendLine: (line: string) => void, assertOpen: () => void) => void,
): void {
  const parent = dirname(filePath);
  const before = lstatSync(parent);
  if (!before.isDirectory()) throw Error("Invalid transcript directory");
  const fd = openSync(
    filePath,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_APPEND |
      (constants.O_NONBLOCK ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let active = true;
  const assertOpen = () => {
    if (!active) throw Error("Transcript is closed");
  };
  try {
    const opened = fstatSync(fd);
    const leaf = lstatSync(filePath);
    const current = lstatSync(parent);
    if (
      !opened.isFile() ||
      !leaf.isFile() ||
      !current.isDirectory() ||
      leaf.dev !== opened.dev ||
      leaf.ino !== opened.ino ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw Error("Transcript identity changed");
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    use(
      fd,
      (line) => {
        assertOpen();
        appendLineToDescriptor(fd, line);
      },
      assertOpen,
    );
  } finally {
    active = false;
    closeSync(fd);
  }
}

export function readAppendEvents(
  fd: number,
  maxBytes: number,
): { events: TranscriptEvent[]; complete: boolean } {
  const size = fstatSync(fd).size;
  const start = Math.max(0, size - maxBytes);
  const buffer = Buffer.allocUnsafe(size - start);
  let read = 0;
  while (read < buffer.length) {
    const count = readSync(fd, buffer, read, buffer.length - read, start + read);
    if (!count) break;
    read += count;
  }
  let contents = buffer.subarray(0, read);
  if (start > 0) {
    const newline = contents.indexOf(0x0a);
    contents = contents.subarray(newline === -1 ? contents.length : newline + 1);
  }
  const events: TranscriptEvent[] = [];
  for (const line of contents.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TranscriptEvent);
    } catch {
      /* Interrupted or truncated transcript record. */
    }
  }
  return { events, complete: start === 0 };
}
