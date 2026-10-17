import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const scenario of [
  "delete-file-send",
  "delete-file-queue",
  "delete-file-force",
  "delete-recent-send",
  "delete-recent-force",
  "spaces-unicode",
  "recent-preserved",
  "duplicate",
  "suffix",
  "space-suffix",
  "paste-suffix",
  "clear-restore",
  "explicit-attachments",
  "compact-clear",
]) {
  test(`real ChatView mention references: ${scenario}`, () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./ChatView.mention-references.fixture.tsx", import.meta.url)),
        scenario,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(result.stdout.toString()).toContain('"passed":true');
  });
}
