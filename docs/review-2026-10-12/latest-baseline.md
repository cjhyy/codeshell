# 0.9.33 主分支差异复查

01:30（Asia/Singapore）拉取发现 origin/main 从初始审查基线 `84740d56e55517b004948a0a0e07649ad6fbf998` 更新至 `a66f4ef291f304ee4df9da8095a90671d9a8f140`，版本 0.9.33。主要新增 Panel 稳定项目身份与共享 Collection 跨文件查询，另有发行记录和版本号更新，共 54 个路径变化。没有将新产品代码合入原报告分支。

新隔离工作区：`/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，分支 `codex/review/latest-20261012`。原始报告与证据继续保留在 `server-desktop-review-20261012/codeshell`。两者产品均无手工改动；Desktop build 自动生成的 tracked extension bundle 已核对并只还原该构建产物。

## 已完成验证

| 范围 | 最终结果 | 记录 |
| --- | --- | --- |
| frozen install、workspaces build、Desktop build、typecheck:workspaces | 全部通过 | `validation/latest-a66f4ef2/{install,build,desktop-build,typecheck}.log` |
| 8 个新增或修改测试文件 | 156 项实际执行、0 失败、0 跳过 | `validation/latest-a66f4ef2/changed-test-results.json` |
| 既有便携缺陷表征和正常契约 | 58 文件、186 测试、0 失败、0 跳过 | `validation/latest-a66f4ef2/reproduction-results.json` |
| 凭据实际 Electron/IPC/store | 4 场景通过 | `validation/latest-a66f4ef2/credentials__credentials-e2e.mjs.log` |

复现“通过”表示当前仍观察到被测缺陷。58 个文件并非 58 项问题，一份文件可能覆盖多项发现，也包含正常对照。新快照结果没有加到原基线 6286 个现有测试的总数中，以免重复计数。

## 两处测试入口适配

1. Panel bindGuest 从同步改为异步，原 VM fixture 未提供 AbortController 和可重复检查的 owner/guest 身份，首次新快照跑失败。仅改审查 fixture，使它同时支持同步和异步接口，并提供稳定的模拟身份。原基线、新快照均重跑通过。生产方法仍在进入新 scope resolver 前拒绝合法 secondary root，R22 未被修复。
2. `packages/desktop/tests/panel-app-main.test.ts` 必须经 `panel-app-protocol.test.ts` 子进程入口设置内部标记。直接 guarded 运行注册 69 项但全跳过；环境变量直接传入也会被外层隔离器清除。随后运行正式 spawner 成功，并用同样子进程机制的 `validation/panel-fixture-counts.test.ts` 展开日志，确认 69 pass、0 skip。最初的跳过日志保留，最终结果指向 `panel-fixture-expanded.log`。外层仍使用 guarded runner，子进程继承其隔离 HOME 和无凭据环境。

## 适用范围

主报告 R01–R48 的源码行号仍指初始基线；新快照可能因新增 import/声明发生行号偏移。既有便携证据和实际凭据 UI 场景在 0.9.33 下仍成立。R21 的二次验证复用初轮真实 native Hub 捕获，并执行新快照的生产恢复函数与 replay；本轮没有重新宣称完整原 native Hub smoke 已通过。

凭据脚本原始 observations 中保留了 fixture 作者写死的 `84740d56` 标签；本次实际执行入口、工作区和构建为新快照，已在 `validation/latest-a66f4ef2/summary.json` 单独记录，避免将旧标签误认成运行目录。模拟 Cookie 和 plain cipher 回退等限制与原附录相同。

第六轮已确认共享 Collection 恢复指引 R49/P3、旧录音生命周期缺陷 R50/P2；Panel scope 没有正式新增，R22仍适用。新功能的2文件7测试另见 latest-reproductions/，录音9测试已在两基线分别通过。第七轮身份/连接正常契约 3 文件13测试、Agent Plugins 1文件7测试均已在两基线通过，R51–R53 是旧缺陷新发现；不把旧基线尚无的新功能测试塞入默认入口。

第八轮 Quick Chat R54/P3 及其正常对照7测试也已在两快照分别通过；正式范围限定已送达组件的内部图片 payload，未实测原生跨窗口拖动。更新器 shutdown 候选因平台模拟不符未列正式发现。

第十轮新增六份便携正常/恢复控制，两快照各14测试112断言通过；原有发现新增0，R11/R19依据实际门禁降P3并收窄。总通用46文件125测试。Core关闭28测试和审批正常20测试为现有套件专项复跑，另存validation，不计入该便携总数。

第十一轮新增通用4文件8测试108断言，两快照分别通过，当前50文件133测试。stable scope恢复对照另1文件1测试9断言仅新快照，总新功能专项3文件8测试。真实Electron搜索UI与下载恢复native smoke均仅新快照执行并单列，不加入Bun计数。R55/R56两快照复现；R57原生实验仅a66f，关键5文件旧新diff为空。

第十二轮文件传输、导出、图片保存与磁盘导入正常控制：新增2个通用文件5测试136断言，两基线分别通过；正式新增0。通用总52文件138测试。Bun取消诊断超时单列为不确定harness结果，不计通过或Node产品缺陷。

第十三轮终端、首次提交Review、侧栏删除、多窗口目录与配对Web离开审批：新增6个通用文件48测试304断言，两基线分别guarded通过；当前通用58文件186测试0fail/skip。新正式R58/P2、R59–R62/P3，均旧实现本轮新发现，未归因于0.9.33变更。多窗口33个既有保护测试通过wrapper计在6文件中，不额外再加一次。
