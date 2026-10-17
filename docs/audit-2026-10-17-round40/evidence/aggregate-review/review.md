# Proposed formal Round40 — own-author aggregate metadata review

本材料只做**两个作者scope的own-author metadata核**，并在独立projectOptions reviewer确认冻结后读取其终态。不构成独立source复核；[checks.json](/tmp/codeshell-audit-round40-aggregate-review/checks.json)的`files=[]`，本聚合0新增产品语义行、0产品源码字节读取、0当前source filesystem hash核对、0Git命令/写入。

三组输入共52份冻结文件（含3份收据）、49条自排除receipt records逐项匹配；9个report/source/receipt关键hash与Root/作者报告的freeze hash一致，file sets完整。未修改任何原始目录。未发现阻断拟议组合的metadata不一致。

## 组合分类与编号

[原future40项目选项作者](/tmp/codeshell-audit-round40-data-frontier/report.md)保持有限0 formal/0candidate/0new-related；[独立终态review](/tmp/codeshell-audit-round40-project-options-review/review.md)支持同一有界negative，未扩展到真实registry/path准入、后台identity/保存执行或所有UI。原stripMarkdown只作为已知R2-05、读正文前排除的作者metadata声明；本聚合没有读正文或另核产品字节。

[原future41 UTF8 source-refresh](/tmp/codeshell-audit-round41-utf8-source-refresh/report.md)只跟进旧UTF8-R34-C1：source-addressed at037/runtime not revalidated。它不是新bug ID、不是新related，也不是验证通过或清除旧candidate。拟议[candidate-source-updates.json](/tmp/codeshell-audit-round40-aggregate-review/candidate-source-updates.json)单列既有项的源层备注，明确不请求candidate状态变更、runtimeConfirmedFixed=false，最终阶段处理仍归Root。

Root计划把上述两个prep放入正式round40；prep编号41不等于须另建正式41包。原目录、原context、initial/finish时点、history排除及原文件字节应原样保留。本聚合不认证尚未建立的正式round40 branch/history/baseline，formalBaseline=null；Root后续正式化与当前metadata意见分开。

## Source范围与重叠只核清单

两个作者清单分别5个active source/test pin，均2full/3selected；作者声明385+815=1200观察行，10个不同产品路径。UTF8另有旧R34报告28行。projectOptions作者的385含2条导航；UTF8815为481产品+334测试。测试声明分别13处/14处，仅文本；没有当前或历史运行pass可累加。

独立projectOptions清单是5semantic、2full/3selected、297行=190产品+107测试，另2instruction pin；其中CODESHELL重复全文217行单列。其consumer/test少量早期导航的initialBeforeAnyContentReadSha256保留null，selected body另有读前pin；不是全源初读前pin。相关范围、总行数及full/selected标记内部一致。

[清单overlay](/tmp/codeshell-audit-round40-aggregate-review/source-range-overlay.json)显示，independent297中296行与作者385重叠；额外1行是pathMatch37的注释边界。projectOptions范围union386，两作者加peer的清单union1201，不能把297再作为全局新增语义方向加到1200。本聚合不因此声称新增阅读或扩大producer/identity合同。相同5个路径在作者/独立清单中的bytes/SHA相符，但本聚合未打开任何当前产品源做重复验证。

UTF8作者清单的5个product blob绑定与其保存的Git receipt一致。其scope内**实际7条Git只读命令/0写**：初始rev-parse、5个固定037 blob show、最终rev-parse；HEAD/main始末037c2afbb05f2fcb3b2f3f3588be2b4a980032a1，初始origin/main02d5d9。history扫描当时尚只做3条读，final receipt记录7条，属于保留的执行时序，非矛盾。本聚合只是核receipt事实，**没有执行这7条或新的Git命令**，也不据此认证未来正式baseline。

## Dated history、cap与drift

两作者各自保存的history都是3509 included files=1361MD+2148JSON、975542strings/1464542scalars、169 exact archive/_archive路径、0parse错误。projectOptions时点短context42683054、排mutable39/future40；UTF8时点实际037、排39/40/41，两者均纳冻结38，未倒填成已含冻结39的正式history。

projectOptions初始strip精确17contexts已读并排除；宽54contexts无cap保存但有截断，不能写全读。replacement24contexts+1direct object已完整读。UTF8 cap80、15/20/0命中均保留，35contexts完整读。独立review则cap160，6/7/1/24均未触cap，按完整相同text去重22contexts全读，另1个same-SHA metadata row。三种query/retention单位不同，不能合并为全部历史语义穷尽。

projectOptions原history canonical SHA579548d3…，UTF8为3a18bff9…；集合0增删，仅共享release-real-operations文档由189803B/c8cdef20…变为199956B/8c1b9ca1…。独立review初始已是后一版本，自己的included3509结束字节无变化。各自原row保留，不能修改parent时点或把这项dated文档漂移叫产品修复。独立175是archiv子串路径计数，作者169是exact archive/_archive目录口径，两者不可混用。

没有把dated28 hash/ranking当全文语义读或“此前未读”证据；命名文档显示此前关注，旧测试receipt只是导航metadata。UTF8 fix文件名/历史worktree名字/别线程pass不是当前运行验证，仍只保留作者实际静态source conclusion。

[validation.json](/tmp/codeshell-audit-round40-aggregate-review/validation.json)明确本聚合0产品/函数/fixture/import/测试、0连接/network/native/权限/身份/凭据动作，0产品源码与Git读取、0repo写入；只读冻结artifact并在本exact tmp写metadata。旧失败方向未重开；正式round40的Git/blob/history绑定与最终候选阶段由Root另做。收据自排除，所有future40/41原材料保持冻结。
