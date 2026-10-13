# 第十一轮：Workspace / Panel R22、R23、R24、R35 质量复核

冻结版本：`a66f4ef291f304ee4df9da8095a90671d9a8f140`，工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。已读最新 `CODESHELL.md`、主索引、原 Desktop 二/三轮报告、原 portable fixtures、latest-a66f4ef2 日志和第六轮 stable scope 附录。新证据仅保存于 `/tmp/codeshell-review-20261012-workspace-quality-round11/`。

**结论：新增 0；R22 / R23 / R24 保留 P2，R35 保留既有 P1。需要收紧的影响是：R23 清的是当前 renderer 的 Panel App 注册项，不删除健康项目、已安装包或磁盘绑定；R24 是冷会话未释放，真正 resident 的生产 helper 可以先完成脱离，并且原 owner 有恢复路径。** stable project scope 没有修复前三项；它对撤销后的旧授权要求重开属于正确保护。

## 本轮验证与限制

新增 3 文件、5 tests、50 assertions、0 failures / skips：

| 文件 | 测试 / 断言 | 重点 |
| --- | --- | --- |
| `panel-registry-recovery.test.ts` | 3 / 20 | 已发布健康项后失败，内置项保留；缺目录恢复、65→64 后刷新恢复 |
| `project-remove-recovery.test.ts` | 1 / 21 | 真实 Git、冷会话失败、实际 resident Core helper 对照、实际 Settings 恢复回调与后续释放/安全清理 |
| `project-scope-restore.test.ts` | 1 / 9 | 同项目不同根、mixed root 拒绝、旧 grant 撤销、新 grant 恢复 |

均运行 `node scripts/run-bun-test-shard.mjs --timeout 30000 <tmp test>`；runner 隔离 HOME / 应用状态并剥离凭据，Core / Host 动态导入前安装 exact-origin guard `http://127.0.0.1:9`，没有实际网络连接。Git 只作用于自有临时仓库，显式使用隔离 global/system config；没有 fetch、真实模型或账号。

R23 执行最新生产 AST 的 IPC/effect 回调与实际 PanelRegistry，发现返回描述符用本地适配器，未安装真实 Panel 包。R24 使用真实 ProjectStore、SessionManager、工作区服务、renderer 导航和 Settings AST 回调；resident 对照调用真实 `releaseOwnedSessionWorkspace`，没有运行 Engine 或 worker 进程。R22 的实际 bindGuest / UI 拒绝证据复用第六轮 latest fixture，本轮新测试只补 resolver / 恢复边界。R35 仅核对源码、原 Git barrier 和最新日志，没有重跑昂贵 Git 时序。

未修改产品 / 主报告 / goal，未 build。末次 `git status --short` 仍只有 root 持有的 `?? docs/review-2026-10-12/`。除已增加 stable scope 的 Panel bridge/resolver 外，R23/R24/R35 所列根因文件在 `84740d56..HEAD` 没有差异。

## R22：合法 secondary root 仍在 stable scope 之前被拒绝

生产链：`packages/desktop/src/renderer/app/SessionPanelDock.tsx:164-185` 通过 bucket 的 projectId 取项目，并将项目 primary path 作为 Panel 的 projectPath；执行 cwd 则来自该 Session 已授权的 workspace。`packages/desktop/src/main/panel-app-bridge.ts:1001-1007` 将 cwd 按 Git 拓扑折回的路径与 prepared projectPath 比较，独立 secondary root B 不等于 primary A，在 `:1005` 就抛 `Panel App workspace does not belong to its bound project`。新 `resolveProjectScope` 到 `:1029` 才有机会执行。

正常可达：项目有 primary A 与独立合法 secondary B，Session 已通过正常项目根迁移 UI 移到 B，再打开该项目已绑定的安装 Panel。ProjectStore / Session 权威仍为同一 projectId、rootStatus=ok，聊天和文件可以继续；Panel Host 失败重试仍是同一拒绝。`packages/core/src/panel-apps/bindings.ts:40-61` 只解决 Git linked worktree 回主 checkout，并不提供 V2 多根项目所属关系。Primary 切换后保留在旧合法根的会话也属于同类形状，但本轮不扩大到所有 worktree。

