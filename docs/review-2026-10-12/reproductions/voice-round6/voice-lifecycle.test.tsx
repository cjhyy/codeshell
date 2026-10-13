import React, { act } from "react";
import { afterEach, expect, mock, test } from "bun:test";
import { createRoot } from "../../../../packages/desktop/node_modules/react-dom/client.js";
import { ensureMiniDom, flushMicrotasks } from "../../../../packages/web/src/test-utils/renderHook.tsx";

// Before any product/Core-facing imports, deny global fetch; STT IPC is mocked.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown) => { throw new Error(`NETWORK_FORBIDDEN: ${String(url)}`); }) as typeof fetch;
const { ChatView } = await import("../../../../packages/desktop/src/renderer/ChatView.tsx?voice-review");
const { createPanelAudioCapture } = await import("../../../../packages/web/app/panel-audio-capture.ts");
const { PanelAudioDialog } = await import("../../../../packages/web/app/PanelAudioDialog.tsx");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const cleanup: Array<() => void | Promise<void>> = [];
function property(target: object, key: string, value: unknown) {
  const old = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  cleanup.push(() => { if (old) Object.defineProperty(target, key, old); else Reflect.deleteProperty(target, key); });
}
function descendants(node: any): any[] { return Array.from(node?.childNodes ?? []).flatMap((child: any) => [child, ...descendants(child)]); }
function props(node: any): Record<string, any> { const key = Object.keys(node).find(key => key.startsWith("__reactProps$")); return key ? node[key] : {}; }
function find(container: any, predicate: (props: Record<string, any>) => boolean) { const node = descendants(container).find(node => predicate(props(node))); if (!node) throw new Error("rendered element missing"); return node; }
function streamFixture(id: string) {
  const track = { stop: mock(() => undefined) };
  const stream = { id, getTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}
class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported() { return true; }
  state = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  stopCalls = 0;
  constructor(readonly stream: MediaStream, options?: { mimeType?: string }) { this.mimeType = options?.mimeType ?? "audio/webm"; Recorder.instances.push(this); }
  start() { this.state = "recording"; }
  stop() { this.stopCalls++; this.state = "inactive"; queueMicrotask(() => this.onstop?.()); }
  emit(text: string) { this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) }); }
}
async function mount(options: { getUserMedia: () => Promise<MediaStream>; ensureMicAccess?: () => Promise<{ granted: boolean }>; transcribe?: (payload: any) => Promise<any>; initialDraft?: string }) {
  ensureMiniDom();
  property(globalThis, "navigator", { mediaDevices: { getUserMedia: options.getUserMedia } });
  property(globalThis, "MediaRecorder", Recorder);
  property(window, "codeshell", {
    sttAvailable: async () => ({ available: true }),
    ensureMicAccess: options.ensureMicAccess ?? (async () => ({ granted: true })),
    transcribeAudio: options.transcribe ?? (async () => ({ ok: true, text: "dictated fixture" })),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let draft = options.initialDraft ?? "";
  let mounted = true;
  function Host() {
    const [value, setValue] = React.useState(draft);
    const [attachments, setAttachments] = React.useState<any[]>([]);
    draft = value;
    return <ChatView variant="quickChat" messages={[]} engineSessionId="voice-fixture" onSend={() => undefined} onStop={() => undefined} busy={false} activeProjectId={null} permissionMode="plan" onPermissionChange={() => undefined} goalEnabled={false} onGoalToggle={() => undefined} modelOptions={[{ key: "fixture", label: "Fixture", provider: "fixture" }]} activeModelKey="fixture" onModelChange={() => undefined} contextTokens={0} projects={[]} onSelectProject={() => undefined} onAddProject={() => undefined} configurationTarget={{ sessionId: "voice-fixture" }} configurationAvailable conversationRoot="/tmp/voice-fixture" conversationRootId="voice-root" draft={value} onDraftChange={setValue} attachments={attachments} onAttachmentsChange={setAttachments} />;
  }
  await act(async () => { root.render(<Host />); await flushMicrotasks(); });
  const unmount = async () => { if (!mounted) return; mounted = false; await act(async () => { root.unmount(); await flushMicrotasks(); }); container.parentNode?.removeChild(container); };
  cleanup.push(unmount);
  const mic = () => find(container, p => p["aria-label"] === "语音输入");
  const click = async () => { await act(async () => { expect(props(mic()).disabled).toBe(false); props(mic()).onClick(); await flushMicrotasks(); }); };
  return { container, mic, click, unmount, draft: () => draft };
}
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  // Fixture-only cleanup for recorders deliberately proved unreachable by product cleanup.
  for (const recorder of Recorder.instances) { recorder.onstop = null; recorder.ondataavailable = null; if (recorder.state !== "inactive") recorder.stop(); }
  Recorder.instances = [];
});

