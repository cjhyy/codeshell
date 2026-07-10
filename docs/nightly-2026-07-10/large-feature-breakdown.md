# 大功能升级拆解：可单会话落地的子项

日期：2026-07-10

性质：调研与排期输入；不代表已经进入实现队列

范围：`TODO.md`「大功能升级（体量 L）」全部 7 项；所有执行单元均控制在 M 及以下

## 结论先行

- 覆盖 **7/7** 个大 feature。
- 共列出 **110 行子任务**；其中 `CF-06 = AD-04`、`CF-12 = AD-02` 是跨 feature 共享交付，实际为 **108 个唯一执行单元**。
- 每个执行单元都标注了依赖、体量、源码/设计锚点以及能否独立先做。
- 文末给出 **TOP 15**「可先做的子项」。这些只是候选，仍应由用户圈定后再进入实现流水线。

体量口径：`XS` 为单点文档/测试/机械变更；`S` 为边界清楚的一组改动；`M` 为一个完整纵切或跨少量模块的单会话任务。表内的“可先做”是相对于本 feature 内部依赖而言；“条件”会写明外部输入或产品决策。

## 先纠正几处过期描述

本拆解以当前 worktree 源码为准，设计稿只作为方向输入，避免重复实现已经落地的内容。

1. **worktree 调研稿的 P0/P1 大部已完成**：已有 `SessionWorkspace` 持久指针、下一轮 cwd 切换、resume 恢复/缺失分支处理、Desktop workspace switcher，以及 DriveAgent `externalSessionId -> cwd` 绑定与 cwd 强制恢复。后续从“外部 agent 自动 per-run worktree”开始。
2. **凭证加密 P1 已完成，不再列为架构债子任务**：Desktop main 已安装 `SafeStorageCipher`，worker 通过 `CredentialAccess` 快照与 `desktop/credentialResolve`/cookie materialize RPC 取用，且已有迁移测试。锚点：`packages/desktop/src/main/index.ts:1611`、`packages/desktop/src/main/credential-access-service.ts:1`、`packages/core/src/credentials/access.ts:75`。
3. **Connections/Link 不再是完全静态壳**：已有固定 catalog、OAuth 凭证状态和退出；仍缺真实 login/refresh，以及 workspace 数据源绑定。锚点：`packages/desktop/src/renderer/credentials/LinkTab.tsx:13`、`:41`。
4. **插件面板的内置面板数已从设计稿的 6 个变成 7 个**：quick-chat 已加入，但 `PanelTab` union、`KINDS`/`META` 和渲染 switch 仍是手工多点维护。锚点：`packages/desktop/src/renderer/view.ts:18`、`packages/desktop/src/renderer/panels/PanelArea.tsx:108`、`:464`。
5. **旧 roadmap 的“只有两个测试文件”已严重过期**：当前扫描到约 728 个 test/spec/smoke 路径；真正缺口是 full-suite 稳定门、builtin 跨层集成、Electron e2e 基座和 coverage gate。CI 当前仍只运行 targeted suites：`.github/workflows/ci.yml:45`。
6. 当前大文件规模也已变化：`core/index.ts` 859 行、`desktop/main/index.ts` 3494 行、Desktop `App.tsx` 4257 行、TUI `App.tsx` 2369 行。`engine.ts` 拆分属于 TODO 的独立 M 项，本报告在“架构债 P1/P2”中明确排除。
7. **架构文档措辞债也已自然消失**：当前 `docs/architecture/00-overview.md:70` 明说支持直接构造 Engine，`docs/architecture/04-protocol-and-sessions.md:9` 只把 protocol seam 约束在 interactive hosts，不再声称所有 run 都强制过 client/server，因此不再拆成待做任务。

## 跨 feature 依赖与去重

| 共享点 | 只执行一次的归属 | 其他 feature 如何使用 |
|---|---|---|
| public/internal entry 与 subpath exports | `CF-12` | 架构债 `AD-02` 直接引用，不另开重复 PR |
| Arena 从默认 builtin 改为可选能力 | `CF-06` | 架构债 `AD-04` 直接引用；真正移包再做 `AD-09/10` |
| Electron mock-provider/e2e | `EQ-06`–`EQ-13` | 插件面板、Profile、数据源、worktree 后续纵切复用同一 harness |
| OAuth/credential 底座 | 已落地基线 | 数据源 schema/store 不必等待真实 OAuth login；接真实 Figma/云盘时再依赖 OAuth 后续 |
| WorkspaceProfile 与数据源 | Profile MVP 不依赖数据源 | `DS-12` 后置把数据源 binding 与 active Profile 求交，不阻塞两边基础闭环 |

---

## 1. core 通用化 + 插件面板

### 当前基线与结束条件

设计源：`docs/todo/core-harness-and-plugin-panels.md`。当前 core 的 Electron 依赖边界是干净的，问题集中在默认能力、注册元数据、coding 载荷和插件 UI 扩展点。完成本 feature 的最低标准是：`harness-min` 可在非 git 目录运行；宿主显式选择能力模块；插件 panel 能通过沙箱 host 和最小权限 bridge 完成一条端到端路径。

