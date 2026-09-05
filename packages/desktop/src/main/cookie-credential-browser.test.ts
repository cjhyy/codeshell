import { describe, expect, test } from "bun:test";
import {
  restoreCookieCredentialToBrowser,
  type RestoreCookieCredentialDeps,
  type RestoreCookieCredentialInput,
} from "./cookie-credential-browser.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const target = { cookies: {} } as Electron.Session;
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const jar = [{ name: "sid", value: "selected-account", domain: ".example.com" }];
  const input: RestoreCookieCredentialInput = {
    sessionCwd: "/project",
    credentialId: "selected",
    credentialScope: "full",
    targetSession: "persist:browser:project::session",
    resolved: {
      ok: true,
      label: "Selected account",
      jar,
      sourceSecret: JSON.stringify(jar),
      autoRefreshEnabled: true,
      switchMode: "merge",
      captureScope: "domain",
      domain: "example.com",
      storeScope: "project",
    },
  };
  const deps: RestoreCookieCredentialDeps = {
    readCredential: (request) => ({ ...request.resolved }),
    resolveSession: async (...args) => {
      calls.push({ name: "resolve", args });
      return target;
    },
    restore: async (...args) => {
      calls.push({ name: "restore", args });
      return { count: jar.length };
    },
    autoRefresh: {
      prepareRestore: (...args) => {
        calls.push({ name: "prepare", args });
      },
      detachForCredential: (...args) => {
        calls.push({ name: "detach", args });
      },
      bind: (...args) => {
        calls.push({ name: "bind", args });
        return true;
      },
    },
  };
  return { target, calls, input, deps };
}

