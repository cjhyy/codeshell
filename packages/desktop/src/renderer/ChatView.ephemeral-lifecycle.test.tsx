import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { ImageAttachment } from "./chat/attachments";

// Keep the real ChatView even when AppQuickChat.test installs its harness mock.
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { ChatView } = await import("./ChatView.tsx?ephemeral-lifecycle-test");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function descendants(node: any): any[] {
  const children = Array.from(node?.childNodes ?? []) as any[];
  return children.flatMap((child) => [child, ...descendants(child)]);
}

function reactProps(node: any): Record<string, any> {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function findElement(container: any, predicate: (props: Record<string, any>) => boolean): any {
  const found = descendants(container).find((node) => predicate(reactProps(node)));
  if (!found) throw new Error("expected rendered element was not found");
  return found;
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(): boolean {
    return true;
  }

  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stopCalls = 0;

  constructor(
    readonly stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.stopCalls += 1;
    this.state = "inactive";
    this.onstop?.();
  }

  emit(blob: Blob): void {
    this.ondataavailable?.({ data: blob });
  }
}

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalMediaRecorderDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "MediaRecorder",
);
const originalFileReaderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let root: Root | null = null;
let container: HTMLElement | null = null;

async function mountChatView(options: {
  codeshell: Record<string, any>;
  onDraftChange?: (next: React.SetStateAction<string>) => void;
  onAttachmentsChange?: (next: React.SetStateAction<ImageAttachment[]>) => void;
  onSend?: (text: string) => void;
}) {
  ensureMiniDom();
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    writable: true,
    value: options.codeshell,
  });
  container = document.createElement("div");
  root = createRoot(container);
  function Host() {
    const [draft, setDraft] = React.useState("");
    const [attachments, setAttachments] = React.useState<ImageAttachment[]>([]);
    const updateDraft: React.Dispatch<React.SetStateAction<string>> = (next) => {
      options.onDraftChange?.(next);
      setDraft(next);
    };
    const updateAttachments: React.Dispatch<React.SetStateAction<ImageAttachment[]>> = (next) => {
      options.onAttachmentsChange?.(next);
      setAttachments(next);
    };
    return (
      <ChatView
        variant="quickChat"
        messages={[]}
        engineSessionId="qchat-lifecycle"
        onSend={(text) => options.onSend?.(text)}
        onStop={() => undefined}
        busy={false}
        activeProjectId={null}
        permissionMode="plan"
        onPermissionChange={() => undefined}
        goalEnabled={false}
        onGoalToggle={() => undefined}
        modelOptions={[
          {
            key: "vision-model",
            label: "Vision",
            provider: "test",
            supportsVision: true,
          },
        ]}
        activeModelKey="vision-model"
        onModelChange={() => undefined}
        contextTokens={0}
        projects={[]}
        onSelectProject={() => undefined}
        onAddProject={() => undefined}
        activeProjectPath="/tmp/project"
        draft={draft}
        onDraftChange={updateDraft}
        attachments={attachments}
        onAttachmentsChange={updateAttachments}
        onPrepareAttachmentSession={() => ({
          cwd: "/tmp/project",
          sessionId: "qchat-lifecycle",
          quickChatClaimId: "generation-lifecycle",
        })}
      />
    );
  }
  await act(async () => {
    root?.render(<Host />);
    await flushMicrotasks();
  });
  return container;
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
  container = null;
  FakeMediaRecorder.instances = [];
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  }
  if (originalMediaRecorderDescriptor) {
    Object.defineProperty(globalThis, "MediaRecorder", originalMediaRecorderDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).MediaRecorder;
  }
  if (originalFileReaderDescriptor) {
    Object.defineProperty(globalThis, "FileReader", originalFileReaderDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).FileReader;
  }
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
});

