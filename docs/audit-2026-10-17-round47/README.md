本批Web消息普通展示审查与覆盖元数据适配：新增正式问题0、候选0、关联问题0。此前111条正式历史记录不变，见[完整目录](../audit-2026-10-17-round43/README.md)。产品/helper/test/fixture/UI/native/model运行0。

Web MessageContent目标295行全部显示，但普通text/reasoning、streaming/settled、代码/工具摘要仅选段计语义；HTML、链接、剪贴板和宿主回调止于相邻边界，不称全文语义。实际Workbench调用与streamReducer所选正常分支对应：text/reasoning累加，assistant_message/turn_complete结束，工具args/result/status分别传递。三份产品源码共454语义行，测试只读57行声明，总511语义/902去重显示；4selected+3hash，7pin结束同SHA。旧Desktop复制围栏、TUI表格与Unicode根因没有重报或恢复动态方向。本批未建立具有正常输入、真实入口和独立根因的新反例。

覆盖适配只识别结构化inspectionScope中明确句首整文件标签，并保留唯一同对象path/currentSHA、有限purpose和not-full/selected/hash/navigation/引用/机制边界/范围等否决条件。原49/51路径集合精确复现；独立metadata reviewer逐一核10个新增full原对象、35个实际转移和全部4162历史机器计数。此过程未增加产品源码语义阅读，也未执行作者method或产品。

| 本次台账对照阶段 | full记录 | selected且无full | 无法由本索引确认 |
| --- | ---: | ---: | ---: |
| 旧51记录、精确当前SHA重绑定 | 288 | 150 | 4205 |
| 仅补inspectionScope字段 | 298 | 150 | 4195 |
| 再纳冻结43/44记录 | 301 | 161 | 4181 |
| 再纳冻结45记录 | 304 | 169 | 4170 |

以上分母为4643个TS/TSX路径，含测试/辅助文件；纳入记录截至冻结45，46及以后未倒填。4339仅是这份dated台账不能标完整的路径数，不是未读、剩余工作或bug数；MD-only及未适配schema不穷尽，不给全仓百分比。旧49原4642路径292full/154selected也精确复现；旧SHA导致4full+4selected失效单独列出，不能当字段修正。

10个字段新增full来自20个有TS/TSX锚点的inspectionScope对象；21是所有对象的口径，额外1个instruction对象不在源码集合。14个positive对象对应12路径，其中2路径原已有full；6个limited/行号对象不升级。它们保留原query producer/error consumer等有限purpose，不等同所有行为正确或当前运行通过。

唯一来源澄清：contracts/dataset.ts的代表原指向43聚合检查转摘；原canonical manifest同SHA明确selected1–181，剩余filesystem/store未读。正式展示以[原始来源覆盖说明](evidence/provenance-clarification.json)指回该canonical，保留限制，不升级345行full，不把转摘当新阅读；57/60冻件与304/169/4170计数均不改。其余34代表为canonical。

所有首次metadata错误/截断保留：作者57非法变量名、hash alias归一化与canonical引用选择的中间原件；reviewer60对两个nonfull旧SHA的误要求已明确撤回，不当作者错误。Root另有一次宽metadata文件列表输出截断，仅使用可见候选，见[root导航说明](evidence/root-navigation-diagnostic.json)。均非产品失败或运行重试。

[Web作者](evidence/web-message-frontier/report.md)、[适配作者](evidence/coverage-adapter/report.md)、[独立metadata复核](evidence/coverage-review/review.md)、[归档复核](evidence/review-aggregate.md)、[源版本绑定](source-manifest.json)、[验证范围](validation.json)、[证据索引](evidence-index.json)。worker Git0；Root状态/版本绑定/集成另计。机器计数不等于阅读全部历史语义；12MB派生claims只机器计数/hash，不提取为新的语义证据，也没有重复复制。
