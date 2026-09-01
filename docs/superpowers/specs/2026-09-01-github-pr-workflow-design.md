# GitHub / Pull Request 工作流 PRD / 设计稿

> 日期：2026-09-01
> 状态：设计完成，待按独立实施计划开发
> 范围：GitHub.com PR；本地 checkout + Review 面板 + GitHub 写回
> 不含：托管云执行、GitLab、自动 merge、无人确认的远端写操作

## 1. 背景

CodeShell 已具备两块基础能力：

- Review 面板能根据 Session 的权威 workspace 展示 working、commit、branch diff；
- GitHub Link 能验证账户并列出/读取 PR，连接层同时支持 token/`gh` CLI。

目前二者没有形成工作流。用户要手动找 PR、手动 checkout、回到 Review 面板，再到浏览器逐条评论和查看 checks。目标是把这些已有能力串成一条可审计、可确认的本地 PR review 流程。

## 2. 方案推演（brainstorming）

### 方案 A：renderer 直接调 GitHub API 和 git

实现快，但凭据、路径、命令和远端写操作暴露到 renderer，违背现有 main 权威边界，否决。

### 方案 B：把 PR diff 直接从 API 渲染，不 checkout

适合轻量阅读，但无法复用本地语义审查、测试、代码导航和 workspace 隔离；大 diff API 还会截断。可作为降级预览，不作为主流程。

### 方案 C：main 编排 PR workspace，复用 Review 面板（采用）

主进程解析 PR → 校验 GitHub 身份/权限 → fetch 精确 head SHA → 建立独立 worktree/Session workspace → Review 面板按 `base...head` 加载 → 评论/checks/review 通过专用 GitHub service 写回。

## 3. 产品目标

1. 从 GitHub Link 中选择或粘贴 PR URL，一步建立隔离本地 review workspace。
2. Review 面板显示 PR 元数据、文件 diff、checks 和 review threads。
3. 用户可创建 pending 行内评论，统一预览后提交 `COMMENT`、`APPROVE` 或 `REQUEST_CHANGES`。
4. 每个远端写操作都有明确确认、幂等键和可见结果。
5. 可选 merge 只在 checks/权限/分支状态满足且用户再次确认时开放。

### 非目标

- 不自动修复、自动 approve 或自动 merge。
- 不在 dirty 当前 checkout 上强制切分支。
- 不执行 fork PR 的不可信代码；运行测试是独立、明确授权的本地动作。
- 不保存 GitHub token 到新 store，复用 Credential/Link 层。
- 首版不支持 GitLab/Merge Request。

## 4. 核心用户流程

### 4.1 打开 PR

1. 用户选择 GitHub 连接，粘贴 `https://github.com/<owner>/<repo>/pull/<number>` 或从列表选 PR。
2. main 获取 PR、base/head SHA、仓库权限、mergeability 和 checks 摘要。
3. 若本地项目 remote 与 owner/repo 匹配，复用该 repo；否则要求用户选择已保存项目或 clone 位置。
4. fetch 精确 SHA，不信任 PR branch 名作为命令参数。
5. 在 CodeShell worktree 根创建隔离 checkout，并绑定一个 review Session。
6. 打开 Review 面板的 `pull-request` scope。

### 4.2 审查与评论

- 文件和 hunk 仍由现有 `UnifiedDiffViewer` 展示。
- 用户点击新增行内评论，评论先进入本地 draft，不立即发网。
- Review drawer 汇总所有 draft、普通总结和最终事件。
- 提交前展示：仓库、PR、head SHA、事件、评论数量与正文预览；用户确认后批量创建 review。

### 4.3 checks 与 merge

- 展示 latest check suites/runs 的 `queued | in_progress | success | failure | cancelled | neutral`。
- 支持手动刷新；不做高频轮询。
- Merge 按钮必须满足：PR open、非 draft、当前 head SHA 未变化、无阻塞 checks、API 报告有 merge 权限。
- Merge 使用 GitHub API 的 expected head SHA；用户选择 merge/squash/rebase 并二次确认。

## 5. 架构

新增主进程模块 `packages/desktop/src/main/pull-request/`：

- `github-pr-client.ts`：通过 Link credential/backend 读取 PR、files、threads、checks，提交 review/merge；
- `pull-request-url.ts`：严格 URL parser；
- `pull-request-workspace.ts`：remote 匹配、fetch SHA、worktree/session 绑定与清理；
- `pull-request-review-store.ts`：本地 draft 与已提交 receipt；
- `pull-request-service.ts`：状态机与 IPC facade。

