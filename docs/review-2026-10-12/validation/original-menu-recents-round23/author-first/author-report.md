# 第23轮：成功项目变更后 macOS Recent 菜单仍是旧快照

**REC23-1 / 建议P3，待root正式编号。** 单窗口正常创建项目、重命名或移除成功后，实际V2项目文件、legacy recents投影和新一次`loadRecents`都正确，但已经安装的应用菜单没有刷新：新项目不出现、改名仍显示旧label、删除后旧item仍残留。不是“现代ProjectStore不写recents”的问题，也没有删除项目复活或数据损失证据。

作者在冻结 latest a66f4ef2 用仓库 maintained guarded runner首次执行：**1文件 / 1测试 / 43个Bun expect，1 pass / 0 fail / 0 skipped / exit0 / Completed**。没有早期失败或作者重复运行。root后续双基线复跑另列；本作者收据不冒充双基线证明。此前只读预审及独立审计的执行0仍指各自完成阶段。

## 正式入口与根因

- Sidebar添加、重命名、移除调用真实renderer hook与项目IPC，见 [useSessionNavigation.ts:120](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:120)、[useSessionNavigation.ts:138](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:138)、[useSessionNavigation.ts:174](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:174)。正常菜单已安装后，这些操作不需要人工race或多窗。
- 实际 [project-authority-ipc.ts:82](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-authority-ipc.ts:82) createFromPicker、[同文件:165](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-authority-ipc.ts:165) rename、[同文件:178](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-authority-ipc.ts:178) remove成功后广播registry/mobile。实际Main依赖接线为 [index.ts:5553](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5553)，没有菜单更新回调。
- **反证：磁盘桥已存在。** [ProjectStore.mutate:822](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:822) V2写入后调用 [projectRecents:839](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:839)，写primary path、project.name、lastOpenedAt及deletedAt。初始化创建V2也投影。`recents.json`是rollback输出，V2是权威；本实验健康写入，不依赖投影拒写容错。
- [menu.ts:18](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:18) 仅安装时读一次recents，再在 [menu.ts:56](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:56) 构造固定label与payload。全仓生产安装唯一入口是createWindow末 [index.ts:2711](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:2711)；[refreshAppMenu:148](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:148) 无生产consumer。无menu-will-show重新读取或项目广播更新MenuItem的路径。
- [menu.ts:8](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:8) 注释要求recents变更后重装，相关迁移计划 [multi-folder-local-project-plan.md:614](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/todo/multi-folder-local-project-plan.md:614) 规定V2与降级投影；未找到将已实现Recent实时更新明确后置的契约。

## 动态证据：同一个A窗口，无焦点切换

fixture不改recents mock数组。实际`ProjectAuthority IPC`调用实际`ProjectStore`，真实Core JSON事务写入维护runner私有HOME中的文件，再实际调用`loadRecents`和整个`menu.ts`。

| 阶段 | 实际磁盘 / 新读取 / 广播 | 原菜单对象与内容 |
| --- | --- | --- |
| 空registry正常初次安装 | actual list空、私有V2/recents初始化成功 | `(空)`，builds=1 |
| 实际createFromPicker成功 | V2项目id与返回值一致；recents/live read含owned-project；registry广播含同id | **原对象不变，仍`(空)`**，builds=1 |
| 内部install正常控制 | actual loadRecents重新读取 | 当前owned-project，builds=2 |
| 实际rename成功 | V2/recents/live read/registry广播都为Owned renamed title | **原对象不变，仍owned-project**，builds=2 |
| 内部install正常控制 | actual loadRecents重新读取 | Owned renamed title，builds=3 |
| 实际remove成功 | V2与recents有deletedAt，actual loadRecents及actual registry:list都空，广播空 | **原对象不变，仍Owned renamed title**，builds=3 |
| 点击旧item | actual menu closure向owned A发出`menu:open-recent`旧payload；actual live registry仍无target，磁盘tombstone不变 | 仅证实际menu消息及registry保护；**没有运行App回调** |
| 内部install正常控制 | actual loadRecents重新读取并过滤deleted | 回到`(空)`，builds=4 |

观察文件保留了每阶段V2/recents JSON、新读结果、旧labels/build次数及旧消息；不是只断言文本数组替身。目录折叠adapter实际调用1次，后续actual recents canonical缓存复用该owned path；文件内容及name/tombstone仍由真实磁盘重读。picker 1次、git-settings adapter 1次、registry/mobile广播各3次；所有无关叶模块调用[]，network/child attempts[]。

## 证据边界与删除反证

实际使用：whole ProjectStore、ProjectAuthority注册/create/rename/remove/list、private projects/recents文件、whole实际recents-store读取/校验/live过滤/排序、whole实际menu builder；实际Core公共/内部入口来自现有已构建dist，manifest明确保留两个dist entry SHA及对应源码文件SHA。实际SessionManager仅以owned sessions目录构造，fixture从不构造/调用Engine、LLM client、Core server、Host或worker。Core barrel会加载Engine/provider定义，不能称Core模块未导入；此scope为源码审计声明，不是module-cache检测。

