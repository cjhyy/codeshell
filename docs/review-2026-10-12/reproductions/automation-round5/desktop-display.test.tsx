import { fileURLToPath } from "node:url";
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const isolation = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
isolation.installLocalNetworkGuard("http://127.0.0.1:9");
const React = await import(repo + "/node_modules/react/index.js");
const { act } = React;
const { createRoot } = await import(repo + "/packages/desktop/node_modules/react-dom/client.js");
const { ensureMiniDom, flushMicrotasks } = await import(repo + "/packages/desktop/src/renderer/test-utils/renderHook.tsx");
const { CronScheduler } = await import(repo + "/packages/core/src/automation/scheduler.ts");
const { bindCronToEngine } = await import(repo + "/packages/core/src/automation/runner.ts");
const { automationSummary, setAutomationScheduler, listAutomations } = await import(repo + "/packages/desktop/src/main/automation-service.ts");
const { AutomationView } = await import(repo + "/packages/desktop/src/renderer/automation/AutomationView.tsx");
const { placeLiveAutomationSession } = await import(repo + "/packages/desktop/src/renderer/automation/liveSession.ts");
ensureMiniDom();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
const noop = () => {};
const nodes = (node: any): any[] => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const props = (node: any): any => node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))!];
const label = (node: any): string => node.nodeType === 3 ? node.nodeValue :
  (node.childNodes?.length ? node.childNodes.map(label).join("") : node.textContent ?? "");
const project: any = {
  id: "p", path: "/fixture", name: "fixture", createdAt: 1,
  primaryRootId: "r", roots: [{ id: "r", path: "/fixture", name: "main" }],
};

