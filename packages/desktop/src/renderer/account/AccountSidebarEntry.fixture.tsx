// Separate processes preserve Radix's real browser initialization without
// inheriting UI-module mocks or portal state from other renderer suites.
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type {
  CloudAccountApi,
  CloudAccountIdentity,
  CloudAccountLogin,
  CloudAccountLogoutResult,
  CloudAccountStatus,
} from "../../shared/cloud-account.js";
import type { MaskedCredentialView } from "../credentials/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
HTMLElement.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 240, bottom: 36, width: 240, height: 36 }) as DOMRect;
// Popper reads CSS custom properties when the account dropdown mounts.
const createElement = document.createElement.bind(document);
document.createElement = ((...args: Parameters<typeof document.createElement>) => {
  const element = createElement(...args);
  element.style.setProperty = (name: string, value: string | null) => {
    (element.style as unknown as Record<string, string>)[name] = value ?? "";
  };
  element.style.removeProperty = (name: string) => {
    const value = (element.style as unknown as Record<string, string>)[name] ?? "";
    delete (element.style as unknown as Record<string, string>)[name];
    return value;
  };
  element.style.getPropertyValue = (name: string) =>
    (element.style as unknown as Record<string, string>)[name] ?? "";
  return element;
}) as typeof document.createElement;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null },
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: clearTimeout,
});

const { AccountSidebarEntry } = await import("./AccountSidebarEntry");
const { ToastProvider } = await import("../ui/ToastProvider");
const scenario = process.argv[2];
type Capabilities = Awaited<ReturnType<CloudAccountApi["capabilities"]>>;
const deferred = <T = CloudAccountStatus,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const savedGitHubLink: MaskedCredentialView = {
  id: "saved-github-link",
  type: "link",
  label: "Saved GitHub Link",
  storeScope: "user",
  hasSecret: true,
  meta: { linkProvider: "github", linkExecutionRuntime: "local" },
};
const savedCredentialRows = (): MaskedCredentialView[] => {
  if (
    scenario.startsWith("github-first-") ||
    ["github-connect-unavailable", "github-connect-legacy"].includes(scenario)
  ) {
    if (scenario !== "github-first-unrelated") return [];
    return [
      { ...savedGitHubLink, type: "token" },
      { ...savedGitHubLink, storeScope: "project" },
      { ...savedGitHubLink, id: "figma-link", meta: { linkProvider: "figma" } },
    ];
  }
  if (scenario === "github-existing-server")
    return [
      { ...savedGitHubLink, meta: { oauthProvider: "github", linkExecutionRuntime: "server" } },
    ];
  if (scenario === "github-existing-legacy")
    return [{ ...savedGitHubLink, id: "github-oauth", type: "oauth", meta: undefined }];
  const state = scenario.replace("github-existing-", "");
  if (["expired", "invalid", "missing"].includes(state))
    return [
      {
        ...savedGitHubLink,
        type: "oauth",
        hasSecret: state !== "missing",
        oauthStatus: { state: state as "expired" | "invalid" | "missing" },
      },
    ];
  return [savedGitHubLink];
};
const credentialListCalls: string[] = [];
const credentialListRequests: ReturnType<typeof deferred<MaskedCredentialView[]>>[] = [];
const listCredentials = (cwd: string) => {
  assert.equal(cwd, "", "Login defaults read masked global credentials only");
  credentialListCalls.push(cwd);
  if (scenario === "github-credentials-rejected")
    return Promise.reject(new Error("Local read failed"));
  if (scenario === "github-credentials-malformed")
    return Promise.resolve(null as unknown as MaskedCredentialView[]);
  if (scenario.startsWith("github-credentials-")) {
    const request = deferred<MaskedCredentialView[]>();
    credentialListRequests.push(request);
    return request.promise;
  }
  return Promise.resolve(savedCredentialRows());
};
const listeners = new Set<(status: CloudAccountStatus) => void>();
const subscribed: Array<(status: CloudAccountStatus) => void> = [];
const requests: ReturnType<typeof deferred<CloudAccountStatus>>[] = [];
const capabilityRequests: Array<{
  origin: string;
  request: ReturnType<typeof deferred<Capabilities>>;
}> = [];
let capabilityAttempts = 0;
const credentials: Array<{ action: string; input: CloudAccountLogin }> = [];
const authenticationRequest = deferred<CloudAccountStatus>();
const logoutRequest = deferred<void>();
const logoutResultRequest = deferred<CloudAccountLogoutResult>();
let logoutCalls = 0;
const toastErrors: string[] = [];
const profileRequest = deferred<CloudAccountStatus>();
const profileCalls: Array<Parameters<CloudAccountApi["profile"]>[0]> = [];
let remoteProfile: CloudAccountIdentity | undefined;
let current: CloudAccountStatus = { state: "signed-out" };
let subscriptions = 0;
let unsubscriptions = 0;
let githubOrigin = "";
const githubRequests: Array<Parameters<CloudAccountApi["signInWithGitHub"]>[0]> = [];
let githubBindings = 0;
let cancellations = 0;
const emit = (next: CloudAccountStatus) => {
  current = next;
  for (const listener of listeners) listener(next);
};
const signedIn = (username: string): CloudAccountStatus => ({
  state: "signed-in",
  origin: "https://accounts.example.test",
  account: { id: `account-${username}`, username },
});
const authenticate = async (action: string, input: CloudAccountLogin) => {
  credentials.push({ action, input });
  if (scenario === "registration-pending") return authenticationRequest.promise;
  emit(signedIn(input.username));
  return current;
};
const api: CloudAccountApi = {
  profile: async (input) => {
    assert.ok(scenario.startsWith("profile-") && scenario !== "profile-unavailable");
    profileCalls.push(input);
    if (input.action === "read" && scenario === "profile-read-pending")
      return profileRequest.promise;
    if (input.action === "update" && scenario === "profile-failure")
      throw new Error(
        "Error invoking remote method 'cloudAccount:profile': Error: 此用户名已被使用，请换一个用户名。",
      );
    if (input.action === "update" && scenario === "profile-stale") return profileRequest.promise;
    remoteProfile =
      input.action === "read"
        ? { ...current.account!, displayName: "原昵称" }
        : {
            ...remoteProfile!,
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.username === undefined ? {} : { username: input.username }),
          };
    emit({
      ...current,
      account: remoteProfile,
    });
    return current;
  },
  manageLinks: async () => {
    throw new Error("Sidebar fixture does not authorize Link management requests");
  },
  capabilities: (origin) => {
    capabilityAttempts += 1;
    if (scenario === "capabilities-stale") {
      const request = deferred<Capabilities>();
      capabilityRequests.push({ origin, request });
      return request.promise;
    }
    if (scenario === "capabilities-retry" && capabilityAttempts === 1) {
      return Promise.reject(new Error("Discovery unavailable"));
    }
    return Promise.resolve({
      profileEnabled: scenario.startsWith("profile-") && scenario !== "profile-unavailable",
      registrationAllowed: !["registration-unavailable", "github-registration-closed"].includes(
        scenario,
      ),
      githubEnabled: !["github-unavailable", "link-unavailable"].includes(scenario),
      ...(scenario === "github-connect-legacy"
        ? {}
        : {
            githubLinkEnabled: ![
              "github-connect-unavailable",
              "github-credentials-account-only",
            ].includes(scenario),
          }),
    });
  },
  status: () => {
    if (
      ["late-response", "late-failure", "cleanup"].includes(scenario) ||
      (["github-connect-late-status", "github-connect-late-failure"].includes(scenario) &&
        githubRequests.length > 0)
    ) {
      const request = deferred();
      requests.push(request);
      return request.promise;
    }
    if (scenario === "unavailable") return Promise.reject(new Error("IPC unavailable"));
    return Promise.resolve(current);
  },
  login: (input) => authenticate("login", input),
  register: (input) => authenticate("register", input),
  signInWithGitHub: async (input) => {
    githubRequests.push(input);
    githubOrigin = input.origin;
    if (
      [
        "github-connect-optin",
        "github-connect-failed",
        "github-connect-skipped",
        "github-connect-late-status",
        "github-connect-late-failure",
      ].includes(scenario) ||
      (["github-connect-repeat", "github-first-connect", "github-first-unrelated"].includes(
        scenario,
      ) &&
        input.connectGitHub)
    ) {
      emit({ ...signedIn("github-user"), githubConnection: { state: "pending" } });
    } else if (
      [
        "github-first-connect",
        "github-first-unrelated",
        "github-first-optout",
        "github-credentials-rejected",
        "github-credentials-malformed",
        "github-credentials-account-only",
        "github-credentials-deadline",
        "github-login-only-default",
        "github-connect-repeat",
        "github-connect-optout",
        "github-connect-unavailable",
        "github-connect-legacy",
      ].includes(scenario) ||
      scenario.startsWith("github-existing-")
    ) {
      emit({ ...signedIn("github-user"), githubConnection: { state: "skipped" } });
    } else {
      emit(
        scenario === "github-automatic-account" ? signedIn("github-user") : { state: "signing-in" },
      );
    }
    return current;
  },
  linkGitHub: async () => {
    githubBindings += 1;
    return current;
  },
  cancelSignIn: async () => {
    cancellations += 1;
    emit({ state: "signed-out" });
  },
  logout: async () => {
    logoutCalls += 1;
    if (["menu-logout-failure", "settings-logout-failure"].includes(scenario) && logoutCalls === 1)
      throw new Error("Unable to sign out");
    if (scenario === "menu-logout-pending") await logoutRequest.promise;
    if (scenario.endsWith("logout-stale")) return logoutResultRequest.promise;
    emit({ state: "signed-out" });
    return {
      state: "signed-out",
      revocation: scenario.endsWith("logout-unconfirmed") ? "unconfirmed" : "confirmed",
    };
  },
  onStatus: (callback) => {
    subscriptions += 1;
    subscribed.push(callback);
    listeners.add(callback);
    return () => {
      unsubscriptions += 1;
      listeners.delete(callback);
    };
  },
};
Object.defineProperty(window, "codeshell", {
  configurable: true,
  value: {
    cloudAccount: api,
    credentials: { list: listCredentials },
    log: (event: string) => {
      if (event === "ui.toast.error") toastErrors.push(event);
    },
  },
});

