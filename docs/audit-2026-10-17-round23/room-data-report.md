# Mobile 历史与 Codex room 数据叶子复核

冻结点 `c1d007ed0af1eca9b56b32fabbb0ea2401037ee1`。本方向 **0 新正式问题、0 新候选、0 新关联**；一个首次 guarded shard 完整通过 **6 pass / 13 expect / 0 fail / 0 skipped**，全部为 focused。只记录，没有产品/Git 写。

## 实际验证

完整读取 [mobile-history.ts](../../packages/server/src/mobile-remote/mobile-history.ts#L1) 的 41 行。它没有 import；fixture 只绝对路径导入真实 `buildSessionHistory`，用自有 JSON 对象和 reader 回调，不导入真实 reader、Core、room store 或平台服务。[首跑 fixture](evidence/room-data-mobile-history.test.ts)、[raw](evidence/room-data-first.raw.log)、[exit](evidence/room-data-first.exit.json) 与 [preflight](evidence/room-data-preflight.json) 保留具体输入、命令和 hash；raw/exit 先保存后阅读，exit0、Completed，一次尝试、无重跑或修复。

四项普通投影控制检查选定 sessionId 只传一次与空结果、普通文字顺序、stream event 对象原样保留、readonly 输入下的 user/stream 交错及不变性。另两项使用 owned deferred Promise 与主动拒绝的回调，分别控制调用间输出独立和同一 Error 传播；没有 timer、真实并发会话、文件错误、持久化、手机或 UI 验证，不能把这些人工边界控制当作普通生产故障。

普通消费者只静态确认：[handle-client-event.ts:19](../../packages/desktop/src/main/mobile-remote/handle-client-event.ts#L19) 导入 transcript reader，557–563 行调用 builder 并返回 events 或读取失败提示。[getSessionTranscript:616](../../packages/desktop/src/main/transcript-reader.ts#L616) 返回 page.items；fold 在 332–364 行产生 `kind:user` 与携带 text_delta 的 `kind:stream`。这些是 selected 源码合同，不是实际 FS、协议、恢复、身份或 renderer 执行。readonly 列表与 user/stream 两种结构同时由叶子公开接口/注释说明。没有把完整 transcript 元数据投影承诺强加给这次普通 DTO 控制。

## Codex 方向保留静态去重

完整静态读取 [codex-parse.ts](../../packages/server/src/mobile-remote/codex-parse.ts#L1) 的 137 行与 [既有测试](../../packages/server/src/mobile-remote/codex-parse.test.ts#L1) 的 133 行。实际消费者 [codex-room-agent:139](../../packages/server/src/mobile-remote/codex-room-agent.ts#L139) 在 stdout line callback 调 extractThreadId 和 parser，再转发事件；只读该片段，没有 import/构造 agent、读取进程输出或启动 Codex。

[round3/root.md](../audit-2026-10-17-round3/root.md#L5) 已登记 R3-01 file_change、R3-02 MCP 对象/错误摘要、R3-03 null 边界，并运行过 15 项选定 parser baseline。本批不重复运行这些旧缺陷或基线，不测试 null/primitive，不把源码的 0.142.4 注释或历史 SDK tag 当成当前安装 CLI 的普通 producer 合同；没有新增当前格式证据，因此没有以手写新协议对象升级问题。既有套件还包含审批断言，整组保持未执行，本轮 Codex 运行尝试为 0。注释中关于审批/sandbox 的说法不属于本批验证。

[round14 bytes](../audit-2026-10-17-round14/bytes.md#L20) 也已保留上述去重与 UTF16 截断家族的排除；[R84 legacy history](../review-2026-10-12/legacy-history-round24.md#L3) 已覆盖 native 历史用户正文/附件提示的投影边界。此次不重测附件、injected/clientMessageId/timestamp 丢失、内部 anchor 空白气泡、Unicode slice、输出 fallback 或 mapper 错 ID，不新增旧问题关联计数，不声明它们已经修复。

## 证据范围与跳过

[全历史扫描](evidence/room-data-dedup.json) 排除本批，覆盖 docs/bugs 全部递归 MD 与 parsed JSON 标量，包含 archive/_archive：**2,301 文件 = 1,213 MD + 1,088 JSON，335,490 string leaves / 472,091 scalar leaves，0 parse errors**。exact/Codex shapes/history projection/old families 分别命中 115/41/286/189 次，保存 115/41/150/150 个上下文；匹配次数不是问题数，有限关键词上下文不证明语义穷尽。人工排除依据见 [去重决定](evidence/room-data-dedup-decisions.json)。

源码清单中 4 个文件全文静态读取、3 个 selected；只有 mobile-history 叶子实际执行。Codex 既有测试只静态读，未发现直接引用 builder 的现有测试；额外读到的 Desktop room history 测试依赖 RoomManager、真实临时存储与 viewer 行为，整组未执行，不能当作 builder 既有基线。本批既有测试通过数为 0。[manifest](evidence/room-data-source-manifest.json) 分清 full/selected、运行与静态；hash 只证明选定字节，不是全文件/传递依赖/端到端覆盖。

一次静态导航错误已原样保留：[navigation](evidence/room-data-transcript-navigation.json) 记录对旧报告提及但当前库存没有的 `sessions-service.ts` 查询 exit2。这个猜测文件方向跳过，没有重试其路径、修 fixture 或运行替代产品。实际 handler 与先前成功库存独立确认的 transcript-reader 仅静态选读，用于普通合同，不是恢复该失败猜测。此事不是 Bun、依赖解析或产品故障；[metadata notes](evidence/room-data-metadata-notes.json) 明确分账。

没有 Codex CLI/进程/SDK/模型/网络/账号、真实 transcript/room/文件、身份/权限/security/custody/PTY/native、真实 timer、共享 deps/dist/build、完整 suite/lint/typecheck 或旧失败方向恢复。仅一条实际零依赖 helper shard 的结果不能外推完整历史恢复或当前 Codex 协议正确性。计数见 [validation](evidence/room-data-validation.json)，分类见 [findings](evidence/room-data-findings.json)、[candidates](evidence/room-data-candidates.json)、[related](evidence/room-data-related.json)，材料 hash 见 [author receipt](evidence/room-data-author-receipt.json)。