| ID | 有序子任务（交付/验收） | 依赖 | 体量 | 锚点 | 可独立先做 |
|---|---|---|---|---|---|
| CF-01 | **工具元数据单一来源**：给 builtin entry 增加 preset/default-enabled 元数据，由 `BUILTIN_TOOLS` 派生 preset 名单；先加“派生结果等于现名单”快照，保证零行为变化。 | 无 | S | `packages/core/src/preset/index.ts:34`；`packages/core/src/tool-system/builtin/index.ts:167`；`packages/core/src/preset/preset-builtin-tools.test.ts:12` | **是** |
| CF-02 | **PanelRegistry 收敛内置面板**：`PanelTab` 改为可扩展 string/descriptor，合并 `KINDS`、`META`、label、render；未知 kind 显示占位且旧 panelState 可读。 | 无 | M | `packages/desktop/src/renderer/view.ts:18`；`packages/desktop/src/renderer/panels/PanelArea.tsx:108`、`:118`、`:464` | **是** |
| CF-03 | **参数化 4 个 git 触点**：instruction 扫描边界改为 fs marker/注入；git status 变 system-context provider；setup script 从 Engine 门面移入 worktree 生命周期；ArtifactTracker 用 detector 注册制。四点均配行为保持测试。 | 无 | M | `packages/core/src/prompt/instruction-scanner.ts:83`、`:178`；`prompt/composer.ts:104`；`engine/engine.ts:3350`；`run/ArtifactTracker.ts:151` | **是** |
| CF-04 | **`harness-min` preset + 纯度守卫**：只保留通用工具；在非 git 目录跑 mock LLM 一轮，断言 prompt/tool table 无 coding/git 且不执行 git。 | CF-01、CF-03 | M | `packages/core/src/preset/index.ts:196`；`packages/core/src/engine/engine.no-repo-whitelist.test.ts:105`；设计稿 §B② | 否 |
| CF-05 | **CapabilityModule 最小装配协议**：定义 tools/hooks/rpc/settings fragment、冲突规则和 Engine/ToolRegistry 装配点；先用测试模块验证注册/卸载，不开放第三方进程内代码。 | CF-01 | M | `packages/core/src/engine/types.ts:32`；`packages/core/src/tool-system/registry.ts:19`；设计稿 §B③ | 否 |
| CF-06 | **Arena 改为可选 CapabilityModule**：默认 builtin 不再无条件注册；Desktop/TUI 显式装配，协议和 settings 仍先兼容。此项同时完成架构债 `AD-04`。 | CF-05、AD-03 | M | `packages/core/src/tool-system/builtin/index.ts:667`；`packages/core/src/protocol/server.ts:1588`；`packages/core/src/settings/schema.ts:404` | 否 |
| CF-07 | **迁移一个低风险真实能力模块**：优先 browser 或 media，把工具/guard/宿主依赖完整挂到 CapabilityModule，形成后续迁移模板；不要一次搬完四类。 | CF-05 | M | `packages/core/src/tool-system/builtin/index.ts:172`；`packages/core/src/tool-system/browser-bridge.ts`；设计稿 §B③ | 否 |
| CF-08 | **coding pack 注册与默认值反转**：先不搬目录；把 coding prompt、工具集合和 git provider 组合成模块，kernel 默认不含，Desktop/TUI coding host 显式启用。 | CF-03、CF-05、CF-06 | M | `packages/core/src/preset/index.ts:127`；`packages/core/src/prompt/sections/coding.md`；设计稿 §B④ | 否 |
| CF-09 | **coding pack 物理外移第一批**：建立包/子路径边界，迁移 git、worktree、review、LSP 和 coding prompt；保持 import adapter 与 public behavior。 | CF-08、CF-12 | M | `packages/core/src/git/`；`packages/core/src/lsp/`；`packages/core/src/review/`；`packages/core/src/tool-system/builtin/worktree.ts` | 否 |
| CF-10 | **coding pack 外移第二批**：迁移 external-agent/quota/ApplyPatch/NotebookEdit/Brief；把 cc-orchestrator 的 CLI adapter 留在能力包、房间/发现桥移向 Desktop。 | CF-09 | M | `packages/core/src/cc-orchestrator/`；`packages/core/src/quota/`；设计稿 §B④ | 否 |
| CF-11 | **宿主载荷搬家**：先 grep 消费者，再把 updater/notifier/analytics/diagnostics/确认无用的 remote 移到 Desktop；memory/dream 管线留 core。 | CF-05 | M | `packages/core/src/updater.ts`；`packages/core/src/services/notifier.ts`；`packages/core/src/remote/`；设计稿 §B⑤ | 条件（先完成消费者清单） |
| CF-12 | **分层入口与 subpath exports**：稳定 SDK 留 `index.ts`，in-repo 宿主走 `./internal`，Arena 先标 internal/experimental；只做机械分层和 import 改写。此项也是 `AD-02`。 | AD-01（且宜早于 CF-09） | M | `packages/core/src/index.ts:281`、`:459`；`packages/core/package.json:8`；`docs/todo/architecture-debt.md:26` | 否 |
| CF-13 | **HostProfile/createHost 收口**：抽出宿主配置模板和受控 override，迁移 Desktop worker、TUI repl/run、automation、TCP、dream、seed 等构造点；更新 engine-bypass allowlist。 | CF-05；CF-12 建议先做 | M | `packages/core/src/protocol/factories.ts:13`；`packages/core/src/cli/agent-server-stdio.ts:132`；`packages/desktop/src/main/automation-host.ts:123`；`scripts/check-no-engine-bypass.sh` | 否 |
| CF-14 | **插件 panels manifest/schema**：定义 versioned `panels[]`、本地化 title、icon/entry/permissions；校验 id/entry containment，旧 manifest 继续通过。 | 无 | S | `packages/core/src/plugins/installer/types.ts:4`；`packages/core/src/plugins/pluginContent.ts`；设计稿 §D.1 | **是** |
| CF-15 | **panel descriptor 发现与动态 registry**：main/plugins service 提供 `listPanels()`，kind 使用 `plugin:<installKey>:<panelId>`；disable/uninstall 时移除 descriptor、保留旧 tab 占位。 | CF-02、CF-14 | M | `packages/core/src/plugins/installer/list.ts`；`packages/desktop/src/renderer/panels/PanelArea.tsx:108`；设计稿 §D.2 | 否 |
| CF-16 | **`csplugin://` 只读协议**：从 installKey 映射 cache 目录；入口和每次资源请求都做 realpath 双侧 containment、拒绝 symlink/编码穿越，并加恶意路径测试。 | CF-14 | M | `packages/core/src/plugins/pluginInstaller.ts:77`；`packages/core/src/plugins/resolveSafePluginPath.test.ts`；`packages/core/src/plugins/installMaliciousName.test.ts`；设计稿 §D.3 | 否 |
| CF-17 | **PluginPanelHost 沙箱**：独立 partition、无 Node、严格 CSP 的 iframe/webContents host；只加载 `csplugin://`，崩溃/禁用有占位和回收。 | CF-02、CF-15、CF-16 | M | `packages/desktop/src/renderer/panels/PanelArea.tsx:427`；`packages/desktop/src/main/index.ts` 的 webview hardening；设计稿 §D.4 | 否 |
| CF-18 | **scoped bridge + 权限执行器**：实现 `call/on/context` 最小 API；默认零权限、method 白名单、session 事件过滤，高危调用复用 approval，不向 panel 暴露裸 `agent:msg`。 | CF-17 | M | `packages/desktop/src/main/agent-bridge.ts:740`；`packages/desktop/src/preload/index.ts:196`；设计稿 §D.5 | 否 |
| CF-19 | **权限展示与参考插件纵切**：安装/详情展示 panels 权限；做一个只读示例 panel 调自身 MCP resource，覆盖 install→open→call→disable→占位的 Electron smoke。 | CF-18、EQ-08 | M | `packages/desktop/src/renderer/extensions/`；`packages/core/src/plugins/pluginContent.ts`；设计稿 §D.6–7 | 否 |

推荐顺序：`CF-01 || CF-02 || CF-14 || AD-01→CF-12` → `CF-03` → `CF-04/05` → `AD-03→CF-06`、`CF-07/08` → `CF-09/10/11/13`；插件面板链 `CF-15→19` 只依赖 `CF-02/14`，可与 core 后半并行排期。

---

## 2. 聊天软件 channel / IM gateway

### 当前基线与结束条件

设计源：`docs/todo/im-gateway-remote-orchestration.md`。Tunnel、remote host、passcode、pairing 和 `mobileRemote:start/stop/status` 已存在，但只暴露在 Electron IPC。MVP 结束条件是 Telegram 私聊中完成 `/open → 一次性入口回推 → /status → /close`，gateway 仍只是通道，不承担 AI 编排。

