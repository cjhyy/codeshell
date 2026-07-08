# TODO

> 已完成项一律删除（记录在 git 历史与记忆里）。本文件只保留**未完成**的待办。
> 最近一次核对：2026-07-08（codex 核对，按当前 git HEAD 逐条对照代码与候选清单，重分两类）。

---

## 小 feature / 主分支迭代

- **`/compact` 进行中缺 UI 反馈和输入禁用**（体量 S-M）｜锚点：`packages/desktop/src/renderer/App.tsx:2443`、`packages/desktop/src/renderer/App.tsx:2454`｜现状：`compactActiveSession` 只在触发前挡 busy，Promise 飞行期间没有 per-bucket compacting 状态，输入仍可继续发送且可重复触发。修法：加 `compactingBuckets`，composer 禁用/展示「正在压缩」，重复 `/compact` 忽略或合并。
- **CC/Codex/外部 agent 面板补「来源 session」徽标**（体量 S）｜锚点：`packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:24`、`packages/core/src/tool-system/builtin/background-work.ts:71`｜现状：面板只按当前 `sessionId` 拉列表，条目模型和 row UI 没有来源 session 短 id/标题。修法：background work entry 带 source session 元数据，面板对「本会话」高亮并显示来源徽标。
- **automation/mobile announce 乐观气泡补稳定 `clientMessageId`**（体量 S）｜锚点：`packages/desktop/src/renderer/App.tsx:1682`、`packages/desktop/src/renderer/App.tsx:1751`、`packages/desktop/src/renderer/transcriptsReducer.ts:56`｜现状：普通 send/steer 已有 `clientMessageId`，但 automation/mobile announce 派发 `user_message` 时无 key，hydrate 仍可能覆盖本地 intent。修法：生成稳定 id（如 `automation:${sessionId}:${hash(prompt)}` / `mobile:${sessionId}:...`）并随 dispatch 传入。
- **TodoWrite resume 恢复补 core 测试**（体量 S）｜锚点：`packages/core/src/tool-system/builtin/task.ts:154`、`packages/core/src/engine/engine.ts:1623`｜现状：`readLastTodoSnapshot` 和 resume 重发 `task_update` 已实现，但缺直接覆盖 pending 恢复、末次全 completed 清空/不 emit 的 engine/task 测试。修法：补 `task`/`engine.todo-resume` 用例。
- **压缩 token 初始估算无真实 anchor 时仍偏启发式**（体量 S-M）｜锚点：`packages/core/src/context/compaction.ts:21`、`packages/core/src/context/manager.ts:210`、`packages/core/src/engine/engine.ts:1604`｜现状：真实 usage anchor 的主 blocker 已修，剩余是首轮/无 anchor 时仍用 `estimateMessagesTokens()*4/3` 或 char/4 近似。修法：引入 provider/model-aware tokenizer 或在首个真实 usage 回来前标注估算置信度并校准显示。
- 🔴 **[worktree/数据安全] 自动清理会静默 `--force -D` 删掉未合并/未提交的 worktree**（体量 S-M）｜锚点：`packages/desktop/src/main/desktop-services.ts:357`、`packages/desktop/src/main/desktop-services.ts:373`、`packages/desktop/src/main/desktop-services.ts:388`｜现状：`cleanupStaleWorktrees` 只按「目录 mtime 早于阈值 + 分支是托管前缀且非当前 root 分支」判定就删，**完全不检查未提交改动、也不检查是否已合并到 main**；删除用 `git worktree remove --force`（丢未提交）+ `git branch -D`（强删未合并分支）。默认关闭 + 默认 7 天阈值窗口不大，但一旦命中（开了开关 + worktree 里有没提交/没合并的活 + 晾超阈值）就是**静默、不可逆**的数据丢失（未提交改动 reflog 也救不回）。修法：删除前对每个候选 worktree 做护栏——`git status --porcelain` 非空则跳过并记日志；分支相对 main 有未合并 commit（`git cherry`/`rev-list main..branch`）则跳过；仅对「干净且已合并」的才 `--force -D`，其余保留并在 UI 提示手动处理。

