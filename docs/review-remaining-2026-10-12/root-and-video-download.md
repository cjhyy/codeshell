# Pet、Optimization Lab、Arena、CDP、发行及 Video Download 补审

CodeShell 基线 `62a58ac8702835f848108e152234a6bdd6c3eb3f`；Panel Apps 基线 `aabba34ca94f7081fd7de4e20c52443f08f36d5e`。仅 review，未改产品代码、未发布、未运行真实模型或账号请求。

## 确认发现

### V1 / P2 — 视频查询启动回执丢失后清掉关联键，重试创建第二个仍运行的 AI 任务

位置：Panel `apps/video-download/app/video-search.js:730–731` 在 `agent.task.start` 拒绝后直接结束阶段；`:642–650` 清掉 `taskId`；`:824–828` 清掉恢复快照并显示普通错误。下一次 `awaitTask` 在 `:684` 生成新 key，而不是核对原 key。

触发：Host 已接受查询任务，但调用回执丢失或超时；用户在当前面板再点查询。真实浏览器运行打包后的原始 `mountVideoSearch`，替身 Host 先记录任务后抛出“回执丢失”。第一轮显示 error、taskId 为空、最后持久快照为 null；第二次查询用不同 key 创建任务，两份任务都仍 running，没有 list/get/cancel 来认领第一份。正常回执对照保持 planning，第二次查询被 busy 守卫拒绝，只有一份任务。

Host 静态衔接：`packages/server/src/panels/runtime.ts:409` 普通 bridge 调用有 60 秒超时；`agent-task-host.ts:476–490` 及 `agent-task-service.ts:223` 只按同 key 的活动任务去重。面板重新生成 key 无法使用该保护。面板重开时会扫描并取消一份活动查询，但当前页失败重试没有这个恢复步骤，且多份任务时不能由该逻辑推定全部清理。

影响：查询显示失败后实际任务仍可继续；重复点击可能再占模型请求、任务容量。没有运行真实模型，不声称实测扣费或真实网络丢包。独立于旧 R03 的 Web 聊天意图恢复，因为这里是 Panel 查询自身的 key/恢复状态管理。

证据：`validation/root/video-search-receipt.mjs` 与 `.log`。2 个正常/失败场景，实际 Chrome headless、全新临时 profile、真实模块和 DOM、内存 Host；Node imports 前 deny 网络，浏览器页面路由全部 abort，页面网络请求 0。通过维护中的 `run-isolated-node-smoke.mjs` 隔离 HOME。首轮因为隔离 HOME 找不到 Playwright 下载浏览器而失败，保留 `video-search-receipt-first-environment-failure.log`；随后使用本机已有 Chrome 可执行文件及全新临时 profile 完成，不下载浏览器或使用用户 profile。

建议：保留不确定启动的原 key，先按 key 查询或取消并确认；确认旧任务状态前不创建新 key。

### A1 / P3 — Arena git_show 把对象引用当成路径

位置：`packages/arena/src/context/context-tools.ts:226` 使用 `git show -- <ref>`。`--` 后的 `HEAD:example.txt` 被当作路径筛选，而不是 Git 对象引用。

在自建 Git 仓库中，直接 `git show HEAD:example.txt` 和实际 `read_file` 返回已有正文，实际 `executeContextTool(git_show)` 却返回 `Could not resolve: HEAD:example.txt`。1 个候选测试、3 个断言；与下面 O1 合计自定义 shard 2 pass、0 fail、7 expect。自有目录全部删除，没有操作项目 Git 历史。

Arena 为私有保留源码、当前 Host 不加载，故 P3；不能把该发现解释为当前 Desktop 聊天主流程失败。`phases/participant-research.ts:149` 是导出工具的静态消费者，未运行 Arena 模型回合。

证据：`validation/root/root-candidates.test.ts`、`root-candidates.log`。建议把已校验对象引用放到 `--` 前，并以对象读取对照验证。

### O1 / P3 — Optimization Lab 冷恢复前停止只记标志，终态仍变成 interrupted

位置：`packages/optimization-lab/src/controller.ts:785–795` 只在持久状态已经非 active 时写 cancelled。持久快照仍为 baselining、当前 Controller 没有 running 句柄时，stop 返回 baselining；随后 `get():643–659` 将其恢复为 interrupted，而不是已请求的 cancelled。

测试用实际 Controller/Store/Lease，构造已释放 lease 的基线运行快照，再新建 Controller。stop 返回 baselining、stopRequested=true；get 返回 interrupted；普通授权未运行实验 stop 对照返回 cancelled。没有 SDK 调用，requests=0。

可达边界：`queries.ts` 每个 worker/项目懒建 Controller，stop 直接调用此方法；Desktop `OptimizationLabPage.tsx:218–250` 缓存快照并每 1.2 秒轮询，worker 恢复后的第一次 status 之前点击 stop 可进入该状态。此 UI/worker 时序只有静态链，未运行真实 worker 崩溃。初次打开页面先 get 恢复会避开该窗口。停止标志仍持久保留，不声称停止失效、继续付费或数据丢失。默认关闭的私有功能，按窄窗口状态错误列 P3。

