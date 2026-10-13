# 第十四轮：Terminal tab、窗口 owner 与重开

**建议保留 1 项 P3，暂称 TL1。** 正常 reload 保留终端 owner/token；恢复的 terminal-1 在首次新建前关闭后，下一次新建重新分配 terminal-1，接回尚存活的旧 PTY而不是新壳。再次关闭重开可恢复。正常同 tab 重挂、不同 ID 的迟到事件隔离、启动拒绝后重试、自然退出与 owner reap 保护均通过；同 key 显式 kill/restart 的回调缺口仍因当前 UI 不可达而排除。

冻结快照 `a66f4ef291f304ee4df9da8095a90671d9a8f140`，工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。已读 CODESHELL.md、主报告 R01–R62 与第十三轮终端报告。R58 的 managed worktree 路径门禁、R59 的首提交 Review、R61 的 catalog 选择联动不重复计数。本子任务没有修改产品/主报告/goal，没有 build/clean、模型、真实 PTY、worker、OS 通知或原生进程实验；root 另行提供了不打开 Terminal 的真实隔离 Electron reload 身份实验，见下文，不能合称真实 PTY 复现。

## 本轮执行证据

[terminal-lifecycle.test.tsx](/tmp/codeshell-review-20261012-terminal-lifecycle-round14/terminal-lifecycle.test.tsx) 使用真实 `TerminalPanel`、`PanelArea` / tab strip、真实 `pty-service`，并精确 AST 提取生产 Main 的四个 PTY IPC handlers 与 preload 六个 PTY methods。窗口事件总线、WebContents、xterm 绘制和 native PTY adapter 用替身；路径门禁是实际 `requireRendererProjectPath` 的 `registeredPaths` 注入，目录均为 fixture 自有临时目录。没有启动真实 shell。

每个真实 Main handler 仍校验 terminal ID，并将实际 fixture sender 交给服务 owner gate；组件事件通过真实 preload subscribe / unsubscribe 与 invoke 闭环。未执行 BrowserWindow、真实窗口重载或 renderer crash，不能称作 Electron 端到端复现。PanelArea 的请求/controlled state 由测试 host 提供，其 close/delete key 仍走实际 tab strip handler。

[成功日志](/tmp/codeshell-review-20261012-terminal-lifecycle-round14/terminal-lifecycle.test.log)：**6 tests / 41 assertions / 0 fail / 0 skip**。其中 1 项观察 TL1 及其再次重开恢复，5 项是正常保护/恢复；“通过”不代表有 6 个缺陷。此前条件诊断版本为 6/35，最终补了 recovery / 不同 ID 的旧 data/exit 对照，计数以此 6/41 为准。

| 场景 | 实际观察 | 生产保护 |
| --- | --- | --- |
| 同 tab 卸载后重挂、相同 owner / token | listeners 清除；PTY 不被 kill；重挂不额外 spawn；保留输出回放到新 xterm；其他 WebContents 不能 reattach/write | [TerminalPanel.tsx:121](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/TerminalPanel.tsx:121)、[pty-service.ts:265](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/pty-service.ts:265) |
| 第一个 start 延迟，tab 已关闭并新建不同 ID | 迟到 start 的返回不触发旧实例 resize；旧 tab 的 data/exit 不进入新 xterm；新 tab 仍可写入自身 PTY | [TerminalPanel.tsx:67](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/TerminalPanel.tsx:67)、[87](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/TerminalPanel.tsx:87) 的完整 ID 和 disposed guard |
| native spawn 适配器拒绝 | 真实 service 返回 `{ok:false,detail}`，组件显示具体失败；关闭后新 tab 可成功启动 | [pty-service.ts:283](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/pty-service.ts:283)、[TerminalPanel.tsx:89](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/TerminalPanel.tsx:89) |
| Main 路径校验拒绝不存在目录 | 组件 catch 显示错误，native adapter 未调用；卸载 listeners 清空，新有效 tab 可恢复 | [index.ts:6453](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6453)、[TerminalPanel.tsx:97](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/TerminalPanel.tsx:97) |
| shell 自然退出，再新建 tab | 退出码可见；新 tab 使用新句柄启动；live owner 不被 reap，destroyed owner 被 kill 一次，再 quit 不重复 kill 已移除 entry | [TerminalPanel.tsx:71](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/TerminalPanel.tsx:71)、[pty-service.ts:307](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/pty-service.ts:307)、[325](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/pty-service.ts:325) |

真实 native kill 是否完成、真实 OS shell 与后代是否全部退出不属于本轮替身结论。迟到 start 仍可创建该窗口拥有的隐藏旧 PTY，组件明确保留壳到窗口关闭/退出；本轮不把这条已写明的保活政策单独报为泄漏，也不声称它回收了真实原生资源。

