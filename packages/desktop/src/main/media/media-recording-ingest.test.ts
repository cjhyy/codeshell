import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MediaRecordingIngest,
  type RecordingIngestOptions,
  type RecordingSession,
} from "./media-recording-ingest.js";
import { MediaLibrary } from "./media-library.js";
import { mediaDirectory, mediaScopeKey, writeMediaJson } from "./media-storage.js";
import { runMediaProcess } from "./media-process-runner.js";

const available = ["ffmpeg", "ffprobe"].every(
  (command) => spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0,
);
const scope = { appId: "video-studio", projectPath: "/recording-project-a" };
const roots: string[] = [],
  managers: MediaRecordingIngest[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(extra: Partial<RecordingIngestOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "recording-ingest-"));
  roots.push(root);
  const library = new MediaLibrary({ rootDirectory: root });
  const options = {
    rootDirectory: root,
    library,
    isScopeAuthorized: () => true,
    maxChunkBytes: 4096,
    ...extra,
  };
  const manager = new MediaRecordingIngest(options);
  managers.push(manager);
  await manager.initialize();
  return { root, library, manager, options };
}
async function directory(root: string, session: RecordingSession) {
  return mediaDirectory(
    root,
    ["scopes", mediaScopeKey(scope), "recordings", session.sessionId],
    false,
  );
}
async function tone(): Promise<Buffer> {
  return readFile(
    new URL("../../../../core/src/panel-apps/fixtures/static-tone.wav", import.meta.url),
  );
}
function chunk(
  session: RecordingSession,
  bytes: Buffer,
  sequence = session.nextSequence,
  offset = session.receivedBytes,
) {
  return { sessionId: session.sessionId, sequence, offset, dataBase64: bytes.toString("base64") };
}
async function upload(manager: MediaRecordingIngest, bytes: Buffer, mimeType = "audio/wav") {
  let session = await manager.begin(scope, {
    mimeType,
    name: "测试录制.wav",
    expectedBytes: bytes.length,
  });
  for (let offset = 0; offset < bytes.length; offset += session.maxChunkBytes)
    session = await manager.write(
      scope,
      chunk(session, bytes.subarray(offset, offset + session.maxChunkBytes)),
    );
  return session;
}

test("recording begin enforces MIME, file and active-session budgets without accepting paths", async () => {
  const { manager } = await fixture({
    maxFileBytes: 50,
    maxActivePerScope: 2,
    maxActiveSessions: 3,
  });
  for (const input of [
    { mimeType: "text/html" },
    { mimeType: "image/svg+xml" },
    { mimeType: "audio/wav", expectedBytes: 51 },
    { mimeType: "audio/wav", expectedBytes: 0 },
    { mimeType: "audio/wav", path: "/private/secret" },
  ])
    await expect(manager.begin(scope, input)).rejects.toThrow();
  const attempts = await Promise.allSettled(
    [0, 1, 2].map(() =>
      manager.begin(scope, { mimeType: "video/webm;codecs=vp9,opus", name: "../record.html" }),
    ),
  );
  expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(2);
  const first = (
    attempts.find(
      (attempt) => attempt.status === "fulfilled",
    ) as PromiseFulfilledResult<RecordingSession>
  ).value;
  expect(first.mimeType).toBe("video/webm");
  expect(Object.keys(first)).not.toContain("path");
  await manager.begin({ ...scope, projectPath: "/b" }, { mimeType: "audio/wav" });
  await expect(
    manager.begin({ ...scope, projectPath: "/c" }, { mimeType: "audio/wav" }),
  ).rejects.toThrow("Too many");
  await manager.cancel(scope, { sessionId: first.sessionId });
  await expect(manager.begin(scope, { mimeType: "audio/wav" })).resolves.toMatchObject({
    receivedBytes: 0,
  });
});

