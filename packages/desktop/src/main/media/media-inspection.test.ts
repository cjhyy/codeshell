import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMediaJobProcessors, inspectMediaFile } from "./media-processors.js";
import { runMediaProcess } from "./media-process-runner.js";
import type { MediaJobContext } from "./media-types.js";

const available =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

test.skipIf(!available)(
  "rotated VFR footage keeps display orientation and becomes a seekable 30 fps proxy",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "media-vfr-"));
    const signal = new AbortController().signal;
    const context: MediaJobContext = {
      scope: { appId: "video-studio", projectPath: root },
      jobId: "job-vfr",
      attempt: 1,
      signal,
      workDir: join(root, "work"),
      outputDir: join(root, "output"),
      cacheDir: join(root, "cache"),
      reportProgress: async () => {},
    };
    try {
      await Promise.all(
        [context.workDir, context.outputDir, context.cacheDir].map((directory) => mkdir(directory)),
      );
      const source = join(root, "vfr.mp4"),
        rotated = join(root, "rotated.mp4");
      await runMediaProcess(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=120x80:r=30:d=2",
          "-vf",
          "setpts='if(lt(N,30),N/(30*TB),(1+(N-30)/15)/TB)'",
          "-fps_mode",
          "vfr",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          source,
        ],
        { signal },
      );
      const modernRotation = spawnSync("ffmpeg", ["-hide_banner", "-h", "full"], {
        encoding: "utf8",
      }).stdout.includes("-display_rotation");
      await runMediaProcess(
        "ffmpeg",
        [
          "-v",
          "error",
          ...(modernRotation ? ["-display_rotation", "90"] : []),
          "-i",
          source,
          "-c",
          "copy",
          ...(!modernRotation ? ["-metadata:s:v:0", "rotate=90"] : []),
          rotated,
        ],
        { signal },
      );
      const inspection = await inspectMediaFile(rotated, context);
      expect(inspection.video?.variableFrameRate).toBe(true);
      expect(inspection.video?.displayWidth).toBe(80);
      expect(inspection.video?.displayHeight).toBe(120);
      expect(Math.abs(inspection.video!.rotation)).toBe(90);
      const processors = createMediaJobProcessors({ resolveAssetPath: async () => rotated });
      const prepared = (await processors.proxy!.run({ assetId: "rotated" }, context)) as {
        proxy: { path: string };
      };
      const proxy = await inspectMediaFile(prepared.proxy.path, context);
      expect(proxy.video?.frameRate).toBe(30);
      expect(proxy.video?.variableFrameRate).toBe(false);
      expect(proxy.video?.displayWidth).toBe(80);
      expect(proxy.video?.displayHeight).toBe(120);
      expect(Math.abs(proxy.durationSeconds! - inspection.durationSeconds!)).toBeLessThan(0.07);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
