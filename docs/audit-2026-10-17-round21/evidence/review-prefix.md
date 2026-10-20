# 独立交叉复核：Root 普通 prefix mapping

Reviewer：`ndjson_input_round21`。冻结点 `615e4e4dd3a61b1ad132ab4f3683985a0d582386`。只读复核后，**未发现需要阻止汇总的证据或分类问题**；接受本分区 **0 确认 / 0 候选 / 0 related**。未修改作者报告/source/fixture/raw/exit/preflight，没有执行新产品测试或 Git 写入。

完整读 prefix report、metadata note、7-case fixture、first raw/exit/preflight、source manifest；实际读完整 `slug.ts`/35 行既有 tests，selected settings schema、worktree tool/query/crud consumer 段落，以及 round8/round13 的旧 baseline 段落。对 manifest 其余探索性 path 只做字节/pin 核验，不冒称逐行深读。

1. 唯一 fixture 只直接导入和调用 `normalizeWorktreeBranchPrefix`、`managedBranchPrefixes`，零 mocks/摘抄；leaf 零 runtime imports。输入都是短的普通有效标签，包含 omitted/undefined、slash 层级/trim、Unicode、default/custom namespace 与独立返回数组控制。normalize 会间接调用合法值 predicate，报告已披露；没有直接无效/攻击 validator 输入、isManaged、applyPrefix、ownership/cleanup/Host/native/Git 动作。Unicode 控制也没有被扩大为 Git ref/platform 可创建性结论。
2. First raw 的实际结果是 **7 pass / 17 expect / 0 fail / 0 skip，Completed**，与 exit0、attempts1/reruns0 和 report 一致。7 个都是 focused；5 个既有 slug tests 仅静态阅读，旧 round8/round13 各 8/17 baseline 如实承认，未恢复 parser/validator/gate 动态方向。Exit 收据声明 combined raw+exit 在检查前保存；本复核只能核验现存 bytes 与收据，未补造原收据没有的 `rawSha256` 字段。
3. 独立计算现存 raw 为 **757 bytes，SHA-256 `e720c874dac78b43f218db52b6c555f0494b186cf18da44ce53f3c4388257330`**。13 个 manifest path 的 current bytes、line count、SHA 与冻结 Git blob 全部一致；preflight 的 source/fixture 两个 bytes/SHA 也一致，fixture SHA 为 `a0c461f3a6cb64582c7acbe63692a506cc50fbfefeb62273c9c5037340a5dcb0`。这是只读 metadata 核验，未运行这些源码。
4. 普通 schema/default/prefix producer 与命名/分类 consumer 的实际 selected source 支持 report 的静态传递说明；这些模块未被 fixture 导入。字符串返回值控制没有证明工作树创建、归属或 cleanup 安全，报告没有作该扩大结论。
5. Dedup JSON 有 2,169 个 prior inventory 项；1,189 MD、980 JSON、288,528 string leaves / 404,370 scalar leaves、0 parse errors，与 report 一致。四类总命中 13/14/2,789/4；保存上下文 13/14/120/4，限额和宽泛 A03/A04 hash 噪声均披露。旧 baseline 的实际文本已另读；未把关键词导航当语义穷尽。
6. 14 个 report 本地链接均存在，声明的 colon line anchors 均在实际行数内。`root-metadata-notes.md` 如实记 normalize 17→16、managed 51→49 declaration anchor 修正；当前 anchors 与实际声明一致。该调整只涉及 Markdown，没有 fixture/raw/source 或重跑。

本复核不补证明完整 CLI/SDK/worktree/native/runtime、其他 Root 初始探索源码、全量历史语义覆盖或任何未运行方向。原有动态失败与 authority 等排除条件继续有效。
