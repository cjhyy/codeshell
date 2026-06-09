# fal.ai 视频生成 Provider 接入设计

- 日期: 2026-06-10
- 状态: 已确认方案 A,定稿待实现
- 目标项目: codeshell (`packages/core`)

## 背景与目标

为 `GenerateVideo` 工具新增一个走 **fal.ai** 的视频生成 provider,支持**文生视频**与**图生视频**。
fal.ai 是生成式媒体的统一推理平台(1000+ 模型,一个 API key),底层可调 Kling、字节视频模型等。
本期用 Kling v3 Pro 跑通主链路。

**即梦(火山引擎)官方 API 本期不实现,仅做预留位**(见第 5 节)。理由:fal.ai 已覆盖文生/图生视频+原生音频,
且避开火山 AK/SK 签名这块最脏的活;即梦特有能力(数字人/最新版/境内合规/会员额度计费)以后按需再加,
provider 架构是 switch 注册,加 `case "jimeng"` 即可,零返工。

### 非目标(本期不做)
- 即梦官方 API / 火山 AK/SK 签名
- 数字人、语音(TTS)等非 image/video 能力
- 字幕烧录/合成(AI 视频模型不直接产字幕;属另一跳)
- 音频开关字段(本期音频走模型默认,不加控制字段)
- 本地图片**上传**到 fal storage(本期 `image` 只接受 http/https URL)

## 1. 架构总览

新增 `FalVideoProvider`(`kind: "fal"`),纯适配器塞进现有 `getVideoProvider()` switch。
轮询/超时/下载落盘/通知**全部复用** `generate-video.ts` 现成的 `pollToCompletion`,
provider 自己只管三段 HTTP(submit/poll/download)。`fetch` 可注入,便于 mock 测试。

```
GenerateVideo 工具 (generate-video.ts)         ← 仅 schema 加 image 字段 + 透传
   │  resolveVideoProvider(cwd, "fal")          ← 读 videoGen.providers[]
   │  getVideoProvider("fal")  ───────────────► FalVideoProvider   ← 新增
   │  submit() → jobId (= "model::request_id")
   └─ void pollToCompletion(...)  ← 复用:5s 轮询 / 15min 超时 / 下载 / notify
          │  adapter.poll(jobId)   → running | succeeded | failed
          │  adapter.download(jobId) → bytes + ext
          └─ 写 .code-shell/generated_videos/ → notificationQueue
```

「视频慢」由现成后台轮询基础设施承担,provider 层不写一行相关代码。

## 2. 接口改动 + model 策略

### 2a. `VideoSubmitRequest` 加可选 `image`

```typescript
export interface VideoSubmitRequest {
  prompt: string;
  model: string;
  creds: VideoProviderCreds;
  image?: string;     // 新增:图片 URL(http/https),存在时触发图生视频
  signal?: AbortSignal;
}
```
可选字段,向后兼容现有 FakeVideoProvider 与文生视频路径。

### 2b. fal model id 体系 = "选对即可"

fal 的 model 是路径式字符串,文生/图生只差末段:

| 用途 | model id |
|---|---|
| 文生视频 | `fal-ai/kling-video/v3/pro/text-to-video` |
| 图生视频 | `fal-ai/kling-video/v3/pro/image-to-video` |

provider 无需 if-else 判断模型种类,直接把 `model` 拼进 `POST https://queue.fal.run/{model}`。
换模型 = 换配置字符串,代码零改动。

### 2c. 防选错:两道默认值
1. **配置级默认**:fal 配置写 `defaultModel`,调用不传 model 时由现有 `resolveVideoProvider` 透传。
2. **图生视频智能切换**:调用带 `image` 但 model 仍以 `text-to-video` 结尾时,provider 内部自动
   `model.replace(/text-to-video$/, "image-to-video")`。Agent 只要"想图生就传图",不必记两个 id。
   仅对成对命名(Kling 类)生效;非成对命名由用户显式写 model。

### 2d. 用户配置(settings.json,不进 git)

```json
{
  "videoGen": {
    "defaultProvider": "fal",
    "providers": [
      {
        "id": "fal",
        "kind": "fal",
        "baseUrl": "https://queue.fal.run",
        "apiKey": "<FAL_KEY>",
        "defaultModel": "fal-ai/kling-video/v3/pro/text-to-video"
      }
    ]
  }
}
```
现有 `videoGen.providers[]` schema 已支持任意 `kind` 字符串,**无需改 settings schema**。

## 3. 数据流(三段 HTTP 映射)

### jobId 设计
fal submit 返回 `request_id`,但 poll/download 还需要 model 才能拼 URL,而接口只传 jobId 字符串。
故 **jobId 编码为 `"{model}::{request_id}"`**,poll/download 拆开自拼 URL(显式、可读、不依赖 fal URL 结构)。

