import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMediaJobProcessors, inspectMediaFile } from "./media-processors.js";
import { runMediaProcess } from "./media-process-runner.js";
import type { MediaJobContext } from "./media-types.js";

const available =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

test.skipIf(!available)(
  "measures missing WebM Duration from real packets and preserves its tail through proxy and MP4 export",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "media-webm-"));
    const signal = new AbortController().signal;
    const context: MediaJobContext = {
      scope: { appId: "video-studio", projectPath: root },
      jobId: "webm",
      attempt: 1,
      signal,
      workDir: join(root, "work"),
      outputDir: join(root, "output"),
      cacheDir: join(root, "cache"),
      reportProgress: async () => {},
    };
    try {
      await Promise.all(
        [context.workDir, context.outputDir, context.cacheDir].map((path) => mkdir(path)),
      );
      const path = join(root, "recorder.webm");
      if (process.env.CODESHELL_MEDIA_BROWSER_FIXTURE === "1") {
        const { chromium } = await import("playwright");
        const browser = await chromium.launch({
          headless: true,
          args: ["--autoplay-policy=no-user-gesture-required"],
        });
        try {
          const page = await browser.newPage();
          const bytes = await page.evaluate(async () => {
            const canvas = document.createElement("canvas");
            canvas.width = 160;
            canvas.height = 90;
            const context = canvas.getContext("2d")!,
              audio = new AudioContext(),
              oscillator = audio.createOscillator(),
              destination = audio.createMediaStreamDestination();
            oscillator.connect(destination);
            await audio.resume();
            const stream = canvas.captureStream(30);
            destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
            const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8,opus" }),
              chunks: Blob[] = [];
            recorder.ondataavailable = (event) => chunks.push(event.data);
            const stopped = new Promise<void>((resolve) => {
              recorder.onstop = () => resolve();
            });
            oscillator.start();
            recorder.start(100);
            const started = performance.now();
            while (performance.now() - started < 2100) {
              context.fillStyle = performance.now() - started < 1000 ? "red" : "blue";
              context.fillRect(0, 0, 160, 90);
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            recorder.stop();
            await stopped;
            oscillator.stop();
            stream.getTracks().forEach((track) => track.stop());
            await audio.close();
            return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
          });
          await writeFile(path, Buffer.from(bytes));
        } finally {
          await browser.close();
        }
      } else {
        // A live muxer has the same intentionally omitted Duration element as
        // MediaRecorder. This core regression runs without downloading Chromium.
        await runMediaProcess(
          "ffmpeg",
          [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=160x90:r=30:d=2.1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2.1",
            "-c:v",
            "libvpx",
            "-c:a",
            "libopus",
            "-shortest",
            "-live",
            "1",
            path,
          ],
          { signal },
        );
      }
      const raw = await runMediaProcess(
        "ffprobe",
        ["-v", "error", "-show_format", "-of", "json", path],
        { signal },
      );
      expect(JSON.parse(raw.stdout.toString()).format.duration).toBeUndefined();
      const inspection = await inspectMediaFile(path, context);
      expect(inspection.durationSeconds).toBeGreaterThan(1.95);
      expect(inspection.durationSeconds).toBeLessThan(2.35);
      expect(inspection.audio?.codec).toBe("opus");
      const processors = createMediaJobProcessors({ resolveAssetPath: async () => path });
      const proxy: any = await processors.proxy!.run({ assetId: "source" }, context);
      const proxyInfo = await inspectMediaFile(proxy.proxy.path, context);
      expect(Math.abs(proxyInfo.durationSeconds! - inspection.durationSeconds!)).toBeLessThan(0.07);
      const frames = Math.floor(inspection.durationSeconds! * 30);
      const rendered: any = await processors.render!.run(
        {
          project: {
            schemaVersion: 1,
            revision: 1,
            fps: 30,
            width: 160,
            height: 90,
            assets: [{ id: "source", kind: "video" }],
            clips: [{ id: "clip", assetId: "source", inFrame: 0, outFrame: frames, volume: 1 }],
            captions: [],
          },
        },
        context,
      );
      expect(Math.abs(rendered.durationSeconds - frames / 30)).toBeLessThan(0.07);
      const lastFrame = await runMediaProcess(
        "ffmpeg",
        [
          "-v",
          "error",
          "-ss",
          String((frames - 1) / 30),
          "-i",
          rendered.video.path,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { signal },
      );
      expect(lastFrame.stdout.length).toBe(160 * 90 * 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
