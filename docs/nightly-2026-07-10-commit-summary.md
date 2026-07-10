# Nightly 2026-07-10：`main` 领先提交汇总

## 范围与统计口径

- 本地远端跟踪引用 `origin/main` 经 `git rev-parse --verify origin/main` 确认为
  `80eef6e6a3e55bccefd3d9a46e8084e8726b1c4d`，对应
  `chore: release 0.7.0-beta.1`。
- 执行 `git log --oneline origin/main..HEAD` 时，当前 `HEAD` 已在 2026-07-10 13:52
  新增 `c3e9020b`，所以实时结果是 85 条。任务所指的 84 条对应 13:24 的快照终点
  `2082ebcd`；本文固定分析区间为 `origin/main..2082ebcd`，并排除后加的
  `c3e9020b`。
- `git rev-list --count origin/main..2082ebcd` 的结果为 **84**。计数以 commit object
  为单位，包含功能分支上的实现提交和随后将其集成回主线的 merge commit；因此同一功能的
  “实现 + 集成”会分别计数。
- 类型按提交的主要目的归类。显式评审轮次中产生的补丁及跨模块评审集成归入
  `review-fix`；CI/结构性维护归入 `refactor`；merge commit 按其所集成功能归类，不另设
  `merge` 类型。

## 功能分组总览

| # | 功能模块 | commit 数 | 类型构成 | 内容概览 |
|---:|---|---:|---|---|
| 1 | Nightly 编排、研究与进度文档 | 19 | docs × 19 | 建立当夜工作流，持续记录 A–E 阶段进度、根因线索、能力清单和后续拆解。 |
| 2 | 命名统一方案 | 2 | docs × 2 | 编写命名收敛计划并集成。 |
| 3 | Beta 发布清单 | 2 | docs × 2 | 修正发布步骤、检查项和文档口径并集成。 |
| 4 | GitHub Actions 与发布流水线 | 4 | refactor × 2；bugfix × 2 | 升级 Node 24 兼容的 Actions，强化版本提取和 macOS 签名失败检查。 |
| 5 | DriveAgent 作业查看与取消 | 3 | feature × 2；review-fix × 1 | 增加 `DriveAgentJobs` 的 list/inspect/cancel、作业元数据和取消竞态修复。 |
| 6 | MCP HTTP OAuth 凭据 | 4 | feature × 2；review-fix × 2 | 增加 OAuth 凭据模型、Bearer 注入和桌面状态 UI，并收紧/修复凭据类型校验。 |
| 7 | Desktop Quick Chat | 5 | feature × 2；review-fix × 3 | 新增 dock 面板，修复迟到事件、跨窗口所有权和关闭后的 transcript 泄漏。 |
| 8 | Prompt cache 动态上下文隔离 | 4 | bugfix × 2；review-fix × 2 | 避免易变上下文污染缓存及 summary compaction，并修正锚点诊断。 |
| 9 | 安全回归测试 | 2 | test × 2 | 覆盖视觉门禁、附件元数据和 recorder 脱敏。 |
| 10 | Engine 图片输入拆分 | 2 | refactor × 2 | 将图片输入流程提取到独立模块，保持行为不变。 |
| 11 | Turn 过程卡片展开状态 | 2 | bugfix × 2 | 避免新一轮唤醒时强制折叠历史卡片。 |
| 12 | Steer、附件与消息归属 | 7 | bugfix × 4；review-fix × 3 | 贯通 steer 附件，修复普通附件卡住、失败重排队、FIFO 和副作用归属。 |
| 13 | 每轮 changed-files 统计 | 2 | bugfix × 2 | 将 DriveAgent 文件变化带入 stream/transcript，并按 turn 正确聚合。 |
| 14 | DriveAgent 模型覆盖 | 2 | feature × 1；review-fix × 1 | 支持显式选择 Claude/Codex 模型，并在评审集成后恢复参数透传。 |
| 15 | CC/Codex 房间实时 transcript | 6 | feature × 2；review-fix × 4 | 增加桌面/移动端实时订阅，并修复重连、隐藏面板、cwd 和 viewer 隔离。 |
| 16 | Builtin 元数据与面板注册表 | 4 | refactor × 4 | 集中 Sleep/CronList 元数据和 Desktop builtin panel registry。 |
| 17 | Builtin 工具覆盖矩阵 | 2 | test × 2 | 建立 59 个 builtin 的覆盖/跳过矩阵。 |
| 18 | Goal 强制终止生命周期 | 2 | bugfix × 1；review-fix × 1 | 清理已终止 active goal，并用 tombstone 防止陈旧状态复活。 |
| 19 | DriveAgent 进程树与取消收尾 | 4 | review-fix × 4 | 绑定 owner 生命周期，跨平台等待进程树退出并保留取消产物。 |
| 20 | 多轮评审与最终冲突集成 | 6 | review-fix × 6 | 汇总 renderer/core R2、R3 修复，并完成两条长期分支的最终合并。 |
| **合计** |  | **84** |  |  |

