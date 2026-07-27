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

  test("can skip archived Sessions, which are history rather than live bindings", () => {
    const root = mkdtempSync(join(tmpdir(), "session-profile-archived-"));
    try {
      const manager = new SessionManager(root);
      mkdirSync(join(root, "session-live"));
      writeFileSync(
        join(root, "session-live", "state.json"),
        JSON.stringify({ workspaceProfile: "researcher" }),
      );
      mkdirSync(join(root, "session-archived"));
      writeFileSync(
        join(root, "session-archived", "state.json"),
        JSON.stringify({ workspaceProfile: "researcher", archivedAt: 1785137194100 }),
      );

      // Default stays inclusive so existing callers keep their semantics.
      expect(manager.findSessionIdsByWorkspaceProfile("researcher")).toEqual([
        "session-archived",
        "session-live",
      ]);
      expect(
        manager.findSessionIdsByWorkspaceProfile("researcher", 20, { includeArchived: false }),
      ).toEqual(["session-live"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
