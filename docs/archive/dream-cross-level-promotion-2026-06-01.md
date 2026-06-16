# Dream 跨层级提炼 + 项目记忆归档 — 技术设计

> 状态:设计草案,待评审
> 日期:2026-06-01
> 关联代码:`packages/core/src/services/dream-consolidation.ts`、`session/memory.ts`、`services/auto-dream.ts`;`packages/desktop/src/main/dream-service.ts`、`renderer/settings/MemorySection.tsx`

## 1. 背景与目标

### 现状
当前 dream 整理(`runDreamConsolidation`)只在**单一 level 内、dream scope 内部**做去重/合并:
- 你点项目的 dream → 它读该项目的 user+dream 记忆(user 只读作上下文),只往**该项目的 dream scope** 写。
- 永远碰不到全局(`~/.code-shell/memory`),也不会跨 level 移动记忆。

实测一次后发现两个问题:
1. 项目记忆里其实混着**两类东西**:
   - **项目相关**:只对这个 repo 有意义(某文件的坑、某次修复、某模块设计)。
   - **user 维度**:跨项目通用(工作偏好、你是谁、通用方法论,如"只读 review 不能有副作用")。
   - user 维度的东西卡在项目里,别的项目用不到。
2. dream 产出会越堆越多,缺乏**克制**——没用的、临时的、项目专属的噪音不断累积。

### 目标
让 dream:
1. **跨层级提炼**:读项目记忆,用 **LLM 语义判断**识别出"其实是 user 维度、跨项目通用"的条目,**晋升写入全局 dream scope**。
2. **克制**:严格筛选——只晋升真正可复用的;过滤掉项目专属/临时/低信号的噪音,不把全局塞爆。
3. **归档而非删除**:被 dream 处理(提炼/消费)过的项目条目,**归档**起来不再在项目记忆列表里展示,但可追溯/可恢复——而不是简单删掉或继续显示。

### 非目标
- 不动用户**手写的 user scope**(全局 `memory/user/` 和项目 `memory/user/`)。dream 永远不写、不删 user scope——那是用户亲手维护的区域。提炼的来源主要是项目的 **dream scope**(以及 user scope 作只读参考)。
- 不改 dream 的触发时机(手动按钮 + 会话结束 auto-dream),只改它的行为。

## 2. 存储层事实(设计依据)

来自 `session/memory.ts`:

- **全局**:`~/.code-shell/memory/{user,dream}/`
- **项目**:`~/.code-shell/projects/<hash>/memory/{user,dream}/`,`<hash>` = `projectDir.replace(/[/\\:]/g,"-").replace(/^-/,"")`
- **每个 scope 目录**:`*.md` 条目 + `MEMORY.md` 索引(增量维护,save/delete O(1))。
- **MemoryEntry**:`{ name, description, type: user|feedback|project|reference, content, fileName, scope }`,frontmatter 为 `name/description/type` 三字段。
- **`delete()` 是软删**:`renameSync` 移到 `~/.code-shell/memory-trash/<ISO>/<scope>/`,`loadAll()` 不再列出。
- **`MemoryScope` 当前只有 `"user" | "dream"`**,**没有任何 archive 概念**。
- `MemoryManager` 关键方法:`save() / loadAll() / loadScope(scope) / delete() / getMemoryDir() / getScope() / buildMemoryContext()`。`loadScope` 可不改 manager scope 读任意 scope。

## 3. 设计决策(已与用户确认)

| 决策点 | 选择 |
|---|---|
| user 维度 vs 项目相关的判断依据 | **纯 LLM 语义判断**(读内容判断,type 仅作弱参考) |
| 晋升写到哪 | **全局 dream scope**(`~/.code-shell/memory/dream/`),不碰 user scope |
| 提炼后项目原条目 | **归档**(不是删除、不是继续展示) |
| 归档的实现 | 新增第三个 scope `archived`(见 §4.1) |
| 整体基调 | **克制**:严格过滤,宁缺毋滥 |

## 4. 方案

### 4.1 新增 `archived` scope(归档机制)

把 `MemoryScope` 从 `"user" | "dream"` 扩展为 `"user" | "dream" | "archived"`。

- 磁盘:`<memoryRoot>/archived/`,与 `user/`、`dream/` 平级,同样有 `*.md` + `MEMORY.md`。复用现有全部加载/索引逻辑,零新 IO 模式。
- 语义:`archived` 是"已被 dream 消费/提炼过、不再主动展示但保留可追溯"的项目记忆。它**只在项目 level 存在**(全局不需要归档)。
- `MemoryManager` 新增一个便捷方法(二选一,见实现注意):
  ```ts
  /** 把当前 scope 的某条移动到同 level 的 archived scope(保留原文,frontmatter 不变)。 */
  archive(nameOrFile: string): boolean
  ```
  实现:读源文件 → 写入同 level 的 `archived/` → 从源 scope 删除其 `*.md` + 更新两边 MEMORY.md。比"save 到 archived + delete 原条目"更原子。

