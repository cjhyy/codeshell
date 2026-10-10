import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  LinkConnectionInput,
  LinkSnapshot,
  MaskedLinkConnection,
} from "@cjhyy/code-shell-link";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { Message } from "./types";
import { LINK_PROVIDER_MANIFESTS } from "../../../link/src/catalog";
import { createChatLinkReadHandler } from "./chat/linkResourceIntents";

// Keep the actual controller and dialog; only Radix portals are replaced for the mini DOM.
mock.module("@/components/ui/dialog", () =>
  Object.fromEntries(
    [
      "Dialog",
      "DialogContent",
      "DialogHeader",
      "DialogFooter",
      "DialogTitle",
      "DialogDescription",
    ].map((name) => [
      name,
      ({ open, children }: { open?: boolean; children: React.ReactNode }) =>
        name !== "Dialog" || open ? React.createElement("div", null, children) : null,
    ]),
  ),
);
// @ts-expect-error Bun query suffix keeps the real component if another suite mocks ChatView.
const { ChatView } = await import("./ChatView.tsx?link-resource-test");

function descendants(node: any): any[] {
  return Array.from(node?.childNodes ?? []).flatMap((child: any) => [child, ...descendants(child)]);
}
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function childText(value: any): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(childText).join("");
  return value?.props ? childText(value.props.children) : "";
}
function button(container: HTMLElement, label: string): any {
  return descendants(container).find(
    (node) => node.tagName === "BUTTON" && childText(props(node).children) === label,
  );
}
function connection(id = "one", files: string[] = []): MaskedLinkConnection {
  return {
    id,
    providerId: "figma",
    methodId: "remote-link",
    label: `Design ${id}`,
    runtime: "server",
    authSource: "remote-link",
    status: "connected",
    account: {
      id: `account-${id}`,
      label: `user-${id}`,
      resources: files.map((key) => `Display ${key}`),
      resourceGroups: [{ id: "files", items: files.map((id) => ({ id, label: `Display ${id}` })) }],
    },
    capabilityIds: ["figma.get_file", "figma.get_comments"],
    revision: `revision-${id}-${files.length}`,
    scope: "user",
    editable: true,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: Root | undefined;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = undefined;
});

