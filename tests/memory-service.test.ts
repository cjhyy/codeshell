import {
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock electron so the memory-service module imports cleanly. It
// doesn't actually use electron — only main/index.ts does — but
// other top-level files in the package transitively pull it in via
// barrel exports during type resolution.
mock.module("electron", () => ({
  shell: { openExternal: async () => undefined, openPath: async () => "", showItemInFolder: () => undefined },
}));

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
