import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMediaJobProcessors, type CaptionImageRequest } from "./media-processors.js";
import { runMediaProcess } from "./media-process-runner.js";
import type { MediaJobContext } from "./media-types.js";

const available = ["ffmpeg", "ffprobe"].every(
  (command) => spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0,
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test.skipIf(!available)(
  "Host render forwards each allowlisted caption template and rejects CSS before resolving media",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "caption-style-"));
    roots.push(root);
    const source = join(root, "source.mp4");
    await runMediaProcess(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=black:s=160x90:r=30:d=0.2",
        "-c:v",
        "libx264",
        source,
      ],
      { signal: AbortSignal.timeout(10000) },
    );
    let resolutions = 0;
    const requests: CaptionImageRequest[] = [];
    const processors = createMediaJobProcessors({
      resolveAssetPath: async () => {
        resolutions++;
        return source;
      },
      renderCaptionPng: async (request) => {
        requests.push(request);
        // The PNG drawing itself has a real Chromium pixel-parity check in the
        // Panel repository. Stop here to isolate the Host's validated handoff.
        throw new Error("caption snapshot reached");
      },
    });
    const project = {
      schemaVersion: 1,
      revision: 0,
      fps: 30,
      width: 160,
      height: 90,
      assets: [{ id: "source", kind: "video" }],
      clips: [{ id: "clip", assetId: "source", inFrame: 0, outFrame: 6, volume: 1 }],
      captions: [{ id: "caption", startFrame: 0, endFrame: 6, text: "真实字幕" }],
    };
    let sequence = 0;
    const context = (): MediaJobContext => {
      const work = join(root, `attempt-${sequence++}`);
      return {
        scope: { appId: "video-studio", projectPath: root },
        jobId: "style",
        attempt: 1,
        signal: AbortSignal.timeout(10000),
        workDir: work,
        outputDir: work,
        cacheDir: join(root, "cache"),
        reportProgress: async () => {},
      };
    };
    for (const captionStyle of ["color:red", "url(https://example.com)", null, {}])
      await expect(
        processors.render!.run({ project: { ...project, captionStyle } }, context()),
      ).rejects.toThrow("Caption style");
    expect(resolutions).toBe(0);
    for (const captionStyle of [undefined, "classic", "bold", "minimal"])
      await expect(
        processors.render!.run(
          { project: { ...project, ...(captionStyle ? { captionStyle } : {}) } },
          context(),
        ),
      ).rejects.toThrow("caption snapshot reached");
    expect(requests.map((request) => request.style)).toEqual([
      "classic",
      "classic",
      "bold",
      "minimal",
    ]);
    expect(
      requests.every((request) => request.texts[0] === "真实字幕" && request.fontSize === 5),
    ).toBe(true);
  },
  20000,
);
