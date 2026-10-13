# 第二十四轮：旧原生图片会话历史显示

## R84 / F24-1 / P3：兼容恢复把内部图片路径和模型提示显示为用户正文

触发条件：打开通过旧版配对 `chat.send` 发送过图片的有效原生 Session；它从未发布持久输出 journal，原始 transcript 和 staged 图片仍保留。当前配对 Web 正常协商 `outputJournal:1`，走受支持的 journal-unavailable → `session.history` 回退。不是删除现代 journal、任意导入历史、过期上传票据或失效文件。

实际结果：用户正文末尾出现 `<attached-image-paths>`、工作区路径和“作为工具输入”的模型提示，没有安全的附件 summary。路径本身包含文件名，因此不声称完全没有图片线索。真实 Workbench SSR 已确认标记以转义后的普通正文出现；普通文字和 assistant 回答仍正常。此项是旧历史投影的窄 P3，不涉及图片原件、任务或历史丢失。

最小审查位置：[mobile-history.ts:34](../../packages/server/src/mobile-remote/mobile-history.ts:34)。该处将 FoldItem 用户内容直接构造成 `{type:"user_message",text:item.text}`；上游 [transcript-reader.ts:255](../../packages/desktop/src/main/transcript-reader.ts:255) 取 displayText 或原始文本块，没有输出附件摘要。浏览器 [userMessageDisplay.ts:153](../../packages/web/src/lib/userMessageDisplay.ts:153) 的正常投影入口只处理 `session_user_message`/`steer_injected`，这种旧信封不会被清洗；[Workbench.tsx:622](../../packages/web/app/Workbench.tsx:622) 直接显示 text。

## 真实入口和正常对照

1. 旧发送格式有来源证据。持久 journal 引入提交为 `8dc1cfe870a3ab90dee103f69975ac47dba51be8`，其父为 `c9b1d95979a0ca12faedeba9fadf81e8ddda680f`。父提交与初始基线的 `run-image-input.ts` / `input-attachments.ts` Git blob 分别相同：`4a28a57c65b7748820c207b3ece2c7031687865f` / `c49f0dd6e9db2876111bd0473b9812af9af4478b`，见[来源收据](validation/original-legacy-history-round24/root-provenance-preflight.json)。实验调用真实 stageImageBytes、prepareRunImageInput、buildRunUserMessageContent、SessionManager 和 Transcript.appendMessage，没有手写路径 XML 或调用 Engine.run。
2. 旧/当前 paired-native 请求均没有补 displayText：[mobile-chat-turn.ts:95](../../packages/server/src/mobile-remote/mobile-chat-turn.ts:95) → [AgentServer:2021](../../packages/core/src/protocol/server.ts:2021) / [2196](../../packages/core/src/protocol/server.ts:2196) → [ChatSession:514](../../packages/core/src/protocol/chat-session.ts:514) → [run-session-open.ts:153](../../packages/core/src/engine/run-session-open.ts:153)。fixture 明确使用 `injected:false`、有效 clientMessageId、`displayText:undefined`，不泛化到主动提供 clean displayText 的其他生产者。
3. 实际 Web hook 经 [mobileOutputClient.ts:190](../../packages/web/src/hooks/mobileOutputClient.ts:190)、[useRemoteApp.ts:538](../../packages/web/src/hooks/useRemoteApp.ts:538) 发出 history 回退；实际 Desktop [handle-client-event.ts:546](../../packages/desktop/src/main/mobile-remote/handle-client-event.ts:546)、reader、server builder、reducer 和旧状态 Workbench SSR 完成链路。普通正文和 assistant replay 作为正常控制保留。
4. 读完旧历史后，才首次创建真实 SessionOutputJournal，使用同一 transcript cutover 和匹配 snapshot cursor。重选后，实际 hook 得到干净正文及名称、68-byte size、MIME、path、clientMessageId 的附件 summary。这是现代投影正常控制，没有第二次现代 Workbench SSR，也不是公开修复按钮；不建议为修复显示而启动模型任务。
5. 输入、staged 和两次恢复后的 PNG 均为 68 bytes，SHA-256 均为 `431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460`。原件保留，未测历史缩略图或下载。

现有图片契约要求隐藏路径块、在缺少历史摘要时至少提示图片附件，但不要求第一版历史下载 API，见[原设计:213](../../docs/todo/small-features-2026-07-10/mobile-remote-send-image.md:213)。[旧端回退契约](../../docs/todo/mobile-output-journal-delivery.md:86) 没有允许显示内部模型提示。sent staged 文件的 30 天保留与 Mobile 五分钟票据、浏览器 object URL 是不同生命周期，本实验仅覆盖有效且仍保留原件的 Session。

