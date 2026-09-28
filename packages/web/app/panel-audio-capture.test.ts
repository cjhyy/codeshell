import { expect, test } from "bun:test";
import { createPanelAudioCapture, type PanelAudioSnapshot } from "./panel-audio-capture.js";

function fixture(options: { pending?: boolean; maxBytes?: number } = {}) {
  const abort = new AbortController();
  const snapshots: PanelAudioSnapshot[] = [];
  let requested = 0,
    released = 0,
    resolveStream!: (stream: MediaStream) => void;
  const stream = { getTracks: () => [{ stop: () => released++ }] } as unknown as MediaStream;
  const recorder = {
    state: "inactive",
    mimeType: "audio/webm;codecs=opus",
    ondataavailable: null as ((event: { data: Blob }) => void) | null,
    onstop: null as (() => void) | null,
    onerror: null as (() => void) | null,
    start() {
      this.state = "recording";
    },
    stop() {
      this.state = "inactive";
      queueMicrotask(() => this.onstop?.());
    },
    data(value: string) {
      this.ondataavailable?.({ data: new Blob([value]) });
    },
  };
  const capture = createPanelAudioCapture({
    signal: abort.signal,
    maxDurationSeconds: 60,
    maxBytes: options.maxBytes || 1024,
    onChange: (value) => snapshots.push(value),
    getStream: async () => {
      requested++;
      return options.pending
        ? new Promise((resolve) => {
            resolveStream = resolve;
          })
        : stream;
    },
    makeRecorder: () => recorder as unknown as MediaRecorder,
  });
  return {
    capture,
    abort,
    recorder,
    snapshots,
    release: () => resolveStream(stream),
    requested: () => requested,
    released: () => released,
  };
}

test("constructing a capture does not request a microphone; explicit start then stop retains audio for review", async () => {
  const f = fixture();
  expect(f.requested()).toBe(0);
  await f.capture.start();
  expect(f.requested()).toBe(1);
  expect(f.capture.snapshot().phase).toBe("recording");
  f.recorder.data("recorded audio");
  f.capture.stop();
  await Promise.resolve();
  expect(f.released()).toBe(1);
  expect(f.capture.snapshot().phase).toBe("review");
  expect(await f.capture.snapshot().blob?.text()).toBe("recorded audio");
  expect(f.capture.snapshot().blob?.type).toBe("audio/webm");
  f.capture.close();
  expect(f.capture.snapshot().blob).toBeUndefined();
});

test("revocation while the browser permission prompt is pending releases a late microphone without recording", async () => {
  const f = fixture({ pending: true });
  const starting = f.capture.start();
  f.abort.abort();
  f.release();
  await starting;
  expect(f.released()).toBe(1);
  expect(f.recorder.state).toBe("inactive");
  expect(f.capture.snapshot().phase).toBe("closed");
  expect(f.snapshots.some((item) => item.phase === "recording")).toBe(false);
});

test("revocation during recording stops tracks and ignores buffered late events", async () => {
  const f = fixture();
  await f.capture.start();
  const late = f.recorder.ondataavailable!;
  f.abort.abort();
  late({ data: new Blob(["late bytes"]) });
  await Promise.resolve();
  expect(f.released()).toBe(1);
  expect(f.capture.snapshot().blob).toBeUndefined();
  expect(f.capture.snapshot().phase).toBe("closed");
});

test("oversized audio is stopped and retained as an explicit error backup, never a ready upload", async () => {
  const f = fixture({ maxBytes: 4 });
  await f.capture.start();
  f.recorder.data("oversized");
  await Promise.resolve();
  expect(f.released()).toBe(1);
  expect(f.capture.snapshot().phase).toBe("error");
  expect(f.capture.snapshot().message).toContain("下载备份");
  expect(await f.capture.snapshot().blob?.text()).toBe("oversized");
  f.capture.close();
});

test("an already revoked capture never requests device access", async () => {
  let requested = false;
  const capture = createPanelAudioCapture({
    signal: AbortSignal.abort(),
    maxDurationSeconds: 5,
    maxBytes: 1024,
    onChange() {},
    getStream: async () => {
      requested = true;
      throw new Error("unexpected");
    },
  });
  expect(capture.snapshot().phase).toBe("closed");
  await expect(capture.start()).rejects.toThrow("授权已结束");
  expect(requested).toBe(false);
});
