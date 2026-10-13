# Quant Lab / Job Hunt HQ 离线业务正确性 review

基线：`/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps`，分支 `codex/panel-shared/review-remaining-20261012`，HEAD `aabba34ca94f7081fd7de4e20c52443f08f36d5e`。本报告只审查，不修改产品代码、不提交、不发布、不联系他人。

已读本仓库 `AGENTS.md`、`CODESHELL.md`、`CONTRIBUTING.md`，检查工作区为干净。测试使用 npm 仓库现有 Node 测试协议；此范围都是 JS/MJS，没有使用 Bun，也没有新增 TypeScript 测试。已读取 `tests/suites.mjs` 与 `scripts/run-typescript-tests.mjs` 确认目录和运行约定。

有 4 个高置信候选：3 个 P2、1 个 P3。没有宣称找到全部问题。下面的“测试通过”表示稳定观察到当前行为和正常对照，不表示已修复。

## QJ-01 / P2：既有交易账本写入回执丢失后，再次保存会重复记账

定位：

- [portfolio-store.mjs:144](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/quant-lab/app/portfolio-store.mjs:144)：`workspace.writeText` 拒绝就直接抛冲突，未读回核对这一次写入是否已经提交。
- [holdings-ui.mjs:1523](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/quant-lab/app/modules/holdings-ui.mjs:1523)：每次 `draftFromForm` 都生成新 transaction ID。
- [holdings-ui.mjs:1555](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/quant-lab/app/modules/holdings-ui.mjs:1555)：再次保存重新生成 draft，调用 append 没有传递界面原账本 `expectedFingerprint`。
- [holdings-ui.mjs:1615](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/quant-lab/app/modules/holdings-ui.mjs:1615)：失败只显示原错误并保留输入，finally 重新启用保存；没有落实 store error 的 `frozen` 状态。

触发：已经存在的 `portfolio/transactions.json`；保存一笔买入时 Host 已把完整权威账本写入，却因为传输/调用回执问题拒绝这次调用；用户看到失败后保留原表单，再点击保存。现有 Host 条件写入只防止并发覆盖；第二次 append 会读到已包含第一笔的最新账本，再追加新 ID 的同内容交易。

影响：实际只录入一次的 100 股变成 200 股，成本和现金等派生值随之错误。错误提示和可再次点击的原表单会引导用户重试。限定既有账本；第一次建账的重试会因 `initialLedger` 与已存在账本冲突停止，不属于本复现。

证据层级：实际导入 `portfolio-store.mjs`、`portfolio.mjs`；从基线文件原文提取实际 `draftFromForm` 与 `save`，在 VM 中运行，替换只涉及 Host、DOM 字段、行情读取和渲染。Host 是内存 map，第一次权威写入先落 map 再抛 `ack lost after commit`。没有完整浏览器或真实 Host/行情服务。

结果：第一次失败后，落盘 map 已有一笔 buy，但界面 ledger 仍无 buy，数量字段仍为 `100`、保存按钮恢复可用；第二次实际 save 产生 `tx-mv0snr40-1` / `tx-mv0snr40-2`，持仓数量 `200`。

控制：正常 ACK 的保存只记录一次并清空表单；真正写入前失败再试只有一笔；同样 ACK 丢失条件下，实际 `importPortfolioSnapshot` 的截图导入依靠稳定 importId，在重试时返回 `already-imported` 并保持一笔。这说明不是 fixture 统一制造的重复行为。

建议：保存时稳定保留本次 transaction ID/内容；不确定写入结果先只读核对，确认未提交再允许明确重试；把 `frozen`/不确定状态真正接入 UI，避免重新生成一次业务操作。

## QJ-02 / P2：简历保存读取期间切换项目，会吞掉切换错误并向新项目继续写文件

定位：

