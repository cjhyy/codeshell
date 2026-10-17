import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TURN_DIFF_LIMITS, TurnDiffTracker } from "./turn-diff.js";

const directories: string[] = [];
function fixture(filename = "a.ts") {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "turn-diff-")));
  directories.push(cwd);
  const path = join(cwd, filename);
  const tracker = new TurnDiffTracker({ cwd, turnId: "turn-1" });
  return { cwd, path, tracker };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Independent patch application invariant, including exact line terminators. */
function applyDiff(before: string, diff: string): string {
  const source = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const output: string[] = [];
  const lines = diff.split("\n");
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(lines[i]);
    if (!header) continue;
    const start = Number(header[1]) - (Number(header[2]) ? 1 : 0);
    output.push(...source.slice(cursor, start));
    cursor = start;
    let oldCount = 0,
      newCount = 0;
    while (i + 1 < lines.length && !lines[i + 1].startsWith("@@ ")) {
      const row = lines[++i];
      if (!/^[ +-]/.test(row)) continue;
      let value = `${row.slice(1)}\n`;
      if (lines[i + 1] === "\\ No newline at end of file") {
        value = value.slice(0, -1);
        i++;
      }
      if (row[0] !== "+") {
        expect(source[cursor++]).toBe(value);
        oldCount++;
      }
      if (row[0] !== "-") {
        output.push(value);
        newCount++;
      }
    }
    expect(oldCount).toBe(Number(header[2]));
    expect(newCount).toBe(Number(header[4]));
    i--;
  }
  output.push(...source.slice(cursor));
  return output.join("");
}

function update(
  tracker: TurnDiffTracker,
  path: string,
  id: string,
  content: string,
  success = true,
) {
  tracker.begin(id, [path]);
  writeFileSync(path, content);
  return tracker.end(id, success)!;
}

