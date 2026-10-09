import { afterEach, expect, test } from "bun:test";
import { createPanelVideoCapture, panelVideoCapabilities } from "./panel-video-capture.js";

const restores: Array<() => void> = [];
function global(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restores.push(() =>
    previous ? Object.defineProperty(globalThis, name, previous) : delete (globalThis as any)[name],
  );
}
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
class Track {
  onended: (() => void) | null = null;
  stopped = 0;
  constructor(readonly kind: "video" | "audio") {}
  stop() {
    this.stopped++;
  }
}
class Stream {
  constructor(readonly tracks: Track[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
}
class Recorder {
  static isTypeSupported(type: string) {
    return type.startsWith("video/webm");
  }
  state = "inactive";
  mimeType = "video/webm;codecs=vp8,opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => this.onstop?.());
  }
  data(value: string) {
    this.ondataavailable?.({ data: new Blob([value]) });
  }
}
function fixture(
  settings: {
    screen?: boolean;
    system?: boolean;
    pending?: boolean;
    micFailure?: boolean;
    maxBytes?: number;
    microphone?: boolean;
    unexpectedAudio?: boolean;
    pendingMic?: boolean;
  } = {},
) {
  global("MediaRecorder", Recorder);
  global("MediaStream", Stream);
  const abort = new AbortController();
  const video = new Track("video"),
    mic = new Track("audio"),
    system = new Track("audio"),
    mix = new Track("audio");
  const visual = new Stream([
    video,
    ...(settings.system || settings.unexpectedAudio ? [system] : []),
  ]);
  const recorder = new Recorder();
  const requests: Array<{ method: string; options: unknown }> = [];
  let resolve!: (value: Stream) => void;
  const devices = {
    getDisplayMedia(options: unknown) {
      requests.push({ method: "display", options });
      return settings.pending
        ? new Promise<Stream>((done) => {
            resolve = done;
          })
        : Promise.resolve(visual);
    },
    getUserMedia(options: any) {
      requests.push({ method: "user", options });
      if (settings.micFailure) return Promise.reject(new DOMException("denied", "NotAllowedError"));
      const stream = new Stream([
        ...(options.video ? [video] : []),
        ...(options.audio || settings.unexpectedAudio ? [mic] : []),
      ]);
      return settings.pending || settings.pendingMic
        ? new Promise<Stream>((done) => {
            resolve = done;
          })
        : Promise.resolve(stream);
    },
  };
  let closedAudio = 0,
    mixed = 0;
  const audio = {
    state: "running",
    resume: async () => {},
    close: async () => {
      closedAudio++;
      audio.state = "closed";
    },
    createMediaStreamDestination: () => ({ stream: new Stream([mix]) }),
    createMediaStreamSource: () => ({
      connect: () => {
        mixed++;
      },
    }),
  };
  let encoded: Stream | undefined;
  const capture = createPanelVideoCapture({
    source: settings.screen ? "screen" : "camera",
    microphone: settings.microphone !== false,
    systemAudio: !!settings.system,
    maxDurationSeconds: 60,
    maxBytes: settings.maxBytes ?? 1024,
    signal: abort.signal,
    onChange() {},
    devices: devices as any,
    makeRecorder: (stream) => {
      encoded = stream as unknown as Stream;
      return recorder as any;
    },
    makeAudioContext: () => audio as any,
  });
  restores.push(() => capture.close());
  return {
    capture,
    abort,
    recorder,
    requests,
    video,
    mic,
    system,
    mix,
    release: () => resolve(settings.pendingMic ? new Stream([mic]) : visual),
    encoded: () => encoded,
    closedAudio: () => closedAudio,
    mixed: () => mixed,
  };
}

test("capability discovery distinguishes camera from screen without requesting devices", () => {
  let requests = 0;
  global("window", { isSecureContext: true });
  global("MediaRecorder", Recorder);
  global("navigator", {
    mediaDevices: {
      getUserMedia() {
        requests++;
      },
    },
  });
  expect(panelVideoCapabilities()).toMatchObject({
    camera: true,
    microphone: true,
    screen: false,
    systemAudio: false,
  });
  expect(requests).toBe(0);
  (window as any).isSecureContext = false;
  expect(panelVideoCapabilities()).toMatchObject({
    camera: false,
    screen: false,
    microphone: false,
  });
});

test("camera access starts only explicitly and stops every track before retaining a review", async () => {
  const f = fixture();
  expect(f.requests).toHaveLength(0);
  await f.capture.start();
  expect(f.requests).toEqual([{ method: "user", options: { video: true, audio: true } }]);
  f.recorder.data("camera bytes");
  f.capture.stop();
  await Promise.resolve();
  expect(f.video.stopped).toBe(1);
  expect(f.mic.stopped).toBe(1);
  expect(f.capture.snapshot()).toMatchObject({
    phase: "review",
    capture: { source: "camera", microphone: true, systemAudio: false },
  });
  expect(await f.capture.snapshot().blob?.text()).toBe("camera bytes");
  expect(f.capture.snapshot().blob?.type).toBe("video/webm");
});

test("screen picker runs synchronously from start and a late permission after revocation is released", async () => {
  const f = fixture({ screen: true, pending: true });
  const started = f.capture.start();
  expect(f.requests).toEqual([{ method: "display", options: { video: true, audio: false } }]);
  f.abort.abort();
  f.release();
  await started;
  expect(f.video.stopped).toBe(1);
  expect(f.requests).toHaveLength(1);
  expect(f.recorder.state).toBe("inactive");
  expect(f.capture.snapshot().phase).toBe("closed");
});

test("screen audio is reported from actual tracks and stopping sharing releases its microphone", async () => {
  const f = fixture({ screen: true });
  await f.capture.start();
  expect(f.capture.snapshot().capture).toEqual({
    source: "screen",
    microphone: true,
    systemAudio: false,
  });
  f.recorder.data("screen bytes");
  f.video.onended!();
  await Promise.resolve();
  expect(f.video.stopped).toBe(1);
  expect(f.mic.stopped).toBe(1);
  expect(f.capture.snapshot().phase).toBe("review");
});

test("microphone and optional system audio are mixed and all source and destination tracks are released", async () => {
  const f = fixture({ screen: true, system: true });
  await f.capture.start();
  expect(f.mixed()).toBe(2);
  expect(f.capture.snapshot().capture.systemAudio).toBe(true);
  const late = f.recorder.ondataavailable!;
  f.abort.abort();
  late({ data: new Blob(["late"]) });
  expect([f.video.stopped, f.mic.stopped, f.system.stopped, f.mix.stopped]).toEqual([1, 1, 1, 1]);
  expect(f.closedAudio()).toBe(1);
  expect(f.capture.snapshot().blob).toBeUndefined();
});

test("failure acquiring the screen microphone releases the already selected display", async () => {
  const f = fixture({ screen: true, micFailure: true });
  await f.capture.start();
  expect(f.video.stopped).toBe(1);
  expect(f.capture.snapshot().phase).toBe("error");
  expect(f.recorder.state).toBe("inactive");
});

test("over budget video remains an error backup and cannot become a ready upload", async () => {
  const f = fixture({ maxBytes: 4 });
  await f.capture.start();
  f.recorder.data("oversized video");
  await Promise.resolve();
  expect(f.capture.snapshot().phase).toBe("error");
  expect(f.capture.snapshot().message).toContain("备份");
  expect(f.video.stopped).toBe(1);
});

test("unexpected unrequested audio never enters the encoder but every returned track is cleaned", async () => {
  for (const screen of [false, true]) {
    const f = fixture({ screen, microphone: false, unexpectedAudio: true });
    await f.capture.start();
    expect(f.encoded()!.getAudioTracks()).toHaveLength(0);
    expect(f.capture.snapshot().capture).toEqual({
      source: screen ? "screen" : "camera",
      microphone: false,
      systemAudio: false,
    });
    f.capture.close();
    expect((screen ? f.system : f.mic).stopped).toBe(1);
  }
});

test("stopping display while its microphone permission is pending releases the late microphone without encoding", async () => {
  const f = fixture({ screen: true, pendingMic: true });
  const starting = f.capture.start();
  await Promise.resolve();
  f.video.onended!();
  expect(f.video.stopped).toBe(1);
  f.release();
  await starting;
  expect(f.mic.stopped).toBe(1);
  expect(f.recorder.state).toBe("inactive");
  expect(f.capture.snapshot().phase).toBe("error");
});
