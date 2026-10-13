# Desktop 会话操作：第十七轮

冻结快照：`a66f4ef291f304ee4df9da8095a90671d9a8f140`，工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。先读 `CODESHELL.md`、主报告 R01–R70 与 progress。产品、主报告和目标未改；未 build/clean，未启动真实 CLI、PTY、worker、模型、账号或第三方网络。未创建子代理。

本轮确认两项候选，未自行编号：SO17-1 建议 P3，SO17-2 建议 P2，交独立质量复核决定正式收录。相关 App、Sidebar、AdvancedSections、useSessionNavigation、ProjectStore 在 `84740d56..a66f` 的 git diff 为空；本代理本轮动态验证仅 a66f，不能把源码相同写成已在旧快照运行。

## SO17-1 / 建议 P3：项目重命名拒写后仍显示新名称，没有失败提示

主位置：`packages/desktop/src/renderer/app/useSessionNavigation.ts:174–178`。它先修改 renderer 项目 `displayName`，随后 `void projectRegistry.rename(...)`，没有等待、回滚或错误状态。

正式入口：Sidebar 项目右键 → “重命名项目…” → 实际 DialogProvider 输入框 → “确定”，`Sidebar.tsx:270–277`。App 的 Sidebar 将 `handleRenameProject` 接到该 hook；Main 实际 `project-authority-ipc.ts:165–168` 等待 `ProjectStore.rename` 成功后才广播注册表。Store 在 `project-store.ts:487–499` 校验 live project/name 并通过实际原子文件写入提交名称。

隔离复现：

1. 真实 ProjectStore 注册自有目录，实际 useTrackedProjects + useProjectRegistrySync 完成初始 hydration；项目菜单取消输入的对照不调用 Main。
2. 将自有注册表父目录 chmod 为 `0500`，经上述实际 UI 输入合法名称 `unique failed project rename` 并确定。
3. 实际 Store 创建原子替换临时文件收到 EACCES。实际 Sidebar 已显示新名称，prompt 已关闭；磁盘项目名称仍是旧名称，Main 没有成功注册表广播。界面没有 EACCES、重命名失败文字或 role=alert。
4. 恢复目录权限，再通过真实 Main 注册表 setPinned 成功操作触发普通广播：useProjectRegistrySync 将界面恢复为磁盘旧名。随后再次打开实际重命名 prompt 并确认，真实 Store 成功保存，界面/磁盘一致。

影响与范围：用户无法知道项目名称未保存，新名称只保留在当前 renderer 投影，后续注册表同步或重新挂载会变回旧名。成功数据未被删除；项目路径/稳定 ID 未改变；故障解除后重新重命名可恢复。P3 适合该窄存储失败条件与轻量恢复，不应扩大成项目配置丢失或错误执行。

owned Bun helper 监听一次 unhandledRejection 仅为记录这个实际未消费的 promise 并继续做恢复验证；没有据此声称 Electron 崩溃、页面白屏或原生错误窗口。

建议：将项目重命名做成有结果的操作，等待 Main 成功后提交显示名，或在失败时按该请求的项目 ID/版本回滚并保留输入、展示重试。不能让较早失败的回滚覆盖另一次较新成功名称；Main 的 live project/name 校验和成功后广播应保留。

去重：与 R60 的“先删除会话目录投影并永久 tombstone，真实删除失败”不同，本项是项目显示名称的未处理异步失败，既没有会话删除也没有 tombstone；修复 R60 的删除提交顺序不会自动修复该 rename callback。与 R70 的 debounce pending 消费/离开唯一稿消失不同，此处显式 prompt 已关闭、投影乐观成功，修复点在项目操作。

## SO17-2 / 建议 P2：Settings“取消归档”只恢复桌面目录，Core 仍归档，恢复行的项目根保护随之失配

主位置：`packages/desktop/src/renderer/App.tsx:2723–2728`，项目配置路由的同一回调在 `2747–2752`。两个回调都只执行 renderer `archiveSession(projectId, sessionId, false)` 和 setSessionIndices，没有调用现有 `setSessionArchived` Main writer。

正式入口与正常归档链：

- Sidebar 现有会话右键“归档”，`Sidebar.tsx:345–347` → `useSessionNavigation.ts:239–252` → `workspaceArchiveRelease.ts:26–41`，这里按 `engineSessionId ?? id` 调用 Main `setSessionArchived`。
- preload `index.ts:969–970` → Main `index.ts:6742–6746` → 实际 `archiveDiskSession`/Core SessionManager 字段更新和 SessionCwdIndex refresh。写入失败时 hook 尚未执行本地 archiveSession；本轮没有把这个顺序说成 R60 的乐观删除问题。
- 设置页“已归档对话”：`SettingsPage.tsx:835–840` → 实际 `ArchivedConversationsSection`，`AdvancedSections.tsx:1462–1470` 的“取消归档”按钮调用 App 提供的回调。该 section 只按 renderer `session.archived` 过滤，`1380–1382`。

动态闭环：

