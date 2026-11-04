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
import { featureSnapshot } from "./accountFeatureFixture";
import type { AccountFeatureSnapshot, AccountFeatureView } from "../../shared/account-features";
let network = 0;
const deny = () => {
  network++;
  throw new Error("Feature UI fixture denies network");
};
globalThis.fetch = deny as any;
http.request = http.get = https.request = https.get = deny as any;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = deny as any;
Bun.connect = Bun.udpSocket = deny as any;
syncBuiltinESMExports();
ensureMiniDom();
Object.assign(window, {
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  localStorage: { getItem: () => null, setItem() {} },
});
mock.module("../ui/ToastProvider", () => ({ useToast: () => () => {} }));
mock.module("../ui/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
mock.module("qrcode", () => ({
  default: { toDataURL: async () => "data:image/png;base64,fixture" },
}));
const presentation = ({ children }: any) => <div>{children}</div>;
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: presentation,
  DialogHeader: presentation,
  DialogTitle: presentation,
  DialogDescription: presentation,
  DialogFooter: presentation,
}));
const { I18nProvider } = await import("../i18n/I18nProvider");
const { AccountDeviceEntry } = await import("./AccountDeviceEntry");
const { DeviceRelaySettings } = await import("../settings/DeviceRelaySettings");
const { NewProjectDialog } = await import("../projects/NewProjectDialog");
const { CloudProjectManager } = await import("../projects/CloudProjectManager");
const { RemoteProviderSection } = await import("../credentials/RemoteLinkSection");
const [scenario, state = "ready"] = process.argv.slice(2);
const snapshot = featureSnapshot(state as AccountFeatureView["state"], {
  cloudOrigin: "https://cloud.example",
});
for (const view of Object.values(snapshot))
  if (view.state === "pending") view.reason = "relay_connecting";
// Directory preparation remains independently available while phone business access is pending.
snapshot["devices.directory"] = { id: "devices.directory", state: "ready" };
let resolve!: (snapshot: AccountFeatureSnapshot) => void;
let reject!: (error: Error) => void;
const late = new Promise<AccountFeatureSnapshot>((yes, no) => {
  resolve = yes;
  reject = no;
});
let subscribed: ((value: AccountFeatureSnapshot) => void) | undefined;
let unsubscribed = 0,
  opened = 0,
  signIns = 0,
  closed = 0,
  refreshed = 0,
  enrolled = 0;
const cloudActions: string[] = [];
const listeners = new Set<(value: AccountFeatureSnapshot) => void>();
const api = {
  snapshot: () =>
    scenario.startsWith("late-") || scenario === "unmount" ? late : Promise.resolve(snapshot),
  refresh: async () => {
    refreshed++;
    return snapshot;
  },
  onChanged: (listener: (value: AccountFeatureSnapshot) => void) => {
    subscribed = listener;
    listeners.add(listener);
    return () => {
      unsubscribed++;
      listeners.delete(listener);
    };
  },
};
window.addEventListener("codeshell:open-account-settings", () => signIns++);
window.codeshell = {
  accountFeatures: api,
  cloudAccount: {
    status: async () => ({
      state: "signed-in",
      origin: "https://account.example",
      account: { id: "account", username: "member" },
    }),
    onStatus: () => () => {},
  },
  mobileRemote: {
    relay: {
      enroll: async () => {
        enrolled++;
      },
      forget: async () => {},
    },
  },
  links: {},
  onMenuEvent: () => () => {},
  openCloudWorkbench: async (request: { action: string }) => {
    opened++;
    cloudActions.push(request.action);
    return { action: request.action, available: true, projects: [] };
  },
} as any;
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const nodes = (node: any): any[] => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const props = (node: any): any =>
  node?.[Object.keys(node ?? {}).find((key) => key.startsWith("__reactProps$")) ?? ""] ?? {};
const text = (node: any): string =>
  node?.nodeType === 3
    ? (node.data ?? node.textContent ?? "")
    : node?.childNodes?.length
      ? node.childNodes.map(text).join("")
      : (node?.textContent ?? "");
const button = (label: string) =>
  nodes(container).find(
    (n) => n.tagName === "BUTTON" && (text(n) === label || props(n)["aria-label"] === label),
  );
const update = async (run: () => unknown) => {
  await act(async () => {
    run();
    await flushMicrotasks();
    await flushMicrotasks();
  });
};
const render = async () =>
  update(() =>
    root.render(
      <I18nProvider>
        {scenario === "phone" ? (
          <DeviceRelaySettings
            status={{
              state: "ready",
              registered: true,
              accountId: "account",
              relayOrigin: "https://account.example",
              name: "Laptop",
            }}
            busy={false}
            refresh={async () => {
              refreshed++;
            }}
          />
        ) : scenario === "cloud" || scenario === "cloud-sign-in-transition" ? (
          <NewProjectDialog
            open
            onOpenChange={(open) => {
              if (!open) closed++;
            }}
            onCreateLocal={async () => {
              opened++;
            }}
          />
        ) : scenario.startsWith("cloud-") ? (
          <CloudProjectManager
            initialAddress="https://old.example"
            onBack={() => {}}
            onOpened={() => {}}
            onBusyChange={() => {}}
          />
        ) : scenario === "remote" ? (
          <RemoteProviderSection
            cwd="/fixture"
            providerId="github"
            snapshot={
              { providers: [], connections: [], revision: "fixture", capabilities: {} } as any
            }
            provider={
              {
                id: "github",
                displayName: "GitHub",
                description: { zh: "fixture", en: "fixture" },
                connectionMethods: [],
                authModes: [{ id: "remote-link", methodId: "remote-link", available: true }],
              } as any
            }
            loadError=""
            reload={async () => {}}
            onChanged={() => {}}
          />
        ) : (
          <AccountDeviceEntry onOpen={() => opened++} onSignIn={() => signIns++} />
        )}
      </I18nProvider>,
    ),
  );
