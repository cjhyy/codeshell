# 真机冒烟清单 · 驱动 Claude Code 编排

> 注:按约定冒烟清单应统一进单一 `docs/smoke-checklist.md`。本文件是该 section 的独立草稿(worktree 从 origin/main 分出,主线的 smoke-checklist.md 未带入);合并到 main 时把下面这段并入 `docs/smoke-checklist.md` 的新 section,删除本文件。

## 驱动 Claude Code 编排(CC 房间 / 定时 / 后台)

前置:本机已装 `claude` CLI(`/opt/homebrew/bin/claude`,v2.1.186 已验证)。

- [ ] **门控**:卸载/重命名 `claude` 后,CC 房间面板显示"未检测到 Claude Code CLI"+ 引导 + "重新检测";装回后点"重新检测"恢复正常列表。
- [ ] **列 session**:CC 房间面板列出本项目(cwd)下所有 claude session,首条消息/消息数/时间正确;中文路径项目也能列出(encodeCwd 已对中文路径验证)。
- [ ] **DriveClaudeCode 工具(前台)**:普通对话里说"用 cc 跑一下 X" → 真的 spawn `claude -p` 跑一轮、返回 finalText + sessionId(已有集成测试真机返回 PONG)。
- [ ] **resume 续接**:`DriveClaudeCode` 传 `resumeSessionId` → 上下文延续(claude 记得上一轮)。
- [ ] **ScheduleRoomTask 一次性**:"2 分钟后用 cc 做 Y" → 任务落进 `~/.code-shell/cron.json`,2 分钟后桌面 automation scheduler 真的触发(不是 sleep 假装);跑完任务 disabled。
- [ ] **ScheduleRoomTask loop**:"每 1 分钟检查 X" kind=loop → 每分钟触发一轮;面板"定时任务"区可见、可删除。
- [ ] **continuation 策略**:always-fresh 每轮新 session(sessionId 变化);always-resume 续同一 session。
- [ ] **后台模式**:`DriveClaudeCode background:true` → 立即返回 jobId,进 backgroundJobRegistry;完成时通知唤醒空闲引擎(不 sleep 轮询);引擎 wait-loop 期间不催模型 sleep。
- [ ] **睡眠唤醒**:定时任务过点 >90s(合盖再开)→ misfire 跳过、re-arm 到下个 occurrence,不补跑(复用 CronScheduler 现有 misfire guard)。
- [ ] **automation 未回归**:已有的 automation 定时任务仍照常触发(CC-aware executor 的 fallback 逐字复刻 bindCronToEngine)。

## 已知限制(本版,见交接段)

- **RelevanceJudge 未接真 aux 模型**:desktop 接线处 judge 是保守默认 `continue-same`(loop+auto 保持同 session 上下文,靠手动停)。"根据返回内容决定续/新/停"的智能裁判需后续把 aux LLM 接进 `ccJudge`(`packages/desktop/src/main/index.ts` 的 CC-aware executor 块)。core 的 `judgeContinuation` 已实现+测试,只差宿主注入一个真模型调用。
- **CC 房间 UI 仅列表态**:"新开 session"按钮与 session 卡片点击是占位(console.log);进入实际对话视图(复用 resident-agent 事件渲染)是后续迭代。
- **headless 审批**:`claude -p` 中途工具被拒时按 permissionMode 行为(bypassPermissions 全自动,其余可能卡到超时);本版未做跨进程审批桥接,driver 也未加单轮超时上限——需真机观察后决定是否给 driver 加 timeout。
- **`claude -p "/goal …"` 单轮自循环**:工具描述里建议 agent 可在 prompt 嵌 `/goal` 让单轮跑更深,但 headless 下 `/goal` 是否真阻塞到条件满足才退尚未真机验证;不 work 则该退回纯 prompt 措辞(改 `drive-claude-code.ts` 工具描述)。
