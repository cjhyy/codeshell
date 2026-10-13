import { afterAll, afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) {
  throw new Error("guarded HOME required");
}
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard("http://127.0.0.1:9");
const deny = () => { throw new Error("NETWORK_FORBIDDEN_model_switch_round18"); };
net.connect = net.createConnection = deny as any;
tls.connect = deny as any;
const { default: React, act } = await import(`${repo}/packages/desktop/node_modules/react`);
const { createRoot } = await import(`${repo}/packages/desktop/node_modules/react-dom/client`);
const { ensureMiniDom, flushMicrotasks } = await import(`${repo}/packages/desktop/src/renderer/test-utils/renderHook.tsx`);
const { useBucketOverrides } = await import(`${repo}/packages/desktop/src/renderer/app/useBucketOverrides.ts`);
const { switchActiveModel } = await import(`${repo}/packages/desktop/src/renderer/app/switchActiveModel.ts`);
const { ModelPill } = await import(`${repo}/packages/desktop/src/renderer/chat/ModelPill.tsx`);
const { runAfterModelSwitch } = await import(`${repo}/packages/desktop/src/renderer/modelSwitchRun.ts`);

ensureMiniDom();
// Geometry is outside this state/persistence review; mini DOM has no layout engine.
const elementPrototype = Object.getPrototypeOf(document.createElement("button"));
elementPrototype.getBoundingClientRect = () => ({ top: 300, bottom: 330, left: 200, right: 300, width: 100, height: 30, x: 200, y: 300 });
Object.defineProperty(elementPrototype, "offsetWidth", { configurable: true, value: 200 });
Object.defineProperty(elementPrototype, "offsetHeight", { configurable: true, value: 180 });
Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
});
const frames = new Set<any>();
window.requestAnimationFrame = (callback) => {
  const id = setTimeout(() => { frames.delete(id); callback(performance.now()); }, 0);
  frames.add(id);
  return id as unknown as number;
};
window.cancelAnimationFrame = (id) => { clearTimeout(id); frames.delete(id); };
const configureCalls: any[] = [];
const logs: any[] = [];
let configure = (_params: any): Promise<unknown> => Promise.resolve({ result: { ok: true } });
Object.defineProperty(window, "codeshell", {
  configurable: true,
  value: {
    configure: (params: any) => { configureCalls.push(structuredClone(params)); return configure(params); },
    log: (...args: any[]) => { logs.push(args); },
  },
});

