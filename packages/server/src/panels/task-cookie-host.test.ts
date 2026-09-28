import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Credential } from "@cjhyy/code-shell-core";
import { PanelTaskCookieHost } from "./task-cookie-host.js";

const scope = { appId: "fixture", projectPath: "/project", revision: "r1" };
const credential: Credential = {
  id: "cookie",
  type: "cookie",
  label: "Fixture",
  meta: { domain: "example.com" },
  secret: JSON.stringify([{ domain: ".example.com", name: "session", value: "secret-fixture" }]),
};
describe("Host-owned task Cookie lifecycle", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "task-cookie-host-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const options = {
      rootDirectory: join(root, "private"),
      authorize: async () => {},
      credentials: async () => [structuredClone(credential)],
    };
    function create() {
      const host = new PanelTaskCookieHost(options);
      cleanups.push(() => host.shutdown());
      return host;
    }
    return { root, options, create };
  }
  async function select(host: PanelTaskCookieHost) {
    const account = (await host.list(scope, "https://example.com")).accounts[0];
    return { credentialId: account.id, revision: account.revision, url: "https://example.com" };
  }
  test("persists a private key, preserves selection versions after restart and closes outstanding leases", async () => {
    const f = await fixture(),
      host = f.create();
    await Promise.all([host.initialize(), host.initialize()]);
    const selection = await select(host);
    const lease = await host.materialize(scope, selection);
    expect(await readFile(lease.path, "utf8")).toContain("secret-fixture");
    expect((await stat(join(f.options.rootDirectory, "revision-key.json"))).mode & 0o777).toBe(
      0o600,
    );
    await host.shutdown();
    expect((await readdir(f.options.rootDirectory)).sort()).toEqual(["revision-key.json"]);
    await expect(host.list(scope, selection.url)).rejects.toThrow("stopping");
    const next = f.create();
    expect(await select(next)).toEqual(selection);
    await next.check(scope, selection);
  });
  test("a second live Host cannot erase active credential files", async () => {
    const f = await fixture(),
      host = f.create();
    const lease = await host.materialize(scope, await select(host));
    await expect(f.create().initialize()).rejects.toThrow("already owned");
    expect(await readFile(lease.path, "utf8")).toContain("secret-fixture");
    await lease.cleanup();
  });
  test("corrupt key fails closed without overwriting it or sweeping old leases", async () => {
    const f = await fixture();
    await mkdir(join(f.options.rootDirectory, "cookies-ABC123"), { recursive: true });
    const key = join(f.options.rootDirectory, "revision-key.json");
    await writeFile(key, '{"version":1,"key":"bad"}');
    await expect(f.create().initialize()).rejects.toThrow("Invalid task Cookie Host key");
    expect(await readFile(key, "utf8")).toBe('{"version":1,"key":"bad"}');
    expect(await readdir(f.options.rootDirectory)).toContain("cookies-ABC123");
    expect(await readdir(f.options.rootDirectory)).not.toContain("owner.lock");
  });
  test("startup removes only managed leftovers and does not traverse a lease symlink", async () => {
    const f = await fixture(),
      first = f.create();
    await first.initialize();
    await first.shutdown();
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "untouched");
    await symlink(outside, join(f.options.rootDirectory, "cookies-ABC123"));
    await writeFile(join(f.options.rootDirectory, "unrelated.txt"), "keep");
    await f.create().initialize();
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("untouched");
    expect(await readdir(f.options.rootDirectory)).toContain("unrelated.txt");
    expect(await readdir(f.options.rootDirectory)).not.toContain("cookies-ABC123");
  });
  test("shutdown during an asynchronous vault read cannot return a new lease", async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = new PanelTaskCookieHost({
      ...f.options,
      credentials: async () => {
        entered();
        await waiting;
        return [credential];
      },
    });
    cleanups.push(() => host.shutdown());
    const pending = host.list(scope, "https://example.com").then(
      () => undefined,
      (error) => error,
    );
    await ready;
    const closing = host.shutdown();
    release();
    expect(await pending).toBeInstanceOf(Error);
    await closing;
    expect(await readdir(f.options.rootDirectory)).toEqual(["revision-key.json"]);
  });
  test("real Host process crash leaves a recoverable key and clears only abandoned leases", async () => {
    const f = await fixture();
    const marker = join(f.root, "ready.json");
    const source = `import {PanelTaskCookieHost} from ${JSON.stringify(new URL("./task-cookie-host.ts", import.meta.url).href)};
import {writeFile} from "node:fs/promises";
const host=new PanelTaskCookieHost({rootDirectory:${JSON.stringify(f.options.rootDirectory)},authorize:async()=>{},credentials:async()=>[${JSON.stringify(credential)}]});
const scope=${JSON.stringify(scope)}, url="https://example.com";
const account=(await host.list(scope,url)).accounts[0];
const selection={credentialId:account.id,revision:account.revision,url};
const lease=await host.materialize(scope,selection);
await writeFile(${JSON.stringify(marker)},JSON.stringify({selection,path:lease.path}));
setInterval(()=>{},1000);`;
    const child = Bun.spawn([process.execPath, "--eval", source], {
      stdout: "pipe",
      stderr: "pipe",
    });
    cleanups.push(async () => {
      child.kill("SIGKILL");
      await child.exited;
    });
    let record: { selection: Awaited<ReturnType<typeof select>>; path: string } | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !record) {
      record = await readFile(marker, "utf8").then(JSON.parse, () => undefined);
      if (!record) await Bun.sleep(20);
    }
    expect(record).toBeDefined();
    expect(await readFile(record!.path, "utf8")).toContain("secret-fixture");
    child.kill("SIGKILL");
    await child.exited;
    const next = f.create();
    expect(await select(next)).toEqual(record!.selection);
    await expect(readFile(record!.path)).rejects.toThrow();
    expect((await readdir(f.options.rootDirectory)).sort()).toEqual([
      "owner.lock",
      "revision-key.json",
    ]);
  });
});
