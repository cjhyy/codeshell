// packages/desktop/src/main/automationMemory.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readAutomationMemory, appendAutomationMemory } from "./automationMemory";

describe("automationMemory", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("read returns '' for unknown job", () => {
    expect(readAutomationMemory("job1", dir)).toBe("");
  });

  it("append then read returns the summary", () => {
    appendAutomationMemory("job1", "ran ok", dir);
    expect(readAutomationMemory("job1", dir)).toContain("ran ok");
  });

  it("append accumulates across runs, newest appended after older", () => {
    appendAutomationMemory("job1", "first", dir);
    appendAutomationMemory("job1", "second", dir);
    const mem = readAutomationMemory("job1", dir);
    expect(mem.indexOf("first")).toBeLessThan(mem.indexOf("second"));
  });

  it("isolates by jobId and rejects path traversal", () => {
    appendAutomationMemory("job1", "x", dir);
    expect(readAutomationMemory("job2", dir)).toBe("");
    expect(readAutomationMemory("../escape", dir)).toBe(""); // unsafe id → empty, no throw
  });

  it("rejects linked job directories and memory files", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "am-outside-"));
    try {
      fs.symlinkSync(outside, path.join(dir, "linked-job"));
      expect(() => appendAutomationMemory("linked-job", "escape", dir)).toThrow(/real directory/);
      expect(fs.existsSync(path.join(outside, "memory.md"))).toBe(false);

      fs.mkdirSync(path.join(dir, "file-link"));
      const outsideFile = path.join(outside, "outside.md");
      fs.writeFileSync(outsideFile, "keep");
      fs.symlinkSync(outsideFile, path.join(dir, "file-link", "memory.md"));
      expect(readAutomationMemory("file-link", dir)).toBe("");
      expect(() => appendAutomationMemory("file-link", "escape", dir)).toThrow(/regular file/);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("keep");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps only the newest bounded memory and rejects giant summaries", () => {
    const jobDir = path.join(dir, "job1");
    fs.mkdirSync(jobDir);
    const file = path.join(jobDir, "memory.md");
    fs.writeFileSync(file, "old\n".repeat(700_000));

    appendAutomationMemory("job1", "latest", dir);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(readAutomationMemory("job1", dir)).toContain("latest");
    expect(() => appendAutomationMemory("job1", "x".repeat(256 * 1024), dir)).toThrow(
      /exceeds/,
    );
  });
});
