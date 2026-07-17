#!/usr/bin/env node

import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ASPECT_DIMENSIONS = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
};
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_CLIPS = 256;
const MAX_FRAME_TIMES = 24;
const MAX_PATH_CHARS = 4096;
const MAX_ENCODING_TOKEN_CHARS = 64;

function fail(message) {
  throw new Error(message);
}

function asRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function finiteNumber(value, label, options = {}) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) fail(`${label} must be a finite number`);
  if (options.min !== undefined && number < options.min) {
    fail(`${label} must be >= ${options.min}`);
  }
  if (options.max !== undefined && number > options.max) {
    fail(`${label} must be <= ${options.max}`);
  }
  return number;
}

function encodingToken(value, label, fallback) {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ENCODING_TOKEN_CHARS ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    fail(
      `${label} must be a ${MAX_ENCODING_TOKEN_CHARS}-character FFmpeg identifier using letters, numbers, dot, underscore, or hyphen`,
    );
  }
  return value;
}

export function parseTimecode(value) {
  if (typeof value === "number") return finiteNumber(value, "time", { min: 0 });
  if (typeof value !== "string" || value.trim() === "") {
    fail("time must be seconds or a timecode string");
  }
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return finiteNumber(trimmed, "time", { min: 0 });
  }
  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === "")) {
    fail(`invalid timecode: ${value}`);
  }
  const numbers = parts.map((part) => finiteNumber(part, "timecode component", { min: 0 }));
  const seconds = numbers.at(-1);
  const minutes = numbers.at(-2);
  const hours = numbers.length === 3 ? numbers[0] : 0;
  if (seconds >= 60 || (numbers.length === 3 && minutes >= 60)) {
    fail(`invalid timecode: ${value}`);
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function formatSeconds(value) {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function parseFrameTimes(value) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("--at must contain one or more comma-separated timecodes");
  }
  const rawTimes = value.split(",").map((item) => item.trim());
  if (
    rawTimes.length === 0 ||
    rawTimes.length > MAX_FRAME_TIMES ||
    rawTimes.some((item) => item === "")
  ) {
    fail(`--at must contain between 1 and ${MAX_FRAME_TIMES} timecodes`);
  }
  const seen = new Set();
  const times = [];
  for (const raw of rawTimes) {
    const seconds = parseTimecode(raw);
    const key = formatSeconds(seconds);
    if (!seen.has(key)) {
      seen.add(key);
      times.push(seconds);
    }
  }
  return times;
}

export function buildAtempoFilter(speed) {
  const value = finiteNumber(speed, "video.speed", { min: 0.25, max: 4 });
  const factors = [];
  let remaining = value;
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  factors.push(remaining);
  return factors.map((factor) => `atempo=${formatSeconds(factor)}`).join(",");
}

function resolvePlanPath(value, baseDir, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required`);
  if (value.length > MAX_PATH_CHARS) {
    fail(`${label} must be at most ${MAX_PATH_CHARS} characters`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must not contain control characters`);
  }
  const resolved = isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
  if (resolved.length > MAX_PATH_CHARS) {
    fail(`${label} resolves to more than ${MAX_PATH_CHARS} characters`);
  }
  return resolved;
}

function evenInteger(value, label) {
  const number = finiteNumber(value, label, { min: 2, max: 16384 });
  if (!Number.isInteger(number) || number % 2 !== 0) {
    fail(`${label} must be an even integer between 2 and 16384`);
  }
  return number;
}

function regularFileInfo(path, label) {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      fail(`${label} does not exist: ${path}`);
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    fail(`${label} must not be a symbolic link: ${path}`);
  }
  if (!info.isFile()) {
    fail(`${label} must be a regular file: ${path}`);
  }
  return info;
}