- [app.js:11885](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/app.js:11885)：开始时基于项目 A 的 resume 计算 Markdown / evidence 路径。
- [app.js:11893](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/app.js:11893)：首次 readText 的无条件 catch 把 `PROJECT_CHANGED` 当作文件不存在，继续操作。
- [app.js:11919](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/app.js:11919)：evidence 读取也有同类 catch。
- [app.js:2114](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/app.js:2114)：`hostCall` 只捕获每次调用的 epoch；旧 read 返回时正确抛出切换错误，但下一次调用会捕获新的 epoch。
- [app.js:17111](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/app.js:17111)：实际项目激活递增 epoch，并在 17131/17156 重置/恢复 state。

触发：A 中点击保存简历，读取旧同名输出文件尚未完成时切到 B；B 允许写入，且 A 推导的文件名在 B 中不存在。释放 A 的旧读取后，真实 hostCall 抛 `PROJECT_CHANGED`，被 saveResumeToRepo 的 catch 吞掉，随后继续使用 B 的全局 `state` 和当前 Host。

影响：B 中出现由 A 分类/岗位推导的文件名，内容却是 B 的正文和内部证据；仍提示“简历与证据账本已保存”。如果切换发生在第二个 read，A 的公开文件已经写入，B 中则单独出现 A 文件名的 evidence。新项目中已有同名文件时 create-only 条件可阻止覆盖，不能据此推断任何现有文件都会被覆盖。

证据层级：从生产文件原文提取实际 `hostCall`、`saveResumeToRepo`、`resumeMarkdownProjectPath` 与 `slugify`，VM 运行；fake Host 捕获调用项目和完整内容；UI/render/publication gate 为替身，测试输入假定已通过发布门槛。用实际项目激活对应的 epoch/state 切换语义，但没有启动完整 Panel 或 Electron。

结果：首次 read 切换的复现记录两次 project=B 写入：`job-hunt-resume-base-a-category.md` 内容 `B public resume`；同 stem 的 `.evidence.json` 中 `resumeVersionId=resume-B`。第二个 read 切换控制记录第一笔写入 A、第二笔写入 B。

控制：同项目、明确 ENOENT 时按预期生成 A 的正文和 A 的证据。两个切换位置分别复现，排除单一 await fixture 偶然性。

建议：整个保存动作捕获 `currentProject()` 并只走该 scope；只将明确的 ENOENT 当作缺失；保存开始时冻结同一 resume/publication/source 快照，在每个后续步骤前校验 scope。

## QJ-03 / P3：一次批量保存中的相同 JD 不去重

定位：[job-opportunities.mjs:89](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/job-opportunities.mjs:89)。每项仅匹配 `existingJobs`，新插入项只进 `inserted`，下一项没有看到本批已插入记录；136 行最终把全部 inserted 拼接进结果。实际 `upsertJobDiscovery` 对 formalJobs 与 leads 都使用这条逻辑。调用入口 [app.js:14309](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/app.js:14309)。

触发：同一次发现/保存返回两个相同 URL 或相同标准 metadata 的完整岗位（例如渠道结果重复），而之前没有该岗位。

影响：同一个机会留下不同稳定 ID 的两个岗位，新增数计两次，进展可分别编辑，也消耗有限容量。没有声称一定引发 QJ-04；这是独立的同批去重缺陷。

证据：直接导入实际 `upsertJobDiscovery`，实际生产 URL/metadata key 函数由原文提取；一批 `[id=one, id=two]` 且 URL 相同，结果 jobs=2、insertedJobs=2。正常对照把它们分两次保存，第二次结果只有 ID=one 的一份。

建议：每处理一条新项就纳入本批匹配索引，并合并信息强度；同批与跨批使用相同去重语义。

## QJ-04 / P2：新增第 81 个完整岗位时静默删除旧岗位的投递进展

定位：

- [app.js:14327](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/app.js:14327)：`save_job_opportunities` 直接 `routed.jobs.slice(0, 80)`。
- [job-opportunities.mjs:136](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/job-opportunities.mjs:136)：新的 inserted 位于原岗位前，超额时淘汰原数组末尾。
- [app.js:3918](/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/job-hunt-hq/app/app.js:3918)：定时发现收据导入也有同样截断（本轮只静态确认该第二入口，未独立执行其控制器）。

触发：已有 80 条完整岗位，原数组末尾包含已投递/正在沟通/面试中的岗位；再保存一个不同的新完整岗位。容量限制没有检查旧项状态、提示清理或保留归档。