建议复用已有、识别真实消息元数据的安全展示投影，保留普通用户自己写的 XML 和 clean displayText。不能用全局字符串删除 XML 代替消息识别，也不应把曾经发布而丢失的 journal 当正常旧会话。

## 执行、失败与证据层级

| 执行 | 结果 | 证据 |
| --- | --- | --- |
| 作者首次 latest | 0 pass / 1 fail；没有 Completed，也没有打印 Bun expect 总数 | [原日志](validation/original-legacy-history-round24/first-authorized.log)、[观测](validation/original-legacy-history-round24/first-authorized.observed.json) |
| 作者修正后 latest | 1 test / 17 Bun expect / 0 fail / Completed | [日志](validation/original-legacy-history-round24/second-authorized.log)、[观测](validation/original-legacy-history-round24/second-authorized.observed.json) |
| 主审独立初始基线 84740 | 同源 1 test / 17 Bun expect / 0 fail / Completed | [日志](reproductions/legacy-history-round24/legacy-native-history.test.ts.log)、[观测](reproductions/legacy-history-round24/observed.json)、[清理](reproductions/legacy-history-round24/cleanup-receipt.json) |
| 主审独立最新基线 a66f | 同源 1 test / 17 Bun expect / 0 fail / Completed | [日志](validation/latest-a66f4ef2/legacy-history-round24/legacy-native-history.test.ts.log)、[观测](validation/latest-a66f4ef2/legacy-history-round24/observed.json)、[清理](validation/latest-a66f4ef2/legacy-history-round24/cleanup-receipt.json) |

首次失败来自 fixture 借用的 PNG 有错误 IDAT CRC，真实 staging 正常拒绝，尚未到达 hook/fallback，也在第一条 Bun expect 前。[修正收据](validation/original-legacy-history-round24/png-fixture-correction.json) 记录仅替换为 maintained attachment-service 测试的有效 PNG 常量及来源注释，业务逻辑、guard、权限替身、元数据和控制不变。原作者报告中“0 Bun expect”为源码阶段推断，原日志没有打印此计数；上表以实际日志为准。最初未执行的 prepared 源码/计划与[精确压缩差异](validation/original-legacy-history-round24/prepared-revision.diff.gz) 保留，执行数 0。

最终 fixture SHA 为 `dfe9749f86552d7529af7ea9d323d43ce95904ee82d5654201b17c3f62d221e3`；guard 为 `6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d`。guard 在产品 import 前检查 maintained 私有 HOME，安装 exact-origin 限制并拒绝 dummy origin，以及常见网络、监听、child/Worker/Bun spawn API。三次最终成功运行 attempts 均为空，viewer revoke、hook unmount、pending settlement、owned 文件删除完成，runner HOME 均已删除。guard 是进程内防护，不是 OS sandbox。

动态链路中的 auth/device/viewer/authority stamp、Bridge snapshot facade 和 MemoryWebSocket 是明确受控替身。真实 authority 与非 Git no-repo 路径只做静态核对，没有动态 Git/真实身份验收；实际 recovery service 的 Session/selection/viewer 一致性检查仍运行。没有真实 HTTP/WS、Electron、物理手机、完整 Main、worker、Engine.run、provider 或付费请求。SessionManager 显式从 Core dist 构造；31 项 source manifest 与 5 个 resolve-only 地址已按各冻结 checkout 核验，不能当成实际 module-cache/import-graph 探针。

与 R54 Quick Chat 拖放、R58 worktree 图片根权限、R65 EACCES、R39 归档导航和 R09/R17/R20/R34 上传生命周期分别去重，根因不同。本轮新增 1 文件 1 测试 17 Bun expect；Node assert/guard 检查未另行计数，native 增量 0。通用便携累计 84 文件 248 测试；正式 84 项 = 1 P1 / 52 P2 / 31 P3。原失败、作者重跑与 root 两次验证不叠加成新套件。

完整分账见[round24 收据](validation/round24-legacy-history-results.json)；作者原始报告见[保留稿](validation/original-legacy-history-round24/report.md)，独立只读质量复核见[历史反证稿](legacy-history-quality-round24.md)及[最终整合核验](quality-round24.md)。

归档说明：首次失败日志第7行的Bun空白源码context尾空格已从可读副本删除以通过Git whitespace检查；[原字节压缩日志](validation/original-legacy-history-round24/first-authorized.raw.log.gz)与[SHA/行号收据](validation/original-legacy-history-round24/first-authorized-log-normalization.json)保留。fixture、guard和执行结果均未变化，没有重跑。
