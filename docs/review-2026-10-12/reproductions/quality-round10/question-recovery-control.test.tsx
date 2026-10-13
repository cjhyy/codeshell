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
function text(value: any): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  return value?.props ? text(value.props.children) : "";
}

test("CONTROL shorter sticky question needs an intervening no-question remount to recover", async () => {
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
  let select: any;
  let answered = 0;
  function Host() {
    const [sid, setSid] = React.useState("A");
    select = setSid;
    return (
      <ChatView
        messages={sid === "C" ? [] : [
          {
            kind: "ask_user",
            id: `ask-${sid}`,
            requestId: `ask-${sid}`,
            question: `问题 ${sid}`,
            multiSelect: true,
            options:
              sid === "A"
                ? [
                    { label: "A 一", description: "一" },
                    { label: "A 二", description: "二" },
                    { label: "A 三", description: "三" },
                  ]
                : [{ label: "B 唯一选项", description: "唯一" }],
          },
        ]}
        sendBucket={`project::${sid}`}
        engineSessionId={sid}
        onAskUserAnswer={() => { answered++; }}
        onSend={() => {}}
        onStop={() => {}}
        busy
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
        draft=""
        onDraftChange={() => {}}
        attachments={[]}
        onAttachmentsChange={() => {}}
      />
    );
  }
  await act(async () => {
    root.render(<Host />);
    await flushMicrotasks();
  });
  const third = nodes(container).find(
    (n) => n.tagName === "LI" && text(props(n).children).includes("A 三"),
  );
  expect(third).toBeDefined();
  await act(async () => {
    props(third).onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    select("B");
    await flushMicrotasks();
  });
  const submit = nodes(container).find(
    (n) => n.tagName === "BUTTON" && text(props(n).children) === "提交",
  );
  if (!submit)
    throw new Error(
      "submit missing; labels: " +
        nodes(container)
          .filter((n) => n.tagName === "BUTTON")
          .map((n) => text(props(n).children))
          .join("|"),
    );
  expect(props(submit).disabled).toBe(false);
  expect(() => props(submit).onClick()).toThrow();
  const optionB = () => nodes(container).find((n) => n.tagName === "LI" && text(props(n).children).includes("B 唯一选项"));
  await act(async () => { props(optionB()).onClick(); await flushMicrotasks(); });
  expect(() => props(submit).onClick()).toThrow();
  expect(answered).toBe(0);
  await act(async () => { select("C"); await flushMicrotasks(); });
  expect(nodes(container).some((n) => n.tagName === "BUTTON" && text(props(n).children) === "提交")).toBe(false);
  await act(async () => { select("B"); await flushMicrotasks(); });
  const recoveredSubmit = nodes(container).find((n) => n.tagName === "BUTTON" && text(props(n).children) === "提交");
  expect(props(recoveredSubmit).disabled).toBe(true);
  await act(async () => { props(optionB()).onClick(); await flushMicrotasks(); });
  expect(props(recoveredSubmit).disabled).toBe(false);
  await act(async () => { props(recoveredSubmit).onClick(); await flushMicrotasks(); });
  expect(answered).toBe(1);
  console.log("R13 invalid index survives visible option click; no-question remount recovers and submits once");
});
