# inspectionScope 覆盖元数据适配

这是审计元数据盲区修正，**不是产品bug或新增正式项**。旧49/51/56和Root目录均未修改，产品正文、helper/import、测试/fixture/UI/native/network/Git运行均0。当前基线ec1f6ae458d3646d07db20e876a2b9ce8c9939b9来自Root通知，没有独立Git认证。

仅适配结构化inspectionScope中的明确句首整文件标签（包括R13的entire file），同时保留原purpose、同object唯一source path/唯一current SHA、范围、否定/selected/navigation/hash/引用/机制边界和歧义veto。[方法说明](method.md)与[可重用metadata脚本](method.py)保留旧classifier对照；不因任意原文中出现full/entire就升级。

| 对照阶段 | 源路径 | full claim | selected且无full | unknown |
| --- | ---: | ---: | ---: | ---: |
| 旧49 dated原方法，精确复现 | 4642 | 292 | 154 | 4196 |
| 51/当前SHA，原49方法 | 4643 | 288 | 150 | 4205 |
| 同旧历史，仅增加字段适配 | 4643 | 298 | 150 | 4195 |
| 再纳冻结43/44记录 | 4643 | 301 | 161 | 4181 |
| 再纳冻结45记录 | 4643 | 304 | 169 | 4170 |

字段适配本身新增识别10个full路径；14个positive object对应12个不同路径，另2个路径已有其它full记录，不重复增加。6个limited/行号描述不升级full。R13 search-source-manifest.json /files/8的SessionSearchModal保留原句“entire file; query producer/error consumer static only”，不变成所有行为验证。 [字段delta](field-adapter-delta.json)保存全部20个inspectionScope对象的最小字段、document SHA与pointer；原执行/测试/失败SKIP措辞仍是旧作者语境，没有本轮复验。

[SHA单独对照](sha-validity-comparison.json)中，旧49到当前有9处SHA变化、1个新增路径，其中8处旧语义claim失效（4full+4selected）。此项不是字段适配，也没有恢复旧版本full。当前4643路径和SHA全部与51相同，[current delta](current-source-delta.json)为空差集；本轮只hash字节，不重复复制相同inventory。43/44及45只是后续冻结证据记录，包括同次阅读的正式化/作者与reviewer重复记录，不代表新做了对应数量审查。

[35个状态转移](status-transitions.json)逐path/current SHA区分字段新增识别、后来43/44记录、45记录；每个变化可回溯至少一个精确object。canonical证据优先于.first快照，历史first记录不被当作另一份新阅读。 [summary](summary.json)记录完整统计，[checks](checks.json)从51+转移独立重建304/169/4170，旧49和51集合对照diff均0。full/selected只是精确SHA下保守metadata类别；4170不表示未读、剩余工作或bug数，不报告审查百分比。

[fresh inventory](history-inventory.json)纳冻45、排46–57：4162=1416MD+2746JSON，机器计数748751objects、75979arrays、2534677value scalars、1676345string leaves。旧claims12MB仅标准库parse/递归机器计数，不提取新证据、不复制原表；机器处理不等于语义阅读。MD-only完整证据没有自动穷尽。与旧49只有release TODO MD字节漂移；本轮fresh到ending无历史变化。 [初始input pins](initial-input-pins.json)全11件结束同SHA，当前4643源和4162历史ending全部一致。source语义manifest见[files为空的记录](source-manifest.json)。

首次method因非法变量名在scan前SyntaxError exit1，原[脚本](method.first.py)/[输出](method.first.exit.json)保留；首次实际scan又被真实R13正例校准发现hash alias未按field_label去数字归一化，造成不应有veto，scan1完整原件保留、不是active计数。修正alias及dated universe后，scan2计数正确但代表pointer先指向.first，随后仅调整canonical引用偏好、计数不变。 [更正记录](metadata-corrections.json)分清这些metadata过程，没有产品/fixture失败或运行重试。冻结清单见[receipt](reviewer-receipt.json)。
