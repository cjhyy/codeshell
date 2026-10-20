# CodeShell 第十一批审查记录

冻结源码：`b8b776d56e5982e59b18de0262d5c49367746625`。本批审查组合配置、Hook 数据解析、Chat 普通格式/通知进度、Host 普通目录与同步生命周期。确认 **1 项 P3**，保留 **2 个候选**。只记录，没有修产品；全仓持续审查仍未完成。

**[CHAT-R11-01](chat.md)：通知进度初次读取失败的 rejected Promise 被缓存，阻断同一 watcher 的自动恢复。** 真实 progress、relay 和 watcher 原型方法在内存 store/fake adapter/page/sleep seam 下重试 3 次，只调用 load 1 次，send 0 次；同一 healthy store 用新 handler 能继续。正常初次 load、同实例 save/flush 恢复构成对照。生产 CLI/Desktop 的一次 handler 装配与 File store 非 ENOENT 传播仅静态追踪；未诱发真实 OS 读取故障、构造 client、读取 descriptor、发网络或发送实际消息。不称永久丢失，cursor 保持在原事件。

| 候选 | 分类与缺少的证据 |
| --- | --- |
| [HOOK-R11-C1](hooks.md) | 真实 HookRegistry 在合成 mid-emit 注册时序中重复执行旧 handler；缺正常生产时序与明确可见性/单次执行契约，不扩大为 Engine 重复注入 |
| [CHAT-R11-C1](chat.md) | Markdown URL/标签转义静态疑点；官方平台资料读取失败后 SKIP，没有换 parser 或补 fixture，不确认具体平台渲染错误 |

[组合配置报告](composition.md)与[Host 报告](host.md)均为 0 项新确认、0 新候选；正常声明拷贝/冻结/投影和同步生命周期控制通过。Topology digest 正文排除是设计，caller-owned service 引用是旧 HL-C1，都未重复登记。

**首次验证：7 个 clean guarded shards，42 pass、619 expect、0 fail、0 skipped；21 项既有 baseline + 21 项 focused observations/controls。** 所有 raw combined stdout/stderr 和退出码先保存后查看，没有失败的 Bun shard或产品重跑。Characterization 通过不表示产品已修复。查看[正式缺陷](findings.json)、[候选与静态观察](candidates.json)、[验证汇总](validation.json)、[冻结源码 SHA](source-manifest.json)和[材料索引](evidence-index.json)。

历史结构化查重涵盖全部 `docs/`、`bugs/` 的旧 audit/review/archive/_archive。Root/Hooks 统计为 1,045 Markdown、556 parsed JSON（共 1,601 文件，0 parse errors）；Chat 保留早先 1111 命名子集与后来全量 1601 补充的范围差异，Host 另注明 nested archive 范围。旧 instruction order、composition/lifetime、HL-C1、通知映射/ACK/FIFO、平台上限等排除。关键词/散列查重不代表全历史逐行语义穷尽。

静态猜测文件/目录/glob、官方资料访问失败均标记并跳过相应方向，与真实测试日志分开；未用替代产品验证恢复旧失败路线。Root 含管道的首个导航工具整体 exit 0 但部分 rg 路径失败，也在[转录](evidence/root-navigation-skip.md)中准确区分。错误地址不会被当成产品文件缺失或已读源码。

四份只读交叉复审：[Chat](evidence/cross-review-chat.md)、[Hooks](evidence/cross-review-hooks.md)、[Host](evidence/cross-review-host.md)、[组合配置](evidence/cross-review-composition.md)。复审没有新增测试或产品修改；Chat 全量历史补充及最终 16 件 artifact delta 亦经核对。[最终材料检查](evidence/final-quality.md)记录日志、来源、收据和整合边界。

整合前 main 前进至 `9cbd3a34c8c3249d87a2a31b2edf538e0448c365`，8 个路径属于其他任务的 Desktop acceptance harness、AppImage/startup、CI 和文档。首次完整 snapshot 相等检查因此拒绝继续，已保留[metadata 诊断](evidence/root-integration-refresh-note.md)和[当时状态](evidence/integration-current-observed.json)，随后仅快进当前任务分支。本批直接缺陷/候选源码未变，见 [main source review](evidence/main-source-review.json)。[初始](evidence/integration-before.json)与[最终整合前](evidence/integration-before-final.json)快照的原有删除、tracked/staged diff 和全部 4 个未跟踪文件字节保持一致，没有恢复旧 HEAD 或覆盖其他任务。

本批没有真实模型、付费 API、账号、用户数据、外部消息、原生应用/PTY、认证/权限/security/custody/watchdog 实验，没有共享 dist/依赖重建或全仓 build/typecheck/lint/test 声明。选定源清单不等于完整传递依赖/全文件覆盖；另一个 `codeshell-panel-apps` 仓库未在本批全量审查。
