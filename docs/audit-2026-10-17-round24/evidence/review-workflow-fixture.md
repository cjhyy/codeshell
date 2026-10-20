# Root workflow / fixture 独立静态交叉审查

冻结点 `c9056c8047a8e75ab2469e59bf1d3fedd9ad7272`。结论：**维持 0 formal / 0 candidate / 0 related，无需额外作者修订**。本 reviewer 仅检查仓库源代码、元数据、hash 与 readonly Git blob；没有产品/import/constructor/fixture/测试/CI/browser/native/process/模型/网络/authority 实验或 Git 写入，仅新增本 review。没有把现有测试声明、历史通过、手工假设或包库存变成当前运行证据。

首次独立核查发生于 owned checkout HEAD 仍为冻结点时：**13 个 Root source pins** 的冻结/当前字节、bytes、lineCount 及 selected ranges 全部匹配；前四主目标 580+493+28+42 = **1143 行**。19 个本批目标独立计数合为 **7776 行**，四份作者 manifest 均对对应目标声明 full static，没有缺失项；release history 另为 selected。这只是作者跨方向静态阅读范围与字节库存的核对，不是 reviewer 已全文审完全部 19 个文件、全部依赖或当前所有 OS 分支，更不是 7776 行动态验证。

package prep 的 **135 个 pins** 已逐项比对其保存的 SHA、冻结 Git blob/当时当前字节，及 root-prep-current 中 135 个相同路径检查；均匹配。它们明确为 inventory/hash-only provenance，sourceReadByRoot=false，不增加本批 full-read 数。原 receipt 列出的 **8 个材料 copy** 的 bytes/hash 也逐个匹配；第九个原 receipt copy 作为 Root 作者材料被绑定。reviewer 没有访问或执行原 `/tmp` 材料，只读仓内副本；原 receipt 内 `/tmp` 路径保留为出处。较早 2374/370701/523452 与新扫描 2375/370703/523455 是分时库存，没有合成一次结果。

清理合同挑战成立：完整 static `settlePackagedPet` 会累计 primary/close/integrity/cleanup 错误，是否尝试 cleanup 由 caller canCleanup 决定，不直接以 errors.length 授权。现有第三个测试在 :62 明确传 primary assertion，仍要求 cleanup 被尝试并保留 primary+remove 两个错误；此测试只被阅读，未执行。它是当前 generic helper 允许该语义的直接设计反证，不能从“errors 非空”推导必须保留所有失败 HOME 的通用合同。

UI :422 起的 native/model/worker 与 keychain 最终检查确在 settlement 后；updater 将相应检查放在 canCleanup，两个 consumer 的顺序不同。静态顺序值得披露，但 generic helper 本身保留错误并使最终结果 failed，没有普通错误被改成成功的源码证据。未建立统一 all-retention 合同或具体普通失败场景时，不应把手工构想、已有 Web 的特定保留约定或 OS 结果猜测移植成新的 UI/Pet bug。报告准确保留这一边界，没有声称相同源顺序已被动态验证、已修复或无风险。

signal diagnostics 的 28 行实现只记录 **请求意图**：记录在调用原 signalProcess 前发生，512 后仅标 truncated，仍继续 delegation，原返回值或 throw 传出。两个 existing test 的同 callback / 超限 assertions 不代表本轮通过或实际 OS 信号送达。它不创建 cleanup authority；报告把 watchdog 的判断、请求 ledger 与 OS-wide signal audit 区分开，未作过度证明。

workflow selected 触发/条件/构建顺序/pipefail/预期负例及上传清单接线与叙述一致。tracked-source 的 status/diff/hash 打印是诊断，而非每项产物不变的 assert；upload 的 if-no-files-found:error 也不能据此当作每个 pattern 均单独存在的证明。报告没有基于缺少未承诺的更强 gate 就制造 defect，也没有拿前批 64 Node / 31 browser / 13 UI 或作者所谓验收数量替代当前执行。历史最终 report-write / HOME removal 限制与未分类 inode 事实没有被重报或解释成新 OS 根因。

最终材料核验使用 Root 最新报告，SHA256 为 `487830d75073c8a11e03c0d76fdc6d6532a0be81d9b9b61f671e169e7235e073`：**22 个作者 artifact hashes 全通过，18 个报告本地链接存在且 #L 合法**，包含修正后的 :62 / :422 anchors。分类数组为空；root receipt 产品尝试/测试=0，prep dynamicAttempts=0，没有产品 raw/exit。Root 元数据 EOF1156>1155 的 AssertionError 在 notes 中明确是汇总范围错误，修正到实际 EOF1155，源/fixture 未变、产品运行/重跑仍为 0。最新报告已将“Git 写”限定为隔离审查记录/集成，避免与主审工作流相矛盾。

审查期间 Root 将 owned branch FF 到 `e7543a56805d992dec936b9c8df07e4ce7e2a709`。**此前 13 pins current=frozen 的结果只绑定 FF 前时点，不保证 FF 后当前仍冻结**。最新报告及独立 aggregate metadata `main-source-review.json` 披露：并行 5 commits（含 merge）/7 paths，选定的 workflow 与 release doc 分别 +9 / +125；只读 workflow 完整 patch、doc diff 前115输出行，其余5脚本没有成为已审目标或新运行。reviewer 另核两份变动文件的 frozen hash/bytes 与旧冻结一致，FF 后当前字节与 metadata 所列 main hash/bytes/新 main Git blob 一致；这是预期并行变更，不是材料篡改或要求产品重跑的理由。

`main-source-review.json` 是 aggregate metadata，**不在 Root 22 个 author artifacts 内**。最终 aggregate 应分别保留 frozen/current/main SHA；本 review 不更改原作者冻结 manifest、时点声明或阅读行数，也不把新 9 行/125 行算成旧 7776 行的全文审查或新验收。没有必要为这些静态边界追加测试、stub、native 或 authority 实验。

Reviewer 读取时一次合并多段源码的工具显示被截断，未把未显示的 packaged fixture 中段或上传清单当全文新阅读，随后有界补读 canCleanup/verifyUnchanged、第三测试和最新报告。初次查询发现 Root 使用 root-artifact-receipt 而非统一命名的 author-receipt/validation，按实际 schema 检查，未将不存在的统一文件假设当缺失产品证据。以上仅是静态导航/显示范围说明，没有作者改动或产品失败。
