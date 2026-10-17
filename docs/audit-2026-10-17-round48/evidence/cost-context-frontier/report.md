# Prep61 cost-ledger/context 普通数据静态审查

有限范围结论：0 formal、0 candidate、0 related。未建立具有正常 producer、真实 consumer 和独立新根因的 usage/cost 上下文反例。结论只覆盖下述普通 DTO/字段传递，不等于账单、定价、账本持久化、资源传播或所有 Core 会计路径正确。

本材料为 prep61。Root 提供父上下文 `c3a9ece2e6f183671b00e07322a9722fad6bda54`；本代理没有运行 Git 验证或建立正式新 baseline，只写当前 exact 临时目录。产品/helper/语言样例/测试/provider/model/账单/真实 store/文件锁/native/网络/Git 运行均为0，没有运行 pass 或真实账单观察。[validation](validation.json)

目标先于正文 pin：`packages/core/src/cost-ledger/context.ts`，167行、5823字节、SHA256 `91ab442184ca82d512c2722c64205c27470db2a6c29bde1fe2883f24d96c99ee`，时间2026-10-17T15:42:52.945423+00:00。正文开始于 fresh 历史 gate 之后。types/store/client-base/Engine/既有 test 文件分别在首次静态显示或导航前 pin；CODESHELL/AGENTS 仅核此前已读指引的当前哈希，不回填原首次语义时点。[initial pins](initial-pins.json)、[consumer pins](consumer-initial-pins.json)

Fresh 历史 gate 遍历所有 docs/bugs MD 文本与递归 JSON scalar values，含归档，不以 JSON key 匹配冒充 value 命中。纳冻结46，排 future47及57–62：4255文件 = 1423 MD + 2832 JSON，204562997字节；1765237 JSON string values、2662013 scalar values，解析错误0。175是路径含 `archiv` 的统计，并非归档过滤条件。遍历及关键词命中不代表语义阅读全部历史。[history method/inventory](history.json)

Exact path / path-family / SHA / broad cost-ledger 组命中57 / 64 / 11 / 741。前3组均低于160上限；大组只保留160，明确不能冒称全部读完。结构化同对象 path+SHA lookup 不受该 cap 影响，7行逐项检查了整个对象，包括实际存在的 coverage/scope/review/inspectionScope：旧 R9 明确 selected、未列范围，其他是库存/hash/incidental/unknown，没有明确同 SHA 全文证据。loaded-module/preflight import 引用不是正文阅读或 pass。排名和 no-row 也不是未读证明。[whole row gate](history-gate-selected.json)

补充旧因检索沿用同一 dated4255文件集而非借旧扫描：COST-R9-01命中10，context-family64，budget/429特定词0，均低于每组100上限。实际选读保留的3个旧 tracker 窗口；旧 R9 限定独立、未绑定 CostTracker 丢失完整模型标识并估价错误，未把该已录根因重新计数。旧运行数量、bound-ledger 对照及 native/失败日志都仅是历史文本，不是本轮执行或覆盖证据。特定词0不证明相关领域无旧问题。[focused cause scan](history-cost-causes.json)、[selected old windows](history-cause-selected.json)

普通实际链条：`LLMClientBase` 构造时把 config.provider/model 赋给只读字段；usageIdentity 返回 provider/model/providerKind，recordUsage/recordAttemptUsage 交给 recordOwnedUsage。实际 createMessage wrapper 经 withUsageAccounting → withUsageAttempt；context 将正常 identity/usage 转交 ledger.begin/settle/finish。所选账本 receipt 构造原样写 provider/model/providerKind、purpose，begin写 startedAt，settle/finish写 settledAt，时间来自 this.now。本链没有所读独立 CostTracker 的 canonical 标识截断步骤。[source manifest](source-manifest.json)、[captured excerpts](source-excerpts.json)

这些证据支持有限 negative，而非全账本正确性判断：所选 DTO保留了模型/provider普通字符串，usage与receipt状态有明确转交分支，没有正常输入支持的新丢失/错归因反例。context里的异常包裹及未知usage是可见源码分支，但没有据此声明实际 provider重试、计费可靠性或所有错误路径已验证。未用任意畸形 DTO、跨并发假设、真实请求或账本文件造问题。

范围为4个产品 selected rows、234行语义；0测试语义选段，Engine与ledger.test仅rg导航（含个别匹配到的实现行，不是连续测试正文阅读）；2指引hash-only。535行是正文与额外rg行的去重显示并集，不能当额外语义。context167行和types92行全部显示过，但资源/authority邻接部分、无关query DTO并未计入语义，所有row均不升级为全文语义覆盖。manifest同时保留 body ranges、额外导航行与 canonical displayed union，重复显示不相加。

AsyncLocalStorage传播、crypto请求标识构造、billing/preflight资格机制、session/身份归属、权限、persist/锁/真实store、定价公式、预算和429错误均在边界停止，没有权限、安全或真实资源结论。只有普通provider/model标识作为数据字段被读取；没有真实账号、密钥或配置数据。既有test的重试/localhost/paid-provider名称只是导航，没有import或恢复任何旧失败动态方向。[decisions](decisions.json)

Ending8个源码/指引pin的SHA全部相同。原4255 included paths及字节无added/removed/changed，ending excluded3来自相同排除规则，不倒填初始excluded0或把新文档冒称已读。当前metadata错误、控制台截断均为0；唯一cap限制已明确保留。[ending checks](ending-checks.json)、[diagnostics](metadata-diagnostics.json)

最终 author receipt 按现有文件绑定字节和SHA，自身不递归包含自身。本包链接均为目录内相对链接，不要求外部别名。
