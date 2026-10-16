# scheduling / chat 与最终索引只读质量复核

冻结基线：`ab8b03f86ad38835939d4125b56bf4513cae7f15`。复核人：`desktop_data_round2`。本复核只读报告、生产源码、首次原始 stdout/stderr 和旧记录；**新增测试执行 0**，没有重跑任何失败支架、没有修改其他作者报告或产品/Git。下列通过是证据质量结论，不是重新执行结果。

## 第一部分：scheduling-data.md

| 项目 | 结论 | 核对要点 |
| --- | --- | --- |
| TIME1 / P3 | 保留 | `cron-expr.ts:60–61,72–74` 的两次 split 解构确实忽略额外段。文件 `:6` 明列合法语法，`:93` 承诺非法输入抛错；`scheduler.ts:557–559,795–801,1230–1242` 要求创建/更新前校验。原始 round1 首项看到非法串通过 validation、展开为另一分钟集，并实际更新内存 job 的 schedule/prompt。P3 与 typo 输入和局部配置误导范围相称。 |
| TIME2 / P3 | 保留，必须维持 Host 条件 | `cron.ts:205` 无 timeZone 的 formatter 使用工具运行进程的本地时区，`:207–208` 把 job timezone 直接贴在一次性日期后。原始 once 收据明确 Host=UTC、job=Asia/Tokyo；nextRun=2026-10-18T00:00Z 正确，Host 文案为 00:00、Tokyo 文案为 09:00。只确认显示错误，底层调度绝对时刻没有被证明错误。 |

TIME2 生产可达性不依赖 fixture 替换 formatter：CronCreate schema `cron.ts:83–86` 允许显式 IANA 时区，描述 `:59–60` 要求按用户时区设置。Desktop worker 在 `cli/agent-server-stdio.ts:409` 安装 Main authority；`automation/desktop-authority-client.ts` 返回 Main 的 CronJob。`cron.ts:188–198` 的 authority/local 分支在 `:203–210` 汇合后共用同一显示代码。因此 Host formatter zone 与 job zone 不同即可触发；当前 fixture 动态执行的是 local scheduler 分支，Desktop 接线只作静态确认。Host 与 job 时区相同的普通情况不能泛化为误显示；周期字符串也没有直接把时区后缀贴到 Next run，报告已正确将其限定为不明示 Host 时区的歧义。

首次收据均有 Completed：`time-cron-data-round1.log` 2 tests / 12 expect；`time-sleep-data-round2.log` 2 / 5；`time-cron-once-display.log` 1 / 3；`time-scheduling-baseline.log` 44 / 143。合计 **4 shards / 49 tests / 163 expect / 0 fail / 0 skipped**。`time-source-manifest.json` 的 6 个源码及 7 个 fixture/log 共 13 个当前 SHA-256 全部与记录一致；本复核没有重新调用 Git 验证冻结 blob。

Sleep 中途 abort 的 Slept acknowledgement 已由 `docs/review-2026-10-12/goal-sleep-round20.md:63` 记录，本轮只作旧边界复核，不新增 finding。两年 cron 搜索上限也有源码明确限定，未计缺陷。

## 第二部分：chat-data.md

| 项目 | 结论 | 核对要点 |
| --- | --- | --- |
| CHD01 / P2 | 保留 | `slack.ts:67–77` 接受正常 thread message，但没有将 event.thread_ts 投影到 ChannelMessage；`chat-gateway.ts:111` 的 reply 只传 target；`slack.ts:134–136` 正文 postMessage 无 thread_ts。真实 adapter run/onEvent → Gateway.dispatch → adapter.send 已在首次内存 SDK fixture 中走通，两个不同 thread 都构造频道顶层 payload。普通回复的会话定位丢失足以支持 P2，不能扩大为真实 session 合并/跨账号/泄漏结论。 |
| CHD02 / P3，长 remote/SDK 标签条件 | 保留条件项 | `media.ts:232,234` 按 UTF-16 code units 截断；`:52` remoteAttachment 调用此 helper，`attachments.ts:61` 原样保留 name。原始测试以 254 ASCII + emoji 的完整 Unicode 标签触发尾部 lone high surrogate 0xd83d，并验证编码后 U+FFFD；短 Unicode 标签正常。只证明共享普通元数据转换及 bridge payload，不推断所有真实平台都接受这种长标签，也不将其写成本地 APFS 文件名复现。 |

