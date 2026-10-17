# CodeShell 审查第五批（2026-10-17 checkpoint）

本批确认并记录 **5 项：3 P2、2 P3**。仅新增报告、复现与原始收据，未修产品源码。触发条件、源码行号、预期/实际、影响和验证边界见分报告；结构化入口 [findings.json](findings.json)。

冻结源码：`9a421b3e65d5bfe662b78062cb86bd99483a683a`。独立分支 `codex/audit/prompt-profile-web-round5-20261017`。审查期间另一个任务推进本地 main，正常整合但不改变首跑证据基线，见 [integration-context.md](integration-context.md)。主目录原有改动保留；未推远端。旧四批报告保持冻结，历史数量不能直接累加为当前剩余 bug 数。

| 编号 | 优先级 | 问题 | 详情 |
| --- | --- | --- | --- |
| WEB-R5-01 | P2 | 子代理 detail/error 改写主任务全局运行状态 | [Web](root-web.md) |
| WEB-R5-02 | P3 | 乱序工具结果回填遗漏正常的显示清理 | [Web](root-web.md) |
| PROFILE-R5-01 | P2 | 不同目录源键碰撞，混淆来源且互相删除缓存 | [Profile](profile.md) |
| PROMPT-01 | P3 | 祖先 local 指令先于子目录 project，偏离声明的顺序 | [Prompt](prompt.md) |
| CHAT-R5-01 | P2 | LINE 按钮标签/URI 投影超出平台字段上限 | [Chat](chat-text.md) |

[验证汇总](validation.json)：**7 个首次完整成功 guarded shard，104 pass / 330 expect / 0 fail / 0 skip**。其中86项为明确列出的 Profile/run-setup 既有基线，18项为本批聚焦错误行为与正常 controls。共享日志只计一次，复核新增执行0。所有确认项均未修复，断言通过表示错误行为被复现。

动态范围：真实 scanner/composer/preset/cache、真实 Profile 本地 reader/remover/registry、真实 Web reducer/snapshot/Agent后台转发、真实 ChatGateway/Mimi/LINE adapter；外部执行部分使用内存 spawner/model-free callback/transport，自有文件和隔离 HOME。没有真实模型、语言服务器、平台发送、账号、Host/WS、浏览器/DOM或Native应用验收。LINE字段限制已对照官方主源，超限 payload 是实测，平台拒绝不是实测。

没有失败 guarded 产品 shard。WhatsApp 主源首次读取失败后跳过，DingTalk契约不足保留候选；Prompt一次材料数字解析失败有透明说明，未改测试或重跑。先前 CLI/recorder/summary/Discord 等失败方向未重试。见 [候选与跳过](candidates-and-skips.md)。

只读交叉复核：[Prompt审Web/Profile/Chat](quality-prompt.md)、[Profile审Prompt/Web](quality-profile.md)、[Chat审Profile](quality-chat.md)。[主审质量核对](quality-root.md)、[覆盖范围](coverage.md)、[冻结源码SHA](source-manifest.json)、[证据SHA](evidence-index.json) 分开保存。没有全仓 build/typecheck/lint/完整测试通过声明。

**持续审查仍在进行，本批不是全仓完成。** 独立 Panel Apps 仓库未开展全仓审查。
