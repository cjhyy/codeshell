import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "./auth.js";
import {
  configurationErrorMessage,
  connectionDraft,
  filterSkills,
  readConfiguration,
  readSkill,
  saveConnection,
  saveDefaults,
  setSkillEnabled,
  deleteConnection,
  probeConnection,
  type HubConfiguration,
} from "./configuration.js";

const nativeFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = nativeFetch;
});

const snapshot: HubConfiguration = {
  workspace: {
    path: "/workspace",
    settingsScope: "local",
    skillDirectories: ["/workspace/.code-shell/skills"],
  },
  defaults: { text: "work", auxText: "quick" },
  connections: [
    {
      id: "work",
      catalogId: "openai",
      tag: "text",
      model: "configured-model",
      baseUrl: "https://example.test/v1",
      hasApiKey: true,
      needsKey: true,
    },
  ],
  catalog: [
    {
      id: "openai",
      displayName: "OpenAI-compatible",
      adapterKind: "openai",
      defaultBaseUrl: "https://example.test/v1",
      needsKey: true,
    },
  ],
  skills: [
    { name: "plugin:review", description: "Review code changes", source: "plugin", enabled: true },
  ],
  mcpServers: [],
  restartRequired: false,
};

describe("Hub configuration client boundary", () => {
  test("editing a model never manufactures or resends a masked existing secret", async () => {
    let body: Record<string, unknown> | undefined;
    let request: RequestInit | undefined;
    globalThis.fetch = (async (_path, init) => {
      request = init;
      body = JSON.parse(String(init?.body));
      return Response.json(snapshot);
    }) as typeof fetch;
    const draft = connectionDraft(snapshot.connections[0]);
    expect(draft.apiKey).toBe("");
    draft.model = "new-model";
    await saveConnection(draft);
    expect(body).toEqual({
      id: "work",
      catalogId: "openai",
      model: "new-model",
      baseUrl: "https://example.test/v1",
    });
    expect(request?.credentials).toBe("same-origin");
    expect(request?.cache).toBe("no-store");
    expect(request?.method).toBe("PUT");
  });

  test("sends only the explicitly entered replacement key and leaves the draft reusable after failure", async () => {
    const draft = { ...connectionDraft(snapshot.connections[0]), apiKey: " replacement-key " };
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_path, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ error: "请等待当前任务完成后再保存配置。" }, { status: 409 });
    }) as typeof fetch;
    await expect(saveConnection(draft)).rejects.toThrow("请等待当前任务完成");
    expect(body?.apiKey).toBe("replacement-key");
    expect(draft.apiKey).toBe(" replacement-key ");
    expect(draft.model).toBe("configured-model");
  });

  test("follow-main auxiliary selection explicitly clears the override", async () => {
    let body: unknown;
    globalThis.fetch = (async (path, init) => {
      expect(String(path)).toBe("/api/v1/configuration/defaults");
      body = JSON.parse(String(init?.body));
      return Response.json(snapshot);
    }) as typeof fetch;
    await saveDefaults({ text: "work", auxText: null });
    expect(body).toEqual({ text: "work", auxText: null });
  });

  test("skill controls use discovered names as data, never file paths", async () => {
    const requests: { url: string; body?: unknown }[] = [];
    globalThis.fetch = (async (path, init) => {
      requests.push({
        url: String(path),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return init?.method === "PUT"
        ? Response.json(snapshot)
        : Response.json({ name: "plugin:review & test", content: "# Instructions" });
    }) as typeof fetch;
    expect(await readSkill("plugin:review & test")).toBe("# Instructions");
    await setSkillEnabled("plugin:review & test", false);
    expect(requests).toEqual([
      { url: "/api/v1/configuration/skill?name=plugin%3Areview%20%26%20test", body: undefined },
      {
        url: "/api/v1/configuration/skills",
        body: { name: "plugin:review & test", enabled: false },
      },
    ]);
  });

  test("aborts stale reads and preserves 401 for the account gate", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async (_path, init) => {
      expect(init?.signal).toBe(controller.signal);
      return Response.json({ error: "Session revoked" }, { status: 401 });
    }) as typeof fetch;
    try {
      await readConfiguration(controller.signal);
      throw new Error("must reject");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ApiError);
      expect((cause as ApiError).status).toBe(401);
    }
  });

  test("does not treat HTML fallbacks or wrong skill responses as configuration", async () => {
    globalThis.fetch = (async () => new Response("<!doctype html>offline")) as typeof fetch;
    await expect(readConfiguration()).rejects.toThrow("无效的设置");
    globalThis.fetch = (async () =>
      Response.json({ name: "different", content: "text" })) as typeof fetch;
    await expect(readSkill("plugin:review")).rejects.toThrow("无效的 Skill");
  });

  test("skill search covers descriptions and names without changing server enable state", () => {
    expect(filterSkills(snapshot.skills, "  REVIEW ")).toEqual(snapshot.skills);
    expect(filterSkills(snapshot.skills, "changes")).toEqual(snapshot.skills);
    expect(filterSkills(snapshot.skills, "missing")).toEqual([]);
    expect(snapshot.skills[0]?.enabled).toBe(true);
  });

  test("explains key protection errors and retains actionable server errors", () => {
    expect(
      configurationErrorMessage(
        new ApiError("provide an API key when changing the endpoint origin", 400),
      ),
    ).toContain("请同时填写");
    expect(configurationErrorMessage(new ApiError("请等待当前任务完成后再保存配置。", 409))).toBe(
      "请等待当前任务完成后再保存配置。",
    );
  });

  test("deletes with an explicit replacement and probes only a saved connection ID", async () => {
    const requests: { path: string; method: string | undefined; body: unknown }[] = [];
    globalThis.fetch = (async (path, init) => {
      requests.push({
        path: String(path),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return String(path).endsWith("/probe")
        ? Response.json({
            ok: false,
            connectionId: "work",
            model: "configured-model",
            code: "unauthorized",
            message: "请检查 API Key。",
            latencyMs: 1,
            checkedAt: new Date().toISOString(),
            status: 401,
          })
        : Response.json(snapshot);
    }) as typeof fetch;
    await deleteConnection("work", "quick");
    expect((await probeConnection("work")).code).toBe("unauthorized");
    expect(requests).toEqual([
      {
        path: "/api/v1/configuration/connections",
        method: "DELETE",
        body: { id: "work", replacementText: "quick" },
      },
      {
        path: "/api/v1/configuration/connections/probe",
        method: "POST",
        body: { id: "work", requestId: expect.any(String) },
      },
    ]);
  });

  test("cancellation explicitly releases the matching server probe before the client settles", async () => {
    const controller = new AbortController();
    const requests: { path: string; body: any }[] = [];
    globalThis.fetch = (async (path, init) => {
      requests.push({ path: String(path), body: JSON.parse(String(init?.body)) });
      if (String(path).endsWith("/cancel")) return Response.json({ ok: true });
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        ),
      );
    }) as typeof fetch;
    const pending = probeConnection("work", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      path: "/api/v1/configuration/connections/probe/cancel",
      body: { requestId: requests[0]!.body.requestId },
    });
  });
});

test("connection writes carry the reviewed revision and new connections explicitly require an unused name", async () => {
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_path, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json(snapshot);
  }) as typeof fetch;
  const draft = connectionDraft({ ...snapshot.connections[0]!, revision: "opaque-review-token" });
  await saveConnection(draft);
  const fresh = connectionDraft();
  Object.assign(fresh, { id: "fresh", catalogId: "openai", model: "new-model" });
  await saveConnection(fresh);
  await deleteConnection("work", "quick", undefined, "opaque-review-token");
  expect(requests.map((item) => item.expectedRevision)).toEqual([
    "opaque-review-token",
    null,
    "opaque-review-token",
  ]);
  expect(draft.apiKey).toBe("");
});
