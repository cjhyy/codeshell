# 第二十轮追加：R29 优先级只读交叉裁定

**建议将 R29 从 P2 收窄为 P3，保留正式缺陷和修复建议。** 当前证据证明一次升级迁移窗口内的 renderer 项目投影回退，可使刚添加并选中的项目暂时不可见/配置不可用；没有证明 Main 项目或历史被删除、永久无法恢复、错项目执行或真实任务中断。第十轮已动态验证真实 Main 广播能恢复投影，此恢复与触发稀窄性共同支持较低紧急度。

本轮仅阅读 CODESHELL、desktop-round3 D12、desktop-quality-round10 R29、现有便携fixture/最终日志和冻结 a66f 源码。**新增测试/fixture/原生/模型/CLI/网络实验执行均0**；没有重跑既有1 test / 9 expect，不将它计为本轮执行。没有产品、主报告、goal或构建改动，仅写本文。不是新finding，也不是已有缺陷修复后的撤回。

## 仍成立的真实触发与功能受阻

- `useProjectRegistrySync.ts:49–54` 读取/迁移初始项目快照。`projects.ts:303–304` 的 migrateLegacyProjects 已会重读Main registry，这是保护，但该读取发生在后续await之前。
- 必须有升级遗留renderer project id需要remap，并有需要复制的旧transcript；`useProjectRegistrySync.ts:57–58` await迁移，`transcripts.ts:800–806,821–830` 确有真实persistence.flush等待。普通已完成升级/无旧bucket-copy的日常Add Project，不是该已复现条件。
- 等待期间正式Add Project仍可通过 `App.tsx:1426–1427` 或侧栏 `:2198–2199` 调 `useSessionNavigation.ts:120–135`。Main createFromPicker成功注册并广播B，renderer先显示A+B且activeProjectId=B。旧初始化续程随后在 `useProjectRegistrySync.ts:62` 无版本检查地setProjects(旧A)，activeProjectId在 `:71–73` 只处理remap，不清掉B。
- 不把影响降成纯文案错误：`App.tsx:298` 的activeProject查找会返回null；侧栏依 `:2177–2181` 的projects不再呈现B，B的项目菜单/选择入口因此消失。`App.tsx:531–533` 对activeProject缺失的project_config路由退回chat，项目配置渲染也有 `:2736–2744` 的activeProject条件。
- 对尚无既有Core Session的新项目草稿，`sessionUiAuthority.ts:165–175,265–269` 的projectPrimaryRoot来自activeProject；此时projectId仍为B但primaryRoot=null，configurationAvailable=false。这是源码限定的功能不可用，未在既有R29 fixture中完整渲染配置页或发送任务。已有绑定Session的authority另由Main按sessionId解析，不能从该草稿状态泛化“所有B会话功能都失败”。

因此第十轮以“选中项目的UI authority消失”保留P2并非没有依据；真实阻断仍保留在结论中。本轮是对已经明确的影响/恢复重新定级，没有否定race可达性。

## 保护证据与恢复强度

| 事项 | 已有证据强度 | 本轮如何使用 |
|---|---|---|
| Main仍保留A+B | 既有fixture使用真实ProjectStore，migration完成后实际list得到2项，renderer只剩A且activeB | 证明不是注册表删除；不写“新增项目失败回滚” |
| transcript迁移保护 | `transcripts.ts:803–806` 保留source authority至复制flush，`:821–830` 两目录patch持久后才删除迁移source snapshots | stale renderer setProjects本身不调用项目删除/删除B历史；不把IPC transcript-write seam扩大成完整原生文件系统故障证明 |
| 对仍可见A重命名后恢复B | round10实际hook的handleRenameProject(A,新名)→真实ProjectStore.rename/onChanged，恢复A+B、保持activeB、显示A新名，既有1test/9expect最终log通过 | 动态证明不必重启可恢复；是hook+Main实际边界，不冒充实际Sidebar/Prompt/Electron全UI点击 |
| 该重命名的可见UI入口 | `Sidebar.tsx:270–277` 的真实prompt提交→App`:2203`→hook`:174–179` | 源码接线使上述服务控制有可见入口；fixture确实改变A名称，未证明同名rename也会广播，不能称无副作用“一键刷新” |
| Open Recent恢复 | Main `menu.ts:56–66` 有最近项目menu event；App`:1429–1445` 对当前projection缺失的path重读registry并reconcile/select | 合理的非改名恢复入口，仅静态，不能写本轮已点击成功 |
| 重启/重开后读权威registry | startup list/reconcile源码和Main持久A+B支持；旧报告作为恢复描述 | 没有本轮动态重启，不依赖它充当唯一恢复证据 |

