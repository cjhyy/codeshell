# 覆盖台账更新：统计到正式61

原4643个TS/TSX路径，当前相同SHA的保守状态：**360完整范围、363部分、3920覆盖证据不足**。其中4283个尚不能标为完整范围。full仅代表原目的下完整静态语义文本；不证明所有行为/平台/运行机制正确。unknown也不证明从未读过。

相对[上轮台账](../audit-2026-10-17-round61/COVERAGE.md)，本次回填正式61原阅读证据，5个unknown→full、9个unknown→selected，另8个selected仅补provenance。不把多份selected拼成full，不把作者和复核者重叠相加。[163方法与原用途](evidence/coverage61/report.md)、[逐路径索引](evidence/coverage61/unified-current-index.json)、[变化](evidence/coverage61/transitions.json)。这些是既有证据归类，不是本次新读4643源码。

原161/files7展示范围40–124超过文件实际EOF120，该行整体暂缓迁移；有效selected51–80/114–120独立保留，其他155/159记录仍支撑同path。原冻件不改，不重新运行展示helper或声称替代实际显示总数；原MCP问题还有有效源证据。[勘误与范围澄清](evidence/scope-clarifications.json)。适配器首次只接受body字段、误拒实际navigation-display union支持的明确semantic17行，后来纠正；首方法/输出保留，未从纯nav创造语义。163的第二实现是作者自检，不是外部peer。

Root再核4643源码raw bytes及Git blob全同；当前同过滤库存4644，多出的旧57 static-path.test.ts审查fixture单列在分母外。[当前绑定](evidence/coverage-snapshot-current-binding.json)。本轮62的source选段未再并入统一索引。非TS/TSX、跨模块行为、完整运行/平台验证不在该分母，不能据此给出全仓精确剩余量或剩余bug数。全仓审查目标仍active。
