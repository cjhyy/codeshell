import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

describe("forked turn diff evidence", () => {
  test("remaps the logical turn and run anchors without leaking evidence into model messages", () => {
    const root = mkdtempSync(join(tmpdir(), "fork-turn-diff-"));
    try {
      const manager = new SessionManager(root);
      const source = manager.create("/project", "model", "provider", "source-diff");
      const turnId = source.transcript.appendMessage("user", "change file").id;
      source.transcript.appendMessage("assistant", "changed");
      source.transcript.append("turn_diff", {
        type: "turn_diff",
        turnId,
        runId: turnId,
        cwd: "/project",
        complete: true,
        files: [
          {
            path: "/project/a.ts",
            status: "modified",
            diff: "PRIVATE_DIFF_EVIDENCE",
            added: 1,
            removed: 1,
          },
        ],
        trackedPaths: ["/project/a.ts"],
        toolCallIds: ["edit-1"],
        omissions: [],
      });
      const forked = manager.fork("source-diff", { targetSessionId: "forked-diff" });
      const copiedUser = forked.bundle.transcript.getEvents("message")[0]!;
      const copiedDiff = forked.bundle.transcript.getEvents("turn_diff")[0]!;
      expect(copiedUser.id).not.toBe(turnId);
      expect(copiedDiff.data.turnId).toBe(copiedUser.id);
      expect(copiedDiff.data.runId).toBe(copiedUser.id);
      expect(source.transcript.getEvents("turn_diff")[0]!.data.turnId).toBe(turnId);
      expect(JSON.stringify(forked.bundle.transcript.toMessages())).not.toContain(
        "PRIVATE_DIFF_EVIDENCE",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
