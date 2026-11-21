import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWorkspaceProfile } from "@cjhyy/code-shell-core/internal";
import { deleteMemory, listMemory, readMemory, saveMemory } from "./memory-service.js";

describe("digital-human profile memory", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "desktop-profile-memory-"));
    previousHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = root;
    saveWorkspaceProfile({
      name: "pm",
      label: "Product manager",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: true,
    });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  test("revocation at the write boundary preserves existing profile memory", () => {
    const input = {
      level: "profile",
      scope: "user",
      profileName: "pm",
      name: "Stable",
      description: "approved",
      type: "reference",
      content: "original",
    } as const;
    saveMemory(input);
    const deny = () => {
      throw new Error("revoked");
    };
    const current = readMemory("profile", "user", "Stable", undefined, "pm")!;
    expect(() => saveMemory({ ...input, id: current.id, content: "withheld" }, deny)).toThrow(
      "revoked",
    );
    expect(() => deleteMemory("profile", "user", "Stable", undefined, "pm", deny)).toThrow(
      "revoked",
    );
    expect(readMemory("profile", "user", "Stable", undefined, "pm")?.content).toBe(current.content);
  });
  test("edits a store isolated under the selected profile", () => {
    saveMemory({
      level: "profile",
      scope: "user",
      profileName: "pm",
      name: "PRD review habits",
      description: "Checks before handoff",
      type: "reference",
      content: "Confirm acceptance criteria and unresolved questions.",
    });

    expect(listMemory("profile", "user", undefined, "pm")).toHaveLength(1);
    expect(readMemory("profile", "user", "PRD review habits", undefined, "pm")?.content).toContain(
      "acceptance criteria",
    );
    expect(listMemory("user", "user")).toEqual([]);
    expect(deleteMemory("profile", "user", "PRD review habits", undefined, "pm")).toBe(true);
  });

  test("requires an existing profile", () => {
    expect(() => listMemory("profile", "user", undefined, "missing")).toThrow("does not exist");
  });
});
