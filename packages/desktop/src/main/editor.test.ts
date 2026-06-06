import { describe, expect, test } from "bun:test";
import {
  editorCandidates,
  splitTarget,
  buildEditorInvocation,
} from "./editor";

describe("editorCandidates", () => {
  test("uses CODE_SHELL_EDITOR when set", () => {
    expect(editorCandidates("subl")).toEqual(["subl"]);
    expect(editorCandidates("  webstorm  ")).toEqual(["webstorm"]);
  });
  test("falls back to cursor then code when unset", () => {
    expect(editorCandidates(undefined)).toEqual(["cursor", "code"]);
    expect(editorCandidates("")).toEqual(["cursor", "code"]);
  });
});

describe("splitTarget", () => {
  test("plain path", () => {
    expect(splitTarget("/a/b.ts")).toEqual({ path: "/a/b.ts" });
  });
  test("path with line", () => {
    expect(splitTarget("/a/b.ts:42")).toEqual({ path: "/a/b.ts", line: 42 });
  });
  test("path with line and col", () => {
    expect(splitTarget("/a/b.ts:42:7")).toEqual({
      path: "/a/b.ts",
      line: 42,
      col: 7,
    });
  });
});

describe("buildEditorInvocation", () => {
  test("vscode-family uses --goto with line", () => {
    expect(buildEditorInvocation("code", "/a/b.ts", 42)).toEqual({
      command: "code",
      args: ["--goto", "/a/b.ts:42"],
    });
    expect(buildEditorInvocation("cursor", "/a/b.ts", 42, 7)).toEqual({
      command: "cursor",
      args: ["--goto", "/a/b.ts:42:7"],
    });
  });
  test("vscode-family without a line opens the bare path", () => {
    expect(buildEditorInvocation("cursor", "/a/b.ts")).toEqual({
      command: "cursor",
      args: ["/a/b.ts"],
    });
  });
  test("non-vscode editor ignores the line and opens the path", () => {
    expect(buildEditorInvocation("subl", "/a/b.ts", 42)).toEqual({
      command: "subl",
      args: ["/a/b.ts"],
    });
  });
});