**为什么不用 frontmatter flag / trash**:
- trash 是"误删可手动捞回"的回收站,语义是"没了";归档是"刻意留存、可查",两者不能混。
- frontmatter flag 需要 `loadAll` 过滤、混在同目录里,可视性差、解析脆弱。
- 独立 scope 复用现成的 list/index/load 代码,最干净,UI 也能直接像 user/dream 那样列出 archived。

### 4.2 dream 流程改造(`runDreamConsolidation`)

当 dream 跑在**项目 level**(`projectDir` 非空)时,新增"提炼晋升"阶段。跑在全局 level 时,行为不变(只在全局 dream 内部整理)。

新的项目级 dream 循环(仍是 LLM tool-call loop,但工具集和系统提示扩展):

1. **输入**:项目的 `dream` scope 条目(工作区)+ 项目的 `user` scope 条目(只读参考)+ **全局 dream scope 现有条目**(只读参考,避免重复晋升)。
2. **LLM 任务**(系统提示重写,见 §4.3):对每条项目 dream 记忆做语义分类:
   - **user 维度、跨项目通用** → 晋升:写入**全局 dream**(`MemorySave` 到 global dream),然后**归档项目原条目**(`MemoryArchive`)。
   - **纯项目相关、仍有价值** → 留在项目 dream(可顺手合并/改述)。
   - **没用 / 临时 / 低信号 / 已过时** → 直接归档(从展示中移走),不晋升。
   - **与全局已有条目重复** → 不晋升,归档项目条目。
3. **约束(克制)**:
   - 全局晋升设**写入上限**(如每轮最多 N 条,默认 3–5),逼 LLM 只挑最通用的。
   - 系统提示强调"宁缺毋滥:不确定是否通用就留在项目、不晋升"。
   - 沿用现有 `MAX_TURNS`/`MAX_WRITES` 上限。

### 4.3 工具集与权限

dream loop 当前白名单:`MemoryList / MemoryRead / MemorySave / MemoryDelete`,且**硬拒 user scope 写**。改造:

- **跨 level 写**:`MemorySave` 需要支持目标 = 全局 dream。现有 Memory 工具的 `MemoryManager` 由 `ctx.cwd` 决定 level(`mmFor(ctx, scope)` 用 `ctx.cwd` 作 projectDir)。为支持"项目 dream loop 里写全局",有两条路:
  - **(推荐)** 在 dream loop 内部**不复用通用 Memory 工具**,而是直接用两个 `MemoryManager` 实例(一个 projectDir=当前项目、一个全局),在 `dispatchDreamTool` 里按工具参数里的目标 level 路由。这样不污染通用工具的 ctx 语义。
  - 或给 Memory 工具加一个 `level: "project" | "global"` 入参(改动面更大,影响普通会话)。
- **新增 `MemoryArchive` 工具**(仅 dream loop 内可用,不进通用 preset):`{ name }` → 归档当前**项目** dream scope 的该条。
- **权限不变**:dream loop 绕过权限层直接 `executeTool`;user scope 写仍在 `dispatchDreamTool` 硬拒;全局 dream + 归档 = 自动放行(可逆)。

### 4.4 UI(`MemorySection`)

- 项目记忆视图:`loadAll` 默认只列 `user` + `dream`(active),**归档的不展示**——满足"dream 后归档、不再展示"。
- 加一个不显眼的入口看归档(如一个 `archived` scope tab 或"查看已归档"折叠),点开才 `listMemory(level, "archived", cwd)`。可恢复(把条目移回 dream)。
- 全局记忆视图:dream scope 现在会出现被晋升上来的条目,正常展示。
- Dream 按钮文案/提示:跑完后 summary 里体现"晋升 X 条到全局、归档 Y 条"。

### 4.5 常规设置:记忆自动化开关

在「常规」页(`GeneralSection`)加**两个独立的全局开关**(user 维度,存 `~/.code-shell/settings.json`):

| 设置键 | 默认 | 控制 |
|---|---|---|
| `memory.autoExtract` | `true` | 会话结束是否**自动提取**新记忆(MemoryOrchestrator 的 extract 阶段) |
| `memory.autoDream` | `true` | 会话结束是否**自动整理**(auto-dream:去重/合并/晋升) |

- **手动 Dream 按钮永不受开关影响** —— 用户显式点的总是执行。
- 两个开关相互独立:可只关提取、只关整理、或都关。

