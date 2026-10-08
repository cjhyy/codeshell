# 优化实验室 P1b：选定证据导入与固定候选试用

日期：2026-10-09。按用户继续完成优化实验室的交付要求实施。本阶段延续设置页入口、Desktop 专用与默认关闭的 `optimization_lab`；没有新增侧栏。本文及工程 fixture 不授权任何真实模型消费，也不声称作者已获得质量或成本收益。

## 选定运行证据

在实验室材料区填写从活动记录复制的运行 ID（每行一个，最多 20 条）。支持 managed run ID 与 `session:<sessionId>:<receiptEventId>` 持久运行回执。Desktop main 只定位这些来源，先核对来源当前持久记录的项目 realpath，再打开该来源的 trace；不调用个人全历史扫描，不读取附件或 artifact 路径。能力包没有会话目录读取权。

文件通过不跟随链接的有界 inode 读取，读取前后验证 inode、大小与修改时间。快照限 8 MiB，trace 取最多 8 MiB 的尾窗且丢弃不完整 JSONL 行；解析损坏、缺输入、窗口截断、最多 200 个事件或 50 个内容块的裁切均作为缺失/截断事实保留。每块最多 32 KiB UTF-8，整个 bundle 最多 2 MiB。正在变化的文件要求重新预览，不把读取竞争静默当完整证据。交错的其他提交文本不返回，无法精确归属的工具事件省略并注明缺失。

`EvidenceBundle` 固定版本、project key、导入时间、run/session/event IDs、内容类型、脱敏后 hash/字节数、原始块字节数、截断和脱敏规则记录、完整性缺失及 bundle hash。默认清除认证头、常见密钥、凭据字段、含凭据 URL、URL token 与 inline binary；这是启发式处理，不能保证发现自由文本中的全部密钥或个人信息，用户必须预览。Hash 检查能发现持久内容错配，不是外部来源签名或历史配置真实性证明。

预览完全在本地，不发送模型请求。确认 receipt 只在原顶层窗口、原可信项目和 10 分钟内有效；新预览会替换旧 receipt。原生确认后 Main 才把自己持有的准确 bundle 交给能力包持久化，renderer 不能提交任意 bundle 或调用隐藏导入 query。窗口/primary/trust/flag 变化后拒绝导入。

导入案例默认 `real`、`analysis_only`，输入取已脱敏的原用户文本；历史输出、工具资料与纠正保存在本地 bundle 供复核，历史输出不会成为 `expected`。缺输入时明确显示不可用。当前 `state.model`、诊断 `contentRecorded:false` 或缺失 messages 不能升级成历史请求快照。所有旧记录目前仅作为 `problem_source_only`，历史配置统一标为 unavailable。

用户须确认当前任务输入、获准资料、独立预期/评分条件，处理缺失项后才可手动设为 runnable。导入 metadata 留在样本 JSON 和 hash 中；准备实验时校验对应本地 bundle、project、run、block hashes 与同源组。一个 session 的导入样本保持同一同源组，不能重标组 ID 绕过 dev/holdout 隔离。将样本 JSON 搬到没有该 bundle 的机器时拒绝准备，不能凭手填 hash 宣称已经导入。

## 固定候选试用

已有持久报告的实验显示候选正文、解释与准确候选 hash。点击试用后创建新的 `fixed_candidate_trial_v1` 计划，绑定来源 experiment/plan/report hashes、完整候选 artifact/body hash、源 Skill revision，以及原目标 connection/model/config。源 Skill 或目标配置漂移时要求新实验；凭据轮换仍沿用已有身份比较规则。

新题集、评分器、输出/请求/执行时间限额、重复次数和最终验收预留全部进入新 plan hash，须重新通过现有 Desktop 原生预算授权。试用只按冻结正文比较原版/候选，复用现有单写者租约、账本预留、HTTP 请求准入、人工评分检查点、停止/撤销、未知用量和崩溃恢复；不调用 optimizer，也不生成或改写候选。授权或准备本身不开始付费调用。

来源报告及祖先（最多 32 层）中已经出现的同源组或相同输入若再次进入新保留集，会列入 `revealedHoldoutCaseIds`，报告保持独立证据不足/inconclusive。这个确定性检查不证明用户改写后的内容真正独立；报告仍保留小样本、文本片段、模型别名和环境限制。

试用不写 `SKILL.md`、Memory、dream 或普通会话 binding，报告始终 `adoptionEligible:false`。P2 的隔离 Agent 运行、真实 Skill 加载、正式采用与回滚仍单独实施。

## 无付费验收

- 能力包/Host/renderer fixtures 覆盖脱敏、hash 篡改、项目越权、symlink、尾部截断、缺历史配置/metadata-only、交错提交隔离、预览取消/失效、同源组约束，以及新授权和固定正文/模型绑定。
- 固定试用 fixture 覆盖零 optimizer 调用、原版/候选配对、两个人工评分检查点、已揭示保留集结论降级、来源候选错误、父 revision/目标配置冲突和生效 Skill 不变。
- 生产 Electron + preload + Main + 真实 worker + localhost HTTP 的验收脚本 `packages/desktop/scripts/e2e-optimization-lab.mjs` 新增证据预览/取消/确认导入及固定候选新授权/12 次比较调用；保留原有报告重开、原生评分文件、撤销、在途停止和 worker/app 崩溃恢复。

运行结果和最终 CI 见对应 PR。所有模型返回来自明确标记的本机确定性 HTTP fixture；没有三方真实账号或真实模型收益验收。