test("confirmed: double click while media permission is pending starts two recorders; stop and unmount leak the first", async () => {
  const first = streamFixture("first"), second = streamFixture("second");
  const pending1 = deferred<MediaStream>(), pending2 = deferred<MediaStream>();
  const getUserMedia = mock(() => getUserMedia.mock.calls.length === 1 ? pending1.promise : pending2.promise);
  const f = await mount({ getUserMedia });
  await f.click();
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(props(f.mic()).disabled).toBe(false);
  await f.click();
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  await act(async () => { pending1.resolve(first.stream); await flushMicrotasks(); pending2.resolve(second.stream); await flushMicrotasks(); });
  expect(Recorder.instances).toHaveLength(2);
  expect(Recorder.instances.map(r => r.state)).toEqual(["recording", "recording"]);
  await f.click();
  expect(Recorder.instances[1].state).toBe("inactive");
  expect(second.track.stop).toHaveBeenCalledTimes(1);
  expect(Recorder.instances[0].state).toBe("recording");
  expect(first.track.stop).not.toHaveBeenCalled();
  await f.unmount();
  expect(Recorder.instances[0].stopCalls).toBe(0);
  expect(first.track.stop).not.toHaveBeenCalled();
  console.log("VOICE_DOUBLE_START_LEAK", JSON.stringify({ startedRecorders: 2, stoppedRecorders: Recorder.instances.filter(r => r.state === "inactive").length, firstTrackStopCalls: first.track.stop.mock.calls.length, firstStillRecordingAfterUnmount: Recorder.instances[0].state === "recording" }));
});

test("normal: one recording stops recorder and track when the surface unmounts", async () => {
  const first = streamFixture("one");
  const transcribe = mock(async () => ({ ok: true, text: "unused" }));
  const f = await mount({ getUserMedia: async () => first.stream, transcribe });
  await f.click();
  expect(Recorder.instances).toHaveLength(1);
  expect(Recorder.instances[0].state).toBe("recording");
  await f.unmount();
  expect(Recorder.instances[0].stopCalls).toBe(1);
  expect(first.track.stop).toHaveBeenCalledTimes(1);
  expect(transcribe).not.toHaveBeenCalled();
});

test("normal: denied permission starts no device; granting permission on retry records and appends transcript", async () => {
  const first = streamFixture("retry");
  let granted = false;
  const getUserMedia = mock(async () => first.stream);
  const f = await mount({ getUserMedia, ensureMicAccess: async () => ({ granted }), initialDraft: "existing draft" });
  await f.click();
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(Recorder.instances).toHaveLength(0);
  expect(f.draft()).toBe("existing draft");
  granted = true;
  await f.click();
  Recorder.instances[0].emit("fixture recording");
  await f.click();
  expect(f.draft()).toBe("existing draft dictated fixture");
  expect(first.track.stop).toHaveBeenCalledTimes(1);
});

test("normal: unmount while getUserMedia is pending releases late tracks without starting recorder", async () => {
  const first = streamFixture("late");
  const pending = deferred<MediaStream>();
  const f = await mount({ getUserMedia: () => pending.promise });
  await f.click();
  await f.unmount();
  await act(async () => { pending.resolve(first.stream); await flushMicrotasks(); });
  expect(first.track.stop).toHaveBeenCalledTimes(1);
  expect(Recorder.instances).toHaveLength(0);
});

