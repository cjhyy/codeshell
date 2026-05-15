# Universal Model Configuration Layer — 设计草案

**作者**: maki / Codex  
**日期**: 2026-05-14  
**状态**: 设计草案  
**目标**: 让 OpenRouter、OpenAI 官方、Gemini 官方、DeepSeek 官方、Z.AI GLM-5.1 官方，以及自定义 provider，都能通过同一套模型配置、切换、能力发现和 provider 特性转译层接入。

---

## 1. 背景

当前 `codeshell` 已经有 `providers[] + models[] + activeKey` 的基础结构，但它仍然把 provider 理解成两类协议：

- `openai` / OpenAI-compatible Chat Completions
- `anthropic` / Anthropic Messages

这对 OpenRouter 还算够用，因为 OpenRouter 本身做了一层 OpenAI Chat 风格归一化；但对官方直连 provider 会逐渐不够：

- OpenAI 官方推荐复杂工具/推理工作流走 Responses API，而不是只走 Chat Completions。
- Gemini 官方是 `generateContent` 形态，thinking 控制、thought summary、thought signature 都不是 OpenAI Chat 语义。
- DeepSeek V4 / Z.AI GLM-5.1 虽然都是 OpenAI-like Chat Completions，但 thinking、reasoning_content replay、tool streaming 参数有自己的协议细节。
- OpenRouter 会转译/忽略不支持的参数；如果我们想要严格语义，需要显式 `require_parameters` 或能力校验。

所以 V2 模型层应该从“一个 `LLMConfig` 直接发请求”升级成：

```
用户选择 logical model key
  -> ModelResolver 解析 alias / role / mode / composite
  -> ProviderAdapter 把统一意图转成 provider 原生请求
  -> ProviderAdapter 把 provider 原生响应转回统一 LLMResponse
```

---

## 2. Provider 差异表

| Provider | 推荐 transport | 典型 baseUrl | 关键配置差异 | Thinking / Reasoning | Tool / stream 特点 | 兼容策略 |
|---|---|---|---|---|---|---|
| OpenRouter | `openai-chat-normalized` | `https://openrouter.ai/api/v1` | OpenAI Chat-like；支持 `provider` routing、`models` fallback、`route`、`debug.echo_upstream_body`；不支持的参数默认可能被忽略 | 支持 `reasoning` / `reasoning_effort` / `verbosity` 等归一化参数，但依模型/provider 而定 | tools 会尽量传给原生 provider；不支持时可能转成 YAML prompt | 当作“归一化聚合器”，但对强语义请求设置 `provider.require_parameters=true`；保留 OpenRouter-only routing 配置 |
| OpenAI 官方 | `openai-responses` 优先，`openai-chat` 兜底 | `https://api.openai.com/v1` | GPT-5 系列推荐 Responses API；`text.verbosity`、`reasoning.effort`、hosted tools、`previous_response_id` / output item replay | `reasoning.effort`: `none/low/medium/high/xhigh`；`text.verbosity`: `low/medium/high` | Responses API 的 tool/state 形态不同于 Chat Completions；要保留 returned output items / `phase` | 新增 OpenAIResponsesAdapter；Chat adapter 只用于老模型或兼容入口 |
| Gemini 官方 | `gemini-generate-content` | `https://generativelanguage.googleapis.com` | 请求是 `contents + generationConfig`；OpenAI-compatible endpoint 可用但会损失原生特性 | Gemini 3 用 `thinkingConfig.thinkingLevel`；Gemini 2.5 用 `thinkingBudget`；部分 Pro 不能彻底关闭 thinking | function calling + thought signatures 需要把带 signature 的 parts 原样回放 | 原生 GeminiAdapter；统一层保存 provider state，不能把 parts 简单拼成纯文本 |
| DeepSeek 官方 | `openai-chat-deepseek` | `https://api.deepseek.com` 或 `/v1` | OpenAI-compatible；V4 thinking 参数放 `extra_body.thinking`；thinking 模式下部分 sampling 参数无效 | `thinking: {type}` 默认 enabled；`reasoning_effort`: `high/max`，兼容映射 low/medium -> high、xhigh -> max | thinking + tool calls 时 `reasoning_content` 必须参与后续上下文 | DeepSeekAdapter 负责 extra_body、reasoning_content replay、thinking 模式参数裁剪 |
| Z.AI GLM-5.1 官方 | `openai-chat-zai` | `https://api.z.ai/api/paas/v4` | OpenAI-like；模型 `glm-5.1`；context 200K，max output 128K；默认 `temperature=1.0`、`top_p=0.95` | `thinking: {type:"enabled"}`，默认 enabled；复杂编码建议开启 | 支持 `tool_stream=true` 流式输出 tool call 参数；stream 中有 `delta.reasoning_content` | ZaiAdapter 负责 top-level `thinking`、`tool_stream`、reasoning_content 分流 |
| Anthropic 官方 / Claude | `anthropic-messages` | `https://api.anthropic.com` | Messages API；system 是独立字段；cache_control、thinking blocks、tool_use/tool_result 是 block 结构 | Claude Code 有 alias 和 mode switch 概念，例如 `opusplan` | tool block 原生，不是 OpenAI function call | 作为现有 AnthropicAdapter 的增强目标；用于借鉴 `/model` 和 alias 设计 |
| Custom OpenAI-compatible | `openai-chat-custom` | 用户配置 | 只保证 Chat Completions 基本字段；extra 参数不确定 | 通过声明式 `extraBody` / `paramMap` 或 adapter hook | tools 可能不稳定 | 默认宽松；可配置 `strictParams`、`dropUnsupported`、`probe` |
| Custom native provider | `custom-adapter` | 用户配置 | 完全自定义 | hook 决定 | hook 决定 | 必须注册 ProviderAdapter，不直接落到通用 OpenAI adapter |

