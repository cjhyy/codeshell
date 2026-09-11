import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PanelMediaService, type PanelMediaOptions } from "./panel-media-service.js";
import { mediaDirectory, mediaScopeKey, writeMediaJson } from "./media-storage.js";
import type { MediaJob } from "./media-types.js";
import type { SpeechConfiguration } from "@cjhyy/code-shell-core/internal";

const services = new Set<PanelMediaService>(),
  roots = new Set<string>();
afterEach(async () => {
  for (const service of services) await service.jobs.shutdown();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  services.clear();
  roots.clear();
});
const scope = { appId: "video-studio", projectPath: "/speech-project" };
const modelId = `speech-${"c".repeat(32)}`;
const configured = (): SpeechConfiguration => ({
  defaultModelId: modelId,
  models: [
    {
      description: {
        id: modelId,
        name: "测试旁白 · gpt-4o-mini-tts",
        provider: "OpenAI",
        available: true,
        voices: [{ id: "coral", name: "coral", language: "und" }],
        defaultVoiceId: "coral",
        maxTextLength: 4096,
        supportsInstructions: true,
      },
      connectionId: "test-narration",
      model: "gpt-4o-mini-tts",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "TEST-ONLY-SPEECH-SECRET",
      defaultRate: 1.1,
      defaultInstructions: "轻快地朗读",
    },
  ],
});
async function fixture(extra: Partial<PanelMediaOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "panel-speech-"));
  roots.add(root);
  const service = new PanelMediaService({
    rootDirectory: root,
    isScopeAuthorized: () => true,
    speechConfiguration: () => configured(),
    speechAudioToolsAvailable: async () => true,
    ...extra,
  });
  services.add(service);
  await service.initialize();
  return { service, root };
}
async function terminal(service: PanelMediaService, id: string): Promise<MediaJob> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const job = await service.jobs.get(scope, id);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Speech job did not settle");
}

test("speech catalog exposes configured choices without credentials, URLs or changing legacy local voices", async () => {
  const { service } = await fixture();
  const catalog = (await service.dispatch(scope, "media.tts.voices", {})) as any;
  expect(catalog.defaultModelId).toBe(modelId);
  expect(catalog.models.map((model: any) => model.id)).toEqual([
    "macos-say",
    "edge-tts",
    "kokoro",
    modelId,
  ]);
  expect(catalog.models[0].name).toBe("macOS 系统配音");
  expect(catalog.voices).toEqual(catalog.models[0].voices);
  expect(catalog.models.find((model: any) => model.id === modelId).supportsInstructions).toBe(true);
  const encoded = JSON.stringify(catalog);
  expect(encoded).not.toContain("TEST-ONLY-SPEECH-SECRET");
  expect(encoded).not.toContain("api.openai.com");
  expect(encoded).not.toContain("apiKey");
});

test("unknown models, cross-model voices, unsupported styles and oversized drafts fail before queuing", async () => {
  const configuration = configured();
  configuration.models[0]!.description.supportsInstructions = false;
  delete configuration.models[0]!.defaultInstructions;
  const { service } = await fixture({ speechConfiguration: () => configuration });
  for (const input of [
    { text: "你好", modelId: "deleted-model" },
    { text: "你好", modelId, voiceId: "Tingting" },
    { text: "你好", modelId, instructions: "温柔" },
    { text: "你好", modelId, instructions: "字".repeat(2001) },
    { text: "字".repeat(4097), modelId },
    { text: "你好", modelId, rate: NaN },
    { text: "你好", modelId: "macos-say", instructions: "温柔" },
    { text: "你好", modelId, apiKey: "guest-key" },
  ])
    await expect(service.dispatch(scope, "media.tts", input)).rejects.toThrow();
  expect(await service.jobs.list(scope)).toHaveLength(0);
});

test("configured online models remain visible but cannot start without audio conversion tools", async () => {
  const { service } = await fixture({ speechAudioToolsAvailable: async () => false });
  const catalog = (await service.dispatch(scope, "media.tts.voices", {})) as any;
  const online = catalog.models.find((model: any) => model.id === modelId);
  expect(online.available).toBe(false);
  expect(online.reason).toContain("FFmpeg");
  await expect(
    service.dispatch(scope, "media.tts", { text: "不应提前计费", modelId }),
  ).rejects.toThrow("FFmpeg");
  expect(await service.jobs.list(scope)).toHaveLength(0);
});

test("new requests use the configured speech default and freeze the selected model before queuing", async () => {
  let calls = 0;
  const { service, root } = await fixture({
    generateOnlineSpeech: async () => {
      calls++;
      throw new Error("Local test provider: no external request");
    },
  });
  const job = (await service.dispatch(scope, "media.tts", {
    text: "使用我选择的默认模型",
  })) as MediaJob;
  expect(job.type).toBe("tts-online");
  const directory = await mediaDirectory(root, ["scopes", mediaScopeKey(scope), "jobs", job.id]);
  expect(JSON.parse(await readFile(join(directory, "job.json"), "utf8")).input.modelId).toBe(
    modelId,
  );
  expect((await terminal(service, job.id)).status).toBe("failed");
  expect(calls).toBe(1);
});