test("normal limitation: failed transcription preserves typed draft and permits a new take, but has no retry of failed audio", async () => {
  const first = streamFixture("transcription");
  const calls: any[] = [];
  const f = await mount({ getUserMedia: async () => first.stream, initialDraft: "typed draft", transcribe: async payload => { calls.push(payload); return calls.length === 1 ? { ok: false, error: "fixture 503" } : { ok: true, text: "second take" }; } });
  await f.click(); Recorder.instances[0].emit("lost first audio"); await f.click();
  expect(f.draft()).toBe("typed draft");
  expect(calls).toHaveLength(1);
  expect(new TextDecoder().decode(calls[0].audio)).toBe("lost first audio");
  await f.click();
  expect(Recorder.instances).toHaveLength(2);
  expect(calls).toHaveLength(1);
  Recorder.instances[1].emit("second audio"); await f.click();
  expect(new TextDecoder().decode(calls[1].audio)).toBe("second audio");
  expect(f.draft()).toBe("typed draft second take");
});

test("normal: Web Panel prevents a second start while requesting, and abort releases late permission result", async () => {
  const first = streamFixture("web-late");
  const pending = deferred<MediaStream>();
  const abort = new AbortController();
  const getStream = mock(() => pending.promise);
  const makeRecorder = mock(() => new Recorder(first.stream) as unknown as MediaRecorder);
  const capture = createPanelAudioCapture({ signal: abort.signal, maxDurationSeconds: 60, maxBytes: 1024, onChange() {}, getStream, makeRecorder });
  const starting = capture.start();
  expect(capture.snapshot().phase).toBe("requesting");
  await expect(capture.start()).rejects.toThrow("已有录音");
  expect(getStream).toHaveBeenCalledTimes(1);
  abort.abort(); pending.resolve(first.stream); await starting;
  expect(first.track.stop).toHaveBeenCalledTimes(1);
  expect(makeRecorder).not.toHaveBeenCalled();
  expect(capture.snapshot().phase).toBe("closed");
});

test("normal: Web Panel microphone denial remains retryable; recording retains review audio and abort clears it", async () => {
  const first = streamFixture("web-retry");
  const abort = new AbortController();
  let deny = true;
  const capture = createPanelAudioCapture({ signal: abort.signal, maxDurationSeconds: 60, maxBytes: 1024, onChange() {}, getStream: async () => { if (deny) throw new DOMException("fixture denied", "NotAllowedError"); return first.stream; }, makeRecorder: stream => new Recorder(stream) as unknown as MediaRecorder });
  await capture.start();
  expect(capture.snapshot().phase).toBe("error");
  expect(capture.snapshot().message).toContain("未获授权");
  deny = false; await capture.start();
  expect(capture.snapshot().phase).toBe("recording");
  Recorder.instances[0].emit("web review bytes"); capture.stop(); await flushMicrotasks();
  expect(capture.snapshot().phase).toBe("review");
  expect(await capture.snapshot().blob?.text()).toBe("web review bytes");
  expect(first.track.stop).toHaveBeenCalledTimes(1);
  abort.abort();
  expect(capture.snapshot().phase).toBe("closed");
  expect(capture.snapshot().blob).toBeUndefined();
});

