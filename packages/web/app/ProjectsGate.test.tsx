import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { api } from "./auth.js";
import { getApiProject, setApiProject, setApiWorkspace } from "./api-context.js";
import { ProjectsGate, type RuntimeProject } from "./ProjectsGate.js";

type Element = React.ReactElement<Record<string, any>>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  return [node as Element, ...elements((node as Element).props.children)];
}
function text(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (React.isValidElement(node)) return text((node as Element).props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function button(tree: React.ReactNode, label: string, index = 0): Element {
  const found = elements(tree).filter((item) => item.type === "button" && text(item) === label)[
    index
  ];
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
async function action(run: () => unknown) {
  await act(async () => {
    run();
    await flushMicrotasks();
  });
}
async function click(element: Element) {
  expect(element.props.disabled).not.toBe(true);
  await action(() => element.props.onClick());
}
const projectA: RuntimeProject = {
  id: "12345678-1234-1234-1234-1234567890ab",
  name: "项目 A",
  status: "running",
  generation: 1,
  createdAt: 1000,
};
const projectB: RuntimeProject = {
  ...projectA,
  id: "12345678-1234-1234-1234-1234567890cd",
  name: "项目 B",
};
const originalFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  globalThis.fetch = originalFetch;
  setApiProject(null);
  setApiWorkspace(undefined);
});

async function fixture(
  options: {
    projects?: RuntimeProject[];
    search?: string;
    intercept?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;
    available?: boolean;
    strict?: boolean;
  } = {},
) {
  ensureMiniDom();
  const priorLocation = Object.getOwnPropertyDescriptor(window, "location");
  const priorHistory = Object.getOwnPropertyDescriptor(window, "history");
  let location = new URL(`http://localhost/${options.search ?? ""}`);
  Object.defineProperty(window, "location", { configurable: true, get: () => location });
  Object.defineProperty(window, "history", {
    configurable: true,
    value: {
      state: null,
      replaceState(_state: unknown, _unused: string, url: string | URL) {
        location = new URL(String(url), location);
      },
    },
  });
  cleanups.push(async () => {
    if (priorLocation) Object.defineProperty(window, "location", priorLocation);
    else delete (window as any).location;
    if (priorHistory) Object.defineProperty(window, "history", priorHistory);
    else delete (window as any).history;
  });
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  let projects = options.projects ?? [projectA, projectB];
  let failure: Response | undefined;
  globalThis.fetch = (async (url, init) => {
    const path = String(url);
    requests.push({ path, init });
    const intercepted = options.intercept?.(path, init);
    if (intercepted) return intercepted;
    if (path === "/api/v1/projects" && (!init?.method || init.method === "GET"))
      return (
        failure?.clone() ??
        Response.json({ runtime: "docker", available: options.available ?? true, projects })
      );
    if (path === "/api/v1/projects" && init?.method === "POST") {
      const created = {
        ...projectA,
        status: "stopped",
        name: JSON.parse(String(init.body)).name,
      } as RuntimeProject;
      projects = [created];
      return Response.json({ project: created });
    }
    const match = /^\/api\/v1\/projects\/([^/]+)\/(start|stop)$/.exec(path);
    if (match) {
      projects = projects.map((item) =>
        item.id === match[1]
          ? { ...item, status: match[2] === "start" ? "running" : "stopped" }
          : item,
      );
      return Response.json({ project: projects.find((item) => item.id === match[1]) });
    }
    return Response.json({});
  }) as typeof fetch;
  let tree!: React.ReactNode;
  let child:
    | {
        project: RuntimeProject | null;
        draft: string;
        setDraft: (value: string) => void;
        back?: () => void;
      }
    | undefined;
  let mounts = 0;
  let authLost = 0;
  function Workspace({ project, back }: { project: RuntimeProject | null; back?: () => void }) {
    const [draft, setDraft] = React.useState("");
    React.useLayoutEffect(() => {
      child = { project, draft, setDraft, back };
      return () => {
        child = undefined;
      };
    });
    React.useEffect(() => {
      mounts++;
      void api("/api/v1/configuration");
    }, []);
    return (
      <div>
        {project?.name ?? "legacy"}:{draft}
      </div>
    );
  }
  function Gate() {
    tree = ProjectsGate({
      onAuthLost: () => {
        authLost++;
      },
      children: (project, back) => <Workspace project={project} back={back} />,
    });
    return tree;
  }
  const root = createRoot(document.createElement("div"));
  let live = true;
  const unmount = async () => {
    if (live) {
      live = false;
      await action(() => root.unmount());
    }
  };
  cleanups.push(unmount);
  await action(() =>
    root.render(
      options.strict ? (
        <React.StrictMode>
          <Gate />
        </React.StrictMode>
      ) : (
        <Gate />
      ),
    ),
  );
  return {
    get tree() {
      return tree;
    },
    get child() {
      return child;
    },
    get mounts() {
      return mounts;
    },
    get url() {
      return location;
    },
    get authLost() {
      return authLost;
    },
    requests,
    unmount,
    setProjects(value: RuntimeProject[]) {
      projects = value;
    },
    setFailure(value?: Response) {
      failure = value;
    },
    async focus() {
      await action(() => window.dispatchEvent({ type: "focus" } as Event));
    },
  };
}

test("only 404 uses the single-project Hub; malformed success and errors stay gated", async () => {
  for (const response of [
    Response.json({ error: "offline" }, { status: 503 }),
    Response.json({ runtime: "docker", projects: [] }),
  ]) {
    const view = await fixture({ intercept: () => response.clone() });
    expect(view.child).toBeUndefined();
    expect(text(view.tree)).toMatch(/offline|无效的项目列表/);
    await view.unmount();
  }
  const legacy = await fixture({
    intercept: (path) =>
      path === "/api/v1/projects" ? Response.json({}, { status: 404 }) : undefined,
  });
  expect(legacy.child?.project).toBeNull();
  expect(getApiProject()).toBeNull();
  expect(legacy.requests.at(-1)?.path).toBe("/api/v1/configuration");
});

test("a running deep link opens only its project and preserves its session", async () => {
  const view = await fixture({ search: `?project=${projectB.id}&session=same-project-session` });
  expect(view.child?.project?.id).toBe(projectB.id);
  expect(view.url.searchParams.get("session")).toBe("same-project-session");
  expect(view.requests.map((item) => item.path)).toEqual([
    "/api/v1/projects",
    `/p/${projectB.id}/api/v1/configuration`,
  ]);
});

test("switching projects resets child drafts and scope, and returning removes project/session", async () => {
  const view = await fixture();
  await click(button(view.tree, "打开项目"));
  await action(() => view.child!.setDraft("A 的未发送内容"));
  expect(view.child?.draft).toBe("A 的未发送内容");
  await action(() => view.child!.back!());
  expect(view.url.searchParams.has("project")).toBe(false);
  expect(view.url.searchParams.has("session")).toBe(false);
  expect(getApiProject()).toBeNull();
  await click(button(view.tree, "打开项目", 1));
  expect(view.child?.project?.id).toBe(projectB.id);
  expect(view.child?.draft).toBe("");
  expect(view.mounts).toBe(2);
  expect(view.requests.at(-1)?.path).toBe(`/p/${projectB.id}/api/v1/configuration`);
});

test("stopped projects require a start response confirming running", async () => {
  const view = await fixture({
    projects: [{ ...projectA, status: "stopped" }],
    search: `?project=${projectA.id}&session=old`,
  });
  expect(view.child).toBeUndefined();
  await click(button(view.tree, "启动并打开"));
  expect(view.requests.find((item) => item.init?.method === "POST")?.path).toBe(
    `/api/v1/projects/${projectA.id}/start`,
  );
  expect(view.child?.project?.status).toBe("running");
  expect(view.url.searchParams.has("session")).toBe(false);
});

test("create sends a trimmed name and leaves the new project stopped", async () => {
  const view = await fixture({ projects: [] });
  const input = elements(view.tree).find((item) => item.type === "input")!;
  await action(() => input.props.onChange({ target: { value: "  新项目  " } }));
  await action(() =>
    elements(view.tree)
      .find((item) => item.type === "form")!
      .props.onSubmit({ preventDefault() {} }),
  );
  const write = view.requests.find((item) => item.init?.method === "POST")!;
  expect(JSON.parse(String(write.init?.body))).toEqual({ name: "新项目" });
  expect(text(view.tree)).toContain("新项目");
  expect(text(view.tree)).toContain("已停止");
  expect(view.child).toBeUndefined();
});

test("stopping requires an explicit confirmation before the lifecycle request", async () => {
  const view = await fixture();
  await click(button(view.tree, "停止项目"));
  expect(view.requests.some((item) => item.init?.method === "POST")).toBe(false);
  await click(button(view.tree, "确认停止"));
  expect(view.requests.find((item) => item.init?.method === "POST")?.path).toBe(
    `/api/v1/projects/${projectA.id}/stop`,
  );
  expect(text(view.tree)).toContain("已停止");
});

test("unavailable and stopping projects stay gated with an explicit status", async () => {
  const view = await fixture({ projects: [{ ...projectA, status: "stopping" }], available: false });
  expect(text(view.tree)).toContain("正在停止");
  expect(text(view.tree)).toContain("运行环境暂不可用");
  expect(button(view.tree, "正在处理…").props.disabled).toBe(true);
  expect(view.child).toBeUndefined();
});

test("transient polling errors preserve an active draft; generation changes remount the project", async () => {
  const view = await fixture({ search: `?project=${projectA.id}` });
  await action(() => view.child!.setDraft("保留我"));
  view.setFailure(Response.json({ error: "network interrupted" }, { status: 503 }));
  await view.focus();
  expect(view.child?.draft).toBe("保留我");
  expect(view.mounts).toBe(1);
  view.setFailure();
  view.setProjects([{ ...projectA, generation: 2 }]);
  await view.focus();
  expect(view.child).toBeUndefined();
  expect(text(view.tree)).toContain("运行状态已经变化");
  await click(button(view.tree, "打开项目"));
  expect(view.child?.draft).toBe("");
  expect(view.child?.project?.generation).toBe(2);
});

test("unknown deep links never send runtime requests, and auth rejection invokes the gate", async () => {
  const unknown = await fixture({ search: "?project=../../escape&session=wrong" });
  expect(unknown.child).toBeUndefined();
  expect(unknown.requests).toHaveLength(1);
  expect(unknown.url.searchParams.has("session")).toBe(false);
  await unknown.unmount();
  const denied = await fixture({
    intercept: () => Response.json({ error: "logged out" }, { status: 401 }),
  });
  expect(denied.authLost).toBe(1);
  expect(denied.child).toBeUndefined();
});

test("StrictMode retries the initial check without losing the selected project scope", async () => {
  const view = await fixture({ strict: true, search: `?project=${projectA.id}` });
  expect(view.child?.project?.id).toBe(projectA.id);
  expect(getApiProject()).toBe(projectA.id);
  const runtimeRequests = view.requests.filter((item) => item.path !== "/api/v1/projects");
  expect(runtimeRequests.length).toBeGreaterThan(0);
  for (const request of runtimeRequests)
    expect(request.path).toBe(`/p/${projectA.id}/api/v1/configuration`);
});

test("a late start response cannot reopen its project after the gate unmounts", async () => {
  let finish!: (value: Response) => void;
  let signal: AbortSignal | null | undefined;
  const view = await fixture({
    projects: [{ ...projectA, status: "stopped" }],
    intercept(path, init) {
      if (path.endsWith("/start")) {
        signal = init?.signal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
    },
  });
  await click(button(view.tree, "启动并打开"));
  await view.unmount();
  setApiProject(projectB.id);
  await action(() => finish(Response.json({ project: projectA })));
  expect(signal?.aborted).toBe(true);
  expect(view.child).toBeUndefined();
  expect(getApiProject()).toBe(projectB.id);
});
