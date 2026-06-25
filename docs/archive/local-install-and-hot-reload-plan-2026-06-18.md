# 本地安装(zip/目录)+ skill 一键安装 + 装完即生效 —— 实现计划

日期:2026-06-18
状态:待用户过目后动手(worktree)

---

## 背景与用户诉求

用户提出两件事:
1. **扩展页没有"本地安装包 upload"入口** —— 现在只有 Marketplace(git URL → 选插件装)。
2. **session 用 skill-creator 调成 skill 后,怎么装到本地用?** —— 并追问"为什么装完还要重启,不该热生效吗?"

调研结论(两轮 Explore):
- **底层能力大部分已具备,缺的是 UI 入口暴露 + 一个热生效 bug。**
- skill-creator 产出的是**裸 SKILL.md(skill 目录)**,不打包 plugin。用户"自己调好本地用"正是 skill 那条路。
- 插件天生全局(`~/.code-shell/plugins/`),无项目级;skill 的 `installSkillFromDirectory(scope)` 本就支持 `user`/`project`。
- **"装完要重启"是 bug:** scanner 的 memoize 缓存 key 只盯 `installed_plugins.json` 的 mtime,不盯本地 skills 目录 mtime;且 desktop 装完只刷 UI 列表,从不通知引擎重载。

用户拍板(2026-06-20 最终):
- zip 入口:**zip 压缩包 + 本地目录都支持**
- skill 一键安装范围:**默认全局(user),不弹范围选择** —— 与市场安装(默认全局)保持一致。用户指出:目前没有"把 skill 切到某 repo / 项目间挪动"的能力,单独给一键安装加 user/project 选择会造成体验割裂。"按项目管理 skill 范围"列为后续独立优化。
- 插件:**保持全局**,本轮不做项目级插件
- 排期:**先做 codeshell 三块(本轮),creator 升级后续单独一轮**
- 节奏:先出计划过目 → 已过目

## creator 升级(后续单独一轮,本轮不做)

调研结论(CC vs Codex 造插件做法对照):
- **CC** 有 `plugin-development` 插件:`init` 搭骨架 + `add-skill/command/agent/hook` 逐个加 + `validate`/`test-local` + `plugin-reviewer` agent;skill 讲规范、command 落盘(分离)。
- **Codex** 社区 marketplace 无"造插件"meta-skill(全是消费型);官方有 `$skill-creator`/`$skill-installer`。
- 共性:插件 = 引导 + 脚手架 + 强校验;**产目录不自动安装**(故本地安装入口是配套刚需)。

方向(用户定:做插件、兼容 skill):本地 mimi-plugins repo 在 `/Users/admin/Documents/个人学习/代码学习/mimi-plugins`(remote cjhyy/mimi-plugins,改这里 push,别改 cache)。现有 `plugins/skill-creator/` 扩成 creator:
- `skills/skill-creator/SKILL.md`(现有,造单 skill)开头加分流问"造 skill 还是 plugin?"
- 新增 `skills/plugin-creator/SKILL.md`:引导搭 `.claude-plugin/plugin.json` + `skills/` 结构(对齐 mimi 现有插件均用 CC 格式 manifest,codeshell detectFormat 两种都吃),可复用 skill-creator 造内部 skill,强校验(学 CC 清单),产出目录 → 引导走 codeshell 本地装插件入口。
- 交互保持 mimi 的对话引导式(非 CC command 式)。

---

## 三块改动

### 块 1:装完即生效(修 bug,最高优先)

这是用户那句"为什么要重启"的正解。两处:

**1a. core scanner 缓存 key 加本地 skills 目录 mtime**
- 文件:`packages/core/src/skills/scanner.ts:204-207`
- 现状:`key = ${cwd}\0${userHome()}\0${installedPluginsMtime()}`
- 改:再拼上 user + project 两个 skills 目录的 mtime
  ```ts
  const skillsDirsMtime = (cwd: string): string =>
    [join(cwd, ".code-shell", "skills"), join(userHome(), ".code-shell", "skills")]
      .map((d) => { try { return statSync(d).mtimeMs.toString(); } catch { return "0"; } })
      .join("|");
  // key: `${cwd}\0${userHome()}\0${installedPluginsMtime()}\0${skillsDirsMtime(cwd)}`
  ```
