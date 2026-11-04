# 全仓库问题盘点（2026-11-01）

> 历史状态：2026-11-01 为只读审查，未修复产品代码。2026-11-04 的修复跟进见下节；历史行号与当时验收结论保持原样。
> 基线：`82c6f37ab6ef8dd29ee58aa7ca9a1daa0ea1d7c6`（`origin/main`，PR #266 “mobile panel directory selection” 合并提交，提交日期 2026-10-31）；审查日期 2026-11-01；源码版本 0.9.51。
> 本文所有 `path:line` 都以该基线为准。读取方式是 `git show 82c6f37ab:<path>` 和 `git grep -n … 82c6f37ab -- <path>`，不读任何工作区文件。
> Mimi 专项方案见 [mimi-single-entry-movement-plan.md](mimi-single-entry-movement-plan.md)；根待办见 [TODO.md](../../TODO.md)。

## 2026-11-04 修复跟进

本轮修复位于 [PR #291](https://github.com/cjhyy/codeshell/pull/291)。R01–R04、R09–R28 已进行一轮源码修复或契约更正，并增加定向回归；R05–R08、R29 已在既有主线实现，本轮核对后保留其原生/正式包验收边界。PR 的必需 CI 是最终整合门禁，不能把以下本机验证等同于发布或安装。

- 权限与配置：Bash 识别规范化路径与递归敏感目录；项目设置读保护与 Config 自身审批区分；授权持久化共用 SettingsManager 锁，损坏文件保持原字节，YAML 配置保持生效。
- 生命周期与隔离：模型从会话项目解析，模型恢复失败不发布半注册 Engine；聊天按会话保持路由顺序、就绪以实际连接为准；停止撤销准备中的移动输入；退出仅在保存阶段允许取消，开始清理后重试或完成退出，缓存最后关闭。
- Panel 与平台：瞬时存储错误保留已准备资源；文件读取固定描述符并拒绝 FIFO；进程组清理覆盖自然退出；更新检测采用异步探测并丢弃过期回调；平台密钥不可用时拒绝新的不安全凭据写入。
- 工程契约：保留 CLI 完整管道输出；CDP 等待使用总期限；本地 test/test:watch 使用隔离 HOME 和有界分片；版本标题、最新 CI 结果及 Host lint 范围均加入门禁。

同时处理 11 月 3–4 日继续审查确认的发送后冻结及恢复问题。本机合成负载中，3,000 条 trace 的发送同步清理约 7.95 秒降至 4 毫秒；300 条 CLI delta 的同步落盘约 6.75 秒降至 338 毫秒；62 MiB transcript 追加轮询的最大心跳间隔约 351 毫秒降至 6 毫秒。历史解析和完整缓存合并放入 worker，大文件/Markdown/diff 分页保留全部内容及流式最新页。

这些是可重复的阻塞路径证据，未采集用户当次卡死堆栈，不能断言唯一原因或完全消除所有卡顿。移除未使用预览后，250 会话的 workspace owner 元数据扫描仍约 446 毫秒；CLI 同步耐久提交仍有约 338 毫秒的剩余成本。本轮不发布版本、不替换已安装应用；原生快捷键、正式签名包和真实设备验收仍按原待办跟进。

## 1. 结论摘要

- **本轮新增发现中未发现 P0；原有 P0 验收门禁保持未关闭。**
- **P1 共 5 项。**
  - 2 项 core 权限/设置持久化（确认）；
  - 2 项 Desktop 安全与退出生命周期（静态风险，待真实环境验收）；
  - 1 项 Mimi 双表面可同时出现、无互斥（确认，即用户本次提出的问题）。
- **P2 共记录 24 项（R06–R29，其中 R29 已在本轮文档整理中更正，其余 23 项待处理）**：跨端时钟、移动端死代码、并发顺序、主进程阻塞、发布门禁、文档陈旧等。
- **历史陈旧条目**：TODO.md 头部仍是 0.9.46 / 2026-10-26。2026-10-27 组合被写成“未推送、未发行”，源码已包含在 v0.9.47–v0.9.51 tag 且已进入远端主线；Release 与发行工件本轮未核对，不能把 tag 祖先关系当作正式发行证据。本轮已在 TODO.md 中更正，见 §6。
- **已实现、待验收**：P0.1–P1.7 的原生/正式包/实体设备门禁、Pet 可靠性真实环境验收、⌘⇧Esc 全屏可用性、Mimi 跨显示器视觉验收。本轮没有任何新的真实环境证据，这些状态维持不变。

## 2. 范围与方法

- **方式：**有边界的静态代码审查。CC 按包分 5 路只读审查，Mimi 专项由 CC 追踪；交付后主控另行静态复核 R01–R05 的关键证据并修正文案。审查优先看用户可见故障、状态/生命周期/互斥、跨端契约、安全边界、错误恢复、架构违规、测试与文档陈旧。TODO 注释数量和大文件本身不算问题。
- **不是逐行穷尽审查。**每个包看过的入口和局限见 §5 覆盖矩阵。
- **证据强度定义：**
  - **确认**：代码路径已逐行追到结论；
  - **静态风险**：从代码推断出的风险，没有运行验证；
  - **待真实环境验收**：只有真实 Electron、正式包、真机或真实账号才能证实。
- 本轮**没有运行任何测试**，所以不对任何测试的通过或失败下结论；历史 PASS 也不算作发行或实体设备验收。

### 2.1 实际执行的验证命令

| 命令（在共享 git 对象库上只读执行） | 结果 |
| --- | --- |
| `git worktree list` | 任务工作区 `repo-audit-todo-20261101` 位于 `82c6f37ab [codex/docs/repo-audit-todo-20261101]` |
| `git log -3 --format='%H %ad %s' 82c6f37ab` | 基线 = PR #266 合并提交，2026-10-31 |
| `git show 82c6f37ab:<file>`、`git grep -n <pattern> 82c6f37ab -- <paths>` | 本文全部行号证据的来源 |
| `git log --oneline -40 82c6f37ab -- <Mimi 相关路径>` | Mimi companion 起于 `7dca610dc`，经 PR #239、#244–#258 迭代 |
| `git tag --contains 2035c0a30`、`git merge-base --is-ancestor 2035c0a30 <v0.9.47>` | 2035c0a30 已包含在 v0.9.47–v0.9.51（用于更正 TODO.md:13/15） |
| `git tag --merged 82c6f37ab --sort=-creatordate` | 最新 tag v0.9.51 = 3cadd158c（2026-10-30）；v0.9.47 c6a1c5130、v0.9.48 d85ef7a23、v0.9.49 9161ff792、v0.9.50 37369c0b3 |

**未执行项与交付环境边界：**

- `bun test`、构建、typecheck：任务约束只改文档，而且不应在本机真实 HOME 下跑测试。
- CC 阶段对任务工作区的访问被权限系统自动拒绝，先在暂存目录产出文档。主控交付复核阶段已把三份文档复制到任务分支，并执行 `git status --short`、`git diff --check` 和三份文档的相对链接目标检查；结果见本文 §8。

## 3. 发现（按优先级与体量排序）

### P1

**R01 [P1][S] Bash 只读免审批可读 CodeShell 自身凭据/设置文件**

- 位置：
  - `packages/core/src/tool-system/permission.ts:1408-1423`：敏感路径正则里只有 `.code-shell/credentials`；
  - `:1430-1475`：`segmentIsSensitiveRead`；
  - `:829-841`：只读命令白名单；
  - 判为只读即 `allow`。
  - 对照 `packages/core/src/tool-system/path-policy.ts:775-790` 的 `isCodeShellCredentialContainer`：Read 工具会对用户 `~/.code-shell` 根内的同类敏感容器要求审批；普通项目 `.code-shell/settings.local.json` 不符合当前敏感容器判定，是 Bash / Read 双方的识别缺口。
- 触发：模型执行 `cat ~/.code-shell/settings.json`、`grep -r apiKey ~/.code-shell`、`cat .code-shell/settings.local.json`、`cat ~/.code-shell/serve/access.json`，在 default 模式下免审批放行。
- 影响：provider key、MCP env/header 密钥可被读出。
  - Desktop 默认 sandbox=off（`engine/sandbox-config.ts:48`），在 default/auto 权限模式下缺少对应的只读审批拦截；acceptEdits 模式下 Bash 一律 ask，不属于此免审路径。
  - sandbox 开启时家目录这份会被 deniedReads 挡住，但项目级 `.code-shell/settings.local.json` 不在 deniedReads 内。
- 证据：确认（`classifySegment → matchesSafeReadPattern → segmentIsSensitiveRead → classify` 全链路）。
- 建议：
  - 在 `segmentIsSensitiveRead` 中展开路径参数（`~`、相对 cwd），复用 path-policy 的凭据容器判定并导出；
  - 加入项目级 `.code-shell/settings*.{json,yaml}`；
  - 对 grep/rg/less/sed 这类递归命令的根目录也按同规则判定。
- 验收：
  - 上述 4 条命令以及 `grep -r . ~/.code-shell/` 经 `classifyBashCommand` 判为 `unsafe`；
  - `cat README.md`、`rg token src/` 仍判为 `safe-read`。

**R02 [P1][S] “始终允许（项目）”写 settings.local.json 不加锁，且解析失败时从空对象重写**

- 位置：
  - `packages/core/src/tool-system/permission.ts:738-776`（`persistProjectRule`）：`:748-755` 解析失败当作 `{}`，`:773-775` 先写 tmp 再 rename，全程不持锁；
  - `packages/core/src/tool-system/path-policy.ts:336-377`（路径授权持久化）是同一写法。
  - 对照 `packages/core/src/settings/manager.ts:859-878`（锁内读改写）和 `:991-999`（读不懂时拒绝写）。
- 触发：
  - Desktop 设置页或 Config 工具与“始终允许”跨进程并发写同一文件；
  - 或者文件暂时损坏、写到一半时用户点了“始终允许”。
- 影响：
  - 并发时一方的改动丢失；
  - 文件损坏时整个文件被覆盖成只剩 `permissions`/`pathApprovals`，MCP 等配置全部丢失；
  - 只有 `settings.local.yaml` 时会新建 JSON，由于 JSON 优先（`manager.ts:1071-1083`），YAML 层整体失效。
  - 应复用 `SettingsManager` 对同一文件的跨进程锁协议，解析失败时保全原文件；原子 rename 不能替代锁内读改写。
- 证据：确认（代码自 2026-05/06 起就是这样，不是新回归；没有核对是否在 10-21 的 206 条清单内）。
- 建议：两处都改走 `SettingsManager` 的锁内读改写；读不懂时本次授权仍生效，但不持久化并提示用户；保留 YAML 原配置语义；可继续写 YAML，也可像 `manager.ts:794-817` 先保全原配置再迁移为 JSON，不能从空对象新建并遮蔽 YAML。
- 验收：
  - 多进程并发写不同键后全部保留；
  - 文件损坏时授权前后字节不变；
  - 只有 YAML 时，授权前后的原有配置语义保持生效。

**R03 [P1][S] 浏览器弹出窗口挂完整 preload，却没有顶层导航/新窗口拦截；`shell:openExternal` 不校验发送方且允许 `file:`**

- 位置：
  - `packages/desktop/src/main/index.ts:3122-3141`（`createBrowserPopout`）：`preload/index.cjs` + `webviewTag:true`，只调用了 `hardenWebviewGuests`。对照主窗口 `:1572-1581` 的 `setWindowOpenHandler` 和 `will-navigate` 拦截。
  - `index.ts:6472-6477`：`shell:openExternal` 只检查长度。
  - `desktop-services.ts:977`：放行 `file:`。
  - 全仓没有 `web-contents-created` 兜底。
- 触发：链接被拖到弹出窗口的非 webview 区域，或者弹出窗口的渲染端触发 `window.open` / `target=_blank`，顶层导航到外部页面，而 preload 仍然挂着。
- 影响：外部页面拿到 `window.codeshell` API。IPC 防护不统一：部分通道另校验 `mainWindows` 成员并拒绝 popout，不能据此断言全部 IPC 都可调用；但此处 `shell:openExternal` 明确缺少发送方与来源检查，可以借 `openExternal("file://…")` 用系统默认程序打开任意本地文件。
- 证据：静态风险，待真实环境验收。
- 建议：把主窗口的两段导航守卫抽成公共函数，弹出窗口复用；`openExternal` 校验受信任宿主窗口及本地来源，保留必要的现有合法调用；`file:` 移除或限定为已授权路径；增加 `web-contents-created` 兜底。
- 验收：弹出窗口拖入 https 链接或触发 `window.open` 时顶层 URL 不变；外部页面或未授权发送方调用 `openExternal("file://…")` 被拒绝，原有合法外链入口可用。

**R04 [P1][M] 未被捕获的退出步骤失败会取消本次退出且无可见提示（Windows/Linux 可能无窗口常驻并占着单实例锁）**

- 位置：
  - `packages/desktop/src/main/desktop-shutdown.ts:22-33`：失败时只调用 `onError` 并清掉 `pending`，不会再 `quit()`。按文件头注释这是“未保存不退出”的有意设计，但没有任何用户可见的恢复路径。
  - 渲染进程崩溃事件只记日志（`index.ts:1598` 附近），`flushRenderers` 等满 10 s 后 reject（`session-catalog-ipc.ts:68,70`）。
  - `second-instance` 在没有窗口时直接返回（`quick-chat-startup-cleanup.ts:40`）。
  - `quitAndInstall` 可能卡在 `installing`（退出被取消后未收到同步异常时）（`updater.ts:362-375`）。
- 触发：
  - 渲染进程崩溃后按 ⌘Q；
  - Windows/Linux 关掉最后一个窗口后，`flushRenderers`、`disposeOperationResolution` 或顶层 cleanup 中未被捕获的步骤 reject；cleanup 内经 `Promise.allSettled` 收集的普通 disposer 拒绝不构成本条触发条件。
- 影响：本次退出被取消；`pending` 清空后再次触发退出可以重试（`desktop-shutdown.test.ts:42-72` 已覆盖），但故障持续时仍会反复失败且缺少用户可见提示或明确强制退出路径。无窗口残留进程可能占着单实例锁，再次启动不能自行建窗。自动更新安装也可能停滞。
- 证据：控制流确认；触发条件待真实环境验收。
- 建议：失败时弹“重试 / 仍然退出”；已崩溃或无响应的渲染进程不计入 flush 范围；`second-instance` 没有窗口时调用 `createWindow()`；更新流程失败时复位 `installInFlight`。
- 验收：`process.crash()` 弄崩渲染进程后 ⌘Q 能退出或出现提示；Windows 上模拟 dispose 失败后再次启动能打开窗口。

**R05 [P1][M] Mimi 桌宠与“移动的 Mimi”（CUA 操作角色）是两个互不感知的置顶表面，可以同时出现；默认尺寸偏大**

- 位置：
  - pet widget：`packages/desktop/src/main/index.ts:650-654, 2945-3092, 5903-5981`；
  - companion：`packages/desktop/src/main/computer-use/mimi-companion-host.ts:44-79, 128-164, 588`；
  - 两者都在 mac `screen-saver` 层（`pet/pet-widget-window-state.ts:36-41`）；
  - companion 默认角色框 320（`packages/desktop/src/shared/mimi-companion.ts:92`）。
- 触发：macOS 上分别在 Pet 设置/菜单和“设置 → 电脑操作”里打开两者。
- 影响：
  - 两个 Mimi 同屏叠在一起，各有一个聊天入口；
  - 重启后 companion 自动恢复而 widget 不恢复，行为不一致；
  - 默认角色框高 320 DIP，是桌宠狗头（96）的约 3.3 倍。
- 证据：确认（显隐判定互相独立，`packages/desktop/src/main/pet/` 下没有 companion 引用；`docs/mimi-cua-companion.md:143-145` 自述合并是后续工作）。
- 建议与验收：见 [Mimi 单入口方案](mimi-single-entry-movement-plan.md) §4–§7（统一 `MimiPresenceController`、hide-before-show 互斥、旧设置迁移、建议默认 200 DIP）。

### P2（Mimi / 电脑操作相关）

**R06 [P2][S] CUA 截图只隐藏 companion，不隐藏 pet widget**

- 位置：`mimi-companion-host.ts:100-107` 是唯一的 `hideForCapture` 实现；`packages/desktop/src/main` 下没有 `setContentProtection`。
- 影响：widget 打开时，可能出现在模型截图里或遮住目标控件。
- 证据：静态风险，待真机验收。
- 建议：并入方案 T3 的统一 `hideForCapture`。
- 验收：widget 可见时执行一次截图类 CUA 工具，截图中不出现 widget。

**R07 [P2][S] pet widget 不响应显示器拓扑变化**

- 位置：`index.ts` 中没有 `display-metrics-changed/display-removed` 监听（`git grep` 无结果）。widget 只在创建（`:2948-2953`）和拖动（`:5949-5958`）时夹紧位置；companion 有监听（`mimi-companion-host.ts:579-587`）。
- 影响：拔掉外接屏后，widget 可能停在不可见的区域，直到重新打开。
- 证据：确认（缺少监听）；可见性后果待真机验收。
- 建议：并入方案 §5.6。
- 验收：拔掉外接屏后 widget 回到可见工作区。

**R08 [P2][S] `mimi-companion-host.ts`（717 行）没有单元测试**

- 位置：`git grep -l mimi-companion-host 82c6f37ab -- "*.test.ts"` 无结果。choreographer/layout/stage 各有单测；host 层的持久化、显隐、发送方校验、`close()` 清理只有 e2e 脚本覆盖。
- 建议：方案 T8 补测试，至少覆盖 `persist` 顺序、`update(false)` 与 `creating` 并发、`close()` 移除全部 IPC 与监听器、发送方校验。

**R09 [P2][S] CUA 执行边界规格与代码不一致**

- 位置：`docs/superpowers/specs/2026-10-28-mimi-cua-execution-boundary-design.md`
  - `:138` 称全局停止会对活跃会话发 `agent/cancel`，但 `packages/desktop/src/main/computer-use/computer-use-control.ts:35-40` 的 `stopInput` 只调用 `gate.stopAll()` 并发通知，agent 会继续运行、只是输入被拒；
  - `:143` 称快捷键在 CuaDriverHost running 时注册，但实际按 proxy 连接数注册（`computer-use-control.ts:46-58`），与同文 `:284` 一致、与 `:143` 矛盾。
- 证据：确认。
- 建议：先确定产品语义（停止输入是否取消 Run），再改代码或改文档。
- 验收：规格与代码一致，并有一条测试固定“停止后 Run 是否继续”。

### P2（core / 能力包）

**R10 [P2][M] 删除会话所用的模型连接后，失败会“粘住”，且会话处于半注册状态**

- 位置：
  - `packages/core/src/engine/configured-text-model.ts:98-106, 148-162`；
  - `packages/core/src/protocol/chat-session-manager.ts:386, 397-402`；
  - `packages/core/src/protocol/server.ts:849-850`（来源提交 0b0f559f1）。
- 触发：手机端选过模型连接的会话，其连接被删除或 key 被清空。
- 影响：
  - 首次打开时注册成功但恢复抛错，之后走 `existing` 分支不再恢复模型；
  - 每次运行都抛 “Selected text connection is unavailable”，直到用户手动切换模型；
  - 后台唤醒只记 warn，待办可能丢失。
- 证据：静态风险，待真实环境验收。
- 建议：解析失败时回退到 model/provider 匹配，发出可见警告并清掉 `modelConnectionId`；恢复失败时撤回注册。
- 验收：连续两次打开同一会话，行为一致。

**R11 [P2][S] DelegateWork schema 文案与实现相反**

- 位置：
  - `packages/pet/src/delegate-work.ts:77` 写“缺少证据时 host 会新建 Session”，而 `packages/pet/src/delegation.ts:126-158` 实际是拒绝（“no replacement Session was created”）；
  - `delegation.ts:59-61` 的三个 reason 在全仓都没有被产生。
- 影响：Mimi 可能省略 `session_continuation`，指望静默新建 Session，结果被拒，在 6 回合预算（`packages/pet/src/profile.ts:147`）内反复重试。
- 证据：确认。
- 建议：改 `:77` 文案，删除三个无用 reason。
- 验收：schema 文案测试禁止“回退新建”的措辞。

**R12 [P2][S] 同一个 pet 模块的多个 observer 共享一个 ReportToMimi 连接**

- 位置：`packages/pet/src/capability.ts:123-133`。
- 影响：只有一个组合同时服务多个 AgentServer 时才触发（目前 stdio host 只有一个 server，`packages/core/src/cli/agent-server-stdio.ts:444`），一个 server 关闭会清空其他 server 的连接。
- 证据：静态风险。
- 建议：每个 observer 持有自己的连接。
- 验收：双 observer 测试中，关闭第一个后第二个仍能投递。

**R13 [P2][S] Optimization Lab 冻结数据集时忽略配置的 root**

- 位置：`packages/optimization-lab/src/queries.ts:90` 固定用 `labRoot(p.cwd)`；`:82` 和 `controller.ts:145` 用 `options.root ?? labRoot(cwd)`。
- 影响：生产环境不触发（Desktop 不传 options）。
- 证据：静态风险。
- 建议：改为 `options.root ?? labRoot(p.cwd)`。
- 验收：自定义 root 的单测通过。

**R14 [P2][M] chat 网关每个会话最多并行 4 条消息，绑定 Work Session 的消息可能乱序**

- 位置：`packages/chat/src/cli.ts:88-91` 把每会话并发提到至少 4；`delivery-queue.ts:325-327` 在同一会话内并行执行整条中间件链（`bound-session-chat.ts:77`，`/open`、`/close` 在 `gateway.ts:64-87`）。只有 Mimi 分支会合并同会话消息（`gateway.ts:35-39`）。
- 影响：先发 “A” 再发 “/mimi”，后者可能先到；发往 Session 的消息可能乱序；`/open` 与 `/close` 可能竞态。
- 证据：静态风险，待真实环境验收（Desktop 侧 `routeBoundSessionMessage` 是否串行没有核对）。
- 建议：除 Mimi 外按会话串行执行。
- 验收：慢速假 `routeBoundSessionMessage` 下调用与完成顺序都保持。

**R15 [P2][S] chat 就绪状态过早报 ready，重启退避计数从不归零**

- 位置：`packages/chat/src/chat-gateway.ts:198` 在 `adapter.run()` 连上之前就设为 running；`:204-208` 的 `attempts` 只增不减；`/readyz` 在 `webhook.ts:39-43`。
- 证据：确认。
- 建议：适配器声明就绪后才标记 running；健康运行 N 秒后重置计数。
- 验收：启动即失败的适配器不报 ready；长时间健康运行后断线使用基础退避。

### P2（server / web / 移动端）

**R16 [P2][S] 跨设备审批截止时间只接到了无入口的旧组件，手机实际界面不显示**

- 位置：
  - edd3e83c5 把截止时间加在 `packages/desktop/src/mobile/components/ApprovalCard.tsx:75-85`；
  - 但手机入口 `packages/desktop/src/mobile/main.tsx:4,14` 挂载的是 `packages/web/app/DesktopApp`，其审批组件在 `packages/web/app/DesktopControls.tsx:330-460`，不读 `expiresAt`；
  - `docs/architecture/09-desktop-renderer-mobile-web.md:21-24` 已注明旧组件是遗留代码。
- 影响：手机用户看不到“请在 HH:MM 前确认”；超时后卡片无说明地消失（`packages/web/src/hooks/useRemoteApp.ts:723-738`）。旧组件的单测仍通过，给人虚假的信心。
- 证据：确认。
- 建议：在 `DesktopApprovalCard` / `DesktopAskQuestions` 中渲染截止时间；隔离或删除 `packages/desktop/src/mobile/App.tsx` 与 `components/*`。
- 验收：`DesktopApp` 级测试显示截止时间；生产代码中没有任何 import 指向 `@mobile/components`。

**R17 [P2][S] 由 Host 时钟生成的截止时间被手机时钟判定**

- 位置：
  - Host 生成：`packages/core/src/protocol/user-decision-lifecycle.ts:145`；
  - 客户端判定：`useRemoteApp.ts:731, 822, 2703`；
  - 目录选择器：`packages/web/app/PanelHost.tsx:385-387, 547-549`；
  - 服务端等待：`packages/server/src/panels/runtime.ts:1084`。
- 影响：手机时钟快于 Desktop 超过 10 分钟（审批）或 5 分钟（选择器）时，审批/选择器不出现，Run 或面板一直空等；偏差较小时窗口被悄悄缩短。服务端自己会强制过期，所以不构成安全问题。
- 证据：静态风险，待真实环境验收。
- 建议：随截止时间下发相对 TTL 或服务器当前时间，客户端据此计算本地截止时间；选择器过期时给出提示，而不是静默跳过。
- 验收：客户端时钟 mock +15 min 时，审批和选择器仍可用。

### P2（Desktop 其他）

**R18 [P2][M] 面板发现出现瞬时错误时清空目录，并收回正在运行面板的资源**

- 位置：`packages/desktop/src/main/panel-apps-service.ts:82-83`（catch-all 返回空列表）→ `:305` `replacePanelAppResources([], …)` → `panel-app-protocol.ts:188-199, 331`。
- 证据：静态风险。
- 建议：区分“读取失败”和“确认为空”，失败时保留上一份资源和列表。
- 验收：注入一次异常后，已打开面板的资源仍能加载。

**R19 [P2][S] 快速连点 Dock 可能创建两个主窗口**

- 位置：`index.ts:7279-7281`；`createWindow` 在 `:1443` 先 await，再到 `:1471` 加入 `mainWindows`。
- 证据：静态风险。
- 建议：像 `petWidgetWindowCreation` 一样缓存进行中的创建 Promise。
- 验收：连续两次 `activate` 只产生一个窗口。

**R20 [P2][S] 主进程同步阻塞**

- 位置：`packages/desktop/src/main/profiles-service.ts:634`（`spawnSync --version`，每个工具最长 10 s、串行）；`updater.ts:148,151`（同步 codesign）；`panel-apps-service.ts:36-38`（同步 stat/读文件）。
- 证据：确认存在同步调用，实际耗时待测。
- 建议：改为异步并发执行。
- 验收：依赖工具卡住时 UI 仍可响应。

**R21 [P2][S] 凭据加密在 Linux `basic_text` 后端下的策略与模型签名不一致**

- 位置：`packages/desktop/src/main/credential-cipher.ts:20-31` 只判断 `isEncryptionAvailable()`；`index.ts:1678-1681` 还排除了 `basic_text`。钥匙串临时不可用时会静默写成 `plain:`。
- 证据：静态风险。
- 建议：统一判定，降级时提示用户或拒绝写入。

### P2（tui / cdp / 工具链 / 文档）

**R22 [P2][S] TUI headless `run` 在 stdout 写完前就 `process.exit`，管道输出可能被截断**

- 位置：`packages/tui/src/cli/commands/run.ts:292`；同样模式还在 `runs.ts:142/224/266`、`exit.ts:28-29`。
- 证据：静态风险，待 macOS 实测。
- 建议：设 `process.exitCode`，等 stdout drain 后再返回。
- 验收：在 macOS 上把 >1 MB 的 JSON 管道给 `wc -c`，20 次全部完整。

**R23 [P2][S] cdp `waitForLoad` 的期限覆盖不到卡住的 CDP 命令**

- 位置：`packages/cdp/src/driver.ts:609-618`；Desktop 发送端没有单命令超时（`packages/desktop/src/main/browser-driver/electron-puppeteer.ts:83`）。
- 证据：静态风险。
- 建议：每次 `send` 都与剩余期限竞速。
- 验收：永不返回的 sender 在 `timeoutMs + 200 ms` 内结束。

**R24 [P2][S] ESLint 边界规则漏了 `packages/host`**

- 位置：`eslint.config.js:15-29`（`workspacePackageRoots` 只列了 13 个包），用于 `:256/280/296`。
- 影响：从 core、能力包或渲染端用相对路径导入 host 不会被拦截。
- 证据：静态风险。
- 建议：加入 `"host"`，或从 `packages/*/package.json` 自动生成列表。
- 验收：在 boundary guard 测试中新增一条用例。

**R25 [P2][S] 发布门禁小缺口**

- 位置：
  - `scripts/require-green-ci.mjs:17`：同一 SHA 任一次成功即算绿，即使更新的重跑失败了；
  - `:33`：GitHub API 一次 5xx 就直接失败，不重试；
  - `.github/workflows/release.yml:61`：作业名写 “nine tarballs”，实际是 10 个公开包。
- 证据：静态风险。
- 建议：以最新一次完成的 run 为准；5xx 退避重试；修正作业名。

**R26 [P2][S] `bun run test` 和 `test:watch` 与分片设计矛盾**

- 位置：`package.json:29` 用单进程跑 `tests packages`；`:42` 的 `bun test --watch tests packages` 不经过 guarded runner，参数也没有 `./`；`CODESHELL.md:136` 仍推荐 `bun run test`；ci.yml 的注释说明单进程会超时并出现 EBADF。
- 证据：静态风险。
- 建议：`test` 按 ci.yml 分片执行或输出分片命令；`test:watch` 使用显式 `./` 路径并走隔离环境。

**R27 [P2][S] CHANGELOG.md 缺 0.9.46–0.9.51，却随 npm meta 包发布**

- 位置：`CHANGELOG.md:9`（Unreleased）→ `:46`（0.9.45）；`package.json` 的 `files` 包含 CHANGELOG.md。
- 证据：确认。
- 建议：补齐各版本小节；在发布校验中要求 `## [X.Y.Z]` 标题存在。

**R28 [P2][S] 文档陈旧（非 TODO.md）**

- `packages/arena/README.md:9,21,26` 仍写“供宿主使用、同发行单元”，而 arena 是 `private: true`、不被宿主加载；`publishConfig.access: public` 有误导性。
- `docs/panel-native-tools.md:418-419` 仍写 Hub 只能用 server project / downloads 目录，ef3b2fb7a 之后已支持项目内任意子目录选择（`packages/server/src/panels/runtime.ts:1892-1906`）。
- `docs/todo/mobile-remote-acceptance-2026-10-29.md` 没有被 TODO.md 链接。
- 建议：随相关修复一起更新。

**R29 [P2][S] TODO.md 发布头与集成状态陈旧**

- 已在本轮 TODO.md 更正，详见 §6。

**低优先级备注（不单列待办）：**

- 主窗口位置只夹紧到 ±20000（`packages/desktop/src/main/window-state-store.ts:47`）；
- `packages/browser-devtools/src/inspector.ts:103` 在 try 外解引用 `options.maxEntries`；
- TUI 有 4 处运行时安全规则的 suppression 缺少局部理由（`AppContext.ts:18`、`StdinContext.ts:46`、`TerminalFocusContext.tsx:15`、`reconciler.ts:2`）。

## 4. Mimi 专项摘要

- **“移动的 Mimi”= 桌面 CUA companion（操作角色）**，不是手机端。手机端没有 Mimi 形象：会话列表和输出恢复都主动过滤 pet 会话（`packages/server/src/sessions-service.ts:98,352`；`packages/desktop/src/main/mobile-remote/output-recovery-authority.ts:56,74,141`），只能经 IM 通道对话。
- **分开的原因：**来源不同（桌宠 vs CUA 实验 `7dca610dc`）；状态拥有者、持久化文件、IPC、设置入口全部独立；原型文档明确把合并列为后续工作（`docs/mimi-cua-companion.md:143-145`）。
- **能同时出现的原因：**两条显隐判定互不检查；两个窗口都是 `screen-saver` 层、全部工作区可见。
- **默认尺寸：**
  - 桌宠窗口 112×112 DIP（狗头 96，展开 400×380）；
  - companion 角色框 320×224 DIP（范围 200–480，工作时 ×0.55）；
  - 物理像素 = DIP × `scaleFactor`，没有 zoom。
- **建议：**移动形态默认降到 200 DIP（待用户确认），范围 160–480；停靠形态在 Phase 1 不变。
- **方案：**统一 `MimiPresenceController`，内部保留两个窗口，用户只看到一个；切换顺序 hide-before-show；迁移旧设置。详见 [方案](mimi-single-entry-movement-plan.md)。

## 5. 覆盖矩阵

| 范围 | 实际查看的入口 | 结论 | 局限 |
| --- | --- | --- | --- |
| core | 对 link/tui 的 import 与 pet/arena 字面量 grep；`utils/file-mutex.ts`；锁调用点；`tool-system/permission.ts`、`path-policy.ts`；`settings/manager.ts`；`engine/configured-text-model.ts`；`protocol/chat-session-manager.ts`、`server.ts` 恢复路径；`user-decision-lifecycle.ts`；MCP 会话标签；`plugins/gitOps.ts`、marketplace 刷新；插件 hook 环境 | R01、R02、R10；所查路径未发现超出 CODESHELL.md 兼容别名范围的架构违规 | engine 主循环、output journal、hooks 执行器、MCP 连接池没有深读 |
| link | `operation-validation.ts`、`file-selection.ts`、catalog/recipes 导出 | 未发现问题 | 没有逐个 provider 审查 catalog 内容 |
| host | `runtime.ts`、`host-requests.ts`、`index.ts`、`services/session-files.ts` | 未发现问题（启动回滚、能力不可重复注册、O_NOFOLLOW 加 inode 复核） | `mcp-probe.ts`、`model-connection-probe.ts` 没读 |
| coding | 导入面、Claude 权限映射、session-factory 的 prompt-tool 接线、运行时 spawn 参数、隔离文本推理 | 未发现问题 | drive-agent、worktree、LSP、Codex runtime、apply-patch 没读；Claude CLI 参数是否存在需真实环境核对 |
| pet（能力包） | delegate-work、delegation、profile、capability、projection-extension、pending-decision-index、sessions-tool 路径校验 | R11、R12；只经 `core/extension` 导入，符合约束 | host-actions、follow-ups、report-to-mimi 没有深读；9–10 月可靠性修复没有重新验证 |
| optimization-lab | feature flag 与 Desktop gating、module、queries、controller | R13；默认关闭符合要求 | ledger、评分、报告计算没审 |
| arena | package.json、README、全部宿主导入路径 | 只保留源码、不被宿主加载；README 陈旧（R28） | 没有审查 arena 逻辑 |
| chat | webhook、teams/line/whatsapp 验签、chat-gateway、gateway、cli、delivery-queue 调度、bound-session-chat、ingress | R14、R15；验签与 ingress 已加固 | wechat/slack/lark/dingtalk/matrix/mattermost/wecom 适配器内部、spool 持久化没读 |
| server | `panels/directory-picker.ts`、`panels/runtime.ts` 的 picker/confirm 与 CSP、`mobile-static.ts`（#238）、`remote-host-manager.ts:200-760`、`desktop-web/http-api.ts`、#241 `references.ts` | 未发现鉴权绕过或路径穿越；R17 的服务端部分 | `access-passcode.ts`、`pairing.ts`、relay connector、`room-manager` 没有全读 |
| web | `useRemoteSocket.ts`、`useRemoteApp.ts` 审批截止路径、`PanelHost.tsx:375-562`、picker 线协议 | R16、R17；重连与监听器清理正确 | `useRemoteApp` 的历史/游标逻辑（约 2900 行）、`mobileOutputClient.ts` 没审 |
| desktop main | 窗口创建与 webview 加固、CSP/权限、弹出窗口、生命周期与退出、自动更新、agent-bridge worker 回调、外部运行时审批、CUA 闸门/control/activity-server/desktop-setup、panel 服务与协议、credential cipher、`spawnSync` 扫描；**Mimi：pet widget 全链路与 companion host 全文** | R03、R04、R05–R09、R18–R21 | `index.ts` 共 7281 行，只按主题抽读；external-runtime-service、panel-app-bridge、browser-runtime 没有深读 |
| desktop preload | `ipcRenderer.on` 与 main 侧 `.send` 的通道对照；`pet-api.ts`、`computer-use-api.ts`、`mimi-companion.ts` | 字面量通道一致 | `types.d.ts` 与实现的签名没有逐项比对 |
| desktop renderer | 全部 `@cjhyy/*` 导入；`main.tsx` 的弹出模式；Mimi：`App.tsx:942-999`、`PetDesktopWindow.tsx`、`PetWidget.tsx`、`PetSettingsPage.tsx`、`SettingsMenu.tsx`、`ComputerUseSettings.tsx`、`live2d/MimiCompanionWindow.tsx` | 没有违规运行时导入；R05 | 一般组件的状态与竞态没审 |
| desktop mobile UI | `src/mobile/main.tsx`、vite mobile 配置、旧 `App.tsx` 导入图、`output-recovery-authority.ts`、`handle-client-event.ts` | R16 | `native-submissions.ts`、`external-runtime-commands.ts` 没读 |
| tui | CLI 退出路径、`run` 生命周期、运行时安全 suppression、对 server 的依赖 | R22 | Ink 渲染与组件没审 |
| cdp | 零依赖、导出与 README、超时 | R23；Desktop 仍使用 cdp helpers，与 CODESHELL.md 一致 | — |
| browser-devtools | 零依赖、脱敏、边界、dispose | 低优先级备注 1 条 | — |
| 根脚本 / CI / 发布 | Bun 版本固定（全部为 1.3.11）、ci.yml 14 项检查、版本校验（15 份 manifest + `core/src/index.ts:7` + 14 个 bun.lock 条目，基线全部为 0.9.51）、green-CI 门禁、`check-test-shards.ts` | R24–R27 | 没有 API 权限，无法对照 GitHub ruleset 的检查名 |
| 文档 | TODO.md 77 个相对链接（全部可解析，锚点没查）、CODESHELL.md 构建顺序与包列表（一致）、Mimi/CUA 文档 | R09、R28、R29 | docs/ 下数百份历史审计证据没有复核 |

## 6. TODO.md 陈旧项更正依据

| TODO.md 原表述（基线行号） | 事实（证据） | 本轮处理 |
| --- | --- | --- |
| `:5` 发布核对 2026-10-26、origin/main `2661eb04d`、源码 0.9.46、普通 CI 十二项 | origin/main = `82c6f37ab`，源码 0.9.51，最新 tag v0.9.51（`3cadd158c`，2026-10-30）；ci.yml 现有 14 项检查 | 新增 2026-11-01 核对行，原行标为历史核对 |
| `:13` 2026-10-27 组合“已快进合入两仓本地 main，未推送、未发行”，基线 `2035c0a30` | Host 仓的 `2d031febe`、`26f8068eb`、`2035c0a30` 都是 v0.9.47 的祖先（`git tag --contains`）；panel-apps 一侧没有核对 | 更正 Host 侧表述 |
| `:15` 外部自动记忆“另已集成本地 main” | 源码已包含于 v0.9.47 tag（发行工件未核对） | 更正 |
| `:16` “真实 `0.9.44→0.9.46` 升级回滚” | 候选需更新为 v0.9.51 或之后；门禁本身仍未完成 | 更正版本，保留待办 |
| `:38` Mobile 大旧基线分页“合入本地 main” | 源码已包含于 v0.9.47–v0.9.51 tag（发行工件未核对）；正式包与真机验收仍缺 | 更正发行状态，保留验收 |
| `:74` “Arena、Pet、coding 都是独立能力包，经 extension/composition 组合” | Arena 已不被任何宿主组合，只保留私有源码 | 更正 |
| 未跟踪 | Computer Use / Mimi 舞台工作（PR #239、#244–#258，源码包含于 v0.9.50 tag，发行工件未核对）与 ⌘⇧Esc 全屏待验收（执行边界规格 `:305`） | 新增待办 |

## 7. 建议处理顺序

1. **R01、R02**（S，core 安全与数据完整性）。
2. **R03**（S，Desktop 安全）→ **R04**（M，退出可恢复）。
3. **R05 Mimi 合并**（M–L）：已获授权实施（T0 按方案 §9.1 决定），源码落在任务分支 `codex/desktop/mimi-unified-presence-20261101`，**R06–R08** 同架构收口；主控已补齐回归、类型/lint、构建和隔离实际 Electron 验证，原生合成器/多显示器/正式包仍未验收，状态以[方案 §9](mimi-single-entry-movement-plan.md#9-实施记录2026-11-01)为准。
4. **R16、R17**（手机审批体验）、**R10**、**R14**。
5. 其余 P2 和文档项随相关改动顺手处理；R27–R29 在下一次发版前完成。

## 8. 主控交付复核

- 文档已从 CC 暂存目录复制到任务工作区 `/Users/admin/.codex/worktrees/repo-audit-todo-20261101/codeshell`，任务分支为 `codex/docs/repo-audit-todo-20261101`；没有修改主工作区的分支或文件。
- 另行只读复核 R01–R04 的调用链与已有防护/测试，修正了项目设置的 Read 保护范围、退出可再次重试、普通 disposer 拒绝不阻断退出，以及部分 IPC 自带主窗口校验等表述。复核没有读取真实凭据或执行产品测试。
- 主控核对 R05 的独立显隐条件与 320 / 200–480 尺寸常量，并补充了预览入口必须互斥、关闭时撤销旧预览、每个异步边界上的可见性不变量，以及使用实际脚底偏移和工作缩放的切换坐标要求。
- 更正 tag / 正式发行的证据边界：本轮只证实源码祖先关系和远端主线，不声称对应 Release、工件或真实设备验收已完成。CI 矩阵展开为 14 项，但未读取 GitHub ruleset，不能据此声称 14 项均为必需检查。
- 三份文档共 **114 个相对链接**的目标文件检查通过，缺失为 0；未核验链接中的标题锚点。
- `git diff --cached --check` 通过；暂存范围仅 `TODO.md` 和上述两份新增报告。没有修改产品代码、配置、测试、版本或锁文件，没有运行测试/构建/typecheck，没有 push、PR、合并或发布。
