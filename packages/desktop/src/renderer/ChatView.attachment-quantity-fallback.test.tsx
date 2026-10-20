import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { QuickChatSessionRef } from "./quickChatSession";

// The real renderer and its real attachment handlers run against an inert bridge.
// No Main/Core, native transport, browser, media device, or provider is invoked.
const deniedCalls: string[] = [];
const children = createRequire(import.meta.url)("node:child_process");
const childNames = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
// The shard shares one process, so these denials must not outlive this file.
const originalChildren = Object.fromEntries(childNames.map((name) => [name, children[name]]));
const originalKill = process.kill;
for (const name of childNames) {
  children[name] = () => {
    deniedCalls.push(`child_process.${name}`);
    throw new Error(`Native transport denied: ${name}`);
  };
}
process.kill = () => {
  deniedCalls.push("process.kill");
  throw new Error("Native signal denied");
};
syncBuiltinESMExports();
const denied = () => {
  deniedCalls.push("renderer transport");
  throw new Error("Unexpected renderer transport");
};
const originalFetch = globalThis.fetch;
const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
globalThis.fetch = denied;
Object.defineProperty(globalThis, "Worker", { configurable: true, value: denied });
Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: denied });
const denyQRCode = () => {
  deniedCalls.push("qrcode");
  throw new Error("Unexpected QR code rendering");
};
mock.module("qrcode", () => ({
  default: Object.assign(denyQRCode, { toDataURL: denyQRCode }),
  toDataURL: denyQRCode,
}));

