# 后台完成重置前台计时：针对性独立静态复核

**支持单个P3静态缺陷意见，最终formal分类/ID由Root决定。** 当同一前台query仍active且最后一个旧后台任务完成，TUI提交该bool变化并执行effect时，App会把该query的runStartRef重写为完成后台任务的时刻；StatusLine后续tick和turn_duration均读取这个共享ref。两处影响是同一根因，不拆成两项。这是源码推导，**没有观察到真实UI帧、计时跳变或运行结果**。

本次不是盲审：Root提供了待反证假设，我自行追源；未读64作者或Root66可变目录/报告/manifest/excerpts。只写本exact tmp，无产品修改。15个[初始源/指令pins](initial-pins.json)及后续consumer/producer/input pins在对应正文/行导航前取得；Root提供2735100f81f4d12cbb3e610da0e3977eaf74727c仅上下文，本reviewer Git0。

**实际普通入口成立，bg并不禁用新的前台提交。** App1814–1849只在isQueryActive为true时将普通输入排队；A=false、B=true时仍调用submitToEngine1847。App2266–2269把handleSubmit/isRunning/dockFocusIdx传给实际TuiControlSurface。后者364–370仅用isRunning改变placeholder，disabled只看dockFocusIdx；CommandInput232–238以!disabled取得focus，169–174转发普通提交。所以主视图、无输入阻挡overlay、dock未占焦点、旧前台已结束的正常状态可在旧bg仍运行时启动新query。这里没有展开或操作QueryGuard内部机制。

后台生命周期来源亦是正常producer：Agent471–475明确其survive spawning turn，487–502注册running，537的void runSubAgent以独立Promise运行，582及594–597在成功回调走completeTerminal/markCompleted。App的import46经internal export247到agent-registry singleton445。accepted terminal路径写status360–362并notify370；普通markFinished380–389同理；notify148–157重建snapshot通知订阅，hasRunning131–133只把running/cancelling记为true。lease/generation/权限机制仅导航、未认证；本意见只取正常获接受的终态转换。

在“旧bg能够跨上一前台返回且仍运行”这一生命周期前提成立时，有无需手工DTO的普通序列：旧query发起bg后已结束；用户在旧bg运行时提交新query；新query的client.run仍在await（App1643–1652）；旧bg随后正常完成，且全局没有其它running/cancelling agent。若UI在新query仍active时commit这一状态并flush effect，A=true保持不变、B由true变false、R=A||B仍true。

App213–218定义这些值；436–446的effect依赖[R,A,B]且只要R为true便无条件写runStartRef.current=Date.now()。B变化因此重写起点，即使不是新query。该ref唯一赋值定位为438；393只是初始化。StatusLine125–128按该ref算elapsed，167–170显示，69–101的自身tick提供后续读取；App1669–1680以同ref生成turn_duration。若新query起点为T0、旧bg完成并触发effect为T1、结果结算为T2，raw elapsed从应有T2−T0缩短为T2−T1。这些是符号源码推演，没有执行clock/表达式fixture。

没有找到支持“每个bg状态变化都应该开启新计时阶段”的合同。相反StatusLine127–128原注释明确把mid-turn reset视为会造成frozen-looking timer的疑点；turn_duration还和该query的整段usage并列。合理修正方向是按实际新query/所需idle→running边界初始化计时，将纯debug状态观察与起点写入分开；不能简单删掉isQueryActive依赖而损坏bg运行时新query的合理重置。本review不改产品。

**反证和条件均保留：**

- 新query开始重置是合理行为，尤其旧bg使R早已true时；它不属于本问题。焦点/overlay或普通query gate不满足时也不是上述入口。
- Agent711–714的runYield/background_notification可让最初spawn前台先结束，故不能声称每次launch/finish必跨同一前台；本意见使用“已有bg时启动后续新query”的实际入口避开该反例。67未语义读Engine是否在bg等待前返回；turn-loop1768–1806、run-tooling173–182只是已pin的精确导航locator。因此该生命周期前提在本独立包中尚未完成实现级闭环，不能只用comment替代Engine控制流；Root可结合66另核后决定formal。未继续审这些机制，相关搜索只导航。
- 其它agent仍running/cancelling时B不变，任意registry notify不等于effect依赖变化。若前台已结束、R已false、UI没有提交中间状态、或query响应先于effect，不能从静态源宣称此帧发生了重置。
- handleTransportResponse1626–1629可在await返回前结束本地query状态，finally1716–1720还有结束调用；这限制触发窗口，不支持把所有结果回调都当作active。可见影响仍要求T1处UI实际commit时A=true。
- StatusLine现有23行测试只声明cost格式行为，本次未执行；不借其测试结果证明elapsed，也不宣称穷尽全repo测试。React调度、renderer和真实tick/网络时序均未运行或认证。

[Fresh历史gate](history.json)纳冻47、排exact48和61–67：4336=1429MD+2907JSON、1834940strings/2753459scalars、169exact archive/_archive、0parse。App path507/cap100保留100，AppSHA101/cap100保留100；StatusLine path16/SHA7及cause33均全保留，不能把截断caps当作全读。108个精确path/SHA object和原scope标签用于参考，旧full也不能证明当前假设无bug。本次不是以unknown/no-row宣称未读的新frontier。

[33个有界cause窗口](history-cause-selected.json)涉及旧Desktop elapsed刷新、AgentDock自身时长、goal时钟、TUI历史实现计划等，producer不同或只是计划，没有识别到已记录的精确同因；不声称历史语义穷尽。较宽首次输出9eb471被工具截断已在[metadata notes](metadata-notes.json)保留，之后独立输出33个窄窗口。没有产品失败或重试。

[source manifest](source-manifest.json)：8语义文件，7selected+1full既有测试；314行=291产品+23测试，5个额外文件只rg导航，所有显示逐file union1109行。App等大文件只列实际范围，QueryGuard/lease/权限/identity/native机制均排除；registry445为后补精确读，capture时间单列。片段[快照](source-excerpts.json)在实际显示之后捕获，不冒称读前文本快照。[ending](ending-checks.json)的15pins全同，4336历史集合和成员字节无漂移。产品/React/Date.now/timer/registry/helper/fixture/测试/provider/native/网络/Git执行全0。见[assessment](assessment.json)、[validation](validation.json)及冻结[receipt](reviewer-receipt.json)。
