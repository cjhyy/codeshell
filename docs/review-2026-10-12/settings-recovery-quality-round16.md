# 第十六轮设置候选独立只读复核

Completed。复核对象为 `settings-recovery-round16.md`、其便携 fixture/wrapper/最终日志，以及冻结 `a66f4ef291f304ee4df9da8095a90671d9a8f140` 的实际 renderer、preload、Main 与 settings-service 源码。没有重新执行测试、创建代理、运行进程实验或改产品/主报告。

**结论：保留 S16-1，建议 P3；与 R43 独立修复，不存在阻止收录的实质证据问题。** 结论限定为：设置→个性化→自定义指令的自动保存遭遇真实拒写，失败稿仍显示时修复存储，再失焦/返回都不会重试；离开卸载后重开只读到旧值。不能扩成全部设置或已经成功落盘的数据丢失。

## 生产接线与根因

- `SettingsPage.tsx:748–758` 实际同时挂载 ResponsePrefsSection 和 PersonalizationSection，fixture 选第二个 textarea 对应自定义指令，输入值和磁盘 `agent.appendSystemPrompt` 的断言互相印证。
- `AdvancedSections.tsx:80–82` 给实际 hook 的是 `writeSettings` promise；109–113 的 `onChange` 排队和 `onBlur` flush 是真实入口。该组件只有局部 `instructions` state，没有保存按钮、错误状态、可重试队列或独立持久草稿。
- `useTargetedDebouncedSave.ts:27–29` 先取出/清空 pending，再 `void queued.persist(...)`；52 的卸载 cleanup 只 flush。第一次异步拒绝不会恢复 pending，故没有编辑变化的再次 blur 或卸载不会再写。这不是人为慢响应或错误目标造成的假阳性。
- `settingsBus.ts:27–28` 只有成功 await 后才发 settings-changed；`settingsAuthority.ts:22–23` 用户 scope 直接返回 bridge promise；preload `index.ts:962–963` 将其返回为 `ipcRenderer.invoke("settings:set")`，没有重试/吞错。Main `index.ts:6570–6574` 校验后 await 真正 writer。
- SettingsPage 返回按钮 `SettingsPage.tsx:598–605` 直接 onBack；App `App.tsx:2715–2734` 在 settings view 条件下挂载并把 onBack 接到 `setViewMode("chat")`，因此 fixture 的边界卸载与生产返回的 state 生命周期一致。完整 App/原生 IPC 没有运行，报告已正确说明。

## 证据与反证

已读 `settings-lifecycle.fixture.tsx`，EISDIR 来自 guarded HOME 的自有真实 settings.json 被临时替换为目录。真实 AST Main callback + patch validator + 原 settings-service 写入执行，没有把 persist 换成 `Promise.reject`。agent-only `appendSystemPrompt` patch 不触发 Main side effects；将 side-effect callback 置 no-op 不掩盖本场景的后端写入或错误。初始已存指令出现后才编辑，排除了初始读取覆盖。

最终日志为 **1 Bun wrapper test、2 Bun expect、0 fail/skip，Completed**；owned helper 内部 **27 assert**，不是第二个 Bun 测试。该原始执行只有 latest；源码两基线无差异的观察不等于两基线都运行。

关键反证充分：正常立即返回保存一次且重开成功；其他 agent 字段保留；真实失败后当前稿仍可见；恢复原文件之后不编辑只 blur/返回不再写；重开旧值；再次编辑并 blur 成功且只在成功后发事件。writer `settings-service.ts:147–176` 忽略前次链 rejection、finally 释放锁和 tail，因而不是永久卡住的写锁。原 target capture、cancel 对照证明 hook 正常路径没有跨目标写入；这些 hook 控制不应被当作完整项目 identity IPC 测试，原报告已经限定。

fixture 的 `process.on("unhandledRejection")` 是 Bun helper 对未处理 promise 的记录，**不能据此声称 Electron pageerror、renderer 崩溃或应用退出**。实际组件没有 catch/反馈，生产 renderer 的检索也未发现通用 unhandledrejection 转 toast 入口，支持“该页面没有保存失败呈现”的源码结论；最终文稿保留组件层措辞即可。

## 数据范围、恢复和独立性

损失的是本次失败写入的、尚未持久化的新自定义指令内容。旧文件是 fixture 保存并恢复的原文件，不能说 writer 删除了旧成功数据。失败后页面未卸载时仍可复制或再次编辑；原字串重新输入/发生 change 会重新排队并可保存。仅恢复存储、失焦或正常返回无法重放失败值。页面卸载清掉局部 state 后，生产代码没有该草稿的恢复副本；本审计不排除用户外部剪贴板/手工备份，也不声称其它 hook 消费者逐项动态验证。

EISDIR 是真实故障注入，异常但符合 writer 的拒绝契约。满盘、EACCES 仅共享相同 promise 分支，未逐项执行；不应据此提高常见性或扩大影响。按 P3 的失败提示与恢复摩擦加未保存稿丢失定位合理。

R43 的 TokenTab 是显式 Save：拒写后原表单草稿和同一个 Save 重试入口保留，恢复存储后点 Save 可完成。本项共用 autosave hook 丢弃失败 pending，且离开无确认/重试，修复必须追踪持久化结果、保留原 target/value 和可重试状态。只给 TokenTab 加 catch 不会修 hook，修 hook 也不会修 TokenTab 的凭据呈现，所以可以独立保留；同族整理时亦应保留两个不同修复点。与 R25 旧全表单回滚、R28 初次读取竞态均非同一触发。

**Completed：建议保留一项 P3；新增执行 0。**

主审整合说明：正式分别收录R69/P2与R70/P3；原始专项作者只跑latest，主审后来独立双基线复跑通过，见专项附录。该审计没有新增执行。
