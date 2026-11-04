import { expect, test } from "bun:test";
import { CloudAccountManager } from "./manager.js";
import { MemoryAccountStore } from "./native-store.js";
import { parseAccountArgs, runAccountCli } from "./cli.js";
import { CloudAccountHttpError, type CloudAccountRequest } from "./http.js";
const origin = "https://accounts.example";
const identity = {
  id: "22222222-2222-4222-8222-222222222222",
  username: "member",
  displayName: "Member",
};
function setup({
  discoveryFailures = 0,
  overviewError,
  omitFeatures = false,
  linkManagementEnabled = true,
  registrationAllowed = true,
}: {
  discoveryFailures?: number;
  overviewError?: Error;
  omitFeatures?: boolean;
  linkManagementEnabled?: boolean;
  registrationAllowed?: boolean;
} = {}) {
  const requests: CloudAccountRequest[] = [];
  const store = new MemoryAccountStore();
  const manager = new CloudAccountManager({
    store,
    openExternal: async () => {},
    changed() {},
    request: async (input) => {
      requests.push(input);
      if (input.path.endsWith("/login"))
        return {
          accessToken: "a".repeat(43),
          refreshToken: "b".repeat(43),
          accessTokenExpiresAt: Date.now() + 600000,
          refreshTokenExpiresAt: Date.now() + 86400000,
          sessionId: "11111111-1111-4111-8111-111111111111",
          account: identity,
        };
      if (input.path.endsWith("/status") && discoveryFailures-- > 0)
        throw new Error("private-upstream-failure");
      if (input.path.endsWith("/status"))
        return {
          registrationAllowed,
          linkManagementEnabled,
          githubEnabled: false,
          ...(omitFeatures ? {} : { features: { "links.remote": { version: 1, enabled: true } } }),
        };
      if (input.path.endsWith("/overview") && overviewError) throw overviewError;
      if (input.path.endsWith("/overview"))
        return {
          account: identity,
          ...(omitFeatures
            ? {}
            : {
                features: {
                  "links.remote": {
                    version: 1,
                    enabled: true,
                    params: { secret: "do-not-project" },
                  },
                },
              }),
          capabilities: { links: true },
          refreshToken: "do-not-project",
        };
      if (input.path.endsWith("/links"))
        return { linkOrigin: "https://links.example", connections: [], grants: [] };
      if (input.path.endsWith("/logout")) return { ok: true };
      throw new Error("unexpected fixture request");
    },
  });
  return { manager, requests, store };
}
test("CLI rejects argv passwords and registration only navigates to the selected website", async () => {
  expect(() => parseAccountArgs(["login", "--password", "never-log"])).toThrow("Passwords");
  expect(() => parseAccountArgs(["login", "--origin", "https://account.example/path"])).toThrow();
  const urls: string[] = [];
  const { manager, requests, store } = setup();
  await runAccountCli(["register", "--origin", origin], {
    acquireLock: async () => {
      throw new Error("registration must not lock persistent credentials");
    },
    write() {},
    open: async (url) => {
      urls.push(url);
    },
    createManager: () => manager,
  });
  expect(urls).toEqual([origin + "/register"]);
  expect(requests.map((r) => r.path)).toEqual(["/api/v1/account/status"]);
  expect(store.load()).toBeUndefined();
});
test("memory login stays usable for live features/status and revokes on normal exit", async () => {
  const { manager, requests, store } = setup();
  const output: string[] = [],
    answers = ["fixture-password-123", "features", "links", "status", "exit"];
  await runAccountCli(["login", "--memory", "--origin", origin, "--username", "member"], {
    acquireLock: async () => {
      throw new Error("memory sessions must not lock persistent credentials");
    },
    interactive: true,
    createManager: () => manager,
    prompt: async () => answers.shift()!,
    write: (value) => output.push(value),
  });
  expect(requests.filter((r) => r.path.endsWith("/overview"))).toHaveLength(3);
  expect(requests.some((r) => r.path.endsWith("/logout"))).toBe(true);
  expect(store.load()).toBeUndefined();
  expect(output.join()).toContain("links.remote");
  expect(requests.some((r) => r.path.endsWith("/links"))).toBe(true);
  const projection = JSON.parse(
    output.find((value) => value.startsWith("{") && value.includes('"features"'))!,
  );
  expect(projection.features["links.remote"].state).toBe("ready");
  expect(projection.features["cloud.projects"].state).toBe("hidden");
  expect(projection.features["devices.dispatch"].state).toBe("hidden");
  for (const secret of ["fixture-password-123", "a".repeat(43), "b".repeat(43), "do-not-project"])
    expect(output.join()).not.toContain(secret);
});
test("persistent stdin login retains credentials while memory refuses a process that cannot remain interactive", async () => {
  const { manager, store } = setup();
  await runAccountCli(["login", "--origin", origin, "--username", "member", "--password-stdin"], {
    createManager: () => manager,
    readPassword: async () => "fixture-password-123",
    write() {},
  });
  expect(store.load()?.account.id).toBe(identity.id);
  await expect(
    runAccountCli(["login", "--memory"], {
      interactive: false,
      createManager() {
        throw new Error("must reject before login");
      },
    }),
  ).rejects.toThrow("interactive");
});
test("overview strips secrets, status subscriptions are public, and old identity responses are cancelled", async () => {
  const { manager } = setup();
  const statuses: unknown[] = [];
  const off = manager.onStatus((status) => statuses.push(status));
  await manager.signIn("login", { origin, username: "member", password: "fixture-password-123" });
  const overview = await manager.overview({ origin, accountId: identity.id });
  expect(JSON.stringify(overview)).not.toContain("do-not-project");
  expect(Object.keys(overview).sort()).toEqual(["account", "features"]);
  expect(JSON.stringify(statuses)).not.toContain("Token");
  const abort = new AbortController();
  abort.abort();
  await expect(
    manager.overview({ origin, accountId: identity.id }, () => true, abort.signal),
  ).rejects.toThrow();
  await expect(
    manager.overview({ origin, accountId: "33333333-3333-4333-8333-333333333333" }),
  ).rejects.toThrow();
  off();
  manager.dispose();
});