## 各组提交明细

### 1. Nightly 编排、研究与进度文档（19 commits）

归属模块：`docs/nightly-2026-07-10/`。这组提交既建立执行框架，也在功能、修复和评审推进时同步维护可追踪状态。

- `9e38be9b` — `docs`：新增当夜 `WORKFLOW.md`、目标清单和 Codex session 通信研究，定义优化任务的编排方式、验收口径与研究背景。
- `8a395254` — `docs`：在目标进度中将 A5 命名统一方案标为完成。
- `9a6dd54e` — `docs`：更新 A7 GitHub Actions 升级进度和状态。
- `3ba1b7ac` — `docs`：记录 A3 Quick Chat dock 已完成。
- `e759ce09` — `docs`：记录 A4 OAuth 凭据完成，同时登记卡片折叠、附件发送和文件计数三个 UI bug 候选。
- `0ed63ed8` — `docs`：记录 A1 DriveAgent 作业管理完成，并进一步描述 steer 携带附件时无 LLM 响应的问题。
- `42b39416` — `docs`：将 B3 发布清单修订标为完成。
- `aa4d396a` — `docs`：将 B1 发布流水线加固和 B2 安全回归测试标为完成。
- `a11463be` — `docs`：记录 A2 图片输入提取完成，宣告 A、B 两阶段任务全部收口。
- `6f4f751b` — `docs`：记录 Codex logout 阻塞项，并说明 C 阶段因此暂停。
- `ffe87a5c` — `docs`：为 steer + attachment 无响应问题留下静态根因线索，指向 steer 队列缺失附件信息。
- `f002d6d3` — `docs`：记录过程卡片折叠和每轮文件计数错误的静态根因线索。
- `670800b6` — `docs`：标记过程卡片折叠问题已修复。
- `a02bad66` — `docs`：新增 C1 Codex 能力目录，并同步 steer 附件、卡片折叠两项修复状态。
- `0e323aa7` — `docs`：新增 C2 CodeShell 能力差距分析，并整理后续清理项。
- `a4631613` — `docs`：标记普通附件发送卡住已修复，并细化 CC room 实时更新要求。
- `430f1e7c` — `docs`：标记 changed-files 计数修复完成。
- `d00108b9` — `docs`：新增 D1 大功能拆解，将方向拆成 108 个子任务，并列出优先可做的 TOP 15。
- `f501a371` — `docs`：新增 E1 open connector 能力计划，按六阶段展开并明确首批 TOP 5。

### 2. 命名统一方案（2 commits）

归属模块：架构治理文档。

- `bcb8b861` — `docs`：新增 95 行命名统一计划，梳理待收敛概念、目标命名和迁移步骤。
- `25970519` — `docs`：将 A5 文档分支合入 nightly 主线；自身是集成提交，不引入文档之外的运行时变化。

### 3. Beta 发布清单（2 commits）

归属模块：发布文档。

- `adc01e74` — `docs`：修订 Beta 发布清单，校正发布顺序、验证步骤和检查口径。
- `c1b67b0a` — `docs`：将 B3 发布清单修订分支集成到 nightly 主线。

### 4. GitHub Actions 与发布流水线（4 commits）

归属模块：`.github/workflows/` 与 Desktop 打包脚本。

