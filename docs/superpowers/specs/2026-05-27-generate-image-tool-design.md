# GenerateImage 工具设计

**日期:** 2026-05-27
**状态:** 设计已批准,待实现

## 目标

给 codeshell 增加一个内置工具 `GenerateImage`,让模型能通过 OpenAI Images API
(`gpt-image-2`)做文生图,生成的图片落盘到工作区,工具返回文件路径供模型后续引用。

参考实现:codex 的 `~/.codex/skills/.system/imagegen/scripts/image_gen.py`
(其 `_generate` + `_decode_write_and_downscale` 是本设计的蓝本)。

## 范围

**做:** 文生图(text-to-image)。

**不做(YAGNI):** 图片编辑(edit)、蒙版(mask)、透明背景、批量(n>1)、
本地降采样、capability gate。后续按需再加。

## 架构

新增单文件 `packages/core/src/tool-system/builtin/generate-image.ts`,导出
`generateImageToolDef`(ToolDefinition)+ `generateImageTool`(executor),
在 `builtin/index.ts` 的 `BUILTIN_TOOLS` 注册。

遵循现有工具契约(见 `write.ts`):executor 签名 `(args, ctx?) => Promise<string>`,
错误一律返回字符串(不抛)。

不引入 `openai` SDK —— codeshell 没装它,工具用原生 `fetch`(与 `web-fetch.ts` 一致)。

## 凭证来源(走 config,非环境变量)

从 settings 的 `providers[]` 数组里找 `kind === "openai"` 的 provider,取其
`apiKey` 和 `baseUrl`。读取方式照抄 `web-search.ts`:`new SettingsManager(ctx.cwd).get()`。

- providers 项 schema(`settings/schema.ts:48`):`{ key, label?, kind, baseUrl, apiKey?, ... }`
- 找不到 openai provider,或它没有 apiKey → 返回友好错误,提示去 settings 配置一个
  `kind: "openai"` 的 provider。
- 零新增配置:用户现有的 OpenAI provider 直接复用。

## 数据流

```
模型调用 GenerateImage({ prompt, size?, quality? })
  → new SettingsManager(ctx.cwd).get() 读 settings
  → providers.find(p => p.kind === "openai")
      └─ 无 / 无 apiKey → 返回错误字符串
  → fetch POST `${baseUrl}/images/generations`
      headers: { Authorization: `Bearer ${apiKey}`, Content-Type: application/json }
      body:    { model: "gpt-image-2", prompt, size, quality, n: 1 }
  → resp 非 2xx → 返回 "Error: image API returned <status>: <body 片段>"
  → 取 json.data[0].b64_json
      └─ 缺失 → 返回 "Error: no image in response: <body 片段>"
  → Buffer.from(b64, "base64") → 写 `${ctx.cwd}/.code-shell/generated_images/<ts>.png`
  → 返回 "Generated image saved to <绝对路径>"
```

## 工具参数(JSON schema)

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `prompt` | ✅ | — | 图片描述 |
| `size` | ✗ | `"1024x1024"` | 枚举:`1024x1024` / `1536x1024` / `1024x1536` / `auto` |
| `quality` | ✗ | `"auto"` | 枚举:`low` / `medium` / `high` / `auto` |

## 注册项字段

`permissionDefault: "ask"`(写盘 + 联网 + 花钱,与 Write 一致)、
`isReadOnly: false`、`isConcurrencySafe: false`、`source: "builtin"`。

## 错误处理(全返回字符串)

1. 无 prompt → `"Error: prompt is required"`
2. 无 openai provider / 无 apiKey → 提示去 config 配置
3. fetch 抛异常(网络) → `"Error generating image: <message>"`
4. HTTP 非 2xx → 状态码 + body 片段
5. 响应缺 b64_json → 原始响应片段(帮调试)

## 落盘

目录 `${ctx.cwd}/.code-shell/generated_images/`,`mkdir -p`,
文件名 `<Date.now()>.png`。返回绝对路径。

## 测试

`tests/generate-image.test.ts`,mock `globalThis.fetch`:
1. 正确 payload(model/prompt/size/quality)
2. b64 解码并写盘,返回路径正确
3. 无 openai provider → 错误字符串
4. HTTP 500 → 错误字符串含状态码

不打真实 API。
