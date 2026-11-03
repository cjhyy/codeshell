import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  backgroundJobRegistry,
  notificationQueue,
  type ExternalChangedFilesProvenance,
} from "@cjhyy/code-shell-core/extension";
import { makeDriveAgentTool, driveAgentJobsTool } from "./drive-agent.js";

for (const action of ["cancel", "drop"] as const)
  test(`${action} during provenance observation does not publish a stale successful completion`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "drive-provenance-gap-"));
    const sessionId = `provenance-gap-${action}`;
    let resume!: (value: ExternalChangedFilesProvenance) => void;
    const records: unknown[] = [];
    let observed!: () => void;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    try {
      const tool = makeDriveAgentTool(
        async () => ({
          sessionId: "external",
          finalText: "done",
          isError: false,
          exitCode: 0,
          lines: [],
        }),
        undefined,
        {
          readChangedFiles: () => ["file.ts"],
          probeChangedFiles: async () =>
            new Promise((resolve) => {
              resume = resolve;
              observed();
            }),
          sessionStore: { get: () => undefined, record: () => undefined },
        },
      );
      await tool({ prompt: "fixture", cwd }, {
        sessionId,
        cwd,
        recordExternalFileChanges: (record) => records.push(record),
      } as any);
      await started;
      expect(typeof resume).toBe("function");
      const job = backgroundJobRegistry.listForSession(sessionId)[0]!;
      const cancellation =
        action === "cancel"
          ? driveAgentJobsTool({ action: "cancel", jobId: job.jobId })
          : undefined;
      if (action === "drop") backgroundJobRegistry.dropForSession(sessionId);
      expect(notificationQueue.getSnapshot(sessionId)).toHaveLength(0);
      resume({
        schemaVersion: 1,
        cli: "claude",
        observedAt: 123,
        capture: "completion",
        files: [{ path: "file.ts", absolutePath: join(cwd, "file.ts"), presence: "missing" }],
      });
      await cancellation;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const notifications = notificationQueue.getSnapshot(sessionId);
      if (action === "cancel") {
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({ status: "cancelled", changedFiles: ["file.ts"] });
        expect(records).toHaveLength(1);
      } else {
        expect(notifications).toHaveLength(0);
        expect(records).toHaveLength(0);
      }
    } finally {
      backgroundJobRegistry.reset();
      notificationQueue.reset(sessionId);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
