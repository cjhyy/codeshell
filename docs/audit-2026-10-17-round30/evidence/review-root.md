# Round30 Root 方向独立复核

支持 [Root 正式报告](../root-report.md) 的限定静态结论：**0 formal / 0 candidate / 0 new-related**。未发现需修改作者材料的 source/provenance/分类/validation 元数据错误。产品/测试/fixture/import/函数/stdin/TTY/native/Git/network/auth/identity 实验均为 0，作者脚本/verifier 未执行。

语义复核已在 [独立 prep review](root-review-prep/review.md) 冻结，之后仅做 formal 元数据核对，0 新增产品语义读取。Intl 94 全文、format 139–300、earlyInput 60–110、internal export 60–90，共 338 作者产品范围行；旧 R14 utils 全文 40 行。额外 McpSection 1092–1112 的 21 行只用于消歧同名本地 helper，不能变成 Core formatter options 的新消费者，也不是 MCP 权限/凭据覆盖。6 个 reviewer source pins 共 399 声明读取行（2 full / 4 selected），原始读前与 finish SHA 保留在 [复制的 reviewer source manifest](root-review-prep/source-manifest.json)，不重新计数为 formal 读取。

Intl 的固定 granularity 缓存、style:numeric formatter cache、locale unavailable 的 undefined 缓存、first/last grapheme 与消费者按返回长度删除的合同，均支持有限 negative；未测试 Intl 平台或输入分块。showTime=false 的短期 reset 分支和 relative short style 是 R14:31 已排除的孤立 API 线索；package 名称导航未建立更强普通消费者合同。Desktop 同名函数为另一实现，internal export 也不能证明格式器 options 的生产可达性。R14:38 已记录 intl 静态阅读，所以旧 hash-only manifest 提示不等于历史从未语义读过。本复核不为 negative 制造新候选，也不声称整个 helper 家族无 bug。

正式 [作者 source manifest](root-source-manifest.json) 的 5 行 source records 与 [作者 copied prep](root-prep/source-manifest.json) 逐字段相等，338 产品 + 40 旧报告只是一轮作者语义阅读。正式 baseline 19efab9225723c76af447f8b9d9f65aace3b0780 与原 prep parent b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0 分开；reviewer 无 Git 绑定声明。4 个产品 source 的原 before-read pin 与原 initial/consumer pins 对应。旧报告专用 pin 晚于历史 excerpt、早于直接全文，active initialSemanticReadSha256=null；first 错误 true JSON 和更正说明均逐字保留，不倒填成首次语义读前证明。

[作者 receipt](root-artifact-receipt.json) 列出的 10 个正式冻结 artifacts bytes/SHA 全匹配，加 receipt 当前捕获共 11 项；作者 12 份 prep copies 仍与 exact /tmp 原件逐字相同；正式报告 12 个本地链接存在。作者三类分类为空数组，validation runs 为空、计数为 0，newSemanticReadsDuringFormalization=0。当前作者报告/JSON artifact checks 与产品/旧报告 source rows 在 [独立 formal manifest](review-root-source-manifest.json) 中分列，不冒称当前 Round30 文档属于正式 baseline blob。

正式历史已独立以 stdlib 文件/hash/JSON scalar/regex 重查：包括冻结29、排除当前30，2851 文件 = 1285 MD + 1566 JSON，597236 strings / 884863 scalars，169 exact archive/_archive 路径，0 parse errors。inventory 的全部路径、bytes、当前 SHA 和计数均吻合；三组 matches 111/15/146，cap100 保留100/15/100。原 prep 的 2765（排除当时 mutable29/future30）、counts111/15/133 及原时点保持不变；新 metadata 不是第二次产品阅读，关键词及 capped contexts 也不是历史语义穷尽。

reviewer 原始 4 份 prep artifacts 已按 [copy receipt](review-root-prep-copy-receipt.json) 逐字保存于 root-review-prep，原 parent/时间/读前 pins/finish hashes 未改。旧 i18n/CLI/stdin/Slice/import 动态失败方向继续 SKIP，旧 R14 测试通过或失败只作历史文本，未转作本轮验证。此报告只支持已声明范围的 negative，不扩大到 Intl 平台、格式器全集或全仓。
