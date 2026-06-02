# 无人值守自动化闭环 — 现状调研 + Plan

> 日期：2026-06-02
> 目标链路：自动化读评论/汇总 → 选出要修的问题 → 确认是问题 → 建分支修复 → 提 PR → 发预览版给用户用
> 方法：对 TASK.md 里那份结论逐条核实代码（file:line），三路并行 Explore 验证。

---

## 一、TASK.md 结论核实（逐条）

那份结论**大体属实**，但有两处偏差会改变工作量估算，已在下面标注 ⚠️。

| # | 声明 | 核实结论 | 证据 |
|---|------|---------|------|
| 1 | 定时自动化：cron/interval/timezone/cwd/持久化/runNow/防重并发 | ✅ 属实 | `automation/scheduler.ts:17,25,27,61`(持久化), `411-419`(runNow), `56`+`482-487`(防重) |
| 2 | 桌面端 UI/IPC：列表/创建/暂停/立即运行/权限字段 | ✅ 属实 | `desktop/src/main/index.ts:807-835`(四个 IPC), `automation-service.ts:34`(permissionLevel) |
| 3 | RunManager 落 RunStore 有运行历史 | ✅ 属实 | `automation/runner.ts:90-103`(submit), `scheduler.ts:31`(lastRunId), `run/RunStore.ts:19-43` |
| 4 | headless：TCP server + scheduler，localhost、无鉴权、未作 bin | ✅ 属实 | `cli/agent-server-tcp.ts:37`(127.0.0.1), `16-17`(注释自承无 auth), `102-105`(接 scheduler)；`package.json` bin 仅 `code-shell`，无 tcp 入口 |
| 5 | 写型抽象（write-policy/write-run）有定义+测试但没接线 | ✅ 属实 | `resolveWritePolicy`/`runWriteJobInWorktree` 全仓库消费者**仅** index.ts 导出 + 各自 .test.ts，无生产调用方 |
| 6 | 实际宿主仍只读：硬编码 `HeadlessApprovalBackend("approve-read-only")` | ✅ 属实 | `automation-host.ts:45` 硬编码；`buildDesktopRunManager()` 不看 `job.permissionLevel` |
| 7 | permissionLevel UI 能选但没贯通到执行 | ✅ 属实（孤儿特性） | 存得下来：`AutomationView.tsx:475` → `automation-service.ts:97` → `scheduler.ts:230`；**用不上**：`runner.ts:54-64` & `90-103` 都不读 `job.permissionLevel` |
| 8 | 读评论靠 WebFetch/MCP/GitHub API | ⚠️ **比文档好** | 已有现成的 `git/utils.ts:141-150 ghPrComments()`（`gh pr view --comments`），并已 `index.ts:525` 导出。读评论不用从零做。 |
| 9 | "问题确认状态机"只是架构准备 | ⚠️ **比文档好** | 已有高完整度状态机：`arena/transitions.ts`(proposed→under_review→verified/contested/rejected) + `arena/types.ts:227-288`(ClaimRecord/confidence/adjudication)。不是从零，是"接上"。 |
| 10 | 建分支/修复/提交 PR 只有抽象，无真实接线 | 部分属实，需细分 | worktree **真实可用**(`git/worktree.ts:38-130` 真 execFileSync)，commit/add 真实(`git/utils.ts:90-106`)；**但** `git push` 无执行代码、`gh pr create` **全仓库不存在** |
| 11 | 预览发布链路基本缺失 | ✅ 属实（0%） | 无任何 Vercel/Netlify/Actions deployment / URL 回写代码，仅注释里提过 "deployment agent" 示例 |

### `HeadlessApprovalBackend` 三种模式（`tool-system/permission.ts:19`）
`approve-all` / `deny-all` / `approve-read-only`。automation 当前固定第三种，只放行 Read/Glob/Grep/WebSearch/WebFetch/ToolSearch，写/bash/git 全拒。

