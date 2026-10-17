# Web格式化范围：读前历史全文排除

本轮 **0正式 / 0候选 / 0新增关联**，两个允许目标均在产品正文前按同版本canonical全文凭据排除；没有换第三个方向，也没有重新审查普通consumer或宣称模块无bug。

- `packages/web/src/lib/format.ts` 当前140行/5447B，SHA c1c2d582d623ba99a738b7d43c483358e6826cae24010ef7994b5d4708310f33。R20 `evidence/root-source-manifest.json` 的 `/files/10` 同SHA明确“Full static module”；保留原“旧project matching/i18n动态预检未恢复、无import”限制。不是借旧失败方向恢复运行。
- 允许的fallback `packages/server/src/mobile-remote/mobile-history.ts` 当前41行/1458B，SHA258e0810ddb54c9fb4d39f6d8bcd4140bd874b8795229047b69f1b54c6ed9b04。R23 `room-data-source-manifest.json /files/1`同SHA coverage=full、1–41；Root `/files/12`另有Full initial static。旧字段“zero-runtime-import leaf”只是旧作者语境，本轮没有执行它。

[canonical原object](canonical-coverage-objects.json)保存四份精确元数据对象及历史库存读前pin，其中R5 format whole-file是不同旧SHA，仅作反证，不能单独绑定当前；更晚hash-only/inventory/rank也不抹去有效旧full。不把unknown/no-row/rank视为从未阅读。产品当前仅hash/行数，body语义与显示均0，测试声明0；源码[manifest](source-manifest.json)的files=[]、hashOnlyFiles=2，instruction全文222行另列。

先读当前CODESHELL217行和AGENTS5行，SHA分别56d9ffdd…、29806470…；[初始pin](initial-pins.json)在任何产品正文前完成。Parent报告dc2b3d4…为正式48上下文，Git0，不冒充独立版本认证。

[fresh history](history.json)于2026-10-17 16:16:16–20 UTC纳冻结48、排49+：4492=1442MD+3050JSON，1953735个string values、2921270个scalar values，169 archive/_archive路径，0parse错误。全递归值机器扫描不是全文语义阅读。[原方法](history-method.py)只搜值、不搜JSON key；path/basename命中format1732、fallback124，SHA393/32，cap100保存100/100/100/32个有限窗口。这些窗口本轮未人工逐读。900个显式对象字段是机器提取，不是900次语义审查；实际只读[10条direct-manifest简表](coverage-gate-selected.json)及上述4个原object，未做历史根因语义穷尽。[窗口原件](history-contexts.json)保留，不以cap阴性判断无旧因。

[结束哈希](ending-checks.json)逐个复核两产品、两instruction及原4492历史成员；[验证口径](validation.json)明确产品/helper/import、测试/fixture、React/clock、真实历史文件、模型/native/业务网络和Git均0。无本轮metadata错误或输出截断。canonical凭据只表示原目的下已有同SHA静态全文记录，不能当运行通过或所有行为正确。冻结见[receipt](reviewer-receipt.json)。
