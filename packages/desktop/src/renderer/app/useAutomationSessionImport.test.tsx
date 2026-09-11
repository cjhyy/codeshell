import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useRef, useState } from "react";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import { foldTranscript } from "../automation/foldTranscript";
import { loadProjects, saveProjects, type TrackedProject } from "../projects";
import { loadTranscript, saveTranscript, type SessionIndex } from "../transcripts";
import { useAutomationSessionImport } from "./useAutomationSessionImport";

describe("automation catalog import", () => {
  let savedStorage: PropertyDescriptor | undefined;
  let savedBridge: PropertyDescriptor | undefined;
  let savedProjects: TrackedProject[];
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useHarness>>>> | undefined;
  let transcriptReads: number;
  let status: "running" | "completed";

  function useHarness() {
    const [indices, setSessionIndices] = useState<Record<string, SessionIndex>>({});
    const indicesRef = useRef(indices);
    indicesRef.current = indices;
    const [, setProjects] = useState(loadProjects);
    useAutomationSessionImport({ sessionIndicesRef: indicesRef, setSessionIndices, setProjects });
    return indices;
  }

  beforeEach(() => {
    ensureMiniDom();
    savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    savedBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    savedProjects = loadProjects();
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    saveProjects([
      {
        id: "project",
        name: "Project",
        path: "/workspace",
        primaryRootId: "root",
        addedAt: 1,
        roots: [{ id: "root", path: "/workspace", name: "Root", addedAt: 1 }],
      },
    ]);
    transcriptReads = 0;
    status = "running";
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        log: () => undefined,
        listRuns: async () => [
          {
            runId: "run",
            sessionId: "session",
            cwd: "/workspace",
            objective: "Watch progress",
            source: "automation",
            status,
            createdAt: 1,
            finishedAt: status === "completed" ? 2 : null,
          },
        ],
        listDiskSessions: async () => ({ sessions: [], nextCursor: null }),
        projectRegistry: {
          resolveForCwdBatch: async (cwds: string[]) =>
            cwds.map(() => ({ projectId: "project", rootId: "root", created: false })),
        },
        getSessionTranscript: async () => {
          transcriptReads++;
          throw new Error("History must wait for session selection");
        },
      },
    });
  });

  afterEach(async () => {
    await hook?.unmount();
    hook = undefined;
    saveProjects(savedProjects);
    if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (savedBridge) Object.defineProperty(window, "codeshell", savedBridge);
    else Reflect.deleteProperty(window, "codeshell");
  });

  test("registers a running session without reading or replacing its live snapshot", async () => {
    const live = foldTranscript([{ kind: "user", text: "Live request", timestamp: 1 }]);
    saveTranscript("project", "session", live);
    hook = await renderHook(useHarness);
    expect(hook.result.current.project.sessions).toMatchObject([
      {
        id: "session",
        engineSessionId: "session",
        source: "automation",
        runStatus: "running",
      },
    ]);
    expect(transcriptReads).toBe(0);
    expect(loadTranscript("project", "session")).toEqual(live);
  });

  test("registers a completed session even while transcript IO is unavailable", async () => {
    status = "completed";
    hook = await renderHook(useHarness);
    expect(hook.result.current.project.sessions).toMatchObject([
      {
        id: "session",
        runStatus: "completed",
        title: "Watch progress",
      },
    ]);
    expect(transcriptReads).toBe(0);
    expect(loadTranscript("project", "session").messages).toHaveLength(0);
  });
});
