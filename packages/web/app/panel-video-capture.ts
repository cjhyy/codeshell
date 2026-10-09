import {
  panelVideoLimits,
  panelVideoOptions,
  type PanelVideoOptions,
} from "../../server/src/panels/browser-capture.js";

const VIDEO_TYPES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm",
  "video/mp4",
];
function videoMime() {
  try {
    return VIDEO_TYPES.find(
      (type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
    );
  } catch {
    return undefined;
  }
}

/** API/encoder availability only: this never enumerates devices or asks for permission. */
export function panelVideoCapabilities() {
  const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  const enabled = typeof window !== "undefined" && window.isSecureContext === true && !!videoMime();
  const microphone = enabled && typeof devices?.getUserMedia === "function";
  const screen = enabled && typeof devices?.getDisplayMedia === "function";
  return {
    camera: microphone,
    screen,
    microphone,
    // Display audio is optional even when requested. The receipt reports actual tracks.
    systemAudio: screen,
    maxDurationSeconds: panelVideoLimits.maxDurationSeconds,
    maxBytes: panelVideoLimits.maxBytes,
  };
}

export interface PanelVideoSnapshot {
  phase: "idle" | "requesting" | "recording" | "review" | "error" | "closed";
  elapsedSeconds: number;
  message: string;
  stream?: MediaStream;
  blob?: Blob;
  capture: Pick<PanelVideoOptions, "source" | "microphone" | "systemAudio">;
}

/** Owns all device tracks, the encoder and any audio mix in the trusted workbench. */
export function createPanelVideoCapture(
  options: PanelVideoOptions & {
    signal: AbortSignal;
    onChange: (snapshot: PanelVideoSnapshot) => void;
    devices?: Pick<MediaDevices, "getUserMedia" | "getDisplayMedia">;
    makeRecorder?: (stream: MediaStream, mimeType: string) => MediaRecorder;
    makeAudioContext?: () => AudioContext;
  },
) {
  const request = panelVideoOptions({
    source: options.source,
    microphone: options.microphone,
    systemAudio: options.systemAudio,
    maxDurationSeconds: options.maxDurationSeconds,
    maxBytes: options.maxBytes,
  });
  let state: PanelVideoSnapshot = {
    phase: "idle",
    elapsedSeconds: 0,
    message: "点击开始录制后，才会请求设备授权。",
    capture: { source: request.source, microphone: false, systemAudio: false },
  };
  let generation = 0;
  let closed = options.signal.aborted;
  let recorder: MediaRecorder | undefined;
  let audio: AudioContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let chunks: Blob[] = [];
  let bytes = 0;
  let captureError = "";
  const streams = new Set<MediaStream>();
  const publish = (patch: Partial<PanelVideoSnapshot>) => {
    state = { ...state, ...patch };
    if (!closed) options.onChange({ ...state });
  };
  const release = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    for (const track of new Set([...streams].flatMap((stream) => stream.getTracks()))) {
      track.onended = null;
      track.stop();
    }
    streams.clear();
    if (audio && audio.state !== "closed") void audio.close().catch(() => {});
    audio = undefined;
  };
  const stop = () => {
    try {
      if (recorder?.state !== "inactive") recorder?.stop();
    } finally {
      release();
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    generation++;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
    }
    try {
      stop();
    } finally {
      release();
    }
    chunks = [];
    state = { ...state, phase: "closed", stream: undefined, blob: undefined };
    options.signal.removeEventListener("abort", close);
  };
  if (closed) state.phase = "closed";
  else options.signal.addEventListener("abort", close, { once: true });
  return {
    snapshot: () => ({ ...state }),
    async start() {
      if (closed || options.signal.aborted) throw new Error("录制授权已结束。");
      if (["requesting", "recording"].includes(state.phase)) throw new Error("已有录制正在进行。");
      const ownGeneration = ++generation;
      const active = () => !closed && generation === ownGeneration && !options.signal.aborted;
      const own = (stream: MediaStream) => {
        if (!active()) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error("录制授权已结束。");
        }
        streams.add(stream);
        for (const track of stream.getTracks()) {
          if (track.readyState === "ended") throw new Error("所选采集来源已经停止，请重新连接。");
          track.onended = () => {
            if (!active()) return;
            if (state.phase === "recording") stop();
            else {
              generation++;
              release();
              publish({
                phase: "error",
                stream: undefined,
                message: "采集来源已停止，请重新连接。",
              });
            }
          };
        }
        return stream;
      };
      release();
      chunks = [];
      bytes = 0;
      captureError = "";
      publish({
        phase: "requesting",
        elapsedSeconds: 0,
        stream: undefined,
        blob: undefined,
        message: "正在等待设备授权…",
      });
      try {
        const devices = options.devices ?? navigator.mediaDevices;
        if (!devices) throw new Error("录制需要安全连接和浏览器设备支持。");
        // No awaited work precedes getDisplayMedia: retain the trusted button's activation.
        const video = own(
          await (request.source === "screen"
            ? devices.getDisplayMedia({ video: true, audio: request.systemAudio })
            : devices.getUserMedia({ video: true, audio: request.microphone })),
        );
        if (!video.getVideoTracks().length) throw new Error("没有获得可录制的画面。");
        const mic =
          request.source === "screen" && request.microphone
            ? own(await devices.getUserMedia({ audio: true, video: false }))
            : undefined;
        const microphoneTracks = request.microphone
          ? ((request.source === "camera" ? video : mic)?.getAudioTracks() ?? [])
          : [];
        if (request.microphone && !microphoneTracks.length) throw new Error("没有获得麦克风音轨。");
        const systemTracks =
          request.source === "screen" && request.systemAudio ? video.getAudioTracks() : [];
        // Encode only explicitly requested tracks, even if a source returns extra audio.
        let stream = own(
          new MediaStream([...video.getVideoTracks(), ...microphoneTracks, ...systemTracks]),
        );
        if (microphoneTracks.length && request.source === "screen") {
          if (systemTracks.length) {
            audio = options.makeAudioContext ? options.makeAudioContext() : new AudioContext();
            const currentAudio = audio;
            const destination = currentAudio.createMediaStreamDestination();
            own(destination.stream);
            for (const tracks of [microphoneTracks, systemTracks])
              currentAudio.createMediaStreamSource(new MediaStream(tracks)).connect(destination);
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                currentAudio.resume(),
                new Promise<never>((_resolve, reject) => {
                  timeout = setTimeout(
                    () => reject(new Error("声音混合未能启动，请重新录制。")),
                    2000,
                  );
                }),
              ]);
            } finally {
              if (timeout) clearTimeout(timeout);
            }
            options.signal.throwIfAborted();
            stream = own(
              new MediaStream([...video.getVideoTracks(), ...destination.stream.getAudioTracks()]),
            );
          } else stream = own(new MediaStream([...video.getVideoTracks(), ...microphoneTracks]));
        }
        if (!active()) {
          release();
          return;
        }
        const mime = videoMime();
        if (!mime) throw new Error("此浏览器不支持视频录制编码。");
        recorder = options.makeRecorder
          ? options.makeRecorder(stream, mime)
          : new MediaRecorder(stream, { mimeType: mime });
        const current = recorder;
        current.ondataavailable = (event) => {
          if (!active() || !event.data.size) return;
          chunks.push(event.data);
          bytes += event.data.size;
          if (bytes > request.maxBytes) {
            captureError = "录制超过大小限制；可以下载备份或重新录制较短的视频。";
            stop();
          }
        };
        current.onerror = () => {
          if (!active()) return;
          captureError = "录制设备或编码器发生错误，请保留备份后重试。";
          try {
            stop();
          } catch {
            release();
          }
          publish({ phase: "error", stream: undefined, message: captureError });
        };
        current.onstop = () => {
          if (!active()) return;
          release();
          const blob = new Blob(chunks, {
            type: current.mimeType.split(";")[0] || mime.split(";")[0],
          });
          chunks = [];
          publish({
            phase: blob.size && !captureError ? "review" : "error",
            stream: undefined,
            blob: blob.size ? blob : undefined,
            message:
              captureError ||
              (blob.size
                ? "录制已停止。可以预览，再保存到当前项目。"
                : "没有录到内容，请重新录制。"),
          });
        };
        const started = Date.now();
        current.start(250);
        publish({
          phase: "recording",
          stream,
          capture: {
            source: request.source,
            microphone: microphoneTracks.length > 0,
            systemAudio: systemTracks.length > 0,
          },
          message: "正在使用这台设备录制；停止后可以预览和保存。",
        });
        timer = setInterval(() => {
          if (!active()) return;
          const elapsedSeconds = Math.floor((Date.now() - started) / 1000);
          publish({ elapsedSeconds });
          if (elapsedSeconds >= request.maxDurationSeconds) stop();
        }, 250);
      } catch (error) {
        release();
        if (!active()) return;
        publish({
          phase: "error",
          stream: undefined,
          message:
            error instanceof Error && ["NotAllowedError", "SecurityError"].includes(error.name)
              ? "设备未获授权或屏幕选择已取消，请检查浏览器和系统权限后重试。"
              : error instanceof Error
                ? error.message
                : "无法启动录制，请检查设备和浏览器支持。",
        });
      }
    },
    stop,
    close,
  };
}
