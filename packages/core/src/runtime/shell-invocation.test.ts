import { describe, test, expect, afterEach } from "bun:test";
import { resolveShellInvocation, defaultShellBinary } from "./spawn-common.js";

// resolveShellInvocation branches on process.platform; redefine it per-case so
// the Windows path is exercised on a non-Windows CI host. Restore afterwards.
const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
afterEach(() => {
  setPlatform(realPlatform);
  delete process.env.ComSpec;
  delete process.env.SHELL;
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

  test("Windows uses cmd.exe /c (NOT -c) and ignores a stray POSIX $SHELL", () => {
    setPlatform("win32");
    process.env.SHELL = "/bin/bash"; // stray unix value — must be ignored on win
    delete process.env.ComSpec;
    expect(resolveShellInvocation("dir")).toEqual({ file: "cmd.exe", args: ["/c", "dir"] });
  });

  test("Windows honors ComSpec for the cmd path", () => {
    setPlatform("win32");
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    expect(resolveShellInvocation("dir")).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/c", "dir"],
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

  test("explicit shell overrides platform default (POSIX)", () => {
    setPlatform("darwin");
    expect(resolveShellInvocation("x", "/usr/bin/fish")).toEqual({
      file: "/usr/bin/fish",
      args: ["-c", "x"],
    });
  });
});

describe("defaultShellBinary", () => {
  test("Windows → cmd.exe (or ComSpec)", () => {
    setPlatform("win32");
    delete process.env.ComSpec;
    expect(defaultShellBinary()).toBe("cmd.exe");
    process.env.ComSpec = "C:\\cmd.exe";
    expect(defaultShellBinary()).toBe("C:\\cmd.exe");
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
