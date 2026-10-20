# 当前覆盖台账状态（保守迁移口径）

截至本次工作树字节，TS/TSX 路径 **4643** 个：有 **304 个明确完整阅读范围记录、168 个部分阅读记录、4171 个索引无法确认语义覆盖**。因此 **4339 个不能据这份台账标为完整范围**；这不是“从未阅读”或“还剩4339个文件要审”的精确计数，也不是未修 bug 数。完整记录仍受原阅读目的与机制边界限制，不表示所有合同、平台、运行行为已验证。

| 可复核阶段 | 完整范围记录 | 部分记录 | 无法确认 | 总数 |
| --- | ---: | ---: | ---: | ---: |
| 原冻结45的集合 | 304 | 169 | 4170 | 4643 |
| 原集合迁移当前相同SHA，撤销漂移绑定 | 304 | 168 | 4171 | 4643 |

恢复方法可行：[原47 method.py](#method)只读未执行；完整的 frozen51/current-inventory 加35条逐路径 status-transitions 恢复至冻结45，所有旧状态/SHA匹配、0 transition错误，并复现原summary。随后使用原相同 `rg --files --hidden` TS/TSX过滤，只读取bytes/SHA/splitlines，不解码或阅读产品正文。原45至当前8个TS/TSX路径SHA改变、0新增/删除；其中只有 MessageStream.tsx 原属部分记录，已撤销该1项，其余7项原本无法确认（含compress.ts及其test）。逐路径见[当前库存](current-source-inventory.json)、[重建与差集](base-reconstruction.json)、[保留的原范围/目的引用](frozen45-provenance.json)。

46–53增量本次 **尚未适配完成**，54排除。只定位并固定64份规范 source-manifest JSON、511个当前TS/TSX行；自有元数据hash字段normalizer去掉数字而allowlist仍带256，首次输出0/511是适配器逻辑缺陷，**不能解释成后续没有阅读或记录被语义拒绝**。[首诊断](metadata-diagnostics.json)保存原脚本和首次输出字节，原样标first；未执行第二次适配。活跃[increment状态](increment-summary.json)为 `DEFERRED_UNPARSED`、不发布合并数字，后续可单独继续。不强行处理MD-only、复杂ancestor限制、full显示/偶读、hash-only、旧full gate 或重复作者/reviewer记录。

<a id="method"></a>原method为 `docs/audit-2026-10-17-round47/evidence/coverage-adapter/method.py:1–298`，输入/输出均只读；未执行作者method或产品代码。原完整逐文件集合能够恢复，不需要重扫历史数百万scalar。分母包括tests/helpers和部分文档内TS证据，仅是原同过滤的TS/TSX宇宙；CSS、非TS和所有其他机制不在分母。MD-only与未回填46–53/54可能含更多实际阅读，不能从4171减去后续阅读行/文件数；同一路径、不同版本、选段重叠和正式化副本也不能简单相加。没有覆盖百分比、精确unread或当前unfixed断言。

Root给定当前字节基线0d2d5418…，此前读取上下文16c1a40…；本agent未查Git。Root随后通知正式54文档整合head00c04636…、产品同字节。[结束检查](checks.json)核4643个source hash与73个元数据输入全部未变；54即使已提交也未补入本次证据。发布集合见[统一当前索引](unified-current-index.json)，明确仅为旧45同SHA迁移；[source manifest](source-manifest.json)的产品语义files为空，Git/产品/helper/fixture/test/React/network/native执行均0。本包是用户状态核对，不是独立全仓复审；所有问题列表由Root正式问题清单另提供。
