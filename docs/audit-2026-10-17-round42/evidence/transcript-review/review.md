# Background transcript revocation — independent static review

独立支持同一项 **P3静态问题**：作者 alias `TRANSCRIPT-R44-C1` 与 Root 拟正式 `TRANSCRIPT-R42-01` 是一项，提升不双计。作者原0formal/1candidate/0related口径保留；本 reviewer 不创建额外ID。[classification](classification.json)区分意见和分类归属。结论不是实际模型/UI复现。

普通条件为后台子代理已输出非空partial，随后可恢复的streaming异常走内置非流式fallback，用户查看仍活跃的子代理详情。`TurnLoop` 2107–2115明确tombstone用于撤销partial；2197–2228随后重发start和replacement text delta，使用同一messageId。1119–1142为正常调用点。已选读child wrapper、默认childRunner与Engine onStream到TurnLoop的静态路由，tombstone未被wrapper过滤；没有将任意手喂StreamEvent当作普通producer。

translator全文195行显示：stream_request_start未保存messageId；text_delta创建bg-counter行；164–174把tombstone与turn_complete共用finalize，只将旧row的streaming改false并清本地ID，从不按撤销标识删除该行。replacement delta因本地ID已清而另建assistant行，旧partial仍在transcript。assistant_message没有独立case，落入default。只讨论本撤销内容未移除的问题，不另扩工具运行标记。

后台agent detailSink先调用translator，再转发事件；registry append/touch保留实际row并通知订阅。实际TUI ui/App2145–2169在agent view直接取这份transcript传入VirtualMessageList，app-helpers238–246按assistant_text渲染text。App754–755主feed的tombstone处理对agent-scoped事件明确skip，不能替translator删除旧row。所读registry终态尾段没有transcript替换；但影响结论主要限定于fallback等待或仍运行时的详情，不声称完成/fade后每次都可见，不声称持久session transcript损坏。

最初模糊App名被猜为Desktop：两文件仅pin和无命中导航，命令末项rg exit1已记[诊断](metadata-diagnostics.json)。实际TUI文件另在读前pin后读取。CLI package/main/repl/ui-index只做导航，未把这些locator计语义；作者与Root另做真实入口核对，未借为本 reviewer新增source行。没有import、启动CLI或恢复旧loaded-module/native失败方向。

[源清单](source-manifest.json)列10个语义product pins：1full/9selected，共479行，测试源码0；另7个hash-only/navigation产品路径、2个既有指令hash核对。799个显示行由body＋navigation单行求canonical union，逐row显示ranges和count自洽；并非799行都作普通语义，更不代表native/model/authority/scroll机制审验。全部17产品及2指令结束hash匹配。每个实际body选段均在对应专用pin后；无首次/全局新覆盖声明，跨作者重叠不相加。

独立fresh全history gate纳冻结40，排任务时mutable41/future42/43/44，含archives：3696文件＝1379MD＋2317JSON，1130742string values、1704078scalar values，parse error0。初始四组命中72/90/1/116，全低于cap160；47个去重context窗口全部读完。唯一当前SHA对象是R28 inventory195行/6622B hash行，不是full语义或从未读过的证明。旧loaded-module路径/失败日志不借作body/pass。见[原扫描](history.json)。

精准同因gate在同3696文件对MD按段、JSON递归字符串值匹配，命中12/6/31均低于cap100；实际读了30个窗口＝全部12helper＋6translator-revoke＋12个TUI窗口，剩余19个TUI窗口未冒称读完，也不把截取窗口当整段/整份文件。原库存字节无变化。见[focused结果](history-focused.json)、[实际选读](history-focused-selected.json)及[历史判定](history-decisions.json)。

旧July09 F-01与deep-dive另直接读了1–35和15–45共66行，仅作历史反证，不混入479当前产品行。旧F01明确普通Desktop、不展开TUI，根因是turn_N/freshId不对应且assistant_message只封口；当前Core已stableID并补发replacement deltas，此处是独立TUI background translator仍不消费revocation。R20 StreamAttempt关注普通main-feed请求撤销，不覆盖此consumer。Oct12 internal retry failed-prefix旧项则是上游重试成功而不发外层tombstone；当前条件已真实发tombstone，原因不同。保留同族关系，不重复旧Desktop/F01或上游缺撤销标题。

[结束检查](history-finish-check.json)显示3696路径集和字节均一致。后续正式41集成不倒填本prep；formalBaseline为null、无Git绑定。175为含archiv的路径substring计数，不混exact archive目录口径，也没有历史语义穷尽声明。

独立意见形成后才读取作者声明冻结的终态。[作者metadata核对](author-metadata-checks.json)确认26条receipt与含receipt的27文件集合、20个source/navigation/hash字节核对均匹配。作者757语义（749当前＋8旧报告）/1791display是作者范围，不记作本 reviewer阅读。所有本文Markdown链接仅在本目录内，正式化无需父目录相对链接别名。

[validation](validation.json)记录产品/helper/import/事件/语言fixture/测试/Buffer/timer/Promise/真实模型/流/native/React/TUI/UI/网络/身份权限及Git均为0；旧失败方向未恢复，历史pass未借用。写入仅本exact tmp。[receipt](artifact-receipt.json)自排除。
