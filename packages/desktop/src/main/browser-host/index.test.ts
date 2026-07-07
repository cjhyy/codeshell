import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  buildWindowOptions,
  shouldBlockNavigation,
  openBrowserHost,
  destroyPartitionStorage,
} from "./index.js";

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
const registeredElectronPartitions = new Set<string>();

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

function registerElectronSession(
  partition: string,
  session: Electron.Session,
  onFromPartition?: (partition: string) => void,
): void {
  electronMockState().sessions.set(partition, { session, onFromPartition });
  registeredElectronPartitions.add(partition);
}

function clearRegisteredElectronSessions(): void {
  for (const partition of registeredElectronPartitions) {
    electronMockState().sessions.delete(partition);
  }
  registeredElectronPartitions.clear();
}

beforeAll(() => {
  installElectronMock();
});

afterEach(() => {
  clearRegisteredElectronSessions();
});

describe("buildWindowOptions", () => {
  test("hardened webPreferences, no preload, carries partition", () => {
    const o = buildWindowOptions({ kind: "window", url: "https://x", partition: "login-1" });
    expect(o.webPreferences.partition).toBe("login-1");
    expect(o.webPreferences.nodeIntegration).toBe(false);
    expect(o.webPreferences.contextIsolation).toBe(true);
    expect(o.webPreferences.sandbox).toBe(true);
    expect(o.webPreferences.webSecurity).toBe(true);
    // no preload key — external site must not get our API
    expect("preload" in o.webPreferences).toBe(false);
  });

  test("defaults size/title; respects overrides", () => {
    const def = buildWindowOptions({ kind: "window", url: "https://x", partition: "p" });
    expect(def.width).toBe(1000);
    expect(def.title).toBe("登录");
    const ov = buildWindowOptions({
      kind: "window",
      url: "https://x",
      partition: "p",
      width: 1200,
      title: "登录 YouTube",
    });
    expect(ov.width).toBe(1200);
    expect(ov.title).toBe("登录 YouTube");
  });
});

describe("shouldBlockNavigation", () => {
  test("allows http/https/about, blocks others", () => {
    expect(shouldBlockNavigation("https://youtube.com")).toBe(false);
    expect(shouldBlockNavigation("http://x.com")).toBe(false);
    expect(shouldBlockNavigation("about:blank")).toBe(false);
    expect(shouldBlockNavigation("file:///etc/passwd")).toBe(true);
    expect(shouldBlockNavigation("javascript:alert(1)")).toBe(true);
  });
});

describe("openBrowserHost", () => {
  test("rejects unimplemented kinds", async () => {
    // @ts-expect-error intentional bad kind for the guard test
    await expect(
      openBrowserHost({ kind: "webview", url: "https://x", partition: "p" }),
    ).rejects.toThrow(/not implemented/);
  });
});

describe("destroyPartitionStorage", () => {
  test("clears all site storage for the partition", async () => {
    const partitions: string[] = [];
    const clearCalls: unknown[][] = [];
    registerElectronSession(
      "login-1",
      {
        clearStorageData: async (...args: unknown[]) => {
          clearCalls.push(args);
        },
      } as Electron.Session,
      (partition) => {
        partitions.push(partition);
      },
    );

    await destroyPartitionStorage("login-1");

    expect(partitions).toEqual(["login-1"]);
    expect(clearCalls).toEqual([[]]);
  });
});