- 效果:把 skill 文件拷进目录后,目录 mtime 变 → 下一个 turn 缓存自动失效 → 引擎重扫,**当前会话直接看见,无需重启**。
- 注意:目录 mtime 只在"直接子项增删"时变;若担心改文件内容不变 mtime,安装路径已显式调 `invalidateSkillCache()`(见 1b),双保险。

**1b. desktop 装完 skill / plugin 后通知引擎热重载**
- skill 安装回调:`packages/desktop/src/renderer/settings/PluginsAndSkillsSection.tsx:551-554`(onInstalled 现在只 `refresh()`)
- plugin 安装回调:`packages/desktop/src/renderer/extensions/MarketDetail.tsx:68-76`、本地安装新入口(块 3)
- 改:安装成功后额外 `window.dispatchEvent(new Event("codeshell:settings-changed"))`
  - 该事件 App.tsx 已监听 → `configure({ reloadSettings: true })` → server `forEachSession` 广播 → 每个活跃 session `refreshRuntimeConfig()` → `reloadHooks()`(插件 hooks 热重载)。
  - skill 列表本就每 turn 重扫(`composer.ts:211`),配合 1a 即时可见。
- 参考已正确实现的对照:TUI `plugin-handler.ts` 装完调 `invalidateSkillCache()`。desktop 缺这步。
- 可选加固:main 进程 skill/plugin 安装服务里也直接调一次 core `invalidateSkillCache()`(确保 main 自己读的列表也新),`skills-service.ts` / `marketplace-service.ts`。

**验证 1:** 跑 app,装一个 skill,**不重启**,同一会话下一条消息里问"你有哪些 skill" / 触发它,应能看到/触发。

---

### 块 2:skill 一键安装入口

底层 `window.codeshell.installLocalSkill(sourceDir, scope, cwd?, name?)` 已暴露(preload:512-517,main index:1316-1331,service:83-117)。缺 UI 按钮。

- 入口位置:`PluginsAndSkillsSection.tsx`(skill 区,已有"安装本地 skill"的雏形 install() at 766-777 — 先确认是否已部分存在,可能只差按钮可见性)。
- UI:一个"安装本地 Skill"按钮 → 选目录(含 SKILL.md)→ **默认 scope=user(全局)** → 调 installLocalSkill → 成功后走块 1b 的热生效 + toast。
- **不弹 user/project 选择**(与市场安装一致,避免体验割裂 —— 见用户决策)。底层 installLocalSkill 的 scope 参数仍传 "user"。
- 失败提示:SKILL.md 不存在 / 同名已存在 → 走 DialogProvider + toast(禁原生 alert)。

**验证 2:** skill-creator 在某目录产出 SKILL.md → 点"安装本地 Skill"→ 选 project → 该项目立即可用,别的项目不可见。

---

### 块 3:扩展本地安装(zip + 目录)

**3a. core:installer 支持 zip**
- 现状:`installPluginFromPath(sourceDir)` 只吃已解压目录(install.ts:21-96);无任何解压逻辑;仓库无 unzip 依赖。
- 改:新增 `installPluginFromArchive(zipPath)` 或在入口探测扩展名:
  - 解压到临时目录(`os.tmpdir()` 下),再走已有 `installPluginFromPath`。
  - **解压放 core,用 async**(main 进程禁同步 fs — 记忆 project_main_sync_fs_freeze)。
  - 解压库:需新增依赖。候选 `unzipper` / `yauzl`(纯 zip,无原生编译)或 `adm-zip`(同步,不选)。倾向流式 async 的 `unzipper`。**装依赖后必重生成 lock(bun)。**
  - 安全:解压要防 zip-slip(条目路径 `..` 逃逸)——校验每个 entry 落点在 tmp 目录内。
  - 解压后目录可能多套一层(zip 里常含一个顶层文件夹)→ 探测:若 tmp 下只有一个目录且不含 plugin manifest,则下钻一层再 detectFormat。

**3b. desktop:暴露 IPC + UI**
- IPC:新增 `installPluginFromLocal({ kind: "dir" | "zip", path })` → main 调 core。
  - 选目录:已有 core 能力,直接走 installPluginFromPath。
  - 选 zip:走 3a。
