# 第十六轮 Desktop 设置保存与恢复

Completed。冻结 `a66f4ef291f304ee4df9da8095a90671d9a8f140`，工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。已读 CODESHELL、当前 R01–R68、flow-coverage，去重 R25/26/27/28/R43/R67。产品、主报告、goal、dist 未改，无 build/clean、真实模型、账户、第三方网络或原生 Electron/CLI 实验。

本轮 **1 个待主审独立复核的 P3 候选，暂不编号**。正常 debounce target capture、cancel、离开保存/重开、真实 Main 合并写入与失败后重新编辑恢复均验证。最终 **1 个 guarded Bun wrapper test / 2 expect / 0 fail/skip；内层 owned Bun fixture 27 个 assert，属于该 wrapper，不加第二个测试**。最终日志有 Completed。

## S16-1 / 建议 P3：自动保存拒写后清掉待保存值，存储恢复也不重试，离开后新稿消失

最小根因范围：[useTargetedDebouncedSave.ts:27](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/useTargetedDebouncedSave.ts:27)。`flush` 先 `pending.current=null`，再 `void queued.persist(value)`；没有 await/catch、失败状态、重排队或重试入口。[卸载 cleanup:52](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/useTargetedDebouncedSave.ts:52) 只再次 flush 已清空的 pending。

实际影响的已验证入口为设置→个性化→自定义指令：[SettingsPage.tsx:754](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/SettingsPage.tsx:754) 挂载实际 PersonalizationSection；[AdvancedSections.tsx:80](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/AdvancedSections.tsx:80) 将写入 `agent.appendSystemPrompt` 的实际 `writeSettings` promise 交给 hook，[109](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/AdvancedSections.tsx:109) 输入排队、113 的实际 blur 立即 flush。该组件没有保存按钮、错误/重试反馈或独立持久草稿。

正式可达步骤与已验证结果：

1. 设置已完整加载后修改指令。fixture 明确等待初始已有值出现，排除 R28 类型的旧初始读取覆盖。
2. 保存时 settings.json 已遭遇存储故障。fixture 在**自己 guarded HOME** 中将现有 settings.json 暂时替换为目录，使真实 Main `settings:set`→真实 settings-service 的读改写返回 EISDIR；不是伪造 promise rejection。生产 Main [6570](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6570) 验 patch 并 await 实际 writer，不吞此错误。
3. 实际 Textarea blur 调用 flush 后，内层 Bun 收到一次未处理 promise rejection；当前文本还在，但页面 0 个 role=alert，没有保存失败或错误文本，成功 settings-changed 事件也未发出。**这里没有声称真实 Electron 已发 pageerror 或崩溃；Bun process listener 仅用于记录未结算的 renderer promise。**
4. 在稿仍可见时恢复原文件，重新 focus/blur 的等效实际 blur handler 不再调用 Main；随后点击真实“返回应用”按钮也不再尝试写。hook 的待保存值已被首次失败 flush 清除。fixture 的 onBack 边界卸载实际 SettingsPage；实际 App [2733](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2733) 同样切 viewMode=chat、条件卸载设置页，此接线仅源码核对。
5. 重开实际 SettingsPage 只从磁盘读回旧指令；失败的新稿不在页面或磁盘，临时故障恢复本身不能重放它。重新输入该稿，再 blur，真实 store 成功持久化并产生 settings-changed，故不是永久损坏的 writer/按钮。

这是存储错误后的界面失败恢复问题：用户无法得知自动保存失败，也不能仅通过再次失焦或正常离开重试旧稿。当前数据在失败后仍可复制/重新输入；离开后才能确认其唯一组件副本消失。**不宣称已成功落盘的数据被 writer 删除，不泛化为所有设置都丢失，不声称任何普通编辑都会触发。** EISDIR 是具体可复现的故障注入；EACCES/满盘属于同 promise 分支的可能原因，本轮没有分别动态验证。

### 证据、级别、去重与修复建议

[fixture](/tmp/codeshell-review-20261012-settings-round16/settings-lifecycle.fixture.tsx)、[fixture stdout](/tmp/codeshell-review-20261012-settings-round16/settings-lifecycle.fixture.log)、[guarded wrapper](/tmp/codeshell-review-20261012-settings-round16/settings-lifecycle.test.ts)、[最终 Completed 日志](/tmp/codeshell-review-20261012-settings-round16/settings-lifecycle.test.log)。实际 React SettingsPage/PersonalizationSection/hook/settingsBus/settingsAuthority 均运行。Main get/set callback 与 patch validator AST 取自生产 index.ts，真实 read/writeSettings 原样运行；agent-only patch 的 Main side-effect callback 为 no-op（该字段不触发这些 side effects）。`window.codeshell` 为直接桥接 actual Main callback 的替身，**没有运行原生 IPC/preload transport 或完整 App/Electron**。写入失败不是内存 mock。

建议 P3：限定真实拒写后的自动保存/恢复摩擦与离开失稿，不把假设的满盘或所有字段扩成 P2。与 R43 Token 拒写无反馈同属失败呈现家族，但修复位置和恢复契约不同：R43 的 Token 草稿留在原表单，可按同一个 Save 重试；这里公用 debounce hook 已清掉失败队列，没有同值重试入口，临时存储恢复后正常离开仍丢组件稿。仅修 TokenTab.catch 不会修本 hook。主审若按家族合并，也应保留 hook 的待保存值/离开契约修复点，不以多记编号为目标。

