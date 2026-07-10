# CodeShell vs Codex 能力对标与候选排序

调研日期：2026-07-10  
基线：`codex-capability-catalog.md` 的 313 条 Codex 能力；CodeShell 以本工作树代码为准。  
目标：不是复刻 Codex 的产品菜单，而是找出对通用 agent harness 真正有收益、且 CodeShell 尚未补齐的能力。

## 结论先行

CodeShell 并不是“少一套 Codex CLI”。它已经具备相当完整的 harness 底盘：交互/无头运行、JSON/JSONL 事件流、持久 session、上下文压缩、Seatbelt/bwrap 沙箱、审批规则、MCP stdio/HTTP 与 stored OAuth credential、插件/marketplace/skill/hook、图片输入/查看/生成、记忆、Goal/Cron/Sleep、worktree、并行及后台子 agent，以及 stdio/TCP AgentServer。

本次逐项覆盖 C1 的 **11 个能力面、313 条 feature**，把同一能力在 CLI flag、slash command、config key、app-server API 中的重复表述合并判断，最终得到 **15 个高价值差距包**。其中最值得先圈定的是 8 个：

1. 无头多模态与 stdin context 补齐；
2. 把已有 session fork 内核打通到协议和 UI；
3. `doctor/debug-config/debug-prompt` 诊断面；
4. MCP required / tool filter / risk annotation 策略；
5. JSON Schema 约束的最终结构化输出；
6. 子 agent role 的 sandbox/MCP 最小权限；
7. 将 CodeShell 暴露为 MCP server；
8. ephemeral + session 保留/清理策略。

前三项主要是“已有内核的产品化”，投入小、见效快；第 4～8 项是 harness 生产化能力。

## 口径与 C1 ID

C1 原文表格没有打印稳定 ID。为便于回查，本报告按“章节前缀 + 该表 feature 行序”生成位置 ID；例如 `C1-IN-004` 是“输入、多模态与上下文”表的第 4 行 `-i, --image`。如果 C1 表格以后插行，需同步重排。

| 前缀 | C1 能力面 | 条目数 |
| --- | --- | ---: |
| `RUN` | 运行模式与 CLI 命令 | 30 |
| `FLAG` | 关键 CLI flags | 26 |
| `IN` | 输入、多模态与上下文 | 13 |
| `OUT` | 输出、事件流与机器可读格式 | 12 |
| `SES` | Session、thread 与 rollout 文件 | 12 |
| `SEC` | 权限、审批、沙箱与安全边界 | 23 |
| `EXT` | 工具、扩展与生态能力 | 35 |
| `CFG` | 配置体系与关键配置项 | 61 |
| `MOD` | 模型、provider 与鉴权 | 26 |
| `SLASH` | Slash 命令 | 52 |
| `AGT` | 多 agent、子任务与可编程控制 | 23 |
|  | **合计** | **313** |

状态口径：

- **已有**：CodeShell 有等价 harness 原语；名称或入口不同不算差距。
- **部分有**：内核已存在但入口、策略、平台或协议链路未闭环。
- **缺失**：仓库中未找到等价实现。
- 差距数量按下文的“可独立交付能力包”计数，不按 C1 重复出现次数计数。

体量按一个熟悉仓库的工程师估算：`XS` 1～2 人日，`S` 3～5 人日，`M` 6～10 人日，`L` 11～20 人日；含核心实现、入口、测试和最小文档，不含跨平台 soak time。

## 逐能力面对标结论

### 1. 运行模式与 CLI 命令（C1 `RUN` 30 条）— 部分有，核心运行面已齐

- **已有**：TUI/REPL、初始 prompt、`run` 无头模式、stdin prompt、`--resume`、session 列表、插件/marketplace、feature flags、更新、review，以及 stdio/TCP AgentServer。锚点：`packages/tui/src/cli/main.ts`、`packages/tui/src/cli/commands/run.ts`、`packages/core/src/cli/agent-server-stdio.ts`、`packages/core/src/cli/agent-server-tcp.ts`。
- **部分有**：`SessionManager.fork()` 已实现，但没有协议、TUI slash 或 desktop 入口；诊断服务存在，但不是覆盖配置/认证/Git/MCP/session inventory 的 `doctor`。
- **缺失但不优先**：Codex cloud/app handoff、remote pairing daemon、shell completion。这些偏 Codex 产品生态，不是当前 harness 的主路径。
- **对标结论**：无需复制 Codex 子命令树；优先把 fork、doctor 和 MCP-server 形态补成公共能力。

