# Round13 history 只读交叉复核

复核对象：`history.md`、聚焦 fixture、首跑 combined raw/exit、findings/candidates/validation、source/artifact pins 与全历史 dedup。冻结 `7927a7c8b80b4aec710dee1f6d831ad1982bb466`。本次仅静态读取和元数据哈希计算，**0 runtime、0 测试、0 他人文件/产品/Git修改**；仅写此复核文件。

结论：两项正式 P3 的窄结论有足够纯 helper 证据与普通 UI 静态可达合同，保留；同 tick flush 项继续候选。没有需阻塞整合的发现。

## 普通提交、Up 与中断到达性

- HIST-R13-01：`input-history.ts:125–127` 明确 history 为 most recent last，`:310–317` 从末尾向更旧方向浏览；`:162` 把当前 session 组放数组前部，使另一 session 的旧项反而在第一轮 Up 被读到。夹具在相同合法 project 加一条本次新输入，实际 timestamped history 最新项和磁盘追加序都正确，只有 navigator 顺序错误；old-only、project 过滤、Down 草稿对照齐全。`CommandInput.tsx:171–172` 的普通提交 add+refresh 与 `:119` 的 Up 使用同一接口，故普通 producer 充分。没有把字符串/磁盘完整性错误混入本项。
- HIST-R13-02：`removeLastFromHistory():222–240` 明确撤销最近 add 并从 `_entries` 移除；navigator `:305` 保存独立字符串数组。夹具先按普通 submit 执行 add+refresh，正常 flush 后再 remove，旧 navigator 返回 interrupted input，而 timestamped、新建 navigator 与显式 refresh 都只保留 kept input。这不依赖同 tick 抢占。
- `CommandInput.tsx:58` 的 useRef 确保实际导航使用旧对象，虽然 createHistoryNavigator() 表达式在重渲染时会再次求值，该新值不会替换已存在 ref。`:144` 的编辑动作只 reset，不 refresh。`App.tsx:1418–1427` 的普通无 overlay、active query Esc 门槛到 `:1456` remove 没有刷新此 ref；`TuiControlSurface.tsx:364–370` 保持同一 CommandInput 类型和位置，isRunning 仅改变 placeholder。`App.tsx:2223–2227` 的 bottomContent 中也没有随运行状态变化的 key。该链均为源码支持，没有运行 React/Ink 或真实 Esc；报告已明确仅限保留组件的普通路径，覆盖层重挂载另当别论。

## 隔离与首跑

fixture 静态 import 的 model-display 只有纯函数，没有先导入 input-history。`mock.module("node:os", ...)` 在第一个带 query 的真实 history 动态 import 之前安装，只有 named homedir() 替换为 owned mkdtemp 下的 mockedHome，其余 os 导出来自 originalOs。没有赋值或重新利用 HOME/home/CODEX_HOME；每个 fixture 子目录独立，真实 fs 与 nextTick 保留，清理前 drain tick。仅普通字符串输入，没有执行既有敏感命令 fixture 或真实 TUI。

已读取 raw 与 exit：7 pass、31 expect、0 fail、0 skip，包含完整 Completed Bun shard；两个正式项和候选的 console 观察与 fixture/report 相符。没有新增或重跑测试。13 个 source 的 frozen Git blob id、SHA-256、当前字节均逐项复核一致；artifact receipt 使用 `files` 字段，11 个列出文件的 bytes/SHA-256 全部匹配，包括 raw、exit 与 fixture。raw/exit 的落盘先后由 author 的首次运行记录说明，本次不重新运行去“验证”捕获顺序。

## 候选、去重与范围

HIST-R13-C1 的函数序列确实有首次 raw 支持：pending 归零导致 `_flushScheduled` 不重置，后续 add 不再自动排 flush，显式 flush 恢复。真实 UI Esc 是否能在 submit 后 nextTick 前到达未证；目前普通输入事件通常晚于该 tick，未找到正常 clearPendingHistoryEntries 入口，维持 candidate 正确。没有崩溃、永久数据丢失或跨启动撤销结论。

dedup collector 的范围包括全 docs/bugs MD/parsed JSON 与 archive/_archive，排除 round13；清单为 1075 MD + 641 JSON、240534 叶子、0 JSON 解析错误。核对 topic/file 命中中的旧 inline-login、Windows mode、focus/navigation 归属及 model-display 重复 helper 条目，与两个正式项根因不同；文字检索仍不是语义穷举。报告明确既有测试未执行、UI 为 static、模型能力 tag 属启发式、落盘旧 interrupted input 仅观察未另计缺陷，边界准确。
