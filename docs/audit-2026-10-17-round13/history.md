# Round13：TUI 输入历史与 model-display 普通 helper

冻结源码为 `7927a7c8b80b4aec710dee1f6d831ad1982bb466`。本组新增 **2 项 P3**，另保留 **1 个候选**。1 次 guarded 首跑完成，**7 pass、31 expect、0 fail、0 skipped**；7 项都是新增 characterization/对照，没有执行既有测试。测试断言当前错误行为与恢复对照，不代表修复。

## HIST-R13-01 / P3：Up 首先返回旧 session 输入，刚提交的新输入被排后

同项目先有 previous session 的 `previous session input`，current session 再提交 `current session input`。真实 `createHistoryNavigator().up()` 第一次返回旧输入，第二次才返回本次新输入。同一模块的 `getTimestampedHistory()` 正确把本次新输入列为最新，真实临时 JSONL 也保留正确追加顺序。

合同来自 `packages/tui/src/ui/input-history.ts:125–127` 的 **most recent last**、current session priority，以及 `:310` 的 **Move up (older)**。根因是 `:162` 先拼 currentSessionEntries、后拼 otherEntries，而 navigator `:305–317` 从末尾向前读取，翻转了 session 分组的实际浏览优先级。普通提交的生产链为 `packages/tui/src/ui/components/CommandInput.tsx:171–172` 的 add+refresh，Up 在 `:119` 调同一 navigator。

真实函数对照：只有 old session 时按时间倒序正常；不同 project 被过滤；Down 正常恢复草稿。因此只记录导航顺序错误，不声称内容或磁盘数据丢失。没有执行 CommandInput、React、Ink 或真实按键。

## HIST-R13-02 / P3：中断撤销没有更新已有 navigator 的字符串快照

夹具按正常提交顺序执行真实 `addToHistory()`、已有 navigator 的 `refresh()`、`flushHistorySync()`，模拟后续中断 bookkeeping 调真实 `removeLastFromHistory()`。此后 `getTimestampedHistory()` 仅剩 `kept input`，新建 navigator 也只返回 kept input；原 navigator 仍首先返回已撤销的 `interrupted input`。对原 navigator 显式 refresh 后恢复。

合同为 `packages/tui/src/ui/input-history.ts:218–220` 的 Undo most recent addToHistory，以及 `packages/tui/src/ui/App.tsx:1455–1456` 对 interruption 的 Undo last history entry。真实 remove 在 `input-history.ts:236–240` 修改 `_entries`，但 navigator 在 `:305` 存储独立字符串数组，`up` 不检查当前 entries。静态消费者在 `CommandInput.tsx:58` 用 useRef 长期持有该 navigator，只在提交 `:172` 刷新；App 的 Esc 分支只调用 remove。`TuiControlSurface.tsx:364–370` 的普通无 overlay 分支保持 CommandInput，仅根据 isRunning 改 placeholder，没有给中断提供刷新或更换 key。

**执行边界**：执行了真实 history helpers、真实自有临时 fs；App/CommandInput/TuiControlSurface 的引用寿命和 Esc 生产链仅静态追踪，没有挂载或运行 React/Ink。结论限于保留既有 CommandInput 实例的普通中断路径；覆盖层引起重挂载可产生新 navigator，不能据此声称每条 UI 路径都受影响。已保留 kept input、新建 navigator、显式 refresh 三种对照。

## HIST-R13-C1：同 tick pending 撤销后自动 flush 标记粘住（候选）

真实 helper 序列 add→remove→等 nextTick→add→等 nextTick，使第二条普通输入存在内存却没有自动落盘；显式 `flushHistorySync()` 后落盘恢复。非空正常 flush 的对照会让下一次 add 继续自动落盘。根因静态对应 `input-history.ts:168` 在 pending 为空时直接 return，未执行 `:179` 的 `_flushScheduled = false`，而 `:183` 的 scheduleFlush 之后持续提前返回。

暂不列正式缺陷：本轮未证明实际 TUI Esc 能在提交后的 nextTick 之前进入 remove；`clearPendingHistoryEntries` 也未找到正常调用点。没有改写调度器，没有模拟进程崩溃，不声称永久数据丢失。正常退出的显式 flush 仍可恢复。

## 其他观察与排除

- `model-display.ts` 的文档示例 128000→128K、1000000→1M、undefined→? 与普通值控制通过；modelTags 明确按名字推断，输出属启发式标签，本轮没有更强 provider 能力合同，不登记 substring 误判。
- 已落盘 interrupted input 在当前临时 JSONL 仍保留，这一磁盘观察由同一首次夹具保留。没有再加载或跨进程运行，也没有证明跨启动撤销的持久性合同，不据此单列跨启动缺陷，不扩大 HIST-R13-02。
- 既有 `input-history.test.ts` 已完整阅读副作用，包含敏感命令方向，本轮不执行，不恢复历史安全审查方向。未运行 App/index 中静态读到的 catalog refresh、client.cancel、provider handler 等。
- `app-helpers.tsx` 源码阅读未发现可在本组合同下独立登记的新问题；其较宽 renderer/command 运行依赖未导入。

## 隔离、首次证据与去重

[夹具](evidence/history-characterization.test.ts) 首次 guarded 调用先将 combined stdout/stderr 原样写入 [raw log](evidence/history-characterization.first.log)，再写 [exit receipt](evidence/history-characterization.first.exit.json)，两者落盘后才查看。没有失败 shard、修 fixture、产品修改或重跑。

没有设置、重设或复用 `HOME`、`home`、`CODEX_HOME` 环境/脚本变量。夹具在第一次动态导入真实 input-history 之前，以 node:os mock **仅替换 homedir()**，返回 task-specific `mockedHome` 所指的自有 mkdtemp 子目录，其他 os 导出保留。真实 fs/nextTick 没有替换；只读写该临时目录，drain pending ticks 后清理。没有实际用户历史、TTY/PTY、原生应用、模型、网络、自动化或外部消息。

[去重 collector](evidence/history-dedup.py) 对全部 docs/bugs 递归 `.md`/`.json`、包括 archive/_archive、排除当前 round13，处理 **1716 文件（1075 MD、641 JSON、240534 scalar leaves）**，JSON 解析错误 0，64 个 topic/file hit 条目。[匹配结果](evidence/history-dedup.json) 中旧历史问题是 inline-login 持久化、Windows mode、focus 泄漏等，旧 model-display 是重复 helper 抽取；与本组三个根因不同。全范围扫描不等于已验证所有历史问题仍存在。

一个前批 metadata-script 路径定位失败已原样标注在 [navigation note](evidence/history-navigation-note.md)：只跳过不存在的旧脚本，没有重试该读取；新 collector 属独立元数据收集，不是失败产品方向的替代验证。

[正式项数据](evidence/history-findings.json)、[候选](evidence/history-candidates.json)、[验证汇总](evidence/history-validation.json)、[冻结 Git blob 与 SHA-256 pins](evidence/history-source-manifest.json) 可供根整合。source pins 区分完整/选择性阅读和 actual/static；不把静态引用推断称为完整 UI 运行，不把本组 narrow pass 称为 build/typecheck/full suite 通过。