等待旧迁移结束本身不会自动把B加回来；race正是在完成时覆盖投影，必须再有新的registry event/reconcile。P3不是“自动一闪而过”的判断，也不是保证任何操作都能恢复。

## 为什么建议P3，以及保留的反对意见

支持P3的组合是：**升级遗留id+transcript异步迁移窗口限定、仅投影被旧快照覆盖、Main项目/当前active id保留、真实广播恢复已验证、没有持久损失或任务错误的动态证据。** 这是一次需要用户恢复的界面状态故障；现有证据尚不足支持它对通常项目流程造成广泛或不可恢复中断。不是因为“有workaround就一定P3”，而是其触发频率、持久影响和可恢复边界都已收窄。

保留反对P3的理由：

1. 新增并选择B是正常用户操作，没有违反门禁；UI已确认显示B又将它移除。用户可能不知道这是投影问题，甚至误以为添加失败。启动磁盘复制较慢时窗口可以可感知，并非数学上不可达的瞬时竞态。
2. 对仍可见A改名虽然动态有效，但修改无关项目不是自然的恢复指引，也不能要求用户凭空发现；Open Recent尚未作为完整UI动作动态证明。因此不能宣传恢复为轻松、显式提示或单击重试。
3. 问题可持续到下一个registry event，期间选中B的项目配置确实受阻；不能因为Main持久数据健康就把功能影响写成仅侧栏美观。

这些反对意见足以保留缺陷并要求修复，但在当前证明边界下，我仍倾向窄P3。若后续正式UI证据显示无法进入已存在的正常恢复入口、错误注册/任务实际在其他cwd执行、已发送任务或会话被中断，或现代无迁移startup也能持续覆盖，则应重新考虑P2；本轮未运行任务，既不声称发生这些后果，也不声称所有发送路径已被安全反证。

## 建议报告措辞与修复范围

建议主表描述保留“启动旧会话迁移完成后，旧项目快照覆盖新广播，刚添加的B从renderer消失；Main保留A+B，可由后续真实registry事件恢复”。优先级改P3即可，不需撤回R29或新编号。

保留原修复方向：让初始化与subscription使用共同revision/generation，或await迁移后再取最新registry并协调后发布；防止旧初始快照覆盖较新的广播。不要靠放宽Main项目/Session权限门禁或删掉legacy transcript durability safeguards来修UI投影。也不将现有alive flag当作版本围栏。

本轮仅提定级建议，不改任何主报告文字或数目。原始证据仍为desktop-round3 D12及quality-round10/project-recovery-control.test.tsx/.log；它们的既有执行与本轮0执行分账。

Completed — R29建议P3、缺陷保留；新增finding0，新增测试/原生/模型执行0。

第二十三轮[Recent菜单快照预审](menu-recents-preflight-round23.md)补清静态恢复条件：Open Recent必须已经包含目标项目的菜单项，或后续重装菜单使其出现；现代ProjectStore虽将新建项目投影到recents磁盘，但现有菜单没有随registry广播刷新的接线，不能承诺刚添加B立即可从旧快照菜单恢复。本项真实rename广播恢复仍已动态证明，R29/P3与原证据不变。
