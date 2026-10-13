# 第二十二轮最终整合语义核验

Completed；**新增验证执行0、产品/主报告/fixture修改0**。只读主审工作区 `docs/review-2026-10-12` 的README、flow-coverage、latest-baseline、progress、reproductions说明、Browser Stop专项/最终quality/contract/preflight/plan/core-gates/discovery、local6034预审，以及round22两个JSON收据；复用前一份独立动态质量复核，未再运行native、Bun、转译、prepare、Core、worker、浏览器、模型或网络。

## 最终结论

**未发现阻碍R81/P2收录的实质语义矛盾。** 当前正式81项=1P1/52P2/28P3；通用Bun仍两基线各81文件243测试，第二十二轮新增Bun文件/测试均0。R81是取消的重要执行边界，不是Core未停止、Chrome断线投影、lease回收本身或已提交动作回滚；正常/恢复、替身和平台范围在正式附录与最终质量复核中一致。

本轮核验时提出的历史时序、归档入口、可复跑路径与README旧阶段用词小修均已由root处理并核读，下面记录修后状态；没有未解决的实质问题。

## 数量与执行归属

已核 [round22-browser-stop-results.json](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/validation/round22-browser-stop-results.json)：finding为`R81/B22-1/P2`，common81/243、增量0/0、作者先前失败6次。三次standalone执行分别列为：

| 执行 | 基线 | Node手工断言 | Completed/close/HOME | 精确只读info重试 | mutation重试 |
| --- | --- | --- | --- | --- | --- |
| author-latest | a66f4ef2 | 66 | true/code0/removed | 0 | 0 |
| root-initial | 84740d56 | 66 | true/code0/removed | 2 | 0 |
| root-latest | a66f4ef2 | 66 | true/code0/removed | 1 | 0 |

三个执行的输入时序均为Core settled序号2→enable3→Input5/6/7→DOM hit1；晚approve均因原pending不存在而拒绝。不能相加成198项suite、三个完整产品E2E、Bun expect或新增Bun测试。six failed版本的prefix0/15/15/15/21/50只是诊断；没有与正式66重复计数。prepare-only0assert不算native完成。

三份最终source SHA一致：launcher `11bc7a9cf31d53a69c55191b89fe08d621e4857621175841bb13a446d97c320d`、Main `1f9213c591383ae16b4ac41adaabcce8be298fcf143503909eb067cc7dbaf26b`。metadata逐执行保留十二项产品manifest，既有最终quality已核实际源/日志，root又在两冻结基线独立运行；没有把源码同SHA替代执行。三次known Main/renderer各3个PID的absent收据共9个，不扩成全部Chromium helper进程树逐PID证明。

读到 [round22-report-audit.json](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/validation/round22-report-audit.json) SG07:34版本：81、1/52/28、1203个顶层本地链接、776个源码行号、errors空；两份completedCommonRuns仍81/243且tracked productDiff空。这是读取root已有机械收据，不是本审计重新执行QC或测试。round18/19/20/21历史执行与其当时数量分别保留，没有回写为当前总数。

## 正式行为、恢复与分级边界

[正式专项](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/browser-stop-round22.md)与[最终独立质量复核](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/browser-stop-quality-round22.md)都明确：真实Core Stop ACK后还等实际Engine abort/settle、busy=false、pending=0，并再次确认Input0/DOM hit0，才启用owned按钮；随后旧click提交实际Chromium Input。这与“先前已发出的输入晚完成”区别充分。UI自身先标stopped不能单独证明Core终结；本次实际等待Core终结，所以没有借UI乐观更新夸大时序。

真实disabled/visibility/两RAF等待来自正式Puppeteer driver，observational wrapper原样透传predicate/options与结果；不是人为挂起Host promise。默认ready期限12秒有界，适用条件是同节点在期限内启用；不存在永久后台执行或任何Stop都必然点击的推断。

正常控制分层正确：显式AbortSignal驱动阻止同类待发输入，仅证明driver可取消，不说产品已提供一键撤销；后续新的正式Core agent/run成功、hit2，仅证明目标/会话可继续，不是还原旧click；完成输入后的idle Stop不回滚hits2是正确行为。旧approve拒绝、旧modelCalls不增加，证明Core/审批身份保护正常，不推导旧模型续跑、跨会话执行、继任答案污染、永久不可恢复或文件/账号损失。