test("writes serialize concurrent chunks, reject gaps and allow only an identical most-recent retry", async () => {
  const { manager, root } = await fixture({ maxFileBytes: 12, maxChunkBytes: 4 });
  const session = await manager.begin(scope, { mimeType: "audio/wav" });
  await expect(manager.write(scope, chunk(session, Buffer.from("5678"), 1, 4))).rejects.toThrow(
    "sequence",
  );
  const writes = await Promise.all([
    manager.write(scope, chunk(session, Buffer.from("1234"), 0, 0)),
    manager.write(scope, chunk(session, Buffer.from("5678"), 1, 4)),
  ]);
  expect(writes.map((write) => write.receivedBytes)).toEqual([4, 8]);
  expect(
    (await manager.write(scope, chunk(session, Buffer.from("5678"), 1, 4))).receivedBytes,
  ).toBe(8);
  await expect(manager.write(scope, chunk(session, Buffer.from("1234"), 0, 0))).rejects.toThrow();
  await expect(manager.write(scope, chunk(session, Buffer.from("nope"), 1, 4))).rejects.toThrow();
  for (const dataBase64 of ["not base64!", "Zg=", "Zh==", "", Buffer.alloc(5).toString("base64")])
    await expect(
      manager.write(scope, { sessionId: session.sessionId, sequence: 2, offset: 8, dataBase64 }),
    ).rejects.toThrow();
  const end = await manager.write(scope, chunk(session, Buffer.from("9012"), 2, 8));
  await expect(manager.write(scope, chunk(end, Buffer.from("x")))).rejects.toThrow("budget");
  expect(await readFile(join(await directory(root, session), "content.partial"), "utf8")).toBe(
    "123456789012",
  );
});

test("every session action is isolated by project and app and revocation can cancel without a guest", async () => {
  let authorized = true;
  const { manager, root } = await fixture({ isScopeAuthorized: () => authorized });
  const session = await manager.begin(scope, { mimeType: "audio/wav" });
  const another = await manager.begin({ ...scope, appId: "other-app" }, { mimeType: "audio/wav" });
  for (const wrongScope of [
    { ...scope, projectPath: "/recording-project-b" },
    { ...scope, appId: "other-app" },
  ]) {
    await expect(manager.write(wrongScope, chunk(session, Buffer.from("x")))).rejects.toThrow(
      "Unknown",
    );
    await expect(manager.get(wrongScope, { sessionId: session.sessionId })).rejects.toThrow(
      "Unknown",
    );
    await expect(manager.finish(wrongScope, { sessionId: session.sessionId })).rejects.toThrow(
      "Unknown",
    );
    await expect(manager.cancel(wrongScope, { sessionId: session.sessionId })).rejects.toThrow(
      "Unknown",
    );
  }
  await manager.write(scope, chunk(session, Buffer.from("x")));
  const path = await directory(root, session);
  authorized = false;
  await expect(manager.write(scope, chunk(session, Buffer.from("x"), 1, 1))).rejects.toThrow(
    "authorized",
  );
  await manager.cancelApp("video-studio");
  expect(await stat(path).catch(() => null)).toBeNull();
  authorized = true;
  expect(
    (await manager.get({ ...scope, appId: "other-app" }, { sessionId: another.sessionId })).state,
  ).toBe("uploading");
});

