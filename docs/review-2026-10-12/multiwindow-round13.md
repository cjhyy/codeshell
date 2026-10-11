# 第十三轮：Desktop 多窗口与持久 session catalog

> 主报告收束：本附录候选 M1 正式编号为 **R61 / M1 / P3**。root 已将便携脚本复制到报告目录，并在 84740 与 a66f 两基线分别 guarded 复跑成功。下文“仅 latest”描述的是代理首次实验范围，不能用来覆盖这次补充验证。


审查快照：`a66f4ef291f304ee4df9da8095a90671d9a8f140`，工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。已读 `CODESHELL.md` 及主报告当前 R01–R57，产品只读，无构建、原生进程实验、模型或外部服务调用。以下是提交 root 决定是否纳入的一个 P3 候选，以及已验证的正常保护；没有因为旧 TODO 或单窗口关闭缺少 flush 就增加问题。

## M1 / P3 候选：同项目窗口的正常会话选择覆盖另一窗口当前会话

**触发与实际影响。** 从正式“新窗口”入口打开 A、B 两个 Desktop 窗口，使两者显示同一项目 P。A 正在查看 S1；在 B 侧栏选择另一个既有会话 S2。B 的选择被写入 project 级目录并广播到 A，A 的当前会话也变为 S2。A 再选择 S1，B 同样被切回 S1。用户无法让这两个窗口稳定地分别停留在同项目的两个会话，重新选择可以恢复，但会覆盖另一窗口。不同项目的窗口对照不受影响。

**可达性。** [CommandPalette.tsx:189](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/shell/CommandPalette.tsx:189) 提供 `window.new` / `Cmd+Shift+N`，调用真实 `newWindow()`；[index.ts:5835](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5835) 创建另一个完整应用窗口。没有发现只允许一个窗口的正式门禁。复现只需已有项目与两条已有会话，无首次迁移、运行任务、丢包或异步导航竞速。

**生产因果链。**

1. [useSessionNavigation.ts:80](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:80) 的正式侧栏选择调用 `setActiveSession`，后者在 [transcripts.ts:1136](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/transcripts.ts:1136) 保存 `activeSessionId` 到项目 index。
2. [sessionPersistence.ts:99](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionPersistence.ts:99) 把选择变化发为 project 级 patch；[session-catalog-store.ts:151](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-store.ts:151) 将其写入共享 canonical index。
3. [session-catalog-ipc.ts:45](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-ipc.ts:45) 向全部活窗口广播完整 snapshot；[sessionPersistence.ts:278](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionPersistence.ts:278) 接受新 revision 并重新投影。
4. [useSessionIndices.ts:25](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionIndices.ts:25) 将广播的整个 index（包括选择）合入窗口 React 状态；[App.tsx:297](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:297) 直接用该字段派生当前会话。

这是一条完整的正常选择链；问题点不在目录字段合并失败，而在共享持久选择同时充当各窗口当前导航。代码确有“follow Main's durable cross-window catalogue”注释，能证明目录共享意图，尚未找到明确要求所有同项目窗口同步导航的产品契约。若产品明确要求镜像式窗口，M1 应作为已验证行为排除；目前正式新窗口入口与窗口独立活动项目状态支持将其作为 P3 流程摩擦候选交 root 判定。

**证据强度与限定。** [catalog-window-selection.test.tsx](reproductions/multiwindow-round13/catalog-window-selection.test.tsx) 使用实际 `SessionCatalogStore`、`SessionTranscriptCache`、IPC 注册、preload API、两个独立 `SessionPersistence` 与两个 React root；为避免单 JS realm 共用 renderer singleton，精确 AST 提取生产 `useSessionIndices`、`selectSession`、`setActiveSession` / normalize 及 App selector，分别绑定每窗口 persistence。模拟的是窗口/IPC 传递与无关 UI setter，没有改写被验证的选择逻辑。结果 [catalog-window-selection.test.log](reproductions/multiwindow-round13/catalog-window-selection.test.tsx.log)：**3 tests / 24 assertions，全部通过**。其中第一项固定观察当前问题，另两项检查跨项目隔离与字段合并/删除。

没有执行完整 Electron 双窗口点击或屏幕录制；实际消息内容、草稿、模型发送与 transcript 写入没有在本 fixture 中执行，不能据此声称历史或草稿丢失、输入被错发、权限越界。`catalog-observations.json` 中 `transcriptOrRowsDeleted: false` 仅表示该用例没有执行删除，并且目录行数仍为 2；不构成 transcript 内容完整性实验。已有会话仍可重新选择，故建议 P3，不能据这个结果升为 P2。

