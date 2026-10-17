本批普通上下文配置表单与外观偏好数据审查：新增正式问题0、候选0、关联问题0，产品运行0。此前111条正式历史记录不变，见[完整目录](../audit-2026-10-17-round43/README.md)。

ContextSettings由作者与独立源码复核者分别检查。正常百分比草稿→除以100序列化、UI与Core范围/default一致；相等顺序经normalize和Core clamp允许，双语提示明确为≤，没有把源码旧注释的严格<当成新bug。保存实际经settingsBus/user分支到main普通配置patch，reset的null在deepMerge中删除覆盖；SettingsManager→Engine ratios→run-context→ContextManager阈值消费链在选定范围内相符。权限、identity resolver与Host机制只导航，不作正确性结论。旧发布记录里的读取保护、正常数字草稿、保存/reset失败保留与slider名称修复均作为旧反证，不另立ID。

Appearance仅做普通mode/pack枚举、state/save与pressed/name回显的选段审查，不称362行全文。模式与包各用独立键，installed描述保留id/name和来源。安装导入/删除、焦点恢复、音频、系统主题应用与Host机制不在本次语义范围。ThemePackPreview保持hash-only；LogsView在正文前发现同SHA旧完整审查，故排除重复正文。现有测试只阅读声明，没有执行。

两个方向的原始3979文件旧因gate纳入冻结43、排当时未冻结44；Root归档44新增的仅市场列表、三旧项源码状态及覆盖元数据，没有新的Context/Appearance发现。归档45开始时main已并发前进至0b174967；相对上一审查commit仅[两个路径](evidence/incoming-before-begin-main-paths.json)，不相交普通表单源码。原3979清单不倒写，release TODO的字节变化由ending检查单列。原始初稿/metadata错误与诊断按原件保留，不作为产品失败或运行结果。

[作者](evidence/context-frontier/report.md)、[独立Context复核](evidence/context-review/review.md)、[Appearance作者](evidence/appearance-frontier/report.md)、[归档复核](evidence/review-aggregate.md)、[源版本绑定](source-manifest.json)、[验证范围](validation.json)、[证据索引](evidence-index.json)。所有产品/helper/test/fixture/UI/native/model/network运行0；worker Git0，Root版本绑定和Git集成另计。完整阅读只表示声明范围内的静态审查，不保证所有行为正确，也不自动更新上一批全仓覆盖下限。