| ID | 有序子任务（交付/验收） | 依赖 | 体量 | 锚点 | 可独立先做 |
|---|---|---|---|---|---|
| IG-01 | **本地控制协议 + 威胁模型 ADR**：定方案 A 的进程/启动/认证边界、命令幂等和并发语义；明确 pairing URL 整体视作短期 secret，只能回白名单私聊、不得进日志/状态缓存。 | 无 | S | `docs/todo/im-gateway-remote-orchestration.md:38`、`:98`；`packages/desktop/src/main/index.ts:2460` | **是** |
| IG-02 | **抽 RemoteControl service**：把 IPC handler 内 start/stop/status/pairing 编排提成可测试服务，renderer IPC 与未来本地 RPC 共用；保持现有 in-flight mutex。 | IG-01 | M | `packages/desktop/src/main/index.ts:2473`、`:2529`、`:2536`、`:2540` | 否 |
| IG-03 | **gateway 包/进程骨架与配置**：独立 headless 入口、结构化日志、优雅退出；bot token/白名单写 owner-only 文件并统一 redaction。 | IG-01 | M | `docs/todo/im-gateway-remote-orchestration.md:38`；`packages/core/src/logging/`；`packages/desktop/package.json` | 否 |
| IG-04 | **认证 loopback RPC + Desktop 唤起**：gateway 可发现/拉起 app，使用短期 challenge 或本机 secret 调 IG-02；断线返回“桌面端未在线”，禁止公网监听。 | IG-02、IG-03 | M | `packages/desktop/src/main/index.ts:2473`；设计稿 §三方案 A、§八 | 否 |
| IG-05 | **GatewayCommand/IM Adapter 核心**：统一 receive/send、`/open\|close\|status` parse、sender allowlist、速率限制、重复 update 去重和每 chat 串行队列。 | IG-03 | M | `docs/todo/im-gateway-remote-orchestration.md:53`、`:74`、`:98` | 否 |
| IG-06 | **Telegram adapter**：先用 long polling，处理 offset 持久化、文本/链接回复、429 retry-after 和关停；adapter 不包含 tunnel 业务。 | IG-05 | M | `docs/todo/im-gateway-remote-orchestration.md:58`、`:122` | 否 |
| IG-07 | **`/status` 只读纵切**：回 tunnel running/connected、host mode、已连接设备数；不得生成新 pairing token或回显 passcode。 | IG-04、IG-05、IG-06 | S | `packages/desktop/src/main/index.ts:2540`；`packages/desktop/src/preload/types.d.ts:1301` | 否 |
| IG-08 | **`/open` + `/close` 闭环**：`/open` 复用 tunnel start 并只在成功后 mint pairing URL/expiry；`/close` 幂等清理 tunnel+host，失败不留孤儿进程。 | IG-04、IG-06；IG-07 建议先做 | M | `packages/desktop/src/main/mobile-remote/tunnel-manager.ts:76`；`remote-host-manager.ts:257`；`main/index.ts:2473` | 否 |
| IG-09 | **错误、重试与 fake-adapter e2e**：覆盖二进制缺失、端口占用、edge 未 ready、RPC 断开、Telegram 429/5xx；断言日志无 bot token/pairing URL。 | IG-07、IG-08 | M | `packages/desktop/src/main/mobile-remote/tunnel-manager.test.ts`；设计稿 §八 | 否 |
| IG-10 | **assistant dispatch seam**：仅定义 `dispatchToAssistant(command, context)` 和“主体不可用”的稳定 fallback；不实现跨 session 编排。 | IG-05 | S | `docs/todo/im-gateway-remote-orchestration.md:86`；`TODO.md:46` | 否（可在 MVP 尾部） |
| IG-11 | **系统守护与可观测性**：提供 launchd/systemd 安装/卸载/状态命令，崩溃有界重启；secret 与日志路径明确。 | IG-09 | M | `docs/todo/im-gateway-remote-orchestration.md:38`、`:113` | 否（Phase 2） |
| IG-12 | **Lark/飞书 adapter**：按同一 adapter 接事件订阅、签名校验和目标映射；不得为其复制 Gateway Core。 | IG-05、IG-09 | M | `docs/todo/im-gateway-remote-orchestration.md:58`、`:122` | 否（Phase 2） |

推荐顺序：`IG-01→02/03→04/05→06→07→08→09`；`IG-10` 只留接口，`IG-11/12` 在 Telegram MVP 稳定后做。

---

## 3. Workspace / Profile / 数字人

### 当前基线与结束条件

设计源：`docs/todo/workspace-profile-讨论稿.md`。已有 project-scoped `CapabilityOverrides`、preset、plugin、主/项目指令和两层 memory；缺 Profile source of truth、可逆事务、指令 provenance、portable memory 与 Team Board。MVP 明确不做 marketplace、不同时激活多个 Profile、不做 agent 总指挥。

这里有两个必须先解决的设计缝隙：

- **override 所有权**：Profile 若直接把 capability key 写成 `on`，关闭时无法区分“Profile 写的”与“用户原本手调的”，不能简单删除或改 `off`。
- **第三层记忆语义不一致**：讨论稿文字称项目经验是“workspace × 数字人”，但当前 `MemoryManager({ projectDir })` 只按 project 分桶。要么 MVP 明确项目经验在 Profile 间共享，要么把 project memory 再按 profile 分桶；不能含糊实现。

