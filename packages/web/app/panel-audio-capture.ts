/** Browser-device capture owned by the trusted workbench, never the Panel iframe. */
export interface PanelAudioSnapshot {
  phase: "idle" | "requesting" | "recording" | "review" | "error" | "closed";
  elapsedSeconds: number;
  message: string;
  blob?: Blob;
}

export function createPanelAudioCapture(options: {
  signal: AbortSignal;
  maxDurationSeconds: number;
  maxBytes: number;
  onChange: (snapshot: PanelAudioSnapshot) => void;
  getStream?: () => Promise<MediaStream>;
  makeRecorder?: (stream: MediaStream) => MediaRecorder;
}) {
  if (
    !Number.isInteger(options.maxDurationSeconds) ||
    options.maxDurationSeconds < 1 ||
    options.maxDurationSeconds > 600 ||
    !Number.isInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > 25 * 1024 * 1024
  )
    throw new Error("录音限制无效。");
  let state: PanelAudioSnapshot = {
    phase: "idle",
    elapsedSeconds: 0,
    message: "点击开始录音后，浏览器才会请求麦克风。",
  };
  let generation = 0;
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let chunks: Blob[] = [];
  let size = 0;
  let captureError = "";
  let closed = options.signal.aborted;
  const publish = (patch: Partial<PanelAudioSnapshot>) => {
    state = { ...state, ...patch };
    if (!closed) options.onChange({ ...state });
  };
  const releaseTracks = () => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const stop = () => {
    try {
      if (recorder?.state !== "inactive") recorder?.stop();
    } finally {
      releaseTracks();
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
      releaseTracks();
    }
    chunks = [];
    state = { phase: "closed", elapsedSeconds: 0, message: "录音已关闭。" };
    options.signal.removeEventListener("abort", close);
  };
  if (closed) state = { phase: "closed", elapsedSeconds: 0, message: "录音授权已结束。" };
  else options.signal.addEventListener("abort", close, { once: true });

  return {
    snapshot: () => ({ ...state }),
    // The trusted dialog calls start only from its explicit record button.
    async start() {
      if (closed || options.signal.aborted) throw new Error("录音授权已结束。");
      if (["requesting", "recording"].includes(state.phase)) throw new Error("已有录音正在进行。");
      const ownGeneration = ++generation;
      const active = () => !closed && ownGeneration === generation && !options.signal.aborted;
      chunks = [];
      size = 0;
      captureError = "";
      publish({
        phase: "requesting",
        elapsedSeconds: 0,
        blob: undefined,
        message: "正在等待麦克风授权…",
      });
      try {
        const acquired = await (options.getStream
          ? options.getStream()
          : navigator.mediaDevices.getUserMedia({ audio: true, video: false }));
        if (!active()) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
        const mimeType = [
          "audio/webm;codecs=opus",
          "audio/webm",
          "audio/mp4",
          "audio/ogg;codecs=opus",
        ].find(
          (type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
        );
        recorder = options.makeRecorder
          ? options.makeRecorder(stream)
          : new MediaRecorder(stream, {
              ...(mimeType ? { mimeType } : {}),
              audioBitsPerSecond: 128000,
            });
        const current = recorder;
        current.ondataavailable = (event) => {
          if (!active() || !event.data.size) return;
          chunks.push(event.data);
          size += event.data.size;
          if (size > options.maxBytes) {
            captureError = "录音超过大小限制；可以下载备份，或重新录制较短的音频。";
            stop();
          }
        };
        current.onerror = () => {
          if (!active()) return;
          captureError = "录音设备发生错误；请检查麦克风后重新录制。";
          try {
            stop();
          } catch {
            releaseTracks();
          }
          publish({ phase: "error", message: captureError });
        };
        current.onstop = () => {
          if (!active()) return;
          releaseTracks();
          const blob = new Blob(chunks, { type: current.mimeType.split(";")[0] || "audio/webm" });
          chunks = [];
          publish({
            phase: blob.size && !captureError ? "review" : "error",
            blob: blob.size ? blob : undefined,
            message:
              captureError ||
              (blob.size
                ? "录音已停止。可以试听，再保存到当前项目。"
                : "没有录到声音，请重新录制。"),
          });
        };
        const started = Date.now();
        current.start(250);
        publish({ phase: "recording", message: "正在使用这台设备的麦克风录音。" });
        timer = setInterval(() => {
          if (!active()) return;
          const elapsedSeconds = Math.floor((Date.now() - started) / 1000);
          publish({ elapsedSeconds });
          if (elapsedSeconds >= options.maxDurationSeconds) stop();
        }, 250);
      } catch (error) {
        releaseTracks();
        if (!active()) return;
        publish({
          phase: "error",
          message:
            error instanceof Error && ["NotAllowedError", "SecurityError"].includes(error.name)
              ? "麦克风未获授权，请检查浏览器和系统的麦克风权限。"
              : "无法启动录音，请确认安全连接、麦克风和浏览器录音支持。",
        });
      }
    },
    stop,
    close,
  };
}
