# 候选、旧问题与跳过

下列均不计本批 5 个确认问题，也不需要修支架或新增平台实验来补成通过。

| 方向 | 处置 | 分报告 |
| --- | --- | --- |
| Prompt custom system prompt 与 preset sections 并存 | May30 已记录，同根因重复排除，未新增实验 | [Prompt](prompt.md) |
| Prompt composer 缓存编辑后不刷新 | 当前 Engine 每轮创建新实例，缺正常生产失败链，不计 | [Prompt](prompt.md) |
| Profile name/目录不一致、basePreset/general、snapshot/live字段、无inventory exclusivity | 当前明确语义或没有支持的正常 producer；未推广为 bug | [Profile](profile.md) |
| Profile repo grammar 超过 safe key grammar | 显式能力边界，未建立更广支持合同；无网络或替代路径实验 | [Profile](profile.md) |
| DingTalk 业务错误响应检查 | 主源未给出当前精确响应契约，只留静态候选，无 fixture | [Chat](chat-text.md) |
| WhatsApp CTA/caption | 旧未确认候选；主源首次 open Internal Error 后跳过，无重试或镜像/浏览器/CLI替代 | [Chat](chat-text.md) |
| Slack link label 格式、WeCom UTF-8 长度 | 尚不足以确认当前协议的功能故障；没有真实发送 | [Chat](chat-text.md) |
| Web maxRoomSeq 回退、CC静态tool封口、late Goal update | 需要进一步证明当前正常时序/合同与影响，未执行 | [Web](root-web.md) |
| June23 orphan result 丢失 | 旧 bug 已由 buffer 修复；当前 WEB-R5-02 是 buffer 分支未清理显示文字，不是丢结果 | [Web](root-web.md) |
| 旧 Slack thread/附件名、Telegram fence、FIFO、Web cwd/ACK/history | 已有报告排除重复，没有重跑 | 各分报告 |
| 先前失败 CLI/data/recorder/JSON-summary/Discord/memory-TTL | 保持跳过；本批未修支架、重试或换方法继续这些方向 | 各分报告 |

本批没有失败 guarded 产品测试 shard。Prompt 收据汇总的 Python 数字解析曾断言失败，是材料组装问题；原 tool response 以明确的转录说明保留在 [assembly note](evidence/prompt-receipt-assembly-note.md)。从不变的首跑日志纠正元数据，没有改 fixture、重跑测试或把它计为产品 bug。WhatsApp 主源读取失败是研究跳过项，也不算失败 Bun shard。
