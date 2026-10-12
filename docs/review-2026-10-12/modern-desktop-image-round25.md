# 第二十五轮：现代图片会话在普通桌面端恢复后的显示

## R85 / D25-1 / P3：已恢复附件元数据，聊天仍隐藏附件及纯图片气泡

触发条件：当前配对原生 `chat.send` 已接受图文或纯图片输入，产生有效现代持久 journal；随后在普通 Desktop 对话中选择该会话，冷缓存没有该条输入的本地 optimistic inline 副本。不是旧版无日志回退，也不需要删除文件、破坏日志或越过图片读取权限。

实际结果：恢复后的用户对象正确保留 clean text、clientMessageId 和一个带名称、MIME、size、path 的附件，但普通聊天只显示文字，没有附件名称或数量提示；纯图片输入连用户气泡都不显示，assistant 回答仍正常。68-byte 图片原件与 canonical journal 均保留，因此没有输入、历史或文件丢失的结论。一个渲染根因覆盖两种输入，合并为窄 P3。

最小审查位置：[MessageStream.tsx:441](../../packages/desktop/src/renderer/MessageStream.tsx:441)。此处只从 `m.text` 解码旧 `codeshell-image`；[445](../../packages/desktop/src/renderer/MessageStream.tsx:445) 遇空正文、空 annotations 和零 inline images 就返回 null，没有消费 `m.attachments`。上游 [types.ts:858](../../packages/desktop/src/renderer/types.ts:858) / [889](../../packages/desktop/src/renderer/types.ts:889) 已正确保留现代附件；[ChatView.tsx:1503](../../packages/desktop/src/renderer/ChatView.tsx:1503) 直接把这些消息交给普通 MessageStream。

## 真实入口、反证与正常对照

1. [mobile-chat-turn.ts:77](../../packages/server/src/mobile-remote/mobile-chat-turn.ts:77) 允许文字或图片，真实 dispatch/materialization 生成请求与 staged 文件；[95](../../packages/server/src/mobile-remote/mobile-chat-turn.ts:95) 的 native 请求没有 displayText。协议 [server.ts:2021](../../packages/core/src/protocol/server.ts:2021) / [ChatSession:514](../../packages/core/src/protocol/chat-session.ts:514) 和 [run-session-open.ts:153](../../packages/core/src/engine/run-session-open.ts:153) 转送 undefined displayText、false injected 与真实 clientMessageId。实验实际调用图片 preparation/content helpers、SessionManager 和 Transcript，不手写用户 XML 或展示事件。
2. 生产会话有普通 Desktop 入口：[handle-client-event.ts:381](../../packages/desktop/src/main/mobile-remote/handle-client-event.ts:381) / [412](../../packages/desktop/src/main/mobile-remote/handle-client-event.ts:412) → [orchestrator:276](../../packages/desktop/src/main/mobile-remote-orchestrator.ts:276) → [useHostSubscriptions.ts:523](../../packages/desktop/src/renderer/app/useHostSubscriptions.ts:523) 创建/更新 sidebar index 并安装 engineToBucket。[useTranscriptBuckets.ts:177](../../packages/desktop/src/renderer/app/useTranscriptBuckets.ts:177) / [253](../../packages/desktop/src/renderer/app/useTranscriptBuckets.ts:253) 走实际 preload journal reader 和现代恢复。以上完整 App、hook、身份授权及 worker 接受链路仅静态核对；fixture 不把 synthetic submit 回执当动态真实授权。
3. 实验从实际 Core dist [run-stream.ts:72](../../packages/core/src/engine/run-stream.ts:72) 对应 publisher/writer 发布 canonical user anchor 和受控运行事件，实际 [session-transcript-ipc.ts:65](../../packages/desktop/src/main/session-transcript-ipc.ts:65)、preload facade、reader、[outputJournalRecovery.ts:47](../../packages/desktop/src/renderer/app/outputJournalRecovery.ts:47) 及 tokened hydration reducer 完成恢复，再执行真实 MessageStream SSR。没有启动 Engine.run、模型或 worker。synthetic user anchor 只写 journal，没有 live user echo；不声称发送瞬间原图被 echo 清掉。
4. [transcriptHydration.ts:243](../../packages/desktop/src/renderer/transcriptHydration.ts:243) 的 outputCursor 分支从 action.state 开始，只重放本轮 locals、保留原 pending stable-ID drafts；legacy replayBase 合并在 [342](../../packages/desktop/src/renderer/transcriptHydration.ts:342) 之后。冷 paired 会话没有本地 optimistic 副本，是本轮动态下限。已 hydrate 的同 bucket 在 [useTranscriptBuckets.ts:179](../../packages/desktop/src/renderer/app/useTranscriptBuckets.ts:179) 可直接复用，不声称一直停留也会触发。
5. 正常对照一：同一真实 journal page 经过 Web reducer 和 [Workbench.tsx:620](../../packages/web/app/Workbench.tsx:620) 实际 SSR，两场均显示 modern-shot.png。正常对照二：真实 Desktop `encodeAttachmentsForWire` → `appendUserMessage` → MessageStream SSR，两场均显示图片 data URL 及名称。这只验证初始 optimistic UI 表示；没有执行实际 send hook。普通 [ChatView.tsx:1081](../../packages/desktop/src/renderer/ChatView.tsx:1081) / [useRunController.ts:208](../../packages/desktop/src/renderer/app/useRunController.ts:208) 使用 displayText 做 optimistic 展示，但 native opts 没有复制它，不能据此推断 canonical 恢复一直受保护；普通 Desktop send/reopen 的扩大范围本轮只静态支持。
6. 输入、恢复后 staged 原件均保持 68 bytes，SHA256 `431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460`。有效 PNG 来自 maintained attachment-service 测试；没有历史缩略图、下载、click-open 或特权读取验收。[PetChatHost.tsx:158](../../packages/desktop/src/renderer/pet/PetChatHost.tsx:158) 是另一个消费 structured attachments 的正常独立入口，不纳入普通 ChatView 缺陷。

