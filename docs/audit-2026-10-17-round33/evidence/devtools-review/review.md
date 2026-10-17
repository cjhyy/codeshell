# Round33 host-neutral devtools 独立静态复核

结论 **0 new formal / 0 candidate / 0 new-related**。没有在普通collector记录、cap或DTO/host参数链建立新反例；旧问题按既有原因排除。这里不是全包无bug结论，更不是新的未读frontier：R10已明确读完整src/README/tests，本次相关文件的当前SHA与R10完全相同。

本prep开始时Root报告Round32仍mutable、上下文4be；正式Round33 baseline尚未绑定。[初始pins](initial-pins.json)与[consumer pins](consumer-initial-pins.json)固定独立读时字节，Root后续负责Git。历史排除当时32与future33，不把它称为未来正式历史完成。

## 普通合同与实际调用链

完整读inspector227、contracts36、index7、既有test137，以及Core browser-inspect50、Desktop wrapper10和包README56；选读Core bridge、Puppeteer/Playwright driver、background runtime与automation host。公开模式enum、max_entries1–100→maxEntries的字段映射、默认50和collector clamp一致。实际host创建的是注入Page的同一工厂，driver/host inspect传递options；这些只证明所读普通参数数据流，不表示验证了目标选择、授权或原生生命周期。

Console/network首次请求才订阅；后续读slice(-limit)的recent entries，缓存最多100条，单条console text另有长度限制。stop解除两类监听并清两个buffer；源码有main-document navigation停止及close/dispose路径，缺mainFrame端口时每次frame navigation都停的行为也在README明示。没有把optional mainFrame、同时开启两种recording或stop后重新开启猜成缺陷。

DOM/performance分支只作source阅读，没有运行callback、DOM、page.evaluate或语言fixture。Performance只是bounded timing summary，没有承诺最新N条或全局时序排序，因此不能把slice(0,limit)当新bug。URL/请求/console字段按普通Page端口形状读取；未用任意FakePage抛错、畸形URL、外部对象修改或大量资源输入凑候选。

## 旧原因与版本对照

直接全文读R10旧报告 `docs/audit-2026-10-17-round10/diagnostics.md`，范围保存在source manifest。旧DIAG-R10-01/P3是Array.from(children/shadow children)完整枚举后才检查queue预算，direct-text同形态也已合并说明；旧CDP-R3-03是hidden祖先过早剪枝visible后代，R10明确排除过。两项不新增、不升级，也不重新运行旧VM/大collection/浏览器方向。

[精确SHA对照](prior-source-comparison.json)确认包四个src、README以及相关旧wrapper/driver在当前仍同版本。R10旧manifest没有精确driver全文范围，不能把相同hash扩大成“旧driver全文已审”；包全文历史依据来自R10报告与coverageLimit。旧5pass/24expect与10pass/44expect均为旧时点，本轮不借为验证。

[历史检索](history.json)覆盖2988=1304MD+1684JSON、645399strings/957193scalars，0parseerror，含archive/_archive，排除mutable32/future33。exact105、record/cap11、old-failed10为regex总occurrences，保留60/11/10（cap60）；实际读exact前20、record11、old-failed10及R10父report。名为old-failed的命中还包括0fail日志和无关inspector上下文，不代表10次真实失败。没有宣称历史语义穷尽或“以前没人读过”。

## 范围、pin时序与执行

[source manifest](source-manifest.json)列13个实际语义source/contract rows：734行TS产品/测试、56行README、38行旧报告，另3项hash-only。大型driver/host只计selected范围；5个现有unit test仅作声明阅读。7个consumer的rg locator摘录及旧report scanner excerpt早于专门pin，8项initialSemanticReadSha256保持null，专门pin只证明直接范围读前字节；初始/结束hash均未变，没有补造时点。

**0产品/import/函数/page.evaluate/DOM或语言fixture/测试/browser/HTTP或网络/native/模型/Git执行，0pass/expect**，没有auth/permission/custody/identity实验。没有修改产品、旧Round32或Rootprep，metadata操作没有失败；旧失败方向保持SKIP。终态[receipt](reviewer-receipt.json)只证明审计文件字节。
