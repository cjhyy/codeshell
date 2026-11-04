import { describe, expect, test } from "bun:test";

// Each query-suffixed import is a fresh module instance: what a renderer
// reload gives PanelArea, while terminal shells keyed by tab id survive it.
async function freshLoad(tag: string) {
  // @ts-expect-error Bun supports query-suffixed TypeScript module imports.
  return (await import(`./panelTabIds.ts?${tag}`)) as typeof import("./panelTabIds");
}

describe("panel tab ids", () => {
  test("ids stay unique within one load and skip ids already present", async () => {
    const ids = await freshLoad("one-load");
    const first = ids.nextPanelTabId("terminal", []);
    const second = ids.nextPanelTabId("terminal", [{ id: first, kind: "terminal" }]);
    expect(second).not.toBe(first);
    const ahead = `terminal-${Number(second.slice("terminal-".length)) + 50}`;
    const next = ids.nextPanelTabId("terminal", [{ id: ahead, kind: "terminal" }]);
    expect(Number(next.slice("terminal-".length))).toBeGreaterThan(
      Number(ahead.slice("terminal-".length)),
    );
  });

  test("a reload never reissues an id from an earlier load", async () => {
    const before = await freshLoad("before-reload");
    const closedBeforeReload = before.nextPanelTabId("terminal", []);
    const restored = before.nextPanelTabId("terminal", []);
    await new Promise((resolve) => setTimeout(resolve, 2));

    const after = await freshLoad("after-reload");
    // The restored tab was closed before any new tab was opened: neither id
    // remains in the bucket, but both shells may still be alive in Main.
    const reopened = after.nextPanelTabId("terminal", []);
    expect(reopened).not.toBe(closedBeforeReload);
    expect(reopened).not.toBe(restored);
    expect(reopened).not.toBe("terminal-1");
  });
});

describe("CC Room task tabs", () => {
  const job = (jobId: string) => ({
    nonce: 1,
    jobId,
    sourceSessionId: "parent",
    cliKind: "claude-code" as const,
    cwd: "/repo",
  });

  test("a task link binds one CC Room tab and never takes over the session list", async () => {
    const { cliSessionForTab, cliTaskKey, placeCliTaskTab } = await import("./cliTaskTabs");
    const list = { id: "ccRoom-1", kind: "ccRoom" };
    const first = placeCliTaskTab([list], cliTaskKey(job("job-1"))!, {
      id: "ccRoom-2",
      kind: "ccRoom",
    });
    expect(first).toEqual({
      activeId: "ccRoom-2",
      tabs: [list, { id: "ccRoom-2", kind: "ccRoom", cliTask: "parent:job-1" }],
    });
    // The list tab renders no task; the bound tab renders only its own task.
    expect(cliSessionForTab(list, job("job-1"))).toBeUndefined();
    expect(cliSessionForTab(first.tabs[1]!, job("job-1"))).toEqual(job("job-1"));
    expect(cliSessionForTab(first.tabs[1]!, job("job-2"))).toBeUndefined();

    // Another task reuses the task tab instead of opening a third.
    const second = placeCliTaskTab(first.tabs, cliTaskKey(job("job-2"))!, {
      id: "ccRoom-3",
      kind: "ccRoom",
    });
    expect(second).toEqual({
      activeId: "ccRoom-2",
      tabs: [list, { id: "ccRoom-2", kind: "ccRoom", cliTask: "parent:job-2" }],
    });
    // The same task again only focuses it.
    expect(placeCliTaskTab(second.tabs, "parent:job-2", list).tabs).toBe(second.tabs);
  });

  test("a plain room request goes to list tabs only", async () => {
    const { cliSessionForTab, cliTaskKey } = await import("./cliTaskTabs");
    const linked = { nonce: 2, externalSessionId: "s-1", cliKind: "codex" as const, cwd: "/repo" };
    expect(cliTaskKey(linked)).toBeUndefined();
    expect(cliSessionForTab({ id: "a", kind: "ccRoom" }, linked)).toBe(linked);
    expect(
      cliSessionForTab({ id: "b", kind: "ccRoom", cliTask: "parent:job-1" }, linked),
    ).toBeUndefined();
  });
});
