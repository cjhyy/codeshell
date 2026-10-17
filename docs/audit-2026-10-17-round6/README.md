# CodeShell 第六批审查记录

本批新增确认 **0 项**；保留 **3 个未确认静态候选**。用户要求持续找 bug，本批只是阶段记录，全仓审查仍在继续。有限范围未找到反例不能证明模块或仓库没有 bug。

冻结源码：`cef9ff76167d33a6a6e5b4464ba5313f7fd35f79`。全部首次测试在该基线上运行；随后接入并行任务已合入的 `main`，详见 [integration-context.md](integration-context.md)。本批仅新增审查文档、保留 fixture 和证据，没有产品修复。

| 范围 | 报告 | 本批结论 |
| --- | --- | --- |
| Task/Todo 快照、guard 元数据与展示消费者 | [tasks.md](tasks.md) | 0 确认；3 干净分片、13 tests / 280 expect，含 2 项既有 TUI 测试 |
| Skill/Agent 普通元数据解析与发现 | [skills-agents.md](skills-agents.md) | 0 确认；分隔符与 CRLF 两个静态候选因首次 fixture 依赖失败而 SKIP |
| Desktop 日志、设置搜索、列表/模型显示 | [desktop-display.md](desktop-display.md) | 0 确认；两个既有组件分片 12 / 71；纯投影 fixture import 失败单列 |
| 包边界、临时构建与发布元数据 | [root-package.md](root-package.md) | 0 确认；既有基线 17 / 123；watch 入口差异仅静态候选 |

共 **8 次首次分片尝试**：**6 个干净分片，42 pass / 474 expect / 0 fail / 0 skip**。42 项由 31 项现有基线和 11 项新增 Task 合同测试组成。参数循环的样本不额外计为测试。另 **2 个 fixture 导入失败分片**，原始日志与 exit 完整保留，未修复、未重试、未换方法。Skill 失败分片内另有 13 pass / 26 expect，不并入干净结果。SKIP 是审查方向处置，不能冒充 Bun 的 test skip。

机器索引：[确认发现](findings.json)、[静态候选](candidates.json)、[验证计数](validation.json)、[冻结源码清单](source-manifest.json)、[最终证据哈希](evidence-index.json)。去重、排除项和实际证据边界保留在各分报告中。三份交叉复核只读文档/源码/日志，没有新增产品测试。

本批使用纯转换、fake client、MiniDOM 与自有临时目录。构建脚本只在临时 fake TUI fixture 中运行逐字副本，共享 `dist` 未构建。没有真实模型、付费 API、用户数据、真实发布、账户、native 应用或平台/权限/安全实验；没有全仓 build/typecheck/lint/test 或干净安装验证。旧失败方向继续跳过。独立的 `codeshell-panel-apps` 仓库未在此批做全仓审查。
