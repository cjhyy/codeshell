# 第二十六轮：会话分叉、重试、导出及账号续接静态审查

本轮新增正式问题0、新增动态执行0；当前85项（1P1/52P2/32P3）、通用85文件250测试保持。两冻结产品树未改动，没有重跑旧测试、产品import、真实Git/Engine/provider/worker/Electron、账号、网络或模型摘要。既有测试只读源码，不当成本轮通过收据。

## 分叉后的Review覆盖：设计/体验观察

普通Desktop[上下文摘要分叉入口](../../packages/desktop/src/renderer/MessageStream.tsx:322)成功后，实际[Core publish](../../packages/core/src/session/session-manager.ts:2144)用[白名单](../../packages/core/src/session/session-manager.ts:2429)继承cwd/workspace/model/provider/origin，不复制现代project；[App注册](../../packages/desktop/src/renderer/App.tsx:2018)仍把target放入原sidebar项目。首条续聊前，Main对无binding目标给[legacy单根Review](../../packages/desktop/src/main/session-workspace-service.ts:396)，范围可暂时少于source项目的多个独立仓库。这里只读推导，没有执行一个summary或打开真实Review。

[普通空白会话](../../packages/desktop/src/renderer/App.tsx:315)也在engineSessionId为空时[隐藏Review](../../packages/desktop/src/renderer/panels/useReviewAvailability.ts:140)；[既有Session的authority合同](../../packages/desktop/src/renderer/sessionUiAuthority.ts:56)不继承renderer bucket权限。[迁移设计](../../docs/todo/multi-folder-local-project-plan.md:187) / [普通fork首run规则](../../docs/todo/multi-folder-local-project-plan.md:217)明确首次run才合法回读/补绑。缺少首send前必须聚合全部根的合同，所以不列R86/P3；不声称永久丢项目、错cwd或运行失败。后续合法send的[Main resolver](../../packages/desktop/src/main/agent-run-metadata.ts:118)和[Core补绑](../../packages/core/src/engine/run-session-open.ts:88)是静态正常恢复链，不是本轮已运行或建议用户付费修复的路径。

体验建议：如果产品希望用户立即审阅项目全部仓库，可先明确可信fork结算时的项目身份与Main校验规则；现状可提示Review暂只覆盖该会话工作目录。不要让renderer路径直接授予项目全部根。[独立最终反证](fork-authority-quality-round26.md)保留初始候选被收紧的历史。

[FilesPanel](../../packages/desktop/src/renderer/panels/FilesPanel.tsx:140)在无sessionMainRootId时仍用正式project API；source main等于currentprimary的普通场景保多根，不把Review条件推成Files全部失败。[子审原稿](validation/original-session-continuation-round26/fork-binding-counterreview.md)还保留source main≠primary时可能rootId/path错配的未验证边界，本轮没有升项。

## 其他正常保护

- summary [操作代与source检查](../../packages/desktop/src/renderer/MessageStream.tsx:323)、[App选择保护](../../packages/desktop/src/renderer/App.tsx:2027)及[二次激活检查](../../packages/desktop/src/renderer/App.tsx:2072)限制迟到影响；Core成功摘要后才原子发布。R55导航迟到与R74取消问题仍独立保留，不重复。
- Quick Chat full fork的[nonce/claim处理](../../packages/desktop/src/renderer/app/usePanelBuckets.ts:239)保留迟到清理、当前nonce错误与独立snapshot语义；没有找到普通顶层full按钮，不扩大入口。
- history失败不落入空白英雄分支，[ChatView错误/Retry](../../packages/desktop/src/renderer/ChatView.tsx:1507)与[未hydrate重试](../../packages/desktop/src/renderer/app/useTranscriptBuckets.ts:435)存在。分页读取保generation与旧状态；没有把只读源码当重试动态通过。
- [Hub export静态原稿](validation/original-session-continuation-round26/hub-export-static.md)：固定entry.sessionId的href、workspace/project、paired principal及generation复核；有界只读快照、格式/损坏/忙状态及finally释放正常。未运行浏览器下载错误UI；R76同源running缺口不再编号。
- [Cloud账号核查](cloud-account-static-round26.md)：取消generation与晚到grant/revoke门禁、refresh singleflight及持久化、MainFrame授权、logout在远端await前本地clear/广播均有源码反证；单HTTP15秒不是整个流程总上限，远端撤销不确定明确反馈。没有真实账号/OAuth测试，与R38配对Web退出根因不同。

## 来源与未执行计划

[主审静态manifest](validation/original-session-continuation-round26/source-manifest-static-final.json)为29路径，28整文件双冻结相同；Main index整文件不同，但review:status block同SHA、分别保存primary6288/latest6294行号。独立fork28sources、Cloud10sources、Hub/Files子审互有重叠，不累加成动态覆盖或module-cache/import graph。

[PLAN原件](validation/original-session-continuation-round26/PLAN.md)准备于最终反证之前，只是候选可行性；[guard原件](validation/original-session-continuation-round26/network-guard.unexecuted.ts.txt)仅复制未安装执行，没有可执行fixture。没有Bun pass/expect/Completed、Node业务assert或native增量。作者[最终静态报告](validation/original-session-continuation-round26/report.md)、[独立结论](fork-authority-quality-round26.md)与[分账收据](validation/round26-static-review-results.json)保留；正式85/250不变。