---

## 大功能升级

- **core 通用化 + 插件面板**（体量 L）｜锚点：`packages/core/src/preset/index.ts:34`、`packages/desktop/src/renderer/panels/PanelArea.tsx:90`、`packages/core/src/plugins/installer/types.ts:4`｜现状：preset/builtin 仍硬编码 coding/git/browser/tool 包，PanelArea 固定内置 panel kind，plugin manifest schema 无 `panels`。修法：工具元数据派生 preset、PanelRegistry 收敛内置面板、manifest `panels` + `csplugin://` 沙箱 host + scoped bridge。
- **拆 `engine.ts` 本体**（体量 M）｜锚点：`packages/core/src/engine/engine.ts:768`、`packages/core/src/engine/engine.ts:2068`｜现状：`engine.ts` 仍 3626 行；`extractJSON` 与 `EngineConfig` 前置已提取，但门面仍混合图片策略、sandbox、subagent、runtime config、run 装配。修法：一次抽一块到独立模块，每块配 core 测试，保留 Engine 只做生命周期和装配。
- **侧边栏快速聊天（btw / quick-chat）**（体量 M）｜锚点：`packages/desktop/src/renderer/view.ts:18`、`packages/desktop/src/renderer/panels/PanelArea.tsx:90`｜现状：侧边 dock 只有 files/browser/review/terminal/shells/ccRoom，无 quick-chat panel 或独立临时 session 流。修法：独立 sessionId、严格 bucket/session 隔离、可选只读主线程快照，面板生命周期复用现有 PanelArea 持久化规则。
- **聊天软件 channel / IM gateway（含隧道地址回推微信）**（体量 L）｜锚点：`docs/todo/im-gateway-remote-orchestration.md:36`、`packages/desktop/src/main/mobile-remote/tunnel-manager.ts:101`、`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:257`｜现状：mobile tunnel 与 pairing URL 已在 Electron main 内部可生成，但无 IM/webhook/bot adapter、无 gateway 进程、无微信/Telegram 回推。修法：先做 `/open /close /status` gateway MVP，复用 tunnel/pairing/passcode，再接可插拔 channel。
- **Workspace / Profile / 数字人**（体量 L）｜锚点：`docs/todo/workspace-profile-讨论稿.md:86`、`packages/core/src/settings/schema.ts:25`、`packages/core/src/prompt/composer.ts:270`｜现状：已有 capability overlay、preset、plugin、普通 `userProfile`，但没有 `WorkspaceProfile` schema、激活/切换事务、主指令注入和数字人记忆层。修法：先落全局 profile 库 + activeProfile 记录 + capability 批量写入，再接 mainInstruction、portable memory、Team Board。
- **Workspace 数据源绑定**（体量 L）｜锚点：`packages/core/src/settings/schema.ts:25`、`packages/desktop/src/renderer/credentials/LinkTab.tsx:11`｜现状：settings 只有能力开关，Links 仍是静态壳；没有 workspace-scoped resource model、外部源 link、Figma/issue/云盘 scope 分配。修法：设计数据源 schema、权限/凭证绑定和按 workspace/profile 注入的读取面。
- **worktree session 隔离深化（外部 agent 自动隔离）**（体量 L）｜锚点：`docs/todo/worktree-session-isolation-research.md:331`、`packages/core/src/tool-system/builtin/drive-claude-code.ts:225`、`packages/core/src/tool-system/builtin/worktree.ts:179`｜现状：主 session workspace pointer、下一轮 cwd、DriveAgent resume cwd 绑定已落地；剩余是 DriveAgent/subagent 并行时自动 per-run worktree、完成后保留/清理提示、`.worktreeinclude`/baseRef/cleanup。修法：给 DriveAgent 增 isolation 策略和生命周期 UI，再扩展 include/baseRef/lock。
- **MCP HTTP Auth / OAuth / Link 认证体验**（体量 M）｜锚点：`packages/core/src/credentials/types.ts:6`、`packages/core/src/types.ts:718`、`packages/core/src/tool-system/mcp-manager.ts:99`、`packages/desktop/src/renderer/settings/McpSection.tsx:960`｜现状：HTTP MCP 有 headers / env Bearer / envHeaders / credentialRef，但 `CredentialType` 无 `oauth`，设置 UI 仍是字段编辑，LinkTab 只是静态壳。修法：加 OAuth credential 类型、登录状态/刷新/退出、认证方式选择 UI，并保持 Codex 风格字段兼容。
- **命名收口 repo / workspace / project / cwd**（体量 M）｜锚点：`packages/desktop/src/renderer/repos.ts:14`、`packages/core/src/types.ts:248`、`packages/core/src/settings/schema.ts:361`｜现状：renderer 用 Repo/Project 文案，core session 用 cwd/workspace，settings 又称 Project-scoped，跨边界同义词混用。修法：先定概念表和迁移边界，再机械改名/适配旧 localStorage 与 state.json。
- **工程质量 P7：builtin tools 集成测试 / Electron e2e / CI 覆盖率**（体量 L）｜锚点：`package.json:17`、`.github/workflows/ci.yml:45`、`packages/desktop/package.json:144`、`packages/desktop/scripts/smoke-panels.mjs:1`｜现状：根脚本无 coverage/e2e/smoke；CI 仍跑 targeted tests；desktop 有 Playwright 依赖和一次性 smoke script，但未成稳定 e2e 基座。修法：mock provider smoke、Electron `_electron` harness、CI xvfb/e2e 分层，最后加覆盖率目标。
- **架构债 P1/P2（不含上方拆 engine）**（体量 L）｜锚点：`docs/todo/architecture-debt.md:24`、`packages/core/src/index.ts:281`、`packages/core/src/tool-system/builtin/index.ts:667`、`packages/desktop/src/main/index.ts:1540`｜现状：index.ts 仍暴露大量 Arena 面，arena 仍默认 builtin，SafeStorageCipher 已实现但故意未启用，App.tsx 仍巨型；cron sleep/wake guard 已补，DST/闰等边界仍可加强。修法：拆 public/internal export、arena 可选注册/移包、main-mediated credential decrypt service、拆 renderer App、收敛 state 单例和文档措辞。
- **Prompt cache 深化：静态/动态分离、粘性锁定、破坏检测**（体量 M）｜锚点：`docs/todo/prompt-cache-optimization.md:91`、`packages/core/src/prompt/composer.ts:242`、`packages/core/src/llm/providers/anthropic.ts:484`、`packages/core/src/engine/engine.ts:2264`｜现状：OpenAI cached_tokens、Anthropic tools/history 断点、session cumulative cache usage 已落地；剩余是更系统地分离 cacheable prefix、审计动态开关是否锁定、检测 cache_read 暴跌。**codex 2026-07-08 复核新增发现**：`compactedMessagesBySession` 落进程内缓存时只用 `stripUserContextMessage` 剥掉 userContext，**没剥旧的 dynamicContext**（engine.ts:2264）→ 陈旧的 skills/gitStatus/memory/goal 副本可能残留进历史，既污染上下文又膨胀 prompt；另 OpenRouter-Anthropic 路径只打 system+last message 两个 marker、靠 system marker 覆盖 tools，与直连不完全一致，建议加 cache_read 暴跌诊断。修法：作为性能专项做 prefix hash/diagnostic，压缩后一并剥离旧 dynamicContext，不零敲碎打。

---

## 明确不做

- **quick-chat 不做 Pi 式 parent 指针树状 session**：快聊是用完即走短对话；需要合并时用 fork/复制派生，不引入树状会话模型。
- **IM gateway MVP 不做编排大脑 / IM 内富交互审批 / 多租户**：gateway 只做通道、隧道生命周期和入口回推；高阶跨 session 指挥留给未来 assistant 主体。
- **WorkspaceProfile MVP 不做同一 workspace 同时激活多个 Profile**：当前决策是同一 workspace 一个 active Profile，可切换但不并存；项目专属定制仍放 `CLAUDE.md`/项目指令。
