import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createCodingModule } from "./index.capability.js";

describe("coding file mutation targets", () => {
  test("ApplyPatch supplies complete diff targets independently of undo targets", () => {
    const contribution = createCodingModule().engine?.fileHistory?.find(
      (item) => item.toolName === "ApplyPatch",
    );
    const args = {
      patch: "*** Begin Patch\n*** Add File: new.ts\n+created\n*** End Patch",
    };
    expect(contribution?.resolveTargets(args, "/repo")).toEqual([]);
    expect(contribution?.resolveDiffTargets?.(args, "/repo")).toEqual([resolve("/repo", "new.ts")]);
    expect(contribution?.resolveDiffTargets?.({}, "/repo")).toEqual([]);
  });

  test("NotebookEdit tracks only mutating actions", () => {
    const contribution = createCodingModule().engine?.fileHistory?.find(
      (item) => item.toolName === "NotebookEdit",
    );
    expect(contribution).toBeDefined();
    for (const action of ["insert", "replace", "delete"]) {
      const args = { action, file_path: "./notebooks/../book.ipynb" };
      expect(contribution?.resolveTargets(args, "/repo")).toEqual([resolve("/repo", "book.ipynb")]);
      expect(contribution?.resolveDiffTargets?.(args, "/repo")).toEqual([
        resolve("/repo", "book.ipynb"),
      ]);
    }
    for (const args of [
      { action: "read", file_path: "book.ipynb" },
      { action: "unknown", file_path: "book.ipynb" },
      { action: "replace" },
      { action: "insert", file_path: "" },
    ]) {
      expect(contribution?.resolveTargets(args, "/repo")).toEqual([]);
      expect(contribution?.resolveDiffTargets?.(args, "/repo")).toEqual([]);
    }
  });
});
