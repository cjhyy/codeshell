# 第十四轮 Terminal Main/preload 只读归属与生命周期复核

结论：本子任务没有确认新增正式缺陷。常规 PTY owner 绑定、不同 key 的输出隔离、窗口销毁清理和退出接线均有明确源码保护。同 key 在旧 PTY 退出回调到达前被显式 kill 再 start，存在回调代际缺口，但当前 renderer 没有调用 `ptyKill` 的入口；由本 renderer 已分配 ID 的普通 tab 关闭后重开会使用新 ID，恢复后先关闭的特殊顺序需另看下文，不能将该服务 seam 直接当作用户可达发现。窗口 reload/crash 只有条件化源码结论，未做 Electron PID 或原生生命周期实验。

冻结源码：`/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，HEAD `a66f4ef291f304ee4df9da8095a90671d9a8f140`。已读 CODESHELL.md、主报告 R01–R62、第十三轮终端与 Review 报告及其独立复核；R58 的 managed-worktree path 门禁、R59 的首提交 Review 为空不在本轮重复计数。这里只写当前文件，未修改产品、主报告、目标或构建，未执行任何测试、PTY、子进程/worker、模型、账户或网络实验。

## Main 与 preload 的正常保护

- `packages/desktop/src/main/pty-service.ts:162–169` 将每个 key 映射到 `{ pty, webContents, buffer }`，owner 是实际 WebContents 对象。`:208–219` 的 `sessionForOwner` 对对象身份做严格比较，owner 不符只记录拒绝并返回 undefined；并非只相信 renderer 传入的窗口 token 或数值 ID。
- `pty-service.ts:262–275` 的重连先验证同一个 WebContents，再把该 entry 的滚动缓冲回放到调用者，返回已有 PID，不另起 shell。`:318–321` 的 write、`:338–345` 的 resize、`:348–350` 的 kill 均经相同 owner gate。未找到其他绕过 owner gate 的 renderer 控制入口。
- `packages/desktop/src/main/index.ts:6453–6462` 的正式 start IPC 校验 PTY ID，等待项目路径权威，再以 `e.sender` 交给 service。`:6464–6477` 的 write/resize/kill 也传递实际 sender；write 要求 string 且不超过 1 MiB。`pty-service.ts:177–189` 的句柄格式要求 `term:`、长度不超过 512、无 `..`、只接受指定字符；该句柄不是 Engine session ID。路径门禁的既有 R58 不在此复报。
- `pty-service.ts:279–296` 先校验 cwd 目录，native spawn 抛错转为结构化 `{ ok:false, detail }`；只有 spawn 成功才在 `:297–298` 写入 Map。`:192–198` 将每个滚动缓冲封顶 256 KiB。`:334–345` 对 resize 使用正整数 clamp，并捕获 native resize 错误。
- `packages/desktop/src/preload/index.ts:1453–1472` 是 IPC 调用与事件订阅适配；`onPtyData`/`onPtyExit` 返回对应 removeListener。preload 订阅本身不按 session key 筛选；`packages/desktop/src/renderer/panels/TerminalPanel.tsx:67–77` 在实际组件按完整 sessionId 筛选。`:121–128` 在卸载时撤销输入、输出、退出、链接与 ResizeObserver，并 dispose xterm。
- 现有 `packages/desktop/src/main/pty-ownership.test.ts:64–112` 覆盖非 owner 的 write/resize/kill/reattach 被拒，原 owner 正常控制；`:29–30` 的 FakePty 没有保存 data/exit 回调，所以这些现有测试不构成迟到回调的验证。`packages/desktop/src/preload/pty-contract.test.ts:6–16` 仅覆盖 start 的成功/结构化失败类型，本子任务没有重跑它们。

## 关闭、重开和相同 ID 的边界

`packages/desktop/src/renderer/panels/PanelRegistry.ts:177–183` 生成 `term:<bucket>:<tabId>`，`TerminalPanel.tsx:28–30` 再追加 `@windowToken`。`packages/desktop/src/preload/index.ts:1446–1452` 用 renderer 的 `process.pid` 生成该 token，意图是不同窗口的终端 key 分离；Main 的 WebContents owner gate 是独立的第二层保护。

`packages/desktop/src/renderer/panels/PanelArea.tsx:40–41` 使用模块级单调 counter；`:217–230` 的 `mkId` 还扫描该 bucket 的既有 tab IDs，生成更大的序号。`:273–285` 的 closeTab 删除被关闭 tab，重新添加在 `:268–270` 调用 mkId。**若 terminal-1 由当前模块分配，counter 已为 1，关闭后重开取得 terminal-2**；此时 service 旧回调查旧 key，不会命中新 key。

这不能泛化成全部恢复顺序都有新 ID。fresh renderer 模块的 counter 为 0；假如持久恢复 terminal-1、requestKind=null，且在任何 mkId 扫描该旧 tab 前先关闭它，随后 reopen 的 tabs 已空，mkId 可以再次返回 terminal-1。若窗口 token 和 owner 同时保持，Main 会重新连接尚存的旧 PTY；这里没有显式 kill，也不触发上述 kill→restart 的迟到回调 gap。这一条件现已由协调代理的替身诊断提请核对，静态算式与源码一致；本子任务没有执行或重复计数其测试。真正 Electron reload 是否保留 token/owner 本轮未验证，不能把固定 token 的诊断直接表述成普通 reload 后确定发生的产品缺陷。

`TerminalPanel.tsx:129–131` 明确不在卸载时 kill，壳跨面板切换存活，退出/窗口关闭时清理；`PanelArea.tsx:127–128` 也明确通过保持挂载保活终端。`docs/todo/small-features-2026-07-10/review-panel-wrong-cwd.md:135–145` 明确保留已启动 PTY、用新 tab 启动新 workspace，显式重启只是可选后续能力。不能将“旧 tab 卸载但 shell 保留”自身定性为漏 kill，也不能假定现在存在同 key 的重启按钮。全局源码查询只发现 preload API 与 Main handler 的 `ptyKill` 接线，未发现实际 renderer 调用。

服务层条件缺口是确定的，但当前不列发现：

1. `pty-service.ts:222–230` 的 killSession 调用 `s.pty.kill()` 后立即删除 key，不等待 onExit。
2. `:301–306` 的旧 onData 闭包按 `sessions.get(sessionId)` 取当前 entry，未检查 `s === session` 或 PTY 对象身份；同 key 若已换成新 entry，旧 data 会加入新缓冲并发给新 entry 的 owner。
3. `:307–313` 的旧 onExit 同样取当前 key 的 WebContents，随后无条件 delete key；同 key 若已重建，会把旧 exit 发给新 entry 并删除新 entry。

该推导需要在旧 exit 到达前显式释放并复用同一个 key。tab close/reopen 不调用 kill；当前模块已分配 ID 时使用新 key，特殊恢复顺序即便同 key 也只重连尚存 entry，均不能满足显式释放再重建的前提。正常自然 exit 已同步执行删除后才可再次 start，也不留下“尚未执行的同一次 exit”来覆盖新 entry。若未来引入重启 API，应按捕获的 Session 对象/代际确认事件归属；这是对源码缺口的记录，不是当前新增正式问题或已执行复现。

## 窗口关闭和退出清理

`packages/desktop/src/main/index.ts:1533–1535` 明确解释 macOS 最后窗口关闭后应用仍存活，因此需清理 destroyed WebContents 的 PTY。`:1541–1549` 在 `closed` 后用 `setImmediate(ptyReapDestroyed)`，等待 WebContents 真正 teardown；`pty-service.ts:324–328` 遍历当前 entry，仅对 `isDestroyed()` 的 owner 调用 killSession，保留其他存活窗口的 PTY。`:222–230` 对 native kill 抛错做 best-effort 捕获并删除 entry。

`index.ts:7133–7136` 在非 macOS 的 window-all-closed 调用 quit；macOS activate `:7206–7207` 可再建窗口。before-quit `:7138–7145` 使用 createDesktopShutdownHandler；`packages/desktop/src/main/desktop-shutdown.ts:12–33` 顺序等待 renderer flush、operation-resolution dispose 和 cleanup，失败保留退出屏障，重复事件不会并发启动第二次 cleanup。Main 的 cleanup `index.ts:7179` 调用 ptyKillAll，`pty-service.ts:353–355` 遍历所有当前 Map keys 逐个 kill。

这些源码证明清理已接线及其调用范围，不能证明 native kill 一定完成、其后代必然退出或所有操作系统具有相同退出语义。ptyKillAll 没有等待 native onExit；本任务按授权没有做原生进程实验，不把这点扩写为 R31/R57 或新的清理缺陷。

## Reload / renderer crash：只作条件结论

正式菜单 `packages/desktop/src/main/menu.ts:118` 提供 role=reload。`PanelArea.tsx:217–219` 明确考虑 renderer reload 后 counter 重置并恢复 tabs；`packages/desktop/src/renderer/app/appUtils.ts:89–91` 恢复 panel snapshot，`usePanelBuckets.ts:625–636` 按 bucket 持久化 `{open,tabs,activeId}`。这些文件没有为 PTY 持久化 PID、代际或独立窗口身份。

Main `index.ts:1505–1508` 的 render-process-gone 只释放 media owner 并记录日志；`:1538–1540` 的主帧非原地 navigation 也只释放 media。没有在这些事件中触发 ptyReapDestroyed 或 ptyKillAll。PTY owner 死亡回收实际挂在 window closed，见上一节。

preload 的 `windowToken` 仅等于每次执行时的 `process.pid`；注释称其为窗口寿命内的判别值，但这里没有 Main 分配的持久窗口 token，也没有 PTY reload/crash 专门恢复协议。源码能支持的条件分析是：

- 重新挂载若完整 key 相同，且传入同一 owner WebContents，start 会按 `pty-service.ts:265–275` 重连并回放现有缓冲。
- 若 token 不同，完整 key 不同，start 会创建独立 entry；旧 entry 是否仍在，取决于 owner 是否 destroyed 以及关闭清理是否发生。
- 若 key 相同而 owner 对象不同，start 会被 owner gate 拒绝，不能接管已有壳。

没有执行 Electron reload/crash，没有核验 PID 是否改变、WebContents 对象身份是否保持，也没有找到针对 renderer crash 自动恢复所有既有 shell 的正式产品约定。因而不能声称普通 reload 必定丢失终端、crash 必定泄漏 PTY，或用猜测的 PID 变化增加正式问题。对已 close 的 owner，Main start 的 await 后也没有显式存活重检；这只是源码边界观察，未复现“close 后成功 spawn”时序，不单列候选或计入数量。

## 证据范围与去重

此次只读核对的关键 `pty-service.ts`、`pty-ownership.test.ts`、preload index 与 PanelRegistry 在 `84740d56e55517b004948a0a0e07649ad6fbf998..a66f4ef2` 的 git diff --stat 为空。工作区 status 只见已有 `?? docs/review-2026-10-12/`，本子任务未改这些文件。新运行文件数、测试数、断言数均为 0。

R58/R59 是不同的路径权威和 Git range 问题；R61 是全局 catalog selection 广播，未参与 PTY owner；R31/R57 是其他原生资源关闭/恢复链，不能借本轮静态调用推导扩张。建议本轮将以上 owner、重连、关闭/退出和不同 key 事件隔离作为正常控制，并把同 key 显式 restart 的代际缺口及 reload/crash 条件结论留在排除项中。

## Root 后续真实 reload 身份补证

本初始只读审计完成后，root 在隔离 a66f 实际 Electron 执行两次 reload，最终 token/rendererPid 为 71825，webContentsId 为 1；Main realm 直接对象 === 比较三次 sameOwnerObject=true，无 worker/Terminal/PTY。结合主代理实际组件/Main/service 替身首项，恢复 terminal-1 先关闭再首次重开确实复用旧key并reattach旧PTY；再次关闭重开得到不同key、新adapter spawn且不继承旧缓冲。该条现在建议 P3（TL1），以同名总报告最终结论为准。完整 native PTY 仍未运行；本只读子审计自身新运行数仍为 0，同key显式kill/restart的另一回调gap继续排除。
