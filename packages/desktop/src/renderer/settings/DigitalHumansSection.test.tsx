import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import {
  DigitalHumansSection,
  nextPetPatch,
  nextPetProjectOverridePatch,
  PetExternalSessionsToggles,
} from "./DigitalHumansSection";

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElements(node: unknown, tagName: string): any[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

// Radix Switch renders as a <button role="switch">. Find each toggle by the
// label text of its sibling <span>, matched via the surrounding <label>.
function switchButtons(container: unknown): any[] {
  return findElements(container, "BUTTON").filter(
    (button) => reactPropsOf(button).role === "switch",
  );
}

// useEffect (the profile fetch + settings load) does not run under
// renderToStaticMarkup, so the static render shows the section frame with the
// pet external-session toggles in their default (unchecked) state — no
// window.codeshell access is needed at module load / static render.
describe("DigitalHumansSection — pet external session toggles (global scope)", () => {
  test("renders both external-session toggles with their labels + descriptions", () => {
    const html = renderToStaticMarkup(<DigitalHumansSection scope="user" projectPath={null} />);
    // Codex toggle
    expect(html).toContain("在 Pet 全局视图显示 Codex CLI/App 会话");
    expect(html).toContain("~/.codex");
    // Claude toggle
    expect(html).toContain("在 Pet 全局视图显示 Claude Code 会话");
    expect(html).toContain("~/.claude");
    // Two switches rendered (Radix switch renders role="switch" buttons).
    const switches = html.match(/role="switch"/g) ?? [];
    expect(switches.length).toBe(2);
  });

  test("both toggles default to unchecked (aria-checked=false) before settings load", () => {
    const html = renderToStaticMarkup(<DigitalHumansSection scope="user" projectPath={null} />);
    const unchecked = html.match(/aria-checked="false"/g) ?? [];
    expect(unchecked.length).toBe(2);
    expect(html).not.toContain('aria-checked="true"');
  });

  test("renders both pet toggles alongside ProfileSection in project scope", () => {
    const html = renderToStaticMarkup(<DigitalHumansSection scope="project" projectPath="/a" />);
    expect(html).toContain("给这个 Workspace 设一个默认数字同事");
    expect(html).toContain("在 Pet 全局视图显示 Codex CLI/App 会话");
    expect(html).toContain("在 Pet 全局视图显示 Claude Code 会话");
    expect(html.match(/role="switch"/g)).toHaveLength(2);
  });
});

describe("nextPetPatch — write-back merge", () => {
  test("sets the flipped codex key", () => {
    expect(nextPetPatch({}, "showExternalCodexSessions", true)).toEqual({
      showExternalCodexSessions: true,
    });
  });

  test("preserves the other toggle's current value when flipping one", () => {
    const current = { showExternalClaudeSessions: true };
    expect(nextPetPatch(current, "showExternalCodexSessions", true)).toEqual({
      showExternalClaudeSessions: true,
      showExternalCodexSessions: true,
    });
  });

  test("preserves unrelated pet fields", () => {
    const current = { skin: "dino", showExternalCodexSessions: true };
    expect(nextPetPatch(current, "showExternalClaudeSessions", false)).toEqual({
      skin: "dino",
      showExternalCodexSessions: true,
      showExternalClaudeSessions: false,
    });
  });

  test("builds project on/off/inherit patches under capabilityOverrides.pet", () => {
    expect(nextPetProjectOverridePatch("showExternalCodexSessions", true)).toEqual({
      capabilityOverrides: { pet: { showExternalCodexSessions: "on" } },
    });
    expect(nextPetProjectOverridePatch("showExternalClaudeSessions", false)).toEqual({
      capabilityOverrides: { pet: { showExternalClaudeSessions: "off" } },
    });
    expect(nextPetProjectOverridePatch("showExternalCodexSessions", "inherit")).toEqual({
      capabilityOverrides: { pet: { showExternalCodexSessions: null } },
    });
  });
});

// Interactive mount (createRoot + real click) mirroring ProfileSection.test.tsx.
// We mount PetExternalSessionsToggles directly rather than the whole
// DigitalHumansSection: the section embeds a Radix Dialog (DigitalHumanEditorDialog)
// whose portal/presence machinery never settles under the mini-dom shim and hangs
// the async act(). The toggles subcomponent is the unit under test and mounts cleanly.
//
// The fake is stateful (writes persist), matching real settings: writeSettings
// fires codeshell:settings-changed on success, which re-runs the component's
// load() — a static fake would clobber the optimistic state on that reload.
describe("PetExternalSessionsToggles — toggle interaction (global scope)", () => {
  let root: Root | null = null;

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
        await flushMicrotasks();
      });
    }
    root = null;
  });

  interface Fake {
    updateArgs: Array<[string, Record<string, unknown>, string | undefined]>;
    rejectUpdate: boolean;
  }

  function installFake(initialPet: Record<string, unknown>): Fake {
    const fake: Fake = { updateArgs: [], rejectUpdate: false };
    let stored: Record<string, unknown> = { pet: { ...initialPet } };
    Object.assign(window, {
      codeshell: {
        // Deep-copy so the component can't mutate the backing store.
        getSettings: async () => JSON.parse(JSON.stringify(stored)),
        updateSettings: async (
          scope: string,
          patch: Record<string, unknown>,
          projectPath?: string,
        ) => {
          fake.updateArgs.push([scope, patch, projectPath]);
          if (fake.rejectUpdate) throw new Error("write failed");
          // Deep-merge the pet subtree like the real settings service does, so a
          // subsequent getSettings() (triggered by the settings-changed event)
          // reflects the write.
          const petPatch = (patch.pet ?? {}) as Record<string, unknown>;
          stored = {
            ...stored,
            pet: { ...((stored.pet as Record<string, unknown>) ?? {}), ...petPatch },
          };
        },
      },
    });
    return fake;
  }

  async function mount(
    element: React.ReactNode = <PetExternalSessionsToggles />,
  ): Promise<HTMLElement> {
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(element);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    return container;
  }

  async function clickSwitch(button: unknown): Promise<void> {
    await act(async () => {
      reactPropsOf(button).onClick?.({});
      await flushMicrotasks();
      await flushMicrotasks();
    });
  }

  test("(a) clicking the Codex switch flips it to checked (optimistic + persisted)", async () => {
    ensureMiniDom();
    installFake({});
    const container = await mount();

    const [codexSwitch] = switchButtons(container);
    expect(reactPropsOf(codexSwitch)["aria-checked"]).toBe(false);

    await clickSwitch(codexSwitch);

    const [codexAfter] = switchButtons(container);
    expect(reactPropsOf(codexAfter)["aria-checked"]).toBe(true);
  });

  test("(b) write patch carries pet.showExternalCodexSessions=true and preserves the Claude key", async () => {
    ensureMiniDom();
    const fake = installFake({ showExternalClaudeSessions: true });
    const container = await mount();

    // Codex is the first switch, Claude the second; initial state reflects load.
    const [codexSwitch, claudeSwitch] = switchButtons(container);
    expect(reactPropsOf(codexSwitch)["aria-checked"]).toBe(false);
    expect(reactPropsOf(claudeSwitch)["aria-checked"]).toBe(true);

    await clickSwitch(codexSwitch);

    expect(fake.updateArgs).toHaveLength(1);
    const [scope, patch, projectPath] = fake.updateArgs[0];
    expect(scope).toBe("user");
    expect(projectPath).toBeUndefined();
    // The other toggle's value is carried through — flipping one never drops it.
    expect(patch).toEqual({
      pet: { showExternalClaudeSessions: true, showExternalCodexSessions: true },
    });
  });

  test("(c) a rejected write rolls the switch back to unchecked", async () => {
    ensureMiniDom();
    const fake = installFake({});
    fake.rejectUpdate = true;
    const container = await mount();

    const [codexSwitch] = switchButtons(container);
    await clickSwitch(codexSwitch);

    expect(fake.updateArgs).toHaveLength(1);
    const [codexAfter] = switchButtons(container);
    expect(reactPropsOf(codexAfter)["aria-checked"]).toBe(false);
  });

  test("project switch resolves the global baseline and writes a force-off override", async () => {
    ensureMiniDom();
    const updateArgs: Array<[string, Record<string, unknown>, string | undefined]> = [];
    let projectSettings: Record<string, unknown> = { capabilityOverrides: {} };
    Object.assign(window, {
      codeshell: {
        getSettings: async (scope: string) =>
          scope === "user" ? { pet: { showExternalCodexSessions: true } } : projectSettings,
        updateSettings: async (
          scope: string,
          patch: Record<string, unknown>,
          projectPath?: string,
        ) => {
          updateArgs.push([scope, patch, projectPath]);
          projectSettings = patch;
        },
      },
    });
    const container = await mount(
      <PetExternalSessionsToggles scope="project" projectPath="/work/a" />,
    );

    const [codexSwitch] = switchButtons(container);
    expect(reactPropsOf(codexSwitch)["aria-checked"]).toBe(true);
    await clickSwitch(codexSwitch);

    expect(updateArgs).toEqual([
      [
        "project",
        { capabilityOverrides: { pet: { showExternalCodexSessions: "off" } } },
        "/work/a",
      ],
    ]);
    expect(reactPropsOf(switchButtons(container)[0])["aria-checked"]).toBe(false);
  });
});
