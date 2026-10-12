// Test-only argv for the frozen Video Studio WAV -> default 320x180 MP4 smoke.
// Panel 3f80db2c and 75431542 have the same Video subtree 743ec92448a09f9e9a80c80beef5cd3018b3b7ee.
// This is intentionally narrower than the Panel's general media feature set.
// The caller separately pins the native binary, reviewed entry and container cwd.
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const HASH = "[a-f0-9]{64}";
const uuid = new RegExp(`^${UUID}$`);
const hash = new RegExp(`^${HASH}$`);
const deny = () => {
  throw new Error("Docker candidate Video path custody refused");
};
const owned = (info) => !process.getuid || info.uid === process.getuid();
const stat = (path) => {
  try {
    return lstatSync(path);
  } catch {
    deny();
  }
};
const canonical = (path) => {
  try {
    return realpathSync(path);
  } catch {
    deny();
  }
};
const inputSafety = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm,avi,mp3,wav,aiff,flac,ogg,aac",
];
const inspectSafety = [
  ...inputSafety.slice(0, 3),
  "mov,matroska,webm,avi,mp3,wav,aiff,flac,ogg,aac,mpeg,mpegts,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif,apng,j2k_pipe",
];
const legacySafety = [
  ...inputSafety.slice(0, 3),
  "mov,matroska,webm,avi,mp3,wav,aiff,flac,ogg,aac,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif,j2k_pipe",
];
const pathToken = (...kinds) => ({ kinds });
const source = pathToken("job-input", "resource");
const audio = pathToken("mix");
const rendered = pathToken("render");
const duration = (value) =>
  /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0 && Number(value) <= 3600;
const audioEnd = (value) => {
  const match = /^apad,atrim=end_sample=([1-9]\d{0,8})$/.exec(value);
  return !!match && +match[1] <= 3600 * 48000;
};

function pathKind(path, cwd, dataRoot) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) return;
  const job = relative(cwd, path).split("/");
  if (job.length === 2 && job[0] === "inputs" && job[1] === "resource-0.bin") return "job-input";
  if (job.length >= 2 && new RegExp(`^work-${UUID}$`).test(job[0])) {
    if (job.length === 2) {
      if (new RegExp(`^mix\\.wav\\.${UUID}\\.tmp$`).test(job[1])) return "wav-output";
      if (new RegExp(`^\\.render-${UUID}\\.mp4$`).test(job[1])) return "render";
      if (/^editor-browser-[A-Za-z0-9]{6}$/.test(job[1])) return "browser";
    }
    if (job.length === 3 && /^editor-audio-[A-Za-z0-9]{6}$/.test(job[1])) {
      if (new RegExp(`^${UUID}\\.f32$`).test(job[2])) return "pcm-output";
      if (job[2] === "mix.f32") return "pcm-input";
    }
  }
  const runtime = relative(join(dataRoot, "panel-data/video-studio"), path).split("/");
  if (
    !/^[a-f0-9]{24}$/.test(runtime[0]) ||
    runtime[1] !== "runtime" ||
    runtime[2] !== "editor-v2" ||
    runtime[3] !== "scopes" ||
    !hash.test(runtime[4])
  )
    return;
  if (
    runtime.length === 9 &&
    runtime[5] === "transfers" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runtime[6]) &&
    runtime[7] === "resources" &&
    new RegExp(`^asset-${HASH}\\.bin$`).test(runtime[8])
  )
    return "resource";
  if (
    runtime.length === 9 &&
    runtime[5] === "cache" &&
    runtime[6] === "mixes" &&
    hash.test(runtime[7]) &&
    runtime[8] === "audio.wav"
  )
    return "mix";
}

function verifyPath(path, kind, dataRoot, output) {
  // Every parent must still be an owned ordinary directory at its canonical path.
  const parts = relative(dataRoot, dirname(path)).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) deny();
  let parent = dataRoot;
  for (const part of parts) {
    parent = join(parent, part);
    const info = stat(parent);
    if (!info.isDirectory() || !owned(info) || info.mode & 0o077 || canonical(parent) !== parent)
      deny();
  }
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (output && error.code === "ENOENT") return;
    deny();
  }
  if (output || !owned(info) || canonical(path) !== path) deny();
  if (kind === "browser") {
    if (!info.isDirectory() || info.mode & 0o077) deny();
  } else if (!info.isFile() || info.nlink !== 1) deny();
}

