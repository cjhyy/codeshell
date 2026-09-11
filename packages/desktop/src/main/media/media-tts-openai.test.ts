import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type ServerResponse } from "node:http";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateOpenAiTts, type OpenAiTtsOptions } from "./media-tts-openai.js";
import { runMediaProcess } from "./media-process-runner.js";
import type { MediaJobContext, MediaJobProgress } from "./media-types.js";

function pcmWav(sampleRate = 24000, seconds = 0.4): Buffer {
  const frames = Math.round(sampleRate * seconds),
    wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    wav.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / sampleRate) * 6000), 44 + i * 2);
  return wav;
}

let root = "",
  baseUrl = "",
  serial = 0;
let respond: (res: ServerResponse) => void;
const requests: Array<{ url: string; authorization?: string; body: unknown }> = [];
const events: MediaJobProgress[] = [];
const input = {
  text: "  新的中文旁白。  ",
  model: "chosen-tts-model",
  voiceId: "chosen-voice",
  rate: 1.25,
};
const credential = "synthetic-test-key-never-real";
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push({
    url: req.url!,
    authorization: req.headers.authorization,
    body: JSON.parse(Buffer.concat(chunks).toString() || "null"),
  });
  respond(res);
});
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "codeshell-openai-tts-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
function context(controller = new AbortController()): MediaJobContext {
  const job = join(root, `job-${++serial}`);
  return {
    scope: { appId: "video-studio", projectPath: root },
    jobId: String(serial),
    attempt: 1,
    signal: controller.signal,
    workDir: join(job, "work"),
    outputDir: join(job, "output"),
    cacheDir: join(job, "cache"),
    reportProgress: async (progress) => {
      events.push(progress);
    },
  };
}
function options(extra: Partial<OpenAiTtsOptions> = {}): OpenAiTtsOptions {
  return { baseUrl, apiKey: credential, ...extra };
}
function wavResponse(wav = pcmWav()) {
  respond = (res) => {
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
    res.end(wav);
  };
}
async function noFiles(job: MediaJobContext) {
  expect(await readdir(job.workDir)).toEqual([]);
  expect(await readdir(job.outputDir)).toEqual([]);
}

test("online speech sends the selected model and voice and converts a real WAV to audible 48kHz mono", async () => {
  wavResponse();
  const job = context();
  const result = await generateOpenAiTts(
    { ...input, instructions: "温暖、清晰。" },
    job,
    options(),
  );
  expect(requests.at(-1)).toEqual({
    url: "/v1/audio/speech",
    authorization: `Bearer ${credential}`,
    body: {
      model: input.model,
      input: input.text.trim(),
      voice: input.voiceId,
      speed: 1.25,
      response_format: "wav",
      instructions: "温暖、清晰。",
    },
  });
  expect(result.engine).toBe("openai-compatible");
  expect(result.mimeType).toBe("audio/wav");
  expect(result.durationSeconds).toBeCloseTo(0.4, 5);
  expect(result.sampleRate).toBe(48000);
  expect(result.channels).toBe(1);
  const decoded = await runMediaProcess(
    "ffmpeg",
    ["-v", "error", "-i", result.path, "-f", "f32le", "pipe:1"],
    { signal: job.signal },
  );
  let energy = 0;
  for (let offset = 0; offset < decoded.stdout.length; offset += 4)
    energy += decoded.stdout.readFloatLE(offset) ** 2;
  expect(Math.sqrt(energy / (decoded.stdout.length / 4))).toBeGreaterThan(0.1);
  expect(decoded.stdout.length / 4).toBe(19200);
  expect(await readdir(job.workDir)).toEqual([]);
  expect(await readdir(job.outputDir)).toEqual([result.path.split("/").at(-1)!]);
  expect(JSON.stringify(result)).not.toContain(credential);
  expect(events.at(-1)?.fraction).toBe(1);
});

test("plain requests omit unsupported optional instructions and repeated explicit calls do not silently cache", async () => {
  wavResponse();
  const count = requests.length;
  const first = await generateOpenAiTts(input, context(), options());
  const second = await generateOpenAiTts(input, context(), options());
  expect(requests.length).toBe(count + 2);
  expect((requests.at(-1)!.body as any).instructions).toBeUndefined();
  expect(first.path).not.toBe(second.path);
  expect(await readFile(first.path)).toEqual(await readFile(second.path));
});

test("invalid inputs and unsafe connection URLs cannot send a request or create output", async () => {
  const count = requests.length;
  for (const base of [
    "http://example.com/v1",
    "file:///tmp/audio",
    "https://user:secret@example.com/v1",
    "https://example.com/v1?q=secret",
    "https://example.com/v1#secret",
    "not a url",
  ])
    await expect(generateOpenAiTts(input, context(), options({ baseUrl: base }))).rejects.toThrow(
      /地址|HTTPS/,
    );
  for (const extra of [
    { text: " " },
    { text: "字".repeat(4097) },
    { text: "🙂".repeat(4097) },
    { model: "" },
    { voiceId: "a\nb" },
    { rate: 0.1 },
    { rate: NaN },
    { instructions: "字".repeat(4097) },
  ])
    await expect(generateOpenAiTts({ ...input, ...extra }, context(), options())).rejects.toThrow();
  expect(requests.length).toBe(count);
});

