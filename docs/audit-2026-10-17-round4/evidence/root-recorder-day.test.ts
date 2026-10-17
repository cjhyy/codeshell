import { expect, setSystemTime, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("LOG-R4-02 a continuous session writes after UTC midnight into the previous day directory", async () => {
  // Like the existing session-recorder fixture, copy the production leaf byte
  // for byte so its import.meta.url root and all output remain in owned tmp.
  const root = mkdtempSync(join(tmpdir(), "audit-r4-recorder-day-"));
  const copy = join(root, "session-recorder.ts");
  const envBefore = {
    dev: process.env.CODE_SHELL_DEV,
    verbose: process.env.CODE_SHELL_VERBOSE_LOG,
  };
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  const source = new URL("../../../packages/core/src/logging/session-recorder.ts", import.meta.url);
  copyFileSync(source, copy);
  try {
    process.env.CODE_SHELL_DEV = "1";
    process.env.CODE_SHELL_VERBOSE_LOG = "1";
    setSystemTime(new Date("2026-10-16T23:59:59.000Z"));
    const recorder = await import(pathToFileURL(copy).href);
    expect(readFileSync(copy)).toEqual(readFileSync(source));
    expect(recorder.getVerboseLogDir()).toBe(join(root, "log"));
    recorder.recordSessionStart("owned-continuous", { model: "metadata-only" });
    setSystemTime(new Date("2026-10-17T00:00:01.000Z"));
    recorder.recordToolResult("owned-continuous", { id: "owned-1", toolName: "Read", ok: true, durationMs: 1, output: "owned result" });
    const oldFile = join(root, "log", "2026-10-16", "engine", "session-owned-continuous.jsonl");
    const newFile = join(root, "log", "2026-10-17", "engine", "session-owned-continuous.jsonl");
    const events = readFileSync(oldFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.t.slice(0, 10))).toEqual(["2026-10-16", "2026-10-17"]);
    expect(events.at(-1).output).toBe("owned result");
    expect(existsSync(newFile)).toBe(false);
    // A new session after midnight goes into the new day normally.
    recorder.recordSessionStart("owned-new-session", { model: "metadata-only" });
    expect(existsSync(join(root, "log", "2026-10-17", "engine", "session-owned-new-session.jsonl"))).toBe(true);
    // Closing clears the session cache; a later turn now picks the correct day.
    recorder.recordSessionEnd("owned-continuous", { turns: 1 });
    recorder.recordSessionStart("owned-continuous", { model: "metadata-only" });
    expect(existsSync(newFile)).toBe(true);
  } finally {
    setSystemTime();
    for (const [key, value] of [["CODE_SHELL_DEV", envBefore.dev], ["CODE_SHELL_VERBOSE_LOG", envBefore.verbose]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
