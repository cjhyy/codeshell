# Round29 Room / Stop 独立静态复核

结论：支持 [Room](../room-report.md) 与 [Stop](../stop-report.md) 分别维持 **0 formal / 0 candidate / 0 new-related**。在下列限定范围没有发现需要作者修改的分类或元数据问题。冻结上下文由 Root 提供为 `b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0`；本 reviewer 没有执行 Git，由 Root 独立绑定冻结源码。

本复核等待两位作者明确 freeze 后才读报告与最终产物；没有改动作者文件。自己的 [source/check manifest](review-room-stop-source-manifest.json) 分列旧源码、当前 Round29 产物、收据与历史库存，不将未提交的本轮报告/JSON 声称为 b348 的 Git blob。

## 普通生产路径与结论强度

Room：全文读 roomHistory76、其既有测试声明42、messageMappers144；精选 Web catchup、Desktop replay、公开分页 DTO 与显示 reducer。Accumulator 固定 snapshot/throughSeq 并检查连续序号、完成边界和 cursor；collect 只在完整范围返回。Web 在 accept 完成后才折叠消息并推进位置，失败分支不提交半页；Desktop 先 collect 再 replay。这些反证支持不把任意失败实例复用、畸形记录或伪造极大序号变成普通分页缺陷，没有连接服务或运行分页。

Mapper 将完整 prose 转成 assistant_text，实际 reducer 的对应分支为独立 done:true 气泡；真实 toolId 在 start/result 两端保留，选读 reducer 有按 ID 查找和 orphan 分支。旧合成历史 ID 与后来真实 ID 的边界，缺少本轮普通在途 producer/跨 snapshot 合同证据，不能靠静态自造对象升级。没有推断 UI 无重复、网络恢复无竞态或服务器 journal 正确；AskUser、认证、权限和身份机制没有实验或结论。

Stop：全文读 helper24、既有测试声明42、QuickChat helper59；精选 controller、App、Host 和 Dock。nullish 优先级 override > active > running 与主 composer 的 stop()、同一 active busy 来源相符，QuickChat 经 Host/Dock 显式传 session.bucket，relay 亦传目标 bucket。controller 在 cancel 调用前使旧 launch 版本失效并标取消，异步 launch 有取消/版本检查。普通 send 会在启动前选择并保存 engineSessionId；没有普通 producer 证据能把某个手工旧 summary 升为新的错误目标。

即时 UI stopped 不等于 Main/Core 已完成取消，作者明确保留该界限。reviewer 没有执行 launch 测试、React、native cancel 或 SDK；也没有审完大型 controller/App 全文，不扩张为所有取消终态正确。

## 历史排除与执行口径

全文重读 R14 Web 与 R17 mapper 旧报告，并读 Stop 的 R81/R08/D5 指定片段。R14 的旧8cases/9expect不计本轮通过，user-display 失败仍 SKIP；R17 合成 ID 候选维持旧候选，不新增关联或升级。R81 下游 Browser 动作取消与本轮 renderer bucket 选择不同；R08 是另一 Web/Mobile room producer 缺目标且被 guard 拒绝，不能重报为当前 Desktop helper 误取消 native。D5 库存提到 helper，不能据少量覆盖记录宣称历史从未读。

两份作者 dedup 的2765项库存完全相同：1275MD/1490JSON，含 archive/_archive，排除 current29。reviewer 逐项核字节/hash，2765项全部仍匹配；没有重做或宣称全文语义阅读这2765份材料。作者声明的562917字符串值/833428标量、Room267/774/51与Stop64/20关键词次数，以及 capped contexts 只作历史导航，不能证明历史语义穷尽。这里判断根因是否相同，依据上述实际读过的旧报告片段。

作者的分类 JSON 均为0/0/0；validation runs 为空、0 pass/0 expect。reviewer 同样 **0产品函数/import/测试/fixture/React/browser/VM/native/网络/模型/Git执行**。测试源码是合同意图，旧通过数未借用；旧失败方向没有重跑、修支架或替代验证。

## 字节、范围与限制

独立核对 Room12与Stop13共25条作者 source rows：当前字节、行数、hash、范围上下界与 coveredLineCount 全匹配。核对两份收据列出的13+12=25个作者 artifacts 及两份 receipt 自身；全部匹配。作者提供的5个明确 freeze SHA也匹配。Room报告10个、Stop报告17个本地链接均存在。当前29产物的 review 之前没有另行 durable artifact pin，保留作者 freeze 消息和最终收据对照，不补称 reviewer 读前取证。

自己的实际语义范围为21个 source/contract 文件、1164行产品/测试、222行指令、129行旧历史；2个 mapper/launch 测试仅 hash，不因作者全文读过而计为 reviewer 已读。大型 consumer 的不连续片段分开记录；reducer222–246仅导航，不计语义行数。一次合并旧报告输出截断后，R17被单独全文重读才计 full。

Room作者 streamReducer 的首次 durable SHA 在跟读之后，initialSemanticReadSha256=null；Stop作者 QuickChat helper/Host/Dock 也诚实保留缺少 before-read SHA 的限制。最终相同字节不能重建其捕获时点。Stop记录的猜错 Dock 目录仅为 metadata locator 诊断，原始 exit 未捕获则留 null；没有产品失败或测试重试。这些已如实披露，未发现需要更改冻结材料的事项。

该复核支持所声明范围的 negative 分类，不表示全仓没有 bug，也不是运行时、平台交互或完整停止/恢复流程的验收。
