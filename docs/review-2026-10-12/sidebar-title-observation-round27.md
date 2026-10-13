# 第二十七轮子主题：侧栏与历史页的命名体验观察

本子主题新增正式问题0、产品/fixture/native执行0，没有编写或运行测试。静态阶段正式85项、通用85文件250测试保持；后续同轮其他领域以主报告为准。只读两个冻结树的源码、设计与现有测试，未把旧测试代码当动态通过。

普通原生会话在[侧栏重命名](../../packages/desktop/src/renderer/Sidebar.tsx:317)后，当前[handler](../../packages/desktop/src/renderer/app/useSessionNavigation.ts:223) / [metadata写入](../../packages/desktop/src/renderer/transcripts.ts:1017)只更新catalog的title/titleManual。实际catalog字段patch及广播存在，改名会持久保存并同步侧栏，不是写盘失败。

[历史页refresh](../../packages/desktop/src/renderer/sessions/SessionsView.tsx:51)读Core会话标题及另一套标题override；本页[filter](../../packages/desktop/src/renderer/sessions/SessionsView.tsx:96)也按该map匹配。所以新侧栏名称只在catalog时，历史行/本页名称搜索可与侧栏不同；正常刷新仍读原来源。普通[全局标题picker](../../packages/desktop/src/renderer/shell/SessionSearchModal.tsx:54)直接读catalog，新名可用，不能说所有搜索失效或会话找不到。

反方向，[历史页改名](../../packages/desktop/src/renderer/sessions/SessionsView.tsx:121)等待Main保存override后，经[history sync](../../packages/desktop/src/renderer/app/useSessionHistorySync.ts:46)按canonical engine id回填所有loaded sidebar aliases。自动标题还[保护titleManual](../../packages/desktop/src/renderer/app/useHostSubscriptions.ts:348)，不会自动覆盖侧栏手改名。这些是源码正常控制，未运行用户改名或真实窗口实验。

[旧自动标题设计](../../docs/superpowers/specs/2026-06-01-llm-session-title-design.md:19)明确将SessionsView另一套标题存储排除在当次改动范围；这只证明历史feature边界，不能证明手动名称永远应不同，也不是当代统一命名的合同。没有找到足以正式判为P3的统一所有rename入口要求，故保留设计/体验观察，不加入正式编号。R46自动化历史认领、R71项目重命名拒写、R61跨窗选择及R75模型偏好覆盖保持各自根因。

体验建议：明确侧栏操作是局部昵称，或让同一会话的手动命名在侧栏与历史页一致。若统一，应保留尚无engine id的草稿及兼容UI aliases，不能把UI id直接当持久会话身份。无需为确认现有双来源设计而启动模型或额外fixture。

作者[完整阶段稿](validation/original-sidebar-title-round27/static-preflight.md)、[来源清单](validation/original-sidebar-title-round27/source-manifest.json)、[子审正常反证](validation/original-sidebar-title-round27/static-counterreview.md)与[独立质量原稿](validation/original-sidebar-title-round27/independent-quality.raw.md)均保留。独立20份产品/设计文件双基线同SHA已逐项核真；Main整文件有版本差异，分别核callback，不当模块加载图或动态验收。此子主题新增正式0/执行0，不改变通用测试数。
