# 多图视频 + 可插拔上传 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 图生视频支持多图(≥2 走 fal reference-to-video)+ 本地图片自动上传(可插拔 ImageUploader,fal storage 首个实现)。

**Architecture:** provider 收 `images[]` 按数量路由 t2v/i2v/ref2v;上传是独立 `ImageUploader` 抽象,由工具层在 submit 前把本地路径归一成 URL,provider 永远只收 URL。

**Tech Stack:** TypeScript, bun:test, fal queue API + fal storage REST。

**约束:** subagent 不动 git;bun test 带 `src/`;core 改完 rebuild;**上传 REST 的确切请求/返回公开文档不全 → 实现时用真 fal key 探测核实**(见 Task 3 注)。

---

## 现状(实现者必读)

`video-providers.ts`:
```typescript
export interface VideoSubmitRequest {
  prompt: string; model: string; creds: VideoProviderCreds;
  image?: string;            // 现有单图
  signal?: AbortSignal;
}
```
FalVideoProvider.submit 现:`resolveModel(model, image)` 把 `text-to-video`→`image-to-video`(当 image 存在);body `{ prompt }`,有 image 加 `body.image_url = req.image`。jobId = `${status_url}|${response_url}`。

fal reference-to-video(已核实):`POST {base}/bytedance/seedance-2.0/reference-to-video`,body `{ prompt, image_urls: [...], ... }`,最多 9 图。

---

## Task 1: VideoSubmitRequest 加 images[] + provider 三态路由

**Files:**
- Modify: `packages/core/src/tool-system/builtin/video-providers.ts`
- Test: `packages/core/src/tool-system/builtin/video-providers.test.ts`

- [ ] **Step 1: 接口加 images**

```typescript
export interface VideoSubmitRequest {
  prompt: string;
  model: string;
  creds: VideoProviderCreds;
  /** Single image URL (http/https) — image-to-video. Back-compat. */
  image?: string;
  /** Multiple image URLs — ≥2 triggers reference-to-video. Takes precedence over `image`. */
  images?: string[];
  signal?: AbortSignal;
}
```

- [ ] **Step 2: 写多图路由测试**

在 `describe("FalVideoProvider")` 内追加(沿用文件顶部已有的 `creds` 与 `falSubmitBody` helper):

```typescript
  test("submit with 2+ images → reference-to-video + image_urls array", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fakeFetch: typeof fetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => falSubmitBody("req-ref") } as Response;
    }) as unknown as typeof fetch;

    const p = new FalVideoProvider(fakeFetch);
    const res = await p.submit({
      prompt: "@Image1 and @Image2 dance",
      model: "fal-ai/kling-video/v3/pro/text-to-video",
      images: ["https://x/a.png", "https://x/b.png"],
      creds,
    });
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe("https://queue.fal.run/fal-ai/kling-video/v3/pro/reference-to-video");
    expect(calls[0].body).toEqual({ prompt: "@Image1 and @Image2 dance", image_urls: ["https://x/a.png", "https://x/b.png"] });
  });

  test("submit with single-element images[] → image-to-video + image_url (singular)", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fakeFetch: typeof fetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => falSubmitBody("req-i2v") } as Response;
    }) as unknown as typeof fetch;
    const p = new FalVideoProvider(fakeFetch);
    const res = await p.submit({
      prompt: "zoom",
      model: "fal-ai/kling-video/v3/pro/text-to-video",
      images: ["https://x/only.png"],
      creds,
    });
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe("https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video");
    expect(calls[0].body).toEqual({ prompt: "zoom", image_url: "https://x/only.png" });
  });
```

(现有单 `image` 测试保持不变,验证向后兼容。)

