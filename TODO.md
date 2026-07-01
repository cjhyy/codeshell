# TODO

整理范围：来自 2026-07-01 Codex 规划与 Claude Code 只读复核。本文只记录待办与复核结论，不包含修复实现。

排序规则：按最终优先级归档为 `Critical` / `High` / `Medium` / `Low` / `Follow-up / 待复核` / `Hardening / Product TODO` / `已核实未作为 Bug`。原分轮来源只在必要时进入条目正文，不再作为 section 标题。

> 状态复核（2026-07-01，用 Explore agent 逐条核对源码）：Critical + High 前 9 项已在 commit `d9541fc9`（另含 ws-trust-v2）修复合入 main，下方标 `[x]`。其余 High/Medium/Low 逐条核对结论标注在条目正文。

## Critical

- [x] **项目级 `.code-shell/settings.json` 无 workspace-trust 门，克隆恶意仓库即可影响执行** — 已修(ws-trust-v2 合入 main)：SettingsManager 加 trust 参数,未信任项目 strip 危险字段(env/permissions/hooks/mcpServers/localEnvironment),desktop trust-store 接线 + TrustDialog 展示。
  - 影响：打开第三方仓库时，仓库内可被 git 跟踪的 `.code-shell/settings.json` 会被无条件信任；其中 `permissions.rules` 可自授权，`env` 可注入 `BASH_ENV` / `NODE_OPTIONS` / `LD_PRELOAD` / `PATH`，下次 Bash 工具执行可能触发攻击者代码。
  - 相关文件：`packages/core/src/settings/manager.ts:96-102`；`packages/core/src/engine/engine.ts:2663-2668,2947-2980`；`packages/core/src/settings/schema.ts:496-498`；`packages/core/src/state.ts:29,50-51`。
  - 复核补充：项目 `mcpServers` 自动连接子面被削弱，因当前实现读取 worker boot cwd，不一定是当前 session cwd；但 env / permissions 子面仍成立。
  - 修复方向：引入 workspace trust；未信任项目的危险字段（`permissions.rules`、`env`、`hooks`、`mcpServers`、`localEnvironment`）默认不生效或必须用户确认。未 trust 前项目层 rules 不允许 `allow`；trust 后允许但必须可见、可撤销、可审计。env 过 denylist，MCP/Hook 需确认。
  - 回归验证：tmp repo 中 `.code-shell/settings.json` 含恶意 env + permissions，打开该 cwd 后未经 trust 不应生效。

## High

- [x] **MCP 跨会话/会话内授权绕过，通用 MCP builtin 无视 `ctx.allowedMcpServers`** — 已修(d9541fc9)：executor 门扩展覆盖 MCPTool/ReadMcpResource(按 server 校验)+ListMcpResources 注入 `__allowedMcpServers` 过滤;ReadMcpResource 去 preset 无条件 allow 改 tool-level ask。+5 TDD。
  - 影响：共享 worker 下，A 会话可调用/列举/读取只为 B 会话启用的 MCP server 的工具与资源；同一会话内，`ReadMcpResource` / `ListMcpResources` 也可在 default 模式无确认读取任意已连接 MCP server 的资源内容。
  - 相关文件：`packages/core/src/tool-system/builtin/mcp-tools.ts`（`mcpToolExecute` / `listMcpResourcesTool` / `readMcpResourceTool` 直接 `MCPManager.getInstance()`，签名不接 `ctx`）；`packages/core/src/tool-system/executor.ts:153-165`（只拦 `reg.source === "mcp"`）；`packages/core/src/preset/index.ts:87-89,147-148`（普通会话默认可见，资源工具 explicit allow）。
  - 调用链：A 调 `ListMcpResources` → `MCPManager.getInstance().listResources(undefined)` → 返回共享 manager 里所有 server 资源；`MCPTool(server:"X")` 同理可调用未授权 server 的工具。
  - 修复方向：三个 builtin 接收并校验 `ctx.allowedMcpServers`；未授权 server 直接拒；去掉资源工具 unconditional preset allow，至少按 server/resource 来源走 ask/allowlist。
  - 回归验证：A 启用 serverA、B 启用 serverB 时，A 不应看到 serverB 资源；`MCPTool(server:"serverB")` 在 A 会话应被拒；default 模式读取 MCP resource 不应零审批通过。

- [x] **`Config` / `config_set` / `provider_add` / `settings:set` 无 key allowlist，可写任意信任根字段** — 已修(d9541fc9)：新增 `isProtectedSettingKey`,config_set 拒写 permissions/env/hooks/mcpServers/mcpServerOverrides/localEnvironment 信任根。+2 TDD。备注:desktop `settings:set`(受信 UI 写路径)未收紧,仅堵协议对端 config_set。
  - 影响：任何能发协议/IPC 的对端（renderer XSS、配对手机、外部 driver）可写入 `permissions.rules`、`env`、`hooks`、`mcpServers` 等危险字段，等价远程触发 workspace trust 缺口。
  - 相关文件：`packages/core/src/tool-system/builtin/config.ts:47-78`；`packages/core/src/protocol/server.ts:1242-1245`；`packages/core/src/engine/engine.ts:2612-2613`；`packages/core/src/settings/manager.ts:222-259`；`packages/core/src/settings/schema.ts:595`；`packages/desktop/src/main/index.ts:2535-2541`；`packages/desktop/src/main/settings-service.ts:84-117`。
  - 修复方向：危险字段必须走专门写路径和用户确认；通用 `Config` / config/settings 写入只允许安全字段 allowlist。
  - 回归验证：`Config(action:"write", key:"permissions.rules", ...)` / `config_set("permissions.rules", ...)` / `settings:set({ permissions: { rules: [...] } })` 应被拒或要求确认。

- [x] **TUI Stop / `/force` / Ctrl+C 在 multi-session 模式下不真正取消运行** — 已修(d9541fc9)：三处 `client.cancel()` 传 `sidRef.current ?? sessionId ?? ""` + reason,`.catch` 改 `uiLog.warn`。
  - 影响：用户按 Esc / Ctrl+C / `/force` 后，UI 乐观置 idle，但底层 run 继续跑、继续烧 token、继续写 transcript；在途 approval 也不会被取消。
  - 相关文件：`packages/tui/src/ui/App.tsx:1070,1129,1436`（三处 `client.cancel()` 不传 sessionId 且 `.catch(() => {})`）；`packages/core/src/protocol/client.ts:172-173`；`packages/tui/src/cli/commands/repl.ts:200-228`；`packages/core/src/protocol/server.ts:603-609,621,629`；`packages/tui/src/ui/App.tsx:1228,1285-1286`。
  - 结论：确认。multi-session server 要求非空 `sessionId`，TUI cancel 漏传后直接返回 `InvalidParams "sessionId is required"`，错误又被吞掉。
  - 修复方向：三处 cancel 都传 `client.cancel(sidRef.current ?? sessionId ?? "")`；`.catch` 至少 `logger.warn`。
  - 回归验证：multi-session 下长 run 按 Esc/`/force`/Ctrl+C，server 收到带 sessionId 的 cancel，`ChatSession.cancel()` 被调用，引擎 controller abort，在途审批被 cancelled。

- [x] **桌面主聊天 AskUserQuestion 在冷表 + 并发/当前会话存在时串错 session** — 已修(d9541fc9)：ask_user/bypass 走 `resolveBucket`(冷表回退磁盘 index);AskUserMessage 带 originating `engineSessionId`;答复用 `findAskUserOrigin` 按 requestId 找源桶回包。+4 TDD。
  - 影响：后台 session A 发 AskUserQuestion 时，如果 renderer remount/HMR/崩溃恢复导致 `engineToBucketRef` 冷表，且存在其它 running/active bucket B，AskUser 气泡会落到 B；用户在 B 作答后，core 在 B 的 `pendingApprovals` 找不到 requestId，A 的 pending approval 挂到超时。
  - 相关文件：`packages/desktop/src/renderer/App.tsx:1651-1665,2717-2738`；`packages/desktop/src/renderer/types.ts:187-201`；`packages/core/src/protocol/server.ts:543-575`；对照安全路径 `packages/desktop/src/renderer/App.tsx:1704-1724,494-534,520`。
  - 边界：纯并发且 `engineToBucketRef` 热表时通常不触发；关键是“冷表 + 跌到 running/activeBucket”。bypass 子面因回包使用 `env.sessionId`，只保留 Low 子风险。
  - 修复方向：ask_user 与 bypass 的 bucket 解析统一复用 `resolveBucket`/engineToBucketIndex；解析不到时 warn/不落桶；`AskUserMessage` 增加 originating `engineSessionId` 或 bucket，`handleAskUserAnswer` 据此回包；approve 失败至少 log。
  - 回归验证：A/B 两 session，模拟 remount 清空 `engineToBucketRef` 但保留磁盘/索引，A 发 ask_user；断言气泡落 A，作答后 approve 带 A 的 engineSessionId，A 的 pendingApprovals resolve。

