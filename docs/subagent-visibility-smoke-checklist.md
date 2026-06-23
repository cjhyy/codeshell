# 真机冒烟 checklist — 子代理可见性三批工作

覆盖 worktree `subagent-skill-plugin-namespace` 合入 main 的三批(commit `a0b55219` / `31babc5d` / `5526bddf`,merge `ec0807e0`)。全部**未真机验证**。

**前置**:重启 app(core 已重新 build,但 app 的 agent worker 是子进程,必须重启才加载新 core dist)。测试项目用 `~/Documents/个人学习/代码学习/mimi-test-videos`(已配 mimi-video 插件 on,script/ep01-焚天诀.md 在位)。

---

## 批次 1 — 插件 skill 命名空间 + send_input

- [ ] **skill 不再报"未注册"**:新会话发"对 ep01 做导演分析",director 子代理调 `mimi-video:director-skill` 应正常执行,**不再**出现"当前环境没有注册名为 director-skill 的技能"+ 手动 Read SKILL.md 的退化。
- [ ] **三阶段串起来**:导演→服化道→分镜各子代理都能调到自己的 `mimi-video:*` skill(art-design / seedance-storyboard / *-review)。
- [ ] **send_input 续接(可选)**:若某子代理被打断/返回部分结果,`AgentSendInput(agent_id, ...)` 能带记忆续跑(注:mimi-video 流程默认走 re-spawn 读文件,这条主要验底层能力,非日常路径)。
- [ ] **跨重启续接**:子代理 session 落在 `~/.code-shell/sessions/<agentId>/`,重启后 AgentSendInput 仍能 resume(同进程内必成;跨重启理论成立,待验)。

## 批次 2 — A 转后台运行中状态 + B 心跳

- [ ] **A·转后台不再"消失"**:某阶段子代理 >120s 自动转后台时,卡片显示 **"转后台·运行中"** badge,而不是看起来已完成/空闲。
- [ ] **A·折叠按运行中走**:多个子代理(导演+审核…)时,AgentGroupCard 在**有子代理运行中时默认展开**(能看到产出),全部跑完后才折叠。
- [ ] **A·完成收尾**:后台子代理完成后,卡片从"运行中"转为完成态(agent_end/background_agent_completed 到达)。
- [ ] **B·心跳可见"还在 work"**:转后台子代理在 LLM 长请求静默期(数分钟无 tool 调用)时,UI 仍持续显示"运行中"(每 30s 心跳),不会让人以为卡死。
- [ ] **B·失联提示**:若 worker 异常(可手动 kill worker 进程模拟),>90s 无心跳后卡片显示 **"可能失联"**。
- [ ] **B·不空转**:无后台子代理时,不应有持续心跳事件(看日志 `agent_heartbeat` 不应在空闲时刷)。

## 批次 3 — C 重开显示中断子代理

- [ ] **中断可见**:某阶段子代理跑一半时**整个关掉 app**(模拟突然中断),重开该 session → 消息流顶部出现 **"N 个子代理上次未跑完"** banner,列出任务摘要(取自 session.summary)。
- [ ] **completed 不误报**:正常跑完的子代理,重开后**不**出现在中断 banner 里(避免假阳性)。
- [ ] **stale 阈值**:中断判定阈值 10min。刚断的可能要等阈值过(重开通常已隔几分钟,正常)。
- [ ] **banner 只读 + 可关闭**:无续跑按钮;点"知道了"能关。
- [ ] **恢复路径**:看到中断后,发"继续 ep01 导演分析" → 制片人 re-spawn 导演子代理,读现有 outputs 文件接着干。

---

## 验证后

- 通过 → 在本文件勾掉,更新对应记忆(`project_video_migrate_to_notification_wakeup` 系列 / 新建后台可见性条目)标"真机已验"。
- 发现问题 → 记在下方"问题"区,按批次定位(批1=core agent/skill;批2=core agent.ts+desktop reducer/AgentMessageView;批3=desktop sessions-service+InterruptedSubagentsBanner)。

### 问题记录

(待填)
