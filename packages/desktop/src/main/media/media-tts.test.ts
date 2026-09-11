import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMediaProcess } from "./media-process-runner.js";
import { detectLocalTts, generateLocalTts, validateLocalTtsInput } from "./media-tts.js";
import type { MediaJobContext, MediaJobProgress } from "./media-types.js";

test("local speech input is normalized, bounded and rejects embedded say controls", () => {
  expect(validateLocalTtsInput({ text: "  你好\r\n世界  " })).toEqual({
    text: "你好\n世界",
    rate: 1,
  });
  expect(validateLocalTtsInput({ text: "a", voiceId: " Tingting ", rate: 2 })).toEqual({
    text: "a",
    voiceId: "Tingting",
    rate: 2,
  });
  expect(validateLocalTtsInput({ text: "字".repeat(6000), rate: 0.5 }).text.length).toBe(6000);
  for (const raw of [
    null,
    [],
    {},
    { text: " " },
    { text: "字".repeat(6001) },
    { text: "🙂".repeat(6001) },
    { text: "hello\u0000" },
    { text: "[[rate 999]]你好" },
    { text: "[[slnc 999999999]]" },
    { text: "[[voice Bad News]]你好" },
    { text: "hello", rate: 0.49 },
    { text: "hello", rate: 2.01 },
    { text: "hello", rate: "1" },
    { text: "hello", rate: NaN },
    { text: "hello", voiceId: " " },
  ])
    expect(() => validateLocalTtsInput(raw)).toThrow();
});

test("missing system speech is explicitly unavailable without installing anything", async () => {
  const result = await detectLocalTts({ sayPath: join(tmpdir(), "codeshell-no-such-say") });
  expect(result.available).toBe(false);
  expect(result.engine).toBe("unavailable");
  expect(result.voices).toEqual([]);
  expect(result.reason).toBeTruthy();
});

const available =
  process.platform === "darwin" &&
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!available)("real macOS system speech", () => {
  let root = "",
    serial = 0;
  let voiceId = "";
  const events: MediaJobProgress[] = [];
  const context = (controller = new AbortController()): MediaJobContext => {
    const base = join(root, `job-${++serial}`);
    return {
      scope: { appId: "video-studio", projectPath: root },
      jobId: String(serial),
      attempt: 1,
      signal: controller.signal,
      workDir: join(base, "work"),
      outputDir: join(base, "output"),
      cacheDir: join(root, "cache"),
      reportProgress: async (event) => {
        events.push(event);
      },
    };
  };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "codeshell-tts-"));
    const status = await detectLocalTts();
    expect(status.available).toBe(true);
    expect(status.engine).toBe("macos-say");
    expect(status.version).toContain("say-");
    const chinese =
      status.voices.find((voice) => voice.id === "Tingting") ??
      status.voices.find((voice) => voice.language === "zh_CN");
    if (!chinese)
      throw new Error("The Chinese speech fixture needs an installed zh_CN system voice");
    voiceId = chinese.id;
    expect(status.voices.every((voice) => voice.id && voice.name && voice.language)).toBe(true);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("Chinese narration has real PCM audio and verified cache survives jobs but rejects corruption", async () => {
    const input = { text: "从想法，到成片。留住值得讲述的瞬间。", voiceId, rate: 1 };
    const first = await generateLocalTts(input, context());
    expect(first.cached).toBe(false);
    expect(first.durationSeconds).toBeGreaterThan(1);
    expect(first.durationSeconds).toBeLessThan(15);
    expect(first.sampleRate).toBe(48000);
    expect(first.channels).toBe(1);
    const decoded = await runMediaProcess(
      "ffmpeg",
      ["-v", "error", "-i", first.path, "-f", "f32le", "-ac", "1", "pipe:1"],
      { signal: new AbortController().signal },
    );
    let energy = 0,
      peak = 0;
    for (let index = 0; index < decoded.stdout.length; index += 4) {
      const value = decoded.stdout.readFloatLE(index);
      energy += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    const rms = Math.sqrt(energy / (decoded.stdout.length / 4));
    expect(rms).toBeGreaterThan(0.015);
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(1);
    expect(Math.abs(decoded.stdout.length / 4 / 48000 - first.durationSeconds)).toBeLessThan(0.001);
    const second = await generateLocalTts(input, context());
    expect(second.cached).toBe(true);
    expect(second.path).not.toBe(first.path);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(await readFile(second.path)).toEqual(await readFile(first.path));
    const wav = join(root, "cache", `tts-${first.cacheKey}.wav`);
    const damaged = await readFile(wav);
    damaged[damaged.length - 100] ^= 127;
    await writeFile(wav, damaged);
    const repaired = await generateLocalTts(input, context());
    expect(repaired.cached).toBe(false);
    const repairedMetadata = JSON.parse(
      await readFile(join(root, "cache", `tts-${first.cacheKey}.json`), "utf8"),
    );
    expect(repairedMetadata.sha256).toBe(
      createHash("sha256")
        .update(await readFile(repaired.path))
        .digest("hex"),
    );
    expect(events.some((event) => event.stage === "synthesize")).toBe(true);
    expect(events.at(-1)?.fraction).toBe(1);
    console.info(
      `Real Chinese TTS: ${first.durationSeconds.toFixed(3)}s, RMS ${rms.toFixed(4)}, peak ${peak.toFixed(4)}`,
    );
  }, 30_000);

  test("requested rate changes actual speech duration and selects an installed voice only", async () => {
    const text = "整理素材，让每一次剪辑都有依据。";
    const slow = await generateLocalTts({ text, voiceId, rate: 0.5 }, context());
    const fast = await generateLocalTts({ text, voiceId, rate: 2 }, context());
    expect(slow.durationSeconds).toBeGreaterThan(fast.durationSeconds * 2.2);
    expect(slow.cacheKey).not.toBe(fast.cacheKey);
    expect(slow.rate).toBe(0.5);
    expect(fast.rate).toBe(2);
    await expect(
      generateLocalTts({ text, voiceId: "--output=/tmp/not-a-voice" }, context()),
    ).rejects.toThrow("未安装");
  }, 30_000);

  test("literal command-looking text cannot execute through file based synthesis", async () => {
    const marker = join(root, "must-not-exist");
    const result = await generateLocalTts({ text: `测试。$(touch ${marker})`, voiceId }, context());
    expect(result.durationSeconds).toBeGreaterThan(0);
    await expect(readFile(marker)).rejects.toThrow();
  }, 30_000);

  test("active and pre-cancelled speech stop and leave no partial output or raw text", async () => {
    const pre = new AbortController();
    pre.abort();
    const before = context(pre);
    await expect(generateLocalTts({ text: "你好", voiceId }, before)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(readdir(before.workDir)).rejects.toThrow();
    const controller = new AbortController();
    const active = context(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    active.reportProgress = async (event) => {
      if (event.stage === "synthesize") timer = setTimeout(() => controller.abort(), 100);
    };
    const started = Date.now();
    try {
      await expect(
        generateLocalTts(
          { text: "这是一段可以取消的长篇中文配音。".repeat(200), voiceId, rate: 0.5 },
          active,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      if (timer) clearTimeout(timer);
    }
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await readdir(active.workDir)).toEqual([]);
    expect(await readdir(active.outputDir)).toEqual([]);
    expect((await readdir(active.cacheDir)).some((name) => name.includes(".tmp."))).toBe(false);
  }, 10_000);
});