- [x] **cloudflared 二进制下载无 checksum/签名校验，且 URL 指向 `latest`** — 已修(d9541fc9)：pin 版本 `2026.6.1` + 内置 5 资产 SHA-256 表 + `verifyAssetDigest` 在 chmod/rename 前比对,不符抛错清 tmp。+6 TDD。备注:未做 redirect host 白名单/cosign(留加固)。
  - 影响：`mobileRemote:downloadCloudflared` 或 `mobileRemote:start{mode:"tunnel"}` 会下载原生可执行文件，落盘后 `chmod 0o755` 并以桌面用户权限执行。下载内容只校验非空，不校验 SHA-256/签名；URL 指向 GitHub `releases/latest/download`，无法审计固定版本。
  - 相关文件：`packages/desktop/src/main/index.ts:1981,2054-2060`；`packages/desktop/src/main/mobile-remote/cloudflared-binary.ts:28-42,108-127,138-164,168-209`；`packages/desktop/src/main/mobile-remote/tunnel-manager.ts:109`。
  - 修复方向：固定 cloudflared 版本 tag，内置各平台/arch 对应 SHA-256；在 chmod/rename 前计算 digest 并比对，不符删除 tmp 并拒绝。可选：验证官方 checksum/cosign、限制 redirect host、加固 tar 解压。
  - 回归验证：mock download 写入错误字节时 `ensureBinary` 抛 digest mismatch 且 final path 不存在；匹配 hash 时才安装；URL 不含 `/latest/`；非白名单 redirect host 被拒。

- [x] **`agent-server-stdio` 启动时 `validateSettings` 未捕获，合法 JSON 但 schema 错误会崩 worker** — 已修(d9541fc9)：bootstrap `settingsManager.get()` 包 try/catch,ZodError 回退 `validateSettings({})` 默认 + 截断可读 stderr。
  - 影响：用户手编 settings 时，只要 JSON/YAML 语法合法但字段类型/枚举错误，`SettingsSchema.parse` 抛出的 ZodError 会在 worker 顶层未捕获，桌面/手机遥控表现为连接丢失、卡住或 worker 非零退出。
  - 相关文件：`packages/core/src/cli/agent-server-stdio.ts:93-94`；`packages/core/src/settings/manager.ts:162,398-399,416-423`；`packages/core/src/settings/schema.ts:599-601`。
  - 高频 payload：`permissions.rules[0].decision:"allowed"`、`permissions.defaultMode:"ask"`、`mcpServers.fs.args:"server-filesystem"`、`mcpServerOverrides.*.command`、对象字段写成标量、`context.compactAtRatio:1.5`、`env.FOO:123`、`credentialUse.autoApprove:"yes"`。
  - 修复方向：bootstrap 包 try/catch，ZodError 输出安全截断的可读错误并退出；或引入 `safeValidateSettings`，对坏配置回退最小配置 + warn。
  - 回归验证：临时 HOME 写入上述 payload，spawn `agent-server-stdio` 或抽出的 `loadSeedSettings()`，应得到可读错误/可用回退，而不是裸 ZodError 崩溃。

- [x] **project `mcpServers` 读取 worker boot cwd 而非 session cwd，跨项目 MCP 配置串线/失效** — 已修(d9541fc9)：agent-server-stdio engineFactory 改按 `sessionCwd` 新建 SettingsManager 读 live(mcpServers/agent.*/personalization),不再用 boot cwd 快照。
  - 影响：一个 worker 服务多个项目时，后续项目 session 的 project MCP 配置来自 worker 首次 spawn 的 cwd，而不是当前 session cwd。B 项目 `.code-shell/settings.json` 的 `mcpServers` 不生效，反而可能连接 A/no-repo 的 project MCP server。
  - 相关文件：`packages/desktop/src/main/agent-bridge.ts:117-119,253-258`；`packages/core/src/cli/agent-server-stdio.ts:88,93,177-183,230-234`；对照 `packages/core/src/cli/agent-server-stdio.ts:202-205` 与 `packages/core/src/engine/engine.ts:2664,2947-2966`。
  - 修复方向：`mcpServers`、agent personalization 等 session 相关 project settings 应按 sessionCwd 读取，与 permissions/env/disabledPlugins 语义统一。
  - 回归验证：worker boot cwd=A，随后创建 cwd=B 的 session；断言该 session 只包含 B 的 project MCP server，不包含 A-only server。

- [x] **UseCredential/CredentialStore 无视 engine settingsScope，project/isolated 引擎仍可读宿主凭证** — 已修(d9541fc9)：CredentialStore.list/resolve/listMasked 加 scope 形参;ToolContext 加 settingsScope;engine 下发;project/isolated→只读 project 层。+3 TDD。
  - 影响：SDK 嵌入或 isolated/project scope 引擎本应不继承宿主 `~/.code-shell`，但凭证工具仍可能看到 user credentials，并读取宿主 `credentialUse.autoApprove`，造成隔离破坏。
  - 相关文件：`packages/core/src/credentials/use-credential-tool.ts:125-132,139,149`；`packages/core/src/credentials/store.ts:147-152`；对照 `packages/core/src/credentials/store.ts:173-188` 与 `packages/core/src/engine/engine.ts:2973`。
  - 修复方向：`CredentialStore` 增加 scope；project/isolated 下只读 project 层；`readAutoApprove` 按 engine settingsScope 读取；scope 经 ToolContext 传入 UseCredential。
  - 回归验证：user 凭证 + user autoApprove 下，以 project scope 跑 `UseCredential(userCred)` 应不可见/不放行。

- [x] **校验 mobile remote `roomId`，避免 room 存储路径穿越** — 已修(d9541fc9)：`isValidRoomId`=`^room_[a-z0-9]+_[a-z0-9]+$`,roomDir 单一 chokepoint 守卫;读路径返回安全默认不抛,写/open/send/close 经 getRoom 先挡。+TDD。
  - 影响：已配对手机端或可发 WS 消息的同网攻击者可能路径探测/读写 rooms 根外的 `messages.jsonl`。
  - 相关文件：`packages/desktop/src/main/mobile-remote/room-manager.ts`；`packages/desktop/src/main/index.ts`。
  - 问题：`roomDir/metaPath/msgPath` 直接 `join(rootDir, id, ...)`，外部 `room.open/history/send/close` 事件传入的 `roomId` 未校验格式。
  - 修复方向：所有 room manager 公共入口强制校验 `^room_[a-z0-9]+_[a-z0-9]+$`，非法 id 直接 missing/空响应。
  - 回归验证：`getRoom/getMessages/open/send("../x")` 不触碰 rootDir 外路径。

- [x] **修复浏览器自动化桥接丢失 `value/key/refs/tabId` 参数** — 已修(d9541fc9)：`parseBrowserActionLine` 补齐 value/key/refs/tabId 透传(带类型守卫)。+2 TDD。
  - 影响：`selectOption`、`pressKey`、`fetchImages`、`switchTab` 静默失效。
  - 相关文件：`packages/desktop/src/main/browser-driver/intercept.ts`；`packages/desktop/src/main/browser-driver/automation-host.ts`。
  - 问题：`automation-host.ts` schema/handler 消费 `value`、`key`、`refs`、`tabId`，但 `intercept.ts` 解析时没有透传这些字段。
  - 修复方向：在 `parseBrowserActionLine` 构造 request 时补齐字段并做类型校验。
  - 回归验证：新增 intercept 单测，覆盖 selectOption/pressKey/fetchImages/switchTab 四类 action 的参数透传。

- [ ] **校验插件缓存路径 segment，避免 marketplace manifest 写出 cache root** — 【核对 2026-07-01：确认 NOT DONE — `pluginCacheDir()` 直接 join,`materialize()` 从 manifest 取 marketplace/plugin 不调 `assertSafePluginName()`】（唯一剩余 High）
  - 影响：供应链路径穿越；恶意 marketplace manifest 可将插件缓存写出 cache root。
  - 相关文件：`packages/core/src/plugins/pluginInstaller.ts:43-44,191,209,235,257`；`packages/core/src/plugins/installer/paths.ts:10-16`。
  - 问题：manifest 中进入缓存路径的 marketplace/plugin/version path segment 进入 `join(cacheRoot, marketplace, plugin, version)`，但未复用本地 install 路径已有的安全名称校验。注意：这不同于下方 Low 的 marketplace root name latent 项。
  - 修复方向：对 marketplace、plugin、version 做 path segment 校验；或在 `pluginCacheDir` 内做 containment check。
  - 回归验证：manifest entry name 含 `/`、`..`、`\0` 时安装失败，且不在 cache root 外落盘。

## Medium