- UI:扩展页(MarketList 区 或 PluginsTab)加"本地安装"按钮:
  - 系统文件选择对话框(Electron dialog):允许选 `.zip` 文件 或 选目录(两个按钮或一个带 filter 的对话框)。
  - 安装成功 → 块 1b 热生效 + toast + 刷新已装列表。
- 插件**只全局**,UI 不出现项目级选项(避免误导)。

**验证 3:** 准备一个本地插件目录 + 一个 .zip,分别走"本地安装",装完出现在已装列表,且 hooks/skill 当前会话即时生效(块 1b)。

---

## 不做 / 边界

- 插件项目级安装:用户明确不做,插件保持全局。
- creator 升级(plugin-creator):后续单独一轮,本轮不动 mimi-plugins。
- zip-slip 之外的供应链校验(签名等):本轮不做。

## 块4 · skills + git status 移出 system prefix(prompt cache 优化,已做)

用户追问"skill 注入会不会失效缓存,CC 是不是注入到最下面"引出。核实(claude-api skill + 读 anthropic.ts):
- Anthropic 缓存是 prefix-match,整个 system 打**一个** cache_control(`anthropic.ts:183`),断点在 system 末尾。
- system prefix 里有**两个动态污染源**:skills 清单(装/删 skill 变)+ **git status**(`buildSystemContext` 拼在 system 末尾,改任何文件就变,高频)。任一变 → 整个 system+tools 缓存失效。
- `runtime_header` 无时间戳(已确认干净);`currentDate` 早已正确放在 user-reminder,不在 system。

改动(core 两文件):
- `composer.ts`:删 skills section;新增 `buildDynamicContextMessage()` 把 skills + git status 包进一个 `<system-reminder>` user 消息。
- `engine.ts:1730+`:不再把 systemContext 拼进 fullSystemPrompt;dynamicContextMsg 注入 messages **末尾**(user task 之后,过对话断点之后)——动态内容变动不再炸历史 prefix。
- 测试 `composer-dynamic-context.test.ts`(3 例)锁定:skills 不在 system / 在尾部 user-reminder / 空时 null。

与块1协同:skills 移出 prefix 后,装新 skill 不再炸 system 缓存 → 热生效代价归零。
修正了调研的放置建议(它建议放 messages 靠前,会让历史 prefix 失效;改为放末尾才符合缓存原则)。

## 后续优化清单(不在本轮)

- **按项目管理 skill 范围**:目前市场/本地装的 skill 都是全局,且无"把已装 skill 切到某 repo / 项目间挪动"的能力。这是一个系统性体验设计点(切换/挪动/项目级覆盖 UI),用户拍板后续单独做。
- creator 升级成造 skill + plugin(见上方"creator 升级"节)。
- skill-creator SKILL.md 第 71 行"新开会话才生效" → 块1 修好后改成"立即生效"(属 mimi-plugins,随 creator 那轮一起)。

## 风险点

- 缓存 key 加 mtime:目录 mtime 语义在不同 fs 上略有差异,但配合显式 invalidate 兜底,够用。
- 新增解压依赖:确认纯 JS 无原生编译(否则触发 Electron ABI 重编麻烦)。
- `codeshell:settings-changed` 触发 reloadSettings 是否对长任务会话有副作用:它走的是 refreshRuntimeConfig 既有热重载链(已被 settings 改动复用),风险低。

## 验证总纲

- core 单测:scanner 缓存失效(写 skill 文件后 scanSkills 能发现);zip 解压 + zip-slip 拒绝。`bun test` 带 `src/` 避开 dist 旧测试;改 core 必 rebuild 供 desktop dist 引用。
- desktop:在对应 worktree 跑 app 真机冒烟三块验证(记忆:测新功能必在对应 worktree 跑 app)。
- typecheck:desktop 有自己独立的 typecheck/build,根不覆盖。

## 提交策略

- worktree 隔离(功能/大改动,别动 main)。
- 建议拆 3 个 commit:块1(热生效修复)/ 块2(skill 一键装)/ 块3(zip+目录本地装)。
