import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

test("foreground managed worktree captures completion provenance before discard", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-foreground-prov-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(root, "tracked.txt"), "initial");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-qm", "initial");
    let runnerCwd = "",
      reads = 0,
      probes = 0;
    const records: unknown[] = [];
    const tool = makeDriveAgentTool(
      async (options) => {
        runnerCwd = options.cwd;
        writeFileSync(join(options.cwd, "tracked.txt"), "changed");
        git(options.cwd, "add", "tracked.txt");
        git(options.cwd, "commit", "-qm", "changed");
        return {
          sessionId: "fixture",
          finalText: "[result](" + join(options.cwd, "tracked.txt") + ")",
          isError: false,
          exitCode: 0,
          lines: [],
        };
      },
      undefined,
      {
        readChangedFiles: () => {
          reads++;
          return ["tracked.txt"];
        },
        probeChangedFiles: async () => {
          probes++;
          return {
            schemaVersion: 1,
            cli: "claude",
            observedAt: 1,
            capture: "completion",
            files: [],
          };
        },
        sessionStore: { get: () => undefined, record: () => undefined },
      },
    );
    const result = await tool(
      {
        prompt: "fixture",
        cwd: root,
        background: false,
        isolation: "worktree",
        cleanup: "discard",
      },
      {
        sessionId: "foreground-provenance",
        cwd: root,
        recordExternalFileChanges: (r: any) => records.push(r),
      } as any,
    );
    expect(result).toContain("完成");
    expect(reads).toBe(1);
    expect(probes).toBe(1);
    expect(records).toHaveLength(1);
    expect(existsSync(runnerCwd)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