| ID | 有序子任务（交付/验收） | 依赖 | 体量 | 锚点 | 可独立先做 |
|---|---|---|---|---|---|
| WP-01 | **Profile MVP ADR 收口**：拍板 schema version、UI/API 名称、activation ownership ledger、项目记忆是否按 Profile 分桶、team 存储位置和指令冲突可观测性。 | 无 | S | `docs/todo/workspace-profile-讨论稿.md:350`；`packages/core/src/settings/schema.ts:25`；`session/memory.ts:194` | **是** |
| WP-02 | **Seedance 手工体验 spike**：不造抽象，使用现有 `capabilityOverrides` 和项目指令，在隔离试验目录验证装上/三阶段/关闭消失，并记录能力清单和失败点。 | 无 | S | `docs/todo/workspace-profile-讨论稿.md:223`；`packages/core/src/capability-control/overlay.ts` | **条件**（需拿到 Seedance 包/素材） |
| WP-03 | **WorkspaceProfile 类型与 versioned schema**：覆盖 basePreset、plugins/skills/mcp/agents、mainInstruction、portableMemory 和包元信息；拒绝路径穿越/重复 id。 | WP-01 | S | `docs/todo/workspace-profile-讨论稿.md:95`；`packages/core/src/settings/schema.ts:53` | 否 |
| WP-04 | **全局 ProfileRepository**：从 `~/.code-shell/profiles/<name>/profile.json` 安全 list/get/validate；损坏包隔离报错，不影响其他 Profile。 | WP-03 | M | `docs/todo/workspace-profile-讨论稿.md:175`；`packages/core/src/plugins/installer/paths.ts`；`settings/manager.ts` 的 `userHome()` | 否 |
| WP-05 | **纯 activation planner**：给当前 settings + A/B Profile 算出 remove/restore/apply diff；保存每个 managed key 的前值/所有者，保证关闭可恢复用户原配置。 | WP-03 | M | `packages/core/src/settings/schema.ts:25`；`packages/core/src/capability-control/overlay.ts`；讨论稿 §5.2/5.4 | 否 |
| WP-06 | **原子 activate/switch/close 事务**：临时文件+rename 写 project settings；任一步失败回滚，activeProfile 与 overrides 不出现半状态；同 workspace 加写锁。 | WP-04、WP-05 | M | `packages/core/src/settings/manager.ts:425`；`docs/todo/workspace-profile-讨论稿.md:148`、`:223` | 否 |
| WP-07 | **运行时服务/API 与 next-turn 热生效**：提供 list/status/activate/switch/close，接 settingsBus/reload；明确当前轮不变、下一轮生效。 | WP-06 | M | `packages/core/src/settings/disk-defaults.ts:15`；`packages/core/src/engine/engine.ts:2629`；讨论稿 §5.4 | 否 |
| WP-08 | **mainInstruction 注入与优先级测试**：加入独立 system section/provenance，落实项目指令 > Profile > basePreset；切换后 cache 不复用旧 Profile 内容。 | WP-03、WP-07 | M | `packages/core/src/prompt/composer.ts:241`、`:273`；`prompt/__tests__/composer-instructions-compat.test.ts` | 否 |
| WP-09 | **Profile 影响预览/诊断**：展示将开启/关闭的能力、指令来源及冲突；为“能力为何消失/指令来自哪”提供只读 explain API。 | WP-05、WP-08 | S | `packages/desktop/src/main/capabilities-service.ts:31`；讨论稿 §Profile Switcher | 否 |
| WP-10 | **portable memory 读取层**：active Profile 开启时，用 Profile 目录作为 `baseDir` 建 manager，按 WP-01 的顺序合并 global/Profile/project index；Profile 不可用时 fail closed。 | WP-01、WP-04、WP-07 | M | `packages/core/src/session/memory.ts:153`、`:186`、`:798`；`prompt/composer.ts:302` | 否 |
| WP-11 | **Profile dream/写入路由与冲突规则**：定义 Save/Read 的 location、同 id/name 去重、promotion/soft-delete 边界；确保 dream 不跨 Profile 污染且不改 manual。 | WP-10 | M | `packages/core/src/services/memory-orchestrator.ts:416`；`dream-consolidation.ts:87`；`docs/todo/memory-final-design.md:25` | 否 |
| WP-12 | **Profile Switcher UI**：显示当前 Profile、影响摘要、switch/close 确认与失败回滚；同 cwd 多工位明确为互斥切换。 | WP-07、WP-09 | M | `packages/desktop/src/renderer/settings/ConversationSettingsSection.tsx`；讨论稿 §Profile Switcher | 否 |
| WP-13 | **Profile Builder UI**：编辑 schema 支持的字段、选择已有能力、预览并本地保存；不接 marketplace。 | WP-04、WP-09 | M | `packages/desktop/src/renderer/extensions/`；讨论稿 §Profile Builder | 否 |
| WP-14 | **Team v1 schema/store**：定义 team/workstation（cwd + profile + label），路径 canonicalize、重复成员规则和全局存储；不引入运行时调度。 | WP-01、WP-04 | S | `docs/todo/workspace-profile-讨论稿.md:306`、`:328` | 否 |
| WP-15 | **Team Board 总览与导航**：列工位/当前数字人/状态，点击进入 workspace；同 cwd 工位先执行 Profile switch，再导航，失败不改变当前页。 | WP-12、WP-14 | M | `docs/todo/workspace-profile-讨论稿.md:328`；`packages/desktop/src/renderer/panels/PanelArea.tsx:108` | 否 |
| WP-16 | **轻量 handoff note**：用户显式把当前摘要带到另一个工位；只存/复制 note，不自动派活或汇总。 | WP-15 | S | `docs/todo/workspace-profile-讨论稿.md:282`、`:322` | 否（MVP 后半） |
| WP-17 | **本地导入/导出**：Profile 包 canonical layout、schema 校验、冲突策略和安全解包；portable memory 是否随包导出必须显式选择。 | WP-04、WP-10 | M | `docs/todo/workspace-profile-讨论稿.md:175`、`:223`；`packages/core/src/plugins/installer/installFromArchive.ts` | 否 |
| WP-18 | **降级为 plugin 的数据边界**：只转换 agents/skills/mcp/plugin 同构层，明确丢弃 mainInstruction/memory；做 round-trip/损失清单，不接远程发布。 | WP-03、WP-17 | M | `docs/todo/workspace-profile-讨论稿.md:175`；`packages/core/src/plugins/installer/types.ts:4` | 否（P4） |

推荐顺序：`WP-01` 与有素材时的 `WP-02` → `WP-03/04/05` → `WP-06/07/08`，此处已构成本地数字人最小闭环；再做 `WP-09→13`、`WP-10→11`、`WP-14→16`，最后导入导出。

---

## 4. Workspace 数据源绑定

### 当前基线与结束条件

此项没有独立的完整设计稿；相关输入是 `docs/todo/mcp-http-auth-oauth-link-tech-design.md`、`docs/todo/credentials-partition-mismatch-plan.md` 和 WorkspaceProfile 讨论稿。当前已有 MCP server/resource、CredentialStore、Connections catalog 与 project capability overlay，但没有“连接定义—workspace binding—本轮可读资源”的独立模型。

建议固定三层，避免把所有东西再次塞进 `mcpServers`：

```text
Connection/SourceDefinition（全局：服务是什么、用哪个 adapter/credential）
  └─ WorkspaceSourceBinding（项目级：此 workspace 可见哪些 scope/resource）
       └─ EffectiveSourceAccess（运行时：再与 active Profile、权限、连接状态求交）
```

MVP 只注入数据源的名称/范围/状态，真实内容必须经显式 read surface 与审批读取，不能把 Figma/issue/云盘内容整包塞进 system prompt。