- [ ] **自动化/cron full 档可调 DriveAgent 绕开 tier+sandbox（外部 CLI 无沙箱）** — 【核对 2026-07-01：确认 NOT DONE — `AUTOMATION_DISABLED_TOOLS` 只禁 cron 三件套,不含 DriveAgent/DriveClaudeCode】
  - 严重级别：Medium。前置是存在 `permissionLevel:"full"` 的 cron/automation run；read-only/workspace-write 档会被 TierApprovalBackend 正确拒绝。
  - 影响：full 档 cron run 可调用 DriveAgent → 外部 claude/codex 以 `bypassPermissions` + 无 seatbelt 运行，打破 automation write-policy“即使 full 也逃不出 workspace”的不变量。DriveAgent 子进程继承 worker 真实 `process.env`，不会自动拿到 CodeShell `Credential.exposeAsEnv` 或 settings 顶层 `env`，但用户从带 API key 的 shell 启动桌面/worker 时仍会传给外部 CLI。
  - 相关文件：`packages/desktop/src/main/automationToolset.ts:19-33`；`packages/desktop/src/main/automation-host.ts:105-133`；`packages/core/src/preset/index.ts:84-85,90`；`packages/core/src/tool-system/builtin/drive-claude-code.ts:71-105`；`packages/core/src/cc-orchestrator/external-agent-driver.ts:26-53`；`packages/core/src/sandbox/index.ts:5-9`；`packages/core/src/engine/engine.ts:2947-2981`；`packages/core/src/tool-system/builtin/bash.ts:99-103`。
  - 修复方向：把 DriveAgent / DriveClaudeCode / RemoteTrigger 加入 `AUTOMATION_DISABLED_TOOLS`；或 DriveAgent 识别 automation origin 时拒绝/强制 default+sandbox；外部 CLI env 改成 allowlist。
  - 回归验证：`automationBuiltinTools()` 不含 Drive* / RemoteTrigger；full 档 cron run 调 DriveAgent 被拒/不可见且不 spawn；外部 agent env 不含来自 CredentialStore.envExposures/settings.env 的键。

- [ ] **CronCreate 的 `permissionLevel` 由模型自选 `full`，且 full 档 headless 可无人值守调用 MCP 副作用工具** — 【核对 2026-07-01：确认 NOT DONE — schema enum 无上限约束,描述仅 advisory】
  - 影响：被 prompt-injection 诱导的模型可自建 `permissionLevel:"full"` 的循环 cron job；到点以 bypass 档无人值守执行任意 prompt，并可调用任意 MCP 副作用工具。sandbox 管不住 MCP server 的网络/外部副作用。
  - 相关文件：`packages/core/src/tool-system/builtin/cron.ts:39-45,67-72`；`packages/core/src/automation/scheduler.ts:31,411-437`。
  - 状态：已确认 MCP 子面。`CronCreate` 默认 `default` 模式下分类为 ask，故非静默；但在 auto / DriveAgent bypass 上下文中不弹。credential 工具在 cron full 下无 `askUser` 会 fail-closed，已证伪为非问题。
  - 修复方向：限制模型可申请的最高 `permissionLevel`；对 `full`/`workspace-write` cron 强制用户显式确认且展示 MCP/网络副作用风险；cron 执行时套用 MCP allowlist。
  - 回归验证：cron full 执行 MCP 写/发网络类工具时应被拦截或要求预授权；credential 工具无 askUser 继续 fail-closed。

- [ ] **Bash safe-read 绕过 path-policy，敏感文件/凭证可零审批外泄** — 【核对 2026-07-01：确认 NOT DONE — `SAFE_READ_PATTERNS` 含 `/^env$/`、`/^printenv/`,无敏感路径降级】
  - 影响：`Read ~/.ssh/id_rsa` 走 path-policy 会 ask，但等价的 `cat ~/.ssh/id_rsa` 被 YOLO 分类为 `safe-read`；桌面默认 sandbox=off 下直接自动放行、无审批、无沙箱。`env` / `printenv` 同属 safe-read，会 dump `Credential.exposeAsEnv` 注入的密钥与顶层 `env` 的 API key。
  - 相关文件：`packages/core/src/tool-system/permission.ts:543-564`；`packages/core/src/tool-system/executor.ts:249-261,507-524`；`packages/core/src/engine/sandbox-config.ts:52`；`packages/core/src/engine/engine.ts:2967-2974`。
  - 修复方向：safe-read 分类对命中敏感路径的参数降级为 ask；`env`/`printenv` 在有敏感 env 时降级为 ask；或桌面默认开 seatbelt deniedReads。
  - 回归验证：默认（非 bypass）模式下 `Bash("cat ~/.ssh/id_rsa")`、`Bash("printenv")` 应触发审批而非静默放行。

- [ ] **stdio MCP server 默认继承宿主全量 `process.env`，缺少敏感环境变量过滤** — 【核对 2026-07-01：确认 NOT DONE — `buildStdioEnv()` 直接 spread `process.env`,无过滤】
  - 影响：插件自带或自动连接的 stdio MCP server 可默认获得 CodeShell 进程环境中的 API key、tokens、代理配置等敏感变量；这与用户对 MCP server 的最小授权预期不一致。
  - 相关范围：`packages/core/src/tool-system/mcp-manager.ts`；MCP server stdio 启动 / env merge 相关代码。
  - 状态：已确认。`exposeAsEnv` 只进 Bash 不经 MCP 的说法已证伪为低风险；但 stdio MCP 继承宿主 `process.env` 本身是确认问题。
  - 修复方向：默认只传最小 env（PATH、HOME、必要运行时变量），对 `*_KEY`、`*_TOKEN`、`SECRET`、`PASSWORD`、credential 注入变量等做 denylist/allowlist；项目/用户显式配置的 MCP env 才传入。
  - 回归验证：启动 fake stdio MCP server，断言默认 env 不含测试 API key；显式配置 env 时才出现。

- [ ] **Desktop 普通会话删除只清 renderer localStorage，遗漏 on-disk 会话目录与后台 shell 回收** — 【核对 2026-07-01：确认 NOT DONE — 只有 `source==="automation"` 走 `window.codeshell.deleteSession`,普通会话只 `deleteSessionLocal`】
  - 影响：删普通对话后，`~/.code-shell/sessions/<sessionId>/`（transcript.jsonl + state.json）残留；该会话关联的后台 shell 不被回收，造成孤儿进程与磁盘堆积。
  - 相关文件：`packages/desktop/src/renderer/App.tsx:1132-1172`；`packages/desktop/src/renderer/transcripts.ts:460-466,490-504`；`packages/desktop/src/main/index.ts:2619-2628`；`packages/desktop/src/main/sessions-service.ts:61-81`；`packages/core/src/protocol/server.ts:847-864`；`packages/core/src/runtime/background-shell.ts:479-484`。
  - 结论：确认。普通会话只走 localStorage；IPC 回收路径仅 automation 会话触达。idle sweeper/tab-close 不杀 shell，“显式删除”本应是会 kill 的路径。
  - 修复方向：`handleDeleteSession` 对所有 source 调用 `window.codeshell.deleteSession(engineSessionId ?? sessionId)`；automation 额外 cancelRun/deleteRun；注意 active run 与 id 映射。
  - 回归验证：普通会话开后台 shell → 删会话 → `~/.code-shell/sessions/<id>/` 已删除且该 shell 被 SIGTERM/SIGKILL 回收。

- [ ] **InjectCredential cookie 还原用全局 `lastRunContext.cwd`，可能跨项目注入错账号 cookie**
  - 影响：共享 worker 的多 tab desktop 中，会话 B 触发的 cookie 还原可能按会话 A 的项目 cwd 解析凭证；若两个项目的 `.code-shell/credentials.json` 存在同名 credentialId 但不同账号，则把 A 项目的 cookie 注入到 B 的浏览器会话。
  - 相关文件：`packages/desktop/src/main/agent-bridge.ts:255-258,363`；`packages/desktop/src/main/browser-driver/intercept.ts:91,117`。
  - 结论：确认，触发面较窄：需同名 credentialId 跨项目 + 交错 tab/run。worker 内 InjectCredential / UseCredential 本体使用 per-call `ctx.cwd`，问题只在 host 侧 cookie 还原。
  - 修复方向：在 credential action line 里透传 cwd，或 host 维护 sessionId→cwd 映射，用 `parsed.sessionId` 查正确 cwd，避免读 `lastRunContext.cwd`。
  - 回归验证：项目 A/B 各有同 id 不同账号 cookie 凭证，A/B 交错触发 InjectCredential，B 还原的是 B 项目的 cookie。

- [ ] **移动端审批/房间不绑定设备，任一受信设备可应答他设备审批 / 读写他设备房间**
  - 影响：多台受信设备场景下，设备 B 可应答设备 A 的危险工具审批、读 A 房间 transcript、往 A 房间灌 prompt、起停 A 的房间 agent。未认证 socket 已被拦，故不是 Critical，但属于跨受信设备 confused-deputy。
  - 相关文件：`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:196-216,318-324`；`packages/desktop/src/main/index.ts:923-943,983-991,1008-1009,341-347`；`packages/desktop/src/main/mobile-remote/approval-bridge.ts:34,39-41,58-67`；`packages/desktop/src/main/mobile-remote/room-manager.ts:277,297,367,440`。
  - 问题：auth 成功后有 `deviceId`，但 `handleRoomEvent`/`handleCcRoomEvent` 后续只读 `roomId/sessionId`，不消费 device ownership；approval request/resolve 也 broadcast 给所有已认证设备。
  - 修复方向：房间创建/打开时记录 `ownerDeviceId`；room/ccRoom 操作入口校验 `event.deviceId === ownerDeviceId`；`ApprovalBridge.respond` 增加 deviceId 校验；审批 push 与 history 回包定向发送。
  - 回归验证：两受信设备 A/B，B 对 A room 的 `respondApproval/history/send/open/close` 被拒；approval request 只推给属主设备；属主设备正例不回归。