const key = "codeshell.overrides.model";
const alpha = { key: "fixture-alpha", label: "Alpha", provider: "fixture" };
const beta = { key: "fixture-beta", label: "Beta", provider: "fixture" };
const fallback = { key: "fixture-default", label: "Default", provider: "fixture" };
const options = [alpha, beta, fallback];
const snapshot = () => JSON.parse(storage.get(key) ?? "{}");
const states = new Map<string, any>();
const ownedRoots = new Set<any>();
const ownedContainers = new Set<any>();
let completed = 0;
const nodes = (node: any): any[] => [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
const props = (node: any) => {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
};
async function settle() { await flushMicrotasks(); }
function View({ name, projectId, sessionId, disabled = false }: any) {
  const preferences = useBucketOverrides();
  const bucket = `${projectId}::${sessionId}`;
  const selected = preferences.modelOverrides[bucket] ?? fallback.key;
  states.set(name, { ...preferences, selected, bucket });
  return React.createElement(ModelPill, { activeKey: selected, options, disabled, onSelect: (option: any) => {
    switchActiveModel({
      currentModelKey: selected,
      nextModelKey: option.key,
      activeBucket: bucket,
      activeProjectId: projectId,
      activeProjectBucketSegment: projectId,
      activeSessionId: sessionId,
      engineSessionId: sessionId,
      promptTokens: 0,
      setModelOverrides: preferences.setModelOverrides,
      setSessionIndices: () => {},
      dispatch: () => {},
    });
  } });
}
async function mount(name: string, projectId: string, sessionId: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  ownedContainers.add(container);
  const root = createRoot(container);
  ownedRoots.add(root);
  let current = { name, projectId, sessionId, disabled: false };
  const render = async (patch: Record<string, any> = {}) => {
    current = { ...current, ...patch };
    await act(async () => { root.render(React.createElement(View, current)); await settle(); });
  };
  await render();
  return {
    container,
    render,
    async unmount() {
      await act(async () => { root.unmount(); await settle(); });
      ownedRoots.delete(root);
      container.parentNode?.removeChild(container);
      ownedContainers.delete(container);
    },
  };
}
async function pick(view: any, option: any) {
  const trigger = nodes(view.container).find((node) => props(node)["aria-haspopup"] === "listbox");
  expect(Boolean(trigger)).toBe(true);
  expect(props(trigger).disabled).toBe(false);
  await act(async () => { props(trigger).onClick(); await settle(); });
  const row = nodes(view.container).find((node) => props(node)["data-model-key"] === option.key);
  expect(Boolean(row)).toBe(true);
  await act(async () => { props(row).onClick(); await settle(); });
}
afterEach(async () => {
  await act(async () => {
    for (const root of ownedRoots) root.unmount();
    ownedRoots.clear();
    await settle();
  });
  for (const frame of frames) clearTimeout(frame);
  frames.clear();
  for (const container of ownedContainers) container.parentNode?.removeChild(container);
  ownedContainers.clear();
  storage.clear();
  states.clear();
  configureCalls.length = 0;
  logs.length = 0;
  configure = () => Promise.resolve({ result: { ok: true } });
});
afterAll(() => {
  if (completed === 3) console.log("Completed model switch round18: 3 scenarios; actual selector/persistence controls; no Electron/model/worker/CLI/network");
});

test("two already-open native composers overwrite an unrelated persisted model; reload falls back and reselection recovers", async () => {
  const a = await mount("A", "project-a", "session-a");
  const b = await mount("B", "project-b", "session-b");
  expect(states.get("A").modelOverrides).toEqual({});
  expect(states.get("B").modelOverrides).toEqual({});
  await pick(a, alpha);
  expect(snapshot()).toEqual({ "project-a::session-a": alpha.key });
  expect(states.get("B").modelOverrides).toEqual({});
  await pick(b, beta);
  expect(snapshot()).toEqual({ "project-b::session-b": beta.key });
  expect(states.get("A").selected).toBe(alpha.key);
  expect(states.get("B").selected).toBe(beta.key);
  expect(configureCalls).toEqual([
    { sessionId: "session-a", model: alpha.key },
    { sessionId: "session-b", model: beta.key },
  ]);
  const beforeReload = snapshot();
  await a.unmount();
  const reopened = await mount("A", "project-a", "session-a");
  expect(states.get("A").selected).toBe(fallback.key);
  expect(states.get("A").modelOverrides).toEqual({ "project-b::session-b": beta.key });
  let submitted: any;
  await runAfterModelSwitch({
    sessionId: "session-a", model: states.get("A").selected, text: "synthetic turn", opts: { sessionId: "session-a" },
    run: async (_text: string, opts: any) => { submitted = opts; return { reason: "completed" }; },
  });
  expect(submitted).toEqual({ sessionId: "session-a", model: fallback.key });
  await pick(reopened, alpha);
  expect(snapshot()).toEqual({ "project-a::session-a": alpha.key, "project-b::session-b": beta.key });
  expect(states.get("A").selected).toBe(alpha.key);
  writeFileSync(join(import.meta.dir, "observations.json"), JSON.stringify({
    beforeReload, afterReloadModel: fallback.key, runAdapterReceived: submitted,
    recovered: snapshot(), nativeElectron: false, actualModelRun: false,
    boundary: "actual ModelPill + useBucketOverrides + switchActiveModel; two React roots with shared MemoryStorage; run adapter records params only",
  }, null, 2));
  completed++;
});

test("one window and a later-opened window preserve independent bucket selections", async () => {
  const first = await mount("first", "project-a", "session-a");
  await pick(first, alpha);
  await first.render({ projectId: "project-b", sessionId: "session-b" });
  expect(states.get("first").selected).toBe(fallback.key);
  await pick(first, beta);
  expect(snapshot()).toEqual({ "project-a::session-a": alpha.key, "project-b::session-b": beta.key });
  await first.unmount();
  const a = await mount("A", "project-a", "session-a");
  expect(states.get("A").selected).toBe(alpha.key);
  const b = await mount("B", "project-b", "session-b");
  expect(states.get("B").selected).toBe(beta.key);
  await pick(b, fallback);
  expect(snapshot()).toEqual({ "project-a::session-a": alpha.key, "project-b::session-b": fallback.key });
  await a.render({ disabled: true });
  const trigger = nodes(a.container).find((node) => props(node)["aria-haspopup"] === "listbox");
  expect(props(trigger).disabled).toBe(true);
  completed++;
});

test("late rejected configure stays attached to the old session; chosen intent pins the subsequent run independently of ACK", async () => {
  let reject!: (error: unknown) => void;
  configure = () => new Promise((_resolve, fail) => { reject = fail; });
  const view = await mount("view", "project-a", "session-a");
  await pick(view, alpha);
  expect(states.get("view").selected).toBe(alpha.key);
  await view.render({ projectId: "project-b", sessionId: "session-b" });
  expect(states.get("view").selected).toBe(fallback.key);
  await act(async () => { reject(new Error("synthetic IPC unavailable")); await settle(); });
  expect(states.get("view").selected).toBe(fallback.key);
  expect(snapshot()).toEqual({ "project-a::session-a": alpha.key });
  expect(logs).toEqual([["session.model_switch_failed", {
    sessionId: "session-a", model: alpha.key, error: "Error: synthetic IPC unavailable",
  }]]);
  await view.render({ projectId: "project-a", sessionId: "session-a" });
  let submitted: any;
  await runAfterModelSwitch({
    sessionId: "session-a", model: states.get("view").selected, text: "synthetic turn", opts: { sessionId: "session-a" },
    run: async (_text: string, opts: any) => { submitted = opts; return { reason: "completed" }; },
  });
  expect(submitted).toEqual({ sessionId: "session-a", model: alpha.key });
  completed++;
});
