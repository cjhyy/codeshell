import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager";

describe("SessionManager digital-human reference scan", () => {
  test("finds bounded regular state files and isolates unsafe entries", () => {
    const root = mkdtempSync(join(tmpdir(), "session-profile-references-"));
    try {
      const manager = new SessionManager(root);
      for (const [id, workspaceProfile] of [
        ["session-b", "researcher"],
        ["session-a", "researcher"],
        ["session-c", "developer"],
      ] as const) {
        mkdirSync(join(root, id));
        writeFileSync(join(root, id, "state.json"), JSON.stringify({ workspaceProfile }));
      }
      mkdirSync(join(root, "qchat-ignored"));
      writeFileSync(
        join(root, "qchat-ignored", "state.json"),
        JSON.stringify({ workspaceProfile: "researcher" }),
      );
      if (process.platform !== "win32") {
        const outside = join(root, "outside-state.json");
        writeFileSync(outside, JSON.stringify({ workspaceProfile: "researcher" }));
        mkdirSync(join(root, "session-linked"));
        symlinkSync(outside, join(root, "session-linked", "state.json"));
      }

      expect(manager.findSessionIdsByWorkspaceProfile("researcher")).toEqual([
        "session-a",
        "session-b",
      ]);
      expect(manager.findSessionIdsByWorkspaceProfile("researcher", 1)).toHaveLength(1);
      expect(manager.findSessionIdsByWorkspaceProfile("developer")).toEqual(["session-c"]);
      expect(manager.findSessionIdsByWorkspaceProfile("")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
