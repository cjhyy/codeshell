import React from "react";
import type { PanelVideoOptions } from "../../server/src/panels/browser-capture.js";
import { createPanelVideoCapture, type PanelVideoSnapshot } from "./panel-video-capture.js";
import { createPanelResourceUpload } from "./panel-resource-upload.js";

export interface PanelVideoRequest extends PanelVideoOptions {
  signal: AbortSignal;
  call: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  finish: (result: unknown) => void;
  transferBudget?: { rateWindowMs: number; maxTransferCallsPerWindow: number };
}

export function PanelVideoDialog({ request }: { request: PanelVideoRequest }) {
  const [snapshot, setSnapshot] = React.useState<PanelVideoSnapshot>({
    phase: "idle",
    elapsedSeconds: 0,
    message: "点击开始录制后，才会请求设备授权。",
    capture: { source: request.source, microphone: false, systemAudio: false },
  });
  const [error, setError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [receivedBytes, setReceivedBytes] = React.useState(0);
  const [url, setUrl] = React.useState("");
  const element = React.useRef<HTMLElement>(null);
  const video = React.useRef<HTMLVideoElement>(null);
  const capture = React.useRef<ReturnType<typeof createPanelVideoCapture> | undefined>(undefined);
  const upload = React.useRef<
    { blob: Blob; transfer: ReturnType<typeof createPanelResourceUpload> } | undefined
  >(undefined);
  const active = React.useRef<AbortController | undefined>(undefined);
  React.useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    const signal = AbortSignal.any([request.signal, controller.signal]);
    capture.current = createPanelVideoCapture({ ...request, signal, onChange: setSnapshot });
    const pagehide = () => {
      controller.abort();
      request.finish({ cancelled: true });
    };
    window.addEventListener("pagehide", pagehide, { once: true });
    element.current?.focus();
    element.current?.scrollIntoView?.({ block: "nearest" });
    return () => {
      window.removeEventListener("pagehide", pagehide);
      controller.abort();
      capture.current?.close();
      capture.current = undefined;
      upload.current = undefined;
    };
  }, [request]);
  React.useEffect(() => {
    const current = video.current;
    if (!current) return;
    current.srcObject = snapshot.stream ?? null;
    if (snapshot.stream) void current.play().catch(() => {});
    return () => {
      current.srcObject = null;
    };
  }, [snapshot.stream]);
  React.useEffect(() => {
    if (!snapshot.blob) {
      setUrl("");
      return;
    }
    const next = URL.createObjectURL(snapshot.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [snapshot.blob]);
  const extension = snapshot.blob?.type === "video/mp4" ? "mp4" : "webm";
  const start = () => {
    setError("");
    upload.current = undefined;
    void capture.current?.start().catch((cause) => setError(String(cause)));
  };
  const save = async () => {
    const blob = snapshot.blob,
      controller = active.current;
    if (!blob || !controller || saving || snapshot.phase !== "review") return;
    const signal = AbortSignal.any([request.signal, controller.signal]);
    setSaving(true);
    setError("");
    try {
      if (upload.current?.blob !== blob)
        upload.current = {
          blob,
          transfer: createPanelResourceUpload({
            blob,
            name: `recording.${extension}`,
            signal,
            maxBytes: request.maxBytes,
            mimeTypes: ["video/webm", "video/mp4"],
            transferBudget: request.transferBudget,
            call: (method, params) => request.call(method, params, signal),
            onProgress: setReceivedBytes,
          }),
        };
      const result = await upload.current.transfer.save();
      signal.throwIfAborted();
      request.finish({ ...result, capture: snapshot.capture });
    } catch (cause) {
      if (!signal.aborted)
        setError(
          `${cause instanceof Error ? cause.message : "保存失败。"} 视频仍保留在本页，可重试保存或下载备份。若已保存但未收到回复，重开面板后可从项目资源找回。`,
        );
    } finally {
      if (!signal.aborted) setSaving(false);
    }
  };
  return (
    <section
      className="panel-host-video panel-host-preview"
      aria-label="视频录制"
      tabIndex={-1}
      ref={element}
    >
      <header>
        <h2>{request.source === "camera" ? "摄像头录制" : "屏幕录制"}并保存到当前项目</h2>
        <button onClick={() => request.finish({ cancelled: true })}>取消录制</button>
      </header>
      <p>
        使用当前设备；最长 {request.maxDurationSeconds} 秒，最多{" "}
        {Math.ceil(request.maxBytes / 1024 / 1024)} MiB。
        {request.microphone ? "使用麦克风。" : "不使用麦克风。"}
        {request.systemAudio && "屏幕声音取决于浏览器和你选择的共享来源，可能没有声音音轨。"}
        停止后可预览，点击保存才会上传。关闭面板会丢弃未保存录制。
      </p>
      <p role="status">
        {snapshot.message} {snapshot.elapsedSeconds > 0 && `${snapshot.elapsedSeconds} 秒`}
      </p>
      {snapshot.stream && <video ref={video} muted playsInline aria-label="实时录制预览" />}
      {url && <video controls playsInline src={url} aria-label="录制预览" />}
      {snapshot.phase === "recording" && (
        <p>
          麦克风：{snapshot.capture.microphone ? "已采集" : "未采集"}；屏幕声音：
          {snapshot.capture.systemAudio ? "已采集" : "未采集"}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {saving && (
        <p role="status">
          正在保存视频：{Math.round((receivedBytes / (snapshot.blob?.size || 1)) * 100)}%
        </p>
      )}
      <div className="panel-host-actions">
        {["idle", "error"].includes(snapshot.phase) && !snapshot.blob && (
          <button onClick={start}>开始录制</button>
        )}
        {snapshot.phase === "recording" && (
          <button onClick={() => capture.current?.stop()}>停止录制</button>
        )}
        {snapshot.phase === "review" && (
          <button disabled={saving} className="panel-host-primary" onClick={() => void save()}>
            {saving ? "正在保存…" : "保存到当前项目"}
          </button>
        )}
        {url && (
          <button disabled={saving} onClick={start}>
            丢弃并重新录制
          </button>
        )}
        {url && (
          <a href={url} download={`recording.${extension}`}>
            下载本机备份
          </a>
        )}
      </div>
    </section>
  );
}