---

## 3. 统一模型配置对象

### 3.1 Provider 层

`providers[]` 描述“怎么连到一个厂商/聚合器”，不描述某个具体模型的使用习惯。

```ts
type ProviderKind =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "zai"
  | "openai-compatible"
  | "custom";

type ProviderTransport =
  | "openai-chat"
  | "openai-chat-normalized"
  | "openai-chat-deepseek"
  | "openai-chat-zai"
  | "openai-chat-custom"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-generate-content"
  | "custom-adapter";

interface ProviderConfigV2 {
  key: string;
  label?: string;
  kind: ProviderKind;
  transport: ProviderTransport;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  modelsPath?: string;

  /** provider 级默认策略 */
  parameterPolicy?: "loose" | "warn" | "strict";
  requestDefaults?: Record<string, unknown>;
  adapter?: {
    name?: string;
    module?: string;
    options?: Record<string, unknown>;
  };
}
```

### 3.2 Model 层

`models[]` 描述“用户可选择的逻辑模型条目”。同一个 provider 可以挂多个模型，同一个真实模型也可以挂多个逻辑条目，比如 `deepseek-fast` 和 `deepseek-pro-thinking`。

```ts
interface ModelEntryV2 {
  key: string;
  label?: string;
  providerKey: string;
  model: string;

  roles?: Array<"chat" | "fast" | "plan" | "edit" | "review" | "summarize">;
  maxContextTokens?: number;
  maxOutputTokens?: number;

  capabilities?: {
    tools?: boolean;
    streaming?: boolean;
    structuredOutput?: boolean;
    vision?: boolean;
    promptCache?: boolean;
    nativeState?: "none" | "previous_response_id" | "reasoning_content" | "thought_signature" | "blocks";
    reasoning?: {
      supported: boolean;
      modes?: Array<"off" | "minimal" | "low" | "medium" | "high" | "max" | "dynamic">;
      default?: "off" | "minimal" | "low" | "medium" | "high" | "max" | "dynamic";
    };
  };

  defaults?: CanonicalModelOptions;
  providerOptions?: Record<string, unknown>;
}
```

### 3.3 统一调用意图

Engine / TurnLoop 不应该直接知道 Gemini 的 `thinkingBudget` 或 DeepSeek 的 `extra_body`。它只表达“我想要什么”。

```ts
interface CanonicalModelOptions {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];

  reasoning?: {
    mode?: "off" | "minimal" | "low" | "medium" | "high" | "max" | "dynamic";
    includeSummary?: boolean;
  };

  text?: {
    verbosity?: "low" | "medium" | "high";
  };

  tools?: {
    allowed?: string[] | "*";
    parallel?: boolean;
    strict?: boolean;
  };

  routing?: {
    providerOrder?: string[];
    allowFallbacks?: boolean;
    requireParameters?: boolean;
    dataCollection?: "allow" | "deny";
    zdr?: boolean;
  };
}
```