**接线(关键 —— 当前开关读不到)**:今天 `shouldAutoDream()` 用 `DEFAULT_CONFIG`(enabled 永远 true),orchestrator 调用时**不传任何 config**,所以即使写了设置也不生效。改造:
- `MemoryOrchestrator.run()` 开头读 settings(经 Engine 注入或 orchestrator 自读 `~/.code-shell/settings.json`),得到 `autoExtract` / `autoDream` 两个 bool。
- extract 阶段(orchestrator §1)前加 `if (!autoExtract) skip`。
- `shouldAutoDream({ ...DEFAULT_CONFIG, enabled: autoDream })`(§4 dream 阶段),让 `enabled:false` 真正短路。
- Engine 构造 orchestrator 时把这两个值从 `getSettingsManager().get()` 透传进去(与现有 `auxModelKey` 等读取同路径)。

**UI**:`GeneralSection` 新增一个「记忆」block,两个 shadcn `Switch` 行 + 一句说明("关闭后会话结束不再自动提取/整理记忆;手动整理不受影响")。读写走 `window.codeshell.getSettings/updateSettings("user")`。

## 5. 改动清单(预估)

**core**
- `session/memory.ts`:`MemoryScope` 加 `"archived"`;新增 `archive()` 方法;`migrateFlatLayout`/dir 解析兼容新 scope。
- `services/dream-consolidation.ts`:项目 level 走新"提炼晋升 + 归档"逻辑;`dispatchDreamTool` 支持跨 level 路由 + `MemoryArchive`;全局上限常量。
- `services/auto-dream.ts`:`buildDreamSystemPrompt`/`buildDreamUserPrompt` 重写为"分类 + 晋升 + 克制"版;userPrompt 额外带上全局 dream 现状。
- `tool-system/builtin/memory.ts`:(若走推荐方案则不改通用工具;仅 dream loop 内部新增 archive dispatch)。
- 测试:晋升正确落全局、原条目进 archived 不再被 loadAll 列出、user scope 不被动、上限生效。

**core(开关接线)**
- `services/memory-orchestrator.ts`:`run()` 读 `autoExtract`/`autoDream`,分别短路 extract 阶段和 `shouldAutoDream`。
- `engine.ts`:构造 orchestrator 时从 settings 透传两个 bool。
- 测试:`autoExtract:false` 不写新记忆;`autoDream:false` 时 `shouldAutoDream` 返回 false。

**desktop**
- `preload/types.d.ts` + 渲染层:`MemoryScope` 加 `archived`;`MemorySection` 默认隐藏 archived + 加查看入口;Dream summary 展示晋升/归档计数。
- `GeneralSection.tsx`:新增「记忆」block,两个 Switch(`memory.autoExtract` / `memory.autoDream`),读写 `getSettings/updateSettings("user")`。
- `main/dream-service.ts`:基本不变(手动按钮仍直接调 `runDreamConsolidation`,不看开关)。

## 6. 风险与权衡

- **误晋升**:纯 LLM 判断可能把项目专属的当成通用。缓解:全局写入上限 + "不确定就不晋升"的强提示 + 归档可恢复(晋升错了能从全局 dream 删、从 archived 捞回)。
- **scope union 扩散**:`"user"|"dream"|"archived"` 会波及若干 `VALID_MEMORY_SCOPES` 校验点(desktop main `index.ts`、core memory 工具)。需全量扫一遍校验集合。
- **auto-dream 一致性**:会话结束的 auto-dream 也会走同逻辑——好处是后台自动把通用记忆往全局沉淀;但要确保上限 + 克制提示同样生效,避免无人值守时全局膨胀。
- **归档膨胀**:archived 只增不减。可后续加一个"归档超过 N 条/M 天清理到 trash"的策略,本期不做。

## 7. 验证

- 单测:构造项目 dream 里混入 user 维度 + 项目专属 + 垃圾三类条目,跑 dream,断言:user 维度→全局 dream 出现且项目原条目进 archived;项目专属→留项目 dream;垃圾→进 archived 不在 loadAll;user scope 全程不变;晋升数 ≤ 上限。
- 手测:桌面端项目记忆建几条混合条目 → 点 Dream → 项目列表里被处理的消失(进归档)、全局 dream 出现提炼条目、summary 显示计数;查看归档入口能看到并恢复。
- `~/.code-shell/logs` engine bucket 看 `memory.dream_*` 日志的晋升/归档计数。

## 8. 待评审决策

1. 全局晋升每轮上限取值(建议 3–5)。
2. 归档入口的 UI 形态(scope tab vs 折叠区)。
3. auto-dream 是否也开启跨层级晋升(建议开,但上限更紧)。
4. `MemoryArchive` 是新工具还是 `MemoryDelete` 加 `mode: "archive"` 参数。