- [ ] **Markdown/附件图片渲染会零交互读取工作区外任意本地图片文件**
  - 影响：assistant/LLM 输出或网页内容包含 `![](/abs/x.png)`、`<img src="/abs/x.svg">` 等绝对路径图片时，Desktop renderer 会在消息渲染时自动调用 main 进程读取该路径并转成 data URL。本问题不自动外泄，但属于模型/网页内容可控的零点击本地图片读取原语。
  - 相关文件：`packages/desktop/src/renderer/Markdown.tsx:148-150,163-168,352-378`；`packages/desktop/src/renderer/tool-cards/AttachmentCard.tsx:122-137`；`packages/desktop/src/main/index.ts:1723-1735`。
  - 边界：`images:readDataUrl` 只校验绝对路径、扩展名、`lstat`、`isFile`、25MB；无 root/workspace containment。返回 data URL 仅渲染为 `<img>`，不能读取非图片扩展名。
  - 修复方向：`images:readDataUrl` 接收 `root` 并复用 `resolveWithin`；或渲染层先过 rooted `fileExists`；域外路径改为点击确认后读取。
  - 回归验证：含工作区外 `.png/.svg` 的 assistant 消息或 AttachmentCard 不应读取域外路径；工作区内图片仍显示；workspace 内 symlink 指向域外图片应拒绝。

- [ ] **provider `httpHeaders` 自定义 header 值可通过 `config_get("providers")` 明文返回**
  - 当前归档：Medium（偏 Low，但属于确认的敏感信息脱敏缺口）。
  - 影响：`config_get` 面向协议对端做脱敏，但 `httpHeaders` 只按 header 键名匹配 secret 词根；如 `x-custom-auth: s3cr3t` 这类自定义鉴权 header 不匹配词根时会原样返回。
  - 相关文件：`packages/core/src/llm/provider-catalog.ts:19`；`packages/core/src/llm/provider-auth.ts:17-24`；`packages/core/src/protocol/server.ts:1266-1271`；`packages/core/src/engine/engine.ts:2620-2629`；`packages/core/src/protocol/redact.ts:52-57`；`packages/core/src/logging/sanitize-messages.ts:169-170,226-227`。
  - 修复方向：把 `httpHeaders` / `headers` / `defaultHeaders` 容器整块视为敏感，只返回 header key/presence；或对所有 header value 统一 redact。
  - 回归验证：provider 配置 `httpHeaders: { "x-custom-auth": "s3cr3t" }`，`config_get("providers")` 返回中不应包含 `s3cr3t`。

- [ ] **RemoteTrigger 死工具：写 `~/.code-shell/triggers` 后无人消费，任务静默丢失** — 【核对 2026-07-01：确认死工具 — 全仓无 pickup,工具仍在 BUILTIN_TOOLS】
  - 影响：模型调用 RemoteTrigger 后写入 pending JSON 并返回 dispatched 成功；全仓没有 pickup/scheduler/worker 读取该目录，任务永不执行，pending 文件堆积。default 模式会 ask，但用户可能按工具描述批准；auto/bypass 上下文更隐蔽。
  - 相关文件：`packages/core/src/tool-system/builtin/remote-trigger.ts:9-11,44-59`；`packages/core/src/tool-system/builtin/index.ts:38,551-557`；`packages/core/src/preset/index.ts:90`。
  - 复核结论：全仓 grep 只有工具自身、注册、preset 白名单命中；`packages/desktop/src/main`、`packages/core/src/automation`、`packages/core/src/cc-orchestrator` 没有消费 `~/.code-shell/triggers/`。
  - 修复方向：首选从 GENERAL_BUILTIN_TOOLS/BUILTIN_TOOLS 移除 RemoteTrigger，导向 CronCreate/DriveAgent；若保留，则实现 pickup 回路、状态更新和完成通知，并修正文案。
  - 回归验证：移除路线下工具清单不含 RemoteTrigger；实现路线下调用后在有限时间内启动真实执行、trigger JSON 从 pending 变 terminal，并产生完成通知。

- [ ] **后台 sub-agent 失败/取消不发 `agent_end`，TUI 主 feed 的 agent 卡永久转圈** — 【核对 2026-07-01：确认 NOT DONE — agent.ts L512/L526 两 catch 只 markCancelled/markFailed,无 safeEmit agent_end】
  - 影响：`Agent(run_in_background=true)` 直接后台派发后，如果子 agent 失败或被 `AgentCancel` 取消，dock 会显示 failed/cancelled 后淡出，但主 feed 的 `AgentBlockStart` 依赖 stream 里的 `agent_end` 才能 seal；直接后台 fail/cancel 路径不发 `agent_end`。
  - 相关文件：`packages/core/src/tool-system/builtin/agent.ts:335,342,344,444,512-524,526-559,769,861-865`；`packages/tui/src/ui/App.tsx:697-704,706-730,2071-2080`；`packages/tui/src/ui/AgentDock.tsx:200-211`。
  - 触发边界：仅直接后台 `Agent(run_in_background=true)` 且失败/取消；成功路径、同步 agent、同步自动转后台路径不受影响。
  - 修复方向：`agent.ts:512` 与 `:526` 两个 catch 中补 `safeEmit(parentStream, { type: "agent_end", ... })`，与 sync→bg 路径对齐；或在 `runSubAgent` finally 统一收口并保证不重复发。
  - 回归验证：直接后台 agent 取消 / mock spawn reject 时，parentStream 在 `agent_start` 后收到恰好一条 `agent_end{error|cancelled}`；成功路径仍只有一条；TUI reducer 喂入后 agent card 被 seal。

- [ ] **TUI ESC/取消后晚到 stream 事件不被抑制，低频重开已收口的 feed**
  - 当前归档：Medium（Low-Medium 边界）。真实存在但触发低频；不是数据损坏/安全问题，但会留下 zombie 气泡/工具卡。
  - 影响：取消后晚到的 `text_delta` / 少量 `tool_use_start` 可能在 “[Request interrupted by user]” 下方新建永不结束的 assistant 气泡或永久转圈工具卡，直到下一次成功回合收口。
  - 相关文件：`packages/tui/src/ui/App.tsx:1056-1084,1111-1141,289-294,519-812,446-487,1284-1339`；`packages/core/src/engine/turn-loop.ts:690`；provider 对照 `packages/core/src/llm/providers/anthropic.ts:259-262`、`packages/core/src/llm/providers/openai.ts:89,107,136,142`；desktop 对照 `packages/desktop/src/renderer/lib/streamReducer.ts:361-377`。
  - 修复方向：`handleStreamEvent` 顶部对会写 chatStore/feed 的事件在 `cancelledRef.current` 时丢弃，仅放行纯状态事件；或给 TUI 增加 `turn_complete` done-sweep 与 desktop 对齐。
  - 回归验证：cancel/commitInterruptedStreaming 后注入晚到 `text_delta` 不新增 streaming 气泡；注入 `tool_use_start` 不新增 tool_running；纯状态事件不被误拦；下一回合清理不回归。

- [ ] **为 `streamReducer` 增加乱序 `tool_use_args_delta` orphan 缓存**
  - 影响：低概率乱序流下工具参数展示/审批摘要丢失。
  - 相关文件：`packages/desktop/src/renderer/lib/streamReducer.ts`。
  - 问题：`tool_use_args_delta` 早于 `tool_use_start` 到达时会被直接丢弃；`tool_result` 有 orphan 缓存，但 args delta 没有对称机制。
  - 修复方向：增加 `orphanArgsByCallId`，在 `tool_use_start` 时合并。
  - 回归验证：reducer 单测喂入 delta-first/start-second 序列，最终 args 应完整。

- [ ] **改善 stdio transport 对畸形行/超长行/出站序列化失败的错误处理**
  - 影响：automation / agent-server stdio 可能无响应且缺少日志。
  - 相关文件：`packages/core/src/protocol/transport.ts:92-100`；多处调用 `transport.send(...)` 如 `server.ts:134,321,343,416`。
  - 已复核问题：入站 JSON parse catch 静默吞；`send()` 中 `JSON.stringify(message)` 同步抛错未捕获；RPC 出站流使用 `process.stdout`，任何业务 `console.log` 都可能污染 NDJSON；readline 无 max line length，超长无换行行会无界缓冲。
  - 修复方向：入站 catch 记录安全截断后的 warn；`send()` 包 try/catch 并降级/记日志；评估最大行长上限与错误响应；考虑把 RPC 出站流与业务 stdout 隔离。
  - 回归验证：喂入畸形 JSON 行、含循环引用的 message、超长行，确认有 warn、`send()` 不抛、后续合法消息仍可处理。