async function fixture(
  options: {
    connections?: MaskedLinkConnection[];
    history?: Message[];
    draftSession?: boolean;
    busy?: boolean;
    queued?: boolean;
    delayedStart?: Promise<unknown>;
    preparedBucket?: string;
  } = {},
) {
  ensureMiniDom();
  const initial = options.draftSession ? "project::_none_" : "project::session-one";
  let liveBucket = initial;
  let liveCwd = "/tmp/project";
  let configurationAvailable = true;
  const synchronousBusy = new Set<string>();
  let update!: React.Dispatch<
    React.SetStateAction<{ bucket: string; busy: boolean; messages: Message[] }>
  >;
  let currentSnapshot: LinkSnapshot = {
    providers: [
      {
        ...LINK_PROVIDER_MANIFESTS.find((item) => item.id === "figma")!,
        tokenLabel: "Token",
        tokenPlaceholder: "",
        actions: [],
        authModes: [
          {
            id: "remote-link",
            methodId: "remote-link",
            kind: "redirect",
            label: "Browser",
            available: true,
          },
        ],
      },
    ],
    connections: options.connections ?? [connection()],
    capabilities: { token: false, cliBinding: false, deviceAuth: false, remoteAuth: true },
    revision: "snapshot-one",
  };
  const starts: LinkConnectionInput[] = [];
  const cancellations: string[] = [];
  const reads: Array<{ text: string; bucket: string; clientMessageId: string }> = [];
  const submissions: Array<{ text: string; opts: Record<string, any> }> = [];
  let prepareCalls = 0;
  let snapshotCalls = 0;
  let nextSnapshot: (() => Promise<LinkSnapshot>) | undefined;
  let startConnected = false;
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    writable: true,
    value: {
      sttAvailable: async () => ({ available: false }),
      listPluginCommands: async () => [],
      getProjectGitBranches: async () => ({ current: "main", branches: ["main"] }),
      onPluginCommandsChanged: () => () => undefined,
      links: {
        remoteSnapshot: async () => {
          snapshotCalls++;
          return nextSnapshot ? nextSnapshot() : currentSnapshot;
        },
        authorizationStart: async (_cwd: string, id: string, input: LinkConnectionInput) => {
          starts.push(input);
          if (options.delayedStart) return options.delayedStart;
          if (startConnected) {
            const saved = connection(
              input.connectionId ?? "created",
              input.resourceUrl ? ["FileOne"] : [],
            );
            currentSnapshot = { ...currentSnapshot, connections: [saved] };
            return {
              id,
              providerId: "figma",
              methodId: "remote-link",
              state: "connected",
              connection: saved,
            };
          }
          return {
            id,
            providerId: "figma",
            methodId: "remote-link",
            state: "pending",
            step: {
              id: "redirect",
              kind: "redirect",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              authorizationUrl: "https://fixture.invalid/authorize",
            },
          };
        },
        authorizationGet: async () => {
          throw new Error("unexpected polling in immediate UI test");
        },
        authorizationCancel: async (_cwd: string, id: string) => {
          cancellations.push(id);
          return { id, providerId: "figma", state: "cancelled" };
        },
        authorizationOpen: async () => undefined,
      },
    },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  function Host() {
    const [state, setState] = React.useState({
      bucket: initial,
      busy: options.busy ?? false,
      messages: options.history ?? [],
    });
    const [draft, setDraft] = React.useState("");
    update = setState;
    const submit = (text: string, opts: Record<string, any> = {}) => {
      submissions.push({ text, opts });
      liveBucket = opts.bucket ?? state.bucket;
      setState((old) => ({
        ...old,
        bucket: liveBucket,
        messages: [
          ...old.messages,
          {
            kind: "user",
            id: `u${submissions.length}`,
            text,
            clientMessageId: opts.clientMessageId,
            ...(options.queued ? { injected: true } : {}),
          },
        ],
      }));
    };
    return (
      <ChatView
        messages={state.messages}
        sendBucket={state.bucket}
        engineSessionId={state.bucket.split("::")[1]}
        onSend={submit}
        onQueueInput={submit}
        onForceSend={submit}
        onReadLinkResource={createChatLinkReadHandler(
          () => ({
            bucket: liveBucket,
            cwd: liveCwd,
            available: configurationAvailable,
            busy: state.busy || synchronousBusy.has(liveBucket),
            compacting: false,
          }),
          (text, opts) => {
            synchronousBusy.add(opts.bucket);
            reads.push({ text, bucket: opts.bucket, clientMessageId: opts.clientMessageId });
            expect(opts.suppressGoal).toBe(true);
          },
        )}
        onPrepareLinkSubmission={() => {
          if (liveBucket.endsWith("::_none_")) {
            prepareCalls++;
            liveBucket = options.preparedBucket ?? "project::session-created";
          }
          return { cwd: "/tmp/project", bucket: liveBucket };
        }}
        onStop={() => undefined}
        busy={state.busy}
        activeProjectId="project"
        permissionMode="plan"
        onPermissionChange={() => undefined}
        goalEnabled
        onGoalToggle={() => undefined}
        modelOptions={[{ key: "model", label: "Test", provider: "test", supportsVision: true }]}
        activeModelKey="model"
        onModelChange={() => undefined}
        contextTokens={0}
        projects={[]}
        onSelectProject={() => undefined}
        onAddProject={() => undefined}
        configurationTarget={{ sessionId: state.bucket.split("::")[1]! }}
        configurationAvailable
        conversationRoot="/tmp/project"
        draft={draft}
        onDraftChange={setDraft}
        attachments={[]}
        onAttachmentsChange={() => undefined}
      />
    );
  }
  await act(async () => {
    root!.render(<Host />);
    await flushMicrotasks();
  });
  const type = async (text: string) => {
    await act(async () => {
      const textarea = descendants(container).find((node) => props(node).rows === 1);
      props(textarea).onChange({ target: { value: text, selectionStart: text.length } });
      await flushMicrotasks();
    });
  };
  const send = async (text = "读取 https://www.figma.com/design/FileOne/Design?node-id=0-1") => {
    await type(text);
    await act(async () => {
      const textarea = descendants(container).find((node) => props(node).rows === 1);
      props(textarea).onKeyDown({
        key: "Enter",
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault() {},
      });
      await flushMicrotasks();
      await flushMicrotasks();
    });
  };
  const click = async (label: string) => {
    const node = button(container, label);
    expect(node).toBeDefined();
    await act(async () => {
      props(node).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
  };
  return {
    container,
    starts,
    cancellations,
    reads,
    submissions,
    send,
    click,
    type,
    snapshotCalls: () => snapshotCalls,
    prepareCalls: () => prepareCalls,
    setSnapshot: (value: LinkSnapshot) => {
      currentSnapshot = value;
    },
    snapshot: () => currentSnapshot,
    nextSnapshot: (value: (() => Promise<LinkSnapshot>) | undefined) => {
      nextSnapshot = value;
    },
    completeImmediately: () => {
      startConnected = true;
    },
    navigate: async (bucket: string, messages: Message[] = []) => {
      liveBucket = bucket;
      await act(async () => {
        update((state) => ({ ...state, bucket, messages }));
        await flushMicrotasks();
      });
    },
    setBusy: async (busy: boolean) => {
      await act(async () => {
        update((state) => ({ ...state, busy }));
        await flushMicrotasks();
      });
    },
    changeLiveBucket: (bucket: string) => {
      liveBucket = bucket;
    },
    changeLiveCwd: (cwd: string) => {
      liveCwd = cwd;
    },
    disableConfiguration: () => {
      configurationAvailable = false;
    },
  };
}

describe("chat file authorization", () => {
  test("history, assistant, tool, and engine-only user text cannot register file candidates", async () => {
    const url = "https://figma.com/design/FileOne/Name";
    const f = await fixture({
      history: [
        { kind: "user", id: "history", text: url, clientMessageId: "history-id" },
        { kind: "user", id: "injected", text: url, injected: true },
        { kind: "assistant", id: "assistant", text: url, done: true },
        {
          kind: "tool",
          id: "tool",
          toolName: "Source",
          args: "{}",
          result: url,
          status: "succeeded",
          startedAt: 1,
        },
      ],
    });
    expect(descendants(f.container).some((node) => props(node)["data-chat-link-resource"])).toBe(
      false,
    );
    expect(f.snapshotCalls()).toBe(0);
    expect(f.starts).toHaveLength(0);
  });

  test("a local first send pins the real session; only a subsequent click starts exact file consent", async () => {
    const f = await fixture({ draftSession: true });
    await f.send();
    expect(f.prepareCalls()).toBe(1);
    expect(f.submissions[0]!.opts.bucket).toBe("project::session-created");
    expect(f.submissions[0]!.opts.clientMessageId).toBeString();
    expect(button(f.container, "授权此文件")).toBeDefined();
    expect(f.starts).toHaveLength(0);
    expect(f.reads).toHaveLength(0);
    await f.click("授权此文件");
    expect(f.starts).toEqual([
      {
        providerId: "figma",
        methodId: "remote-link",
        label: "Design one",
        connectionId: "one",
        expectedRevision: "revision-one-0",
        resourceUrl: "https://www.figma.com/design/FileOne/Design?node-id=0-1",
      },
    ]);
    await f.click("取消");
    expect(f.cancellations.length).toBeGreaterThan(0);
    expect(f.snapshot().connections[0]!.account!.resourceGroups![0]!.items).toEqual([]);
    expect(f.reads).toHaveLength(0);
  });

  test("completion never sends a model turn; one explicit read uses the selected connection once", async () => {
    const f = await fixture();
    f.completeImmediately();
    await f.send();
    await f.click("授权此文件");
    expect(f.reads).toHaveLength(0);
    const read = button(f.container, "读取文件");
    expect(read).toBeDefined();
    await act(async () => {
      props(read).onClick();
      props(read).onClick();
      await flushMicrotasks();
    });
    expect(f.reads).toHaveLength(1);
    expect(f.reads[0]!.bucket).toBe("project::session-one");
    expect(f.reads[0]!.text).toContain('"connectionId":"one"');
    expect(f.reads[0]!.text).toContain(
      '"file_url_or_key":"https://www.figma.com/design/FileOne/Design?node-id=0-1"',
    );
    expect(f.starts).toHaveLength(1);
  });

  test("draft preparation uses the live project bucket instead of the rendered project", async () => {
    const f = await fixture({ draftSession: true, preparedBucket: "other-project::live-session" });
    await f.send();
    expect(f.submissions[0]!.opts.bucket).toBe("other-project::live-session");
    expect(f.submissions[0]!.opts.clientMessageId).toBeString();
    expect(button(f.container, "授权此文件")).toBeDefined();
    expect(f.starts).toHaveLength(0);
  });

  test("already authorized files read directly without reauthorization and require account selection", async () => {
    const f = await fixture({ connections: [connection("one", ["FileOne"]), connection("two")] });
    await f.send();
    const select = descendants(f.container).find((node) => node.tagName === "SELECT");
    expect(select).toBeDefined();
    expect(childText(props(select).children)).toContain("Design one · user-one");
    expect(props(button(f.container, "连接 Figma")).disabled).toBe(true);
    await act(async () => {
      props(select).onChange({ target: { value: "one" } });
      await flushMicrotasks();
    });
    await f.click("读取文件");
    expect(f.starts).toHaveLength(0);
    expect(f.reads).toHaveLength(1);
    expect(f.reads[0]!.text).toContain('"connectionId":"one"');
  });

  test("a revision change between review and click refreshes the card without granting or reading", async () => {
    const f = await fixture();
    await f.send();
    f.setSnapshot({ ...f.snapshot(), connections: [{ ...connection(), revision: "changed" }] });
    await f.click("授权此文件");
    expect(f.starts).toHaveLength(0);
    expect(f.reads).toHaveLength(0);
    expect(descendants(f.container).some((node) => props(node).role === "alert")).toBe(true);
  });

  test("local Figma credentials do not prevent connecting a separate remote account", async () => {
    const f = await fixture({
      connections: [{ ...connection("local"), authSource: "manual-token", runtime: "local" }],
    });
    await f.send();
    await f.click("连接 Figma");
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]!.connectionId).toBeUndefined();
    expect(f.starts[0]!.resourceUrl).toBeUndefined();
  });

  test("queued local human input still has provenance when echoed as injected steering", async () => {
    const f = await fixture({ queued: true, busy: true });
    await f.send();
    expect(button(f.container, "授权此文件")).toBeDefined();
    expect(props(button(f.container, "授权此文件")).disabled).toBe(true);
    expect(f.starts).toHaveLength(0);
    await f.setBusy(false);
    await f.click("授权此文件");
    expect(f.starts).toHaveLength(1);
  });

  test("the explicit force-send control registers only the submitted composer URL", async () => {
    const f = await fixture({ busy: true, queued: true });
    await f.type("https://www.figma.com/design/FileOne/Design");
    await f.click("引导");
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]!.opts.clientMessageId).toBeString();
    expect(button(f.container, "授权此文件")).toBeDefined();
    expect(f.starts).toHaveLength(0);
    await f.setBusy(false);
    await f.click("授权此文件");
    expect(f.starts[0]!.resourceUrl).toBe("https://www.figma.com/design/FileOne/Design");
  });

  test("two file read clicks in one frame share the owner's synchronous busy guard", async () => {
    const f = await fixture({ connections: [connection("one", ["FileOne", "FileTwo"])] });
    await f.send("https://figma.com/design/FileOne/One https://figma.com/design/FileTwo/Two");
    const buttons = descendants(f.container).filter(
      (node) => node.tagName === "BUTTON" && childText(props(node).children) === "读取文件",
    );
    expect(buttons).toHaveLength(2);
    await act(async () => {
      props(buttons[0]).onClick();
      props(buttons[1]).onClick();
      await flushMicrotasks();
    });
    expect(f.reads).toHaveLength(1);
    expect(f.starts).toHaveLength(0);
  });

  test("revocation during a reviewed read never silently starts new authorization", async () => {
    const f = await fixture({ connections: [connection("one", ["FileOne"])] });
    await f.send();
    f.setSnapshot({
      ...f.snapshot(),
      connections: [{ ...connection("one", ["FileOne"]), status: "unavailable" }],
    });
    await f.click("读取文件");
    expect(f.starts).toHaveLength(0);
    expect(f.reads).toHaveLength(0);
    expect(descendants(f.container).some((node) => props(node).role === "alert")).toBe(true);
  });

  test.each(["cwd", "configuration"] as const)(
    "owner %s authority changing before commit refuses a read",
    async (kind) => {
      const f = await fixture({ connections: [connection("one", ["FileOne"])] });
      await f.send();
      if (kind === "cwd") f.changeLiveCwd("/tmp/different-project");
      else f.disableConfiguration();
      await f.click("读取文件");
      expect(f.reads).toHaveLength(0);
      expect(f.starts).toHaveLength(0);
    },
  );

  test("switching sessions during a fresh check cannot grant or read in the new session", async () => {
    const f = await fixture({ connections: [connection("one", ["FileOne"])] });
    await f.send();
    const gate = deferred<LinkSnapshot>();
    f.nextSnapshot(() => gate.promise);
    await f.click("读取文件");
    await f.navigate("project::session-two");
    await act(async () => {
      gate.resolve(f.snapshot());
      await flushMicrotasks();
    });
    expect(f.reads).toHaveLength(0);
    expect(f.starts).toHaveLength(0);
    expect(descendants(f.container).some((node) => props(node)["data-chat-link-resource"])).toBe(
      false,
    );
  });

  test("owner live navigation before a React commit refuses a read", async () => {
    const f = await fixture({ connections: [connection("one", ["FileOne"])] });
    await f.send();
    f.changeLiveBucket("project::session-two");
    await f.click("读取文件");
    expect(f.reads).toHaveLength(0);
    expect(f.starts).toHaveLength(0);
  });

  test("unmounting an authorization cancels it; a late completed callback cannot resume", async () => {
    const gate = deferred<unknown>();
    const f = await fixture({ delayedStart: gate.promise });
    await f.send();
    await f.click("授权此文件");
    await f.navigate("project::session-two");
    await act(async () => {
      gate.resolve({
        id: "late",
        providerId: "figma",
        methodId: "remote-link",
        state: "connected",
        connection: connection("one", ["FileOne"]),
      });
      await flushMicrotasks();
    });
    expect(f.cancellations.length).toBeGreaterThan(0);
    expect(f.reads).toHaveLength(0);
  });
});