| ID | 有序子任务（交付/验收） | 依赖 | 体量 | 锚点 | 可独立先做 |
|---|---|---|---|---|---|
| DS-01 | **数据源 ADR + 威胁模型**：定三层模型、source id、scope selector、Profile 求交、credential 归属、撤销语义，以及 MCP resource 与专用 connector 的边界。 | 无 | S | `TODO.md:36`；`docs/todo/mcp-http-auth-oauth-link-tech-design.md:102`；`packages/core/src/settings/schema.ts:25` | **是** |
| DS-02 | **versioned schema/types**：定义 SourceDefinition、WorkspaceSourceBinding、selector/readPolicy；project settings 只存 ref/scope，不存 secret/token。 | DS-01 | S | `packages/core/src/settings/schema.ts:25`、`:299`；`packages/core/src/credentials/types.ts:6` | 否 |
| DS-03 | **全局 SourceCatalog/Connection store**：CRUD、schema migration、损坏项隔离；支持 `mcp-resource` 和 `mock` 两种 kind 先行。 | DS-02 | M | `packages/desktop/src/renderer/credentials/link-catalog.ts:33`；`packages/core/src/model-catalog/` 的存储模式 | 否 |
| DS-04 | **project binding 持久化与 effective overlay**：读写 `${cwd}/.code-shell/settings.json`，合并全局 source 状态；source 删除/禁用后 binding 显示 dangling 而非静默换源。 | DS-02、DS-03 | M | `packages/core/src/settings/manager.ts:425`；`packages/core/src/capability-control/overlay.ts` | 否 |
| DS-05 | **credentialRef 校验与撤销传播**：保存 binding 时只校验 metadata/type；运行时按 user/project scope resolve，凭证删除/过期后立即 unavailable，日志仅含 id。 | DS-03、DS-04 | S | `packages/desktop/src/main/credential-access-service.ts:15`；`packages/core/src/credentials/access.ts:75` | 否 |
| DS-06 | **ConnectorAdapter + MCP resource adapter**：统一 listScopes/listResources/read；第一实现包装现有 MCP List/Read，不为 Figma/Notion 写 core 特判。 | DS-01、DS-03 | M | `packages/core/src/tool-system/mcp-manager.ts`；`packages/core/src/tool-system/builtin/index.ts:640`；OAuth 设计 §3 | 否 |
| DS-07 | **EffectiveSourceAccess resolver**：以 cwd、binding、source enabled、credential status、active Profile 和 session permission 求交；默认 deny，不能靠 UI 隐藏充当授权。 | DS-04、DS-05、DS-06 | M | `packages/core/src/capability-control/service.ts`；`packages/core/src/tool-system/permission.ts` | 否 |
| DS-08 | **Connections UI 数据化**：从 store 渲染 catalog/连接状态/凭证状态，保留当前 OAuth catalog；增加 add/edit/test/disable，不实现 workspace 分配。 | DS-03、DS-05 | M | `packages/desktop/src/renderer/credentials/LinkTab.tsx:13`、`:41`；`McpSection.tsx:1188` | 否 |
| DS-09 | **workspace binding editor + scope picker**：在 project context 选择 source、账号与资源 scope，预览 effective access；不能把“全盘云盘”当无提示默认。 | DS-04、DS-07、DS-08 | M | `packages/desktop/src/renderer/settings/SettingsView.tsx`；`packages/desktop/src/main/capabilities-service.ts:31` | 否 |
| DS-10 | **运行时 metadata 注入**：动态 context 只列已绑定源、可用状态和 scope 摘要，变化不破坏静态 system cache；无源时完全不注入。 | DS-07 | S | `packages/core/src/prompt/composer.ts:255`；`packages/core/src/prompt/composer-dynamic-context.test.ts` | 否 |
| DS-11 | **统一读取面与审批**：list metadata 可自动允许；read content 默认 ask，并对 source/scope/resource id 二次校验；tool result 带 provenance、大小上限与 secret redaction。 | DS-06、DS-07、DS-10 | M | `packages/core/src/preset/index.ts:162`；`packages/core/src/tool-system/mcp-manager.ts`；`ReadMcpResource` 注册处 | 否 |
| DS-12 | **与 active Profile 求交**：Profile 可声明需要/建议的 source scope，但不能越过 workspace binding；切 Profile 下一轮刷新 effective access。 | DS-07、WP-07 | M | `docs/todo/workspace-profile-讨论稿.md:121`；`packages/core/src/settings/schema.ts:25` | 否（双方基础闭环后） |
| DS-13 | **mock connector 纵切 e2e**：本地 fake source 暴露两个 scope/三条 resource，覆盖 connect→bind→list→approve read→unbind→拒绝，证明模型无 provider 特判。 | DS-08、DS-09、DS-11、EQ-08 | M | `docs/todo/smoke-automation-mock-provider.md:19` 的隔离模式；`packages/core/src/tool-system/mcp-manager.test.ts` | 否 |
| DS-14 | **审计/撤销/故障测试**：覆盖 credential 过期、source disabled、binding dangling、scope 缩小、Profile 切换、跨 workspace 访问和内容超限。 | DS-11、DS-12、DS-13 | M | `packages/core/src/credentials/access.test.ts`；`packages/core/src/capability-control/project.test.ts` | 否 |

推荐顺序：先单独完成 `DS-01`；随后 `DS-02→04` 与 `DS-03→08`，再做 runtime `DS-06/07/10/11`，最后 UI 绑定纵切和 Profile 集成。真实 OAuth login 或真实 Figma adapter 不应阻塞 mock/MCP MVP。

---

## 5. worktree session 隔离深化（外部 agent 自动隔离）

### 当前基线与结束条件

设计源：`docs/todo/worktree-session-isolation-research.md`。当前已完成 session workspace mode 与外部 CLI resume cwd 防漂移；DriveAgent 仍要求调用者给 cwd，并直接在那里运行。`ExternalAgentSessionBinding` 虽已有 `worktreePath/worktreeBranch` 字段，`recordSuccessfulSession()` 当前只记录 cli/sessionId/cwd，尚未建立自动 worktree 生命周期。

最低结束条件：两次并行 writable DriveAgent 默认可进入各自 per-run worktree；完成/失败/取消后有确定的保留/清理状态；resume 绝不悄悄落回 main checkout。

| ID | 有序子任务（交付/验收） | 依赖 | 体量 | 锚点 | 可独立先做 |
|---|---|---|---|---|---|
| WT-01 | **isolation 语义 ADR**：定义 `current/worktree/none` 的差别、默认值、foreground/background、非 git cwd、resume、dirty diff 和 cleanup matrix；明确不自动 merge。 | 无 | S | `docs/todo/worktree-session-isolation-research.md:331`；`packages/core/src/tool-system/builtin/drive-claude-code.ts:463` | **是** |
| WT-02 | **DriveAgent 参数与 effective policy**：增加 isolation/baseRef/include 选项和纯 resolver；`current` 用 session workspace、`none` 严格用显式 cwd、`worktree` 进入自动创建链。 | WT-01 | S | `packages/core/src/tool-system/builtin/drive-claude-code.ts:61`、`:463`；`tool-system/context.ts` 的 workspace bridge | 否 |
| WT-03 | **per-run worktree factory**：复用 git/worktree CRUD 创建独立 branch/path、跑 setup，创建失败不得启动外部 CLI；branch/path 带 job/run 唯一性。 | WT-02 | M | `packages/core/src/git/worktree/crud.ts:55`；`packages/core/src/tool-system/builtin/worktree.ts:406` | 否 |
| WT-04 | **binding/job metadata 完整持久化**：在 CLI 返回 sessionId 后记录 codeShellSessionId、workspaceRoot、worktree path/branch/baseRef；background panel/通知同时携带。 | WT-03 | M | `packages/core/src/cc-orchestrator/external-agent-session-store.ts:13`；`drive-claude-code.ts:256`、`:418` | 否 |
| WT-05 | **resume 守卫与可重建路径**：原 worktree 存在则强制使用；目录缺失但 branch 在时返回“重建或 detach”显式动作；branch 也没了则拒绝，绝不 fallback main。 | WT-04 | M | `packages/core/src/tool-system/builtin/drive-claude-code.ts:487`；`external-agent-session-store.ts:1` | 否 |
| WT-06 | **完成后的 diff/commit 分类器**：纯函数输出 clean、dirty、ahead、conflict/unknown，并给出 auto-clean/keep/review 建议；unknown 一律保留。 | WT-03 | M | `packages/core/src/git/worktree/diff.ts`；`packages/core/src/git/worktree/query.ts`；`background-jobs.ts:40` | 否 |
| WT-07 | **生命周期通知与 Desktop 操作**：完成卡显示 cwd/branch/diff，提供 keep/detach/discard；occupied/dirty 时禁用危险清理，动作复用 session-workspace service。 | WT-04、WT-06 | M | `packages/desktop/src/main/session-workspace-service.ts:19`；`renderer/topbar/WorkspaceIndicator.tsx:396`；`renderer/messages/FilesChangedCard.tsx` | 否 |
| WT-08 | **cancel/crash/timeout 清理**：外部进程先终止，再按分类器清理；有改动或无法确认时保留并通知，创建到 spawn 之间失败也不遗留无主 worktree。 | WT-03、WT-06 | M | `packages/core/src/tool-system/builtin/background-jobs.ts:106`；`drive-claude-code.ts:418` | 否 |
| WT-09 | **原生 subagent isolation**：给 `Agent` 请求增加 worktree policy，child Engine 与 session binding 使用自己的 root；与 DriveAgent 共用 factory/生命周期，不共享 active singleton。 | WT-03、WT-06 | M | `packages/core/src/tool-system/builtin/agent.ts:646`；`packages/core/src/engine/engine.ts:1087` | 否 |
| WT-10 | **`.worktreeinclude` 等价能力**：解析受限规则，复制 gitignored config/env；拒绝绝对路径、`..`、越界 symlink，敏感文件不打印内容。 | WT-03 | M | `packages/core/src/git/worktree-setup.test.ts`；`docs/todo/worktree-session-isolation-research.md:338` | 否 |
| WT-11 | **baseRef 策略 + git lock**：实现 `head/fresh/explicit` 的 ref 校验；运行期间 `git worktree lock`，终态可靠 unlock，resume 保持原 baseRef。 | WT-03、WT-04 | M | `packages/core/src/types.ts:215`；`packages/core/src/git/worktree/query.ts`；调研稿 §2/§8 P3 | 否 |
| WT-12 | **stale cleanup 感知 binding/lock**：启动清扫排除 running job、session owner、external binding 和 locked worktree；只自动删 clean 且超时项，其余进 review list。 | WT-04、WT-06、WT-11 | M | `packages/desktop/src/renderer/App.tsx:915`；`renderer/gitPrefs.ts:13`；`session-workspace-service.ts` | 否 |
| WT-13 | **并行隔离 e2e**：fake runner 同时修改同名文件，断言两个不同 cwd/branch、main checkout 不变、各自 changedFiles 正确，cancel 一路不删另一条。 | WT-07、WT-08、EQ-03 | M | `packages/core/src/tool-system/builtin/drive-claude-code.test.ts:367`；`packages/desktop/src/main/session-workspace-service.test.ts:283` | 否 |

