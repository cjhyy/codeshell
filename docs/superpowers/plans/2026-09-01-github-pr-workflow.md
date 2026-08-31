# GitHub / Pull Request 工作流 Implementation Plan

> 设计来源：`docs/superpowers/specs/2026-09-01-github-pr-workflow-design.md`
> 依赖：现有 ReviewService、GitHub Link/CredentialStore、Session workspace/worktree 绑定
> 范围：GitHub.com；不含托管云、GitLab、无人确认的远端写操作

**Goal:** 将 PR 解析、隔离 checkout、本地 Review、checks、行内评论、review 与受控 merge 串成完整流程。

## P1 — URL、数据 schema 与 API 只读客户端

**Files:**
- Create: `packages/desktop/src/main/pull-request/pull-request-url.ts`
- Create: `github-pr-client.ts`, `pull-request-types.ts`
- Test: 同目录单测

- [ ] 严格解析 GitHub PR URL；覆盖 host/port/credential/encoded traversal/边界长度。
- [ ] 复用 Link connection/credential 执行句柄，token 不出 main。
- [ ] 实现 PR 元数据、files、reviews/comments、permission、checks 的 bounded 请求和分页。
- [ ] schema 过滤未知/超长字段；超时、限流和 partial error 结构化。

## P2 — managed review workspace

**Files:**
- Create: `pull-request-workspace.ts` + tests
- Modify: Session workspace service（只增加显式 PR context 绑定 seam）

- [ ] remote 精确匹配 owner/repo，歧义时要求用户选择而不是猜。
- [ ] 通过参数数组 fetch 精确 base/head SHA，默认建立 managed worktree。
- [ ] dirty 当前 checkout 不被修改；路径 containment 和 symlink 测试。
- [ ] restart 后验证 worktree/HEAD；存在未提交改动时拒绝自动清理。
- [ ] fork PR 只读 checkout 测试。

## P3 — ReviewService 的 PR scope

**Files:**
- Modify: `review-service.ts`, shared review types, preload
- Modify: `ReviewPanel.tsx`, `reviewScope.ts`
- Test: main + renderer tests

- [ ] 新增 `pull-request` scope，只接受 main 登记的 `contextId`。
- [ ] diff 固定为登记的 `baseSha...headSha`，renderer 无法注入任意 range/path。
- [ ] 显示 PR 标题、编号、head/base、作者与 `+/-` 统计。
- [ ] 大 diff/二进制/重命名降级显示，保持现有 working/branch scope 不回归。

## P4 — context 与 draft 持久化

**Files:**
- Create: `pull-request-review-store.ts` + tests

- [ ] 持久 context、draft comment、review body、提交 receipt；原子写、`0600`、bounded。
- [ ] comment locator 来自 parsed hunk，不能输入任意路径/行号。
- [ ] 跨重启恢复；损坏隔离、原字节不覆盖。
- [ ] 记录 head SHA 和 request hash，为不确定网络结果提供查重依据。

## P5 — PR 页面与 checks

**Files:**
- Create: `packages/desktop/src/renderer/pull-request/*`
- Modify: PageRegistry/navigation/i18n

- [ ] PR 选择/URL 输入、账户标签、workspace 创建进度与错误恢复。
- [ ] ReviewPanel 旁展示 checks、review threads、draft drawer。
- [ ] 手动刷新和低频状态刷新；窗口隐藏时停止轮询。
- [ ] `head_changed` 时禁用旧 draft 提交并引导重新定位。
- [ ] 首切片只读 flag 下没有任何远端写入口。

## P6 — 行内评论与 review 提交

**Files:**
- Modify: `UnifiedDiffViewer`（draft anchor seam）
- Create: `pull-request-service.ts`, IPC/preload API
- Test: locator、确认、幂等、partial failure

- [ ] 在 diff 行上创建/编辑/删除本地 draft。
- [ ] 提交前重新读取 head SHA、account、permission，并使旧确认失效。
- [ ] 预览 `COMMENT | APPROVE | REQUEST_CHANGES` 与所有评论正文。
- [ ] 一次 API 创建 review；不确定结果先查远端 receipt，再决定重发。
- [ ] 同一确认重复点击/应用重启不产生重复评论。

## P7 — 受控 merge

**Files:**
- Extend: `github-pr-client.ts`, `pull-request-service.ts`, renderer
- Test: gate matrix + expected SHA

- [ ] 仅 open、非 draft、权限足够、head 未变且无阻塞 checks 时开放。
- [ ] merge/squash/rebase 选择和二次确认。
- [ ] API 请求携带 expected head SHA；409/405/权限错误结构化显示。
- [ ] 只有远端确认 merged 后更新 context；不自动删除有改动的 worktree。

## P8 — 恢复、真机与发布门禁

- [ ] GitHub Link token 与 `gh` backend 各跑一次只读验收。
- [ ] 公共仓库 PR、私有仓库 PR、fork PR、head force-push、checks failure 场景。
- [ ] 断网提交 review → 重启 → 远端查重 → 无重复评论。
- [ ] macOS/Windows/Linux git worktree 路径测试。
- [ ] 依次灰度 `prReviewReadV1`、`prReviewWriteV1`、`prMergeV1`。
- [ ] desktop typecheck/build、相关测试和全仓门禁全绿。

## Definition of Done

- [ ] 用户能从 PR URL 到隔离本地 diff，不污染当前 checkout。
- [ ] 评论/review/merge 全部 main 权威、可确认、可恢复、可去重。
- [ ] head/权限/checks 变化会阻止陈旧写操作。
- [ ] feature flag 可独立回滚读取、review 写入和 merge 三层能力。
