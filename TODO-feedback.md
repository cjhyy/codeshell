# TODO / 反馈记录

> 随手记录使用中发现的问题、体验吐槽、待办改进。
> 格式建议:每条带状态标记,处理完打勾并备注 commit。

状态图例:🔴 待处理 · 🟡 进行中 · 🟢 已修复 · ⚪️ 搁置/不修

---

## 反馈列表

> 已完成(🟢)/不修(⚪️)项已归档到 `docs/archive/TODO-feedback-archive.md`(2026-06-16),本文件只留未完成(🔴/🟡)。

<!-- 在下面追加。模板:
### [日期] 一句话标题
- **现象**:
- **复现**:
- **期望**:
- **状态**:🔴
- **备注**:
-->

### 🟡 [2026-06-12] 记忆/Dream 机制疏理 + 记忆杂乱过期 — 待讨论方向
- **疑问**:目前记忆到底怎么用的?Dream 有什么用?CC/Codex 怎么做?而且有些记忆过期了、好杂乱。
- **核实(2026-06-12,本仓库现状)**:
  - **存储**:全局 `~/.code-shell/memory/{user,dream}/` + 项目级 `~/.code-shell/projects/<hash>/memory/{user,dream}/`;每条一个 md(frontmatter+正文)+ `MEMORY.md` 索引。证据 `packages/core/src/session/memory.ts:73-147,225-230`。
  - **注入**:每轮对话开头作为 `<system-reminder>` 注入(user+dream 两 scope 合并,标不同标签);可选 `settings.memories.maxAge` 按天过滤**注入**(不删文件)。证据 `prompt/composer.ts:76-94,243-250`、`session/memory.ts:44-62,239-274`。
  - **写入**:① Desktop UI 手动增删改(MemorySave/Delete 需确认);② 每次对话结束自动 LLM 提取(≤2 条/会话,直存 user scope 不确认,legacy)。证据 `services/extract-memories.ts:14-101`、`services/memory-orchestrator.ts:77-125`。
  - **Dream**:LLM 工具循环(8 轮/10 写预算)整理 **dream scope**(去重/合并/清理),user scope 对它**只读**;自动触发=每 5 会话且隔 ≥24h,手动=设置页「整理 Dream」按钮。证据 `services/dream-consolidation.ts:34-195`、`services/auto-dream.ts:12-89`、`desktop/.../MemorySection.tsx:266-277`。
  - **过期/清理**:**只有注入期 age 过滤 + soft-delete 到 memory-trash**;❌无自动硬删除、❌无自动去重(仅 Dream LLM 做)、❌无后台清理。证据 `session/memory.ts:44-62,199-222`、`settings/schema.ts:418-424`。
- **CC/Codex 对比(2026-06 核实,纠正旧认知)**:两家**都已是「静态指令文件 + 动态自动记忆」双层**,不再是纯静态靠人维护。CC = CLAUDE.md(静态,全量注入)+ Auto memory(默认开/会话内实时写/MEMORY.md 限 200 行 25KB recall/topic 按需读/**无过期无去重靠人**);Codex = AGENTS.md(静态)+ Memories(默认关/**后台异步**写/**有专门 consolidation 模型 + age/idle/数量过期参数**/redact secrets)。**本项目的 Dream(后台 LLM 整合)思路更接近 Codex 的 Memories,而非 CC**。来源 code.claude.com/docs/en/memory、developers.openai.com/codex/memories + config-reference。
- **「杂乱过期」实测**:`~/.claude/...codeshell/memory/` 当前 **75 个文件,其中 42 个(56%)标「已修/已做/已完成」**——一多半是办完的旧事仍占索引,这是杂乱主因。(注:这是 **Claude Code 自己的** auto memory 目录,非本项目 code-shell 的记忆;但暴露的问题对两套都成立=完成态记忆只增不减。)
- **状态**:🟡 第一批已修(2026-06-13,96c5a3e),**未完——用户拍板后续开记忆专项**(整体设计一轮,别零敲碎打)
- **已修(第一批)**:①可关 = `settings.memories.autoExtract`(false 跳过提取,总结/Dream 照跑;记忆页全局视图加 Switch);存量淹没 = 记忆页「清理自动提取(N)」批量按钮(soft-delete 全部 origin:auto 未固定,confirm 带数量);③部分 = 提取 prompt 加 secret redact 规则;② = Dream prompt 加完成态归档规则(纯「已修」无教训的删/并 changelog,有教训先折进主题条目)。
- **🔜 记忆专项(待做,先出整体设计再动手)**:第一批只是止血,记忆系统该作为一个整体重新审一遍。专项至少覆盖——
  1. **生命周期**:记忆从写入→使用→过期→归档/删除的完整状态机;age/数量上限自动归档(现 maxAge 只滤注入不动文件)、trash 的恢复/清空 UI(现只能手动 mv)。
  2. **完成态语义**:给记忆加状态字段(active/done/archived?),Dream/清理流程能按状态归档,不再靠 prompt 软约束。
  3. **质量闭环**:自动提取要不要确认流(现仅可关);提取质量评估(噪音率);Dream 效果可观测(整理前后对比)。
  4. **规模化**:MEMORY.md 索引截断 + 详情按需读(学 CC 200 行 25KB recall);注入 token 预算管理。
  5. **对齐参照**:CC auto-memory(会话内实时写/无过期) vs Codex Memories(后台异步/consolidation 模型/age 参数),见 [[reference_cc_codex_memory]],codeshell 的 Dream 介于两者,定位要明确。