推荐顺序：`WT-01→02→03→04→05/06→07/08` 形成 DriveAgent MVP；再做 subagent、include/baseRef/lock 和 stale cleanup。不要先做自动清理，再补 ownership。

---

## 6. 工程质量 P7：builtin tools 集成测试 / Electron e2e / CI 覆盖率

### 当前基线与结束条件

设计源：`docs/todo/smoke-automation-mock-provider.md` 与批准的完整 spec `docs/superpowers/specs/2026-07-02-smoke-automation-mock-provider-design.md`。现有单测很多，Playwright 和一次性 `smoke-panels.mjs` 也存在；缺的是可复用 fixture、隔离 HOME、真实 provider wire mock、full-suite/coverage 的可信基线与分层 CI。

顺序必须是“先让 suite 与 e2e 稳定，再设覆盖率阈值”。直接上百分比会把既有失败、生成文件和平台分支混成噪声。

| ID | 有序子任务（交付/验收） | 依赖 | 体量 | 锚点 | 可独立先做 |
|---|---|---|---|---|---|
| EQ-01 | **full-suite 事实基线与清扫清单**：运行完整 `bun test`，分类 deterministic failure、真实平台限定、real-provider opt-in 和 flaky；输出机器可读 allowlist/owner，目标是默认 full suite 可重复绿。 | 无 | S | `package.json:17`；`.github/workflows/ci.yml:45`；`docs/todo/roadmap.md:90` | **是** |
| EQ-02 | **builtin 风险/覆盖矩阵**：从 `BUILTIN_TOOLS` 派生清单，按 read/write/path/permission/background/bridge 分类，标记 unit、registry integration、host e2e 缺口；CI 检查新工具必须登记。 | 无 | S | `packages/core/src/tool-system/builtin/index.ts:172`；`validate-tool-metadata.test.ts`；`docs/architecture/02-tool-system.md:118` | **是** |
| EQ-03 | **共享 ToolRegistry 集成 harness**：统一 fake ToolContext、cwd/temp HOME、permission decision、abort/timeout 和 result snapshot；测试真正走 registry/executor，不直接调用函数。 | EQ-02 | M | `packages/core/src/tool-system/registry.ts:19`、`:35`；`tool-system/__tests__/` | 否 |
| EQ-04 | **表驱动 builtin 基础集成组**：先覆盖 read-only 与本地 mutation/path-policy 两组，验证 metadata、visibility、permission、cwd containment、abort 与错误归一。 | EQ-03 | M | `packages/core/src/tool-system/path-policy-array-arg.test.ts`；`executor-permission-hooks.test.ts`；`builtin/index.ts:172` | 否 |
| EQ-05 | **bridge/长任务集成组**：为 MCP、browser、credentials、background shell、Agent/DriveAgent/GenerateVideo 建 fake bridge/process，覆盖 start→event→cancel/timeout→cleanup。 | EQ-03 | M | `packages/core/src/tool-system/browser-bridge.test.ts`；`mcp-manager.test.ts`；`builtin/background-jobs.test.ts` | 否 |
| EQ-06 | **OpenAI mock provider server**：实现 plain-text/tool-call/usage-with-cache/error-then-ok 四场景的真实 SSE wire；可单独启动，不在 core 加 mock 分支。 | 无 | M | `docs/todo/smoke-automation-mock-provider.md:25`；完整 spec §Mock provider server | **是** |
| EQ-07 | **隔离 smoke orchestrator**：随机端口、临时 `CODE_SHELL_HOME`/catalog、spawn server/app、finally 回收 app/server/temp；严禁读写真用户配置。 | EQ-06 | M | `docs/todo/smoke-automation-mock-provider.md:33`；`packages/core/src/services/homedir-isolation.test.ts` | 否 |
| EQ-08 | **可复用 Playwright Electron fixture**：从 one-off 脚本抽 launch/window selection/pageerror/console/timeout/teardown；提供稳定 test API，而非固定 sleep。 | 无 | M | `packages/desktop/scripts/smoke-panels.mjs:1`；`packages/desktop/package.json:144` | **是** |
| EQ-09 | **L1 启动/UI 接线 suite**：覆盖 session、7 个 panel、Settings/Connections、Extension 页面和关键按钮；使用 role/test-id/存在性断言，不绑易变文案。 | EQ-08 | M | `packages/desktop/scripts/smoke-panels.mjs:33`；`renderer/panels/PanelArea.tsx:108` | 否 |
| EQ-10 | **L2 LLM 全链路 suite**：真实发消息，断言流式 assistant、工具卡、usage/cache 区和 error retry；不精确匹配生成文本。 | EQ-06、EQ-07、EQ-08 | M | `docs/todo/smoke-automation-mock-provider.md:19`、`:33` | 否 |
| EQ-11 | **Anthropic 原始 SSE fast-follow**：实现 SDK 所需完整事件序列并复用 L2 断言，防只测 OpenAI 路径。 | EQ-06、EQ-10 | M | `docs/todo/smoke-automation-mock-provider.md:25`；`packages/core/src/llm/providers/anthropic.ts` | 否 |
| EQ-12 | **统一本地脚本入口**：根/desktop 提供 `smoke`、`smoke:l1`、`smoke:l2`、`test:full`，退出码可靠，文档写明 build 前置。 | EQ-01、EQ-09、EQ-10 | S | `package.json:17`；`packages/desktop/package.json:13` | 否 |
| EQ-13 | **CI xvfb e2e job + 失败 artifacts**：Linux 固定 Electron/Playwright，上传 screenshot/trace/renderer log；先 non-blocking nightly，连续稳定后变 required。 | EQ-12 | M | `.github/workflows/ci.yml`；`packages/desktop/package.json:144` | 否 |
| EQ-14 | **coverage 采集与过滤**：统一 Bun coverage 命令，排除 dist/out/生成数据/fixtures，产 text+lcov；先只报告不 gate。 | EQ-01 | S | `package.json:17`；`packages/core/package.json`；`.github/workflows/ci.yml:45` | 否 |
| EQ-15 | **coverage baseline/no-regression gate**：提交可审计 baseline，PR 只阻止总量下降；新增文件/高风险目录可有更高局部要求。 | EQ-14 | S | `.github/workflows/ci.yml:45`；`packages/core/src/tool-system/` | 否 |
| EQ-16 | **阈值 ratchet + PR/nightly 分层**：按 core/desktop-main/renderer 分桶渐进提高；PR 跑快速 unit+L1，nightly 跑 full/L2/平台矩阵，禁止用跳测刷百分比。 | EQ-13、EQ-15 | M | `.github/workflows/ci.yml`；`.github/workflows/release.yml` | 否 |
| EQ-17 | **L3 打包产物 smoke**：对 `electron-builder --dir` 产物验证启动、native module、版本与基础对话；与源码 e2e 分 job。 | EQ-13 | M | `packages/desktop/package.json:21`、`:26`；`docs/todo/smoke-automation-mock-provider.md:47` | 否（后置） |

