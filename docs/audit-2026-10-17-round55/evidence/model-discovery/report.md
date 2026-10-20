本包对 Codex 模型发现及实际模型列表投影作有限静态审查，结果为 **0 新正式项、0 候选、0 新关联项**。没有在正常本仓 producer/consumer 合同中建立新反例；不认证外部 CLI、模型可用性、账户状态或真实上下文窗口。

Root 提供的固定产品版本为00c046367769349c1f5413e74c993b2c19ce8337；本作者未调用 Git。只读 owned worktree、只写此 exact 临时目录。[正文前初始 pin](initial-pins.json) 固定 model-discovery.ts 为99行、3492B、SHA08691432cb3fec0592aeb4a9e87f872df64459909948898c47a0ec70c44fa3bc。CODESHELL/AGENTS 与此前实际读过版本同SHA，本题只hash核对，不新增222行指令阅读数。

旧覆盖门槛采用两层。自身 [精确定位](history-locator.json) 后，只对52件匹配的已冻MD/JSON作 [递归值扫描](history-gate.json)，纳54排55+，不是全仓新扫描；44 JSON、8 MD，330266字符串、512089 scalar，0解析错误。path/SHA/filename/oldcause 命中11/5/30/105，每query最多保存50。六个compact path对象是inventory/coverage转摘；[两份 canonical 原对象](canonical-gate-read.json) 也仅建立当前SHA与inventory/index门槛，不能从unknown或空full列表推断历史从未审过。

原始 coding-tui-chat.md 及 source-report 的207–212行明确将 model-discovery 列为 source-directed 审查，正文声明不代表每个测试执行。[原报告选段](prior-report-selected.json) 保留这12行及原件SHA；这与旧sameSHA全文门槛是两回事，本次保留旧审读重叠，不称首次或全量新覆盖，不为排除而换叶。

Root 随后提供已冻结批量结果：5433件MD/JSON、3997418个递归value scalar机器访问、纳已冻54排formal55+、0解析错误。这里只 [投影本目标16个path/SHA命中](shared-history-projection.json)，不读取其他目标报告或复跑共享方法。16个compact精确定位均显示，实际原对象只另核上述2份；完整原库存的检查由Root负责。原共享输入的 [pin](shared-history-input-pin.json) 和结束hash保留时点，不能把Root机器访问说成本文作者穷读历史。

已建立的正常链与反证为：

- model-discovery.ts:56–95 对 model/list.data 作DTO投影，hidden=true排除，同model保留服务端首条，保留isDefault布尔；有效空catalog返回[]，与函数21–24的注释一致。分页参数includeHidden:false，正常nextCursor推进和重复游标拒绝可在本仓代码核对，未运行AppServerClient或SDK。
- external-runtime-model-service.ts:71–79 默认项优先、model经共享constructor形成codex/model key、displayName用于label；54–58的首轮fallback与80–85的失败保留列表区别于成功空数组。没有把有效空结果强改成回退的合同，亦未用任意坏DTO制造问题。
- shared/external-runtime-models.ts:1–23明确同一模型dropdown合同，90–93构造统一key，100–160是内置fallback和可用runtime DTO投影。42行的1M context数是明确标注的缺省元数据；本次没有建立逐模型真实窗口合同，因此不把该常量推断为所有外部模型实际窗口，也不据此强判新bug。
- main/index.ts:6099–6102实际创建服务并注册externalRuntime:models；preload/index.ts:1605–1606调用同channel；useExternalRuntimeModels.ts:31–35读回并设置列表；App.tsx:353–356/368–371实际将其并入modelOptions。旧“只存在未到达helper”的担忧不适用这条已读链；账户、enabled布尔来源和会话发送机制停在边界。
- 既有model-discovery.test.ts:66–91声明了正常分页、隐藏过滤、去重与default flag，106–110声明成功空catalog。只是31行测试声明；fake server、SDK、进程、错误/timeout cleanup、React/DOM和timer均未运行。

[范围清单](source-manifest.json) 为7个产品selected、291行产品语义，1个测试selected、31行声明，共322行；0产品full。另1个barrel仅导航38–39的真实export，0导入执行。source body显示606行，正文外导航9行，含导航显示615行。目标99行和共享160行虽整段显示，SDK/环境/clock/cleanup、旧key迁移等邻接范围仍有明确排除，不能自动升级full。[选段文本](source-excerpts.json) 在实际显示后保存，不作为预读全文快照或第二次语义阅读；这些数字也不是历史唯一新增覆盖。

旧因查询中实际只读 [4个bounded窗口](history-selected-contexts.json)，25个compact旧因locator不是25个完整窗口，更不等于105命中全审。原archive context硬编码、settings默认模型保存等窗口未被重报为本题新项；当前没有候选，所以也不宣称已穷尽整个Codex模型问题家族。既有SDK/native失败方向未重启，静态阅读不构成恢复运行授权。

[首次诊断](first-diagnostics.json) 记录一次主动4500字符raw数组展示上限；原共享输入和全部16命中投影未丢，后续只补compact定位。listExternalRuntimeModels的filename查询exit1是无命中，真实名字后来按实例定位，不能当产品失败。无fatal metadata exception或工具输出截断，未编造首个合并命令中未单独捕获的rg退出码。

[结束复核](ending-checks.json) 的11个源/指令pin全部同初始，52件自身匹配历史字节均同；共享冻结输入自身hash也相同。这不是对共享5433件历史集合的独立ending认证。[分类原件](classification.json) 与 [验证口径](validation.json) 明确产品/helper/import/fixture/tests、模型/账户/连接/SDK、真实配置/缓存、React/DOM/timer、native产品进程、网络、Git均0。没有修产品。只在本次普通投影范围内收口有限阴性。

[元数据整理脚本](finalize-metadata.py) 仅处理自身审计JSON、hash和选段；[冻结收据](reviewer-receipt.json) self-excluded，覆盖此目录其余终态文件。
