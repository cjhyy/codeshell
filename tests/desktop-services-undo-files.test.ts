import {
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock electron so importing desktop-services doesn't blow up — we
// only need the file-system / git-driving paths.
mock.module("electron", () => ({
  shell: {
    openExternal: async () => undefined,
    openPath: async () => "",
    showItemInFolder: () => undefined,
  },
}));

let undoFiles: typeof import("../packages/desktop/src/main/desktop-services").undoFiles;
let dir: string;

async function git(args: string[], cwd = dir): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

beforeAll(async () => {
  const services = await import("../packages/desktop/src/main/desktop-services");
  undoFiles = services.undoFiles;
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codeshell-undo-files-"));
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);
  await writeFile(join(dir, "README.md"), "hello\n");
  await writeFile(join(dir, "src.ts"), "export const x = 1;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("restores tracked files modified vs HEAD", async () => {
  await writeFile(join(dir, "README.md"), "DIRTY\n");
  const res = await undoFiles(dir, ["README.md"]);
  expect(res).toHaveLength(1);
  expect(res[0]!.ok).toBe(true);
  expect(res[0]!.action).toBe("restore");
  const after = await readFile(join(dir, "README.md"), "utf-8");
  expect(after).toBe("hello\n");
});

test("removes untracked (newly-created) files from disk", async () => {
  await writeFile(join(dir, "new.txt"), "fresh\n");
  const res = await undoFiles(dir, ["new.txt"]);
  expect(res[0]!.ok).toBe(true);
  expect(res[0]!.action).toBe("remove");
  await expect(access(join(dir, "new.txt"))).rejects.toBeDefined();
});

test("succeeds (no-op) when an untracked path no longer exists", async () => {
  const res = await undoFiles(dir, ["nope.txt"]);
  expect(res[0]!.ok).toBe(true);
  expect(res[0]!.action).toBe("remove");
});

test("refuses paths that escape the cwd", async () => {
  const res = await undoFiles(dir, ["../escape.txt"]);
  expect(res[0]!.ok).toBe(false);
  expect(res[0]!.action).toBe("skip");
});

test("reports per-path mixed outcomes in one batch", async () => {
  await writeFile(join(dir, "README.md"), "DIRTY\n");
  await writeFile(join(dir, "fresh.txt"), "new\n");
  const res = await undoFiles(dir, [
    "README.md",
    "fresh.txt",
    "../escape",
    "missing.txt",
  ]);
  expect(res.map((r) => ({ p: r.path, ok: r.ok, a: r.action }))).toEqual([
    { p: "README.md", ok: true, a: "restore" },
    { p: "fresh.txt", ok: true, a: "remove" },
    { p: "../escape", ok: false, a: "skip" },
    { p: "missing.txt", ok: true, a: "remove" },
  ]);
});
