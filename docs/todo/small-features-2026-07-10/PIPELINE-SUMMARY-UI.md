# UI Small Features Pipeline Summary

分支：`feat/sf-ui`  
基线：`main` HEAD `517f80ff`

## 任务 1：Review 面板跟随 session workspace

- 本轮 commit：`266b7a707acb6ac7aa0dc3003dfdfb42ddc38d3a`
  (`fix(desktop): mask stale panels during workspace refresh`)
- 改动文件：
  - `packages/desktop/src/renderer/panels/PanelWorkspaceRootConsumer.tsx`
  - `packages/desktop/src/renderer/panels/PanelArea.tsx`
  - `packages/desktop/src/renderer/panels/PanelArea.workspace.test.tsx`
- TDD：先新增 workspace refresh 三态回归测试；测试因缺少
  `panelWorkspacePresentation` 导出而失败，再实现。
- 结果：workspace 首次解析时不挂载 cwd-sensitive body；workspace 切换解析期间保留
  已启动的 Terminal body，但用 loading 遮住旧 Review/Files 内容，解析完成后再显示新 root。
- 相关测试：
  `bun test packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.test.tsx packages/desktop/src/renderer/panels/PanelArea.workspace.test.tsx packages/desktop/src/renderer/panels/ReviewPanel.workspace.test.tsx packages/desktop/src/renderer/panels/FilesPanel.workspace.test.tsx packages/desktop/src/renderer/panels/TerminalPanel.workspace.test.tsx`
  → `12 pass / 0 fail`。

说明：起始 `main` 已包含计划稿的主体 cwd 修复（历史 commit `984ef2a5`），包括
`App.tsx` 传递 engine session、`usePanelWorkspaceRoot`、Review/Files/Terminal 的 resolved-root
接入及回归测试。本轮没有重复改写这些已存在内容，只补齐 workspace change 请求期间仍暴露旧
Review/Files 内容的呈现缺口。

## 任务 2：Session fork 阶段一

- 本轮 commit：`c24c59c87c37109d9b753f46f2bef4d687b84d77`
  (`fix(protocol): reject forks from active sessions`)
- 改动文件：
  - `packages/core/src/protocol/server.ts`
  - `packages/core/src/protocol/server.fork.test.ts`
- TDD：先把 live-source 测试修正为真正 `await getOrCreate()`，并扩充 queued source 场景；
  busy/queued 两项均红灯。随后在 `agent/forkSession` handler 中拒绝 `isBusy()` 或
  `queueDepth() > 0` 的 source，返回 `Overloaded (-32001)`。
- 相关测试：SessionManager、protocol client/server、desktop cold-start/ownership router、
  quick-chat 状态机和 App 集成共 7 个测试文件 → `59 pass / 0 fail`。

说明：起始 `main` 已包含阶段一主体实现（历史 commit `2999e6d2`，并由 `517f80ff`
补齐 transcript helper/build），包括事件游标快照、原子发布、独立 event id、
`forkedFrom` lineage、top-level target、workspace/model/provider/origin 继承、
`agent/forkSession` client/server/preload/desktop cold-start，以及 quick-chat 默认 full、可选 blank、
claim/fork/hydrate/cleanup 状态机。本轮修复了基线末尾把 `getIdle()` 改为 `get()` 后丢失的
live-source 稳定快照保护。

## 最终验证

- `bun run --filter '@cjhyy/code-shell-core' build` → 通过。
- `bun run --filter '@cjhyy/code-shell-cdp' build` → 通过（整仓 browser-driver 测试需要该
  workspace 包的构建产物）。
- 最终 `bun test` → `5765 pass / 6 skip / 0 fail`，共 5771 项、808 个测试文件，66.46s。
- 6 个 skip 均为需要真实外部 agent/LLM 开关的集成测试。

## 偏离与未完成

- 按要求只完成 session-fork 阶段一；阶段二的选段 UI、`summarizeContextPackage`、
  context-transfer summary 持久化均明确跳过。
- 未启动 Electron 做“两份 worktree 各有不同未暂存内容”的手工 UI 回归；对应 renderer、
  workspace、git diff、Terminal 和 quick-chat 自动测试均已通过。
- 未 merge、未 push、未切换到 `main`。