### 2. CLI flags（C1 `FLAG` 26 条）— 部分有，常用运行覆盖，策略型 flag 不足

- **已有**：model/provider/base URL/API key/preset、permission mode、output format、max turns、reasoning effort、resume、final-message file。
- **部分有**：CLI 有 JSON/JSONL/stream-json，但这是传输格式，不是最终内容 schema；配置有 feature flags，却没有通用单次 `key=value` overlay、named profile 或 strict-config 诊断。
- **缺失且有价值**：`--image`、prompt 与 piped stdin 同时输入、`--ephemeral`、`--output-schema`。
- **对标结论**：优先补自动化输入/输出契约；generic config override/profile 的收益次之。

### 3. 输入、多模态与上下文（C1 `IN` 13 条）— 部分有，多模态内核强，headless 链路缺口明显

- **已有**：desktop 附件、TUI `/image` 多图、图片粘贴/拖入、vision gate/压缩/历史降级、文件和目录附件、`/files`、WebSearch、ViewImage、GenerateImage。锚点：`packages/core/src/engine/input-attachments.ts`、`packages/core/src/engine/image-policy.ts`、`packages/tui/src/cli/commands/builtin/image-command.ts`。
- **部分有**：`resolveTaskFromArgOrStdin()` 在有 positional task 时直接忽略 stdin；`run` 没有 `--image`，导致 CI/脚本无法复用已成熟的图片处理链。
- **对标结论**：这是最清晰的“小投入补齐一整条能力链”候选。

### 4. 输出、事件流与机器可读格式（C1 `OUT` 12 条）— 部分有，事件流已有，终态契约缺失

- **已有**：text/JSON/JSONL/stream-json renderer、丰富 `StreamEvent`、AgentServer JSONL-over-stdio、通知流、final-message file。锚点：`packages/tui/src/cli/output/renderer.ts`、`packages/core/src/protocol/server.ts`、`packages/core/src/types.ts`。
- **缺失**：用 JSON Schema 约束并校验最终 assistant 输出；协议/schema bundle 生成命令；完整 redacted `doctor --json`。
- **对标结论**：CodeShell 已适合“观察运行过程”，下一步应让下游可靠消费“最终结果”。

### 5. Session、thread 与持久化（C1 `SES` 12 条）— 部分有，session 内核强，生命周期策略未闭环

- **已有**：每 session 的 `state.json + transcript.jsonl`、resume、parent session、turn 边界、compact 事件、工作区/worktree 绑定、desktop rename/archive/delete、core fork。锚点：`packages/core/src/session/session-manager.ts`、`packages/core/src/session/transcript.ts`、`packages/desktop/src/main/sessions-service.ts`。
- **部分有**：fork 只有未被调用的 core 方法；archive 是 desktop 本地索引语义，不是统一协议状态。
- **缺失**：ephemeral run、session/transcript 大小或年龄保留策略、统一 fork/archive API。
- **对标结论**：先暴露 fork，再补持久化策略；不建议为了对齐 Codex rollout 格式而绑定内部文件协议。

### 6. 权限、审批、沙箱与安全边界（C1 `SEC` 23 条）— 部分有，现有实现已是 CodeShell 强项

