# Web 浏览器验收 helper 静态复核

冻结点 `c9056c8047a8e75ab2469e59bf1d3fedd9ad7272`。本方向新增正式问题 0、候选 0、关联项 0。指定五个脚本共 1511 行已分块全文阅读；产品、现有测试、import、browser/native/process、网络、真实 HOME 与 authority 验证尝试均为 0。没有编写 fixture，没有运行旧验收。普通调用与失败判断来自源代码，不能当作本批实际成功收据。

## 普通调用与正常门禁

[prepareBrowserOperationCustody](../../packages/web/scripts/browser-operation-custody.mjs#L105) 是有文件、环境、进程与 watchdog 依赖的验收 helper，不能当纯叶子导入执行。本轮仅静态核对其默认配置和状态链：[SW driver](../../packages/web/scripts/test-service-worker-browser.mjs#L267) 与 [Auth driver](../../packages/web/scripts/test-auth-boundary-browser.mjs#L679) 先调用 executable resolver，随后把 executablePath 与 SHA 传入 custody，使用同步诊断 callback。

custody 从 prepared 到 launch、settle、cleanup 的失败记录保持首个 failure，诊断写入/异步 callback/截断另有失败门禁；最终 [settle](../../packages/web/scripts/browser-operation-custody.mjs#L373) 必须得到 cleaned、无 query/truncation/remaining 的 watcher 收据，并包含 captured root 的 PID/parent/birth，进程 close tuple 为 `{code:0,signal:null}`，root 未被 watchdog signal 后才可为 settled。[cleanupPrivateHome](../../packages/web/scripts/browser-operation-custody.mjs#L439) 另需 acceptancePassed===true、已 settle、没有失败/recordingFailed/truncated，才考虑移除自建目录。SW/Auth 消费者选段也在持久化日志/ledger 后给出各自 operations gate，再依据 cleanup 返回值决定结果。上述是源码反证，不是实际 PID、进程退出、信号、目录删除或 authority 正确性证明。

完整静态读 [custody test](../../packages/web/scripts/browser-operation-custody.test.mjs#L1)：它包含 owned stub、真实临时目录与 timer、首次启动/失败/清理/诊断等场景。也完整静态读 [resolver test](../../packages/web/scripts/service-worker-browser-executable.test.mjs#L1)，其中顶层即解析已安装 Playwright 元数据，并有真实文件操作。两份现有测试均未 import/执行，内容不能当本批通过。runner [run-isolated-node-smoke](../../scripts/run-isolated-node-smoke.mjs#L1) 全文与环境创建 [createBunTestEnvironment](../../scripts/bun-test-completion.mjs#L15) 选段只用于解释脚本要求；没有启动其进程、建立 HOME 或读取任何用户环境值。watchdog 仅选读接口/receipt/返回值，不继续审查其 OS snapshot、process-custody 或跨平台 authority。

[executable resolver](../../packages/web/scripts/service-worker-browser-executable.mjs#L28) 固定版本、registry/metadata SHA、revision 与支持的 platform/arch，区分 headless-shell、headful Chromium、Darwin 默认 Chrome 和明确 override。读取文件有大小/常规文件/前后 identity 与 SHA 检查；receipt 明确是路径及字节 pin，不是实际浏览器执行证明。此次没有解析已安装 SDK、读取实际浏览器二进制、探测系统安装位置、在异构 OS 上验证路径，或把计划结果当 native 验收。对其他版本/平台的拒绝是该固定合同，不凭未知版本或 OS 假设新增问题。

## 预期失败收据的证明范围

[verify-subagent-failure-home](../../packages/web/scripts/verify-subagent-failure-home.mjs#L11) 固定旧 reducer、八个 case 名与 2 pass / 6 fail 矩阵，要求失败名与非空 message、干净的 renderer/observer/deny/unexpected/signal ledger、正常 browser close、cleaned observed settlement、当前 source fingerprint，最后检查实际 private HOME/profile 保留并写新 verification receipt。[CI 选段](../../.github/workflows/desktop-ui-acceptance.yml#L101) 另要求该旧运行 Node=1、tee=0，再调用 verifier。没有将“预期失败 Node=1”计作普通八项成功，更没有实际检查这些历史临时目录或执行 verifier。

证据范围限制：verifier 按 case 的失败名/状态匹配，并未比较每个失败的专属语义原因。[场景 runCase](../../packages/web/scripts/test-subagent-state-browser.mjs#L469) 会把 action 内任意 Error 记在该 case，locator/poll 等 fixture 错误也可能成为同名失败。因此仅凭这份 verifier 成功可支持固定 case 矩阵失败且目录保留，不能单独证明六个失败分别由预期 reducer 根因造成。与负责场景的子审交叉核对后，这被保留为证据解释边界：当前目标是失败时保留证据，没有具体普通误判生产记录，不升级正式或候选，也不模拟替代失败/attack。

[历史验收父记录](../todo/release-real-operations-2026-10-16.md#L250) 已把旧真实 2 pass / 6 fail、失败 HOME 保留的 source-segment 实验、预期负例 CI、普通 31 browser behaviors，以及 64 项 Node fault/path/source 合同分别说明；它也明确“成功删除 HOME 后最后报告写失败无法恢复”的既知限制。此处不重报该限制、不恢复旧首次失败方向。历史 38 custody + 9 resolver 等 Node 结果既不是本批运行，也不证明当前所有 browser/authority 行为。原始父记录路径只作出处，未访问其中临时文件或账号。

## 去重与交付边界

[全历史扫描](evidence/browser-helpers-dedup.json) 递归读取 docs/bugs 全部 MD 与 JSON 标量，含 archive/_archive，排除本批：2375 文件（1223 MD、1152 JSON），370703 string leaves、523455 scalar leaves，0 parse error。精确 helper 命中 5 次，均为 round22 integration-plan 的外部变更路径，属于库存，不是已完成源码审查证据；receipt 宽搜 898 次仅保存前 100 context，有历史/通用噪声，不能宣称语义穷尽。相关父对象/父段另存 [history selection](evidence/browser-helpers-history-selected.json)，判断见 [dedup decisions](evidence/browser-helpers-dedup-decisions.json)。

初次合并大块 source 导航显示截断，随后五个目标均按实际行范围补读完；较宽文档搜索也未把未显示部分算作已读。没有产品/测试/依赖解析失败或修复重跑。[source manifest](evidence/browser-helpers-source-manifest.json) 区分五目标 full 与依赖/消费者 selected（runner 独立全文），逐项核 frozen/current 字节；hash 不代表跨文件语义全覆盖。此处没有引用上一批 135 个库存 pin 作为本批阅读。所有执行计数见 [validation](evidence/browser-helpers-validation.json)，材料 hash 见 [author receipt](evidence/browser-helpers-author-receipt.json)。