与 R25 全表单旧字段回滚不同，本例是单 `appendSystemPrompt` patch，正常对照保留 responseLanguage/userProfile；与 R26 revision 刷新、R27 probe 过期回包、R28 初次加载未完成操作、R67 另一窗口 LAN 状态均不同。受影响的 ResponsePrefs、GitPath、PetPersonalization 也用此 hook，但本轮只静态确认复用，未逐项宣称独立动态失稿。

建议让 flush 跟踪保存结果，失败保留原目标与值、显示持久错误并提供同值重试；离开时需要使失败稿仍可恢复或明确拦截/提示，不能只在 await 前清空唯一队列。重试必须保留捕获的原 scope/project，仍防跨项目错写。取消应明确丢弃尚未提交的当前值，不能取消已提交到 Main 的事实。

## 正常保护与排除

- **原目标 callback 捕获正确**：hook schedule 保存 targetKey/value/persist；target 切换和 unmount 旧 effect cleanup flush 原 callback。新便携 fixture 用实际 hook +真实项目 settings-service：A 连续两稿只写 latest，切 B 后先写回 A，B 文件不存在；B schedule 后 cancel/unmount 不写。这里是 hook/store 控制，项目 identity IPC 门禁未在这条 hook 控制中动态执行。
- **正常离开确实保存**：实际 SettingsPage 自定义指令输入后立刻按返回，真实 Main writer 只接一次 patch，成功事件一次；重开读回最新指令，其他 agent 字段保留。不能把 cleanup flush 设计本身写成 bug。
- **Main writer不因一次失败永久卡住**：[settings-service.ts:141](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/settings-service.ts:141) 按目标路径串行，前次失败后 catch 链继续；写锁内同步 read/merge/原子 temp→rename，finally 释放与清理tail。fixture 真实失败后重新编辑成功。不是当前 writer 丢并发互不相干 patch 的证据。
- **设置导航限定目标**：SettingsPage [447](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/SettingsPage.tsx:447) contentTargetKey 包含 scope/project/module，[694](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/SettingsPage.tsx:694) key 重挂；主 scope picker更新 scope/module，项目消失时511–518回退 global。不能仅在子组件 rerender 时观察旧局部state就声称正式导航会跨项目污染。
- **配置权威不是 renderer任意cwd**：settingsAuthority 将项目路径投影为稳定 projectId；Main settings:get/setConfiguration先 [rendererConfigurationCwd:3618](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:3618)→实际 resolveRendererConfigurationTarget，后者66–101精确单身份、project resolve primary、session requireUsable等门禁。路径/混合identity失败是保护，不列故障。本轮此门禁仅源码反证，不重跑既有 authority tests。
- **模型配置已有错误与取消保护**：ModelCatalogPanel188–242单飞、写失败保留draft/显示mutationError、成功后authoritative本地更新即使后读失败；403取消只collapse无写。useModelConnections171–195阻止重叠mutation、废弃旧读、失败安全toast，268–271明确保留draft。仅只读已有组件与测试，不重复R25/R26，不计本轮新增执行。
- **初始加载/重复旧读**：开发诊断曾在初始设置请求未完成时输入，旧读取随后覆盖可见值；最终fixture已等待加载完成。该加载门禁家族与R28相近，本轮未单列，不把这个诊断失败充作S16-1证据。

## ProjectInstructions / DataSources 只读反证

详见 [独立快速反证](/tmp/codeshell-review-20261012-settings-round16/instructions-datasources-audit.md)，其新增执行0，随后审计 agent 转入 root 的 Link 任务，没有继续扩展或再委派。

ProjectInstructions 是外部编辑器入口：按 project/root/cwd + targetVersion 检查文件，检查失败显示未知并禁用动作，可重试；openingRef同步防双开，迟到失败不写新项目。不存在内置指令正文保存，不应套用 auto-save结论。

DataSources项目key重挂、active/layout cleanup、load和scope各自generation、busyLock先占位，保存失败保留选择，成功refresh后才清稿；取消选源使旧scope回包失效，未发bind。删除确认迟到返回仍检查active。Main先权威固定原project primary path，迟到picker也不会写新项目；binding从当前磁盘列表按sourceId替换单项，不能直接复制R25旧整表回滚结论。取消系统上传picker返回[]却可能显示uploadDone是静态文案观察，没有实际写入/丢失证据，不列正式项。

## 执行与隔离

```sh
node scripts/run-bun-test-shard.mjs --timeout 25000 /tmp/codeshell-review-20261012-settings-round16/settings-lifecycle.test.ts
```

脚本repo均用 process.cwd()，本地 node_modules symlink仅依赖解析不应提交。outer guardedrunner创建私有HOME并清provider环境；唯一 owned Bun helper继承该HOME，入口再断言marker，在 Core/Host import前安装精确 `http://127.0.0.1:9` HTTP/fetch guard并deny direct net/tls。没有连接该端口、没有再spawn模型/CLI/外部编辑器。文件改动全在 guarded HOME，runner finally清理；组件finally卸载/移除container，helper退出0，最终wrapper Completed。guard不是OS sandbox。

最终wrapper **1 pass、2 expect、0fail/skip**；内层 **27 assert** 单独记录。开发的 MiniDOM不支持container.remove导致cleanup错误已保留在 `settings-lifecycle.harness-failed.log`；初始读取竞态诊断在 `settings-lifecycle.initial-load-diagnostic.log`。它们不计成功总数，也不是产品发现。源码 `git diff 84740d56..HEAD` 对hook/AdvancedSections/settings-service为空，但本轮只执行 latest，不能宣称两基线都跑过。最终 git status只有 root 所有 `?? docs/review-2026-10-12/`。

**Completed：1候选暂建议P3，未自行编号；正常控制与独立反证如上。**
