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
          activeProjectId={null}
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
          activeProjectPath="/tmp/project"
          messageCwd="/tmp/project"
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
    const expandPluginCommand = mock(async () => ({
      prompt: "Review src/app.ts for security issues.",
    }));
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        sttAvailable: async () => ({ available: false }),
        listPluginCommands: async () => [
          {
            name: "demo:review",
            pluginName: "demo",
            description: "Review a code change",
            argumentHint: "<path> [FOCUS=value]",
          },
        ],
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
          onSend={onSend}
          onStop={() => undefined}
          busy={false}
          activeProjectId={null}
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
          activeProjectPath="/tmp/project"
          messageCwd="/tmp/project"
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
      "/tmp/project",
      "demo:review",
      '"src/app.ts" FOCUS=security',
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(reactProps(findComposer(container)).value).toBe(
      "Review src/app.ts for security issues.",
    );
  });
});
