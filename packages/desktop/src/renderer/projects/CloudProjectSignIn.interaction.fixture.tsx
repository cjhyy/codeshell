import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { CloudEnvironmentDiscovery } from "../../shared/cloud-environment";
import type { CloudProjectBinding } from "../../shared/project-runtime";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

let unexpectedRequests = 0;
const deny = () => {
  unexpectedRequests++;
  throw new Error("Cloud sign-in UI fixture denies network");
};
globalThis.fetch = deny as any;
http.request = http.get = https.request = https.get = deny as any;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = deny as any;
globalThis.WebSocket = class {
  constructor() {
    deny();
  }
} as any;
Bun.connect = Bun.udpSocket = deny as any;
syncBuiltinESMExports();
for (const probe of [
  () => fetch("https://fixture.invalid"),
  () => https.request("https://fixture.invalid"),
  () => net.connect(9, "127.0.0.1"),
  () => new WebSocket("wss://fixture.invalid"),
  () => Bun.connect({ hostname: "127.0.0.1", port: 9, socket: {} }),
])
  assert.throws(probe, /denies network/);
assert.equal(unexpectedRequests, 5);
unexpectedRequests = 0;
assert.equal(process.env.NODE_ENV, "test");
assert.ok(process.env.HOME && process.env.CODE_SHELL_TEST_HOME?.startsWith(`${process.env.HOME}/`));
ensureMiniDom();
mock.module("../i18n", () => ({ useT: () => ({ lang: "zh" }) }));
const presentation = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
let closeDialog: (open: boolean) => void = () => assert.fail("No active dialog");
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, onOpenChange, children }: any) => {
    closeDialog = onOpenChange;
    return open ? <div role="dialog">{children}</div> : null;
  },
  DialogContent: presentation,
  DialogHeader: presentation,
  DialogFooter: presentation,
  DialogTitle: presentation,
  DialogDescription: presentation,
}));
const { CloudProjectSignIn } = await import("./CloudProjectSignIn");
const scenario = process.argv[2];
const binding: CloudProjectBinding = {
  id: "binding-a",
  localProjectId: "local-a",
  origin: "https://cloud-a.example",
  environmentId: "environment-a",
  environmentName: "Cloud A",
  remoteProjectId: "remote-a",
  remoteProjectName: "Project A",
  createdAt: 1,
  updatedAt: 1,
};
const other = {
  ...binding,
  id: "binding-b",
  localProjectId: "local-b",
  origin: "https://cloud-b.example",
  environmentId: "environment-b",
  remoteProjectId: "remote-b",
};
const discovery = (target = binding): CloudEnvironmentDiscovery => ({
  origin: target.origin,
  initialized: true,
  authenticated: true,
  environment: {
    version: 1,
    id: target.environmentId,
    name: target.environmentName,
    kind: "project-host",
    entryPath: "/",
  },
  projects: [
    {
      id: target.remoteProjectId,
      name: target.remoteProjectName,
      status: "running",
      generation: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
});
function deferred() {
  let resolve!: (value: CloudEnvironmentDiscovery) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CloudEnvironmentDiscovery>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const calls: Array<{
  input: { origin: string; username: string; password: string };
  pending: ReturnType<typeof deferred>;
}> = [];
const reconnected: string[] = [];
window.codeshell = {
  cloudEnvironment: {
    login: (input) => {
      const pending = deferred();
      calls.push({ input, pending });
      return pending.promise;
    },
  },
} as any;
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
let mounted = true;
const descendants = (node: any): any[] => [node, ...Array.from(node.children).flatMap(descendants)];
const props = (node: any) =>
  node?.[Object.keys(node ?? {}).find((key) => key.startsWith("__reactProps$")) ?? ""] ?? {};
const text = (node: any): string =>
  node?.nodeType === 3
    ? (node.data ?? node.textContent ?? "")
    : node?.childNodes?.length
      ? node.childNodes.map(text).join("")
      : (node?.textContent ?? "");
const elements = (tag: string) => descendants(container).filter((node) => node.tagName === tag);
const button = (label: string) => elements("BUTTON").find((node) => text(node) === label);
const input = (suffix: string) =>
  elements("INPUT").find((node) => props(node).id.endsWith(`-${suffix}`));
const dialogOpen = () => descendants(container).some((node) => props(node).role === "dialog");
async function update(work: () => void | Promise<void>) {
  await act(async () => {
    await work();
    await flushMicrotasks();
  });
}
const render = (target: CloudProjectBinding) =>
  update(() =>
    root.render(
      <CloudProjectSignIn
        binding={target}
        required
        reconnect={async () => {
          reconnected.push(target.id);
        }}
      />,
    ),
  );
const click = async (label: string) => {
  const node = button(label);
  assert.ok(node, `Missing button: ${label}`);
  assert.ok(!props(node).disabled, `Disabled button: ${label}`);
  await update(() => props(node).onClick());
};
const change = (suffix: string, value: string) =>
  update(() => props(input(suffix)).onChange({ target: { value } }));
const submit = () => update(() => props(elements("FORM")[0]).onSubmit({ preventDefault() {} }));
async function fill() {
  await change("username", " owner ");
  await change("password", "fixture-password");
}

try {
  await render(binding);
  await click("重新登录");
  assert.equal(props(input("origin")).value, binding.origin);
  assert.equal(props(input("origin")).readOnly, true);
  await fill();
  if (scenario === "close-clears") {
    await click("取消");
    assert.equal(dialogOpen(), false);
    await click("重新登录");
    assert.equal(props(input("password")).value, "");
    await fill();
  }
  await submit();
  await submit();
  assert.equal(calls.length, 1, "Repeated submit cannot duplicate login");
  assert.deepEqual(calls[0].input, {
    origin: binding.origin,
    username: "owner",
    password: "fixture-password",
  });
  assert.equal(props(input("password")).value, "");
  await update(() => closeDialog(false));
  assert.ok(dialogOpen(), "Pending authentication retains its dialog");
  if (scenario === "retry") {
    await update(() => calls[0].pending.reject(new Error("Invalid login")));
    assert.ok(text(container).includes("Invalid login"));
    assert.equal(props(input("password")).value, "");
    await fill();
    await submit();
    await update(() => calls[1].pending.resolve(discovery()));
    assert.deepEqual(reconnected, [binding.id]);
    assert.equal(dialogOpen(), false);
  } else if (scenario === "binding-switch") {
    await render(other);
    assert.equal(dialogOpen(), false);
    await click("重新登录");
    await fill();
    await update(() => calls[0].pending.resolve(discovery()));
    assert.deepEqual(reconnected, []);
    assert.ok(dialogOpen());
    assert.equal(props(input("password")).value, "fixture-password");
    await submit();
    assert.equal(calls[1].input.origin, other.origin);
    await update(() => calls[1].pending.resolve(discovery(other)));
    assert.deepEqual(reconnected, [other.id]);
  } else if (scenario === "unmount") {
    await update(() => root.unmount());
    mounted = false;
    await update(() => calls[0].pending.resolve(discovery()));
    assert.deepEqual(reconnected, []);
  } else if (scenario === "identity-mismatch") {
    await update(() =>
      calls[0].pending.resolve({ ...discovery(), environment: discovery(other).environment }),
    );
    assert.deepEqual(reconnected, []);
    assert.ok(dialogOpen());
    assert.ok(text(container).includes("无法验证当前云端项目"));
    assert.equal(props(input("password")).value, "");
  } else if (scenario === "close-clears") {
    await update(() => calls[0].pending.resolve(discovery()));
    assert.deepEqual(reconnected, [binding.id]);
    assert.equal(dialogOpen(), false);
    await click("重新登录");
    assert.equal(props(input("password")).value, "");
  } else assert.fail(`Unknown scenario: ${scenario}`);
  assert.equal(unexpectedRequests, 0);
  console.log(JSON.stringify({ scenario, passed: true, unexpectedRequests }));
} finally {
  if (mounted) await update(() => root.unmount());
  document.body.removeChild(container);
}
