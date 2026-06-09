# fal.ai 视频 Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `GenerateVideo` 工具接入 fal.ai 视频 provider,支持文生视频与图生视频,跑通主链路。

**Architecture:** 新增 `FalVideoProvider`(`kind:"fal"`)作为纯适配器,实现 `VideoProvider` 三段式(submit/poll/download)对接 fal queue API;轮询/超时/下载/通知复用现有 `pollToCompletion`。`resolveVideoProvider` 扩展为读取 `videoGen.providers[]` 并注册 `"fal"` kind。`fetch` 注入便于 mock 测试。

**Tech Stack:** TypeScript, bun:test, fal.ai queue REST API (`https://queue.fal.run`)。

**约束:** subagent **不动 git**(用户记忆约定:此仓库 subagent 别 commit/push)。测试用注入 mock fetch,不打真实网络。bun test 必须带 `src/` 路径,避免命中 dist 旧测试。

---

## 关键背景(实现者必读)

现有契约(`packages/core/src/tool-system/builtin/video-providers.ts`):

```typescript
export interface VideoProviderCreds { baseUrl: string; apiKey: string; }
export interface VideoSubmitRequest {
  prompt: string; model: string; creds: VideoProviderCreds; signal?: AbortSignal;
}
export type VideoSubmitResult = { ok: true; jobId: string } | { ok: false; error: string };
export type VideoPollResult =
  | { ok: true; status: "running" } | { ok: true; status: "succeeded" }
  | { ok: true; status: "failed"; error: string } | { ok: false; error: string };
export type VideoDownloadResult =
  | { ok: true; bytes: Uint8Array; ext: string } | { ok: false; error: string };
export interface VideoProvider {
  readonly kind: string;
  submit(req: VideoSubmitRequest): Promise<VideoSubmitResult>;
  poll(req: { jobId: string; creds: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoPollResult>;
  download(req: { jobId: string; creds: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoDownloadResult>;
}
```

fal queue API:
- 提交: `POST {baseUrl}/{model}`,header `Authorization: Key {apiKey}`,body `{prompt}` 或 `{prompt, image_url}`,返回 `{ request_id, ... }`
- 状态: `GET {baseUrl}/{model}/requests/{request_id}/status` → `{ status: "IN_QUEUE"|"IN_PROGRESS"|"COMPLETED", ... }`
- 结果: `GET {baseUrl}/{model}/requests/{request_id}/` → `{ video: { url }, ... }`
- 下载: `GET {video.url}` → 视频字节

**jobId 编码 = `"{model}::{request_id}"`**(poll/download 拆开自拼 URL,因为接口不传 model)。

---

## Task 1: FalVideoProvider.submit(文生视频)

**Files:**
- Modify: `packages/core/src/tool-system/builtin/video-providers.ts`(接口加 `image?` 字段;新增 `FalVideoProvider` 类的 submit)
- Test: `packages/core/src/tool-system/builtin/video-providers.test.ts`

- [ ] **Step 1: 给 VideoSubmitRequest 加可选 image 字段**

在 `video-providers.ts` 的 `VideoSubmitRequest` 接口里加一行:

```typescript
export interface VideoSubmitRequest {
  prompt: string;
  model: string;
  creds: VideoProviderCreds;
  /** Optional image URL (http/https). When present, triggers image-to-video. */
  image?: string;
  signal?: AbortSignal;
}
```

- [ ] **Step 2: 写 submit 的失败测试(文生)**

在 `video-providers.test.ts` 末尾加:

