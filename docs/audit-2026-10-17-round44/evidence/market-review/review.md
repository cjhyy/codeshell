# MarketList 普通列表独立静态复核

结论：0 新 formal、0 candidate、0 new related。只对本次普通 DTO 列表分组、显示与选择链给出有限 negative；没有执行产品、测试或 UI。

我也是旧 R36 ui-state/NotificationHistory 作者。首选 NotificationHistory 在读正文前因同 SHA 的旧 1–108/150–193（152 行）及同筛选、markRead、clear 流程排除，本次该产品 body 为 0；不是 193 行全文审查，也不把旧作者身份当成再次独立复核。经 Root 明确替换 gate 后，才独立读 MarketList；形成以下判断前未读本轮作者的 mutable 或 final 报告。

- ManagePage 177 明确对 market 隐藏搜索框；MarketList 没有 query prop，因此没有从旧计划中的跨 tab 搜索描述推出当前市场页显示搜索却不筛选的 bug。
- list/recommended DTO 声明与 service 245–256 的装饰按名称或 source 匹配 added；MarketList 278–289 使用同类谓词，将已添加项按谓词及其否定分为两组，再呈现剩余推荐项。没有把 name-only 假设或任意 Git URL 大小写输入当作普通生产反例。
- MarketList 258–267、420–455 将选中的原名称送给 MarketDetail。后者按该名称加载 DTO，依赖变化时使用 alive guard；详情中的 loading/error/back、插件名称和版本展示选段未建立新的普通数据不一致。

范围见 [source manifest](source-manifest.json)：5 份产品源均为 selected，共 563 产品语义行；另选读旧 R36 report 的 9、14、21 共 3 行。产品显示 795 行，多出的相邻 imports、Git check、安装 job、add/remove/refresh 操作及字段不是本次语义覆盖。没有 tests body 阅读或测试通过声明。 [source excerpts](source-excerpts.json) 是阅读后的元数据快照，不另计覆盖。初始 [leaf pins](initial-pins.json)、[consumer pins](consumer-initial-pins.json)、[DTO pins](dto-initial-pins.json) 均在各自正文阅读前保存。只追到普通 wrapper/声明，未调用底层文件、网络、安装、身份或权限机制。

[历史快照](history.json) 在 2026-10-17 14:42:58–14:43:01 UTC 扫描 docs/bugs 全 MD 文本及递归 JSON value scalars，含 exact archive/_archive，纳冻 42、排 43–48：3869=1391 MD+2478 JSON，1,255,894 string leaves、1,896,731 scalar leaves，169 archive paths、0 parse errors。 [方法](history-method.py) 为字面查询，JSON keys 不搜索。Notification path/SHA 命中 10/14，MarketList 16/18，cap 均 100，全部命中已保留于 [contexts](history-contexts.json)。实际阅读 path 的 26 个有限窗口和 [19 个明确 coverage 元数据行](coverage-gate-rows.json)，没有声称读尽所有 SHA 窗口、巨型 scalar 或完整旧文档。旧 R37 同 SHA 只有明确 175–194/308–330 的 43 selected 行；no-row/hash-only 不证明历史未读，旧 local namespace/uninstall 因果未重开、未新计。 [分类](classification.json) 保留这些边界。

结束检查有两处真实字节漂移，原时点未改写：[ending checks](ending-checks.json)。类型声明文件由读前 102234 B / cd152ddf… 变为 102370 B / 31935ed8…；其余 6 个产品/旧文档 pin 全同。 [DTO range check](dto-range-drift-check.json) 从先前 tool 13ce0f 的显示文本保留两段 863–883、2068–2094，核对结束时同一行号逐字相同；这只证明所读片段未变，不是整文件 diff 或全文件同 SHA。active source 行保留读时 SHA，ending SHA 另列。历史集合仍 3869、无新增/移除，只有 release TODO 从 199956 B / 8c1b9ca1… 变为 212262 B / f654cd5e…；不借旧快照声称结束时全历史未变。

[诊断](metadata-diagnostics.json) 如实保留首次猜 types.ts 的 locator/pin exit 1、另一旧报告猜路径未命中，以及首份结束元数据将 ending SHA 放入 sha256 字段的口径问题。first manifest/checks/excerpts 原字节均保留，active 行已明确初读与 ending 版本。这些是元数据问题或真实文件漂移，无产品尝试、测试失败或失败方向重试。Root 随后说明结束 refresh 已由 c2db 到 07e5791b1fc1ad1fcfd5c55c2913d8a45f1b20cb，22 incoming paths 包含这两处漂移；这里只记录 Root 提供的外部上下文，本审查 Git 调用为 0。

有限结论不认证所有来源规范化、跨时点列表一致性、详情错误导航或整个插件市场无 bug。冻结清单见 [receipt](reviewer-receipt.json)。