describe("TurnDiffTracker", () => {
  it("replaces repeated operations with one original-to-final full-file diff", () => {
    const { path, tracker } = fixture("aB.ts");
    writeFileSync(path, "A\n");
    update(tracker, path, "one", "B\n");
    const result = update(tracker, path, "two", "C\n");
    expect(result.complete).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].diff).toContain("-A\n+C\n");
    expect(result.files[0].diff).not.toMatch(/^[ +-]B$/m);
    expect(result.toolCallIds).toEqual(["one", "two"]);
    expect(applyDiff("A\n", result.files[0].diff)).toBe("C\n");
  });

  it("retains real coordinates and separate distant hunks", () => {
    const { path, tracker } = fixture();
    const lines = Array.from({ length: 900 }, (_, i) => `line ${i + 1}\n`);
    const before = lines.join("");
    writeFileSync(path, before);
    lines[399] = "first edit\n";
    update(tracker, path, "one", lines.join(""));
    lines[799] = "second edit\n";
    const result = update(tracker, path, "two", lines.join(""));
    const file = result.files[0];
    expect(file.added).toBe(2);
    expect(file.removed).toBe(2);
    expect(file.diff).toContain("@@ -397,7 +397,7 @@");
    expect(file.diff).toContain("@@ -797,7 +797,7 @@");
    expect(applyDiff(before, file.diff)).toBe(lines.join(""));
  });

  it("keeps an authoritative empty snapshot when edits cancel out", () => {
    const { path, tracker } = fixture();
    writeFileSync(path, "A\n");
    update(tracker, path, "one", "B\n");
    const result = update(tracker, path, "two", "A\n");
    expect(result.files).toEqual([]);
    expect(result.trackedPaths).toEqual([path]);
    expect(result.complete).toBe(true);
  });

  it("distinguishes overwrite from create and counts actual removed lines", () => {
    const { path, tracker } = fixture();
    writeFileSync(path, "old one\nold two\n");
    const file = update(tracker, path, "write", "new\n").files[0];
    expect(file.status).toBe("modified");
    expect(file.added).toBe(1);
    expect(file.removed).toBe(2);
    expect(file.diff).not.toContain("/dev/null");
    expect(applyDiff("old one\nold two\n", file.diff)).toBe("new\n");
  });

  it("shows newly created file at its latest contents", () => {
    const { path, tracker } = fixture();
    update(tracker, path, "create", "initial\n");
    const file = update(tracker, path, "overwrite", "final\n").files[0];
    expect(file.status).toBe("added");
    expect(file.diff).toContain("new file mode 100644");
    expect(file.diff).toContain("--- /dev/null");
    expect(file.diff).not.toContain("initial");
    expect(applyDiff("", file.diff)).toBe("final\n");
  });

  it("removes create-then-delete from net changes and represents an existing deletion", () => {
    const { path, tracker } = fixture();
    update(tracker, path, "create", "initial\n");
    tracker.begin("delete", [path]);
    rmSync(path);
    expect(tracker.end("delete", true)!.files).toEqual([]);
    const other = join(resolve(path, ".."), "b.ts");
    writeFileSync(other, "old\n");
    tracker.begin("delete-existing", [other]);
    rmSync(other);
    const deleted = tracker.end("delete-existing", true)!.files[0];
    expect(deleted.status).toBe("deleted");
    expect(deleted.diff).toContain("+++ /dev/null");
    expect(applyDiff("old\n", deleted.diff)).toBe("");
  });

  it("preserves empty-file creation and deletion metadata", () => {
    const { path, tracker } = fixture();
    const added = update(tracker, path, "create", "").files[0];
    expect(added.status).toBe("added");
    expect(added.added).toBe(0);
    expect(added.diff).toContain("new file mode");
    const fresh = new TurnDiffTracker({ cwd: resolve(path, ".."), turnId: "turn-2" });
    fresh.begin("delete", [path]);
    rmSync(path);
    expect(fresh.end("delete", true)!.files[0].diff).toContain("deleted file mode");
  });

  it("normalizes relative, absolute, and parent-directory aliases", () => {
    const { cwd, path, tracker } = fixture();
    writeFileSync(path, "A\n");
    tracker.begin("one", ["a.ts"]);
    writeFileSync(path, "B\n");
    tracker.end("one", true);
    const result = update(tracker, path, "two", "C\n");
    expect(result.files).toHaveLength(1);
    expect(result.trackedPaths).toEqual([path]);
    if (process.platform !== "win32") {
      const alias = `${cwd}-alias`;
      directories.push(alias);
      symlinkSync(cwd, alias);
      tracker.begin("alias", [join(alias, "a.ts")]);
      writeFileSync(path, "D\n");
      expect(tracker.end("alias", true)!.files).toHaveLength(1);
    }
  });

  it("persists original and latest states across continuation runs", () => {
    const { cwd, path } = fixture();
    const sessionDir = join(cwd, "session");
    writeFileSync(path, "A\n");
    const first = new TurnDiffTracker({ cwd, turnId: "logical-turn", sessionDir });
    update(first, path, "one", "B\n");
    const second = new TurnDiffTracker({ cwd, turnId: "logical-turn", sessionDir });
    const result = update(second, path, "two", "C\n");
    expect(result.files[0].diff).toContain("-A\n+C\n");
    expect(result.toolCallIds).toEqual(["one", "two"]);
    const separate = new TurnDiffTracker({ cwd, turnId: "new-turn", sessionDir });
    expect(update(separate, path, "three", "D\n").files[0].diff).toContain("-C\n+D\n");
  });

  it("drops a failed no-op attempt and captures partial failure mutations", () => {
    const { path, tracker } = fixture();
    writeFileSync(path, "A\n");
    tracker.begin("failed", [path]);
    expect(tracker.end("failed", false)).toBeUndefined();
    writeFileSync(path, "external\n");
    const file = update(tracker, path, "partial", "partial\n", false).files[0];
    expect(file.diff).toContain("-external\n+partial\n");
  });

  it("retains mutations from interleaved starts on the same path", () => {
    const { path, tracker } = fixture();
    writeFileSync(path, "A\n");
    tracker.begin("first", [path]);
    tracker.begin("second", [path]);
    writeFileSync(path, "B\n");
    tracker.end("second", true);
    writeFileSync(path, "C\n");
    const result = tracker.end("first", true)!;
    expect(result.files[0].diff).toContain("-A\n+C\n");
  });

  it("reports binary and oversized files as omissions, never as clean changes", () => {
    const { cwd, path, tracker } = fixture();
    writeFileSync(path, Buffer.from([0, 1, 2]));
    const binary = update(tracker, path, "binary", "new\n");
    expect(binary.complete).toBe(false);
    expect(binary.omissions[0].reason).toBe("binary file");
    expect(binary.files).toEqual([]);
    expect(binary.trackedPaths).toEqual([path]);
    const large = join(cwd, "large.txt");
    writeFileSync(large, "x".repeat(TURN_DIFF_LIMITS.fileBytes + 1));
    expect(update(tracker, large, "large", "small\n").omissions.some((o) => o.path === large)).toBe(
      true,
    );
  });

  it("reports a diff output limit instead of silently clipping", () => {
    const { path, tracker } = fixture();
    writeFileSync(path, `${"a".repeat(TURN_DIFF_LIMITS.fileBytes - 1)}\n`);
    const result = update(
      tracker,
      path,
      "large-diff",
      `${"b".repeat(TURN_DIFF_LIMITS.fileBytes - 1)}\n`,
    );
    expect(result.complete).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.omissions[0].reason).toContain("output limit");
  });

  it("round-trips CRLF and no-final-newline differences without normalizing bytes", () => {
    for (const [before, after] of [
      ["a\r\nb\r\n", "a\r\nB\r\n"],
      ["same", "same\n"],
      ["one\n", "two"],
      ["", "\n"],
    ]) {
      const { path, tracker } = fixture();
      writeFileSync(path, before);
      const diff = update(tracker, path, "edit", after).files[0].diff;
      expect(applyDiff(before, diff)).toBe(after);
    }
  });

  it("quotes platform-valid path labels with spaces, Unicode and POSIX quotes and tabs", () => {
    const { cwd, tracker } = fixture();
    const path = join(cwd, process.platform === "win32" ? "中 文 a.ts" : '中 文\t"a.ts');
    const result = update(tracker, path, "create", "new\n");
    expect(result.files[0].path).toBe(path);
    expect(result.files[0].diff).toContain(
      `diff --git ${JSON.stringify(`a/${path.replaceAll("\\", "/")}`)} ${JSON.stringify(`b/${path.replaceAll("\\", "/")}`)}`,
    );
  });

  it("captures mode-only changes", () => {
    if (process.platform === "win32") return;
    const { path, tracker } = fixture();
    writeFileSync(path, "same\n");
    chmodSync(path, 0o644);
    tracker.begin("chmod", [path]);
    chmodSync(path, 0o755);
    const file = tracker.end("chmod", true)!.files[0];
    expect(file.added).toBe(0);
    expect(file.removed).toBe(0);
    expect(file.diff).toContain("old mode 100644\nnew mode 100755");
  });

  it("fails closed on a corrupted persisted baseline", () => {
    const { cwd, path } = fixture();
    const sessionDir = join(cwd, "session");
    writeFileSync(path, "A\n");
    const first = new TurnDiffTracker({ cwd, turnId: "same", sessionDir });
    update(first, path, "one", "B\n");
    const state = join(sessionDir, "turn-diff", readdirSync(join(sessionDir, "turn-diff"))[0]);
    expect(readFileSync(state, "utf8")).toContain('"content":"A\\n"');
    writeFileSync(state, "corrupt");
    const resumed = new TurnDiffTracker({ cwd, turnId: "same", sessionDir });
    const result = update(resumed, path, "two", "C\n");
    expect(result.complete).toBe(false);
    expect(result.files).toEqual([]);
  });

  it("keeps an interrupted original baseline and marks its latest state unknown", () => {
    const { cwd, path } = fixture();
    const sessionDir = join(cwd, "session");
    writeFileSync(path, "A\n");
    const first = new TurnDiffTracker({ cwd, turnId: "interrupted", sessionDir });
    first.begin("interrupted-tool", [path]);
    writeFileSync(path, "B\n"); // Process exits before end receipt.
    const resumed = new TurnDiffTracker({ cwd, turnId: "interrupted", sessionDir });
    const other = join(cwd, "other.ts");
    const partial = update(resumed, other, "other", "new\n");
    expect(partial.complete).toBe(false);
    expect(
      partial.omissions.some(
        (omission) => omission.path === path && omission.reason.includes("interrupted"),
      ),
    ).toBe(true);
    expect(partial.toolCallIds).toContain("interrupted-tool");
    const resolved = update(resumed, path, "resolved", "C\n");
    expect(resolved.complete).toBe(true);
    expect(resolved.files.find((file) => file.path === path)!.diff).toContain("-A\n+C\n");
  });

  it("does not persist a failed no-op as an interrupted mutation", () => {
    const { cwd, path } = fixture();
    const sessionDir = join(cwd, "session");
    writeFileSync(path, "A\n");
    const first = new TurnDiffTracker({ cwd, turnId: "failed", sessionDir });
    first.begin("failure", [path]);
    expect(first.end("failure", false)).toBeUndefined();
    writeFileSync(path, "external\n");
    const resumed = new TurnDiffTracker({ cwd, turnId: "failed", sessionDir });
    const result = update(resumed, path, "new", "updated\n");
    expect(result.complete).toBe(true);
    expect(result.files[0].diff).toContain("-external\n+updated\n");
  });

  it("limits newline-heavy files before allocating diff rows", () => {
    const { path, tracker } = fixture();
    writeFileSync(path, "\n".repeat(TURN_DIFF_LIMITS.fileLines + 1));
    const result = update(tracker, path, "too-many-lines", "small\n");
    expect(result.complete).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.omissions[0].reason).toBe("line limit exceeded");
  });

  it("keeps two distant edits minimal in a ten-thousand-line file", () => {
    const { path, tracker } = fixture();
    const lines = Array.from({ length: 10_000 }, (_, index) => `line ${index}\n`);
    const before = lines.join("");
    writeFileSync(path, before);
    lines[500] = "first\n";
    lines[9500] = "second\n";
    const file = update(tracker, path, "distant", lines.join("")).files[0];
    expect(file.added).toBe(2);
    expect(file.removed).toBe(2);
    expect(applyDiff(before, file.diff)).toBe(lines.join(""));
  });

  it("produces exact patches for varied additions, deletions and repeated lines", () => {
    const { path, cwd } = fixture();
    let seed = 17;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let run = 0; run < 100; run++) {
      const content = () =>
        Array.from({ length: random() % 20 }, () => `${random() % 5}\n`).join("");
      const before = content(),
        after = content();
      writeFileSync(path, before);
      const tracker = new TurnDiffTracker({ cwd, turnId: `random-${run}` });
      const result = update(tracker, path, "change", after);
      if (before === after) expect(result.files).toEqual([]);
      else expect(applyDiff(before, result.files[0].diff)).toBe(after);
    }
  });

  it("rejects symlink leaves as unavailable rather than reading their targets", () => {
    if (process.platform === "win32") return;
    const { cwd, path, tracker } = fixture();
    writeFileSync(path, "private\n");
    const link = join(cwd, "link.ts");
    symlinkSync(path, link);
    tracker.begin("link", [link]);
    const result = tracker.end("link", true)!;
    expect(result.complete).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.omissions[0].reason).toBe("not a regular file");
  });
});
