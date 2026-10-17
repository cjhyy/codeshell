# 冻结基线与并行主线

开始时确认已附加独占 worktree 干净、主工作区原有 dirty 状态，检查 worktree 清单并成功 fetch origin。分支 `codex/audit/questions-plugins-display-round8-20261017` 从最新 origin/main 创建，再 fast-forward 接入本地 main；首次审查和测试基线冻结为 `ec0e16bf0068a458abcbaa28225a4c764c24f4de`。CODESHELL/AGENTS 在期间没有变动。

期间 main 前进至 `34553b747f9a5b6acafe7ad1dd21905bcfa53cac`，与冻结基线相比有 81 个文件变动，主要为打包/操作验收脚本、当前浏览器回归、Desktop 注释/上下文选择/偏好/Review、更新器与 Web Host 路径策略。root 检查清单和与本批直接相关的数据差异，没有执行这些并行任务的 native/浏览器脚本，也不把本批绿色基线当作它们的验收。

`658b8c6fcdad0e9d4bfe8809c5adf6f95f19580d` 的 format.ts 改为在 base 已以 `/` 结尾时直接使用 base，静态消除了 WEB-R8-01 的双分隔符。保留原冻结复现并单列“并行 main 源级已修复，runtimeRetested=false”。另外五项直接 finding 源码未变；没有将此源码一致性写成在新 main 重新验证其运行行为。

Workers 完成首次收据后，root 再次 fetch origin 成功，并 `git merge --ff-only --no-stat main` 接入上述主线。没有重跑错误行为断言、改动首次 fixture 或日志。worker source receipt 表示生成时状态；最终根 source manifest 的 SHA 取冻结 Git blob，当前文件一致性另列，不能因为主线前进而重写测试基线。

主工作区原有 tracked 删除和未跟踪内容的 porcelain、tracked diff SHA、4 个常规文件字节数/SHA 保存在 [integration-before.json](evidence/integration-before.json)。后续检测到额外 `.github/workflows/desktop-ui-acceptance.yml` 工作区修改；不是本审查产生，不归入本轮提交。另存 [最终集成前快照](evidence/integration-before-final.json)，包含当前 tracked/staged diff SHA/porcelain，原始四个未跟踪文件仍逐字一致。只提交本轮目录，最终 fast-forward 前后比较这一最新快照和材料哈希；不能把其他写入者中途产生的 CI 修改描述成原始 tracked diff 从头到尾未变。外部 receipt 为 `/tmp/codeshell-audit-20261017-round8-integration.json`。没有 stash/reset、push 或改动其他任务文件。
