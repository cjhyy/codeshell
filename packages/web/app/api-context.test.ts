import { afterEach, expect, test } from "bun:test";
import { api, ensureDesktopHttpSession } from "./auth.js";
import { apiUrl, setApiWorkspace } from "./api-context.js";
import { workspaceFileUrl } from "./HubFiles.js";
import { sessionExportUrl } from "./HubSessions.js";
import { probeConnection } from "./configuration.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setApiWorkspace(undefined);
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