function assertSafeDirectoryChain(directory, label) {
  let current = resolve(directory);
  while (true) {
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        throw error;
      }
      info = undefined;
    }
    const parent = dirname(current);
    if (info?.isSymbolicLink()) {
      const isSystemRootAlias = parent === dirname(parent);
      if (!isSystemRootAlias) {
        fail(`${label} must not contain a symbolic-link directory: ${current}`);
      }
      current = parent;
      if (parent === dirname(parent)) break;
      continue;
    }
    if (info && !info.isDirectory()) {
      fail(`${label} contains a non-directory path: ${current}`);
    }
    if (parent === current) break;
    current = parent;
  }
}

function assertOutputDirectory(outputDir) {
  let info;
  try {
    info = lstatSync(outputDir);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw error;
    }
    assertSafeDirectoryChain(dirname(outputDir), "output directory parent");
    return;
  }
  if (info.isSymbolicLink()) {
    fail(`output directory must not be a symbolic link: ${outputDir}`);
  }
  if (!info.isDirectory()) {
    fail(`output directory is not a directory: ${outputDir}`);
  }
  assertSafeDirectoryChain(dirname(outputDir), "output directory parent");
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSafeOutputPath(input, output, overwrite, label) {
  const inputInfo = regularFileInfo(input, "input");
  assertSafeDirectoryChain(dirname(output), `${label} parent`);
  if (resolve(input) === resolve(output)) {
    fail(`${label} must differ from input`);
  }

  let outputInfo;
  try {
    outputInfo = lstatSync(output);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  if (outputInfo.isSymbolicLink()) {
    fail(`${label} must not be a symbolic link: ${output}`);
  }
  if (!outputInfo.isFile()) {
    fail(`${label} must be a regular file when it already exists: ${output}`);
  }
  if (sameFile(inputInfo, outputInfo)) {
    fail(`${label} resolves to the input file: ${output}`);
  }
  if (outputInfo.nlink > 1) {
    fail(`${label} has multiple hard links and cannot be replaced safely: ${output}`);
  }
  if (!overwrite) {
    fail(`${label} already exists (enable overwrite to replace it): ${output}`);
  }
}

export function normalizePlan(rawPlan, baseDir = process.cwd()) {
  const plan = asRecord(rawPlan, "plan");
  const video = plan.video === undefined ? {} : asRecord(plan.video, "video");
  const audio = plan.audio === undefined ? {} : asRecord(plan.audio, "audio");
  const encoding = plan.encoding === undefined ? {} : asRecord(plan.encoding, "encoding");
  const transition =
    video.transition === undefined ? undefined : asRecord(video.transition, "video.transition");
  const subtitles =
    plan.subtitles === undefined ? undefined : asRecord(plan.subtitles, "subtitles");

  const aspect = video.aspect ?? "original";
  if (!["original", ...Object.keys(ASPECT_DIMENSIONS)].includes(aspect)) {
    fail("video.aspect must be original, 16:9, 9:16, 1:1, or 4:5");
  }
  const fit = video.fit ?? "cover";
  if (fit !== "cover" && fit !== "contain") fail("video.fit must be cover or contain");

  let width;
  let height;
  if (video.width !== undefined || video.height !== undefined) {
    if (video.width === undefined || video.height === undefined) {
      fail("video.width and video.height must be provided together");
    }
    width = evenInteger(video.width, "video.width");
    height = evenInteger(video.height, "video.height");
  } else if (aspect !== "original") {
    [width, height] = ASPECT_DIMENSIONS[aspect];
  }

  const clips = plan.clips === undefined ? [] : plan.clips;
  if (!Array.isArray(clips)) fail("clips must be an array");
  if (clips.length > MAX_CLIPS) fail(`clips must contain at most ${MAX_CLIPS} entries`);
  const normalizedClips = clips.map((rawClip, index) => {
    const clip = asRecord(rawClip, `clips[${index}]`);
    const start = parseTimecode(clip.start);
    const end = parseTimecode(clip.end);
    if (end <= start) fail(`clips[${index}].end must be after start`);
    return { start, end };
  });
  const transitionType = transition?.type ?? "cut";
  if (transitionType !== "cut" && transitionType !== "fade") {
    fail("video.transition.type must be cut or fade");
  }
  const transitionDuration =
    transitionType === "fade"
      ? finiteNumber(transition?.duration ?? 0.25, "video.transition.duration", {
          min: 0.01,
          max: 5,
        })
      : 0;
  if (transitionType === "fade") {
    if (normalizedClips.length < 2) {
      fail("video.transition fade requires at least two clips");
    }
    normalizedClips.forEach((clip, index) => {
      if (clip.end - clip.start <= transitionDuration) {
        fail(`clips[${index}] must be longer than video.transition.duration`);
      }
    });
  }

  return {
    input: resolvePlanPath(plan.input, baseDir, "input"),
    output: resolvePlanPath(plan.output, baseDir, "output"),
    overwrite: plan.overwrite === true,
    clips: normalizedClips,
    video: {
      aspect,
      fit,
      width,
      height,
      fps:
        video.fps === undefined
          ? undefined
          : finiteNumber(video.fps, "video.fps", { min: 1, max: 240 }),
      speed:
        video.speed === undefined
          ? 1
          : finiteNumber(video.speed, "video.speed", { min: 0.25, max: 4 }),
      transition: {
        type: transitionType,
        duration: transitionDuration,
      },
    },
    audio: {
      mute: audio.mute === true,
      volume:
        audio.volume === undefined
          ? 1
          : finiteNumber(audio.volume, "audio.volume", { min: 0, max: 10 }),
    },
    subtitles:
      subtitles === undefined
        ? undefined
        : { path: resolvePlanPath(subtitles.path, baseDir, "subtitles.path") },
    encoding: {
      videoCodec: encodingToken(encoding.videoCodec, "encoding.videoCodec", "libx264"),
      audioCodec: encodingToken(encoding.audioCodec, "encoding.audioCodec", "aac"),
      crf:
        encoding.crf === undefined
          ? 18
          : finiteNumber(encoding.crf, "encoding.crf", { min: 0, max: 51 }),
      preset: encodingToken(encoding.preset, "encoding.preset", "medium"),
    },
  };
}

function escapeSubtitlePath(path) {
  return path
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function probeSummary(probe) {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration ?? video?.duration ?? audio?.duration);
  return {
    duration: Number.isFinite(duration) ? duration : undefined,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width,
    height: video?.height,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    frameRate: video?.avg_frame_rate,
  };
}

function requireVideoStream(summary, label) {
  if (!summary.hasVideo) {
    fail(`${label} does not contain a video stream`);
  }
}

/**
 * Re-check the path and media facts produced by FFmpeg before reporting a
 * render as successful. This closes the gap between the preflight checks and
 * the final output: a replaced symlink/hard-link alias, an empty file, or an
 * audio-only result must never be presented as a valid video export.
 */
export function validateRenderedOutput(input, output, probe) {
  const inputInfo = regularFileInfo(input, "input");
  assertSafeDirectoryChain(dirname(output), "rendered output parent");
  const outputInfo = regularFileInfo(output, "rendered output");
  if (sameFile(inputInfo, outputInfo)) {
    fail(`rendered output resolves to the input file: ${output}`);
  }
  if (outputInfo.nlink > 1) {
    fail(`rendered output has multiple hard links and cannot be trusted: ${output}`);
  }
  if (outputInfo.size < 1) {
    fail(`rendered output is empty: ${output}`);
  }
  const summary = probeSummary(probe);
  requireVideoStream(summary, "rendered output");
  return summary;
}

export function buildRenderCommand(plan, probe) {
  const summary = probeSummary(probe);
  regularFileInfo(plan.input, "input");
  requireVideoStream(summary, "input");
  if (plan.subtitles) regularFileInfo(plan.subtitles.path, "subtitle file");
  assertSafeOutputPath(plan.input, plan.output, plan.overwrite, "output");
  if (summary.duration !== undefined) {
    plan.clips.forEach((clip, index) => {
      if (clip.end > summary.duration + 0.05) {
        fail(`clips[${index}].end (${clip.end}) exceeds source duration (${summary.duration})`);
      }
    });
  }

  const filters = [];
  const useAudio = summary.hasAudio && !plan.audio.mute;
  let videoLabel;
  let audioLabel;

  if (plan.clips.length > 0) {
    for (const [index, clip] of plan.clips.entries()) {
      filters.push(
        `[0:v:0]trim=start=${formatSeconds(clip.start)}:end=${formatSeconds(
          clip.end,
        )},setpts=PTS-STARTPTS,settb=AVTB[v${index}]`,
      );
      if (useAudio) {
        filters.push(
          `[0:a:0]atrim=start=${formatSeconds(clip.start)}:end=${formatSeconds(
            clip.end,
          )},asetpts=PTS-STARTPTS[a${index}]`,
        );
      }
    }
    if (plan.clips.length === 1) {
      videoLabel = "v0";
      if (useAudio) audioLabel = "a0";
    } else if (plan.video.transition.type === "fade") {
      const duration = plan.video.transition.duration;
      let accumulatedDuration = plan.clips[0].end - plan.clips[0].start;
      let currentVideo = "v0";
      let currentAudio = useAudio ? "a0" : undefined;
      for (let index = 1; index < plan.clips.length; index++) {
        const nextVideo = `vx${index}`;
        const offset = accumulatedDuration - duration;
        filters.push(
          `[${currentVideo}][v${index}]xfade=transition=fade:duration=${formatSeconds(
            duration,
          )}:offset=${formatSeconds(offset)}[${nextVideo}]`,
        );
        currentVideo = nextVideo;
        if (useAudio && currentAudio) {
          const nextAudio = `ax${index}`;
          filters.push(
            `[${currentAudio}][a${index}]acrossfade=d=${formatSeconds(
              duration,
            )}:c1=tri:c2=tri[${nextAudio}]`,
          );
          currentAudio = nextAudio;
        }
        accumulatedDuration += plan.clips[index].end - plan.clips[index].start - duration;
      }
      videoLabel = currentVideo;
      if (useAudio) audioLabel = currentAudio;
    } else {
      const concatInputs = plan.clips
        .map((_clip, index) => `[v${index}]${useAudio ? `[a${index}]` : ""}`)
        .join("");
      filters.push(
        `${concatInputs}concat=n=${plan.clips.length}:v=1:a=${useAudio ? 1 : 0}` +
          `[vcat]${useAudio ? "[acat]" : ""}`,
      );
      videoLabel = "vcat";
      if (useAudio) audioLabel = "acat";
    }
  } else {
    filters.push("[0:v:0]setpts=PTS-STARTPTS[vbase]");
    videoLabel = "vbase";
    if (useAudio) {
      filters.push("[0:a:0]asetpts=PTS-STARTPTS[abase]");
      audioLabel = "abase";
    }
  }

  const videoFilters = [];
  if (plan.video.speed !== 1) {
    videoFilters.push(`setpts=PTS/${formatSeconds(plan.video.speed)}`);
  }
  if (plan.video.width && plan.video.height) {
    const width = plan.video.width;
    const height = plan.video.height;
    if (plan.video.fit === "cover") {
      videoFilters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
      );
    } else {
      videoFilters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      );
    }
  }
  if (plan.video.fps !== undefined) videoFilters.push(`fps=${formatSeconds(plan.video.fps)}`);
  if (plan.subtitles) {
    videoFilters.push(`subtitles=filename='${escapeSubtitlePath(plan.subtitles.path)}'`);
  }
  videoFilters.push("setsar=1", "format=yuv420p");
  filters.push(`[${videoLabel}]${videoFilters.join(",")}[vout]`);

  if (useAudio) {
    const audioFilters = [];
    if (plan.video.speed !== 1) audioFilters.push(buildAtempoFilter(plan.video.speed));
    if (plan.audio.volume !== 1) {
      audioFilters.push(`volume=${formatSeconds(plan.audio.volume)}`);
    }
    audioFilters.push("aresample=async=1:first_pts=0");
    filters.push(`[${audioLabel}]${audioFilters.join(",")}[aout]`);
  }

  const args = [
    plan.overwrite ? "-y" : "-n",
    "-hide_banner",
    "-i",
    plan.input,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
  ];
  if (useAudio) args.push("-map", "[aout]");
  args.push(
    "-c:v",
    plan.encoding.videoCodec,
    "-preset",
    plan.encoding.preset,
    "-crf",
    String(plan.encoding.crf),
  );
  if (useAudio) args.push("-c:a", plan.encoding.audioCodec, "-b:a", "192k");
  args.push("-movflags", "+faststart", plan.output);
  return { command: "ffmpeg", args, summary, useAudio };
}

