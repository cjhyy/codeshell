# 第二十七轮：换主目录后摘要分叉的Files根映射

## R86 / F27-1 / P3：新主目录ID配上旧会话路径，健康根无法列出文件

触发条件：健康多根项目P有不重叠目录A/B，初始primary=A；普通持久化source固定绑定P/A。用户通过支持的Make primary把B设为primary，旧source按合同仍保持main/workspace=A。随后从source成功创建普通摘要上下文分叉target，在target首次续聊前打开Files。两目录仍live、mounted、trusted；不需要权限失败、删根、symlink替换、并发切项目或损坏状态。

实际结果：新target的Main authority正确返回继承workspace=A、无project/mainRootId；Files fallback把currentprimary **B.id** 配上 **A.path**，显示为B选项却发送 `fsRoot:readDir(P,B,A)`。Main正确按B授权后拒绝A越界，新主目录的文件不显示，切回B仍是错误配对；选A可正常读取。真实B通过正确P/B/B请求也正常，两份原件内容不变。这是单一渲染根映射问题，不是丢文件、所有根不可用或权限绕过。

最小审查位置：[FilesPanel.tsx:142](../../packages/desktop/src/renderer/panels/FilesPanel.tsx:142) / [145](../../packages/desktop/src/renderer/panels/FilesPanel.tsx:145)。无sessionMainRootId时fallback到project.primaryRootId，又用workspaceCwd覆盖该注册根path；得到B.id/A.path与A.id/A.path，B真实路径没有正确选项。[177](../../packages/desktop/src/renderer/panels/FilesPanel.tsx:177) / [190](../../packages/desktop/src/renderer/panels/FilesPanel.tsx:190)仍进入已实现的Project文件API。目录拒读被降为空树属于R65的既有反馈，不再拆新编号；补R65提示也不能修正这里的错误tuple。

## 正式入口与设计反证

1. [Sidebar Make primary](../../packages/desktop/src/renderer/Sidebar.tsx:219)经[Main trust/mounted校验](../../packages/desktop/src/main/project-authority-ipc.ts:140)后执行[ProjectStore.setPrimary](../../packages/desktop/src/main/project-store.ts:471)。[当代多根合同](../../docs/todo/multi-folder-local-project-plan.md:271)明确旧Session mainRootId/cwd/workspace不变，所以source main=A/currentprimary=B是合法状态。动态实验直接调用真实store；Sidebar、trust/setPrimary RPC及广播仅静态核对。
2. [普通summary入口](../../packages/desktop/src/renderer/MessageStream.tsx:322)在摘要成功后调用[实际Core publish](../../packages/core/src/session/session-manager.ts:2144)，[白名单](../../packages/core/src/session/session-manager.ts:2429)继承cwd/workspace而不复制project；[App注册选择target](../../packages/desktop/src/renderer/App.tsx:2018)，[打开既有bucket](../../packages/desktop/src/renderer/App.tsx:669)不额外发送run。首次run才补binding是明确迁移设计，缺binding本身不定为缺陷；R26 Review scope仍仅设计观察。
3. [Main authority](../../packages/desktop/src/main/session-workspace-service.ts:209) / [实际panel hook](../../packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.ts:92)保留A/null/ready；[SessionPanelDock](../../packages/desktop/src/renderer/app/SessionPanelDock.tsx:161)、[PanelArea](../../packages/desktop/src/renderer/panels/PanelArea.tsx:488)和[Registry Files](../../packages/desktop/src/renderer/panels/PanelRegistry.ts:118)给body最新完整project与该workspace。实验实际挂consumer/hook/Files，wrapper只传这组真实来源props；上游完整App/点击导航未运行。
4. 实际[preload目录API](../../packages/desktop/src/preload/project-authority-api.ts:100)转发三个参数。Main [初始index:6486](../../packages/desktop/src/main/index.ts:6486) / [latest:6492](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6492)的真实提取callback按[opaque根ID](../../packages/desktop/src/main/renderer-project-path.ts:73)取B.path，再交[FS containment](../../packages/desktop/src/main/fs-service.ts:30)；真实拒绝发生在readdir前。保留此安全边界，不能让Main接受任意renderer path。

建议在无持久mainRootId的fallback中保持注册rootId/path属于同一根，并单独表达会话workspace；只对匹配可信会话主根的项替换workspace路径。此证据不要求盲目复制fork权限，也不要求用户发一次模型请求来修复显示。

