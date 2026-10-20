import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunManager } from "./factory.js";
import { defineProduct } from "../product/define.js";
import type { RunManager } from "./RunManager.js";

// concurrency 0 keeps submitted runs queued, so no Engine or model is started.
const llm = { provider: "openai", model: "test-model", apiKey: "test" } as const;

const roots: string[] = [];
const managers: RunManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "run-factory-cwd-"));
  roots.push(root);
  return root;
}

describe("factory cwd option", () => {
  it("createRunManager uses options.cwd as the submitted run's default cwd", async () => {
    const root = tempRoot();
    const cwd = join(root, "workspace");
    const manager = createRunManager({ llm, cwd, runsDir: join(root, "runs"), concurrency: 0 });
    managers.push(manager);

    expect((await manager.submit({ objective: "default" })).cwd).toBe(cwd);
    const explicit = join(root, "other");
    expect((await manager.submit({ objective: "explicit", cwd: explicit })).cwd).toBe(explicit);
  });

  it("defineProduct uses runtime.cwd as the submitted run's default cwd", async () => {
    const root = tempRoot();
    const cwd = join(root, "workspace");
    const { manager } = defineProduct(
      {
        preset: { name: "cwd-product", label: "Cwd", description: "test" },
        contract: { concurrency: 0 },
      },
      { llm, cwd, runsDir: join(root, "runs") },
    );
    managers.push(manager);

    expect((await manager.submit({ objective: "default" })).cwd).toBe(cwd);
  });
});