---

## 4. ProviderAdapter 接口

ProviderAdapter 是这层的核心：一个 adapter 负责一个 transport 或 provider family。

```ts
interface ProviderAdapter {
  name: string;
  transport: ProviderTransport;

  normalizeModel(entry: ModelEntryV2, provider: ProviderConfigV2): ResolvedModel;

  buildRequest(input: {
    provider: ProviderConfigV2;
    model: ModelEntryV2;
    systemPrompt: string;
    messages: Message[];
    tools: ToolDefinition[];
    options: CanonicalModelOptions;
    state?: ProviderConversationState;
  }): ProviderRequest;

  parseResponse(raw: unknown): LLMResponse;
  parseStream?(chunk: unknown): LLMStreamChunk[];

  /** provider 原生状态：reasoning_content、thought_signature、previous_response_id 等 */
  extractState?(raw: unknown): ProviderConversationState | undefined;

  validate?(request: ProviderRequest): ProviderValidationResult;
}
```

### Adapter 转译表

| 统一意图 | OpenRouter | OpenAI Responses | Gemini | DeepSeek | GLM-5.1 |
|---|---|---|---|---|---|
| `reasoning.mode=off` | 传 provider 支持的 off/low，必要时 `require_parameters` | `reasoning.effort="none"` | Gemini 3 只能 `minimal`；Gemini 2.5 Flash 可 `thinkingBudget=0` | `extra_body.thinking.type="disabled"` | `thinking.type="disabled"` |
| `reasoning.mode=high` | `reasoning_effort` 或 `reasoning`，按模型支持 | `reasoning.effort="high"` | Gemini 3 `thinkingLevel="high"`；2.5 用预算 | `thinking.enabled + reasoning_effort="high"` | `thinking.enabled` |
| `reasoning.mode=max` | 如果支持则传；否则 downgrade/warn | `reasoning.effort="xhigh"` | 无严格 max，映射 high/warn | `reasoning_effort="max"` | 暂映射 enabled/warn |
| `text.verbosity=low` | `verbosity="low"` | `text.verbosity="low"` | prompt 或 generation config，无完全等价 | prompt 约束 | prompt 约束 |
| `tools.strict=true` | `provider.require_parameters=true` | 原生 tools | 原生 functionDeclarations | 原生 tools | 原生 tools + 可选 `tool_stream` |
| provider state | OpenRouter normalized response | `previous_response_id` 或 output item replay / `phase` | thought signatures 原样回放 | `reasoning_content` replay | `reasoning_content` replay |

---

## 5. ModelResolver 与切换设计

Claude Code 的可借鉴点不是具体 provider 实现，而是“用户切的是 model setting / alias，不是 API body”：

- `/model <alias|name>` 可以在会话中切换。
- 优先级是 session 内 `/model` 高于启动参数，高于环境变量，高于 settings。
- alias 可以有行为：`opusplan` 在 plan mode 用 Opus，在 execution 用 Sonnet。

`codeshell` 可以做成更通用的 resolver：

```ts
interface ModelResolveContext {
  activeKey: string;
  phase: "chat" | "plan" | "execute" | "review" | "summarize";
  permissionMode?: string;
  taskText?: string;
  isEscalated?: boolean;
}

interface ModelAlias {
  key: string;
  strategy: "fixed" | "mode-switch" | "role-switch" | "composite";
  rules: Array<{
    when?: Partial<ModelResolveContext>;
    modelKey: string;
    options?: CanonicalModelOptions;
  }>;
  fallback: string;
}
```

示例：

```json
{
  "modelAliases": {
    "default": {
      "strategy": "fixed",
      "fallback": "openrouter-claude-sonnet"
    },
    "opusplan-like": {
      "strategy": "mode-switch",
      "rules": [
        { "when": { "phase": "plan" }, "modelKey": "anthropic-opus" }
      ],
      "fallback": "anthropic-sonnet"
    },
    "auto-ds": {
      "strategy": "composite",
      "rules": [
        { "when": { "isEscalated": true }, "modelKey": "deepseek-v4-pro-thinking" }
      ],
      "fallback": "deepseek-v4-flash-fast"
    }
  }
}
```

`/model auto-ds` 只改变 active alias。真正每一轮使用哪个底层模型，由 `ModelResolver.resolve(ctx)` 决定。

---

## 6. 自定义 Provider 的兼容方式

