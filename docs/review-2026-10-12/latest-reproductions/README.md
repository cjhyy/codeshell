# 新快照专项复现

此目录针对 `a66f4ef291f304ee4df9da8095a90671d9a8f140`（0.9.33）及兼容后继，包含旧基线尚无的新功能。与 `reproductions/` 的初始基线脚本分开运行。

在独立的新快照 checkout 安装冻结依赖、完成工作区与 Desktop 构建，将本报告目录复制到相同位置后运行：

```sh
node docs/review-2026-10-12/run-latest-reproductions.mjs
```

当前已备好新快照工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`；请在该目录运行。入口会检查 Git ancestry，并逐文件使用 guarded runner，原始报告 checkout 不会执行不适用的新功能测试。结果写 `validation/latest-reproduction-results.json`，日志在脚本旁。

脚本包含缺陷表征和正常恢复对照；通过表示观察成立，不表示已修复。不调用真实付费模型；原件、Cookie、转写等 fixture 都应使用虚构隔离数据。每个附录描述其模拟范围。
