# UTF8-R34-C1 current-source refresh — future Round41 prep

旧候选 **UTF8-R34-C1** 在实际读取的commit `037c2afbb05f2fcb3b2f3f3588be2b4a980032a1`已有直接针对同因的源码处理：running/starting增量peek先保留潜在有效但不完整的UTF-8尾，再只解码/推进完整部分。本次所读条件内未建立剩余ordinary gap。建议阶段备注为 **source-addressed at037 / runtime not revalidated**；不是当前宿主已验证修复。0新formal、0新candidate、0new-related，不分配新ID，不修改旧R34候选或已冻结40材料；归档/阶段分类由Root统一决定。

## 与旧同因的源码对照

已全文读旧[proposal.md](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round34/evidence/utf8-frontier/proposal.md)15行和[独立review.md](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round34/evidence/utf8-review/review.md)13行。原C1条件是完整逻辑有效UTF8流跨data event、peek恰在字符未完成时发生，且可用新输出不超过16KiB。旧reader在该小burst分支直接解码全部bytes并推进全部cursor，后续 continuation到达也无法从该incremental cursor重组。旧材料明确缺少真实宿主chunk/peek时序观察，仍属候选；旧cap helper针对完整有效buffer的negative不借为运行证据。

当前 [background-shell.ts:57](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/runtime/background-shell.ts:57)（57–85）新增completeUtf8PrefixLength：从尾部有限回溯，按lead决定所需字节数；完整或不可能成为有效字符的prefix仍返回全部可用长度，潜在有效未完成suffix返回其开始位置。73–83明确保留invalid/overlong/surrogate/out-of-range前缀的replacement与forward-progress语义。

实际 [readOutput:509](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/runtime/background-shell.ts:509)（509–538）先取从绝对cursor开始的raw slice；running/starting在513–516计算完整prefix，其余terminal/orphan状态消费EOF。517–518把consumedBytes/rawBuf限制在完整prefix；534–535只解码该prefix并推进对应byte长度。因此原候选的“未完成尾立即解码并全推进”前提在这里已不成立。

保留链也是实际源码：[background-shell.ts:358](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/runtime/background-shell.ts:358)（358–372）仍把stdout/stderr raw chunk写ring；[RingFile.write:96](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/runtime/ring-file.ts:96)（96–105）在保留窗口内拼接原bytes，147–151从相同绝对cursor返回仍保留的尾。于是，在旧C1的有效stream/未evict条件下，未消耗尾prefix可以与后来到达的continuation一起参与后续读取。这是人工沿源码的byte-offset推理，没有运行Buffer样例或模拟流。

大于16KiB的完整prefix仍走background519–531及 [utf8-cut.ts](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/runtime/utf8-cut.ts)全文21行的原safe cut；terminal EOF故意不无限等待，all snapshot487–497不推进incremental cursor。[BashOutput:28](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/tool-system/builtin/background-shell-tools.ts:28)（28–30）仍明确允许STILL-RUNNING on-demand peek，57–61默认incremental并转发manager返回值。这确认修复分支位于原来真实入口链，没有仅凭新增文件名判断修复。

结论仅针对这个保留的有效UTF8前缀场景。不扩展为ring wrap/eviction、stdout/stderr交织、snapshot UTF16 surrogate切片、cleanOutput CRLF旧因或整个Shell生命周期正确；也不以任意invalid Buffer、NaN/分数cap构造新反例。旧Round25输出清理及D03 JSON-lines decoder记录属于别的原因，继续不重开。

## 新测试仅作为声明阅读

[background-shell.utf8-frontier.test.ts](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/runtime/background-shell.utf8-frontier.test.ts)全文334行，静态读14处test调用语法：5项CJK/emoji拆分表、ASCII/完整字符、无中间peek、16KiB cap、重复空peek、3terminal状态表、初始terminal EOF、无效prefix前进、held lead后invalid、cap后不完整尾、Unicode范围边界循环以及starting→running。另有foreign-session拒绝声明，仅作为相邻测试源码读取，不进行身份/权限机制实验。

该文件定义真实RingFile FS fixture，并替换network/process入口、运行guard probes、创建mocked registry及调用实际BashOutput；这些全是读到的代码，**本审查未import或执行任何部分**，没有确认guard有效，没有创建目录或实际输出文件，也没有Bash/stream/Buffer/语言fixture或产品子进程。fixture里的inert process state不等于真实宿主分块时序。没有读取或借用其他线程的测试pass、stdout witness或fix worktree名来证明运行修复。

## 新scope、版本绑定与历史gate

本次初始filesystem pin均早于当前对应源码/旧报告内容阅读；[source-manifest.json](/tmp/codeshell-audit-round41-utf8-source-refresh/source-manifest.json)区分5个current product/test路径与2个历史报告。当前2full/3selected，共815观察行=481产品行（含另列rg导航）+334测试行；历史报告另28行。whole-file SHA/Git blob绑定不表示该产品文件全文语义已读。所有initial/finish相同，CODESHELL/AGENTS仅核对此前已全文阅读指令SHA，新增指令语义行0；本prep独立读前instruction pin保留null。

此次实际进行了 **7条read-only Git命令、0 Git写**：[git-read-receipt.json](/tmp/codeshell-audit-round41-utf8-source-refresh/git-read-receipt.json)逐条记录。初始git rev-parse HEAD/main均037c2a，origin/main当时为02d5d9；随后对5个current product文件逐个git show固定037的blob，bytes/SHA均等filesystem初始pin；最终git rev-parse HEAD/main仍037。不是沿用以前0Git措辞，也没有由origin/main落后推导产品状态或执行网络fetch。该验证是Git/文件元数据读取，不是产品运行。

完整docs/bugs MD+递归JSON value scalar metadata gate纳已冻38、排mutable39/40/41：3509文件=1361MD+2148JSON，975542 string leaves、1464542 scalar leaves，169 exact archive/_archive路径，0parse错误。canonical inventory SHA256 `3a18bff9033e4818ba2874371dad6cfbcf612ec91e3b4835096c7fc45d2beae0`；exact-candidate15、peek-boundary20、old-failed0，cap80，实际保留15/20/0且35contexts全部读完，无截断。所有命中与旧C1同因只归原项，不重复计数；历史worktree名字只作为dated metadata，未访问其checkout或当作运行证明。

相对future40 dated3509库存，文件集合0新增/0删除，共享release-real-operations文档1项byte drift保存在[history-delta.json](/tmp/codeshell-audit-round41-utf8-source-refresh/history-delta.json)，不回写旧库存或把其原history冒称当前冻结点。本次history仍排39，即便Root已经报告39/main刷新；源版本绑定与旧历史排除口径分开。

[validation.json](/tmp/codeshell-audit-round41-utf8-source-refresh/validation.json)明确0产品/helper/decoder/Buffer示例/语言fixture/import/test/真实流及输出文件操作，0产品Bash/CLI/子进程/native/network/auth/权限/identity动作，0repo产品或文档写入，7 Git读/0写；唯一写入本tmp。metadata history会话已收取exit0；0runtime passes/expectations，未重开旧失败方向。当前只支持有限source-level counterevidence，真实宿主及允许的运行复验不由本审查完成，旧候选阶段处理留给Root。