- **已有**：应用层 classifier、默认/accept-edits/bypass/plan 模式、headless fail-closed、session/project remembered rules、项目 trust gate、writable roots、denied reads、network allow/deny、macOS Seatbelt、Linux bwrap、敏感路径和 shell metacharacter 检查。锚点：`packages/core/src/tool-system/permission.ts`、`packages/core/src/tool-system/path-policy.ts`、`packages/core/src/tool-system/sandbox/`、`packages/core/src/settings/manager.ts`。
- **部分有**：规则在 settings 中可表达 allow/ask/deny，但没有 named permission profile、独立 policy explain/check；MCP 只使用 `readOnlyHint`，未完整利用 `destructiveHint` 等风险标注。
- **缺失**：自动审批 reviewer、原生 Windows sandbox。
- **对标结论**：不要重做沙箱；优先补“策略可解释性”和 MCP 风险元数据，Windows native backend 单独立项。

### 7. 工具、MCP、插件、skill 与 hook（C1 `EXT` 35 条）— 部分有，生态面总体接近

- **已有**：文件/shell/background shell/web/image/browser/LSP/notebook/worktree/agent/goal/cron 等 builtin；MCP stdio、Streamable HTTP/SSE、headers、env secret、stored OAuth credential、resources、插件携带 MCP；marketplace 安装/升级；project/user/plugin skills；按 description 向模型暴露 skill 并通过 Skill tool 按需加载；CODESHELL/CLAUDE/AGENTS 分层；shell/plugin hooks。锚点：`packages/core/src/tool-system/builtin/`、`packages/core/src/tool-system/mcp-manager.ts`、`packages/core/src/plugins/`、`packages/core/src/skills/scanner.ts`、`packages/core/src/hooks/`。
- **部分有**：MCP 仅 server 级 enable/disable，连接失败统一 warn 后继续；发现到的 tool 全注册；初始化 instructions 未进入受控上下文；hook 事件覆盖较多，但 `pre_compact` 明确预留未触发，plugin `SubagentStop` 明确跳过。
- **缺失**：MCP per-tool allow/deny/approval、required server；hook 内容 hash/review/re-trust。
- **对标结论**：能力数量已经足够，下一阶段重点应是 MCP/hook 的最小权限、可靠性和供应链信任。

### 8. 配置体系（C1 `CFG` 61 条）— 部分有，分层和 trust 很好，运维配置不足

- **已有**：managed → user → project → local → flag precedence、JSON/YAML、schema/migration、project trust、model/MCP/sandbox/hooks/features/memories/instructions、desktop settings UI。锚点：`packages/core/src/settings/manager.ts`、`packages/core/src/settings/schema.ts`、`packages/desktop/src/renderer/settings/`。
- **部分有**：managed settings 等价于企业基线，但没有 Codex `requirements.toml` 那种“上层只允许某些值”的约束；有本地 logger span/analytics/diagnostics，却没有 OTel exporter。
- **缺失**：named profiles、strict-config/debug-config 完整解释、OTLP logs/traces/metrics、session history cap、完整 shell environment policy DSL。
- **对标结论**：profile 不是首要差距；诊断、保留策略、OTel 更符合长运行 harness 的需求。

### 9. 模型、provider 与鉴权（C1 `MOD` 26 条）— 部分有，通用 provider 强，OpenAI 新协议面不足

- **已有**：OpenAI-compatible 与 Anthropic-style client、自定义 base URL/headers/auth command、model catalog、动态模型发现、Ollama、本地/云 provider、vision/reasoning/max-context/max-output 能力、运行中切 model/effort。锚点：`packages/core/src/llm/`、`packages/core/src/model-catalog/`。
- **部分有**：provider 种类可通过兼容接口接入，但 OpenAI client 当前走 `chat.completions.create()`；没有 Responses API 的 item/reasoning/tool-call 语义。
- **缺失但非通用优先级**：ChatGPT OAuth、Codex Fast credits、Bedrock Codex 专用内置 provider。这些与特定商业账户绑定，不应压过协议能力。
- **对标结论**：模型名不构成能力差距；Responses API adapter 才是值得排期的协议差距。

### 10. Slash 命令与交互面（C1 `SLASH` 52 条）— 部分有，常用操作覆盖充分