影响：旧岗位及其 `application.nextAction/history` 从将要保存的项目快照消失，工具仍返回 `projectSaved:true`、新增成功。关联简历/题单等不会同步清理或迁移，出现 jobId 指向不再存在岗位；保留的原 JD Markdown 不能恢复只存在结构化快照里的投递备注。本复现没有声称删除所有历史备份或外部文件。

证据层级：实际 `save_job_opportunities` handler 和实际输入 normalizer 从原文提取；实际 `upsertJobDiscovery`、application normalization、snapshot compact 模块导入；Host/JD 文件写入、渲染和最终 snapshot 写入是内存替身，后者保存真实 handler 传来的全量 state compact 结果。没有真实 Agent 调用或真实项目文件。

结果：已有 80 条时新增一条，返回 totalJobs=80、inboxAdded=1、projectSaved=true；`old-79` 的已投递记录和专用备注从 state/snapshot 消失，variant resume 仍有 `jobId=old-79`。

控制：79+1 时旧投递进展保留；已有 80 条但只更新一个已存在岗位时也保留。不是 fixture 将所有保存统一截断。

建议：达到容量明确拒绝新增并要求用户归档/清理；或用显式可恢复的归档策略保留进展和引用。不能仅凭数组年龄丢掉招聘中的岗位。

## 覆盖地图及边界

| 模块/流程 | 本轮完成的审查/执行 | 边界 |
| --- | --- | --- |
| Quant ledger 解析、回放、货币/公司行为、收益计算 | 阅读 portfolio.mjs 核心解析/phase/replay/holdings/valueSeries/analyze；运行原16脚本中的 portfolio/portfolio-rules/portfolio-data golden、十进制/XIRR/HHI/attribution；新增保存 ACK 三路对照 | 计算 oracle 主要沿用既有 golden；未对真实市场数据或金融产品作验证，不提供投资建议 |
| Quant 手动交易保存/恢复 | 阅读 store 和 holdings-ui save/load/reset；实际 save/draftFromForm + store 内存故障实验 | 无真实界面点击、文件系统或 Host 断线；新建首笔与既有账本区分 |
| Quant 截图持仓导入 | 阅读 portfolio-import 全文件；运行现有 preview/commit/重复/fingerprint/epoch contract；新增 ACK 幂等对照 | 未做 OCR、真实截图或模型识别 |
| Quant 笔记、当日工作台、规则 | 阅读 notes-store；运行 notes/today/rules 脚本 | 新增回执实验没有扩展到所有笔记 UI |
| Quant 行情/历史/选股、来源、缓存 | 运行离线 data adapters、history、pulse、selection、source cache、progress、signal storage、watch/evidence 与 research bridge suites | 全部 fake fetch/provider；没有连接行情、付费、新闻或交易服务；Python bridge suite未运行 |
| Quant 项目 scope/自动化/报价队列 | 阅读 project-operation、panel scheduler、holding-quotes；运行 alerts/news/pulse project scope、unique/mutation、quote lifecycle、执行绑定以外的 controller suites | 未启动 process.spawn 原生行情运行器；未操作真实定时任务 |
| Job 草稿存储/备份/恢复 | 阅读 draft/browser/snapshot/storage models 与保存入口；运行11文件中的 draft/storage/backup/generation/restore/recovery tests | 未跑完整 draft-ui 浏览器套件；真实 Host/云端存储/跨浏览器不由内存测试推定 |
| Job 项目简历保存/版本/发布 | 阅读 saveResumeToRepo、版本编辑/归档/removal/export 函数及 resume-model API；新增同项目与两位置切换测试 | gate 与DOM为替身；未实际发布文件、打印PDF或验证所有长文/照片布局 |
| Job 岗位发现/导入/投递生命周期 | 阅读 application-model、job-removal、job-opportunities、actual save handler 与scheduled import；新增同批/跨批去重和容量边界测试 | 未连接招聘网站/账号/Agent；scheduled入口仅静态确认同截断；非所有状态转换穷举 |
| Job 面试长期题库/练习/评分 | 阅读 bank update/sync、score/progress/terminal gating、实际review handler、practice/generation/analytics API | 已排除“完成后已保存答案不能补评分”的旧README误报：validate.mjs:2020 有明确允许对照；未执行完整模拟面试UI/模型评分 |
| Job PDF/音频持久任务 | 运行 resume-pdf-tasks / interview-audio-tasks 的 start/find/get/list/cancel/recovery/input-hash/receipt tests；阅读两模块 | 无真实Chrome打印、麦克风、转写模型、真实服务商、凭据；两个native suites未运行 |
| Job 自动化 | 运行 discovery-automation fake Host suite并阅读完整模块 | 没有真实渠道验证、自动化调度或收费行为 |

