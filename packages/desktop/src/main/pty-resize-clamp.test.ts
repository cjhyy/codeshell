import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetPtyGitBashCache,
  clampPtyDim,
  resolvePtyCwd,
  resolveGitBashForPty,
  resolveShell,
  shellArgs,
} from "./pty-service.js";

const realPlatform = process.platform;
const realPath = process.env.PATH;
const realComspec = process.env.COMSPEC;
const realProgramFiles = process.env.ProgramFiles;
const realProgramFiles86 = process.env["ProgramFiles(x86)"];
const realPowershellPath = process.env.CODE_SHELL_POWERSHELL_PATH;
const realSystemRoot = process.env.SystemRoot;
const realWinDir = process.env.windir;
let tempDir: string | undefined;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function disableGitBashDiscovery(): void {
  process.env.PATH = "";
  process.env.ProgramFiles = "C:\\__no_git_here__";
  process.env["ProgramFiles(x86)"] = "C:\\__no_git_here_x86__";
  delete process.env.CODE_SHELL_GIT_BASH_PATH;
}

function fakeExecutable(name: string): string {
  tempDir = mkdtempSync(join(tmpdir(), "codeshell-pty-test-"));
  const file = join(tempDir, name);
  writeFileSync(file, "");
  return file;
}

afterEach(() => {
  setPlatform(realPlatform);
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
  if (realComspec === undefined) delete process.env.COMSPEC;
  else process.env.COMSPEC = realComspec;
  if (realProgramFiles === undefined) delete process.env.ProgramFiles;
  else process.env.ProgramFiles = realProgramFiles;
  if (realProgramFiles86 === undefined) delete process.env["ProgramFiles(x86)"];
  else process.env["ProgramFiles(x86)"] = realProgramFiles86;
  delete process.env.CODE_SHELL_GIT_BASH_PATH;
  if (realPowershellPath === undefined) delete process.env.CODE_SHELL_POWERSHELL_PATH;
  else process.env.CODE_SHELL_POWERSHELL_PATH = realPowershellPath;
  if (realSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = realSystemRoot;
  if (realWinDir === undefined) delete process.env.windir;
  else process.env.windir = realWinDir;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  _resetPtyGitBashCache();
});

// Footgun: ptyResize used Math.max(1, cols), but Math.max(1, NaN) === NaN, so a
// malformed IPC resize (cols=NaN / Infinity / <1) reached node-pty.resize as a
// bad dimension → native throw / misbehavior. clampPtyDim floors any non-finite
// or sub-1 value to 1.
describe("clampPtyDim", () => {
  test("passes through valid positive dimensions (floored to int)", () => {
    expect(clampPtyDim(80)).toBe(80);
    expect(clampPtyDim(24)).toBe(24);
    expect(clampPtyDim(120.7)).toBe(120);
  });

  test("NaN / Infinity floor to 1 (no NaN to node-pty)", () => {
    expect(clampPtyDim(Number.NaN)).toBe(1);
    expect(clampPtyDim(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampPtyDim(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  test("zero / negative floor to 1", () => {
    expect(clampPtyDim(0)).toBe(1);
    expect(clampPtyDim(-5)).toBe(1);
    expect(clampPtyDim(0.5)).toBe(1);
  });
});

describe("pty shell resolution", () => {
  test("Windows terminal prefers Git Bash when explicitly configured", () => {
    setPlatform("win32");
    process.env.CODE_SHELL_GIT_BASH_PATH = __filename;
    _resetPtyGitBashCache();
    expect(resolveGitBashForPty()).toBe(__filename);
    expect(resolveShell()).toBe(__filename);
  });

  test("Windows terminal falls back to PowerShell before cmd.exe when Git Bash is absent", () => {
    setPlatform("win32");
    disableGitBashDiscovery();
    process.env.CODE_SHELL_POWERSHELL_PATH = fakeExecutable("powershell.exe");
    process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe";
    _resetPtyGitBashCache();
    expect(resolveShell().toLowerCase()).toContain("powershell.exe");
  });

  test("Windows terminal uses cmd.exe only when Git Bash and PowerShell are absent", () => {
    setPlatform("win32");
    disableGitBashDiscovery();
    delete process.env.CODE_SHELL_POWERSHELL_PATH;
    process.env.SystemRoot = "C:\\__no_powershell_here__";
    process.env.windir = "C:\\__no_powershell_here__";
    process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe";
    _resetPtyGitBashCache();
    expect(resolveShell()).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  test("Windows Git Bash pty starts as login interactive; fallback shells get no bash flags", () => {
    setPlatform("win32");
    expect(shellArgs("C:\\Program Files\\Git\\bin\\bash.exe")).toEqual(["--login", "-i"]);
    expect(shellArgs("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toEqual([]);
    expect(shellArgs("C:\\Windows\\System32\\cmd.exe")).toEqual([]);
  });
});

describe("resolvePtyCwd", () => {
  test("accepts an existing directory", () => {
    tempDir = mkdtempSync(join(tmpdir(), "codeshell-pty-cwd-test-"));
    expect(resolvePtyCwd(tempDir)).toEqual({ ok: true, cwd: tempDir });
  });

  test("rejects a file or missing path before node-pty.spawn", () => {
    tempDir = mkdtempSync(join(tmpdir(), "codeshell-pty-cwd-test-"));
    const file = join(tempDir, "not-a-dir");
    writeFileSync(file, "");
    expect(resolvePtyCwd(file)).toMatchObject({ ok: false });
    expect(resolvePtyCwd(join(tempDir, "missing"))).toMatchObject({ ok: false });
  });
});