- **已有**：`/clear /compact /copy /diff /exit /features /feedback /goal /hooks /image /init /login /logout /mcp /memory /model /permissions /plugin /resume /review /skills /status /tools /undo /update` 等，并有 CodeShell 自己的 `/tasks /cost /voice /security-review`。
- **缺失且值得做**：`/fork`、统一 `/debug-config`；`/side` 可作为 fork 的第二阶段。
- **不建议追平**：pet/theme/title/keymap 等 TUI 个性化命令不是 harness 能力差距。
- **对标结论**：按底层能力补入口，不按 Codex 的 52 个命令逐名复刻。

### 11. 多 agent、长任务与可编程控制（C1 `AGT` 23 条）— 部分有，是 CodeShell 另一强项

- **已有**：同步/并行/后台子 agent、自动后台化、status/cancel/send-input、持久 child session、custom agent role、model/tool/skill/max-turn 约束、禁止嵌套、并发上限、Goal/Cron/Sleep/DriveAgent、AgentServer run/cancel/configure/query。锚点：`packages/core/src/tool-system/builtin/agent.ts`、`packages/core/src/agent/agent-definition.ts`、`packages/core/src/protocol/`、`packages/core/src/cron/`。
- **部分有**：子 agent 继承父 sandbox/MCP，role schema 不能声明更窄的 sandbox、network 或 MCP server/tool 集；并发上限为实现常量、depth 硬编码为 1，而非配置策略。
- **缺失**：把 CodeShell 自身以 MCP server tools 暴露；Python SDK；CSV batch primitive。
- **对标结论**：优先做 role 级最小权限和 MCP server facade；Python SDK/CSV batch 可由稳定协议后续派生。

## 高价值差距清单（按性价比排序）

> 排序综合用户收益、对 harness 的通用性、可复用现有内核的程度和交付风险；不是单纯按代码量排序。

