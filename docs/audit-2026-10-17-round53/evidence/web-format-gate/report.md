# Web 格式化：读前同版本全文排除

本次 **0 正式 / 0 候选 / 0 新增关联**。两个允许目标均有明确同 SHA 的原始全文静态审查凭据，当前源码正文前排除；不再换第三个目标，没有重新验证普通消费者或宣称模块无缺陷。

- `packages/web/src/lib/format.ts`：140 行 / 5447 B，SHA `c1c2d582d623ba99a738b7d43c483358e6826cae24010ef7994b5d4708310f33`。原 R20 `evidence/root-source-manifest.json /files/10` 同对象明确 **Full static module**。保留“旧 project matching/i18n 失败预检方向不恢复、无 import”的限定。R49 既有 gate 是补充确认；R5/R8 此文件旧 full 的 SHA 不同，不能绑定当前版本。
- 唯一 fallback `packages/web/src/lib/userMessageDisplay.ts`：164 行 / 5926 B，SHA `628fb9130fccc1022c1448ccba8ed21fe145cfeb072167ab57f76411473a0391`。原 R5 `/sources/3` 明确 `review=whole-file`，原 R8 `/sources/7` 明确 `readScope=full`、同 SHA 和字节。更晚 hash-only/inventory 记录不会取消有效旧 full。旧 R14 错误相对 import 的失败动态方向继续 SKIP，未执行或恢复。

[原始对象与限定段](canonical-evidence.json)保留三份直接 canonical 对象及 25 行专门选读的历史 MD 元数据；其余命中展示只是定位/上下文，不折算成当前产品语义阅读。[源码清单](source-manifest.json)的 `files=[]`，产品 hash-only 两项，当前产品 semantic/display 均 0，测试声明 0；指令文件仅复核字节并复用先前同 SHA 阅读。

fresh [历史库存](history-inventory.json)含已冻结正式 52、排正式 53 及以后：**5150 = 1489 MD + 3661 JSON**；递归 JSON value 计 2430509 个字符串、3611347 个 scalar，键名不作 value 搜索。exact `archive` 路径段 162 份，substring `archive` 174 份，口径分别保留。path/SHA/叶名 gate 逐 MD 行及递归 JSON value 扫描；每查询保存前 100 个上下文和完整总数，不表示这些上下文均被人工全文读。format 命中 1760/712/1760，fallback 命中 211/56/854（path/SHA/叶名）；canonical 定向对象另提取，不受前 100 截断限制。unknown/no-row/hash-only 不是从未审查证明，也不更新全局覆盖计数。

[结束检查](ending-checks.json)核四项 source/instruction pin 和原 5150 份历史字节；原历史时点不倒填。首次直接打印 `rg` 文件名库存的展示被截断，退出 0，未保留原始 stdout 文件；[诊断](metadata-diagnostics.json)保存工具 chunk、上限和观察值，不伪造原始 raw。后续仅自有元数据读取、hash、JSON、范围与本包链接检查。

[validation](validation.json)中产品/helper/fixture/test/React/DOM/timer/native/model/network/Git 执行均 0。旧行为与运行结果不转移成此轮 pass；没有当前普通输入反例、实际消费者执行或整个 Web 正确性结论。冻结父上下文由 Root 给定为 `524c0827a480132119b637aa87e16f0eab9895f3`，本 agent 未查询 Git。