- [ ] **Step 3: 运行确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/video-providers.test.ts`
Expected: FAIL(走错 model / 字段)。

- [ ] **Step 4: 实现三态路由**

替换 `resolveModel` 和 submit 的 body 构造:

```typescript
  /** Effective image list: images[] wins; else single image; else []. */
  private imageList(req: VideoSubmitRequest): string[] {
    if (req.images && req.images.length) return req.images;
    if (req.image) return [req.image];
    return [];
  }

  /** Route model suffix by image count: 0→text, 1→image, ≥2→reference. */
  private resolveModel(model: string, imageCount: number): string {
    const target = imageCount >= 2 ? "reference-to-video" : imageCount === 1 ? "image-to-video" : null;
    if (target && /(text|image|reference)-to-video$/.test(model)) {
      return model.replace(/(text|image|reference)-to-video$/, target);
    }
    return model;
  }
```

submit 开头改为:

```typescript
  async submit(req: VideoSubmitRequest): Promise<VideoSubmitResult> {
    const base = req.creds.baseUrl.replace(/\/+$/, "");
    const imgs = this.imageList(req);
    const model = this.resolveModel(req.model, imgs.length);
    const body: Record<string, unknown> = { prompt: req.prompt };
    if (imgs.length >= 2) body.image_urls = imgs;
    else if (imgs.length === 1) body.image_url = imgs[0];
    // ...rest unchanged (fetch POST, parse status_url/response_url)...
```

(删掉旧的 `if (req.image) body.image_url = req.image;` 与旧 resolveModel 调用。)

- [ ] **Step 5: 运行确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/video-providers.test.ts`
Expected: PASS(含原单图测试不回归)。

---

## Task 2: ImageUploader 抽象 + URL 直通

**Files:**
- Create: `packages/core/src/tool-system/builtin/image-uploader.ts`
- Test: `packages/core/src/tool-system/builtin/image-uploader.test.ts`

- [ ] **Step 1: 写接口 + URL 直通测试**

新建 `image-uploader.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { FalStorageUploader, getImageUploader, isHttpUrl } from "./image-uploader.js";

describe("isHttpUrl", () => {
  test("http/https → true; local path → false", () => {
    expect(isHttpUrl("https://x/a.png")).toBe(true);
    expect(isHttpUrl("http://x/a.png")).toBe(true);
    expect(isHttpUrl("/Users/me/a.png")).toBe(false);
    expect(isHttpUrl("./a.png")).toBe(false);
  });
});

describe("FalStorageUploader.toUrl", () => {
  const creds = { baseUrl: "https://queue.fal.run", apiKey: "k" };

  test("already-a-URL → returned unchanged, no fetch", async () => {
    let called = false;
    const fakeFetch: typeof fetch = (async () => { called = true; return {} as Response; }) as unknown as typeof fetch;
    const up = new FalStorageUploader(fakeFetch);
    const r = await up.toUrl("https://x/a.png", creds);
    expect(r).toEqual({ ok: true, url: "https://x/a.png" });
    expect(called).toBe(false);
  });

  test("getImageUploader('fal') returns a FalStorageUploader", () => {
    expect(getImageUploader("fal")?.kind).toBe("fal");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/image-uploader.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现接口 + URL 直通骨架(上传 HTTP 留待 Task 3 探测后填)**

新建 `image-uploader.ts`:

```typescript
/**
 * ImageUploader — pluggable "local path → public URL" so image-to-video /
 * reference-to-video can accept local files, not just URLs. fal storage is the
 * first impl; swapping in another image host = another impl, no provider change.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface UploaderCreds {
  baseUrl: string;
  apiKey: string;
}

export type UploadResult = { ok: true; url: string } | { ok: false; error: string };

export interface ImageUploader {
  readonly kind: string;
  /** http/https → unchanged; local path → upload, return public URL. */
  toUrl(pathOrUrl: string, creds: UploaderCreds, signal?: AbortSignal): Promise<UploadResult>;
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export class FalStorageUploader implements ImageUploader {
  readonly kind = "fal";
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async toUrl(pathOrUrl: string, creds: UploaderCreds, signal?: AbortSignal): Promise<UploadResult> {
    if (isHttpUrl(pathOrUrl)) return { ok: true, url: pathOrUrl };
    try {
      const bytes = await readFile(pathOrUrl);
      const url = await this.uploadBytes(bytes, basename(pathOrUrl), creds, signal);
      return { ok: true, url };
    } catch (err) {
      return { ok: false, error: `fal upload error for ${pathOrUrl}: ${(err as Error).message}` };
    }
  }

  /**
   * Upload raw bytes to fal storage, return the public URL.
   * IMPLEMENTATION NOTE: the exact fal upload REST flow is filled in Task 3
   * after probing the live API. Until then this throws so callers get a clear
   * "not implemented" rather than a silent wrong URL.
   */
  private async uploadBytes(_bytes: Uint8Array, _name: string, _creds: UploaderCreds, _signal?: AbortSignal): Promise<string> {
    throw new Error("fal upload not implemented yet (Task 3)");
  }
}

export function getImageUploader(kind: string, fetchImpl: typeof fetch = fetch): ImageUploader | null {
  switch (kind) {
    case "fal":
      return new FalStorageUploader(fetchImpl);
    default:
      return null;
  }
}
```

- [ ] **Step 4: 运行确认通过(URL 直通 + registry 测试过;上传未测)**

Run: `cd packages/core && bun test src/tool-system/builtin/image-uploader.test.ts`
Expected: PASS。

---

## Task 3: 落实 fal 上传 HTTP(探测真实 API 后实现)

**Files:**
- Modify: `packages/core/src/tool-system/builtin/image-uploader.ts`(uploadBytes)
- Test: `packages/core/src/tool-system/builtin/image-uploader.test.ts`

> **本 Task 由主代理(非 subagent)用真 fal key 探测后落实** —— 因为 fal 上传 REST 的确切 endpoint/请求体/返回字段公开文档不全,必须实测(就像之前 video status_url 的 bug 是真机才发现的)。subagent 阶段做到 Task 2 即可;Task 3 主代理接手。

- [ ] **Step 1: 主代理用 fal key 探测上传**:确定 endpoint(POST 形式)、是否两步(先取 upload url 再 PUT)、鉴权 header、返回里 URL 字段名。记录真实请求/响应。
- [ ] **Step 2: 写 uploadBytes 的 mock 测试**:按探测到的真实形态写 mock fetch 断言(上传请求 URL/header + 取回 URL)。先确认失败。
- [ ] **Step 3: 实现 uploadBytes**:按探测结果填入真实 HTTP。
- [ ] **Step 4: mock 测试通过 + 真机验证**:用 fal key 真上传一张本地图,拿到可访问 URL,再用该 URL 跑一条多图视频跑通。

---

## Task 4: GenerateVideo 工具接线(images schema + 上传归一)

**Files:**
- Modify: `packages/core/src/tool-system/builtin/generate-video.ts`
- Test: `packages/core/src/tool-system/builtin/generate-video.fal.test.ts`(追加)

- [ ] **Step 1: 写工具层归一测试**

追加到 `generate-video.fal.test.ts`(用注入的 fake provider + fake uploader 思路;若现有无注入 uploader 的 seam,测 `normalizeImages` 纯函数):

```typescript
import { __normalizeImagesForTests } from "./generate-video.js";

describe("GenerateVideo image normalization", () => {
  test("images[] wins; URLs pass through; >9 → error", async () => {
    const fakeUploader = { kind: "fal", toUrl: async (p: string) => ({ ok: true as const, url: p.startsWith("http") ? p : `https://fal/${p}` }) };
    const ok = await __normalizeImagesForTests(["https://x/a.png", "/local/b.png"], undefined, fakeUploader, { baseUrl: "x", apiKey: "k" });
    expect(ok).toEqual({ ok: true, urls: ["https://x/a.png", "https://fal//local/b.png"] });

    const tooMany = await __normalizeImagesForTests(Array.from({ length: 10 }, (_, i) => `https://x/${i}.png`), undefined, fakeUploader, { baseUrl: "x", apiKey: "k" });
    expect(tooMany.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/generate-video.fal.test.ts`
Expected: FAIL(`__normalizeImagesForTests` 未导出)。

- [ ] **Step 3: 实现 schema + 归一 + 透传**

在 `generate-video.ts`:

(a) inputSchema properties 加:
```typescript
      images: {
        type: "array",
        items: { type: "string" },
        description: "Image URLs or local file paths for image/reference-to-video. 1 image → image-to-video; 2+ → reference-to-video (max 9). Local paths are auto-uploaded. Refer to them in prompt as @Image1, @Image2.",
      },
```

(b) 加归一 helper(导出测试钩子):
```typescript
import { getImageUploader, type ImageUploader, type UploaderCreds } from "./image-uploader.js";

const MAX_IMAGES = 9;

export async function __normalizeImagesForTests(
  images: string[] | undefined,
  image: string | undefined,
  uploader: ImageUploader,
  creds: UploaderCreds,
  signal?: AbortSignal,
): Promise<{ ok: true; urls: string[] } | { ok: false; error: string }> {
  const raw = images && images.length ? images : image ? [image] : [];
  if (raw.length > MAX_IMAGES) {
    return { ok: false, error: `too many images: ${raw.length} (max ${MAX_IMAGES})` };
  }
  const urls: string[] = [];
  for (const item of raw) {
    const r = await uploader.toUrl(item, creds, signal);
    if (!r.ok) return { ok: false, error: r.error };
    urls.push(r.url);
  }
  return { ok: true, urls };
}
```

(c) 在 `generateVideoTool` 里,读取 images + 用 uploader 归一(注入分支跳过上传,直接当 URL):
```typescript
  const imagesArg = Array.isArray(args.images) ? (args.images as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
  // ...resolve provider/creds as today...
  // before submit:
  const uploader = getImageUploader(kind) ?? getImageUploader("fal")!;
  const norm = await __normalizeImagesForTests(imagesArg, image, uploader, { baseUrl: creds.baseUrl, apiKey: creds.apiKey }, ctx?.signal);
  if (!norm.ok) return `Error: ${norm.error}`;
  const submit = await adapter.submit({ prompt, model, image: undefined, images: norm.urls, creds, signal: ctx?.signal });
```
(注:把 `image` 单数并入 images 后,submit 只传 images;model 切换由 provider 按 images.length 处理。injected fake provider 测试不受影响——它忽略 images。)

- [ ] **Step 4: 运行确认通过 + 全量**

Run: `cd packages/core && bun test src/tool-system/builtin/generate-video.fal.test.ts src/tool-system/builtin/video-providers.test.ts src/tool-system/builtin/generate-video.test.ts src/tool-system/builtin/image-uploader.test.ts`
Expected: 全 PASS(generate-video.test.ts 后台轮询不回归)。

---

## Task 5: 全量验证 + 构建

- [ ] **Step 1:** `cd packages/core && bun test src/` → 全绿
- [ ] **Step 2:** typecheck:`bunx tsc --noEmit -p tsconfig.json` → 0 错误
- [ ] **Step 3:** `bun run build` → 成功
- [ ] **Step 4:** subagent 贴真实输出,不 commit;Task 3 真机部分主代理做。

---

## 验证标准
- provider:0/1/≥2 图 → t2v/i2v/ref2v,字段 image_url(单)/image_urls(数组)正确;单图旧路径不回归。
- ImageUploader:URL 直通;本地路径走上传;上传失败 ok:false;registry 返回 fal 实现。
- 工具层:images 归一(本地→URL)、>9 报错、并入 submit。
- core 全量测试 + typecheck + build 绿。
- (主代理真机)fal 上传一张本地图通 + 2 张图 reference-to-video 生成一条视频通。
