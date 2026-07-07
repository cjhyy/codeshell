import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

type ElectronMockSessionEntry = {
  session: Electron.Session;
  onFromPartition?: (partition: string) => void;
};

type ElectronMockState = {
  sessions: Map<string, ElectronMockSessionEntry>;
  openExternal: (...args: unknown[]) => Promise<void>;
  openPath: (...args: unknown[]) => Promise<string>;
  showItemInFolder: (...args: unknown[]) => void;
};

const electronMockGlobal = globalThis as typeof globalThis & {
  __codeshellElectronMockState?: ElectronMockState;
};

function createDefaultElectronSession(): Electron.Session {
  return {
    cookies: {
      get: async () => [],
      set: async () => undefined,
    },
    clearStorageData: async () => undefined,
  } as Electron.Session;
}

function electronMockState(): ElectronMockState {
  return (electronMockGlobal.__codeshellElectronMockState ??= {
    sessions: new Map(),
    openExternal: async () => undefined,
    openPath: async () => "",
    showItemInFolder: () => undefined,
  });
}

const electronShellMock = {
  openExternal: (...args: unknown[]) => electronMockState().openExternal(...args),
  openPath: (...args: unknown[]) => electronMockState().openPath(...args),
  showItemInFolder: (...args: unknown[]) => electronMockState().showItemInFolder(...args),
};

const electronSessionMock = {
  fromPartition(partition: string) {
    const entry = electronMockState().sessions.get(partition);
    entry?.onFromPartition?.(partition);
    return entry?.session ?? createDefaultElectronSession();
  },
};

function installElectronMock(): void {
  electronMockState();
  mock.module("electron", () => ({
    app: { isPackaged: false },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString("utf-8"),
    },
    session: electronSessionMock,
    shell: electronShellMock,
  }));
}

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
  installElectronMock();
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
  const res = await undoFiles(dir, ["README.md", "fresh.txt", "../escape", "missing.txt"]);
  expect(res.map((r) => ({ p: r.path, ok: r.ok, a: r.action }))).toEqual([
    { p: "README.md", ok: true, a: "restore" },
    { p: "fresh.txt", ok: true, a: "remove" },
    { p: "../escape", ok: false, a: "skip" },
    { p: "missing.txt", ok: true, a: "remove" },
  ]);
});
