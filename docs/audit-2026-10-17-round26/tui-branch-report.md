# TUI Branch 参数：分支名中的 -c 被当作创建参数

冻结点 `6d61f57ade1ef1b9fdc4d33020652007d995e7a7`。登记 **TUI-R26-01 / P2**，只有静态源码因果证据；**0 产品/import/fixture/test/VM/native 或业务 Git 执行**。没有真实创建或切换分支，没有修改产品。不是最新 Review 功能才引入的问题。

[实际 /branch 定义](../../packages/tui/src/cli/commands/builtin/git-commands.ts:101) 声明 list/create/switch，usage 为 `/branch [name] [--create]`。[122–124行](../../packages/tui/src/cli/commands/builtin/git-commands.ts:122) 却在整个参数串查 `includes("-c")`，再全局删除 `/--create|-c/g`。在正常 Git 仓库中输入 `/branch feature-cache`，没有任何单独创建flag，源码仍推导 create=true、name=`featureache`，调用 `gitCheckout(cwd, "featureache", true)`。

[gitCheckout](../../packages/coding/src/git/utils.ts:145) 接受非空且不以横线开头的名字，这两个普通字符串均通过其校验；[156–157行](../../packages/coding/src/git/utils.ts:156) 对 true 构造 `['checkout','-b','featureache']`，而正确切换请求应是 `['checkout','feature-cache']`。这是源码导出的请求参数，**未观察或执行真实 Git 命令结果**。若被误删后的目标名可创建，可能创建并切换到另一个分支；若不能创建则报错，而不是切到请求的分支。影响为普通命令指向错误分支/动作，不声称用户提交或文件已丢失。

普通入口也明确存在：[App 注册 gitCommands](../../packages/tui/src/ui/App.tsx:124)，[App 分派](../../packages/tui/src/ui/App.tsx:2071)，[dispatch helper](../../packages/tui/src/ui/app-helpers.tsx:118) 把 cmd 原样传 registry；[registry.dispatch](../../packages/tui/src/cli/commands/registry.ts:132) 把这个无空格名称作为arg传实际execute。旧全参数空白归一化问题不会更改本例；不依赖人为构造 callback、非法参数、命令注入或平台差异。

反证与边界：空参数走列表；没有 `-c` 子串的普通 `topic` 保留名且create=false；`topic --create` 正确请求创建；这些是源码正常分支对照，**不是测试通过项**。`--create`或`-c`作为真正独立选项的兼容意图不能证明应把名字内部相同字符删除。相同子串根因还会损坏显式创建的 `feature-cache --create`，不拆成第二个bug。建议将选项作为独立token识别并只移除对应token，保存名称字节；本批不实施修复。

[全历史去重](evidence/root-branch-scan.json) 包含 prior docs/bugs 所有MD和递归JSON值标量，含archive/_archive，排除round26；读取时 **2509=1241MD+1268JSON，426811strings/609678scalars，0parse error**。branch_options共12匹配，全部上下文保留（cap100），真实分支相关父段只有 feature inventory 的正常用法及其引用；其它为Web branch/strip等噪声，未见同一子串选项错误。关键词不是语义穷尽证明。Root同时只读核近期TUI/Git父报告及旧CLI组，未用旧失败夹具或另一种动态方法恢复它。

[旧CLI-R4-01](../audit-2026-10-17-round4/root.md:21) 是registry split/join压缩引号内空白的静态候选，首次CLI组在产品import前失败；保持原等级与SKIP。新Review quoted path的相同现象由target作者作为旧关联登记，不把它升级成新确认。当前branch问题是另一原因，短无空格名称即可出现，报告不依靠任何该旧组运行。

Root另外全文静态读 review-target、prompt、service、hook、composer与shared contract，选读TUI Review/cancellation/QueryGuard接线。当前prompt动态fence和显式coverage为反证；新parseReviewArguments处理perf别名，但旧parseDimensions本身仍未支持该别名，所以不据新TUI路线宣称旧R19整体修复。没有重复旧17/57、parser/React/CLI baseline或创建新测试来增加通过数。

[Root来源](evidence/root-source-manifest.json) 对full/selected/导航区分并绑定冻结Gitblob及当前bytes；[Root验证](evidence/root-validation.json) 执行列表为空，不表示零失败通过门禁。[Root记录](evidence/root-metadata-notes.json) 保留静态导航元数据失误；[Root材料收据](evidence/root-artifact-receipt.json) 与最终索引负责bytes/hash。独立branch复核另记录。所有Git写归Root，仅用于隔离审查文档及集成。
