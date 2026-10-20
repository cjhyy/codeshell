# 模型目录普通字段静态复核（预备164）

本包 **0 正式、0 候选、0 新 related**。有限复核未建立普通模型/连接字段的新反例；不是整个模型接入、凭证或持久化行为正确性结论。

Root 报告 owned HEAD `d195788bc2c18cd85c81aea4a431ab29074df5cf`，分支 `codex/audit/catalog-source-theme-round62-20261018`；本作者 Git 0，未独立认证提交绑定。仅写本 exact tmp，产品源码无写入。

1. `resolve.ts` 1–113、`gen-connections.ts` 1–43、`upsert.ts` 1–25 全文物理阅读；普通字段目的是精确 catalog/preset lookup、tag/id/model 投影与有序替换。实际 image/video 的 unified modelConnections 消费和模型覆盖顺序，以及 schema→save→upsert→catalog merge 为选段阅读，见 [精确范围与预读 pin](source-manifest.json)。共 490 产品语义行、126 既有测试声明行，显示 616 行；声明未执行。3 product full、5 product selected、2 test selected、2 instruction hash-only。导航命中行另列，不加作正文覆盖。
2. 普通字段反证：桥接保留连接 id/adapter/baseUrl，连接 model 优先于 catalog default；真实图像/视频入口继续使用 call model → instance default → kind default。upsert 精确 id/value 替换并复制数组，保存入口实际调用它，merge-mode 以 preset.value 更新。未建立正常 producer 要求相反优先级或丢字段的合同，不以任意重复/坏配置制造问题。详见 [分类与逐链依据](classification.json)。
3. 已亲读 R10 catalog.md 全35行和原清单 /files/3、/4、/7，三源同 SHA；原清单没有明确全文范围，不能仅以 pin 升格旧 full。R17 /sources/14 明确 resolve 80–113 selected 同 SHA；其 catalog.md 全43行与旧导航诊断31行已读。故保留旧静态重叠，不称首读/唯一新增覆盖。两旧 Panel default/trim 候选保持原分类，不重报、不计 related。R10 cache-refresh 猜 engine.ts 失败方向仍 SKIP，不恢复。
4. Root166 共享历史机器导航纳冻61、排62+，6484 MD/JSON、4,639,853 JSON value scalars、errors=[]，含 archive；resolve/gen/upsert 总命中157/130/125，各仅保存前100。这里保存 [目标投影](history-projection.json)，不复制整库存。机器命中、派生 coverage 和保存窗口不等于历史全读或根因查重穷尽。本作者实际原件阅读为4个 canonical JSON objects +119行旧 MD；见 [原对象](canonical-selected-objects.json) 与 [旧报告范围](prior-report-read-ranges.json)。
5. 未验证：真实 Settings/用户目录、锁/备份/atomic write 机制、凭证授权、provider 可用性、网络生成、GUI、跨进程生命周期和所有 accepted config。产品/helper/import/fixture/test/native/model/network 执行均0，无修复、无动态替代验证。

初始 pins 均在产品正文/行导航前持久化；ending 的12个源/指令 pins 与6份直接旧材料及共享batch均未变，见 [结束检查](ending-checks.json)。未重 hash 全6484历史文件。首次共享 schema 的 keys/counts peek 未先单独保存 raw stream，及封包外层引号错误 exit1 已如实记 [诊断](diagnostics.json)，后者在写入 finalizer/启动 child 前发生。随后 child 另有 pinAtUTC 字段名 KeyError，首脚本和 stdout/stderr/exit 保留；只适配原 pinAt 值，不倒填时间、不重复源阅读。各实际执行 audit child 的 stdout/stderr/exit 均先落盘后展示。导航投影首输出有主动24,000字符显示上限，完整 raw 已保存，不冒称300命中均已人工读完。当前源正文输出未截断，无产品执行失败。
