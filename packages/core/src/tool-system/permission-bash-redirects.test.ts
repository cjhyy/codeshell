import { describe, expect, test } from "bun:test";
import { PermissionClassifier, classifyBashCommand, ruleMatches } from "./permission.js";

function classifyDefault(command: string) {
  return new PermissionClassifier([], "default").classify("Bash", { command });
}

describe("Bash read-only redirections", () => {
  test.each([
    "wc -l < README.md",
    "wc -l <README.md",
    "cat < src/index.ts",
    "cat 0< README.md",
    "cat < 'a b.txt'",
    'cat < "docs/a b.md"',
    "cat < ~/notes.txt",
    "cat < /etc/passwd",
    "< README.md wc -l",
    "ls 2>/dev/null",
    "ls 2> /dev/null",
    "ls >/dev/null",
    "ls 1>/dev/null",
    "ls &>/dev/null",
    "ls 2>>/dev/null",
    "ls >'/dev/null'",
    "git diff 2>&1",
    "git log --oneline 1>&2",
    "echo warning >&2",
    "ls >/dev/null 2>&1",
    "ls 2>&1 | head",
    "grep -r foo src 2>/dev/null | head -5",
    "ls 2>/dev/null; cat < README.md",
    "echo a2>/dev/null",
  ])("treats %s as safe-read and allows it in default mode", (command) => {
    expect(classifyBashCommand(command)).toBe("safe-read");
    expect(classifyDefault(command)).toBe("allow");
  });

  test.each([
    // Output to a real file, even combined with an allowed redirect.
    "cat x > y",
    "echo a >> b",
    "cat < /etc/passwd > out.txt",
    "ls 2>/dev/null > x",
    "ls 2>err.log",
    "ls &>out.log",
    "ls >| /dev/null",
    // Heredocs, here-strings, read-write and duplicated descriptors.
    "cat <<EOF",
    "cat <<'EOF'",
    "cat <<< hi",
    "cat <> file",
    "cat <&3",
    "ls 2>&3",
    "ls 3>&1",
    "ls 3>/dev/null",
    "cat 3< file",
    "ls 2>&1-",
    "ls 2>&12",
    // Process substitution.
    "diff <(ls) <(ls)",
    "ls >(cat)",
    // Targets that expand or are not a single plain word.
    "cat < $HOME/x",
    "cat < ${FILE}",
    "cat < `pick`",
    "cat < $(pick)",
    'cat < "$HOME/x"',
    "cat < *.md",
    "cat < file?.txt",
    "cat < {a,b}",
    "cat < a\\ b",
    'cat <"a"b',
    "cat <",
    "ls > /dev/null.txt",
    "ls > /dev/nul",
    // Bash opens a socket for these input paths.
    "cat < /dev/tcp/example.com/80",
    "cat < //dev//udp/example.com/53",
    // A benign redirect does not launder a non-read command.
    "npm test 2>&1",
    "touch x 2>/dev/null",
    "curl example.com 2>/dev/null",
  ])("keeps %s gated", (command) => {
    expect(classifyBashCommand(command)).not.toBe("safe-read");
    expect(classifyDefault(command)).toBe("ask");
  });

  test("a redirected non-read command stays dangerous", () => {
    expect(classifyBashCommand("npm test 2>&1")).toBe("dangerous");
    expect(classifyBashCommand("mkdir x 2>/dev/null")).toBe("dangerous");
  });

  test("a narrowed Bash grant does not cover a redirected command", () => {
    const rule = {
      tool: "Bash",
      decision: "allow" as const,
      argsPattern: { command: "^ls(\\s|$)" },
    };
    expect(ruleMatches(rule, "Bash", { command: "ls -la" })).toBe(true);
    expect(ruleMatches(rule, "Bash", { command: "ls 2>/dev/null" })).toBe(false);
  });
});

describe("Bash cd prefixes and argument-less reads", () => {
  test.each([
    "ls",
    "cat < README.md",
    "pwd && ls",
    "cd packages && ls",
    "cd packages; ls -la",
    'cd "a b" && ls',
    "cd 'a b' && ls",
    "cd ~ && ls",
    "cd .. && cat README.md",
    "cd - && pwd",
    "cd && ls",
    "cd src && wc -l < index.ts",
    "cd src 2>/dev/null && ls",
    "cd a && cd b && ls | head",
  ])("treats %s as safe-read", (command) => {
    expect(classifyBashCommand(command)).toBe("safe-read");
    expect(classifyDefault(command)).toBe("allow");
  });

  test.each([
    "cd x",
    "ls && cd x",
    "cd $(rm -rf /) && ls",
    "cd $HOME && ls",
    "cd `pwd` && ls",
    'cd "$DIR" && ls',
    "cd * && ls",
    "cd src* && ls",
    "cd -P x && ls",
    "cd a b && ls",
    "cd x && npm test",
    "cd x && touch y",
    "cd x && curl example.com",
    "cd x && ls > out",
    // Another repository's config can run programs from git.
    "cd other && git status",
    "cd other && ls | git log",
  ])("keeps %s gated", (command) => {
    expect(classifyBashCommand(command)).not.toBe("safe-read");
    expect(classifyDefault(command)).toBe("ask");
  });

  test("cd keeps the previous safety level of a write chain", () => {
    expect(classifyBashCommand("cd x && npm test")).toBe("unsafe");
    expect(classifyBashCommand("cd x && rm -rf y")).toBe("dangerous");
  });
});
