# Browser helper 独立静态交叉审查

冻结点 `c9056c8047a8e75ab2469e59bf1d3fedd9ad7272`。结论：**0 formal / 0 candidate / 0 related 的判断可接受，无需修改作者材料**。本 reviewer 只有仓库源码/文档/JSON/hash/readonly Git blob 检查，产品/import/测试/browser/process/native/HOME/网络/模型/authority 实验均为 0，没有 fixture、mock、模拟 attack、旧失败方向恢复或 Git 写入；仅新增本 review。

独立核对作者 **11 个 artifact hashes** 全匹配；**14 个 source pins** 的当前字节、冻结 Git blob、bytes、lineCount 全匹配，所有 selected ranges 合法。前五目标行数分别 468/475/199/226/143，独立求和 **1511**，与 targetFullFiles=5/targetFullLines=1511 一致。报告 **20 个本地链接**存在，`#L` 均在行数内；10 份 browser-helpers JSON 解析通过。分类 0/0/0，validation runs=[]，产品/测试/import/constructor/pass/fail/expect/existing/focused 全为 0，没有 raw/exit 被虚构为本轮运行。hash 核验不等于 reviewer 对所有文件全文语义审阅。

本 reviewer 全文静态阅读 custody、resolver、failure verifier，并选读两份现有 test 的依赖/cleanup/诊断/metadata 部分、SW/Auth setup/final gate、subagent runCase、watchdog 接口、runner、历史父段与 workflow 选段。现有 tests 确有真实临时文件、timer、stub，以及 resolver test 的顶层已安装 Playwright metadata resolution；阅读源码不能当作通过。本 review 没有解析已安装 SDK、读浏览器二进制、访问历史 profile/收据临时路径或启动任何 wrapper。

Custody 的普通状态/错误接线与报告吻合：初始/launch checkpoint 的 recording failure 可挡后续阶段；首个 failure 保留，diagnostic throw/异步 callback/截断另有失败位；settle 组合关闭、watcher receipt、close tuple 和 root signal 检查；cleanup 还要求 acceptancePassed=true、settled、无 failure/recordingFailed/truncated。SW/Auth 普通消费者选段在 ledger/log 持久化及自身 operations gate 后调用 cleanup，并用 cleanup 结果决定最终状态，因此没有从单个“cleaned”或“code0”字段直接推断验收通过。

需要保持的精确边界是：helper 消费层检查 settlement 里有 captured child PID、当前 parent PID 和**非空 birth 字符串**，fresh/full-birth authority 由既有 watchdog 构造及其 receipt 合同负责；这不是本 reviewer 独立完成的 OS identity/所有后代/信号正确性证明。作者已经明确不宣称 authority 验证，本 review 不把这些 source guards 或 test stub 的 `owned-full-birth` 字面量扩大为实际证明。

Resolver 的版本/registry/metadata SHA/revision/platform/headless 分支来自明确固定合同。默认 Darwin Chrome、明确 override 与 cache/headless-shell 分支分别记录选择，regular file pin 的身份/大小/前后 hash 检查仅为源码数据流。没有证据要求在未知版本/平台静默回退，故不能把固定拒绝当 bug；也没有实际 OS/browser/SDK 结果可用于宣称当前可运行。

Expected-negative verifier 的限制已被正确降级：实际 source 固定 reducer/hash、8 case 名与 2 passed/6 failed、失败名及非空 message，附带 clean ledgers/正常 browser exit/source fingerprints/实际目录保留检查；workflow 明确要求 Node=1 且 tee=0。subagent runCase 会把 action 内任意 Error 放到该 case，因此 verifier 单独成功**不证明每个失败的专属 reducer 语义原因**。当前这个 helper 的可确认目标是预期失败矩阵和 failure HOME/profile 留存，作者没有提供普通实际误判或把任意手工失败升级为新问题；保持为证据解释边界合适。本 review 没有运行 verifier、构造替代失败或检查实际保留目录。

“成功移除 HOME 后最后报告写失败无法恢复”已在近期父记录及 custody receipt boundary 明示，作者排除为旧限制，没有重报或声称修复。历史 old reducer 2/6、31 browser behaviors、64 Node contracts（含 38 custody/9 resolver）在报告中明确分开，均未计为本批动态通过，也未把 source-segment 清理证明称为完整浏览器验收。

全历史扫描的 2375 文件/370703 string leaves/523455 scalar leaves、0 parse error，以及 exact5/receipt898 的 match/cap 区分与决策一致；exact 命中只是旧 integration inventory，不代表旧审查覆盖或新颖性证明。宽 receipt 搜索的噪声与 100 context cap 已披露。当前无须追加测试、扩大 authority 源码范围或变更分类。