export function buildFrameCommands(input, outputDir, times, probe, overwrite = false) {
  regularFileInfo(input, "input");
  assertOutputDirectory(outputDir);
  if (!Array.isArray(times) || times.length < 1 || times.length > MAX_FRAME_TIMES) {
    fail(`frame times must contain between 1 and ${MAX_FRAME_TIMES} entries`);
  }
  const normalizedTimes = times.map((time, index) =>
    finiteNumber(time, `frame times[${index}]`, { min: 0 }),
  );
  const summary = probeSummary(probe);
  requireVideoStream(summary, "input");
  const commands = normalizedTimes.map((time, index) => {
    if (summary.duration !== undefined && time > summary.duration + 0.05) {
      fail(`frame time (${time}) exceeds source duration (${summary.duration})`);
    }
    const output = resolve(outputDir, `frame-${String(index + 1).padStart(3, "0")}.jpg`);
    assertSafeOutputPath(input, output, overwrite, "frame output");
    return {
      command: "ffmpeg",
      args: [
        overwrite ? "-y" : "-n",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        input,
        "-ss",
        formatSeconds(time),
        "-frames:v",
        "1",
        "-an",
        "-q:v",
        "2",
        output,
      ],
      output,
      time,
    };
  });
  return { input, outputDir, summary, commands };
}