function nodes(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(nodes)];
}
function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}
function text(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? (node as Text).data ?? "";
  return node.childNodes.length
    ? Array.from(node.childNodes).map(text).join("")
    : (node.textContent ?? "");
}
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
let mounted = true;
const trigger = () => {
  const button = nodes(container).find((node) => node.tagName === "BUTTON");
  assert.ok(button, "The sidebar always has an account button");
  return button as HTMLButtonElement;
};
const dialog = () => nodes(document.body).find((node) => props(node).role === "dialog");
const menu = () => nodes(document.body).find((node) => props(node).role === "menu");
const menuItem = (label: string) => {
  const found = nodes(menu()!).find(
    (node) => props(node).role === "menuitem" && text(node) === label,
  );
  assert.ok(found, `Account menu action is available: ${label}`);
  return found;
};
const form = () => {
  const found = nodes(dialog()!).find((node) => node.tagName === "FORM");
  assert.ok(found, "Password credentials use a form that supports Enter submission");
  return found;
};
const button = (label: string) => {
  const found = nodes(dialog() ?? document.body).find(
    (node) => node.tagName === "BUTTON" && text(node) === label,
  );
  assert.ok(found, `Account action is available: ${label}`);
  return found;
};
const input = (label: string) => {
  const found = nodes(dialog()!).find((node) => node.tagName === "LABEL" && text(node) === label);
  assert.ok(found, `Account field is available: ${label}`);
  const field = nodes(found).find((node) => node.tagName === "INPUT");
  assert.ok(field);
  return field;
};
const settle = async (action: () => void) => {
  await act(async () => {
    action();
    await flushMicrotasks();
  });
};
const settleCapabilities = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flushMicrotasks();
  });
};
const settleClose = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
  });
};
const click = (node: Element) =>
  settle(() => {
    assert.ok(!props(node).disabled, `Action must be enabled: ${text(node)}`);
    if (props(node).type === "submit") {
      props(form()).onSubmit({ preventDefault() {}, currentTarget: form() });
    } else {
      props(node).onClick({ defaultPrevented: false, preventDefault() {}, currentTarget: node });
    }
  });
// The mini DOM has no browser implicit-Enter behavior; exercise the real form
// submit handler used by Enter and the native submit button.
const submit = () => settle(() => props(form()).onSubmit({ preventDefault() {} }));
const change = (node: Element, value: string) =>
  settle(() => props(node).onChange({ target: { value } }));
const check = (node: Element, checked: boolean) =>
  settle(() => {
    assert.equal(props(node).disabled, false, "The GitHub connection choice can be changed");
    props(node).onChange({ target: { checked } });
  });
