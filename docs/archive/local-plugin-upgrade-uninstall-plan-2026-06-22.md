# 本地插件:覆盖升级 + 可卸载 + 卸载清 settings — 实施计划(2026-06-22)

> worktree: `feat/local-plugin-upgrade-uninstall`,根 = `.claude/worktrees/installer-upgrade`。
> 测试框架 bun:test,HOME 隔离临时目录(参考 uninstall.test.ts)。core 跑 `bun test src/...`,desktop 有独立 tsc/build。
> **TDD 铁律:先写失败测试,看它失败,再写最小实现。**

**根因(已查实):** 升级能力(`updatePluginByName`)和本地卸载(`uninstallPluginByName`)core 早已实现,缺的是 UI 接线 + 卸载不清 settings。

---

## Task A:本地导入支持覆盖升级(LocalAddPanel)

**真相:** `installPluginFromArchive`/`installLocalPlugin` 在目录已存在时由 `installPluginFromPath` 硬抛 "already installed"。`updatePluginByName(name, installedAt, force=true)` 已实现原子覆盖重装。缺口=本地导入流程不检测同名、不走 update。

**Files:**
- `packages/core/src/plugins/installer/installFromArchive.ts` — 给 `installLocalPlugin` 加 `{ overwrite?: boolean }` 选项:overwrite 时若同名已装,走 `updatePluginByName(name, installedAt, true)` 而非 `installPluginFromPath`。
- `packages/core/src/plugins/installer/installFromArchive.test.ts` — 新测试。
- `packages/desktop/src/main/marketplace-service.ts:174` — `installLocalPluginForUi` 透传 overwrite。
- `packages/desktop/src/preload/index.ts:518` — `installLocalPlugin` 签名加 overwrite。
- `packages/desktop/src/renderer/settings/PluginsAndSkillsSection.tsx` LocalAddPanel — 装前检测同名;已装则 `confirm()` 弹"覆盖升级"(复用 existSameNameMsg 文案或新增),确认后带 overwrite=true 重调。

**TDD steps(core 部分):**
- [ ] RED: 写测试 `installLocalPlugin overwrite reinstalls an already-installed plugin`:先装 v1,改源 plugin.json 版本为 v2,不带 overwrite 再装 → 期望抛 already installed;带 `{overwrite:true}` 再装 → 期望成功且 `.cs-meta.json` version=v2。
- [ ] 跑测试看失败(overwrite 选项不存在 → 类型/行为失败)。
- [ ] GREEN: `installLocalPlugin` 加 overwrite 分支:同名已装 + overwrite → 调 `updatePluginByName`。注意 update 需要源记录在 `.cs-meta.json`,而本地装的 meta.source 指向原 sourceDir;zip 场景 source 是临时解压目录(用完即删)——所以 **overwrite 重装必须直接走"先 uninstallPluginByName 再 installPluginFromPath"或复用 reinstallAtomic 思路**,不能依赖 meta.source 回查(zip 临时目录已删)。最小实现:overwrite 时先 `uninstallPluginByName(name)` 再正常装(非原子,但简单);或更稳妥用 update.ts 里 reinstallAtomic 的 rename-backup 思路。实现者择优,但必须有测试覆盖"覆盖后旧版没了、新版在"。
- [ ] 跑测试看通过 + 全 installer 测试不回归。
- [ ] commit。
- [ ] UI 接线(LocalAddPanel 检测同名 + confirm + overwrite),desktop 跑 `bunx tsc --noEmit`。
- [ ] commit。

## Task B:本地插件可卸载(uninstallTarget + UI)

**真相:** `uninstallTarget.ts:18` 对 `marketplace===null` 直接返回 `uninstallable:false`,UI 隐藏卸载按钮。本地插件应走 core 已有的 `uninstallPluginByName(name)`(删目录+删 `name@local` 条目)。

**Files:**
- `packages/desktop/src/renderer/extensions/uninstallTarget.ts` — 加一种 target:本地插件返回 `{ uninstallable:true, kind:"local", pluginName }`(区别于 marketplace 的 `kind:"marketplace"`)。
- `packages/desktop/src/renderer/extensions/uninstallTarget.test.ts` — 新测试。
- `packages/desktop/src/renderer/extensions/PluginsTab.tsx:86` — uninstall 按 kind 分派:local 调新 IPC `uninstallLocalPlugin(name)`,marketplace 走原路径。
- preload + marketplace-service + main:加 `plugins:uninstallLocal` → core `uninstallPluginByName`。

**TDD steps:**
- [ ] RED: uninstallTarget.test.ts 加测试:本地插件(marketplace=null)→ 期望 `uninstallable:true, kind:"local", pluginName` (当前返回 false,失败)。marketplace 插件仍 `kind:"marketplace"`。
- [ ] 跑测试看失败。
- [ ] GREEN: 改 uninstallTarget 返回带 kind 的判别联合。
- [ ] 跑测试看通过。
- [ ] commit。
- [ ] UI/IPC 接线 + desktop tsc。
- [ ] commit。

## Task C:卸载清理 settings 孤立条目(disabledSkills/disabledPlugins)

**真相:** `uninstallPlugin`/`uninstallPluginByName` 只删目录 + installed_plugins.json,不碰 settings 里的 `disabledSkills`(形如 `name:skill`)和 `disabledPlugins`(形如 `name`)。卸载后孤立残留。

**Files:**
- `packages/core/src/plugins/installer/uninstall.ts`(本地)和 `pluginInstaller.ts` uninstallPlugin(marketplace) — 卸载后清 settings 该插件条目。
- 新建纯函数 `pruneDisabledEntriesForPlugin(settings, pluginName)`(放 disabled-lists.ts 旁或 uninstall 旁),便于 TDD。
- 对应 .test.ts。

**TDD steps:**
- [ ] RED: 写 `pruneDisabledEntriesForPlugin` 测试:输入 `{disabledSkills:["mimi-video:director-skill","other:s"], disabledPlugins:["mimi-video","x"]}` + pluginName "mimi-video" → 期望 `disabledSkills:["other:s"], disabledPlugins:["x"]`(移除 `mimi-video` 和所有 `mimi-video:*`)。
- [ ] 跑测试看失败(函数不存在)。
- [ ] GREEN: 实现纯函数:过滤掉 ===pluginName 和 startsWith(pluginName+":")。
- [ ] 跑测试看通过。
- [ ] commit 纯函数。
- [ ] 接线:两个卸载函数末尾读 settings → prune → 写回(用 userHome() 路径,别污染真 ~/.code-shell;测试 HOME 隔离)。加集成测试:装→禁用其 skill→卸载→settings 不再有该条目。
- [ ] commit。

## 验证收尾
- [ ] core: `bun test src/plugins/installer/ src/capability-control/`(全绿)
- [ ] desktop: `cd packages/desktop && bunx tsc --noEmit`(无错)
- [ ] 不污染真 ~/.code-shell(测试全 HOME 隔离)
- [ ] 交用户:真机跑一遍 卸载旧 mimi-video → 装 zip(全新)→ 再装 zip(测覆盖升级)。
