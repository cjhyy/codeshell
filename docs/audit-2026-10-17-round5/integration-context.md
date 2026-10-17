# 冻结证据与并发 main

本批所有首次产品测试冻结于 `9a421b3e65d5bfe662b78062cb86bd99483a683a`。开始时本地 main 相同，origin/main 是其祖先。沿用本聊天干净独立 worktree，在 `codex/audit/prompt-profile-web-round5-20261017` 工作；本任务只新增第五批审查目录。

整合前另一任务已将本地 main 推进到 `dee38295a5e5ea554c69104207d604d8f83637e9`，其中 `eb3561a7e` 保存后台续跑加载工具的选择。差异涉及 Engine/run-tooling/tool surface/preset task routing、SessionManager/types 与对应测试。主审已查看完整 Engine/run-tooling/SessionManager/types/task-routing diff。

本批直接缺陷实现（Prompt instruction-scanner、Profile catalog/catalog-store、Chat LINE 与 Web streamReducer）均未变。变化不修改当前所依赖的 PromptComposer 实例/扫描接线、Agent后台 detail 转发、Profile目录映射和 reader/remover、Mimi/LINE投影或 Web全局run分支。`task-tool-routing.ts` 的 markup normalization 属于其他任务修复，不是本轮新 finding，也没有把它作为当前 Prompt顺序实验的动态证据。

整合时正常吸收 main，并继续保留冻结 source SHA/行号和首跑日志；主 manifest 单列当前文件是否仍等于冻结 blob。没有对新 main 重跑本批测试，不假称另一任务产品变更已被本批全面审查。

主目录原有删除/未跟踪内容通过 status、tracked diff 和4个文件 SHA 在整合前后核对；只整合本任务审查路径。没有推远端、改产品或清理持续审查中的 worktree。
