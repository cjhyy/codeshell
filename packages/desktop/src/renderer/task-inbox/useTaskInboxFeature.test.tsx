import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useState } from "react";
import type { TaskInboxRecordV1 } from "../../preload/task-inbox-api";
import type { PetOpenSessionRequest } from "../../preload/types";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import type { ViewState } from "../view";
import { useTaskInboxFeature } from "./useTaskInboxFeature";

let previousBridge: PropertyDescriptor | undefined;
let hook: Awaited<ReturnType<typeof mount>> | undefined;
let settings: Array<(value: { featureFlags?: Record<string, boolean> }) => void>;
let petRequests: PetOpenSessionRequest[];

async function mount() {
  let settingsRevision = 0;
  const rendered = await renderHook(() => {
    const [view, setView] = useState<ViewState>({
      viewMode: "task_inbox",
      sidebarCollapsed: true,
      inspectorCollapsed: true,
    });
    const [runId, setRunsInitialRunId] = useState<string | null>(null);
    return {
      view,
      runId,
      ...useTaskInboxFeature({
        settingsRevision,
        setView,
        sessionIndices: {},
        selectSession: () => undefined,
        openDiskSession: async () => undefined,
        openPetTarget: async (request) => {
          petRequests.push(request);
          return true;
        },
        petSnapshot: { version: 23, generation: 7 },
        openPetPage: () => setView((current) => ({ ...current, viewMode: "pet" })),
        setRunsInitialRunId,
      }),
    };
  });
  return {
    ...rendered,
    reloadSettings: async () => {
      settingsRevision += 1;
      await rendered.rerender();
    },
  };
}

function task(source: TaskInboxRecordV1["source"], sourceId: string): TaskInboxRecordV1 {
  return {
    schemaVersion: 1,
    taskKey: `${source}:${sourceId}`,
    source,
    sourceId,
    title: sourceId,
    status: "done",
    artifacts: [],
    capabilities: ["open"],
    createdAt: 1,
    updatedAt: 1,
    sourceRevision: "r1",
  };
}

beforeEach(() => {
  ensureMiniDom();
  previousBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
  settings = [];
  petRequests = [];
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      getSettings: () => new Promise((resolve) => settings.push(resolve)),
      listDiskSessions: async () => ({ sessions: [] }),
    },
  });
});
afterEach(async () => {
  await hook?.unmount();
  hook = undefined;
  if (previousBridge) Object.defineProperty(window, "codeshell", previousBridge);
  else delete (window as any).codeshell;
});

test("an obsolete settings read cannot hide the page; explicit false hides and redirects it", async () => {
  hook = await mount();
  await hook.reloadSettings();
  await act(async () => settings[1]!({}));
  await act(async () => settings[0]!({ featureFlags: { taskInboxV1: false } }));
  expect(hook.result.current.taskInboxEnabled).toBe(true);
  expect(hook.result.current.view.viewMode).toBe("task_inbox");
  await hook.reloadSettings();
  await act(async () => settings[2]!({ featureFlags: { taskInboxV1: false } }));
  expect(hook.result.current.taskInboxEnabled).toBe(false);
  expect(hook.result.current.view).toEqual({
    viewMode: "chat",
    sidebarCollapsed: true,
    inspectorCollapsed: true,
  });
});

test("feature wiring retains exact Mimi, automation, Run and external CLI destinations", async () => {
  hook = await mount();
  const open = async (record: TaskInboxRecordV1) =>
    act(async () => hook!.result.current.onOpenTaskInboxRecord(record));
  await open(task("automation", "schedule-a"));
  expect(hook.result.current.automationInitialId).toBe("schedule-a");
  expect(hook.result.current.view.viewMode).toBe("automation");
  await open(task("mimi-delegation", "delegation-a"));
  expect(hook.result.current.petInitialTaskId).toBe("delegation-a");
  expect(hook.result.current.view.viewMode).toBe("pet");
  await open(task("legacy-run", "run-a"));
  expect(hook.result.current.runId).toBe("run-a");
  expect(hook.result.current.view.viewMode).toBe("runs");
  await open({
    ...task("external-runtime", "observed-a"),
    sessionId: "external-a",
    externalCli: "codex",
    workspacePath: "/actual/cwd",
  });
  expect(petRequests).toEqual([
    {
      agentSessionId: "external-a",
      snapshotVersion: 23,
      generation: 7,
      external: { cli: "codex", cwd: "/actual/cwd", sessionId: "external-a" },
    },
  ]);
  await expect(open(task("session", "missing"))).rejects.toThrow();
});
