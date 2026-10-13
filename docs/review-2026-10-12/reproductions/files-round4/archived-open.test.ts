import { fileURLToPath } from "node:url";
import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const isolation = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
let resolvePatch: (() => void) | undefined;
const patchGate = new Promise<void>((resolve) => {
  resolvePatch = resolve;
});
let archived = true;
const requests: string[] = [];
const fixtureRoot = mkdtempSync(join(tmpdir(), "cs-review-archived-open-"));
const fixtureCwd = join(fixtureRoot, "workspace");
mkdirSync(fixtureCwd);
let service: any;
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://127.0.0.1");
  requests.push(`${req.method} ${url.pathname}${url.search}`);
  res.setHeader("content-type", "application/json");
  if (req.method === "PATCH") {
    await patchGate;
    await service.handle(req, res);
    archived = false;
  } else if (url.pathname.startsWith("/api/v1/sessions")) {
    await service.handle(req, res);
  } else if (url.pathname === "/api/v1/environments") {
    res.end(JSON.stringify({ environments: [] }));
  } else {
    res.end(JSON.stringify({}));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
isolation.installLocalNetworkGuard(origin);
const guardedFetch = globalThis.fetch;
globalThis.fetch = (input: any, init?: RequestInit) =>
  guardedFetch(new URL(typeof input === "string" ? input : (input.url ?? input), origin), init);
// Load production Host/Core only after the exact-origin guard has been installed.
const { createHubSessions } = await import(repo + "/packages/server/src/hub/session-management.ts");
const { SessionManager } = await import(repo + "/packages/core/dist/index.js");
const manager = new SessionManager(join(fixtureRoot, "sessions"));
const sessionId = manager.create(fixtureCwd, "fixture", "fixture").state.sessionId;
manager.updateSessionState(sessionId, { title: "Archived conversation" });
manager.setSessionArchived(sessionId, 10);
service = createHubSessions({
  cwd: fixtureCwd,
  sessionRootDir: join(fixtureRoot, "sessions"),
  dataDir: join(fixtureRoot, "hub"),
  isAuthorized: async () => true,
  isRunning: () => false,
  onChanged() {},
});
const React = await import(repo + "/node_modules/react/index.js");
const { act } = React;
const { createRoot } = await import(repo + "/packages/web/node_modules/react-dom/client.js");
const { ensureMiniDom, flushMicrotasks } = await import(
  repo + "/packages/web/src/test-utils/renderHook.tsx"
);
const { Workbench } = await import(repo + "/packages/web/app/Workbench.tsx");
const { initialChatState } = await import(repo + "/packages/web/src/lib/streamReducer.ts");
const { setApiWorkspace, setApiProject } = await import(repo + "/packages/web/app/api-context.ts");
ensureMiniDom();
setApiWorkspace(fixtureCwd);
setApiProject(null);
Object.assign(window, {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
Object.assign(Object.getPrototypeOf(document.createElement("dialog")), {
  showModal() {},
  close() {},
  getClientRects() {
    return [];
  },
});
globalThis.requestAnimationFrame = ((callback: any) => {
  callback(0);
  return 0;
}) as any;
const opened: string[] = [];
const noop = () => {};
const controller: any = {
  host: "hub",
  workspaceApi: true,
  connection: "open",
  session: { id: "fixture", username: "synthetic", deviceName: "review" },
  activeId: "current",
  chat: initialChatState(),
  sessions: [],
  workspaceCwd: fixtureCwd,
  workspaceName: "fixture",
  workspaceKey: "fixture",
  title: "Current",
  configuration: null,
  configurationVersion: 0,
  sessionsVersion: 0,
  draft: "",
  files: [],
  uploading: false,
  uploadBusy: false,
  hasUnsent: false,
  uncertain: false,
  running: false,
  localDrafts: [],
  approvals: [],
  approvalCount: () => 0,
  approvalContent: null,
  error: "",
  clearError: noop,
  setDraft: noop,
  removeFile: noop,
  selectSession: (id: string) => opened.push(id),
  newSession: noop,
  send: () => false,
  stop: noop,
  addFiles: noop,
  refreshSessions: noop,
  refreshConfiguration: noop,
  onAuthLost: noop,
};
const nodes = (node: any): any[] => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const props = (node: any): any =>
  node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))!];
const label = (node: any): string =>
  node.nodeType === 3
    ? node.nodeValue
    : (node.textContent ?? "") + (node.childNodes ?? []).map(label).join("");
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

test("characterizes spurious unsaved-change prompt after successful archive restore", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const button = (text: string) =>
    nodes(container).find((node) => node.tagName === "BUTTON" && label(node) === text);
  try {
    await act(async () => {
      root.render(React.createElement(Workbench, { controller }));
      await flushMicrotasks();
    });
    await act(async () => {
      props(button("历史对话")).onClick();
      await pause();
    });
    await act(async () => {
      await pause();
    });
    const select = nodes(container).find((node) => node.tagName === "SELECT");
    await act(async () => {
      props(select).onChange({ target: { value: "true" } });
      await pause();
    });
    await act(async () => {
      await pause();
    });
    expect(button("Archived conversation")).toBeDefined();
    await act(async () => {
      props(button("Archived conversation")).onClick();
      await pause();
    });
    expect(opened).toEqual([]);
    await act(async () => {
      resolvePatch!();
      await pause();
    });
    const prompt = nodes(container).find((node) => node.tagName === "DIALOG");
    const observed = {
      archived,
      sessionId,
      storedArchivedAt: manager.readSessionArchivedAt(sessionId) ?? null,
      opened,
      prompt: prompt ? label(prompt) : null,
      requests,
    };
    writeFileSync(
      new URL("./archived-open-observed.json", import.meta.url),
      JSON.stringify(observed, null, 2),
    );
    // Capture present behavior as a passing characterization, keeping review tests zero-failure.
    expect(archived).toBe(false);
    expect(manager.readSessionArchivedAt(sessionId)).toBeUndefined();
    expect(opened).toEqual([]);
    expect(label(prompt)).toContain("还有未保存的修改");
    expect(label(prompt)).toContain("放弃修改并离开");
    await act(async () => {
      props(button("放弃修改并离开")).onClick();
      await flushMicrotasks();
    });
    expect(opened).toEqual([sessionId]);
  } finally {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