- **可能方向(原记录)**:① 给「自动提取」的记忆也走确认/或可关(现 legacy 不确认);② 给记忆加「状态/完成」语义,Dream 或清理流程能归档/删掉「已修完」的;③ 借鉴 Codex:加 age/数量上限自动归档、secret redact;④ 借鉴 CC:MEMORY.md 索引截断 + 详情按需读,避免索引膨胀。关联记忆 [[project_memory_and_dream_overview]]、[[project_settings_hooks_memory_dream]]、[[reference_cc_codex_memory]]。

### ⚪️ [2026-06-14] 连接页 ModelSection 深度重排
- **现状证据**:`settings/ModelSection.tsx` 仍 **1065 行**列表式 IA。
- **背景**:连接 UI 大改(42ff471)主体已完成,这是当时主动留后的「深度重排」——绑 [[project_model_catalog]] 的 catalog/实例分离信息架构。
- **性质**:UI 重构,需先定信息架构方案(非纯执行)。关联 [[project_connections_ui_overhaul]]。
- **状态**:⚪️ 留后(需设计决策)

### ⚪️ [2026-06-14] 手机遥控 UI 留后项 + 真机冒烟
- **现状证据**:`packages/desktop/src/mobile/` 无 Markdown 渲染(现纯文本 + `<pre>`)。
- **范围**:Markdown 渲染、后台 shell 查看(E4)、model UI(F2 协议已通缺 UI)、planMode;**真机冒烟需用户手机 + 桌面 Electron 扫码实测**(浏览器 boot 已验,WS 真链路要真 main)。
- **性质**:部分需真机。关联 [[project_mobile_ui_react_rebuild]]。
- **状态**:⚪️ 留后(部分需真机)

### 🟡 [2026-06-14] Windows P8 真机冒烟 + CI 能否打 Windows 包
- **现状**:Windows 移植 P1–P8 代码全实现已提交;CI 已有 `tests-windows` job 在**真 `windows-latest`** 上跑 win32 单元套件(shell/kill/PATHEXT/CRLF/sandbox/exec),**但没有打包步骤**。
- **测试路径(三选一)**:① 本地 Win 机/VM:`cd packages/desktop && bun run dist` 出包,装上手点(开 session→跑 `dir`/写文件→内置终端验 node-pty→看 sandbox 是否如预期 off);② 给 CI 加 `package-windows` job(`windows-latest` + `electron-builder` + upload artifact),从 Actions 下 `.exe` 装任意 Win 机点;③ 只验代码层 → 现有 `tests-windows` 绿即够,真机项暂缓。
- **关键认知**:**CI 打包成功 ≠ 验过**——无头环境起不了 Electron 窗口、开不了真 PTY、试不了 sandbox 降级/扫码遥控,这些只能真机点。且 node-pty 要按 Electron ABI 重编 + asarUnpack(见 [[project_desktop_four_panels]]),CI 上首次打包大概率要先调通这步。
- **已知降级**:sandbox win=off(无隔离,用户已确认);node-pty 需 MSVC build tools(CI windows runner 自带)。
- **性质**:真机冒烟 CI 替代不了;「CI 加 Windows 打包 job」可做(顺带验证 CI 能否打包)。关联 [[project_windows_port]]。
- **状态**:🟡 待真机冒烟(代码已就绪)

### 🟡 [2026-06-12] 记忆/Dream 机制专项(已记于上方,此处仅索引)
- 见本文档上方同名条目:第一批已修(96c5a3e),整体设计专项待开。关联 [[project_memory_and_dream_overview]]。
- **状态**:🟡 待开专项
