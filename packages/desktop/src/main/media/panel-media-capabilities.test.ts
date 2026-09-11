import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { PanelMediaService } from "./panel-media-service.js";
import type { MediaJob, MediaScope } from "./media-types.js";
const available = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
let root = "",
  service: PanelMediaService | undefined;
afterEach(async () => {
  await service?.shutdown();
  if (root) await rm(root, { recursive: true, force: true });
});
async function terminal(scope: MediaScope, job: MediaJob): Promise<MediaJob> {
  for (let i = 0; i < 600; i++) {
    const next = await service!.jobs.get(scope, job.id);
    if (["succeeded", "failed", "cancelled"].includes(next.status)) {
      expect(next.status).toBe("succeeded");
      return next;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("media processing did not complete");
}
test.skipIf(!available)(
  "recording chunks become scoped sources, enhanced original sound enters a real MP4 and both survive restart",
  async () => {
    root = await mkdtemp(join(tmpdir(), "panel-capabilities-"));
    const input = join(root, "recorded.webm"),
      store = join(root, "store");
    const generated = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=30:d=1.2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=523:duration=1.2",
      "-c:v",
      "libvpx-vp9",
      "-c:a",
      "libopus",
      "-shortest",
      input,
    ]);
    expect(generated.status).toBe(0);
    const scope = { appId: "video-studio", projectPath: root };
    const options = {
      rootDirectory: store,
      isScopeAuthorized: (candidate: MediaScope) =>
        candidate.appId === scope.appId && candidate.projectPath === root,
      speechConfiguration: () => ({ models: [] }),
    };
    service = new PanelMediaService(options);
    const bytes = await readFile(input);
    const upload = (await service.dispatch(scope, "media.recording.begin", {
      mimeType: "video/webm;codecs=vp9,opus",
      name: "我的口播.webm",
      expectedBytes: bytes.length,
    })) as any;
    let sequence = 0;
    for (let offset = 0; offset < bytes.length; offset += upload.maxChunkBytes)
      await service.dispatch(scope, "media.recording.write", {
        sessionId: upload.sessionId,
        sequence: sequence++,
        offset,
        dataBase64: bytes.subarray(offset, offset + upload.maxChunkBytes).toString("base64"),
      });
    const recorded = (await service.dispatch(scope, "media.recording.finish", {
      sessionId: upload.sessionId,
    })) as any;
    expect(recorded.inspection.kind).toBe("video");
    expect(recorded.asset.name).toBe("我的口播.webm");
    await expect(
      service.dispatch({ ...scope, appId: "other" }, "media.assets.get", { id: recorded.asset.id }),
    ).rejects.toThrow();
    const enhanced = await terminal(
      scope,
      (await service.dispatch(scope, "media.audio.enhance", {
        assetId: recorded.asset.id,
        preset: "balanced",
      })) as MediaJob,
    );
    const audio = (enhanced.result as any).asset;
    expect(audio.mimeType).toBe("audio/wav");
    expect((enhanced.result as any).provenance.sourceAssetId).toBe(recorded.asset.id);
    const project = {
      schemaVersion: 1,
      id: "spoken",
      name: "我的口播",
      revision: 1,
      width: 160,
      height: 90,
      fps: 30,
      script: "保留原声的优化口播",
      assets: [
        { id: "picture", name: "原片", kind: "video", durationFrames: 36 },
        { id: "voice", name: "优化原声", kind: "audio", durationFrames: 36 },
      ],
      clips: [{ id: "clip", assetId: "picture", inFrame: 6, outFrame: 30, volume: 0 }],
      audioClips: [
        { id: "enhanced", assetId: "voice", inFrame: 6, outFrame: 30, startFrame: 0, volume: 0.7 },
      ],
      captions: [],
    };
    const rendered = await terminal(
      scope,
      (await service.dispatch(scope, "media.render", {
        project,
        sources: { picture: recorded.asset.id, voice: audio.id },
      })) as MediaJob,
    );
    const exported = (rendered.result as any).video.asset;
    const path = await service.library.resolvePath(scope, exported.id);
    const decoded = spawnSync(
      "ffmpeg",
      ["-v", "error", "-i", path, "-vn", "-ac", "1", "-f", "s16le", "-"],
      { maxBuffer: 1024 * 1024 },
    );
    expect(decoded.status).toBe(0);
    let sum = 0;
    for (let i = 0; i + 1 < decoded.stdout.length; i += 2)
      sum += (decoded.stdout.readInt16LE(i) / 32768) ** 2;
    const rms = Math.sqrt(sum / (decoded.stdout.length / 2));
    expect(rms).toBeGreaterThan(0.01);
    expect(await readFile(await service.library.resolvePath(scope, recorded.asset.id))).toEqual(
      bytes,
    );
    await service.dispatch(scope, "media.document.set", {
      key: "video-project",
      baseRevision: 0,
      data: project,
    });
    await service.shutdown();
    service = new PanelMediaService(options);
    const restored = (await service.dispatch(scope, "media.document.get", {
      key: "video-project",
    })) as any;
    expect(restored.data.audioClips).toEqual(project.audioClips);
    expect(
      ((await service.dispatch(scope, "media.assets.get", { id: exported.id })) as any).asset.id,
    ).toBe(exported.id);
  },
  60000,
);
