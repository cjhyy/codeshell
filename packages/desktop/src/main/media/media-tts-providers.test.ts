import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMediaProcess } from "./media-process-runner.js";
import {
  createManagedTtsProviders,
  validateManagedTtsInput,
  validateManagedTtsProviderId,
  type ManagedTtsProviderId,
} from "./media-tts-providers.js";
import type { MediaJobContext, MediaJobProgress } from "./media-types.js";

let root = "";
let serial = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "codeshell-managed-speech-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
function context(
  controller = new AbortController(),
  events: MediaJobProgress[] = [],
): MediaJobContext {
  const base = join(root, `job-${++serial}`);
  return {
    scope: { appId: "video-studio", projectPath: root },
    jobId: String(serial),
    attempt: 1,
    signal: controller.signal,
    workDir: join(base, "work"),
    outputDir: join(base, "output"),
    cacheDir: join(root, "cache"),
    reportProgress: async (progress) => {
      events.push(progress);
    },
  };
}

test("managed speech only accepts named providers and bounded plain text, voice and rate", () => {
  expect(
    validateManagedTtsInput({
      providerId: "edge-tts",
      text: "  中文\r\n测试  ",
      voiceId: " voice ",
      rate: 0.5,
      command: "ignored",
    }),
  ).toEqual({ providerId: "edge-tts", text: "中文\n测试", voiceId: "voice", rate: 0.5 });
  expect(validateManagedTtsInput({ providerId: "kokoro", text: "中文" }).rate).toBe(1);
  for (const provider of ["../../tmp", "$(touch nope)", "azure", "pip", {}, null])
    expect(() => validateManagedTtsProviderId(provider)).toThrow();
  for (const input of [
    null,
    [],
    {},
    { providerId: "kokoro", text: "。🙂" },
    { providerId: "kokoro", text: "字".repeat(6001) },
    { providerId: "edge-tts", text: "[[rate 9]]中文" },
    { providerId: "kokoro", text: "中文", rate: 2.01 },
    { providerId: "edge-tts", text: "中文", rate: NaN },
  ])
    expect(() => validateManagedTtsInput(input)).toThrow();
  expect(() => createManagedTtsProviders({ runtimeDir: "relative-directory" })).toThrow("absolute");
});

test("status and pre-cancelled setup are offline reads and do not create a runtime", async () => {
  const runtimeDir = join(root, "untouched");
  const api = createManagedTtsProviders({
    runtimeDir,
    uvPath: "/no-such-installer",
    pythonPath: "/no-such-python",
  });
  for (const provider of ["edge-tts", "kokoro"] as const) {
    const status = await api.status(provider);
    expect(status.available).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.voices).toEqual([]);
    expect(status.mode).toBe(provider === "kokoro" ? "offline" : "online");
    expect(status.requiredDiskBytes).toBeGreaterThan(0);
  }
  const controller = new AbortController();
  controller.abort();
  await expect(api.setup("edge-tts", context(controller))).rejects.toMatchObject({
    name: "AbortError",
  });
  await expect(api.generate({ providerId: "kokoro", text: "你好" }, context())).rejects.toThrow();
  await expect(readdir(runtimeDir)).rejects.toThrow();
});

test("failed prerequisites never enable a provider or publish a validation result", async () => {
  const runtimeDir = join(root, "missing-tools");
  const api = createManagedTtsProviders({ runtimeDir, ffmpegPath: join(root, "no-ffmpeg") });
  const job = context();
  await expect(api.setup("kokoro", job)).rejects.toThrow("Kokoro 准备失败");
  const status = await api.status("kokoro");
  expect(status.available).toBe(false);
  expect(status.state).toBe("failed");
  expect(status.reason).toContain("FFmpeg");
  await expect(readFile(join(runtimeDir, "kokoro", "runtime.json"))).rejects.toThrow();
  await expect(readdir(job.outputDir)).rejects.toThrow();
  await expect(readFile(join(runtimeDir, "kokoro", "setup.lock"))).rejects.toThrow();
  // A failed setup releases both its on-disk lock and in-process owner, so a
  // retry reaches the same prerequisite failure instead of a stale lock.
  await expect(api.setup("kokoro", context())).rejects.toThrow("Kokoro 准备失败");
  await expect(readFile(join(runtimeDir, "kokoro", "setup.lock"))).rejects.toThrow();
});

