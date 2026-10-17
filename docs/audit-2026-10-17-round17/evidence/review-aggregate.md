# 第十七批汇总只读复核

复核者：`message_mappers_round17`。核对 README、四份分区报告、四份专项复核、机器汇总、FIRST raw/exit、fixture、source/worker/index 哈希、主分支变化与集成快照。仅新增本文件；**没有产品修改、测试/产品重跑、模块导入执行、浏览/部署、Git 写入或恢复任何已跳过方向**。

结论：接受当前 **1 项确认 P3（CHAT-R17-01）、3 项候选、0 项新增旧问题关联**。没有要求扩大结论或新增验证。全仓目标仍在继续，本批不是穷尽审查完成声明。

## 发现的证据边界

确认项限定为真实纯配置生成器拒绝普通显式 loopback HTTP `:80`。复核静态源 `ingress.ts:60–70`、CLI 的 `printIngress:213–231`、Chat README 364–370 与 config 的 webhook.port/readPort 片段：`--upstream` 原样进入 helper；文档允许 loopback host:port，配置静态允许 1–65,535。首轮 fixture 对三种支持主机的两种格式均捕获 `:80` 拒绝，同时相同主机的 `:8080` 六次调用正常；默认 upstream 与普通配置控制通过。生成器、文档合同和正常对照足够支持这个局部拒绝；没有执行 CLI、配置加载、listener、Caddy/Nginx 或网络，也没有写成运行中代理故障。

Catalog 的默认回退与 trim 两项保持 candidate：报告保留现有 invalid-default 测试的政策冲突、普通 UI 补默认、Task 服务也 trim 以及未执行 React/保存/schema/池/Host/worker 的缺口。Mapper 候选保持两个自造普通对象的实际 ID 表征，未证明同一真实在途工具的生产关联、跨 snapshot/live 合同或 reducer/UI 结果。三项均未定严重级别，没有把可能的完整任务失败、丢结果、挂错卡片或真实模型行为冒充已复现事实。

指纹分区为 0/0。六项实际 helper 测试和一项源码比较区分清楚：Desktop counterpart 没有 import 或编译执行，没有数学唯一、碰撞安全或真实去重/定时任务结果保证。四份专项复核均可追溯到作者的首轮证据；旧 parser/AskUser/reducer/UI/Host/Link/Chat delivery 路线作为排除，不增加 related 计数。

## 首轮计数与材料完整性

直接读取四份 combined raw 和对应 exit，核对每条 guarded 命令、raw SHA、exit 0、guard Completed / 0 skipped / 0 failures：

| 首轮分区 | pass | expect | 测试层级 |
| --- | ---: | ---: | --- |
| Fingerprint | 7 | 34 | 6 actual helper + 1 source comparison |
| Catalog | 12 | 36 | actual pure helpers |
| Mappers | 9 | 33 | actual pure mapper APIs |
| Frontier ingress | 3 | 22 | actual generator / in-memory URL objects |
| 合计 | **31** | **125** | **30 actual helper + 1 source comparison** |

四组均为本批 focused；0 existing baseline、0 failed shard、0 product rerun。characterization 通过不等于产品已修复。导航 glob/receipt 顺序、SyntaxWarning、scope 行号、复核通知地址等已分别标注为元数据或协作错误，没有伪装成 Bun failure，也没有替代动态恢复。

逐项重新核对全局 **59 个唯一 source/contract pin** 的冻结 Git blob、当前文件与记录的 main commit bytes/SHA/equality；**62 次 worker source checks** 均指向相同冻结 SHA。逐项重新读取 **38 份 worker artifacts**，SHA 全部匹配。whole-file hash 与 explicit selected/static/runtime scope 分开，不扩张为整文件、传递依赖或整个包覆盖。

当前 [evidence index](../evidence-index.json) 的 **68 个条目（自身除外）** bytes/SHA 全部匹配；复核时已有 Markdown 本地文件/数字行链接 **110 个，0 错误**。复核期间 root 新增的 integration-plan 已在磁盘出现，依照已说明的后生成流程尚未进入这份旧 index；这不是缺失证据或产品错误。本文件与 integration-plan 必须在 root 收尾时一起刷新进最终 index，并再次核对最终集合、Git staged blobs 与链接。此处不冒称后续提交/集成检查已经执行。

## 基线、旧状态与集成边界

唯一冻结/当前差异为 `packages/desktop/src/renderer/diff/parseUnifiedDiff.ts`，与 [addressed-sources](../addressed-sources.json) 的 R2-10 / DESKTOP-R12-R1 相符。它是其他任务的源码状态更新，`runtimeRetested: false`，不算本批 finding/candidate/related 或已验证修复；没有重跑旧 parser、新回归、Git fixture、Review UI 或 ApplyPatch summary。

main-refresh 的 8 个提交、10 个路径与 frozen/main 状态分开归档。初始与集成前 primary 快照除 HEAD 外字段完全一致，包含 tracked deletion 与 **4 个原有 untracked 文件**的 bytes/SHA；这证明两个保存时点的原内容保留，不代替 root 后续集成后的再次比对。新生成 integration-plan 与该刷新快照一致，产品变化/重跑为 0，目标继续，没有 push 请求。

历史去重统计为 prior docs/bugs **1,134 MD + 804 parsed JSON = 1,938 文件**、**239,449 string value leaves**；专项另统计 **335,081 scalar leaves**。JSON 解析错误为 0，匹配计数与上下文 cap 分开；不存在把关键词查重当作全语义穷尽或把旧测试当成本次测试的表述。

最终 docs-only commit 的 staged 路径、原始 raw、完整/非 raw whitespace 检查、主工作区快进前后原有字节和最终 owned worktree 状态仍由 root 的集成收据证明。本复核没有对未发生的最终集成作成功声明。