| 排名 | 差距包 / C1 ID | 价值 | 难度 | CodeShell 现状与落地锚点 | 体量 |
| ---: | --- | --- | --- | --- | --- |
| 1 | **无头输入补齐：`--image` + prompt/stdin context**<br>`C1-IN-002`、`C1-IN-003`、`C1-IN-004`、`C1-IN-005` | **高**：CI、issue triage、视觉回归、日志+指令组合可直接脚本化；复用已有 vision 安全链。 | 低 | `read-stdin.ts` 当前 task 优先并忽略 pipe；`main.ts/run.ts` 无 image 参数。复用 `input-attachments.ts`、`image-policy.ts` 或 `/image` 的解析。 | `S`，3～4 人日，约 6～9 文件 |
| 2 | **公开 session fork：core → protocol → TUI/desktop**<br>`C1-RUN-006`、`C1-SES-011`、`C1-SLASH-038` | **高**：安全试验方案、从旧 turn 分叉、并行探索，不污染原 transcript。 | 低 | `SessionManager.fork()` 已有按 turn 复制事件并设置 `parentSessionId` 的原语，但全仓无调用；需补状态一致性、protocol method、client、`/fork` 和最小 UI。 | `S`，3～5 人日，约 7～11 文件 |
| 3 | **`doctor --json` + debug-config/debug-prompt**<br>`C1-RUN-024`、`C1-RUN-027`、`C1-RUN-028`、`C1-OUT-009`、`C1-SLASH-045`、`C1-SLASH-047` | **高**：显著降低“模型/MCP/沙箱/配置为什么没生效”的支持成本；适合 bug report 自动脱敏。 | 中低 | 已有 `services/diagnostics.ts`、`/status`、`/log`、MCP probe、settings sources、sandbox capability detection；缺统一 inventory 和 redaction contract。 | `S`，4～5 人日，约 8～12 文件 |
| 4 | **MCP 精细策略：required、tool filter、risk annotation、可选 instructions**<br>`C1-EXT-011`、`C1-EXT-012`、`C1-EXT-013`、`C1-SEC-022` | **高**：减少无关 tool schema 占用、避免关键 server 静默降级、让 destructive/read-only 风险进入审批。 | 中 | schema 只有 server `enabled`；`connectAll()` 对失败统一 warn；`discoverTools()` 全注册；`buildRegisteredTool()` 只读 `readOnlyHint`。锚点：`mcp-manager.ts`、`settings/schema.ts`、capability UI、permission classifier。 | `M`，6～9 人日，约 10～15 文件 |
| 5 | **最终响应 JSON Schema**<br>`C1-FLAG-017`、`C1-OUT-006` | **高**：让 agent job 直接产出可验证 release metadata、review findings、工单动作；比“输出 JSON”可靠一个层级。 | 中 | renderer 只约束 wire format；LLM options/TurnLoop 没有 output schema。需做 provider 能力探测、native schema 或 validate+repair fallback、终态错误语义。锚点：`llm/types.ts`、providers、`turn-loop.ts`、`run.ts`。 | `M`，7～10 人日，约 10～16 文件 |
| 6 | **子 agent role 最小权限：sandbox/network/MCP override**<br>`C1-AGT-006`、`C1-AGT-008`、`C1-AGT-009`、`C1-CFG-038` | **高**：researcher 可只读且禁网，release agent 才拿发布 MCP；提高多 agent 隔离并减少误用。 | 中 | role 目前只有 model/maxTurns/tools/skills/systemPrompt；child 继承父 sandbox/MCP，depth 固定为 1。锚点：`agent-definition.ts`、`agent.ts`、child Engine config。 | `M`，6～9 人日，约 9～14 文件 |
| 7 | **CodeShell as MCP server**<br>`C1-RUN-016`、`C1-AGT-020`、`C1-AGT-021` | **高**：让其它 agent/IDE/工作流直接调用 CodeShell 的 run/reply/resume 能力，放大现有 harness 投资。 | 中 | 已有稳定 AgentServer stdio/TCP 和 session API，但没有 MCP server transport/tool facade。可先暴露 `codeshell`、`codeshell_reply` 两个工具。 | `M`，6～9 人日，约 8～13 文件 |
| 8 | **session 持久化策略：ephemeral、年龄/大小保留、清理报告**<br>`C1-FLAG-014`、`C1-SES-002`、`C1-SES-003`、`C1-SES-006` | **高**：CI 不落敏感 transcript；长期 desktop/daemon 不无限涨盘；清理行为可审计。 | 中 | 每次 run 都创建/续写 session；只有 `storageDir`，未见 transcript/session retention 配置。锚点：`session-manager.ts`、`transcript.ts`、settings、CLI/host cleanup。 | `M`，6～8 人日，约 8～13 文件 |
| 9 | **hook 内容 hash + review/re-trust**<br>`C1-EXT-025`、`C1-EXT-026` | **高（安全）**：插件升级后命令变化不会静默获得旧信任，降低供应链执行风险。 | 中 | untrusted project 会剥离项目 hook，这是已有边界；但已安装插件的 `hooks.json` 自动注册执行，按内容变更无 re-review。锚点：`loadPluginHooks.ts`、`pluginCommandHook.ts`、plugin update、settings hooks UI。 | `M`，7～10 人日，约 11～17 文件 |
| 10 | **OpenAI Responses API adapter**<br>`C1-MOD-011`、`C1-MOD-012`、`C1-MOD-013` | **高**：获得新模型原生 item/reasoning/tool 语义，也为 schema、service tier 和后续 provider 对齐打底。 | 高 | OpenAI provider 当前走 `chat.completions.create()`；需要新的流事件/工具调用/usage 映射和回归矩阵。锚点：`llm/providers/openai.ts`、`llm/types.ts`、TurnLoop。 | `L`，12～18 人日，约 14～22 文件 |
| 11 | **补齐 hook 生命周期**<br>`C1-EXT-027` | 中高：插件可在 compact 前保存状态，并准确观察 subagent start/stop；与既有 CC/Codex 插件兼容。 | 中低 | `events.ts` 明示 `pre_compact` reserved；`loadPluginHooks.ts` 明示跳过 `SubagentStop`；当前 subagent lifecycle 被塞进 notification kind。 | `S`，4～5 人日，约 7～10 文件 |
| 12 | **permission policy explain/check + named profiles**<br>`C1-SEC-014`、`C1-SEC-015`、`C1-SEC-016`、`C1-SEC-017`、`C1-CFG-053` | 中高：在执行前解释“这条命令为何 allow/ask/deny”，便于管理员测试策略和用户复现。 | 中 | classifier/rules/modes 已有，缺纯函数式 CLI checker、匹配轨迹和自定义 profile 选择。锚点：`permission.ts`、`path-policy.ts`、`permissions-command.ts`。 | `M`，6～8 人日，约 8～13 文件 |
| 13 | **OpenTelemetry exporter**<br>`C1-CFG-048` | 中高：生产 daemon、多 session、多 agent 的端到端 latency/error/token 追踪。 | 中高 | logger 已有 `span()`，analytics/diagnostics 为本地文件；无 OTLP exporter、trace context 或 metrics schema。锚点：`logging/logger.ts`、LLM spans、protocol、tool executor。 | `M`，8～10 人日，约 10～16 文件 |
| 14 | **原生 Windows sandbox backend**<br>`C1-SEC-020`、`C1-CFG-021` | 中高：Windows 用户不再依赖 WSL/Docker，安全默认一致。 | 高 | `sandbox auto` 在 Windows 退化为 off 并提示 WSL/Docker；类型只含 seatbelt/bwrap/off。锚点：`tool-system/sandbox/`、PowerShell tool、settings UI。 | `L`，15～20 人日外加平台 soak |
| 15 | **自动审批 reviewer（可选、默认关）**<br>`C1-SEC-010`、`C1-CFG-016`、`C1-CFG-017` | 中：长任务减少人工打断，同时保留比 approve-all 更细的判断。 | 中高 | `AutoApprovalBackend` 是确定性启发式，medium/high 无 delegate 时 fail-closed；尚无独立 reviewer model/policy/audit。 | `M`，8～10 人日，约 10～15 文件 |

