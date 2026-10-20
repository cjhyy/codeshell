# Prep73 TUI display / value leaf 历史全文门槛

结果：0 formal、0 candidates、0 related；两个允许目标均因明确同SHA旧全文，在本轮正文前排除。没有第三个换题，没有新增行为negative结论或源码语义覆盖。当前产品正文、producer/consumer、test声明均读取0；运行产品/helper/fixture/test/React/终端/native/模型/网络/Git均0。[decisions](decisions.json)、[validation](validation.json)

先核当前CODESHELL：17639字节、217行，SHA256 `56d9ffdd81b6f6f615ed7a7392ddfa60ec4338c0ccb88eef20c4b73ad8dad5a2`，与此前已读指引相同，只计重复hash而非新语义。Root给出的 `dc2b3d4c7b3650e36f27deda6f20c87712a8e684` 仅外部上下文，未自行用Git认证HEAD/main/clean。两个候选都在任何正文或源码行导航前pin。[initial pins](initial-pins.json)

| 允许目标 | 当前byte pin | canonical旧全文证据 | 决定 |
| --- | --- | --- | --- |
| `packages/tui/src/ui/components/model-display.ts` | 24行 / 1001B / `f55d2c41404c43abd91ee6c42cb61ce279007b399374f9dfdfe32c50b760d9cb` | R7 `evidence/tui-source-manifest.json /sources/12`的readScope=`full`；R13 `evidence/history-source-manifest.json /files/3`的scope为fully read | 正文前排除 |
| `packages/tui/src/cli/parse-int-option.ts` | 24行 / 1051B / `e6e08f76b8a05a876766e770f9882a44c17f7b41fd909767434c3a9388a5bdad` | R15 `evidence/root-source-manifest.json /files/2`的coverage为full read；R20 `evidence/positiveint-source-manifest.json /sources/0`明确full source和1–24 | fallback同样排除 |

这些原始对象各自带相同路径、匹配SHA和明确语义全文措辞；不是仅依据R28/R44派生index、unknown/no-row、文件名排名或body已显示推断full。R13/R15的旧helper/test执行措辞只作为历史原字段保留，未借其执行数/通过结论，也未恢复任何旧失败方向。[coverage gate metadata](coverage-gate-objects.json)

Fresh docs/bugs全MD文本及递归JSON scalar value gate含归档，纳冻结48、排任何日期audit round>=49；旧review文档的round数字不被误排。4492文件 = 1442MD + 3050JSON，220606193字节；1953735 JSON strings、2921270 scalars、0解析错误。175是路径含archiv，169是exact archive/_archive目录口径，两个口径不混用。遍历JSON keys不当作value匹配；机器遍历与计数不是语义读完全部历史。[history method/counts](history.json)

目标path31/SHA15/name54；fallback path40/SHA26/name88；普通合同词2，各组均低于cap120并保留全部命中。实际阅读范围是21个直接path+SHA对象的keys及coverage/scope/review/inspectionScope/readScope/ranges元数据，未展示其产品text字段，也不声称读完所有命中上下文、其父文档或正文。显式旧全文门槛成立后，不继续普通provider identity/credentials或CLI值转换消费者。

[source manifest](source-manifest.json)的4个row全为hash-only：两个指引重复hash、两个old-full排除pin；new full / selected / semantic / displayed source / test declaration均0。旧全文引用与本轮覆盖分栏，不以2次排除冒充2份新全文。只在exact临时目录写材料，没有读取真实配置。

结束4个pin的SHA均与初始相同；4492历史path集合与字节无added/removed/changed，initial/ending excluded均0，dated范围不倒填未来49。首个metadata错误、控制台截断、产品失败均0，原始rg库存与方法均保留。[ending checks](ending-checks.json)

最终artifact receipt逐项绑定本目录文件字节和SHA，自身除外；本包只用目录内链接，不要求外部别名。
