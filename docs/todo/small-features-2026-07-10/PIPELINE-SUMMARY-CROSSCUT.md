# Crosscut Small Features Pipeline Summary

- 分支：`feat/sf-crosscut`
- 基线：`517f80ff`（`main` HEAD）
- 执行约束：严格按任务 1→5 串行；每项先补失败测试、再实现、再单独提交；未 merge、未 push、未切换到 `main`。
- 说明：五项主体实现已存在于本 worktree 的 `main` 基线历史中，本流水线按对应计划逐项验收，并以 TDD 修复每项发现的真实缺口。

## 任务 1：MCP HTTP OAuth 登录/刷新闭环

- Commit：`b6d957231ef28357b0c0310bf3dd89442197a8a2` (`fix(oauth): recover invalid grants through login`)
- 补缺：Link 集成刷新返回 `invalid_grant` 后，改走真实 host OAuth 重新登录并复用原 credential id；无审计 profile 的集成仍保持禁用。
- 改动文件：
  - `packages/desktop/src/renderer/credentials/LinkTab.tsx`
  - `packages/desktop/src/renderer/credentials/link-oauth-actions.ts`
  - `packages/desktop/src/renderer/credentials/link-oauth-actions.test.ts`
  - `packages/desktop/src/renderer/i18n/ns/extensions.ts`
- 测试：OAuth/core/main/bridge/probe/e2e/renderer 定向集 `124 pass / 0 fail`。
- 偏离/未完成：catalog profile registry 继续按计划保持空，直到有真实 client metadata 或可完成 DCR 的 MCP endpoint；未伪造任何 provider 接入。

## 任务 2：浏览器面板复制地址与系统浏览器打开

- Commit：`781c320544c0ef77c21613424816725ee147e996` (`fix(desktop): preserve case-insensitive blank links`)
- 补缺：guest link bridge 将 HTML 保留 target `_blank` 按 ASCII 大小写不敏感处理，`target="_BLANK"` 继续进入内置新标签；Cmd/Ctrl 外部打开、地址栏右键复制和安全 IPC 行为保持不变。
- 改动文件：
  - `packages/desktop/src/browser-guest-link.ts`
  - `packages/desktop/src/browser-guest-link.test.ts`
- 测试：guest bridge、地址栏、URL 校验与限流定向集 `9 pass / 0 fail`。
- 偏离/未完成：无。

## 任务 3：DriveAgent 跳转 Claude/Codex 会话

- Commit：`42b0a9565efbf01ad10620c2849678220ada1ed1` (`fix(desktop): recover failed CLI session probes`)
- 补缺：CLI probe reject 时不再永久停留在“检测中”；清除已消费 deep-link、进入可重新检测的不可用态，且不会错误调用 `openLinkedSession`。
- 改动文件：
  - `packages/desktop/src/renderer/cc-room/CCRoomView.tsx`
  - `packages/desktop/src/renderer/cc-room/CCRoomView.test.tsx`
- 测试：background-work 字段、bucket 路由、CLI 映射、CCRoom nonce/probe、RoomManager 权限与 cwd 定向集 `50 pass / 0 fail`。
- 偏离/未完成：owner bucket 无法解析时沿用基线的安全行为——拒绝污染当前 bucket，而不是计划稿早期建议的 active bucket fallback。

## 任务 4：手机遥控发送图片

- Commit：`aa29659b5f0655b297cb7afe94fbcb96610c1299` (`fix(mobile): retain image drafts after send errors`)
- 补缺：Composer 捕获 `onSend` rejection，保留文字与图片草稿、显示失败反馈并解除 pending，允许用户直接重试且不产生未处理 rejection。
- 改动文件：
  - `packages/desktop/src/mobile/components/Composer.tsx`
  - `packages/desktop/src/mobile/components/Composer.test.tsx`
- 测试：attachment staging、inline/HTTP upload、ticket 生命周期、device/tunnel gate、worktree dispatch、room、mobile helper/hook/UI、core input attachment 定向集 `123 pass / 0 fail`。
- 偏离/未完成：外部 CLI 首版保持计划允许的 workspace-relative path block；未额外实现依赖 CLI 版本探测的 Codex `-i` 优化路径。

## 任务 5：命名收敛第一批

- Commit：`3ab849ba7139d169169a3aebd02a81591322a977` (`refactor(naming): adapt canonical project helper shapes`)
- 补缺：canonical `projects.ts` facade 不再从嵌套返回值泄露 `createRepoForCwd`、`repos`、`repoIdRemap`，改为 `createProjectForCwd`、`projects`、`projectIdRemap`；旧 `repos.ts` API 完全保留。
- 改动文件：
  - `packages/desktop/src/renderer/projects.ts`
  - `packages/desktop/src/renderer/repos.test.ts`
