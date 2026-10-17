# Prep107 — model trace history 普通查询 DTO

有限结果为 **0 新 formal / 0 candidate / 0 new-related**。所读普通查询校验、转交、页 DTO 消费与两个现有测试声明选段没有建立正常调用的新反例；这不是整个 adapter、Store、Host、UI 或仓库正确性认证。[分类](classification.json)记录反证和边界。

Root 提供 formal53 的产品 baseline `524c0827a480132119b637aa87e16f0eab9895f3`，仅作外部上下文，本读者没有执行 Git。文件名库存确认 `packages/server/src/model-trace-history.ts`，当前242行 / 9402 B / SHA `2bf60f9f830be0d04e9e96b20dfc86f7f24ed5a8d5d0f44e8c8115b2206c7dfb`；[初始 pins](initial-pins.json)先于正文与行导航。AGENTS5/CODESHELL217 的先前实际阅读按当前相同 SHA 沿用，重复 hash 不算新阅读。

正文前 fresh [完整历史库存](history.json)依 [metadata 方法](history-method.py)遍历 docs/bugs Markdown 正文及递归 JSON value scalar，包含 archive，纳正式52、排数字正式53+与自身未来目录。2026-10-17 17:48:37–48 UTC 得到 **5150份 = 1489 MD + 3661 JSON**，2430509 strings / 3611347 scalars / 1041471 objects / 87132 arrays；169 个精确 archive/_archive 目录成员，0 parse error。path/SHA/filename/old-cause 总命中 **92/53/125/82**，各 cap100，保留 **92/53/100/82** 个 [有界窗口](history-contexts.json)。机器遍历量和保存量不等于人逐字读完的范围。

[精确对象](coverage-gate-objects.json)共有95个 path/SHA 元数据对象。实际 gate 读了 R49/R50 两份 canonical 原报告及其原 selected row，原 R3 selected-chain 与 R18 adapter 的显示窗口，另看 compact 定位；没有声称语义读完95个 raw object 或全部窗口。[gate decision](gate-decision.json)保留 coverage/scope/purpose/readScope/reviewMode/inspectionScope/review 限定和 canonical 原行。R49 `/files/0` 同 SHA 明确只有78行普通语义，118–201 scope/visibility 未打开；R50 `/files/2` 同 SHA只有53行 selected。R3 的“选择性阅读结构”及 R18 的 Web adapter 审读不构成本目标 full。R28/R44 inventory、派生 claims、unknown/no-row/hash 既不证明全文，也不保证此前未读。

没有建立明确同 SHA whole-target 旧读，故本次只做有限 selected recheck，不用 fallback。尤其目标本次78行语义**完全重叠 R49**；HTTP普通映射、service调用边界和Desktop消费者也保留 R49/R50 旧选段重叠，不把它们再加为新唯一覆盖。本读者也是旧 R50 trace-query 包作者，角色如实披露。

普通合同与反证：

- 目标14–18/20–35/47–52/54–90规定查询 DTO 字段、record形状、limit1–200、boolean、有限非负时间、字符串长度/status与反向时间范围检查。正常 `false`、0时间值不会被 truthy 字段过滤丢掉；构建新 DTO 后203–206/214–218转交 Store，225–229映射 session cursor 错误。没有手造坏 DTO 或执行语言样例。
- HTTP20–22/24–38只核普通 query 值解码，73–74确认 list/sessions 调用边界；workspace23与70–71 resolveScopes只是相邻显示，没有审认证或 authority。Desktop service6–9/11–13确认 adapter 构造和 store 转交，目录选择/native作用停在边界。各 [support pin](support-initial-pins.json)早于其行导航或正文。
- 经实际 filename 确认并 [先 pin](consumer-initial-pins.json) 的 Desktop `activity/ModelTracesView.tsx`250–258请求 sessions limit50；299–306请求 list limit100并消费 items/nextCursor；372–382继续传回 cursor并合并页 DTO。没有展开合并 helper、异步 lifecycle 或渲染，也不把公共接口当作额外 Web UI 可达证据。
- HTTP现有测试264–288与352–369的43行仅声明 session grouping/filter、callType页与后继 cursor 的预期返回。两个声明只读选段，8个标题导航；fixture/setup、真实 HTTP、授权、Store FS 和所有测试均未运行。它们不是通过回执。

[所读清单](source-manifest.json)为 **5 selected / 0 full，176语义行 = 133产品 + 43测试声明**；跨文件累计唯一显示294行。目标显示158行，只有78行普通语义；get/config/Host/捕获设置等相邻显示只算导航，不因打印出来而扩成 full。HTTP/test 的 additionalNavigationSnippetLines 单列并纳显示 union；[摘录](source-excerpts.json)在实际显示之后捕获，只含已显示行，不冒充 pre-read snapshot。Store 的排序/cursor实现本次没有重新打开，不能把旧 R50 范围或旧 pass 借作当前运行验证。

首个非零是 filename navigation 的 rg exit2：命令含未先确认的 `packages/server/test` 与 `packages/server/tests`，原 stderr已被命令抑制；同次 source display 成功，不能据此虚构产品失败。随后一个错误 Desktop 路径探测返回 PATH_NOT_FOUND、未取得源 bytes；实际 filename定位后才 pin/read。首诊断见 [记录](first-diagnostic.json)。两次 metadata 长输出分别8262/4239 tokens发生截断，原工具 transcript 和 [diagnostics](diagnostics.json)保留，遗漏部分不宣称读完；没有产品失败重试或恢复旧 Codexparse/NDJSON/timer 方向。

[结束检查](ending-checks.json)的7个源码/指令 pins 全同 SHA；原5150历史集合在同 filter 下无新增、删除或 bytes 漂移。结束 hash 不算新语义阅读。[validation](validation.json)记录产品/helper/import/fixture/test/React/DOM/timer/模型/native/network/Git均0，真实trace/config/session/account内容未读。只运行独立标准库 metadata/hash/range脚本；[整理脚本](finalize-metadata.py)不导入产品。

workspace admission/visibility118–201、HTTP身份授权、真实连接/追踪文件、FS/锁/persist/prune、权限/custody与native机制均未认证；没有修产品。最终 [metadata检查](freeze-checks.json)及 [冻结回执](reviewer-receipt.json)绑定本包字节，有限0结果不代表全量无bug。
