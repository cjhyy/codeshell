// Separate processes preserve Radix's real browser initialization without
// inheriting UI-module mocks or portal state from other renderer suites.
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type {
  CloudAccountApi,
  CloudAccountLogin,
  CloudAccountStatus,
} from "../../shared/cloud-account.js";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
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
      registrationAllowed: !["registration-unavailable", "github-registration-closed"].includes(
        scenario,
      ),
      githubEnabled: !["github-unavailable", "link-unavailable"].includes(scenario),
      ...(scenario === "github-connect-legacy"
        ? {}
        : { githubLinkEnabled: scenario !== "github-connect-unavailable" }),
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
        "github-connect-default",
        "github-connect-failed",
        "github-connect-skipped",
        "github-connect-late-status",
        "github-connect-late-failure",
      ].includes(scenario)
    ) {
      emit({ ...signedIn("github-user"), githubConnection: { state: "pending" } });
    } else if (
      ["github-connect-optout", "github-connect-unavailable", "github-connect-legacy"].includes(
        scenario,
      )
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
  logout: async () => emit({ state: "signed-out" }),
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
  value: { cloudAccount: api },
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
const open = async () => {
  trigger().focus();
  await click(trigger());
  assert.ok(dialog(), "The real dialog opens from the account button");
  assert.equal(props(trigger())["aria-expanded"], true);
  assert.ok(text(dialog()!).includes("账号管理"));
};
const close = async () => {
  await click(button("Close"));
  await settle(() => {});
  assert.equal(dialog(), undefined, "Closing removes account management");
  assert.equal(props(trigger())["aria-expanded"], false);
};
const assertSignedOut = () => {
  assert.equal(props(trigger())["aria-label"], "登录账号");
  assert.ok(text(trigger()).includes("本地模式 · 未登录"));
};
const assertSignedIn = (username: string) => {
  assert.equal(props(trigger())["aria-label"], `账号管理: ${username}`);
  assert.ok(text(trigger()).includes(username));
  assert.ok(text(trigger()).includes("CodeShell 云账号"));
  assert.ok(!text(trigger()).includes("暂时无法读取账号状态"));
  if (dialog()) {
    assert.ok(text(dialog()!).includes(username));
    assert.ok(text(dialog()!).includes("云账号已登录"));
    button("退出云账号");
  }
};

try {
  await settle(() => root.render(<AccountSidebarEntry />));
  assert.equal(listeners.size, 1, "The footer listens even before management opens");

  if (scenario === "authentication") {
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
    assert.ok(text(trigger()).includes("正在登录…"));
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
    assert.ok(text(trigger()).includes("暂时无法读取账号状态"));
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
    assert.equal(props(input("同时连接 GitHub")).checked, true);
    assert.equal(props(input("同时连接 GitHub")).disabled, false);
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
    ["github-connect-default", "github-connect-failed", "github-connect-skipped"].includes(scenario)
  ) {
    await open();
    await settleCapabilities();
    assert.equal(props(input("同时连接 GitHub")).checked, true, "GitHub connection defaults on");
    assert.equal(props(input("同时连接 GitHub")).disabled, false);
    assert.ok(text(dialog()!).includes("公开和私有仓库读写权限（repo）"));
    assert.ok(text(dialog()!).includes("选择要使用的仓库和 Actions 权限"));
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
      assert.ok(text(dialog()!).includes("云账号已登录，尚未连接 GitHub。"));
      assert.ok(!text(dialog()!).includes("GitHub 已连接。"));
    }
  } else if (scenario === "github-connect-optout") {
    await open();
    await settleCapabilities();
    await check(input("同时连接 GitHub"), false);
    assert.equal(props(input("同时连接 GitHub")).checked, false);
    await click(button("使用 GitHub 登录"));
    assert.equal(githubRequests[0]?.connectGitHub, false);
    assertSignedIn("github-user");
    assert.ok(text(dialog()!).includes("云账号已登录，尚未连接 GitHub。"));
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
