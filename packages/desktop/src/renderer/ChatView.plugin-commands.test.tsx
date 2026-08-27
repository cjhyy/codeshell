import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";

// Keep the real component even when another ChatView test installs a module mock.
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { ChatView } = await import("./ChatView.tsx?plugin-command-test");

function descendants(node: any): any[] {
  const children = Array.from(node?.childNodes ?? []) as any[];
  return children.flatMap((child) => [child, ...descendants(child)]);
}

function reactProps(node: any): Record<string, any> {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function findComposer(container: HTMLElement): any {
  const textarea = descendants(container).find((node) => reactProps(node).rows === 1);
  if (!textarea) throw new Error("expected composer textarea");
  return textarea;
}

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

describe("ChatView plugin slash commands", () => {
  test("an external composer seed preserves an existing draft and never submits", async () => {
    ensureMiniDom();
    Object.assign(globalThis, {
      requestAnimationFrame: (_callback: FrameRequestCallback) => 1,
    });
    const onSend = mock(() => undefined);
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      writable: true,
      value: {
        sttAvailable: async () => ({ available: false }),
        listPluginCommands: async () => [],
        onPluginCommandsChanged: () => () => undefined,
      },
    });

    const container = document.createElement("div");
    root = createRoot(container);
    function Host() {
      const [draft, setDraft] = React.useState("existing draft");
      return (
        <ChatView
          variant="quickChat"
          messages={[]}
          onSend={onSend}
          onStop={() => undefined}
          busy={false}
          activeProjectId="project-1"
          permissionMode="plan"
          onPermissionChange={() => undefined}
          goalEnabled={false}
          onGoalToggle={() => undefined}
          modelOptions={[
            {
              key: "test-model",
              label: "Test",
              provider: "test",
              supportsVision: true,
            },
          ]}
          activeModelKey="test-model"
          onModelChange={() => undefined}
          contextTokens={0}
          projects={[]}
          onSelectProject={() => undefined}
          onAddProject={() => undefined}
          configurationTarget={{ projectId: "project-1" }}
          configurationAvailable
          conversationRoot="/tmp/project"
          conversationRootId="root-1"
          composerSeed="Draft this starter prompt"
          composerSeedNonce={1}
          draft={draft}
          onDraftChange={setDraft}
          attachments={[]}
          onAttachmentsChange={() => undefined}
        />
      );
    }

    await act(async () => {
      root?.render(<Host />);
      await flushMicrotasks();
    });

    expect(reactProps(findComposer(container)).value).toBe(
      "existing draft\n\nDraft this starter prompt",
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  test("Enter expands a command into the draft without sending it", async () => {
    ensureMiniDom();
    const onSend = mock(() => undefined);
    const listPluginCommands = mock(async () => [
      {
        name: "demo:review",
        pluginName: "demo",
        description: "Review a code change",
        argumentHint: "<path> [FOCUS=value]",
      },
    ]);
    const expandPluginCommand = mock(async () => ({
      prompt: "Review src/app.ts for security issues.",
    }));
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      writable: true,
      value: {
        sttAvailable: async () => ({ available: false }),
        listPluginCommands,
        expandPluginCommand,
        onPluginCommandsChanged: () => () => undefined,
      },
    });

    const container = document.createElement("div");
    root = createRoot(container);
    function Host() {
      const [draft, setDraft] = React.useState("");
      return (
        <ChatView
          variant="quickChat"
          messages={[]}
          engineSessionId="old-session"
          onSend={onSend}
          onStop={() => undefined}
          busy={false}
          activeProjectId="project-1"
          permissionMode="plan"
          onPermissionChange={() => undefined}
          goalEnabled={false}
          onGoalToggle={() => undefined}
          modelOptions={[
            {
              key: "test-model",
              label: "Test",
              provider: "test",
              supportsVision: true,
            },
          ]}
          activeModelKey="test-model"
          onModelChange={() => undefined}
          contextTokens={0}
          projects={[]}
          onSelectProject={() => undefined}
          onAddProject={() => undefined}
          configurationTarget={{ sessionId: "old-session" }}
          configurationAvailable
          conversationRoot="/tmp/old-root"
          conversationRootId="old-root"
          draft={draft}
          onDraftChange={setDraft}
          attachments={[]}
          onAttachmentsChange={() => undefined}
        />
      );
    }

    await act(async () => {
      root?.render(<Host />);
      await flushMicrotasks();
    });

    let textarea = findComposer(container);
    await act(async () => {
      reactProps(textarea).onChange({
        target: {
          value: '/demo:review "src/app.ts" FOCUS=security',
          selectionStart: 44,
        },
      });
      await flushMicrotasks();
    });

    textarea = findComposer(container);
    await act(async () => {
      reactProps(textarea).onKeyDown({
        key: "Enter",
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => undefined,
      });
      await flushMicrotasks();
    });

    expect(expandPluginCommand).toHaveBeenCalledWith(
      { sessionId: "old-session" },
      "demo:review",
      '"src/app.ts" FOCUS=security',
    );
    expect(listPluginCommands).toHaveBeenCalledWith({ sessionId: "old-session" });
    expect(onSend).not.toHaveBeenCalled();
    expect(reactProps(findComposer(container)).value).toBe(
      "Review src/app.ts for security issues.",
    );
  });

  test("fails closed when Session root authority is unavailable", async () => {
    ensureMiniDom();
    const listPluginCommands = mock(async () => []);
    const listSkills = mock(async () => []);
    const inspectAttachments = mock(async () => []);
    const searchProjectFiles = mock(async () => []);
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      writable: true,
      value: {
        sttAvailable: async () => ({ available: false }),
        listPluginCommands,
        listSkills,
        inspectAttachments,
        searchProjectFiles,
        onPluginCommandsChanged: () => () => undefined,
      },
    });

    const container = document.createElement("div");
    root = createRoot(container);
    function Host() {
      const [draft, setDraft] = React.useState("");
      return (
        <ChatView
          variant="quickChat"
          messages={[]}
          engineSessionId="missing-session"
          onSend={() => undefined}
          onStop={() => undefined}
          busy={false}
          activeProjectId="project-1"
          permissionMode="plan"
          onPermissionChange={() => undefined}
          goalEnabled={false}
          onGoalToggle={() => undefined}
          modelOptions={[]}
          activeModelKey={null}
          onModelChange={() => undefined}
          contextTokens={0}
          projects={[]}
          onSelectProject={() => undefined}
          onAddProject={() => undefined}
          configurationTarget={{ sessionId: "missing-session" }}
          configurationAvailable={false}
          conversationRoot={null}
          conversationRootId={null}
          draft={draft}
          onDraftChange={setDraft}
          attachments={[]}
          onAttachmentsChange={() => undefined}
        />
      );
    }

    await act(async () => {
      root?.render(<Host />);
      await flushMicrotasks();
    });

    const textarea = findComposer(container);
    await act(async () => {
      reactProps(textarea).onChange({ target: { value: "@", selectionStart: 1 } });
      await flushMicrotasks();
    });

    expect(listPluginCommands).not.toHaveBeenCalled();
    expect(listSkills).not.toHaveBeenCalled();
    expect(inspectAttachments).not.toHaveBeenCalled();
    expect(searchProjectFiles).not.toHaveBeenCalled();
  });

  test("uses the Session target and authoritative root for Mention discovery", async () => {
    ensureMiniDom();
    Object.getPrototypeOf(document.createElement("div")).scrollIntoView = () => undefined;
    const listSkills = mock(async () => [
      {
        name: "old-skill",
        description: "from old root",
        filePath: "/old-root/.agents/skills/old-skill/SKILL.md",
        enabled: true,
      },
    ]);
    const inspectAttachments = mock(async () => []);
    const searchProjectFiles = mock(async () => [
      { rootId: "old-root", path: "same-relative.md", name: "same-relative.md", kind: "file" },
      { rootId: "new-root", path: "same-relative.md", name: "same-relative.md", kind: "file" },
    ]);
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      writable: true,
      value: {
        sttAvailable: async () => ({ available: false }),
        listPluginCommands: async () => [],
        listSkills,
        inspectAttachments,
        searchProjectFiles,
        onPluginCommandsChanged: () => () => undefined,
      },
    });

    const container = document.createElement("div");
    root = createRoot(container);
    function Host() {
      const [draft, setDraft] = React.useState("");
      return (
        <ChatView
          variant="quickChat"
          messages={[]}
          engineSessionId="old-session"
          onSend={() => undefined}
          onStop={() => undefined}
          busy={false}
          activeProjectId="project-1"
          permissionMode="plan"
          onPermissionChange={() => undefined}
          goalEnabled={false}
          onGoalToggle={() => undefined}
          modelOptions={[]}
          activeModelKey={null}
          onModelChange={() => undefined}
          contextTokens={0}
          projects={[
            {
              id: "project-1",
              name: "Multi root",
              path: "/new-root",
              roots: [
                { id: "old-root", path: "/old-root", name: "Old", addedAt: 1 },
                { id: "new-root", path: "/new-root", name: "New", addedAt: 2 },
              ],
              primaryRootId: "new-root",
              addedAt: 1,
            },
          ]}
          onSelectProject={() => undefined}
          onAddProject={() => undefined}
          configurationTarget={{ sessionId: "old-session" }}
          configurationAvailable
          conversationRoot="/old-root"
          conversationRootId="old-root"
          draft={draft}
          onDraftChange={setDraft}
          attachments={[]}
          onAttachmentsChange={() => undefined}
        />
      );
    }

    await act(async () => {
      root?.render(<Host />);
      await flushMicrotasks();
    });
    const textarea = findComposer(container);
    await act(async () => {
      reactProps(textarea).onChange({ target: { value: "@same", selectionStart: 5 } });
      await flushMicrotasks();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await flushMicrotasks();
    });

    expect(listSkills).toHaveBeenCalledWith({ sessionId: "old-session" });
    expect(inspectAttachments).toHaveBeenCalledWith({ cwd: "/old-root" });
    expect(searchProjectFiles).toHaveBeenCalledWith("project-1", "same");
    const renderedText = descendants(container)
      .map((node) => node.nodeValue ?? node.textContent ?? "")
      .join("");
    expect(renderedText).toContain("/old-root/same-relative.md");
    expect(renderedText).not.toContain("/new-root/same-relative.md");
  });
});
