import { expect, test } from "bun:test";
import { execFileNoThrow } from "./execFileNoThrow.js";

test("failed stdin delivery is reported instead of crashing or succeeding", async () => {
  const result = await execFileNoThrow(
    "node",
    ["-e", "require('node:fs').closeSync(0); setTimeout(() => {}, 5000)"],
    { input: "x".repeat(8 * 1024 * 1024), timeout: 2000 },
  );
  expect(result.code).not.toBe(0);
  expect(result.stderr).toMatch(/stdin:.*(?:EPIPE|closed|broken pipe)/i);
});

test("an explicitly empty stdin closes the pipe and succeeds", async () => {
  const result = await execFileNoThrow(
    process.execPath,
    ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('EOF'))"],
    { input: "", timeout: 2000 },
  );
  expect(result).toEqual({ code: 0, stdout: "EOF", stderr: "" });
});

test("child nonzero status and diagnostics remain intact", async () => {
  const result = await execFileNoThrow(process.execPath, [
    "-e",
    "console.error('owned failure');process.exit(7)",
  ]);
  expect(result.code).toBe(7);
  expect(result.stderr).toContain("owned failure");
});

test("missing executables still report spawn failure when input was supplied", async () => {
  const result = await execFileNoThrow(`${process.env.HOME}/owned-missing-executable`, [], {
    input: "owned input",
  });
  expect(result.code).toBeNull();
  expect(result.stderr).toMatch(/ENOENT|not found/i);
});

test("a stdin-dead child that ignores SIGTERM is forcibly reaped", async () => {
  const result = await execFileNoThrow(
    "node",
    [
      "-e",
      "process.on('SIGTERM', () => {}); require('node:fs').closeSync(0); setInterval(() => {}, 1000)",
    ],
    { input: "x".repeat(8 * 1024 * 1024), timeout: 10000 },
  );
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("stdin:");
}, 5000);
