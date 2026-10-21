# 正式64：认证、Panel来源、附件与Hook来源

> **当前状态（2026-10-21）**：120 条已全部处理。119 条已修复；ATT-R9-01 主路径已修复，其余部分记为已知限制。逐条状态与修复提交见 [STATUS-2026-10-21.md](STATUS-2026-10-21.md)。以下原文为本轮冻结的审计记录，未改动。

新增 **1条P2：ATTACH-R64-01**。同会话相同图片复用磁盘文件但使用不同附件ID，旧草稿24h清理会删掉仍在30d保留期内的已发送图片。[问题详情](attachment-retention.md)、[首次fixture](evidence/attachment-shared-path.test.ts)、[原始日志](evidence/attachment-shared-path.first.log)。

首次规定guarded shard：**1 pass /11 expect /0 fail /0 skip，exit0，Completed**。运行真实附件服务和自有临时FS，使用公开now参数；断言当前错误与独立路径正常对照。未修产品，未启真实UI/native/网络或账号，未重跑失败方向。

| 范围 | 有限结论 |
| --- | --- |
| [172认证](evidence/server-auth/report.md) | HTTP/store两文件完整静态及实际HTTP/WS/Web链，970产品语义行，0新问题；旧认证/锁因保留，作者0执行 |
| [173 Panel GitHub](evidence/panel-github/report.md) | 五目标算法全文及真实安装/update消费者，1009产品语义行，0新问题；不把导出的ref helper当实际安装调用，作者0执行 |
| [174附件](evidence/server-attachments/report.md) | 图像字节叶全文和staging/manifest/TTL/实际启动调用选段，1228产品语义行，提出同一P2；旧SOF3及限额问题不重报，作者0执行 |
| [Root175](evidence/root-settings/report.md) | Hook来源完整叶与真实readonly policy/merge/选择/Host消费者；935语义行含Root附件反例独立选段，不能与174叠成唯一新增覆盖 |
| [176独立反证](evidence/attachment-peer/report.md) | 实查UI移除只改state、同PNG再次添加/正常发送与启动TTL清理，支持同一P2只计一次；独立读Root首fixture/log，未重跑 |

累计 **120条正式历史记录（47P2、73P3）**，另42历史候选；当前未修复数未逐项认证。[全部问题](ALL-ISSUES.md)、[机器目录](recorded-findings-catalog.json)、[历史候选](../audit-2026-10-17-round61/HISTORICAL-CANDIDATES.md)。并发main已替换旧MCP点号写法，单列[源码状态](evidence/concurrent-source-status.json)，不冒称运行重验或旧数据修复。

共享机器历史导航纳冻63排64+，6801 MD/JSON、5060759 JSON value scalar访问、errors[]，archive/hidden/unignored含。各目标cap与真实旧canonical范围由原包记录，机器导航不是全史语义或根因唯一性证明。174另一次有限cause query6/6命中均不同因，未作全史穷尽声明。

263份原件逐字节复制、521条收据检查、15冻结锚点；62混合pins不是同数产品全文。原始metadata错误、显示截断与176首次混合evidence列表及其后拆分保留，未修饰冻件。归档首metadata脚本仍断言0份raw log而失败，发生于stage前；已按本轮1次验证改为1份，首方法/输出完整保留，不重跑产品。Root新增fixture/raw/exit单独按task-owned evidence核对，不能绑定为源读取baseline Git产品文件。[源manifest](source-manifest.json)、[冻结](evidence/freeze-checks.json)、[验证](validation.json)、[字节索引](evidence-index.json)。

读取基线`5fa6a076db90682733c33fd46e1f473f9214d196`，所有读者冻结后main`2bbb517b615a6035e1c68fa8cac13f0b6f3a1eb2`，incoming15路径只做范围核对及MCP bounded diff说明；未认证并发更新的全部行为。本轮只集成审查材料，保留主目录既有改动，不push。当前原4643台账367/377/3899，4276未标完整，63/64源阅读未回填，[剩余边界](COVERAGE.md)。总目标active。
