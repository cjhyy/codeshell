# Round32 context/model selection 静态审查

本方向 **0新增formal / 0candidate / 0new-related**。正式baseline由Root提供为4be4016b8661c6a10c60f4eb0f218552b4b7c5d0，复用 [原prep同次阅读](evidence/selection-prep/report.md)，正式化0新增产品语义读取/0产品运行，未改产品。原parent4dad、时间、2921历史、初始猜想撤销及pin时序按 [10份copy receipt](evidence/selection-prep-copy-receipt.json) 逐字保留，没有覆盖成未来正式baseline。

contextSelection全文218、modelSelection全文21与各自既有test全文223/53，结合App和MessageStream selected，建立了普通DTO/选择调用合同：raw事件turn、durable event/client anchors、歧义/倒序/不连续alignment拒绝、closed范围端点检查；App2040–2090调用source override→default优先级复制并清target goal。permission字段仅静态值复制边界，不声称验证权限/authority路由。

MessageStream284–309读取raw后buildTurns，363–405把selectedTurnRange结果提交forkSession(summary)，444–448先要求display alignment。App2200–2245给出可选条件，2565–2595传递request/callback。没有实际打开选择器、读真实会话、调用fork/session/Engine或创建UI。后端range展开/拒绝没有继续审读，不作为本轮negative证明。

初始ordering猜想透明撤销：早期协调把旧/外围loop-start描述当作当前producer断言，推想boundary提前造成assistant段遗漏。当前turn-loop554–570的appendTurnBoundary实际在幂等finalizeModelTurn，明确close completed model turn；1140–1215在model返回后1199设completed，1945–1985在on_turn_end后1961 finalize、catch1978补finalize。当前producer直接反证该前提，未形成finding/candidate；见 [原metadata notes](evidence/selection-prep/metadata-notes.json)。这是静态猜想被源码推翻，不是产品失败或新的动态验证入口。

model helper当前名称引用仍只有定义+tests，未找到实际App使用。R13已经全文/自有内存回调审过当前同SHA的helper和test，并明确无真实UI caller；旧pin-only状态不能证明未读。contextSelection旧UI source SHA与当前不同，也只能说明版本不同。保留 [旧source对照](evidence/selection-prep/prior-source-comparison.json)，不把旧pass、coverage库存或API手工输入包装为新覆盖/bug。

[正式source manifest](evidence/selection-source-manifest.json) 的10行files逐字段复用prep：6full/4selected、1186声明行=1132当前产品/test/selected消费者+54旧R13报告。App2924仅158、MessageStream928仅153、turn-loop2412仅275、transcript1377仅31行，未审完整生命周期。MessageStream专用pin晚于rg caller snippets、两份旧report晚于history excerpts，3项initial保持null；其first durable仅早于direct selected/full text。全部finish/current SHA、bytes和范围吻合，Root另绑定Git。hash-only旧manifest metadata与语义source rows分列。

原 [2921历史](evidence/selection-prep/history.json) 排除当时mutable31/future32：1295MD/1626JSON、624924strings/926095scalars、169exact archives、0parse；selection关键词59/59/2，cap100全保留，无语义穷尽宣称。正式化复用taskparse当前inventory，按 [差集证据](evidence/selection-history-delta.json) 核全部shared bytes/SHA不变、仅增冻结31的67份（9MD/58JSON），无移除/改动；只查67增量而未重扫原2921，原selection模式增0/1/0，唯一broad命中是Greek entry无关措辞。合成当前2988文件=1304MD/1684JSON、645399strings/957193scalars、169archives、0parse；本方向selection counts59/60/2，没有借用taskparse的不同关键词计数。

[validation](evidence/selection-validation.json) runs为空，当前11个既有test声明只作源读，0tests/pass/expect/import/function/fixture/React/browser/stdin/TTY/native/model/network/Git/auth/identity实验。R6 modelPicker失败、旧上下文取消/文件root等方向继续SKIP，不新增关联。此有限negative不扩大成完整context fork、settings/权限流程或全仓无bug。[分类判断](evidence/selection-history-decisions.json)与 [作者收据](evidence/selection-artifact-receipt.json)保留边界。