### 一句话现状
**"长时只读自动化 + 运行历史"** 已是活的（66 pass / 0 fail）。距离 **"无人值守写代码 + 提 PR + 发预览"** 的闭环，缺的不是架构，是把几段已存在的桥焊起来 + 两段全新链路（push/PR、预览）。

---

## 二、缺口分级（按"焊接" vs "新建"）

**A. 焊接已有桥（成本低，最高优先级）**
- 权限贯通：让 `job.permissionLevel` 真正驱动执行策略，调用已有的 `resolveWritePolicy()`，sandbox fail-closed。
- 读评论接线：把已有的 `ghPrComments()` 接进自动化 prompt 输入。
- 确认状态机接线：把 Arena 的 claim 生命周期接到"候选 bug → 验证 → 置信度阈值/人工批准"。

**B. 新建链路（成本中高）**
- `git push` + `gh pr create`（全仓库不存在，要新写并接 worktree 流程）。
- GitHub 评论**写回** / webhook / cursor 去重（目前只能读不能写）。
- 预览发布（Vercel/Netlify/Actions → deployment URL → 回写 PR），0% 存在。

**C. 产品化（部署相关）**
- TCP server 加 token/TLS、正式 bin、守护进程、重启恢复 + 告警。

---

## 三、Plan（建议执行顺序）

> 原则：先焊接、后新建；每步可独立验收、独立出 PR。本仓库直接在 main 提交（用户偏好），但每步先跑相关 test。

### P0 — 权限贯通（解锁一切写操作）
1. `runner.ts` 的 `bindCronToRunManager()` / `bindCronToEngine()` 读 `job.permissionLevel`，不再硬编码 `approve-read-only`。
2. `automation-host.ts:buildDesktopRunManager()` 按 permissionLevel 选 backend（read-only / workspace-write / full），接 `resolveWritePolicy()`。
3. sandbox fail-closed：策略解析失败一律降级 deny。
4. 验收：新增 test —— 同一 job 设 `workspace-write` 时 Write/bash 放行、`read-only` 时被拒。

### P1 — 读评论 + 确认状态机接线
5. 自动化 prompt 输入接 `ghPrComments()`（先支持手动配 PR/issue URL 列表，不做 webhook）。
6. 把候选问题喂进 Arena claim 流程，用 `confidence` + 阈值或"人工批准"门控，过阈值才进入修复阶段。
7. 验收：给定一组评论，跑出"已确认待修"claim 列表。

### P2 — 真实修复 + 提 PR
8. 在 worktree 内跑 agent 修复（worktree 已可用），跑测试。
9. **新写** push + `gh pr create`（用已有 `gh()` helper 包装），把 lastRunId/PR URL 落 RunStore。
10. 验收：端到端在一个测试仓库跑出真实 PR。

### P3 — 预览发布
11. 抽象 deployment provider 接口（Actions/Vercel/Netlify/自定义脚本），取 deployment URL。
12. URL 回写 PR 评论（**新写** `gh pr comment`，目前只有读）。
13. 验收：PR 上出现可点的预览链接。

### P4 — 服务端产品化
14. TCP server 加 token 鉴权（最低）/ 可选 TLS，绑定可配。
15. 正式 bin 暴露 + 守护进程配置 + 重启恢复 + 失败告警。

---

## 四、关键文件速查
- 调度：`packages/core/src/automation/scheduler.ts`
- 执行接线（焊点）：`packages/core/src/automation/runner.ts:54-103`
- 桌面宿主（焊点）：`packages/desktop/src/main/automation-host.ts:30-47`
- 写策略/worktree 执行（待接线）：`packages/core/src/automation/write-policy.ts:67` · `write-run.ts:47`
- 权限后端：`packages/core/src/tool-system/permission.ts:19`
- 读评论（已有）：`packages/core/src/git/utils.ts:141-150`
- 状态机（已有）：`packages/core/src/arena/transitions.ts` · `arena/types.ts:227-288`
- worktree（已有）：`packages/core/src/git/worktree.ts:38-130`
- TCP server：`packages/core/src/cli/agent-server-tcp.ts`
