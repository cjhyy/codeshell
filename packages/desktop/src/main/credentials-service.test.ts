import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  BROWSER_PARTITION,
  captureAllCookies,
  captureAllCookiesFromSessions,
  formatNetscapeCookies,
  restoreCookiesToBrowser,
  type ElectronCookieLike,
} from "./credentials-service.js";

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

const partitionCalls: string[] = [];
const getCalls: Array<{ partition: string; filter: unknown }> = [];
const clearCalls: Array<{ partition: string; opts: unknown }> = [];
const setCalls: Array<{ partition: string; cookie: unknown }> = [];
const partitionCookies = new Map<string, ElectronCookieLike[]>();
const sessionByPartition = new Map<string, Electron.Session>();

function mockedSession(partition: string): Electron.Session {
  let sess = sessionByPartition.get(partition);
  if (sess) return sess;
  sess = {
    cookies: {
      get: async (filter: unknown) => {
        getCalls.push({ partition, filter });
        return partitionCookies.get(partition) ?? [];
      },
      set: async (cookie: unknown) => {
        setCalls.push({ partition, cookie });
      },
    },
    clearStorageData: async (opts: unknown) => {
      clearCalls.push({ partition, opts });
    },
  } as Electron.Session;
  sessionByPartition.set(partition, sess);
  return sess;
}

function registerMockedSession(partition: string): Electron.Session {
  const sess = mockedSession(partition);
  registerElectronSession(partition, sess, (calledPartition) => {
    partitionCalls.push(calledPartition);
  });
  return sess;
}

beforeAll(() => {
  installElectronMock();
});

beforeEach(() => {
  partitionCalls.length = 0;
  getCalls.length = 0;
  clearCalls.length = 0;
  setCalls.length = 0;
  partitionCookies.clear();
  sessionByPartition.clear();
});

afterEach(() => {
  clearRegisteredElectronSessions();
});

describe("formatNetscapeCookies", () => {
  test("emits the Netscape header line", () => {
    const out = formatNetscapeCookies([]);
    expect(out.split("\n")[0]).toBe("# Netscape HTTP Cookie File");
  });

  test("maps one cookie to 7 tab-separated fields", () => {
    const c: ElectronCookieLike = {
      domain: ".example.com",
      hostOnly: false,
      path: "/",
      secure: true,
      expirationDate: 1893456000,
      name: "sid",
      value: "abc",
    };
    const lines = formatNetscapeCookies([c]).trim().split("\n");
    const fields = lines[lines.length - 1].split("\t");
    expect(fields).toEqual([".example.com", "TRUE", "/", "TRUE", "1893456000", "sid", "abc"]);
  });

  test("hostOnly cookie → include-subdomains FALSE", () => {
    const c: ElectronCookieLike = {
      domain: "x.com",
      hostOnly: true,
      path: "/",
      secure: false,
      name: "a",
      value: "1",
    };
    const fields = formatNetscapeCookies([c]).trim().split("\n").pop()!.split("\t");
    expect(fields[1]).toBe("FALSE");
    expect(fields[3]).toBe("FALSE");
  });

  test("session cookie (no expirationDate) → 0", () => {
    const c: ElectronCookieLike = {
      domain: "x.com",
      path: "/",
      secure: false,
      name: "a",
      value: "1",
    };
    const fields = formatNetscapeCookies([c]).trim().split("\n").pop()!.split("\t");
    expect(fields[4]).toBe("0");
  });

  test("skips cookies whose name/value contain tab or newline", () => {
    const bad: ElectronCookieLike = {
      domain: "x.com",
      path: "/",
      secure: false,
      name: "a\tb",
      value: "v",
    };
    const good: ElectronCookieLike = {
      domain: "x.com",
      path: "/",
      secure: false,
      name: "ok",
      value: "v",
    };
    const lines = formatNetscapeCookies([bad, good]).trim().split("\n");
    // header + 1 good cookie only
    expect(lines).toHaveLength(2);
    expect(lines[1].split("\t")[5]).toBe("ok");
  });
});

describe("browser partition cookie capture", () => {
  test("uses a caller-provided browser partition instead of the default", async () => {
    const partition = "persist:browser:repo__session";
    partitionCookies.set(partition, [
      { domain: ".example.com", path: "/", secure: true, name: "sid", value: "abc" },
    ]);
    registerMockedSession(partition);

    const jar = await captureAllCookies(partition);

    expect(partitionCalls).toEqual([partition]);
    expect(getCalls).toEqual([{ partition, filter: {} }]);
    expect(jar).toEqual(partitionCookies.get(partition));
  });

  test("falls back to the default partition for non-browser partition input", async () => {
    registerMockedSession(BROWSER_PARTITION);

    await captureAllCookies("persist:browser2");

    expect(partitionCalls).toEqual([BROWSER_PARTITION]);
  });

  test("captures multiple partitions and dedupes by domain name and path", async () => {
    partitionCookies.set("persist:browser:a", [
      { domain: ".example.com", path: "/", name: "sid", value: "from-a" },
      { domain: ".one.com", path: "/", name: "a", value: "1" },
    ]);
    partitionCookies.set("persist:browser:b", [
      { domain: ".example.com", path: "/", name: "sid", value: "from-b" },
      { domain: ".two.com", path: "/app", name: "b", value: "2" },
    ]);
    registerMockedSession("persist:browser:a");
    registerMockedSession("persist:browser:b");

    const { jar, count } = await captureAllCookiesFromSessions([
      "persist:browser:a",
      "persist:browser:b",
      "persist:browser:a",
    ]);

    expect(partitionCalls).toEqual(["persist:browser:a", "persist:browser:b"]);
    expect(count).toBe(3);
    expect(jar.map((c) => `${c.domain}|${c.path}|${c.name}|${c.value}`)).toEqual([
      ".example.com|/|sid|from-a",
      ".one.com|/|a|1",
      ".two.com|/app|b|2",
    ]);
  });
});

describe("restoreCookiesToBrowser", () => {
  test("defaults to merge mode and does not clear existing cookies", async () => {
    const browserSession = mockedSession(BROWSER_PARTITION);

    await restoreCookiesToBrowser(
      [{ domain: ".example.com", path: "/", secure: true, name: "sid", value: "abc" }],
      undefined,
      browserSession,
    );

    expect(clearCalls).toEqual([]);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].partition).toBe(BROWSER_PARTITION);
    expect(setCalls[0].cookie).toMatchObject({
      url: "https://example.com/",
      name: "sid",
      value: "abc",
      domain: ".example.com",
      path: "/",
      secure: true,
    });
  });
});
