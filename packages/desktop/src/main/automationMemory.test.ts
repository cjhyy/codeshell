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
});
