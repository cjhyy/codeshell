# Diff 审查面板：任务工作树与审查范围不一致

记录日期：2026-11-10。状态：已复现，待修复；本次只登记问题，不修改审查功能。
优先级：P2。范围：Desktop 的文件改动卡片、审查面板与后台任务交接。

## 实际现象

架构整改实际在独立工作树完成且已经提交，但从原会话打开“审查”时，面板仍按原会话的 main 工作区查询，显示无改动。聊天中的“已编辑 7 个文件，+88/-17”卡片又只代表某次本轮快照，容易被误认为整个任务的交付范围。

本次可定位的状态：

- 原会话工作区：`/Users/admin/Documents/个人学习/代码学习/codeshell`，分支 `main`，当时 HEAD 为 `2d1c0b638`。
- 实际候选工作树：`/Users/admin/Documents/CodeShellBuilds/architecture-review-20261110`，分支 `codex/architecture/direct-candidate-20261110`。
- 审查基线：`fcd8406d51bf34696417dd9dd90c609f1d5ca640`。
- 已审查候选：`51ffc6d7a21009af076cef71f74e972a2d827696`。
- 该固定范围共 7076 个文件：400 个代码、测试、配置、文档文件，另有 6676 个历史审计 evidence 归档后删除。此后新增的本问题记录不计入上述历史数量。
- 候选工作树的未提交 diff 为空；最后一个提交只有文档，因此这两种范围也不能代表完整任务。

这些现象不证明 Git 算错了 diff；已确认的问题是面板没有把任务实际目标与当前查看范围清楚地衔接起来，且本轮卡片的完整性不明确。

## 复现步骤

1. 会话绑定仓库主工作区，保持该 Session 的授权工作区不变。
2. 通过后台 agent 或 Shell 在另一个任务工作树完成多次修改并提交。
3. 返回原会话，从文件改动卡片或审查入口打开面板。
4. 查看“本轮改动”“全部未提交”“最近提交”“分支 vs base”的当前目标与内容。
5. 将面板结果与候选工作树中的固定范围 `git diff fcd8406d5 51ffc6d7a` 对照。

实际结果：默认目标仍可能是原会话仓库；卡片只显示部分工具快照；没有可直接选用完整交付 base/head 的任务入口。用户需要人工找出工作树和提交范围才能正确审查。

## 已确认的范围语义与排查入口

- [ReviewPanel.tsx](../../packages/desktop/src/renderer/panels/ReviewPanel.tsx)：以 Session 绑定的工作区发起 Git 查询；有本轮上下文时默认使用 turn，否则默认全部未提交。committed 只表示所选单个提交；branch 不是“本次任务”的同义词。
- [reviewScope.ts](../../packages/desktop/src/renderer/diff/reviewScope.ts)：范围定义。
- [reviewSnapshot.ts](../../packages/desktop/src/renderer/diff/reviewSnapshot.ts)：本轮快照的选择与分组。
- [turnDiff.ts](../../packages/desktop/src/renderer/messages-reducer/turnDiff.ts)：聊天轮次中的 diff 快照。
- [ReviewPanel.workspace.test.tsx](../../packages/desktop/src/renderer/panels/ReviewPanel.workspace.test.tsx)：已有工作区切换回归测试；修复时在此基础上补充跨任务工作树和交付范围场景。

Shell、后台 agent 与宿主编辑工具是否都有完整、可持久恢复的文件快照，需要继续追踪事件来源；不能把当前 7 文件卡片声称为整个任务的完整审查记录。

## 修复方向与验收标准

- [ ] 面板持续显示实际仓库/工作树、分支、范围类型，以及解析后的 base/head；原会话目标与交付目标不一致时给出明确提示。
- [ ] 后台任务交接携带可信的工作树身份与开始/结束提交，能从交付卡片显式选择“完整任务改动”。
- [ ] 新目标仍须经过现有 Host 工作区与 Session 授权，不允许仅凭结果正文中的任意路径扩张读取权限或自动重绑活动 Session。
- [ ] 卡片区分“本轮快照”“全部未提交”“单个提交”“任务提交范围”；缺少 Shell/后台改动或快照不完整时明确标识。
- [ ] 对已提交且工作区干净的任务，完整任务入口仍展示指定 base/head 的改动；刷新、重开与重启后保持可恢复的目标与范围。
- [ ] 切换目标时清空旧提交选择、文件筛选和统计；旧异步查询不得覆盖新目标。
- [ ] 大量历史工件删除可单独筛选，但始终保留总数、已显示数量和排除说明，不静默截断代码改动。
- [ ] 补回归：原会话 main + 后台独立 worktree；Shell/后台提交；本轮仅部分文件；干净候选；最后一个提交仅文档；未授权目标；目标切换竞态；大批量工件删除。

临时使用方式：在已授权的候选工作树选择正确的 base/head，或查看固定范围导出的 diff。不要把原会话的空未提交列表当作任务没有改动。
