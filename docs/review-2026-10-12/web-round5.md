# Web / 配对端失败恢复与页面保护第五轮审查

固定基线：`84740d56e55517b004948a0a0e07649ad6fbf998`。工作区 `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell`，以下产品路径均相对该目录；没有切到新的 origin/main，没有修改产品代码。

本轮先核对正式索引 R01–R39，避免重复。生产 Hub 路径为 `packages/web/app/AuthGate.tsx:106-119` → `<App hub>` → `App.tsx:14-19` 直接挂载 `useHubController` 和共享 `Workbench`。配对移动端路径为 `packages/desktop/src/mobile/main.tsx:4,14` → `DesktopApp` → 同一个 Workbench。下列测试使用这些实际控制器；页面关闭保护测试同时挂载实际 Workbench。

验证：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-web-round5/recovery-review.test.tsx
```

脚本 `recovery-review.test.tsx` 和完整日志 `recovery-review.log` 均在本目录。**9 pass / 0 fail / 0 skipped / 56 assertions / 933ms**。最后一项使用完整认证 Headless Hub、实际 HTTP session API、真实 loopback WebSocket；其余为真实 React DOM/控制器加受控传输帧。guarded runner 隔离 HOME，Core-facing import 前封锁网络，真实 Hub 只放行其精确临时 loopback origin；fixture worker 仅 stdin.resume，不执行模型。无用户账户、外部服务或付费调用。

## W15 — [P2] 发送明确失败前输入后续草稿，会丢掉原失败内容

- 精确定位：`packages/web/app/drafts.ts:54-59` 在当前草稿 revision 已变化时拒绝 restore，这是防止覆盖后续编辑的合理保护，但调用方没有保留另一份失败草稿。Hub `packages/web/app/useHubController.tsx:127-140` 即使 restore=false 仍删除对应原用户气泡，`:584-587` 随后删除 submission。配对端 `packages/web/app/DesktopApp.tsx:364-370` 忽略 restore 返回值，仍提示“内容和附件已保留”；`:386-388` 结束此次发送后没有失败稿入口。
- 操作时序：用户发送一段较长的任务 A，在等待入队/上传/校验确认期间，继续在同一个输入框写后续问题 B。服务器随后明确拒绝 A，尚未发送 accepted/stream；例子是配置正在保存期间的主机门禁，或附件已失效。输入框在发送期间仍可编辑，真实 Workbench `packages/web/app/Workbench.tsx:721-735` 只因 readOnly 禁用 textarea。
- 实测：Hub 当前输入框保留 B，但 A 的乐观用户气泡被移除，localDrafts 只剩 B。配对端当前输入框也只剩 B；ACK 前原本不会插入 A 气泡，因此历史 UI 中从来没有 A；localDrafts 没有失败稿；错误横幅却声称内容已保留。日志分别为 `HUB_FAILED_SUBMISSION_LOST` 和 `PAIRED_FAILED_SUBMISSION_LOST`。正常对照验证不输入 B 时，两端都能恢复 A 并直接重试，因此根因是失败稿与后续稿竞争同一个 draft slot。
- 其他副本核对：Hub 的明确拒绝路径 `packages/server/src/serve/headless-server.ts:958-970` 在配置变更时直接返回关联 RPC 错误并 return，尚未转发 worker；`:990-1009` 的附件准备拒绝同样在转发前 return。这些合法拒绝没有队列、持久用户回执或任务历史副本可恢复。配对端 `packages/desktop/src/main/mobile-remote/handle-client-event.ts:404-409` 在 dispatchMobileChatTurn 返回失败时只回关联 error；客户端 `packages/web/src/hooks/useRemoteApp.ts:1339-1357` 仅 ACK 成功后才 echo 用户内容。测试明确不发送任何 accepted/stream，未声称已接受且已持久化的任务内容也会全部消失。原纯文本在已结束的发送闭包中不再有产品可访问的恢复入口；控制台/网络开发工具不是用户恢复流程。
- 影响：失败后不能重试原任务，必须重新构思/输入内容；配对端“已保留”的反馈与实际状态相反。当前测试确定性验证文本内容；附件同样经过该 SubmittedDraft，但本条没有把未测试的二进制回收范围作为额外影响。
- 建议：restore 因新编辑冲突时，保留独立失败消息/失败草稿供复制、恢复或重试；保持 B，不要用 A 覆盖新编辑。仅在实际恢复成功时显示“内容已保留”。Hub 原气泡可保留为明确失败状态，而非无条件删掉唯一可见副本。
- 测试缺口：现有 SessionDrafts 测试只要求 late failure 不覆盖新文本/有意清空，未检查被拒绝的原任务还有可恢复副本；本轮同时覆盖无后续稿的正常恢复和有后续稿的丢失。
- 信心：高（两实际控制器确定性复现；合法服务端预入队拒绝路径已核对）。

## W16 — [P2] Hub 未确认送达的意图没有刷新保护，刷新后唯一恢复副本丢失

- 精确定位：`packages/web/app/Workbench.tsx:215-223` beforeunload 只检查 navigationDirty/uploadBusy/hasUnsent；未检查未确认提交。Hub `packages/web/app/useHubController.tsx:567-572` 将断线提交保存在内存 uncertainSubmissions 中，`:705-707` hasUnsent 只计普通输入草稿，与 uncertain 是独立值。提交取走草稿后，两者可分别为 false/true。
- 操作时序：输入 A，正常草稿状态有 beforeunload 提示。点击发送后，帧可能因网络断开尚未到主机，客户端无法确认；断线触发 transport rejection，页面明确显示将重连核对消息是否送达。此时用户按刷新/关闭页签。
- 实测客户端：挂载真实 Hub 控制器和 Workbench，`uncertain=true,hasUnsent=false,uploadBusy=false` 时 beforeunload event 不会被 preventDefault。同一页面有普通草稿时会正确阻止，排除了测试未挂载保护监听器的假阳性。重建页面控制器后，原 A 不在输入框、localDrafts、chat 或 uncertain map 中。
- 真实主机补强：最后一项新建完整 startHeadlessServer、全新账户认证、实际 HTTP + WS。受控浏览器传输层只丢弃一次 agent/run 帧并关闭真实底层 socket，模型化“浏览器已调用 send、帧尚未到主机就断线”，没有伪造服务器拒绝/持久状态。主机实际 `/api/v1/sessions` 在刷新前后均返回空列表；重新加载连接成功后意图副本=0。日志 `REAL_HUB_UNCERTAIN_RELOAD_LOSS` 记录 1 个被丢帧、0 个持久会话、0 个模型请求。worker 从未需要处理任务，故不涉及付费请求。
- 影响与限制：仅报告尚未确认、且实际未接受/未持久化的意图丢失。已被接受且写入日志的任务可以从服务器恢复，本条不称任何刷新都会丢任务，也不主张对全部运行中任务弹离开提示。页面自己的“重连后核对”只在保持当前内存生命周期时有效，用户常用的刷新恢复操作会直接销毁待核对内容。
- 与 R03 的区别：R03 是配对端任务已经执行、ACK 丢失后重试换 ID 导致重复执行；本条是 Hub 在并未接受的窗口中缺少页面离开保护，刷新造成原意图不能再恢复。没有执行第二次任务，也不涉及生成新 ID 重发。
- 建议：将任意会话仍需核对的未确认提交计入页面离开保护，覆盖后台会话的 uncertain 意图；先明确告知用户哪些内容尚未确认保存。可以继续保持普通草稿不进入 localStorage 的隐私设计，不需要为修复此问题持久化凭证/附件 ID。
- 测试缺口：原先只有普通草稿/上传保护，未覆盖 take() 后 transport failure 的 uncertain 内存状态以及真实主机尚未接受时的页面重建。
- 信心：高（真实完整认证主机+实际控制器+实际 Workbench 生命周期复现；断线丢帧条件由传输 fixture 显式固定）。

## 正常路径与排除项

| 路径 | 验证结果 |
| --- | --- |
| Hub 预入队拒绝，没有后续编辑 | 原文本恢复、乐观气泡移除、立即重试重新提交原文本 |
| 配对端明确关联发送拒绝，没有后续编辑 | 原文本恢复，可继续发送 |
| Hub 已接受任务的模型错误 | 错误事件显示、用户 turn 留在历史、实际运行结束后可发送新的显式重试 |
| Hub 正常停止已接受任务 | cancel 使用当前 sessionId；turn_complete/status/result 都结束后解除运行/提交锁，期间输入的后续稿保留 |
| 配对端原生会话停止 | run.stop 使用已绑定 sessionId；终态清掉同步审批，后续草稿可发送。只验证 native，不重复 R08 CLI room 停止错误 |
| 历史 A 详情慢响应，用户先打开 B | A 迟到响应不覆盖 B 历史/草稿；再次选 A 可取回 A 未发送草稿 |
| 普通草稿刷新保护 | 实际 Workbench beforeunload 阻止刷新；W16 的异常只出现在未确认提交未计入该条件时 |

未把没有专门“重试最后一句”按钮作为缺陷；已接受且已有历史的模型错误可以通过新任务明确重试。未把已经列入 R14 的异步审批残留或 R19 的同步审批错误恢复再次计数。没有发现本轮正常 native Stop、正常历史切换或已接受模型错误的额外阻塞缺陷。