**去重。** R16 是 Hub `cc.open` 回包广播到同设备浏览器页签，并可能覆盖较新选择；M1 无 Hub/open 请求或回包竞速，普通 Desktop 本地选择就通过持久目录同步覆盖同项目窗口。R21 是 Hub 首次运行刷新日志基点裁切；R29 是旧项目初始快照覆盖项目广播；R33 是新建意图被后台流抢占；R35 是并行 worktree 回滚删除；R55 是迟到磁盘打开覆盖较新的导航。M1 无这些前提，源于同项目多个活窗口的同步目录字段。归档文档 [15-current-review-and-bug-inventory.md:183](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/archive/architecture/15-current-review-and-bug-inventory.md:183) 的 I11 记录 worker 输出广播的泛化风险，没有描述本项 session catalog 选择链；本轮未把该旧 TODO 当作另一发现。

**最小修复建议。** 把当前窗口的 active session 与持久目录的“上次使用会话”分开。新窗口初始化/进入项目时可以从目录种子恢复；另一窗口的普通目录广播应继续更新标题、pin、归档、删除等共享事实，但不覆盖本窗口仍有效的当前选择。被删除或归档的会话仍需正规化退出。不要通过停止跨窗口目录广播来修复，否则会破坏已经有效的合并与删除保护。回归应验证两个同项目窗口可分别停留 S1/S2、跨窗口 rename/pin 可见、删除当前行能退出、重开窗口可以恢复合法选择。

## 已验证的保护与未列问题

| 用户流程 | 已观察的保护 | 证据与边界 |
| --- | --- | --- |
| 多窗口同时修改同一会话标题和 pin | renderer 只发变化字段；Main 每次载入最新文件并原子提交；两字段均保留，重新打开 store 仍一致 | 新 fixture 的第三项；生产 [sessionPersistence.ts:62](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionPersistence.ts:62)、[session-catalog-store.ts:179](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-store.ts:179) |
| 一个窗口删除，旧窗口随后保存 | permanent tombstone 过滤 stale upsert，不能复活被删行；canonical 与两个窗口均保留删除结果 | 新 fixture 第三项；[session-catalog-store.ts:138](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-store.ts:138) |
| 初次迁移与重载 | Main 保留既有 canonical 行和选择；迁移 backup/marker 原子提交；renderer 每份 legacy transcript 收到 ACK 后才删源；失败可重试；旧 revision 不覆盖新 projection | 既有 store / persistence 套件；[session-catalog-store.ts:79](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-store.ts:79)、[sessionPersistence.ts:278](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionPersistence.ts:278) |
| 保存失败 | 未成功提交不广播 success；pending patch / transcript head 保留；Gate 显示保存失败并有重试按钮 | 既有套件；[SessionPersistenceGate.tsx:30](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/SessionPersistenceGate.tsx:30) |
| 正常退出 | Main 向每个活窗口请求 flush；等待该窗口 sender 对应 ACK；失败或 10 秒超时拒绝退出；成功后再等两个 store flush | IPC 套件；[session-catalog-ipc.ts:39](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-ipc.ts:39)、[session-catalog-ipc.ts:56](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-ipc.ts:56) |
| Panel agent 同一 session 的窗口控制归属 | 最新正式 claim 决定唯一 owner；关闭时释放自己拥有的记录；回复仅接受绑定窗口；可能修改状态的 invoke 不允许广播 fallback | routing 套件；[panel-host-routing.ts:39](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/panel-host-routing.ts:39)、[panel-host-routing.ts:89](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/panel-host-routing.ts:89) |
| 单窗口关闭/renderer reload | 关闭 owner 会取消该窗口外部审批、停止其 external runtimes，media owner 在关闭/主导航释放；Core worker 跨窗口存活不是独立缺陷 | [index.ts:1533](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1533)。仅静态核对，没有原生进程实验 |

没有把“单窗口 close 或 reload 没有执行全局 quit 的 renderer flush”本身列为丢历史问题。Renderer transcript cache 是可恢复投影，Core canonical history 与 catalog 不等同；当前证据不足以证明正常关闭丢失用户唯一副本。也没有把 Panel 最新 owner claim 的明确设计报告成竞态；本轮没有证实普通 native 任务或审批错误归属的新故障。

[catalog-protections.test.ts](reproductions/multiwindow-round13/catalog-protections.test.ts) 在 guard 后导入既有 `session-catalog-store.test.ts`、`session-catalog-ipc.test.ts`、`sessionPersistence.test.ts`、`panel-host-routing.test.ts`；[catalog-protections.test.log](reproductions/multiwindow-round13/catalog-protections.test.ts.log)：**33 tests / 129 assertions，0 fail / 0 skip**。合计本轮 **36 tests / 153 assertions**。

## 复现与日志说明

