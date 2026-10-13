// Child-process React interactions exercise the actual manager and chooser.
// The dialog presentation primitive uses mini-DOM; these are not browser/native tests.
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
import type { CloudAccountStatus } from "../../shared/cloud-account";
import type {
  CloudManagementRequest,
  CloudManagementResult,
  CloudProject,
} from "../../shared/cloud-management";

let unexpectedRequests = 0;
const deny = () => {
  unexpectedRequests++;
  throw new Error("Cloud project UI fixture denies network");
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
const storage = new Map<string, string>();
Object.assign(window, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
});
// Real translations bind a stable t() through the actual provider, so its consumer
// effects are not restarted by a freshly allocated mock translator every render.
const { I18nProvider } = await import("../i18n/I18nProvider");
const { translate } = await import("../i18n/translate");
const t = (key: any) => translate("zh", key);
mock.module("../ui/ToastProvider", () => ({ useToast: () => () => {} }));
const presentation = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
let closeDialog: (open: boolean) => void = () => assert.fail("No active dialog");
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, onOpenChange, children }: any) => {
    closeDialog = onOpenChange;
    return open ? <div role="dialog">{children}</div> : null;
  },
  DialogContent: presentation,
  DialogHeader: presentation,
  DialogTitle: presentation,
  DialogDescription: presentation,
}));
const { CloudProjectManager } = await import("./CloudProjectManager");
const { useNewProjectDialog } = await import("./NewProjectDialog");
const scenario = process.argv[2];
const origin = "https://cloud.example";
const alice: CloudAccountStatus = {
  state: "signed-in",
  origin: "https://account.example",
  account: { id: "10000000-0000-0000-0000-000000000001", username: "alice" },
};
const project: CloudProject = {
  id: "20000000-0000-0000-0000-000000000001",
  name: "Existing project",
  status: scenario === "same-account-late-open" ? "running" : "stopped",
  generation: 1,
  createdAt: 1,
  updatedAt: 1,
};
const linkedProject = {
  id: "legacy-binding",
  localProjectId: "local-project",
  origin,
  environmentId: "legacy-environment",
  environmentName: "Existing cloud",
  remoteProjectId: project.id,
  remoteProjectName: "Existing remote project",
  createdAt: 1,
  updatedAt: 1,
};
let linkedOpens = 0;
let projects = [project];
const list = (): CloudManagementResult => ({
  action: "list",
  available: true,
  projects: structuredClone(projects),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const lateStatus = deferred<CloudAccountStatus>();
const lateLinkedOpen = deferred<void>();
const lateManagement = deferred<CloudManagementResult>();
const listeners = new Set<(status: CloudAccountStatus) => void>();
let snapshot: CloudAccountStatus =
  scenario === "anonymous-chooser" ? { state: "signed-out" } : alice;
let nativeMenu: (event: string) => void = () => assert.fail("No native menu listener");
let menuDetached = 0;
let localCreates = 0;
let accountLogouts = 0;
let backCalls = 0;
let fail: CloudManagementRequest["action"] | undefined;
const calls: CloudManagementRequest[] = [];
const opened: string[] = [];
const busy: boolean[] = [];
const onBusyChange = (next: boolean) => busy.push(next);
const onOpened = (address: string) => opened.push(address);
const onBack = () => backCalls++;
window.codeshell = {
  onMenuEvent: (callback: typeof nativeMenu) => {
    nativeMenu = callback;
    return () => menuDetached++;
  },
  cloudAccount: {
    status: async () =>
      ["late-status-after-event", "linked-cloud-pending"].includes(scenario)
        ? lateStatus.promise
        : snapshot,
    onStatus: (callback: (status: CloudAccountStatus) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    capabilities: async () => ({
      registrationAllowed: false,
      githubEnabled: false,
      githubLinkEnabled: false,
      linkManagementEnabled: false,
    }),
    logout: async () => {
      accountLogouts++;
    },
  },
  openCloudWorkbench: async (request: CloudManagementRequest) => {
    assert.equal(typeof request, "object", "Managed UI must use the typed object IPC branch");
    assert.equal(request.accountOrigin, alice.origin);
    assert.equal(request.accountId, alice.account?.id);
    assert.equal(request.cloudOrigin, origin);
    calls.push(structuredClone(request));
    if (scenario === "dialog-busy-before-effect") closeDialog(false);
    if (fail === request.action) throw new Error(`fixture ${request.action} ACK unknown`);
    if (
      (scenario === "same-account-late-list" && calls.length === 1) ||
      (scenario === "same-account-late-open" && request.action === "open")
    )
      return lateManagement.promise;
    if (request.action === "list") return list();
    if (request.action === "logout") return { action: "logout", revoked: true };
    if (request.action === "create") {
      const created = {
        ...project,
        id: "20000000-0000-0000-0000-000000000002",
        name: request.name,
        status: "stopped" as const,
      };
      projects.push(created);
      return { action: "create", project: structuredClone(created) };
    }
    assert.ok("projectId" in request, "Project actions must carry their exact UUID");
    const selected = projects.find((item) => item.id === request.projectId)!;
    assert.ok(selected, "Mutation must target an actual returned project UUID");
    if (request.action !== "open") {
      selected.status = request.action === "start" ? "running" : "stopped";
      selected.generation++;
    }
    return {
      action: request.action,
      project: structuredClone(selected),
      ...(request.action === "open" ? { address: `${origin}/?project=${selected.id}` } : {}),
    };
  },
} as any;
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const props = (node: Element): Record<string, any> => {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as any)[key] : {};
};
const descendants = (node: Element): Element[] => [
  node,
  ...Array.from(node.children).flatMap(descendants),
];
const text = (node: any): string =>
  node?.nodeType === 3
    ? (node.data ?? node.textContent ?? "")
    : node?.childNodes?.length
      ? node.childNodes.map(text).join("")
      : (node?.textContent ?? "");
const contents = () => text(container);
const elements = (tag: string) => descendants(container).filter((node) => node.tagName === tag);
const button = (label: string, index = 0) =>
  elements("BUTTON").filter((node) => text(node) === label || props(node)["aria-label"] === label)[
    index
  ];
async function update(work: () => void | Promise<void>) {
  await act(async () => {
    await work();
    await flushMicrotasks();
  });
}
async function click(label: string, index = 0) {
  const node = button(label, index);
  assert.ok(node, `Missing button: ${label}`);
  assert.ok(!props(node).disabled, `Disabled button: ${label}`);
  await update(() => props(node).onClick());
}
async function change(node: Element, value: string) {
  assert.ok(node, "Missing input");
  await update(() => props(node).onChange({ target: { value } }));
}
async function submit(index: number) {
  const form = elements("FORM")[index];
  assert.ok(form, `Missing form: ${index}`);
  const submitter = descendants(form).find(
    (node) => node.tagName === "BUTTON" && props(node).type === "submit",
  );
  assert.ok(submitter && !props(submitter).disabled, "Disabled form submitter");
  let prevented = false;
  await update(() =>
    props(form).onSubmit({
      preventDefault: () => {
        prevented = true;
      },
    }),
  );
  assert.ok(prevented, "Forms must prevent browser navigation");
}
async function emit(status: CloudAccountStatus) {
  await update(() => {
    snapshot = status;
    for (const listener of [...listeners]) listener(status);
  });
}
const chooser = [
  "anonymous-chooser",
  "explicit-workflow",
  "local-chooser",
  "dialog-busy-before-effect",
  "linked-cloud-entry",
  "linked-cloud-retry",
  "linked-cloud-pending",
].includes(scenario);
function Chooser() {
  const [open, dialog] = useNewProjectDialog(
    async () => {
      localCreates++;
    },
    {
      cloudBindings: scenario.startsWith("linked-cloud") ? [linkedProject] : [],
      onOpenCloudProject: async (binding) => {
        assert.deepEqual(binding, linkedProject);
        linkedOpens++;
        if (scenario === "linked-cloud-pending") await lateLinkedOpen.promise;
        if (scenario === "linked-cloud-retry" && linkedOpens === 1)
          throw new Error("Existing cloud could not be opened");
      },
    },
  );
  return (
    <>
      <button onClick={open}>fixture chooser opener</button>
      {dialog}
    </>
  );
}
try {
  await update(() => {
    root.render(
      <I18nProvider>
        {chooser ? (
          <Chooser />
        ) : (
          <CloudProjectManager
            initialAddress={origin}
            onBusyChange={onBusyChange}
            onOpened={onOpened}
            onBack={onBack}
          />
        )}
      </I18nProvider>,
    );
  });
  assert.equal(calls.length, 0, "Mount/status reads must not connect to Cloud management");
  if (chooser) {
    if (scenario === "explicit-workflow") await update(() => nativeMenu("add-project"));
    else await click("fixture chooser opener");
    assert.equal(calls.length, 0, "Opening the chooser must not connect");
    if (scenario === "local-chooser") {
      await click(t("sidebar.thisComputer"));
      assert.equal(localCreates, 1);
      assert.equal(button(t("sidebar.cloud")), undefined);
    } else {
      await click(t("sidebar.cloud"));
      await update(() => new Promise<void>((done) => setTimeout(done, 300)));
      assert.equal(calls.length, 0, "Selecting Cloud must not exchange credentials");
      if (scenario.startsWith("linked-cloud")) {
        const label = "打开云端项目：Existing remote project";
        assert.ok(contents().includes(t("sidebar.linkedCloudProjects")));
        assert.ok(contents().includes(linkedProject.origin));
        await click(label);
        if (scenario === "linked-cloud-pending") {
          await update(() => lateStatus.resolve(alice));
          assert.ok(
            props(button(label)).disabled,
            "Late Account status must not release a pending project open",
          );
          await update(() => closeDialog(false));
          assert.ok(button(label), "Pending project selection keeps the chooser open");
          await update(() => props(button(label)).onClick());
          assert.equal(linkedOpens, 1, "A late status update must not permit a second open");
          await update(() => lateLinkedOpen.resolve());
        }
        if (scenario === "linked-cloud-retry") {
          assert.ok(contents().includes("Existing cloud could not be opened"));
          assert.ok(button(label), "Failed open keeps its exact binding available for retry");
          await click(label);
        }
        assert.equal(linkedOpens, scenario === "linked-cloud-retry" ? 2 : 1);
        assert.equal(localCreates, 0);
        assert.equal(
          calls.length,
          0,
          "Opening an existing binding does not exchange a managed grant",
        );
        assert.equal(button(label), undefined, "Opened legacy project closes its chooser");
      } else if (scenario === "anonymous-chooser") {
        assert.ok(contents().includes(t("cloudManager.signIn")));
        assert.equal(button(t("cloudManager.connect")), undefined);
        assert.equal(localCreates, 0);
      } else {
        await change(elements("INPUT")[0], origin);
        await submit(0);
        if (scenario === "dialog-busy-before-effect") {
          assert.ok(
            button(t("cloudManager.reload")),
            "Request must fence dialog close synchronously",
          );
          assert.ok(contents().includes(project.name));
          await update(() => closeDialog(false));
          assert.equal(
            button(t("cloudManager.reload")),
            undefined,
            "Settled request releases close",
          );
        } else {
          await change(elements("INPUT")[1], "Created from chooser");
          await submit(1);
          await click(t("cloudManager.start"), 1);
          await click(t("cloudManager.stop"), 1);
          await click(t("cloudManager.start"), 1);
          await click(t("sidebar.openCloud"), 1);
          assert.deepEqual(
            calls.map((request) => request.action),
            ["list", "create", "start", "stop", "start", "open"],
          );
          assert.equal(localCreates, 0);
          assert.equal(button(t("sidebar.cloud")), undefined, "Opened Cloud closes the chooser");
          assert.equal(storage.get("codeshell.cloud-workbench.v1"), `${origin}/`);
        }
      }
    }
  } else if (scenario === "late-status-after-event") {
    await emit(alice);
    await update(() => lateStatus.resolve({ state: "signed-out" }));
    assert.equal(button(t("cloudManager.connect")) !== undefined, true);
    assert.ok(!contents().includes(t("cloudManager.signIn")));
    await submit(0);
    assert.equal(calls.length, 1);
  } else if (scenario === "ime-submit") {
    const addressInput = elements("INPUT")[0];
    const composingEnter = async (node: Element, keyCode: number, isComposing: boolean) => {
      let prevented = false;
      assert.equal(typeof props(node).onKeyDown, "function", "Inputs must guard native IME Enter");
      await update(() =>
        props(node).onKeyDown({
          key: "Enter",
          keyCode,
          nativeEvent: { isComposing },
          preventDefault: () => {
            prevented = true;
          },
        }),
      );
      assert.ok(prevented, "IME Enter must prevent the form's implicit submission");
    };
    await composingEnter(addressInput, 229, false);
    await composingEnter(addressInput, 13, true);
    await update(() => props(addressInput).onCompositionStart());
    await submit(0);
    assert.equal(calls.length, 0);
    await update(() => props(addressInput).onCompositionEnd());
    await submit(0);
    await change(elements("INPUT")[1], "中文项目");
    await composingEnter(elements("INPUT")[1], 229, false);
    await composingEnter(elements("INPUT")[1], 13, true);
    await update(() => props(elements("INPUT")[1]).onCompositionStart());
    await submit(1);
    assert.equal(calls.length, 1);
    await update(() => props(elements("INPUT")[1]).onCompositionEnd());
    await submit(1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].action === "create" && calls[1].name, "中文项目");
  } else if (scenario.startsWith("same-account-late-")) {
    await submit(0);
    if (scenario === "same-account-late-open") await click(t("sidebar.openCloud"));
    const stale =
      scenario === "same-account-late-list"
        ? { action: "list" as const, available: true, projects: [{ ...project, name: "STALE" }] }
        : { action: "open" as const, project, address: `${origin}/?project=${project.id}` };
    await update(() => {
      for (const status of [{ state: "signed-out" } as const, { ...alice }]) {
        snapshot = status;
        for (const listener of [...listeners]) listener(status);
      }
      lateManagement.resolve(stale);
    });
    assert.ok(!contents().includes("STALE"));
    assert.ok(!contents().includes(project.name));
    assert.equal(
      button(t("cloudManager.logout")),
      undefined,
      "Relogin forgets the old attempted scope",
    );
    assert.equal(opened.length, 0, "Late open must not close/adopt in the new login");
    projects = [{ ...project, name: "Fresh login project" }];
    await submit(0);
    assert.ok(contents().includes("Fresh login project"));
    assert.equal(busy.at(-1), false);
  } else if (scenario === "initial-connect-failure-logout") {
    fail = "list";
    await submit(0);
    assert.ok(contents().includes("fixture list ACK unknown"));
    assert.ok(button(t("cloudManager.logout")), "Failed first connect must retain scoped logout");
    await change(elements("INPUT")[0], "https://different-cloud.example");
    await click(t("cloudManager.logout"));
    assert.ok(contents().includes(origin), "Review must identify the attempted Cloud");
    assert.equal(calls.length, 1, "Review must not revoke");
    fail = "logout";
    await click(t("cloudManager.confirmLogout"));
    assert.ok(contents().includes("fixture logout ACK unknown"));
    fail = undefined;
    await click(t("cloudManager.confirmLogout"));
    assert.deepEqual(
      calls.map((request) => request.action),
      ["list", "logout", "logout"],
    );
    assert.ok(calls.every((request) => request.cloudOrigin === origin));
    assert.equal(button(t("cloudManager.logout")), undefined);
  } else {
    await submit(0);
    assert.ok(contents().includes(project.name));
    if (scenario.startsWith("logout-")) {
      await click(t("cloudManager.logout"));
      assert.equal(calls.length, 1, "Review must not revoke");
      await click(t("cloudManager.cancel"));
      assert.equal(calls.length, 1, "Cancel must not revoke");
      await click(t("cloudManager.logout"));
      if (scenario === "logout-unknown-retry") fail = "logout";
      await click(t("cloudManager.confirmLogout"));
      if (scenario === "logout-unknown-retry") {
        assert.ok(contents().includes(project.name));
        assert.ok(contents().includes("fixture logout ACK unknown"));
        assert.ok(props(button(t("cloudManager.start"))).disabled);
        fail = undefined;
        await click(t("cloudManager.confirmLogout"));
      }
      assert.equal(accountLogouts, 0, "Cloud logout must not sign out the Account authority");
      assert.equal(calls[1].action, "logout");
      assert.equal(calls[1].cloudOrigin, origin);
      assert.ok(!contents().includes(project.name));
      assert.equal(button(t("cloudManager.logout")), undefined);
    } else {
      if (scenario === "failed-mutation-reload") {
        fail = "start";
        await click(t("cloudManager.start"));
      } else {
        fail = "list";
        await submit(0);
      }
      assert.ok(contents().includes(project.name));
      assert.ok(props(button(t("cloudManager.start"))).disabled);
      assert.ok(props(button(t("cloudManager.stop"))).disabled);
      assert.ok(props(button(t("sidebar.openCloud"))).disabled);
      await change(elements("INPUT")[1], "Blocked mutation");
      assert.ok(props(button(t("cloudManager.create"))).disabled);
      fail = "list";
      await submit(0);
      assert.ok(contents().includes(project.name));
      assert.ok(props(button(t("cloudManager.create"))).disabled);
      fail = undefined;
      await submit(0);
      assert.ok(!props(button(t("cloudManager.start"))).disabled);
      assert.ok(!props(button(t("cloudManager.create"))).disabled);
    }
  }
  assert.equal(accountLogouts, 0);
  assert.equal(backCalls, 0);
} finally {
  await update(() => root.unmount());
  document.body.removeChild(container);
}
assert.equal(listeners.size, 0, "Unmount must remove all Account subscriptions");
if (chooser) assert.equal(menuDetached, 1, "Unmount must detach the native menu callback");
assert.equal(unexpectedRequests, 0);
console.log(JSON.stringify({ scenario, passed: true, unexpectedRequests }));