async function mounted(jobs: any[], sessions: any[], sessionIndices: any = {}) {
  const opened: string[] = [];
  Object.defineProperty(window, "codeshell", { configurable: true, value: {
    listAutomations: async () => jobs,
    listRuns: async () => [],
    listDiskSessions: async () => ({ sessions }),
    log: noop,
  } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const input = {
    projects: [project], sessionIndices, onCreateConversational: noop,
    onOpenRunSession: noop, onOpenDiskSession: (disk: any) => opened.push(disk.id), onOpenSession: noop,
  };
  const render = async (extra: any = {}) => {
    await act(async () => {
      root.render(React.createElement(AutomationView, { ...input, ...extra }));
      await flushMicrotasks();
    });
  };
  await render();
  return {
    container,
    opened,
    render,
    detail: () => nodes(container).find((node) => props(node)?.role === "region"),
    async close() {
      await act(async () => { root.unmount(); await flushMicrotasks(); });
      document.body.removeChild(container);
    },
  };
}

test("disabled reason exists in scheduler but is lost across desktop summary and reopening UI", async () => {
  const scheduler = new CronScheduler();
  scheduler.setExecutionEnabled(false);
  const job = scheduler.create("missing-root-job", "1h", "fixture", {
    cwd: "/fixture", projectId: "p", rootId: "r", resumeSessionId: "deleted-s",
  });
  const reason = "resume Session root is unavailable: fixture project directory is missing";
  scheduler.disableWithReason(job.id, reason);
  setAutomationScheduler(scheduler);
  const summary = listAutomations()[0];
  const ui = await mounted([summary], []);
  try {
    expect(job.disabledReason).toBe(reason);
    expect(summary.enabled).toBe(false);
    expect((summary as any).disabledReason).toBeUndefined();
    expect(label(ui.detail())).toContain("已暂停");
    expect(label(ui.detail())).not.toContain(reason);
    writeFileSync(new URL("./disabled-reason-observed.json", import.meta.url), JSON.stringify({
      schedulerJob: job, summary, reopenedDetail: label(ui.detail()),
    }, null, 2));
  } finally {
    await ui.close();
    scheduler.stopAll();
    setAutomationScheduler(null);
  }
});

test("live production announcement is not linked by its exact cronJobId", async () => {
  const scheduler = new CronScheduler();
  scheduler.setExecutionEnabled(false);
  const job = scheduler.create("每日盘点", "1h", "inventory fixture", { cwd: "/fixture", projectId: "p", rootId: "r" });
  const live = placeLiveAutomationSession({
    sessionId: "live-inventory", cwd: "/fixture", title: job.name + " 2026/10/12", cronJobId: job.id,
  }, [project], { caseInsensitive: false, createProjectForCwd: () => null })!;
  const ui = await mounted([automationSummary(job)], [], { p: { sessions: [live.summary], activeId: live.summary.id } });
  try {
    const text = label(ui.detail());
    expect(live.summary.cronJobId).toBe(job.id);
    expect(text).not.toContain(live.summary.title);
    expect(text).toContain("这个任务还没有可跳转的历史 session");
    writeFileSync(new URL("./live-link-observed.json", import.meta.url), JSON.stringify({
      liveSummary: live.summary, job: automationSummary(job), detail: text,
    }, null, 2));
  } finally { await ui.close(); scheduler.stopAll(); }
});

test("reopened automation A lists unrelated job B's disk session from same 24h window", async () => {
  const scheduler = new CronScheduler();
  scheduler.setExecutionEnabled(false);
  const job = scheduler.create("每日盘点", "1h", "inventory fixture", { cwd: "/fixture", projectId: "p", rootId: "r" });
  job.lastRun = Date.now();
  job.runCount = 1;
  const disk = [
    { id: "inventory", engineSessionId: "inventory", cwd: "/fixture", title: "inventory fixture", origin: "automation", updatedAt: job.lastRun },
    { id: "unrelated", engineSessionId: "unrelated", cwd: "/fixture", title: "UNRELATED: publish weekly financial report", origin: "automation", updatedAt: job.lastRun + 1000 },
  ];
  const ui = await mounted([automationSummary(job)], disk);
  try {
    const text = label(ui.detail());
    expect(text).toContain("inventory fixture");
    expect(text).toContain("UNRELATED: publish weekly financial report");
    const historyButton = nodes(ui.detail()).find((node) => node.tagName === "BUTTON" && label(node).includes("UNRELATED:"));
    expect(historyButton).toBeDefined();
    await act(async () => { props(historyButton).onClick(); await flushMicrotasks(); });
    expect(ui.opened).toEqual(["unrelated"]);
    writeFileSync(new URL("./cross-job-history-observed.json", import.meta.url), JSON.stringify({
      job: automationSummary(job), disk, detail: text, opened: ui.opened,
    }, null, 2));
  } finally { await ui.close(); scheduler.stopAll(); }
});

test("run-now refresh finishes before asynchronous auto-disable, leaving open UI active indefinitely", async () => {
  const scheduler = new CronScheduler();
  scheduler.setExecutionEnabled(false);
  let finishPreflight!: () => void;
  const preflight = new Promise<void>((resolve) => { finishPreflight = resolve; });
  bindCronToEngine(scheduler, async () => {
    await preflight;
    return { text: "", reason: "workspace-unresolved", stop: { reason: "fixture root unavailable" } };
  });
  const job = scheduler.create("automatic-stop", "1h", "fixture", { cwd: "/fixture", projectId: "p", rootId: "r" });
  let listCalls = 0;
  const ui = await mounted([automationSummary(job)], []);
  Object.defineProperty(window, "codeshell", { configurable: true, value: {
    listAutomations: async () => { listCalls++; return [automationSummary(job)]; },
    listRuns: async () => [],
    listDiskSessions: async () => ({ sessions: [] }),
    runAutomationNow: async () => scheduler.runNow(job.id),
  } });
  try {
    const runNow = nodes(ui.detail()).find((node) => node.tagName === "BUTTON" && label(node) === "立即运行");
    await act(async () => { props(runNow).onClick(); await flushMicrotasks(); });
    expect(listCalls).toBe(1);
    expect(label(ui.detail())).toContain("活跃");
    await act(async () => { finishPreflight(); await flushMicrotasks(); });
    expect(job.enabled).toBe(false);
    // App receives other Host state and rerenders with a new project/index object.
    // The mounted AutomationView has no lifecycle subscription and still shows
    // its old enabled state, even after ordinary parent rerenders.
    await ui.render({ projects: [{ ...project }], sessionIndices: {} });
    expect(listCalls).toBe(1);
    expect(label(ui.detail())).toContain("活跃");
    expect(label(ui.detail())).not.toContain("已暂停");
    writeFileSync(new URL("./stale-enabled-observed.json", import.meta.url), JSON.stringify({
      schedulerJob: job, listCallsAfterRunNow: listCalls, mountedDetailAfterStop: label(ui.detail()),
    }, null, 2));
  } finally { await ui.close(); scheduler.stopAll(); }
});
