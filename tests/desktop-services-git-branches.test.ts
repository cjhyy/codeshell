import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

let getGitBranches: typeof import("../packages/desktop/src/main/desktop-services").getGitBranches;
let switchGitBranch: typeof import("../packages/desktop/src/main/desktop-services").switchGitBranch;
let stashAndSwitchGitBranch: typeof import("../packages/desktop/src/main/desktop-services").stashAndSwitchGitBranch;
let dir: string;

async function run(args: string[], cwd = dir): Promise<string> {
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
  getGitBranches = services.getGitBranches;
  switchGitBranch = services.switchGitBranch;
  stashAndSwitchGitBranch = services.stashAndSwitchGitBranch;
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codeshell-git-branches-"));
  await run(["init", "-b", "main"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test User"]);
  await writeFile(join(dir, "README.md"), "hello\n");
  await run(["add", "README.md"]);
  await run(["commit", "-m", "initial"]);
  await run(["branch", "feature/local"]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("getGitBranches lists local branches and current branch", async () => {
  const branches = await getGitBranches(dir);

  expect(branches.isRepo).toBe(true);
  expect(branches.current).toBe("main");
  expect(branches.branches).toEqual(["feature/local", "main"]);
});

test("getGitBranches reports non-Git directories without throwing", async () => {
  const plain = await mkdtemp(join(tmpdir(), "codeshell-not-git-"));
  try {
    const branches = await getGitBranches(plain);

    expect(branches).toEqual({ isRepo: false, current: null, branches: [] });
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
});

test("switchGitBranch switches only to an existing local branch", async () => {
  const branches = await switchGitBranch(dir, "feature/local");

  expect(branches.current).toBe("feature/local");
  expect((await run(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/local");
});

test("switchGitBranch rejects missing branches and keeps current branch", async () => {
  await expect(switchGitBranch(dir, "origin/remote-only")).rejects.toThrow(
    "Local branch not found",
  );

  expect((await run(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
});

test("stashAndSwitchGitBranch stashes dirty changes before switching", async () => {
  await writeFile(join(dir, "README.md"), "dirty change\n");
  await writeFile(join(dir, "new-file.txt"), "untracked\n");

  const branches = await stashAndSwitchGitBranch(dir, "feature/local");

  expect(branches.current).toBe("feature/local");
  expect((await run(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/local");
  expect((await run(["status", "--porcelain=v1"])).trim()).toBe("");
  expect(await run(["stash", "list"])).toContain(
    "CodeShell auto-stash before switching to feature/local",
  );
});
