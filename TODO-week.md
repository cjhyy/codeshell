# 本周 TODO — 2026-06-03 → 2026-06-09

> 这周要做的事。**只放本周**;长线路线图见 `TODO.md`。**只保留未完成/进行中的。**

## 待办

| 状态 | #   | 任务 | 备注 / 关键落点 |
| ---- | --- | ---- | --------------- |
| 🟢 基本完成 | 6 | **发测试版(Electron App + npm rc.1,少数熟人内测)** | **代码 5 块全做完并提交在 main;npm 三包已发。** plan=`docs/superpowers/plans/2026-06-04-beta-release-prep.md`,发布记录=`docs/beta-smoke-checklist.md` E 节。**块0** 测试腐化(发现已先行提交,root+core+desktop typecheck 全 0 错);**块1** Electron 打包✅(electron-builder 出 mac arm64+x64 dmg/zip,未签名;**客观验证** `Info.plist` 三个名全=`code-shell`、产物 Resources 含 4 agents + 市场种子);**块2** 首启 seed✅(`seed-defaults.ts` TDD,whenReady 调用,extraResources;**修了 plan 两个 bug**:ESM 下 `__dirname` 要 fileURLToPath 派生、repo root 是 `../../../..` 四级不是三级;electron 改 lazy `require` 以免污染 bun-test);**块3** `AddMarketplace` 内置工具✅(TDD,6 用例,ask 权限,已注册+rebuild core);**块4** 版本→**最终 `0.5.0-rc.2`**✅,**用 `bun publish --tag rc`(不是 `npm publish`——meta/tui 的 `workspace:*` 只有 bun 发布时解析成具体版本;npm 会原样发出导致装不上)**;过程踩两坑均已修:①bun.lock 把 tui 仍钉在 rc.0(重生成 lockfile);②**rc.1 装得上跑不起来**——上轮已发的 core@rc.1 缺 tui 需要的 `mergePluginMcpServers` export,装完跑 bin 抛 SyntaxError;npm 不可覆盖故全量 bump rc.2 用兼容构建重发。**最终 clean-env `npm i @cjhyy/code-shell@rc` → 三包全 rc.2 → `code-shell --version`=0.5.0-rc.2 跑通无报错**✅;meta `latest` 仍 `0.3.0` 未污染。块5 冒烟清单✅。桌面包**已重出 rc.2 dmg/zip**(arm64+x64,name/version/seed 资源全客观验证)。**剩余(交人工)**:桌面 App GUI 点测(装 dmg/右键打开/配 provider 跑对话/生成图)——agent 没法操作 GUI,清单见 `docs/beta-smoke-checklist.md` A 节。**教训**:发 npm 前必真跑一次 bin,别只信 `bun publish` 的 `+pkg@ver`。相关记忆 [[project_npm_publish_workspace]] [[project_agent_capability_overview]] [[project_subagent_require_configured]] |
| ⚪ 不做 | 5 | 内置默认配置随 Electron 发布(agents/skills) | **【不做 — 2026-06-03 用户决定搁置;调研料留档备查】** 诉求:用户开箱即有默认子代理/技能,且走 **Electron 发布默认**(不是 core 包)。**已查清现状**:① **presets 已是 core 内置常量**(`preset/index.ts:118 BUILTIN_AGENT_PRESETS`,general/terminal-coding…)→ 本来就有,不用动;② **models 默认也是 core 常量**(`onboarding.ts` 各 provider 默认 model 列表)→ 不用动;③ **agents 缺分发**——4 个 `.md`(explorer/general-purpose/planner/researcher)仅在本仓库 `.code-shell/agents/`、**git 未跟踪**、无任何内置/seed;core 有软默认 `DEFAULT_AGENT_TYPE="general-purpose"`(`tool-system/builtin/agent.ts:48`)但**不保证存在**,打包后用户 registry 空→退临时 agent,偏好失效;④ **skills 缺内置默认**(`skills/scanner.ts` 只扫 plugin installPath/skills + 用户级,无 bundled)。**Electron 打包现状**:`packages/desktop/package.json build.files` 只带 `out/**`+icon,**无 extraResources、无 seed 机制**。**现成参考模式**:core `prompt/sections/*.md`——build 拷 dist + `package.json files` 列出 + 运行时 `readFileSync(new URL("./sections/x.md", import.meta.url))` 包内读。**待定方向**(brainstorm 时拍):A=Electron extraResources 带默认 + 首次启动 seed 到 `~/.code-shell/{agents,skills}`(用户可改可删,推荐);B=包内只读加载不 seed(用户不能删、升级跟新)。AgentsSection 现 `listAgents(cwd)` 用 `activeRepoPath ?? ""`,没选项目→只列用户级→空(用户报「子代理没东西」根因)。相关记忆 [[project_agent_capability_overview]] [[project_subagent_require_configured]] |

## 遗留 / 待确认

- [ ] **插件 MCP 加载/禁用链路收尾** —— 现象:安装 `chrome-devtools-codex-plugin` 后,`mcp-servers.json` 已生成,`mergePluginMcpServers({}, [])` 能读到 `chrome-devtools:chrome-devtools`,但新 session 的 `ToolSearch` 里没有暴露 Chrome DevTools MCP 工具;关闭插件后也可能复用同一进程内已注册 MCP tools。已修一处独立 bug:插件 MCP server 名含 `:` 会导致 OpenAI `tools[].function.name` 非法,已在 `mcp-manager.ts` 注册前清洗。后续期望:安装插件后新 session 自动加载插件 MCP;禁用插件后不再合并 MCP server、已连接 server 被 disconnect、`ToolRegistry` 对应 MCP tools 被 unregister;重新启用可重新 connect/register。关键文件:`plugins/installer/loadPluginMcp.ts`,`tool-system/mcp-manager.ts`,`tool-system/registry.ts`,`settings/disk-defaults.ts`,`engine/engine.ts`,`run/factory.ts`,`cli/agent-server-{stdio,tcp}.ts`。
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
