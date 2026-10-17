# 基线与集成上下文

本批使用已附加且由 root 独占的工作区 `/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell`。开始时确认工作区干净、读取当前 CODESHELL 分支与 guarded 测试规则、检查 worktree 清单并成功 fetch origin。新分支 `codex/audit/files-provider-tui-round7-20261017` 从最新 `origin/main` 创建，再通过 fast-forward 接入包含前批审查的本地 `main`，冻结为 `1b04838474bcd57212f80f791d0e268a00d347e3`。

所有首次产品测试只在该基线上执行。结束阶段再次 fetch origin 成功；如 main 在最终合入前发生变化，保留首次基线并另行检查差异，不能把旧测试宣称为新主线重跑。源码索引 SHA 取冻结 Git blob，当前文件一致性另列；安装 SDK 的逻辑路径/实际共享路径和哈希属于独立运行时依赖收据，不声称在冻结 Git 中逐字保存。

主工作区既有 `bugs/2026-07-13-repo-audit.md` 删除、`.mimi-download-cli/` 与 `docs/todo/browser-panel-runtime-design.md` 未跟踪内容。在 [integration-before.json](evidence/integration-before.json) 保存 porcelain、tracked diff SHA 及 4 个常规未跟踪文件的字节数/SHA。root 只提交本轮目录，并在最终 fast-forward 前后再次比较这些状态。外部最终 receipt 为 `/tmp/codeshell-audit-20261017-round7-integration.json`；没有 stash/reset、push 或修改其他任务文件。
