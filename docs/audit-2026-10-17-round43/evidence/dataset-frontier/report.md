# Future46 dataset editor 静态前置

结论为 **0新增正式问题 / 0候选 / 0新增 related**。本次完整阅读普通数据转换 leaf `packages/desktop/src/renderer/optimization-lab/dataset-editor.ts`（251行），并核对实际 DatasetEditor/Page 数据调用与必要测试声明。这个有限负结论不覆盖整个 Lab、训练/模型流程、完整 UI 或运行时。

这是未来批次的 prep，Root 当时报告正式40已冻结、41仍 pending；本作者没有读取 Git 版本，不认证未来正式批次或 baseline。原时点和文件 SHA 保存在 [source manifest](source-manifest.json)，之后由 Root 绑定版本。本次只写当前 exact tmp 目录，不修改源码或仓库文档。

## 普通合同与反证

- `dataset-editor.ts:8–16,79–161` 明确只检查表单可编辑形状，worker 继续负责有效性。JSON 原对象被返回，缺省数组/expected 不会在解析时注入；不支持的字段、错误形状、过大集合返回失败。`DatasetEditor.tsx:213–218,288–327` 使用失败结果退回原始 JSON 文本；模式按钮仅改 mode，没有 emit。实际表单编辑才 spread 更新并 serialize，不能把“接受尚未有效的草稿”报告成 worker 有效性问题。
- `:167–229` 新建 ID 从当前集合避重；复制 structuredClone 原病例，只更换病例 ID，保留 sourceGroupId/split；rubric 和 assertion 共享既有 criterion ID 池。`:241–250` 按 split/readiness 计算数量和独立来源组数，未把复制病例计成新来源组。`DatasetEditor.tsx:398–404,650–655` 的复制/添加都在200例上限禁用。
- `:231–238` 只在用户明确切换断言类型时转换标量。纯 helper 现有7个测试声明包含缺省字段、原样保存未知数据、标量/path、复制独立数组和类型转换；selected interaction 中另读5个完整声明及前一测试尾部。它们只提供意图反证，**全部未执行**。
- 真实入口是 `OptimizationLabPage.tsx:77–79,121–125,586–590`：draft 文本传入 DatasetEditor，onChange 更新文本、清除旧 validation 并更新草稿。Page 的导出回调只读至边界，未调用。`contracts/dataset.ts:43–181` 提供 worker 校验结果、duplicate input/source group/criterion 与 runnable 检查的静态反证；未审其后存储实现，也未调用任何 schema/Buffer/worker/API。

## 阅读与历史边界

[source manifest](source-manifest.json) 记录6个语义源：2全文、4选段，**1025语义行=742产品+283测试**。这是明确范围的合计；额外 grep 导航发生过截断，不宣称所有匹配行都读完，也不拿导航当全文。26个其他产品路径只有库存/哈希，2个 instruction 哈希另列。初始 pin 均在对应正文显示之前；选段文本快照是在显示之后捕获，时间没有倒填；确切 source display tool chunk 已列出，未单独采集的 wall-clock 诚实为 null。 [finish hashes](finish-hash-checks.json) 核32个产品路径均与首次 pin 相同。

先做 [全历史 gate](history.json)：docs/bugs 下3696份 MD/JSON（1379 MD、2317 JSON），包括169个 archive/_archive 精确路径组件的归档，JSON递归值1130742 strings/1704078 scalars，0解析失败；纳已冻结40，排除当前 mutable41及未来42–46。inventory canonical SHA `47ef0e5ccf80391d9c3203990262ad79c4dafa1dba05e383572c1674ae916cb1`。每次补充按同一3696 inventory复查，0 dated drift。

最初 toolDisplay/cron/budget/notes/orphan/agentGroup 候选，以及 Root 建议的 browser diagnostic/chat data 批次，都在读产品正文前由原 scope/review/full 或旧根因排除。尤其 R4 `review:"full"` 与 R13报告完整阅读的原始证据，优先于 R28 pin-only 分类。小文件和其他 parked 候选不算新增语义覆盖，详见 [selection/history decisions](history-decisions.json)。不把整个 repo 的旧库存当全文覆盖，也不声称“无历史匹配就是从未读”。

选中的 dataset-editor 当前 path/SHA 精确 gate 仅4条路径/库存记录；[active semantic gate](active-history.json) 的 exact leaf/contract13、普通保留合同3条已完整显示阅读。另21个旧Lab边界 contexts 只读 compact identity/scope 前缀；不把全量 retained raw 等同全读。旧 LAB-R3-01 反思取首条反馈根因与 Arena 失败 fixture 仍排除，既不新编号也不重启失败方向。历史中的旧测试回执不用于证明当前行为。

完整初次扫描和各次选择补充的 total/retained/cap 均原样保留。初次 toolDisplay161、cron259输出截断；第三轮 index.ts basename 过宽4696/cap100，均已记录，不冒称全部语义读完。最终 active exact/preservation16 contexts 无截断。此前库存中猜测的 OptimizationLabWorkspace.tsx 不存在，随后定位真实 Page；只是导航假设，不是产品执行失败。

[分类](classification.json)、[验证边界](validation.json)、[source excerpts](source-excerpts.txt) 和 [artifact receipt](artifact-receipt.json) 可复查。**0产品/函数/import/parser/schema/fixture/测试/React/browser/模型/网络/native/Git操作**；只做标准库文件、哈希、JSON与正则元数据工作，没有动态复验或行为观察。
