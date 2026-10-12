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
let current: CloudAccountStatus = { state: "signed-out" };
let subscriptions = 0;
let unsubscriptions = 0;
let githubOrigin = "";
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
      registrationAllowed: scenario !== "registration-unavailable",
      githubEnabled: !["github-unavailable", "link-unavailable"].includes(scenario),
    });
  },
  status: () => {
    if (["late-response", "late-failure", "cleanup"].includes(scenario)) {
      const request = deferred();
      requests.push(request);
      return request.promise;
    }
    if (scenario === "unavailable") return Promise.reject(new Error("IPC unavailable"));
    return Promise.resolve(current);
  },
  login: (input) => authenticate("login", input),
  register: (input) => authenticate("register", input),
  signInWithGitHub: async ({ origin }) => {
    githubOrigin = origin;
    emit({ state: "signing-in" });
    return current;
  },
  linkGitHub: async () => current,
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
    props(node).onClick({ defaultPrevented: false, preventDefault() {}, currentTarget: node });
  });
const change = (node: Element, value: string) =>
  settle(() => props(node).onChange({ target: { value } }));
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
    assert.equal(props(button("注册")).disabled, true);
    assert.equal(props(button("使用 GitHub 登录")).disabled, true);
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
    await change(input("账号名称"), "new-user");
    await change(input("密码（至少 12 位）"), "registration-password");
    await settleCapabilities();
    await click(button("注册"));
    assertSignedIn("new-user");
    assert.equal(credentials[1]?.action, "register");
    await close();
    assert.equal(listeners.size, 1, "Closing the form preserves the footer subscription");
    assertSignedIn("new-user");
    await open();
    assertSignedIn("new-user");
  } else if (scenario === "github") {
    await open();
    await change(input("云服务地址"), " https://accounts.example.test/ ");
    await settleCapabilities();
    await click(button("使用 GitHub 登录"));
    assert.equal(githubOrigin, "https://accounts.example.test");
    assert.ok(text(trigger()).includes("正在登录…"));
    assert.equal(props(button("使用 GitHub 登录")).disabled, true);
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
    button("注册");
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
    assert.equal(props(button("关联 GitHub")).disabled, true);
    await settleCapabilities();
    assert.equal(props(button("关联 GitHub")).disabled, true);
    assert.ok(text(dialog()!).includes("此云服务尚未配置 GitHub 登录，请使用账号密码。"));
  } else if (scenario === "capabilities-stale") {
    await open();
    await settleCapabilities();
    assert.equal(capabilityRequests.length, 1);
    await settle(() =>
      capabilityRequests[0]!.request.resolve({ registrationAllowed: true, githubEnabled: true }),
    );
    assert.equal(props(button("使用 GitHub 登录")).disabled, false);
    await change(input("云服务地址"), "https://old.example.test");
    assert.equal(
      props(button("使用 GitHub 登录")).disabled,
      true,
      "Editing the origin immediately invalidates the previous discovery",
    );
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
      capabilityRequests[1]!.request.resolve({ registrationAllowed: true, githubEnabled: true }),
    );
    assert.equal(
      props(button("使用 GitHub 登录")).disabled,
      true,
      "A late response from the old origin cannot enable GitHub for the new origin",
    );
    assert.ok(text(dialog()!).includes("此云服务尚未配置 GitHub 登录，请使用账号密码。"));
    assert.ok(text(dialog()!).includes("此云服务暂未开放注册。"));
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
    assert.equal(props(button("注册")).disabled, false);
    assert.ok(!text(dialog()!).includes("无法检查云服务的登录方式"));
  } else if (scenario === "registration-unavailable") {
    await open();
    await settleCapabilities();
    await change(input("账号名称"), "existing-user");
    await change(input("密码（至少 12 位）"), "existing-user-password");
    assert.equal(props(button("注册")).disabled, true);
    assert.ok(text(dialog()!).includes("此云服务暂未开放注册。"));
    assert.equal(props(button("登录")).disabled, false);
    await click(button("登录"));
    assertSignedIn("existing-user");
    assert.equal(credentials[0]?.action, "login");
  } else {
    assert.fail(`Unknown fixture scenario: ${scenario}`);
  }
} finally {
  if (mounted) await settle(() => root.unmount());
  assert.equal(listeners.size, 0, "Account listeners are released on unmount");
  assert.equal(subscriptions, unsubscriptions, "Each subscription is cleaned up exactly once");
  document.body.removeChild(container);
}