- `ff809c46` — `refactor`：将 CI/Release 中的 checkout、setup-python、upload/download-artifact 升到 Node 24 兼容版本。
- `0c3d2f6d` — `refactor`：合入 A7 Actions 升级分支，统一 CI 和发布工作流版本。
- `5ba15a46` — `bugfix`：让 release 版本正则兼容类型注解与 `as const`，并让 macOS ad-hoc codesign 在 CI 中验证失败即失败、在本地仍保持容错。
- `052c4970` — `bugfix`：合入 B1 发布流水线加固，保留经评审后的版本检查和签名失败语义。

### 5. DriveAgent 作业查看与取消（3 commits）

归属模块：Core background jobs、DriveAgent builtin 与 Desktop 后台任务展示。

- `fb839656` — `feature`：新增白名单工具 `DriveAgentJobs`，支持按 cwd/session 列出、查看和取消 DriveAgent 作业；注册表增加 `cancelled` 状态、CLI/cwd/prompt/changed-files 元数据和 abort hook，并补齐通知与测试。
- `eb439725` — `review-fix`：修复取消过程中的竞态，避免取消与正常完成相互覆盖，同时把取消状态和相关字段贯通到 Desktop IPC、类型及后台面板。
- `9624dc1b` — `feature`：在 refix 后合入 A1，实现作业 inspect/cancel 的完整 Core + Desktop 能力。

### 6. MCP HTTP OAuth 凭据（4 commits）

归属模块：Core credentials/MCP manager 与 Desktop credentials UI。

- `660f320d` — `feature`：增加 `oauth` 凭据类型、access/refresh token 与过期元数据解析、公开状态摘要和 MCP HTTP Bearer 注入；Desktop Link/MCP 设置页展示有效/过期/无效状态并支持退出，登录与刷新入口预留。
- `5ef8c819` — `feature`：合入 A4 OAuth 凭据能力及其 Core、main/preload、renderer 测试。
- `38e71302` — `review-fix`：当凭据元数据缺失时 fail closed，只允许合适的 token/OAuth 类型注入 Bearer，并拒绝“结构化 secret 与 token 元数据不匹配”的可疑情况。
- `4caa8ded` — `review-fix`：修正上一轮收紧过度的问题，恢复历史 `link` 类型作为 MCP Bearer 凭据的兼容路径，并补回 Core 与 probe 测试。

### 7. Desktop Quick Chat（5 commits）

归属模块：Desktop dock panel、临时 session、跨窗口 ownership 与 transcript reducer。

- `2e700c01` — `feature`：新增 Quick Chat dock 面板、独立临时会话状态、面板入口和命令面板入口，并补充会话与视图测试、i18n 文案。
- `4569a016` — `feature`：合入 A3 Quick Chat dock 功能分支。
- `713757e1` — `review-fix`：保留任务结束后迟到的文件事件和 Quick Chat 会话，避免完成/面板变更时过早清理；新增大批隔离、清理和迟到事件回归测试。
- `ada4ec5c` — `review-fix`：在 main 进程引入 Quick Chat ownership，保护其他窗口仍在使用的 live session，避免任一窗口关闭或清理时误杀共享会话。
- `6c6016b2` — `review-fix`：关闭 Quick Chat 时同步清除 busy/running bucket、coalescer 序列和 transcript reducer bucket，阻止已关闭聊天的内存状态继续累积或被迟到 Promise 写回。

### 8. Prompt cache 动态上下文隔离（4 commits）

归属模块：Core engine prompt cache、turn loop 与 usage/cache 诊断。

- `13e0b826` — `bugfix`：从可缓存 prompt 中剥离易变动态上下文，同时保持当轮模型仍能看到所需上下文，并增加 prompt-cache 回归测试。
- `f2caf918` — `review-fix`：确保 summary compaction 不会把已剥离的动态上下文重新写回缓存边界。
- `b1bd98a3` — `review-fix`：让上下文锚点选择与 volatile stripping 保持一致，并修正 `cache_read`/usage 相关诊断测试。
- `b745b98b` — `bugfix`：在两轮 refix 后集成 A6，形成缓存隔离、compaction 和诊断一致的完整修复。

### 9. 安全回归测试（2 commits）

归属模块：Core engine security tests。

- `703537bd` — `test`：新增 structured-image vision gate、input attachment metadata 和 model-facade recorder redaction 的回归覆盖。
- `9994e409` — `test`：合入 B2 安全测试分支，固定三类安全边界的测试基线。

### 10. Engine 图片输入拆分（2 commits）

归属模块：Core engine。