没有执行浏览器/原生套件：Quant `execution-binding-ui.test.mjs`、`selection-signal-browser.test.mjs`，Job `draft-ui.test.mjs`、`interview-transcribe-native.test.mjs`、`resume-pdf-native.test.mjs`。没有使用真实账号/模型/服务、任何绕过/命令执行或漏洞利用实验。运行的现有 URL/config 拒绝用例只是纯逻辑 fixture，不访问目标。

## 命令、数量和证据索引

所有执行从维护中的 isolator 发起：

```sh
node /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/scripts/run-isolated-node-smoke.mjs /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/quant-job/codeshell-quant-job-baseline-runner.mjs
node /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/scripts/run-isolated-node-smoke.mjs /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/quant-job/codeshell-quant-job-review.test.mjs
```

isolator 在任何产品导入前隔离 HOME/env。baseline runner 的每个 Node child 使用 `--import /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/quant-job/codeshell-quant-job-deny-network.mjs`，也设置相同 NODE_OPTIONS 使后续子进程继承。自定义测试首个 import 是 guard，产品模块均在其后动态 import。guard 在导入前拒绝 fetch/http.request/https.request/net.connect/Socket.connect/dgram，并额外拒绝 tls.connect；没有放行任何外部或本地 HTTP origin。

- baseline：18 个 child 命令全部 exit 0。其中 Quant 16 个 standalone workflow 脚本；Quant 24 个 Node test 文件 **211 tests passed**；Job 11 个 Node test 文件 **79 tests passed**。16 standalone脚本没有统一assert计数，不能与Node tests重复计数。
- 自定义：1 文件 **10 tests / 48 assert 调用，全部通过**。最初证据夹具有一次等待第二个read的同步错误（9/10），随后改为显式deferred-ready屏障；未改产品逻辑，最终日志覆盖为10/10。补强 actual normalizer/key 后再跑仍10/10；报告只累计最终唯一用例。
- 合计：**36 个 Node test文件 / 300 tests**（35 baseline文件+1 custom），另16 standalone脚本。不是完整 `npm test -- --suite quant-lab/job-hunt-hq`；已明确省略含浏览器/原生服务的项。
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/quant-job/codeshell-quant-job-deny-network.mjs`：网络禁用 preload。
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/quant-job/codeshell-quant-job-baseline-runner.mjs`：准确的16脚本与35测试文件命令目录。
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/quant-job/codeshell-quant-job-baseline.log`：18条命令、exit与211/79测试收据。
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/quant-job/codeshell-quant-job-review.test.mjs`：生产函数原文提取、实际纯模块、owned内存Host、所有正常/故障夹具。
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/quant-job/codeshell-quant-job-review.log`：QJ-01/02/03/04结构化结果、10 tests/48 assertions。
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/quant-job.md`：本报告。

旧86去重：只读检查父任务指定的旧 `docs/review-2026-10-12/README.md`、`priority-and-coverage.md`。旧R22/R23是Host Panel注册/项目根判定，R31是Host原生进程退出；旧报告明确独立Panel业务不等于Host覆盖。旧R03虽同样涉及ACK概念，代码/触发/影响属于Web发消息意图，不是本轮Quant交易账本。未见四项候选的应用业务问题已列于旧86。

结束时 `git status --short` 为空。全部夹具和报告仅在 `/tmp`；产品文件保持原样。