最新证据复核：第六轮实际 bindGuest AST + 真实 ProjectStore 测试记录 `bindResolverCalls=0`、`rejectionBeforeResolver=true`，且分别选择 A/A、B/B 的 scope 同 projectId、不同 rootId。已复制 `r22-round6-secondary-root-observed.json` 与原 `r22-round6-native-lifecycle.log` 供并列核查，不将它们计入本轮新测试数。

本轮反证：`project-scope-restore.test.ts` 再次确认直接选择 B/B 可以获得正确 scope，但 A/B 混合调用仍被 `packages/desktop/src/main/panel-project-scope.ts:25-29` 的 topology 比较拒绝。因此只删除旧 bindGuest 预检也不足以修好，需要一致调整新 resolver 的合法根关联。

保护边界：primary A 及其正常 linked Git worktree 在第六轮正向对照中成功；独立 root 并不是任意 cwd，必须属于同一个已注册且可用的 V2 项目。新 scope 的 environment/project/root pin、重新验证与 sticky revocation 仍正确。项目 tombstone 后旧 scope 经 assertCurrent 观察撤销；原路径 native picker 重加恢复相同 projectId，但旧 grant 继续明确提示重开，新 capture 可用且稳定身份相同。这是“context identity 不是授权凭据”的正常契约，不作为恢复缺陷。

修复方向：保留 Panel 包/绑定/存储所属的项目路径与执行根的区别；以 Main 的 V2 projectId、Session 的已确认 mainRootId / 注册根及 worktree 拓扑共同判定同项目。执行根 B 必须得到其自身 root identity，安装/存储绑定 A 不应被偷偷改成 B。不能只把传入 projectPath 改成 cwd、允许任意路径，或取消 mount/session/scope 保护。

## R23：会清健康 Panel App 注册项，但不会卸载或删除健康项目

根因未变：`packages/desktop/src/main/project-panel-ipc.ts:135-145` 对最多 64 个路径进行 `Promise.all(requireRendererProjectPath)`；任一路径失效则整批 reject。`packages/desktop/src/renderer/App.tsx:585-598` 提交全部 tracked / cached 主路径，不分批；最新请求失败后用空 descriptors 调 `replacePanelApps`。

“健康项确实清掉”的证据：`packages/desktop/src/renderer/panels/PanelRegistry.ts:258-274` 先移除所有 `owner.kind === "panel-app"`，再注册 next；空 next 会移除当前 renderer 所有已安装 Panel App 项，且与是否 active project 无关。本轮在执行失败 effect 前先发布一个健康项，随后证明其消失；`files` / `browser` builtin 项仍存在。现有 tab 会在 `packages/desktop/src/renderer/panels/PanelArea.tsx:643-652` 呈现 unavailable，launcher/dock 也找不到相应安装项。不要把这一结果描述成整个项目列表被清空。

正常可达：另一个已追踪项目目录被移动、删除或外接盘离线。`ProjectStore.list` 的 `:169-175` 只过滤 deletedAt，不因目录离线删除记录；`requireRendererProjectPath` 的 `:125-126` 会拒绝该缺失目录。它不是来自不可信 arbitrary path 的攻击。65 个健康项目也会触发同一全局 renderer 清空，因为 ProjectStore 上限是 5000（`:44`），App 发送全部项目而 IPC 上限 64。

范围与保护：该失败发生在 discovery 前，新证据 `discovered=0`。没有调用卸载、绑定移除或项目删除；Main 的已安装包/磁盘绑定并未被该错误清除，聊天、文件和 builtin Panels 可继续。Renderer 只是显示这些安装项不可用；目前实际提示可能误导为 disabled/uninstalled。refreshGeneration 检查（App `:591-597`）正确拒绝旧请求覆盖新结果，不能删除它来掩盖当前失败。

恢复已经验证：缺失目录恢复后发普通 `onPanelAppsChanged` 刷新，健康项回来；65 项减少到 64 后刷新也回来。不需要重新安装包。若坏项目仍追踪、或仍超过上限，每次重试仍失败；没有“刷新一次必定恢复”的保证。

stable project scope 不改变此项：scope 捕获在 Panel guest 准备/绑定阶段，批量发现的全有或全无校验更早发生。

修复方向：保留每个路径的 authority 校验和 bounded IPC；逐项目隔离错误并返回可说明的结果，renderer 按 64 上限分批并合并各项目的 descriptors / bound paths；仅撤下无权或不可用项目的变体，健康项目不应因另一个项目失败被清空。不要简单忽略 validation、提高到无界长度，或永久保留一份可能已经撤销的旧全局快照。

