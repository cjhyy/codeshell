# Server 普通字节/文本转换审查（第 14 批）

冻结基线：`badc2262a90966f6f903977b849adf1f22b55e9f`。新增 **0 项正式问题、1 个候选**。一个首次 guarded shard 完整通过：**11 pass / 31 expect / 0 fail / 0 skip**。全部是本批 focused 纯内存测试；其中 10 项为正常格式对照，1 项刻画候选拒绝现象，不证明产品已经修复或候选已确认。

## BYTES-R14-C1：JPEG SOF3 识别与全局 DQT 前提可能不一致

- 源码：[image-byte-probe.ts:16](../../packages/server/src/image-byte-probe.ts#L16) 的 SOF 集合包括 `0xc3`；同一 parser 在 [119](../../packages/server/src/image-byte-probe.ts#L119) 的 EOI 分支无条件要求 `sawQuantization`，而该标志仅由 DQT 设置。
- 格式依据：[ITU-T T.81（W3C 托管的标准原文）](https://www.w3.org/Graphics/JPEG/itu-t81.pdf#page=36) 的 B.1 将 SOF3 指定为无损顺序编码；B.2.4.1 Table B.4 对无损过程的量化表字段标为未定义。这里只据此提出应核对编码模式与 DQT 前提，没有把宽泛 `image/jpeg` 类型自动解释成支持所有 JPEG 编码模式的产品承诺。
- 实际观察：本批 fixture 构造 SOI/SOF3/DHT/SOS/熵字节/EOI 的内存序列，调用真实 `probeImageBytes("image/jpeg", bytes)`，得到 `invalid JPEG image structure: missing frame, tables, or scan`。四种既有普通 1×1 样本（含仓库 JPEG 样本）正常通过；该拒绝断言是成功的 characterization 测试。
- 证据边界：没有用独立像素解码器证实此自造序列是完整可解码的 JPEG，也没有证明常规附件/显示消费端承诺或支持 lossless JPEG。fixture 注释引用格式章节只说明构造意图，不能当作独立有效性证据。因此保留候选、不定严重级、不计正式 bug。
- 普通生产链接线只作静态核对：[attachment-service.ts:246](../../packages/server/src/attachment-service.ts#L246) 在 stageImageBuffer 中调用 sanitizer；[image-byte-probe.ts:314](../../packages/server/src/image-byte-probe.ts#L314) 复用该 JPEG parser。没有执行 stage、文件上传、真实图像文件、UI 或原生解码器；不能声称真实用户已被阻断。
- 查重：全历史 docs/bugs 中的 MD 与 parsed JSON string leaves 对 image probe、lossless/DQT、WebP canvas 等关键词未发现相同已登记条目。关键词覆盖不等同于语义穷尽证明。

## 实际覆盖、对照与排除

[首次 fixture](evidence/bytes-image-probe.first.test.ts) 直接导入目标纯函数，不导入 attachment-service。PNG/JPEG/GIF/WebP 正常样本逐项核对 1×1 尺寸、sanitizer 返回原有字节且 trailingBytes=0；另有带非零 byteOffset 的 Uint8Array 子视图控制、jpg MIME 别名，以及无动画简单 GIF 改为 87a header 的控制。样本字节来自当前维护的 attachment-service.test.ts 声明，未执行该服务测试中的文件、上传或存储路径。这不是恢复旧 legacy-native-history 的失败 stage 实验；本批没有调用那个实验或其消费者。

`remote-relay/byte-stream.ts` 全文与 protocol.ts、device-relay.md 相关合同为静态阅读。该实现封装实际 ws/Node stream，并非可独立输入字节的纯帧 decoder；没有为了制造试验而替换其运行时、创建 WebSocket/TCP/HTTP、验证认证/超限攻击或引入假流来证明真实网络性质。没有新问题，也不能由本批声称 backpressure、EOF、慢读或连接清理全部正确。

`mobile-remote/codex-parse.ts` 与既有测试全文只读。file_change 完成形状、MCP 对象/错误摘要与 JSON null 方向已在 [round3/root.md](../audit-2026-10-17-round3/root.md) 的 R3-01/02/03 登记，未重新运行或重复计数。其 UTF-16 slice 边界属于已知文本截断家族（[round12 Desktop 记录](../audit-2026-10-17-round12/desktop.md)），本次没有新增常规 CLI producer/消费者或独立复现，也未据此增列新条目。审批/权限注释不属于本批验证范围，未执行对应既有用例或任何真实 CLI。

## 首次证据、查重与跳过

[raw combined stdout/stderr](evidence/bytes-image-probe.first.log) 与 [exit receipt](evidence/bytes-image-probe.first.exit.json) 在首次运行结束后、查看输出前保存。仅执行一次 `node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round14/evidence/bytes-image-probe.first.test.ts`；无失败 Bun shard、修 fixture、重跑或替代验证。

[完整历史查重](evidence/bytes-dedup.json) 的文件库存覆盖 **1088 MD + 680 JSON = 1768 文件**，含 archive/_archive；JSON 共 **185197 string leaves，0 parse errors**，排除本批 round14。各 pattern 最多保存 120 个上下文且本次所有匹配数均低于该限额。

一次静态 rg 误猜 `mobile-remote/upload-store.ts`，返回 exit 2，已按工具响应转录存入 [navigation skip](evidence/bytes-navigation-skip.md)，跳过该误猜路径，没有找替代文件或恢复其验证。不会把它作为产品问题或 Bun 失败。

[source manifest](evidence/bytes-source-manifest.json)、[validation](evidence/bytes-validation.json)、[candidates](evidence/bytes-candidates.json)、[external source receipt](evidence/bytes-external-sources.json)、[artifact receipt](evidence/bytes-artifact-receipt.json) 可核对。metadata assembler 仅重建清单，不运行产品测试。

未改产品或 Git；没有 shared deps/dist/build、完整 suite/lint/typecheck、真实模型/账户/网络/socket/终端/原生平台、用户数据、权限/security/custody 实验。普通内存字节的局部结果不支持整个 Server 或跨平台端到端结论。
