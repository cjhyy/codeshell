// Test-only argv for recorded WebM preparation and WAV -> default 320x180 MP4.
// Panel 3f80db2c and 75431542 have the same Video subtree 743ec92448a09f9e9a80c80beef5cd3018b3b7ee.
// Recorded audio uses the exact media-processors consumers in Panel 6036db38.
// This is intentionally narrower than the Panel's general media feature set.
// The caller separately pins the native binary, reviewed entry and container cwd.
import {
  lstatSync,
  realpathSync,
  opendirSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
} from "node:fs";
import { createHash } from "node:crypto";
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
const recordedSource = pathToken("recorded-input");
const legacySource = pathToken("job-input", "resource", "recorded-input");
const thumbnail = pathToken("recorded-thumbnail");
const proxy = pathToken("recorded-proxy");
const encodePrefix = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats"];
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
  if (job.length === 2 && job[0] === "inputs" && job[1] === "source-0.bin") return "recorded-input";
  if (job.length === 2 && job[0] === "outputs") {
    if (new RegExp(`^thumbnail-${UUID}\\.png$`).test(job[1])) return "recorded-thumbnail";
    if (new RegExp(`^proxy-${UUID}\\.m4a$`).test(job[1])) return "recorded-proxy";
  }
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

function verifyParents(path, dataRoot) {
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
}

function verifyResourceAliases(path, info, dataRoot) {
  // Only the content-addressed original may share immutable storage across
  // snapshots. Account for every link inside this exact scope before reading it.
  if (
    !Number.isSafeInteger(info.nlink) ||
    info.nlink < 2 ||
    info.nlink > 64 ||
    info.size > 64 * 1024 * 1024
  )
    deny();
  const scope = dirname(dirname(dirname(dirname(path))));
  const name = basename(path);
  const aliases = new Set();
  const inspectAlias = (candidate) => {
    let alias;
    try {
      alias = lstatSync(candidate);
    } catch (error) {
      if (error.code === "ENOENT") return;
      deny();
    }
    if (alias.dev !== info.dev || alias.ino !== info.ino) return;
    verifyParents(candidate, dataRoot);
    if (
      !alias.isFile() ||
      !owned(alias) ||
      canonical(candidate) !== candidate ||
      alias.nlink !== info.nlink
    )
      deny();
    aliases.add(candidate);
  };
  inspectAlias(join(scope, "resources", name));
  const transfers = join(scope, "transfers");
  const directory = opendirSync(transfers);
  try {
    let count = 0,
      entry;
    while ((entry = directory.readSync())) {
      if (++count > 64) deny();
      if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.name)) continue;
      inspectAlias(join(transfers, entry.name, "resources", name));
    }
  } finally {
    directory.closeSync();
  }
  if (!aliases.has(path) || aliases.size !== info.nlink) deny();
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const unchanged = () => {
      const final = fstatSync(descriptor);
      if (
        !final.isFile() ||
        !owned(final) ||
        final.dev !== info.dev ||
        final.ino !== info.ino ||
        final.nlink !== info.nlink ||
        final.size !== info.size ||
        final.mtimeMs !== info.mtimeMs ||
        final.ctimeMs !== info.ctimeMs
      )
        deny();
    };
    unchanged();
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let bytes = 0;
    while (bytes <= info.size) {
      const length = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, info.size - bytes + 1),
        bytes,
      );
      if (!length) break;
      bytes += length;
      if (bytes > info.size) deny();
      hash.update(buffer.subarray(0, length));
    }
    unchanged();
    if (bytes !== info.size || `asset-${hash.digest("hex")}.bin` !== name) deny();
    for (const candidate of aliases) {
      verifyParents(candidate, dataRoot);
      const final = stat(candidate);
      if (
        !final.isFile() ||
        !owned(final) ||
        canonical(candidate) !== candidate ||
        final.dev !== info.dev ||
        final.ino !== info.ino ||
        final.nlink !== info.nlink ||
        final.size !== info.size ||
        final.mtimeMs !== info.mtimeMs ||
        final.ctimeMs !== info.ctimeMs
      )
        deny();
    }
  } finally {
    closeSync(descriptor);
  }
}

function verifyPath(path, kind, dataRoot, output) {
  verifyParents(path, dataRoot);
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
  } else {
    if (!info.isFile()) deny();
    if (info.nlink !== 1) {
      if (kind !== "resource") deny();
      verifyResourceAliases(path, info, dataRoot);
    }
  }
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
          [
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            ...legacySafety,
            legacySource,
          ],
          [
            "-v",
            "error",
            "-show_entries",
            "packet=stream_index,pts_time,dts_time,duration_time",
            "-of",
            "compact=p=0:nk=0",
            ...legacySafety,
            recordedSource,
          ],
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
              ...encodePrefix,
              ...legacySafety,
              "-i",
              recordedSource,
              "-filter_complex",
              "showwavespic=s=480x160:colors=0x8fd6ad",
              "-frames:v",
              "1",
              thumbnail,
            ],
            [
              ...encodePrefix,
              ...legacySafety,
              "-i",
              recordedSource,
              "-vn",
              "-map",
              "0:a:0?",
              "-c:a",
              "aac",
              "-b:a",
              "128k",
              "-movflags",
              "+faststart",
              "-t",
              (value) => duration(value) && Number(value) <= 600,
              proxy,
            ],
            [
              "-hide_banner",
              "-nostdin",
              "-v",
              "error",
              "-progress",
              "pipe:2",
              ...legacySafety,
              "-i",
              recordedSource,
              "-vn",
              "-ac",
              "1",
              "-ar",
              "8000",
              "-f",
              "f32le",
              "pipe:1",
            ],
            [
              "-hide_banner",
              "-nostdin",
              "-progress",
              "pipe:1",
              ...legacySafety,
              "-i",
              recordedSource,
              "-vn",
              "-af",
              "silencedetect=noise=-35dB:d=0.45",
              "-f",
              "null",
              "-",
            ],
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
  if (typeof cwd !== "string" || !isAbsolute(cwd) || resolve(cwd) !== cwd) deny();
  // Only the two fixed legacy encoders use the nested job work directory.
  const nestedWork = pattern.includes(thumbnail) || pattern.includes(proxy);
  const jobRoot = nestedWork ? dirname(cwd) : cwd;
  // The Host's fixed job directory provides the data-root relationship; the
  // surrounding runtime guard independently restricts it to the owned container.
  if (
    basename(cwd) !== "work" ||
    basename(jobRoot) !== "work" ||
    !uuid.test(basename(dirname(jobRoot))) ||
    basename(dirname(dirname(jobRoot))) !== "panel-tool-jobs"
  )
    deny();
  const info = stat(cwd);
  if (!info.isDirectory() || !owned(info) || info.mode & 0o077 || canonical(cwd) !== cwd) deny();
  const dataRoot = dirname(dirname(dirname(jobRoot)));
  for (let i = 0; i < pattern.length; i++) {
    const token = pattern[i];
    if (typeof token !== "object") continue;
    const path = token.profile ? args[i].slice("--user-data-dir=".length) : args[i];
    const kind = pathKind(path, jobRoot, dataRoot);
    if (token.profile ? kind !== "browser" : !token.kinds.includes(kind)) return false;
    const output =
      kind === "pcm-output" ||
      kind === "wav-output" ||
      kind === "recorded-thumbnail" ||
      kind === "recorded-proxy" ||
      (name === "ffmpeg" && kind === "render");
    verifyPath(path, kind, dataRoot, output);
  }
  return true;
}
