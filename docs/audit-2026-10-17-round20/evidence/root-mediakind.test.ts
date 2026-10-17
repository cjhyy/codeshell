import { afterAll, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (() => {
  fetchCalls += 1;
  throw new Error("No network in mediaKind leaf audit");
}) as typeof fetch;
const { mediaKind } = await import("/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/chat/src/media.ts");
afterAll(() => {
  globalThis.fetch = originalFetch;
  expect(fetchCalls).toBe(0);
});

test("ordinary MIME values normalize case, surrounding spaces and parameters", () => {
  expect(mediaKind("  IMAGE/PNG ; charset=binary  ", "owned.bin")).toBe("image");
  expect(mediaKind("Audio/OGG; codecs=opus", "owned.bin")).toBe("audio");
  expect(mediaKind(" VIDEO/MP4 ", "owned.bin")).toBe("video");
});

test("missing MIME classifies ordinary uppercase filename extensions", () => {
  expect(mediaKind(undefined, "PHOTO.JPG")).toBe("image");
  expect(mediaKind(undefined, "PHOTO.TIFF")).toBe("image");
  expect(mediaKind(undefined, "VOICE.OPUS")).toBe("audio");
  expect(mediaKind(undefined, "CLIP.MOV")).toBe("video");
});

test("ordinary Unicode and spaced names preserve their ASCII extension meaning", () => {
  expect(mediaKind(undefined, "工作照片 final.png")).toBe("image");
  expect(mediaKind(undefined, "语音 note.flac")).toBe("audio");
  expect(mediaKind(undefined, "演示 🙂.webm")).toBe("video");
});

test("no MIME or known filename suffix produces the generic file fallback", () => {
  expect(mediaKind()).toBe("file");
  expect(mediaKind(undefined, "README")).toBe("file");
  expect(mediaKind("application/pdf", "report.pdf")).toBe("file");
  expect(mediaKind("text/plain", "notes.txt")).toBe("file");
});

test("empty MIME uses the same normal filename fallback", () => {
  expect(mediaKind("", "drawing.webp")).toBe("image");
  expect(mediaKind(" ", "voice.m4a")).toBe("audio");
});

test("the final suffix controls ordinary names with multiple dots", () => {
  expect(mediaKind(undefined, "meeting.notes.mp3")).toBe("audio");
  expect(mediaKind(undefined, "photo.png.txt")).toBe("file");
});

test("ordinary MIME-only inputs do not require a filename", () => {
  expect(mediaKind("image/jpeg")).toBe("image");
  expect(mediaKind("audio/wav")).toBe("audio");
  expect(mediaKind("video/webm")).toBe("video");
});
