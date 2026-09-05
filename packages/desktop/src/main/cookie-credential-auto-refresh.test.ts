import { describe, expect, test } from "bun:test";
import {
  CookieCredentialAutoRefresh,
  type CookieSessionLike,
} from "./cookie-credential-auto-refresh.js";
import type { ElectronCookieLike } from "./credentials-service.js";

type CookieJarLike = CookieSessionLike["cookies"];
type ChangedListener = Parameters<CookieJarLike["on"]>[1];

class FakeCookies implements CookieJarLike {
  jar: ElectronCookieLike[] = [];
  listeners = new Set<ChangedListener>();

  async get(_filter: { domain?: string }): Promise<ElectronCookieLike[]> {
    return [...this.jar];
  }

  on(_event: "changed", listener: ChangedListener): void {
    this.listeners.add(listener);
  }

  removeListener(_event: "changed", listener: ChangedListener): void {
    this.listeners.delete(listener);
  }

  emit(cookie: ElectronCookieLike, removed = false): void {
    for (const listener of this.listeners) listener({}, cookie, "explicit", removed);
  }
}

function session(cookies = new FakeCookies()): CookieSessionLike & { cookies: FakeCookies } {
  return { cookies };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("CookieCredentialAutoRefresh", () => {
  test("writes a rotated cookie back to the credential bound to this Session", async () => {
    const writes: unknown[][] = [];
    const target = session();
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, _id, _scope, jar) => {
        writes.push(jar);
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "xhs",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      domain: "xiaohongshu.com",
      seedJar: [{ name: "web_session", value: "old", domain: ".xiaohongshu.com" }],
    });
    target.cookies.jar = [
      { name: "web_session", value: "fresh", domain: ".xiaohongshu.com" },
      { name: "sid", value: "unrelated", domain: ".example.com" },
    ];

    target.cookies.emit(target.cookies.jar[0]);
    await refresh.flushNow(target);

    expect(writes).toEqual([[{ name: "web_session", value: "fresh", domain: ".xiaohongshu.com" }]]);
  });

  test("ignores removals so logout cannot overwrite a known-good credential", async () => {
    let writes = 0;
    const target = session();
    const refresh = new CookieCredentialAutoRefresh({
      persist: () => {
        writes += 1;
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "xhs",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      seedJar: [{ name: "web_session", value: "old", domain: ".xiaohongshu.com" }],
    });

    target.cookies.emit({ name: "web_session", value: "old", domain: ".xiaohongshu.com" }, true);
    await refresh.flushNow(target);
    expect(writes).toBe(0);
  });

  test("rebinding a Session detaches the previous credential listener", async () => {
    const writes: string[] = [];
    const target = session();
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, id) => {
        writes.push(id);
        return "updated";
      },
    });
    const common = {
      session: target,
      credentialScope: "full" as const,
      storeScope: "user" as const,
      captureScope: "all" as const,
      seedJar: [{ name: "sid", value: "1", domain: ".xiaohongshu.com" }],
    };
    refresh.bind({ ...common, credentialId: "first" });
    refresh.bind({ ...common, credentialId: "second" });
    target.cookies.jar = [{ name: "sid", value: "2", domain: ".xiaohongshu.com" }];

    target.cookies.emit(target.cookies.jar[0]);
    await refresh.flushNow(target);
    expect(writes).toEqual(["second"]);
  });

  test("keeps bindings for unrelated domains in the same browser Session", async () => {
    const writes: string[] = [];
    const target = session();
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, id) => {
        writes.push(id);
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "xhs",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      seedJar: [{ name: "sid", value: "1", domain: ".xiaohongshu.com" }],
    });
    refresh.bind({
      session: target,
      credentialId: "github",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      seedJar: [{ name: "sid", value: "1", domain: ".github.com" }],
    });
    target.cookies.jar = [
      { name: "sid", value: "2", domain: ".xiaohongshu.com" },
      { name: "sid", value: "2", domain: ".github.com" },
    ];

    target.cookies.emit(target.cookies.jar[0]);
    await refresh.flushNow(target);
    expect(writes).toEqual(["xhs"]);

    target.cookies.emit(target.cookies.jar[1]);
    await refresh.flushNow(target);
    expect(writes).toEqual(["xhs", "github"]);
  });

  test("moves one credential binding to the latest browser Session", async () => {
    const writes: string[] = [];
    const first = session();
    const second = session();
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, id) => {
        writes.push(id);
        return "updated";
      },
    });
    const binding = {
      credentialId: "xhs",
      credentialScope: "full" as const,
      storeScope: "user" as const,
      captureScope: "all" as const,
      seedJar: [{ name: "sid", value: "1", domain: ".xiaohongshu.com" }],
    };
    refresh.bind({ ...binding, session: first });
    refresh.bind({ ...binding, session: second });
    first.cookies.jar = [{ name: "sid", value: "stale", domain: ".xiaohongshu.com" }];
    second.cookies.jar = [{ name: "sid", value: "fresh", domain: ".xiaohongshu.com" }];

    first.cookies.emit(first.cookies.jar[0]);
    await refresh.flushNow(first);
    expect(writes).toEqual([]);

    second.cookies.emit(second.cookies.jar[0]);
    await refresh.flushNow(second);
    expect(writes).toEqual(["xhs"]);
  });

  test("cancels pending captures on deletion and rejects later incomplete guest jars", async () => {
    const writes: unknown[][] = [];
    const target = session();
    const auth = { name: "sid", value: "saved", domain: ".example.com" };
    const tracking = { name: "tracking", value: "one", domain: ".example.com" };
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, _id, _scope, jar) => {
        writes.push(jar);
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "login",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      seedJar: [auth, tracking],
    });
    target.cookies.emit(tracking);
    target.cookies.jar = [tracking];
    target.cookies.emit(auth, true);
    await refresh.flushNow(target);
    expect(writes).toHaveLength(0);

    target.cookies.emit(tracking);
    await refresh.flushNow(target);
    expect(writes).toHaveLength(0);

    target.cookies.jar = [{ ...auth, value: "rotated" }, tracking];
    target.cookies.emit(target.cookies.jar[0]);
    await refresh.flushNow(target);
    expect(writes).toEqual([target.cookies.jar]);
  });

  test("drops an older capture that resolves after a newer rotation", async () => {
    const writes: unknown[][] = [];
    const target = session();
    const oldCookie = { name: "sid", value: "old", domain: ".example.com" };
    const newCookie = { ...oldCookie, value: "new" };
    const firstRead = deferred<ElectronCookieLike[]>();
    const secondRead = deferred<ElectronCookieLike[]>();
    let reads = 0;
    target.cookies.get = () => (++reads === 1 ? firstRead.promise : secondRead.promise);
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, _id, _scope, jar) => {
        writes.push(jar);
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "login",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      seedJar: [oldCookie],
    });
    target.cookies.emit(oldCookie);
    const firstFlush = refresh.flushNow(target);
    target.cookies.emit(newCookie);
    const secondFlush = refresh.flushNow(target);
    secondRead.resolve([newCookie]);
    await secondFlush;
    firstRead.resolve([oldCookie]);
    await firstFlush;
    expect(writes).toEqual([[newCookie]]);
  });

  test("invalidates an in-flight capture when logout removes a cookie", async () => {
    const target = session();
    const cookie = { name: "sid", value: "old", domain: ".example.com" };
    const read = deferred<ElectronCookieLike[]>();
    target.cookies.get = () => read.promise;
    let writes = 0;
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: () => {
        writes += 1;
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "login",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      seedJar: [cookie],
    });
    target.cookies.emit(cookie);
    const pending = refresh.flushNow(target);
    target.cookies.emit(cookie, true);
    read.resolve([cookie]);
    await pending;
    expect(writes).toBe(0);
  });

  test("does not capture parent-domain cookies for a narrowly scoped seed", async () => {
    const target = session();
    const narrow = { name: "sid", value: "old", domain: "account.example.com" };
    const parent = { name: "other", value: "unrelated", domain: ".example.com" };
    const writes: unknown[][] = [];
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, _id, _scope, jar) => {
        writes.push(jar);
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "narrow",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      seedJar: [narrow],
    });
    target.cookies.jar = [{ ...narrow, value: "new" }, parent];
    target.cookies.emit(parent);
    await refresh.flushNow(target);
    expect(writes).toHaveLength(0);
    target.cookies.emit(target.cookies.jar[0]);
    await refresh.flushNow(target);
    expect(writes).toEqual([[target.cookies.jar[0]]]);

    // Parent- and child-domain accounts still conflict when replacing a binding.
    refresh.prepareRestore(target, [parent]);
    expect(target.cookies.listeners.size).toBe(0);
  });

  test("detaches overlapping accounts before restore while preserving unrelated sites", async () => {
    const target = session();
    const xhs = { name: "sid", value: "old", domain: ".xiaohongshu.com" };
    const github = { name: "sid", value: "old", domain: ".github.com" };
    const writes: string[] = [];
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, id) => {
        writes.push(id);
        return "updated";
      },
    });
    for (const [id, cookie] of [
      ["xhs", xhs],
      ["github", github],
    ] as const) {
      refresh.bind({
        session: target,
        credentialId: id,
        credentialScope: "full",
        storeScope: "user",
        captureScope: "all",
        seedJar: [cookie],
      });
    }
    target.cookies.emit(xhs);
    refresh.prepareRestore(target, [xhs], "merge");
    target.cookies.jar = [{ ...xhs, value: "other-account" }, github];
    target.cookies.emit(target.cookies.jar[0]);
    target.cookies.emit(github);
    await refresh.flushNow(target);
    expect(writes).toEqual(["github"]);
    expect(target.cookies.listeners.size).toBe(1);

    refresh.prepareRestore(target, [xhs], "clear");
    expect(target.cookies.listeners.size).toBe(0);
  });

  test("writes to the bound store layer with the latest expected source secret", async () => {
    const target = session();
    const cookie = { name: "sid", value: "old", domain: ".example.com" };
    const sourceSecret = JSON.stringify([cookie], null, 2);
    const expected: Array<[string, string]> = [];
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, _id, scope, _jar, secret) => {
        expected.push([scope, secret]);
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "login",
      credentialScope: "full",
      storeScope: "project",
      sessionCwd: "/project",
      captureScope: "all",
      sourceSecret,
      seedJar: [cookie],
    });
    const firstJar = [{ ...cookie, value: "first" }];
    target.cookies.jar = firstJar;
    target.cookies.emit(firstJar[0]);
    await refresh.flushNow(target);
    target.cookies.jar = [{ ...cookie, value: "second" }];
    target.cookies.emit(target.cookies.jar[0]);
    await refresh.flushNow(target);
    expect(expected).toEqual([
      ["project", sourceSecret],
      ["project", JSON.stringify(firstJar)],
    ]);
  });

  for (const result of ["missing", "conflict"] as const) {
    test(`stops synchronizing when the bound credential is ${result}`, async () => {
      const target = session();
      const cookie = { name: "sid", value: "old", domain: ".example.com" };
      const refresh = new CookieCredentialAutoRefresh({
        debounceMs: 60_000,
        persist: () => result,
      });
      refresh.bind({
        session: target,
        credentialId: "login",
        credentialScope: "full",
        storeScope: "user",
        captureScope: "all",
        seedJar: [cookie],
      });
      target.cookies.jar = [cookie];
      target.cookies.emit(cookie);
      await refresh.flushNow(target);
      expect(target.cookies.listeners.size).toBe(0);
    });
  }

  test("detaches only the selected store-layer binding and releases all listeners on close", () => {
    const userSession = session();
    const projectSession = session();
    const cookie = { name: "sid", value: "old", domain: ".example.com" };
    const refresh = new CookieCredentialAutoRefresh();
    const common = {
      credentialId: "login",
      credentialScope: "full" as const,
      captureScope: "all" as const,
      seedJar: [cookie],
      sessionCwd: "/project",
    };
    refresh.bind({ ...common, session: userSession, storeScope: "user" });
    refresh.bind({ ...common, session: projectSession, storeScope: "project" });
    refresh.detachForCredential("/project", "login", "project");
    expect(userSession.cookies.listeners.size).toBe(1);
    expect(projectSession.cookies.listeners.size).toBe(0);
    refresh.closeAll();
    expect(userSession.cookies.listeners.size).toBe(0);
  });

  test("enabling sync captures the current bound profile without another cookie event", async () => {
    const target = session();
    const cookie = { name: "sid", value: "old", domain: ".example.com" };
    const writes: unknown[][] = [];
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, _id, _scope, jar) => {
        writes.push(jar);
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "login",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      seedJar: [cookie],
    });
    target.cookies.jar = [{ ...cookie, value: "rotated-while-disabled" }];
    expect(refresh.requestRefreshForCredential(undefined, "login", "project")).toBe(false);
    expect(refresh.requestRefreshForCredential(undefined, "login", "user")).toBe(true);
    await refresh.flushNow(target);
    expect(writes).toEqual([target.cookies.jar]);
  });

  test("disabling sync cancels both queued and in-flight snapshots while keeping its binding", async () => {
    const target = session();
    const cookie = { name: "sid", value: "old", domain: ".example.com" };
    const read = deferred<ElectronCookieLike[]>();
    let reads = 0;
    target.cookies.get = () => {
      reads += 1;
      return read.promise;
    };
    let writes = 0;
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: () => {
        writes += 1;
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "login",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      seedJar: [cookie],
    });
    refresh.requestRefreshForCredential(undefined, "login", "user");
    expect(refresh.cancelRefreshForCredential(undefined, "login", "user")).toBe(true);
    await refresh.flushNow(target);
    expect(reads).toBe(0);

    refresh.requestRefreshForCredential(undefined, "login", "user");
    const pending = refresh.flushNow(target);
    refresh.cancelRefreshForCredential(undefined, "login", "user");
    read.resolve([{ ...cookie, value: "new" }]);
    await pending;
    expect(writes).toBe(0);
    expect(target.cookies.listeners.size).toBe(1);
    refresh.closeAll();
  });

  test("disabled bindings avoid reads and enabling again saves the latest browser state", async () => {
    const target = session();
    const cookie = { name: "sid", value: "old", domain: ".example.com" };
    const writes: unknown[][] = [];
    let reads = 0;
    target.cookies.get = async () => {
      reads += 1;
      return [...target.cookies.jar];
    };
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, _id, _scope, jar) => {
        writes.push(jar);
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "login",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      seedJar: [cookie],
      enabled: false,
    });
    target.cookies.jar = [{ ...cookie, value: "first" }];
    target.cookies.emit(target.cookies.jar[0]);
    await refresh.flushNow(target);
    expect(reads).toBe(0);
    expect(writes).toHaveLength(0);

    refresh.requestRefreshForCredential(undefined, "login", "user");
    await refresh.flushNow(target);
    expect(reads).toBe(1);
    expect(writes).toEqual([target.cookies.jar]);

    refresh.cancelRefreshForCredential(undefined, "login", "user");
    target.cookies.emit(target.cookies.jar[0], true);
    target.cookies.jar = [{ ...cookie, value: "latest" }];
    target.cookies.emit(target.cookies.jar[0]);
    await refresh.flushNow(target);
    expect(reads).toBe(1);

    refresh.requestRefreshForCredential(undefined, "login", "user");
    await refresh.flushNow(target);
    expect(reads).toBe(2);
    expect(writes.at(-1)).toEqual(target.cookies.jar);
  });

  test("shutdown flushes pending snapshots before detaching every listener", async () => {
    const target = session();
    const cookie = { name: "sid", value: "old", domain: ".example.com" };
    const writes: unknown[][] = [];
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, _id, _scope, jar) => {
        writes.push(jar);
        return "updated";
      },
    });
    const binding = {
      session: target,
      credentialId: "login",
      credentialScope: "full" as const,
      storeScope: "user" as const,
      captureScope: "all" as const,
      seedJar: [cookie],
    };
    refresh.bind(binding);
    target.cookies.jar = [{ ...cookie, value: "latest" }];
    target.cookies.emit(target.cookies.jar[0]);
    const shutdown = refresh.shutdown();
    expect(refresh.shutdown()).toBe(shutdown);
    expect(refresh.requestRefreshForCredential(undefined, "login", "user")).toBe(false);
    expect(refresh.bind(binding)).toBe(false);
    await shutdown;
    expect(writes).toEqual([target.cookies.jar]);
    expect(target.cookies.listeners.size).toBe(0);
  });

  test("shutdown waits for in-flight reads and drains a newer rotation without saving stale state", async () => {
    const target = session();
    const oldCookie = { name: "sid", value: "old", domain: ".example.com" };
    const newCookie = { ...oldCookie, value: "new" };
    const firstRead = deferred<ElectronCookieLike[]>();
    let reads = 0;
    target.cookies.get = () => (++reads === 1 ? firstRead.promise : Promise.resolve([newCookie]));
    const writes: unknown[][] = [];
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      persist: (_cwd, _id, _scope, jar) => {
        writes.push(jar);
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "login",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      seedJar: [oldCookie],
    });
    target.cookies.emit(oldCookie);
    const firstFlush = refresh.flushNow(target);
    const quitting = refresh.shutdown();
    target.cookies.emit(newCookie);
    firstRead.resolve([oldCookie]);
    await firstFlush;
    await quitting;
    expect(writes).toEqual([[newCookie]]);
    expect(target.cookies.listeners.size).toBe(0);
  });

  test("shutdown is bounded and ignores snapshots that arrive after its deadline", async () => {
    const target = session();
    const cookie = { name: "sid", value: "old", domain: ".example.com" };
    const read = deferred<ElectronCookieLike[]>();
    target.cookies.get = () => read.promise;
    let writes = 0;
    const refresh = new CookieCredentialAutoRefresh({
      debounceMs: 60_000,
      shutdownTimeoutMs: 5,
      persist: () => {
        writes += 1;
        return "updated";
      },
    });
    refresh.bind({
      session: target,
      credentialId: "login",
      credentialScope: "full",
      storeScope: "user",
      captureScope: "all",
      seedJar: [cookie],
    });
    target.cookies.emit(cookie);
    const pending = refresh.flushNow(target);
    await refresh.shutdown();
    expect(target.cookies.listeners.size).toBe(0);
    read.resolve([cookie]);
    await pending;
    expect(writes).toBe(0);
  });
});
