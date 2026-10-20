# Prep92：Goal 延长入口的独立定向静态复核

**支持一项 P3 静态缺陷意见：带工具的 live goal turn 经 process group 渲染时丢失延长回调，接近上限 marker 不显示延长按钮。** 对应 Parent 提议 `DESKTOP-R50-01`，不另造第二正式 ID；最终晋升由 Root 完成。这是源码条件推导，没有运行或观察实际 UI 帧。原“失败后提前显示成功”假设未单独晋升，也不另列 candidate/related；见 [意见与边界](finding-opinion.json)。

这是定向复核，非盲审：Parent 先给 clicked latch 假设，后给 group callback 假设。自己的所有 source pins/正文阅读独立完成，没有打开 Root91 mutable 或冻结报告、manifest、excerpts。Root 提供产品 baseline `7dcd41b9a1bfd23ecc6e6563fd8fbf569cf9483b`仅作外部上下文；自己的 Git 为0。[initial pins](initial-pins.json)及 [producer pins](producer-initial-pins.json)、[render pins](render-initial-pins.json)、[ChatView pin](chat-consumer-initial-pin.json)、[goal producer pins](goal-event-initial-pins.json)、[agent fold pin](agent-fold-initial-pin.json)均先于各文件正文/行导航。指令同 SHA 沿用此前阅读，不新增指令语义计数。

普通成立条件和精确源链如下：

1. 实际 goal emitter 在 `turn-loop.ts454–478` 用普通 goal/limit proximity 字段发出 `goal_progress(status=approaching_limit)`，注释明确为了运行中提供再续按钮；1054–1056与1547–1562是正常 loop 和 not_met 后的实际调用。这里没有执行 judge、模型、budget helper 或任何真实 goal。
2. `renderer/types.ts1778–1818` 将 marker 加入 messages，只在 met/exhausted/新 approaching 时替换旧 approaching；not_met保留它。后续普通顶层 stream_request_start 在1258–1278追加 done:false assistant并置 streamingAssistantId；534–610 的 user.turnTiming 保持未终结，直到实际 terminal。相应 App907–911的 liveTurnActive 在 busy且stream pointer非空时为true，经App2580→ChatView1801→MessageStream432传入builder。无需假设某个中间 assistant.done就等于整条 goal run完成。
3. `streamGroups.ts219–226`进入fold；413–517对最近未完成且已有至少一个非bookkeeping工具的turn，live时使用 **innerEnd=end**，把保留的goal marker纳入 turn_process_group.items。519–546优先采用authoritative user.turnTiming，旧snapshot的assistant.done兼容分支不能反驳这个普通新turn条件。`agentGroup.ts85–132`递归保留group结构，非agent marker原样保留，没有hoist回外层的回调分支。
4. `MessageStream451–461`创建 TurnProcessGroupCard 时未传 onExtendGoal；其 Props19–28没有该字段，190–191只渲染 `<GoalProgressView message={m}>`。对照同文件596–597的平铺分支确实传 `onExtend={onExtendGoal}`，实际回调又由App2657经ChatView1803传来。
5. GoalProgressView77–93以onExtend存在为整个延长按钮/extended区域的必要条件。group内部此prop为undefined，因此即使展开并渲染marker也没有该延长入口。该结果来自真实分支/prop传播，不是手造拒绝Promise或畸形DTO。

影响限定为：同一普通未完成goal已用过工具、保留approaching marker，且UI在后续模型流式阶段提交该live-group状态时，预期的该处延长按钮缺失；无法从这个marker发出延长请求。**不是每帧、不是所有goal、不是所有延长入口都失效**。App live flag有真实busy/stream-pointer条件，warning刚发或请求间隙可暂时平铺；没有工具时streamGroups的inline分支照常到外层带callback的leaf；closed turn最后工具之后的尾部也可能平铺。其他控制面/SDK、端到端transport与真实模型时序没有认证。建议把已有callback贯穿MessageStream→TurnProcessGroupCard→GoalProgressView，保留相同opts；未修改产品。

原 clicked-latch 假设的已读源是：leaf85–87先setClicked后onExtend；useRunController1114–1126只void RPC并catch log；preload609–626/types1120–1140声明Promise limits与无active run时reject。Core server2231–2295在已读正常分支只成功返回 `{ok:true,limits}`，无active result产生InvalidParams；**没有证明这里正常resolve `{ok:false}`**。普通错误入口本身存在，但本次不继续把错误生命周期、重挂载/marker清理和实际可点击时机补成第二问题；这些反馈行为也不由本报告全面反证。新group-callback缺陷不依赖上述失败假设。

[初始fresh history](history.json)/[method](history-method.py)遍历docs/bugs MD与递归JSON scalar values，纳冻结49、排正式数字50+，含169个精确archive/_archive成员：**4693 = 1457 MD + 3236 JSON**，2129441 strings/3168045 scalars，0 parse。目标path/SHA/filename12/5/12命中，7个 [原对象](coverage-gate-objects.json)实际核读后只有库存/派生incidental，未建立同SHA明确full；两处overnight路径只是历史TODO标签。[gate](gate-decision.json)不把unknown/no-row当未读。即使邻接模块此前full，也不证明本具体假设无bug；本次行数不是全仓新增唯一覆盖量。

初始宽old-cause111次仅保留首100（cap100），不声称读完全部窗口。另立 [focused history](history-focused.json)精确GoalExtend22/UI false-success33，均低于cap100；实际读55个定位和有界240字符文本。再立 [group cause history](history-group.json)得到groupGoalExtend4、goalButton3，7个保留窗口全部读完；原 [contexts](history-group-contexts.json)保存。未在这些精确匹配建立同样的live group丢callback旧因。旧R13/groups的coverage描述、派生转摘及移动功能计划不是此缺陷确认；现行types的B2注释是not_met过早删marker，与保留marker后丢callback不同。旧GCTRL-F14是Goal identity/revision和update/delete乐观投影对账，未当作此UI callback同因；只读旧摘要，不展开身份机制。[history decisions](history-decisions.json)逐项限定，旧失败方向全部保持SKIP，未借旧pass。

[源码清单](source-manifest.json)：**13 semantic files = 1 full(leaf130) + 12 selected，752产品语义行**，另2个navigation-only protocol文件、1个hash-only Core types，累计唯一显示1199行；0测试正文/声明。所有selected/nav/hash/display范围单列，真实source excerpt为 [阅读后捕获](source-excerpts.json)，不是预读快照。没有因hash或全文显示自动扩大语义scope，session lookup/stale Goal helper/权限/身份/native/transport、usage记账、sensitive-tool及真实配置/会话/账本内容止于边界。

有两个自有metadata诊断，均保留：首宽显示 [truncation](first-diagnostic.json)是tool2f7ff0 exit0，原18240 tokens/max8000，不冒称读全37选中窗口；原37窗口输入另在 [first selected windows](old-cause-focused-windows.json)。随后显示器 [SyntaxError](metadata-reader-syntax-error.json) d20eb3 exit1在读JSON/产品正文前发生，只修自有`else`空格，原库存未改，不是产品重跑。后续小块显示并非掩盖首次结果。

[validation](validation.json)记录0产品/helper/import/fixture/test/React/DOM/timer/network/native/model/Git执行；仅标准库metadata/hash/range脚本运行。结束 [checks](ending-checks.json)确认18个源码/指令pins全同SHA，原4693历史集合/bytes均0漂移，排除的mutable50不倒填为已审历史。只写exact tmp，不动产品、旧冻件或Root材料。[reviewer receipt](reviewer-receipt.json)冻结所有本包文件。
