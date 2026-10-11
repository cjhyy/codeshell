import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
const repo = process.cwd();
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw new Error("guarded HOME required");
const { installLocalNetworkGuard } = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
installLocalNetworkGuard("http://127.0.0.1:9");
const React = await import(repo + "/node_modules/react/index.js");
const { act } = React;
const { createRoot } = await import(repo + "/packages/desktop/node_modules/react-dom/client");
const { ensureMiniDom, flushMicrotasks } = await import(repo + "/packages/desktop/src/renderer/test-utils/renderHook.tsx");
const { default: ts } = await import(repo + "/node_modules/typescript/lib/typescript.js");
const service = await import(repo + "/packages/desktop/src/main/pty-service.ts");
const { requireRendererProjectPath } = await import(repo + "/packages/desktop/src/main/renderer-project-path.ts");

const terminals: FakeTerminal[] = [];
class FakeTerminal {
  cols = 80; rows = 24; buffer = { active: { getLine: () => undefined } };
  output = ""; disposed = false; input?: (value: string) => void;
  constructor() { terminals.push(this); }
  loadAddon() {} open() {} focus() {}
  write(value: string) { if (this.disposed) throw new Error("write after xterm dispose"); this.output += value; }
  dispose() { this.disposed = true; }
  onData(fn: (value: string) => void) { this.input = fn; return { dispose: () => { this.input = undefined; } }; }
  registerLinkProvider() { return { dispose() {} }; }
}
mock.module("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
mock.module("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
const { TerminalPanel } = await import(repo + "/packages/desktop/src/renderer/panels/TerminalPanel.tsx");
const { PanelArea } = await import(repo + "/packages/desktop/src/renderer/panels/PanelArea.tsx");

let root: any, container: any, temporary = "";
afterEach(async () => {
  if (root) await act(async () => { root.unmount(); await flushMicrotasks(); });
  root = undefined;
  if (container?.parentNode) container.parentNode.removeChild(container);
  container = undefined;
  service.ptyKillAll(); service._setPtyForTest(null);
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = ""; terminals.length = 0;
});
function nodes(node: any): any[] { return [node, ...Array.from(node?.childNodes ?? []).flatMap(nodes)]; }
function props(node: any) { const key = Object.keys(node).find(k => k.startsWith("__reactProps$")); return key ? node[key] : {}; }
const settle = async () => { await flushMicrotasks(); await new Promise(r => setTimeout(r, 0)); await flushMicrotasks(); };
async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) { if (Date.now() > end) throw new Error("terminal lifecycle did not settle"); await act(settle); }
}
function transpile(expression: string, globals: any) {
  const js = ts.transpileModule("const result = " + expression, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return runInNewContext(js + "\nresult", globals);
}
function ipcHandler(channel: string, globals: any) {
  const source = ts.createSourceFile("index.ts", readFileSync(repo + "/packages/desktop/src/main/index.ts", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: any;
  function walk(n: any) { if (ts.isCallExpression(n) && n.arguments[0]?.getText(source) === JSON.stringify(channel)) found = n.arguments.find((a: any) => ts.isArrowFunction(a)); ts.forEachChild(n, walk); }
  walk(source); if (!found) throw new Error("IPC not found: " + channel);
  return transpile(found.getText(source), globals);
}
function preloadFunction(name: string, globals: any) {
  const source = ts.createSourceFile("preload.ts", readFileSync(repo + "/packages/desktop/src/preload/index.ts", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: any;
  function walk(n: any) { if (ts.isPropertyAssignment(n) && n.name.getText(source) === name) found = n.initializer; ts.forEachChild(n, walk); }
  walk(source); if (!found) throw new Error("preload method not found: " + name);
  return transpile(found.getText(source), globals);
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

async function fixture({ failSpawn = false, delayedFirst = false } = {}) {
  ensureMiniDom();
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  Object.assign(document.documentElement, { classList: { contains: () => false } });
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-terminal-lifecycle-")));
  const fakes: any[] = [], requests: any[] = [], handlers = new Map<string, any>(), listeners = new Map<string, Set<any>>();
  let fail = failSpawn, destroyed = false;
  const wc = { id: 71, isDestroyed: () => destroyed, send(channel: string, value: any) { for (const fn of [...(listeners.get(channel) ?? [])]) fn({}, structuredClone(value)); } };
  service._setPtyForTest({ spawn() {
    if (fail) { fail = false; throw new Error("fixture shell unavailable"); }
    const p = { pid: 8100 + fakes.length, kills: 0, writes: [] as string[], resizes: [] as any[], data: undefined as any, exit: undefined as any,
      onData(fn: any) { this.data = fn; }, onExit(fn: any) { this.exit = fn; },
      write(value: string) { this.writes.push(value); }, resize(cols: number, rows: number) { this.resizes.push({ cols, rows }); }, kill() { this.kills++; } };
    fakes.push(p); return p;
  } });
  const globals = { ...service, resolveNoRepoCwd: () => temporary,
    requireRendererProjectPath: (cwd: string) => requireRendererProjectPath(cwd, { registeredPaths: [temporary] }) };
  for (const channel of ["pty:start", "pty:write", "pty:resize", "pty:kill"]) handlers.set(channel, ipcHandler(channel, globals));
  const gate = deferred();
  const ipcRenderer = {
    async invoke(channel: string, ...args: any[]) {
      if (channel === "pty:start") { requests.push(structuredClone(args[0])); if (delayedFirst && requests.length === 1) await gate.promise; }
      return handlers.get(channel)({ sender: wc }, ...args);
    },
    on(channel: string, fn: any) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(fn); },
    removeListener(channel: string, fn: any) { listeners.get(channel)?.delete(fn); },
  };
  const api: any = { windowToken: "window-71", openExternal: async () => {}, openPath: async () => "" };
  for (const name of ["ptyStart", "ptyWrite", "ptyResize", "ptyKill", "onPtyData", "onPtyExit"]) api[name] = preloadFunction(name, { ipcRenderer });
  Object.defineProperty(window, "codeshell", { configurable: true, value: api });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  const mount = async (value: any) => { await act(async () => { root.render(value); await settle(); }); };
  let state: any;
  function Harness() {
    const [tabs, setTabs] = React.useState([{ id: "terminal-1", kind: "terminal" }]);
    const [activeId, setActiveId] = React.useState("terminal-1");
    const [open, setOpen] = React.useState(true);
    const [request, setRequest] = React.useState({ nonce: 0, kind: null as string | null });
    state = { tabs, open, reopen: () => { setOpen(true); setRequest(p => ({ nonce: p.nonce + 1, kind: "terminal" })); } };
    return <PanelArea projectPath={temporary} tabs={tabs} setTabs={setTabs} activeId={activeId} setActiveId={setActiveId} bucket="project::session" hidden={!open} onClose={() => setOpen(false)} requestNonce={request.nonce} requestKind={request.kind} width={480} onResizeStart={() => {}} />;
  }
  async function close() {
    const tab = nodes(container).find(n => props(n).role === "tab"); expect(tab).toBeDefined();
    await act(async () => { props(tab).onKeyDown({ key: "Delete", currentTarget: tab, preventDefault() {} }); await settle(); });
  }
  async function reopen() { await act(async () => { state.reopen(); await settle(); }); }
  return { fakes, requests, listeners, wc, api, gate, mount, Harness, close, reopen, getState: () => state, destroy: () => { destroyed = true; } };
}

test("CONFIRMED WITH SEPARATE ELECTRON IDENTITY: restored tab close/reopen reuses surviving PTY; another close/reopen recovers", async () => {
  const f = await fixture(); await f.mount(<f.Harness />); await until(() => f.fakes.length === 1);
  const firstId = f.requests[0].sessionId; const firstTerm = terminals[0];
  await act(async () => { f.fakes[0].data("old retained scrollback"); await settle(); });
  await f.close(); expect(f.getState().tabs).toHaveLength(0); expect(f.getState().open).toBe(false);
  expect(firstTerm.disposed).toBe(true); expect(f.fakes[0].kills).toBe(0);
  await f.reopen(); await until(() => f.requests.length === 2 && terminals.at(-1)!.output.includes("old retained scrollback"));
  const next = terminals.at(-1)!; expect(f.requests[1].sessionId).toBe(firstId); expect(f.fakes).toHaveLength(1);
  await act(async () => { f.fakes[0].data("same surviving PTY"); next.input?.("same owner"); await settle(); });
  expect(next.output).toContain("same surviving PTY"); expect(f.fakes[0].writes).toEqual(["same owner"]);
  await f.close(); await f.reopen(); await until(() => f.fakes.length === 2);
  const fresh = terminals.at(-1)!; expect(f.requests[2].sessionId).not.toBe(firstId);
  expect(fresh.output).not.toContain("old retained scrollback");
  await act(async () => { f.fakes[0].data("late old output"); f.fakes[0].exit({ exitCode: 3 }); fresh.input?.("fresh shell remains"); await settle(); });
  expect(fresh.output).not.toContain("late old output"); expect(fresh.output).not.toContain("3");
  expect(f.fakes[1].writes).toEqual(["fresh shell remains"]);
});

test("same tab remount reattaches only its owner and replays scrollback without another spawn", async () => {
  const f = await fixture(); await f.mount(<TerminalPanel cwd={temporary} sessionId="term:project::session:terminal-1" />); await until(() => f.fakes.length === 1);
  await act(async () => { f.fakes[0].data("retained scrollback"); await settle(); });
  await f.mount(null); expect(f.listeners.get("pty:data")?.size).toBe(0); expect(f.listeners.get("pty:exit")?.size).toBe(0);
  expect(f.fakes[0].kills).toBe(0);
  await f.mount(<TerminalPanel cwd={temporary} sessionId="term:project::session:terminal-1" />); await until(() => f.requests.length === 2 && terminals.at(-1)!.output.includes("retained scrollback"));
  expect(f.fakes).toHaveLength(1); expect(terminals.at(-1)!.output).toContain("retained scrollback");
  const peer = { id: 72, isDestroyed: () => false, send() {} };
  expect(service.ptyStart(peer as any, { sessionId: f.requests[0].sessionId, cwd: temporary })).toMatchObject({ ok: false });
  service.ptyWrite(peer as any, f.requests[0].sessionId, "denied"); expect(f.fakes[0].writes).toEqual([]);
});

test("late first start after tab closure cannot resize disposed xterm or replace the new tab", async () => {
  const f = await fixture({ delayedFirst: true }); await f.mount(<f.Harness />); await until(() => f.requests.length === 1);
  const old = terminals[0]; await f.close(); await f.reopen(); await until(() => f.fakes.length === 1);
  const live = terminals.at(-1)!; const liveId = f.requests[1].sessionId;
  await act(async () => { f.gate.resolve(); await settle(); }); await until(() => f.fakes.length === 2);
  expect(old.disposed).toBe(true); expect(f.requests[0].sessionId).not.toBe(liveId);
  expect(f.fakes[1].resizes).toEqual([]);
  await act(async () => { f.fakes[1].data("late closed tab"); f.fakes[1].exit({ exitCode: 5 }); live.input?.("new remains usable"); await settle(); });
  expect(live.output).not.toContain("late closed tab"); expect(f.fakes[0].writes).toEqual(["new remains usable"]);
});

test("structured spawn refusal is visible; closing and reopening retries with a new tab successfully", async () => {
  const f = await fixture({ failSpawn: true }); await f.mount(<f.Harness />); await until(() => terminals[0]?.output.includes("fixture shell unavailable"));
  expect(f.fakes).toHaveLength(0); await f.close(); await f.reopen(); await until(() => f.fakes.length === 1);
  expect(f.requests).toHaveLength(2); expect(f.requests[0].sessionId).not.toBe(f.requests[1].sessionId);
  await act(async () => { f.fakes[0].data("retry prompt"); await settle(); }); expect(terminals.at(-1)!.output).toContain("retry prompt");
});

test("Main path rejection is visible and removes no owner; a fresh valid tab can recover", async () => {
  const f = await fixture(); await f.mount(<TerminalPanel cwd={join(temporary, "absent")} sessionId="term:project::session:terminal-1" />);
  await until(() => terminals[0]?.output.includes("existing absolute directory")); expect(f.fakes).toHaveLength(0);
  await f.mount(null); expect(f.listeners.get("pty:data")?.size).toBe(0);
  await f.mount(<TerminalPanel cwd={temporary} sessionId="term:project::session:terminal-2" />); await until(() => f.fakes.length === 1);
  expect(terminals.at(-1)!.disposed).toBe(false);
});

test("natural exit is visible and new tab recovers; reaping a destroyed owner does not double-kill it on quit", async () => {
  const f = await fixture(); await f.mount(<f.Harness />); await until(() => f.fakes.length === 1);
  await act(async () => { f.fakes[0].exit({ exitCode: 7 }); await settle(); }); expect(terminals[0].output).toContain("7");
  await f.close(); await f.reopen(); await until(() => f.fakes.length === 2);
  service.ptyReapDestroyed(); expect(f.fakes[1].kills).toBe(0);
  f.destroy(); service.ptyReapDestroyed(); expect(f.fakes[1].kills).toBe(1);
  service.ptyKillAll(); expect(f.fakes[1].kills).toBe(1);
});