renderer 新增 `pull-request` 页面/侧栏，但 diff 核心继续复用 `ReviewPanel` / `UnifiedDiffViewer`。ReviewService 增加受约束的 PR range：只接受 main 已登记的 review context id，不接受 renderer 传任意 git range。

### 状态模型

```ts
type PullRequestReviewState =
  | "resolving"
  | "fetching"
  | "ready"
  | "head_changed"
  | "submitting"
  | "submitted"
  | "merged"
  | "closed"
  | "failed";

interface PullRequestContextV1 {
  contextId: string;
  provider: "github";
  owner: string;
  repo: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  repoRoot: string;
  worktreePath: string;
  sessionId: string;
  connectionId: string;
  state: PullRequestReviewState;
  updatedAt: number;
}
```

## 6. GitHub API 能力

首版读取：

- `GET /repos/{owner}/{repo}/pulls/{pull_number}`；
- PR files/commits；
- issue comments 与 pull review comments/reviews；
- commit check-runs/status；
- authenticated repo permission。

首版写入：

- `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`，一次提交 body/event/comments；
- 可选 reply/resolve 后续切片；
- `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`，携带预期 `sha`。

所有 write action 标记为 high-risk，走现有审批/确认约定。HTTP 响应有严格大小上限、超时、分页上限和 schema 过滤。

## 7. 行内评论定位

GitHub 行内评论使用 `path + line + side`，必要时使用 `start_line/start_side`。UI 从 parsed diff hunk 生成 locator，不允许用户输入任意路径。

提交前重新读取 PR head SHA：

- 未变化：提交；
- 已变化：进入 `head_changed`，旧 draft 保留但标记需重新定位；
- 某行不再存在：该评论降级为普通 review body 或要求用户修正，不能静默贴错行。

Draft key 为 `contextId:path:side:line[:startLine]`。提交 receipt 记录 GitHub review id、head SHA 和请求摘要 hash，跨重试去重。网络结果不确定时先查询已存在 review，再决定是否重发。

## 8. workspace 与 git 安全

- URL 仅允许 `https://github.com/<owner>/<repo>/pull/<positive-int>`，拒绝凭据、端口、编码越界和额外控制字符。
- 所有 git 调用使用参数数组，不经过 shell。
- fetch 使用配置好的 remote URL 和精确 SHA；分支标题/用户名只作展示。
- 不修改 dirty 主 checkout；默认创建 CodeShell 管理的独立 worktree。
- worktree 路径由主进程生成并做 realpath containment；renderer 不能指定绝对路径。
- fork PR 默认只读 checkout。执行测试、写文件、push 都是现有 Session 权限模型中的独立动作。
- 清理只删除已登记的 managed worktree；存在未提交改动时拒绝自动清理。

## 9. 身份、权限与确认

- 连接来自现有 GitHub Link/CredentialStore；PR service 只拿短生命周期执行句柄，不把 token 返回 renderer。
- 读取可直接执行；评论、review、merge 每次都需要可见确认。
- `APPROVE` 自己创建的 PR 时，GitHub 拒绝信息原样结构化显示。
- 提交时显示当前 GitHub account label，避免多账户误发。
- head SHA 变化、权限变化、checks 变化都会使旧确认失效。

## 10. 错误与恢复

- fetch/checkout 失败不改变当前工作区；可重试同 context。
- API 限流显示 reset/重试信息，不无限自动重试。
- 应用重启后从本地 context/draft store 恢复，重新验证 worktree、connection 和 head SHA。
- GitHub 不可用时，本地 diff 和 draft 仍可读，远端动作禁用。
- 提交 review 部分失败时保留未确认 receipt，重查远端后收敛。

## 11. 验收标准

- PR URL parser 覆盖合法 URL、encoded dot、凭据、端口、超长、非 GitHub host。
- dirty 主 checkout 不被切换；PR 在 managed worktree 中打开。
- Review 面板显示精确 `baseSha...headSha`，而不是本地猜测的默认分支范围。
- 同一 draft/review 重试不会产生重复远端评论。
- head SHA 改变后禁止旧行评论和 merge，用户刷新后才能继续。
- checks、权限和账户身份在最终确认界面可见。
- merge 必须二次确认并携带 expected SHA；失败不会把本地 context 标为 merged。
- 断网/限流/重启均不丢本地 draft。

## 12. 发布顺序

先发布只读 PR open + diff + checks；第二切片发布 draft 和 review submission；第三切片才开放 merge。每个切片由独立 feature flag 控制，默认禁用下一切片的写能力。
