import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAgent } from "./agents-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codeshell-agent-save-"));
  roots.push(root);
  return root;
}

describe("saveAgent atomic writes", () => {
  test("concurrent saves of one agent both complete and leave one intact definition", async () => {
    const cwd = await projectRoot();
    const definitions = [
      {
        name: "reviewer",
        description: "first complete definition",
        systemPrompt: "A".repeat(32_000),
      },
      {
        name: "reviewer",
        description: "second complete definition",
        systemPrompt: "B".repeat(32_000),
      },
    ];

    await Promise.all(
      definitions.map((definition) => saveAgent(definition, { scope: "project", cwd })),
    );

    const agentDir = join(cwd, ".code-shell", "agents");
    const saved = await readFile(join(agentDir, "reviewer.md"), "utf8");
    const isFirst = saved.includes("first complete definition") && saved.includes("A".repeat(1_000));
    const isSecond =
      saved.includes("second complete definition") && saved.includes("B".repeat(1_000));
    expect(isFirst || isSecond).toBe(true);
    expect((await readdir(agentDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("removes its unique temp file when replacement fails", async () => {
    const cwd = await projectRoot();
    const target = join(cwd, ".code-shell", "agents", "reviewer.md");
    await mkdir(target, { recursive: true });

    await expect(
      saveAgent(
        { name: "reviewer", description: "cannot replace a directory", systemPrompt: "review" },
        { scope: "project", cwd },
      ),
    ).rejects.toBeDefined();
    expect(
      (await readdir(join(cwd, ".code-shell", "agents"))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  test("rejects a project agents directory symlink that escapes the project", async () => {
    const cwd = await projectRoot();
    const outside = await projectRoot();
    await mkdir(join(cwd, ".code-shell"), { recursive: true });
    await symlink(outside, join(cwd, ".code-shell", "agents"));

    await expect(
      saveAgent(
        { name: "escape", description: "must stay local", systemPrompt: "review" },
        { scope: "project", cwd },
      ),
    ).rejects.toThrow(/escapes the project/i);
    await expect(readFile(join(outside, "escape.md"), "utf8")).rejects.toBeDefined();
  });

  test("rejects unbounded definitions before writing", async () => {
    const cwd = await projectRoot();
    await expect(
      saveAgent(
        { name: "huge", description: "ok", systemPrompt: "x".repeat(1024 * 1024 + 1) },
        { scope: "project", cwd },
      ),
    ).rejects.toThrow(/unbounded/i);
  });
});
