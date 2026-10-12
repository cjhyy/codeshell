import { expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateCandidateVideoArguments as validate } from "../scripts/docker-candidate-video-argv.mjs";

// Literal native calls from the committed Panel, not execution of its processors.
// Frozen 3f80db2c and 75431542 have identical Video Studio package bytes.
// editor-runtime blob b9a4a9bfee900654de1fb0c9609960b532c47f86;
// media-runtime blob d8772ce8045011eca637af08e074c3d539dc9fa0.
const UUID = "1f533283-e3b9-49f5-957b-cdb7b90c3948";
const HASH = "a".repeat(64);
const safety = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm,avi,mp3,wav,aiff,flac,ogg,aac",
];
const inspect = [
  ...safety.slice(0, 3),
  "mov,matroska,webm,avi,mp3,wav,aiff,flac,ogg,aac,mpeg,mpegts,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif,apng,j2k_pipe",
];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "candidate-video-argv-")));
  const data = join(root, "data"),
    cwd = join(data, "panel-tool-jobs", UUID, "work");
  const work = join(cwd, `work-${UUID}`);
  const runtime = join(
    data,
    "panel-data/video-studio",
    "b".repeat(24),
    "runtime/editor-v2/scopes",
    HASH,
  );
  const input = join(cwd, "inputs/resource-0.bin");
  const resource = join(runtime, "transfers/transfer-1/resources", `asset-${HASH}.bin`);
  const audio = join(runtime, "cache/mixes", HASH, "audio.wav");
  const pcmDir = join(work, "editor-audio-aB0123");
  const pcm = join(pcmDir, `${UUID}.f32`),
    raw = join(pcmDir, "mix.f32");
  const wav = join(work, `mix.wav.${UUID}.tmp`),
    render = join(work, `.render-${UUID}.mp4`);
  const browser = join(work, "editor-browser-aB0123");
  for (const path of [cwd, work, pcmDir, browser])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const file = (path: string) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "controlled bytes; never decoded", { mode: 0o600 });
  };
  for (const path of [input, resource, audio, raw]) file(path);
  const sourceProbe = [
    "-v",
    "error",
    ...inspect,
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    input,
  ];
  const frames = [
    "-v",
    "error",
    ...inspect,
    "-show_frames",
    "-show_entries",
    "frame=stream_index,pts,best_effort_timestamp,duration,pkt_duration,nb_samples",
    "-of",
    "compact=p=0:nk=0",
    input,
  ];
  const audioProbe = [
    "-v",
    "error",
    ...safety,
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_type,sample_rate,channels",
    "-of",
    "json",
    resource,
  ];
  const decode = [
    "-nostdin",
    "-v",
    "error",
    ...safety,
    "-copyts",
    "-start_at_zero",
    "-i",
    resource,
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-af",
    "aresample=48000:async=1:first_pts=0",
    "-t",
    "2.0000000000000000",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "pcm_f32le",
    "-f",
    "f32le",
    "-y",
    pcm,
  ];
  const mix = [
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
    raw,
    "-c:a",
    "pcm_f32le",
    "-rf64",
    "auto",
    "-f",
    "wav",
    "-y",
    wav,
  ];
  const encode = [
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
    "apad,atrim=end_sample=48000",
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
    render,
  ];
  const chromium = [
    "--headless=new",
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    `--user-data-dir=${browser}`,
    "about:blank",
  ];
  return {
    root,
    cwd,
    input,
    resource,
    audio,
    pcm,
    raw,
    wav,
    render,
    browser,
    sourceProbe,
    frames,
    audioProbe,
    decode,
    mix,
    encode,
    chromium,
    file,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
function withFixture(run: (value: ReturnType<typeof fixture>) => void) {
  const value = fixture();
  try {
    run(value);
  } finally {
    value.close();
  }
}

test("frozen WAV import uses both actual source metadata and decoded frame probes", () =>
  withFixture((f) => {
    expect(validate("ffprobe", f.sourceProbe, f.cwd)).toBe(true);
    expect(validate("ffprobe", f.frames, f.cwd)).toBe(true);
  }));
test("legacy media metadata probe keeps its own frozen option ordering and format allowlist", () =>
  withFixture((f) => {
    const legacy = [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "mov,matroska,webm,avi,mp3,wav,aiff,flac,ogg,aac,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif,j2k_pipe",
      f.input,
    ];
    expect(validate("ffprobe", legacy, f.cwd)).toBe(true);
    expect(
      validate(
        "ffprobe",
        legacy.map((arg) => (arg === "file,pipe" ? "file,pipe,https" : arg)),
        f.cwd,
      ),
    ).toBe(false);
  }));
test("frozen audio preparation permits stream probe, timestamp preserving PCM and final mix only", () =>
  withFixture((f) => {
    expect(validate("ffprobe", f.audioProbe, f.cwd)).toBe(true);
    expect(validate("ffmpeg", f.decode, f.cwd)).toBe(true);
    expect(validate("ffmpeg", f.mix, f.cwd)).toBe(true);
    for (const flag of ["-version", "-filters", "-encoders"])
      expect(validate("ffmpeg", ["-hide_banner", flag], f.cwd)).toBe(true);
  }));
test("default 320x180 h264/aac MP4 encoding and exact completed output verification are separate", () =>
  withFixture((f) => {
    expect(validate("ffmpeg", f.encode, f.cwd)).toBe(true);
    expect(
      validate(
        "ffprobe",
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", f.audio],
        f.cwd,
      ),
    ).toBe(true);
    f.file(f.render);
    expect(
      validate(
        "ffprobe",
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", f.render],
        f.cwd,
      ),
    ).toBe(true);
    expect(() => validate("ffmpeg", f.encode, f.cwd)).toThrow("custody refused");
  }));
test("frame renderer Chromium uses its exact pipe argv and a private owned editor profile", () =>
  withFixture((f) => {
    expect(validate("chromium", f.chromium, f.cwd)).toBe(true);
    expect(
      validate("chromium", [...f.chromium.slice(0, -1), "https://external.invalid"], f.cwd),
    ).toBe(false);
    expect(validate("chromium", [...f.chromium, "--no-sandbox"], f.cwd)).toBe(false);
    chmodSync(f.browser, 0o755);
    expect(() => validate("chromium", f.chromium, f.cwd)).toThrow("custody refused");
  }));
test("external protocols, extra inputs, option reordering and arbitrary filter programs stay refused", () =>
  withFixture((f) => {
    const replace = (args: string[], from: string, to: string) =>
      args.map((value) => (value === from ? to : value));
    for (const args of [
      replace(f.decode, f.resource, "http://127.0.0.1:18791/source.wav"),
      replace(f.decode, f.resource, "concat:/etc/passwd|/etc/shadow"),
      replace(f.decode, "file,pipe", "file,pipe,http,tcp"),
      replace(f.decode, "aresample=48000:async=1:first_pts=0", "amovie=/etc/passwd"),
      [...f.decode, "-filter_complex_script", "/tmp/filter.txt"],
      replace(f.encode, "apad,atrim=end_sample=48000", "amovie=http://external.invalid/a.wav"),
      replace(f.encode, "pipe:0", "/etc/passwd"),
      replace(f.encode, "320x180", "1920x1080"),
    ])
      expect(validate("ffmpeg", args, f.cwd)).toBe(false);
    const reordered = [...f.sourceProbe];
    [reordered[0], reordered[2]] = [reordered[2], reordered[0]];
    expect(validate("ffprobe", reordered, f.cwd)).toBe(false);
  }));
test("arbitrary file paths, another job, traversal and unexpected outputs cannot obtain admission", () =>
  withFixture((f) => {
    for (const path of [
      "/etc/passwd",
      join(f.root, "other.bin"),
      f.input.replace(UUID, "b".repeat(36)),
      `${f.cwd}/inputs/../inputs/resource-0.bin`,
    ]) {
      expect(validate("ffprobe", [...f.sourceProbe.slice(0, -1), path], f.cwd)).toBe(false);
    }
    expect(
      validate("ffmpeg", [...f.decode.slice(0, -1), join(f.cwd, "overwrite.f32")], f.cwd),
    ).toBe(false);
    expect(() => validate("ffmpeg", ["-hide_banner", "-version"], f.root)).toThrow(
      "custody refused",
    );
  }));
test("source and resource symlinks, hard links and non-private parents are refused before spawn", () =>
  withFixture((f) => {
    const target = join(f.root, "controlled-source.bin");
    f.file(target);
    rmSync(f.input);
    symlinkSync(target, f.input);
    expect(() => validate("ffprobe", f.sourceProbe, f.cwd)).toThrow("custody refused");
    rmSync(f.input);
    linkSync(target, f.input);
    expect(() => validate("ffprobe", f.sourceProbe, f.cwd)).toThrow("custody refused");
    rmSync(f.input);
    f.file(f.input);
    chmodSync(dirname(f.input), 0o755);
    expect(() => validate("ffprobe", f.sourceProbe, f.cwd)).toThrow("custody refused");
  }));
test("a replaced output parent or missing input never becomes a writable file grant", () =>
  withFixture((f) => {
    rmSync(dirname(f.pcm), { recursive: true });
    const outside = join(f.root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, dirname(f.pcm));
    expect(() => validate("ffmpeg", f.decode, f.cwd)).toThrow("custody refused");
    rmSync(f.resource);
    expect(() => validate("ffprobe", f.audioProbe, f.cwd)).toThrow();
  }));
test("a non-private ancestor in the persistent resource path remains rejected", () =>
  withFixture((f) => {
    chmodSync(dirname(dirname(f.resource)), 0o755);
    expect(() => validate("ffprobe", f.audioProbe, f.cwd)).toThrow("custody refused");
  }));
test("bounded duration and trim grammar rejects numeric injection and excess work", () =>
  withFixture((f) => {
    for (const value of ["0", "-1", "Infinity", "3601", "1;movie=/etc/passwd"])
      expect(
        validate(
          "ffmpeg",
          f.decode.map((item) => (item === "2.0000000000000000" ? value : item)),
          f.cwd,
        ),
      ).toBe(false);
    for (const value of [
      "apad,atrim=end_sample=0",
      "apad,atrim=end_sample=172800001",
      "apad,atrim=end_sample=48000,amovie=/etc/passwd",
    ])
      expect(
        validate(
          "ffmpeg",
          f.encode.map((item) => (item === "apad,atrim=end_sample=48000" ? value : item)),
          f.cwd,
        ),
      ).toBe(false);
  }));
test("unknown executables, malformed argv and unrelated native features are not generalized", () =>
  withFixture((f) => {
    expect(validate("bash", f.encode, f.cwd)).toBe(false);
    expect(validate("ffmpeg", ["-i", f.input, "-y", f.render], f.cwd)).toBe(false);
    expect(validate("ffmpeg", ["-hide_banner", "-version", "\0"], f.cwd)).toBe(false);
    expect(validate("ffmpeg", Array(97).fill("-version"), f.cwd)).toBe(false);
  }));
