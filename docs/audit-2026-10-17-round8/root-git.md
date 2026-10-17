# Root：Git 普通解析与 worktree 摘要

冻结源码 `ec0e16bf0068a458abcbaa28225a4c764c24f4de`。新增确认 **1 项 P3**；仅修改审查记录和 fixture。

## GIT-R8-01 — P3：带引号路径在 committed/dirty 集合中形成两个身份，文件数重复

位置：`packages/coding/src/git/worktree/diff.ts:61` 对两个来源取 union；`:70–78` 的 committed 路径保留 Git 外层引号，`:87–105` 的 dirty 路径则尝试 JSON 解码或剥掉引号。两者不在同一个规范化空间。函数公开合同在 `:7` 明确要求 unique files changed，不能把同一文件的两种字符串形态算两项。

正常触发：同一个 `中文.txt` 在 base→HEAD 已有提交修改，同时工作区又修改它；Git 默认 quotePath 把 UTF-8 路径输出为带引号的 C 八进制表示。或在支持双引号文件名的平台上，同一个 `quote"name.txt` 同时有 committed/dirty 变化。预期均为 changedFiles=1；真实摘要函数分别返回 2。普通 ASCII 同文件对照为 1，两个不同普通文件对照为 2，aheadCommits/dirty 标志不受本例影响。

动态证据：[root-git-diff-quoted.test.ts](evidence/root-git-diff-quoted.test.ts) 调用真实 `getWorktreeDiff`，只把 `gitOutput` 模块替换为内存返回值，并对 child_process 安装 throwing guard。全部四项断言确认 native 调用计数为 0。[首次日志](evidence/root-git-diff-quoted.first.log)、[exit](evidence/root-git-diff-quoted.first.exit.txt)、[receipt](evidence/root-git-diff-quoted.receipt.json)：**4 pass / 12 expect / exit0 / Completed**。绿色断言观察当前错误计数，不是修复。

输入格式依据：[Git diff 官方 `-z` 文档](https://git-scm.com/docs/git-diff) 说明未使用 NUL 输出时 unusual 路径会被引用；[core.quotePath](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corequotePath) 说明默认 true、UTF-8 高字节按 C 八进制转义，双引号无论配置都转义。fixture 据此构造规范格式；没有启动真实 Git 捕获输出、创建仓库、提交、删除或操作 worktree。没有声称实际 Windows 双引号文件名合法或已跨平台验证。

直接消费者 `packages/coding/src/git/worktree/query.ts:173–177` 在 `includeDiffSummary` 时附加该摘要，是静态传播。另一个猜测的 Desktop caller 导航路径不存在，已 [记录并跳过](evidence/root-navigation-skip.md)。本项仅确认公开摘要数据多计文件，不声称主界面已渲染错误、删除判断受影响、权限或安全影响。建议对两个来源统一使用 NUL 路径和同一解码规则后取唯一集合。

## 去重与正常基线

[root-git-dedup.json](evidence/root-git-dedup.json) 对冻结 HEAD 的 docs/bugs 中 1,486 份 `.md/.json/.txt` 保存字节/SHA，解析 JSON 字符串叶子与 Markdown 行，0 JSON parse errors。A03（status 首行 trim）、A04（commit subject 的竖线）、A05/A06（/commit 终态/暂存范围）均为已有记录；未重复计数或运行旧 fixture。当前 log pipe 线索明确由 October 16 A04 与 May 30 记录排除。

[root-git-diff-dedup.json](evidence/root-git-diff-dedup.json) 在同一语料补查 changedFiles/quote/重复和 unquoteGitPath，只命中与 Desktop Review/外部 CLI 元数据有关的旧说明，未找到本 union 两种路径身份的同根因项。语法/词项检索不证明所有历史语义穷尽。

独立现有纯基线 `packages/coding/src/git/parse-log.test.ts`、`worktree/slug.test.ts` 首次 guarded 分片通过：**8 pass / 17 expect / 0 fail/skip / Completed**；[raw](evidence/root-git-pure-baseline.first.log)、[exit](evidence/root-git-pure-baseline.first.exit.txt)、[receipt](evidence/root-git-pure-baseline.receipt.json)。只测试解析/字符串前缀，未调用 Git 产品命令或重现旧 A04。Root 合计两个干净分片 **12 tests / 29 expect**。

只读查看了 Git utils、parse-log、slug、worktree diff/query 与所选既有测试、TUI `/commit` caller 段落。未执行工作树生命周期/native/真实 CLI/模型/网络/用户数据，未改产品，未做全仓 build/typecheck/lint/test。
