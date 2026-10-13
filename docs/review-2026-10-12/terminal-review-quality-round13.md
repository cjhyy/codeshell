# 第十三轮独立只读复核：Review 首提交空 diff

结论：**保留 P3。** 生产提交菜单确实可以选择无父提交；服务端拼出的父提交 range 无效，却由 legacy helper 把 Git 错误转为空串，最终 viewer 误显示 no changes。未发现身份门禁或菜单限制能够排除此例。影响是特定历史提交的审查内容缺失、且失败伪装为空改动，不是提交或文件丢失。

本复核没有启动任何新测试、服务器、模型或网络实验；只读 a66f 冻结源码、最终便携 fixture、两基线的既有日志，并用只读 git diff --stat 检查相关源码是否变化。**新增运行文件/测试/断言计数均为 0；下述 1 测试/15 断言属于 root 已执行的同一份证据，不能重复累加。** 未修改产品或主报告。

## 用户可达性

`packages/desktop/src/renderer/panels/ReviewPanel.tsx:64–79` 打开提交子菜单时请求 `getReviewRecentCommits(sessionId, 20)`。Main `index.ts:6307–6309` 校验 session ID 后调用真实 ReviewService；`ReviewService.getRecentCommits` 对当前 Session 的权威 workspace 寻找 Git top-level 并读取日志，带回 rootId。`desktop-services.ts:647–670` 使用普通 git log，没有排除无父提交。

`ReviewPanel.tsx:222–255` 直接列出返回的所有 commits，每一项都有 onSelect，设置 selectedCommit 并切到 committed scope；没有 parent 数量或 root-commit 禁用条件。`:151–160` 生成 `{kind:"committed",rootId,commitHash}`，`:313–318` 交给 UnifiedDiffViewer，preload/Main 走 `review:diff`。

所以范围限定为 root commit 出现在当前仓库最近 20 个日志结果中的正常用户菜单入口，最简单场景是一个或少量提交的新仓库；不能声称 UI 提供了任意古老提交的选择器。只有一个提交时，默认“最近提交”也失败；增加第二个提交后，仍可在菜单选中原 root commit 并触发同一缺陷。Fixture 使用服务端实际返回的 rootId/hash，未拼造未知 ID 或绕过 workspace 选择检查。

## 因果链

1. `packages/desktop/src/main/review-service.ts:155–159` 对选定提交固定构造 `<hash>^..<hash>`，无具体选择时用 `HEAD~1..HEAD`。无父 root commit 没有 `<hash>^`；Git 不能解析该 range。
2. `packages/desktop/src/main/desktop-services.ts:621–628` 的真实 `getGitRangeDiff` catch 所有失败并返回 `""`。这是既存 best-effort helper 的行为，不应描述成一次未经处理的异常、renderer crash 或错误数据解析。
3. `ReviewService.ts:110–125` 只有抛出的异常才进入 errors。helper 已吞掉错误，因此返回一个合法 repository 对象，diff 空，errors=[]。
4. `packages/desktop/src/renderer/diff/UnifiedDiffViewer.tsx:129–138` 将空 diff 解析为 0 files，`:180–181` 在 files=0 且 errors=0 时显示 no changes。真正失败没有显示 git diff failed。

仅展示改动为空有合理场景，例如空提交；本 fixture 根提交有实际新增内容，并用真实 `git show --format= --root <hash>` 证明含 `+ROOT_COMMIT_REAL_CONTENT`，排除了空提交。第二提交含 `+SECOND_COMMIT_REAL_CONTENT`，真实服务返回并由同一 viewer 正常显示，排除了 fixture 的 Git、授权工作区或 diff 渲染器普遍失效。

## 既有证据与限制

读取的文件均为 `docs/review-2026-10-12/reproductions/terminal-review-round13/review-first-commit.test.tsx` 及同目录 `review-first-commit.test.tsx.log`，分别在：

- 原基线主审查工作区 `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell`：1 pass / 15 expect / 0 fail / 0 skipped，总 2.59 秒。
- 最新冻结工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`：1 pass / 15 expect / 0 fail / 0 skipped，总 1.91 秒。

日志两份均记录 rootCommitListed、实际内容非空、rootReply.repositories[0].diff=""、errors=[]、rootViewer="no changes"、laterCommitVisible=true、explicitSnapshotVisible=true、actualFullMainStarted=false。代码在动态 Main/Core 导入之前安装网络 guard，guarded HOME 必需，Git global/system config 指向 /dev/null；实际 Git 仓库是自行创建的临时目录，afterEach 删除它。仅只读确认这些已执行证据，没有新建或清理实验进程/仓库。

Fixture 跑真实 ReviewService、真实 Git helper、真实 UnifiedDiffViewer React DOM，workspace 解析经 dependency seam 提供合法隔离项目；未启动完整 Electron Main，也未实际点击 Radix 提交子菜单。菜单可选性由上述生产源码直接确认，应维持这一证据边界。`diffText=actualRootDiff` 的控制证明 viewer 可以正常显示已经取得的 root snapshot；它不是用户可以从该菜单调用的恢复按钮。

## 分级、恢复与建议

P3 合理：失败只影响选定的无父提交（和单提交仓库默认最近提交），一般有父提交的 committed review 正常，仓库内容和提交均在。刷新、再次选择相同 root commit 不会修复无父 range；增加第二提交使默认最近提交可用，但原 root commit 的选择仍空，本 fixture 已明确断言。

外部 `git show --root <hash>` 可以检查真实首提交；若该次 Agent turn 原本有保存的 turnDiff snapshot，其既有“本轮改动”通道可正常展示，但不能保证每一个 root commit 都有这种快照，也不应把该测试的手动 diffText 注入称为产品内普遍恢复路径。

建议对根提交使用空树基线或等效的 `git show --root` 获取 committed diff，同时让非“确实无改动”的 Git 执行错误透传到 ReviewService 的 per-repository errors。它与已有 Session/工作区选择问题、审批生命周期或文件丢失项独立。所查 ReviewService/desktop-services/ReviewPanel/UnifiedDiffViewer 在 84740d56→a66f4ef2 的只读 git diff --stat 为空，应写作旧实现本轮新发现。
