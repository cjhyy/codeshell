# Mimi Chat 离线回放与回归覆盖

日期：2026-09-06。目的：用真实历史输入驱动可重复的故障回放，修复聊天链路，保留长期回归入口。

## 运行

在仓库根目录执行：

```sh
bun run test:mimi-chat
```

这条命令覆盖 Chat、Pet、Desktop Pet、IM service、通用 profile 轮次上限与跨层聊天回放。包边界修改后先执行 `bun run build`；完整类型门禁为 `bun run typecheck`。

测试使用临时目录、脚本 LLM、内存 RPC、模拟微信接口和模拟 Work 启动。不会发送真实微信消息、调用付费模型、执行历史输入中的 Star 或浏览器操作，也不会改写用户历史会话。测试不依赖本机历史文件。

## 回放层次

- `tests/mimi-chat-replay.test.ts`：真实 ChatGateway → Mimi middleware → PetDispatchService → AgentClient/AgentServer → Engine/Pet tools → host-action receipts → reply enrichment → 模拟渠道发送。桌面 Electron 广播、附件 staging 和 Work 执行使用已有独立测试；控制入口适配在测试中组装。
- `packages/chat/src/mimi-wechat-replay.test.ts`：真实 WechatAdapter 解析、持久 inbox/附件 spool、ChatGateway 与 Mimi middleware；平台 HTTP/CDN 和 desktop.petChat 使用模拟接口。
- `packages/pet/src/engine.chat-replay.test.ts`：真实 Engine、多轮历史、Sessions/FollowUps 读取、工具参数校验与动作收集，LLM 使用脚本。
- `packages/core/src/engine/engine.profile-max-turns.test.ts`：通用 profile 上限、Goal 修改/扩展、普通 Work 隔离及无工具收尾。
- `packages/core/src/engine/engine.profile-input-change.test.ts` 与 `turn-loop-steer-backfill.test.ts`：仅已持久化的新输入使草稿失效，排队/撤回/重复输入不触发，保持注入顺序。

## 验证结果

- 统一命令：**983 pass / 0 fail / 3,202 assertions，108 个测试文件**。
- 另跑 Core 注入、Goal lifecycle、reply/background yield 组合回归：73 pass / 0 fail。
- `bun run typecheck` 完成构建与全部 11 个 workspace 类型检查。
- 本次变更的 ESLint、Prettier、Engine 架构边界检查与 `git diff --check` 均通过。
- 100 条持续聊天产生 100 个管理调用与 100 个回复；三个草稿反例分别验证新输入后的普通 final、模型错误、上限终止。

## 历史案例对应表

样本来自此前本机 Mimi transcript；仅保留代表性输入，省略私人文档链接、账号、会话 ID 和文件路径。相邻输入按任务上下文组成案例，不把用户的模糊短句孤立地当成完整任务。

