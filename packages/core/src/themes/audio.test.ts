import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectThemeWav, MAX_THEME_MUSIC_BYTES, MAX_THEME_SOUND_BYTES } from "./audio.js";
import { installReviewedLocalTheme, listInstalledThemes, previewLocalTheme } from "./installer.js";
import { parseThemeManifest } from "./manifest.js";
import { THEME_ASSET_DIR, ThemeReviewChangedError, themeInstallDir } from "./paths.js";

function wav(frames = 80, sampleRate = 8_000, channels = 1): Buffer {
  const bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

describe("theme PCM16 WAV validation", () => {
  test.each([1, 2])("accepts complete mono/stereo PCM16 with %d channels", (channels) => {
    expect(detectThemeWav(wav(800, 8_000, channels))).toEqual({
      mediaType: "audio/wav",
      channels,
      sampleRate: 8_000,
      durationSeconds: 0.1,
    });
  });

  test.each([
    [20, 3, "float encoding"],
    [22, 3, "unsupported channels"],
    [24, 7_999, "low sample rate"],
    [24, 96_001, "high sample rate"],
    [28, 123, "incorrect byte rate"],
    [32, 4, "incorrect block alignment"],
    [34, 8, "non-16-bit samples"],
  ] as const)("rejects malformed format %d / %d (%s)", (offset, value) => {
    const bytes = wav();
    if (offset === 24 || offset === 28) bytes.writeUInt32LE(value, offset);
    else bytes.writeUInt16LE(value, offset);
    expect(detectThemeWav(bytes)).toBeNull();
  });

  test("rejects truncation, RIFF mismatch, partial samples and overflowing chunks", () => {
    const valid = wav();
    expect(detectThemeWav(valid.subarray(0, -1))).toBeNull();
    expect(detectThemeWav(Buffer.concat([valid, Buffer.from([0])]))).toBeNull();
    const overflow = Buffer.from(valid);
    overflow.writeUInt32LE(0xffff_ffff, 40);
    expect(detectThemeWav(overflow)).toBeNull();
    const partial = Buffer.from(valid);
    partial.writeUInt32LE(partial.length - 45, 40);
    expect(detectThemeWav(partial)).toBeNull();
    expect(detectThemeWav(wav(0))).toBeNull();
    const highBitSignature = Buffer.from(valid);
    highBitSignature[0] |= 0x80;
    expect(detectThemeWav(highBitSignature)).toBeNull();
  });

  test("validates unknown chunk padding and rejects duplicate format/data chunks", () => {
    const valid = wav();
    const junk = Buffer.from([0x4a, 0x55, 0x4e, 0x4b, 1, 0, 0, 0, 42, 0]);
    const padded = Buffer.concat([valid.subarray(0, 12), junk, valid.subarray(12)]);
    padded.writeUInt32LE(padded.length - 8, 4);
    expect(detectThemeWav(padded)?.durationSeconds).toBe(0.01);
    const missingPad = Buffer.concat([valid.subarray(0, 12), junk.subarray(0, -1)]);
    missingPad.writeUInt32LE(missingPad.length - 8, 4);
    expect(detectThemeWav(missingPad)).toBeNull();
    for (const chunk of [valid.subarray(12, 36), valid.subarray(36)]) {
      const duplicate = Buffer.concat([valid, chunk]);
      duplicate.writeUInt32LE(duplicate.length - 8, 4);
      expect(detectThemeWav(duplicate)).toBeNull();
    }
  });
});

const BASE = { schemaVersion: 1, id: "audio-theme", name: "Audio Theme", version: "1" };

describe("theme audio manifest", () => {
  test.each([
    { title: "Track" },
    { title: "Track", file: "track.wav", url: "https://example.com/listen" },
    { title: "Track", file: "../outside.wav" },
    { title: "Track", url: "http://example.com/listen" },
    { title: "Track", url: "https://user:secret@example.com/listen" },
    { title: "Track", url: "file:///tmp/song.wav" },
    { title: "Track", url: "javascript:alert(1)" },
    { title: "Track", url: "invalid" },
    { title: " ", file: "track.wav" },
    { title: "a".repeat(121), file: "track.wav" },
    { title: "Track", artist: "a".repeat(121), file: "track.wav" },
  ])("rejects invalid track %j", (track) => {
    expect(() => parseThemeManifest({ ...BASE, music: [track] })).toThrow();
  });

  test("bounds the playlist and permits only known sound events and safe paths", () => {
    const track = { title: "Track", url: "https://example.com/listen" };
    expect(parseThemeManifest({ ...BASE, music: Array(12).fill(track) }).music).toHaveLength(12);
    expect(() => parseThemeManifest({ ...BASE, music: Array(13).fill(track) })).toThrow();
    expect(() => parseThemeManifest({ ...BASE, sounds: { unknown: "cue.wav" } })).toThrow();
    expect(() => parseThemeManifest({ ...BASE, sounds: { send: "../cue.wav" } })).toThrow();
  });
});

describe("theme audio installer", () => {
  let home: string;
  let source: string;
  let previousHome: string | undefined;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cs-audio-home-"));
    source = await mkdtemp(join(tmpdir(), "cs-audio-source-"));
    previousHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
  });
  afterEach(async () => {
    if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });

  async function pack(extra: Record<string, unknown>) {
    await writeFile(join(source, ".cs-theme.json"), JSON.stringify({ ...BASE, ...extra }));
    await writeFile(join(source, "cue.wav"), wav());
  }

  test("roundtrips canonical sounds/local music and retains HTTPS links", async () => {
    const sounds = { send: "cue.wav", complete: "cue.wav", approval: "cue.wav", error: "cue.wav" };
    const link = {
      title: "Official listening",
      artist: "Artist",
      url: "https://example.com/listen",
    };
    await pack({ sounds, music: [link, { title: "Local track", file: "cue.wav" }] });
    const preview = await previewLocalTheme(source);
    expect(preview.soundEvents).toEqual(["send", "complete", "approval", "error"]);
    expect(preview.musicCount).toBe(2);
    expect(preview.warnings).toEqual([]);
    const installed = await installReviewedLocalTheme(source, preview.reviewToken);
    expect(installed.sounds).toEqual(
      Object.fromEntries(
        Object.keys(sounds).map((event) => [event, `${THEME_ASSET_DIR}/sound-${event}.wav`]),
      ),
    );
    expect(installed.music).toEqual([
      link,
      { title: "Local track", file: `${THEME_ASSET_DIR}/music-2.wav` },
    ]);
    expect(await readFile(join(themeInstallDir(installed.id), installed.music![1].file!))).toEqual(
      wav(),
    );
    expect(await listInstalledThemes()).toEqual([installed]);
  });

  test.each(["sounds", "music"])("binds %s file bytes to the review token", async (field) => {
    await pack(
      field === "sounds"
        ? { sounds: { send: "cue.wav" } }
        : { music: [{ title: "Track", file: "cue.wav" }] },
    );
    const preview = await previewLocalTheme(source);
    const changed = wav();
    changed.writeInt16LE(1, 44);
    await writeFile(join(source, "cue.wav"), changed);
    await expect(installReviewedLocalTheme(source, preview.reviewToken)).rejects.toBeInstanceOf(
      ThemeReviewChangedError,
    );
    expect(await listInstalledThemes()).toEqual([]);
  });

  test("binds external listening links to the review token without fetching them", async () => {
    await pack({ music: [{ title: "Track", url: "https://example.com/first" }] });
    const preview = await previewLocalTheme(source);
    await pack({ music: [{ title: "Track", url: "https://example.com/changed" }] });
    await expect(installReviewedLocalTheme(source, preview.reviewToken)).rejects.toBeInstanceOf(
      ThemeReviewChangedError,
    );
  });

  test.each([false, true])("rejects excessive audio duration (music: %s)", async (music) => {
    await pack(
      music ? { music: [{ title: "Track", file: "cue.wav" }] } : { sounds: { send: "cue.wav" } },
    );
    await writeFile(join(source, "cue.wav"), wav((music ? 600 : 10) * 8_000 + 1));
    await expect(previewLocalTheme(source)).rejects.toThrow(/audio duration exceeds/);
  });

  test.each([false, true])("rejects excessive audio byte size (music: %s)", async (music) => {
    await pack(
      music ? { music: [{ title: "Track", file: "cue.wav" }] } : { sounds: { send: "cue.wav" } },
    );
    await truncate(
      join(source, "cue.wav"),
      (music ? MAX_THEME_MUSIC_BYTES : MAX_THEME_SOUND_BYTES) + 1,
    );
    await expect(previewLocalTheme(source)).rejects.toThrow(/asset too large/);
  });

  test("rejects invalid WAV bytes and a symlink to valid audio outside the source", async () => {
    await pack({ sounds: { send: "cue.wav" } });
    await writeFile(join(source, "cue.wav"), "RIFF is not enough");
    await expect(previewLocalTheme(source)).rejects.toThrow(/not a supported PCM16 WAV/);
    await writeFile(join(home, "outside.wav"), wav());
    await rm(join(source, "cue.wav"));
    await symlink(join(home, "outside.wav"), join(source, "cue.wav"));
    await expect(previewLocalTheme(source)).rejects.toThrow(/escapes theme root via symlink/);
  });

  test("rejects special audio files without blocking on a FIFO", async () => {
    if (process.platform === "win32") return;
    await pack({ sounds: { send: "cue.wav" } });
    await rm(join(source, "cue.wav"));
    expect(spawnSync("mkfifo", [join(source, "cue.wav")]).status).toBe(0);
    await expect(previewLocalTheme(source)).rejects.toThrow(/asset is not a file/);
  });
});
