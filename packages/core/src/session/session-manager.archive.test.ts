import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

function tempManager(): { manager: SessionManager; root: string } {
  const root = mkdtempSync(join(tmpdir(), "cs-archive-"));
  return { manager: new SessionManager(join(root, "sessions")), root };
}

describe("SessionManager archive marker", () => {
  test("archive sets a durable timestamp and unarchive clears it", () => {
    const { manager, root } = tempManager();
    try {
      const { state } = manager.create(join(root, "proj"), "m", "p");
      expect(manager.readSessionArchivedAt(state.sessionId)).toBeUndefined();

      manager.setSessionArchived(state.sessionId, 1_700_000_000_000);
      expect(manager.readSessionArchivedAt(state.sessionId)).toBe(1_700_000_000_000);

      manager.setSessionArchived(state.sessionId, undefined);
      expect(manager.readSessionArchivedAt(state.sessionId)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("readSessionArchivedAt returns undefined for an unsafe or missing id", () => {
    const { manager, root } = tempManager();
    try {
      expect(manager.readSessionArchivedAt("../escape")).toBeUndefined();
      expect(manager.readSessionArchivedAt("does-not-exist")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
