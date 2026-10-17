# 独立只读复核：Context / Coding

复核者：settings 专项 agent。冻结产品基线 `4ee32f28f78b8315112cca77cfc22b2f2f80ced6`。按 root 追加分工阅读 `context.md` / `coding.md`、三份 fixture、首次原始日志、退出码和收据，并核对相关当前实现与调用方。**本复核新增测试执行 0**，未改产品或他人报告/fixture，未重试或换方法。

结论：支持 **CTX-1、CTX-2、CODING-R4-01、CODING-R4-02 共 4 项独立 P2**，保留现有触发条件和动态范围。它们不是本复核新增发现，也不重复计入总数。

| 项目 | 复核判断 | 关键限制 |
| --- | --- | --- |
| CTX-1 | 默认 snip 的 first-N 边界不调整，源码注释却承诺两边界保持工具对；完整原始输入经过真实 manager 后变成不完整序列，真实 TurnLoop 将它发送给两次 fake model，晚期 cancellation 补齐不能恢复原成功结果。支持 P2。 | provider 拒绝由 fake model 调用 Core 的真实 validator 实现，真实 Anthropic 只核对转换源码，不能称已实测真实 API 拒绝。 |
| CTX-2 | 普通 summary builder 对数组 tool_result.content 序列化为空，真实 toolResultToBlock 允许该格式；真实 automatic summary 与 range archive 均遗漏唯一事实，scalar 与 portable serializer 正常。支持 P2。 | 不把 summary 丢事实扩成 transcript 删除；MCP text+image 是源码确认的生产 producer，本轮只有 text-only structured fixture，未启真实 MCP/模型。 |
| CODING-R4-01 | 真实 formatter 对普通 Location 的 file URI 只删 scheme，保留 `%20` / UTF-8 / `%25` / `%23`，返回路径与自有真实文件不一致；Definition/References 同根因合并恰当。支持 P2。 | 没有 GUI 导航或真实语言服务器；Windows/UNC 仅未覆盖。现有 rootUriToPath 正常控制避免将旧 manager finding 重复计入。 |
| CODING-R4-02 | 同一 workspace manager 复用 ready client，工具每次发送 didOpen version 1，整个工具没有 close/change；严格 adapter 保留首次内容后返回旧诊断，证明该 adapter 下的陈旧行为与实际非法通知序列。支持 P2。 | “具体真实服务器一定保留旧诊断”不成立，报告已限定可能行为。10 秒不发布分支未执行，不另计 finding。LSP 3.17 合同依赖 root 已核对的官方源，本复核未另行联网获取。 |

## 当前合同、可达性与反证

- Context：复核 `compaction.ts` 的 snip、summary builder、portable serializer，`manager.ts` 的 automatic fallback 与 range archive，TurnLoop 的 manage→model→error repair 顺序、toolResultToBlock，以及 Anthropic conversion、MCP wrapped text+image producer、Transcript ordered-pair validator。`assembleRunMessages` 可前置 userContext；加上原用户请求，fixture 的 tool call 落在第三条消息是正常可达形状。fake hooks 只是普通空适配器，没有执行 hook 进程。
- Coding：复核整个 `tools/lsp.ts`、client 初始化能力、manager ready-client 与 cwd cache、shutdownAll、root URL helper、Coding capability 注册。fixture 在真实 manager 上替换 getClient，constructor 只注册配置；没有走 isCommandAvailable/startServer，没有语言服务器子进程。LocationLink 与 hierarchical symbols 都未被当前能力广告确证，保持候选而不扩充发现数是正确的。
- 没有将 fake adapter 的业务结果提升为真实提供方/服务器实测，没有将相关性推断为跨进程或 native app 证据。当前报告对自动/manual/range/archive 的动态和静态接线区分清楚。

## 证据计数与去重精度

读到的首次原始日志与退出码、收据一致：Context 两文件 **4 pass / 29 expect / 0 fail、skip / exit 0 / Completed**；Coding 一文件 **8 pass / 32 expect / 0 fail、skip / exit 0 / Completed**。本次只读哈希核验 Context 的两份 fixture / raw log 及 Coding receipt 所列 dedup、fixture、raw log、exit 文件，均匹配。这里不加一次“复核测试”到任何执行总数。

Coding fixture 的 beforeExit 注释声称会记录观察 payload，但首跑未触发该事件；报告和收据已经明确披露，故以现有断言、fixture 与原始日志为证，不要求为补输出而重跑。

已读 dedup 收据中的输入覆盖与结论，并针对旧 `docs/archive` / `docs/review*` / 前三份 audit 检索 snip/prefix/pair/structured summary；阅读旧 Core context 文档、July 状态机/清理说明、October context-recovery/cancel 报告和 image-number 历史发现。没有看到同根因既有条目。旧 image 编号漂移被明确排除；旧 LSP manager cwd URI 转换和旧 diagnostics 固定等待 2 秒/未收集通知与当前两个 consumer 根因不同。此结论限于已覆盖的历史文档与检索，不声称证明所有未记录历史都不存在。

两份原报告的候选、旧 bug 与未执行方向未混入确认数；当前证据足以保留四项，不需要额外模型/网络/语言服务器实验。
