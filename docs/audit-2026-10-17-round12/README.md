# CodeShell 第十二批审查

冻结源码：`d5fae44358b3a92d4d02fd5fcc4ac21c56b2a08a`。本批新增 **4 项 P3**、**2 个候选**，另关联 **1 个旧问题的剩余边界**。只修改审查文档和证据；全仓审查持续，本批结束不代表全部内容已覆盖。

| 编号 | 确认问题 | 实际证据与边界 |
| --- | --- | --- |
| TUI-R12-01 | modifyOtherKeys 将非 Ctrl 大写文本降为小写 | 实际 parser → InputEvent，Shift+A 得到 a；TextInput 消费仅静态追踪 |
| TUI-R12-02 | KeyboardEvent 未还原编码可打印键的字面字符 | 实际 parser/事件构造，Alt+Space 得到词语 space，Alt+z 带 ESC；dispatcher/Button 未执行 |
| DESKTOP-R12-01 | 工具卡摘要截断拆开 Unicode 代理对 | 实际 helper 在正常 70/80/90 上限产生孤立高代理项；UI 消费仅静态追踪 |
| PATCH-R12-01 | 省略可选 @@ 时丢失首段显式空白 context | 实际 parser/matcher，重复行的匹配位置由 2 变为 0；applier/文件写入未执行 |

详见 [TUI 输入](tui-input.md)、[Desktop helpers](desktop.md)、[ApplyPatch](patch.md)、[调度与时间展示](schedule-display.md)。候选是 ANSI grapheme width metadata 与实际 stringWidth 不一致（当前消费者未使用 width），以及 Write 卡片用 code-unit 长度标 B（静态）。Header-only diff 的文件身份丢失属于旧 R2-10 根因剩余边界，单独关联，不增加新 bug 数。

**首次验证：6 组 clean guarded shards，66 pass、413 expectations、0 fail/skip**，其中 35 项既有基线、31 项 focused 现象/对照。通过的刻画测试包含错误行为断言，不表示已修复。每组原始 combined stdout/stderr 和退出码均先保存后查看，没有产品测试失败或重跑。[validation](validation.json) 明列命令、raw log、exit 和计数；共享日志只计一次。

Root、Desktop、Patch 完整历史查重范围为 prior docs/bugs **1,060 Markdown + 598 parsed JSON = 1,658 文件**，152,326 JSON string leaves，0 parse error。TUI 另含 TXT，为 1,725 文件。各处保留初始命名子集和后续 metadata-only 范围补充，未把截断的终端显示当作完整库存。

TUI 文本 shard 在首次运行前把 Core barrel 的 grapheme helper 映射到实际冻结 intl.ts，OSC native helper 是抛错且调用数为零的边界；没有验证整个 Core barrel。调度模型只读源码，实际只运行 relativeTime/timezones 既有纯函数测试，没有恢复旧 i18n 失败方向或执行真实调度。Core cron 猜路径、各处元数据参考/正则/文档补丁错误分别保存为明确工具响应转录；metadata 更正未触发产品重跑。

[findings](findings.json)、[candidates](candidates.json)、[related observations](related.json)、[source pins](source-manifest.json)、[evidence index](evidence-index.json) 给出可核对材料；[assembler](evidence/assemble-audit.py) 只生成元数据，不执行产品或测试。独立只读复核与 root 最终 QC 位于 evidence 下。

没有执行真实终端/TTY/PTY、React/Electron/native UI、Git diff producer、ApplyPatch/applier、实际工具或自动化、真实模型/收费 API/账号/用户数据/外部消息/权限/security/custody实验；没有 shared deps/dist 重建或完整 build/typecheck/lint/suite。官方协议/格式资料只用于正常输入合同，不是实际终端或安装 Git 版本的实测证据。

工作分支 `codex/audit/input-parsers-schedule-round12-20261017` 仅整合本目录。[整合前核验](evidence/integration-plan.json) 记录已完成末尾 fetch，current main 仍等于冻结源，69 个 selected source pins 当前字节均匹配冻结 blobs。主工作区既有 tracked deletion 与四个 untracked 文件的内容 hash 和状态与开审快照一致。整合只允许本目录的 disjoint fast-forward，前后继续核对；已确认问题不通过重跑恢复或扩大证据。持续审查仍需要当前独占 worktree，故保留使用。
