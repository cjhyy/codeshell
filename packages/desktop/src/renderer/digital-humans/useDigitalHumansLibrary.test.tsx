import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import {
  useDigitalHumanOperations,
  useDigitalHumansLibrary,
  type DigitalHumansLibraryApi,
} from "./useDigitalHumansLibrary";
import type { RendererConfigurationTarget } from "../../preload/types";
import { useDigitalHumanTeamDraft } from "./DigitalHumansView";
import {
  DIGITAL_HUMAN_TEAM_MEMBER_MAX,
  DIGITAL_HUMAN_TEAM_NAME_LIMIT,
  DIGITAL_HUMAN_TEAM_PLAYBOOK_LIMIT,
} from "../../shared/digital-human-team";

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
  type LibraryTarget = Parameters<typeof useDigitalHumansLibrary>[0];
  const _stableTargetIsAccepted: LibraryTarget = { projectId: "project-a" };
  const _legacyPathIsRejected: string extends LibraryTarget ? false : true = true;
  void _stableTargetIsAccepted;
  void _legacyPathIsRejected;

  test("does not let an older project response overwrite the latest project", async () => {
    ensureMiniDom();
    const first = deferred<ReturnType<typeof profile>[]>();
    const second = deferred<ReturnType<typeof profile>[]>();
    const api: DigitalHumansLibraryApi = {
      listProfiles: (target) =>
        "projectId" in target && target.projectId === "project-a" ? first.promise : second.promise,
      listProfileCatalog: async () => [],
      listDigitalHumanTeams: async () => [],
      listSkills: async () => [],
    };
    let target: RendererConfigurationTarget = { projectId: "project-a" };
    const hook = await renderHook(() => useDigitalHumansLibrary(target, api));
    cleanup = hook.unmount;

    target = { projectId: "project-b" };
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
      listProfiles: (target) =>
        "projectId" in target && target.projectId === "project-a"
          ? Promise.resolve([profile("project-a-profile")])
          : next.promise,
      listProfileCatalog: async () => [],
      listDigitalHumanTeams: async () => [],
      listSkills: async (target) =>
        "projectId" in target && target.projectId === "project-a"
          ? [{ name: "project-a-skill", description: "" }]
          : [],
    };
    let target: RendererConfigurationTarget = { projectId: "project-a" };
    const hook = await renderHook(() => useDigitalHumansLibrary(target, api));
    cleanup = hook.unmount;
    expect(hook.result.current.status).toBe("ready");
    expect(hook.result.current.profiles).toHaveLength(1);
    expect(hook.result.current.availableSkills).toHaveLength(1);

    target = { projectId: "project-b" };
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

  test("an earlier refresh handle retries only the current target", async () => {
    ensureMiniDom();
    const targets: RendererConfigurationTarget[] = [];
    const api: DigitalHumansLibraryApi = {
      listProfiles: async (target) => {
        targets.push(target);
        const name = "projectId" in target ? target.projectId : "no-repo";
        return [profile(name)];
      },
      listProfileCatalog: async () => [],
      listDigitalHumanTeams: async () => [],
      listSkills: async () => [],
    };
    let target: RendererConfigurationTarget = { projectId: "project-a" };
    const hook = await renderHook(() => useDigitalHumansLibrary(target, api));
    cleanup = hook.unmount;
    const refreshFromProjectA = hook.result.current.refresh;

    target = { projectId: "project-b" };
    await hook.rerender();
    await act(async () => {
      await refreshFromProjectA();
      await flushMicrotasks();
    });

    expect(hook.result.current.status).toBe("ready");
    expect(hook.result.current.profiles.map((entry) => entry.name)).toEqual(["project-b"]);
    expect(targets).toEqual([
      { projectId: "project-a" },
      { projectId: "project-b" },
      { projectId: "project-b" },
    ]);
  });

  test("rejects same-target stale responses after A to B to A and retries only current A", async () => {
    ensureMiniDom();
    const firstProjectA = deferred<ReturnType<typeof profile>[]>();
    const projectB = deferred<ReturnType<typeof profile>[]>();
    const projectAReload = deferred<ReturnType<typeof profile>[]>();
    let projectACalls = 0;
    const targets: RendererConfigurationTarget[] = [];
    const api: DigitalHumansLibraryApi = {
      listProfiles: (target) => {
        targets.push(target);
        if ("projectId" in target && target.projectId === "project-b") return projectB.promise;
        projectACalls += 1;
        if (projectACalls === 1) return firstProjectA.promise;
        if (projectACalls === 2) return projectAReload.promise;
        return Promise.resolve([profile("project-a-retried")]);
      },
      listProfileCatalog: async () => [],
      listDigitalHumanTeams: async () => [],
      listSkills: async () => [],
    };
    let target: RendererConfigurationTarget = { projectId: "project-a" };
    const hook = await renderHook(() => useDigitalHumansLibrary(target, api));
    cleanup = hook.unmount;
    expect(hook.result.current.status).toBe("loading");

    target = { projectId: "project-b" };
    await hook.rerender();
    target = { projectId: "project-a" };
    await hook.rerender();
    expect(hook.result.current.status).toBe("loading");
    expect(hook.result.current.profiles).toEqual([]);

    await act(async () => {
      projectAReload.reject(new Error("project-a reload failed"));
      await flushMicrotasks();
      firstProjectA.resolve([profile("stale-project-a")]);
      projectB.resolve([profile("stale-project-b")]);
      await flushMicrotasks();
    });
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("project-a reload failed");
    expect(hook.result.current.profiles).toEqual([]);

    await act(async () => {
      await hook.result.current.refresh();
      await flushMicrotasks();
    });
    expect(hook.result.current.status).toBe("ready");
    expect(hook.result.current.profiles.map((entry) => entry.name)).toEqual(["project-a-retried"]);
    expect(targets).toEqual([
      { projectId: "project-a" },
      { projectId: "project-b" },
      { projectId: "project-a" },
      { projectId: "project-a" },
    ]);
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
    const hook = await renderHook(() => useDigitalHumansLibrary({ noRepo: true }, api));
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
    expect(hook.result.current.dirty).toBe(false);
    await act(async () => {
      hook.result.current.setName("Delivery v2");
      hook.result.current.setDescription("Updated description");
      hook.result.current.toggleMember("reviewer");
      await flushMicrotasks();
    });

    expect(hook.result.current.dirty).toBe(true);
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

  test("caps the roster and rejects text beyond the persisted team limits", async () => {
    ensureMiniDom();
    const profiles = Array.from({ length: DIGITAL_HUMAN_TEAM_MEMBER_MAX + 1 }, (_, index) =>
      profile(`member-${index}`),
    );
    const hook = await renderHook(() => useDigitalHumanTeamDraft(true, undefined, profiles));
    cleanup = hook.unmount;

    await act(async () => {
      hook.result.current.setName("Bounded team");
      for (const member of profiles) hook.result.current.toggleMember(member.name);
      await flushMicrotasks();
    });
    expect(hook.result.current.members.size).toBe(DIGITAL_HUMAN_TEAM_MEMBER_MAX);
    expect(hook.result.current.members.has(profiles.at(-1)!.name)).toBe(false);
    expect(hook.result.current.canSave).toBe(true);

    await act(async () => {
      hook.result.current.setName("x".repeat(DIGITAL_HUMAN_TEAM_NAME_LIMIT + 1));
      await flushMicrotasks();
    });
    expect(hook.result.current.canSave).toBe(false);
    expect(hook.result.current.toTeam()).toBeNull();

    await act(async () => {
      hook.result.current.setName("Bounded team");
      hook.result.current.setPlaybook("x".repeat(DIGITAL_HUMAN_TEAM_PLAYBOOK_LIMIT + 1));
      await flushMicrotasks();
    });
    expect(hook.result.current.canSave).toBe(false);
    expect(hook.result.current.toTeam()).toBeNull();
  });
});