| 历史输入 / 故障 | 已验证的契约 | 主要回归文件 |
| --- | --- | --- |
| “就是这个 给我解释一下题目” | 多轮保留历史；GatewayReply 提交后停止，只有一条回复 | `tests/mimi-chat-replay.test.ts` |
| “你给我题目内容啊 不要每次都是追加结果” | 前轮内容进入下一轮；回复正文完整穿过渠道 | `tests/mimi-chat-replay.test.ts` |
| “新开一个session 然后做这个工作” | 省略 selector 时新建；同批委派＋回复采用真实启动回执；失败不说完成 | `tests/mimi-chat-replay.test.ts` |
| “继续执行啊” / “再点一遍文档里新增的repo 给我总结” | 精确 selector 与 Workspace 匹配；畸形续办参数不能静默新建 | `engine.chat-replay.test.ts`、`delegate-work.test.ts` |
| 新目标误接旧 Archify 会话 | 同 URL/项目不自动推断复用；新建/续办参数执行一致 | `pet-dispatch-service.test.ts`、跨层回放 |
| “现在有哪些session” | 错误 `list + session_id + query` 后可修正；序号对应真实列表 | `engine.chat-replay.test.ts` |
| “你自己去session里面看” / 精确跟进项 | FollowUps 字段映射正确；启动不等于完成；重复错参受上限约束 | `engine.chat-replay.test.ts`、`pet-dispatch-service.test.ts` |
| “处理啊 点完了吗” / 旧日志 20 多次重复报错 | 6 个工具推理轮后停止，最多额外一次无工具收尾；宿主拒绝总结中的虚假完成说法 | profile 上限测试、跨层回放 |
| “不要答案，只要题目” 连续补充 | 同来源 steer；成功修订只发新回复；失败/达上限不发送旧草稿 | `tests/mimi-chat-replay.test.ts` |
| 同时从两个会话输入 | 分开调度，回复仍属于各自来源；相同平台消息 ID 不串路由 | `tests/mimi-chat-replay.test.ts` |
| “讲解一下图片内容 给我分析一下结果” | 图片在持久接收后使用已保存字节，不重复访问可能失效的 CDN 地址 | `mimi-wechat-replay.test.ts` |
| “附件发我” / 已知图片路径 | 合法渠道附件走 GatewayReply；宿主拒绝附件时不说已发送 | `host-action-reply.test.ts`、`pet-dispatch-service.test.ts`、跨层回放 |
| 微信重复入站、发送异常、上下文失效 | 重复入站去重；并发发送共享结果；重试复用内容；新上下文到达后补发 | `mimi-wechat-replay.test.ts`、`gateway.test.ts`、`pet-dispatch-replay.test.ts` |
| `/clear` | 宿主确定性处理，不调用 LLM | `tests/mimi-chat-replay.test.ts`、`pet-segment-controller.test.ts` |
| 100 条持续输入 | 100 个管理调用、100 个回复，无提交后重复推理，无动态 world 重复持久化 | `tests/mimi-chat-replay.test.ts` |
| “记一下…” / “打开远程遥控” / “有什么进度通知我” | 精确宿主动作、真实回执、持久记忆与订阅边界 | `engine.chat-replay.test.ts`、`host-action-reply.test.ts`、`pet-long-task-coordinator.test.ts` |
| “给微信说一下现在几点了” / 桌面主动发微信 | CurrentTime/SendMessage；桌面不提供 route-bound GatewayReply | `engine.chat-replay.test.ts`、`outbound-message.test.ts` |
| 进入工作会话后退出、取消不存在的任务、重启后完成通知 | 既有绑定/退出/通知路由、取消与终态重放回归一起执行 | `session-conversation-bridge.test.ts`、`pet-long-task-coordinator.test.ts` |

## 本次修复

1. 持久入站附件直接使用本地 spool，避免微信图片二次下载失败。
2. 并发重复消息共用发送过程，避免共用模型结果却仍发送两次。
3. 严格校验 DelegateWork 的未知字段、Workspace 与续办 selector；错误参数不降级成新任务。
4. 修正 FollowUps 真实输出字段与提示中的映射关系，强调启动回执不等于工作完成。
5. 增加通用 profile 轮次上限，Mimi 设置为 6；Goal 编辑/扩展不能绕过，普通 Work 沿用原有规则。
6. 模型失败或达到轮次上限时，宿主提供明确失败回复；停止执行可能过期的回复草稿。
7. 新输入实际注入后，使待发送 GatewayReply 草稿失效；新一轮普通 final、失败或上限终止都不会复活旧草稿。

## 验证范围与剩余边界

脚本预先指定模型输出，能证明工具、状态与交付契约，不能证明真实 LLM 在任意自然语言下都会选择正确任务或补全正确题干。尤其“新开”语义与模型显式给出的旧 selector 冲突，尚没有完整的结构化意图证据契约；本次没有引入关键词猜测路由。

100 条回放证明持续聊天与回复停止行为，没有证明完整输入 token 有硬预算。辅助摘要、记忆提取的调用与 6 轮管理预算分开；这不是整个系统最多 7 次模型调用的承诺。

绑定 Work Session 的媒体直达接口尚未完整传递附件；本次图片验证覆盖 Mimi 入站路径。真实微信账号的端到端送达、平台未知 ACK 下的 exactly-once、长期上下文预算和真实模型语义表现，不能由离线测试宣布验收。