证据与 A1 共用自定义 shard。建议冷 stop 先按 lease/owner 状态恢复并完成终态，而非依赖下一次读请求修复。

## 实际覆盖

| 范围 | 本轮工作与证据 | 仍未执行的边界 |
| --- | --- | --- |
| Pet 委派、profile、projection、长任务 | 阅读 delegate-work/delegation/profile/gateway/context-recall/projection-extension/pending-decision-index、follow-ups、registered-follow-ups、run-params、bound-session-commands/host-actions；long-task 创建/转换/恢复的关键段；新增阅读 session-index、session-control、outbound-message、report-to-mimi、conversation-session-route 前半、im-session-list、session-visit-receipt、topic-segment/segment-closure、mobile-remote、migration-summary。之前疑似隐藏 pending 泄漏被 surfaceable 门禁反证排除。 | 长任务完整 1321 行及所有 disclosure 文件未逐行重审；Desktop 真实委派到模型、跨进程恢复和外部 IM 送达未执行。 |
| Optimization Lab | Controller 准备/授权/启动/停止/恢复/账本/报告主链，runner、store、lease、contracts、metered-fetch、模块/queries 与 Desktop 轮询控制；正常失败关闭和未知用量保护未发现新增缺陷。O1 为实际状态复现。 | 真实 provider、付费实验、真实 worker kill、磁盘故障/跨实例压力、所有采纳/撤销组合未执行。 |
| CDP 兼容包 | 维护中的 driver/keymap 单测；driver DOM/键盘/图片/导航/阅读游标/滚动观测与归一化实现、scroll-state/export/types 关键链。只读源码与真实接口替身控制未新增确认缺陷。 | 没有由此启动真实站点导航；不能代替 Desktop 所有浏览器后端、OS 输入和网络恢复验收。 |
| Arena | context tools、within-root、providers repo/git、participant research、capability/Host 启用边界、transition/usage 正常控制；A1 实证。 | 保留源码中的全部 planning/debate/adjudication/iterative phases、外部模型回合未完整重审。 |
| 根 scripts/打包 | 阅读 release、版本声明/验证、package-release-smoke、build-meta、guarded runners；安装后包合同成功：9 tarballs、47 typed entries、45 runtime imports，另验证 packed owner-auth HTTP 生命周期和 uploaded documents。 | 不运行 release --push、真实 npm 发布、自动更新/回滚、Windows/Linux 安装器。release helper 分支前置条件仅静态建议，未列确认 bug。 |
| Video Download | 全文或分段阅读 project-storage/project-binding/durable-downloads/download-library/library-process/video-search/video-search-archive；app.js 保存、队列启动停止、结果、项目变更、依赖刷新/初始化关键段；native download/search/library 的输入、流程、发布及取消关键段；147 项既有离线回归通过，V1 浏览器正常/失败控制。 | app.js 约 6600 行未逐行全审；真实 yt-dlp/FFmpeg 下载、Cookie/网站、依赖安装、真实付费查询未运行。固定 8 次 detail read 的潜在饥饿只记未实证，不列发现。 |
| Panel shared/build | shared/panel-select.js 全文及 CSS 合同；panel-projects/build-panels 发现、打包、库存、替换/安装依赖主链。5 项真实 headless select UI 测试通过；66 项 build 合同测试通过。 | 不把这些结果外推为所有独立 App UI、实际 Host 安装升级或系统辅助功能均已验收。 |

## 验证计数及限制

- `validation/root/control-shard.log`：29 文件、326 pass、0 fail、923 expect。包括 11 份 Pet 专项、CDP、Arena、Optimization Lab 纯合同/存储等。与后续 Pet 全包控制存在重复，不能相加当唯一测试总数。
- `validation/root/pet-full-controls.log`：Pet 当前 37 份既有单测全部执行，330 pass、0 fail/skip、1093 expect。deny-all preload 在产品 import 前安装；没有原生 subprocess/模型调用。这补的是既有行为控制，不能推出未手读文件的全部逻辑正确。
- `validation/root/root-candidates.log`：2 pass、0 fail、7 expect。
- `validation/root/video-download-controls.log`：10 文件、147 tests/pass、0 fail/skip。大部分为内存 Host/假 spawn、自有文件。library-native 的 CLI 子进程继承私有 HOME，仅处理 fixture 文件/输入；初次这批子进程没有继承 Node preload，不把父进程 guard 声称为所有子进程网络隔离证据。其执行内容静态限于本地检查，没有实际 opener/网站调用。
- `validation/root/panel-select-controls.log`：5 pass、0 fail；原测试没有改动，任务 preload 为 Chromium 指定已有 Chrome 可执行文件并对每个新 page 安装 abort-all 路由。
- `validation/root/panel-build-controls.log`：66 pass、0 fail，esbuild 产物只在测试自有临时目录，原 repo 源码和生成产物未修改。
- 清洁包门禁细节在 `validation/packaging/receipt.json` 和原始日志；第一次因本次 guard 未解开 Node normalized connect 参数数组而失败，修正的是任务 harness，随后完整重跑成功，首轮收据保留。

这些计数为测试执行结果，不是语句/分支覆盖率。新 fixture、报告、日志均属本任务，产品源码没有修复；真实设备、服务、付费模型验收仍有明确边界。
