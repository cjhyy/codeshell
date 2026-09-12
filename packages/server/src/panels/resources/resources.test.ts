import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PanelResourceService } from "./service.js";
import { ResourceLibrary, mediaSourceIdentity } from "./library.js";
import { mediaScopeKey } from "./storage.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const digest = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panel-resources-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const tool = join(root, "tool");
  await mkdir(tool);
  const scope = { appId: "generic-documents", projectPath: join(root, "workspace") };
  let authorized = true;
  let hook = async () => {};
  const create = () =>
    new PanelResourceService({
      rootDirectory: join(root, "store"),
      maxFileBytes: 8 * 1024 * 1024,
      isScopeAuthorized: async () => {
        await hook();
        return authorized;
      },
    });
  const service = create();
  cleanup.push(() => service.shutdown());
  const context = {
    resolveDirectory: (handle: string) => {
      if (handle !== "approved-tool") throw new Error(`private path ${root}`);
      return tool;
    },
  };
  const call = (method: string, input: unknown, otherScope = scope) =>
    service.dispatch(otherScope, method, input, context);
  const asset = async (data: Buffer | string, name = "source.pdf") => {
    const path = join(root, name);
    await writeFile(path, data);
    return service.library.importFile(scope, path);
  };
  return {
    root,
    tool,
    scope,
    service,
    call,
    asset,
    context,
    create,
    revoke() {
      authorized = false;
    },
    hook(value: () => Promise<void>) {
      hook = value;
    },
  };
}