- `39d7f218` — `refactor`：把约 200 行图片输入准备/执行逻辑从 `engine.ts` 提取到 `run-image-input.ts`，减少 Engine 体积并保持行为不变。
- `0315026e` — `refactor`：合入 A2 图片输入提取，评审结论为 zero behavior change。

### 11. Turn 过程卡片展开状态（2 commits）

归属模块：Desktop `TurnProcessGroupCard`。

- `d81e7d4b` — `bugfix`：调整唤醒时的折叠同步逻辑，不再强制折叠所有历史 process group，保留用户手动展开的卡片。
- `b8510c4e` — `bugfix`：合入该修复，并以“turn wakeup 触发全历史组 force-collapse”为已确认根因。

### 12. Steer、附件与消息归属（7 commits）

归属模块：Core steer queue/turn loop/protocol 与 Desktop queued input/attachment session。

- `b0cb9782` — `bugfix`：让 steer queue 项携带 attachments，并贯通 protocol、preload、renderer queued input 和 engine preparation；补充队列、server 与 backfill 测试。
- `16bc4ebe` — `bugfix`：合入 steer + attachment 无 LLM 响应修复，确认根因是 steer 队列此前没有附件字段。
- `922ab8dd` — `bugfix`：修复普通附件发送因 UI/engine sessionId 不一致而卡住的问题，统一附件 session 绑定和输入准备，并补充结构化图片门禁测试。
- `9c69c0ba` — `bugfix`：合入普通附件发送修复，并记录 sessionId mismatch 根因。
- `1a5914b5` — `review-fix`：附件准备失败时把 steer 恢复到队列，避免消息被消费后静默丢失。
- `124ab626` — `review-fix`：注入 steer 后设置 origin client message id，使随后工具副作用和 changed-files 归属到发起该 steer 的消息。
- `9730647b` — `review-fix`：准备失败时释放已 claim 的 message id、恢复当前项及其后缀并停止继续消费，保持严格 FIFO 顺序。

### 13. 每轮 changed-files 统计（2 commits）

归属模块：DriveAgent change detection、stream/transcript 与 Desktop file aggregation。

- `73a818da` — `bugfix`：把外部 agent 的 changed-files 写入通知、`StreamEvent` 和 transcript reader，并按 origin/turn 在 Desktop 聚合，修复每轮文件数失真。
- `9e824a88` — `bugfix`：合入文件计数修复，明确根因是 changed-files 未进入 stream/transcript 数据链。

### 14. DriveAgent 模型覆盖（2 commits）

归属模块：Claude/Codex adapter、external driver 与 DriveAgent tool schema。

- `ba8076aa` — `feature`：给 DriveAgent 增加可选 `model` 参数；仅显式传入时生成 Claude/Codex CLI 的 `--model`，并验证参数顺序、默认省略和别名透传。
- `42e784ed` — `review-fix`：在后续集成分支上恢复被遗漏的 model schema/adapter/runner 透传及对应测试。

### 15. CC/Codex 房间实时 transcript（6 commits）

归属模块：Core session history、Desktop main subscription service、renderer CC room 与 mobile remote。

- `f8ae46ed` — `feature`：新增 CC/Codex session history 增量读取和 transcript subscription manager，通过 main/preload/mobile 通道推送实时更新，并让 Desktop/Mobile 房间消费直播 transcript。
- `89391a6a` — `feature`：合入桌面和移动端 CC/Codex room 实时 transcript 能力。
- `bad7a64e` — `review-fix`：移动端断线重连后重新建立 transcript subscription，避免房间停在旧快照。
- `735ca6b1` — `review-fix`：面板隐藏时释放 CC room subscription，并集中 panel visibility 判断，消除不可见房间的订阅泄漏。
- `95d43a3c` — `review-fix`：移动端 reconnect 时保留 room cwd，避免重连后落回错误工作目录。
- `26845032` — `review-fix`：为 mobile viewer 建立稳定 identity，并按 viewer 隔离 transcript subscription，防止多个观看端互相覆盖/取消订阅。

### 16. Builtin 元数据与面板注册表（4 commits）

归属模块：Core builtin definitions/preset 与 Desktop panel registry。