推荐顺序：`EQ-01/02/06/08` 可并列起步；`EQ-03→05` 建 builtin 集成底座，`EQ-07→10→12→13` 建 Electron e2e；最后 `EQ-14→16` 加 coverage gate。

---

## 7. 架构债 P1/P2（不含拆 engine）

### 当前基线与结束条件

设计源：`docs/todo/architecture-debt.md`，并与 core 通用化路线去重。以下明确排除已在 TODO 小 feature 单列的 `engine.ts` 拆分，也排除已经落地的 SafeStorage/main-mediated credential access。

剩余债务是：SDK/internal 边界、Arena 可选与移包、两个巨型 App、`state.ts` 进程单例和 cron 边界测试。

| ID | 有序子任务（交付/验收） | 依赖 | 体量 | 锚点 | 可独立先做 |
|---|---|---|---|---|---|
| AD-01 | **public API inventory/兼容清单**：导出当前 `index.ts` symbol、仓内消费者、是否 `@internal`、外部稳定性和目标 subpath；生成 reviewable before/after 表。 | 无 | S | `packages/core/src/index.ts:1`、`:281`、`:459`；`packages/core/package.json:8` | **是** |
| AD-02 | **执行 public/internal entry 分层**：直接复用 `CF-12`，不另做第二个 PR/任务；Arena 先 internal/experimental，不在此删除语义。 | AD-01；实际执行为 CF-12 | M | `docs/todo/architecture-debt.md:26`；`packages/core/src/index.ts:281` | **是（按 CF-12 执行）** |
| AD-03 | **Arena 产品语义 ADR**：决定 `arena_status`、settings、onboarding、public API、TUI `/arena` 的最终归属和兼容窗口，为 optional 与移包提供单一答案。 | 无 | S | `docs/todo/architecture-debt.md:55`；`packages/core/src/protocol/server.ts:1588`；`settings/schema.ts:404` | **是** |
| AD-04 | **Arena builtin 可选注册**：直接复用 `CF-06`；此阶段只把默认装配变显式，协议/settings 暂兼容。 | AD-03、CF-05；实际执行为 CF-06 | M | `packages/core/src/tool-system/builtin/index.ts:667`；`docs/todo/architecture-debt.md:32` | 否 |
| AD-05 | **Desktop `useStreamRouter`**：从 4257 行 App 抽 stream event routing、late completion/changedFiles 归属和订阅生命周期；先保持 state shape 不变。 | 无 | M | `packages/desktop/src/renderer/App.tsx`；`renderer/streamRouting.ts:1`；`renderer/types.test.ts:972` | **是** |
| AD-06 | **Desktop conversation bucket reducer/hooks**：抽 session/bucket/panel/override 的 reducer 与持久化 adapter，兼容既有 localStorage key；App 留装配与页面布局。 | AD-05 | M | `packages/desktop/src/renderer/App.tsx`；`renderer/transcripts.ts`；`docs/nightly-2026-07-10/naming-consolidation-plan.md` | 否 |
| AD-07 | **Desktop feature hooks 分批下沉**：按 workspace、attachments、automation、quick-chat 各选择一组抽 hook；每批单独 M，本文这一项以“先抽一组并立模板”为验收。 | AD-06 | M | `packages/desktop/src/renderer/App.tsx:915`、`:3419`；`renderer/topbar/WorkspaceIndicator.tsx` | 否 |
| AD-08 | **TUI stream router/reducer**：把 Ink App 的 stream 事件、session/bucket 状态抽成纯 reducer/hook，复用已有 stream event 类型；不引入 DOM 假设。 | 无；可参考 AD-05 | M | `packages/tui/src/ui/App.tsx`；`packages/core/src/types.ts` 的 `StreamEvent` | **是** |
| AD-09 | **`packages/arena` 核心移包**：AD-03/04 后迁移 arena 纯逻辑、类型、strategies/providers；core 只留 capability contract/compat re-export。 | AD-02、AD-03、AD-04 | M | `packages/core/src/arena/`；`packages/core/src/index.ts:281` | 否 |
| AD-10 | **Arena 宿主适配搬迁**：把 protocol RPC、settings fragment、onboarding、TUI command 接到 arena 包/capability；按 ADR 保留兼容层与 deprecation test。 | AD-09 | M | `packages/core/src/protocol/server.ts:1588`；`settings/schema.ts:404`；`onboarding.ts:404`；`packages/tui/src/cli/commands/arena.ts:242` | 否 |
| AD-11 | **`state.ts` 所有权/消费者盘点**：按 session/cwd/model/cost/timing/feature/cache/telemetry 分类，标记真正消费者、并发风险和目标 owner；先文档+测试清单。 | 无 | S | `packages/core/src/state.ts:1`；`packages/core/src/engine/model-facade.ts:15`；`packages/core/src/index.ts:526` | **是** |
| AD-12 | **先迁移模型 usage/API timing 到 per-runtime store**：给 ModelFacade 注入窄接口，EngineRuntime 持有；保留 legacy adapter，覆盖两个并发 session 不串计数。 | AD-11 | M | `packages/core/src/engine/model-facade.ts:15`；`packages/core/src/engine/runtime.ts:21`；`packages/core/src/engine/cost-store.ts` | 否 |
| AD-13 | **迁移 session/cwd/model override 状态**：把 session id、main/workspace roots、model override 放到 Session/Engine/host config，保留短期 compat facade；并发 session 不互改。 | AD-11 | M | `packages/core/src/state.ts:20`、`:70`；`packages/core/src/session/session-manager.ts`；`packages/core/src/engine/runtime.ts` | 否 |
| AD-14 | **迁移 token/turn/timing counters**：把 budget continuation、tool/hook/classifier timing 等放进 per-run metrics store；reset 只影响当前 run/session。 | AD-12 | M | `packages/core/src/state.ts:83`、`:162`；`packages/core/src/engine/runtime.ts:21` | 否 |
| AD-15 | **收口剩余 cache/interaction/feature/skill 状态**：section cache 归 Composer、invoked skills 归 agent/session、feature flags 归 host config；删无消费者 stub 或留显式 no-op adapter。 | AD-11、AD-13、AD-14 | M | `packages/core/src/state.ts:55`、`:200`、`:253`、`:261`；`packages/core/src/prompt/composer.ts:60` | 否 |
| AD-16 | **cron parser DST/闰日/不可能日期表测**：覆盖春季跳时、秋季重复时、Feb 29、Feb 30、DOM/DOW OR 和无效 timezone；固定时区和 timestamp。 | 无 | S | `packages/core/src/automation/cron-expr.ts:120`；`cron-expr.test.ts:1`；`docs/todo/architecture-debt.md:66` | **是** |
| AD-17 | **sleep/wake/misfire 集成测试**：以 fake clock 验证休眠跨多个触发点、恢复只补应补任务、不双跑，与 DST 边界联动。 | AD-16 | S | `packages/core/src/automation/scheduler-resume.test.ts`；`scheduler-cron-expr.test.ts` | 否 |