- [ ] **`bun run dist` / `pack` 不触发 desktop build，可能打包陈旧/部分 `out/`**
  - 当前归档：Medium（Low-Medium release footgun，非运行时 bug）。clean checkout 缺 `out/` 时通常会 fail loud；真正风险是 `out/` 已存在但源码已改，electron-builder 静默打包旧 bundle。
  - 相关文件：`packages/desktop/package.json:12,19-22,24-49,27-32`；`packages/desktop/scripts/predist.ts:79-89,131-134`；根 `package.json:18`。
  - 调用链：`bun run dist` → `predist` 只复制已有 core `dist` 到 desktop node_modules → electron-builder 按 `files` 收当前 `out/**/*` → 全程不跑 `packages/desktop/scripts/build.ts`。
  - 修复方向：在 `dist`/`pack` 前串 `bun run build`；或 electron-builder `beforeBuild/beforePack` 跑 `scripts/build.ts`；或 predist 里断言 `out/main/index.mjs`、`out/renderer/index.html`、`out/mobile/index.html` 存在且新鲜。
  - 回归验证：build 一次后改 renderer/mobile 可见字符串，不 rebuild 直接 dist；当前包内仍是旧字符串，修复后应自动重建并包含新字符串。clean `out/` 后直接 dist 应自动 build 或给明确错误。

## Low

- [ ] **marketplace name 无路径校验，存在越界 rmSync/clone latent 风险**
  - 严重级别：Low / latent / defense-in-depth。`marketplaceDir(name)` 缺少 path segment 校验，技术上可让 `..` 逃出 marketplacesRoot；但当前没有 model/远程直接可达路径，主要风险来自被攻陷 renderer 或本地 IPC 直发。
  - 影响：若任意字符串 `name` 进入 `marketplaceDir`，`addMarketplace` 可能越界 `rmSync`/`gitClone`，`removeMarketplace` 可越界递归删除。最现实入口是 desktop `marketplace:remove` IPC 直传 name；正常 UI add 走 `deriveMarketplaceName` 消毒，AddMarketplace builtin 不在 preset 白名单。
  - 相关文件：`packages/core/src/plugins/marketplaceManager.ts:36-38,87-150,171-178`；`packages/core/src/plugins/knownMarketplaces.ts:39-51`；`packages/core/src/plugins/pluginInstaller.ts:104,205,207,299`；`packages/core/src/tool-system/builtin/add-marketplace.ts:74`；`packages/desktop/src/main/marketplace-service.ts:111-132`。
  - 修复方向：在 `marketplaceDir` 或 add/remove/refresh 公共入口复用安全名称校验，拒绝空、`.`、`..`、分隔符、NUL；`rmSync` 前 realpath 双侧 containment；knownMarketplaces 写入前校验 key/installLocation；IPC 层加 name 白名单。
  - 回归验证：`../x`、`.`、`a/b`、`a\\b`、绝对路径、NUL name 的 add/remove/refresh 均拒绝且不触碰 root 外路径；篡改 known_marketplaces.json 指向 root 外时 install/uninstall 也应拒绝。

- [ ] **mobile-remote WS upgrade 无 Origin 校验，LAN auth 无限速**
  - 严重级别：Low（纵深防御缺口）。恶意网页可跨源连接 `ws://<lan-ip>:port/ws` 探测 remote 是否运行，并对 auth.device 做无限速尝试；但未认证 socket 够不到 room/approval 事件，直接接管仍被高熵 `secretHash` / pairing token 挡住。
  - 相关文件：`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:165-182,184-217,228-235,275-292`；`packages/desktop/src/main/mobile-remote/trusted-device-store.ts:56-65`；`packages/desktop/src/main/mobile-remote/pairing.ts:18-23`；`packages/desktop/src/main/mobile-remote/access-passcode.ts:5-6,88-104,133-138,168-178`。
  - 修复方向：LAN/tunnel 两种 upgrade 都校验 Origin/Host；LAN 模式对 `auth.device` / `pair.complete` 加 per-socket/per-IP 失败计数和退避；可选在 pairing 期外禁止裸连。
  - 回归验证：伪造 Origin 的 upgrade 被拒；合法 Origin 可连接但仍需 auth；缺失 Origin 按策略拒绝或白名单；多次错误 auth 触发限速；真配对流程与 tunnel passcode lockout 不回归。

- [ ] **DriveAgent / background job 的 `files_changed` 汇总与 invalid sessionId 通知边界**
  - 影响：外部 agent（DriveAgent claude/codex）改的文件不进 `files_changed` 汇总卡；FilesPanel 与审查面板仍能看到，故非完全不可见，但内联汇总卡会漏报外部 agent 的改动量/diff。另有 Low edge：`DriveAgent` 后台路径用 `ctx?.sessionId ?? ""`，ctx 缺失 sessionId 时结果通知被丢、永不唤醒。
  - 相关文件：`packages/core/src/tool-system/builtin/drive-claude-code.ts:83-104`；`packages/core/src/tool-system/builtin/background-jobs.ts`；`packages/core/src/tool-system/builtin/background-work.ts`；`packages/core/src/protocol/server.ts`；`packages/desktop/src/renderer/messages/fileChangeAggregator.ts`；`packages/core/src/tool-system/builtin/agent-notifications.ts:75-83`。
  - 已核实边界：notification wakeup 时序基本健全，见“已核实未作为 Bug”；本条只保留已确认的 Low / UX 缺口与 invalid sessionId edge。
  - 修复方向：DriveAgent 完成后附带改动文件清单（外部 CLI 输出 changed files 或 cwd git diff），喂进汇总；后台任务创建时强制有效 sessionId，缺失时 fail loud 或记录可见错误。
  - 回归验证：DriveAgent 修改文件后内联汇总卡显示改动；ctx 无 sessionId 的后台任务不应静默丢结果通知。

- [ ] **credentials:captureAllCookies 明文整 jar 回 renderer，无 main 级用户确认**
  - 影响：renderer 一旦可调用该 IPC，即可导出 `persist:browser` 全站明文 cookie；目前只靠 UI 按钮把门，没有 main 层确认。
  - 相关文件：`packages/desktop/src/main/credentials-service.ts:68-82`；`packages/desktop/src/main/index.ts:1525-1528`。
  - 修复方向：全量抓取 cookie 必须走 main 级显式用户确认，并展示影响范围。
  - 回归验证：无确认时调用 `credentials:captureAllCookies` 被拒。

- [ ] **BashOutput 增量分页按固定 16KB 原始字节硬切，切断多字节 UTF-8 与 ANSI 序列**
  - 严重级别：Low。非数据丢失、非安全问题；原始 `.log` / ring buffer 字节完好，但喂给模型的增量文本可能出现 `�` 或裸 ANSI 残片。
  - 相关文件：`packages/core/src/runtime/background-shell.ts:416,419-431,268-269`；`packages/core/src/runtime/ring-file.ts:34,96,99,147-152`；`packages/core/src/runtime/output-clean.ts:21-25,43`；`packages/core/src/tool-system/builtin/background-shell-tools.ts:58`。
  - 修复方向：切点从固定 16384 回退到最近 UTF-8 字符边界，`consumedBytes` 使用回退后的长度；同时避免切在未闭合 ESC/CSI 序列中间，或引入跨读 StringDecoder 状态后按行/码点切。
  - 回归验证：24KB 中文且某个汉字起始于第 16383 字节，连续增量读取拼接无 `�`；ANSI 序列跨 16KB 边界时 cleaned 文本无裸残片；ASCII 完整性测试通过。

- [ ] **禁用插件 mid-session 不停其 hook**
  - 影响：用户在能力总览禁用插件/某 hook 后，该 hook 仍对当前活动会话生效到下次新建会话；与 settings hook 热重载不对称。
  - 相关文件：`packages/core/src/engine/engine.ts:603,534-549`。
  - 修复方向：`reloadHooks` 一并卸载/重载 plugin hook。
  - 回归验证：会话内禁用插件后，其 `pre_tool_use` hook 不再触发。

- [ ] **mobile-static `resolveSafe` 不防 symlink，静态目录内预置 symlink 可逃逸 root**
  - 严重级别：Low / 加固项。`resolveSafe` 只做词法 containment，`statSync` 跟随 symlink；但运行时请求方不能在打包产物 `out/mobile` 内创建 symlink，需要构建期供应链污染或本地写入 app bundle 才可触发。
  - 相关文件：`packages/desktop/src/main/mobile-remote/mobile-static.ts:66-77,100-121`；`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:100,135-158`。
  - 修复方向：`resolveSafe` 使用 realpath 双侧 containment，或对目标/路径段 `lstatSync().isSymbolicLink()` 直接 404。静态资源目录可采用“任何 symlink 都拒绝”的严格策略。
  - 回归验证：root 内 `link -> root外文件`、`dirlink -> /tmp` 被拒；真实 `assets/app.js`、`index.html`、SPA fallback 不回归；`../secret` 仍拒。

