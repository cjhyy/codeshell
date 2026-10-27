import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceUploadIngest } from "./uploads.js";
import { ResourceLibrary } from "./library.js";
import type { ResourceScope } from "./types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("expiry cleanup preserves an acknowledged write that renewed while cleanup awaited its lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resource-upload-expiry-"));
  let now = 1000,
    calls = 0,
    block = false;
  const entered = deferred(),
    release = deferred();
  const scope = { appId: "test-app", projectPath: directory };
  const options = {
    rootDirectory: join(directory, "resources"),
    now: () => now,
    isScopeAuthorized: async () => {
      if (block && ++calls === 3) {
        entered.resolve();
        await release.promise;
      }
      return true;
    },
  };
  const uploads = new ResourceUploadIngest({
    ...options,
    library: new ResourceLibrary(options),
    ttlMs: 100,
  });
  try {
    const upload = await uploads.begin(scope, { name: "data.bin", expectedBytes: 2 });
    now = upload.expiresAt - 1;
    block = true;
    const writing = uploads.write(scope, {
      sessionId: upload.sessionId,
      sequence: 0,
      offset: 0,
      dataBase64: "eA==",
    });
    await entered.promise;
    now = upload.expiresAt + 1;
    const cleanup = uploads.cleanupExpired();
    await new Promise((resolve) => setTimeout(resolve, 10));
    release.resolve();
    const ack = await writing;
    expect(ack.expiresAt).toBeGreaterThan(now);
    await cleanup;
    expect(await uploads.get(scope, { sessionId: upload.sessionId })).toMatchObject({
      receivedBytes: 1,
      nextSequence: 1,
    });
    await uploads.write(scope, {
      sessionId: upload.sessionId,
      sequence: 1,
      offset: 1,
      dataBase64: "eQ==",
    });
    const result = await uploads.finish(scope, { sessionId: upload.sessionId });
    expect(result.asset.bytes).toBe(2);
  } finally {
    release.resolve();
    await uploads.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup waiting on another upload does not abort a renewed upload's active finalization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resource-upload-finish-expiry-"));
  let now = 1000,
    block = false;
  const aEntered = deferred(),
    aRelease = deferred(),
    bEntered = deferred(),
    bRelease = deferred();
  const finishEntered = deferred(),
    finishRelease = deferred(),
    finishAborted = deferred();
  const calls = new Map<string, number>();
  const a: ResourceScope = { appId: "first-app", projectPath: directory };
  const b: ResourceScope = { appId: "second-app", projectPath: directory };
  const options = {
    rootDirectory: join(directory, "resources"),
    now: () => now,
    isScopeAuthorized: async (scope: ResourceScope) => {
      if (block) {
        const count = (calls.get(scope.appId) ?? 0) + 1;
        calls.set(scope.appId, count);
        if (count === 3) {
          const [entered, release] =
            scope.appId === a.appId ? [aEntered, aRelease] : [bEntered, bRelease];
          entered.resolve();
          await release.promise;
        }
      }
      return true;
    },
  };
  const library = new ResourceLibrary(options);
  const importFile = library.importFile.bind(library);
  let finishSignal: AbortSignal | undefined;
  library.importFile = async (scope, path, input = {}) => {
    finishSignal = input.signal;
    input.signal?.addEventListener("abort", finishAborted.resolve, { once: true });
    finishEntered.resolve();
    await Promise.race([finishRelease.promise, finishAborted.promise]);
    input.signal?.throwIfAborted();
    return importFile(scope, path, input);
  };
  const uploads = new ResourceUploadIngest({ ...options, library, ttlMs: 100 });
  let finishing: Promise<unknown> | undefined;
  try {
    const first = await uploads.begin(a, { name: "a.bin", expectedBytes: 1 });
    const second = await uploads.begin(b, { name: "b.bin", expectedBytes: 1 });
    now = first.expiresAt - 1;
    block = true;
    const writingA = uploads.write(a, {
      sessionId: first.sessionId,
      sequence: 0,
      offset: 0,
      dataBase64: "YQ==",
    });
    const writingB = uploads.write(b, {
      sessionId: second.sessionId,
      sequence: 0,
      offset: 0,
      dataBase64: "Yg==",
    });
    await Promise.all([aEntered.promise, bEntered.promise]);
    now = first.expiresAt + 1;
    const cleanup = uploads.cleanupExpired();
    await new Promise((resolve) => setTimeout(resolve, 10));
    bRelease.resolve();
    await writingB;
    finishing = uploads.finish(b, { sessionId: second.sessionId });
    void finishing.catch(() => {});
    await finishEntered.promise;
    aRelease.resolve();
    await writingA;
    await Promise.race([cleanup, finishAborted.promise]);
    expect(finishSignal?.aborted).toBe(false);
    finishRelease.resolve();
    await finishing;
    await cleanup;
    expect(await uploads.get(b, { sessionId: second.sessionId })).toMatchObject({
      state: "finished",
    });
    // Truly expired receipts are still reclaimed once their latest TTL passes.
    now += 101;
    await uploads.cleanupExpired();
    await expect(uploads.get(b, { sessionId: second.sessionId })).rejects.toThrow(
      "Unknown resource upload",
    );
  } finally {
    aRelease.resolve();
    bRelease.resolve();
    finishRelease.resolve();
    await finishing?.catch(() => {});
    await uploads.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup aborts a truly expired finalization before reclaiming its upload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resource-upload-expired-finish-"));
  let now = 1000;
  const entered = deferred(),
    aborted = deferred();
  const scope = { appId: "test-app", projectPath: directory };
  const options = {
    rootDirectory: join(directory, "resources"),
    now: () => now,
    isScopeAuthorized: () => true,
  };
  const library = new ResourceLibrary(options);
  library.importFile = async (_scope, _path, input = {}) => {
    input.signal?.addEventListener("abort", aborted.resolve, { once: true });
    entered.resolve();
    await aborted.promise;
    input.signal?.throwIfAborted();
    throw new Error("Fixture expected cleanup to cancel the expired finish");
  };
  const uploads = new ResourceUploadIngest({ ...options, library, ttlMs: 100 });
  let finishing: Promise<unknown> | undefined;
  try {
    const upload = await uploads.begin(scope, { name: "data.bin", expectedBytes: 1 });
    await uploads.write(scope, {
      sessionId: upload.sessionId,
      sequence: 0,
      offset: 0,
      dataBase64: "eA==",
    });
    finishing = uploads.finish(scope, { sessionId: upload.sessionId });
    void finishing.catch(() => {});
    await entered.promise;
    now = upload.expiresAt + 1;
    await uploads.cleanupExpired();
    await expect(finishing).rejects.toThrow();
    await expect(uploads.get(scope, { sessionId: upload.sessionId })).rejects.toThrow(
      "Unknown resource upload",
    );
  } finally {
    aborted.resolve();
    await finishing?.catch(() => {});
    await uploads.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