test("serve account route reaches registration without starting a Hub or contacting Account", async () => {
  const { runServeCli } = await import("../serve/cli.js");
  const original = console.log;
  const output: unknown[] = [];
  console.log = (...values) => {
    output.push(...values);
  };
  try {
    await runServeCli(["account", "--help"]);
  } finally {
    console.log = original;
  }
  expect(output.join()).toContain("--password-stdin");
});

test("TUI account command forwards flags to the shared native entry", async () => {
  const { fileURLToPath } = await import("node:url");
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("../../../tui/src/cli/main.ts", import.meta.url)),
      "account",
      "--help",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("--password-stdin");
});

test("missing features and a handoff-only deployment never enable CLI Link listing", async () => {
  for (const options of [{ omitFeatures: true }, { linkManagementEnabled: false }]) {
    const { manager, requests } = setup(options);
    await manager.signIn("login", { origin, username: "member", password: "fixture-password-123" });
    await expect(
      runAccountCli(["links", "--origin", origin], {
        createManager: () => manager,
        write() {},
      }),
    ).rejects.toThrow("hidden");
    expect(requests.some((r) => r.path.endsWith("/links"))).toBe(false);
  }
});

test("overview errors cannot fall back to public Link configuration", async () => {
  for (const error of [
    new CloudAccountHttpError(404),
    new CloudAccountHttpError(401),
    new CloudAccountHttpError(403),
    new Error("offline"),
  ]) {
    const { manager, requests } = setup({ overviewError: error });
    await manager.signIn("login", { origin, username: "member", password: "fixture-password-123" });
    await expect(
      runAccountCli(["links", "--origin", origin], {
        createManager: () => manager,
        write() {},
      }),
    ).rejects.toBe(error);
    expect(requests.some((r) => r.path.endsWith("/links"))).toBe(false);
  }
});

test("closed registration does not open a website or touch credentials", async () => {
  const { manager, requests, store } = setup({ registrationAllowed: false });
  const urls: string[] = [];
  await expect(
    runAccountCli(["register", "--origin", origin], {
      createManager: () => manager,
      write() {},
      open: async (url) => {
        urls.push(url);
      },
    }),
  ).rejects.toThrow("未开放注册");
  expect(urls).toEqual([]);
  expect(store.load()).toBeUndefined();
  expect(requests.map((r) => r.path)).toEqual(["/api/v1/account/status"]);
});

test("optional feature discovery failure preserves a successful persistent or in-process login", async () => {
  for (const memory of [false, true]) {
    const { manager, requests, store } = setup({ discoveryFailures: 1 });
    const output: string[] = [];
    const answers = ["fixture-password-123", "features", "exit"];
    await runAccountCli(
      [
        "login",
        "--origin",
        origin,
        "--username",
        "member",
        ...(memory ? ["--memory"] : ["--password-stdin"]),
      ],
      {
        createManager: () => manager,
        interactive: true,
        readPassword: async () => "fixture-password-123",
        write: (value) => output.push(value),
        prompt: async () => {
          if (answers.length < 3) expect(manager.status().state).toBe("signed-in");
          return answers.shift()!;
        },
      },
    );
    expect(output.join()).toContain("Signed in. Feature status could not be loaded");
    expect(output.join()).not.toContain("private-upstream-failure");
    if (memory) expect(requests.some((request) => request.path.endsWith("/overview"))).toBe(true);
    else {
      expect(store.load()?.account.id).toBe(identity.id);
      expect(requests.some((request) => request.path.endsWith("/logout"))).toBe(false);
    }
  }
});