async function dialogFixture(options: { holdWrite?: boolean; loseWrite?: boolean } = {}) {
  ensureMiniDom();
  const first = streamFixture("web-dialog");
  property(globalThis, "navigator", { mediaDevices: { getUserMedia: async () => first.stream } });
  property(globalThis, "MediaRecorder", Recorder);
  const revoked: string[] = [];
  property(URL, "createObjectURL", () => "blob:voice-fixture");
  property(URL, "revokeObjectURL", (url: string) => revoked.push(url));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const abort = new AbortController();
  const pending = deferred<unknown>();
  const methods: string[] = [], signals: AbortSignal[] = [], finishes: unknown[] = [], chunks: Uint8Array[] = [];
  let digest = "", lost = options.loseWrite, show!: (value: boolean) => void;
  const current = { sessionId: "upload-12345678-1234-1234-1234-1234567890ab", mimeType: "audio/webm", receivedBytes: 0, nextSequence: 0, maxChunkBytes: 32768, state: "uploading" };
  const request = {
    signal: abort.signal, maxDurationSeconds: 60, maxBytes: 1024,
    call: async (method: string, params: any, signal?: AbortSignal) => {
      methods.push(method); if (signal) signals.push(signal);
      if (method.endsWith("begin")) digest = params.expectedSha256;
      if (method.endsWith("write")) {
        expect(params.sessionId).toBe(current.sessionId); expect(params.sequence).toBe(current.nextSequence); expect(params.offset).toBe(current.receivedBytes);
        const bytes = Uint8Array.from(atob(params.dataBase64), c => c.charCodeAt(0)); chunks.push(bytes);
        current.receivedBytes += bytes.length; current.nextSequence++;
        if (options.holdWrite) return pending.promise;
        if (lost) { lost = false; throw new Error("fixture lost chunk reply after commit"); }
      }
      if (method.endsWith("finish")) { current.state = "finished"; return { asset: { id: `asset-${digest}`, bytes: current.receivedBytes, mimeType: "audio/webm" } }; }
      return { ...current };
    },
    finish: (value: unknown) => { finishes.push(value); show(false); },
  };
  function Owner() { const [visible, setVisible] = React.useState(true); show = setVisible; return visible ? <PanelAudioDialog request={request} /> : null; }
  await act(async () => { root.render(<Owner />); await flushMicrotasks(); });
  let alive = true;
  const unmount = async () => { if (!alive) return; alive = false; await act(async () => { root.unmount(); await flushMicrotasks(); }); container.parentNode?.removeChild(container); };
  cleanup.push(unmount);
  const button = (label: string) => find(container, p => typeof p.onClick === "function" && p.children === label);
  const click = async (label: string) => { await act(async () => { expect(props(button(label)).disabled).not.toBe(true); props(button(label)).onClick(); await flushMicrotasks(); }); };
  const settle = async () => { await act(async () => { for (let i = 0; i < 4; i++) { await flushMicrotasks(); await new Promise(resolve => setTimeout(resolve, 0)); } }); };
  const record = async () => { await click("开始录音"); Recorder.instances.at(-1)!.emit("preserved audio"); await click("停止录音"); };
  return { container, first, record, click, settle, methods, signals, finishes, chunks, revoked, pending, current };
}

test("normal: real Web audio dialog keeps playback/download after lost write; save retries same identity without duplicate bytes", async () => {
  const f = await dialogFixture({ loseWrite: true });
  await f.record();
  expect(f.first.track.stop).toHaveBeenCalledTimes(1);
  await f.click("保存到当前项目"); await f.settle();
  expect(f.methods).toEqual(["resources.upload.begin", "resources.upload.write"]);
  expect(f.finishes).toEqual([]);
  expect(descendants(f.container).some(node => props(node).role === "alert" && String(props(node).children).includes("录音仍保留"))).toBe(true);
  expect(descendants(f.container).some(node => props(node).src === "blob:voice-fixture")).toBe(true);
  expect(descendants(f.container).some(node => props(node).download === "recording.webm")).toBe(true);
  await f.click("保存到当前项目"); await f.settle();
  expect(f.methods).toEqual(["resources.upload.begin", "resources.upload.write", "resources.upload.get", "resources.upload.finish"]);
  expect(f.chunks).toHaveLength(1);
  expect(f.finishes).toHaveLength(1);
  expect(f.revoked).toEqual(["blob:voice-fixture"]);
});

test("normal: cancelling real Web audio dialog during pending save aborts signal, revokes local URL, and ignores late receipt", async () => {
  const f = await dialogFixture({ holdWrite: true });
  await f.record(); await f.click("保存到当前项目"); await f.settle();
  expect(f.methods).toEqual(["resources.upload.begin", "resources.upload.write"]);
  expect(f.signals.at(-1)?.aborted).toBe(false);
  await f.click("取消录音");
  expect(f.finishes).toEqual([{ cancelled: true }]);
  expect(f.signals.every(signal => signal.aborted)).toBe(true);
  expect(f.revoked).toEqual(["blob:voice-fixture"]);
  f.pending.resolve({ ...f.current }); await f.settle();
  expect(f.methods).toEqual(["resources.upload.begin", "resources.upload.write"]);
  expect(f.finishes).toEqual([{ cancelled: true }]);
});

// Keep network denial installed until this isolated process exits.
void originalFetch;