## R24：冷会话遗留 owner 成立，resident 对照与恢复入口需要明确

当前用户入口 `packages/desktop/src/renderer/Sidebar.tsx:299-311` 有正常移除项目确认；确认后 `useSessionNavigation.ts:138-146` 先 fire-and-forget `projectRegistry.remove`，再 release/归档。Main `packages/desktop/src/main/project-store.ts:514-522` 同步写 tombstone，然后才 await 广播。

冷会话路径：`packages/desktop/src/main/session-workspace-service.ts:563-592` 没有实际 resident 可先释放时，会到 `mainRootFor`；`:137-171` 对已 tombstone 项目返回 root_removed 并拒绝，正确防止已移除项目继续作为普通运行权威。Renderer `workspaceArchiveRelease.ts:43-57,63-77` 只记录 error 并仍继续 archive；工作区引用保留，归档 owner 仍进入 `workspaceOwners`（service `:130-134`）。重加原项目后，新会话在 `:635-636` 被“occupied by another session”保护拒绝清理。

本轮真实 Git 对照仍成立：移除顺序 remove→release→archive，cold Session durable workspace 仍是其 worktree，归档状态与 deletedProjectLabel 留存；重加恢复同 projectId，新会话看见旧 owner，cleanup 被拒绝。

resident 的正确保护必须收窄说明：`project-authority-ipc.ts:332-338` 对 Main known session 先调用 worker release；`packages/core/src/protocol/session-workspace-rpc.ts:55-64` 只有真的 resident 才调用 engine helper，`packages/core/src/engine/engine.ts:4268-4273` 接到实际 `releaseOwnedSessionWorkspace`，后者 `engine-workspace-authority.ts:200-216` 从持久 session mainRoot 先写回 main，不依赖 ProjectStore 仍 live。本轮调用这个真实 helper 的对照证明：即使 Main 后续再次 root 校验报 root_removed，该 Session workspace 已经 main，不再占用旧 worktree。不能把相同 error 字样当成 resident 释放失败。

同时，Main `hasKnownSession` 只检查 sessionCwd map（`agent-bridge.ts:1765-1766`），并不证明 Core 仍 resident；RPC 对不在 manager 的会话返回 `{ok:true,workspace:null}`（workspace-rpc `:57-60`）。已 idle-evicted / worker 已不存在等情况仍需 durable fallback，不因 known 标签就自动排除此项。本轮只验证确定 cold 与真实生产 helper 的两个端点，不声称所有 known/resident 错误都相同。

恢复入口不是不存在：

1. `transcripts.ts:1005-1014` 归档全部会话并保存 deletedProjectLabel，`:611-639` 在重新加载时恢复已移除项目的归档索引；设置 `AdvancedSections.tsx:1355-1382,1462-1470` 仍列出并允许恢复。
2. Native picker 重加原路径走 `ProjectStore.registerFromPath(...,true)`（`:208-234`），清除 tombstone 并保留原 projectId。单独重加不会自行释放旧 owner，也不会恢复所有已归档会话。
3. Settings 的实际 `App.tsx:2723-2729` callback 恢复 catalog 可见性；它不释放 workspace。本轮执行这个真实 AST 回调后，原 owner 仍在 worktree；随后对该恢复会话再次归档，经正常 `handleArchiveSession` / release helper，在有效项目权威下回到 main，旧 owner 消失，原 checkout仍存在；新会话的正常 clean detach 成功。也可恢复原会话后通过其正常 workspace UI 切回 main，源码服务路径支持这一操作，本轮未另外自动化该 UI。

因此影响应写“移除流程的冷会话脱离失败，重加后需要恢复并处理原 owner；从新会话直接清理被安全保护拒绝”，不应写不可恢复的数据丢失或必须手改状态。`cleanupSessionWorktreeForUi:632-647` 对 external / occupied / dirty worktree 的拒绝均正确；工作区 release 只解除 owner，不自动删除文件，不能通过弱化这些保护来修 R24。

