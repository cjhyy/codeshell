import { describe, expect, test } from "bun:test";
import {
  RendererBrowserSessionAccess,
  type PersistedBrowserSessionAuthority,
  type RendererBrowserSessionAccessDeps,
} from "./renderer-browser-session-access.js";

const SESSION_ID = "saved-conversation";
const SENDER_ID = 11;
const OTHER_SENDER_ID = 12;
const BUCKET = "mounted-project";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const state = {
    known: false,
    owner: undefined as number | undefined,
    ownerRevision: 0,
    generation: 0,
    authorityRevision: 0,
    resolveCalls: 0,
    registerCalls: 0,
    buckets: new Map<string, string>(),
  };
  function fakeWindow(id: number) {
    const life = { destroyed: false, contentsDestroyed: false };
    return {
      life,
      isDestroyed: () => life.destroyed,
      webContents: {
        id,
        mainFrame: {},
        isDestroyed: () => life.contentsDestroyed,
      },
    };
  }
  const firstWindow = fakeWindow(SENDER_ID);
  const secondWindow = fakeWindow(OTHER_SENDER_ID);
  const windows = new Map([
    [SENDER_ID, firstWindow],
    [OTHER_SENDER_ID, secondWindow],
  ]);
  const initialBridge = {
    hasKnownSession: () => state.known,
    panelOwnerWebContentsId: () => state.owner,
    sessionPanelOwnerRevision: () => state.ownerRevision,
    workerGeneration: () => state.generation,
  };
  let bridge: typeof initialBridge | null = initialBridge;
  function authority(bucket = BUCKET): PersistedBrowserSessionAuthority {
    const revision = state.authorityRevision;
    return {
      bucket,
      assertCurrent: () => {
        if (state.authorityRevision !== revision) throw new Error("persisted Session changed");
      },
    };
  }
  const deps: RendererBrowserSessionAccessDeps = {
    bridge: () => bridge,
    windowForSender: (senderId) => windows.get(senderId) ?? null,
    resolvePersistedSession: async () => {
      state.resolveCalls++;
      return authority();
    },
    bucketForSession: (sessionId) => state.buckets.get(sessionId) ?? null,
    registerSessionBucket: (sessionId, bucket) => {
      state.registerCalls++;
      state.buckets.set(sessionId, bucket);
    },
  };
  const access = new RendererBrowserSessionAccess(deps);
  return {
    state,
    access,
    deps,
    authority,
    firstWindow,
    windows,
    replaceBridge: () => {
      bridge = { ...initialBridge };
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

describe("RendererBrowserSessionAccess", () => {
  test("a saved UI alias survives its first run and cannot be rebound by a later renderer hint", async () => {
    const f = fixture();
    const alias = "project::legacy-ui-id";
    f.deps.resolvePersistedSession = async (sessionId, requestedBucket) => {
      expect(sessionId).toBe(SESSION_ID);
      expect(requestedBucket).toBe(alias);
      return f.authority(alias);
    };
    const authorization = await f.access.prepare(SESSION_ID, SENDER_ID, alias);
    expect(f.state.buckets.get(SESSION_ID)).toBe(alias);
    f.access.sessionOwnerClaimed(SESSION_ID, SENDER_ID);
    f.state.known = true;
    f.state.generation++;
    f.state.owner = SENDER_ID;
    f.state.ownerRevision++;
    expect(() => authorization.assertCurrent()).not.toThrow();
    await expect(f.access.prepare(SESSION_ID, SENDER_ID, "project::other-ui-id")).rejects.toThrow(
      "does not match",
    );
    expect(() => authorization.assertCurrent()).not.toThrow();
  });

  test.each(["", "bad\0bucket", "x".repeat(513)])(
    "rejects malformed bucket hints before resolving a Session",
    async (bucket) => {
      const f = fixture();
      await expect(f.access.prepare(SESSION_ID, SENDER_ID, bucket)).rejects.toThrow(
        "invalid browser bucket",
      );
      expect(f.state.resolveCalls).toBe(0);
    },
  );

  test("a persisted cold conversation gets browser authority without becoming a Host session", async () => {
    const f = fixture();
    expect(() => f.access.assertAccess(SESSION_ID, SENDER_ID)).toThrow(
      "Open an existing conversation",
    );
    const authorization = await f.access.prepare(SESSION_ID, SENDER_ID);
    expect(authorization.bucket).toBe(BUCKET);
    expect(f.state.buckets.get(SESSION_ID)).toBe(BUCKET);
    expect(f.access.assertAccess(SESSION_ID, SENDER_ID)).toBe(SESSION_ID);
    expect(f.state.known).toBe(false);
    expect(f.state.generation).toBe(0);
    expect(f.state.owner).toBeUndefined();
    expect(f.state.resolveCalls).toBe(1);
    expect(await f.access.prepare(SESSION_ID, SENDER_ID)).toBe(authorization);
    expect(f.state.resolveCalls).toBe(1);
  });

  test("known sessions preserve their owner rules and do not read durable Session state", async () => {
    const f = fixture();
    f.state.known = true;
    f.state.owner = SENDER_ID;
    f.state.buckets.set(SESSION_ID, BUCKET);
    const authorization = await f.access.prepare(SESSION_ID, SENDER_ID);
    expect(authorization.bucket).toBe(BUCKET);
    authorization.assertCurrent();
    expect(f.state.resolveCalls).toBe(0);
    expect(f.state.registerCalls).toBe(0);
    await expect(f.access.prepare(SESSION_ID, OTHER_SENDER_ID)).rejects.toThrow("another window");
    f.state.owner = OTHER_SENDER_ID;
    expect(() => authorization.assertCurrent()).toThrow("another window");
  });

  test("known sessions with no browser binding do not invent a project bucket", async () => {
    const f = fixture();
    f.state.known = true;
    expect((await f.access.prepare(SESSION_ID, SENDER_ID)).bucket).toBeNull();
    expect(f.state.registerCalls).toBe(0);
  });

  test.each(["../escape", "", "a/b", null])(
    "rejects invalid Session IDs: %s",
    async (sessionId) => {
      const f = fixture();
      await expect(f.access.prepare(sessionId, SENDER_ID)).rejects.toThrow();
      expect(f.state.resolveCalls).toBe(0);
      expect(f.state.registerCalls).toBe(0);
    },
  );

  test("rejects missing, deleted, or unusable durable Sessions without a browser binding", async () => {
    const f = fixture();
    f.deps.resolvePersistedSession = async () => {
      throw new Error("Session cannot be opened");
    };
    await expect(f.access.prepare(SESSION_ID, SENDER_ID)).rejects.toThrow(
      "Session cannot be opened",
    );
    expect(f.state.registerCalls).toBe(0);
  });

  test.each(["", "a\0b", "a".repeat(513)])("rejects invalid canonical buckets", async (bucket) => {
    const f = fixture();
    f.deps.resolvePersistedSession = async () => f.authority(bucket);
    await expect(f.access.prepare(SESSION_ID, SENDER_ID)).rejects.toThrow("browser bucket");
    expect(f.state.registerCalls).toBe(0);
  });

  test("rejects an existing binding to a different project", async () => {
    const f = fixture();
    f.state.buckets.set(SESSION_ID, "other-project");
    await expect(f.access.prepare(SESSION_ID, SENDER_ID)).rejects.toThrow("browser bucket");
    expect(f.state.buckets.get(SESSION_ID)).toBe("other-project");
    expect(f.state.registerCalls).toBe(0);
  });

  test("a healthy cold claim cannot be stolen, even once the bridge knows the Session", async () => {
    const f = fixture();
    const first = await f.access.prepare(SESSION_ID, SENDER_ID);
    f.state.known = true;
    await expect(f.access.prepare(SESSION_ID, OTHER_SENDER_ID)).rejects.toThrow("another window");
    expect(() => f.access.assertAccess(SESSION_ID, OTHER_SENDER_ID)).toThrow("another window");
    first.assertCurrent();
    expect(await f.access.prepare(SESSION_ID, SENDER_ID)).toBe(first);
  });

  test("concurrent browser registration and status reuse the same window's committed authority", async () => {
    const f = fixture();
    const wait = deferred<PersistedBrowserSessionAuthority>();
    f.deps.resolvePersistedSession = () => wait.promise;
    const first = f.access.prepare(SESSION_ID, SENDER_ID);
    const second = f.access.prepare(SESSION_ID, SENDER_ID);
    wait.resolve(f.authority());
    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(two);
    expect(f.state.registerCalls).toBe(1);
  });

  test("a concurrent read in a second window cannot overwrite the first claim", async () => {
    const f = fixture();
    const wait = deferred<PersistedBrowserSessionAuthority>();
    f.deps.resolvePersistedSession = () => wait.promise;
    const first = f.access.prepare(SESSION_ID, SENDER_ID);
    const second = f.access.prepare(SESSION_ID, OTHER_SENDER_ID);
    wait.resolve(f.authority());
    const accepted = await first;
    await expect(second).rejects.toThrow("another window");
    accepted.assertCurrent();
    expect(f.state.registerCalls).toBe(1);
  });

  const pendingChanges: [string, (f: Fixture) => void][] = [
    ["window destruction", (f) => (f.firstWindow.life.destroyed = true)],
    ["renderer destruction", (f) => (f.firstWindow.life.contentsDestroyed = true)],
    ["main-frame replacement", (f) => (f.firstWindow.webContents.mainFrame = {})],
    ["window replacement", (f) => f.windows.set(SENDER_ID, { ...f.firstWindow })],
    ["bridge replacement", (f) => f.replaceBridge()],
    ["worker restart", (f) => f.state.generation++],
    ["new Host Session", (f) => (f.state.known = true)],
    ["owner revision change", (f) => f.state.ownerRevision++],
    ["another window taking ownership", (f) => (f.state.owner = OTHER_SENDER_ID)],
    ["Session deletion", (f) => f.access.forgetSession(SESSION_ID)],
    ["window release", (f) => f.access.forgetWindow(SENDER_ID)],
    ["durable Session replacement", (f) => f.state.authorityRevision++],
    ["browser bucket change", (f) => f.state.buckets.set(SESSION_ID, "other-project")],
  ];
  test.each(pendingChanges)(
    "rejects %s while persistent authority is loading",
    async (_label, change) => {
      const f = fixture();
      const wait = deferred<PersistedBrowserSessionAuthority>();
      f.deps.resolvePersistedSession = () => wait.promise;
      const authority = f.authority();
      const preparing = f.access.prepare(SESSION_ID, SENDER_ID);
      change(f);
      wait.resolve(authority);
      await expect(preparing).rejects.toThrow();
      expect(f.state.registerCalls).toBe(0);
    },
  );

  test("forgetting and reopening a Session cannot resurrect an earlier pending read", async () => {
    const f = fixture();
    const wait = deferred<PersistedBrowserSessionAuthority>();
    f.deps.resolvePersistedSession = () => wait.promise;
    const old = f.access.prepare(SESSION_ID, SENDER_ID);
    f.access.forgetSession(SESSION_ID);
    const fresh = f.access.prepare(SESSION_ID, SENDER_ID);
    wait.resolve(f.authority());
    await expect(old).rejects.toThrow("window changed");
    (await fresh).assertCurrent();
    expect(f.state.registerCalls).toBe(1);
  });

  const grantChanges: [string, (f: Fixture) => void][] = [
    ["window destruction", (f) => (f.firstWindow.life.destroyed = true)],
    ["main-frame replacement", (f) => (f.firstWindow.webContents.mainFrame = {})],
    ["bridge replacement", (f) => f.replaceBridge()],
    ["durable Session replacement", (f) => f.state.authorityRevision++],
    ["browser bucket removal", (f) => f.state.buckets.delete(SESSION_ID)],
    ["browser bucket replacement", (f) => f.state.buckets.set(SESSION_ID, "other-project")],
    ["another window taking ownership", (f) => (f.state.owner = OTHER_SENDER_ID)],
    ["Session release", (f) => f.access.forgetSession(SESSION_ID)],
    ["window release", (f) => f.access.forgetWindow(SENDER_ID)],
  ];
  test.each(grantChanges)("invalidates a stored grant after %s", async (_label, change) => {
    const f = fixture();
    const authorization = await f.access.prepare(SESSION_ID, SENDER_ID);
    change(f);
    expect(() => authorization.assertCurrent()).toThrow();
  });

  test("a first legitimate run may start a worker and claim this window without revoking its grant", async () => {
    const f = fixture();
    const authorization = await f.access.prepare(SESSION_ID, SENDER_ID);
    f.state.known = true;
    f.state.generation++;
    f.state.owner = SENDER_ID;
    f.state.ownerRevision++;
    f.access.sessionOwnerClaimed(SESSION_ID, SENDER_ID);
    authorization.assertCurrent();
    expect(f.access.assertAccess(SESSION_ID, SENDER_ID)).toBe(SESSION_ID);
    expect(await f.access.prepare(SESSION_ID, SENDER_ID)).toBe(authorization);
    // An intervening owner transfer must not be hidden by returning to the
    // original window before a grant's next dispatch.
    f.state.ownerRevision += 2;
    expect(() => authorization.assertCurrent()).toThrow("owner changed");
  });

  test.each([false, true])(
    "owner claims permanently retire other windows before any dispatch (known = %s)",
    async (known) => {
      const f = fixture();
      f.state.known = known;
      const authorization = await f.access.prepare(SESSION_ID, SENDER_ID);
      // Both transfers occur before the grant guard can sample an owner. The
      // Main hook still retires the old window's authority permanently.
      f.state.owner = OTHER_SENDER_ID;
      f.state.ownerRevision++;
      f.access.sessionOwnerClaimed(SESSION_ID, OTHER_SENDER_ID);
      f.state.owner = SENDER_ID;
      f.state.ownerRevision++;
      f.access.sessionOwnerClaimed(SESSION_ID, SENDER_ID);
      expect(() => authorization.assertCurrent()).toThrow("window changed");
      (await f.access.prepare(SESSION_ID, SENDER_ID)).assertCurrent();
      expect(() => authorization.assertCurrent()).toThrow("window changed");
    },
  );

  test("a first owner claim keeps its own known-session grant and retires another window's grant", async () => {
    const f = fixture();
    f.state.known = true;
    const first = await f.access.prepare(SESSION_ID, SENDER_ID);
    const second = await f.access.prepare(SESSION_ID, OTHER_SENDER_ID);
    f.state.owner = OTHER_SENDER_ID;
    f.state.ownerRevision++;
    f.access.sessionOwnerClaimed(SESSION_ID, OTHER_SENDER_ID);
    expect(() => first.assertCurrent()).toThrow();
    second.assertCurrent();
    f.access.sessionOwnerClaimed(SESSION_ID, OTHER_SENDER_ID);
    second.assertCurrent();
  });

  test("an owner claim cancels another window's pending disk read", async () => {
    const f = fixture();
    const wait = deferred<PersistedBrowserSessionAuthority>();
    f.deps.resolvePersistedSession = () => wait.promise;
    const preparing = f.access.prepare(SESSION_ID, SENDER_ID);
    f.access.sessionOwnerClaimed(SESSION_ID, OTHER_SENDER_ID);
    wait.resolve(f.authority());
    await expect(preparing).rejects.toThrow("window changed");
    expect(f.state.registerCalls).toBe(0);
  });

  test("releasing another window does not revoke this window's pending registration", async () => {
    const f = fixture();
    const wait = deferred<PersistedBrowserSessionAuthority>();
    f.deps.resolvePersistedSession = () => wait.promise;
    const first = f.access.prepare(SESSION_ID, SENDER_ID);
    const second = f.access.prepare(SESSION_ID, OTHER_SENDER_ID);
    f.access.forgetWindow(OTHER_SENDER_ID);
    wait.resolve(f.authority());
    (await first).assertCurrent();
    await expect(second).rejects.toThrow("window changed");
    expect(f.state.registerCalls).toBe(1);
  });

  test("new explicit authorization after revocation cannot make an old grant current again", async () => {
    const f = fixture();
    const previous = await f.access.prepare(SESSION_ID, SENDER_ID);
    f.state.authorityRevision++;
    const current = await f.access.prepare(SESSION_ID, SENDER_ID);
    expect(current).not.toBe(previous);
    current.assertCurrent();
    expect(() => previous.assertCurrent()).toThrow("registration was retired");
  });

  test("a known Session grant becomes invalid if generic Session authority is released", async () => {
    const f = fixture();
    f.state.known = true;
    const authorization = await f.access.prepare(SESSION_ID, SENDER_ID);
    f.state.known = false;
    expect(() => authorization.assertCurrent()).toThrow("Open an existing conversation");
  });
});
