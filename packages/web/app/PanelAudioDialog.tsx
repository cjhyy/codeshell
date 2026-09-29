import React from "react";
import { createPanelAudioCapture, type PanelAudioSnapshot } from "./panel-audio-capture.js";
import { createPanelAudioUpload } from "./panel-audio-upload.js";

export interface PanelAudioRequest {
  signal: AbortSignal;
  maxDurationSeconds: number;
  maxBytes: number;
  call: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  finish: (result: unknown) => void;
}

export function PanelAudioDialog({ request }: { request: PanelAudioRequest }) {
  const [snapshot, setSnapshot] = React.useState<PanelAudioSnapshot>({
    phase: "idle",
    elapsedSeconds: 0,
    message: "点击开始录音后，浏览器才会请求麦克风。",
  });
  const [error, setError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [receivedBytes, setReceivedBytes] = React.useState(0);
  const [url, setUrl] = React.useState("");
  const element = React.useRef<HTMLElement>(null);
  const capture = React.useRef<ReturnType<typeof createPanelAudioCapture> | undefined>(undefined);
  const upload = React.useRef<
    { blob: Blob; transfer: ReturnType<typeof createPanelAudioUpload> } | undefined
  >(undefined);
  const active = React.useRef<AbortController | undefined>(undefined);
  React.useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    const signal = AbortSignal.any([request.signal, controller.signal]);
    capture.current = createPanelAudioCapture({ ...request, signal, onChange: setSnapshot });
    element.current?.focus();
    element.current?.scrollIntoView?.({ block: "nearest" });
    return () => {
      controller.abort();
      capture.current?.close();
      capture.current = undefined;
      upload.current = undefined;
    };
  }, [request]);
  React.useEffect(() => {
    if (!snapshot.blob) {
      setUrl("");
      return;
    }
    const next = URL.createObjectURL(snapshot.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [snapshot.blob]);
  const extension =
    snapshot.blob?.type === "audio/mp4"
      ? "m4a"
      : snapshot.blob?.type === "audio/ogg"
        ? "ogg"
        : "webm";
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
          transfer: createPanelAudioUpload({
            blob,
            name: `recording.${extension}`,
            signal,
            call: (method, params) => request.call(method, params, signal),
            onProgress: setReceivedBytes,
          }),
        };
      const result = await upload.current.transfer.save();
      signal.throwIfAborted();
      request.finish(result);
    } catch (cause) {
      if (!signal.aborted)
        setError(
          `${cause instanceof Error ? cause.message : "保存失败。"} 录音仍保留在本页，可重试保存或下载备份。`,
        );
    } finally {
      if (!signal.aborted) setSaving(false);
    }
  };
  return (
    <section
      className="panel-host-audio panel-host-preview"
      aria-label="录音"
      tabIndex={-1}
      ref={element}
    >
      <header>
        <h2>录音并保存到当前项目</h2>
        <button onClick={() => request.finish({ cancelled: true })}>取消录音</button>
      </header>
      <p>
        使用当前设备的麦克风；最长 {request.maxDurationSeconds}{" "}
        秒。停止后可试听，点击保存才会上传到当前项目。关闭面板会丢弃未保存录音。
      </p>
      <p role="status">
        {snapshot.message} {snapshot.elapsedSeconds > 0 && `${snapshot.elapsedSeconds} 秒`}
      </p>
      {url && <audio controls src={url} />}
      {error && <p role="alert">{error}</p>}
      {saving && (
        <p role="status">
          正在保存录音：{Math.round((receivedBytes / (snapshot.blob?.size || 1)) * 100)}%
        </p>
      )}
      <div className="panel-host-actions">
        {["idle", "error"].includes(snapshot.phase) && !snapshot.blob && (
          <button
            onClick={() => {
              setError("");
              void capture.current?.start().catch((cause) => setError(String(cause)));
            }}
          >
            开始录音
          </button>
        )}
        {snapshot.phase === "recording" && (
          <button onClick={() => capture.current?.stop()}>停止录音</button>
        )}
        {snapshot.phase === "review" && (
          <button disabled={saving} className="panel-host-primary" onClick={() => void save()}>
            {saving ? "正在保存…" : "保存到当前项目"}
          </button>
        )}
        {url && (
          <button
            disabled={saving}
            onClick={() => {
              setError("");
              upload.current = undefined;
              void capture.current?.start().catch((cause) => setError(String(cause)));
            }}
          >
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