修复方向：项目移除应有明确的 Main 编排，持有仍有效的项目/会话权威先完成各会话 release，审查结果后再 tombstone / archive 并更新 UI；失败需要可见且不能当作释放成功。仅 await 已经先发出的 remove Promise 无法修复顺序；仅先改 renderer 列表也不够。保持 cold durable 路径与 resident 单写者协作，不允许旧 root_removed 项目继续任意运行来绕过失败。

## R35：保留既有 P1；stable scope 不处理创建资源所有权

未重复执行 Git barrier。读取原独立质量审计与 latest-a66f4ef2 `worktree-duplicate-create.test.tsx.log`：2 tests / 15 assertions 通过，包含真实生产 UI 重复 Enter 与真实 Main/Git 失败回滚的分开验证。未把其计入本轮 5 tests。

最新源码确认：`packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:604-635` 只检查 sessionBusy / 有效 authority，未拒绝 busyAction；`:838-854` Enter 仍直接调用 createNew，而只禁用创建按钮。`project-authority-ipc.ts:286-309` 与 `session-workspace-service.ts:511-560` 没有 per-operation 序列化，两个合法同 Session/target 请求都可经过已知 session / mounted root 保护。

`packages/coding/src/git/worktree/crud.ts:126-144` 的分支/路径 preflight 是正确的普通保护，但异步检查之间仍有竞争窗口；`:176-181` 对 add 本身失败也无条件 rollback，`:79-87` 先 `worktree remove --force` 再 `branch -D`。`worktreePathPreexisted` 仅关闭递归 rm fallback，并不限制前两个 Git 删除操作。新 Panel stable scope 只在后续 guest/Host 操作校验项目/执行根，不证明失败创建者拥有这些 Git 资源，无法阻止上述 rollback。

边界：第二次请求若在第一次已建立 branch/registered checkout 后才进入 preflight，顺序保护可拒绝且不走 destructive rollback；不应写每次双 Enter 必现。普通 pre-existing 未注册目录测试（crud.test.ts:52-68）能保护该目录，但不覆盖另一个并发请求刚成功注册的 checkout。非提交文件丢失还要求内容在成功返回后、失败 rollback 前写入；原 barrier 延长了可观察窗口，不证明自然发生频率。P1 仍来自可达的破坏性 ownership 错误。

修复建议需要两层：UI 使用同步 in-flight gate 覆盖 Enter / click，不能只继续禁用按钮；Main/创建服务按 canonical repository 与实际目标资源串行或合并同一创建操作。更关键的是 Coding rollback 必须有操作所有权证明，add 未成功/没有证明自己创建的资源不能删除其它调用的 worktree、branch 或目录；仅把 allowRecursiveDelete 设 false 不足。锁和所有权需覆盖 post-add 配置/失败清理全过程，保留正常取消/部分创建的清理能力。修复验证应同时保留顺序重复分支、pre-existing directory 的正向保护，并复用既有并发真实 Git barrier；本轮不实施修改。

## 证据复制清单

- 新脚本及对应 `.log`：`/tmp/codeshell-review-20261012-workspace-quality-round11/panel-registry-recovery.test.ts`、`project-remove-recovery.test.ts`、`project-scope-restore.test.ts`。
- 计数与限制：同目录 `results.json`。
- R22 复用 latest 观察和日志：同目录 `r22-round6-secondary-root-observed.json`、`r22-round6-native-lifecycle.log`，本轮未重新执行。
- R35 原 latest Git 日志仍位于主报告 `docs/review-2026-10-12/validation/latest-a66f4ef2/repro__desktop-round3__worktree-duplicate-create.test.tsx.log`；无需复制重复的 Git 复现脚本或新跑测试。

## Root归档与两基线复跑

`reproductions/workspace-quality-round11/` 的 Panel registry和项目移除恢复两份便携副本，已在84740d56/a66f4ef2分别通过：4 tests、41 assertions、0fail/skip。`latest-reproductions/workspace-round11/project-scope-restore.test.ts` 为0.9.33专用，另1test9assert通过；没有在旧快照运行或计入通用组。原始文件的绝对源码路径改为当前checkout相对入口；复制后Panel恢复对照的固定40ms等待不足以完成64目录权威检查，初始harness失败已保存于 `validation/workspace-quality-round11/panel-copy-initial-fixed-delay.log`，改为有界等待真实回调完成后通过。产品代码未改。原代理JSON和日志保留在 `validation/workspace-quality-round11/`，便携副本最终日志与脚本同目录。
