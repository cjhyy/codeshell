import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as coreModule from "../packages/core/src/index";

mock.module("@cjhyy/code-shell-core", () => coreModule);
const { MemoryManager } = coreModule;

let listMemory: typeof import("../packages/desktop/src/main/memory-service").listMemory;
let readMemory: typeof import("../packages/desktop/src/main/memory-service").readMemory;
let saveMemory: typeof import("../packages/desktop/src/main/memory-service").saveMemory;
let deleteMemory: typeof import("../packages/desktop/src/main/memory-service").deleteMemory;

let baseDir: string;
let projectDir: string;

// The MemoryManager respects CODE_SHELL_HOME for the user-scoped
// directory. We override it for each test so we don't poison the
// user's actual ~/.code-shell.
const ORIGINAL_HOME = process.env.CODE_SHELL_HOME;

beforeAll(async () => {
  const svc = await import("../packages/desktop/src/main/memory-service");
  listMemory = svc.listMemory;
  readMemory = svc.readMemory;
  saveMemory = svc.saveMemory;
  deleteMemory = svc.deleteMemory;
});

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "codeshell-memory-svc-"));
  projectDir = await mkdtemp(join(tmpdir(), "codeshell-memory-proj-"));
  process.env.CODE_SHELL_HOME = baseDir;
});

afterEach(async () => {
  process.env.CODE_SHELL_HOME = ORIGINAL_HOME;
  await rm(baseDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

test("user-level save → list → read round trip", async () => {
  saveMemory({
    level: "user",
    scope: "user",
    name: "favorite-shell",
    description: "preferred shell preference",
    type: "user",
    content: "zsh with starship",
  });
  const list = await listMemory("user", "user");
  expect(list).toHaveLength(1);
  expect(list[0]!.name).toBe("favorite-shell");
  expect(list[0]!.level).toBe("user");
  expect(list[0]!.scope).toBe("user");

  const full = await readMemory("user", "user", "favorite-shell");
  expect(full?.content).toBe("zsh with starship");
});

test("project-level memory writes under the project hash, isolated from user memory", async () => {
  saveMemory({
    level: "user",
    scope: "user",
    name: "global-pref",
    description: "global",
    type: "user",
    content: "global content",
  });
  saveMemory({
    level: "project",
    scope: "user",
    name: "proj-only",
    description: "project-only memo",
    type: "project",
    content: "project content",
    cwd: projectDir,
  });

  const userList = await listMemory("user", "user");
  const projectList = await listMemory("project", "user", projectDir);
  expect(userList.map((e) => e.name)).toEqual(["global-pref"]);
  expect(projectList.map((e) => e.name)).toEqual(["proj-only"]);
  expect(projectList[0]!.level).toBe("project");
});

test("dream scope is separate from user scope at the same level", async () => {
  saveMemory({
    level: "user",
    scope: "user",
    name: "u1",
    description: "u",
    type: "user",
    content: "user",
  });
  saveMemory({
    level: "user",
    scope: "dream",
    name: "d1",
    description: "d",
    type: "reference",
    content: "dream",
  });
  const u = await listMemory("user", "user");
  const d = await listMemory("user", "dream");
  expect(u.map((e) => e.name)).toEqual(["u1"]);
  expect(d.map((e) => e.name)).toEqual(["d1"]);
});

test("deleteMemory soft-removes the entry", async () => {
  saveMemory({
    level: "user",
    scope: "user",
    name: "to-delete",
    description: "x",
    type: "feedback",
    content: "x",
  });
  expect((await listMemory("user", "user")).length).toBe(1);
  const ok = deleteMemory("user", "user", "to-delete");
  expect(ok).toBe(true);
  expect((await listMemory("user", "user")).length).toBe(0);
});

test("project memory throws without cwd", () => {
  expect(() =>
    saveMemory({
      level: "project",
      scope: "user",
      name: "x",
      description: "x",
      type: "project",
      content: "x",
    }),
  ).toThrow(/cwd/);
});

test("readMemory returns null when the entry doesn't exist", async () => {
  expect(await readMemory("user", "user", "nope")).toBeNull();
});

test("listMemory and readMemory surface lifecycle fields and dream origin", async () => {
  const createdAt = "2026-07-08T01:00:00.000Z";
  const updatedAt = "2026-07-08T02:00:00.000Z";
  const lastUsedAt = "2026-07-08T03:00:00.000Z";
  const mm = new MemoryManager({ scope: "dream" });
  mm.save(
    {
      name: "dream-owned",
      description: "dream provenance and counters",
      type: "feedback",
      content: "Dream owns this entry.",
      origin: "dream",
      createdAt,
      updatedAt,
      lastUsedAt,
      useCount: 7,
      updateCount: 3,
    },
    { forceOrigin: "dream", incrementUpdateCount: false },
  );

  const list = await listMemory("user", "dream");
  expect(list).toHaveLength(1);
  expect(list[0]!.id).toStartWith("mem_");
  expect(list[0]!.origin).toBe("dream");
  expect(list[0]!.useCount).toBe(7);
  expect(list[0]!.updateCount).toBe(3);
  expect(list[0]!.createdAt).toBe(createdAt);
  expect(list[0]!.updatedAt).toBe(updatedAt);
  expect(list[0]!.lastUsedAt).toBe(lastUsedAt);

  const full = await readMemory("user", "dream", "dream-owned");
  expect(full?.id).toBe(list[0]!.id);
  expect(full?.origin).toBe("dream");
  expect(full?.useCount).toBe(7);
  expect(full?.updateCount).toBe(3);
  expect(full?.createdAt).toBe(createdAt);
  expect(full?.updatedAt).toBe(updatedAt);
  expect(full?.lastUsedAt).toBe(lastUsedAt);
});

test("pin-style save keeps origin and does not increment updateCount", async () => {
  const fileName = saveMemory({
    level: "user",
    scope: "user",
    name: "pin-me",
    description: "pin lifecycle",
    type: "feedback",
    content: "same content",
    origin: "dream",
  });
  const full = await readMemory("user", "user", fileName);
  expect(full?.origin).toBe("dream");
  expect(full?.updateCount).toBe(0);

  saveMemory({
    level: "user",
    scope: "user",
    id: full!.id,
    name: full!.name,
    description: full!.description,
    type: full!.type,
    content: full!.content,
    pinned: true,
    origin: full!.origin,
  });

  const after = await readMemory("user", "user", "pin-me");
  expect(after?.origin).toBe("dream");
  expect(after?.pinned).toBe(true);
  expect(after?.updateCount).toBe(0);
});