[旧图片设计:161](../../docs/archive/electron-image-input-design.md:161) 明确延期历史图片解析及缓存，因此这里不要求重建 base64 或历史预览。当前 [durable journal 文档:84](../../docs/todo/durable-output-journal-delivery.md:84) 和 [useTranscriptBuckets.test.tsx:206](../../packages/desktop/src/renderer/app/useTranscriptBuckets.test.tsx:206) 已支持 canonical image / attachment-only 恢复，但既有测试只断言状态，未渲染普通 MessageStream。修复下限是展示已经安全恢复的附件摘要，并保留合法纯图片用户气泡；不要为此重复持久 base64 或绕过图片访问门禁。

与 R84 的 never-published legacy 历史信封错误、R54 的拖放接收和 R58 的图片读取根门禁分别去重。Quick Chat、queued steer、外部 CLI/room 不算本轮动态场景。

## 执行分账和证据范围

| 执行 | 实际结果 | 证据 |
| --- | --- | --- |
| 作者首次 latest | 0 pass / 2 fail / 22 Bun expect；无 Completed | [日志](validation/original-modern-desktop-image-round25/first-authorized/first-authorized.log)、[观测](validation/original-modern-desktop-image-round25/first-authorized/observed.json) |
| 作者修正后 latest | 2 tests / 32 Bun expect / 0 fail / Completed | [日志](validation/original-modern-desktop-image-round25/second-authorized/second-authorized.log)、[观测](validation/original-modern-desktop-image-round25/second-authorized/observed.json) |
| 主审独立 84740 | 同源 2 tests / 32 Bun expect / 0 fail / Completed | [日志](reproductions/modern-desktop-image-round25/modern-desktop-image.test.ts.log)、[观测](reproductions/modern-desktop-image-round25/observed.json)、[清理](reproductions/modern-desktop-image-round25/cleanup-receipt.json) |
| 主审独立 a66f | 同源 2 tests / 32 Bun expect / 0 fail / Completed | [日志](validation/latest-a66f4ef2/modern-desktop-image-round25/modern-desktop-image.test.ts.log)、[观测](validation/latest-a66f4ef2/modern-desktop-image-round25/observed.json)、[清理](validation/latest-a66f4ef2/modern-desktop-image-round25/cleanup-receipt.json) |

首次失败是 MiniDom 缺少 Web Workbench SSR 的 window.matchMedia，尚未完成 Web、inline 和 byte controls，observations=[]；不能把之前未抛出的断言算完整候选通过，也不是产品缺陷。[唯一修正收据](validation/original-modern-desktop-image-round25/root-match-media-correction.json) 记录只在 ensureMiniDom 后补 matches=false 的 SSR viewport adapter，业务代码、断言和 guard 不变。初稿 PLAN、首败精确源码/日志/观测与作者修正后源码分别归档。

最终 fixture SHA256 `411b12bcb249b6eeb5465fe67f1f30555ecc5fb2232c219c602e0ce1df049ca9`，guard `6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d`。使用 maintained runner 独立 HOME；产品 import 前安装 exact-origin guard 并拒绝 dummy origin，网络/监听/child/worker attempts 均为空。两场 owned Session/cwd 清理成功，三次最终运行及首败的 HOME/runner root 均已删除。进程内 guard 不称 OS sandbox。

动态链路中的 submit acceptance、run events、内存 IPC transport、MiniDom viewport 为明确替身；真实 producer/staging、Core dist journal publisher/writer、preload facade/registrar/reader、recovery/hydration 与两端 renderer/正常对照均实际运行。五个 UI alias 只转发真实 leaf exports，不替换图片/消息/恢复逻辑。63 项 source/dist/契约 hash 与 4 个 resolve-only 地址逐项核真，不能当 module-cache/import graph 探针。没有完整 App/hook/Electron、真实 authority/auth、HTTP/WS、手机、Engine/provider/worker 或付费请求。

本轮新增通用 1 文件 2 测试，每冻结基线 32 个 Bun expect；作者及主审重复不叠加，Node assert 不另计，native 增量 0。当前正式 85 项 = 1 P1 / 52 P2 / 32 P3，通用便携 85 文件 250 测试。见[执行收据](validation/round25-modern-desktop-image-results.json)、[作者保留稿](validation/original-modern-desktop-image-round25/report.md)、[历史静态反证](modern-desktop-image-quality-round25.md)及[独立最终质量核验](quality-round25.md)。条件性历史分页比较候选仅[静态保留](validation/original-modern-desktop-image-round25/history-pagination-static-preflight.md)，无自然触发验证、无执行、未收为正式项。

分页候选追加[生产前提核查](validation/original-modern-desktop-image-round25/same-mtime-prerequisites.md)仍为新增执行0/正式0：reader实际键为会话目录stat.mtimeMs，不是state.json或startedAt；创建/fork/导入/备份源码未提供完全同目录mtime的生产收据，tar格式和精度也未指定，不把低精度存储假设或示意排序当自然复现。旧静态稿的R01–R83是当时去重阶段，当前正式85/250。
