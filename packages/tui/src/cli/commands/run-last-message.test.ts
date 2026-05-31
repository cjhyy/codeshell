import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLastMessage } from "./run.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-lastmsg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeLastMessage (--output-last-message)", () => {
  test("writes the final message text verbatim", () => {
    const file = join(dir, "out.txt");
    writeLastMessage(file, "the final answer");
    expect(readFileSync(file, "utf-8")).toBe("the final answer");
  });

  test("writes an empty file for empty text rather than skipping", () => {
    const file = join(dir, "empty.txt");
    writeLastMessage(file, "");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("");
  });

  test("an unwritable path is swallowed (best-effort, no throw)", () => {
    // A path whose parent directory doesn't exist → write fails; must not throw.
    const file = join(dir, "no-such-dir", "out.txt");
    expect(() => writeLastMessage(file, "x")).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });
});