以下命令从冻结工作区运行，不构建产品；guarded runner 分配临时 HOME / 状态目录，两个脚本在导入目标代码前安装 exact-origin `http://127.0.0.1:9` 网络守卫。本轮没有请求该 origin。

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-multiwindow-round13/catalog-window-selection.test.tsx
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-multiwindow-round13/catalog-protections.test.ts
```

原始 [catalog-window-selection.harness-failed.log](validation/original-multiwindow-round13/catalog-window-selection.harness-failed.log) 保留第一次 harness 未 await 异步 `renderHook` 的错误；修正 harness 后才得到上述 3/24，第一次失败不计产品问题。结构化摘要为 [catalog-observations.json](reproductions/multiwindow-round13/catalog-observations.json)。可选择复制的文件是两个脚本、两个成功日志与该 JSON；失败 harness 日志只作审计溯源。

## 附录：root 的 managed-worktree Terminal 候选只读反证

按 root 要求只读审阅其 `terminal-review-round13/terminal-worktree.test.tsx` 和正式生产调用链，没有重跑 Git / PTY / 原生实验。**未发现“必须先将 worktree 另行 OpenProject 才能使用终端”的正式门禁，赞同此候选可独立于 R22 保留。** 本附录自身不新增测试计数；动态结果和 native spawn stub 由 root 原证据承担。

- 正式入口是 [WorkspaceIndicator.tsx:604](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:604) 的 `switchTo`：有 session / project、非 busy 且 authority ready 就可调用 workspace switch。Main [project-authority-ipc.ts:287](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-authority-ipc.ts:287) 将其交给 session workspace service，并广播成功 workspace；不要求新增 project root。
- [session-workspace-service.ts:511](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-workspace-service.ts:511) 创建/采用合法 worktree 后，写 session workspace、session cwd index 与 handoff；没有 `ProjectStore.addRoot`。因此 root fixture 观察到 worktree 不在 `project.roots` 不是造了不可能状态，而是正常域模型：project main root 与 session 当前 workspace 分开。
- [requireSessionFileRootForUi:452](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-workspace-service.ts:452) 正面支持 `createdBy=codeshell` 且 Git worktree 列表包含当前 root 的会话工作区；文件权限无需再注册该 worktree。Panel 也通过 [usePanelWorkspaceRoot.ts:45](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.ts:45) 明确以 engine session 为真源，保留 hidden bucket 所属 worktree。
- [PanelArea.tsx:184](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelArea.tsx:184) 把 workspace.root 作为 cwd，[PanelRegistry.ts:171](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelRegistry.ts:171) 的内置 terminal 无额外开关，直接将该 cwd 交给 TerminalPanel。[TerminalPanel.workspace.test.tsx:80](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/TerminalPanel.workspace.test.tsx:80) 现有正向测试还明确要求首次 PTY 使用 worktree cwd，说明产品组件的支持意图；该测试仅 stub preload，未覆盖 Main 拒绝。
- Main [index.ts:6460](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6460) 调用 project 路径门禁而非 Session workspace 门禁；[renderer-project-path.ts:114](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/renderer-project-path.ts:114) 刻意排除 Session cwd，要求 session authority 经 Session-scoped IPC 流动。这条安全约束本身正确，错配是 PTY 调用方没有带 engine session authority。拒绝发生在 `ptyStart` 之前，不能通过将 native PTY 适配器换为真实实现来挽救；TerminalPanel catch 会显示 startFailed 与该注册错误。
- 影响应限定为进入合法 worktree 后首次启动一个终端 tab（或重开后首次重新建立 PTY）失败。已经在主目录启动的终端故意保留最初 cwd，不能据此报告为同一缺陷；root 原证据未运行真实 PTY，也不支持声称进程泄漏、错误命令执行或任意目录访问。切回 main 再新建终端是合理恢复对照；另行注册 worktree 可绕过 exact project path 检查，但不是正式 workspace switch 流程的前置要求。
- 与 R22 独立：R22 的合法 secondary **已注册 project root** 会通过 `requireRendererProjectPath`，但 installed Panel 在 [panel-app-bridge.ts:1005](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/panel-app-bridge.ts:1005) 因绑定 topology 误拒绝。Terminal 是内置面板，不走 installed Panel bind；本项是合法 **Session managed worktree** 不是独立 project root，在 PTY IPC 的另一门禁被拒绝。应保留 registered secondary 可启动和任意未注册目录拒绝的对照，避免扩大成“全部多根项目终端失效”。

修复建议保留 project/no-repo 兼容路径，同时给 terminal 显式、独立的 engine session authority 参数，再由 Main 从会话事实解析当前 cwd，并检查 renderer/session access 与 worktree 身份。当前 `sessionId` 是 `term:<bucket>:<tab>@<windowToken>` 的 PTY 句柄，不是 engine session id，不能直接把它当作 Core session 或以任意 supplied cwd / 可伪造前缀授权。保持每窗口 PTY owner 限制及不允许任意未注册目录的正常保护。
