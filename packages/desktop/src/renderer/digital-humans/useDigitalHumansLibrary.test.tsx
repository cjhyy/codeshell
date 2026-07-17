import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import {
  useDigitalHumanOperations,
  useDigitalHumansLibrary,
  type DigitalHumansLibraryApi,
} from "./useDigitalHumansLibrary";
import { useDigitalHumanTeamDraft } from "./DigitalHumansView";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function profile(name: string) {
  return {
    name,
    label: name,
    basePreset: "general",
    plugins: [],
    skills: [],
    mcp: [],
    agents: [],
    active: false,
    portableMemory: false,
  };
}

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("useDigitalHumansLibrary", () => {
  test("does not let an older project response overwrite the latest project", async () => {
    ensureMiniDom();
    const first = deferred<ReturnType<typeof profile>[]>();
    const second = deferred<ReturnType<typeof profile>[]>();
    const api: DigitalHumansLibraryApi = {
      listProfiles: (cwd) => (cwd === "/project-a" ? first.promise : second.promise),
      listProfileCatalog: async () => [],
      listDigitalHumanTeams: async () => [],
      listSkills: async () => [],
    };
    let activeProjectPath = "/project-a";
    const hook = await renderHook(() => useDigitalHumansLibrary(activeProjectPath, api));
    cleanup = hook.unmount;

    activeProjectPath = "/project-b";
    await hook.rerender();
    await act(async () => {
      second.resolve([profile("new-project")]);
      await flushMicrotasks();
      first.resolve([profile("stale-project")]);
      await flushMicrotasks();
    });

    expect(hook.result.current.status).toBe("ready");
    expect(hook.result.current.profiles.map((entry) => entry.name)).toEqual(["new-project"]);
  });

  test("does not show project-specific data from the previous project while switching", async () => {
    ensureMiniDom();
    const next = deferred<ReturnType<typeof profile>[]>();
    const api: DigitalHumansLibraryApi = {
      listProfiles: (cwd) =>
        cwd === "/project-a" ? Promise.resolve([profile("project-a-profile")]) : next.promise,
      listProfileCatalog: async () => [],
      listDigitalHumanTeams: async () => [],
      listSkills: async (cwd) =>
        cwd === "/project-a" ? [{ name: "project-a-skill", description: "" }] : [],
    };
    let activeProjectPath = "/project-a";
    const hook = await renderHook(() => useDigitalHumansLibrary(activeProjectPath, api));
    cleanup = hook.unmount;
    expect(hook.result.current.status).toBe("ready");
    expect(hook.result.current.profiles).toHaveLength(1);
    expect(hook.result.current.availableSkills).toHaveLength(1);

    activeProjectPath = "/project-b";
    await hook.rerender();
    expect(hook.result.current.status).toBe("loading");
    expect(hook.result.current.profiles).toEqual([]);
    expect(hook.result.current.availableSkills).toEqual([]);

    await act(async () => {
      next.reject(new Error("project-b unavailable"));
      await flushMicrotasks();
    });
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.profiles).toEqual([]);
  });

  test("stays in a load error after a rapid project round-trip cleared the old data", async () => {
    ensureMiniDom();
    const projectB = deferred<ReturnType<typeof profile>[]>();
    const projectAReload = deferred<ReturnType<typeof profile>[]>();
    let projectACalls = 0;
    const api: DigitalHumansLibraryApi = {
      listProfiles: (cwd) => {
        if (cwd === "/project-b") return projectB.promise;
        projectACalls += 1;
        return projectACalls === 1
          ? Promise.resolve([profile("project-a-profile")])
          : projectAReload.promise;
      },
      listProfileCatalog: async () => [],
      listDigitalHumanTeams: async () => [],
      listSkills: async () => [],
    };
    let activeProjectPath = "/project-a";
    const hook = await renderHook(() => useDigitalHumansLibrary(activeProjectPath, api));
    cleanup = hook.unmount;
    expect(hook.result.current.status).toBe("ready");

    activeProjectPath = "/project-b";
    await hook.rerender();
    activeProjectPath = "/project-a";
    await hook.rerender();
    expect(hook.result.current.status).toBe("loading");
    expect(hook.result.current.profiles).toEqual([]);

    await act(async () => {
      projectAReload.reject(new Error("project-a reload failed"));
      await flushMicrotasks();
    });
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("project-a reload failed");
  });

  test("exposes an initial load error and recovers through retry", async () => {
    ensureMiniDom();
    let attempts = 0;
    const api: DigitalHumansLibraryApi = {
      listProfiles: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("library unavailable");
        return [profile("recovered")];
      },
      listProfileCatalog: async () => [],
      listDigitalHumanTeams: async () => [],
      listSkills: async () => [],
    };
    const hook = await renderHook(() => useDigitalHumansLibrary(null, api));
    cleanup = hook.unmount;

    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("library unavailable");

    await act(async () => {
      await hook.result.current.refresh();
      await flushMicrotasks();
    });
    expect(hook.result.current.status).toBe("ready");
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.profiles[0]?.name).toBe("recovered");
  });
});