## 动态正常对照与恢复边界

- 同primary时，真实无binding summary target经Main/hook得到A/null，Files项目模式读A/A并显示unique-a.txt；lazy状态本身并非普遍失败。
- Make primary后，真实已绑定source仍authority=A.id；实际Files的Session模式读A和B都显示各自独有文件，排除两目录健康或Make primary本身故障。
- 候选target默认实际请求P/B/A，被真实FS拒绝；selector保两个真实ID。选择A显示unique-a.txt，选回B仍不显示unique-b.txt。直接真实preload/Main/FS读P/B/B成功，B原件可读。
- 用实际Core writer给owned target显式补P/A，再remount后Main authority=A.id，Files经Session API读A/B正常。这仅是**内部binding正常控制**，没有运行真实首send，不称公开修复动作或当前挂载面板即时刷新。真实普通send的[Main解析](../../packages/desktop/src/main/agent-run-metadata.ts:118) / [Core补绑](../../packages/core/src/engine/run-session-open.ts:88)仅静态支持。
- 真实读回A/B原件各等于 `A original\n` / `B original\n`。完整blank App会先materialize UI sid的边界未运行；没有blank动态断言，不把裸组件cwd=B/no-engineId合同控制外推完整入口。

## 执行与来源分账

| 执行 | 实际结果 | 证据 |
| --- | --- | --- |
| 作者首次latest | 1 test / 29 Bun expect / 0 fail / Completed | [日志](validation/original-file-root-round27/first-authorized/first-authorized.log)、[观测](validation/original-file-root-round27/first-authorized/observed.json) |
| 主审独立初始84740 | 同源1 test / 29 Bun expect / 0 fail / Completed | [日志](reproductions/file-root-round27/file-root.test.ts.log)、[观测](reproductions/file-root-round27/observed.json)、[清理](reproductions/file-root-round27/cleanup-receipt.json) |
| 主审独立最新a66f | 同源1 test / 29 Bun expect / 0 fail / Completed | [日志](validation/latest-a66f4ef2/file-root-round27/file-root.test.ts.log)、[观测](validation/latest-a66f4ef2/file-root-round27/observed.json)、[清理](validation/latest-a66f4ef2/file-root-round27/cleanup-receipt.json) |

最终source SHA256 `28f4202efc90bedbd67f39f60bd7e9370a3b8557872ae841edb856e3720a13d2`，guard `6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d`。三run均51source、4resolve-only、2实际AST callback、3coding mock地址、10owned nonGit adapter calls、15API calls与5组观测；这些结构计数不是测试数或loaded graph。两callback原箭头SHA分别2820bebc...与a94993aa...，完整原文/精确行号/依赖在observed中。进程内guard在Core import前检查maintained私有HOME，拒绝网络/child/Worker/Bunspawn；attempts[]、owned清理无error，HOME与runnerroot均确认删除。非OS万能sandbox。

实际Core dist SessionManager/Transcript/selectContextPackage/createSummaryFork，真实ProjectStore/SessionCwdIndex、Mainauthority/registrar/preload、consumer/hook/Files及真实validator/FS均运行。summary文本是已成功输出替身，source binding是实际writer setup，未构造Engine；内存IPC、store.list registry DI、DOM/React handler/panelwrapper明示。Git折叠DI与精确owned A/B标准nonGit error adapter无真实Git；其它coding exports原样，五UI叶子alias转发真实exports，不替换业务。Sidebar/trust/summaryRPC/App/Electron/真实blank/首send/模型/provider/worker/网络均未动态执行。

[55d3准备原件](validation/original-file-root-round27/prepared-initial/file-root.test.ts.txt)从未执行，不是首次失败。本轮首次即通过，没有rerun或执行后改源；准备前仅收窄Gitcatch与mock地址，业务test/断言/cleanup/guard相同，见[预审](file-root-fixture-preflight-round27.md)。Node assert未另计、native增量0；新增通用1文件1测试，每冻结基线29个Bun expect，作者与root重复不叠加。当前正式86项=1P1/52P2/33P3，通用86文件251测试。

与R22、R58、R65、R69分别去重；[标题双来源](sidebar-title-observation-round27.md)只保设计/体验观察、不新增正式项。完整[执行收据](validation/round27-file-root-results.json)、[独立最终质量稿](quality-round27.md)、[历史静态反证](file-root-quality-preflight-round27.md)及[作者原稿](validation/original-file-root-round27/report.md)保留。
