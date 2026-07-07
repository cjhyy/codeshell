# Worktree 优化设计（性能 / 结构 / UI）

日期：2026-07-07
分支：`test/worktree-demo`
状态：设计已确认，待写实现计划

## 背景与问题

CodeShell 的 session 级 worktree 功能（per-session 绑定、cwd 自动跟随、三态清理）当前有三类问题：

1. **性能卡顿**：桌面端切换器（`WorkspaceIndicator`）一打开就同步等待每个 worktree 的完整 git diff（`listWorktrees(includeDiffSummary:true)` 对每个 worktree 跑 `git status` + `git diff` + `rev-list`），点击后列表要等一下才出现。
2. **报错弹窗**：`refreshList` 的 catch 无条件 `reportError`，包含被取消/卸载的请求，导致误报错弹窗。
3. **结构混杂**：`packages/core/src/git/worktree.ts`（552 行）混了 7 类职责：slug 校验、git-exec 封装、create、remove、list、diff、symlink。
4. **重复计算**：`switchSessionWorkspaceForUi` / `cleanupSessionWorktreeForUi` 结尾各自重跑一次完整 list+diff；`session-workspace-service.ts` 每次 IPC 调用都 `new SessionManager()`。

## 竞品对照结论（Codex / Claude Code / OpenCode）

三家共识（2025-2026）：
- **列表元数据即时渲染，diff 异步填充**，绝不阻塞导航。
- **diff 懒加载**，不 eager 计算所有 worktree。
- **分支命名可预测前缀**（`worktree-<name>` / `opencode/<name>`）+ 区分受管 vs 外部。
- **清理两阶段**：干净可自动，脏的/未推送的必须显式确认。

Claude/Codex/OpenCode 偏「只认自己建的」，代价是手动/外部 worktree 不可见（OpenCode 有相关 issue）。Codex 研究推荐的是**中间路线**：全部发现，但区分受管/外部，外部限制危险操作。

## 决策

- **性能方案 A｜纯懒加载**：先出列表后异步填 diff（用户确认）。
- **分支前缀设置页可配置**：默认 `worktree/`，用户可改（用户确认）。
- **可见性中间路线**：全显示，外部/detached 标「外部」徽章、可切换但禁用清理（用户确认）。
- 不引入 diff 缓存（作为后续增量，避免缓存失效复杂度）。

## 架构：后端模块拆分

将 `packages/core/src/git/worktree.ts`（552 行）拆成目录 + barrel，对外导出不变（下游 import 不动）：

```
git/
  worktree/
    index.ts       # barrel，re-export 全部公共 API（兼容现有 import 路径）
    git-exec.ts    # execGit / gitOutput / gitErrorMessage / GIT_BIN / normalizeBranchName
    slug.ts        # validateWorktreeSlug + 分支名生成（applyPrefix）
    crud.ts        # createWorktree / removeWorktree / runWorktreeSetup / symlinkLargeDirectories
    query.ts       # findGitRoot / findMainWorktreeRoot / listWorktreesFast / owners /
                   # branchExists / isGitWorktreeRoot / currentBranch
    diff.ts        # getWorktreeDiff(单个) / worktreeHasUncommittedChanges /
                   # worktreeHasUncommittedOrAheadChanges / findComparisonBaseRef
```

**单元职责与边界**：
- `git-exec`：唯一封装 `execFile(git)` 的地方；其它模块只调它，不直接 spawn git。依赖：node child_process。
- `slug`：纯函数校验 + 前缀应用（`applyPrefix(prefix, slug, sid)` → 分支名）。无 IO。
- `query`：只读发现，不碰 diff。`listWorktreesFast` 只跑 `worktree list --porcelain` + owners 归属 + isMain/isManaged 标记。
- `diff`：单 worktree 的 diff/dirty/ahead。供 UI 逐行并发调用。
- `crud`：写操作（create/remove/setup/symlink）。

### 关键 API 变化（性能核心）