## 可先做候选（TOP 8）

### TOP 1：无头 `--image` + prompt/stdin context

最小切片：`code-shell run "检查截图" --image a.png --image b.jpg`；当同时存在 positional prompt 和 pipe 时，将 pipe 包成明确的 `<stdin>` context，而不是丢弃。复用现有图片类型、大小、数量、vision 能力检查；JSONL 中记录附件 metadata，不输出 base64。

验收点：多图/逗号或 repeated flag、resume follow-up、非 vision model 的清晰错误、task+stdin 不丢数据、stdout 保持机器可读。

### TOP 2：公开 session fork

最小切片：新增 `session/fork { sourceSessionId, forkAtTurn? }`，返回新 session id；TUI `/fork [turn]` 切到新 session，desktop 先提供“从当前点分叉”。沿用 `parentSessionId`，原 session 保持只读不变。

验收点：指定 turn 截断、fork 后写入互不影响、当前 worktree/session workspace 语义明确、并发 fork 不冲突。

### TOP 3：doctor / debug bundle

最小切片：先做 `code-shell doctor [--json]`，输出版本、runtime、Git/cwd、配置源及覆盖、有效 model、凭据是否存在（绝不输出 secret）、sandbox backend、MCP 连接/工具数量、session inventory。随后复用数据源做 `/debug-config` 和“模型实际看到的 prompt sections”摘要。

验收点：稳定 JSON schema、全字段脱敏、单个探针失败不拖垮报告、退出码区分 healthy/warn/error。

### TOP 4：MCP 精细策略

建议分两期：

1. `required` + `enabledTools/disabledTools`，这是可靠性和 context 成本的直接收益；
2. 映射 MCP annotations 到审批风险；server instructions 仅在用户启用时作为“外部不可信 guidance”注入，不能绕过 system/project policy。

验收点：required 失败阻止 run、filter 在 tool 注册前生效、热重载会撤销 tool、未知 annotation 保守处理、项目 trust 继续 fail-closed。

### TOP 5：最终 JSON Schema

最小切片：CLI 接受 schema 文件；RunResult 增加结构化终态或 schema error；支持 native provider 时下推 schema，不支持时做本地校验与有界 repair。不要把 transport `--output json` 与模型内容 schema 混成一个开关。

