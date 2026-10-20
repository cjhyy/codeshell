# TUI Branch 独立静态复核

支持 [Root报告](../tui-branch-report.md) 保留 **TUI-R26-01 / P2，Root本方向1 formal / 0 candidate / 0 related**。没有发现需要纠正的触发、源码推导、计数或影响表述。单一子串识别/删除原因，不把无flag与显式create的两个例子拆成两个bug。

普通合同与接线已独立核对：App124–126构造CommandRegistry并注册gitCommands，App2071调用实际 [dispatch helper](../../../packages/tui/src/ui/app-helpers.tsx:118)，helper125原样交registry.dispatch；registry132–141对短无空白名称保留arg，再调用注册对象的execute。`/branch` 的description为list/create/switch，usage105为可选独立`--create`。当前 [122–124](../../../packages/tui/src/cli/commands/builtin/git-commands.ts:122) 却对整个arg查`includes("-c")`并全局replace。普通`/branch feature-cache`由源码必然推导`create=true`、`name=featureache`；这两个名称都不为空且不以横线开头，实际 [gitCheckout145–157](../../../packages/coding/src/git/utils.ts:145) 的校验不会补回原名或撤销create。

因此 [findings](root-findings.json) 将正确请求`['checkout','feature-cache']`与**source-inferred**请求`['checkout','-b','featureache']`区分是恰当的。没有捕获argv、调用产品字符串算法、提取函数、mock或执行真实Git；这里只做静态数据推导。P2合理之处是普通切换操作会变成另一个名字的创建请求，命令的主要功能与意图不一致。若可创建才可能转到新分支，若不可创建则可能报错；没有证据证明本次成功创建/切换、提交/文件损失、平台频率或权限问题，Root报告也未作这些断言。

反证充分且范围准确：空arg是列表，普通topic没有该子串，topic --create是独立创建意图；它们只是源码对照，不是passing tests。合法独立flag的兼容意图不能授权删除branch name内部同名字符。旧registry split/join不会改变这个短单token示例。其 [CLI-R4-01父项](../../audit-2026-10-17-round4/root.md:21) 是内部空白归一化；旧validation.runs[3]首次CLI夹具在产品导入前失败，0pass/1fail/1error/无Completed，必须继续SKIP。当前branch是另一原因，Root没有借旧失败夹具或另一动态方法验证它。当前quoted-review同旧registry原因的关联由target材料另记，不算Root的新bug或本项证据。PERF/fence/UTF16等旧机制没有被再包装为分支问题。

[Root去重](root-branch-scan.json) 的2509份prior库存全部独立核bytes/SHA，并重新按其规则解析MD及递归JSON值标量：1241MD/1268JSON、426811strings/609678scalars，含169 archive/_archive，排除round26。三个匹配计数12/9/174和全部保存的12/9/100上下文都与首snapshot独立重计相同；其中branch_options12条全部保留。已逐条读branch上下文，真正相关的是feature inventory的正常独立flag用法及引用，其余Web branch/strip与worktree说明不构成相同子串错误。实际读 [feature inventory277](../../architecture/11-feature-inventory.md:277)、旧R4完整报告及失败父run；关键词和有限父段不证明语义穷尽。去重脚本只做文本/JSON处理，没有恢复产品或测试方向。

[Root source manifest](root-source-manifest.json) 的18份当前filesystem bytes、SHA、lineCount和selected范围均逐项匹配Root登记的freeze hashes且范围在EOF内。这是当前字节与Root pin的复核，**本reviewer未执行Git命令，未独立重放Git blob验证**。8b→6d branch对象未变的 [prior-source记录](root-branch-prior-source.json) 作为Root提供的只读Git来源元数据核对；不将其冒充本reviewer独立读取历史Git对象。报告正确说明此错误不是新增Review功能引入。

语义阅读与hash核验分开：本reviewer对branch链实际选读git-commands1–23/83–131、utils1–34/123–165、registry104–147、App114–129/2052–2078、app-helpers114–146及上述历史父段；没有认领18份文件全部独立全文审查，也没有因Root全文件hash扩大运行覆盖。关键当前SHA：git-commands `0de851ebbecfc4d2159a994a04e026f8fc22378b7b8083c02a3ec4a144e8376c`，utils `8e3531c2b340359e99e13b35242a88bb12eed51008e2c9ded67b149be7983192`，registry `0b73681bf81543cedbc220a28b4f7bfaf7cbf0f89784c6ac3cf74ab024689a7c`，app-helper `1696995a266590dc467e827df622d3f60cdbb5a57161f1015955861f212fa3e7`。

最终 [Root artifact receipt](root-artifact-receipt.json) 的10份文件全部核bytes/SHA，receipt自身排除；report14个本地链接和行界有效。report SHA `f06bdec75fafbab2e659d42965837520a0c9ea320526011480542503e5b85132`；receipt SHA `77d1cdff91e4a0c1b70e45f97942b9c012b8c38f6b71eb9d3601bb42e2ca0246`。[validation](root-validation.json) 的runs为空；0pass/0fail不是通过门禁，没有应当存在的产品raw被遗漏。[metadata notes](root-metadata-notes.json) 对.ts/.tsx和pending receipt猜名保留首次响应/退出与范围，没有升级为产品缺陷。

父报告freeze为`6d61f57ade1ef1b9fdc4d33020652007d995e7a7`。本reviewer产品/import/test/fixture/VM/AST/eval/native/PTY/真实Git/网络/auth/permission/custody/identity/security实验及Git命令/写入均0；只写本文件，Root作者文件未改。Review ready。
