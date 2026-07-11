import { describe, expect, test } from "bun:test";
import { PermissionClassifier, classifyBashCommand } from "./permission.js";

function classifyBash(mode: "default" | "acceptEdits" | "bypassPermissions", command: string) {
  return new PermissionClassifier([], mode).classify("Bash", { command });
}

describe("Bash git safe-read gating", () => {
  test.each([
    "git branch -D x",
    "git remote remove origin",
    "git tag -d v1",
    "git branch --force",
    "git branch x",
    "git remote add origin https://example.com/repo.git",
    "git tag v1",
  ])("does not auto-allow a mutating git command in default mode: %s", (command) => {
    expect(classifyBashCommand(command)).not.toBe("safe-read");
    expect(classifyBash("default", command)).not.toBe("allow");
  });

  test.each([
    "git status",
    "git log",
    "git diff",
    "git branch",
    "git branch --list",
    "git remote",
    "git remote -v",
    "git tag",
  ])("keeps a read-only git command auto-allowed in default mode: %s", (command) => {
    expect(classifyBashCommand(command)).toBe("safe-read");
    expect(classifyBash("default", command)).toBe("allow");
  });

  test.each([
    'git status "`git branch -D x`"',
    'git status "$(touch x)"',
    'ls "`touch x`"',
    'cat "$(rm x)"',
  ])("does not auto-allow command substitution inside double quotes: %s", (command) => {
    expect(classifyBashCommand(command)).not.toBe("safe-read");
    expect(classifyBash("default", command)).not.toBe("allow");
  });

  test.each([
    'ls "$' + "\\\n" + '(touch x)"',
    'ls "$' + "\\\r\n" + '(touch x)"',
    'cat "`' + "\\\n" + 'touch x`"',
    'git status "$' + "\\\n" + '(touch x)"',
  ])("normalizes line continuations before detecting command substitution: %s", (command) => {
    expect(classifyBashCommand(command)).toBe("dangerous");
    expect(classifyBash("default", command)).toBe("ask");
  });

  test("keeps ordinary command substitution gated", () => {
    const command = 'ls "$(touch x)"';
    expect(classifyBashCommand(command)).toBe("dangerous");
    expect(classifyBash("default", command)).toBe("ask");
  });

  test("keeps command-substitution syntax literal inside single quotes", () => {
    const command = "git log --grep='`literal`'";
    expect(classifyBashCommand(command)).toBe("safe-read");
    expect(classifyBash("default", command)).toBe("allow");
  });

  test("keeps dollar-paren syntax literal inside single quotes", () => {
    const command = "git log --grep='$(x)'";
    expect(classifyBashCommand(command)).toBe("safe-read");
    expect(classifyBash("default", command)).toBe("allow");
  });

  test("does not normalize a line continuation inside single quotes", () => {
    const command = "git log --grep='$" + "\\\n" + "(x)'";
    expect(classifyBashCommand(command)).toBe("safe-read");
    expect(classifyBash("default", command)).toBe("allow");
  });

  test("keeps a pipeline of read-only commands auto-allowed", () => {
    const command = "git log|grep x";
    expect(classifyBashCommand(command)).toBe("safe-read");
    expect(classifyBash("default", command)).toBe("allow");
  });

  test("keeps a pipeline into a shell gated", () => {
    const command = "git status|sh";
    expect(classifyBashCommand(command)).toBe("dangerous");
    expect(classifyBash("default", command)).toBe("ask");
  });

  test.each([
    "git log --format='x|y'",
    "git branch --format='%(refname)|%(objectname)'",
    "git --no-pager status",
    "git --no-optional-locks status",
  ])("allows a quoted pipe or known-safe git global option: %s", (command) => {
    expect(classifyBashCommand(command)).toBe("safe-read");
    expect(classifyBash("default", command)).toBe("allow");
  });

  test.each(["git -c core.pager=cat status", "git -C repo status", "git --git-dir=.git status"])(
    "keeps an unapproved git global option gated: %s",
    (command) => {
      expect(classifyBashCommand(command)).not.toBe("safe-read");
      expect(classifyBash("default", command)).not.toBe("allow");
    },
  );
});

describe("acceptEdits Bash gating", () => {
  test.each(["npm run x", "npm test", "make"])(
    "requires confirmation for project code execution: %s",
    (command) => {
      expect(classifyBash("acceptEdits", command)).toBe("ask");
    },
  );

  test("does not treat acceptEdits as approval for read-only Bash either", () => {
    expect(classifyBash("acceptEdits", "git status")).toBe("ask");
  });

  test.each(["Write", "Edit"])("continues to auto-allow the %s tool", (toolName) => {
    expect(new PermissionClassifier([], "acceptEdits").classify(toolName, {})).toBe("allow");
  });

  test.each(["npm run x", "npm test", "make"])(
    "continues to allow Bash in bypassPermissions mode: %s",
    (command) => {
      expect(classifyBash("bypassPermissions", command)).toBe("allow");
    },
  );
});
