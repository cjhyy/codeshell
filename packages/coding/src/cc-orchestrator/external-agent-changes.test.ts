import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractChangedFilesFromClaudeLines,
  extractChangedFilesFromCodexLines,
  readClaudeChangedFiles,
  readCodexChangedFiles,
} from "./external-agent-changes.js";

/**
 * #6: a background DriveAgent runs an external CLI whose Edit/Write land in the
 * external transcript, invisible to the host. Given the external session id +
 * cwd, the host reads that transcript and extracts the changed-file list so the
 * UI can attribute "N files edited". Parsing must be tolerant: a malformed line
 * is skipped, not fatal.
 */
describe("extractChangedFilesFromClaudeLines", () => {
  const line = (name: string, input: Record<string, unknown>) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name, input }] },
    });

  test("extracts Write/Edit/MultiEdit/NotebookEdit file paths, deduped", () => {
    const lines = [
      line("Write", { file_path: "/repo/a.ts", content: "x" }),
      line("Edit", { file_path: "/repo/a.ts", old_string: "x", new_string: "y" }),
      line("Edit", { file_path: "/repo/b.ts", old_string: "1", new_string: "2" }),
      line("NotebookEdit", { notebook_path: "/repo/n.ipynb" }),
      line("Read", { file_path: "/repo/ignored.ts" }),
    ].join("\n");
    const files = extractChangedFilesFromClaudeLines(lines);
    expect(files.sort()).toEqual(["/repo/a.ts", "/repo/b.ts", "/repo/n.ipynb"].sort());
  });

  test("skips malformed / non-tool lines without throwing", () => {
    const lines = [
      "not json at all",
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      line("Write", { file_path: "/repo/only.ts", content: "z" }),
      "{ broken",
    ].join("\n");
    expect(extractChangedFilesFromClaudeLines(lines)).toEqual(["/repo/only.ts"]);
  });

  test("empty input → empty list", () => {
    expect(extractChangedFilesFromClaudeLines("")).toEqual([]);
  });
});

describe("extractChangedFilesFromCodexLines", () => {
  const fnCall = (name: string, args: Record<string, unknown>) =>
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", name, arguments: JSON.stringify(args) },
    });

  test("extracts file paths from write/edit function calls", () => {
    const lines = [
      fnCall("write_file", { file_path: "/repo/x.ts" }),
      fnCall("edit_file", { path: "/repo/y.ts" }),
      fnCall("shell", { command: "ls" }), // non-write tool ignored
    ].join("\n");
    expect(extractChangedFilesFromCodexLines(lines).sort()).toEqual(
      ["/repo/x.ts", "/repo/y.ts"].sort(),
    );
  });

  test("extracts file paths from an apply_patch header block", () => {
    const patch =
      "*** Begin Patch\n*** Update File: /repo/a.ts\n@@\n-1\n+2\n*** Add File: /repo/b.ts\n*** End Patch";
    const line = JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call", name: "apply_patch", input: patch },
    });
    expect(extractChangedFilesFromCodexLines(line).sort()).toEqual(
      ["/repo/a.ts", "/repo/b.ts"].sort(),
    );
  });

  test("attributes an apply_patch rename to both source and destination", () => {
    const patch =
      "*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-old\n+new\n*** End Patch";
    const line = JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call", name: "apply_patch", input: patch },
    });
    expect(extractChangedFilesFromCodexLines(line)).toEqual(["src/old.ts", "src/new.ts"]);
  });

  test("malformed / non-response lines skipped", () => {
    expect(extractChangedFilesFromCodexLines("junk\n{ broken")).toEqual([]);
  });
});

describe("readClaudeChangedFiles (locates the transcript by cwd + sid)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cs-extchg-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("reads <claudeHome>/projects/<encodeCwd>/<sid>.jsonl and returns changed files", () => {
    const cwd = "/Users/x/proj";
    const sid = "sess-123";
    const projectsDir = join(home, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, `${sid}.jsonl`),
      [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "Write", input: { file_path: "/Users/x/proj/src/a.ts" } },
            ],
          },
        }),
      ].join("\n"),
    );
    const files = readClaudeChangedFiles(cwd, sid, home);
    expect(files).toEqual(["/Users/x/proj/src/a.ts"]);
  });

  test("missing transcript → empty list (no throw)", () => {
    expect(readClaudeChangedFiles("/no/where", "nope", home)).toEqual([]);
  });
});

describe("readCodexChangedFiles (locates the rollout by cwd + thread)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cs-extchg-codex-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("reads the newest rollout of a resumed thread", () => {
    const cwd = "/repo";
    const dir = join(home, "sessions", "2026", "10", "17");
    mkdirSync(dir, { recursive: true });
    const write = (name: string, path: string): string => {
      const file = join(dir, name);
      writeFileSync(
        file,
        [
          JSON.stringify({ type: "session_meta", payload: { id: "thread-1", cwd } }),
          JSON.stringify({
            type: "response_item",
            payload: { type: "function_call", name: "write_file", arguments: `{"path":"${path}"}` },
          }),
        ].join("\n"),
      );
      return file;
    };
    const fileA = write("rollout-a.jsonl", "/repo/a.ts");
    const fileB = write("rollout-b.jsonl", "/repo/b.ts");
    const older = new Date("2026-10-16T00:00:00Z");
    const newer = new Date("2026-10-17T00:00:00Z");
    // Exercise both mtime orders so the result cannot depend on readdir order.
    for (const [oldFile, newFile, expected] of [
      [fileA, fileB, "/repo/b.ts"],
      [fileB, fileA, "/repo/a.ts"],
    ] as const) {
      utimesSync(oldFile, older, older);
      utimesSync(newFile, newer, newer);
      expect(readCodexChangedFiles(cwd, "thread-1", home)).toEqual([expected]);
    }
  });
});