- [ ] **房间 agent exit 不清 `pendingAskUser`，审批卡最长挂 5 分钟且缓存泄漏**
  - 严重级别：Low。不是安全洞，最终会 auto-deny；主要是 UX 卡住和极小内存泄漏。
  - 相关文件：`packages/desktop/src/main/mobile-remote/approval-bridge.ts:34,43-56`；`packages/desktop/src/main/mobile-remote/room-manager.ts:173,337-338,345-358,401,418,420,432-434,448-451`；`packages/desktop/src/main/mobile-remote/resident-agent.ts:216-219`。
  - 修复方向：agent exit/close 时遍历并清该 room 的 `pendingAskUser`；给 `ApprovalBridge` 增加按 roomId 批量 deny/resolve pending 的能力；把 `pendingAskUser.delete(askKey)` 移到 `respondApproval` 的 agent 存在性检查之前。
  - 回归验证：触发 AskUser 后模拟 agent exit/close，`pendingAskUser` 清零、approvalBridge 立即 deny 并广播 resolved；超时路径 agent 已 undefined 时也不泄漏。

- [ ] **`shell:openPath` / `openInEditor` / `revealInFinder` IPC 无路径 containment，可点击打开工作区外路径**
  - 严重级别：Low。需要用户主动点击，不会自动读取/外泄内容；但存在模型/终端输出可控的点击入口。
  - 相关文件：`packages/desktop/src/main/index.ts:2441-2454`；`packages/desktop/src/main/paths.ts:12-17`；`packages/desktop/src/main/desktop-services.ts:594-609,705-720,729-754`；`packages/desktop/src/renderer/chat/openWith.ts:17-19,43-77`；入口 `AttachmentCard.tsx:54`、`OpenWithMenu.tsx:62,65,69`、`Markdown.tsx:388,406,428`、`TerminalPanel.tsx:160`。
  - 修复方向：open* main handler 对解析后的绝对路径做 realpath 双侧 containment，允许集合为当前 cwd + recents/已打开项目；域外路径拒绝或二次确认。渲染层复用 PathLink 的 rooted 存在性门。
  - 回归验证：`openPath("/etc/hosts", cwd=repo)`、`openInEditor("/Users/x/.zshrc")`、`revealInFinder("/tmp/outside.png")` 应拒绝或需确认；工作区内路径和 `src/a.ts:12` 正常；workspace 内 symlink 指向域外应拒。

- [ ] **MCP server 重命名非原子，第二步失败会留下 old + new 重复条目**
  - 严重级别：Low。非安全问题，低概率触发，用户可手动删除重复项。
  - 相关文件：`packages/desktop/src/renderer/settings/McpSection.tsx:192-199,247-259,414-418`；`packages/desktop/src/main/settings-service.ts:84-117,119-144`。
  - 触发时序：rename `old -> new` 时，第一步写 `{ mcpServers: { new: ... } }`，deepMerge 保留 `old`；第二步写 `{ old: null }` 才删除。第二步失败/崩溃会持久化 old + new。
  - 修复方向：重命名合成单次 `updateSettings` patch，同时写 `new` 与 `{ [old]: null }`；或保留两步但加 try/catch、toast 与回滚。
  - 回归验证：mock 第二次 `updateSettings` reject，当前会留下 old+new；修复后单次 patch 成功或失败不产生半成品。正常 rename 后磁盘只剩 new。

- [ ] **settings config 迁移写回使用裸 `writeFileSync`，并发读可能短暂看到 torn JSON**
  - 严重级别：Low。真实存在但触发窗口极窄、一次性、自愈；并发读方通常有 try/catch 降级，不造成持久损坏。
  - 相关文件：`packages/core/src/settings/manager.ts:142,148,190-191`；对照正常保存 `packages/core/src/settings/manager.ts:254-256,357-360`。
  - 修复方向：抽 `atomicWriteJson(path,obj)`，迁移写点改为 tmp+rename，与正常 save 路径一致；保留 `.bak` 备份语义。
  - 回归验证：需迁移 settings + fs hook 放大写窗口，并发 load 不应读到半截文件；spy 迁移路径写 `*.tmp` 后 `renameSync`；迁移后 mode 仍 0o600。

- [ ] **mobile remote remember-token 无服务端 TTL，泄漏的 `cs_access` cookie 直到口令轮换前长期有效**
  - 严重级别：Low。不是独立绕过访问控制的洞，前提是攻击者已拿到 token 明文；但泄漏后缺少自然过期。
  - 相关文件：`packages/desktop/src/main/mobile-remote/access-passcode.ts:191-195,108-117,133-149,174-175`。
  - 修复方向：`verifyToken` 解析 payload 内时间戳，检查 `now() - ts <= MAX_TOKEN_AGE_MS`；缺失/非数字 ts 的旧格式 token 视为无效；保留 secret rotation 立即失效旧 token。
  - 回归验证：签发 token 后推进超过 TTL，`verifyToken`/HTTP gate/WS allows 应拒绝；TTL 内通过；轮换 passcode 后旧 token 即使未过期也失效；畸形无 ts token 拒绝。

- [ ] **mobileRemote tunnel start 缺少 IPC 层 in-flight 互斥，并发 start 会互相拆隧道**
  - 严重级别：Low。常规单 renderer UI 的 busy/status 按钮禁用基本挡住双击；主要是多窗口/状态不同步/IPC 重入下的可用性与健壮性问题。
  - 相关文件：`packages/desktop/src/main/index.ts:1971-2021`；`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:130-131`；`packages/desktop/src/main/mobile-remote/tunnel-manager.ts:101-104,211-222,283-292`；`packages/desktop/src/renderer/settings/AdvancedSections.tsx:1557-1559,1761`。
  - 并发时序：Call#2 见已有 tunnel child 抛错，catch 无条件 `tunnelManager.stop()` + `mobileRemote.stop()`，会杀掉 Call#1 的 child；Call#1 随后 timeout 失败。
  - 修复方向：main 层加 `startInFlight` promise 互斥，并发调用复用同一 promise；或 `tunnelManager.isRunning()` 时幂等返回当前 URL；遇到“隧道已在运行”时不要 stop 已有隧道。
  - 回归验证：并发两次 `mobileRemote:start{tunnel}` 只 spawn 一次且最终 connected；Call#2 不 kill Call#1；真实首次 start 失败仍会清理。

## Follow-up / 待复核

- [ ] **复核项目级 `.code-shell/settings.local.json` / `settings*.json` 信任根写入覆盖**
  - 候选严重级别：Follow-up / Hardening。file tool 直写 `.code-shell/settings.local.json` 这一路已被 path-policy 的 `.code-shell` 敏感目录规则拦住（写入 deny），不再按 Critical 处理；但仍需确认所有配置写入口和内部持久化路径没有旁路。
  - 相关文件：`packages/core/src/tool-system/path-policy.ts:77-82,486-500`；`packages/core/src/tool-system/builtin/config.ts:47-78`；`packages/core/src/settings/manager.ts:100-101,214-218,268-314`；`packages/desktop/src/main/settings-service.ts:84-117`。
  - 修复方向：保留 file-tool 对 `.code-shell/settings*.json` / `credentials.json` / path approval 文件的敏感写保护；对 `Config` / protocol / IPC 配置写入口补危险 key allowlist；内部写 `settings.local.json` / path approvals 的路径必须只接受受控数据，不接受模型任意 key/value。
  - 回归验证：`classifyPath(join(cwd, ".code-shell", "settings.local.json"), { operation: "write" })` 当前应为 deny；`Config` / `config_set` / `settings:set` 写 `permissions.rules`、`env`、`hooks`、`mcpServers` 等信任根字段应被拒或要求专门确认；内部 pathApprovals 持久化正例不回归。

- [ ] **复核 UseCredential token/link 结果是否会部分落入 desktop 原始 JSON-RPC preview 日志**
  - 候选严重级别：Low。触发面被显著收窄，仍需针对短 token / 边界情况复核。
  - 影响假设：`UseCredential` 对 token/link 凭证返回 `{ kind:"value", value:"<secret>" }`，streamEvent 经 worker→renderer 时可能被 `dlog("bridge","worker→renderer", { method, raw: previewLine(line) })` 记录；日志 redaction 只按 key 名屏蔽，secret 嵌在 `raw` 字符串里且字段名叫 `value`。
  - 已复核收窄：`previewLine` 默认截断前 200 字符（`agent-bridge.ts:62-64`），长 token 通常被截掉；`SessionSnapshotStore` 是纯内存 Map（`SessionSnapshotStore.ts:40-41`），不落盘，所谓“整段 token 进 sessions/session-<SID>.jsonl”不成立。
  - 相关文件：`packages/core/src/credentials/use-credential-tool.ts:79-84,176-178`；`packages/desktop/src/main/agent-bridge.ts:62-64,156-166`；`packages/desktop/src/main/redact-secrets.ts:9-39`。
  - 修复方向（若确认）：redact 时对 `raw`/字符串值做 token-shape 正则扫描；对 UseCredential 等敏感 tool_result 记日志前整体 mask；或把 secret 字段名规范成命中 redaction 的名字。
  - 回归验证：`UseCredential` 返回 token 后，`~/.code-shell/logs/desktop/*.log` 与 per-session 日志均不含明文 token，含短 token 边界。