/** Return false for unsupported operations; never execute a binary or parse media. */
export function validateCandidateVideoArguments(name, args, cwd) {
  if (
    !["ffmpeg", "ffprobe", "chromium"].includes(name) ||
    !Array.isArray(args) ||
    args.length > 96 ||
    args.some((arg) => typeof arg !== "string" || arg.length > 8192 || /[\0\r\n]/.test(arg))
  )
    return false;
  const patterns =
    name === "ffprobe"
      ? [
          ["-v", "error", ...inspectSafety, "-show_streams", "-show_format", "-of", "json", source],
          [
            "-v",
            "error",
            ...inspectSafety,
            "-show_frames",
            "-show_entries",
            "frame=stream_index,pts,best_effort_timestamp,duration,pkt_duration,nb_samples",
            "-of",
            "compact=p=0:nk=0",
            source,
          ],
          ["-v", "error", "-show_format", "-show_streams", "-of", "json", ...legacySafety, source],
          [
            "-v",
            "error",
            ...inputSafety,
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_type,sample_rate,channels",
            "-of",
            "json",
            source,
          ],
          [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            pathToken("mix", "render"),
          ],
        ]
      : name === "ffmpeg"
        ? [
            ["-hide_banner", "-version"],
            ["-hide_banner", "-filters"],
            ["-hide_banner", "-encoders"],
            [
              "-nostdin",
              "-v",
              "error",
              ...inputSafety,
              "-copyts",
              "-start_at_zero",
              "-i",
              source,
              "-map",
              "0:a:0",
              "-vn",
              "-sn",
              "-dn",
              "-af",
              "aresample=48000:async=1:first_pts=0",
              "-t",
              duration,
              "-ac",
              "2",
              "-ar",
              "48000",
              "-c:a",
              "pcm_f32le",
              "-f",
              "f32le",
              "-y",
              pathToken("pcm-output"),
            ],
            [
              "-nostdin",
              "-v",
              "error",
              "-f",
              "f32le",
              "-ar",
              "48000",
              "-ac",
              "2",
              "-i",
              pathToken("pcm-input"),
              "-c:a",
              "pcm_f32le",
              "-rf64",
              "auto",
              "-f",
              "wav",
              "-y",
              pathToken("wav-output"),
            ],
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-nostdin",
              "-n",
              "-f",
              "image2pipe",
              "-vcodec",
              "png",
              "-framerate",
              "30/1",
              "-i",
              "pipe:0",
              "-i",
              audio,
              "-map",
              "0:v:0",
              "-map",
              "1:a:0",
              "-vf",
              "scale=out_color_matrix=bt709:out_range=limited,format=yuv420p,setparams=colorspace=bt709:range=limited",
              "-af",
              audioEnd,
              "-c:v",
              "libx264",
              "-pix_fmt",
              "yuv420p",
              "-s:v",
              "320x180",
              "-r",
              "30/1",
              "-fps_mode",
              "cfr",
              "-preset",
              "medium",
              "-crf",
              "19",
              "-c:a",
              "aac",
              "-ar",
              "48000",
              "-ac",
              "2",
              "-b:a",
              "192000",
              "-movflags",
              "+faststart",
              "-f",
              "mp4",
              "-color_primaries",
              "bt709",
              "-color_trc",
              "iec61966-2-1",
              "-colorspace",
              "bt709",
              "-color_range",
              "tv",
              rendered,
            ],
          ]
        : [
            [
              "--headless=new",
              "--remote-debugging-pipe",
              "--no-first-run",
              "--no-default-browser-check",
              "--disable-background-networking",
              "--disable-component-update",
              "--disable-sync",
              "--disable-extensions",
              { profile: true },
              "about:blank",
            ],
          ];
  const pattern = patterns.find(
    (value) =>
      value.length === args.length &&
      value.every((token, i) =>
        typeof token === "string"
          ? token === args[i]
          : typeof token === "function"
            ? token(args[i])
            : token.profile
              ? args[i].startsWith("--user-data-dir=")
              : isAbsolute(args[i]),
      ),
  );
  if (!pattern) return false;
  // The Host's fixed job directory provides the data-root relationship; the
  // surrounding runtime guard independently restricts it to the owned container.
  if (
    typeof cwd !== "string" ||
    !isAbsolute(cwd) ||
    resolve(cwd) !== cwd ||
    basename(cwd) !== "work" ||
    !uuid.test(basename(dirname(cwd))) ||
    basename(dirname(dirname(cwd))) !== "panel-tool-jobs"
  )
    deny();
  const info = stat(cwd);
  if (!info.isDirectory() || !owned(info) || info.mode & 0o077 || canonical(cwd) !== cwd) deny();
  const dataRoot = dirname(dirname(dirname(cwd)));
  for (let i = 0; i < pattern.length; i++) {
    const token = pattern[i];
    if (typeof token !== "object") continue;
    const path = token.profile ? args[i].slice("--user-data-dir=".length) : args[i];
    const kind = pathKind(path, cwd, dataRoot);
    if (token.profile ? kind !== "browser" : !token.kinds.includes(kind)) return false;
    const output =
      kind === "pcm-output" || kind === "wav-output" || (name === "ffmpeg" && kind === "render");
    verifyPath(path, kind, dataRoot, output);
  }
  return true;
}