- 测试：project/localStorage/bucket 合同及 session workspace/state 兼容定向集 `28 pass / 0 fail`。
- 兼容确认：继续只读写 `codeshell.repos`、`codeshell.activeRepoId`、`codeshell.removedRepoPaths`；`r-` id、`__no_repo__`、bucket/transcript 字符串和 `state.json` 的 `cwd`/`workspace.root` 均未改变。
- 留待后续：计划 PR2–PR6 的 App 主状态、次级页面/settings、bucket 术语、settings 边界、Core helper 与大范围机械改名均未做，符合“只做第一批”的范围约束。

## 最终测试与已知基线问题

- 五项合并定向回归：`299 pass / 0 fail`（33 个 test files）。
- 最终仓库级 `bun test`：`5768 pass / 6 skip / 1 fail`。
- 唯一全量失败：`packages/core/src/protocol/server.fork.test.ts` 的 `AgentServer agent/forkSession > rejects a live busy source without forking`。该失败在本分支改动之外可单独复现；基线 `517f80ff` 将 fork source lookup 从 `getIdle()` 改为 `get()`，但没有保留 busy guard。它属于未授权的 fork 线，本流水线记录后跳过，没有混入任何任务 commit。
- 环境准备：执行过 `bun install`、`bun run build` 和 `bun run --filter '@cjhyy/code-shell-cdp' build`；生成物均为 ignored 文件，未进入 commit。

## 最终状态

- 五个 feature commit 均为当前分支上的线性独立提交。
- 未 merge、未 push、未切换分支。
- `PIPELINE-SUMMARY-CROSSCUT.md` 按要求保留为唯一未提交文件。

## 复审修复

只读复审给出的 3 MAJOR + 1 NIT 已全部处理，仍在 `feat/sf-crosscut` 上按 TDD 完成，未 merge、未 push、未切换分支。

### MAJOR 1：invalid_grant 后页面未切换到重新登录

- Commit：`dde216b4cd7429bc8193721558f309d065b93d41` (`fix(oauth): refresh link recovery state after failures`)
- 修法：`LinkTab.run()` 在 OAuth action reject 后保留并展示原始错误，同时 best-effort 重新加载 masked credentials；refresh 已落盘的 `lastRefreshErrorCode: "invalid_grant"` 因而能立即驱动主按钮切成“重新登录”。
- 新增测试：`packages/desktop/src/renderer/credentials/LinkTab.test.tsx`，覆盖 `refresh reject → list 返回 invalid_grant → 按钮变 relogin → catalog login 复用原 credentialId`。

### MAJOR 2：catalog relogin 可能覆盖同名其他 OAuth credential

- Commit：`929930f65d4f8370ee0f240ea2a0145be44a96d4` (`fix(oauth): serialize credential login ownership`)
- 修法：main 在任何已有 credential id 登录前 fail-closed 校验类型、provider 与规范化 MCP server URL；归属不同或元数据缺失时在授权前拒绝，不读取/复用 secret，也不 upsert 覆盖原记录。默认 `${provider}-oauth` id 冲突与显式 credential id 冲突均受保护。
- 新增测试：`mcp-oauth-service.test.ts` 的 `catalog login refuses credential ids owned by another provider or MCP server`，分别覆盖 provider 冲突与 server URL 冲突，并断言未打开授权、原 token 保持不变。

### MAJOR 3：同 id relogin 未与后台 refresh 串行化

- Commit：`929930f65d4f8370ee0f240ea2a0145be44a96d4` (`fix(oauth): serialize credential login ownership`)
- 修法：增加 per-credential login gate；登录开始递增 generation 并摘除旧 refresh singleflight entry，登录期间 access-token resolve 等待新登录。旧 refresh 即使延迟返回也无法通过 generation 保存检查；refresh cleanup 使用 promise identity，避免旧 promise 清掉后续新 singleflight。
- 新增测试：`mcp-oauth-service.test.ts` 的 `relogin supersedes a deferred refresh and requests wait for the new login`，覆盖 deferred 旧 refresh、deferred relogin、登录期间 resolve、晚到 refresh 不覆盖新 token/refresh token/meta。

### NIT 4：Composer rejection 测试未包含真实图片

- Commit：`c24df1152f84ac9acb177a792a239321bf039848` (`test(mobile): retain image drafts across retries`)
- 修法：将既有 rejection 测试升级为真实 `File` 与 gallery input 交互；首次失败后断言文字、缩略图和同一 File 均保留且 object URL 未 revoke，第二次重试继续发送同一 File，成功后才 revoke 并清空缩略图。
- 新增/强化测试：`packages/desktop/src/mobile/components/Composer.test.tsx` 的 `Composer keeps text and image drafts after rejection and retries the same File`。

### 复审修复验证

- OAuth + mobile 相关定向回归：`142 pass / 0 fail`（13 个 test files）。
- Desktop typecheck：`bun run --filter '@cjhyy/code-shell-desktop' typecheck` 通过。
- 用户指定全量尾部核验：`bun test 2>&1 | tail -5` 得到 `5771 pass / 6 skip / 1 fail`，共 810 个 test files；唯一失败仍是上文记录的预存 `AgentServer agent/forkSession` busy-source 基线问题，没有新增失败。
