import { afterEach, expect, test } from "bun:test";
import { api, ensureDesktopHttpSession, uploadFile } from "./auth.js";
import { apiUrl, captureApiScope, setApiProject, setApiWorkspace } from "./api-context.js";
import { defaultWsUrl } from "./protocol.js";
import { workspaceFileUrl } from "./HubFiles.js";
import { sessionExportUrl } from "./HubSessions.js";
import { probeConnection } from "./configuration.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setApiWorkspace(undefined);
  setApiProject(null);
});

const projectA = "12345678-1234-1234-1234-1234567890ab";
const projectB = "12345678-1234-1234-1234-1234567890cd";

test("project API scoping is idempotent and keeps account/lifecycle requests at the root", async () => {
  setApiProject(projectA);
  setApiWorkspace("/project/a");
  const captured = apiUrl("/api/v1/files?path=hello");
  setApiProject(projectB);
  setApiWorkspace("/project/b");
  expect(apiUrl(captured)).toBe(captured);
  expect(captured).toBe(`/p/${projectA}/api/v1/files?path=hello&workspace=%2Fproject%2Fa`);
  expect(apiUrl("/api/v1/auth/status")).toBe("/api/v1/auth/status");
  expect(apiUrl(`/p/${projectA}/api/v1/projects`)).toBe("/api/v1/projects");
  expect(apiUrl("/api/v1/desktop/session")).toBe("/api/v1/desktop/session");
  const requests: Array<{ path: string; headers: Headers }> = [];
  globalThis.fetch = (async (path, init) => {
    requests.push({ path: String(path), headers: new Headers(init?.headers) });
    return Response.json({});
  }) as typeof fetch;
  await api(captured);
  await api(`/p/${projectA}/api/v1/configuration`);
  await api("/api/v1/auth/status");
  await api("/api/v1/projects");
  await api("/api/v1/configuration");
  expect(requests.map((item) => item.path)).toEqual([
    captured,
    `/p/${projectA}/api/v1/configuration`,
    "/api/v1/auth/status",
    "/api/v1/projects",
    `/p/${projectB}/api/v1/configuration`,
  ]);
  for (const item of requests.slice(0, 4))
    expect(item.headers.has("X-CodeShell-Workspace")).toBe(false);
  expect(decodeURIComponent(requests[4].headers.get("X-CodeShell-Workspace")!)).toBe("/project/b");
});

test("project paths reject nonlocal URLs, traversal and invalid identifiers", () => {
  for (const path of [
    "https://attacker.invalid/api/v1/foo",
    "//attacker.invalid/api/v1/foo",
    "/api/v1/../auth",
    "/api/v1/%2e%2e/auth",
    "/api/v1/foo\\bar",
    "/p/invalid/api/v1/foo",
  ])
    expect(() => apiUrl(path)).toThrow("local API");
  expect(() => setApiProject("../../auth")).toThrow("项目标识无效");
});

test("model probe cancellation and upload scope remain in the original project", async () => {
  setApiProject(projectA);
  const captured = captureApiScope();
  const abort = new AbortController();
  const seen: string[] = [];
  globalThis.fetch = (async (url) => {
    seen.push(String(url));
    if (seen.length === 1) {
      setApiProject(projectB);
      setApiWorkspace("/project/b");
      abort.abort();
      throw new DOMException("cancelled", "AbortError");
    }
    return Response.json({ cancelled: true });
  }) as typeof fetch;
  await expect(probeConnection("model", abort.signal)).rejects.toThrow("cancelled");
  await uploadFile(new File(["synthetic"], "fixture.txt"), { scope: captured });
  expect(seen).toHaveLength(3);
  for (const path of seen) expect(path).toStartWith(`/p/${projectA}/api/v1/`);
});

test("the shared protocol scopes WebSockets while preserving root legacy connections", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "https:", host: "example.test:443" },
  });
  try {
    setApiProject(projectA);
    expect(defaultWsUrl()).toBe(`wss://example.test:443/p/${projectA}/ws`);
    setApiProject(null);
    expect(defaultWsUrl()).toBe("wss://example.test:443/ws");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "location", descriptor);
    else delete (globalThis as any).location;
  }
});

test("workspace headers encode Unicode while download links preserve exact paths", async () => {
  const cwd = "/projects/演示 %20#?";
  setApiWorkspace(cwd);
  let headers: Headers | undefined;
  globalThis.fetch = (async (_url, init) => {
    headers = new Headers(init?.headers);
    return Response.json({});
  }) as typeof fetch;
  await api("/api/v1/configuration");
  expect(decodeURIComponent(headers!.get("X-CodeShell-Workspace")!)).toBe(cwd);
  const url = new URL(workspaceFileUrl("报告 %20#?.txt"), "http://localhost");
  expect(url.searchParams.get("workspace")).toBe(cwd);
  expect(url.searchParams.get("path")).toBe("报告 %20#?.txt");
  expect(
    new URL(sessionExportUrl("session"), "http://localhost").searchParams.get("workspace"),
  ).toBe(cwd);
  expect(() => apiUrl("https://other.example/secret")).toThrow("local API");
});

test("a pending model probe cancels the original workspace after navigation", async () => {
  setApiWorkspace("/project/a");
  const abort = new AbortController();
  const seen: string[] = [];
  globalThis.fetch = (async (url) => {
    seen.push(String(url));
    if (seen.length === 1) {
      setApiWorkspace("/project/b");
      abort.abort();
      throw new DOMException("cancelled", "AbortError");
    }
    return Response.json({ cancelled: true });
  }) as typeof fetch;
  await expect(probeConnection("test-model", abort.signal)).rejects.toThrow("cancelled");
  expect(seen).toHaveLength(2);
  for (const url of seen)
    expect(new URL(url, "http://localhost").searchParams.get("workspace")).toBe("/project/a");
});

test("Desktop cookie exchange uses the paired credential exactly without hashing or storing it", async () => {
  let input: unknown;
  globalThis.fetch = (async (_url, init) => {
    input = JSON.parse(String(init?.body));
    return Response.json({
      authenticated: true,
      session: { id: "cookie-owner", username: "Desktop", deviceName: "phone" },
    });
  }) as typeof fetch;
  await expect(
    ensureDesktopHttpSession({ deviceId: "paired-device", secretHash: "synthetic-opaque-secret" }),
  ).resolves.toMatchObject({ id: "cookie-owner" });
  expect(input).toEqual({ deviceId: "paired-device", secretHash: "synthetic-opaque-secret" });
});