Main target跨turn保留、普通lease.release允许inflight结束不列缺陷；取消尚未发送的本次动作与关闭全部tab/撤销整个profile不同。正式建议保留session/request/generation身份、取消等待/队列并在input前重查；未建议用全局revoke破坏后续turn。R07/R08/R74/R80的根因及修复位置与R81独立，历史静态边界本来未计正式finding，因此不存在重复编号。

## 实际层与替身限制

正式报告、quality、flow与metadata一致注明actual Core/ChatManager/Engine、内存provider、正式ToolSearch→snapshot→click、真实preload/native IPC、提取未改的Main函数体、actualRuntime/adapter/Puppeteer和owned Chromium DOM。未加载完整产品Main/App/AgentBridge构造或真实stdio worker；provider不是外部LLM，BrowserHost工厂与stdio为owned适配。完整ChatView/Stop按钮与现代bound会话共享链只读源码衔接，不冒充完整Desktop UI、bound WorkspaceContext或Chrome扩展动态验证。

动态Session是真实保存的合法legacy/unbound Session、实际active-guest registry/profile解析和一致sessionDiskRoot；不是绕R79权威门禁。DEFAULT_POLICY及非敏感owned按钮前提保留，未外推支付、删除、凭据、外站或安全门禁绕过。Node/Chromium守卫在求值/加载前建立、watched attempt数组空，与OS全面隔离/all-native负测保持区别；maintained inspector本地控制不误称业务外联。退出与privateHOME回收有实际收据，启动期间必要Chromium helpers没有被写成“未创建任何子进程”。

## 历史文档、原始与便携归档

已核root修后的contract、core-gates、preflight、plan、discovery顶部历史banner：未验证/待收据指launch前或调试时状态，当前R81/P2与两基线Completed统一指向最终专项。本静态审计作者新增执行仍0，不因后续实验改为作者亲自运行。discovery当时`maxTurns=4足够`建议已注明最终正常对照需8；budget修正只避免fixture的max_turns正常结束断言失败，不伪造completion或增加动作。

preflight初始SHA4ef5/e57a的审查对象已指向真正`before-first-native/`源，保留17a/b985/11bc后续版本历史，不把最终1f92源误标成初次预审源。plan两个当前命令都从冻结repo根用完整`docs/review-2026-10-12/validation/browser-stop-round22/`便携路径；不再指向/覆写作者final-author。正式专项正文已改成作者本人只跑latest、初始结果由root独立Completed，末表分账与主报告一致。

作者成功的source/log/summary/cleanup/observations保存在`validation/original-browser-stop-round22/final-author`；root初始和latest分别在`validation/browser-stop-round22`、`validation/latest-a66f4ef2/browser-stop-round22`，最终quality的链接没有混用作者与root收据。六个failed目录全部保留，与成功计数隔离。

已读root [deduplicated-top-copies.json](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/validation/original-browser-stop-round22/deduplicated-top-copies.json)：17个顶层重复副本移除前对应retainedExactBytesAt与逐字SHA；failed版本文件夹、final-author及/tmp原件不删。该去重没有损失独立失败或最终成功收据，也不增加/合并执行次数。

## local6034与阶段状态

[Sidebar本地差异预审](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/sidebar-account-local-round22.md)只针对原工作区其他任务`6034df8a`的6-path变更，parent84740、与a66f隔离。它明确新增可信候选0、正式0、执行0；7个child场景仅源码审阅，没有取得新pass/Completed，不进81/243或两冻结产品结论。正式README/flow/progress/metadata同样单列local范围，原checkout未切换或修改。

progress SG07:31当前状态与末条R81确认吻合；06:47/06:51/07:07的“尚未native/未收录”是带时间的历史记录，后有明确完成节点，不需要篡改历史。11:00截止尚未到、继续目标与调度由root管理，本审计未调用相关状态工具。

## 本轮小修核验记录

已处理并核读：五份历史banner；preflight首次审稿SHA源归属；plan完整便携命令；discovery预算旧建议限定；正式专项作者与root执行时序。

初读README:314时，后续检查长段还写“第二十一轮补…当前通用81文件243测试、正式80=1P1/51P2/28P3”，而页首/末段及metadata已是正式81=1/52/28。root现已将该处改为“该阶段通用81文件243测试、正式80…”，本审计最后读取该句确认，阶段与现行数量不再混淆。属于历史措辞小修，不改变finding/native计数；主报告仍仅由root修改。

最终：**Completed；新增执行0；R81/P2证据、原始/便携归属与计数无实质冲突；不新增finding或suite计数。**