1. 自有真实双根项目 primary A + secondary B；真实 Core 普通 desktop 会话 S 持久绑定 B，UI 别名 U 的 engineSessionId 指向 S。会话包含一条真实持久消息，不启动 Engine/模型。
2. 实际 Sidebar 归档 U，真实 Main AST callback/Core 写 `archivedAt`；实际桌面 SessionCatalogStore 持久 `archived=true`。默认 `listDiskSessions` 不返回 S，符合归档契约。
3. 实际 SettingsPage“取消归档”按钮调用从当前 App TSX AST 原样提取的 callback。真实桌面 catalog 变成 `archived=false`，记录从归档列表消失；重挂普通 Sidebar 又出现 live 会话行。但 setSessionArchived 调用记录没有 false，真实 Core `archivedAt` 仍是 number，默认磁盘目录继续不返回 S。
4. 真实 ProjectStore `sessionMainRoots` 在 `project-store.ts:195` 排除 Core archived 的 S。正常恢复对照：直接调用实际 `navigation.handleArchiveSession(..., false)`（handler/service 控制，不称实际点击了一个可见 Desktop 恢复入口），真实 Main 清掉 archivedAt，磁盘目录重新包含 S、sessionMainRoots 重新报告 B→S；此时真实 Main removeRoot 正确拒绝 “folder is the main root for sessions”。
5. 再走一次实际 Sidebar archive → SettingsPage 取消归档，状态再次分离。实际 Sidebar 项目菜单“编辑项目文件夹…” → 实际 ProjectFoldersDialog，不显示 B 仍是 S 主目录的计数。点击该 dialog 的 B“移除”并通过真实 DialogProvider 确认，实际 Main `projectRegistry:removeRoot`/ProjectStore 成功移除 B mount。该 Core 会话仍绑定旧 B root ID；真实 `store.resolveRunProjectSync` 随后拒绝 `root_removed`。
6. Core 原消息完整保留；未删除物理 B 目录或消息。没有运行后续发送/真实 worker，不能写成已观察到某条消息执行失败或文件丢失。

核心保护并非自己错误：`ProjectStore.removeRoot:312–322` 正确只阻止未归档的 durable bindings，`326–327` 仍阻止移除唯一/primary root。问题在 Desktop 已向用户呈现“恢复”却没有更新这份权威。真实 Main restore primitive 的正向对照验证了正确清 marker 会恢复同一门禁。

级别建议：P2，正常、没有存储故障的“归档→取消归档”确定性触发，重挂也保留互相矛盾的持久状态；可进一步通过完全正式的项目文件夹流程移除恢复行仍绑定的 root，随后生产项目解析正确拒绝该会话。不是 R39 那种已经真正恢复后多一次确认即可完成的 P3 摩擦。如果主审希望只按“Core 目录仍归档”而不计文件夹闭环，应保留本报告的动态范围再讨论 P3，不能把 root gate 自身修成允许失效根。

恢复边界：

- 本轮动态证明现有正确 navigation/Main restore primitive 清 marker 后可恢复磁盘目录和 root guard；**没有**完成一个纯 Desktop 可见恢复 UI workaround。Sidebar 的 live 列表过滤归档行，Settings 取消归档本身始终漏 writer，不能声称“再点一次取消归档”可清 Core marker。
- Desktop SessionsView 本身是磁盘会话的重命名/删除页，没有 restore 按钮，不可把本轮正常 rename 重试对照当成 archivedAt 恢复入口。现有 navigation handler 的 false 分支只是本轮直接调用的正确服务控制。
- Web/配对历史页 PATCH restore 通过服务器更新 Core 标记是既有正式入口，R39 原证据已动态验证它会清 archivedAt；本轮没有新启 Web/HTTP 或点击它，不把旧专项计为本轮恢复运行。
- root 已被显式移除后，恢复 archivedAt 本身不重新挂 root；还要经现有 root 注册/会话修复流程恢复合法绑定。本轮不追加 worktree/Git 或端到端发送实验。
- 没有执行真实 run，也没有证明普通聊天一定不能继续。源码检索到的 Core archivedAt 更新入口为显式 SessionManager.setSessionArchived；本轮未确认正常 run 会自行清 marker 的路径，这只是源码范围说明，不当成真实运行后的观察。P2 依据是正式 restore 契约未完成及已动态验证的 root guard 失配。

建议：两处 App Settings 回调统一复用实际归档操作，以 canonical engine ID 先等待 Main clear archivedAt/refresh 成功，再提交 desktop catalog 的 restored 状态。Settings restore 按请求身份保留 pending/error/retry，失败不先移除归档行；重复操作需去重。保留 Main 的 session ID 校验、durable root binding 门禁、mounted root 身份检查与成功广播语义；不要为修恢复 UI 而跳过安全 authority。

去重：

- R39 是配对 Web 历史页已经清掉 Core archivedAt 后，恢复导航被其 busy guard 误拦；本项是 Desktop Settings 从未调用 durable restore，平台、状态与修复点不同。
- R24 是移除整个项目先 tombstone project authority，冷 worktree 释放失败；本项项目始终 live、无整个项目删除、无 worktree、无 native cleanup，且是 restore marker 漏写。
- R69 是仍 mounted 但物理 missing 的旧 source 令 migrate-to-healthy-target 被全 roots 校验阻断；本项健康 secondary 因错误归档身份被合法 removeRoot 移除，根因与修复点不同。
- R55/R61 的导航或多窗口选择竞争、R60 的永久删除墓碑都未参与复现。