## Hardening / Product TODO

- [ ] **UseCredential cookies.txt 非租约式临时文件：确认但属已知设计 / 加固项**
  - 影响：cookie 凭证被取用时物化为 `tmpdir()/codeshell-cred-cookie-*.txt`（`0o600`），用完不主动删除；Desktop 仅 app 启动时 sweep >30min 旧文件，CLI/TUI/headless/automation worker 没有接入 sweep。
  - 相关文件：`packages/core/src/credentials/use-credential-tool.ts:32-33,90-106,195-202`；`packages/desktop/src/main/index.ts:1366`；`packages/tui/src` 与 `packages/core/src/cli` 无 sweep 调用。
  - 设计结论：确认但属已知设计。`use-credential-tool.ts:86-88` 显式注释说明不引入 lease 对象/定时器，靠进程退出 + 轻量 sweep；权限 `0o600` 已限同用户访问。
  - 加固方向：引入轻量租约（命令结束/会话结束 try-finally 删除）；或把 sweep 接到 CLI/TUI 启动与 app 退出钩子；缩短 TTL；更彻底可用 fd/pipe 避免落盘。
  - 回归验证：取用 cookie 凭证并执行完命令后，对应 cookies.txt 已删除；CLI/TUI 宿主下也有启动/退出清理路径；sweep 单测覆盖 <30min 保留、>30min 删除、非前缀文件不动。

- [ ] **sync-models/OpenRouter snapshot：docs-only / 健壮性加固，不是 High**
  - 影响：`sync-models` 不自动刷新，只会让模型定价/上下文/模态元数据陈旧；OpenRouter json 缺失崩溃只在手动删文件、错误 gitignore、copy-assets 被改坏等异常人为场景触发。
  - 相关文件：`scripts/sync-models.ts:6-7`；根 `package.json:18`；`packages/core/src/data/openrouter-models.ts:5,8-10,35`；`packages/core/src/llm/model-fetcher.ts:31,294,299-307`；`packages/core/package.json`。
  - 问题：注释称 build 会通过 package.json `prebuild` 跑 sync-models，但根 build 不调用；OpenRouter 注释称 lazy/missing returns `[]`，实际模块顶层 `requireJson("./openrouter-models.json")`，文件缺失会 import 期崩溃。正常 checkout/build/release 下文件恒在。
  - 修复方向：若希望自动刷新，真正加 `prebuild` 或把 sync-models 串进 build；若保持手动刷新，删掉虚假注释。OpenRouter snapshot 要么 try/catch 缺失回退空 snapshot，要么修改注释说明 eager require 且构建保证文件存在。
  - 回归验证：若实现缺失降级，临时移除 snapshot 后 import 消费模块不崩，`getOpenRouterModels()` 返回 `[]`；若实现自动刷新，断网 build 应保留旧 snapshot 且不阻断。

- [ ] **fs/memory/settings 的 root/cwd 依赖 renderer 可信：已打开项目白名单加固**
  - 影响：当前依赖 renderer 可信；若未来 XSS/被篡改 bundle 出现，renderer 可传 `root="/"` 让 fs containment 形同虚设，memory/settings cwd 同理。
  - 相关文件：`packages/desktop/src/main/fs-service.ts:30-52`；`packages/desktop/src/main/index.ts:2510-2522`；`packages/desktop/src/main/memory-service.ts:45-51`；`packages/desktop/src/main/settings-service.ts:25-29`。
  - 加固方向：root/cwd 必须落在 recents/已打开项目集合内；不在白名单则拒绝。
  - 回归验证：root 不在已知项目集合时 fs/memory/settings IPC 拒绝。

- [ ] **credentials-login 只清 cookies：产品 TODO，不作为隐藏 bug**
  - 结论：代码已标为本期已知局限，作为产品/隐私加固 TODO 追踪，不作为未披露 bug。
  - 修复方向：如产品目标要求“彻底登出”，补齐 localStorage / IndexedDB / cache / service worker 等浏览器状态清理，并明确 UI 文案。
  - 回归验证：执行 credentials-login 清理后，目标站点相关 cookie 与本地浏览器状态均按产品定义清除。

## 已核实未作为 Bug

- [x] **空 sessionId 流事件跌到 `runningBucket`：降级为当前桌面路径不可触发的防御性死分支。** 现代 desktop/tcp 均走 ChatSessionManager 多会话路径，`handleRunMulti` 强制非空 sessionId；服务端 `notify(Methods.StreamEvent)` 的活跃发送点均带真实 sid。唯一 `?? ""` 在 legacy-only `handleRunLegacy` 路径，桌面 worker 不走。可选加固：`packages/desktop/src/preload/index.ts:108` 对 `agent/streamEvent` 无 sessionId 时加 guard/warn；或收紧 `packages/desktop/src/renderer/streamRouting.ts:49` 空 sid 不再 fallback 到 runningBucket。

- [x] **DriveAgent / background job notification wakeup 时序：未确认竞态。** trigger A（idle 时 bus 触发）+ trigger B（run 边界 re-check）+ `drainAll` 原子化 + 同步 fan-out/同步置 busy 的 burst-merge 不变量到位；`wasCancelledSinceLastTurn` 保证 Stop 后不被后台完成强行复活。可接受边界：用户 Stop 后再不发消息，后台 DriveAgent 结果会滞留队列，按当前设计不计 bug。已确认的 `files_changed` 与空 sessionId edge 已移入 Low。

- [x] **cron double-run：当前 worker 侧禁用 execution，未复现双跑。**

- [x] **plugin `fs.cp` 默认解引用 symlink 拷出外部文件：结论错误。** Node 默认 `dereference: false`；仅保留低风险 symlink 残留关注。

- [x] **desktop 旧 reducer 的若干 Critical 推断：文件混淆，未作为确认 bug。**

- [x] **MCP discovered tool 不转发 AbortSignal、Stop 后底层请求继续：证伪。** AbortSignal 全链路已透传：registry 注入 `__signal`（`registry.ts:128`）→ `mcpToolExecute` 取 `args.__signal`（`mcp-tools.ts:39`）并传给 `manager.callTool(..., signal)`（`:44`）→ `MCPManager.callTool` 接收 `signal?`（`mcp-manager.ts:560`）并作为 RequestOptions 转给 SDK `conn.client.callTool({...}, undefined, signal ? { signal } : undefined)`（`:572`）。Stop 时 run 的 AbortSignal 会级联取消在途 MCP 请求。

---

# 发布关键路径（beta1，必须用户亲自做）

> 原 `TODO-beta1.md` 合并进来。代码侧 review 确认 bug 已修;剩下是验证 + 打包 + 发布,AI 无法代做。

- 🔴 **真机冒烟:弹窗登录抓 cookie 全链路** — 登 YouTube → 保存 → 切换账号 → AI 取用。唯一没真机验过的核心新功能。关联 `project_browser_login_window`。
- 🔴 **桌面 App 冒烟**（本机,发前必跑）:装包→Gatekeeper 右键打开→主界面→子代理列表非空→市场有源→配 OpenAI 跑一轮→切模型→默认 agent 跑一次→生成一张图→关掉重开能恢复会话。
- 🔴 **全量打包构建**:`bun run build` + `cd packages/desktop && bun run dist`（electron-builder,未签名,`CSC_IDENTITY_AUTO_DISCOVERY=false`），确认 main 进程 / node-pty ABI / asarUnpack 没崩。
- 🔴 **`git push`** 未推的 commit 到 origin/main。
- 🟡 **npm 包**（若本轮要发）:**必用 `bun publish --tag rc` 不是 `npm publish`**（workspace:* 解析）;**发后必真跑一次 bin**（`code-shell --version`）。
- 🟡 **i18n 全语言点一遍**:中/英切换走主流程,确认无未翻译泄漏 / 无 localStorage 报错。
- 🟡 **Windows P8 真机冒烟**:代码 P1–P8 全实现 + CI 绿,但无打包 job、无真机点验。beta1 若只发 mac 可整体延后。关联 `project_windows_port`。

---

# 后台面板 / DriveAgent 可观测性

> 原 `TODO-background-panel-fixes.md` 合并进来。来源:会话日志诊断 + 源码核实。
> 合并时重新核对现状,发现 #1/#4/#7/#8/#9 **其实已实现**(下方标注),原文件未勾。

## 已核实实现（合并核对 2026-07-01 时发现已做，原文件未勾）

