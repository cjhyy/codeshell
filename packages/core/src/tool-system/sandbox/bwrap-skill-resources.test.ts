import { describe, expect, test } from "bun:test";
import { createBwrapBackend } from "./bwrap.js";

const backend = createBwrapBackend({
  mode: "bwrap",
  writableRoots: ["/workspace"],
  deniedReads: ["/home/user/.code-shell"],
  network: "allow",
});

describe("bwrap protected Skill diagnostics", () => {
  test("explains how to read a Skill when the protected parent produces ENOTDIR", () => {
    const hint = backend.hintForBlockedOutput!(
      "cat: /home/user/.code-shell/skills/research/SKILL.md: Not a directory",
    );

    expect(hint).toContain("read or write");
    expect(hint).toContain("SKILL.md with the Skill tool");
    expect(hint).toContain("Read or Grep");
    expect(hint).toContain("On Linux");
    expect(hint).not.toContain("sandbox.mode");
  });

  test("keeps actionable diagnostics for permission denials", () => {
    for (const error of ["Permission denied", "Operation not permitted"]) {
      expect(backend.hintForBlockedOutput!(`cat: /protected/guide.md: ${error}`)).toContain(
        "[sandbox:bwrap]",
      );
    }
  });

  test("does not diagnose an ordinary missing reference as a sandbox failure", () => {
    expect(
      backend.hintForBlockedOutput!("cat: /workspace/missing.md: No such file or directory"),
    ).toBeUndefined();
  });

  test("retains the protected directory mount without adding a Skill exception", () => {
    const wrapped = backend.wrap("cat /home/user/.code-shell/skills/research/SKILL.md", {
      cwd: "/workspace",
      shell: "/bin/bash",
    });
    const denyIndex = wrapped.args.indexOf("--ro-bind-try");

    expect(wrapped.args.slice(denyIndex, denyIndex + 3)).toEqual([
      "--ro-bind-try",
      "/dev/null",
      "/home/user/.code-shell",
    ]);
    expect(wrapped.args.filter((arg) => arg === "--ro-bind")).toHaveLength(1);
    expect(wrapped.args).not.toContain("--ro-bind-fd");
  });
});
