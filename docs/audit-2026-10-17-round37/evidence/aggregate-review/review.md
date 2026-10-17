# Round37 聚合与反证复核

支持 Root 将**同一个** `MARKETPLACE-LOCAL-R37-C1` 汇总为正式 **P3 `MARKETPLACE-R37-01`**。原作者0 formal/1 candidate/0 related和独立reviewer的P3 support意见保持原样；本review不新增finding ID或重复记录。证据足以静态确定条件式错分派，不要求运行安装/卸载来证明分支取值。

本次只读冻结audit材料，核hash/范围/收据，**新增产品语义读取0行，checks.files=[]**。源码事实归原作者、独立source reviewer与Root各自阅读；我没有第二次直接读产品源码，也未调用产品/helper、测试/fixture、语言表达式、目录exists/catalog/安装卸载、React/browser/native/HTTP/network/Git或权限/身份实验。读取源码文件bytes计算SHA及行界不等于语义阅读，更不是运行产品。见[读前artifact pins](initial-artifact-pins.json)与[checks](checks.json)。

普通链已由材料建立：safe-name和single-segment guard准入registry key `local`；正常marketplace注册/成功安装按`plugin@marketplace`记录cache路径；catalog按末尾`@`解析，summary透传marketplace；helper29–34把`local`当direct-local来源，PluginsTab149–152选择local IPC，再到只查direct `plugins/<name>`的callee。在没有同名direct目录的正常条件下，该入口在其missing-directory guard拒绝，未进入对应marketplace卸载。仅限这一路由；不声称实际操作、目录状态、删除/损坏，或所有卸载方式都失败。

已核材料中的普通反证未阻断结论。direct-local本来就需要`@local`分支，现有声明正支持其marker意图；CSMeta.source与installPath虽存在，材料明确这条catalog identity/helper判定不使用它们来区分来源。旧truthy/local与missing-null是本地origin误走marketplace的反方向；R52是cache版本目录local的无效更新；PROFILE-R5-01及Windows派生非法名称分别是其他key语法/消费者。不能简单撤回local分支作为修复。静态P3强度限于已准入普通producer及具体callee，不靠假DTO或资源/安全边缘输入。

62个冻结输入全部与读前pins相同，四份receipt分别核32/13/18/9条全部匹配；child13条及其收据已包含在主目录33文件中，不能再次相加。36个report链接有效。三组source-manifest 24/19/8 rows的SHA/bytes均与当前源文件相同，所有range合法且range union与各自行数一致；当前字节核对不替代Root的正式Git绑定。原作者1238行（20语义/4hash-only）、独立reviewer1505行（含独列导航）、Root694行分开保留，不加为“新增3437行”。同SHA旧全文及重复读取不变成新覆盖；child原238历史选读仍只归其selected-contexts，不扩大active source rows。

历史两份初始清单3216完全同path/bytes/SHA，1330MD/1886JSON、762312strings/1126584scalars，含冻34、排35–37。补扫同3216，仅release TODO从177252B/6d6d93…变成189803B/c8cdef…，新增/删除0；原3215unchanged+1changed与后补3216unchanged分别保存。谁合入该TODO属于Root报告的上下文，本review不查Git。主作者补扫9组55/8/13/2/0/68/4/32/5均低于400cap；本review读了artifact中的全部8个quoted contexts，未把它们或旧pass转成产品阅读/验证。只支持bounded去重，不认证绝对首报。Root拟补正式history纳入冻35/36，尚不在本review认证范围。

regex叙述有需要限定的元数据差异：[notes](metadata-review-notes.json)保留我首次把JSON显示转义误读为独立focused双转义、随后按字符码撤回的过程。实际独立focused的`\s/\b`均为单反斜杠，原0/0/15可按其实际查询有限使用。进一步检查主作者原child保存的patterns及scan-history.py18–22也都是单反斜杠，未复证其notes所称“原重复转义”；原件保持不改。所谓corrected scan在实际查询中加入backtick、扩大部分窗口等，可作为broadened/clarified补扫使用；不把6→8误称已证明某个escape故障。这个叙述差异不影响产品因果或P3意见。

五项原metadata exit2/1诊断均保留：错误.tsx locator、历史选段超EOF、dated release漂移断言、draft packaging断言、Root installedPlugins250–275超EOF265。实际触达范围和未触达范围不回填；Root首次断言未打印source body，修正后250–265才首次阅读。均非产品尝试/失败。我本次两次过宽元数据输出被截断亦只作导航，已用限定输出补核，不声称读到隐藏文本。所有边界及更正见notes；冻结收据见[receipt](reviewer-receipt.json)。
