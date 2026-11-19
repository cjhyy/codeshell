import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { powershellTool } from "./powershell.js";
import type { ToolContext } from "../context.js";
import type { SandboxBackend } from "../sandbox/index.js";

function ctx(extra: Partial<ToolContext>): ToolContext {
  return { cwd: process.cwd(), ...extra } as ToolContext;
}

function text(out: Awaited<ReturnType<typeof powershellTool>>): string {
  return typeof out === "string" ? out : out.result;
}

// Real `pwsh` cold starts vary widely across CI runners, which made both the
// result and the builtin coverage gate depend on runner timing. On POSIX, put
// a deterministic stand-in first on PATH; it receives the same argv
// (-NoProfile -NonInteractive -Command <script>) and branches on the script.
const FAKE_PWSH = `#!/bin/sh
case "$4" in
  fail) echo "boom" >&2; exit 3 ;;
  silent-fail) exit 4 ;;
  hang) exec sleep 10 ;;
  quiet) exit 0 ;;
  *) printf '%s\\n' "$4" ;;
esac
`;

const posix = process.platform !== "win32";
let fakeDir: string | undefined;
let originalPath: string | undefined;

beforeEach(() => {
  if (!posix) return;
  fakeDir = mkdtempSync(join(tmpdir(), "codeshell-fake-pwsh-"));
  const bin = join(fakeDir, "pwsh");
  writeFileSync(bin, FAKE_PWSH);
  chmodSync(bin, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeDir}:${originalPath ?? ""}`;
});

afterEach(() => {
  if (!posix) return;
  process.env.PATH = originalPath;
  if (fakeDir) rmSync(fakeDir, { recursive: true, force: true });
  fakeDir = undefined;
});

describe("PowerShell sandbox status", () => {
  test("reports unisolated even when the run has an active sandbox backend", async () => {
    const fakeBackend: SandboxBackend = {
      name: "seatbelt",
      network: "deny",
      wrap() {
        throw new Error(
          "PowerShell should not be routed through the sandbox wrapper in this patch",
        );
      },
    };

    const out = await powershellTool(
      { command: "Write-Output sandbox-status", timeout: 5_000 },
      ctx({ sandbox: fakeBackend }),
    );

    if (typeof out === "string") throw new Error("expected structured PowerShell result");
    expect(out.sandbox).toEqual({ backend: "off" });
  });
});

describe("PowerShell result branches", () => {
  test("rejects a blank command without spawning", async () => {
    expect(text(await powershellTool({ command: "   " }, ctx({})))).toBe(
      "Error: command is required.",
    );
  });

  test("reports an abort that happened before start", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(text(await powershellTool({ command: "x" }, ctx({ signal: controller.signal })))).toBe(
      "PowerShell aborted before starting.",
    );
  });

  test.skipIf(!posix)("returns trimmed stdout on success", async () => {
    expect(text(await powershellTool({ command: "hello" }, ctx({})))).toBe("hello");
  });

  test.skipIf(!posix)("marks empty successful output", async () => {
    expect(text(await powershellTool({ command: "quiet" }, ctx({})))).toBe("(no output)");
  });

  test.skipIf(!posix)("includes output for a non-zero exit", async () => {
    expect(text(await powershellTool({ command: "fail" }, ctx({})))).toBe(
      "PowerShell error:\nboom",
    );
  });

  test.skipIf(!posix)("falls back to the exit code when nothing was printed", async () => {
    expect(text(await powershellTool({ command: "silent-fail" }, ctx({})))).toBe(
      "PowerShell error:\nexit code 4",
    );
  });

  test.skipIf(!posix)("reports a timeout", async () => {
    expect(text(await powershellTool({ command: "hang", timeout: 200 }, ctx({})))).toBe(
      "PowerShell timed out after 200ms",
    );
  });

  test.skipIf(!posix)("reports an abort while running", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    expect(
      text(await powershellTool({ command: "hang" }, ctx({ signal: controller.signal }))),
    ).toBe("PowerShell aborted by signal.");
  });

  test.skipIf(!posix)("reports a missing executable", async () => {
    const empty = mkdtempSync(join(tmpdir(), "codeshell-no-pwsh-"));
    process.env.PATH = empty;
    try {
      expect(text(await powershellTool({ command: "x" }, ctx({})))).toStartWith(
        "PowerShell spawn error:",
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
