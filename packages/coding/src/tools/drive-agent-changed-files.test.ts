import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveChangedFiles, normalizeChangedFiles } from "./drive-agent-changed-files.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("normalizeChangedFiles", () => {
  test("gives in-workspace files one cwd-relative identity and keeps outside files absolute", () => {
    expect(
      normalizeChangedFiles("/repo", [
        "/repo/src/a.ts",
        "src/a.ts",
        " src/b.ts ",
        "/etc/hosts",
        "",
      ]),
    ).toEqual(["src/a.ts", "src/b.ts", "/etc/hosts"]);
  });

  test("a path reported through the resolved spelling of a symlinked cwd is in the workspace", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-changed-files-")));
    dirs.push(root);
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(
      normalizeChangedFiles(join(root, "link"), [join(root, "real", "note.txt"), "note.txt"]),
    ).toEqual(["note.txt"]);
    // And the other way round: the cwd resolved, the report through the link.
    expect(normalizeChangedFiles(join(root, "real"), [join(root, "link", "gone", "x.ts")])).toEqual(
      [join("gone", "x.ts")],
    );
    expect(normalizeChangedFiles(join(root, "real"), [join(root, "other.ts")])).toEqual([
      join(root, "other.ts"),
    ]);
  });
});

describe("driveChangedFiles", () => {
  test("merges what the CLI reported with what its transcript names", () => {
    const seen: string[][] = [];
    const read = (cli: string, cwd: string, sessionId: string) => {
      seen.push([cli, cwd, sessionId]);
      return ["src/a.ts", "/repo/src/c.ts"];
    };
    expect(
      driveChangedFiles(
        "codex",
        "/repo",
        { sessionId: "thread-1", changedFiles: ["/repo/src/a.ts", "/repo/src/b.ts"] },
        read,
      ),
    ).toEqual({ rawSize: 4, files: ["src/a.ts", "src/b.ts", "src/c.ts"] });
    expect(seen).toEqual([["codex", "/repo", "thread-1"]]);
  });

  test("a run with no session has no transcript to read but keeps its own report", () => {
    const read = () => {
      throw new Error("must not look for a transcript");
    };
    expect(
      driveChangedFiles("codex", "/repo", { sessionId: "", changedFiles: ["a.ts"] }, read),
    ).toEqual({ rawSize: 1, files: ["a.ts"] });
    expect(driveChangedFiles("claude", "/repo", { sessionId: "" }, read)).toEqual({
      rawSize: 0,
      files: [],
    });
  });
});
