本方向为 **negative：0 formal / 0 candidate / 0 related**。完整阅读 geometry.ts97行，并核普通 damage 矩形合并、clip边界与行坐标 clamp 的实际消费者；未找到普通 producer 合同支持的新反例。没有执行几何函数、坐标样例或渲染器。

公开 edges 重载为1、2、4参数；addEdges为各边相加，resolveEdges按缺省值补零。unionRect使用最小起点 /最大终点包围两个有限矩形，screen/output 的选读 damage区域与其含义相符。clampRect与withinBounds在普通有限、非负尺寸合同下未见新问题。output的纯clip交集对下界取max、上界取min，undefined轴沿用另一边界；文件明示空交集丢弃写入，本次没有重审完整render循环。selection仅查看普通行clamp调用，不扩大到旧scroll方向。没有用NaN、Infinity、错误三参数或畸形layout造输入，也不声称所有helper全局无消费者。

[源范围与读前SHA](source-manifest.json)为9pins、5语义文件471行（429产品 /42测试声明），1full /4selected /4hash-only；geometry本体在完整历史gate后读取，所有选段在专门pin后读取。[末尾检查](finish-checks.json)保存实际字节状态。render-screen.test.ts虽打印95行，仅1–29、83–95的box /wrap声明计入42行；ANSI、OSC8、NoSelect的31–81未计范围且未执行。node-cache、render-node-to-output、frame、log-update仅路径 /hash；native-ts yoga-layout index仅路径命中未读。不借这些文件声称完整renderer或native审查。

新做的[全历史扫描](history.json)含3318文件（1342MD /1976JSON，807880字符串 /1193828 scalar values），含冻结36，exact排mutable37/future38；MD整文与递归JSON values含archive，keys不作文本检索。source path22 /filename22 /SHA2 /rect-clip139，均低于160cap。实际看了22 source上下文、2个same path+SHA对象、139主题locators及一个旧clip上下文，[选读记录](selected-history-contexts.json)分别保存。2个同SHA对象仅为R28库存与coverage-ranking；no-matching-row不证明从未读，也未建立同SHA全文语义覆盖。May30 raw archive findings[177]的edges三参d!问题已旧且未建立普通调用，排除不增related；不把raw archive置信度升级为确认bug。另一个intersectRects上下文是CDP视口点击，未扩到CDP。机械关键词与有限选读不构成历史语义穷尽。

[分类与边界](decisions.json)、[验证账目](validation.json)均记录0产品验证：没有tests、language/coordinate fixture、TTY、renderer/native/browser、模型、网络、Git或权限实验。旧TUI /ANSI /scroll失败方向未重开。[metadata说明](metadata-notes.json)保留一次agent thread limit导致的委派失败，随后由主reviewer独立完成本次新历史扫描；不存在产品失败或重试。它也明确承认上一轮展示转义误读，不改上一轮冻结原件。本prep仅写exact temp目录，parent沿用Root所报冻36缩写ee5c，未来正式baseline未设。[作者收据](author-receipt.json)自排除封存本次产物。