describe("useDigitalHumanOperations", () => {
  test("locks duplicate submissions through the persistence refresh", async () => {
    ensureMiniDom();
    const action = deferred<void>();
    const refresh = deferred<boolean>();
    let actionCalls = 0;
    const hook = await renderHook(() => useDigitalHumanOperations(() => refresh.promise));
    cleanup = hook.unmount;

    let first!: Promise<unknown>;
    let duplicate!: Promise<unknown>;
    await act(async () => {
      first = hook.result.current.run("save-team", async () => {
        actionCalls += 1;
        return action.promise;
      });
      duplicate = hook.result.current.run("save-team", async () => {
        actionCalls += 1;
      });
      await flushMicrotasks();
    });

    expect(actionCalls).toBe(1);
    expect(await duplicate).toEqual({ ok: false, duplicate: true });
    expect(hook.result.current.isBusy("save-team")).toBe(true);

    await act(async () => {
      action.resolve();
      await flushMicrotasks();
      expect(hook.result.current.isBusy("save-team")).toBe(true);
      refresh.resolve(true);
      await first;
      await flushMicrotasks();
    });

    expect(hook.result.current.isBusy("save-team")).toBe(false);
  });
});

describe("useDigitalHumanTeamDraft", () => {
  test("prefills and updates an existing team without changing its id", async () => {
    ensureMiniDom();
    const team = {
      id: "delivery-team",
      name: "Delivery",
      description: "Original description",
      members: ["researcher", "developer"],
      mode: "compare" as const,
    };
    const profiles = [profile("researcher"), profile("developer"), profile("reviewer")];
    const hook = await renderHook(() => useDigitalHumanTeamDraft(true, team, profiles));
    cleanup = hook.unmount;

    expect(hook.result.current.toTeam()).toEqual(team);
    await act(async () => {
      hook.result.current.setName("Delivery v2");
      hook.result.current.setDescription("Updated description");
      hook.result.current.toggleMember("reviewer");
      await flushMicrotasks();
    });

    expect(hook.result.current.toTeam()).toEqual({
      id: "delivery-team",
      name: "Delivery v2",
      description: "Updated description",
      members: ["researcher", "developer", "reviewer"],
      mode: "compare",
    });
  });

  test("preserves missing member references but blocks saving until they are removed", async () => {
    ensureMiniDom();
    const team = {
      id: "legacy-team",
      name: "Legacy",
      members: ["researcher", "removed-profile"],
      mode: "auto" as const,
    };
    const profiles = [profile("researcher"), profile("reviewer")];
    const hook = await renderHook(() => useDigitalHumanTeamDraft(true, team, profiles));
    cleanup = hook.unmount;

    expect(hook.result.current.missingMembers).toEqual(["removed-profile"]);
    expect(hook.result.current.canSave).toBe(false);
    expect(hook.result.current.toTeam()).toBeNull();

    await act(async () => {
      hook.result.current.toggleMember("removed-profile");
      hook.result.current.toggleMember("reviewer");
      await flushMicrotasks();
    });
    expect(hook.result.current.missingMembers).toEqual([]);
    expect(hook.result.current.toTeam()).toEqual({
      id: "legacy-team",
      name: "Legacy",
      members: ["researcher", "reviewer"],
      mode: "auto",
    });
  });
});