Slack 官方 `chat.postMessage` 对 thread_ts 的定义支持“携带父 ts 才在原线程回复”，参见[官方方法文档](https://docs.slack.dev/reference/methods/chat.postMessage/)。这与原始 payload 结合可推出频道顶层定位；真实 Slack 服务端/UI 未执行。项目 `ChannelMessage.threadId?: string` 位于 `channel.ts:117`，但是 `ChannelCapabilities` 与 README 能力矩阵没有显式承诺完整 threads 支持：保留原线程是正常 reply 定位预期，不能改写成项目已有完整 thread 能力声明。没有发现本项目明确将线程回复到主频道规定为设计行为的文档。

首次成功收据：`chat-slack-thread.log` 1 test / 5 expect；`chat-text-metadata.log` 2 / 16；`chat-channel-baseline.log` 2 / 58。合计 **3 Completed shards / 5 tests / 79 expect / 0 fail / 0 skipped**，与 `chat-receipts.json` 一致。

`chat-discord-chunks.log` 为 **0 pass / 1 fail / 1 error / 无 Completed**。顶部 `import { ChannelType } from "discord.js"` 在依赖解析阶段失败，业务断言未运行；只能保留静态候选/首次失败缺口，不能计成确认发现、成功测试或已验证 Discord 分块覆盖。fixture 没有被修复/重跑。WhatsApp 上限候选未实验，Bound Session 附件直达属于既有明确交付限制，报告均已分账。

## 查重与修正清单

结构化只读检索了旧注册表：10-16 findings 25 条、remaining-10-12 findings 33 条、05-30 findings 296 条 / confirmed 30 条 / backlog_confirmed 91 条；并查阅 10-12 automation-round5 和 goal-sleep-round20。检索包含 thread_ts、Slack thread/线程、safeAttachmentName、filename surrogate、附件名 Unicode/emoji、malformed cron/separator、CronCreate timezone/时区、toLocaleString 等。有限检索不是旧文档全量语义证明。

- TIME1 的近似旧条目为 05-30 `Silent default fallback masks invalid schedule configuration`，旧位置 `core/src/cron/scheduler.ts:131–136`，触发 interval `5mn` 后回退硬编码十分钟。本项是当前 `automation/cron-expr.ts` 忽略多余 range/step 段，具体输入、根因和修复位置不同，不作同项重复。
- TIME2、CHD01、CHD02 在上述有限旧检索无同根因命中。10-16 SWC 的错 adapter/账号、队列与回环家族和本轮线程定位不同。
- 唯一文字修正已由作者完成并只读复查：`chat-data.md` 的 Slack 主源 URL 原为小写 `chat.postmessage`，本次直开返回 404；现为规范大小写 `https://docs.slack.dev/reference/methods/chat.postMessage/`。报告也已准确限定官方搜索摘要/摘录的证据来源、未成功打开原小写 URL、reply 定位预期和 capabilities 非完整 threads 承诺；不影响本地动态收据。
- 无需重跑测试或修改产品的阻断性修正项。

## 最终索引核对

根补入 CHD02 后，逐项只读核对 `findings.json`、README 和七份分报告：**26 个唯一正式 ID，11 P2 / 15 P3**；Root 11、Sources 3、OM 4、UI 3、Pet 1、Time 2、Chat 2。README 表格 ID 集合与 JSON 完全相同，没有缺漏或重复；每个 reportLine 都落在对应编号标题，源码路径和行存在，引用日志均可读且进入 validation。CHD02 保留长 remote/SDK 标签条件；TIME2 保留 Host/job 时区不同条件。OM2、R2-12/13、Discord、WhatsApp 和 Sleep 旧观察均未进入正式 finding 集合。

独立读取 **37 份原始测试日志**，按原文 pass/fail/error/expect/Completed 收据解析，并复算 SHA-256 与 `validation.json` 对照：没有未索引测试日志、重复日志、哈希或数值差异。完整成功组为 **34 shards / 227 pass / 777 expect / 26 filtered-or-skipped**，其中基线 7 shards / 167 pass / 568 expect / 26 filtered，聚焦观察 27 shards / 60 pass / 209 expect / 0 skipped。首次失败三组（Chat Discord、OM round1、Root summary）单独保留；它们的局部 pass/expect 没有加入上述 clean totals。`source-manifest.json` 当前 **46 个文件**的 SHA-256 与工作区相符，unresolvedReferences 为空，26 个 finding 的生产源码均被 manifest 收录。这里不重复执行源码与冻结 Git blob 的比较；沿用 manifest 的 frozen-match 收据。

**OM3 的确认边界单独复核通过。** 原始 round1 第一项先用 Date.parse 证明 newer 晚于 older，再真实 saveSessionMemory/listSessionMemories 打印 expected=[newer,older]、actual=[older,newer]，两项断言通过；`session-memory.ts:146–148` 接受可 Date.parse 的有效 offset 时间，`session-memory-sort.ts:4–7` 明确 most-recent-first，`:12` 却比较原字符串，因此首项足以支持 SDK/导入有效 offset 时间的窄 P3。该文件后续三项失败、整组 1 pass / 3 fail / 7 expect、无 Completed；不能宣称干净门禁、完整 memory suite 或内建 toISOString writer 同样受影响。TTL/promotion/approval 三个后续候选仍从不计正式发现。

README、validation 和候选账本目前均明确上述分账，并将独立质量复核标记为新增动态执行 0。最终判断：**索引、优先级、报告锚点及统计一致；无需补实验，无待修阻断项。** 本质量文件收束后需由根作者按原交付流程刷新 evidence-index 中本文件的哈希。

根作者另行提供交付收据：仓库规则忽略 `*.log`，已显式纳入本任务 42 份原始日志（包含测试及只读查重等日志，故多于上述 37 份测试日志）；staged diff 的唯一 whitespace 提示为 `root-summary-json.log:22` 原始 Bun 诊断行 `47 | ` 的尾空格。该空格属于首跑 stdout/stderr，保留逐字节原始证据；不建议修剪或重写原始日志。其余非 log 文件另作 whitespace 检查。这是根作者的 staged 检查边界，本分审未执行 Git 检查，不将其解释为产品失败或实验重试。

## 本复核自身的只读缺口

辅助源码查找中引用的几个推测路径不存在（`main/cron-authority.ts`、`cli/cron-authority.ts`、`chat/src/integration.ts`、`chat/src/pet-bridge.ts`），另一个 `runtime/*automation*` glob 无匹配；这不是实验或产品行为证据，均未修支架或执行测试。随后只用已有源码中的明确符号完成静态接线检视。Slack 小写 URL 直接读取失败如上记录；没有真实平台请求或登录。