验收点：合法结果稳定通过、非法结果有限重试、schema/validation error 进入 JSONL、resume 保持同一 schema 或显式覆盖。

### TOP 6：子 agent role 最小权限

最小切片：agent frontmatter 增加 `sandbox`、`network`、`mcpServers`；只能收窄父权限，不能从 read-only/deny 提升为写入/联网。之后再考虑可配置 `maxDepth/maxThreads`。

验收点：权限单调收窄、role 指定的 MCP 不会泄漏其它 server tools、resume child 继续使用原约束、UI 能显示实际约束。

### TOP 7：CodeShell MCP server facade

最小切片：stdio MCP server 暴露 `codeshell`（新任务）与 `codeshell_reply`（继续 session）两个工具，内部复用 AgentServer/EngineRunner，不复制 turn loop。输出只返回最终文本、session id、状态和精简 usage，详细进度走 logging 或可选 resources。

验收点：调用取消能传递、session 隔离、审批在无交互 client 下 fail-closed、不会把 host 用户配置误注入 isolated embedding。

### TOP 8：ephemeral + retention

最小切片：先实现 `run --ephemeral`，使用临时 session storage 并在进程退出清理；再加 user-level retention 配置和 `doctor` 清理预览，最后才做自动 sweep。

验收点：异常退出尽力清理、明确哪些日志仍会保留、不会删除活跃/归档/有 Goal 的 session、清理有 dry-run 和审计摘要。

## 暂不建议作为近期候选

- Codex cloud task、ChatGPT desktop handoff、remote-control pairing：产品生态绑定强，CodeShell 已有自己的 desktop/mobile remote/automation 路径。
- ChatGPT OAuth、Fast credits、Codex 专用模型名：属于账户与商业能力，不是通用 harness 原语。
- `/pets`、theme/title/keymap 等 TUI 个性化：体验项，不影响 agent 能力。
- Python SDK、CSV batch：AgentServer 协议和 MCP facade 稳定后可薄封装，不必先于协议能力建设。
- 完全复制 Codex transcript/rollout 文件格式：C1 也标注其不是稳定接口；CodeShell 应保持自己的 `state.json + transcript.jsonl` 契约。

## 建议圈定方式

若只圈一轮 1～2 周：选 **TOP 1 + TOP 2 + TOP 3**，三项都大量复用现有代码，能快速形成用户可见增益。  
若圈一个“harness 生产化”主题：选 **TOP 4 + TOP 6**，统一做 MCP 与子 agent 的最小权限。  
若圈一个“自动化 API”主题：选 **TOP 5 + TOP 7**，形成“可被调用 + 可被机器可靠消费”的闭环。  
TOP 8 适合与 doctor 同期设计，但自动清理应晚于 dry-run/report。

## 主要取证锚点

- CLI/输出：`packages/tui/src/cli/main.ts`、`packages/tui/src/cli/commands/run.ts`、`packages/tui/src/cli/input/read-stdin.ts`、`packages/tui/src/cli/output/renderer.ts`
- Session/协议：`packages/core/src/session/session-manager.ts`、`packages/core/src/session/transcript.ts`、`packages/core/src/protocol/server.ts`、`packages/core/src/protocol/client.ts`
- 权限/沙箱：`packages/core/src/tool-system/permission.ts`、`packages/core/src/tool-system/path-policy.ts`、`packages/core/src/tool-system/sandbox/`
- MCP/扩展：`packages/core/src/tool-system/mcp-manager.ts`、`packages/core/src/plugins/`、`packages/core/src/hooks/`、`packages/core/src/skills/scanner.ts`
- 配置/指令：`packages/core/src/settings/schema.ts`、`packages/core/src/settings/manager.ts`、`packages/core/src/prompt/instruction-scanner.ts`
- 模型：`packages/core/src/llm/`、`packages/core/src/model-catalog/`
- 编排：`packages/core/src/tool-system/builtin/agent.ts`、`packages/core/src/agent/agent-definition.ts`、`packages/core/src/cron/`、`packages/core/src/git/worktree/`
