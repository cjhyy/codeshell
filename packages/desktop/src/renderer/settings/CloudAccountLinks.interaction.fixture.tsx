import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { CloudAccountLinksRequest, CloudAccountStatus } from "../../shared/cloud-account";

let unexpectedRequests = 0;
const deny = () => {
  unexpectedRequests++;
  throw new Error("account UI fixture denies network");
};
globalThis.fetch = deny as any;
http.request = http.get = https.request = https.get = deny as any;
net.connect = net.createConnection = tls.connect = deny as any;
syncBuiltinESMExports();
for (const probe of [
  () => fetch("https://fixture.invalid"),
  () => https.request("https://fixture.invalid"),
  () => net.connect(9, "127.0.0.1"),
])
  assert.throws(probe);
assert.equal(unexpectedRequests, 3);
unexpectedRequests = 0;
assert.equal(process.env.NODE_ENV, "test");
assert.ok(process.env.CODE_SHELL_TEST_HOME?.startsWith(`${process.env.HOME}/`));
ensureMiniDom();
const { translate } = await import("../i18n/translate");
mock.module("../i18n/I18nProvider", () => ({
  useT: () => ({ t: (key: any) => translate("zh", key) }),
}));
mock.module("../ui/ToastProvider", () => ({ useToast: () => () => {} }));
const { CloudAccountSettings } = await import("./CloudAccountSettings");
const scenario = process.argv[2];
const connectionId = "10000000-0000-0000-0000-000000000001";
const firstGrant = "10000000-0000-0000-0000-000000000002";
const secondGrant = "10000000-0000-0000-0000-000000000003";
const alice: CloudAccountStatus = {
  state: "signed-in",
  origin: "https://account.example",
  account: { id: "10000000-0000-0000-0000-000000000004", username: "alice" },
};
let currentStatus = alice;
let data = {
  linkOrigin: "https://link.example",
  connections: [
    {
      id: connectionId,
      provider: "github",
      account: { id: "42", login: "linked-alice" },
      revoked: false,
    },
  ],
  grants: [firstGrant, secondGrant].map((id, index) => ({
    id,
    connectionId,
    client: { id, name: `Client ${index + 1}` },
    scopes: ["github.get_repository"],
    resources: [`owner/repo${index + 1}`],
    revoked: false,
  })),
};
const calls: CloudAccountLinksRequest[] = [];
let failList = scenario === "load-failure";
let late: ((value: any) => void) | undefined;
let onStatus!: (status: CloudAccountStatus) => void;
const lateList = scenario === "stale-account" || scenario === "same-account-relogin";
const inflightRefresh = scenario === "connection-refresh-inflight";
const emit = (status: CloudAccountStatus) => {
  currentStatus = status;
  onStatus(status);
};
(globalThis as any).window.codeshell = {
  credentials: {
    list: async (cwd: string) => {
      assert.equal(cwd, "");
      return [];
    },
  },
  cloudAccount: {
    status: async () => currentStatus,
    onStatus: (callback: typeof onStatus) => {
      onStatus = callback;
      return () => {};
    },
    capabilities: async () => ({
      registrationAllowed: true,
      githubEnabled: true,
      githubLinkEnabled: true,
      linkManagementEnabled: true,
    }),
    manageLinks: async (request: CloudAccountLinksRequest) => {
      assert.equal(request.origin, currentStatus.origin);
      assert.equal(request.accountId, currentStatus.account?.id);
      calls.push(request);
      if (request.action === "list") {
        if (failList) throw new Error("fixture offline");
        if ((lateList || inflightRefresh) && calls.length === 1)
          return new Promise((resolve) => {
            late = resolve;
          });
        return { action: "list", view: structuredClone(data) };
      }
      data = {
        ...data,
        connections: data.connections.map((item) =>
          request.kind === "connections" && item.id === request.id
            ? { ...item, revoked: true }
            : item,
        ),
        grants: data.grants.map((item) =>
          (
            request.kind === "connections"
              ? item.connectionId === request.id
              : item.id === request.id
          )
            ? { ...item, revoked: true }
            : item,
        ),
      };
      if (scenario === "unconfirmed-revoke") throw new Error("fixture ack lost");
      if (scenario === "confirmed-refresh-failure") failList = true;
      return { action: "revoke", revoked: true, kind: request.kind, id: request.id };
    },
  },
};
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const text = (node: any): string =>
  node?.nodeType === 3
    ? (node.nodeValue ?? node.data ?? node.textContent ?? "")
    : node?.childNodes?.length
      ? node.childNodes.map(text).join("")
      : (node?.textContent ?? "");
const descendants = (node: Element): Element[] => [
  node,
  ...Array.from(node.children).flatMap(descendants),
];
const props = (node: Element): Record<string, any> => {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as any)[key] : {};
};
const button = (label: string, index = 0) =>
  descendants(container).filter((node) => node.tagName === "BUTTON" && node.textContent === label)[
    index
  ];
