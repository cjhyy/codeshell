# Catalog 独立只读复核

复核者：`frontier_round17`。冻结基线 `d86db33012dffd5d1849e76b869fa15eb260324f`。仅静态读 report、fixture、FIRST raw/exit、候选/validation/source/receipt 及关键合同/消费者选段；零新增 runtime、测试、产品或 Git 修改。

结论：保留 **0 formal / 2 candidates / 0 related**，没有要求修改。现有证据支持两个纯数据表征，报告恰当保留政策与完整消费者验证缺口。

- 首次 raw 明确为 **12 pass / 36 expect / 0 fail / 0 skipped / Completed**，exit 0；fixture 12 个测试全部 focused。exit receipt 的 raw byte 数 1,792 和 SHA 与磁盘原件一致。没有将 characterization 通过写成修复验证。
- 实际产品边界为绝对路径导入 `agent-task-models.ts` 以及只含 type imports 的 `textConnections.ts`、`catalogEditor.ts`；共执行目录函数、`buildInstance`、`catalogModelOptions`、`validateEntry`。fixture 的 provider endpoint 只是自有普通内存字段，没有连接它；无 React/IPC/schema.safeParse、Core pool/Engine、CLI、Host 或 worker 执行。
- C1 的实际 leaf 在缺失/失效 text default 时没有 `defaultModel`，精确 default 控制正常。`docs/panel-apps.md:373–377` effective default 合同、Engine/runtime/CLI 的首条回退与 Host 的 model gate 都是静态消费者依据；现有 Desktop 测试明确要求 invalid default 省略、普通 UI add 会补 default，足以要求维持 candidate。没有证据可把完整任务失败写成已执行事实。
- C2 的普通 id/preset 生产证据来自真实纯 UI helpers；真实 React 编辑器、schema/save、池条目、任务选择仍是静态链。带空格 id 改写、相异 id 折叠和 preset label 回退是同一个 trim 根因，正确合为一项候选。任务服务也 trim model 输入的政策歧义已披露；未声称真实 provider 接受有空格模型值。
- 三个 product leaf 的实际 import 边界、报告关键 source 行与上述普通 producer/合同相符。25 个 source pin 的 frozen Git bytes/current 文件/SHA 全部一致；pin 的 selected coverage 与 runtime/static 分开，未把 pin 当完整文件/传递覆盖证明。
- artifact receipt 中 **12** 个文件逐项读取并核 SHA，全部匹配（receipt 自身排除）。报告 **39** 个本地链接均指向现存文件。findings 是空数组，candidates 长度 2，validation 的 12/36 与首次 raw 一致。
- 历史去重按 1,134 MD / 804 parsed JSON、239,449 string / 335,081 scalar leaves 分开记录，0 parse errors；保留上下文 cap 与总匹配数分开，未宣称语义穷尽。
- metadata 导航 glob 首败及 receipt 前向链接组装诊断已有明确转录；后者外层 shell exit 0 来自后续独立库存命令，不被误写成 Python 检查成功。两者未计 Bun failure，也没有产品重跑。

复核材料：`catalog.md`、全部 `catalog-*` 收据/说明与关键 frozen source 选段。此复核不重新运行作者测试；所有动态计数均来自作者保存的首次证据。
