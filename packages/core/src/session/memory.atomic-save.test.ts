import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryManager } from "./memory.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MemoryManager atomic body writes", () => {
  it("readers observe only complete old or new bodies during repeated replacement", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "codeshell-memory-atomic-"));
    roots.push(baseDir);
    const manager = new MemoryManager({ baseDir, scope: "user" });
    const bodyA = `BEGIN-A\n${"a".repeat(256 * 1024)}\nEND-A`;
    const bodyB = `BEGIN-B\n${"b".repeat(256 * 1024)}\nEND-B`;
    const fileName = manager.save({
      name: "atomic",
      description: "atomic replacement",
      type: "project",
      content: bodyA,
    });
    const id = manager.loadAll()[0]!.id!;
    const file = join(baseDir, "memory", "user", fileName);
    // The writer rebuilds both bodies from their own source rather than
    // receiving them inline. Embedding two 256 KiB strings made the -e argument
    // ~512 KiB, and Linux caps a single argv entry at MAX_ARG_STRLEN (128 KiB),
    // so Bun.spawn failed with E2BIG on CI while macOS's far larger limit let
    // it pass locally. Writing the script to a file keeps argv tiny.
    const scriptPath = join(baseDir, "writer.ts");
    writeFileSync(
      scriptPath,
      `
      import { MemoryManager } from ${JSON.stringify(join(import.meta.dir, "memory.ts"))};
      const manager = new MemoryManager({ baseDir: ${JSON.stringify(baseDir)}, scope: "user" });
      const bodies = [
        \`BEGIN-A\\n\${"a".repeat(256 * 1024)}\\nEND-A\`,
        \`BEGIN-B\\n\${"b".repeat(256 * 1024)}\\nEND-B\`,
      ];
      for (let index = 0; index < 40; index += 1) {
        manager.save({
          id: ${JSON.stringify(id)},
          name: "atomic",
          description: "atomic replacement",
          type: "project",
          content: bodies[index % 2],
        });
      }
    `,
      "utf8",
    );
    const writer = Bun.spawn([process.execPath, scriptPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    let exited = false;
    const exit = writer.exited.then((code) => {
      exited = true;
      return code;
    });
    let observations = 0;
    while (!exited) {
      const raw = readFileSync(file, "utf8");
      const body = raw.split("---\n\n", 2)[1]?.trimEnd();
      expect(body === bodyA || body === bodyB).toBe(true);
      observations += 1;
      await Bun.sleep(0);
    }

    expect(await exit).toBe(0);
    expect(observations).toBeGreaterThan(0);
  });
});
