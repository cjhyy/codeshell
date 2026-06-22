# 插件 MCP 的 env/credential 覆盖层

- 日期:2026-06-22
- 状态:设计已确认,待实现
- 范围:packages/core(存储 + merge + schema) + packages/desktop(UI)

## 背景与目标

插件自带的 MCP server(来自 plugin manifest 的 `.mcp.json` / `mcp-servers.json`)
当前在设置页是**纯只读**:`isEditableMcpServer` 用 `source==="plugin"` /
`editable:false` 挡掉一切编辑,用户只能开关整个插件或走项目级
`capabilityOverrides.mcp.<server>` 强制 on/off。

真实痛点:插件带了一个 MCP(例如 github MCP),但连接需要的 token/环境变量得
用户自己提供 —— 现在**完全没有入口**,用户只能放弃使用或 fork 插件。

目标:让用户给插件 MCP **补充** env / credential,且这些补充值存在独立的
override 层,**插件更新/重装不会冲掉**。command/args/url 这类插件核心定义
仍由插件掌控,用户不可改(要改就该 fork 插件)。

## 关键约束(设计核心)

1. **只允许补充类字段**:override 只能携带
   `env` / `envVars` / `credentialRef` / `bearerTokenEnvVar` / `envHeaders`。
   **不含** `command` / `args` / `url` / `transport` —— schema 层就拒绝,从根上
   防止「影子整个插件 config 导致插件更新后用户拿陈旧 command/url」这个坑
   (参考既有教训:重装会丢上游改动)。
2. **override 只对纯插件来源的 server 生效**:用户**自己手动添加**的 MCP
   (走 `mcpServers`/settings)保持现有行为不变,仍可整体编辑。

## 1. 存储模型(core)

新增全局设置字段 `mcpServerOverrides`,**只存全局**(`~/.code-shell` 用户设置层,
不做项目级 —— MCP server 本身是全局连接语义,项目级只有 capabilityOverrides 的
on/off,不引入项目级 server 定义这个新概念):

```jsonc
{
  "mcpServerOverrides": {
    "github:server": {              // key = 插件 MCP 的 <plugin>:<server>
      "env": { "FOO": "bar" },       // stdio 明文环境变量
      "envVars": ["GITHUB_TOKEN"],   // stdio 转发系统环境变量(只存名)
      "credentialRef": "...",        // HTTP 凭证引用
      "bearerTokenEnvVar": "...",    // HTTP Bearer token 环境变量名
      "envHeaders": { "X-Key": "MY_ENV" } // HTTP header→环境变量名
    }
  }
}
```

schema(`packages/core/src/settings/schema.ts`):新增 `mcpServerOverrides` 为
`Record<string, OverrideShape>`,其中 `OverrideShape` **只**包含上述 5 个字段,
显式不接受 command/args/url/transport(多余字段被 strip 或拒绝)。

## 2. Merge 语义(core,`packages/core/src/plugins/installer/loadPluginMcp.ts`)

现状:`mergePluginMcpServers(base, disabledPlugins)` 把每个插件 MCP 以
`<plugin>:<server>` 为 key merge 进 `base` 的拷贝;若 key 已在 `base`
(用户手加)中存在则 user 整体胜出、跳过插件项(`loadPluginMcp.ts:72`)。

改造:`mergePluginMcpServers` 增加一个 `overrides` 入参
(`Record<string, OverrideShape>`)。对**纯插件来源**的 server(即 key 不在
`base` 中、由插件提供的项),把 override 的补充字段叠加到插件原始 config 上,
**override 胜出**:

```
finalConfig = {
  ...pluginConfig,
  ...pick(override, [env, envVars, credentialRef, bearerTokenEnvVar, envHeaders])
}
```

规则细化:
- `command` / `args` / `url` / `transport` 永远来自 `pluginConfig`,override 无权覆盖。
- 用户自加 server(key 命中 `base`)仍走现有 user-wins 整体胜出逻辑,**不叠加** override。
- disabled 插件仍整体跳过(现有行为不动)。
- override 里某字段缺省时,保留插件原始同名字段(纯叠加,不是整体替换)。

connect 路径(`mcp-manager.ts` 的 `buildStdioEnv` / `buildHttpHeaders`)**不改** ——
它们只认最终 config,merge 在上游 `mergePluginMcpServers` 完成。

调用点:所有调用 `mergePluginMcpServers` 的地方(engine connect 路径 +
desktop `mcp:listMerged` IPC)需把全局 `mcpServerOverrides` 传入。

## 3. UI(desktop)

### IPC(`packages/desktop/src/main/index.ts`)
- `mcp:listMerged` 读取全局 `mcpServerOverrides` 并传给 `mergePluginMcpServers`,
  使返回的插件 server 的 env/credential 字段已是 merge 后的有效值。
- 每个 server 项继续带 `source` / `editable` / `pluginDisabled`;新增一个标记
  位(如 `hasOverride: boolean`)供 UI 画 badge。

### McpSection / McpEditor(`packages/desktop/src/renderer/settings/McpSection.tsx`)
- 插件 MCP 行复用现有 ✏️ 编辑入口,但打开的 `McpEditor` 进 **override 模式**:
  - `command` / `args` / `url` / `transport` 置灰只读(展示插件原始值,让用户看清这是哪个 server)。
  - 放开 `env` / `envVars`(stdio) 与 `credentialRef` / `bearerTokenEnvVar` / `envHeaders`(HTTP)。
- 保存:override 模式写 `mcpServerOverrides[name]`(全局 scope),**不写** `mcpServers`。
  普通模式(用户自加 server)行为不变,仍写 `mcpServers`。
- 已有 override 的插件行加小 badge(如「已补凭证」/「已补环境变量」),走 i18n。
- 测试连接 / probe:用 merge 后的有效 config(已含 override),保证「测试连接」
  看到的就是真实连接态(延续本批已修的 credentialRef 入 probe 的方向)。

## 4. 生效时机

走现有配置热重载(`settingsBus → configure({reloadSettings}) → reconcile`),
改完下一条消息生效,与现有 MCP 编辑一致。无需新机制。

## 5. 测试

**core**
- `mergePluginMcpServers`:
  - 插件 server + override → env/credential 字段被叠加,override 胜出。
  - override 不含 command 时,插件原始 command 保留。
  - override 不影响用户自加(命中 base)的 server。
  - disabled 插件仍整体跳过。
  - override 引用了不存在的插件 server key → 无副作用(不凭空造 server)。
- schema:`mcpServerOverrides` 项含 command/url 时被拒绝或 strip。

**desktop**
- `McpEditor` override 模式:command/args/url 只读不可编辑。
- 保存插件 MCP 的 env → 写入 `mcpServerOverrides`,不污染 `mcpServers`。
- `isEditableMcpServer` 与 override 模式的交互:插件 server 可进入 override 编辑,
  但不可改身份字段。

## 非目标(YAGNI)

- 不做项目级 override(MCP 全局连接语义)。
- 不放开插件 server 的 command/args/url/transport。
- 不为用户自加 server 引入 override 概念(它们本就可整体编辑)。
- 不改 connect 期的 `buildStdioEnv`/`buildHttpHeaders` 实现。