let chatProps: Record<string, any> | null = null;
mock.module("./MessageStream", () => ({ MessageStream: () => null }));
// Keep the real child while using the production wrapper's existing public
// test seam. Only this isolated file is intended for the guarded shard.
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { ChatView: ActualChatView } = await import("./ChatView.tsx?quantity-fallback");
mock.module("./ChatView", () => ({ ChatView: ActualChatView }));
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { QuickChatPanel } = await import("./panels/QuickChatPanel.tsx?quantity-fallback");
const { useQuickChatImages } = await import("./chat/useQuickChatImages");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function descendants(node: any): any[] {
  return [node, ...(node?.childNodes ?? []).flatMap((child: any) => descendants(child))];
}
function renderedText(): string {
  return descendants(container)
    .map((node) => {
      const text = node?.nodeValue ?? node?.data ?? node?.textContent;
      return typeof text === "string" ? text : "";
    })
    .join("");
}
function propsOf(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function find(predicate: (props: Record<string, any>) => boolean): any {
  const node = descendants(container).find((item) => predicate(propsOf(item)));
  if (!node) throw new Error("Actual renderer element was not found");
  return node;
}
class MemoryStorage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}
class ControlledFileReader {
  static reads: ControlledFileReader[] = [];
  result: string | null = null;
  file: File | null = null;
  finished = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(file: File) {
    this.file = file;
    ControlledFileReader.reads.push(this);
  }
  finish() {
    if (this.finished) throw new Error("Controlled reader was completed twice");
    this.finished = true;
    this.result = "data:image/png;base64,eA==";
    this.onload?.();
  }
}
const OWNER = "qchat-capacity";
const CLAIM = "qchat-capacity-generation";
const BUCKET = "quick-chat-capacity-bucket";
const CWD = "/fixture/quick-chat";
const OWNER_SESSION: QuickChatSessionRef = {
  key: "fixture-owner@@fixture-tab",
  ownerBucket: "fixture-owner",
  tabId: "fixture-tab",
  sessionId: OWNER,
  bucket: BUCKET,
  cwd: CWD,
  sourceSessionId: null,
  contextMode: "blank",
  status: "ready",
  creationNonce: CLAIM,
};
const storage = new MemoryStorage();
const originals = new Map(
  ["localStorage", "FileReader", "window", "crypto"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);
const staged: Array<{ input: Record<string, any>; result: ReturnType<typeof deferred<any>> }> = [];
let root: Root | null = null;
let container: HTMLElement | null = null;
const sent: Array<{ text: string; options: Record<string, any> | undefined }> = [];
function ObservedChatView(props: React.ComponentProps<typeof ActualChatView>) {
  chatProps = props;
  return <ActualChatView {...props} />;
}
function ControlledParent() {
  const [draft, setDraft] = React.useState("");
  const [session, setSession] = React.useState<QuickChatSessionRef | null>(OWNER_SESSION);
  const sessions = React.useRef<Record<string, QuickChatSessionRef>>({});
  sessions.current = session ? { [session.key]: session } : {};
  const imageOwner = useQuickChatImages(sessions);
  const composer = session ? imageOwner.forSession(session) : null;
  const retireImages = () =>
    imageOwner.setAttachments((current) => {
      const { [BUCKET]: _retired, ...rest } = current;
      return rest;
    });
  return (
    <>
      <button
        data-quick-chat-owner="close"
        onClick={() => {
          setSession(null);
          retireImages();
        }}
      >
        Close fixture QuickChat
      </button>
      <button
        data-quick-chat-owner="restart"
        onClick={() => {
          setSession((current) => ({
            ...OWNER_SESSION,
            creationNonce: `${current?.creationNonce ?? CLAIM}-restarted`,
          }));
          retireImages();
        }}
      >
        Restart fixture QuickChat
      </button>
      {session && composer && (
        <QuickChatPanel
          chatComponent={ObservedChatView}
          sessionId={OWNER}
          creationNonce={session.creationNonce}
          cwd={CWD}
          messages={[]}
          busy={false}
          creationStatus="ready"
          contextMode="blank"
          draft={draft}
          onDraftChange={setDraft}
          attachments={composer.attachments}
          onAttachmentsChange={composer.setAttachments}
          imageComposer={composer}
          permissionMode="plan"
          modelOptions={[
            { key: "fixture-vision", label: "Vision", provider: "fixture", supportsVision: true },
          ]}
          activeModelKey="fixture-vision"
          onPermissionChange={() => undefined}
          onModelChange={() => undefined}
          onSend={(text, options) => sent.push({ text, options })}
          onStop={denied}
          onRetry={denied}
          onUseBlank={denied}
        />
      )}
    </>
  );
}
function installBridge() {
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    writable: true,
    value: {
      platform: "linux",
      log: () => undefined,
      sttAvailable: async () => ({ available: false }),
      listPluginCommands: async () => [],
      getConfigurationSettings: async () => ({}),
      getSettings: async () => ({}),
      getSessionGitStatus: async () => ({ branch: "main", entries: [], clean: true }),
      stageAttachmentImageDataUrl(input: Record<string, any>) {
        const result = deferred<any>();
        staged.push({ input, result });
        return result.promise;
      },
      readImageDataUrl: denied,
      run: denied,
      send: denied,
      spawn: denied,
      fork: denied,
      transcribeAudio: denied,
    },
  });
}
function imageMeta(input: Record<string, any>, index: number) {
  return {
    id: `owned-image-${index}`,
    kind: "image",
    name: input.name,
    mime: input.mime,
    sessionId: input.sessionId,
    origin: input.origin,
    path: `.code-shell/attachments/${input.sessionId}/image-${index}.png`,
    absPath: `${CWD}/.code-shell/attachments/${input.sessionId}/image-${index}.png`,
    size: 1,
    sha256: "a".repeat(64),
    createdAt: 1,
  };
}
async function settle() {
  await flushMicrotasks();
  await flushMicrotasks();
}
async function pick(name: string) {
  await act(async () => {
    propsOf(find((props) => props.type === "file")).onChange({
      target: { files: [new File(["x"], name, { type: "image/png" })], value: name },
    });
    await settle();
  });
}
beforeEach(async () => {
  ensureMiniDom();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "FileReader", {
    configurable: true,
    writable: true,
    value: ControlledFileReader,
  });
  let uuid = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      subtle: { digest: async () => new Uint8Array(32).buffer },
    },
  });
  storage.clear();
  staged.length = 0;
  sent.length = 0;
  ControlledFileReader.reads.length = 0;
  chatProps = null;
  installBridge();
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root?.render(<ControlledParent />);
    await settle();
  });
  expect(chatProps?.variant).toBe("quickChat");
  expect(chatProps?.onBeginAttachmentSelection).toBeUndefined();
  expect(chatProps?.configurationTarget).toEqual({ sessionId: OWNER });
  expect(chatProps?.configurationAvailable).toBe(true);
  expect(chatProps?.conversationRoot).toBe(CWD);
  expect(chatProps?.attachments).toEqual([]);
  expect(chatProps?.imageDetail === undefined || chatProps?.imageDetail === "high").toBe(true);
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await settle();
  });
  root = null;
  container = null;
  storage.clear();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