V1 不建议让用户在 `settings.json` 里写任意 JS 函数；但可以分两档。

### 6.1 声明式扩展

适合 OpenAI-compatible 但有少量私有参数的 provider。

```json
{
  "providers": [
    {
      "key": "my-openai-compatible",
      "kind": "openai-compatible",
      "transport": "openai-chat",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_PROVIDER_API_KEY",
      "requestDefaults": {
        "extra_body": {
          "some_vendor_flag": true
        }
      },
      "parameterPolicy": "warn"
    }
  ]
}
```

### 6.2 Adapter Hook 扩展

适合真正原生 provider。Hook 必须显式注册，且只从受信任路径加载，例如项目 `.code-shell/providers/*.ts` 或用户 `~/.code-shell/providers/*.js`。

```ts
export default defineProviderAdapter({
  name: "my-native-provider",
  transport: "custom-adapter",
  buildRequest(ctx) {
    return {
      url: `${ctx.provider.baseUrl}/generate`,
      headers: { Authorization: `Bearer ${ctx.provider.apiKey}` },
      body: mapToVendorBody(ctx),
    };
  },
  parseResponse(raw) {
    return mapToLLMResponse(raw);
  },
});
```

安全边界：

- 默认禁用 arbitrary adapter loading。
- 第一次启用某个 adapter module 时需要用户确认。
- 项目级 adapter 只允许在当前 workspace 读写，不能自动加载全局未知代码。
- 对声明式 provider，永远优先于代码 hook。

---

## 7. 实施建议

### Phase 1：抽象层但不改行为

1. 新增 `ProviderAdapter` 接口。
2. 把现有 OpenAI Chat 和 Anthropic Messages client 包一层 adapter。
3. `ModelResolver` 支持 `activeKey -> model entry`，保持现状。
4. 增加 provider/model capability metadata，但先不强依赖。

### Phase 2：官方 provider 原生化

1. `OpenAIResponsesAdapter`：支持 `reasoning.effort`、`text.verbosity`、Responses state replay。
2. `DeepSeekAdapter`：支持 `extra_body.thinking`、`reasoning_effort`、`reasoning_content` replay。
3. `ZaiAdapter`：支持 `thinking`、`tool_stream`、`reasoning_content`。
4. `GeminiAdapter`：支持 `generateContent`、`thinkingLevel/thinkingBudget`、thought signatures。

### Phase 3：alias / mode-switch

1. 加 `modelAliases`。
2. `/model` 可以选 model entry 或 alias。
3. TurnLoop 每次 model call 前调用 `ModelResolver.resolve(ctx)`。
4. 实现 `opusplan-like` 和 `auto-ds` 都走同一个 resolver，不在 Engine 里写特殊分支。

### Phase 4：自定义 provider

1. 声明式 `requestDefaults` / `parameterPolicy`。
2. 受信任 adapter module hook。
3. provider probe：启动或选择模型时做轻量能力探测，缓存 `tools/streaming/reasoning/structuredOutput` 支持状态。

---

## 8. 关键原则

1. UI 只展示 logical model key / alias，不展示 provider body 细节。
2. Engine 只表达统一意图，不直接拼 provider 私有参数。
3. Adapter 必须同时负责 request 和 response/state replay，不能只管发请求。
4. OpenRouter 是一个 provider，不是我们的内部抽象层；不能把它的“忽略未知参数”当成强语义。
5. 官方 provider 的高级能力优先走原生 adapter，OpenAI-compatible endpoint 只能作为 fallback。

---

## 9. 官方参考

- OpenRouter API: https://openrouter.ai/docs/api/reference/overview
- OpenRouter provider routing / `require_parameters`: https://openrouter.ai/docs/guides/routing/provider-selection/
- OpenAI GPT-5.5 / Responses API guidance: https://developers.openai.com/api/docs/guides/latest-model
- Gemini thinking / thought signatures: https://ai.google.dev/gemini-api/docs/thinking
- DeepSeek thinking mode: https://api-docs.deepseek.com/guides/thinking_mode
- Z.AI GLM-5.1: https://docs.z.ai/guides/llm/glm-5.1
- Z.AI GLM-5.1 migration: https://docs.z.ai/guides/overview/migrate-to-glm-new
- Claude Code model configuration: https://docs.claude.com/en/docs/claude-code/model-config

---

**End of Design Doc**