test("redirects are rejected without forwarding bearer credentials and upstream errors do not expose secrets", async () => {
  const count = requests.length;
  respond = (res) => {
    res.writeHead(307, { Location: `${baseUrl}stolen-credentials` });
    res.end();
  };
  const redirected = context();
  await expect(generateOpenAiTts(input, redirected, options())).rejects.toThrow("连接配音服务失败");
  expect(requests.length).toBe(count + 1);
  expect(requests.some((request) => request.url.includes("stolen-credentials"))).toBe(false);
  await noFiles(redirected);
  respond = (res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: credential }));
  };
  const failed = context();
  let error: unknown;
  try {
    await generateOpenAiTts(input, failed, options());
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).toContain("HTTP 401");
  expect(String(error)).not.toContain(credential);
  expect((error as Error).cause).toBeUndefined();
  await noFiles(failed);
});

test("wrong content type, wrong WAV signature, invalid media and overlong actual audio are rejected", async () => {
  const cases = [
    { type: "application/json", body: pcmWav() },
    { type: "audio/wav", body: Buffer.from('{"error":"this is not a sound file"}'.repeat(3)) },
    { type: "audio/wav", body: Buffer.from("RIFF0000WAVE" + "x".repeat(100)) },
    { type: "audio/wav", body: pcmWav(1000, 601) },
  ];
  for (const sample of cases) {
    respond = (res) => {
      res.writeHead(200, { "Content-Type": sample.type });
      res.end(sample.body);
    };
    const job = context();
    await expect(generateOpenAiTts(input, job, options())).rejects.toThrow(/WAV|音频/);
    await noFiles(job);
  }
});

test("advertised or streamed oversized responses stop before a partial output can be published", async () => {
  respond = (res) => {
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": 64 * 1024 * 1024 + 1 });
    res.end();
  };
  const advertised = context();
  await expect(generateOpenAiTts(input, advertised, options())).rejects.toThrow("64 MiB");
  await noFiles(advertised);
  respond = (res) => {
    res.writeHead(200, { "Content-Type": "audio/wav" });
    const chunk = Buffer.alloc(1024 * 1024);
    chunk.write("RIFF0000WAVE");
    let count = 0;
    const next = () => {
      if (res.destroyed) return;
      if (++count > 66) {
        res.end();
        return;
      }
      if (res.write(chunk)) setImmediate(next);
      else res.once("drain", next);
    };
    next();
  };
  const streamed = context();
  await expect(generateOpenAiTts(input, streamed, options())).rejects.toThrow("64 MiB");
  await noFiles(streamed);
}, 10_000);

test("HTTP streaming honours active cancellation and timeout, cleans files and makes no retry", async () => {
  respond = (res) => {
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.write(pcmWav().subarray(0, 100));
  };
  for (const mode of ["cancel", "timeout"]) {
    const controller = new AbortController(),
      job = context(controller),
      count = requests.length;
    const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 120) : undefined;
    try {
      if (mode === "cancel")
        await expect(generateOpenAiTts(input, job, options())).rejects.toMatchObject({
          name: "AbortError",
        });
      else
        await expect(generateOpenAiTts(input, job, options({ timeoutMs: 120 }))).rejects.toThrow(
          "超时",
        );
    } finally {
      if (timer) clearTimeout(timer);
    }
    expect(requests.length).toBe(count + 1);
    await noFiles(job);
  }
  const cancelled = new AbortController();
  cancelled.abort();
  const job = context(cancelled),
    count = requests.length;
  await expect(generateOpenAiTts(input, job, options())).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(requests.length).toBe(count);
  await expect(readdir(job.workDir)).rejects.toThrow();
});

test("cancellation also terminates actual FFmpeg conversion after HTTP has finished", async () => {
  wavResponse(pcmWav(24000, 3));
  const wrapper = join(root, "realtime-ffmpeg");
  await writeFile(wrapper, '#!/bin/sh\nexec ffmpeg -re "$@"\n');
  await chmod(wrapper, 0o700);
  const controller = new AbortController(),
    job = context(controller);
  let timer: ReturnType<typeof setTimeout> | undefined,
    encoding = false;
  job.reportProgress = async (event) => {
    if (event.stage === "speech-encode") {
      encoding = true;
      timer = setTimeout(() => controller.abort(), 120);
    }
  };
  const start = Date.now();
  try {
    await expect(
      generateOpenAiTts(input, job, options({ ffmpegPath: wrapper })),
    ).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    if (timer) clearTimeout(timer);
  }
  expect(encoding).toBe(true);
  expect(Date.now() - start).toBeLessThan(2000);
  await noFiles(job);
});