afterAll(() => {
  mock.restore();
  Object.assign(children, originalChildren);
  process.kill = originalKill;
  syncBuiltinESMExports();
  globalThis.fetch = originalFetch;
  if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
  else Reflect.deleteProperty(globalThis, "Worker");
  if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
  else Reflect.deleteProperty(globalThis, "WebSocket");
  expect(deniedCalls).toEqual([]);
});

// All images enter through the actual file-input handler. ControlledParent
// uses the production QuickChat owner hook; no capacity updater is reimplemented.
function attachments(): Array<Record<string, any>> {
  return JSON.parse(JSON.stringify(chatProps?.attachments ?? []));
}
function expectOriginals(original: Array<Record<string, any>>) {
  const current = attachments();
  for (const previous of original) {
    expect(current.find((image) => image.id === previous.id)).toEqual(previous);
  }
}
async function seedCompletedImages(count: number) {
  for (let index = 0; index < count; index++) {
    const readStart = ControlledFileReader.reads.length;
    const stageStart = staged.length;
    await pick(`seed-${index}.png`);
    expect(ControlledFileReader.reads).toHaveLength(readStart + 1);
    expect(staged).toHaveLength(stageStart);
    await act(async () => {
      ControlledFileReader.reads[readStart].finish();
      await settle();
    });
    expect(staged).toHaveLength(stageStart + 1);
    expect(staged[stageStart].input.sessionId).toBe(OWNER);
    expect(staged[stageStart].input.quickChatClaimId).toBe(CLAIM);
    await act(async () => {
      staged[stageStart].result.resolve(imageMeta(staged[stageStart].input, stageStart));
      await settle();
    });
    expect(attachments()).toHaveLength(index + 1);
  }
  return attachments();
}
async function startParallelPair() {
  const readStart = ControlledFileReader.reads.length;
  const stageStart = staged.length;
  const onChange = propsOf(find((props) => props.type === "file")).onChange;
  expect(typeof onChange).toBe("function");
  // Both calls use the same committed render; neither controlled read finishes
  // before the second selection begins.
  await act(async () => {
    for (const name of ["parallel-first.png", "parallel-second.png"]) {
      onChange({
        target: { files: [new File(["x"], name, { type: "image/png" })], value: name },
      });
    }
    await settle();
  });
  return { readStart, stageStart };
}
async function finishCreatedPair(start: { readStart: number; stageStart: number }) {
  // Two finite inputs can each create at most one reader and stage. A correct
  // reservation may reject before either step, or defer a step behind the first
  // reply. Drain only actually created work over these two bounded passes.
  const completedStages = new Set<object>();
  for (let pass = 0; pass < 2; pass++) {
    await act(async () => {
      for (const reader of ControlledFileReader.reads.slice(start.readStart)) {
        if (!reader.finished) reader.finish();
      }
      await settle();
    });
    const requests = staged.slice(start.stageStart);
    for (let index = requests.length - 1; index >= 0; index--) {
      const request = requests[index];
      if (completedStages.has(request)) continue;
      completedStages.add(request);
      await act(async () => {
        request.result.resolve(imageMeta(request.input, start.stageStart + index));
        await settle();
      });
    }
  }
  const readers = ControlledFileReader.reads.slice(start.readStart);
  const requests = staged.slice(start.stageStart);
  const returned = requests.map((request, offset) =>
    imageMeta(request.input, start.stageStart + offset),
  );
  return { readers, requests, returned };
}
function recordObservation(
  name: string,
  original: Array<Record<string, any>>,
  result: Awaited<ReturnType<typeof finishCreatedPair>>,
) {
  const observation = {
    name,
    readerCount: result.readers.length,
    readerNames: result.readers.map((reader) => reader.file?.name),
    stageCount: result.requests.length,
    stageInputs: result.requests.map(({ input }) => ({
      sessionId: input.sessionId,
      name: input.name,
      origin: input.origin,
      quickChatClaimId: input.quickChatClaimId,
    })),
    original,
    final: attachments(),
    visibleOverflow: renderedText().includes("最多 6 张图片"),
  };
  // Preserve actual quantities and state in the guarded raw log before any
  // desired overflow assertion. This is not native or Main evidence.
  console.log("QUICK_CHAT_QUANTITY_OBSERVATION " + JSON.stringify(observation));
  return observation;
}

