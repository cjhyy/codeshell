import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveShellInvocation, defaultShellBinary, resolveGitBash, _resetGitBashCache, _resetPowerShellCache } from "./spawn-common.js";

// resolveShellInvocation branches on process.platform; redefine it per-case so
// the Windows path is exercised on a non-Windows CI host. Restore afterwards.
const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
// Neutralize Git Bash auto-discovery so the fallback paths are exercised
// deterministically regardless of host. On a real Windows CI runner Git for
// Windows IS preinstalled, so `where git` + the Program Files locations would
// otherwise resolve a real bash.exe and defeat these fallback assertions.
// Emptying PATH makes `where` itself un-spawnable (ENOENT → caught → skip);
// pointing ProgramFiles at a bogus dir makes the well-known locations miss.
const realPath = process.env.PATH;
const realProgramFiles = process.env["ProgramFiles"];
const realProgramFiles86 = process.env["ProgramFiles(x86)"];
const realSystemRoot = process.env.SystemRoot;
let tempDirs: string[] = [];
function fakeExistingBashExe(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-git-bash-test-"));
  tempDirs.push(dir);
  const bash = join(dir, "bash.exe");
  writeFileSync(bash, "");
  return bash;
}
function fakeExistingPowerShellExe(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-powershell-test-"));
  tempDirs.push(dir);
  const powershell = join(dir, "powershell.exe");
  writeFileSync(powershell, "");
  return powershell;
}
function disableGitBashDiscovery() {
  // Hard-disable auto-discovery. Clearing PATH / bogus ProgramFiles is not
  // enough on a real Windows CI runner: CreateProcess still finds System32's
  // where.exe and the preinstalled Git for Windows resolves a real bash.exe,
  // defeating these fallback assertions. The env flag short-circuits discovery
  // in spawn-common so the "shell absent" scenario is hermetic everywhere.
  process.env.CODE_SHELL_NO_SHELL_DISCOVERY = "1";
  process.env.PATH = "";
  process.env["ProgramFiles"] = "C:\\__no_such_root__";
  process.env["ProgramFiles(x86)"] = "C:\\__no_such_root_x86__";
}
afterEach(() => {
  setPlatform(realPlatform);
  delete process.env.ComSpec;
  delete process.env.SHELL;
  delete process.env.CODE_SHELL_GIT_BASH_PATH;
  delete process.env.CODE_SHELL_POWERSHELL_PATH;
  delete process.env.CODE_SHELL_NO_SHELL_DISCOVERY;
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
  if (realProgramFiles === undefined) delete process.env["ProgramFiles"];
  else process.env["ProgramFiles"] = realProgramFiles;
  if (realProgramFiles86 === undefined) delete process.env["ProgramFiles(x86)"];
  else process.env["ProgramFiles(x86)"] = realProgramFiles86;
  if (realSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = realSystemRoot;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  _resetGitBashCache();
  _resetPowerShellCache();
});

describe("resolveShellInvocation — platform-correct shell + command flag", () => {
  test("POSIX uses <shell> -c <command>", () => {
    setPlatform("linux");
    process.env.SHELL = "/bin/zsh";
    expect(resolveShellInvocation("echo hi")).toEqual({ file: "/bin/zsh", args: ["-c", "echo hi"] });
  });

  test("POSIX falls back to /bin/bash when SHELL unset", () => {
    setPlatform("linux");
    delete process.env.SHELL;
    expect(resolveShellInvocation("ls")).toEqual({ file: "/bin/bash", args: ["-c", "ls"] });
  });

  test("Windows falls back to PowerShell when Git Bash is absent and ignores a stray POSIX $SHELL", () => {
    setPlatform("win32");
    disableGitBashDiscovery();
    _resetGitBashCache();
    _resetPowerShellCache();
    process.env.SHELL = "/bin/bash"; // stray unix value — must be ignored on win
    delete process.env.ComSpec;
    process.env.CODE_SHELL_POWERSHELL_PATH = fakeExistingPowerShellExe();
    expect(resolveShellInvocation("dir")).toEqual({
      file: process.env.CODE_SHELL_POWERSHELL_PATH,
      args: ["-Command", "dir"],
    });
  });

  test("Windows PowerShell shell uses -Command", () => {
    setPlatform("win32");
    expect(resolveShellInvocation("Get-ChildItem", "pwsh.exe")).toEqual({
      file: "pwsh.exe",
      args: ["-Command", "Get-ChildItem"],
    });
    expect(resolveShellInvocation("gci", "powershell")).toEqual({
      file: "powershell",
      args: ["-Command", "gci"],
    });
  });

  test("Windows Git Bash (bash.exe) uses -c, NOT /c", () => {
    // Now that defaultShellBinary prefers Git Bash on Windows, resolveShellInvocation
    // must give bash.exe a POSIX -c — feeding it cmd's /c would break every command.
    setPlatform("win32");
    expect(resolveShellInvocation("ls -la", "C:\\Program Files\\Git\\bin\\bash.exe")).toEqual({
      file: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["-c", "ls -la"],
    });
    // bare sh.exe likewise.
    expect(resolveShellInvocation("echo hi", "sh.exe")).toEqual({
      file: "sh.exe",
      args: ["-c", "echo hi"],
    });
  });

  test("Windows default shell invocation uses discovered Git Bash when available", () => {
    setPlatform("win32");
    _resetGitBashCache();
    process.env.CODE_SHELL_GIT_BASH_PATH = fakeExistingBashExe();
    expect(resolveShellInvocation("ls -la")).toEqual({
      file: process.env.CODE_SHELL_GIT_BASH_PATH,
      args: ["-c", "ls -la"],
    });
  });

  test("explicit shell overrides platform default (POSIX)", () => {
    setPlatform("darwin");
    expect(resolveShellInvocation("x", "/usr/bin/fish")).toEqual({
      file: "/usr/bin/fish",
      args: ["-c", "x"],
    });
  });
});

describe("resolveGitBash", () => {
  test("returns undefined on non-Windows", () => {
    setPlatform("darwin");
    _resetGitBashCache();
    expect(resolveGitBash()).toBeUndefined();
  });

  test("honors CODE_SHELL_GIT_BASH_PATH override when the file exists", () => {
    setPlatform("win32");
    _resetGitBashCache();
    // Point at a path we know exists on this host (this very test file) — the
    // resolver only checks existence, not that it's really bash.
    process.env.CODE_SHELL_GIT_BASH_PATH = __filename;
    expect(resolveGitBash()).toBe(__filename);
  });

  test("ignores a non-existent override (falls through)", () => {
    setPlatform("win32");
    disableGitBashDiscovery();
    _resetGitBashCache();
    process.env.CODE_SHELL_GIT_BASH_PATH = "/no/such/bash.exe";
    // With git discovery neutralized, neither `where git` nor the Program Files
    // paths resolve, so it ends up undefined — proving the bogus override didn't
    // stick. (Real Windows CI preinstalls Git; disableGitBashDiscovery() keeps
    // this hermetic there too.)
    expect(resolveGitBash()).toBeUndefined();
  });
});

describe("defaultShellBinary", () => {
  test("Windows → Git Bash override when available", () => {
    setPlatform("win32");
    _resetGitBashCache();
    process.env.CODE_SHELL_GIT_BASH_PATH = fakeExistingBashExe();
    expect(defaultShellBinary()).toBe(process.env.CODE_SHELL_GIT_BASH_PATH);
  });

  test("Windows → PowerShell when Git Bash is absent", () => {
    setPlatform("win32");
    disableGitBashDiscovery();
    _resetGitBashCache();
    _resetPowerShellCache();
    process.env.CODE_SHELL_POWERSHELL_PATH = fakeExistingPowerShellExe();
    expect(defaultShellBinary()).toBe(process.env.CODE_SHELL_POWERSHELL_PATH);
  });

  test("POSIX → $SHELL or /bin/bash", () => {
    setPlatform("linux");
    process.env.SHELL = "/bin/zsh";
    expect(defaultShellBinary()).toBe("/bin/zsh");
    delete process.env.SHELL;
    expect(defaultShellBinary()).toBe("/bin/bash");
  });
  test("explicit override wins", () => {
    setPlatform("win32");
    expect(defaultShellBinary("bash")).toBe("bash");
  });
});