## 正常控制与排除

- 实际项目 prompt 取消不调用 Main、不改变 durable 名称；拒写后实际 prompt 重试成功。
- Main 未知项目重命名拒绝，注册表文件 bytes 不变；实际 `assertDesktopSessionId` 拒绝无效 ID，Main 归档拒绝非 boolean，Main title callback 拒绝超长 title。fixture 没有放宽生产验证器。
- 实际 SessionsView 重命名连接实际 Main `sessions:rename` AST + 真实 session title store。自有 titles 父目录 `0500` 导致 EACCES，实际编辑器保留完整 draft，显示“标题未保存，草稿已保留…”，没有通知 host 成功；恢复权限后点击同一个“保存”，同一 ID/草稿成功，title registry 和 host 通知一致。
- 迟到回包保护只读确认：SessionsView `133–145` 在成功后才通知 host；离页后仍能通知成功，但 mounted=false 不写已卸载编辑器。`useSessionHistorySync.ts:43–69` 用 latest ref，按 canonical engine ID 遍历当前 index，更新匹配别名且不会复活已删除的行；原生产 interaction tests 覆盖 pending 去重、失败重试、离页后成功通知。这些旧测试本轮未重跑，不计新测试。
- 项目 rename 返回的旧 project 对象没有被 hook 回写，普通 registry broadcast 是 Main 的权威 list，不能仅人工延迟 promise 就声称 R55 式旧请求覆盖导航。没有为数量增加项目迟到回包候选。
- “移动会话”没有独立任意目录移动 UI：正式 main-root/workspace 切换沿现有 opaque project/root/session authority；已知 R35/R58/R69 不重报。此次没有做新 Git/worktree/native实验。
- **明确排除自动化选择器影响推断**：buildAutomationConversations 会读取输入中的 archivedAt，但实际 AutomationView 默认 `listDiskSessions` 不传 includeArchived。不能人工将 archived 记录塞进该 picker 再说生产恢复会被拒绝。本轮未据此列问题。默认 Core 磁盘目录过滤与 root removal 影响分别有实际服务/实际 UI 证据。

## 证据层次、隔离与计数

文件均在本目录：`session-operations.test.ts`、`session-operations.fixture.tsx`、`session-operations.test.log`、`session-operations.fixture.log`。

运行：

```sh
node scripts/run-bun-test-shard.mjs --timeout 25000 /tmp/codeshell-review-20261012-session-operations-round17/session-operations.test.ts
```

最终：**1 wrapper Bun test / 2 Bun expect / 0 fail / 0 skip**，owned Bun helper **91 node:assert** 单独计，不能增加测试数。最终 guarded 日志必须有 `Completed Bun shard: 1 tests, 0 skipped; 0 failures.`。helper 使用父 guarded runner 的隔离 HOME 并独立检查 marker；相对 `process.cwd()` 定位产品代码。`node_modules` 本地 symlink 仅用于 /tmp 模块解析，复制到 repo docs 后可由仓库依赖解析。

在 Core/Host 动态 import 前安装 exact-origin `http://127.0.0.1:9` network guard，并 deny net/tls connect；没有实际访问该占位 origin，也没有监听端口。实际读写/chmod 仅 guarded HOME/round17-owned。ProjectStore 的 root discovery 注入恒等适配器避免 Git/native 子进程，真实 mounted root 身份及 mutation/registry/session/index 逻辑仍执行；native picker未运行。worktree release、git status/readProjectDir 是边界替身，普通 main workspace、无 actual cleanup/Git。`window.codeshell` 是本地 bridge 替身，未启动 Electron 或真实 IPC；Main registration 与上述 index.ts callback 为真实生产代码/原样 AST，App restore callback也为真实 AST。实际 React 组件通过 MiniDOM 的正式 handlers 驱动，不能称完整原生 Electron E2E。

finally 卸载 React、dispose persistence、清 project snapshot、恢复 owned 目录权限并删除 owned fixture 数据；wrapper 有 owned child timeout kill，并等待 child.exited。无其他进程操作。

原始 harness 诊断单列：

- `session-operations.initial.log`：Radix 在 MiniDOM 初始化前导入，prompt 不渲染；已把 ensureMiniDom 提前，不是产品缺陷。
- `session-operations.second.log`：fixture 将正式“确定”误写“确认”，按钮选择失败。
- `session-operations.third.log`：fixture 将正式“取消归档”误写“恢复”，按钮选择失败；项目 rename 部分已完成。
- `session-operations.fourth.log`：较早 71 手工断言版本通过，含未包 act 的 fixture 更新警告；不作最终计数。
- `session-operations.final-attempt.log`：补实际 folders UI 的 85 手工断言中间版本通过；最终又补生产 validation 与 post-remove root resolution，所以以最终文件/91 断言为准。

**Completed：第十七轮原始审查与证据已收束；两候选待独立质量裁定，无正式编号或主报告修改。**