const openMenu = async () => {
  trigger().focus();
  await settle(() =>
    props(trigger()).onKeyDown({ key: "Enter", defaultPrevented: false, preventDefault() {} }),
  );
  assert.ok(menu(), "The account button opens its menu");
  assert.equal(props(trigger())["aria-expanded"], true);
};
const selectMenu = async (label: string) => {
  const node = menuItem(label);
  assert.equal(props(node)["data-disabled"], undefined, `${label} is enabled`);
  await settle(() =>
    props(node).onClick({
      defaultPrevented: false,
      stopPropagation() {},
      currentTarget: node,
    }),
  );
  await settleClose();
};
const closeMenu = async () => {
  await settle(() =>
    document.dispatchEvent(
      Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }),
    ),
  );
  await settleClose();
  assert.equal(menu(), undefined);
  assert.equal(document.activeElement, trigger(), "Dismissing the menu restores account focus");
};
const open = async () => {
  await openMenu();
  assert.equal(dialog(), undefined, "Opening the menu does not mount account management");
  await selectMenu(current.account?.username ? "账号管理" : "登录账号");
  assert.ok(dialog(), "The account menu opens the real management dialog");
  assert.equal(menu(), undefined, "The menu releases its surface before management opens");
  assert.equal(props(trigger())["aria-expanded"], false);
  assert.ok(text(dialog()!).includes("账号管理"));
};
const close = async () => {
  await click(button("Close"));
  await settleClose();
  assert.equal(dialog(), undefined, "Closing removes account management");
  assert.equal(props(trigger())["aria-expanded"], false);
  assert.equal(document.activeElement, trigger(), "Closing management restores account focus");
};
const assertTriggerDetails = (detail: string) => {
  const describedBy = props(trigger())["aria-describedby"];
  assert.equal(typeof describedBy, "string", "The account icon describes its current state");
  assert.ok(describedBy.trim(), "The account icon references a status description");
  const descriptions = describedBy
    .trim()
    .split(/\s+/)
    .map((id: string) => {
      const description = nodes(document.body).find((node) => props(node).id === id);
      assert.ok(description, `The account status description exists: ${id}`);
      return text(description);
    });
  assert.equal(descriptions.join(" "), detail);
  assert.equal(props(trigger()).title, `${props(trigger())["aria-label"]}\n${detail}`);
};
const assertSignedOut = () => {
  assert.equal(props(trigger())["aria-label"], "登录账号");
  assertTriggerDetails("本地模式 · 未登录");
};
const assertSignedIn = (username: string) => {
  assert.equal(props(trigger())["aria-label"], `账号管理: ${username}`);
  assertTriggerDetails("CodeShell 云账号");
  if (dialog()) {
    assert.ok(text(dialog()!).includes(username));
    assert.ok(text(dialog()!).includes("云账号已登录"));
    button("退出云账号");
  }
};