test("parallel picks cannot overflow the six-image composer limit", async () => {
  const original = await seedCompletedImages(5);
  const start = await startParallelPair();
  const result = await finishCreatedPair(start);
  const observation = recordObservation("overflow-from-five", original, result);
  expect(result.readers.length).toBeLessThanOrEqual(2);
  expect(result.requests.length).toBeLessThanOrEqual(2);
  expectOriginals(original);
  expect(chatProps?.configurationTarget).toEqual({ sessionId: OWNER });
  expect(observation.final.length).toBeLessThanOrEqual(6);
  expect(observation.visibleOverflow).toBe(true);
});

test("serial sixth succeeds and seventh is refused before reading", async () => {
  const original = await seedCompletedImages(5);
  const readStart = ControlledFileReader.reads.length;
  const stageStart = staged.length;
  await pick("serial-sixth.png");
  expect(ControlledFileReader.reads).toHaveLength(readStart + 1);
  await act(async () => {
    ControlledFileReader.reads[readStart].finish();
    await settle();
  });
  expect(staged).toHaveLength(stageStart + 1);
  const sixth = imageMeta(staged[stageStart].input, stageStart);
  await act(async () => {
    staged[stageStart].result.resolve(sixth);
    await settle();
  });
  const six = attachments();
  expect(six).toHaveLength(6);
  expectOriginals(original);
  expect(six.find((image) => image.id === sixth.id)?.name).toBe("serial-sixth.png");
  const seventhStart = {
    readStart: ControlledFileReader.reads.length,
    stageStart: staged.length,
  };
  await pick("serial-seventh.png");
  const result = await finishCreatedPair(seventhStart);
  const observation = recordObservation("serial-seventh", six, result);
  expect(result.readers).toHaveLength(0);
  expect(result.requests).toHaveLength(0);
  expect(attachments()).toEqual(six);
  expect(observation.visibleOverflow).toBe(true);
});

test("a concurrent pair within capacity retains both independent results", async () => {
  const original = await seedCompletedImages(4);
  const start = await startParallelPair();
  const result = await finishCreatedPair(start);
  const observation = recordObservation("under-capacity-from-four", original, result);
  expect(result.readers).toHaveLength(2);
  expect(result.requests).toHaveLength(2);
  expect(result.requests.map(({ input }) => input.sessionId)).toEqual([OWNER, OWNER]);
  expect(result.requests.map(({ input }) => input.quickChatClaimId)).toEqual([CLAIM, CLAIM]);
  expectOriginals(original);
  expect(observation.final).toHaveLength(6);
  for (const meta of result.returned) {
    const { kind: _kind, ...expected } = meta;
    expect(observation.final.find((image) => image.id === meta.id)).toMatchObject(expected);
  }
  expect(new Set(observation.final.map((image) => image.id)).size).toBe(6);
  expect(observation.visibleOverflow).toBe(false);
});

