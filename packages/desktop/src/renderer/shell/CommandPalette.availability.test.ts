import { describe, expect, test } from "bun:test";
import { ensureMiniDom } from "../test-utils/renderHook";

// App suites mock the canonical palette module; use the actual registry here.
const { buildCommands } = await import("./CommandPalette?workspace-availability");

describe("command palette workspace availability", () => {
  test("hides Git review until available, while keeping general panels usable", () => {
    ensureMiniDom();
    const opened: string[] = [];
    const options = {
      setViewMode: () => {},
      openPanel: (kind: string) => opened.push(kind),
      toggleSidebar: () => {},
      toggleInspector: () => {},
      clearTranscript: () => {},
      openSearch: () => {},
    };
    for (const gitReviewAvailable of [undefined, false]) {
      const commands = buildCommands({ ...options, gitReviewAvailable });
      expect(commands.some((command) => command.id === "go.review")).toBe(false);
      expect(commands.some((command) => command.id === "go.files")).toBe(true);
      expect(commands.some((command) => command.id === "go.browser")).toBe(true);
      expect(commands.some((command) => command.id === "go.terminal")).toBe(true);
    }
    buildCommands({ ...options, gitReviewAvailable: true })
      .find((command) => command.id === "go.review")!
      .run();
    expect(opened).toEqual(["review"]);
  });
});

test("task inbox command follows its shared user feature flag", () => {
  ensureMiniDom();
  const options = {
    setViewMode: () => {},
    openPanel: () => {},
    toggleSidebar: () => {},
    toggleInspector: () => {},
    clearTranscript: () => {},
    openSearch: () => {},
  };
  expect(
    buildCommands({ ...options, taskInboxEnabled: false }).some(
      (command) => command.id === "go.taskInbox",
    ),
  ).toBe(false);
  let target: string | undefined;
  buildCommands({
    ...options,
    taskInboxEnabled: true,
    setViewMode: (mode) => {
      target = mode;
    },
  })
    .find((command) => command.id === "go.taskInbox")!
    .run();
  expect(target).toBe("task_inbox");
});