```typescript
import { FalVideoProvider } from "./video-providers.js";

describe("FalVideoProvider", () => {
  const creds = { baseUrl: "https://queue.fal.run", apiKey: "k-123" };

  test("submit (text-to-video): POST {baseUrl}/{model} with prompt, returns jobId=model::request_id", async () => {
    const calls: Array<{ url: string; body: any; headers: any }> = [];
    const fakeFetch: typeof fetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ request_id: "req-1" }) } as Response;
    }) as unknown as typeof fetch;

    const p = new FalVideoProvider(fakeFetch);
    const model = "fal-ai/kling-video/v3/pro/text-to-video";
    const res = await p.submit({ prompt: "a wave", model, creds });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.jobId).toBe(`${model}::req-1`);
    expect(calls[0].url).toBe(`https://queue.fal.run/${model}`);
    expect(calls[0].headers.Authorization).toBe("Key k-123");
    expect(calls[0].body).toEqual({ prompt: "a wave" });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/video-providers.test.ts`
Expected: FAIL — `FalVideoProvider is not a constructor` / not exported.

- [ ] **Step 4: 实现 FalVideoProvider 类骨架 + submit**

在 `video-providers.ts` 的 `FakeVideoProvider` 类之后、`DEFAULT_VIDEO_MODEL` 之前插入:

```typescript
/**
 * fal.ai video adapter — submit/poll/download against the fal queue API
 * (https://queue.fal.run). model id selects the underlying model
 * (e.g. fal-ai/kling-video/v3/pro/text-to-video). When `image` is present we
 * switch a `...text-to-video` model to `...image-to-video` and send image_url,
 * so callers only need to pass an image to get i2v. jobId encodes
 * `${model}::${request_id}` since poll/download need the model to build URLs.
 */
export class FalVideoProvider implements VideoProvider {
  readonly kind = "fal";
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private resolveModel(model: string, image?: string): string {
    if (image && /text-to-video$/.test(model)) {
      return model.replace(/text-to-video$/, "image-to-video");
    }
    return model;
  }

