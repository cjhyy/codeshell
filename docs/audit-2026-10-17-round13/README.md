# CodeShell 第十三批审查

冻结源码：`7927a7c8b80b4aec710dee1f6d831ad1982bb466`。本批新增 **2 项 P3**、**4 个候选**，另有 **1 个旧家族关联**。只写审查文档与证据；全仓审查持续，本批结束不表示全部完成。

| 编号 | 确认问题 | 实际证据与边界 |
| --- | --- | --- |
| HIST-R13-01 | 当前会话刚提交的输入，在 Up 历史导航中排在旧会话后面 | 实际 history helpers/自有临时 JSONL，时间列表与单 session 对照正常；CommandInput 消费静态 |
| HIST-R13-02 | 中断撤销后，原导航器仍返回被撤销输入 | 实际 add/flush/remove/navigator，fresh/refresh 对照恢复；组件 useRef/普通 Esc 链静态 |

详见 [输入历史](history.md)、[搜索与选择](search.md)、[消息分组](groups.md)、[Git 文本与附加源码检查](git-text.md)。两个历史问题都不表示内容永久丢失、真实界面已运行或所有组件路径都受影响。候选分为：同 tick pending 撤销后的 flush 标记（普通 UI 到达性未证）、搜索 readiness 与 Main trim 长度边界（UI/Main 未执行）、两条 ApplyPatch 文件摘要静态分支（首次 fixture 加载失败后跳过）。Move 摘要仅关联旧 R2-08，不增正式/候选数。

**4 组 clean 首次 guarded shards：66 pass、146 expectations、0 fail/skip**，其中 54 项既有测试、12 项新增刻画/对照。另有 **1 组首次加载失败：0 pass、1 fail、1 error**；7 个预定测试体均未执行，未修 fixture、未重跑或替代验证。该失败单独保留，不纳入 clean 成功总数。通过的刻画测试包括错误行为断言，不代表已修复。

所有首轮 combined stdout/stderr 与退出码都先保存后检查，共 5 份 raw logs。[validation](validation.json) 明列各自的命令、日志/exit、执行边界与失败方向。历史模块在首次动态 import 前仅 mock `node:os.homedir()` 到自有临时目录，真实 fs/nextTick 未替换，未重设 HOME/home/CODEX_HOME，也未访问实际用户历史。

各方向全历史查重均覆盖 prior docs/bugs **1,075 Markdown + 641 JSON = 1,716 文件**，包含 archive/_archive、排除本轮，解析错误 0。Root/Search 统计 171,493 JSON 字符串叶，History/Groups 统计 240,534 scalar leaves；口径不同，不混称同一叶数。Git A03/A04、旧模型分组 DD6-04 的失败路线等已排除，未通过新 fixture 恢复旧失败方向。

[findings](findings.json)、[candidates](candidates.json)、[related](related.json)、[source pins](source-manifest.json)、[worker integrity](worker-integrity.json) 和 [evidence index](evidence-index.json) 汇总材料；[assembler](evidence/assemble-audit.py) 只处理元数据，不执行产品或测试。只读交叉复核及 root 最终 QC 同样归档。不存在的 metadata 参考与 raw-log 猜名诊断明确转录，随后按已有 receipt 指针读实际日志；不把这种元数据定位更正称为失败产品方向的恢复。

未执行 React/Ink/Electron/DOM、真实终端/TTY/PTY、实际 Main/IPC、真实工具/Git producer/applier、模型/收费 API/账号/用户数据/外部消息/真实自动化/权限安全custody实验，未构建共享 dependencies/dist，也不声称完整 build/typecheck/lint/suite 通过。补充 transcript 模块只读源码和部分测试源，读取截断及 i18n 未执行的限制已单列。

工作分支 `codex/audit/search-groups-history-round13-20261017` 只整合本目录。[整合前核验](evidence/integration-plan.json) 记录已完成末尾 fetch，current main 仍等于冻结源；69 个 selected source pins 当前字节一致，40 个 worker artifact hashes 已核对。主工作区原有 tracked deletion 与四个 untracked 文件的状态、字节/hash 与开审快照一致；整合只允许本目录的 disjoint fast-forward，前后继续核对。持续审查仍需当前独占 worktree，保留使用。