### submit(req)
```
POST {baseUrl}/{model}
Header: Authorization: Key {apiKey}, Content-Type: application/json
Body:   { prompt }                      // 文生
        { prompt, image_url: image }    // 图生(req.image 存在)
→ 取 request_id
→ return { ok:true, jobId: `${model}::${request_id}` }
非 2xx / 无 request_id → { ok:false, error }
```
其中 model 经 2c 智能切换后确定。

### poll({ jobId, creds })
```
拆 jobId → model, request_id
GET {baseUrl}/{model}/requests/{request_id}/status
映射:
  IN_QUEUE | IN_PROGRESS → { ok:true, status:"running" }
  COMPLETED              → { ok:true, status:"succeeded" }
  其它/错误状态           → { ok:true, status:"failed", error }
网络错误 → { ok:false, error }
```

### download({ jobId, creds })  —— 两跳
```
拆 jobId → model, request_id
跳1: GET {baseUrl}/{model}/requests/{request_id}/   → 结果 JSON,取 video.url
跳2: GET video.url                                   → 视频字节
→ return { ok:true, bytes, ext: 由 url 后缀/content-type 推,默认 "mp4" }
任一跳失败或无 video.url → { ok:false, error }
```
两跳封在 download 内部,上层 `pollToCompletion` 无感(决策:不复用其它下载工具,保持 provider 自洽)。

## 4. 图生视频细节
- 触发条件:`VideoSubmitRequest.image` 非空。
- `image` 本期只接受 http/https URL → 直接作为 fal 的 `image_url`。
- model 经 2c 自动切到 `image-to-video`(或用户显式给 i2v model)。
- `GenerateVideo` 工具 inputSchema 加可选 `image` 字段(string,描述:图片 URL,用于图生视频),
  运行时透传进 `submit`。
- 本地路径上传 = 后续扩展(非目标)。

## 5. 即梦预留位(本期不实现,仅记录接入路径)

未来接入即梦官方 API 时:
- 在 `getVideoProvider()` switch 加 `case "jimeng": return new JimengVideoProvider(fetchImpl)`。
- 凭证约定:`apiKey` 字段存 `"<AK>:<SK>"` 拼接,`JimengVideoProvider` 内部拆开。
- 鉴权可做成自适应:`apiKey` 含 `:` → 走火山 AK/SK HMAC 签名;否则当方舟 Bearer。
- 即梦的 `submit_id` ↔ jobId,`query_result` ↔ poll+download,天然契合三段式。
- 对本期 fal 代码零影响。

## 6. 错误处理
- submit 非 2xx / 无 request_id → `{ ok:false, error }`(含状态码+响应片段,便于排查)。
- poll 网络错误 → `{ ok:false, error }`;fal 返回失败态 → `{ ok:true, status:"failed", error }`。
  (现有 `pollToCompletion` 对二者都按失败通知用户。)
- download 任一跳失败 / 缺 video.url → `{ ok:false, error }`。
- 所有 error 文本带足够上下文(阶段、状态码),写入现有日志。
- 不在 provider 内重试;超时由现有 15min 上限兜底。

## 7. 测试(TDD,mock fetch)

照 `image-providers.test.ts` 的注入式 mock fetch 写,放进 `video-providers.test.ts`:

1. **文生 submit**:断言 POST URL = `{baseUrl}/{t2v-model}`、header 有 `Authorization: Key`、body 只含 prompt、返回 jobId 含 request_id。
2. **图生 submit**:传 image + t2v model → 断言 URL 切到 `image-to-video`、body 含 `image_url`。
3. **poll 状态映射**:IN_QUEUE/IN_PROGRESS→running,COMPLETED→succeeded,错误态→failed。
4. **download 两跳**:第一跳返回含 `video.url` 的 JSON,第二跳返回字节 → 断言 bytes 正确、ext=mp4。
5. **错误路径**:submit 非 2xx、download 缺 video.url → ok:false。
6. **getVideoProvider("fal")** 返回 FalVideoProvider 实例。

测试必须带 `src/` 路径跑,避免命中 dist 旧测试(项目惯例)。

## 触碰文件清单
1. `packages/core/src/tool-system/builtin/video-providers.ts` — 加 `FalVideoProvider` + 接口加 `image` + switch `case "fal"`
2. `packages/core/src/tool-system/builtin/generate-video.ts` — inputSchema 加 `image` + 透传进 submit
3. `packages/core/src/tool-system/builtin/video-providers.test.ts` — 加 FalVideoProvider 测试
4. 本设计文档(已含即梦预留)

## 验证标准
- `video-providers.test.ts` 全绿(mock fetch,不打真实网络)。
- core typecheck + build 通过(tui/desktop 经 dist 引入需 rebuild core)。
- 真实联调(可选,需 FAL_KEY):配 settings.json 后 GenerateVideo 跑一条文生视频。
