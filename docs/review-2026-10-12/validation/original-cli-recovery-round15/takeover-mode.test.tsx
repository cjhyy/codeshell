import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import net from "node:net";
import tls from "node:tls";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-"))
  throw Error("guarded isolated HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard("http://127.0.0.1:9");
const deny = () => { throw Error("NETWORK_FORBIDDEN_round15"); };
net.connect = net.createConnection = deny as any;
tls.connect = deny as any;
const { default: ts } = await import(`${repo}/node_modules/typescript/lib/typescript.js`);
const { RoomManager } = await import(`${repo}/packages/server/src/mobile-remote/room-manager.ts`);
const { encodeCwd } = await import(`${repo}/packages/coding/dist/cc-orchestrator/index.js`);
const { resolveLinkedSessionFromDisk } = await import(`${repo}/packages/desktop/src/main/cc-room/linked-session-resolver.ts`);
const { openLinkedSessionFromIpc, takeOverLinkedSessionFromIpc } = await import(`${repo}/packages/desktop/src/main/cc-room/linked-session-ipc.ts`);
const { getProjectStore, __resetProjectStoreForTest } = await import(`${repo}/packages/desktop/src/main/project-store.ts`);
const { requireRendererProjectPath } = await import(`${repo}/packages/desktop/src/main/renderer-project-path.ts`);
const { writeSettings } = await import(`${repo}/packages/desktop/src/main/settings-service.ts`);
const { resolveRoomPermissionMode } = await import(`${repo}/packages/desktop/src/main/mobile-remote/handle-room-event.ts`);
const { createRoot } = await import(`${repo}/packages/desktop/node_modules/react-dom/client`);
const { ensureMiniDom, flushMicrotasks } = await import(`${repo}/packages/desktop/src/renderer/test-utils/renderHook.tsx`);
const { CCRoomView } = await import(`${repo}/packages/desktop/src/renderer/cc-room/CCRoomView.tsx`);
ensureMiniDom();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
const proto = Object.getPrototypeOf(document.createElement("div"));
if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
let root: any, container: any, temporary = "", manager: any;
const nodes = (node: any): any[] => [node, ...Array.from(node?.childNodes ?? []).flatMap(nodes)];
function props(node: any): any {
  const key = Object.keys(node).find(k => k.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function text(node: any): string {
  return node.nodeType === 3 ? node.nodeValue ?? node.textContent ?? "" : Array.from(node.childNodes ?? []).map(text).join("") || (typeof node.textContent === "string" ? node.textContent : "");
}
const settle = async () => { await flushMicrotasks(); await new Promise(r => setTimeout(r, 0)); await flushMicrotasks(); };
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw Error("fixture wait: " + text(container)); await act(settle); }
}
async function click(node: any) {
  expect(node).toBeDefined();
  await act(async () => { props(node).onClick(); await settle(); });
}
function mainHandler(channel: string, scope: any) {
  const source = ts.createSourceFile("index.ts", readFileSync(`${repo}/packages/desktop/src/main/index.ts`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let callback: any;
  function visit(node: any) {
    if (ts.isCallExpression(node) && node.arguments[0]?.getText(source) === JSON.stringify(channel)) callback = node.arguments.find((a: any) => ts.isArrowFunction(a));
    ts.forEachChild(node, visit);
  }
  visit(source); expect(callback).toBeDefined();
  const js = ts.transpileModule(`const handler = ${callback.getText(source)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return runInNewContext(`${js}\nhandler`, scope);
}
async function fixture() {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-cli-takeover-round15-")));
  const cwd = join(temporary, "project"), claudeHome = join(temporary, "owned-claude"), sid = "owned-linked-session";
  mkdirSync(cwd);
  const transcriptDir = join(claudeHome, "projects", encodeCwd(cwd));
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(join(transcriptDir, `${sid}.jsonl`), JSON.stringify({ type: "user", cwd, sessionId: sid, message: { role: "user", content: "owned transcript" } }) + "\n");
  const project = await getProjectStore().createFromPath(cwd);
  expect(await requireRendererProjectPath(cwd)).toBe(cwd);
  await writeSettings("user", { externalAgents: { claudeCode: { trustedWorkspaces: [cwd] } } });
  expect(await resolveRoomPermissionMode(cwd, "bypassPermissions")).toBe("bypassPermissions");
  const agents: any[] = [];
  manager = new RoomManager({
    rootDir: join(temporary, "rooms"),
    resolveLinkedSession: (target: any) => resolveLinkedSessionFromDisk(target, { claudeHome }),
    createAgent: (meta: any, emit: any) => {
      const agent = { mode: meta.permissionMode, running: false, stopped: 0, sent: [] as string[], emit,
        start() { this.running = true; }, stop() { this.running = false; this.stopped++; },
        isRunning() { return this.running; }, send(s: string) { this.sent.push(s); return this.running; } };
      agents.push(agent); return agent;
    },
    onMessage() {},
  });
  const scope = { roomManager: manager, requireRendererProjectPath, openLinkedSessionFromIpc, takeOverLinkedSessionFromIpc };
  const openLinked = mainHandler("ccRoom:openLinkedSession", scope), takeover = mainHandler("ccRoom:takeOverLinkedSession", scope), open = mainHandler("ccRoom:openSession", scope);
  let linkedRoom = "", probeCalls = 0;
  Object.defineProperty(window, "codeshell", { configurable: true, value: { ccRoom: {
    openLinkedSession: async (...args: any[]) => { const result = await openLinked({}, ...args); linkedRoom = result.roomId; return result; },
    takeOverLinkedSession: (...args: any[]) => takeover({}, ...args),
    openSession: (...args: any[]) => open({}, ...args),
    probe: async () => { probeCalls++; return { available: true }; },
    codexProbe: async () => { probeCalls++; return { available: true }; },
    onApprovalRequest: () => () => {}, onApprovalResolved: () => () => {}, onRoomMessage: () => () => {},
    subscribeTranscript: async () => ({ messages: [], roomCursor: 0, active: true }),
    unsubscribeTranscript: async () => undefined, roomHistory: async () => [],
    readHistory: async () => ({ messages: [] }), readCodexHistory: async () => ({ messages: [] }),
    send: async (id: string, value: string) => manager.send(id, value),
  } } });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root.render(<CCRoomView cwd={cwd} openRequest={{ nonce: 1, externalSessionId: sid, cwd, cliKind: "claude-code" }} />); await settle(); });
  await until(() => nodes(container).some(n => props(n)["data-cc-room-takeover"]));
  expect(linkedRoom).toBeTruthy(); expect(agents).toHaveLength(0); expect(probeCalls).toBe(0);
  expect(manager.getRoom(linkedRoom).linkedSessionMode).toBe("observe-only");
  return { cwd, sid, project, agents, open, takeover, roomId: linkedRoom, probeCount: () => probeCalls };
}
afterEach(async () => {
  if (root) await act(async () => { root.unmount(); await settle(); });
  root = undefined; container?.parentNode?.removeChild(container); container = undefined;
  manager?.closeAll(); manager = undefined; __resetProjectStoreForTest();
  if (temporary) rmSync(temporary, { recursive: true, force: true }); temporary = "";
});

test("CANDIDATE stale observer takeover resets metadata/header to default but retains the concurrently reopened bypass agent", async () => {
  const f = await fixture();
  await f.takeover({}, f.roomId, f.sid, f.cwd, "claude-code");
  expect(f.agents).toHaveLength(1); expect(f.agents[0].mode).toBe("default");
  await f.open({}, f.sid, f.cwd, "bypassPermissions", "claude-code");
  expect(f.agents).toHaveLength(2); expect(f.agents[0].stopped).toBe(1); expect(f.agents[1].mode).toBe("bypassPermissions");
  expect(manager.getRoom(f.roomId).permissionMode).toBe("bypassPermissions");
  const takeoverButton = nodes(container).find(n => props(n)["data-cc-room-takeover"]);
  expect(props(takeoverButton).disabled).toBe(false);
  await click(takeoverButton);
  await until(() => !nodes(container).some(n => props(n)["data-cc-room-takeover"]));
  expect(text(container)).toContain("· default");
  expect(manager.getRoom(f.roomId).permissionMode).toBe("default");
  expect(f.agents).toHaveLength(2); expect(f.agents[1].stopped).toBe(0); expect(f.agents[1].isRunning()).toBe(true);
  const composer = nodes(container).find(n => props(n)["data-cc-room-composer"] !== undefined);
  expect(props(composer).disabled).toBe(false);
  await act(async () => { props(composer).onChange({ target: { value: "owned fixture next turn" } }); await settle(); });
  await act(async () => { props(composer).onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {}, nativeEvent: {} }); await settle(); });
  expect(f.agents[1].sent).toEqual(["owned fixture next turn"]);
  expect(f.agents[1].mode).toBe("bypassPermissions");
  await f.open({}, f.sid, f.cwd, "default", "claude-code");
  expect(f.agents).toHaveLength(2); expect(f.agents[1].stopped).toBe(0); expect(f.agents[1].mode).toBe("bypassPermissions");
  await f.open({}, f.sid, f.cwd, "acceptEdits", "claude-code");
  expect(f.agents).toHaveLength(3); expect(f.agents[1].stopped).toBe(1); expect(f.agents[2].mode).toBe("acceptEdits");
  await f.open({}, f.sid, f.cwd, "default", "claude-code");
  expect(f.agents).toHaveLength(4); expect(f.agents[2].stopped).toBe(1); expect(f.agents[3].mode).toBe("default");
  console.log(JSON.stringify({ candidate: "concurrent-linked-takeover-mode", actualRoomViewAndConversation: true, actualMainCallbacks: true, actualProjectAndDiskIdentity: true, explicitlyTrustedCwd: true, headerAndStoredModeAfterTakeover: "default", currentAgentModeAfterTakeover: f.agents[1].mode, replacementAfterTakeover: false, reopenDefaultDoesNotRestart: true, acceptEditsThenDefaultRestartsAndRecovers: true, nativeCliStarted: false }));
});

test("CONTROL cold takeover uses default, active default takeover is idempotent, and mismatched cwd cannot take control", async () => {
  const f = await fixture();
  await click(nodes(container).find(n => props(n)["data-cc-room-takeover"]));
  await until(() => !nodes(container).some(n => props(n)["data-cc-room-takeover"]));
  expect(text(container)).toContain("· default"); expect(f.agents).toHaveLength(1); expect(f.agents[0].mode).toBe("default");
  expect(await f.takeover({}, f.roomId, f.sid, f.cwd, "claude-code")).toMatchObject({ status: "running", mode: "default" });
  expect(f.agents).toHaveLength(1);
  await expect(f.takeover({}, f.roomId, f.sid, join(temporary, "unregistered"), "claude-code")).rejects.toThrow(/project path/);
  await expect(f.takeover({}, f.roomId, "different-session", f.cwd, "claude-code")).rejects.toThrow(/transcript/);
  expect(f.agents).toHaveLength(1); expect(f.probeCount()).toBe(0);
  console.log(JSON.stringify({ control: "linked-takeover-default-and-identity", noProbeOnObserve: true, coldDefaultAgent: true, activeDefaultNoRestart: true, staleIdentityRejected: true }));
});
