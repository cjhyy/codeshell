# 第52批：主题、活动状态与附件图片压缩

新增 **1项P3：DESKTOP-R52-01**。累计正式历史问题 **114项：44P2、70P3**，不是当前仍未修复数。[全部114项列表](ALL-ISSUES.md)、[机器目录](recorded-findings-catalog.json)。

有效1×4096（或横向4096×1）附件选low或standard时，短边被Math.round缩至0。零边canvas的toBlob依规范回调null，质量梯级最终回传原附件，因此所选尺寸上限未生效。原图保留；未声称丢图、实际账单或所有图片失败。Root103与独立104均沿普通File→ChatView→compress→staging链核对，App实际detail值入口也由104核实；“暂存仍用旧路径”猜测被反证。见[正式问题](findings.json)、[Root源码推导](evidence/root-image-compress/report.md)、[独立复核](evidence/image-sizing-review/review.md)、[WHATWG原算法](https://html.spec.whatwg.org/multipage/canvas.html#dom-canvas-toblob)。这项仅静态确认，未运行图片/DOM或测试。

[100主题预览](evidence/theme-preview/report.md)全文读Preview/resolver及实际Appearance消费者；[101活动状态](evidence/live-activity/report.md)核真实展示与消息状态链，旧弹窗不再消费计时/工具数，queue不追加optimistic用户气泡，相关猜测撤回。有限范围没有新普通反例，不代表完整主题或运行机制正确。

[102角色主题门槛](evidence/character-theme-gate/report.md)由原R7 MD9明确全文+同SHA源码行，在正文前排除重复目标；[105同作者元数据自核](evidence/character-gate-self-review/report.md)支持该限定，但102/105同作者，不称独立源码复核。Root也直接核对原R7 MD3/7/9和manifest实际baseline/assembly/row48字段。仅target-only，不另激活consumer全文，不修改旧冻件或全局台账，旧glob失败范围保留。

[106状态核对](evidence/coverage-status/report.md)确认总体台账仍是dated45的4643TS/TSX：304全文/169选段/4170未知。4339不能确认全文不等于剩余未读；46–52未统一回填，非TS和真实运行机制不计在分母内，不能报精确剩余数量。

七包100–106逐字节归档，原full/selected/navigation/hash/metadata、测试声明与执行、首诊断和null时点保留，不合并成唯一新覆盖。[范围](coverage.json)、[版本](source-manifest.json)、[验证](validation.json)、[索引](evidence-index.json)、[归档复核](evidence/review-aggregate.md)。源审读00e47保持至所有源读者冻结；随后main刷新到ab3b801f，5条并发路径中仅MessageStream在本批pin内变化，冻结审读与当前SHA分开，候选压缩源及其实际数据链pins不变。原5017历史仅release操作MD变化，不回填原扫描。

产品/helper/fixture/测试/React/DOM/canvas/图片/clock/timer/model/native/业务网络执行均0；仅Git和标准库证据核验，另明确公共官方规范web阅读Root1/独立104为3调用。首metadata失败/截断保留；旧失败动态方向不重开。只提交审查文档、不push，原主目录改动保留；全仓目标继续active。
