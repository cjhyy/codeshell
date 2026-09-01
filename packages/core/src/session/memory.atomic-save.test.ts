import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    const script = `
      import { MemoryManager } from ${JSON.stringify(join(import.meta.dir, "memory.ts"))};
      const manager = new MemoryManager({ baseDir: ${JSON.stringify(baseDir)}, scope: "user" });
      const bodies = [${JSON.stringify(bodyA)}, ${JSON.stringify(bodyB)}];
      for (let index = 0; index < 40; index += 1) {
        manager.save({
          id: ${JSON.stringify(id)},
          name: "atomic",
          description: "atomic replacement",
          type: "project",
          content: bodies[index % 2],
        });
      }
    `;
    const writer = Bun.spawn([process.execPath, "-e", script], {
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
