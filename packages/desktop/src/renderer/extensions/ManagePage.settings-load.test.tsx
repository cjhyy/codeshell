import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { SkillSummary } from "../../main/skills-service";

ensureMiniDom();
const { ManagePage } = await import("./ManagePage");
const { DialogProvider } = await import("../ui/DialogProvider");

let root: Root | undefined;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = undefined;
});

function nodes(node: unknown): unknown[] {
  const current = node as { childNodes?: unknown[] };
  return [node, ...Array.from(current.childNodes ?? []).flatMap(nodes)];
}

function props(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function plugin(name: string) {
  return {
    name,
    displayName: name,
    installKey: `${name}@local`,
    marketplace: null,
    sourceLabel: "Local",
    installPath: `/fixture/${name}`,
    installedAt: "fixture",
    version: "1",
    skillCount: 0,
    mediaAvailability: { composerIcon: false, logo: false, logoDark: false },
  };
}

test("plugin switches stay inert until settings load and then keep unrelated disables", async () => {
  let resolveSkills!: (skills: SkillSummary[]) => void;
  const skills = new Promise<SkillSummary[]>((resolve) => (resolveSkills = resolve));
  let disk: Record<string, unknown> = {
    disabledPlugins: ["alpha"],
    disabledSkills: ["alpha:skill"],
  };
  const writes: Record<string, unknown>[] = [];
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    writable: true,
    value: {
      listSkills: () => skills,
      getSettings: async () => structuredClone(disk),
      listPlugins: async () => [plugin("alpha"), plugin("beta")],
      checkPluginUpdate: async () => ({ updateAvailable: false }),
      updateSettings: async (_scope: string, patch: Record<string, unknown>) => {
        writes.push(patch);
        disk = { ...disk, ...patch };
      },
    },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <DialogProvider>
        <ManagePage
          cwd="/fixture"
          configurationTarget={{ noRepo: true }}
          activeProjectPath={null}
        />
      </DialogProvider>,
    );
    await flushMicrotasks();
  });
  const switches = () => nodes(container).filter((node) => props(node).role === "switch");
  const click = async (node: unknown) => {
    await act(async () => {
      props(node).onClick({ defaultPrevented: false, stopPropagation() {} });
      await flushMicrotasks();
    });
  };
  expect(switches()).toHaveLength(2);

  // The skill scan is still pending, so a plugin cascade cannot be computed.
  expect(props(switches()[1]).disabled).toBe(true);
  await click(switches()[1]);
  expect(writes).toEqual([]);

  await act(async () => {
    resolveSkills([
      {
        name: "alpha:skill",
        source: "plugin",
        filePath: "/fixture/alpha/SKILL.md",
        description: "fixture",
      } as SkillSummary,
    ]);
    await flushMicrotasks();
  });
  expect(props(switches()[0])["aria-checked"]).toBe(false);
  expect(props(switches()[1])["aria-checked"]).toBe(true);
  expect(props(switches()[1]).disabled).toBe(false);

  await click(switches()[1]);
  expect(writes).toHaveLength(1);
  expect(disk.disabledPlugins).toEqual(["alpha", "beta"]);
  expect(disk.disabledSkills).toEqual(["alpha:skill"]);
  expect(props(switches()[1])["aria-checked"]).toBe(false);
});
