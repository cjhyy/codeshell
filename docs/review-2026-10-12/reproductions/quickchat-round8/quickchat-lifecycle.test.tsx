import { fileURLToPath } from "node:url";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Install the guard before product-facing dynamic imports. No Main entrypoint, worker, provider,
// Electron process, hardware or outside document is launched.
await import("./network-guard.ts");
const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const { createRoot } = await import(`${workspace}/packages/desktop/node_modules/react-dom/client.js`);
const { ensureMiniDom, flushMicrotasks } = await import(`${workspace}/packages/desktop/src/renderer/test-utils/renderHook.tsx`);
const { ChatView } = await import(`${workspace}/packages/desktop/src/renderer/ChatView.tsx?round8-real`);
const { QuickChatPanel } = await import(`${workspace}/packages/desktop/src/renderer/panels/QuickChatPanel.tsx?round8-real`);
const { FilesPanel } = await import(`${workspace}/packages/desktop/src/renderer/panels/FilesPanel.tsx?round8-real`);
const { QuickChatOwnershipRegistry } = await import(`${workspace}/packages/desktop/src/main/quick-chat-ownership.ts`);
const { quickChatRunRequest } = await import(`${workspace}/packages/desktop/src/main/agent-bridge-fallback.ts`);

const observations: unknown[] = [];
let root: any = null;
let container: any;
const readerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
function descendants(node: any): any[] {
  return Array.from(node?.childNodes ?? []).flatMap((child: any) => [child, ...descendants(child)]);
}
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find(k => k.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function find(predicate: (p: any) => boolean) {
  const node = descendants(container).find(n => predicate(props(n)));
  if (!node) throw new Error("rendered element missing");
  return node;
}
async function tick(callback: () => void = () => {}) {
  await act(async () => { callback(); await flushMicrotasks(); });
}
async function type(text: string) {
  await tick(() => props(find(p => p.rows === 1)).onChange({ target: { value: text, selectionStart: text.length } }));
}
async function enter(extra: Record<string, unknown> = {}) {
  await tick(() => props(find(p => p.rows === 1)).onKeyDown({
    key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false,
    nativeEvent: { isComposing: false }, preventDefault() {}, ...extra,
  }));
}
async function drop(files: unknown[]) {
  await tick(() => props(find(p => p["data-chat-variant"] === "quickChat")).onDrop({
    preventDefault() {}, dataTransfer: { files, getData: () => "" },
  }));
}
async function mount(options: { codeshell?: any; holdBusy?: boolean } = {}) {
  ensureMiniDom();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => null, setItem() {}, removeItem() {},
  } });
  Object.defineProperty(window, "codeshell", { configurable: true, writable: true, value: {
    sttAvailable: async () => ({ available: false }),
    getPathForFile: (file: any) => file.path ?? "",
    ...options.codeshell,
  }});
  container = document.createElement("div");
  root = createRoot(container);
  const sent: any[] = [];
  let control: any;
  function Host() {
    const [draft, setDraft] = React.useState("");
    const [attachments, setAttachments] = React.useState<any[]>([]);
    const [busy, setBusy] = React.useState(false);
    const [shown, setShown] = React.useState(true);
    const [open, setOpen] = React.useState(true);
    const [identity, setIdentity] = React.useState("qchat-round8-one");
    const [status, setStatus] = React.useState("ready");
    control = { draft, attachments, busy, identity, status, setBusy, setShown, setOpen, setStatus,
      reopen() { setDraft(""); setAttachments([]); setIdentity("qchat-round8-two"); setOpen(true); } };
    return <div style={{ display: shown ? "block" : "none" }}>
      {open && <QuickChatPanel chatComponent={ChatView} sessionId={identity} creationNonce={`claim-${identity}`}
        messages={[]} cwd="/tmp/synthetic-project" busy={busy} creationStatus={status} creationError="synthetic fork failure"
        contextMode="full" copiedEventCount={0} draft={draft} attachments={attachments}
        permissionMode="plan" onPermissionChange={() => {}} modelOptions={[{
          key: "fixture-vision", label: "Fixture", provider: "synthetic", supportsVision: true,
        }]} activeModelKey="fixture-vision" onModelChange={() => {}}
        onDraftChange={setDraft} onAttachmentsChange={setAttachments}
        onSend={(text: string, opts: unknown) => { sent.push({ text, opts, identity }); if (options.holdBusy) setBusy(true); }}
        onStop={() => setBusy(false)} onRetry={() => setStatus("creating")} onUseBlank={() => setStatus("ready")}
      />}
    </div>;
  }
  await tick(() => root?.render(<Host />));
  return { sent, control: () => control };
}
afterEach(async () => {
  if (root) await tick(() => root?.unmount());
  root = null;
  if (readerDescriptor) Object.defineProperty(globalThis, "FileReader", readerDescriptor);
  else Reflect.deleteProperty(globalThis, "FileReader");
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
afterAll(() => writeFileSync(new URL("./observations.json", import.meta.url), JSON.stringify(observations, null, 2)));

test("separate Enter events submit once; busy retains a follow-up; stopped composer submits it", async () => {
  const h = await mount({ holdBusy: true });
  await type("first side task"); await enter(); await enter();
  expect(h.sent).toHaveLength(1); expect(h.control().draft).toBe(""); expect(h.control().busy).toBe(true);
  await type("follow-up survives"); await enter();
  expect(h.sent).toHaveLength(1); expect(h.control().draft).toBe("follow-up survives");
  await tick(() => h.control().setBusy(false)); await enter();
  expect(h.sent).toHaveLength(2); expect(h.sent[1].text).toBe("follow-up survives");
  observations.push({ scenario: "Enter-busy-stop-resubmit", sent: h.sent.length, busyDraftPreserved: true });
});
test("IME and shifted Enter preserve the draft; empty Enter is inert", async () => {
  const h = await mount();
  await enter(); await type("composing");
  await enter({ nativeEvent: { isComposing: true } }); await enter({ shiftKey: true });
  expect(h.sent).toHaveLength(0); expect(h.control().draft).toBe("composing");
  await enter(); expect(h.sent).toHaveLength(1);
  observations.push({ scenario: "IME-Shift-Enter", nonSubmitEvents: 3 });
});
test("same mounted Panel hidden/revealed retains draft and a dropped PDF in the same child session", async () => {
  const h = await mount(); await type("inspect this");
  await drop([{ name: "fixture.pdf", type: "application/pdf", path: "/tmp/synthetic/fixture.pdf" }]);
  await tick(() => h.control().setShown(false)); await tick(() => h.control().setShown(true));
  expect(h.control().draft).toBe("inspect this");
  expect(find(p => p["data-local-path-attachments"] === "true")).toBeDefined();
  await enter();
  expect(h.sent).toHaveLength(1); expect(h.sent[0].text).toContain("/tmp/synthetic/fixture.pdf");
  expect(h.sent[0].identity).toBe("qchat-round8-one"); expect(h.control().draft).toBe("");
  expect(descendants(container).some(n => props(n)["data-local-path-attachments"] === "true")).toBe(false);
  observations.push({ scenario: "hidden-reveal-PDF", identity: h.sent[0].identity, pathSent: true, composerCleared: true });
});
test("close unmounts local path state; explicit reopen starts a new child identity", async () => {
  const h = await mount(); await type("old draft");
  await drop([{ name: "fixture.pdf", type: "application/pdf", path: "/tmp/synthetic/fixture.pdf" }]);
  await tick(() => h.control().setOpen(false)); await tick(() => h.control().reopen());
  expect(h.control().draft).toBe(""); expect(h.control().identity).toBe("qchat-round8-two");
  expect(descendants(container).some(n => props(n)["data-local-path-attachments"] === "true")).toBe(false);
  await enter(); expect(h.sent).toHaveLength(0);
  observations.push({ scenario: "close-reopen", oldPathAbsent: true, newIdentity: h.control().identity });
});
test("fork creation/error gates the composer and offers retry or blank recovery", async () => {
  const h = await mount();
  await tick(() => h.control().setStatus("creating"));
  expect(descendants(container).some(n => props(n).rows === 1)).toBe(false);
  await tick(() => h.control().setStatus("error"));
  const retry = find(p => p.onClick && String(p.children).includes("重试"));
  const blank = find(p => p.onClick && String(p.children).includes("空白"));
  expect(retry).toBeDefined(); expect(blank).toBeDefined();
  await tick(() => props(retry).onClick()); expect(h.control().status).toBe("creating");
  await tick(() => h.control().setStatus("error"));
  await tick(() => props(find(p => p.onClick && String(p.children).includes("空白"))).onClick());
  expect(find(p => p.rows === 1)).toBeDefined();
  observations.push({ scenario: "fork-recovery", readyComposerMounted: true });
});
test("Main ownership tombstones an in-flight image stage and removes late bytes; closed ChatView ignores its result", async () => {
  const registry = new QuickChatOwnershipRegistry();
  const rootDir = mkdtempSync(join(tmpdir(), "round8-quickchat-stage-"));
  const sessionDir = join(rootDir, "qchat-round8-one");
  const sid = "qchat-round8-one", claim = `claim-${sid}`, owner = 101;
  registry.claim(sid, owner, claim);
  let settle!: () => void;
  const pending = new Promise<void>(resolve => { settle = resolve; });
  const stage = mock(async (request: any) => {
    expect(request.sessionId).toBe(sid); expect(request.quickChatClaimId).toBe(claim);
    expect(registry.beginOperation(sid, owner, claim)).toBe(true);
    await pending; mkdirSync(sessionDir); writeFileSync(join(sessionDir, "fixture.png"), "synthetic");
    await registry.settleOperation(sid, owner, claim, async () => rmSync(sessionDir, { recursive: true, force: true }));
    return { id: "staged", path: "fixture.png", absPath: join(sessionDir, "fixture.png"), sessionId: sid };
  });
  Object.defineProperty(globalThis, "FileReader", { configurable: true, value: class {
    result = "data:image/png;base64,YQ=="; onload: any;
    readAsDataURL() { this.onload?.(); }
  }});
  try {
    const h = await mount({ codeshell: { stageAttachmentImageDataUrl: stage } });
    await drop([{ name: "fixture.png", type: "image/png", size: 1 }]);
    expect(stage).toHaveBeenCalledTimes(1);
    const cleanup = await registry.cleanup(sid, owner, claim, async () => rmSync(sessionDir, { recursive: true, force: true }));
    expect(cleanup).toEqual({ deleted: false, deferred: true });
    await tick(() => h.control().setOpen(false)); await tick(() => h.control().reopen());
    await tick(settle);
    expect(existsSync(sessionDir)).toBe(false); expect(h.control().attachments).toHaveLength(0);
    const request = quickChatRunRequest({ jsonrpc: "2.0", id: 1, method: "agent/run", params: {
      sessionId: sid, quickChatClaimId: claim, text: "late run",
    } }, owner);
    expect(request).not.toBeNull();
    expect(registry.isClaimActive(sid, owner, claim)).toBe(false);
    observations.push({ scenario: "close-during-image-stage", mainCleanupDeferred: true, lateBytesDeleted: true,
      reopenedAttachments: h.control().attachments.length, oldRunClaimActive: false });
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("real FilesPanel image drag is silently discarded by real QuickChatPanel; PDF drag and OS image drop work", async () => {
  const stage = mock(async (request: any) => ({ id: "os-image", path: "os.png", sessionId: request.sessionId }));
  Object.defineProperty(globalThis, "FileReader", { configurable: true, value: class {
    result = "data:image/png;base64,YQ=="; onload: any;
    readAsDataURL() { this.onload?.(); }
  }});
  const h = await mount({ codeshell: {
    stageAttachmentImageDataUrl: stage,
    readProjectDir: async () => [
      { name: "source.png", path: "/tmp/synthetic-project/source.png", isDirectory: false },
      { name: "source.pdf", path: "/tmp/synthetic-project/source.pdf", isDirectory: false },
    ],
  } });
  const sourceContainer = document.createElement("div");
  const sourceRoot = createRoot(sourceContainer);
  const project = { id: "fixture-project", name: "Fixture", path: "/tmp/synthetic-project", addedAt: 1,
    primaryRootId: "fixture-root", roots: [{ id: "fixture-root", path: "/tmp/synthetic-project", name: "Fixture", addedAt: 1 }] };
  try {
    await tick(() => sourceRoot.render(<FilesPanel cwd="/tmp/synthetic-project" project={project} onAttachImage={() => {}} />));
    const sourceRows = descendants(sourceContainer).filter(n => props(n).draggable === true && props(n).onDragStart);
    expect(sourceRows).toHaveLength(2);
    async function internalDrop(row: any) {
      const values = new Map<string, string>();
      const transfer = { files: [], items: [], types: [], effectAllowed: "none",
        setData(type: string, value: string) { values.set(type, value); this.types = [...values.keys()] as never; },
        getData(type: string) { return values.get(type) ?? ""; } };
      await tick(() => props(row).onDragStart({ dataTransfer: transfer }));
      expect(transfer.getData("application/x-codeshell-path")).toContain("/tmp/synthetic-project/source.");
      await tick(() => props(find(p => p["data-chat-variant"] === "quickChat")).onDrop({ preventDefault() {}, dataTransfer: transfer }));
      return transfer;
    }
    const pngTransfer = await internalDrop(sourceRows[0]);
    expect(pngTransfer.getData("application/x-codeshell-path")).toEndWith(".png");
    expect(h.control().attachments).toHaveLength(0); expect(stage).toHaveBeenCalledTimes(0);
    expect(h.control().draft).toBe("");
    expect(descendants(container).some(n => props(n)["data-local-path-attachments"] === "true")).toBe(false);
    await internalDrop(sourceRows[1]);
    expect(find(p => p["data-local-path-attachments"] === "true")).toBeDefined();
    await enter(); expect(h.sent[0].text).toContain("source.pdf");
    await drop([{ name: "os.png", type: "image/png", size: 1 }]);
    expect(stage).toHaveBeenCalledTimes(1); expect(h.control().attachments).toHaveLength(1);
    observations.push({ scenario: "FilesPanel-image-DnD", realSourceCustomMime: true,
      internalPngAttachments: 0, internalPngStageCalls: 0, internalPdfAccepted: true, osPngAttachments: 1 });
  } finally { await tick(() => sourceRoot.unmount()); }
});
