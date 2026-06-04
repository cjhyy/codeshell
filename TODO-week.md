# 本周 TODO — 2026-06-03 → 2026-06-09

> 这周要做的事。**只放本周**;长线路线图见 `TODO.md`。**只保留未完成/进行中的。**

## 待办

| 状态 | #   | 任务 | 备注 / 关键落点 |
| ---- | --- | ---- | --------------- |
| ⚪ 不做 | 5 | 内置默认配置随 Electron 发布(agents/skills) | **【不做 — 2026-06-03 用户决定搁置;调研料留档备查】** 诉求:用户开箱即有默认子代理/技能,且走 **Electron 发布默认**(不是 core 包)。**已查清现状**:① **presets 已是 core 内置常量**(`preset/index.ts:118 BUILTIN_AGENT_PRESETS`,general/terminal-coding…)→ 本来就有,不用动;② **models 默认也是 core 常量**(`onboarding.ts` 各 provider 默认 model 列表)→ 不用动;③ **agents 缺分发**——4 个 `.md`(explorer/general-purpose/planner/researcher)仅在本仓库 `.code-shell/agents/`、**git 未跟踪**、无任何内置/seed;core 有软默认 `DEFAULT_AGENT_TYPE="general-purpose"`(`tool-system/builtin/agent.ts:48`)但**不保证存在**,打包后用户 registry 空→退临时 agent,偏好失效;④ **skills 缺内置默认**(`skills/scanner.ts` 只扫 plugin installPath/skills + 用户级,无 bundled)。**Electron 打包现状**:`packages/desktop/package.json build.files` 只带 `out/**`+icon,**无 extraResources、无 seed 机制**。**现成参考模式**:core `prompt/sections/*.md`——build 拷 dist + `package.json files` 列出 + 运行时 `readFileSync(new URL("./sections/x.md", import.meta.url))` 包内读。**待定方向**(brainstorm 时拍):A=Electron extraResources 带默认 + 首次启动 seed 到 `~/.code-shell/{agents,skills}`(用户可改可删,推荐);B=包内只读加载不 seed(用户不能删、升级跟新)。AgentsSection 现 `listAgents(cwd)` 用 `activeRepoPath ?? ""`,没选项目→只列用户级→空(用户报「子代理没东西」根因)。相关记忆 [[project_agent_capability_overview]] [[project_subagent_require_configured]] |

## 遗留 / 待确认

- [ ] **view_image 收尾(剩 2 个计划明确排除的低优先增量)** —— M1 防御默认、gpt-4o vision 误判已修。剩下两项均为**计划排除**:
  - 🟢 **TUI 端图片渲染**(计划明确排除,低优先):终端 inline image(iTerm/kitty graphics protocol)。core 已能产出 image 块,desktop 已能渲染(`InlineImageLink`),仅 TUI 缺。
  - 🟢 **策略 B「看过一轮后把历史图降级成文字摘要」**(计划排除,后续增量):当前靠三道闸门 + tool_result.content 递归剥离控制污染,够用;主动降级(图只在生成/确认那一两轮带,之后换文字占位)是更激进的省 token 手段,留待需要时做。

## 📚 相关研究 / 资料

- 多 session 隔离/上下文装配调研:`docs/research/session-isolation-state.md`
- [CC vs Codex 图片处理对比](./docs/research-cc-vs-codex-image-handling.md)
- 插件系统设计:`docs/superpowers/specs/2026-05-29-plugin-cc-codex-compat-design.md`、`2026-05-29-plugin-remote-install-design.md`
- 统一能力控制层设计:`docs/superpowers/specs/2026-05-29-capability-control-design.md`(对应 #2)
- 泛化推理强度配置:`docs/superpowers/specs/2026-06-02-reasoning-config-design.md` + plan `docs/superpowers/plans/2026-06-02-reasoning-config.md`
- Goal 模式重设计:`docs/goal-mode-redesign-2026-06-02.md` + plan `docs/superpowers/plans/2026-06-02-goal-mode-p0.md`
- 工具可见性守卫 plan:`docs/superpowers/plans/2026-06-02-tool-visibility-guard.md`
- [自动化方案](./docs/automation-plan-2026-05-31.md)— headless/无人值守,Goal P0 是其 Phase 5 依赖
