import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PanelResourceService } from "./service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "external-resource-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "sources"),
    store = join(root, "store"),
    destination = join(root, "outputs");
  await mkdir(sourceRoot);
  await mkdir(destination);
  const scope = { appId: "reference-demo", projectPath: join(root, "project") };
  let allowed = true,
    grant = true;
  const create = () => {
    const service = new PanelResourceService({
      rootDirectory: store,
      maxFileBytes: 4 * 1024 * 1024,
      isScopeAuthorized: () => allowed,
    });
    cleanup.push(() => service.shutdown());
    return service;
  };
  const service = create();
  const context = {
    resolveDirectory(handle: string) {
      if (!grant) throw new Error("Directory grant was revoked");
      if (handle === "selected") return sourceRoot;
      if (handle === "output") return destination;
      throw new Error(`Private directory ${root}`);
    },
  };
  const call = (method: string, input: unknown, currentScope = scope) =>
    service.dispatch(currentScope, method, input, context);
  const reference = async (data: Buffer | string, path = "source.mp4") => {
    await writeFile(join(sourceRoot, path), data);
    return (await call("resources.references.create", { directoryHandle: "selected", path }))
      .reference;
  };
  return {
    root,
    store,
    sourceRoot,
    destination,
    scope,
    service,
    create,
    context,
    call,
    reference,
    revoke() {
      allowed = false;
    },
    revokeGrant() {
      grant = false;
    },
  };
}
async function contents(result: Awaited<ReturnType<PanelResourceService["openRead"]>>) {
  const chunks: Buffer[] = [];
  for await (const chunk of result.body!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("external references persist metadata only, deduplicate selected identity, and reopen without a process grant", async () => {
  const f = await fixture(),
    data = Buffer.alloc(1024 * 1024, 19);
  const reference = await f.reference(data);
  expect(reference).toMatchObject({
    kind: "external",
    state: "available",
    bytes: data.length,
    mimeType: "video/mp4",
  });
  expect(reference.id).toMatch(/^external-[a-f0-9]{64}$/);
  expect(reference.sha256).toBeUndefined();
  expect(Number.isSafeInteger(reference.lastModified)).toBe(true);
  expect(JSON.stringify(reference)).not.toContain(f.root);
  const again = await f.call("resources.references.create", {
    directoryHandle: "selected",
    path: "source.mp4",
    expectedBytes: data.length,
    expectedLastModified: reference.lastModified,
  });
  expect(again.reference).toEqual(reference);
  const files = await readdir(f.store, { recursive: true });
  expect(
    files.some(
      (file) => file.includes("assets") || file.endsWith("content") || file.endsWith(".partial"),
    ),
  ).toBe(false);
  const json = files.filter((file) => file.endsWith(".json"));
  expect(json).toHaveLength(1);
  expect((await stat(join(f.store, json[0]!))).size).toBeLessThan(4096);
  await f.service.shutdown();
  f.revokeGrant();
  const reopened = f.create();
  expect(
    await reopened.dispatch(f.scope, "resources.references.get", { id: reference.id }),
  ).toEqual({ reference });
  expect(await reopened.dispatch(f.scope, "resources.get", { id: reference.id })).toEqual({
    asset: reference,
  });
  expect(await contents(await reopened.openRead(f.scope, reference.id))).toEqual(data);
  expect(await readFile(join(f.sourceRoot, "source.mp4"))).toEqual(data);
});

test("external range, HEAD, EOF chunks and temporary materialization retain byte limits and a real output hash", async () => {
  const f = await fixture(),
    data = Buffer.alloc(70003);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const reference = await f.reference(data, "source.csv");
  const range = await f.service.openRead(f.scope, reference.id, { range: "bytes=32000-33000" });
  expect(range.status).toBe(206);
  expect(range.headers["Content-Range"]).toBe(`bytes 32000-33000/${data.length}`);
  expect(range.headers["Content-Disposition"]).toStartWith("attachment;");
  expect(await contents(range)).toEqual(data.subarray(32000, 33001));
  expect(
    await contents(await f.service.openRead(f.scope, reference.id, { range: "bytes=-7" })),
  ).toEqual(data.subarray(-7));
  const head = await f.service.openRead(f.scope, reference.id, { method: "HEAD" });
  expect(head.body).toBeNull();
  expect(head.headers["Content-Length"]).toBe(String(data.length));
  expect(head.headers["Cache-Control"]).toBe("private, no-store");
  expect(
    (await f.service.openRead(f.scope, reference.id, { range: `bytes=${data.length}-` })).status,
  ).toBe(416);
  expect(
    await f.call("resources.read", { assetId: reference.id, offset: data.length, length: 1 }),
  ).toMatchObject({ eof: true, dataBase64: "" });
  await expect(
    f.call("resources.read", { assetId: reference.id, length: 32769 }),
  ).rejects.toThrow();
  const out = await f.call("resources.materialize", {
    assetId: reference.id,
    directoryHandle: "output",
    path: "input.csv",
  });
  expect(out).toEqual({
    assetId: reference.id,
    path: "input.csv",
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
  expect(await readFile(join(f.destination, "input.csv"))).toEqual(data);
  expect(await f.service.library.list(f.scope)).toEqual([]);
  expect(
    (await readdir(f.store, { recursive: true })).some((file) => file.endsWith("asset.json")),
  ).toBe(false);
});

test("references reject changed files and cannot silently bind a same-size replacement with the old timestamp", async () => {
  const f = await fixture(),
    reference = await f.reference("original", "source.wav");
  const originalPath = join(f.sourceRoot, "source.wav"),
    originalStat = await stat(originalPath);
  await rename(originalPath, join(f.sourceRoot, "moved.wav"));
  expect((await f.call("resources.references.get", { id: reference.id })).reference.state).toBe(
    "missing",
  );
  await writeFile(originalPath, "replaced");
  await utimes(originalPath, originalStat.atime, originalStat.mtime);
  expect((await f.call("resources.references.get", { id: reference.id })).reference.state).toBe(
    "changed",
  );
  await expect(f.service.openRead(f.scope, reference.id)).rejects.toThrow(/changed/);
  await expect(
    f.call("resources.references.relink", {
      id: reference.id,
      directoryHandle: "selected",
      path: "source.wav",
    }),
  ).rejects.toThrow();
  const reconnected = await f.call("resources.references.relink", {
    id: reference.id,
    directoryHandle: "selected",
    path: "moved.wav",
  });
  expect(reconnected.reference.id).toBe(reference.id);
  expect(reconnected.reference.state).toBe("available");
  expect(await contents(await f.service.openRead(f.scope, reference.id))).toEqual(
    Buffer.from("original"),
  );
  await writeFile(join(f.sourceRoot, "moved.wav"), "different length");
  expect((await f.call("resources.references.get", { id: reference.id })).reference.state).toBe(
    "changed",
  );
  const next = (
    await f.call("resources.references.create", { directoryHandle: "selected", path: "moved.wav" })
  ).reference;
  expect(next.id).not.toBe(reference.id);
});

test("external selection validates live grants, expected metadata, regular files, traversal and scope", async () => {
  const f = await fixture(),
    reference = await f.reference("allowed");
  await writeFile(join(f.root, "private.mp4"), "private");
  await symlink(join(f.root, "private.mp4"), join(f.sourceRoot, "link.mp4"));
  for (const path of ["../private.mp4", "/private.mp4", "link.mp4", ".", "a/../../private.mp4"])
    await expect(
      f.call("resources.references.create", { directoryHandle: "selected", path }),
    ).rejects.toThrow();
  await expect(
    f.call("resources.references.create", {
      directoryHandle: "selected",
      path: "source.mp4",
      expectedBytes: 1,
    }),
  ).rejects.toThrow();
  await expect(
    f.call("resources.references.create", {
      directoryHandle: "selected",
      path: "source.mp4",
      expectedLastModified: 0,
    }),
  ).rejects.toThrow();
  for (const scope of [
    { ...f.scope, appId: "other" },
    { ...f.scope, projectPath: join(f.root, "other") },
  ])
    await expect(f.call("resources.references.get", { id: reference.id }, scope)).rejects.toThrow();
  f.revokeGrant();
  await expect(
    f.call("resources.references.create", { directoryHandle: "selected", path: "source.mp4" }),
  ).rejects.toThrow();
  expect((await f.call("resources.references.get", { id: reference.id })).reference.state).toBe(
    "available",
  );
  f.revoke();
  await expect(f.call("resources.references.get", { id: reference.id })).rejects.toThrow();
  await expect(f.service.openRead(f.scope, reference.id)).rejects.toThrow();
});

test("replacing a recorded ancestor fails even when the original file is moved into its replacement", async () => {
  const f = await fixture();
  await mkdir(join(f.sourceRoot, "nested"));
  const reference = await f.reference("same original inode", "nested/source.mp4");
  await rename(join(f.sourceRoot, "nested"), join(f.sourceRoot, "old"));
  await mkdir(join(f.sourceRoot, "nested"));
  await rename(join(f.sourceRoot, "old/source.mp4"), join(f.sourceRoot, "nested/source.mp4"));
  expect((await f.call("resources.references.get", { id: reference.id })).reference.state).toBe(
    "changed",
  );
  await expect(f.service.openRead(f.scope, reference.id)).rejects.toThrow();
});

test("forget and lifecycle revocation close open external streams without deleting source files", async () => {
  for (const action of ["forget", "scope", "app", "shutdown"] as const) {
    const f = await fixture(),
      data = Buffer.alloc(1024 * 1024, 5),
      reference = await f.reference(data);
    const result = await f.service.openRead(f.scope, reference.id);
    expect(result.body!.destroyed).toBe(false);
    if (action === "forget")
      expect(await f.call("resources.references.forget", { id: reference.id })).toEqual({
        forgotten: true,
      });
    if (action === "scope") await f.service.cancelScope(f.scope);
    if (action === "app") await f.service.cancelApp(f.scope.appId);
    if (action === "shutdown") await f.service.shutdown();
    expect(result.body!.destroyed).toBe(true);
    expect(await readFile(join(f.sourceRoot, "source.mp4"))).toEqual(data);
    if (action === "forget")
      await expect(f.call("resources.references.get", { id: reference.id })).rejects.toThrow();
  }
});

test("a symlink introduced above a persisted selected directory cannot restore the old reference", async () => {
  const f = await fixture();
  const parent = join(f.root, "parent"),
    picked = join(parent, "picked");
  await mkdir(picked, { recursive: true });
  const file = join(picked, "source.mp4");
  await writeFile(file, "original file and original final directory");
  const reference = await f.service.references.createFromSelectedPath(f.scope, file);
  const moved = join(f.root, "moved-parent");
  await rename(parent, moved);
  await symlink(moved, parent, process.platform === "win32" ? "junction" : "dir");
  expect((await f.call("resources.references.get", { id: reference.id })).reference.state).toBe(
    "changed",
  );
  await expect(f.service.openRead(f.scope, reference.id)).rejects.toThrow();
});

test("source changes or trust revocation during external reads stop delivery", async () => {
  for (const revoke of [false, true]) {
    const f = await fixture(),
      reference = await f.reference(Buffer.alloc(1024 * 1024, 4));
    const result = await f.service.openRead(f.scope, reference.id),
      iterator = result.body![Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (revoke) f.revoke();
    else await writeFile(join(f.sourceRoot, "source.mp4"), "changed");
    let failed = false;
    try {
      while (!(await iterator.next()).done) {
        // Drain any already buffered chunk; the next source check must reject.
      }
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    result.body?.destroy();
  }
});

test("Host-selected paths revalidate their selection callback before publishing a reference", async () => {
  const f = await fixture(),
    path = join(f.sourceRoot, "chosen.png");
  await writeFile(path, "opaque selected bytes");
  const reference = await f.service.references.createFromSelectedPath(f.scope, path, {
    assertAuthorized: () => {},
  });
  expect(reference.mimeType).toBe("image/png");
  expect(JSON.stringify(reference)).not.toContain(path);
  await expect(
    f.service.references.createFromSelectedPath(f.scope, path, {
      assertAuthorized: () => {
        throw new Error("Selected guest closed");
      },
    }),
  ).rejects.toThrow(/closed/);
});

test("revocation during metadata publication removes the unpublished reference and preserves the original", async () => {
  const f = await fixture(),
    file = join(f.sourceRoot, "selected.mp4");
  await writeFile(file, "source remains unchanged");
  let publicationObserved = false;
  await expect(
    f.service.references.createFromSelectedPath(f.scope, file, {
      async assertAuthorized() {
        const paths = await readdir(f.store, { recursive: true }).catch(() => []);
        if (paths.some((path) => path.endsWith(".json"))) {
          publicationObserved = true;
          throw new Error("Selection revoked while publication completed");
        }
      },
    }),
  ).rejects.toThrow(/revoked/);
  expect(publicationObserved).toBe(true);
  expect((await readdir(f.store, { recursive: true })).some((path) => path.endsWith(".json"))).toBe(
    false,
  );
  expect(await readFile(file, "utf8")).toBe("source remains unchanged");
});
