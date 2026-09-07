import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentBody, saveAgent } from "./agents-service.js";

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
  test("keeps the next same-agent write queued until replacement registration finishes", async () => {
    const cwd = await projectRoot();
    const realpath = fs.realpath;
    const writeFile = fs.writeFile;
    const rename = fs.rename;
    let rootsResolved = 0;
    let writes = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstRename!: () => void;
    const firstReachedRename = new Promise<void>((resolve) => (firstRename = resolve));
    let secondRoot!: () => void;
    const secondRootResolved = new Promise<void>((resolve) => (secondRoot = resolve));
    const rootRead = spyOn(fs, "realpath").mockImplementation(async (...args) => {
      const result = await realpath(...args);
      if (args[0] === cwd && ++rootsResolved === 2) secondRoot();
      return result;
    });
    const writesStarted = spyOn(fs, "writeFile").mockImplementation((...args) => {
      writes++;
      return writeFile(...args);
    });
    const replacement = spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
      firstRename();
      await firstGate;
      return rename(...args);
    });
    replacement.mockImplementation(rename);
    const saves: ReturnType<typeof saveAgent>[] = [];
    try {
      saves.push(
        saveAgent(
          { name: "reviewer", description: "first", systemPrompt: "first" },
          { scope: "project", cwd },
        ),
      );
      await firstReachedRename;
      saves.push(
        saveAgent(
          { name: "reviewer", description: "second", systemPrompt: "second" },
          { scope: "project", cwd },
        ),
      );
      await secondRootResolved;
      // Root validation has finished. Drain its promise continuations before
      // checking that the second save cannot enter the replacement operation.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes).toBe(1);
      releaseFirst();
      const results = await Promise.all(saves);
      expect(writes).toBe(2);
      expect(await readAgentBody(results[1].filePath)).toContain("second");
    } finally {
      releaseFirst();
      await Promise.allSettled(saves);
      rootRead.mockRestore();
      writesStarted.mockRestore();
      replacement.mockRestore();
    }
  });

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

    const summaries = await Promise.all(
      definitions.map((definition) => saveAgent(definition, { scope: "project", cwd })),
    );

    const agentDir = join(cwd, ".code-shell", "agents");
    const saved = await readFile(join(agentDir, "reviewer.md"), "utf8");
    const isFirst =
      saved.includes("first complete definition") && saved.includes("A".repeat(1_000));
    const isSecond =
      saved.includes("second complete definition") && saved.includes("B".repeat(1_000));
    expect(isFirst || isSecond).toBe(true);
    for (const summary of summaries) expect(await readAgentBody(summary.filePath)).toBe(saved);
    expect((await readdir(agentDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a failed replacement releases the next save of the same agent", async () => {
    const cwd = await projectRoot();
    const rename = fs.rename;
    const replacement = spyOn(fs, "rename").mockImplementationOnce(async () => {
      throw new Error("injected replacement failure");
    });
    replacement.mockImplementation(rename);
    try {
      const results = await Promise.allSettled([
        saveAgent(
          { name: "reviewer", description: "first", systemPrompt: "first" },
          { scope: "project", cwd },
        ),
        saveAgent(
          { name: "reviewer", description: "second", systemPrompt: "second" },
          { scope: "project", cwd },
        ),
      ]);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const completed = results.find((result) => result.status === "fulfilled");
      expect(completed?.status).toBe("fulfilled");
      if (completed?.status !== "fulfilled") throw new Error("queued save did not complete");
      expect(await readAgentBody(completed.value.filePath)).toContain(completed.value.systemPrompt);
      expect((await readdir(join(cwd, ".code-shell", "agents"))).sort()).toEqual(["reviewer.md"]);
    } finally {
      replacement.mockRestore();
    }
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