test.skipIf(!available)(
  "acknowledged data survives restart, unacknowledged crash tails are discarded, and finish is idempotent",
  async () => {
    const bytes = await tone(),
      { manager, root, library, options } = await fixture();
    let session = await manager.begin(scope, {
      mimeType: "audio/wav",
      name: "最终录音.wav",
      expectedBytes: bytes.length,
    });
    session = await manager.write(scope, chunk(session, bytes.subarray(0, 4096)));
    await manager.shutdown();
    await appendFile(
      join(await directory(root, session), "content.partial"),
      "unacknowledged tail",
    );
    const restored = new MediaRecordingIngest(options);
    managers.push(restored);
    await restored.initialize();
    expect(await restored.get(scope, { sessionId: session.sessionId })).toEqual(session);
    for (let offset = 4096; offset < bytes.length; offset += 4096)
      session = await restored.write(scope, chunk(session, bytes.subarray(offset, offset + 4096)));
    const [first, repeated] = await Promise.all([
      restored.finish(scope, { sessionId: session.sessionId }),
      restored.finish(scope, { sessionId: session.sessionId }),
    ]);
    expect(repeated).toEqual(first);
    expect(first.asset.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(first.asset.name).toBe("最终录音.wav");
    expect(first.inspection.durationSeconds).toBeCloseTo(0.12, 3);
    expect(first.provenance).toEqual({ kind: "recording" });
    expect(await readFile(await library.resolvePath(scope, first.asset.id))).toEqual(
      Buffer.from(bytes),
    );
    expect(await readdir(await directory(root, session))).toEqual(["session.json"]);
    expect(await library.list(scope)).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain(root);
    await restored.shutdown();
    const reopened = new MediaRecordingIngest(options);
    managers.push(reopened);
    expect(await reopened.finish(scope, { sessionId: session.sessionId })).toEqual(first);
  },
  10000,
);

test.skipIf(!available)(
  "incomplete and forged recordings cannot enter the asset library, while actual durationless WebM audio can",
  async () => {
    const { manager, library } = await fixture();
    const partial = await manager.begin(scope, { mimeType: "audio/wav", expectedBytes: 20 });
    await manager.write(scope, chunk(partial, Buffer.from("abc")));
    await expect(manager.finish(scope, { sessionId: partial.sessionId })).rejects.toThrow(
      "incomplete",
    );
    for (const [mime, bytes] of [
      ["audio/wav", Buffer.from("RIFF html payload WAVE")],
      ["video/mp4", await tone()],
    ] as const) {
      const session = await upload(manager, bytes, mime);
      await expect(manager.finish(scope, { sessionId: session.sessionId })).rejects.toThrow(
        "supported",
      );
      expect((await manager.get(scope, { sessionId: session.sessionId })).state).toBe("failed");
    }
    expect(await library.list(scope)).toHaveLength(0);
    const { stdout } = await runMediaProcess(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=450:duration=0.6",
        "-c:a",
        "libopus",
        "-f",
        "webm",
        "pipe:1",
      ],
      { signal: AbortSignal.timeout(10000) },
    );
    const session = await upload(manager, stdout, "audio/webm");
    const result = await manager.finish(scope, { sessionId: session.sessionId });
    expect(result.asset.mimeType).toBe("audio/webm");
    expect(result.inspection.kind).toBe("audio");
    expect(result.inspection.durationSeconds).toBeGreaterThan(0.5);
    expect(result.inspection.durationSeconds).toBeLessThan(0.7);
  },
  10000,
);

test("cancel and expiry remove partial bytes; symlinks cannot redirect writes outside the session", async () => {
  let now = 100;
  const { root, manager } = await fixture({ now: () => now, ttlMs: 1000 });
  const expired = await manager.begin(scope, { mimeType: "audio/wav" });
  await manager.write(scope, chunk(expired, Buffer.from("private recording")));
  const expiredPath = await directory(root, expired);
  now = 1101;
  await manager.cleanupExpired();
  expect(await stat(expiredPath).catch(() => null)).toBeNull();
  await expect(manager.get(scope, { sessionId: expired.sessionId })).rejects.toThrow("Unknown");
  const cancelled = await manager.begin(scope, { mimeType: "audio/wav" });
  await manager.write(scope, chunk(cancelled, Buffer.from("partial")));
  await manager.cancel(scope, { sessionId: cancelled.sessionId });
  expect(await readdir(await directory(root, cancelled))).toEqual(["session.json"]);
  expect(await manager.cancel(scope, { sessionId: cancelled.sessionId })).toEqual({
    cancelled: true,
  });
  const linked = await manager.begin(scope, { mimeType: "audio/wav" });
  const target = join(root, "keep-private");
  await writeFile(target, "unchanged");
  const partial = join(await directory(root, linked), "content.partial");
  await rm(partial);
  await symlink(target, partial);
  await expect(manager.write(scope, chunk(linked, Buffer.from("overwrite")))).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("unchanged");
});