test("ordinary PDF, Word, font and CSV resources retain old IDs/layout and safe attachment reads", async () => {
  const f = await fixture();
  for (const [name, type] of [
    ["file.pdf", "application/pdf"],
    ["file.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["file.woff2", "font/woff2"],
    ["file.csv", "text/csv"],
    ["file.html", "application/octet-stream"],
  ]) {
    const data = Buffer.from(`contents of ${name}`),
      asset = await f.asset(data, name);
    expect(asset.id).toBe(`asset-${digest(data)}`);
    expect(asset.mimeType).toBe(type);
    const stored = join(f.root, "store", "scopes", mediaScopeKey(f.scope), "assets", asset.id);
    expect(await readFile(join(stored, "content"))).toEqual(data);
    expect(JSON.parse(await readFile(join(stored, "asset.json"), "utf8"))).toEqual(asset);
    const read = await f.service.library.openRead(f.scope, asset.id, { method: "HEAD" });
    expect(read.headers["Content-Security-Policy"]).toContain("sandbox");
    expect(read.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(read.headers["Content-Disposition"]).toStartWith("attachment;");
  }
  expect(
    (await new ResourceLibrary({ rootDirectory: join(f.root, "store") }).list(f.scope)).length,
  ).toBe(5);
});

test("chunk reads reconstruct arbitrary binary bytes with exact EOF and reject oversized/cross-scope reads", async () => {
  const f = await fixture(),
    data = Buffer.alloc(70001);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const asset = await f.asset(data);
  expect(f.service.capabilities()).toMatchObject({
    maxChunkBytes: 32768,
    materialize: true,
    capture: true,
  });
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 32768) {
    const out = await f.call("resources.read", { assetId: asset.id, offset, length: 32768 });
    parts.push(Buffer.from(out.dataBase64, "base64"));
    expect(out.eof).toBe(offset + parts.at(-1)!.length === data.length);
    expect(out.totalBytes).toBe(data.length);
    expect(JSON.stringify(out)).not.toContain(f.root);
  }
  expect(Buffer.concat(parts)).toEqual(data);
  expect(
    await f.call("resources.read", { assetId: asset.id, offset: data.length, length: 1 }),
  ).toMatchObject({ eof: true, dataBase64: "" });
  for (const params of [
    { offset: -1, length: 1 },
    { offset: 0, length: 32769 },
    { offset: 0.5, length: 1 },
    { offset: 0, length: 1, path: f.root },
  ])
    await expect(f.call("resources.read", { assetId: asset.id, ...params })).rejects.toThrow();
  for (const scope of [
    { ...f.scope, appId: "other" },
    { ...f.scope, projectPath: join(f.root, "other") },
  ])
    await expect(
      f.call("resources.read", { assetId: asset.id, offset: 0, length: 1 }, scope),
    ).rejects.toThrow();
});

test("materialize atomically hands exact bytes to an approved directory and capture returns a path-free resource", async () => {
  const f = await fixture(),
    data = Buffer.alloc(600003, 17),
    asset = await f.asset(data, "source.docx");
  let observedPartial = false;
  f.hook(async () => {
    const files = await readdir(f.tool);
    if (files.some((name) => name.endsWith(".resource-partial"))) {
      observedPartial = true;
      if (files.includes("input.docx"))
        expect(await readFile(join(f.tool, "input.docx"))).toEqual(data);
    }
  });
  const out = await f.call("resources.materialize", {
    assetId: asset.id,
    directoryHandle: "approved-tool",
    path: "input.docx",
  });
  f.hook(async () => {});
  expect(observedPartial).toBe(true);
  expect(out).toEqual({
    assetId: asset.id,
    path: "input.docx",
    bytes: data.length,
    sha256: digest(data),
  });
  expect(await readFile(join(f.tool, "input.docx"))).toEqual(data);
  await expect(
    f.call("resources.materialize", {
      assetId: asset.id,
      directoryHandle: "approved-tool",
      path: "input.docx",
    }),
  ).rejects.toThrow();
  expect(await readdir(f.tool)).toEqual(["input.docx"]);
  const capture = await f.call("resources.capture", {
    directoryHandle: "approved-tool",
    path: "input.docx",
    expectedBytes: data.length,
    expectedSha256: digest(data),
  });
  expect(capture.asset).toEqual(asset);
  expect(JSON.stringify(capture)).not.toContain(f.root);
  expect(await readdir(join(f.root, "store", "scopes", mediaScopeKey(f.scope), "imports"))).toEqual(
    [],
  );
});

test("directory hand-offs reject symlinks, invalid paths, foreign grants and replaced roots without overwriting files", async () => {
  const f = await fixture(),
    asset = await f.asset("safe");
  await writeFile(join(f.root, "private.txt"), "private");
  await symlink(join(f.root, "private.txt"), join(f.tool, "link.pdf"));
  for (const path of [
    "../private.txt",
    "/private.txt",
    "a/../private.txt",
    "a\\private.txt",
    "link.pdf",
  ])
    await expect(
      f.call("resources.capture", { directoryHandle: "approved-tool", path }),
    ).rejects.toThrow();
  await expect(
    f.call("resources.materialize", {
      assetId: asset.id,
      directoryHandle: "approved-tool",
      path: "link.pdf",
    }),
  ).rejects.toThrow();
  await expect(
    f.call("resources.materialize", {
      assetId: asset.id,
      directoryHandle: "foreign",
      path: "file.pdf",
    }),
  ).rejects.toThrow("Resource operation failed");
  expect(await readFile(join(f.root, "private.txt"), "utf8")).toBe("private");
  await f.call("resources.materialize", {
    assetId: asset.id,
    directoryHandle: "approved-tool",
    path: "first.pdf",
  });
  await rename(f.tool, `${f.tool}-old`);
  await mkdir(f.tool);
  await writeFile(join(f.tool, "replacement.pdf"), "different");
  await expect(
    f.call("resources.capture", { directoryHandle: "approved-tool", path: "replacement.pdf" }),
  ).rejects.toThrow("replaced");
});

test("source revocation and directory replacement during copy never publish partial output", async () => {
  const f = await fixture(),
    data = Buffer.alloc(2 * 1024 * 1024, 19),
    asset = await f.asset(data);
  f.hook(async () => {
    if ((await readdir(f.tool)).some((name) => name.endsWith(".resource-partial"))) f.revoke();
  });
  await expect(
    f.call("resources.materialize", {
      assetId: asset.id,
      directoryHandle: "approved-tool",
      path: "result.pdf",
    }),
  ).rejects.toThrow();
  expect(await readdir(f.tool)).toEqual([]);

  const g = await fixture();
  await mkdir(join(g.tool, "nested"));
  await writeFile(join(g.tool, "nested", "output.pdf"), data);
  let changed = false;
  g.hook(async () => {
    const imports = join(g.root, "store", "scopes", mediaScopeKey(g.scope), "imports");
    if (
      !changed &&
      (await readdir(imports).catch(() => [])).some((name) => name.endsWith(".partial"))
    ) {
      changed = true;
      await rename(join(g.tool, "nested"), join(g.tool, "original"));
      await mkdir(join(g.tool, "nested"));
      await writeFile(join(g.tool, "nested", "output.pdf"), data);
    }
  });
  await expect(
    g.call("resources.capture", { directoryHandle: "approved-tool", path: "nested/output.pdf" }),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await g.service.library.list(g.scope)).toEqual([]);
  expect(await readdir(join(g.root, "store", "scopes", mediaScopeKey(g.scope), "imports"))).toEqual(
    [],
  );
});

test("capture validates declared size/digest and selected identity before atomic asset publication", async () => {
  const f = await fixture(),
    path = join(f.tool, "report.csv");
  await writeFile(path, "a,b\n1,2\n");
  for (const params of [{ expectedBytes: 1 }, { expectedSha256: "f".repeat(64) }]) {
    await expect(
      f.call("resources.capture", {
        directoryHandle: "approved-tool",
        path: "report.csv",
        ...params,
      }),
    ).rejects.toThrow();
    expect(await f.service.library.list(f.scope)).toEqual([]);
  }
  let checkedEmpty = false;
  const result = await f.service.library.importFile(f.scope, path, {
    assertAuthorized: async () => {
      // Concurrent readers see no incomplete asset records while the copy is prepared.
      if (!(await f.service.library.list(f.scope)).length) checkedEmpty = true;
    },
  });
  expect(checkedEmpty).toBe(true);
  expect(result.bytes).toBe(8);
  const metadata = mediaSourceIdentity({ dev: 0, ino: 0, size: 8, mtimeMs: 0, ctimeMs: 0 });
  await expect(
    f.service.library.importFile(f.scope, path, { expectedSource: metadata }),
  ).rejects.toThrow("Source changed");
});

test("uploads acknowledge canonical chunks, resume after restart and verify bytes before idempotent finish", async () => {
  const f = await fixture(),
    data = Buffer.alloc(32771, 27);
  const session = await f.call("resources.upload.begin", {
    name: "document.pdf",
    mimeType: "application/pdf",
    expectedBytes: data.length,
    expectedSha256: digest(data),
  });
  const first = {
    sessionId: session.sessionId,
    sequence: 0,
    offset: 0,
    dataBase64: data.subarray(0, 32768).toString("base64"),
  };
  const ack = await f.call("resources.upload.write", first);
  expect(await f.call("resources.upload.write", first)).toEqual(ack);
  await expect(
    f.call("resources.upload.finish", { sessionId: session.sessionId }),
  ).rejects.toThrow();
  await f.service.shutdown();
  const restored = f.create();
  cleanup.push(() => restored.shutdown());
  expect(
    await restored.dispatch(f.scope, "resources.upload.get", { sessionId: session.sessionId }),
  ).toMatchObject({ receivedBytes: 32768, nextSequence: 1 });
  await restored.dispatch(f.scope, "resources.upload.write", {
    sessionId: session.sessionId,
    sequence: 1,
    offset: 32768,
    dataBase64: data.subarray(32768).toString("base64"),
  });
  const done = await restored.dispatch(f.scope, "resources.upload.finish", {
    sessionId: session.sessionId,
  });
  expect(done.asset.sha256).toBe(digest(data));
  expect(done.asset.mimeType).toBe("application/pdf");
  expect(
    await restored.dispatch(f.scope, "resources.upload.finish", { sessionId: session.sessionId }),
  ).toEqual(done);
  expect(await readFile(await restored.library.resolvePath(f.scope, done.asset.id))).toEqual(data);
});

test("uploads reject foreign scope, oversize, noncanonical chunks, altered bytes and cancelled sessions", async () => {
  const f = await fixture();
  await expect(
    f.call("resources.upload.begin", { name: "large.pdf", expectedBytes: 9 * 1024 * 1024 }),
  ).rejects.toThrow();
  const session = await f.call("resources.upload.begin", {
    name: "file.csv",
    mimeType: "text/csv",
    expectedBytes: 4,
  });
  for (const input of [
    { dataBase64: "====" },
    { dataBase64: "YQ==\n" },
    { dataBase64: Buffer.alloc(32769).toString("base64") },
    { dataBase64: "YQ==", offset: 1 },
  ])
    await expect(
      f.call("resources.upload.write", {
        sessionId: session.sessionId,
        sequence: 0,
        offset: 0,
        ...input,
      }),
    ).rejects.toThrow();
  await expect(
    f.call(
      "resources.upload.get",
      { sessionId: session.sessionId },
      { ...f.scope, appId: "other" },
    ),
  ).rejects.toThrow();
  await f.call("resources.upload.write", {
    sessionId: session.sessionId,
    sequence: 0,
    offset: 0,
    dataBase64: Buffer.from("abcd").toString("base64"),
  });
  const partial = join(
    f.root,
    "store",
    "scopes",
    mediaScopeKey(f.scope),
    "uploads",
    session.sessionId,
    "content.partial",
  );
  await writeFile(partial, "abce");
  await expect(
    f.call("resources.upload.finish", { sessionId: session.sessionId }),
  ).rejects.toThrow();
  expect(await f.service.library.list(f.scope)).toEqual([]);
  expect((await f.call("resources.upload.get", { sessionId: session.sessionId })).state).toBe(
    "failed",
  );
  const next = await f.call("resources.upload.begin", { name: "file.txt" });
  await f.call("resources.upload.cancel", { sessionId: next.sessionId });
  await expect(
    f.call("resources.upload.write", {
      sessionId: next.sessionId,
      sequence: 0,
      offset: 0,
      dataBase64: "YQ==",
    }),
  ).rejects.toThrow();
});

test("same-size tampering of a managed resource cannot be handed to a tool or reused as a valid import", async () => {
  const f = await fixture(),
    asset = await f.asset("original");
  await writeFile(await f.service.library.resolvePath(f.scope, asset.id), "tampered");
  await expect(
    f.call("resources.materialize", {
      assetId: asset.id,
      directoryHandle: "approved-tool",
      path: "output.pdf",
    }),
  ).rejects.toThrow();
  expect(await readdir(f.tool)).toEqual([]);
  await expect(f.asset("original", "again.pdf")).rejects.toThrow("content changed");
});

test("caller cancellation stops a transfer before publication and upload finalization remains resumable", async () => {
  const f = await fixture();
  const asset = await f.asset(Buffer.alloc(700000, 5));
  const controller = new AbortController();
  f.hook(async () => {
    const files = await readdir(f.tool);
    if (files.some((name) => name.endsWith(".resource-partial"))) controller.abort();
  });
  await expect(
    f.service.dispatch(
      f.scope,
      "resources.materialize",
      {
        assetId: asset.id,
        directoryHandle: "approved-tool",
        path: "cancelled.pdf",
      },
      { ...f.context, signal: controller.signal },
    ),
  ).rejects.toThrow();
  expect(await readdir(f.tool)).toEqual([]);
  f.hook(async () => {});
  const data = Buffer.alloc(32000, 31);
  const upload = await f.call("resources.upload.begin", {
    name: "resumable.pdf",
    expectedBytes: data.length,
  });
  await f.call("resources.upload.write", {
    sessionId: upload.sessionId,
    sequence: 0,
    offset: 0,
    dataBase64: data.toString("base64"),
  });
  const abortFinish = new AbortController();
  let checks = 0;
  f.hook(async () => {
    if (++checks === 5) abortFinish.abort();
  });
  await expect(
    f.service.dispatch(
      f.scope,
      "resources.upload.finish",
      { sessionId: upload.sessionId },
      { signal: abortFinish.signal },
    ),
  ).rejects.toThrow();
  expect(abortFinish.signal.aborted).toBe(true);
  f.hook(async () => {});
  expect(await f.call("resources.upload.get", { sessionId: upload.sessionId })).toMatchObject({
    state: "uploading",
    receivedBytes: data.length,
  });
  const result = await f.call("resources.upload.finish", { sessionId: upload.sessionId });
  expect(result.asset.sha256).toBe(digest(data));
});

test("materialization detects destination-byte tampering and temporary grants release identity pins", async () => {
  const f = await fixture();
  const asset = await f.asset(Buffer.alloc(400000, 29));
  let changed = false;
  f.hook(async () => {
    if (changed) return;
    const name = (await readdir(f.tool)).find((entry) => entry.endsWith(".resource-partial"));
    if (name && (await readFile(join(f.tool, name))).length > 0) {
      changed = true;
      await writeFile(join(f.tool, name), Buffer.alloc(400000, 12));
    }
  });
  await expect(
    f.call("resources.materialize", {
      assetId: asset.id,
      directoryHandle: "approved-tool",
      path: "tampered.pdf",
    }),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await readdir(f.tool)).toEqual([]);
  f.hook(async () => {});
  await rename(f.tool, join(f.root, "released-tool"));
  await mkdir(f.tool);
  await writeFile(join(f.tool, "new.csv"), "new grant content");
  await expect(
    f.call("resources.capture", { directoryHandle: "approved-tool", path: "new.csv" }),
  ).rejects.toThrow();
  f.service.releaseDirectory(f.scope, "approved-tool");
  expect(
    (await f.call("resources.capture", { directoryHandle: "approved-tool", path: "new.csv" })).asset
      .mimeType,
  ).toBe("text/csv");
});