明确替身：

- Electron app/Menu/MenuItem/单一window A与native picker为owned适配器，没有启动Electron/native OS菜单。模板保存是业务结果观测，不会自动刷新或人为改recents。无A/B焦点变化，与R82窗口归属触发隔离。
- coding/git只替换**resolveProjectRoot**为自有普通非Git目录的realpath identity。生产helper原会尝试git然后对这些非Git目录fallback，本fixture为deny subprocess避免该探测；不验证Git、worktree、别名或多root折叠行为。ProjectStore的同一目录折叠依赖也显式提供realpath identity。recents解析与数组/磁盘来源没有mock。
- profiles-service.listProfiles及session-workspace-service的9个unused exports全部throw-only，并断言零调用；准确清单在source/observations。实际IPC其余branch未执行，不宣称整套项目/Workspace IPC均已验证。
- App未挂载/提取。删除后旧item不复活的完整UI含义仍衔接静态 [App.tsx:1429](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1429)：先清renderer本地removed-path标记；若当前projects无path，读live registry，无target便return，未调用create。从本轮实际registry:list空和tombstone不变，不扩大为完整renderer删除E2E。`unmark`不清Main tombstone。

Guard在所有Core/产品动态import前验证维护runner privateHOME，安装exact dummy loopback guard后进一步deny该origin及fetch/http(s)/net/tls/dgram/WebSocket/Bun服务API、child_process/Worker/Bun spawn；owned Electron utility fork也deny。**没有实际网络或产品子进程调用**。这不是OS沙箱或全面direct-native network隔离。fixture finally清recents test override并删除owned目录；维护runner清其临时HOME，最终exit0。wrapper自身启动Bun是授权测试运行，不计为被测产品子进程。

## 恢复、优先级与去重

动态恢复只证**直接内部调用installAppMenu(A)**可用当前磁盘重建，不能写成用户现有“刷新Recent”按钮。实际生产重新创建窗口会在createWindow末重装，重启/全部主窗关闭后activate也是静态生命周期入口；本轮没有实际新建或重启App。展开菜单、聚焦原窗或renderer reload没有重装接线。

权威磁盘项目正常，实际广播为当前状态；Sidebar替代入口和其正常投影为源码衔接，本轮没有渲染完整Sidebar。新名、删除状态不丢。旧rename item仍按同path指向同项目，不称跨项目错开；删除旧item残留但live registry过滤，不称绕过删除/权限或项目复活。建议P3，核心影响是正常操作后的导航项缺失/误导、移除后无效项静默返回；不升为运行中断或数据损失。

与R82/D23-1窗口closure独立：本项单窗，发送正确A仍陈旧；更换dispatch owner不能更新快照。与R29初始化legacy迁移的renderer快照回退独立：本项没有迁移/await覆盖，实际Main结果/广播正确、menu旧，无需R29的renderer投影回退。与R71拒写改名独立：本项限定成功写入；与R24 worktree清理无交集。

R29的Open Recent恢复须限定为**目标path本来在已安装菜单快照，或创建项目后菜单已重装**。本轮实际create证明已装空菜单不会自动出现新B，故不能把Recent写成R29所有触发的立即恢复。R29既有真实rename广播恢复及P3不变，主审负责补措辞。

修复方向：成功项目变更应使Recent数据失效并按当前存活主窗口策略重建，或在展开时生成最新菜单；同时处理R82 owner，避免修列表时继续捕获错误窗口。没有实施产品修复。

## 冻结产物与收据

- [fixture](/tmp/codeshell-review-20261012-menu-recents-round23/menu-recents.test.ts)，SHA256 `e7be6ae20e849cfb6423b1e2d6da23d13f3ba8a05927fef3da39137d1f2afe34`。
- [guard](/tmp/codeshell-review-20261012-menu-recents-round23/network-guard.ts)，SHA256 `6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d`。
- [首次完整日志](/tmp/codeshell-review-20261012-menu-recents-round23/first-run.log)、[观测](/tmp/codeshell-review-20261012-menu-recents-round23/observations.json)、[source manifest](/tmp/codeshell-review-20261012-menu-recents-round23/source-manifest.json)。
- [运行前plan](/tmp/codeshell-review-20261012-menu-recents-round23/plan.md)、[作者只读预审](/tmp/codeshell-review-20261012-menu-recents-preflight-round23.md)、[独立只读质量审计](/tmp/codeshell-review-20261012-menu-recents-quality-round23.md)。plan/预审的“未执行”是运行前历史，本节实际授权首次运行已Completed；独立审计执行仍0，后续更新由审计作者负责。

便携source只依process.cwd()定位冻结仓库，拟复制后使用维护runner，无新API依赖/不build：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-menu-recents-round23/menu-recents.test.ts
```

作者最终：1file / 1test / 43expect，Completed、exit0、0fail、0skip；只执行latest一次，native0，不将作者、root重复运行相加到suite。
