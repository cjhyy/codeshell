普通 marketplace 的 registry key 可以是 `local`，会被卸载路由当作直接本地安装的 marker。本 prep 保留 **0 formal / 1 拟 P3 静态候选 MARKETPLACE-LOCAL-R37-C1 / 0 related**；Root 最终正式 / 候选分类另定。条件是成功安装普通 marketplace 插件，且没有同名 direct-local 插件目录。未进行安装或卸载观察。

普通入口与因果链已闭合：

1. MarketList175–194、308–330 接收非空用户输入，preload1252 → main IPC4934 → marketplace-service343–358 调 parse / derive / add。合法仓库尾名 `local` 经 parseMarketplaceInput60–89 派生出 registry key `local`；此处讨论 registry key，与 marketplace.json 的展示 name 分开。knownMarketplaces14–25、145–148 和 installer/paths10–17 的名称条件允许该字面量，未见保留名拒绝。
2. marketplace install 使用传入 marketplaceName 生成 `demo@local`。成功路径把 mat.cacheDir 写入 registry；普通相对路径源使用 cache/local/demo/local。catalog93–138 从 key 拆出 marketplace=`local`，listPlugins134–161 原样放入 summary；该接口43–72无来源种类字段。
3. uninstallTarget31 因 marketplace=`local` 返回 kind=local，PluginsTab149–152 调 local IPC；main4807–4816 / plugins-service194–223 将其交给 uninstallPluginByName。后者仅定位 plugins/demo，目录不存在时在8–12抛错，未调用针对 cached marketplace 安装的 uninstallPlugin。由此推导普通仅市场安装的该插件无法通过这一路由完成卸载；不推导实际删除、损坏或当前用户文件状态。

反证也已保留：现有39行测试明确需要把 direct-local 的 `name@local` 送本地分支；这说明 marker 的既有意图，同时名称入口仍允许相同 registry key。bare-name / marketplace-null 的本地分支、普通非 local marketplace 分支各有现有声明；没有为此运行测试。权限、authority、custody 与安装安全性未审，也不扩展为另一个 update 发现。[分类与证据位置](decisions.json)、[源码范围与时序](source-manifest.json)列明24 pins、20语义文件、1238行（1199产品 +39测试声明），6 full /14 selected /4 hash-only；4邻接文件的专门 pin 晚于 locator片段，初次语义 SHA 保持 null。CODESHELL 指令先读后 pin，未计产品覆盖；所有24源末尾 hash匹配。

[历史总账](history.json)保留初始3216文件（1330MD /1886JSON，762312字符串 /1126584 scalars），含冻34，exact排35–37；初始排43，后续排除集合随 mutable产物增多而变化。child 的[原扫描与238行选读](history-peer/review.md)按 frozen receipt保留：May30旧 truthy 分支是相反路由，June22是 missing-null与本地覆盖，May29仅说明本地 marker。原 regex 部分重复转义，不能按名称臆定匹配范围；主 reviewer 另做[修正后的全量机械补扫](history-corrected.json)，保留代码、读前 pins与新 dated范围，不覆盖原件。修正后仍3216文件、相同MD/JSON/scalar数，9组hits为55/8/13/2/0/68/4/32/5，均低于400cap；[实际选读与对比](history-corrected-selection.json)包含全部8个 quoted contexts，其额外旧R52命中是恒定cache版本local更新失败，非registry名称分派冲突。其余8组匹配 locator签名与原稿一致。未找到精确旧同因果；这是 bounded no-exact-match，不是历史语义穷尽或绝对首报证明。

两次 dated快照只差 release-real-operations TODO（177252B /6d6d93… →189803B /c8cdef…），included新增/删除0，实际选读3文档字节未漂移；Root报告是其他任务 main合入所致，本 reviewer未执行Git核实。原扫描末尾的3215unchanged+1changed与修正补扫末尾3216unchanged分别保留。[结束检查](finish-checks.json)还核了child13条receipt与其自排除收据，共14文件。源码全hash与语义范围分账，不把重复历史/locator或归档计划中的测试命令计为当前运行。

[metadata说明](metadata-notes.json)保存本 reviewer首个错误.tsx locator的exit2 /截断，以及child选段越EOF、历史字节漂移的原exit1；原诊断均在各自文件中。修正仅为静态读选段和历史账目。所有[产品验证记录](validation.json)的 runs为空：0产品函数、安装、卸载、catalog调用、测试/fixture、CLI、Git业务、HTTP/web、React/browser/native、真实配置与权限/custody实验。[作者收据](author-receipt.json)封存本 exact temp目录；未改repo或任何冻结peer原件。
