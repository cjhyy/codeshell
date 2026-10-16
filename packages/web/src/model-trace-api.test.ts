import { expect, test } from "bun:test";
import { createRemoteModelTraceApi } from "./model-trace-api.js";

test("remote trace API uses the supplied authenticated requester and encodes filters without choosing a Host scope", async () => {
  const requests: string[] = [];
  const api = createRemoteModelTraceApi({
    request: async (path) => {
      requests.push(path);
      return path.endsWith("/config") ? { enabled: true } : { items: [], total: 0 };
    },
  });
  await api.list({ search: "hello & 世界", sessionId: "session-1", limit: 50 });
  const url = new URL(requests[0]!, "https://fixture.test");
  expect(url.pathname).toBe("/api/v1/model-traces");
  expect(url.searchParams.get("search")).toBe("hello & 世界");
  expect(url.searchParams.get("sessionId")).toBe("session-1");
  expect(url.searchParams.get("limit")).toBe("50");
  await api.get("record-1");
  await api.getConfig();
  expect(requests.slice(1)).toEqual([
    "/api/v1/model-traces/record-1",
    "/api/v1/model-traces/config",
  ]);
  await expect(api.list({ workspacePath: "/foreign" } as any)).rejects.toThrow(
    "scope belongs to the Host",
  );
  await expect(api.get("../secret")).rejects.toThrow("Invalid model trace id");
  expect("setConfig" in api).toBe(false);
});

test("a missing or inaccessible record returns null, while authentication and transport failures remain visible", async () => {
  const missing = createRemoteModelTraceApi({
    request: async () => {
      throw Object.assign(new Error("missing"), { status: 404 });
    },
  });
  expect(await missing.get("missing")).toBeNull();
  const revoked = createRemoteModelTraceApi({
    request: async () => {
      throw Object.assign(new Error("revoked"), { status: 401 });
    },
  });
  await expect(revoked.get("record")).rejects.toThrow("revoked");
});
