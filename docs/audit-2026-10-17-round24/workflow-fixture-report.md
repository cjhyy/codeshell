# Workflow 与 packaged fixture 静态审查

冻结点 `c9056c8047a8e75ab2469e59bf1d3fedd9ad7272`。Root 本方向 **0 新正式、0 候选、0 新关联，0 产品/测试/import/CI 执行**。四个主目标全文静态共 1,143 行；其它消费者与帮助器为各自明确的 full/selected 范围。详见 [source manifest](evidence/root-source-manifest.json)。

[workflow](../../.github/workflows/desktop-ui-acceptance.yml#L1) 保持 dispatch 或专用分支触发、只读 repository 权限；web/native suite 条件、平台矩阵、依赖 build→Desktop build→predist→package 的顺序已静态核对。管道使用 pipefail；预期旧 reducer 负例单独捕获两个 PIPESTATUS，要求 Node=1/tee=0，再调用 verifier。这里仅核接线，不执行 workflow、动作版本查询、GitHub job、构建或浏览器，更不采用先前 CI 的结果为本批通过。

上传清单与脚本输出的字面路径只做范围核对；`if-no-files-found:error` 并不被解释为每一个模式都逐项存在。两个 tracked-source 检查步骤打印 status/diff/normalized hash，它们是诊断输出，不自行构成“每个产物保持原样”的断言。本批没有找到由这些诊断直接升级成功的普通错误链，也不因缺少更强未承诺功能就登记缺陷。

[packaged fixture](../../packages/desktop/scripts/packaged-pet-fixture.mjs#L1) 完整 493 行已读，初始 app inventory 在启动前保存；capture、preload、identity、worker evidence、canCleanup、verifyUnchanged 的连接分别核对，未执行这些 authority 路径。consumer 只读 UI/updater/Pet 的 selected close/settlement/final 段，区分静态 gate 与真实 OS、浏览器、进程/出生身份、签名、keychain 或安全边界证据。

[signal diagnostics](../../packages/desktop/scripts/packaged-signal-diagnostics.mjs#L1) 明确记录请求意图，上限 512 后标 truncated，并把原 callback 的返回或失败继续传出。它不证明 OS 实际送达或全局所有信号。对应 42 行 [现有测试](../../packages/desktop/scripts/packaged-signal-diagnostics.test.mjs#L1) 只有两个声明，本批未运行，不能写成两个通过项或一次 watchdog 实验。

## 源码限制与正常反证

[settlePackagedPet](../../packages/desktop/scripts/packaged-pet-shutdown.mjs#L3) 收集 primary/close/integrity 等错误，但 cleanup 是否获准由 caller 的 canCleanup 决定；不能仅凭 errors 非空就断言其合同必定要求保留所有失败 HOME。[既有第三个测试](../../packages/desktop/scripts/packaged-pet-shutdown.test.mjs#L62) 本身要求已确认退出时仍可尝试 cleanup，并保留 primary 与 cleanup failure 两个错误，这是静态设计反证，未执行。

UI caller 有若干最终零 native/model/worker 和 keychain 检查位于 settlement 后，[UI:422](../../packages/desktop/scripts/e2e-ui-packaged.mjs#L422) 起可见；updater 的相关 failure/close 检查则在其 canCleanup 内。这是当前 source ordering 的区别，不是一次新的真实失败/清理复现。未建立“任何 assertion 失败都必须保留所有 inner HOME”的通用合同，不将手工假设扩成新 bug、候选、安全影响或证据伪造。

Web 成功清除 HOME 后最终 report-write 的限制已由[既有发布父记录](../../docs/todo/release-real-operations-2026-10-16.md#L250)明确记载，本批不重报。该父记录中 64 Node、31 browser、13 UI 等均是历史结果及其边界；没有访问其私有日志、旧 HOME、真实 keychain 或重建场景。最终 inode 变化仍是父文档中的未分类事实，不能由静态阅读解释其 OS 原因。

[历史去重](evidence/root-dedup.json) 与 [shutdown 补充去重](evidence/root-shutdown-dedup.json) 读取 docs/bugs 的全部 MD 和递归 JSON 标量，含 archive/_archive、排除本批：**2,375 文件 = 1,223 MD + 1,152 JSON，370,703 strings / 523,455 scalars，0 parse error**。workflow/fixture/integrity 为 13/6/2 次，shutdown/UI 为 1/2 次，全部保存；较宽 retention 490 次只留前100，含普通文本和元数据噪声。具体去重与未升级理由见 [decisions](evidence/root-dedup-decisions.json)，不是语义穷尽证明。

## 初选 package 负提案与本批范围

上一批完成后收到的 [package 负提案](evidence/root-package-prep/proposal.json) 已按原字节保存。它的 15 manifests、17 tsconfigs、92 index 路径是库存；135 个 source/meta pin 的重核只是 [prep provenance](evidence/root-prep-current.json)，**不是本批新读了 135 份文件**。Root 只读提案和核 hash，保留 8 个材料及原收据；没有执行 build/install/typecheck/import 或用未构建 dist 缺失制造 bug，也没有恢复旧失败包边界方向。较早历史读数 2374/370701/523452 与本批扫描分时保存，不合成一次扫描。

本轮更深的目标来自 [round22 集成计划](../audit-2026-10-17-round22/evidence/integration-plan.json)：22 个并行提交的 20 个变化路径。其中 19 个脚本/workflow 在四方向全文静态共 7,776 行，release history 一条只选读，见 [target inventory](evidence/root-target-inventory.json)。full static 不证明全部依赖、所有 OS 分支或运行正确；其它分审和交叉 review 单独记录。没有产品改动、真实程序/测试/fixture/authority 实验或新外部事实假设；主审的 Git 写仅用于隔离审查记录和集成。

Root 初次材料汇总把发布文档读取命令的1156上界当成实际行号，遇到 metadata AssertionError；文件EOF为1155，源字节均相同，仅订正范围，0产品运行/重跑。见 [metadata notes](evidence/root-metadata-notes.json)。

结束刷新时 main 并行前进5个提交（含一个 merge）至 `e7543a56805d992dec936b9c8df07e4ce7e2a709`，7个变化路径；本批选定文件中 workflow 增9行、发布文档增125行。Root 只读了 workflow 完整差异及发布文档 diff 前115输出行，不把新增 Review/Keychain 诊断脚本当作已全文审查或已运行。全文7776行与作者 manifest 均绑定冻结点；最新 main 字节单独保留，不覆盖作者旧 hash 或声称新验收/修复。见 [main source review](evidence/main-source-review.json)。

提交前再次刷新：main 到 `70d2e3846ea48d0d797e51dbeac7026f563c76bb`，相对初始冻结累计7commits/7paths，workflow仍增9行、发布记录累计增214行。第二段发布diff仅前112输出行选读；另一个新变化是范围外的 Review 测试修订，只登记路径，不把历史 CI16/13项修正测试当本轮运行或再次确认缺陷。作者阅读范围、0执行与0问题分类不变。
