# Root171：正式62覆盖回填与本轮共享导航

原4643路径的相同9874源码SHA索引更新为 **368 full /377 selected /3898 unknown**，4275条尚不能标完整范围。这是已有正式62审查记录的metadata回填，不是本次新读4643源码、精确未读量、剩余bug数或当前未修复总数。

四个原canonical .files共36行，26条有效语义记录对应26路径、10条显式hash/instruction排除、0本次新deferred。22个unknown升级：8full、14selected；另4条既有状态仅补provenance。8full为model-catalog三叶、collection、theme conversion/URL/shared types和1份既有run-replay测试声明；full原用途/权限/机制/旧重叠限制随[完整原对象](canonical-rows.json)和[full用途](new-full-provenance.json)保留。235行既有测试声明不代表执行或通过。

只接纳原明确selected范围、同SHA/EOF、实际body/display/nav union支持，full还需单份明确whole1–EOF且无full veto；多份selected不相加成full。显式nav也不能凭出现就新增语义。接受原selectedLineRanges及一致的semanticReadLineRanges别名，规范allowlist保留sha256数字。原62/Root166 realpath7行措辞澄清和旧61 display越EOF由原[scope metadata](source-manifest.json)输入保留；本次0deferred不解除旧61那1条暂缓记录。

[适配器](migrate.py)首stdout/stderr/exit在查看前保存，exit0；[第二实现](verify.py)直接从原metadata重建4643状态和22变化，未调用适配器，exit0。这是Root两种方法的自检，非另一个peer或新增源码审查。[summary](summary.json)、[claims](accepted-claims.json)、[排除](excluded-deferred.json)、[transitions](transitions.json)、[更新索引](unified-current-index.json)、[verification](verification.json)。

4643源码只读raw bytes/hash/EOF，初末全同；8份metadata/instruction pins与11份query/instruction pins均未漂移，见[结束核对](ending-checks.json)。Git认证由Root集成另行完成，此包gitCertified=false、Git0、files=[]。四份manifest在本adapter之前有Root字段投影；持久化pins只声明beforeAdapterParse，未捏造先于所有早期peek。首次猜旧method文件名exit1保留[diagnostics](diagnostics.json)，没有运行旧方法、产品或测试。

共享机器导航纳冻62排63+：6669 MD/JSON、4882650递归JSON value scalars，含archive/hidden/unignored，parse errors=[]。9目标命中57/60/84、48/52/48、51/51/51均低cap100全保存；这不是全历史语义阅读或新颖性穷尽证明。Root只提供字节/query，168–170的实际产品阅读单独分账。[原batch](history-batch.json)、[首stdout](history-first.stdout)、[首exit](history-first-exit.json)。

产品语义阅读/产品import/helper/fixture/test/native/模型/网络均0；原4643分母与旧失败方法不改，原始epoch/source时点不倒填。本轮63源选段未并入此索引；非TS/TSX与完整行为/平台/运行验证不在分母，全仓目标保持active。