- `15b2b432` — `refactor`：为 Sleep、CronList 建立集中 definition，让 schema/说明/注册和 preset 白名单复用单一元数据来源，并补充 whitelist 测试。
- `b4391d89` — `refactor`：合入 CF-01，以 Sleep/CronList 作为 builtin 元数据集中化的首批样板。
- `0d16f9f9` — `refactor`：把 Desktop builtin panel 的 id、标题、渲染和可见性配置集中到 `PanelRegistry`，从 `PanelArea` 移除分散分支并补齐 registry 测试。
- `31c09566` — `refactor`：合入 CF-02 Desktop panel registry 重构。

### 17. Builtin 工具覆盖矩阵（2 commits）

归属模块：Core builtin tests。

- `a76d55af` — `test`：新增 builtin tool coverage matrix，逐项声明可执行覆盖或有理由的 skip，当前覆盖 44/59、跳过 15。
- `954d765c` — `test`：合入 EQ-02 覆盖矩阵，使 builtin 新增/遗漏测试能够被集中审计。

### 18. Goal 强制终止生命周期（2 commits）

归属模块：Core goal/turn loop/session persistence。

- `d97f95f4` — `bugfix`：stop-block 上限、token/time budget 或 goal max-turns 强制结束时清除 live session 的 `activeGoal`；按 objective + setAtMs 绑定 terminal tombstone，阻止陈旧全量状态写回后复活，同时保留 waiting goal，并增加 7 类生命周期回归用例。
- `39c2da3c` — `review-fix`：把相同 goal 修复落到 R2 core 评审分支。它与 `d97f95f4` 是不同分支上的独立 commit object，内容基本相同，因此在 84 条提交中分别计数。

### 19. DriveAgent 进程树与取消收尾（4 commits）

归属模块：external-agent driver、background job registry 与取消通知。

- `08d7192d` — `review-fix`：取消 DriveAgent 时回收 CLI 的完整进程树，而非只结束父进程；同时扩充外部 driver 和 background job 的进程测试。
- `5e2fdd97` — `review-fix`：禁止把外部 agent spawn 为 detached process group，使其继续受 owner worker/app 生命周期约束；POSIX 下显式枚举并信号终止后代。
- `cb641591` — `review-fix`：引入 `cancelling` 中间态并等待 abort hook；POSIX 执行 TERM→等待→KILL，Windows 使用跨平台 process-group 终止，避免作业先标 cancelled、进程仍继续写文件。
- `583fcd02` — `review-fix`：取消收尾期间继续记录 CLI session id、changed-files 和 origin message，确保取消通知与 transcript 不丢失已经产生的文件产物。

### 20. 多轮评审与最终冲突集成（6 commits）

归属模块：跨 Core/Desktop/Mobile 的评审集成。这些 merge commit 主要保存评审批次和集成边界，相关实现提交已在前述各功能组展开。

- `d72afb1d` — `review-fix`：合入 renderer P0 修复，覆盖迟到文件去重、Quick Chat 清理和会话隔离测试。
- `a9283acf` — `review-fix`：合入四路 review 的 core P0 修复，包括 model override、steer 失败恢复/归属、mobile reconnect 和取消进程树。
- `fd1996cd` — `review-fix`：合入 R2 Desktop blockers，包括跨窗口 Quick Chat、隐藏 CC subscription、mobile cwd 和 viewer scope。
- `f0d16770` — `review-fix`：合入 R2 Core blockers，包括 goal 终止、steer FIFO、owner-attached agent、跨平台取消、OAuth fail-closed 和取消产物保留。
- `ac4c70c2` — `review-fix`：合入 R3 最终 blockers，清理关闭 Quick Chat 的 transcript bucket，并恢复 MCP `link` Bearer 兼容性。
- `2082ebcd` — `review-fix`：最终合并 goal 长期分支与累计 nightly 修复分支；实际冲突集中在 model override 测试和 goal lifecycle 测试，去除重复/冲突测试写法后同时保留两侧功能。

## 总量统计（按类型）

| 类型 | commit 数 | 占比 |
|---|---:|---:|
| feature | 9 | 10.7% |
| refactor | 8 | 9.5% |
| bugfix | 13 | 15.5% |
| docs | 23 | 27.4% |
| test | 4 | 4.8% |
| review-fix | 27 | 32.1% |
| **合计** | **84** | **100.0%** |
