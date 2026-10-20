# CodeShell 第十八批审查

冻结源码：`65691923fa629970ac26dc04e35362a9c4ab57a8`。本批审查 Web trace 展示/查询、未读集合及普通环境描述形状。**0 项新增确认缺陷、1 项候选、0 项新增旧问题关联。** 仅写记录，没有修改产品；持续全仓目标仍在进行。

候选 **[UNREAD-R18-C1](unread.md)**：普通列表响应在浏览器导航 guard 之前清掉 server active session 的未读标记。实际纯 helpers 加手工镜像的列表组合，可清掉后台 B，同时镜像导航谓词拒绝从 A 切到 B。`useRemoteApp` / producer / 跨标签页时序均只静态读，没有实际 hook/UI 复现，不能声称消息丢失、错误导航或真实页面已丢标记；因此不定严重级别。[findings](findings.json) 为空，[candidates](candidates.json) 逐项保留限制，[related](related.json) 为空。

其他范围未得新违例：[presentation](presentation.md) 的类型/中英标签、wire/request/media/external/event 边界；[trace API](traceapi.md) 的普通参数/Unicode 编码、查询/path 与内存 payload 透传；[environment](environment.md) 的正常 descriptor 形状。Environment 以前已有完整静态审阅，本次补实际 metadata 对照，不称此前未读。API 自有 page/detail 只是部分对象的透传观察，不是 Host schema 验证；首个 fixture 标题说四条路径但实际四次调用两条路径，原 fixture/raw 未改且已在专项明确披露。

4 组 **首次 guarded Bun shards** 全部完整结束：**33 pass / 138 expect / 0 fail / 0 skip**。其中 **5 个既有 Web presentation 例子 + 28 个聚焦观察/对照**；32 项直接叶子测试、1 项明确手工镜像的未读调用组合。combined stdout/stderr 和 exit 在查看前先保存，没有产品重跑。通过说明当前观察/控制成立，不表示全系统通过或候选已修复。[validation](validation.json) 保存实际命令和边界。

动态仅有直接叶子 helpers 和内存 requester/Sets/metadata。Core type/classification/context、Host/backend/存储、React/真实 producer/consumer 为静态；没有导入 i18n 或恢复旧 backend/i18n/approval/replay/Question 等已跳过动态方向。混合 auth/scope、approval/replay、环境导航测试没有运行，也没有用它们的源码片段冒充执行。

全历史查重覆盖本批外 docs/bugs **1,148 MD + 847 parsed JSON = 1,995 文件**，含存在的 archive/_archive；**253,680 字符串叶子**，部分专项另统计 **353,952 全标量叶子**，口径分开，0 JSON 解析错误。匹配数与保存上下文 cap 分开，不作语义穷尽证明。查重库存冻结于 main 同步前，后续验收文档变化另存 [基线更新](baseline-refresh.md)。

四份只读复核：[Presentation](evidence/review-presentation.md)、[Trace API](evidence/review-traceapi.md)、[Environment](evidence/review-environment.md)、[Unread](evidence/review-unread.md)。[source manifest](source-manifest.json) 固定 38 个去重选定 source/contract 路径、44 次逐 worker 源码核对；[worker integrity](worker-integrity.json) 核对 36 份 worker artifacts。不存在的猜测目录/报告显式排除，整文件 SHA 不代表整文件或所有依赖覆盖。[evidence index](evidence-index.json) 记 bytes/SHA（自身除外），raw 原样保留；metadata 导航、范围更正及输出截断均有记录，不当 Bun/product failure。

最终 [汇总只读复核](evidence/review-aggregate.md) 无阻断意见；[Root evidence 复核](evidence/root-qc.md) 记录提交前检查要求及元数据措辞校正。另一路旧 **DESKTOP-R12-C1** Write 字节标签源码变化单列于 [addressed-sources](addressed-sources.json)，不计本批发现/关联/复验修复；只有这份额外旧源与当前/main 不同，本批 helper/worker source pins 未变。primary 原有 dirty/untracked 字节保留，没有真实模型、付费 API、账户、用户数据、外发消息、产品网络/native/PTY/auth/permission/security/custody/watchdog 实验，没有共享 deps/dist rebuild、full build/typecheck/lint/suite/E2E 主张。独立 codeshell-panel-apps 仓库未作本批全量审查。
