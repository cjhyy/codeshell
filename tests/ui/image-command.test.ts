import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../../packages/tui/src/cli/commands/registry.js";
import {
  imageCommand,
  parsePaths,
} from "../../packages/tui/src/cli/commands/builtin/image-command.js";

const DOCUMENTED_MAX_IMAGE_BYTES = 2 * 1024 * 1024;

describe("parsePaths", () => {
  test("splits on whitespace", () => {
    expect(parsePaths("foo.png bar.jpg baz.gif")).toEqual(["foo.png", "bar.jpg", "baz.gif"]);
  });

  test("returns empty for empty/whitespace arg", () => {
    expect(parsePaths("")).toEqual([]);
    expect(parsePaths("   ")).toEqual([]);
  });

  test("accepts a single path", () => {
    expect(parsePaths("just-one.png")).toEqual(["just-one.png"]);
  });

  test("preserves spaces inside double quotes", () => {
    expect(parsePaths(`"name with spaces.png"`)).toEqual(["name with spaces.png"]);
  });

  test("mixes quoted and unquoted", () => {
    expect(parsePaths(`a.png "b c.jpg" /tmp/d.gif`)).toEqual(["a.png", "b c.jpg", "/tmp/d.gif"]);
  });

  test("tolerates extra whitespace between args", () => {
    expect(parsePaths(`  a.png   b.jpg  `)).toEqual(["a.png", "b.jpg"]);
  });
});

describe("imageCommand", () => {
  test("rejects oversized images before reading file bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-image-command-"));
    const imagePath = join(dir, "huge.png");
    const queued: string[] = [];
    const statuses: string[] = [];
    writeFileSync(imagePath, "");
    truncateSync(imagePath, DOCUMENTED_MAX_IMAGE_BYTES + 1);
    chmodSync(imagePath, 0o000);

    const ctx = {
      cwd: dir,
      pendingImages: {
        add: (block: string) => queued.push(block),
        clear: () => queued.splice(0),
        list: () => queued,
      },
      addStatus: (message: string) => statuses.push(message),
    } as unknown as CommandContext;

    try {
      imageCommand.execute("huge.png", ctx);
    } finally {
      chmodSync(imagePath, 0o600);
      rmSync(dir, { recursive: true, force: true });
    }

    const output = statuses.join("\n");
    expect(queued).toEqual([]);
    expect(output).toContain("超过单图上限");
    expect(output).not.toContain("读取失败");
  });
});
