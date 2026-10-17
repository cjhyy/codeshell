# Web 状态与投影续审

冻结源码 `9a421b3e65d5bfe662b78062cb86bd99483a683a`，分支 `codex/audit/prompt-profile-web-round5-20261017`。本专项确认 **2 项：1 P2、1 P3**。两个首次 guarded shard 合计 **5 pass / 23 expect / 0 fail、skip / Completed / exit 0**。没有产品修改，断言记录当前错误行为。

## WEB-R5-01 [P2] 子代理事件改写主任务全局状态，后台结束后仍显示运行

- 位置：`packages/web/src/lib/streamReducer.ts:206,218,239,250,269,300` 对子代理 start/text/thinking/tool start 同样无条件写 `run: "running"`；`:631–636` 对带 agentId 的 error 也写全局 error 并清空所有 liveByAgent。另一方面 `:482–485` 的 child turn_complete 明确保留主任务状态，agent_end 只更改子任务行，不能收回前面错误的全局修改。
- 正常生产来源：`packages/core/src/tool-system/builtin/agent.ts:515–520` 明确将后台子任务 detail 转发给父流，允许发生在父回合结束之后；`engine/subagent-spawner.ts:84–100` 的真实 wrapChildStream 给事件添加 agentId。不是靠虚构无 agentId 的后台事件触发。
- 预期：父任务已完成时，后台子任务继续显示自己的输出和状态；父任务仍运行时，子任务错误也不应清掉父任务的 live accumulator。现有 child terminal 处理和 Core 转发注释都承诺按 agentId 隔离。
- 实际：主 turn_complete 后接收 child detail 会把全局 run 从 completed 改回 running，随后 child assistant_message、turn_complete、agent_end 全部完成，所有 bubble 已 done 且 liveByAgent 空，global run 仍为 running。另一个正常分支是父轮运行时，scoped child error 将它变为 error 并移除父 bubble 的 live 引用。
- 影响：`packages/web/app/DesktopApp.tsx:332–338` 用全局 run 阻止发送，Mobile `packages/desktop/src/mobile/App.tsx:123` 用它选择运行/停止 composer 状态。后台子任务工作期间，本来已空闲的主会话可被显示为忙；子任务结束本身不会恢复。实际 Host 后续续跑、主 terminal 或新 snapshot 可能恢复，不声称永久阻塞或 Host 本身忙状态错误。
- 首组 [fixture](evidence/root-web-state.test.ts)/[原始日志](evidence/root-web-state.first.log)：真实 reduceStream、wrapChildStream 与 chatFromSnapshot，4 pass / 15 expect。其中 actual snapshot 函数的 `{running:false}` 加后续 buffered child delta/terminal 仍得到 running，另含 child error 和正常显式主 terminal 恢复控制。
- 第二组 [fixture](evidence/root-web-background.test.ts)/[原始日志](evidence/root-web-background.first.log)：真实 Agent background branch、registry、notificationQueue、wrapChildStream 与 Web reducer；注入 deferred 内存 spawner，先模拟父 terminal，再释放子执行。确认真实 Agent 转发、registry completed、子行 completed、完成通知入队，global run 仍 running。1 pass / 8 expect，首次成功。没有真实 Engine 父/子回合、模型、工具进程、Host/HTTP/WS、DOM或发送按钮操作；UI影响是源码接线。辅助输出仅写 runner 的自有 HOME，registry/queue 清理。
- 子 late detail 与 child error 归为同一 agent scope 根因，修复方向是各事件只更新自己的 bucket，并由主会话生命周期决定全局 run；没有拆成额外确认项。

## WEB-R5-02 [P3] 乱序工具结果回填绕过正常的模型上下文显示清理

- 位置：`packages/web/src/lib/streamReducer.ts:329–338` 缓存原始 orphan result，`:290–292` 在 tool_use_start 到来时原样应用；有序结果分支 `:350` 则调用 stripSystemReminders。该 helper `:20–24` 的显式用途是隐藏模型上下文附注。
- 条件：工具结果先于 tool_use_start 被交给 reducer，内容包含普通 `<system-reminder>` 附注。当前源码和既有 `streamReducer.test.ts:67` 明确支持结果先到的回填行为，本项不依赖证明真实 WebSocket 自己会改变帧顺序。
- 预期：同一结果无论以支持的哪种顺序到达，最终用户可见文字一致。
- 实际：同一工具/正文，有序显示 `Visible answer.\n`，先结果后 start 显示完整提醒块，两个都 done:true。乱序路径是明文原样保留，没有走统一显示转换。
- 影响仅为条件触发的显示不一致、暴露本应隐藏的普通模型附注；不声称远程攻击、敏感数据泄露或真实生产传输乱序已经发生。P3。
- 证据在首组第4个测试，已经计入该组 4 pass / 15 expect；不另计一次执行。没有真实浏览器或 transport。

## 去重、候选和覆盖边界

[去重记录](evidence/root-web-dedup.json) 对前三批及第四批 audit、review、archive 的正文/JSON做定向扫描，另阅读旧 Web priority-and-coverage 与近期分报告。没有找到同根因已确认项。旧 A12 是 headless JSON fallback 混入子代理正文，旧 N02 是 provider 重试保留失败前缀，均不是当前 Web reducer 全局生命周期处理。

进一步逐记录解析 May30 minified JSON，没有同项；初始全文 regex 的若干命中跨越不同 JSON entries，不作相同 finding。June23 beta audit `:489–490` 记录的是旧 assistant 不封口、先到结果丢失，后者已通过添加 orphan buffer 修复。WEB-R5-02 是当前回填分支未做显示清理的残留差异，原结果不丢失，根因/改动位置不同。July9 protocol review 描述的是主 terminal 与子事件隔离合同及转发，不是当前 Web 同根因已确认 bug。

相邻已读：messageMappers、transcriptReplay、userMessageDisplay、roomHistory、format、outputCoverage、mobileAttachments、environment、storage、remoteAppSync、service worker/register，以及 useRemoteApp/chat/DesktopApp/Mobile App 的相关调用段。没有把旧 POSIX cwd 小写合并、旧 legacy history 附件、ACK重发、配对/上传故障再登记。只读邻接不是动态全功能覆盖。

候选未测试/不计确认：maxRoomSeq 对较旧 latestSeq 可能回退当前 cursor，但尚未证明普通生产时序与用户影响；CC 历史 tool starts 未显式封口，需要区分正在观察的外部会话与静态历史；清空 Goal 后 late update 的状态残留缺少当前有序 stream 的正常时序证据。认证、权限、安全、真实浏览器/平台、任何已失败 CLI/recorder/Discord/summary 方向均未开展或重试。
