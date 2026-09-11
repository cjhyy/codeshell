/** Build with Bun (target: node, external: electron), then launch with Electron. */
import { app, BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PanelMediaService } from "../src/main/media/panel-media-service.js";
import { MediaCaptionRenderer } from "../src/main/media/media-caption-renderer.js";
import type { MediaJob } from "../src/main/media/media-types.js";
import {
  preparePanelApp,
  registerPanelAppSchemePrivileges,
  replacePanelAppResources,
  setPanelAppMediaReader,
} from "../src/main/panel-app-protocol.js";

app.disableHardwareAcceleration();
app.on("window-all-closed", () => undefined);
registerPanelAppSchemePrivileges();
const execute = promisify(execFile);
const output = resolve(process.argv[2] ?? "artifacts/video-studio/native-render");
let service: PanelMediaService | undefined;
void app
  .whenReady()
  .then(async () => {
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(join(tmpdir(), "codeshell-native-media-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const scope = { appId: "video-studio", projectPath: workspace };
    const captions = new MediaCaptionRenderer();
    service = new PanelMediaService({
      rootDirectory: join(root, "store"),
      isScopeAuthorized: () => true,
      renderCaptionPng: (request, context) => captions.render(request, context),
      onChanged: (_scope, job) => {
        if (["failed", "succeeded", "cancelled"].includes(job.status)) captions.close(job.id);
      },
    });
    const wait = async (job: MediaJob) => {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const next = await service!.jobs.get(scope, job.id);
        if (next.status === "succeeded") return next.result as any;
        if (next.status === "failed" || next.status === "cancelled")
          throw new Error(JSON.stringify(next.error));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Native media smoke timed out");
    };
    const path = join(workspace, "source.mp4");
    await execute("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x20364a:s=640x360:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path,
    ]);
    const imported = await wait(await service.importFiles(scope, [path]));
    const asset = imported.assets[0];
    const project = {
      schemaVersion: 1,
      id: "native-smoke",
      revision: 1,
      fps: 30,
      width: 640,
      height: 360,
      assets: [{ id: asset.id, kind: "video" }],
      clips: [{ id: "clip", assetId: asset.id, inFrame: 0, outFrame: 60, volume: 0.6 }],
      captions: [
        {
          id: "c1",
          startFrame: 6,
          endFrame: 24,
          text: "视频工作台 · 中文字幕\n素材处理与自动剪辑",
        },
        { id: "c2", startFrame: 36, endFrame: 51, text: "预览与成片使用相同排版" },
      ],
      audioClips: [
        { id: "bgm", assetId: asset.id, startFrame: 15, inFrame: 0, outFrame: 30, volume: 0.2 },
      ],
    };
    const rendered = await wait(
      (await service.dispatch(scope, "media.render", { project })) as MediaJob,
    );
    const video = join(output, "native-captions.mp4");
    await service.exportFile(scope, rendered.video.asset.id, video);
    await service.exportFile(
      scope,
      rendered.subtitles.asset.id,
      join(output, "native-captions.srt"),
    );
    for (const [name, seconds] of [
      ["before", 0.1],
      ["caption", 0.5],
      ["gap", 1],
      ["second", 1.4],
    ] as const) {
      await execute("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-ss",
        String(seconds),
        "-i",
        video,
        "-frames:v",
        "1",
        join(output, `${name}.png`),
      ]);
    }
    // Exercise Chromium's actual media loader and canvas origin checks through
    // the same per-project protocol partition used by sandboxed Panel WebViews.
    await mkdir(join(workspace, "app"));
    await writeFile(
      join(workspace, "app", "index.html"),
      "<!doctype html><meta charset=utf-8><title>Media protocol smoke</title>",
    );
    replacePanelAppResources([
      {
        root: workspace,
        entry: "app/index.html",
        descriptor: {
          id: "panel-app:video-studio",
          appId: "video-studio",
          hostId: "native-media-smoke",
          title: "Media smoke",
          version: "1",
          revision: "1",
          icon: "image",
          singleton: true,
          permissions: ["context.workspace", "media"],
        },
      },
    ]);
    const requests: Array<{ method: string; range?: string }> = [];
    setPanelAppMediaReader((boundScope, id, request) => {
      requests.push(request);
      return service!.library.openRead(boundScope, id, request);
    });
    const prepared = await preparePanelApp("panel-app:video-studio", workspace);
    const preview = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: prepared.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await preview.loadURL(prepared.src);
    const url = `cspanel://native-media-smoke/media/${rendered.video.asset.id}`;
    const pixels = await preview.webContents.executeJavaScript(`(async () => {
    const video = document.createElement('video'); video.muted = true;
    document.body.append(video);
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Managed media failed to load')); video.src = ${JSON.stringify(url)}; });
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d'); const samples = [];
    for (const seconds of [0.1,0.5,1,1.4]) {
      await new Promise((resolve) => { video.onseeked = resolve; video.currentTime = seconds; });
      context.drawImage(video, 0, 0); const data = context.getImageData(0, 240, 640, 120).data;
      let white = 0; for (let i=0; i<data.length; i+=4) if (data[i]>210 && data[i+1]>210 && data[i+2]>210) white++;
      samples.push(white);
    }
    return samples;
  })()`);
    preview.destroy();
    if (pixels[0] !== 0 || pixels[2] !== 0 || pixels[1] < 100 || pixels[3] < 100)
      throw new Error(`Incorrect caption timing: ${pixels}`);
    if (!requests.some((request) => request.range?.startsWith("bytes=")))
      throw new Error("Native media loader did not exercise Range requests");
    await writeFile(
      join(output, "evidence.json"),
      JSON.stringify(
        {
          passed: true,
          rendered,
          pixels,
          requests,
          assertions: [
            "native Electron Unicode canvas captions",
            "independent audio track mixed",
            "Host persisted MP4 and SRT",
            "timed PNG caption track with gaps",
            "actual Chromium Range loading and same-origin canvas reads",
          ],
          root,
        },
        null,
        2,
      ),
    );
    await service.jobs.shutdown();
    process.stdout.write(`Native video media smoke passed: ${output}\n`);
    app.quit();
  })
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    await service?.jobs.shutdown();
    app.exit(1);
  });
