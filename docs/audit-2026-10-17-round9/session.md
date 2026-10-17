# Session transcript / fork 数据审查

冻结源码：`248d091202869c07274adedf4fd50403105f1b1f`。本方向新增 **1 项 P3（SESSION-R9-01）**。3 个独立首跑 guarded shard 共 **33 pass、152 expect、0 fail、0 skip**：4 个新 focused tests/controls，29 个既有 baseline。产品代码未改。

## SESSION-R9-01 · P3 · 超出工具批次上限后，正常完成的 transcript 无法 full fork

**触发和实际后果。** 完整模型响应一次返回 26 个合法工具调用，TurnLoop 使用当前 Engine 默认上限 25；fake client 后续正常返回 `done`。实际 live 第二次请求和最终返回的 Message[] 都有完整工具配对，且只执行前 25 个 fake tool。实际落盘 transcript 却含 26 个 provider `tool_use`、25 个 metadata `tool_use`、25 个 `tool_result`。随后实际 `SessionManager.fork("source")` 从同一临时 JSONL 读取并抛出 `Fork provider history inserts a message before pending tool results`，无法创建 full fork。

**原因。** [ModelFacade.recordResponse](../../packages/core/src/engine/model-facade.ts#L294) 遍历全部 response.toolCalls 并在 :303 写入 assistant message。TurnLoop 在 facade 返回后才 [slice 到上限](../../packages/core/src/engine/turn-loop.ts#L1634)，仅给执行集合写 metadata (:1659) 和结果 (:1684)。被丢弃的调用只在 live working messages 中被去除并追加提醒，之前持久化的 assistant 事件没有相应闭合或替换。实际 fork 在 [验证入口](../../packages/core/src/session/session-manager.ts#L2330) 使用原始事件投影，并在 [pending results guard](../../packages/core/src/session/session-manager.ts#L2548) 拒绝后面的 assistant answer。validator 正确发现不完整历史；根因在上游记录集合与执行集合不同。

**正常控制。** 相同组件、相同上限，响应只带 25 个调用时，live 正常完成、落盘配对完整、实际 full fork 成功。26 个调用的 live history 完整、源 JSONL 在失败 fork 前后字节不变，也排除了 live cap 不工作和 fork 改写源历史的解释。

**动态范围。** [fixture](evidence/session-call-cap.test.ts) 运行真实 ModelFacade、TurnLoop、StreamingToolQueue、ContextManager、Transcript、SessionManager。client 是内存静态响应 seam；executor 只返回 `owned fake result`，没有调用真实工具。实际错误来自生产 SessionManager，测试按现状断言错误和正常控制，不是修复回归测试。[首跑原始输出](evidence/session-call-cap.first.log)、[先保存的 exit receipt](evidence/session-call-cap.first.exit.json)：2 pass、18 expect、Completed。

**生产可达性和限制。** [Engine 默认上限为 25](../../packages/core/src/engine/engine.ts#L3535)，[实际运行 wiring 创建同一 facade](../../packages/core/src/engine/run-accounting.ts#L105)，[Engine.forkSession](../../packages/core/src/engine/engine.ts#L1281) 直接委托 SessionManager；[协议 full fork consumer](../../packages/core/src/protocol/server.ts#L1632) 使用该入口。这些连接仅源码核对，未跑完整 Engine、真实 provider/LLM、RPC、Desktop 或 TUI。特别是 [普通 resume 会调用 patchOrphanedToolUses](../../packages/core/src/engine/run-session-open.ts#L126)，所以 **不主张下一次 send 必然失败、工具真的执行了、数据丢失或永久无法继续**；本 finding 限定正常完成历史的 full fork 被阻断。未动态验证 truncated response 分支，也不把同一记录风险拆成第二项。

**去重和修复方向。** B-3 旧审查讨论的是 live cap 和未执行调用提醒；现有 `turn-loop-tool-cap.test.ts` 也用无写入的假 transcript，覆盖不了真实 facade 的提前持久化。此次记录的是不同的持久化/fork 后果。建议使有效 assistant 工具列表与最终执行或明确终止集合保持一致，或为被丢弃调用记录一致的 provider 和 metadata 终止状态，同时保留原始响应审计。

## 其他实际核对与已排除内容

- [结构化结果与冻结数据控制](evidence/session-roundtrip-controls.test.ts)：实际磁盘 reload、selected inclusive range、full fork 对两个配对工具结果（scalar + text/image structured 内容）保持一致；修改 replay 和 selected package 不改写原 transcript，fork 分配新事件 id。图片仅作序列化元数据，不验证图像解码/渲染。首跑 2 pass、11 expect，[原始输出](evidence/session-roundtrip-controls.first.log)。
- 5 个已读 baseline 文件覆盖 range archival 半开区间、无 from、相邻区间、重复/错误 anchor fail-open、live index、归档工具配对、手选 range 保留原始内容、bounded context tail、synthetic/real result 归一化、subagent/injected 持久化、completed side snapshot/receipt 排除、summary context-transfer。首跑 29 pass、123 expect，[原始输出](evidence/session-existing-baseline.first.log)。这是 baseline，不能当作 29 个新发现。
- 错误工具 `is_error` replay 丢失精确重复 [July M1](../review-2026-07-09/pre-beta-01-core.md#L13)，不新增、不重测。旧 synthetic duplicate 让 fork 拒绝属于 [July 审查记录](../../bugs/2026-07-13-repo-audit.md#L283)，不恢复旧多进程方向。CTX-1/CTX-2、child UI、memory TTL、recorder、CLI、原生/认证/权限/安全/custody 方向均未重试。

历史去重读取 437 个 JSON、563 个 Markdown，共 1000 个历史文件，JSON 解析错误 0；保存文件 SHA 和有限摘要，见 [corpus receipt](evidence/session-dedup-corpus.json)、[call-cap targeted dedup](evidence/session-call-cap-dedup.json)、[error-flag 排除](evidence/session-error-flag-dedup.json)。静态旧路径未找到及 metadata preflight 的退出 1 已在 [候选/lookup notes](evidence/session-candidates.json) 和 [dependency receipt](evidence/session-dependencies.json) 记录；不是 fixture/product 测试失败，没有安装依赖、修改支架或补跑。

本方向没有新的未确认候选，也没有失败的 guarded product/fixture shard。完整数据见 [findings](evidence/session-findings.json)、[validation](evidence/session-validation.json)、[25 文件源码 SHA 清单](evidence/session-source-manifest.json)。这些证据只支持所列普通数据边界，不能证明整个 session 子系统或全仓无 bug。