- 新增 `listWorktreesFast(cwd, { owners, currentSessionId, prefix })`：**不含 diff**，即时返回。返回项含 `isMain`、`isManaged`（分支以 prefix 开头）、`occupiedBy*`。
- 新增 `getWorktreeDiff(path, baseRef?)`：单个 worktree 的 `WorktreeDiffSummary`。
- 旧 `listWorktrees(includeDiffSummary)` 保留（内部/测试兼容），desktop service 改用 fast 版。
- 分支命名：`createWorktree(cwd, slug, sid, { prefix })` 生成 `${prefix}${slug}-${sid8}`（prefix 末尾自动规整斜杠）。
- `removeWorktree` 安全校验：从硬编码 `worktree/` 改为「分支以配置 prefix 开头」；仍拒删外部/非受管分支。

## Desktop service + IPC

- `session-workspace-service.ts`：`new SessionManager()` 改为模块级单例复用。
- IPC 拆分：
  - `listSessionWorktrees` → 返回**不含 diff** 的快列表（含 isManaged 标记）。
  - 新增 `getSessionWorktreeDiff(sessionId, path)` → 单行 diff。
- `switch` / `cleanup` 结尾只回 fast 列表，不再跑全量 list+diff。
- 清理动作对「非受管（外部）」worktree 直接拒绝（服务层校验 + UI 禁用）。

## UI 改动（WorkspaceIndicator.tsx）

- 打开 popover：立即渲染骨架行（分支/路径 + 占位 `checking…`），不再 `await` 完整 diff。
- 每行 mount 后并发 `getSessionWorktreeDiff`，回填 dirty/ahead/changedFiles 徽章；带 requestId 防竞态。
- 外部/detached worktree：加灰色「外部」徽章；`detach`/`discard` 菜单项禁用，tooltip 提示「非 CodeShell 管理，请手动清理」。
- 报错弹窗根因修复：`refreshList` catch 忽略「已被新请求取代 / 组件已卸载」的取消错误，只 toast 真实失败。

## 设置页新增项

- `settings.schema.ts` 加 `worktree.branchPrefix`（默认 `worktree/`）。校验：非空、合法 git 分支前缀（允许末尾斜杠，禁非法字符）。
- 设置页 Worktree 区块加输入框（i18n 文案：中/英）。
- `createWorktree` 读取该配置；`removeWorktree` 安全校验用同一前缀；`isManaged` 判定用同一前缀。

## 测试策略

- **core**：新增 `worktree/query.test.ts`（listWorktreesFast 不跑 diff、isManaged 标记）、`worktree/diff.test.ts`（单 worktree diff）、`slug.test.ts`（前缀应用）。现有 worktree-list/remove/guard 测试迁移到新模块路径。
- **crud**：removeWorktree 对自定义前缀受管分支放行、对外部分支拒绝。
- **desktop**：`session-workspace-service.test.ts` 更新为 fast list + 单独 diff；外部 worktree 清理被拒。
- **UI**：`WorkspaceIndicator.test.tsx` 覆盖：骨架行先渲染、diff 异步回填、外部徽章、清理禁用、取消错误不弹 toast。
- 回归基线：`bun test` 对比改动前后，零新增失败。

## 非目标（YAGNI）

- 不做 diff 缓存 / 文件监听失效（后续增量）。
- 不做删除前快照/恢复（Codex 的 restore 能力，暂不纳入）。
- 不改 EnterWorktree/ExitWorktree 工具在 desktop preset 的缺席（刻意移除，保持）。
- 不改 session 级绑定 / cwd 跟随 / 三态清理的核心语义。

## 风险

- barrel 重导出若遗漏某个符号，会 break 下游 import → 拆分后全量 `bun run typecheck` + 测试兜底。
- prefix 可配置后，旧的硬编码 `worktree/` 分支在改前缀后会被判为「外部」而禁用清理 → 文档说明；判定可放宽为「prefix 或历史默认 `worktree/`」二者之一（实现计划中定）。
