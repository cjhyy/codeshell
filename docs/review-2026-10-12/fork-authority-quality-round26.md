# 第二十六轮：fork项目范围的独立最终反证

最终判断：新增正式发现0、产品/fixture/native执行0，正式85=1P1/52P2/32P3、通用85文件250测试保持。成功summary target首次发送前未绑定project，Main按legacy单根解析Review，保留为体验/设计观察。旧阶段的P3候选判断已由后续更强反证收紧，不计入正式表。

[最终独立原稿](validation/original-session-continuation-round26/independent-fork-quality.final.raw.md)给出28项双冻结同SHA来源及完整真实入口；[初始稿](validation/original-session-continuation-round26/independent-fork-quality.static-initial.raw.md)和[追加反证中间稿](validation/original-session-continuation-round26/independent-fork-quality.static-with-counter.raw.md)逐字保留。原稿包含静态阶段推理，最终不收录判断优先，不以历史候选评级覆盖它。

空白新会话的[Review门禁](../../packages/desktop/src/renderer/panels/useReviewAvailability.ts:64)也在首次send前不可用；[renderer authority合同](../../packages/desktop/src/renderer/sessionUiAuthority.ts:56)和[Main Review合同](../../packages/desktop/src/main/session-workspace-service.ts:391)明确既存Session以持久化binding为权威、legacy只给单根。[多根迁移设计](../../docs/todo/multi-folder-local-project-plan.md:217)明确普通rendererfork首次run才单点识别/补绑，旧fork白名单没有现代project字段。没有证据足以排除这种有意授权过渡，确认现象的fixture也不会补足产品合同，因此停止准备，没有执行guard或创建可执行fixture。

[Files独立反证](validation/original-session-continuation-round26/fork-binding-counterreview.md)仅对source main仍等于当前primary证明正常project API fallback，多根可选择。source main≠current primary的rootId/path条件边界另待审查，不从此轮正常控制泛化。首send恢复、模型摘要、App/Electron和Git均只读源码而未运行。

[本轮整合报告](session-continuation-round26.md)列出体验建议、scope和未执行计划；云账号另有[独立结论](cloud-account-quality-round26.md)。