test("setup cancellation kills the installer, clears its lock and excludes concurrent scopes", async () => {
  const runtimeDir = join(root, "cancelled-install");
  const installer = join(root, "installer-fixture");
  const started = join(root, "installer-started");
  // A real child process stands in for a stalled installer; it never pretends to synthesize audio.
  await writeFile(
    installer,
    `#!/bin/sh\nprintf '%s' "$UV_EXTRA_INDEX_URL|$PIP_EXTRA_INDEX_URL|$PYTHONPATH|$UV_CACHE_DIR" > '${started}'\nexec /bin/sleep 30\n`,
  );
  await chmod(installer, 0o700);
  const api = createManagedTtsProviders({ runtimeDir, uvPath: installer });
  const anotherScope = createManagedTtsProviders({ runtimeDir, uvPath: installer });
  const controller = new AbortController();
  const events: MediaJobProgress[] = [];
  const job = context(controller, events);
  const previous = {
    UV_EXTRA_INDEX_URL: process.env.UV_EXTRA_INDEX_URL,
    PIP_EXTRA_INDEX_URL: process.env.PIP_EXTRA_INDEX_URL,
    PYTHONPATH: process.env.PYTHONPATH,
  };
  process.env.UV_EXTRA_INDEX_URL = "https://not-a-source.invalid";
  process.env.PIP_EXTRA_INDEX_URL = "https://not-a-source.invalid";
  process.env.PYTHONPATH = "/not-a-module-path";
  const start = Date.now();
  const pending = api.setup("edge-tts", job);
  try {
    for (let tries = 0; tries < 100; tries++) {
      if (
        await readFile(started).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(await readFile(started, "utf8")).toBe(`|||${join(runtimeDir, "package-cache")}`);
    expect((await anotherScope.status("edge-tts")).state).toBe("installing");
    await expect(
      anotherScope.setup("edge-tts", {
        ...context(),
        scope: { appId: "other-panel", projectPath: "/another" },
      }),
    ).rejects.toThrow("正在准备");
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - start).toBeLessThan(6000);
    expect((await api.status("edge-tts")).available).toBe(false);
    expect((await api.status("edge-tts")).reason).toContain("取消");
    await expect(readFile(join(runtimeDir, "edge-tts", "setup.lock"))).rejects.toThrow();
    expect(await readdir(job.workDir)).toEqual([]);
    expect(events.some((p) => p.stage === "setup")).toBe(true);
  } finally {
    controller.abort();
    await pending.catch(() => {});
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 10_000);

/** Run explicitly after setup; this suite makes real unauthenticated Edge calls and local inference. */
const integrationRuntime = process.env.CODESHELL_TEST_TTS_RUNTIME;
describe.skipIf(!integrationRuntime)("verified installed providers produce real media", () => {
  const api = createManagedTtsProviders({ runtimeDir: integrationRuntime || "/not-enabled" });
  test("same-size corrupted local weights become unavailable without mutating the source runtime", async () => {
    const runtimeDir = join(root, "damaged-model");
    const target = join(runtimeDir, "kokoro");
    await mkdir(target, { recursive: true });
    const source = join(integrationRuntime!, "kokoro");
    await symlink(join(source, "venv"), join(target, "venv"));
    for (const name of ["runtime.json", "runner.py", "kokoro-v1.0.onnx", "voices-v1.0.bin"])
      await copyFile(join(source, name), join(target, name));
    const handle = await open(join(target, "kokoro-v1.0.onnx"), "r+");
    try {
      await handle.write(Buffer.from("damaged"), 0, 7, 1024);
    } finally {
      await handle.close();
    }
    const damaged = createManagedTtsProviders({ runtimeDir });
    await expect(
      damaged.generate({ providerId: "kokoro", text: "检验模型" }, context()),
    ).rejects.toThrow("模型校验失败");
    const state = await damaged.status("kokoro");
    expect(state.state).toBe("failed");
    expect(state.available).toBe(false);
    expect((await api.status("kokoro")).available).toBe(true);
  }, 15_000);
  test("fixed model download rejects incorrect lengths and cleans a cancelled transfer", async () => {
    const runtimeDir = join(root, "download-boundaries");
    const kokoroDir = join(runtimeDir, "kokoro");
    await mkdir(kokoroDir, { recursive: true });
    // Reuse the real installed interpreter/dependencies, while testing fresh model transfers.
    await symlink(join(integrationRuntime!, "kokoro", "venv"), join(kokoroDir, "venv"));
    const downloading = createManagedTtsProviders({ runtimeDir });
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const job = context(controller);
    let requested = "";
    try {
      globalThis.fetch = (async (url) => {
        requested = String(url);
        return new Response("broken", { headers: { "content-length": "6" } });
      }) as typeof fetch;
      await expect(downloading.setup("kokoro", context())).rejects.toThrow("准备失败");
      expect(requested).toBe(
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx",
      );
      expect((await downloading.status("kokoro")).available).toBe(false);
      globalThis.fetch = (async (_url, options) => {
        return new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new Uint8Array(128 * 1024));
              options?.signal?.addEventListener(
                "abort",
                () => stream.error(new DOMException("Cancelled", "AbortError")),
                { once: true },
              );
            },
          }),
          { headers: { "content-length": "325532387" } },
        );
      }) as typeof fetch;
      let downloadProgress = false;
      job.reportProgress = async (progress) => {
        if (progress.stage === "download") {
          downloadProgress = true;
          controller.abort();
        }
      };
      await expect(downloading.setup("kokoro", job)).rejects.toMatchObject({ name: "AbortError" });
      expect(downloadProgress).toBe(true);
      expect((await downloading.status("kokoro")).available).toBe(false);
      expect((await readdir(kokoroDir)).some((name) => name.endsWith(".partial"))).toBe(false);
      await expect(readFile(join(kokoroDir, "kokoro-v1.0.onnx"))).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
      controller.abort();
    }
  }, 40_000);
  for (const providerId of ["edge-tts", "kokoro"] as const) {
    test(`${providerId}: actual Chinese speech, rate, cache corruption and PCM`, async () => {
      const runtime = await api.status(providerId);
      expect(runtime.available).toBe(true);
      expect(runtime.voices.length).toBeGreaterThan(4);
      expect(runtime.verifiedAt).toBeGreaterThan(0);
      const input = { providerId, text: "从想法，到成片。保留真实的声音。", rate: 1 };
      const events: MediaJobProgress[] = [];
      const first = await api.generate(input, context(undefined, events));
      expect(first.cached).toBe(false);
      expect(first.voice.id).toBe(runtime.defaultVoiceId);
      expect(first.durationSeconds).toBeGreaterThan(1);
      const pcm = await runMediaProcess(
        "ffmpeg",
        ["-v", "error", "-i", first.path, "-f", "f32le", "-ar", "48000", "-ac", "1", "pipe:1"],
        { signal: new AbortController().signal },
      );
      let energy = 0;
      for (let offset = 0; offset < pcm.stdout.length; offset += 4)
        energy += pcm.stdout.readFloatLE(offset) ** 2;
      const rms = Math.sqrt(energy / (pcm.stdout.length / 4));
      expect(rms).toBeGreaterThan(0.01);
      expect(Math.abs(pcm.stdout.length / 4 / 48000 - first.durationSeconds)).toBeLessThan(0.001);
      const next = await api.generate(input, context());
      expect(next.cached).toBe(true);
      expect(next.path).not.toBe(first.path);
      expect(await readFile(next.path)).toEqual(await readFile(first.path));
      const matching = await readdir(join(root, "cache"));
      for (const name of matching.filter((name) => name.endsWith(".wav"))) {
        const path = join(root, "cache", name);
        const bytes = await readFile(path);
        bytes[bytes.length - 200] ^= 127;
        await writeFile(path, bytes);
      }
      expect((await api.generate(input, context())).cached).toBe(false);
      const slow = await api.generate({ ...input, rate: 0.5 }, context());
      const fast = await api.generate({ ...input, rate: 2 }, context());
      expect(slow.durationSeconds).toBeGreaterThan(fast.durationSeconds * 1.7);
      await expect(
        api.generate({ ...input, voiceId: "--output=/nope" }, context()),
      ).rejects.toThrow("列表");
      expect(events.at(-1)?.fraction).toBe(1);
      console.info(
        `${providerId}: ${first.durationSeconds.toFixed(3)}s, RMS=${rms.toFixed(4)}, voices=${runtime.voices.length}`,
      );
    }, 120_000);
  }

  test("active local inference cancellation removes raw text and partial media", async () => {
    const controller = new AbortController();
    const job = context(controller);
    job.reportProgress = async (progress) => {
      if (progress.stage === "speech") controller.abort();
    };
    await expect(
      api.generate({ providerId: "kokoro", text: "这是可以取消的本地配音任务。".repeat(80) }, job),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(job.workDir)).toEqual([]);
    expect(await readdir(job.outputDir)).toEqual([]);
    expect((await api.status("kokoro")).available).toBe(true);
  }, 40_000);

  test("literal command-like narration is only data and cannot create files", async () => {
    const sentinel = join(root, "not-a-command");
    const result = await api.generate(
      { providerId: "kokoro" as ManagedTtsProviderId, text: `测试。$(touch ${sentinel})` },
      context(),
    );
    expect(result.durationSeconds).toBeGreaterThan(0);
    await expect(readFile(sentinel)).rejects.toThrow();
  }, 40_000);
});