try {
  await settle(() =>
    root.render(
      <ToastProvider>
        <AccountSidebarEntry
          onOpenSettingsPage={() => {}}
          petWidgetVisible={false}
          onTogglePetWidget={() => {}}
        />
      </ToastProvider>,
    ),
  );
  assert.equal(listeners.size, 1, "The footer listens even before management opens");
  assert.equal(credentialListCalls.length, 0, "The footer does not inspect saved credentials");

  if (scenario === "menu-preview") {
    assertSignedOut();
    await openMenu();
    assert.equal(dialog(), undefined, "The account form stays unmounted in the menu");
    assert.equal(listeners.size, 1, "Opening the menu does not subscribe an account form");
    assert.deepEqual(
      nodes(menu()!)
        .filter((node) => props(node).role === "menuitem")
        .slice(0, 2)
        .map(text),
      ["设置", "切换语言"],
      "Settings and language lead the account menu",
    );
    menuItem("登录账号");
    assert.ok(!text(menu()!).includes("退出云账号"), "Local mode has no sign-out action");
    await settleCapabilities();
    assert.equal(capabilityAttempts, 0, "Opening an account menu never contacts the service");
    await closeMenu();
    await settle(() => emit(signedIn("menu-user")));
    await openMenu();
    assert.ok(
      text(menu()!).includes("menu-user"),
      "The account menu identifies the signed-in user",
    );
    menuItem("账号管理");
    menuItem("退出云账号");
    await settleCapabilities();
    assert.equal(capabilityAttempts, 0, "A signed-in menu also uses only the local status");
  } else if (["menu-logout", "menu-logout-unconfirmed"].includes(scenario)) {
    await settle(() => emit(signedIn("menu-user")));
    await openMenu();
    await selectMenu("退出云账号");
    assert.equal(logoutCalls, 1);
    assertSignedOut();
    assert.equal(dialog(), undefined, "Menu sign-out does not open account management");
    assert.equal(menu(), undefined, "Sign-out dismisses its menu");
    assert.equal(capabilityAttempts, 0, "Sign-out does not discover service capabilities");
    assert.equal(document.activeElement, trigger());
    assert.notEqual(document.body.style.pointerEvents, "none");
    if (scenario === "menu-logout-unconfirmed") {
      assert.ok(
        text(document.body).includes("本机已退出；服务端未确认撤销"),
        "Local sign-out explains the outstanding device revocation",
      );
      assert.ok(!text(document.body).includes("Error invoking remote method"));
      assert.equal(toastErrors.length, 0, "Unconfirmed revocation is an informative notice");
    }
  } else if (["settings-logout-unconfirmed", "storage-logout-unconfirmed"].includes(scenario)) {
    await settle(() =>
      emit(
        scenario === "storage-logout-unconfirmed"
          ? { state: "storage-error" }
          : signedIn("settings-user"),
      ),
    );
    await open();
    await click(button("退出云账号"));
    assert.equal(logoutCalls, 1);
    assertSignedOut();
    assert.ok(text(dialog()!).includes("本地使用中，尚未登录云账号"));
    assert.ok(
      nodes(dialog()!).some(
        (node) => props(node).role === "status" && text(node).includes("服务端未确认撤销"),
      ),
      "Settings keep an inline revocation notice after account controls are removed",
    );
    await settleCapabilities();
    assert.ok(text(dialog()!).includes("请联网后在账号会话管理中撤销此设备"));
    assert.ok(!text(document.body).includes("Error invoking remote method"));
    assert.equal(toastErrors.length, 0, "Unconfirmed revocation does not raise an error toast");
  } else if (scenario === "settings-logout-failure") {
    await settle(() => emit(signedIn("settings-user")));
    await open();
    await click(button("退出云账号"));
    assertSignedIn("settings-user");
    assert.equal(logoutCalls, 1);
    assert.ok(text(dialog()!).includes("Unable to sign out"));
    assert.equal(toastErrors.length, 1, "A real failure still raises an error toast");
    assert.ok(!text(dialog()!).includes("服务端未确认撤销"));
    await click(button("退出云账号"));
    assert.equal(logoutCalls, 2);
    assertSignedOut();
  } else if (["menu-logout-stale", "settings-logout-stale"].includes(scenario)) {
    await settle(() => emit(signedIn("previous-user")));
    if (scenario === "menu-logout-stale") {
      await openMenu();
      await selectMenu("退出云账号");
    } else {
      await open();
      await click(button("退出云账号"));
    }
    assert.equal(logoutCalls, 1);
    await settle(() => {
      emit({ state: "signed-out" });
      emit(signedIn("new-user"));
      logoutResultRequest.resolve({ state: "signed-out", revocation: "unconfirmed" });
    });
    assertSignedIn("new-user");
    assert.ok(
      !text(document.body).includes("本机已退出"),
      "A late logout reply cannot describe a new signed-in account as signed out",
    );
    assert.equal(toastErrors.length, 0);
  } else if (scenario === "menu-logout-pending") {
    for (const pending of [
      { ...signedIn("menu-user"), state: "signing-in" as const },
      { ...signedIn("menu-user"), githubConnection: { state: "pending" as const } },
    ]) {
      await settle(() => emit(pending));
      await openMenu();
      assert.notEqual(
        props(menuItem("退出云账号"))["data-disabled"],
        undefined,
        "Sign-out is disabled while authentication or a GitHub connection is pending",
      );
      await closeMenu();
    }
    await settle(() => emit(signedIn("menu-user")));
    await openMenu();
    const node = menuItem("退出云账号");
    const onClick = props(node).onClick;
    const select = () =>
      onClick({
        defaultPrevented: false,
        stopPropagation() {},
        currentTarget: node,
      });
    await settle(() => {
      select();
      select();
    });
    await settleClose();
    assert.equal(logoutCalls, 1, "Two selections in one tick send one sign-out request");
    assertSignedIn("menu-user");
    await openMenu();
    assert.notEqual(
      props(menuItem("退出云账号"))["data-disabled"],
      undefined,
      "Reopening while sign-out runs keeps the action disabled",
    );
    await settle(() => logoutRequest.resolve());
    assert.equal(logoutCalls, 1);
    assertSignedOut();
    assert.ok(!text(menu()!).includes("退出云账号"), "Completed sign-out removes its action");
  } else if (scenario === "menu-logout-failure") {
    await settle(() => emit(signedIn("menu-user")));
    await openMenu();
    await selectMenu("退出云账号");
    assert.equal(logoutCalls, 1);
    assertSignedIn("menu-user");
    assert.ok(text(document.body).includes("Unable to sign out"), "A failed sign-out explains why");
    assert.equal(dialog(), undefined);
    assert.notEqual(document.body.style.pointerEvents, "none");
    await openMenu();
    assert.equal(props(menuItem("退出云账号"))["data-disabled"], undefined);
    await selectMenu("退出云账号");
    assert.equal(logoutCalls, 2, "A failed sign-out can be retried");
    assertSignedOut();
  } else if (scenario.startsWith("profile-")) {
    await settle(() => emit(signedIn("github-123")));
    await open();
    await settleCapabilities();
    if (scenario === "profile-unavailable") {
      assert.equal(profileCalls.length, 0);
      assert.equal(props(button("保存资料")).disabled, true);
      assert.equal(props(input("昵称")).disabled, true);
      assert.ok(text(dialog()!).includes("此云服务尚未启用资料编辑"));
    } else if (scenario === "profile-read-pending") {
      assert.equal(profileCalls[0]?.action, "read");
      assert.equal(props(input("昵称")).disabled, true);
      assert.equal(props(input("登录用户名")).disabled, true);
      await submit();
      assert.equal(profileCalls.length, 1, "A pending profile read cannot submit cached values");
      remoteProfile = { ...current.account!, username: "fresh-username", displayName: "云端昵称" };
      await settle(() => {
        emit({ ...current, account: remoteProfile });
        profileRequest.resolve(current);
      });
      assert.equal(props(input("昵称")).value, "云端昵称");
      assert.equal(props(input("登录用户名")).value, "fresh-username");
      assert.equal(props(button("保存资料")).disabled, true);
      await change(input("昵称"), "新昵称");
      await click(button("保存资料"));
      assert.deepEqual(profileCalls[1], {
        action: "update",
        origin: current.origin,
        accountId: "account-github-123",
        displayName: "新昵称",
      });
      assert.equal(props(input("登录用户名")).value, "fresh-username");
    } else if (["profile-name-only", "profile-username-only"].includes(scenario)) {
      assert.equal(profileCalls[0]?.action, "read");
      assertSignedIn("原昵称");
      assert.equal(props(input("登录用户名")).value, "github-123");
      assert.equal(props(button("保存资料")).disabled, true, "Unchanged profiles cannot save");
      if (scenario === "profile-name-only") {
        remoteProfile = { ...remoteProfile!, username: "cloud-renamed" };
        await change(input("昵称"), "新昵称 👩‍💻");
        await change(input("登录用户名"), " GitHub-123 ");
        await click(button("保存资料"));
        assert.deepEqual(profileCalls[1], {
          action: "update",
          origin: current.origin,
          accountId: "account-github-123",
          displayName: "新昵称 👩‍💻",
        });
        assert.equal(
          remoteProfile?.username,
          "cloud-renamed",
          "A nickname edit preserves the username changed in another window",
        );
        assertSignedIn("新昵称 👩‍💻");
        assert.equal(props(input("登录用户名")).value, "cloud-renamed");
      } else {
        remoteProfile = { ...remoteProfile!, displayName: "云端新昵称" };
        await change(input("登录用户名"), " Alice-New ");
        await change(input("昵称"), " 原昵称 ");
        await click(button("保存资料"));
        assert.deepEqual(profileCalls[1], {
          action: "update",
          origin: current.origin,
          accountId: "account-github-123",
          username: "alice-new",
        });
        assert.equal(
          remoteProfile?.displayName,
          "云端新昵称",
          "A username edit preserves the nickname changed in another window",
        );
        assertSignedIn("云端新昵称");
        assert.equal(props(input("昵称")).value, "云端新昵称");
        assert.equal(props(input("登录用户名")).value, "alice-new");
      }
      assert.ok(text(dialog()!).includes("账号资料已保存。"));
    } else {
      assert.equal(profileCalls[0]?.action, "read");
      assertSignedIn("原昵称");
      assert.equal(props(input("登录用户名")).value, "github-123");
      await change(input("昵称"), "bad\u202ename");
      assert.equal(props(button("保存资料")).disabled, true);
      await change(input("昵称"), " e\u0301 中文 👩‍💻 ");
      await change(input("登录用户名"), " Alice-New ");
      await click(button("保存资料"));
      assert.deepEqual(profileCalls[1], {
        action: "update",
        origin: current.origin,
        accountId: "account-github-123",
        displayName: "é 中文 👩‍💻",
        username: "alice-new",
      });
      if (scenario === "profile-failure") {
        assert.ok(text(dialog()!).includes("此用户名已被使用"));
        assert.ok(!text(dialog()!).includes("Error invoking"));
        assert.equal(props(input("昵称")).value, " e\u0301 中文 👩‍💻 ");
        assert.ok(!text(dialog()!).includes("账号资料已保存。"));
      } else if (scenario === "profile-stale") {
        await settle(() => emit(signedIn("bob")));
        await settle(() => profileRequest.resolve(signedIn("late-old-user")));
        assert.ok(!text(dialog()!).includes("账号资料已保存。"));
        assert.ok(!text(dialog()!).includes("late-old-user"));
      } else {
        assertSignedIn("é 中文 👩‍💻");
        assert.equal(props(input("登录用户名")).value, "alice-new");
        assert.ok(text(dialog()!).includes("账号资料已保存。"));
      }
    }
  } else if (scenario === "authentication") {
    assertSignedOut();
    assert.equal(dialog(), undefined, "The initial account entry does not interrupt local work");
    await open();
    assert.equal(listeners.size, 2, "The account form independently observes status");
    assert.equal(props(button("登录")).disabled, true, "Empty credentials cannot be submitted");
    assert.equal(props(button("密码登录"))["aria-pressed"], true);
    assert.ok(
      nodes(dialog()!).some(
        (node) => props(node).role === "group" && props(node)["aria-label"] === "账号密码登录方式",
      ),
    );
    assert.equal(props(button("创建账号")).type, "button");
    assert.equal(props(button("使用 GitHub 登录")).disabled, true);
    assert.equal(props(input("同时连接 GitHub")).disabled, true);
    assert.ok(text(dialog()!).includes("正在检查可用登录方式…"));
    await settleCapabilities();
    assert.equal(props(button("使用 GitHub 登录")).disabled, false);
    await change(input("云服务地址"), " https://accounts.example.test/ ");
    await settleCapabilities();
    await change(input("账号名称"), " alice ");
    await change(input("密码（至少 12 位）"), "twelve-or-more-characters");
    await click(button("登录"));
    assertSignedIn("alice");
    assert.deepEqual(credentials[0], {
      action: "login",
      input: {
        origin: "https://accounts.example.test",
        username: "alice",
        password: "twelve-or-more-characters",
      },
    });
    await click(button("退出云账号"));
    assertSignedOut();
    assert.equal(props(input("密码（至少 12 位）")).value, "", "Login clears the password");
    await click(button("创建账号"));
    await change(input("账号名称"), "new-user");
    await change(input("密码（至少 12 位）"), "registration-password");
    await change(input("确认密码"), "registration-password");
    await settleCapabilities();
    await click(button("注册"));
    assertSignedIn("new-user");
    assert.equal(credentials[1]?.action, "register");
    await close();
    assert.equal(listeners.size, 1, "Closing the form preserves the footer subscription");
    assertSignedIn("new-user");
    await open();
    assertSignedIn("new-user");
    assert.equal(githubRequests.length, 0, "Password login and registration do not connect GitHub");
  } else if (scenario === "github") {
    await open();
    await change(input("云服务地址"), " https://accounts.example.test/ ");
    await settleCapabilities();
    assert.equal(props(input("账号名称")).value, "");
    assert.equal(props(input("密码（至少 12 位）")).value, "");
    await click(button("使用 GitHub 登录"));
    assert.equal(githubOrigin, "https://accounts.example.test");
    assertTriggerDetails("正在登录…");
    assert.equal(props(button("使用 GitHub 登录")).disabled, true);
    assert.equal(credentials.length, 0, "GitHub authentication never submits a password draft");
    assert.equal(props(input("同时连接 GitHub")).disabled, true);
    await click(button("取消登录"));
    assert.equal(cancellations, 1);
    assertSignedOut();
  } else if (scenario === "composition") {
    await open();
    await change(input("账号名称"), "draft-user");
    for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
      await settle(() => {
        document.dispatchEvent(
          Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape", ...extra }),
        );
      });
      assert.ok(dialog(), "Cancelling an input composition must keep account management open");
      assert.equal(props(input("账号名称")).value, "draft-user");
    }
    await settle(() => {
      document.dispatchEvent(
        Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }),
      );
    });
    assert.equal(dialog(), undefined, "Ordinary Escape closes account management");
  } else if (scenario === "late-response" || scenario === "late-failure") {
    await open();
    assert.equal(requests.length, 2, "Both initial status reads are pending");
    await settle(() => emit(signedIn("event-user")));
    assertSignedIn("event-user");
    await settle(() => {
      for (const request of requests) {
        if (scenario === "late-response") request.resolve({ state: "signed-out" });
        else request.reject(new Error("Late IPC failure"));
      }
    });
    assertSignedIn("event-user");
  } else if (scenario === "unavailable") {
    assert.equal(props(trigger())["aria-label"], "登录账号");
    assertTriggerDetails("暂时无法读取账号状态");
    await open();
    assert.ok(text(dialog()!).includes("暂时无法读取账号状态"));
    button("登录");
    button("创建账号");
    await settleCapabilities();
    assert.equal(props(button("使用 GitHub 登录")).disabled, false);
    await settle(() => emit(signedIn("recovered-user")));
    assertSignedIn("recovered-user");
  } else if (scenario === "cleanup") {
    await open();
    await close();
    assert.equal(unsubscriptions, 1, "Closing unregisters the dialog's listener");
    assert.equal(listeners.size, 1);
    await open();
    assert.equal(listeners.size, 2, "Reopening installs one fresh listener");
    await settle(() => root.unmount());
    mounted = false;
    assert.equal(listeners.size, 0, "Unmount unregisters every account listener");
    assert.equal(subscriptions, unsubscriptions);
    await settle(() => {
      // An IPC event already queued before unsubscribe can still call its old callback.
      for (const callback of subscribed) callback(signedIn("after-unmount"));
      for (const request of requests) request.resolve(signedIn("late-after-unmount"));
    });
    assert.equal(container.childNodes.length, 0);
    assert.equal(dialog(), undefined);
  } else if (scenario === "github-unavailable") {
    await open();
    assert.equal(props(button("使用 GitHub 登录")).disabled, true);
    await settleCapabilities();
    assert.equal(props(button("使用 GitHub 登录")).disabled, true);
    assert.ok(text(dialog()!).includes("此云服务尚未配置 GitHub 登录，请使用账号密码。"));
    assert.equal(githubOrigin, "", "Unsupported GitHub sign-in never starts authentication");
  } else if (scenario === "link-unavailable") {
    await settle(() => emit(signedIn("local-user")));
    await open();
    assert.equal(props(button("绑定 GitHub 登录")).disabled, true);
    await settleCapabilities();
    assert.equal(props(button("绑定 GitHub 登录")).disabled, true);
    assert.ok(text(dialog()!).includes("此云服务尚未配置 GitHub 登录，请使用账号密码。"));
    assert.ok(text(dialog()!).includes("此操作只绑定登录身份"));
  } else if (scenario === "capabilities-stale") {
    await open();
    await settleCapabilities();
    assert.equal(capabilityRequests.length, 1);
    await settle(() =>
      capabilityRequests[0]!.request.resolve({
        registrationAllowed: true,
        githubEnabled: true,
        githubLinkEnabled: true,
      }),
    );
    assert.equal(props(button("使用 GitHub 登录")).disabled, false);
    assert.equal(props(input("同时连接 GitHub")).checked, false);
    assert.equal(props(input("同时连接 GitHub")).disabled, false);
    await check(input("同时连接 GitHub"), true);
    await change(input("云服务地址"), "https://old.example.test");
    assert.equal(
      props(button("使用 GitHub 登录")).disabled,
      true,
      "Editing the origin immediately invalidates the previous discovery",
    );
    assert.equal(props(input("同时连接 GitHub")).disabled, true);
    assert.equal(props(input("同时连接 GitHub")).checked, false);
    await settleCapabilities();
    await change(input("云服务地址"), "https://new.example.test");
    await settleCapabilities();
    assert.deepEqual(
      capabilityRequests.slice(1).map(({ origin }) => origin),
      ["https://old.example.test", "https://new.example.test"],
    );
    await settle(() =>
      capabilityRequests[2]!.request.resolve({ registrationAllowed: false, githubEnabled: false }),
    );
    assert.equal(props(button("使用 GitHub 登录")).disabled, true);
    await settle(() =>
      capabilityRequests[1]!.request.resolve({
        registrationAllowed: true,
        githubEnabled: true,
        githubLinkEnabled: true,
      }),
    );
    assert.equal(
      props(button("使用 GitHub 登录")).disabled,
      true,
      "A late response from the old origin cannot enable GitHub for the new origin",
    );
    assert.ok(text(dialog()!).includes("此云服务尚未配置 GitHub 登录，请使用账号密码。"));
    assert.ok(text(dialog()!).includes("此云服务暂未开放注册。"));
    assert.equal(props(input("同时连接 GitHub")).disabled, true);
  } else if (scenario === "capabilities-retry") {
    await open();
    await settleCapabilities();
    assert.equal(props(button("使用 GitHub 登录")).disabled, true);
    assert.ok(text(dialog()!).includes("无法检查云服务的登录方式，请检查地址和网络后重试。"));
    await change(input("账号名称"), "existing-user");
    await change(input("密码（至少 12 位）"), "existing-user-password");
    assert.equal(
      props(button("登录")).disabled,
      false,
      "Discovery failures do not block password login",
    );
    await click(button("重新检查"));
    await settleCapabilities();
    assert.equal(capabilityAttempts, 2);
    assert.equal(props(button("使用 GitHub 登录")).disabled, false);
    await click(button("创建账号"));
    await change(input("密码（至少 12 位）"), "existing-user-password");
    await change(input("确认密码"), "existing-user-password");
    assert.equal(props(button("注册")).disabled, false);
    assert.ok(!text(dialog()!).includes("无法检查云服务的登录方式"));
  } else if (scenario === "registration-unavailable") {
    await open();
    await settleCapabilities();
    await change(input("账号名称"), "existing-user");
    await change(input("密码（至少 12 位）"), "existing-user-password");
    assert.ok(text(dialog()!).includes("此云服务暂未开放注册。"));
    assert.equal(props(button("创建账号")).disabled, true);
    assert.equal(props(button("登录")).disabled, false);
    await click(button("登录"));
    assertSignedIn("existing-user");
    assert.equal(credentials[0]?.action, "login");
  } else if (scenario === "registration-validation") {
    await open();
    await settleCapabilities();
    await click(button("创建账号"));
    assert.equal(props(button("创建账号"))["aria-pressed"], true);
    assert.ok(text(dialog()!).includes("3–64 位，以字母或数字开头"));
    assert.equal(props(input("密码（至少 12 位）")).autoComplete, "new-password");
    assert.equal(props(input("确认密码")).autoComplete, "new-password");
    await change(input("账号名称"), "bad name!");
    await change(input("密码（至少 12 位）"), "registration-password");
    await change(input("确认密码"), "registration-password");
    assert.equal(props(button("注册")).disabled, true, "Invalid account names cannot register");
    await submit();
    assert.equal(credentials.length, 0);
    await change(input("账号名称"), "valid-user");
    await change(input("密码（至少 12 位）"), "too-short");
    await change(input("确认密码"), "too-short");
    assert.equal(
      props(button("注册")).disabled,
      true,
      "Registration requires at least 12 characters",
    );
    await submit();
    assert.equal(credentials.length, 0);
    await change(input("密码（至少 12 位）"), "registration-password");
    await change(input("确认密码"), "different-password");
    assert.equal(props(input("确认密码"))["aria-invalid"], true);
    assert.ok(text(dialog()!).includes("两次输入的密码不一致。"));
    assert.equal(props(button("注册")).disabled, true, "Password confirmation must match");
    await submit();
    assert.equal(credentials.length, 0, "Enter cannot bypass registration validation");
  } else if (scenario === "registration-success" || scenario === "register-enter") {
    await open();
    await settleCapabilities();
    await change(input("云服务地址"), " https://accounts.example.test/ ");
    await settleCapabilities();
    await click(button("创建账号"));
    await change(input("账号名称"), " new-user ");
    await change(input("密码（至少 12 位）"), "registration-password");
    await change(input("确认密码"), "registration-password");
    assert.equal(props(button("注册")).type, "submit");
    if (scenario === "register-enter") await submit();
    else await click(button("注册"));
    assert.deepEqual(credentials, [
      {
        action: "register",
        input: {
          origin: "https://accounts.example.test",
          username: "new-user",
          password: "registration-password",
        },
      },
    ]);
    assertSignedIn("new-user");
    assert.equal(githubOrigin, "");
    await click(button("退出云账号"));
    assert.equal(props(input("密码（至少 12 位）")).value, "");
    if (props(button("创建账号"))["aria-pressed"] === true) {
      assert.equal(props(input("确认密码")).value, "", "Registration clears both password inputs");
    }
  } else if (scenario === "login-enter") {
    await open();
    await change(input("账号名称"), "existing-user");
    await change(input("密码（至少 12 位）"), "existing-user-password");
    assert.equal(props(input("密码（至少 12 位）")).autoComplete, "current-password");
    assert.equal(props(button("登录")).type, "submit");
    await submit();
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0]?.action, "login");
    assertSignedIn("existing-user");
  } else if (scenario === "registration-pending") {
    await open();
    await settleCapabilities();
    await click(button("创建账号"));
    await change(input("账号名称"), "new-user");
    await change(input("密码（至少 12 位）"), "registration-password");
    await change(input("确认密码"), "registration-password");
    await settle(() => {
      props(form()).onSubmit({ preventDefault() {} });
      props(form()).onSubmit({ preventDefault() {} });
    });
    assert.equal(
      credentials.length,
      1,
      "Two submissions in one tick send one registration request",
    );
    assert.equal(credentials[0]?.action, "register");
    assert.ok(text(dialog()!).includes("正在提交账号信息…"));
    for (const label of ["云服务地址", "账号名称", "密码（至少 12 位）", "确认密码"]) {
      assert.equal(
        props(input(label)).disabled,
        true,
        `${label} is disabled while registration runs`,
      );
    }
    for (const label of ["密码登录", "创建账号", "注册", "使用 GitHub 登录"]) {
      assert.equal(
        props(button(label)).disabled,
        true,
        `${label} is disabled while registration runs`,
      );
    }
    assert.equal(props(input("同时连接 GitHub")).disabled, true);
    await submit();
    assert.equal(credentials.length, 1, "Pending Enter submission cannot send another request");
    await settle(() => {
      emit(signedIn("new-user"));
      authenticationRequest.resolve(current);
    });
    assertSignedIn("new-user");
  } else if (scenario === "github-registration-closed") {
    await open();
    await settleCapabilities();
    assert.ok(text(dialog()!).includes("此云服务暂未开放注册。"));
    assert.ok(text(dialog()!).includes("仅已关联 GitHub 的 CodeShell 账号可继续登录。"));
    assert.equal(props(button("创建账号")).disabled, true);
    assert.equal(props(button("使用 GitHub 登录")).disabled, false);
    assert.equal(props(input("密码（至少 12 位）")).value, "");
    await click(button("使用 GitHub 登录"));
    assert.ok(
      githubOrigin,
      "GitHub sign-in remains available when password registration is closed",
    );
    assert.equal(credentials.length, 0);
    await click(button("取消登录"));
    assertSignedOut();
  } else if (scenario === "github-automatic-account") {
    await open();
    await settleCapabilities();
    assert.ok(
      text(dialog()!).includes("首次授权会自动创建 CodeShell 账号，无需先注册或设置密码。"),
    );
    assert.equal(props(input("账号名称")).value, "");
    assert.equal(props(input("密码（至少 12 位）")).value, "");
    await click(button("使用 GitHub 登录"));
    assertSignedIn("github-user");
    assert.equal(
      credentials.length,
      0,
      "GitHub creates and signs in the account without a password form",
    );
  } else if (
    ["github-first-connect", "github-first-unrelated", "github-first-optout"].includes(scenario)
  ) {
    await open();
    await settleCapabilities();
    assert.deepEqual(credentialListCalls, [""], "The form checks saved global Links once");
    assert.equal(props(input("同时连接 GitHub")).checked, true);
    assert.equal(props(input("同时连接 GitHub")).disabled, false);
    assert.ok(text(dialog()!).includes("本机尚未保存 GitHub Link 时默认勾选"));
    assert.ok(text(dialog()!).includes("已有 Link 连接会保留，默认不重复授权"));
    if (scenario === "github-first-optout") {
      await check(input("同时连接 GitHub"), false);
      await change(input("云服务地址"), "https://another.example.test");
      await settleCapabilities();
      assert.equal(
        props(input("同时连接 GitHub")).checked,
        false,
        "Explicit opt-out survives discovery",
      );
    }
    await click(button("使用 GitHub 登录"));
    assert.equal(githubRequests[0]?.connectGitHub, scenario !== "github-first-optout");
    assertSignedIn("github-user");
    if (scenario !== "github-first-optout") {
      assert.ok(text(dialog()!).includes("云账号已登录，正在连接 GitHub"));
      await settle(() =>
        emit({ ...signedIn("github-user"), githubConnection: { state: "connected" } }),
      );
      assert.ok(text(dialog()!).includes("GitHub 已连接。"));
    }
    await click(button("退出云账号"));
    await settleCapabilities();
    assert.equal(
      props(input("同时连接 GitHub")).checked,
      false,
      "A completed login consumes the automatic default",
    );
    assert.deepEqual(
      credentialListCalls,
      [""],
      "Relogin in the same form does not re-read credentials",
    );
    await click(button("使用 GitHub 登录"));
    assert.equal(
      githubRequests[1]?.connectGitHub,
      false,
      "Relogin does not repeat Link authorization",
    );
  } else if (scenario.startsWith("github-credentials-")) {
    await open();
    await settleCapabilities();
    assert.deepEqual(credentialListCalls, [""]);
    if (["github-credentials-rejected", "github-credentials-malformed"].includes(scenario)) {
      assert.equal(props(button("使用 GitHub 登录")).disabled, false);
      assert.equal(props(input("同时连接 GitHub")).checked, false);
      assert.equal(props(input("同时连接 GitHub")).disabled, false);
      assert.ok(text(dialog()!).includes("暂时无法确认已保存的 GitHub Link，已取消自动勾选"));
      await click(button("使用 GitHub 登录"));
      assert.equal(githubRequests[0]?.connectGitHub, false);
      assertSignedIn("github-user");
    } else if (scenario === "github-credentials-account-only") {
      assert.equal(props(input("同时连接 GitHub")).disabled, true);
      assert.equal(props(input("同时连接 GitHub")).checked, false);
      assert.equal(props(button("使用 GitHub 登录")).disabled, false);
      assert.ok(text(dialog()!).includes("此云服务暂不支持登录时连接 GitHub"));
      await click(button("使用 GitHub 登录"));
      assert.equal(githubRequests[0]?.connectGitHub, false);
      assertSignedIn("github-user");
      await settle(() => credentialListRequests[0]!.resolve([]));
      assertSignedIn("github-user");
    } else {
      assert.equal(props(button("使用 GitHub 登录")).disabled, true);
      assert.equal(props(input("同时连接 GitHub")).disabled, true);
      assert.ok(text(dialog()!).includes("正在检查已保存的 GitHub Link 连接"));
      await change(input("账号名称"), "existing-user");
      await change(input("密码（至少 12 位）"), "existing-user-password");
      assert.equal(
        props(button("登录")).disabled,
        false,
        "Local Link checks leave password login available",
      );
      if (scenario === "github-credentials-pending") {
        await settle(() => credentialListRequests[0]!.resolve([]));
        assert.equal(props(button("使用 GitHub 登录")).disabled, false);
        assert.equal(props(input("同时连接 GitHub")).checked, true);
        await change(input("云服务地址"), "https://another.example.test");
        await settleCapabilities();
        assert.equal(props(input("同时连接 GitHub")).checked, true);
        assert.deepEqual(
          credentialListCalls,
          [""],
          "Changing cloud services does not repeat a local check",
        );
      } else if (scenario === "github-credentials-deadline") {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 3_050));
          await flushMicrotasks();
        });
        assert.equal(props(button("使用 GitHub 登录")).disabled, false);
        assert.equal(props(input("同时连接 GitHub")).checked, false);
        assert.ok(text(dialog()!).includes("暂时无法确认已保存的 GitHub Link，已取消自动勾选"));
        await settle(() => credentialListRequests[0]!.resolve([]));
        assert.equal(
          props(input("同时连接 GitHub")).checked,
          false,
          "A late local read cannot restore automatic authorization",
        );
        await click(button("使用 GitHub 登录"));
        assert.equal(githubRequests[0]?.connectGitHub, false);
        assertSignedIn("github-user");
      } else if (scenario === "github-credentials-late-status") {
        await click(button("登录"));
        assertSignedIn("existing-user");
        await settle(() => credentialListRequests[0]!.resolve([]));
        await click(button("退出云账号"));
        await settleCapabilities();
        assert.equal(
          props(input("同时连接 GitHub")).checked,
          false,
          "Late local rows cannot override a completed login",
        );
        assert.equal(props(button("使用 GitHub 登录")).disabled, false);
      } else if (scenario === "github-credentials-unmount") {
        await close();
        await open();
        await settleCapabilities();
        assert.equal(
          credentialListRequests.length,
          2,
          "A reopened account form starts a fresh local read",
        );
        await settle(() => credentialListRequests[0]!.resolve([]));
        assert.equal(
          props(button("使用 GitHub 登录")).disabled,
          true,
          "An unmounted form cannot release the fresh check",
        );
        assert.equal(props(input("同时连接 GitHub")).checked, false);
        await settle(() => credentialListRequests[1]!.resolve([savedGitHubLink]));
        assert.equal(props(button("使用 GitHub 登录")).disabled, false);
        assert.equal(props(input("同时连接 GitHub")).checked, false);
      } else {
        assert.fail(`Unknown credential check scenario: ${scenario}`);
      }
    }
  } else if (
    [
      "github-connect-optin",
      "github-connect-repeat",
      "github-connect-failed",
      "github-connect-skipped",
    ].includes(scenario)
  ) {
    await open();
    await settleCapabilities();
    assert.equal(
      props(input("同时连接 GitHub")).checked,
      false,
      "Existing Links require explicit opt-in",
    );
    assert.equal(props(input("同时连接 GitHub")).disabled, false);
    assert.ok(text(dialog()!).includes("已有 Link 连接会保留，默认不重复授权"));
    assert.ok(text(dialog()!).includes("本机尚未保存 GitHub Link 时默认勾选"));
    assert.ok(text(dialog()!).includes("公开和私有仓库读写权限（repo）"));
    assert.ok(text(dialog()!).includes("选择要使用的仓库和 Actions 权限"));
    await check(input("同时连接 GitHub"), true);
    await click(button("使用 GitHub 登录"));
    assert.equal(githubRequests.length, 1);
    assert.equal(githubRequests[0]?.connectGitHub, true);
    assertSignedIn("github-user");
    assert.ok(text(dialog()!).includes("云账号已登录，正在连接 GitHub"));
    assert.equal(props(button("退出云账号")).disabled, true);
    assert.equal(props(button("绑定 GitHub 登录")).disabled, true);
    button("取消 GitHub 连接");
    const connectionState =
      scenario === "github-connect-failed"
        ? "failed"
        : scenario === "github-connect-skipped"
          ? "skipped"
          : "connected";
    await settle(() =>
      emit({ ...signedIn("github-user"), githubConnection: { state: connectionState } }),
    );
    assertSignedIn("github-user");
    assert.equal(props(button("退出云账号")).disabled, false);
    if (connectionState === "connected") {
      assert.ok(text(dialog()!).includes("GitHub 已连接。"));
    } else if (connectionState === "failed") {
      assert.ok(text(dialog()!).includes("云账号已登录，但 GitHub 连接未完成。"));
      assert.ok(text(dialog()!).includes("可稍后在「凭证 → Link」中重试。"));
      assert.ok(!text(dialog()!).includes("GitHub 已连接。"));
    } else {
      assert.ok(text(dialog()!).includes("GitHub 数据连接步骤已跳过或取消。已有 Link 连接保留"));
      assert.ok(!text(dialog()!).includes("GitHub 已连接。"));
    }
    if (scenario === "github-connect-repeat") {
      await click(button("退出云账号"));
      assert.equal(props(input("同时连接 GitHub")).checked, false);
      await settleCapabilities();
      await click(button("使用 GitHub 登录"));
      assert.equal(githubRequests[1]?.connectGitHub, false);
      assertSignedIn("github-user");
      assert.ok(text(dialog()!).includes("GitHub 数据连接步骤已跳过或取消。已有 Link 连接保留"));
      await click(button("退出云账号"));
      await settleCapabilities();
      assert.equal(props(input("同时连接 GitHub")).checked, false);
      await check(input("同时连接 GitHub"), true);
      await click(button("使用 GitHub 登录"));
      assert.equal(githubRequests[2]?.connectGitHub, true);
      await settle(() =>
        emit({ ...signedIn("github-user"), githubConnection: { state: "connected" } }),
      );
      assertSignedIn("github-user");
      assert.ok(text(dialog()!).includes("GitHub 已连接。"));
    }
  } else if (
    ["github-login-only-default", "github-connect-optout"].includes(scenario) ||
    scenario.startsWith("github-existing-")
  ) {
    await open();
    await settleCapabilities();
    assert.equal(props(input("同时连接 GitHub")).checked, false);
    assert.ok(text(dialog()!).includes("已有 Link 连接会保留，默认不重复授权"));
    if (scenario === "github-connect-optout") {
      await check(input("同时连接 GitHub"), true);
      await check(input("同时连接 GitHub"), false);
    }
    await click(button("使用 GitHub 登录"));
    assert.equal(githubRequests.length, 1);
    assert.equal(githubRequests[0]?.connectGitHub, false);
    assertSignedIn("github-user");
    assert.ok(text(dialog()!).includes("GitHub 数据连接步骤已跳过或取消。已有 Link 连接保留"));
    assert.ok(!text(dialog()!).includes("尚未连接 GitHub"));
    assert.ok(!text(dialog()!).includes("GitHub 已连接。"));
    assert.equal(credentials.length, 0);
  } else if (["github-connect-unavailable", "github-connect-legacy"].includes(scenario)) {
    await open();
    await settleCapabilities();
    assert.equal(props(input("同时连接 GitHub")).checked, false);
    assert.equal(props(input("同时连接 GitHub")).disabled, true);
    assert.ok(text(dialog()!).includes("此云服务暂不支持登录时连接 GitHub"));
    assert.equal(props(button("使用 GitHub 登录")).disabled, false);
    await click(button("使用 GitHub 登录"));
    assert.equal(githubRequests[0]?.connectGitHub, false);
    assertSignedIn("github-user");
    assert.ok(!text(dialog()!).includes("GitHub 已连接。"));
  } else if (scenario === "github-bind-only") {
    await settle(() => emit(signedIn("password-user")));
    await open();
    await settleCapabilities();
    assert.ok(text(dialog()!).includes("此操作只绑定登录身份"));
    await click(button("绑定 GitHub 登录"));
    assert.equal(githubBindings, 1);
    assert.equal(
      githubRequests.length,
      0,
      "Identity binding never starts a GitHub data connection",
    );
    assertSignedIn("password-user");
    assert.equal(current.githubConnection, undefined);
    assert.ok(!text(dialog()!).includes("GitHub 已连接。"));
  } else if (["github-connect-late-status", "github-connect-late-failure"].includes(scenario)) {
    await open();
    await settleCapabilities();
    await check(input("同时连接 GitHub"), true);
    await click(button("使用 GitHub 登录"));
    assert.equal(requests.length, 1, "The post-sign-in status snapshot is still in transit");
    const stale = current;
    await settle(() =>
      emit({ ...signedIn("github-user"), githubConnection: { state: "connected" } }),
    );
    assert.ok(text(dialog()!).includes("GitHub 已连接。"));
    await settle(() => {
      if (scenario === "github-connect-late-status") requests[0]!.resolve(stale);
      else requests[0]!.reject(new Error("Late IPC failure"));
    });
    assertSignedIn("github-user");
    assert.ok(text(dialog()!).includes("GitHub 已连接。"));
    assert.ok(!text(dialog()!).includes("正在连接 GitHub"));
    assert.ok(!text(dialog()!).includes("Late IPC failure"));
    assert.equal(props(button("退出云账号")).disabled, false);
  } else {
    assert.fail(`Unknown fixture scenario: ${scenario}`);
  }
} finally {
  if (mounted) await settle(() => root.unmount());
  assert.equal(listeners.size, 0, "Account listeners are released on unmount");
  assert.equal(subscriptions, unsubscriptions, "Each subscription is cleaned up exactly once");
  document.body.removeChild(container);
}