## 关闭和 owner 的源码保护

[PanelArea.tsx:273](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelArea.tsx:273) closeTab 删除指定 tab，关闭最后一个时关闭 dock；激活临近 tab 时保持目标身份。[PanelRegistry.ts:177](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelRegistry.ts:177) 生成 bucket+tab 的基础句柄，组件 [TerminalPanel.tsx:28](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/TerminalPanel.tsx:28) 追加 windowToken。实际 preload [index.ts:1453](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:1453) 负责传输并返回对应 listener 的卸载函数，不自行改写 ID。

Main [pty-service.ts:208](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/pty-service.ts:208) 比较真正的 WebContents **对象**，不是仅相信 token 或数值 ID；reattach/write/resize/kill 都经该门禁。滚动 buffer [192](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/pty-service.ts:192) 封顶 256 KiB；resize 会 clamp 并捕获 native 错误。Main [index.ts:1533](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1533) 明确 macOS 最后窗口关闭仍需 reap，`closed` 后 next tick 调用 `ptyReapDestroyed`；退出 cleanup [7179](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:7179) 调用 `ptyKillAll`。这些是调用范围与接线证据，不能代替 OS 终止完成实验。

组件 [TerminalPanel.tsx:129](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/TerminalPanel.tsx:129) 明确卸载不 ptyKill，以保留壳；源码未找到 renderer 实际调用 ptyKill 的重启按钮。已有 cwd 变化故意保留启动时目录，并在 [141](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/TerminalPanel.tsx:141) 显示工作区变更提示。这些设计不作为新缺陷。

## TL1 / P3：reload 后关闭恢复终端，首次重开复用旧壳

主要位置：[PanelArea.tsx:220](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelArea.tsx:220) 的 mkId 只在新建时扫描当时还存在的 tabs，未在恢复时将模块 counter 提升到已分配最大值；[273](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelArea.tsx:273) 的关闭先移除恢复 tab，而卸载按设计不 kill。实际组件观察到：新模块 counter=0，初始恢复 `terminal-1` 且 requestKind=null，用户在首次创建新 ID 前关闭该恢复 tab；下次重新分配 `terminal-1`，Main [pty-service.ts:265](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/pty-service.ts:265) 因 key 与 owner 相同而正常 reattach 尚存活旧 PTY，回放旧缓冲，不新增 spawn。

生产恢复形状有证据：[appUtils.ts:89](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/appUtils.ts:89) hydrate 读取持久 tabs 并将 requestKind 设为 null；[usePanelBuckets.ts:625](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/usePanelBuckets.ts:625) 保存 tabs/activeId；[PanelArea.tsx:217](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelArea.tsx:217) 的 module counter 在 renderer reload 后重置。菜单 [menu.ts:118](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:118) 提供正式 reload。这里不是打开/关闭整个 dock 的有意保活，而是实际 tab 已删除后请求新终端，违反源码“Fresh, collision-proof tab id”约定。

完整 key 还取决于 preload [index.ts:1446](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:1446) 的 `windowToken=process.pid`，owner 则取决于真正 WebContents 对象。最初将此作为条件诊断；root 随后提供 [reload-identity.json](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/review-2026-10-12/validation/terminal-lifecycle-round14/reload-identity.json)、[原始 log](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/review-2026-10-12/validation/terminal-lifecycle-round14/reload-identity.log)、[脚本](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/review-2026-10-12/validation/terminal-lifecycle-round14/reload-identity.mjs)：真实冻结 Desktop、隔离 HOME / Main exact-origin guard，连续两次正常 `win.reload()`，三次快照 windowToken 与 rendererPid 均为 71825，WebContents ID 均为 1；Main realm 保留旧 WebContents 对象并逐次直接 === 比较，sameOwnerObject 三次均 true；rendererErrors=[]，workerCreated=false、terminalOpened=false、actualPtyStarted=false，正常 exit0。该实际 reload 身份门禁结合本 fixture 的实际组件/Main/service 链，支持普通 reload 后复用条件生产可达。

Main 的 `render-process-gone` [1505](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1505) 与 `did-start-navigation` [1538](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1538) 仅处理 media，正常 reload 没有窗口 closed 的 PTY reap。实际身份实验**没有打开 Terminal 或启动真实 PTY**，组件实验**没有运行 Electron**；二者组合不是完整 native terminal 重现，也不支持所有 crash/导航/平台都维持相同 token。不同 owner 的新窗口/真正关闭重开不适用此重连条件。

