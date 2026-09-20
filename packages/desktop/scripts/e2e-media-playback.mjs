/*
 * Persisted assistant Markdown → production renderer/preload/Main protocol →
 * Chromium media decoding. Uses a disposable profile and generated media only.
 * Requires an existing Desktop build and ffmpeg on PATH (or FFMPEG_PATH).
 */
/* global document, window */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedSessionCatalog,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-media-e2e-");
const screenshotDir =
  process.env.CODESHELL_MEDIA_SCREENSHOT_DIR ?? join(appDir, "out", "media-playback-qa");
const workspace = join(isolated.home, "media-project");
const sessionId = "media-playback-fixture";
const otherSessionId = "media-playback-other";
const title = "聊天音视频播放验证";
const otherTitle = "切换后的任务";
let app;
let win;
let processLog = "";
const report = {};

function waveFixture() {
  const sampleRate = 16000;
  const sampleCount = sampleRate * 8;
  const bytes = Buffer.alloc(44 + sampleCount * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(sampleCount * 2, 40);
  // A quiet sine tone; playback is muted by the smoke test itself.
  for (let i = 0; i < sampleCount; i++) {
    bytes.writeInt16LE(
      Math.round(Math.sin((i / sampleRate) * 440 * Math.PI * 2) * 1000),
      44 + i * 2,
    );
  }
  return bytes;
}

async function seedTranscript(id, sessionTitle, content) {
  const folder = join(isolated.codeShellHome, "sessions", id);
  await mkdir(folder, { recursive: true });
  const now = Date.now();
  await writeFile(
    join(folder, "state.json"),
    JSON.stringify({
      sessionId: id,
      title: sessionTitle,
      cwd: workspace,
      origin: "desktop",
      kind: "work",
      parentSessionId: null,
      status: "completed",
      startedAt: now - 1000,
    }),
  );
  const events = [
    { type: "session_meta", data: { sessionId: id } },
    {
      type: "message",
      data: { role: "user", content: "请展示生成的音频与视频。", clientMessageId: `${id}-input` },
    },
    { type: "turn_boundary", data: {} },
    { type: "message", data: { role: "assistant", content } },
  ].map((event, index) => ({
    id: `${id}-event-${index}`,
    timestamp: now - 1000 + index * 100,
    turnNumber: 1,
    ...event,
  }));
  await writeFile(join(folder, "transcript.jsonl"), events.map(JSON.stringify).join("\n") + "\n");
}

async function screenshot(name) {
  await win.screenshot({ path: join(screenshotDir, name), scale: "css", animations: "disabled" });
}

async function reveal(locator) {
  // Opening disk history resolves task authority asynchronously and remounts
  // players once. Retry a detached candidate during that normal hydration.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await locator.scrollIntoViewIfNeeded();
      return;
    } catch (error) {
      if (attempt === 2 || !String(error).includes("not attached")) throw error;
    }
  }
}

async function protocolRead(url, { method = "HEAD", range } = {}) {
  return app.evaluate(
    async ({ net }, request) => {
      const response = await net.fetch(request.url, {
        method: request.method,
        ...(request.range ? { headers: { Range: request.range } } : {}),
      });
      const bytes = request.method === "HEAD" ? 0 : (await response.arrayBuffer()).byteLength;
      return { status: response.status, range: response.headers.get("content-range"), bytes };
    },
    { url, method, range },
  );
}

async function playAndAdvance(player, label) {
  await player.evaluate(async (node) => {
    node.muted = true;
    await node.play();
  });
  await win.waitForFunction(
    (name) => {
      const node = document.querySelector(
        `audio[aria-label="${name}"],video[aria-label="${name}"]`,
      );
      return node && !node.paused && node.currentTime > 0.15 && Number.isFinite(node.duration);
    },
    label,
    { timeout: 15_000 },
  );
  return player.evaluate((node) => ({
    currentTime: node.currentTime,
    duration: node.duration,
    readyState: node.readyState,
  }));
}

