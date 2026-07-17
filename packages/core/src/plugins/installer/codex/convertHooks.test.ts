import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyCodexHooks } from "./convertHooks.js";

describe("copyCodexHooks", () => {
  let sourceDir: string;
  let destDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "cs-codex-hooks-source-"));
    destDir = mkdtempSync(join(tmpdir(), "cs-codex-hooks-dest-"));
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });

  test("no-ops for the default hooks/hooks.json declaration", async () => {
    await copyCodexHooks(sourceDir, destDir, undefined);
    expect(existsSync(join(destDir, "hooks", "hooks.json"))).toBe(false);
  });

  test("copies a manifest-referenced hooks file into the canonical location", async () => {
    mkdirSync(join(sourceDir, "config"), { recursive: true });
    writeFileSync(
      join(sourceDir, "config", "lifecycle.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: "command", command: "$PLUGIN_ROOT/start.mjs" }],
            },
          ],
        },
      }),
    );

    await copyCodexHooks(sourceDir, destDir, "./config/lifecycle.json");

    const installed = JSON.parse(readFileSync(join(destDir, "hooks", "hooks.json"), "utf-8"));
    expect(installed.hooks.SessionStart[0].hooks[0].command).toBe("$PLUGIN_ROOT/start.mjs");
  });

  test("merges path and inline declarations without dropping event groups", async () => {
    writeFileSync(
      join(sourceDir, "one.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Write",
              hooks: [{ type: "command", command: "one" }],
            },
          ],
        },
      }),
    );

    await copyCodexHooks(sourceDir, destDir, [
      "./one.json",
      {
        hooks: {
          PostToolUse: [
            {
              matcher: "Edit",
              hooks: [{ type: "command", command: "two" }],
            },
          ],
          Stop: [{ hooks: [{ type: "command", command: "stop" }] }],
        },
      },
    ]);

    const installed = JSON.parse(readFileSync(join(destDir, "hooks", "hooks.json"), "utf-8"));
    expect(installed.hooks.PostToolUse).toHaveLength(2);
    expect(installed.hooks.Stop).toHaveLength(1);
  });

  test("accepts an unwrapped inline event map", async () => {
    await copyCodexHooks(sourceDir, destDir, {
      SessionStart: [{ hooks: [{ type: "command", command: "start" }] }],
    });
    const installed = JSON.parse(readFileSync(join(destDir, "hooks", "hooks.json"), "utf-8"));
    expect(installed.hooks.SessionStart).toHaveLength(1);
  });

  test("rejects hook paths and symlinks that escape the plugin root", async () => {
    const outside = join(destDir, "outside.json");
    writeFileSync(outside, JSON.stringify({ hooks: {} }));
    symlinkSync(outside, join(sourceDir, "escape.json"));

    await expect(copyCodexHooks(sourceDir, destDir, "../outside.json")).rejects.toThrow(
      /escapes plugin dir/,
    );
    await expect(copyCodexHooks(sourceDir, destDir, "./escape.json")).rejects.toThrow(
      /escapes plugin dir/,
    );
  });
});
