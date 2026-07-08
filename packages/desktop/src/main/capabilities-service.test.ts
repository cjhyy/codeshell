import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCapabilities } from "./capabilities-service";

describe("desktop capability service", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cs-desktop-cap-cwd-"));
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    writeFileSync(
      join(cwd, ".code-shell", "settings.json"),
      JSON.stringify({
        agent: {
          preset: "terminal-coding",
          enabledBuiltinTools: [],
          disabledBuiltinTools: [],
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("desktop builtin surface shows SwitchSessionWorkspace and hides legacy worktree tools", () => {
    const ids = new Set(listCapabilities(cwd).map((capability) => capability.id));

    expect(ids.has("builtin:SwitchSessionWorkspace")).toBe(true);
    expect(ids.has("builtin:EnterWorktree")).toBe(false);
    expect(ids.has("builtin:ExitWorktree")).toBe(false);
  });
});