- [x] **#1 刷新按钮加 spinner** — 已做:`BackgroundShellPanel.tsx` 有 `refreshing` state(L40-41),finally 复位(L77-84),`RefreshCw` 条件 `animate-spin`(L220)。
- [x] **#8 定时任务续原 codeshell session** — 已做:`cron.ts` 有 `continueInSession`(L72-81);`scheduler.ts` CronJob 有 `resumeSessionId`(L54-59);`automation-host.ts` `makeCronRunnerWithResume`(L219-230)走 `injectResume` 把 prompt 作为 user 轮注入活 session;有 `automation-host.resume.test.ts`。
- [x] **#9 自主多轮后已编辑文件只显示最后一轮** — 已做(选 C):`types.ts` UserMessage 加 `injected?`(L32-37),`steer_injected` 置 injected=true(L432-440);`fileChangeAggregator.ts` 找边界 `!m.injected` 跳过注入消息(L274-281),跨轮编辑不再被截断。
- [x] **#4 工具卡 args 显示 `{}`** — 已修(GenericToolCard 改用 parsedArgs)。
- [x] **#7 生成图 link 点不开（`.code-shell` 被域名判定误杀）** — 已修(收窄域名判定正则)。关联 `project_image_link_dotdir_dead`。

## 未做（核对 2026-07-01 确认）

- [ ] **#2/#5 后台 job 完成即消失、无结果详情** — 【确认 NOT DONE — `finish(jobId)` 仍直接 `jobs.delete`,`BackgroundJobEntry` 只有 jobId/sessionId/description 不存结果】
  - 修复方向(需拍方案):`finish` 不删改标 `status:completed/failed` + 存 `finalText`/`ccSessionId`;面板 job 类加点击展开看详情;保留 cli 徽标。需定何时清理(turn 结束/数量上限)。
  - 相关文件:`background-jobs.ts`;`drive-claude-code.ts:82-105`;`background-work.ts`;`panels/BackgroundShellPanel.tsx:263-283`;`preload/types.d.ts:49-61`。

- [ ] **#6 后台外部 agent 改的文件对宿主 UI 不可见** — 【确认 NOT DONE — 完成通知无 files_changed 字段】（与 Low「DriveAgent files_changed 汇总」同根）
  - 现状:外部 CLI 的 Edit/Write 在外部 transcript,`fileChangeAggregator` 只扫本会话 tool 消息,外部改动无 diff/无计数/无文件名。
  - 修复方向(需拍方案,与 #2/#5 一起设计):完成通知带 `ccSessionId`,可读外部 CLI transcript 解析改动文件回填;或至少在工具卡/后台 job 详情展示「编辑了 N 个文件」。

- [ ] **#10 浏览器新标签页 localhost 端口探测刷控制台报错** — 【确认 NOT DONE — 仍 renderer fetch 扫描】（非 bug,纯噪音 + 功能不精确）
  - 现状:`useLocalhostPorts.ts`(L10-34)仍用 renderer `fetch(..., {mode:"no-cors"})` 扫 CANDIDATE_PORTS,失败请求在 catch 前已进 DevTools;`no-cors` opaque response 读不到状态码 → 403 误报;硬编码端口表既不全又浪费。
  - 修复方向(需拍方案):端口发现下沉 main —— 最小 `net.connect` 真 TCP 探测 + preload 暴露 + renderer 改调;更彻底 main 枚举系统监听端口(`lsof -iTCP -sTCP:LISTEN`)。renderer 纯展示。
  - 临时:DevTools 控制台过滤框输 `-useLocalhostPorts` 屏蔽。

---

# 发后第一优先（非 beta1 关键路径）

- 🔴 **记忆系统专项**（用户已拍板:先出整体设计再动手）— 第一批止血已做(96c5a3e)。专项覆盖:生命周期状态机 / 完成态语义字段 / 自动提取确认流 / MEMORY.md 索引截断按需读 / 注入 token 预算。关联 `project_memory_and_dream_overview`。
- 🟡 **会话可靠性闭环**:长断网会话级重连、崩溃恢复 UI 提示/一键恢复、工具超时可取消性一致化、友好错误消息。
- 🟡 **桌面面板 session 切换保活**:切回来右侧面板 tab 元数据能恢复,但 BrowserPanel/webview 页面内容、面板内部状态会丢。后续做轻量版(保存 BrowserPanel URL 恢复)或完整保活版(按 activeBucket+tab.id 缓存 panel 实例 + LRU)。
- 🟡 **真视频适配器**:替换 `FakeVideoProvider`,接 seedance/kling(待私有 API 文档)。框架 + 工具 + 后台轮询已就位,`getVideoProvider` 加 case 即可。
- [x] **审查面板 turn 级范围**（原标真 bug,已核实实现）— `ReviewPanel.tsx` 收到 `files` prop 时默认 `scope="turn"`。核实 2026-06-25。
- [x] **手机端 CC 会话 UX 对齐桌面端**（已完成,分支 `worktree-mobile-cc-session` 待 push/合并）:去房间外壳、进入前选权限模式、补齐历史、手机版 Markdown 渲染、loading 接线全完成。

---

# beta1 延后（非 bug，记 release notes）

- ⚪️ **browser-login 硬化**:① 已修(per-window `randomUUID()` nonce);② `persist:login-*` 分区只清 cookie,localStorage/IndexedDB/SW 残留 → 改非持久分区或 `clearStorageData`;③ BrowserHost phase-2 webview 收编未预留类型/未抽共享 helper。
- ⚪️ **JSON-Schema 导出未接线**:`schema-export.ts` 无 caller → 宿主启动写 `~/.code-shell/settings.schema.json` 或 release notes 注明不暴露。
- ⚪️ **i18n 收尾（增量）**:`"新对话"` 哨兵常量化;非 React helper 硬编码 localStorage key 应 import KEY;mobile(~149 处)单独接同套 i18n。
- ⚪️ **mac 签名/公证**:beta 未做正式签名 → 首次需右键打开。关联 `project_macos_signing_notarization`。

---

# 大路线图（beta1 不做，留存方向）

- **浏览器自动化 P4**（MVP 已实现）:留后=交互审批弹窗 / 无人值守隐藏窗口 / 视觉兜底 SoM。
- **Cookie Lease**（`docs/browser-cookie-export-design-2026-06-14.md`）:浏览器登录态→CLI 工具受控桥接(按域/按任务/一次性/审批 + 三层清理)。整套未实现。
- **Workspace / Profile / 数字人**（`docs/workspace-profile-讨论稿.md` v0.5）:base preset + 主指令 + 可移植经验三层 / 可切换 / Team Board。下一步 P3 seedance 手动落地。
- **Workspace 数据源绑定**（P4）:资源模型 / link 外部源(Figma/issue/云盘)/ scope 分配。大子系统。
- **远程控制 / 跨代理编排**（P5）:SSH / 扫码配对 / 远控会话 / 编排 Codex+CC / 安全边界。大子系统。
- **手机遥控**（低优）:房间续跑 + 手机驱动真 codeshell session;现 mobile 无 Markdown 渲染。
- **聊天软件接入（channel，参考 OpenClaw）**:微信/Telegram 做成可插拔 channel 前端。要点:① core 保持 channel-agnostic,平台接入做外部插件;② 接入做成一类凭证进 CredentialStore(微信扫码登录 token 存本地,Telegram bot token);③ 扫码微信号绑死为收发身份 + 必配 allowlist + 绑定目标 agent;④ 微信当前只私聊 + 媒体,不支持群聊。未立项。
- **工程质量 P7**:builtin tools 集成测试(已补 65 例)/ E2E / CI 覆盖率 >60% / 性能 / 文档。
  - **Electron e2e 设施**（playwright 现是孤儿依赖）:用 `_electron` API 驱动真机 app,沉淀 `verifier-electron` 基座。最小落地:`playwright.config.ts` + `e2e/`;`launchApp()` 按 title/URL 抓主窗（**别用 `firstWindow()`,会抓 DevTools 窗**）;第一个用例验浏览器面板;`package.json` 加 `test:e2e`。难点:抓错窗 / webview 嵌套需 `frameLocator` / node-pty 按 Electron ABI 重编 + CI 需 `xvfb-run`。约半天。
- **Markdown 渲染一致性**（desktop/TUI）。
- **view_image TUI inline**（iTerm/kitty graphics protocol）+ 历史图降级文字摘要省 token。
- **设置/命名清理**:settings/repo/workspace 命名收口;ModelSection 1065 行深度重排。

### 明确不做（已决策，留因）

- **每轮主动请求压缩 / token 预算动态调档**:与 Anthropic prompt cache 冲突,固定 ratio 门控刻意保留。
- **Agent 角色 settings-level 默认**:硬编码 general-purpose 兜底已够。
- **路径授权审计日志**（B2）:个人本地场景性价比低;机制本身一直生效。
- **Git Bash 探测**（Windows）:真实部署是 Docker/Linux,零价值。
