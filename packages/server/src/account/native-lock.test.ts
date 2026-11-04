import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudAccountStore, type CloudAccountGrant } from "./store.js";
import { acquireNativeAccountLock } from "./native-lock.js";
import { runAccountCli } from "./cli.js";
import { fixtureCipher } from "./__fixtures__/native-account-fixture-store.js";

const origin = "https://accounts.example";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Child did not reach the fixture checkpoint");
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function concurrentCommands(
  firstAction: "status" | "login" | "logout",
  secondAction: "status" | "login" | "logout",
) {
  const directory = mkdtempSync(join(tmpdir(), "native-account-lock-"));
  const path = join(directory, "credentials.enc");
  const store = new CloudAccountStore(path, fixtureCipher());
  const account = { id: randomUUID(), username: "member" };
  const grant = (sessionId = randomUUID()): CloudAccountGrant => ({
    sessionId,
    account,
    accessToken: randomBytes(32).toString("base64url"),
    refreshToken: randomBytes(32).toString("base64url"),
    accessTokenExpiresAt: Date.now() + 600_000,
    refreshTokenExpiresAt: Date.now() + 86_400_000,
  });
  const initial = { ...grant(), accessTokenExpiresAt: Date.now() - 1000 };
  store.save({ ...initial, origin });
  const sessions = new Map([[initial.sessionId, { grant: initial, revoked: false }]]);
  const used = new Map<string, string>();
  const requests: string[] = [];
  let refreshReuse = 0;
  let latestLogin: CloudAccountGrant | undefined;
  const entered = deferred(),
    release = deferred();
  let held = false;
  const holdPath = firstAction === "status" ? "refresh" : firstAction;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const action = new URL(request.url).pathname.slice("/api/v1/account/".length);
      requests.push(action);
      if (!held && action === holdPath) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      if (action === "refresh") {
        const { refreshToken } = await request.json();
        const reused = used.get(refreshToken);
        if (reused) {
          refreshReuse++;
          sessions.get(reused)!.revoked = true;
          return Response.json({ error: "refresh_used" }, { status: 401 });
        }
        const session = [...sessions.values()].find((s) => s.grant.refreshToken === refreshToken);
        if (!session || session.revoked) return Response.json({}, { status: 401 });
        used.set(refreshToken, session.grant.sessionId);
        session.grant = grant(session.grant.sessionId);
        return Response.json(session.grant);
      }
      if (action === "login") {
        latestLogin = grant();
        sessions.set(latestLogin.sessionId, { grant: latestLogin, revoked: false });
        return Response.json(latestLogin);
      }
      if (action === "logout") {
        const session = [...sessions.values()].find(
          (s) => "Bearer " + s.grant.accessToken === request.headers.get("authorization"),
        );
        if (!session) return Response.json({}, { status: 401 });
        session.revoked = true;
        return Response.json({ ok: true });
      }
      if (action === "status")
        return Response.json({ registrationAllowed: true, githubEnabled: false, features: {} });
      if (action === "overview")
        return Response.json({ account, capabilities: { links: false }, features: {} });
      return Response.json({}, { status: 404 });
    },
  });
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const child = (action: string, role: string) => {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./__fixtures__/native-account-cli-child.ts", import.meta.url)),
        directory,
        server.url.href,
        origin,
        action,
        role,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    children.push(subprocess);
    return Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
  };
  try {
    const first = child(firstAction, "first");
    await Promise.race([
      entered.promise,
      first.then((result) => {
        throw new Error("First child ended before the held request: " + JSON.stringify(result));
      }),
    ]);
    const second = child(secondAction, "second");
    await waitFor(() => existsSync(join(directory, "second.started")));
    // The second process entered runAccountCli while the first network request is pending.
    await new Promise((done) => setTimeout(done, 80));
    expect(existsSync(join(directory, "second.manager"))).toBe(false);
    release.resolve();
    const results = await Promise.all([first, second]);
    for (const [code, stdout, stderr] of results) {
      expect(code, stderr).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).not.toContain(initial.refreshToken);
      expect(stdout).not.toContain("fixture-password-123");
    }
    expect(refreshReuse).toBe(0);
    const saved = store.load();
    if (secondAction === "logout") {
      expect(saved).toBeUndefined();
      expect([...sessions.values()].every((session) => session.revoked)).toBe(true);
    } else if (secondAction === "login") {
      expect(saved?.sessionId).toBe(latestLogin!.sessionId);
      expect(sessions.get(latestLogin!.sessionId)?.revoked).toBe(false);
      expect(sessions.get(initial.sessionId)?.revoked).toBe(true);
    } else {
      expect(saved?.refreshToken).toBe(sessions.get(initial.sessionId)?.grant.refreshToken);
      expect(sessions.get(initial.sessionId)?.revoked).toBe(false);
    }
    expect(requests.filter((action) => action === "refresh")).toHaveLength(1);
    if (existsSync(path))
      expect(readFileSync(path).includes(Buffer.from(initial.refreshToken))).toBe(false);
  } finally {
    release.resolve();
    for (const subprocess of children) if (subprocess.exitCode === null) subprocess.kill();
    await Promise.all(children.map((subprocess) => subprocess.exited));
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [first, second] of [
  ["status", "status"],
  ["status", "logout"],
  ["status", "login"],
  ["logout", "login"],
  ["login", "logout"],
] as const)
  test(
    "real native processes serialize " +
      first +
      " then " +
      second +
      " without refresh reuse or lost login",
    () => concurrentCommands(first, second),
  );

test("an old live lock is never stolen, independent origins remain usable, and waiting is bounded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-account-live-lock-"));
  const release = await acquireNativeAccountLock(origin, directory);
  const parent = join(directory, readdirSync(directory)[0]!);
  const lock = join(parent, readdirSync(parent)[0]!);
  utimesSync(lock, new Date(0), new Date(0));
  let timerRan = false;
  const timer = setTimeout(() => {
    timerRan = true;
  }, 20);
  try {
    const other = await acquireNativeAccountLock("https://other.example", directory);
    await other();
    await expect(acquireNativeAccountLock(origin, directory)).rejects.toMatchObject({
      code: "ELOCKED",
    });
    expect(timerRan).toBe(true);
    expect(existsSync(lock)).toBe(true);
  } finally {
    clearTimeout(timer);
    await release();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

test("manager construction failures release the lifecycle lock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-account-failed-lock-"));
  try {
    await expect(
      runAccountCli(["status", "--origin", origin], {
        acquireLock: (origin) => acquireNativeAccountLock(origin, directory),
        createManager() {
          throw new Error("fixture constructor failed");
        },
      }),
    ).rejects.toThrow("fixture constructor failed");
    await (
      await acquireNativeAccountLock(origin, directory)
    )();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
