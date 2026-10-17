# Project options independent static review

支持 parent 的有限 **0 formal / 0 candidate / 0 new related** 结论。独立核查没有建立普通选项列表、标签或 Select 值映射的新反例；不把这个结果扩展为全部项目、路径或自动化无 bug。[判定记录](decisions.json)保存合同和边界。

`projectOptions.ts` 全文101行明确了本 helper 的普通合同：无项目 sentinel 在列表首位；跟踪项目按输入顺序、精确路径字符串去重，空 path 跳过；trim 后的 displayName 优先于 name。非空当前 cwd 若不在列表且未被既有 no-project predicate 分类，则保留为合成选项，已有 mounted root 可提供项目名与 root 名组合。选中值与清空 cwd 的双向映射使用同一 sentinel。没有从这里推出跨平台路径归一化或真实注册准入合同。

实际 `AutomationDetail` 选段使用同一组 helper 产生 Select value、option items 和 onValueChange 的 cwd 转换；resume-session 分支显示继承标签。已有 `pathMatch.isNoRepoCwd` 不仅处理内部 no-repo 目录，也按其注释分类 scratch 路径前缀，本审查保留这一既有合同，没有把它误写成“只有空值/内部目录才算无项目”。中英文资源均有 noProject 字段。`projectOptions.test.ts` 全文107行包含13个 it 声明，覆盖顺序、显示名、补项、去重、空值、no-repo、mounted root 和 sentinel 映射；这些只作测试意图，未运行。

[源清单](source-manifest.json)记录5个语义 pin，2 full / 3 selected，297行＝190 product＋107 test；另有2个指令 pin，CODESHELL本次重复全文217行单列。target全文在初始 pin 与 history gate 后读取；消费者/test 的少量导航行先于专用 pin，`initialBeforeAnyContentReadSha256` 保持 null，selected body 有单独读前 SHA。`pathMatch` 全78行和 consumer 若干邻接内容曾打印，但实际审计范围仅记录普通 predicate/DTO/显示选段；平台匹配、project/root identity 分支、时间/status 与权限类型邻接内容未作机制结论。所有7个源/指令 pin 结束字节一致；与作者重叠的行不作全局新增阅读相加。

本次独立 fresh history gate 扫描 docs/bugs 全 MD 及递归 JSON scalar values，含归档和冻结38，排 mutable39 / future40/41：3509文件＝1361MD＋2148JSON，975542 string values、1464542 scalar values，0 parse errors。四组命中6/7/1/24，cap每组160且均未触达；保存的上下文按完全相同文本去重为22段，全部完整读完，另核1个同 SHA metadata row。[扫描](history.json)、[实际上下文](history-selected-contexts.json)与[历史判定](history-decisions.json)分别保存。唯一同 SHA row 是 Round28 package inventory 的101行/3885B hash记录，不能当作历史 full 语义证明；命名整合资料显示此前关注过此模块，也不能声称此前从未读。历史测试 receipt 只读为导航元数据，未打开其原始 runtime log 或借旧 pass 验证本轮。

本 reviewer 初始 release TODO 已是199956B / `8c1b9ca1…`，与 parent 初始3509库存有1个共享文件字节差异；[作者元数据复核](author-metadata-checks.json)保存双方原始行，不倒填 parent 时点。自己的3509 included 路径集与结束字节全部一致，见[结束检查](history-finish-check.json)。175为路径含 archiv 的 substring 计数，parent169为 exact archive/_archive目录口径，不混用。没有把全文字符串匹配扫描称为全部历史语义阅读。

独立源码结论形成后才读 parent 冻结[报告](../codeshell-audit-round40-data-frontier/report.md)及结构化材料；其16条 receipt records、包含 receipt 的17文件集合全部匹配，5个 active semantic source pins 当前字节匹配。其385行含2条导航的声明保持作者口径，不计入本 reviewer297行。parent 的 stripMarkdown 已在读正文前按旧 R2-05 排除；本 reviewer 未读该正文、未另核其产品字节或重开旧 Markdown 方向，仅核父证据文件字节与排除声明。

本范围没有为相对路径/sentinel碰撞、畸形 roots、临时目录准入等手造 DTO 建立普通 producer；因此未升级为问题。真实 project registry、路径 admission、project/root identity、后台保存/执行、automation runtime、权限、平台及语言状态均是边界跳过，不是 negative 证明。

[validation](validation.json)记录产品/helper/import/语言 fixture/测试/React/实际项目或自动化动作/native/network/Git 均为0，无旧失败方向重试。本 reviewer 没有 metadata 失败命令或输出截断；导航 timing 与打印但未审计的邻接范围已明确记录。所有写入只在本 exact tmp 目录，源和冻结39材料不改。收据自排除以避免递归哈希，见[本 reviewer receipt](author-receipt.json)。