try {
  await render();
  if (scenario.startsWith("late-")) {
    assert.equal(button("执行电脑 / 设备"), undefined);
    await update(() => subscribed!(featureSnapshot("sign-in")));
    if (scenario === "late-failure") await update(() => reject(new Error("old response")));
    else await update(() => resolve(featureSnapshot("hidden")));
    assert.ok(button("执行电脑 / 设备"));
    await update(() => props(button("执行电脑 / 设备")).onClick());
    assert.equal(signIns, 1);
  } else if (scenario === "unmount") {
    await update(() => root.unmount());
    assert.equal(unsubscribed, 1);
    await update(() => {
      resolve(featureSnapshot("ready"));
      subscribed!(featureSnapshot("ready"));
    });
    assert.equal(container.childNodes.length, 0);
  } else if (scenario === "cloud-sign-in-transition") {
    await update(() => props(button("云端")).onClick());
    await update(() => {
      for (const listener of listeners) listener(featureSnapshot("sign-in"));
    });
    await update(() => props(button("云端")).onClick());
    assert.equal(signIns, 1);
    assert.equal(closed, 1, "The chooser closes before navigating to Account settings");
  } else if (scenario === "cloud-revoke-cleanup") {
    const form = nodes(container).find((node) => node.tagName === "FORM");
    await update(() => props(form).onSubmit({ preventDefault() {} }));
    assert.deepEqual(cloudActions, ["list"]);
    await update(() => {
      for (const listener of listeners) listener(featureSnapshot("hidden"));
    });
    assert.equal(button("连接并加载项目"), undefined);
    await update(() => props(button("退出此云端")).onClick());
    await update(() => props(button("确认退出此云端")).onClick());
    assert.deepEqual(cloudActions, ["list", "logout"]);
  } else if (scenario === "cloud-default") {
    const input = nodes(container).find(
      (n) => n.tagName === "INPUT" && props(n).inputMode === "url",
    );
    assert.equal(props(input).value, "https://cloud.example");
    assert.ok(text(container).includes("高级：手动填写云端地址"));
  } else {
    const label =
      scenario === "devices"
        ? "执行电脑 / 设备"
        : scenario === "cloud"
          ? "云端"
          : scenario === "remote"
            ? "远程连接"
            : "手机访问入口";
    const gated = nodes(container).find((n) => props(n)["data-account-feature"]);
    if (state === "hidden") {
      assert.equal(gated, undefined);
      if (scenario === "devices") assert.equal(button(label), undefined);
      if (scenario === "cloud") assert.equal(button(label), undefined);
      if (scenario === "remote")
        assert.equal(
          nodes(container).some((n) => props(n)["data-link-runtime"] === "server"),
          false,
        );
      if (scenario === "phone")
        assert.equal(
          nodes(container).some((n) => n.tagName === "IMG"),
          false,
        );
    } else if (state === "sign-in") {
      assert.equal(props(gated).disabled, false);
      await update(() => props(gated).onClick());
      assert.equal(signIns, 1);
    } else if (state === "pending") {
      assert.equal(props(gated).disabled, true);
      assert.ok(text(gated).includes("中继连接中"));
      if (scenario === "phone") {
        assert.equal(props(button("重试")).disabled, false);
        const nameInput = nodes(container).find(
          (node) => node.tagName === "INPUT" && props(node).maxLength === 100,
        );
        await update(() => props(nameInput).onChange({ target: { value: "Laptop" } }));
        assert.equal(props(button("通过当前账号登记电脑")).disabled, false);
        await update(() => props(button("通过当前账号登记电脑")).onClick());
        assert.equal(enrolled, 1);
        await update(() => props(button("重试")).onClick());
        assert.ok(refreshed >= 2);
      }
    } else if (scenario === "devices") {
      await update(() => props(button(label)).onClick());
      assert.equal(opened, 1);
    } else if (scenario === "remote")
      assert.ok(nodes(container).some((n) => props(n)["data-link-runtime"] === "server"));
    else if (scenario === "phone") assert.ok(nodes(container).some((n) => n.tagName === "IMG"));
    else {
      assert.ok(button(label));
      assert.equal(props(button(label)).disabled, false);
    }
    if (scenario === "cloud")
      assert.ok(button("此计算机"), "Local project remains available in every policy state");
  }
  assert.equal(network, 0);
} finally {
  if (scenario !== "unmount") await update(() => root.unmount());
  document.body.removeChild(container);
}