test("sending an empty-image draft invalidates a pending old batch without closing its owner", async () => {
  await pick("pending-before-send.png");
  expect(ControlledFileReader.reads).toHaveLength(1);
  await act(async () => {
    ControlledFileReader.reads[0].finish();
    await settle();
  });
  expect(staged).toHaveLength(1);
  expect(attachments()).toEqual([]);
  const textarea = find((props) => typeof props.onKeyDown === "function" && props.rows === 1);
  await act(async () => {
    propsOf(textarea).onChange({ target: { value: "send this draft", selectionStart: 15 } });
    await settle();
  });
  await act(async () => {
    propsOf(textarea).onKeyDown({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
    await settle();
  });
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toBe("send this draft");
  expect(sent[0].options?.attachments).toEqual([]);
  expect(chatProps?.draft).toBe("");
  await act(async () => {
    staged[0].result.resolve(imageMeta(staged[0].input, 0));
    await settle();
  });
  expect(attachments()).toEqual([]);
  expect(chatProps?.imageComposer?.attachmentError).toBeNull();
  const current = await seedCompletedImages(1);
  expect(current).toHaveLength(1);
  expect(current[0].id).toBe("owned-image-1");
  expect(chatProps?.configurationTarget).toEqual({ sessionId: OWNER });
});

test("removing one image releases latest capacity for both pending results under StrictMode", async () => {
  await act(async () => {
    root?.render(
      <React.StrictMode>
        <ControlledParent />
      </React.StrictMode>,
    );
    await settle();
  });
  const original = await seedCompletedImages(5);
  const start = await startParallelPair();
  await act(async () => {
    propsOf(find((props) => props["aria-label"] === "移除 seed-4.png")).onClick();
    await settle();
  });
  expect(attachments()).toHaveLength(4);
  const result = await finishCreatedPair(start);
  const observation = recordObservation(
    "remove-frees-latest-capacity",
    original.slice(0, 4),
    result,
  );
  expect(result.requests).toHaveLength(2);
  expectOriginals(original.slice(0, 4));
  expect(observation.final).toHaveLength(6);
  expect(observation.final.some((image) => image.id === original[4].id)).toBe(false);
  expect(new Set(observation.final.map((image) => image.id)).size).toBe(6);
  for (const returned of result.returned) {
    expect(observation.final.filter((image) => image.id === returned.id)).toHaveLength(1);
  }
  expect(observation.visibleOverflow).toBe(false);
});

test("closed and restarted QuickChat generations reject old success and error results", async () => {
  const start = await startParallelPair();
  await act(async () => {
    for (const reader of ControlledFileReader.reads) reader.finish();
    await settle();
  });
  expect(staged).toHaveLength(2);
  await act(async () => {
    propsOf(find((props) => props["data-quick-chat-owner"] === "close")).onClick();
    await settle();
  });
  await act(async () => {
    staged[start.stageStart].result.resolve(imageMeta(staged[start.stageStart].input, 0));
    await settle();
  });
  expect(descendants(container).some((node) => propsOf(node).type === "file")).toBe(false);
  await act(async () => {
    propsOf(find((props) => props["data-quick-chat-owner"] === "restart")).onClick();
    await settle();
  });
  expect(chatProps?.imageComposer?.attachments).toEqual([]);
  await act(async () => {
    staged[start.stageStart + 1].result.reject(new Error("old closed owner must not report here"));
    await settle();
  });
  expect(attachments()).toEqual([]);
  expect(chatProps?.imageComposer?.attachmentError).toBeNull();
  expect(renderedText()).not.toContain("old closed owner must not report here");
  const beforeRestart = await startParallelPair();
  await act(async () => {
    for (const reader of ControlledFileReader.reads.slice(beforeRestart.readStart)) reader.finish();
    await settle();
  });
  expect(staged).toHaveLength(4);
  expect(staged[2].input.quickChatClaimId).toBe(`${CLAIM}-restarted`);
  // Unlike close, this ready -> ready transition keeps the same ChatView
  // mounted. Old results must be rejected by the exact nonce, not unmount.
  await act(async () => {
    propsOf(find((props) => props["data-quick-chat-owner"] === "restart")).onClick();
    await settle();
  });
  await act(async () => {
    staged[2].result.resolve(imageMeta(staged[2].input, 2));
    staged[3].result.reject(new Error("previous ready nonce must not report here"));
    await settle();
  });
  expect(attachments()).toEqual([]);
  expect(chatProps?.imageComposer?.attachmentError).toBeNull();
  expect(renderedText()).not.toContain("previous ready nonce must not report here");
  await pick("restarted-owner.png");
  await act(async () => {
    ControlledFileReader.reads[4].finish();
    await settle();
  });
  expect(staged).toHaveLength(5);
  expect(staged[4].input.quickChatClaimId).toBe(`${CLAIM}-restarted-restarted`);
  await act(async () => {
    staged[4].result.resolve(imageMeta(staged[4].input, 4));
    await settle();
  });
  expect(attachments().map((image) => image.id)).toEqual(["owned-image-4"]);
});
