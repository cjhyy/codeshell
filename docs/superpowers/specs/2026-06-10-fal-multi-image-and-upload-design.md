# 多图视频 + 可插拔本地图上传 设计

- 日期: 2026-06-10
- 状态: 已确认,定稿待实现
- 目标项目: codeshell `packages/core`

## 背景与目标

当前图生视频只收**单张 URL**(`VideoSubmitRequest.image?: string` → fal 单数 `image_url` → `image-to-video` 模型)。两个限制要解除:
1. **只能一张图** —— fal 的 `reference-to-video` 支持最多 9 图(`image_urls` 数组),要接上。
2. **只能传 URL,本地图不行** —— 要支持本地路径自动上传换成 URL。

**关键架构决策(用户定):上传与多图解耦。** 上传做成可插拔抽象(以后可能换别的图床,不止 fal storage)。多图只关心"拿到一组 URL",不关心 URL 哪来。

## 两块独立能力

### A. 多图(provider 层)
- `VideoSubmitRequest` 加 `images?: string[]`,保留 `image?: string`(向后兼容)。
- 归一化:有效图列表 = `images ?? (image ? [image] : [])`。
- 路由(在 FalVideoProvider.submit):
  - 0 图 → 文生(现状)
  - 1 图 → `image-to-video`,发单数 `image_url`(现状,不变)
  - ≥2 图 → `reference-to-video`,发 `image_urls` 数组
- reference-to-video 的 model 切换:把 model 末段 `text-to-video`/`image-to-video` 换成 `reference-to-video`(沿用现有 resolveModel 的成对命名思路,扩展成三态)。
- fal reference-to-video 字段(已核实):`{ prompt, image_urls: [...], ... }`,prompt 里可用 `@Image1/@Image2` 引用——但**本期不强制改写 prompt**(用户/Agent 自己在 prompt 里写引用即可;我们只负责把 image_urls 传对)。

### B. 可插拔上传(独立抽象)
- 新接口 `ImageUploader`:
  ```
  interface ImageUploader {
    readonly kind: string;
    /** 本地路径或 URL → 公网 URL。已是 http/https 的原样返回。 */
    toUrl(pathOrUrl: string, signal?: AbortSignal): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  }
  ```
- 第一个实现 `FalStorageUploader`:本地路径 → 上传 fal storage → 返回 fal URL。fal 上传 REST 的确切请求/返回**实现时用真 key 探测核实**(公开文档不全;参考端点 `POST /serverless/files/...`,鉴权 `Authorization: Key`)。
- 解耦点:`FalVideoProvider` **不直接 import FalStorageUploader**;由工具层(generate-video.ts)在 submit 前,把每个 image 经 uploader 归一成 URL,再传给 provider。这样:
  - provider 永远只收 URL(职责单一)
  - 换图床 = 换 uploader 实现 + 选择逻辑,provider 零改动
- fal storage 保留期:默认 ≥7 天(已核实),图生视频是"传图→立刻生成→秒级用掉",无过期顾虑。

## 数据流

```
GenerateVideo 工具
  ├─ 收 images[](或 image)+ prompt + model
  ├─ 对每个 image:isUrl? 直接用 : uploader.toUrl(本地路径) → URL
  │     (uploader 选择:本期固定 FalStorageUploader;预留按配置选)
  ├─ 归一成 urls[]
  └─ adapter.submit({ prompt, model, images: urls, creds })
        └─ FalVideoProvider:按 urls.length 路由 t2v / i2v / ref2v,发对应字段
        └─ 之后 poll/download 不变
```

## 工具参数(schema)
- 保留 `image?: string`(单图,向后兼容)
- 加 `images?: string[]`(多图;每项可为 URL 或本地路径)
- 运行时:`const imgs = images ?? (image ? [image] : [])`
- 描述里说明:传 1 张走图生、≥2 张走多图参考、本地路径会自动上传、prompt 里可用 @Image1 引用

## 触碰文件
1. `packages/core/src/tool-system/builtin/video-providers.ts` — `VideoSubmitRequest.images`;FalVideoProvider 三态路由(t2v/i2v/ref2v)+ image_urls
2. `packages/core/src/tool-system/builtin/image-uploader.ts` — 新建:ImageUploader 接口 + FalStorageUploader + getImageUploader(kind)
3. `packages/core/src/tool-system/builtin/generate-video.ts` — schema 加 images;submit 前经 uploader 归一本地路径→URL;透传 images
4. 各自 .test.ts — mock fetch 测试

## 错误处理
- 上传失败(任一图)→ 工具返回明确错误,不提交生成(避免半截任务)。
- 图数 >9 → 截断到 9 并 log warn(fal 上限),或直接报错提示;本期**报错提示**更安全(不静默丢图)。
- provider 路由:images 为空仍走文生;1 张 i2v;≥2 张 ref2v。

## 测试
- provider:0/1/≥2 图分别命中 t2v/i2v/ref2v,字段名正确(image_url vs image_urls)、model 切对。
- uploader:URL 原样返回;本地路径触发上传(mock fetch 断言上传请求 + 取回 URL);上传失败→ok:false。
- 工具层:本地路径被 uploader 换成 URL 再进 submit;>9 图报错。
- 真机(实现时,用 fal key):2 张图(可先用两个公网 URL 验 ref2v 通)→ 生成一条多图视频;本地图上传走通一次。

## 非目标
- 改写 prompt 自动插 @Image1(用户自己写)。
- 参考视频/音频(video_urls/audio_urls)——只做图。
- 多个图床的真实第二实现(只留接口 + fal 一个实现 + 选择预留)。
- UI 端多图选择器(本期 core 能力为主;设置页/聊天 UI 另说)。

## 与既有的衔接
- 单图路径(image-to-video)行为完全不变,向后兼容。
- 沿用现有 jobId(status_url|response_url)、poll/download、pollToCompletion 后台轮询,全不动。
- 相关:见 fal video provider 设计 docs/superpowers/specs/2026-06-10-fal-video-provider-design.md。
