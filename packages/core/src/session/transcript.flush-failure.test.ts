import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Transcript } from "./transcript.js";

type TranscriptWriter = (filePath: string, data: string, encoding: "utf-8") => void;

function injectedError(code: "ENOSPC" | "EACCES" | "EPERM"): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code });
}

describe("Transcript flush failures", () => {
  for (const code of ["ENOSPC", "EACCES", "EPERM"] as const) {
    it(`retries ${code} once, keeps the event in memory, and records a structured failure`, () => {
      const dir = mkdtempSync(join(tmpdir(), "transcript-flush-failure-"));
      let attempts = 0;
      const writer: TranscriptWriter = () => {
        attempts++;
        throw injectedError(code);
      };

      try {
        const transcript = new Transcript(join(dir, "transcript.jsonl"), writer);
        transcript.appendMessage("user", `message for ${code}`);

        expect(attempts).toBe(2);
        expect(transcript.flushFailed()).toBe(true);
        expect(transcript.getFlushFailure()).toMatchObject({
          errno: code,
          code,
          message: `injected ${code}`,
          attempts: 2,
          recoverable: false,
        });
        expect(transcript.getFlushFailure()?.timestamp).toBeNumber();
        expect(transcript.getEvents("message")).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("clears a transient first failure when the retry persists the event", () => {
    const dir = mkdtempSync(join(tmpdir(), "transcript-flush-retry-"));
    const file = join(dir, "transcript.jsonl");
    let attempts = 0;
    const writer: TranscriptWriter = (filePath, data, encoding) => {
      attempts++;
      if (attempts === 1) throw injectedError("ENOSPC");
      appendFileSync(filePath, data, encoding);
    };

    try {
      const transcript = new Transcript(file, writer);
      transcript.appendMessage("user", "retry me");

      expect(attempts).toBe(2);
      expect(transcript.flushFailed()).toBe(false);
      expect(transcript.getFlushFailure()).toBeUndefined();
      expect(readFileSync(file, "utf-8")).toContain("retry me");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks the transcript dirty when its directory is deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "transcript-flush-missing-dir-"));
    const file = join(dir, "transcript.jsonl");
    const transcript = new Transcript(file);
    rmSync(dir, { recursive: true, force: true });

    transcript.appendMessage("user", "lost after directory removal");

    expect(transcript.flushFailed()).toBe(true);
    expect(transcript.getFlushFailure()).toMatchObject({
      code: "ENOENT",
      attempts: 2,
      recoverable: false,
    });
    expect(transcript.getFlushFailure()?.errno).toBeNumber();
    expect(transcript.getEvents("message")).toHaveLength(1);
  });
});
