# MARKETPLACE-R37-01 · P3 · 合法市场名local与本地插件来源冲突

普通插件市场允许注册为`local`。从该市场成功安装插件后，安装标识的`@local`后缀会被卸载界面解释为“直接本地安装”，调用只处理`plugins/<name>`目录的入口。仅装了市场缓存插件、没有同名直接本地目录时，这个入口会拒绝卸载，市场缓存条目仍保留。

这是静态确定的条件式路由错误，原候选`MARKETPLACE-LOCAL-R37-C1`升级为本项，只有一个问题。没有实际注册市场、安装、卸载、检查用户目录或观察运行时错误；不声称发生删除、损坏或所有卸载途径都失败。

普通生产者与消费者链已分别读源：

1. 市场添加表单、解析与注册允许仓库尾名派生出`local`；名字正则及单段路径约束均没有保留该名称。
2. 正常市场安装按`plugin@marketplace`保存标识，并使用`plugins/cache/<marketplace>/<plugin>/<version>`缓存。`local`因而同时是合法市场名称和既有的直接本地来源标记。
3. catalog从标识后缀得到`marketplace: "local"`，summary透传；[卸载目标判断](../../packages/desktop/src/renderer/extensions/uninstallTarget.ts#L29)返回`kind: "local"`，实际PluginsTab选择本地IPC。
4. 本地callee只查直接安装目录，在没有该目录的普通条件下抛出缺少插件的错误，未对这个市场缓存安装执行对应卸载。

原作者的[入口与生产链](evidence/marketplace-local-frontier/proposal.md)、独立复核者的[完整路由反证](evidence/local-marker-review/report.md)、Root的[名字/标识/路径复核](evidence/root-frontier/proposal.md)及[聚合材料复核](evidence/aggregate-review/review.md)分别保留归属。三份范围重叠，不相加为独有覆盖；聚合复核新增产品语义读取0行。

已有直接本地插件必须继续识别`@local`。旧“直接本地来源误走市场卸载”是反方向问题；旧R52的固定`local`版本缓存、PROFILE-R5-01的来源key折叠也是不同原因。`CSMeta.source`和`installPath`虽存在，这条catalog/helper路由未用它们区分来源。建议贯穿显式安装来源，或统一保留名称并处理已有数据；单纯删除当前`local`分支会破坏原有本地卸载。

判定绑定冻结父提交`ee5c1a90050ce3cdddd3f2ebee2f9a2c0d8824d8`及[源码指纹](source-manifest.json)。历史扫描只能支持已列查询与实际选读范围内的去重，不证明全仓绝对首报。