推荐顺序：文档/清单 `AD-01/03/11` 和纯测试 `AD-16` 可先做；随后共享交付 `AD-02/04`，再分别推进 App、Arena、state 三条链。`AD-05` 和 `AD-08` 可独立，不必等待 Arena。

---

## 子任务统计

| 大 feature | 表中子任务 | 共享/重复执行 | 唯一执行单元 |
|---|---:|---:|---:|
| core 通用化 + 插件面板 | 19 | 0 | 19 |
| IM gateway | 12 | 0 | 12 |
| Workspace/Profile/数字人 | 18 | 0 | 18 |
| Workspace 数据源绑定 | 14 | 0 | 14 |
| worktree session 隔离深化 | 13 | 0 | 13 |
| 工程质量 P7 | 17 | 0 | 17 |
| 架构债 P1/P2 | 17 | 2（AD-02/04） | 15 |
| **合计** | **110** | **2** | **108** |

说明：这里统计的是可独立排入“做→审→合→清”流水线的执行单元，不把“跑测试”“写迁移说明”等每个验收动作再拆成单独任务。

---

## 「可先做的子项」TOP 15

排序权重依次为：无前置依赖、能降低后续返工/事故、验收清楚、改动半径可控、对多个 feature 有复用价值。设计 ADR 的产出不是空泛讨论，必须包含已决策项、未决项、schema/状态图和 acceptance matrix。

| 排名 | 候选 | 体量 | 为什么现在做 | 直接解锁 |
|---:|---|---|---|---|
| 1 | **CF-01 工具元数据单一来源** | S | 已有多次“注册了但 preset 看不见”的事故；行为保持、测试明确、收益立即 | harness-min、CapabilityModule、后续新工具安全注册 |
| 2 | **EQ-06 OpenAI mock provider server** | M | 完整设计已批准，零 core mock 分支，可同时服务本地调试和 e2e | EQ-07/10/11，所有 Desktop 纵切验收 |
| 3 | **CF-02 PanelRegistry 收敛** | M | quick-chat 加入后手工维护点继续增长；是插件面板唯一硬前置 | CF-15–19、Team Board/未来 panel 扩展 |
| 4 | **EQ-01 full-suite 事实基线** | S | CI targeted 与全量测试之间没有可信关系；先把“红在哪里”变成事实 | full-suite gate、coverage baseline |
| 5 | **EQ-02 builtin 风险/覆盖矩阵** | S | 57+ 工具无法靠零散测试名判断真实覆盖；清单可机器检查 | EQ-03–05、coverage 分桶 |
| 6 | **AD-01 public API inventory** | S | 在拆 entry 前先锁消费者和兼容面，能避免误把 Arena 裸公开导出当 internal 直接删 | CF-12/AD-02 |
| 7 | **CF-12 / AD-02 public/internal entry 分层** | M | 清单完成后做机械分层，可显著降低后续搬包 breaking 半径 | coding pack 外移、Arena 移包、稳定 SDK |
| 8 | **CF-14 插件 panels manifest/schema** | S | 不依赖 PanelHost，可先冻结贡献点和安全校验，减少 Desktop/core 并行返工 | CF-15/16、第三方示例插件 |
| 9 | **AD-16 cron DST/闰日边界表测** | S | 纯测试、风险低；定时器是长时运行安全面，已有睡眠唤醒历史问题 | AD-17、cron 可靠性 gate |
| 10 | **EQ-08 可复用 Playwright Electron fixture** | M | 现有 one-off 脚本已有可用骨架，先抽 fixture 能让所有 Desktop feature 共用稳定启动/回收/错误采集 | EQ-09/10/13、插件/Profile/数据源 e2e |
| 11 | **AD-03 Arena 产品语义 ADR** | S | optional/move-package 都被同一组未决问题阻塞；越晚决定重复迁移越多 | CF-06/AD-04、AD-09/10 |
| 12 | **WT-01 DriveAgent isolation ADR** | S | 当前底座已足够，真正阻塞自动 worktree 的是默认/cleanup/resume 语义 | WT-02–13 |
| 13 | **DS-01 数据源 ADR + 威胁模型** | S | 此 L 项没有独立设计稿；先把 connection/binding/access 分层，避免复制 MCP/credential source of truth | DS-02–14、E1 connector 调研落点 |
| 14 | **IG-01 gateway 本地控制/安全 ADR** | S | 方案 A 已倾向但本地 RPC、app 唤起、pairing URL secret 处理未定；先定可防 MVP 返工 | IG-02–09 |
| 15 | **WP-01 Profile MVP ADR 收口** | S | override ownership 与 project-memory 语义若不先定，会让 switch/close 不可逆或记忆串 Profile | WP-03–18 |

### 选择建议

- 若今晚还要继续做**低风险实现**：优先圈 `CF-01`、`CF-02`、`CF-14`、`AD-16`。
- 若优先铺**测试基础设施**：圈 `EQ-01`、`EQ-02`、`EQ-06`、`EQ-08`；先不要上 coverage 百分比门禁。
- 若下一轮目标是**确定产品方向**：圈 `AD-03`、`WT-01`、`DS-01`、`IG-01`、`WP-01`，每项独立产 ADR，不把五项揉成一份总设计。
- `WP-02`（Seedance 手工 spike）产品学习价值很高，但依赖外部包/素材，故未进无条件 TOP 15；素材就绪时可与 `WP-01` 并行。

## 明确不建议先做

- 不先做 `packages/arena` 物理搬家：产品/API/settings/protocol 语义尚未定。
- 不先做 worktree 自动清理：ownership、binding、lock 和 dirty classification 必须先成立。
- 不先给 coverage 设硬百分比：先让 full suite、过滤口径和 e2e 稳定。
- 不先接真实 Figma/云盘 provider：先用 mock/MCP resource 证明 schema、binding、审批与撤销链。
- 不先做 Profile marketplace 或 Team v2：都不在已决 MVP 边界内。
- 不在 IM gateway 内实现“大脑”、富审批或多租户：保持通道职责。
