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
