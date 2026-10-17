# Prep117 — Host 请求普通范围的历史门槛

结果是 **0 新 formal / 0 candidate / 0 new-related**，理由为两个允许目标均在正文前建立同 SHA 的旧完整普通范围。本批没有新增产品正文或行导航阅读，没有重新验证任何请求路由，不把历史排除写成当前 Host 无 bug。[分类](classification.json)单独保留这一区别。

Root 提供正式53产品 baseline `16c1a40c7e3f0cf7701fccd723293bfb1291f105`，仅为外部上下文，本读者 Git0。实际 filename 库存确认 `packages/host/src/host-requests.ts`，151行 / 4880B / SHA `d3d96655a3f3877dedb9094f4ff8b5433ac750925dfbe4d4a5b00778e317be0d`；[初始 pin](initial-pins.json)先于正文与行导航。AGENTS5/CODESHELL217 的先前实际阅读在当前相同 SHA 下沿用，重复hash不算新指令阅读。

先做 fresh [历史库存](history.json)，按 [metadata 方法](history-method.py)遍历 docs/bugs 全部 Markdown 正文与递归 JSON value scalar，含archive，纳已冻53、排数字正式54+及自身未来目录。2026-10-17 18:06:43–54 UTC 快照为 **5311份 = 1500 MD + 3811 JSON**，2575070 strings / 3824469 scalars / 1106467 objects / 89689 arrays；169个精确 archive/_archive 目录成员，0parse错误。path/SHA/filename/old-cause 命中 **48/22/116/124**，各cap100，保留 **48/22/100/100** 个 [窗口](history-contexts.json)。这些机器数量不是人逐字阅读范围。

决定性证据来自 canonical 原作者记录，而不是派生 coverage index：R11 `evidence/host-source-manifest.json /files/2` 的 `frozenSha256` 与当前相同，`readScope` 明确为“full static data shape and mapping inventory only; authority/approval/security semantics excluded”。原 `host.md` 正文称读过全部非测试源码，末尾又明确 host-requests 只读普通数据形状与映射清单，未认证 authority/approval/security/auth/credential/custody/watchdog。原行和 MD 全文已实际核读，见 [gate证据与决策](gate-decision.json)。因此目标的普通合同范围在打开当前正文前排除；此证据不能扩为所有机制行为的完整审查。

R3旧pin只有path/hash，不能单独证明full。R28/R44 unknown/hash/incidental派生对象也不证明未读；本次 [45个精确对象](coverage-gate-objects.json)只用于定位原canonical范围。没有以no-row或派生claims重置已存在的阅读。本轮也没有从旧已读文件提出新具体反例，故不借“旧full不证明无bug”任意重开正文。

按授权只选一个 fallback：实际 filename 库存中的 `packages/host/src/runtime.ts`，117行 / 4014B / SHA `b785ab50fd5265ffb7f7d78c312f01b8c2ace165a5bcfdb6a25655b3e5dd3089`，先保存 [fallback pin](fallback-initial-pins.json)。其 [fresh fallback gate](fallback-history.json)按 [同一方法的独立查询](fallback-history-method.py)仍是同5311个原成员，18:07:25–37 UTC所有成员hash逐项相同，不与前一扫描相加。path/SHA/filename/old-cause命中 **72/38/277/232**，保留 **72/38/100/100**；[窗口](fallback-history-contexts.json)与 [60个精确对象](fallback-coverage-gate-objects.json)完整保存为机器元数据，未声称人语义读完。

R11同一canonical `/files/1` 的SHA与fallback当前相同，`readScope` 为“full; ordinary capability declarations and synchronous lifecycle; no request dispatch experiments”，与原MD完整非测试源码范围相符。实际核读这一原object后，fallback也在正文前排除。原限定没有被改写成执行过dispatch；没有第二个fallback或新产品方向。原R11还明确保留R3 HL-C1 caller-owned service引用候选，未找到普通后续突变producer；本批不造人为突变或重新实验该旧方向。

[本轮source manifest](source-manifest.json)因此 `files=[]`，两个产品文件只列hash-only排除；**fresh full0 / selected0 / semantic0 / display0 / source-nav0**，测试只有文件名库存，test正文/标题/执行均0。没有保存或生成source-excerpts，因为没有当前正文显示。旧作者的full和历史运行结果只用于范围去重，既不算本轮阅读，也不借作当前运行验证；不声称本轮已审完正常DTO→dispatcher→consumer链。

首次metadata组合输出 `e25db8` 为5166tokens，预算4500导致截断、exit0；[diagnostics](diagnostics.json)保留原工具chunk与边界，遗漏中部不宣称读完。后续对原canonical row和原MD的短读成功，不是产品失败重试；本批没有非零命令或缺失产品路径。完整raw工具transcript是原始凭据，没有伪造另一份完整stdout文件。

[结束检查](ending-checks.json)的两个产品与两个指令pins全同，原5311历史集合无新增、删除或字节漂移。重复hash不产生语义覆盖。[validation](validation.json)记录产品/helper/import/fixture/test/UI/React/timer/native/model/network/Git均0；没有调用Host、bridge、权限/身份/原生进程机制，没有真实配置/用户会话或业务数据操作，也没有修产品。独立 [整理脚本](finalize-metadata.py)只处理metadata。

[最后metadata核对](freeze-checks.json)与 [冻结receipt](reviewer-receipt.json)绑定本包字节。本结论仅说明已证实旧普通范围而避免重复阅读；当前路由正确性、完整Host机制和全仓剩余问题数量均不由本批认证。
