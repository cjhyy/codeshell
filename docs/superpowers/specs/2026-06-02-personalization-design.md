# 设置页 · 个性化重做 — 设计文档

**日期:** 2026-06-02
**状态:** 设计待 review

## 背景

设置页「个性化」当前只有一个「自定义指令」Textarea,接到 `settings.agent.appendSystemPrompt`。
经排查(见 `docs/prompt-assembly-current.html`),system prompt 由 6 个有序片段组成,
其中只有 `appendSystemPrompt` 暴露给了用户。本次在不引入"历史包袱"的前提下,
让个性化面板覆盖两件用户真正想配的事:回复偏好(语言/称呼)与指令文件兼容性。

### Prompt 组装的关键事实(设计依据)

- 个性化字段最终都汇入 `PromptComposer`(`packages/core/src/prompt/composer.ts`),
  由其拼出 system prompt 与前置的 `<system-reminder>` user message。
- 一次 LLM 请求,两个逻辑通道:system 字段 + messages 数组。具体落哪个字段由 provider
  client 决定(Anthropic 拆 `system`/`messages`;OpenAI 全在 `messages` 用 role 区分)。
  **个性化设计无需关心 provider 差异 —— composer 之下已抽象掉。**
- subagent 复用同一个 PromptComposer,配置从父 Engine 继承。**凡走
  `settings → EngineConfig → ComposerOptions` 这条线注入的字段,subagent 自动继承,
  无需额外写继承逻辑。**

## 范围

两块,均为个性化语义。明确**不含** preset、`customSystemPrompt`、git status 开关、
缓存优化、instruction-scanner 冗余清理。

### 关于已被故意砍掉的字段(设计依据,不做)

`AdvancedSections.tsx:34-38` 的注释记录了一个既有决定:`customSystemPrompt` /
`instructions.fileName` / `scanDirs` 等"较重的指令旋钮"当初为**对齐 Codex 极简风格**
被有意从该 tab 移除,仅保留一个映射到 `appendSystemPrompt` 的「自定义指令」框。

本次**尊重这个决定,不暴露 `customSystemPrompt`**:

- 现有「自定义指令」框写的是 `appendSystemPrompt`(`AdvancedSections.tsx:50,64`),
  位于 system prompt **最末尾**(第 6 段)。它是"补充说明",在 preset 行为准则之后,
  **不会覆盖或扰乱默认行为** —— 对普通用户更安全。
- `customSystemPrompt` 位于**第 2 段、行为准则之前**(`composer.ts:144-150`),是
  "高优先级前置定调"。它**不是覆盖式**(后面的 preset 段照样保留),但靠前 → 更易把
  agent 带偏。属高级场景。
- 结论:**只保留一个自定义框,留现有的 append**(零迁移 + 更安全 + 更符合"附加说明"
  的用户直觉)。
- **高级逃生通道(无需开发,现状已满足):** 真要改靠前的 section 的用户,直接在
  `~/.code-shell/settings.json`(或项目 `.code-shell/settings.json`)写
  `agent.customSystemPrompt` 即可 —— 该字段已在 schema、composer 已消费。
  "平时不展示、需要时能改到"这个目标**不需要任何代码改动**,本 spec 只是把它记录在案,
  避免后人误以为是漏做。

> 修正:本文件早期版本曾把 `customSystemPrompt` 描述为"覆盖式/替换默认系统提示" —— 不准确。
> 它只是多 push 一个靠前的 section,不替换 preset 段。

### 第 1 块 · 新增字段:回复语言 + 称呼/画像

两个新字段,需贯穿 schema → EngineConfig → ComposerOptions → composer section。

| 字段 | 含义 | 示例 |
|---|---|---|
| `responseLanguage` | 期望的回复语言 | "始终用简体中文回复" |
| `userProfile` | 称呼 / 用户画像 | "叫我 maki,后端工程师" |

**注入位置:** 在 `getSections()` 的 `append_system` 片段(`composer.ts:190-196`)**附近**新增一个
`personalization` section。两字段合成一段简短文本,例如:

```
# 关于用户与回复偏好
- 称呼/画像:{userProfile}
- 回复语言:{responseLanguage}
```

仅当至少一个字段非空才 push 该 section(与现有 `append_system` 的可选 push 一致)。

**为什么放 system 而非 messages 链:** 这是稳定偏好(不随对话变),适合进可缓存的 system 前缀;
不像日期/CLAUDE.md 那样易变。

### 第 2 块 · 指令文件配置化:两个兼容开关

把 `scanInstructions()` 的 `compatFileNames`(`instruction-scanner.ts:40-49` 的 `ScanOptions`)
暴露成两个勾:

| UI 勾选 | 映射 | 默认 |
|---|---|---|
| ☑ 兼容 Claude | `compatFileNames` 含 `"CLAUDE.md"` | 开(向后兼容) |
| ☑ 兼容 Codex | `compatFileNames` 含 `"AGENTS.md"` | 开(向后兼容) |

- 主文件名**写死** `"CODESHELL.md"`(`ScanOptions.fileName` 不暴露)。无自定义输入框。
- **关闭语义:只去掉同名 `.md`。** 关"兼容 Claude" = compatFileNames 去掉 `CLAUDE.md`;
  `.claude/` 子目录、`CLAUDE.local.md`、`.claude/rules/` **不联动**(用得少,不值得为它改 scanner)。
- 其余 scanner 行为保持现状、不暴露:rules/ 目录扫描、`*.local.md`、git 边界、
  `.codeshell`/`.claude` 子目录探测、user/project/local 分层与 depth 优先级。
- **接线缺口:** composer 的 `getInstructions()` 已支持传 `instructionOptions`(`composer.ts:201-206`),
  但当前**没人从 settings 喂它**。本块要补这条线:settings → EngineConfig → ComposerOptions.instructionOptions。

## 数据结构 / Schema

`packages/core/src/settings/schema.ts` 的 `agent` object 新增:

```ts
agent: z.object({
  // ...现有...
  appendSystemPrompt: z.string().optional(),    // 已有,不改
  responseLanguage: z.string().optional(),      // 新增
  userProfile: z.string().optional(),           // 新增
  instructions: z.object({                      // 新增 — 指令文件兼容开关
    compatClaude: z.boolean().default(true),
    compatCodex: z.boolean().default(true),
  }).optional(),
})
```

> 注:`customSystemPrompt` 保留在 schema 中(已存在),本次不动、不进 UI。
> `instructions` 用嵌套 object,为后续可能的扩展留位;若团队偏好扁平,可改成
> `compatClaude` / `compatCodex` 两个顶层布尔。实现时二选一,保持一致。

## 接线链路(端到端)

```
settings.json (agent.*)
  → EngineConfig (engine.ts: 新增字段声明)
  → ComposerOptions (composer.ts: responseLanguage/userProfile/instructionOptions)
      ├─ getSections(): 新增 personalization section(语言+画像)
      └─ getInstructions(): 把 compat 开关拼成 ScanOptions.compatFileNames 传入 scanInstructions()
  → 子 Engine spawn 时随 EngineConfig 继承 → subagent 自动惠及
```

- `responseLanguage` / `userProfile`:需新增 schema 字段 + EngineConfig 字段 + ComposerOptions
  字段 + composer section。
- 指令兼容开关:需新增 schema 字段 + 在构造 ComposerOptions 时把布尔拼成
  `compatFileNames` 数组喂给 `instructionOptions`。

## UI

`packages/desktop/src/renderer/settings/AdvancedSections.tsx`。现有 `PersonalizationSection`
(单一「自定义指令」框 = `appendSystemPrompt`)**保持不动**,在其旁新增 **2 个独立 section**:

1. **个性化** — `responseLanguage`(单行输入)+ `userProfile`(Textarea)
2. **指令文件** — ☑兼容 Claude · ☑兼容 Codex 两个勾,附一行说明扫描的是哪些文件名

沿用现有 `ScopedProps` / `getSettings` / `writeSettings` 模式(scope + cwd),与当前
PersonalizationSection 的读写方式一致。遵循 desktop CLAUDE.md:用 `@/components/ui` 的
Switch/Textarea/Input,Tailwind 语义 token,不手写原生控件。

## 测试策略(TDD)

- **core 单测:**
  - composer 新 personalization section:给定 responseLanguage/userProfile → 断言 system prompt
    含对应文本;两者为空 → 不 push 该 section。
  - `getInstructions()` 接 instructionOptions:compatClaude=false → 断言扫描结果不含 CLAUDE.md
    来源;compatCodex=false → 不含 AGENTS.md。
  - schema 解析:默认值正确(两个 compat 默认 true)。
- **继承验证:** spawn 子 Engine,断言子 agent 的 ComposerOptions 带上了父的 responseLanguage/
  userProfile/instructionOptions。
- **UI:** 读写往返(写入 settings → 读回显示)。

## 非目标(明确不做)

- preset 进 UI(过重,连带工具集/权限)
- git status / `injectGitStatus` 开关
- prompt caching 优化(messages 滚动断点、git status 移出前缀)
- instruction-scanner 冗余清理(如 `~/.claude/AGENTS.md` 这种不存在的组合探测)
- 自定义指令文件名、rules/ 暴露、local 覆盖暴露、git 边界开关
