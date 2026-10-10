import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../../scripts/bun-test-completion.mjs";

describe("project memory manual copy interactions", () => {
  test.each([
    "project-user-copy",
    "project-dream-copy",
    "entrypoint-scope",
    "cancel-review",
    "cancel-pending-preview",
    "stale-preview-project",
    "stale-confirmation-scope",
    "source-switch",
    "stale-profile-list",
    "preview-lock",
    "commit-lock",
    "rename-after-conflict",
    "legacy-empty-description",
    "legacy-empty-content",
    "server-review-draft",
    "retry-profile-list",
    "cancel-dialog-pending-preview",
    "commit-dialog-close-lock",
    "rename-after-commit-conflict",
  ])("%s", (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "codeshell-memory-promotion-ui-"));
    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          fileURLToPath(
            new URL("./ProfileMemoryPromotionDialog.interaction.fixture.tsx", import.meta.url),
          ),
          scenario,
        ],
        env: createBunTestEnvironment(process.env, directory),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      });
      expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(JSON.parse(result.stdout.toString())).toMatchObject({
        scenario,
        passed: true,
        unexpectedDenials: 0,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