test.skipIf(
  process.platform !== "darwin" ||
    spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0,
)(
  "requests without a configured default and explicit system selections retain local synthesis",
  async () => {
    for (const explicit of [false, true]) {
      const configuration = configured();
      if (!explicit) delete configuration.defaultModelId;
      let remoteCalls = 0;
      const { service, root } = await fixture({
        speechConfiguration: () => configuration,
        generateOnlineSpeech: async () => {
          remoteCalls++;
          throw new Error("must remain local");
        },
      });
      const job = (await service.dispatch(scope, "media.tts", {
        text: "本地",
        ...(explicit ? { modelId: "macos-say" } : {}),
      })) as MediaJob;
      expect(job.type).toBe("tts");
      const directory = await mediaDirectory(root, [
        "scopes",
        mediaScopeKey(scope),
        "jobs",
        job.id,
      ]);
      expect(JSON.parse(await readFile(join(directory, "job.json"), "utf8")).input.modelId).toBe(
        explicit ? "macos-say" : undefined,
      );
      await service.jobs.cancel(scope, job.id);
      expect(remoteCalls).toBe(0);
    }
  },
  10000,
);

test.skipIf(spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status !== 0)(
  "online speech stores the selected recipe and a probed scoped asset, never its credential",
  async () => {
    let calls = 0;
    const { service, root } = await fixture({
      generateOnlineSpeech: async (input, context, options) => {
        calls++;
        expect(input).toEqual({
          text: "最终文案",
          model: "gpt-4o-mini-tts",
          voiceId: "coral",
          rate: 1.1,
          instructions: "轻快地朗读",
        });
        expect(options.apiKey).toBe("TEST-ONLY-SPEECH-SECRET");
        const path = join(context.outputDir, "mock.wav");
        await copyFile(
          new URL("../../../../core/src/panel-apps/fixtures/static-tone.wav", import.meta.url),
          path,
        );
        // The service must inspect the actual bytes instead of trusting this duration.
        return {
          path,
          mimeType: "audio/wav",
          engine: "openai-compatible",
          durationSeconds: 999,
          sampleRate: 48000,
          channels: 1,
        };
      },
    });
    const queued = (await service.dispatch(scope, "media.tts", {
      text: " 最终文案 ",
      modelId,
    })) as MediaJob;
    expect(queued.type).toBe("tts-online");
    const finished = await terminal(service, queued.id);
    expect(finished.status).toBe("succeeded");
    const result = finished.result as any;
    expect(result.inspection.durationSeconds).toBeCloseTo(0.12, 2);
    expect(result.speech).toEqual({
      text: "最终文案",
      modelId,
      voiceId: "coral",
      engine: "openai-compatible",
      rate: 1.1,
      instructions: "轻快地朗读",
    });
    expect(result.asset.id).toMatch(/^asset-[a-f0-9]{64}$/);
    expect(calls).toBe(1);
    const directory = await mediaDirectory(root, [
      "scopes",
      mediaScopeKey(scope),
      "jobs",
      queued.id,
    ]);
    const stored = await readFile(join(directory, "job.json"), "utf8");
    expect(stored).not.toContain("TEST-ONLY-SPEECH-SECRET");
    expect(stored).not.toContain("api.openai.com");
    expect(JSON.stringify(finished)).not.toContain(root);
  },
  10000,
);

test("removing a configured model while queued cannot route to a replacement or the system voice", async () => {
  let configuration = configured(),
    calls = 0,
    unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const { service } = await fixture({
    speechConfiguration: () => configuration,
    generateOnlineSpeech: async () => {
      calls++;
      throw new Error("must not reach provider");
    },
  });
  service.jobs.registerProcessor("hold", {
    recovery: "fail",
    run: async () => {
      await gate;
      return {};
    },
  });
  try {
    await service.jobs.start(scope, { type: "hold", input: {} });
    await service.jobs.start(scope, { type: "hold", input: {} });
    const job = (await service.dispatch(scope, "media.tts", {
      text: "排队的文案",
      modelId,
    })) as MediaJob;
    configuration = { models: [] };
    unblock();
    const failed = await terminal(service, job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error?.message).toContain("连接已更改或不可用");
    expect(calls).toBe(0);
  } finally {
    unblock();
  }
});

test("interrupted paid synthesis requires explicit retry after Host restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-speech-recover-"));
  roots.add(root);
  const id = "job-interrupted-speech";
  const directory = await mediaDirectory(root, ["scopes", mediaScopeKey(scope), "jobs", id]);
  await writeMediaJson(join(directory, "job.json"), {
    schemaVersion: 1,
    id,
    scope,
    type: "tts-online",
    status: "running",
    attempt: 1,
    createdAt: 1,
    updatedAt: 2,
    input: { text: "可能已计费的文案", modelId, voiceId: "coral", rate: 1, instructions: "" },
  });
  let calls = 0;
  const service = new PanelMediaService({
    rootDirectory: root,
    isScopeAuthorized: () => true,
    speechConfiguration: () => configured(),
    generateOnlineSpeech: async () => {
      calls++;
      throw new Error("must not repeat a paid request");
    },
  });
  services.add(service);
  await service.initialize();
  const failed = await service.jobs.get(scope, id);
  expect(failed.status).toBe("failed");
  expect(failed.error?.code).toBe("INTERRUPTED");
  expect(failed.error?.retryable).toBe(true);
  expect(calls).toBe(0);
});