test.skipIf(!available)(
  "interrupted finish is explicitly resumable, while an invalid manifest is cleaned at initialization",
  async () => {
    const { root, manager, options } = await fixture();
    const session = await upload(manager, await tone());
    const path = await directory(root, session);
    await manager.shutdown();
    const stored = JSON.parse(await readFile(join(path, "session.json"), "utf8"));
    await writeMediaJson(join(path, "session.json"), { ...stored, state: "finishing" });
    const restored = new MediaRecordingIngest(options);
    managers.push(restored);
    expect((await restored.get(scope, { sessionId: session.sessionId })).state).toBe("uploading");
    const result = await restored.finish(scope, { sessionId: session.sessionId });
    expect(result.asset.id).toMatch(/^asset-/);
    const corrupt = await restored.begin(scope, { mimeType: "audio/wav" }),
      corruptPath = await directory(root, corrupt);
    await restored.shutdown();
    await writeFile(join(corruptPath, "session.json"), "{broken");
    const reopened = new MediaRecordingIngest(options);
    managers.push(reopened);
    await reopened.initialize();
    expect(await stat(corruptPath).catch(() => null)).toBeNull();
  },
  10000,
);

test.skipIf(!available)(
  "cancel and timeout stop active media inspection before a partial recording can be published",
  async () => {
    for (const mode of ["cancel", "timeout"] as const) {
      const { root, options } = await fixture();
      const started = join(root, "started"),
        stopped = join(root, "stopped"),
        probe = join(root, "slow-probe.cjs");
      await writeFile(
        probe,
        `#!${process.execPath}\nconst fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'1');process.exit(1)});fs.writeFileSync(${JSON.stringify(started)},'1');setInterval(()=>{},1000);\n`,
        { mode: 0o700 },
      );
      const manager = new MediaRecordingIngest({
        ...options,
        ffprobePath: probe,
        finishTimeoutMs: mode === "timeout" ? 3000 : 10000,
      });
      managers.push(manager);
      const session = await upload(manager, await tone());
      const finished = manager.finish(scope, { sessionId: session.sessionId });
      const settled = finished.then(
        () => null,
        (error) => error as Error,
      );
      for (let i = 0; i < 500 && !(await stat(started).catch(() => null)); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        await stat(started).catch(() => null),
        `${mode} inspection process should start`,
      ).not.toBeNull();
      if (mode === "cancel") await manager.cancel(scope, { sessionId: session.sessionId });
      expect(await settled).toBeInstanceOf(Error);
      expect(await stat(stopped).catch(() => null)).not.toBeNull();
      expect(await options.library.list(scope)).toHaveLength(0);
      expect((await manager.get(scope, { sessionId: session.sessionId })).state).toBe(
        mode === "cancel" ? "cancelled" : "uploading",
      );
    }
  },
  20000,
);

test.skipIf(!available)(
  "cancellation immediately after finish also cancels work waiting for its session lock",
  async () => {
    for (const cancelAll of [false, true]) {
      const { manager, library } = await fixture();
      const session = await upload(manager, await tone());
      const completion = manager.finish(scope, { sessionId: session.sessionId }).then(
        () => null,
        (error) => error as Error,
      );
      if (cancelAll) await manager.cancelScope(scope);
      else await manager.cancel(scope, { sessionId: session.sessionId });
      expect(await completion).toBeInstanceOf(Error);
      expect(await library.list(scope)).toHaveLength(0);
    }
  },
);