export function probeMedia(input) {
  regularFileInfo(input, "input");
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", input],
    { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) fail(`ffprobe failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(result.stderr.trim() || `ffprobe exited ${result.status}`);
  return JSON.parse(result.stdout);
}

function commandExists(command) {
  const result = spawnSync(command, ["-version"], {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  });
  return {
    available: !result.error && result.status === 0,
    version: (result.stdout || result.stderr).split(/\r?\n/, 1)[0] || undefined,
    error: result.error?.message,
  };
}

function ffmpegFilterAvailable(name) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-filters"], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      error: result.error?.message ?? result.stderr.trim() ?? `ffmpeg exited ${result.status}`,
    };
  }
  const available = result.stdout
    .split(/\r?\n/u)
    .some((line) => line.trim().split(/\s+/u)[1] === name);
  return { available };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index];
    if (!item.startsWith("--")) fail(`unexpected argument: ${item}`);
    const key = item.slice(2);
    if (key === "dry-run" || key === "overwrite") {
      flags[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for --${key}`);
    flags[key] = value;
    index += 1;
  }
  return { command, flags };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  if (command === "check") {
    const ffmpeg = commandExists("ffmpeg");
    const ffprobe = commandExists("ffprobe");
    const subtitles = ffmpeg.available
      ? ffmpegFilterAvailable("subtitles")
      : { available: false, error: "ffmpeg is unavailable" };
    const xfade = ffmpeg.available
      ? ffmpegFilterAvailable("xfade")
      : { available: false, error: "ffmpeg is unavailable" };
    const acrossfade = ffmpeg.available
      ? ffmpegFilterAvailable("acrossfade")
      : { available: false, error: "ffmpeg is unavailable" };
    printJson({
      ok: ffmpeg.available && ffprobe.available,
      ffmpeg,
      ffprobe,
      features: { subtitles, transitions: { video: xfade, audio: acrossfade } },
    });
    process.exitCode = ffmpeg.available && ffprobe.available ? 0 : 1;
    return;
  }

  if (command === "probe") {
    const input = resolvePlanPath(flags.input, process.cwd(), "input");
    const raw = probeMedia(input);
    printJson({ input, ...probeSummary(raw), streams: raw.streams ?? [] });
    return;
  }

  if (command === "frames") {
    const input = resolvePlanPath(flags.input, process.cwd(), "input");
    const outputDir = resolvePlanPath(flags.output, process.cwd(), "output");
    const times = parseFrameTimes(flags.at);
    const built = buildFrameCommands(
      input,
      outputDir,
      times,
      probeMedia(input),
      flags.overwrite === true,
    );
    if (flags["dry-run"]) {
      printJson({ ok: true, dryRun: true, ...built });
      return;
    }
    mkdirSync(outputDir, { recursive: true });
    assertOutputDirectory(outputDir);
    for (const frame of built.commands) {
      assertSafeOutputPath(input, frame.output, flags.overwrite === true, "frame output");
      const result = spawnSync(frame.command, frame.args, { encoding: "utf-8" });
      if (result.error) fail(`ffmpeg failed to start: ${result.error.message}`);
      if (result.status !== 0) {
        fail(result.stderr.trim() || `ffmpeg exited ${result.status}`);
      }
    }
    printJson({
      ok: true,
      input,
      frames: built.commands.map(({ output, time }) => ({ output, time })),
    });
    return;
  }

  if (command === "render") {
    const planFile = resolvePlanPath(flags.plan, process.cwd(), "plan");
    const planInfo = regularFileInfo(planFile, "plan");
    if (planInfo.size > MAX_PLAN_BYTES) {
      fail(`plan exceeds ${MAX_PLAN_BYTES} bytes`);
    }
    const rawPlan = JSON.parse(readFileSync(planFile, "utf-8"));
    const plan = normalizePlan(rawPlan, dirname(planFile));
    const probe = probeMedia(plan.input);
    const inputSummary = probeSummary(probe);
    if (plan.subtitles && !ffmpegFilterAvailable("subtitles").available) {
      fail(
        "this FFmpeg build does not provide the subtitles filter; install an FFmpeg build with libass support or remove subtitles from the plan",
      );
    }
    if (plan.video.transition.type === "fade") {
      if (!ffmpegFilterAvailable("xfade").available) {
        fail(
          "this FFmpeg build does not provide the xfade filter; use cut transitions or install a full FFmpeg build",
        );
      }
      if (
        inputSummary.hasAudio &&
        !plan.audio.mute &&
        !ffmpegFilterAvailable("acrossfade").available
      ) {
        fail(
          "this FFmpeg build does not provide the acrossfade filter; mute audio, use cut transitions, or install a full FFmpeg build",
        );
      }
    }
    const built = buildRenderCommand(plan, probe);
    if (flags["dry-run"]) {
      printJson({
        ok: true,
        dryRun: true,
        plan,
        input: built.summary,
        command: built.command,
        args: built.args,
      });
      return;
    }
    mkdirSync(dirname(plan.output), { recursive: true });
    assertSafeOutputPath(plan.input, plan.output, plan.overwrite, "output");
    const result = spawnSync(built.command, built.args, { stdio: "inherit" });
    if (result.error) fail(`ffmpeg failed to start: ${result.error.message}`);
    if (result.status !== 0) fail(`ffmpeg exited ${result.status}`);
    const outputProbe = probeMedia(plan.output);
    printJson({
      ok: true,
      output: plan.output,
      media: validateRenderedOutput(plan.input, plan.output, outputProbe),
    });
    return;
  }

  fail(
    "usage: video-editor.mjs check | probe --input FILE | frames --input FILE --output DIR --at TIMES [--dry-run] [--overwrite] | render --plan FILE [--dry-run]",
  );
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  }
}
