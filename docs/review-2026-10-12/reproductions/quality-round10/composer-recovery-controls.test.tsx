import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
const forbidden = (..._args: any[]) => { throw new Error("NETWORK_FORBIDDEN_round10"); };
globalThis.fetch = forbidden as any;
http.request = http.get = forbidden as any;
https.request = https.get = forbidden as any;
net.connect = net.createConnection = forbidden as any;
tls.connect = forbidden as any;
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) {
  throw new Error("guarded HOME required");
}
import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
const { createRoot } = await import("../../../../packages/desktop/node_modules/react-dom/client");
const {
  ensureMiniDom,
  flushMicrotasks,
} = await import("../../../../packages/desktop/src/renderer/test-utils/renderHook");
const { ChatView } = await import("../../../../packages/desktop/src/renderer/ChatView");
const { CODESHELL_PATH_DND_MIME } = await import("../../../../packages/desktop/src/renderer/chat/attachments");
const { buildInputAttachmentContext } = await import("../../../../packages/core/src/engine/input-attachments");

let root: any;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = undefined;
});
function nodes(node: any): any[] {
  return Array.from(node?.childNodes ?? []).flatMap((child: any) => [child, ...nodes(child)]);
}
function props(node: any): any {
  const k = Object.keys(node).find((x) => x.startsWith("__reactProps$"));
  return k ? node[k] : {};
}
function find(container: any, predicate: any) {
  const n = nodes(container).find((n) => predicate(props(n), n));
  if (!n) throw new Error("missing node");
  return n;
}

