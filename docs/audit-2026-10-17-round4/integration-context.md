# 并发 main 变化与整合边界

本批审查与所有首次测试冻结于 `4ee32f28f78b8315112cca77cfc22b2f2f80ced6`。开始时本地 main 与此相同，origin/main 为其祖先 `02d5d9a9ecbbb206d5f3d8a1d367e7081d937101`，因此从已包含最新 origin/main 的 main 建独立任务分支。

整合前刷新 origin 成功，origin/main 仍是 `02d5d9a9e`；另一个并发任务已将本地 main 推进至 `51761b53399cc5daa1823d60b6cfdf52b1237ebe`（包含 `c938007c2 fix(core): exclude auxiliary calls from cache hit rates`，30 个文件）。这是其他任务的产品变更，本审查没有重写、撤销或重新归属它们。

主审静态比较 `4ee32f28f..51761b533`：本批缺陷直接实现所在 context/compaction、context/manager、settings、Coding LSP、logging、Config builtin、protocol/server 与 TUI commands **没有变化**。相关大调用方 Engine/TurnLoop/types 有 cache usage 记账和类型字段更新；已查看完整相关 diff，没有改动本文依赖的 summary/snipping、toolResultToBlock、manage→model 顺序、forceCompact 或 updateConfig writer 接线。

所有首次 raw 测试仍只证明原冻结源码。没有对新 main 重跑，不把静态差异核验写成第二组动态门禁。报告行号、分审 source receipt 和主 source-manifest SHA 继续指向冻结 Git blob；主 manifest 另列当前 worktree 是否相同，避免假称旧 SHA 代表新调用方全文。直接缺陷实现未变化也不代表其他并发产品变更已被本轮全面审查。

主目录预存 `bugs/2026-07-13-repo-audit.md` 删除、`.mimi-download-cli/` 与 `docs/todo/browser-panel-runtime-design.md` 未跟踪内容，均在首次保存 status、tracked diff 与文件 SHA；发现并发 main 更新时再次核对一致。本审查只整合 `docs/audit-2026-10-17-round4/` 自有路径，通过正常任务分支流程合入；不会推远端或清理仍在使用的持续审查 worktree。