try {
  await mkdir(join(workspace, "media"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", workspace]);
  await mkdir(screenshotDir, { recursive: true });
  await writeFile(join(workspace, "media", "voice demo.wav"), waveFixture());
  await writeFile(join(isolated.home, "outside.wav"), waveFixture());
  await writeFile(
    join(workspace, "media", "invalid.mp4"),
    "Invalid video fixture: this is deliberately not a media container.",
  );
  execFileSync(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24",
    "-t",
    "8",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    join(workspace, "media", "preview.mp4"),
  ]);
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
  );
  await seedTranscript(
    sessionId,
    title,
    [
      "音频与视频已生成，可以直接播放。",
      "![音频示例](<media/voice demo.wav>)",
      "[视频示例](media/preview.mp4)",
      "![损坏视频](media/invalid.mp4)",
      "![缺失音频](media/missing.wav)",
      `![越界音频](<${join(isolated.home, "outside.wav")}>)`,
      "[远程视频](https://example.invalid/media.mp4)",
    ].join("\n\n"),
  );
  await seedTranscript(
    otherSessionId,
    otherTitle,
    "已切换到另一个任务。此前的播放器应停止并释放资源。",
  );

  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
  });
  app.process().stderr?.on("data", (chunk) => {
    processLog = (processLog + chunk).slice(-20_000);
  });
  win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1280, height: 960 });
  const trust = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await trust.waitFor({ timeout: 5000 }).then(
      () => true,
      () => false,
    )
  )
    await trust.click();
  await seedSessionCatalog(
    win,
    {
      __no_repo__: {
        sessions: [
          {
            id: sessionId,
            engineSessionId: sessionId,
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          {
            id: otherSessionId,
            engineSessionId: otherSessionId,
            title: otherTitle,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        activeSessionId: null,
      },
    },
    { replace: true },
  );
  await win.reload();
  await win.getByRole("button", { name: title, exact: true }).click();
  if (
    await trust.waitFor({ timeout: 5000 }).then(
      () => true,
      () => false,
    )
  )
    await trust.click();
  const audioCard = win.getByRole("group", { name: "音频：音频示例", exact: true });
  await reveal(audioCard);
  const audio = win.locator('audio[aria-label="音频示例"]');
  await audio.waitFor();
  const videoCard = win
    .locator('[data-media-kind="video"]')
    .filter({ has: win.locator('[title="media/preview.mp4"]') });
  await reveal(videoCard);
  const video = win.locator('video[aria-label="视频示例"]');
  await video.waitFor();
  assert((await audio.getAttribute("preload")) === "none", "Audio does not preload the file");
  assert((await video.getAttribute("preload")) === "none", "Video does not preload the file");
  const audioUrl = await audio.getAttribute("src");
  const videoUrl = await video.getAttribute("src");
  assert(audioUrl?.startsWith("csmedia://preview/"), "Audio uses an opaque authorized URL");
  assert(videoUrl?.startsWith("csmedia://preview/"), "Video uses an opaque authorized URL");
  report.range = await protocolRead(audioUrl, { method: "GET", range: "bytes=0-43" });
  assert(
    report.range.status === 206 && report.range.bytes === 44,
    "Media protocol honors a bounded Range request",
  );
  report.invalidRange = await protocolRead(audioUrl, { method: "GET", range: "bytes=999999999-" });
  assert(report.invalidRange.status === 416, "Unsatisfiable Range returns 416");
  report.audio = await playAndAdvance(audio, "音频示例");
  await audio.evaluate((node) => {
    node.currentTime = 3;
  });
  await win.waitForFunction(
    () => document.querySelector('audio[aria-label="音频示例"]')?.currentTime > 3.1,
  );
  report.audioSeek = await audio.evaluate((node) => node.currentTime);
  report.video = await playAndAdvance(video, "视频示例");
  assert(await audio.evaluate((node) => node.paused), "Starting the video pauses the audio player");
  await video.evaluate((node) => {
    node.currentTime = 4;
  });
  await win.waitForFunction(
    () => document.querySelector('video[aria-label="视频示例"]')?.currentTime > 4.1,
  );
  report.videoSeek = await video.evaluate((node) => node.currentTime);
  await video.evaluate((node) => node.pause());
  await screenshot("media-desktop.png");

  const invalidCard = win.getByRole("group", { name: "视频：损坏视频", exact: true });
  await reveal(invalidCard);
  const invalid = invalidCard.locator("video");
  await invalid.waitFor();
  await invalid.evaluate(async (node) => {
    node.muted = true;
    await node.play().catch(() => undefined);
  });
  await invalidCard.getByRole("status").waitFor();
  report.decoderFallback = await invalidCard.getByRole("status").innerText();
  assert(
    (await invalidCard.locator("video").count()) === 0,
    "Decoder failure becomes a retryable fallback",
  );
  const missingCard = win.getByRole("group", { name: "音频：缺失音频", exact: true });
  await reveal(missingCard);
  await missingCard.getByRole("button", { name: /重试|Retry/ }).waitFor();
  assert(
    (await missingCard.locator("audio").count()) === 0,
    "Missing files never produce a dead player",
  );
  const outsideCard = win.getByRole("group", { name: "音频：越界音频", exact: true });
  await reveal(outsideCard);
  await outsideCard.getByRole("button", { name: /重试|Retry/ }).waitFor();
  assert(
    (await outsideCard.locator("audio").count()) === 0,
    "A task cannot play an out-of-workspace file",
  );
  assert(
    (await win.locator('a[href="https://example.invalid/media.mp4"]').count()) === 1,
    "Remote media remains an explicit link",
  );
  await screenshot("media-errors.png");

  await win.setViewportSize({ width: 390, height: 844 });
  await reveal(videoCard);
  const box = await videoCard.boundingBox();
  assert(box && box.x >= -1 && box.x + box.width <= 391, "Media card fits a narrow chat viewport");
  await screenshot("media-narrow.png");
  await win.setViewportSize({ width: 1280, height: 960 });
  await reveal(videoCard);
  await video.evaluate(async (node) => {
    node.currentTime = 0;
    window.__mediaPlaybackSmoke = node;
    await node.play();
  });
  await win.getByRole("button", { name: otherTitle, exact: true }).click();
  await win
    .getByText("已切换到另一个任务。此前的播放器应停止并释放资源。", { exact: true })
    .waitFor();
  await win.waitForFunction(() => {
    const node = window.__mediaPlaybackSmoke;
    return node && !node.isConnected && node.paused && !node.getAttribute("src");
  });
  report.releasedAudio = await protocolRead(audioUrl);
  report.releasedVideo = await protocolRead(videoUrl);
  assert(
    report.releasedAudio.status === 404 && report.releasedVideo.status === 404,
    "Switching tasks releases both preview URLs",
  );
  assert(
    errors.length === 0,
    `No renderer exceptions: ${errors.map((error) => error.message).join("; ")}`,
  );
  await writeFile(join(screenshotDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    `PASS: real WAV/MP4 playback, seeking, player coordination, Range, task release, error fallback and responsive layout. Evidence: ${screenshotDir}`,
  );
} catch (error) {
  await screenshot("media-failure.png").catch(() => undefined);
  if (processLog) console.error(processLog);
  throw error;
} finally {
  try {
    await app?.close();
  } finally {
    await isolated.cleanup();
  }
}
