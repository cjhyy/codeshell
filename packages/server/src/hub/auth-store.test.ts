import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubAuthStore } from "./auth-store.js";

const directories: string[] = [];
const credentials = { username: "admin", password: "correct-horse-battery", deviceName: "Laptop" };

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-auth-"));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("HubAuthStore", () => {
  test("bootstrap survives restart, is disclosed once, and cannot be reused", async () => {
    const dataDir = directory();
    const store = new HubAuthStore({ dataDir });
    const token = store.initialize()!;
    expect(token).toHaveLength(43);
    expect(store.initialize()).toBeUndefined();
    const restarted = new HubAuthStore({ dataDir });
    expect(restarted.initialize()).toBeUndefined();
    await expect(restarted.setup({ ...credentials, token: "x".repeat(43) })).rejects.toThrow(
      "Invalid initialization token",
    );
    const grant = await restarted.setup({ ...credentials, token });
    expect(store.isInitialized()).toBe(true);
    expect(store.authenticate(grant.token)?.username).toBe("admin");
    await expect(store.setup({ ...credentials, token })).rejects.toThrow(
      "already been initialized",
    );
    const raw = readFileSync(store.filePath, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(grant.token);
    expect(raw).not.toContain(credentials.password);
    expect(JSON.parse(raw).bootstrapTokenHash).toBeNull();
    expect(statSync(store.filePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "hub")).mode & 0o777).toBe(0o700);
    expect(store.listSessions()[0]).not.toHaveProperty("tokenHash");
  });

  test("concurrent setup has exactly one winner and concurrent logins preserve sessions", async () => {
    const store = new HubAuthStore({ dataDir: directory() });
    const token = store.initialize()!;
    const setup = await Promise.allSettled([
      store.setup({ ...credentials, token }),
      store.setup({ ...credentials, token }),
    ]);
    expect(setup.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const grants = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.login({ ...credentials, deviceName: `Device ${i}` }),
      ),
    );
    expect(store.listSessions()).toHaveLength(6);
    for (const grant of grants) expect(store.authenticate(grant.token)?.id).toBe(grant.session.id);
  });

  test("login rotates the presented session, revocation is immediate across instances, and expiry is fixed", async () => {
    let now = 10_000;
    const dataDir = directory();
    const store = new HubAuthStore({ dataDir, now: () => now, sessionTtlMs: 2_000 });
    const token = store.initialize()!;
    const first = await store.setup({ ...credentials, token });
    const second = await store.login(credentials, first.token);
    expect(second.revokedSessionIds).toEqual([first.session.id]);
    expect(store.authenticate(first.token)).toBeNull();
    const peer = new HubAuthStore({ dataDir, now: () => now });
    peer.initialize();
    expect(peer.authenticate(second.token)?.id).toBe(second.session.id);
    expect(store.revoke(second.session.id)).toBe(true);
    expect(peer.authenticate(second.token)).toBeNull();
    const third = await store.login(credentials);
    now += 2_000;
    expect(store.authenticate(third.token)).toBeNull();
    expect(store.listSessions()).toEqual([]);
  });

  test("bounds persistent sessions and revokes the oldest when issuing beyond the limit", async () => {
    let now = 10_000;
    const store = new HubAuthStore({ dataDir: directory(), maxSessions: 2, now: () => now });
    const first = await store.setup({ ...credentials, token: store.initialize()! });
    now += 1_000;
    await store.login(credentials);
    now += 1_000;
    const third = await store.login(credentials);
    expect(third.revokedSessionIds).toEqual([first.session.id]);
    expect(store.listSessions()).toHaveLength(2);
    expect(store.authenticate(first.token)).toBeNull();
  });

  test("rejects bad credentials and weak or malformed input", async () => {
    const store = new HubAuthStore({ dataDir: directory() });
    const token = store.initialize()!;
    await expect(store.setup({ ...credentials, token, password: "short" })).rejects.toThrow(
      "12–256",
    );
    await store.setup({ ...credentials, token });
    await expect(store.login({ ...credentials, username: "wrong" })).rejects.toThrow(
      "Invalid username or password",
    );
    await expect(store.login({ ...credentials, password: "this-is-incorrect" })).rejects.toThrow(
      "Invalid username or password",
    );
    expect(store.authenticate("bad-token")).toBeNull();
    expect(store.revoke("no-such-id")).toBe(false);
  });

  test("malformed, oversized, deleted, or symlinked stores fail closed", async () => {
    const dataDir = directory();
    const store = new HubAuthStore({ dataDir });
    const grant = await store.setup({ ...credentials, token: store.initialize()! });
    const original = readFileSync(store.filePath, "utf8");
    for (const raw of [
      "{",
      "{}",
      " ".repeat(129 * 1024),
      JSON.stringify({ ...JSON.parse(original), account: null }),
    ]) {
      writeFileSync(store.filePath, raw);
      expect(() => store.initialize()).toThrow("corrupt");
      expect(() => store.authenticate(grant.token)).toThrow("corrupt");
      expect(readFileSync(store.filePath, "utf8")).toBe(raw);
    }
    rmSync(store.filePath);
    expect(() => store.authenticate(grant.token)).toThrow("corrupt");
    const other = join(dataDir, "other.json");
    writeFileSync(other, original);
    symlinkSync(other, store.filePath);
    expect(() => store.initialize()).toThrow("corrupt");
    expect(readFileSync(other, "utf8")).toBe(original);
  });

  test("cross-process bootstrap and login writes share the core file lock", async () => {
    const dataDir = directory();
    const modulePath = join(import.meta.dir, "auth-store.ts");
    const initializeScript = `import {HubAuthStore} from ${JSON.stringify(modulePath)};const s=new HubAuthStore({dataDir:process.argv[1]});process.stdout.write(JSON.stringify({token:s.initialize()}));`;
    const initialized = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const child = Bun.spawn([process.execPath, "--eval", initializeScript, dataDir], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [output, errors, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, errors }).toEqual({ code: 0, errors: "" });
        return JSON.parse(output) as { token?: string };
      }),
    );
    const tokens = initialized.flatMap((value) => (value.token ? [value.token] : []));
    expect(tokens).toHaveLength(1);
    const store = new HubAuthStore({ dataDir });
    await store.setup({ ...credentials, token: tokens[0]! });
    const loginScript = `import {HubAuthStore} from ${JSON.stringify(modulePath)};const s=new HubAuthStore({dataDir:process.argv[1]});s.initialize();for(let i=0;i<3;i++)await s.login(${JSON.stringify(credentials)});`;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        const child = Bun.spawn([process.execPath, "--eval", loginScript, dataDir], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
        expect({ code, errors }).toEqual({ code: 0, errors: "" });
      }),
    );
    expect(store.listSessions()).toHaveLength(10);
  }, 20_000);
});