async function click(label: string, index = 0) {
  const node = button(label, index);
  assert.ok(node, `Missing button: ${label}`);
  assert.ok(!props(node).disabled, `Button disabled: ${label}`);
  await act(async () => {
    props(node).onClick();
    await flushMicrotasks();
  });
}
const contents = () => text(container);
try {
  await act(async () => {
    root.render(<CloudAccountSettings embedded />);
    await flushMicrotasks();
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 300));
    await flushMicrotasks();
  });
  if (lateList) {
    const previousData = structuredClone(data);
    await act(async () => {
      data = { ...data, connections: [], grants: [] };
      if (scenario === "same-account-relogin") {
        emit({ state: "signed-out" });
        emit({ ...alice });
      } else
        emit({
          ...alice,
          account: { id: "20000000-0000-0000-0000-000000000004", username: "bob" },
        });
      await flushMicrotasks();
    });
    await act(async () => {
      late!({ action: "list", view: previousData });
      await flushMicrotasks();
    });
    assert.ok(!contents().includes("linked-alice"));
    assert.ok(contents().includes("当前账号没有数据连接"));
    assert.equal(calls.length, 2, "A new account incarnation loads its own connection list");
    assert.equal(calls[1].accountId, currentStatus.account?.id);
  } else if (scenario === "connection-refresh" || inflightRefresh) {
    assert.equal(calls.length, 1, "Opening account management automatically loads connections");
    const previousData = structuredClone(data);
    await act(async () => {
      emit({ ...alice, githubConnection: { state: "pending" } });
      await flushMicrotasks();
    });
    assert.equal(calls.length, 1, "Pending consent must not issue another list request");
    data = {
      ...data,
      connections: data.connections.map((item) => ({
        ...item,
        account: { ...item.account, login: "linked-after-consent" },
      })),
    };
    await act(async () => {
      emit({ ...alice, githubConnection: { state: "connected" } });
      await flushMicrotasks();
    });
    if (inflightRefresh)
      await act(async () => {
        late!({ action: "list", view: previousData });
        await flushMicrotasks();
      });
    await act(async () => {
      await flushMicrotasks();
    });
    assert.equal(calls.length, 2, "Completed consent refreshes connections even after a busy list");
    assert.ok(contents().includes("linked-after-consent"), contents());
    assert.ok(!contents().includes("linked-alice"));
    await act(async () => {
      emit({ ...alice, githubConnection: { state: "connected" } });
      await flushMicrotasks();
    });
    assert.equal(calls.length, 2, "An unchanged completed status does not repeatedly reload");
  } else if (scenario === "load-failure") {
    assert.ok(contents().includes("fixture offline"));
    assert.ok(!contents().includes("当前账号没有数据连接"));
    failList = false;
    await click("加载／刷新连接");
    assert.ok(contents().includes("linked-alice"));
    failList = true;
    await click("加载／刷新连接");
    assert.ok(contents().includes("linked-alice"));
    assert.ok(props(button("审阅并断开连接")).disabled);
  } else if (scenario === "refresh-keeps-view") {
    await act(async () => {
      emit({ ...alice });
      await flushMicrotasks();
    });
    assert.ok(contents().includes("linked-alice"));
    assert.equal(calls.length, 1);
  } else {
    assert.ok(contents().includes("owner/repo1"));
    await click(scenario === "connection-cascade" ? "审阅并断开连接" : "审阅并撤销授权");
    assert.equal(calls.length, 1, "Review must not revoke");
    if (scenario === "review-cancel-revoke") {
      await click("取消");
      assert.equal(calls.length, 1);
      await click("审阅并撤销授权");
    }
    await click("确认撤销");
    assert.equal(calls[1].action, "revoke");
    if (scenario === "unconfirmed-revoke") {
      assert.ok(contents().includes("尚未确认撤销结果"));
      assert.ok(props(button("审阅并撤销授权")).disabled);
      await click("加载／刷新连接");
      assert.ok(contents().includes("已撤销或失效"));
    } else if (scenario === "confirmed-refresh-failure") {
      assert.ok(contents().includes("撤销已确认，但无法刷新列表"));
      assert.ok(contents().includes("已撤销或失效"));
      assert.ok(contents().includes("Client 2"));
    } else {
      assert.equal(calls[2].action, "list", "Confirmed revocation must reload");
      assert.ok(contents().includes("已撤销或失效"));
      if (scenario === "connection-cascade") assert.equal(button("审阅并撤销授权"), undefined);
      else
        assert.equal(
          descendants(container).filter(
            (node) => node.tagName === "BUTTON" && node.textContent === "审阅并撤销授权",
          ).length,
          1,
        );
    }
  }
} finally {
  await act(async () => {
    root.unmount();
    await flushMicrotasks();
  });
  document.body.removeChild(container);
}
assert.equal(unexpectedRequests, 0);
console.log(JSON.stringify({ scenario, passed: true, unexpectedRequests }));
