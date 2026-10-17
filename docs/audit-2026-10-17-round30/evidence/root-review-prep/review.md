# Round30 Intl/helper prep 独立复核

支持冻结 prep 的 **0 formal / 0 candidate / 0 new-related**。没有发现需修改 prep 的 source 范围、字节、pin 时序、receipt 或历史计数错误。此结论限于声明范围，不能表述为全部 Intl、格式器、输入处理或仓库无 bug。

原 prep parent 为 b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0，保持原样。Root 后来提供的 Round30 formal baseline 19efab9225723c76af447f8b9d9f65aace3b0780 在这里仅作上下文，不覆盖 prep parent。reviewer 未运行 Git，当前 filesystem SHA 不是对两个 Git snapshot 的绑定。

在独立 source 范围复读前保存 6 个文件 SHA，结束重查均一致。[source manifest](source-manifest.json) 分开产品/旧报告 source、作者 artifacts 与 navigation。复读作者全部声明：Intl 1–94 全文、format 139–300、earlyInput 60–110、internal export 60–90，共 338 产品行，另旧 R14 utils 1–40 全文。为消歧 package 导航的同名函数，只额外读 Desktop McpSection 1092–1112 的 21 行（本地 helper 1092–1102，其后为相邻声明），不作为作者 coverage 或权限/凭据审查。总共 399 声明读取行、2 full / 4 selected；rg 单行 import 还显示 format:3 与 earlyInput:14，仅作接线导航，不加入语义覆盖。

静态依据与限制：

- Intl 的 grapheme/word segmenter 按固定 granularity 懒初始化；relative formatter 以 style:numeric 为缓存 key。first/last 的空串分支明确返回空串，last 取最后一个 grapheme segment。earlyInput 97–98 删除返回 segment 的 UTF-16 length，与此 helper 的返回合同一致。没有构造 Intl 实例或输入 chunk、运行 stdin/TTY、平台 locale、终端、真实输入捕获。
- system locale 的 null/undefined 区分保留“未计算/已计算但不可用”；这里只认源码的 cache 边界，没有运行 ICU/locale 或推断进程 locale 变化合同。
- format selected 139–300 的 relative/reset/log helpers 与内部调用可见。showTime=false 的短期分支和 relative short style 正是 R14 utils:31 已排除的无普通消费者线索。R14:38 也明确 intl 已作静态阅读；旧 structured hash-only row 不能据此变成“首次语义审查”宣称。
- [package 导航原文](consumer-navigation.txt) 的 Core family 命中只在 format.ts 自身；Desktop McpSection 的同名 formatRelativeTime 是本地 iso-string helper，不能当作 Core Date/options API 的普通消费者。internal export 73–81 暴露 Intl helper，不等于 format options 有真实生产调用。名称搜索本身也不能证明整个仓库没有动态消费者；这里没有建立比旧 R14 更强的新普通 producer/consumer 合同，因此不新增 candidate。

作者 5 个 source rows 的当前 bytes/SHA/EOF/selected ranges/加总全部匹配。4 个产品 source 的原始 before-read pin 可与 initial/consumer pins 对应；旧报告 active pin 明确 initialSemanticReadSha256=null，dedicated pin 只早于直接全文、晚于历史 excerpt。history-source-pin.first.json 的旧 true 记录被保留作更正证据，不能使用它声称早于首次语义读。reviewer 自己的 before-range-reread pin 不替作者补齐该时序。

作者 receipt 列 11 个 self-excluded artifacts，字节/SHA 全匹配；加当前 receipt 捕获共 12 个冻结材料，proposal 5 个本地链接存在。validation runs 为空，测试/通过/expect/import/函数/fixture/native/network/model 计数全为 0。没有执行 author history-method.py。

历史只作独立 stdlib 元数据重查：同原 prep 排除当时 mutable29/future30，2765 文件（1275 MD + 1490 JSON）、562917 string values、833428 scalar values、169 exact archive/_archive 路径、0 parse errors；全部 inventory bytes/SHA 与当前文件匹配。Intl/display-option/old-failed 正则计数111/15/133，cap100 保留100/15/100，均与作者相同。完整 15 个 display-option contexts 已看，包含旧 R14 及其转引；这些是原时点的 navigation，不是全历史语义耗尽或新的 formal history snapshot。

旧 i18n/getLanguage、Slice/import、CLI/stdin 失败方向继续 SKIP。R14 旧测试通过和失败日志仅为历史文本，不能为本轮提供动态验证。reviewer 产品/测试/fixture/import/函数/stdin/TTY/native/Git/network/auth/identity 实验均为 0；只运行文件/hash/JSON values/regex/范围/链接元数据检查，只写 exact reviewer /tmp 目录，未修改作者或产品文件。