describe("ChatView ephemeral async lifecycle", () => {
  test("does not persist a quick-chat prompt in main composer history", async () => {
    const setItem = mock(() => undefined);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null, setItem, removeItem: () => undefined },
    });
    const onSend = mock(() => undefined);
    const mounted = await mountChatView({
      codeshell: { sttAvailable: async () => ({ available: false }) },
      onSend,
    });
    let textarea = findElement(mounted, (props) => props.rows === 1);
    await act(async () => {
      reactProps(textarea).onChange({
        target: { value: "private side prompt", selectionStart: 19 },
      });
      await flushMicrotasks();
    });
    textarea = findElement(mounted, (props) => props.rows === 1);
    await act(async () => {
      reactProps(textarea).onKeyDown({
        key: "Enter",
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => undefined,
      });
      await flushMicrotasks();
    });

    expect(onSend).toHaveBeenCalledWith("private side prompt");
    expect(setItem).not.toHaveBeenCalled();
  });

  test("does not offer /compact when the embedded composer has no compact handler", async () => {
    const mounted = await mountChatView({
      codeshell: { sttAvailable: async () => ({ available: false }) },
    });
    const textarea = findElement(mounted, (props) => props.rows === 1);

    await act(async () => {
      reactProps(textarea).onChange({
        target: { value: "/", selectionStart: 1 },
      });
      await flushMicrotasks();
    });

    expect(descendants(mounted).some((node) => reactProps(node).role === "listbox")).toBe(false);
  });

  test("stops the recorder, tracks, and timer when quick chat unmounts", async () => {
    const track = { stop: mock(() => undefined) };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async () => stream } },
    });
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: FakeMediaRecorder,
    });
    const clearTimer = spyOn(globalThis, "clearTimeout");
    const transcribeAudio = mock(async () => ({ ok: true, text: "must not appear" }));
    const mounted = await mountChatView({
      codeshell: {
        sttAvailable: async () => ({ available: true }),
        ensureMicAccess: async () => ({ granted: true }),
        transcribeAudio,
      },
    });
    const mic = findElement(mounted, (props) => props["aria-label"] === "语音输入");

    await act(async () => {
      reactProps(mic).onClick();
      await flushMicrotasks();
    });
    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder?.state).toBe("recording");

    await act(async () => {
      root?.unmount();
      root = null;
      await flushMicrotasks();
    });

    expect(recorder?.stopCalls).toBe(1);
    expect(recorder?.onstop).toBeNull();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(clearTimer).toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
    clearTimer.mockRestore();
  });

  test("drops a transcription result that resolves after quick chat unmounts", async () => {
    const track = { stop: mock(() => undefined) };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async () => stream } },
    });
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: FakeMediaRecorder,
    });
    const transcription = deferred<{ ok: true; text: string }>();
    const draftWrites: Array<React.SetStateAction<string>> = [];
    const mounted = await mountChatView({
      codeshell: {
        sttAvailable: async () => ({ available: true }),
        ensureMicAccess: async () => ({ granted: true }),
        transcribeAudio: () => transcription.promise,
      },
      onDraftChange: (next) => draftWrites.push(next),
    });
    let mic = findElement(mounted, (props) => props["aria-label"] === "语音输入");
    await act(async () => {
      reactProps(mic).onClick();
      await flushMicrotasks();
    });
    const recorder = FakeMediaRecorder.instances[0]!;
    recorder.emit(new Blob(["voice"]));
    mic = findElement(mounted, (props) => props["aria-label"] === "语音输入");
    await act(async () => {
      reactProps(mic).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      root?.unmount();
      root = null;
      transcription.resolve({ ok: true, text: "late private transcript" });
      await flushMicrotasks();
    });

    expect(draftWrites).toEqual([]);
  });

  test("drops a staged attachment that resolves after quick chat unmounts", async () => {
    class FakeFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(): void {
        this.result = "data:image/png;base64,aA==";
        queueMicrotask(() => this.onload?.());
      }
    }
    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      value: FakeFileReader,
    });
    const staged = deferred<any>();
    const stageAttachmentImageDataUrl = mock(() => staged.promise);
    const attachmentWrites: Array<React.SetStateAction<ImageAttachment[]>> = [];
    const mounted = await mountChatView({
      codeshell: {
        sttAvailable: async () => ({ available: false }),
        stageAttachmentImageDataUrl,
      },
      onAttachmentsChange: (next) => attachmentWrites.push(next),
    });
    const fileInput = findElement(mounted, (props) => props.type === "file");
    const file = new File(["x"], "private.png", { type: "image/png" });

    await act(async () => {
      reactProps(fileInput).onChange({ target: { files: [file], value: "" } });
      await flushMicrotasks();
    });
    expect(stageAttachmentImageDataUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "qchat-lifecycle",
        quickChatClaimId: "generation-lifecycle",
      }),
    );
    await act(async () => {
      root?.unmount();
      root = null;
      staged.resolve({
        id: "late-stage",
        sessionId: "qchat-lifecycle",
        kind: "image",
        origin: "picker",
        path: ".code-shell/attachments/qchat-lifecycle/private.png",
        absPath: "/tmp/project/.code-shell/attachments/qchat-lifecycle/private.png",
        size: 1,
        sha256: "abc",
        createdAt: 1,
      });
      await flushMicrotasks();
    });

    expect(attachmentWrites).toEqual([]);
  });
});