test("CONTROL removing carried file chip before B send clears the stale reference", async () => {
  ensureMiniDom();
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    writable: true,
    value: {
      sttAvailable: async () => ({ available: false }),
      listPluginCommands: async () => [],
      getProjectGitBranches: async () => ({ current: "main", branches: ["main"] }),
      onPluginCommandsChanged: () => () => {},
      log: () => {},
    },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  let changeSession: any;
  const submissions: any[] = [];
  function Host() {
    const [sid, setSid] = React.useState("A");
    changeSession = setSid;
    const [drafts, setDrafts] = React.useState<Record<string, string>>({
      A: "",
      B: "查看 B 的任务",
    });
    return (
      <ChatView
        messages={[]}
        sendBucket={`project::${sid}`}
        engineSessionId={sid}
        onSend={(text, opts) => submissions.push({ text, opts })}
        onStop={() => {}}
        busy={false}
        activeProjectId="project"
        permissionMode="default"
        onPermissionChange={() => {}}
        goalEnabled={false}
        onGoalToggle={() => {}}
        modelOptions={[{ key: "test", label: "Test", provider: "test", supportsVision: true }]}
        activeModelKey="test"
        onModelChange={() => {}}
        contextTokens={0}
        projects={[]}
        onSelectProject={() => {}}
        onAddProject={() => {}}
        configurationTarget={{ sessionId: sid }}
        configurationAvailable
        conversationRoot="/tmp"
        conversationRootId="root"
        draft={drafts[sid]}
        onDraftChange={(next) =>
          setDrafts((cur) => ({
            ...cur,
            [sid]: typeof next === "function" ? next(cur[sid]) : next,
          }))
        }
        attachments={[]}
        onAttachmentsChange={() => {}}
        onPrepareAttachmentSession={() => ({ cwd: "/tmp", sessionId: sid })}
      />
    );
  }
  await act(async () => {
    root.render(<Host />);
    await flushMicrotasks();
  });
  const drop = find(container, (p) => typeof p.onDrop === "function");
  await act(async () => {
    props(drop).onDrop({
      preventDefault() {},
      dataTransfer: {
        getData: (m) => (m === CODESHELL_PATH_DND_MIME ? "/tmp/only-for-A.txt" : ""),
        files: [],
      },
    });
    await flushMicrotasks();
  });
  await act(async () => {
    changeSession("B");
    await flushMicrotasks();
  });
  const chip = find(container, (p) => p["data-local-path-attachments"] === "true");
  const remove = nodes(chip).find((node) => node.tagName === "BUTTON");
  expect(remove).toBeDefined();
  await act(async () => { props(remove).onClick(); await flushMicrotasks(); });
  const textarea = find(container, (_p, n) => n.tagName === "TEXTAREA");
  await act(async () => {
    props(textarea).onKeyDown({
      key: "Enter",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
    await flushMicrotasks();
  });
  expect(submissions).toHaveLength(1);
  expect(submissions[0].opts.bucket).toBe("project::B");
  expect(submissions[0].text).toBe("查看 B 的任务");
  expect(submissions[0].opts.attachments ?? []).toEqual([]);
  const context = await buildInputAttachmentContext(submissions[0].opts.attachments, "/tmp", { expectedSessionId: "B" });
  expect(context.errors).toEqual([]);
  console.log("R05 remove-chip recovery: B prompt and metadata clean");
});
test("CONTROL same-session plugin expansion updates A and preserves B", async () => {
  ensureMiniDom();
  let resolveExpansion: any;
  const expansion = new Promise((resolve) => (resolveExpansion = resolve));
  const expandedTargets: any[] = [];
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    writable: true,
    value: {
      sttAvailable: async () => ({ available: false }),
      listPluginCommands: async () => [
        { name: "demo:review", pluginName: "demo", description: "Review code" },
      ],
      getProjectGitBranches: async () => ({ current: "main", branches: ["main"] }),
      onPluginCommandsChanged: () => () => {},
      log: () => {},
      expandPluginCommand: (target, ...args) => {
        expandedTargets.push({ target, args });
        return expansion;
      },
    },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  let changeSession: any;
  let snapshot: any;
  function Host() {
    const [sid, setSid] = React.useState("A");
    changeSession = setSid;
    const activeRef = React.useRef(sid);
    activeRef.current = sid;
    const [drafts, setDrafts] = React.useState<Record<string, string>>({
      A: "/demo:review src/A.ts",
      B: "B 已经写好的重要草稿",
    });
    snapshot = drafts;
    // This matches App.tsx 376-383: delayed updates always choose activeBucketRef.current.
    const updateDraft = (next) =>
      setDrafts((cur) => {
        const target = activeRef.current;
        return { ...cur, [target]: typeof next === "function" ? next(cur[target]) : next };
      });
    return (
      <ChatView
        messages={[]}
        sendBucket={`project::${sid}`}
        engineSessionId={sid}
        onSend={() => {}}
        onStop={() => {}}
        busy={false}
        activeProjectId="project"
        permissionMode="default"
        onPermissionChange={() => {}}
        goalEnabled={false}
        onGoalToggle={() => {}}
        modelOptions={[{ key: "test", label: "Test", provider: "test", supportsVision: true }]}
        activeModelKey="test"
        onModelChange={() => {}}
        contextTokens={0}
        projects={[]}
        onSelectProject={() => {}}
        onAddProject={() => {}}
        configurationTarget={{ sessionId: sid }}
        configurationAvailable
        conversationRoot="/tmp"
        conversationRootId="root"
        draft={drafts[sid]}
        onDraftChange={updateDraft}
        attachments={[]}
        onAttachmentsChange={() => {}}
      />
    );
  }
  await act(async () => {
    root.render(<Host />);
    await flushMicrotasks();
  });
  const textarea = find(container, (_p, n) => n.tagName === "TEXTAREA");
  await act(async () => {
    props(textarea).onKeyDown({
      key: "Enter",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
    await flushMicrotasks();
  });
  expect(expandedTargets).toHaveLength(1);
  expect(expandedTargets[0].target).toEqual({ sessionId: "A" });
  await act(async () => {
    // Keep the source session selected.
    await flushMicrotasks();
  });
  expect(snapshot.B).toBe("B 已经写好的重要草稿");
  await act(async () => {
    resolveExpansion({ prompt: "A 的 review 命令展开内容" });
    await flushMicrotasks();
  });
  expect(snapshot.B).toBe("B 已经写好的重要草稿");
  expect(snapshot.A).toBe("A 的 review 命令展开内容");
});
test("CONTROL React unmount rejects the late expansion write", async () => {
  ensureMiniDom();
  let resolveExpansion: any;
  const expansion = new Promise((resolve) => (resolveExpansion = resolve));
  const expandedTargets: any[] = [];
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    writable: true,
    value: {
      sttAvailable: async () => ({ available: false }),
      listPluginCommands: async () => [
        { name: "demo:review", pluginName: "demo", description: "Review code" },
      ],
      getProjectGitBranches: async () => ({ current: "main", branches: ["main"] }),
      onPluginCommandsChanged: () => () => {},
      log: () => {},
      expandPluginCommand: (target, ...args) => {
        expandedTargets.push({ target, args });
        return expansion;
      },
    },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  let changeSession: any;
  let snapshot: any;
  function Host() {
    const [sid, setSid] = React.useState("A");
    changeSession = setSid;
    const activeRef = React.useRef(sid);
    activeRef.current = sid;
    const [drafts, setDrafts] = React.useState<Record<string, string>>({
      A: "/demo:review src/A.ts",
      B: "B 已经写好的重要草稿",
    });
    snapshot = drafts;
    // This matches App.tsx 376-383: delayed updates always choose activeBucketRef.current.
    const updateDraft = (next) =>
      setDrafts((cur) => {
        const target = activeRef.current;
        return { ...cur, [target]: typeof next === "function" ? next(cur[target]) : next };
      });
    return (
      <ChatView
        messages={[]}
        sendBucket={`project::${sid}`}
        engineSessionId={sid}
        onSend={() => {}}
        onStop={() => {}}
        busy={false}
        activeProjectId="project"
        permissionMode="default"
        onPermissionChange={() => {}}
        goalEnabled={false}
        onGoalToggle={() => {}}
        modelOptions={[{ key: "test", label: "Test", provider: "test", supportsVision: true }]}
        activeModelKey="test"
        onModelChange={() => {}}
        contextTokens={0}
        projects={[]}
        onSelectProject={() => {}}
        onAddProject={() => {}}
        configurationTarget={{ sessionId: sid }}
        configurationAvailable
        conversationRoot="/tmp"
        conversationRootId="root"
        draft={drafts[sid]}
        onDraftChange={updateDraft}
        attachments={[]}
        onAttachmentsChange={() => {}}
      />
    );
  }
  await act(async () => {
    root.render(<Host />);
    await flushMicrotasks();
  });
  const textarea = find(container, (_p, n) => n.tagName === "TEXTAREA");
  await act(async () => {
    props(textarea).onKeyDown({
      key: "Enter",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
    await flushMicrotasks();
  });
  expect(expandedTargets).toHaveLength(1);
  expect(expandedTargets[0].target).toEqual({ sessionId: "A" });
  await act(async () => {
    changeSession("B");
    await flushMicrotasks();
  });
  expect(snapshot.B).toBe("B 已经写好的重要草稿");
  await act(async () => { root.unmount(); root = undefined; await flushMicrotasks(); });
  await act(async () => {
    resolveExpansion({ prompt: "A 的 review 命令展开内容" });
    await flushMicrotasks();
  });
  expect(snapshot.B).toBe("B 已经写好的重要草稿");
  expect(snapshot.A).toBe("/demo:review src/A.ts");
});