describe("restoreCookieCredentialToBrowser", () => {
  test("detaches old account and source bindings before Cookie writes begin", async () => {
    const { target, calls, input, deps } = fixture();

    expect(await restoreCookieCredentialToBrowser(input, deps)).toEqual({ count: 1 });

    expect(calls).toEqual([
      { name: "resolve", args: [input.targetSession] },
      { name: "prepare", args: [target, input.resolved.jar, "merge"] },
      { name: "detach", args: ["/project", "selected", "project"] },
      { name: "restore", args: [input.resolved.jar, "merge", target] },
      {
        name: "bind",
        args: [
          {
            session: target,
            sessionCwd: "/project",
            credentialId: "selected",
            credentialScope: "full",
            storeScope: "project",
            captureScope: "domain",
            domain: "example.com",
            seedJar: input.resolved.jar,
            sourceSecret: input.resolved.sourceSecret,
            enabled: true,
          },
        ],
      },
    ]);
  });

  test("does not bind a credential whose Cookie writes all failed", async () => {
    const { calls, input, deps } = fixture();
    deps.restore = async () => ({ count: 0 });

    expect(await restoreCookieCredentialToBrowser(input, deps)).toEqual({ count: 0 });
    expect(calls.map((call) => call.name)).toEqual(["resolve", "prepare", "detach"]);
  });

  test("propagates restore failure without reattaching a possibly mixed account", async () => {
    const { calls, input, deps } = fixture();
    deps.restore = async () => {
      throw new Error("Cookie storage failed");
    };

    await expect(restoreCookieCredentialToBrowser(input, deps)).rejects.toThrow(
      "Cookie storage failed",
    );
    expect(calls.map((call) => call.name)).toEqual(["resolve", "prepare", "detach"]);
  });

  test("does not sync a partially restored login back over its complete snapshot", async () => {
    const { calls, input, deps } = fixture();
    input.resolved.jar.push({ name: "second", value: "required", domain: ".example.com" });
    deps.restore = async () => ({ count: 1 });

    expect(await restoreCookieCredentialToBrowser(input, deps)).toEqual({ count: 1 });
    expect(calls.map((call) => call.name)).toEqual(["resolve", "prepare", "detach"]);
  });

  test("rejects empty credentials before clear mode can erase an existing login", async () => {
    const { calls, input, deps } = fixture();
    input.resolved.jar = [];
    input.resolved.switchMode = "clear";

    await expect(restoreCookieCredentialToBrowser(input, deps)).rejects.toThrow("empty");
    expect(calls).toEqual([]);
  });

  test("uses the latest saved login when a restore was waiting for its Session", async () => {
    const { target, calls, input, deps } = fixture();
    const sessionRequested = deferred();
    const releaseSession = deferred();
    deps.resolveSession = async () => {
      sessionRequested.resolve();
      await releaseSession.promise;
      return target;
    };
    const restoring = restoreCookieCredentialToBrowser(input, deps);
    await sessionRequested.promise;
    const jar = [{ name: "sid", value: "newer-login", domain: ".example.com" }];
    input.resolved = { ...input.resolved, jar, sourceSecret: JSON.stringify(jar) };
    releaseSession.resolve();
    await restoring;

    expect(calls.find((call) => call.name === "restore")?.args[0]).toEqual(jar);
    expect(calls.find((call) => call.name === "bind")?.args[0]).toMatchObject({
      sourceSecret: JSON.stringify(jar),
      seedJar: jar,
    });
  });

  test("does not clear browser storage when the credential was deleted before restore", async () => {
    const { calls, input, deps } = fixture();
    input.resolved.switchMode = "clear";
    deps.readCredential = () => ({ ok: false, error: "Credential deleted" });

    await expect(restoreCookieCredentialToBrowser(input, deps)).rejects.toThrow(
      "Credential deleted",
    );
    expect(calls.map((call) => call.name)).toEqual(["resolve"]);
  });

  test("honors an OFF to ON toggle made while Cookie restoration is in progress", async () => {
    const { calls, input, deps } = fixture();
    input.resolved.autoRefreshEnabled = false;
    const started = deferred();
    const release = deferred();
    deps.restore = async () => {
      started.resolve();
      await release.promise;
      return { count: 1 };
    };
    const restoring = restoreCookieCredentialToBrowser(input, deps);
    await started.promise;
    input.resolved = { ...input.resolved, autoRefreshEnabled: true };
    release.resolve();
    await restoring;

    expect(calls.find((call) => call.name === "bind")?.args[0]).toMatchObject({ enabled: true });
  });

  for (const change of ["deleted", "replaced"] as const) {
    test(`does not rebind a credential ${change} during Cookie restoration`, async () => {
      const { calls, input, deps } = fixture();
      const started = deferred();
      const release = deferred();
      deps.restore = async () => {
        started.resolve();
        await release.promise;
        return { count: 1 };
      };
      const restoring = restoreCookieCredentialToBrowser(input, deps);
      await started.promise;
      if (change === "deleted") {
        deps.readCredential = () => ({ ok: false, error: "Credential deleted" });
      } else {
        input.resolved = { ...input.resolved, sourceSecret: "new manual login snapshot" };
      }
      release.resolve();
      expect(await restoring).toEqual({ count: 1 });
      expect(calls.some((call) => call.name === "bind")).toBe(false);
    });
  }

  test("serializes account switches that target the same browser Session", async () => {
    const { input, deps } = fixture();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondResolved = deferred();
    const events: string[] = [];
    deps.restore = async (jar) => {
      const account = jar[0].value;
      events.push(`start:${account}`);
      if (account === "selected-account") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      events.push(`finish:${account}`);
      return { count: jar.length };
    };
    deps.autoRefresh.bind = (binding) => {
      events.push(`bind:${binding.credentialId}`);
      return true;
    };
    const first = restoreCookieCredentialToBrowser(input, deps);
    await firstStarted.promise;
    const secondInput = {
      ...input,
      credentialId: "second",
      resolved: {
        ...input.resolved,
        jar: [{ name: "sid", value: "second-account", domain: ".example.com" }],
      },
    };
    const second = restoreCookieCredentialToBrowser(secondInput, {
      ...deps,
      resolveSession: async (target) => {
        const session = await deps.resolveSession(target);
        secondResolved.resolve();
        return session;
      },
    });
    await secondResolved.promise;
    await Promise.resolve();
    expect(events).toEqual(["start:selected-account"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "start:selected-account",
      "finish:selected-account",
      "bind:selected",
      "start:second-account",
      "finish:second-account",
      "bind:second",
    ]);
  });

  test("serializes transferring one user credential between browser Sessions", async () => {
    const first = fixture();
    const second = fixture();
    second.input.sessionCwd = "/other-project";
    first.input.resolved.storeScope = "user";
    second.input.resolved.storeScope = "user";
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondResolved = deferred();
    const events: string[] = [];
    first.deps.restore = async () => {
      events.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("first:finish");
      return { count: 1 };
    };
    second.deps.resolveSession = async () => {
      secondResolved.resolve();
      return second.target;
    };
    second.deps.restore = async () => {
      events.push("second:start");
      return { count: 1 };
    };
    const firstRestore = restoreCookieCredentialToBrowser(first.input, first.deps);
    await firstStarted.promise;
    const secondRestore = restoreCookieCredentialToBrowser(second.input, second.deps);
    await secondResolved.promise;
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst.resolve();
    await Promise.all([firstRestore, secondRestore]);
    expect(events).toEqual(["first:start", "first:finish", "second:start"]);
  });
});