  async submit(req: VideoSubmitRequest): Promise<VideoSubmitResult> {
    const base = req.creds.baseUrl.replace(/\/+$/, "");
    const model = this.resolveModel(req.model, req.image);
    const body: Record<string, unknown> = { prompt: req.prompt };
    if (req.image) body.image_url = req.image;
    try {
      const r = await this.fetchImpl(`${base}/${model}`, {
        method: "POST",
        headers: { Authorization: `Key ${req.creds.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return { ok: false, error: `fal submit failed: HTTP ${r.status} ${t}`.trim() };
      }
      const j = (await r.json()) as { request_id?: string };
      if (!j.request_id) return { ok: false, error: "fal submit: no request_id in response" };
      return { ok: true, jobId: `${model}::${j.request_id}` };
    } catch (err) {
      return { ok: false, error: `fal submit error: ${(err as Error).message}` };
    }
  }

  async poll(_req: { jobId: string; creds: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoPollResult> {
    return { ok: false, error: "not implemented" };
  }

  async download(_req: { jobId: string; creds: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoDownloadResult> {
    return { ok: false, error: "not implemented" };
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/video-providers.test.ts`
Expected: PASS(submit 文生用例绿;poll/download 用例尚未写)。

---

## Task 2: submit 图生视频 + 错误路径

**Files:**
- Test: `packages/core/src/tool-system/builtin/video-providers.test.ts`

- [ ] **Step 1: 写图生 + 错误测试**

在 `describe("FalVideoProvider")` 内追加:

```typescript
  test("submit (image-to-video): image switches t2v model to i2v and sends image_url", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fakeFetch: typeof fetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ request_id: "req-2" }) } as Response;
    }) as unknown as typeof fetch;

    const p = new FalVideoProvider(fakeFetch);
    const res = await p.submit({
      prompt: "zoom in",
      model: "fal-ai/kling-video/v3/pro/text-to-video",
      image: "https://example.com/a.png",
      creds,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.jobId).toBe("fal-ai/kling-video/v3/pro/image-to-video::req-2");
    expect(calls[0].url).toBe("https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video");
    expect(calls[0].body).toEqual({ prompt: "zoom in", image_url: "https://example.com/a.png" });
  });

  test("submit non-OK → ok:false with status", async () => {
    const fakeFetch: typeof fetch = (async () =>
      ({ ok: false, status: 401, text: async () => "bad key" } as Response)) as unknown as typeof fetch;
    const p = new FalVideoProvider(fakeFetch);
    const res = await p.submit({ prompt: "p", model: "m", creds });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("401");
  });
```

- [ ] **Step 2: 运行测试**

Run: `cd packages/core && bun test src/tool-system/builtin/video-providers.test.ts`
Expected: PASS(submit 逻辑在 Task 1 已实现,这两条直接绿)。

- [ ] **Step 3: Commit** —— 跳过(subagent 不动 git;由主代理统一提交)。

---

## Task 3: FalVideoProvider.poll

**Files:**
- Modify: `packages/core/src/tool-system/builtin/video-providers.ts`(poll 实现)
- Test: `packages/core/src/tool-system/builtin/video-providers.test.ts`

- [ ] **Step 1: 写 poll 测试(三种状态映射)**

追加:

```typescript
  test("poll maps fal status: IN_QUEUE/IN_PROGRESS→running, COMPLETED→succeeded", async () => {
    const seq = ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"];
    let i = 0;
    const urls: string[] = [];
    const fakeFetch: typeof fetch = (async (url: string) => {
      urls.push(url);
      const status = seq[i++];
      return { ok: true, status: 200, json: async () => ({ status }) } as Response;
    }) as unknown as typeof fetch;
    const p = new FalVideoProvider(fakeFetch);
    const jobId = "fal-ai/kling-video/v3/pro/text-to-video::req-1";

    const r1 = await p.poll({ jobId, creds });
    expect(r1.ok && r1.status).toBe("running");
    const r2 = await p.poll({ jobId, creds });
    expect(r2.ok && r2.status).toBe("running");
    const r3 = await p.poll({ jobId, creds });
    expect(r3.ok && r3.status).toBe("succeeded");
    expect(urls[0]).toBe(
      "https://queue.fal.run/fal-ai/kling-video/v3/pro/text-to-video/requests/req-1/status",
    );
  });

  test("poll network error → ok:false", async () => {
    const fakeFetch: typeof fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const p = new FalVideoProvider(fakeFetch);
    const r = await p.poll({ jobId: "m::r", creds });
    expect(r.ok).toBe(false);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/video-providers.test.ts`
Expected: FAIL(poll 返回 "not implemented")。

- [ ] **Step 3: 实现 poll + jobId 拆分助手**

在 `FalVideoProvider` 类内,替换 poll 占位实现,并加一个私有拆分方法:

```typescript
  private split(jobId: string): { model: string; requestId: string } {
    const idx = jobId.indexOf("::");
    if (idx < 0) return { model: jobId, requestId: "" };
    return { model: jobId.slice(0, idx), requestId: jobId.slice(idx + 2) };
  }

  async poll(req: { jobId: string; creds: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoPollResult> {
    const base = req.creds.baseUrl.replace(/\/+$/, "");
    const { model, requestId } = this.split(req.jobId);
    try {
      const r = await this.fetchImpl(`${base}/${model}/requests/${requestId}/status`, {
        method: "GET",
        headers: { Authorization: `Key ${req.creds.apiKey}` },
        signal: req.signal,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return { ok: false, error: `fal status failed: HTTP ${r.status} ${t}`.trim() };
      }
      const j = (await r.json()) as { status?: string; error?: unknown };
      switch (j.status) {
        case "IN_QUEUE":
        case "IN_PROGRESS":
          return { ok: true, status: "running" };
        case "COMPLETED":
          return { ok: true, status: "succeeded" };
        default:
          return { ok: true, status: "failed", error: `fal status: ${j.status ?? "unknown"}` };
      }
    } catch (err) {
      return { ok: false, error: `fal poll error: ${(err as Error).message}` };
    }
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/video-providers.test.ts`
Expected: PASS。

---

## Task 4: FalVideoProvider.download(两跳)

**Files:**
- Modify: `packages/core/src/tool-system/builtin/video-providers.ts`(download 实现)
- Test: `packages/core/src/tool-system/builtin/video-providers.test.ts`

- [ ] **Step 1: 写 download 测试(两跳 + ext 推断 + 缺 url)**

追加:

```typescript
  test("download: hop1 result JSON → video.url, hop2 fetch bytes, ext from url", async () => {
    const urls: string[] = [];
    const fakeFetch: typeof fetch = (async (url: string) => {
      urls.push(url);
      if (url.endsWith("/requests/req-1/")) {
        return { ok: true, status: 200, json: async () => ({ video: { url: "https://cdn.fal/v/out.mp4" } }) } as Response;
      }
      // hop2: video bytes
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("VIDEOBYTES").buffer } as Response;
    }) as unknown as typeof fetch;
    const p = new FalVideoProvider(fakeFetch);
    const jobId = "fal-ai/kling-video/v3/pro/text-to-video::req-1";
    const dl = await p.download({ jobId, creds });
    expect(dl.ok).toBe(true);
    if (dl.ok) {
      expect(Buffer.from(dl.bytes).toString()).toBe("VIDEOBYTES");
      expect(dl.ext).toBe("mp4");
    }
    expect(urls[0]).toBe("https://queue.fal.run/fal-ai/kling-video/v3/pro/text-to-video/requests/req-1/");
    expect(urls[1]).toBe("https://cdn.fal/v/out.mp4");
  });

  test("download: missing video.url → ok:false", async () => {
    const fakeFetch: typeof fetch = (async () =>
      ({ ok: true, status: 200, json: async () => ({ video: {} }) } as Response)) as unknown as typeof fetch;
    const p = new FalVideoProvider(fakeFetch);
    const dl = await p.download({ jobId: "m::r", creds });
    expect(dl.ok).toBe(false);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/video-providers.test.ts`
Expected: FAIL(download 返回 "not implemented")。

- [ ] **Step 3: 实现 download**

替换 download 占位:

```typescript
  async download(req: { jobId: string; creds: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoDownloadResult> {
    const base = req.creds.baseUrl.replace(/\/+$/, "");
    const { model, requestId } = this.split(req.jobId);
    try {
      // hop 1: result JSON
      const r = await this.fetchImpl(`${base}/${model}/requests/${requestId}/`, {
        method: "GET",
        headers: { Authorization: `Key ${req.creds.apiKey}` },
        signal: req.signal,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return { ok: false, error: `fal result failed: HTTP ${r.status} ${t}`.trim() };
      }
      const j = (await r.json()) as { video?: { url?: string } };
      const videoUrl = j.video?.url;
      if (!videoUrl) return { ok: false, error: "fal result: no video.url" };

      // hop 2: video bytes
      const vr = await this.fetchImpl(videoUrl, { method: "GET", signal: req.signal });
      if (!vr.ok) {
        return { ok: false, error: `fal video download failed: HTTP ${vr.status}` };
      }
      const buf = new Uint8Array(await vr.arrayBuffer());
      const m = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(videoUrl);
      const ext = m ? m[1].toLowerCase() : "mp4";
      return { ok: true, bytes: buf, ext };
    } catch (err) {
      return { ok: false, error: `fal download error: ${(err as Error).message}` };
    }
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/video-providers.test.ts`
Expected: PASS。

---

## Task 5: 注册 "fal" + 默认模型

**Files:**
- Modify: `packages/core/src/tool-system/builtin/video-providers.ts`(`DEFAULT_VIDEO_MODEL`、`getVideoProvider`)
- Test: `packages/core/src/tool-system/builtin/video-providers.test.ts`

- [ ] **Step 1: 写注册测试**

在 `describe("registry")` 内追加:

```typescript
  test("getVideoProvider('fal') returns FalVideoProvider", () => {
    expect(getVideoProvider("fal")?.kind).toBe("fal");
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/video-providers.test.ts`
Expected: FAIL(返回 null)。

- [ ] **Step 3: 注册 fal + 默认模型**

在 `video-providers.ts`:

```typescript
export const DEFAULT_VIDEO_MODEL: Record<string, string> = {
  fal: "fal-ai/kling-video/v3/pro/text-to-video",
};
```

并在 `getVideoProvider` switch 加 case:

```typescript
export function getVideoProvider(kind: string, fetchImpl: typeof fetch = fetch): VideoProvider | null {
  switch (kind) {
    case "fake":
      return new FakeVideoProvider({ succeedAfterPolls: 0 });
    case "fal":
      return new FalVideoProvider(fetchImpl);
    default:
      return null;
  }
}
```

(注意:把原来未使用的 `_fetchImpl` 改名为 `fetchImpl` 并传给 FalVideoProvider。)

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/video-providers.test.ts`
Expected: PASS。已有的 `getVideoProvider("seedance")`/`("kling")` 仍返回 null,不受影响。

---

## Task 6: GenerateVideo 工具接线(videoGen.providers[] 解析 + image 透传)

**Files:**
- Modify: `packages/core/src/tool-system/builtin/generate-video.ts`
- Test: `packages/core/src/tool-system/builtin/generate-video.fal.test.ts`(新建)

**背景:** 当前 `resolveVideoProvider`(generate-video.ts:137-147)只遍历 `VIDEO_PROVIDER_KINDS`(空数组)并从 `settings.providers[]` 找,**不读 `videoGen.providers[]`**。spec 的配置走 `videoGen.providers[]`,所以必须扩展。

- [ ] **Step 1: 写 resolveVideoProvider 解析测试**

新建 `packages/core/src/tool-system/builtin/generate-video.fal.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resolveVideoProviderForTests } from "./generate-video.js";

function tmpWorkspaceWithSettings(settings: object): string {
  const dir = mkdtempSync(join(tmpdir(), "fal-vid-"));
  mkdirSync(join(dir, ".code-shell"), { recursive: true });
  writeFileSync(join(dir, ".code-shell", "settings.json"), JSON.stringify(settings));
  return dir;
}

describe("resolveVideoProvider reads videoGen.providers[]", () => {
  test("resolves a fal entry from videoGen.providers[] with defaultModel", () => {
    const cwd = tmpWorkspaceWithSettings({
      videoGen: {
        defaultProvider: "fal",
        providers: [
          { id: "fal", kind: "fal", baseUrl: "https://queue.fal.run", apiKey: "k", defaultModel: "fal-ai/kling-video/v3/pro/text-to-video" },
        ],
      },
    });
    const r = __resolveVideoProviderForTests(cwd);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("fal");
    expect(r!.creds.apiKey).toBe("k");
    expect(r!.defaultModel).toBe("fal-ai/kling-video/v3/pro/text-to-video");
  });

  test("returns null when fal entry has no apiKey", () => {
    const cwd = tmpWorkspaceWithSettings({
      videoGen: { providers: [{ id: "fal", kind: "fal", baseUrl: "https://queue.fal.run" }] },
    });
    expect(__resolveVideoProviderForTests(cwd)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/generate-video.fal.test.ts`
Expected: FAIL — `__resolveVideoProviderForTests` not exported。

- [ ] **Step 3: 扩展 resolveVideoProvider + 暴露测试钩子 + defaultModel**

在 `generate-video.ts`:

(a) `VIDEO_PROVIDER_KINDS` 加 `"fal"`(line 34):
```typescript
const VIDEO_PROVIDER_KINDS: string[] = ["fal"];
```

(b) `ResolvedVideoProvider` 接口加 `defaultModel`(line 132-135):
```typescript
interface ResolvedVideoProvider {
  kind: string;
  creds: VideoProviderCreds;
  defaultModel?: string;
}
```

(c) 替换 `resolveVideoProvider`(line 137-147)为先读 `videoGen.providers[]`、再回退旧路径:
```typescript
function resolveVideoProvider(cwd: string, preferKind?: string): ResolvedVideoProvider | null {
  const settings = new SettingsManager(cwd, "full").get();
  const videoGen = (settings as { videoGen?: { defaultProvider?: string; providers?: Array<{ id: string; kind: string; baseUrl: string; apiKey?: string; defaultModel?: string }> } }).videoGen;
  if (videoGen?.providers?.length) {
    const usable = (p: { kind: string; apiKey?: string }): boolean =>
      !!p.apiKey && getVideoProvider(p.kind) !== null;
    if (preferKind) {
      const chosen = videoGen.providers.find((p) => (p.id === preferKind || p.kind === preferKind) && usable(p));
      if (chosen) return { kind: chosen.kind, creds: { baseUrl: chosen.baseUrl, apiKey: chosen.apiKey! }, defaultModel: chosen.defaultModel };
      return null;
    }
    const preferred = videoGen.defaultProvider
      ? videoGen.providers.find((p) => p.id === videoGen.defaultProvider)
      : undefined;
    const chosen = (preferred && usable(preferred) ? preferred : undefined) ?? videoGen.providers.find(usable);
    if (chosen) return { kind: chosen.kind, creds: { baseUrl: chosen.baseUrl, apiKey: chosen.apiKey! }, defaultModel: chosen.defaultModel };
    return null;
  }
  // Back-compat: scan LLM providers[] for a video-capable kind.
  const kinds = preferKind ? [preferKind] : VIDEO_PROVIDER_KINDS;
  for (const kind of kinds) {
    const provider = settings.providers.find((p) => p.kind === kind);
    if (provider && provider.apiKey) {
      return { kind, creds: { baseUrl: provider.baseUrl, apiKey: provider.apiKey } };
    }
  }
  return null;
}

export function __resolveVideoProviderForTests(cwd: string, preferKind?: string): ResolvedVideoProvider | null {
  return resolveVideoProvider(cwd, preferKind);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/generate-video.fal.test.ts`
Expected: PASS。

- [ ] **Step 5: image 入参接线**

在 `generate-video.ts`:

(a) inputSchema(line 47-58)的 properties 加 image:
```typescript
      image: { type: "string", description: "Image URL (http/https) for image-to-video. When set, an image-to-video model is used." },
```

(b) `generateVideoTool` 内,读取 image(在 `overrideModel` 附近,line 160 后):
```typescript
  const image = typeof args.image === "string" && args.image ? args.image : undefined;
```

(c) `model` 解析处用 resolved.defaultModel(line 189 替换):
```typescript
  const resolvedDefault = (injectedProvider ? undefined : resolveVideoProvider(cwd, preferKind)?.defaultModel);
  const model = overrideModel ?? resolvedDefault ?? DEFAULT_VIDEO_MODEL[kind] ?? kind;
```

  注意:为避免重复解析,更简洁的做法 —— 在已有 `resolved` 分支里把 `resolved.defaultModel` 存到外层变量。具体:在 line 168 附近声明 `let defaultModel: string | undefined;`,在 else 分支 `defaultModel = resolved.defaultModel;`,然后 `const model = overrideModel ?? defaultModel ?? DEFAULT_VIDEO_MODEL[kind] ?? kind;`。注入分支 defaultModel 保持 undefined。

(d) submit 调用(line 191)透传 image:
```typescript
  const submit = await adapter.submit({ prompt, model, image, creds, signal: ctx?.signal });
```

- [ ] **Step 6: 运行全套相关测试**

Run: `cd packages/core && bun test src/tool-system/builtin/video-providers.test.ts src/tool-system/builtin/generate-video.test.ts src/tool-system/builtin/generate-video.fal.test.ts`
Expected: 全 PASS(尤其 `generate-video.test.ts` 原有后台轮询/通知测试不回归)。

---

## Task 7: 全量验证 + 构建

- [ ] **Step 1: core 全量测试**

Run: `cd packages/core && bun test src/`
Expected: 全绿(不引入回归)。

- [ ] **Step 2: typecheck**

Run: `cd packages/core && bun run typecheck`(若无此脚本,用 `bunx tsc --noEmit -p tsconfig.json`)
Expected: 无类型错误。

- [ ] **Step 3: build core**

Run: `cd packages/core && bun run build`
Expected: 成功(tui/desktop 经 dist 引入需 core rebuild)。

- [ ] **Step 4: 报告** —— subagent 把测试/typecheck/build 输出原样回报,不 commit。

---

## 验证标准
- 新增 `FalVideoProvider` 三段式 mock fetch 测试全绿。
- `resolveVideoProvider` 能从 `videoGen.providers[]` 解析 fal + defaultModel,缺 apiKey 返回 null。
- `image` 入参透传并触发 i2v model 切换。
- core 全量测试 + typecheck + build 通过,无回归。
- (可选,需真 FAL_KEY)配 settings.json 后 GenerateVideo 跑一条真实文生视频。
