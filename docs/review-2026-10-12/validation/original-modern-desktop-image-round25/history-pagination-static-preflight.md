# Round25 历史分页静态预审（0 产品/fixture 执行）

读取范围为两个冻结快照：84740d56 与 a66f4ef2。已读 CODESHELL.md、审查 README 的 R01–R83，并按父任务排除 R84 旧 paired-native 图片 fallback。本文未新增正式编号，未运行 fixture、产品 import、模型、CLI、网络或实际应用，也未改产品/主报告。

## 1. 仅保留一个有条件的静态候选

`packages/server/src/sessions-service.ts:304` 对同一目录 `mtimeMs` 的会话用 `a.id.localeCompare(b.id)` 排序，`:312–317` 恢复下一页却用 `entry.id > decodedCursor.id`。后者是 UTF-16 字符顺序，与 localeCompare 的拉丁字母大小写/标点顺序不同。若分页切点落入同 mtime 的混合字符组，下一页可能跳过仍应在切点之后的会话；反方向还可能回到已读行。

静态示意，尚未执行：49 个更近的 filler 加同 mtime 的三个合法 16 字符 ID `a000000000000000`、`B000000000000000`、`c000000000000000`。在普通拉丁 locale 的字母排序下，第一页 limit50 在 a 行结束；比较 `B... > a...` 为 false、`c... > a...` 为 true，后续扫描从 c 开始，B 被略过。应由后续获准 fixture 直接核实运行环境的排序、真实 reader 页及消费结果，不能把此示意当动态收据。

真实生产 ID 来源并不局限于 SDK 测试：

- `desktop/main/index.ts:3502–3505,3551–3558` 将 `buildDesktopAutomationRunner` 装入正式自动化 runner。
- `desktop/main/automation-host.ts:297–304` 创建 origin=automation 的 Engine；`:368–374` 执行普通独立任务时没有传 sessionId。
- `core/engine/run-session-open.ts:169–179` 把 undefined options.sessionId 传入 SessionManager.create；`core/session/session-manager.ts:717` 因此生成 nanoid(16)，`:738–740` 持久 parentSessionId:null 和 origin:automation。NanoID 字符范围包含大小写、下划线和连字符。
- `server/sessions-service.ts:341–365` 接受普通顶层 automation origin；healthy cwd、未归档、不为 pet/ephemeral 的这些行会入 catalog。

真实消费入口：`desktop/renderer/Sidebar.tsx:500–514` 的“加载对话历史” → `App.tsx:2220–2222` → `app/useAutomationSessionImport.ts:121–130` 固定 limit50 → preload/session-transcript-api.ts → `main/session-transcript-ipc.ts:27–44` → 实际 listDiskSessions。消费只导入返回行、保存返回 nextCursor（hook :138–181）；known-ID 去重不能把服务端漏掉的行补回来。

必要前提与未证实边界：

- 必须有完全相等的目录 mtimeMs，且切点处 ID 的两种排序不同；普通全小写、不同 mtime 路径不受影响。
- 当前 Desktop 手工新会话 `transcripts.ts:406–417` 和 mobile 新会话 `handle-client-event.ts:329` 的生成方式是小写，不可将它们当混合大小写来源。
- 当前只读源码没有证明普通 APFS 日常操作会自然产生相等 mtime，也没有执行粗粒度文件系统或备份恢复实验。低精度存储/恢复造成的相同 mtime 是待验证触发条件，不能写成已实测事实。
- 要看到侧栏遗漏，相应行还必须未在 renderer 现有索引/其他成功导入中；旧索引本来已有该行会遮盖本缺陷。磁盘原件和历史管理页仍在，无数据损失论据。
- 两基线在 reader、hook、producer及其相关核心链路的 git diff 为空。候选建议只按窄 P3 讨论，待主审决定是否值得制作 guarded fixture。

## 2. 未发现新候选的正常门禁/反证

- Desktop 聊天更早内容使用连续累计尾窗，Main 从首 newline 之后解析，以避开被尾窗截断的首 JSONL 行；`transcript-reader.ts:90–117,569–599`。hook 每次倍增窗口，有 duplicate-request、engine identity 和 hydration generation 门禁（`useTranscriptBuckets.ts:439–501`）；失败仍保留 previous 状态，界面显示失败与重试（`ChatView.tsx:1507–1535`）。128MiB 预览上限有明确按钮文字，不将任意长度 TODO 当新缺陷。
- 在等待读页期间新直播到达，`transcriptsReducer.ts:105–115` 使用 mergeHistoryIntoLive，后者保留现有对象/运行指针；未找到可可信声称旧分页回包覆盖另一个会话的路径。R55 的磁盘导航迟到问题另有根因，不重复。
- Hub 历史分页在 workspace、archive、roots、query 过滤后收集 limit+1（`hub/session-management.ts:228–248`）；Core list 对同时间戳排序和 before 都使用 localeCompare（`session-manager.ts:2397,2410–2418`），不受上述 reader 比较器差异影响。过滤在 push/limit 之前，不复制 R56 的“最近500候选后再搜索”问题。
- HubSessions 查询/归档/刷新变更会中止当前 read；more 把 query/archive/cursor 和同一 AbortController 绑定，仅在未 aborted 时追加，sessionId 去重（`HubSessions.tsx:107–157`）。未把异步 callback 人工重排冒充同步生产响应乱序。
- paired `session.list` 的100条窗口没有直接列为新问题：`DesktopApp.tsx:282–286` 明确称 paired recent-session cache，shared history 允许更早记录，按 workspaceCwd 补齐旧行并能 select；正式共享 HubSessions 另有游标。未称全历史丢失、旧会话无法打开。
- CC/Codex 只读 history 的较早内容限制与弱网恢复仍在 `docs/todo/mobile-remote-optimizations.md` 明示。现有第十三/十五轮已覆盖 snapshot/cursor、viewer refs、切房间和最终 drain；没有因同步 history 能读完整文件就未经实验扩报 Host 卡顿/OOM。

新增动态执行 0，正式发现 0。静态候选 1（排序与 cursor 比较器不一致；同 mtime 及实际缺行消费待获准验证）。