可达操作按最小范围表述：在同一窗口保存过 `terminal-1`，菜单 Reload 后让其正常恢复，在该 renderer 首次分配新 ID 前关闭它，再新建 Terminal；旧壳尚存活且 owner/token 未变时，旧滚动输出被回放、输入仍进入旧 PTY。再次关闭重开时 counter 已推进，fixture 实际生成不同 ID 并新增 spawn；旧 data/exit 不影响该新 ID。故建议 **P3**：范围是恢复顺序且有额外操作恢复，没有历史或草稿损坏证据。未执行真实命令或目录变更，不声称错 cwd、错误命令执行、壳泄漏、所有重开都失败或永久不能新建。

修复可在恢复 tabs 时将 ID 分配器提升到所有已分配最大值，或用独立 tab UUID，使真正删除再创建不重用旧 key；单纯在 mkId 时扫描尚存 tabs 不足以记住刚关闭的恢复 tab。应保留原 tab 暂时重挂的同 key 重连和窗口 owner gate，不通过放宽 owner 或取消全部保活解决。回归需覆盖恢复后先关最高序号 tab、重复 close/reopen、多个 bucket、same owner+same token 与新窗口 owner 控制。R58 是新 worktree 路径授权拒绝，R61 是目录会话选择，均不能修复此 tab 句柄分配问题，独立但影响不需升 P2。

## 排除项：同 key 显式 kill/restart 的迟到 callback 无代际检查，当前 UI 不可达

Main [pty-service.ts:222](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/pty-service.ts:222) kill 后立即删 key；旧 [onData:301](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/pty-service.ts:301) / [onExit:307](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/pty-service.ts:307) 回调仅按 sessionId 查当前 entry，没有 `current === capturedSession` 校验。若在旧 exit 到达前显式 kill 并用相同 key 重建，理论上旧 data 可进入新 entry、旧 exit 可删新 entry。

本轮不执行这个人为服务 seam，也不报为发现。真实 renderer 没有 kill/restart 入口；正常自然 exit 本身同步移除该 entry，普通新 tab 不要求复用 key。TL1 也只是重新连接同一个尚存活的 entry，不能制造“旧 PTY 已 kill、新 PTY 已替换”的前提。若未来增加原位重启，应按捕获的 session/PTY 实例或 generation 处理回调。

独立只读 [owner-audit.md](/tmp/codeshell-review-20261012-terminal-lifecycle-round14/owner-audit.md) 补充 Main/preload owner、窗口关闭、退出屏障和 reload 的源码边界，新运行测试为 0；该子报告在 root 的真实身份实验之前完成，最终 TL1 可达性以本报告补证为准。本子任务执行数仍只有上述 6/41，root Electron 身份实验另计一次脚本、两次 reload，不累加到 Bun 断言数。

## 运行与日志溯源

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-terminal-lifecycle-round14/terminal-lifecycle.test.tsx
```

脚本在业务导入前安装 exact-origin `http://127.0.0.1:9` 守卫，guarded runner 隔离 HOME/状态/凭据；没有发送该 origin 请求。fixture 目录的 node_modules symlink 仅用于 JSX runtime 解析。当前脚本源码路径固定 latest，需要便携复制时改为 cwd；这不是产品改动。

[terminal-lifecycle.harness-failed.log](/tmp/codeshell-review-20261012-terminal-lifecycle-round14/terminal-lifecycle.harness-failed.log) 是首次缺 JSX runtime 依赖解析的 harness 错误；[terminal-lifecycle.initial-diagnostic.log](/tmp/codeshell-review-20261012-terminal-lifecycle-round14/terminal-lifecycle.initial-diagnostic.log) 是初次把恢复 tab 当作新 ID 对照的等待失败，以及同 tab reattach 尚未完成便断言 replay 的过早读取。前者促成本报告条件诊断，后者改为有界等待真实异步路径结束。保留原始失败，不计正式发现；最终成功日志与该限制应一起保存。

[terminal-lifecycle.conditions-only.log](/tmp/codeshell-review-20261012-terminal-lifecycle-round14/terminal-lifecycle.conditions-only.log) 是尚未收到真实 Electron 身份证据时的 6/35 成功版本；最终为当前 6/41。root 身份实验的前两次 launch harness 失败（动态 CDP socket 与 parent 全局 guard 不兼容）原日志由 root 保存；最终仅将 Main/worker 的导入前 confined guards 与 renderer HTTP(S) 拒绝作为目标进程保护。没有把失败日志计为产品问题或把 parent harness 改动误说为产品改动。

[terminal-lifecycle.recovery40.log](/tmp/codeshell-review-20261012-terminal-lifecycle-round14/terminal-lifecycle.recovery40.log) 保留 6/40 的恢复版本；最终额外明确断言新壳未继承旧滚动缓冲，当前日志为 6/41。
