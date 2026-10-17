独立静态复核支持同一个 Root MCP args roundtrip 线索；**不另发ID，不额外计数**。范围为普通 settings-owned stdio 的 full editor。没有找到能阻止这条普通输入链的反证；不推断实际MCP连接或命令执行后果。

真实表单链路完整：McpSection556的Add打开new editor，699–714对new/edit使用full模式并传回当前server；1465–1482的受控Args输入接收普通quoted非空参数。splitArgs1870–1893支持引号包住空格；1122重开却以空格join数组，未重新引用token。静态手工推导示例为 `--label "alpha beta"` → 首次保存数组 `['--label', 'alpha beta']` → 重开文本 `--label alpha beta` → 再保存数组 `['--label', 'alpha', 'beta']`。示例只写成证据文本，未执行JS/Python模拟、splitArgs或任何产品fixture。

检查的反证均未成立：otherNames1207–1210排除自己的原name；正常editor未保存 /无OAuth忙操作时，submit1301–1338不检查dirty，1746的Save也仅因busy/saving禁用。1384对stdio总从当前args字符串重新split。saveEdit418–449将next交给buildMcpSettingsPatch，再更新本地servers；patch59复制新数组，不恢复旧token边界。user scoped wrapper → preload978–979 → main6707–6712 → settings writer151–156已静态闭合；普通JSON guard不拒绝非空含空格string参数，deepMerge181–215对数组直接替换，JSON写出不补回引号分组。没有实际写设置。

边界同样明确：plugin override1354–1374不写args，HTTP分支也不使用这条stdio参数路径；它们不包含在本问题中。这里只支持参数数组边界变化的静态合同，不宣称server启动失败、宿主MCP结果、权限问题或其他数据损坏。未扩展到空quoted token、反斜杠转义或未闭合引号。原源行的whitespace regex另按codepoints核为 `[47,92,115,47]`；这是静态源字节检查，没有把工具展示转义当作另一个缺陷。

[源范围](source-manifest.json)为9pins、7语义文件686行（572产品 /114现有test声明），3full /4selected /2hash-only。所有body /tests在专门pin后读取，Root报告正式checkout到bbad后，[结束核对](finish-checks.json)的9源仍全部匹配读前SHA。McpDetailDialogs、lifecycle test仅hash；未import /运行它们。源中连带打印的probe、OAuth、锁/权限片段在scope中分清，不审其机制。起始prep context ee5c保留，Root所报结束baseline bbad另列，未执行Git。

[新dated全历史](history.json)含3318文件（1342MD /1976JSON，807880strings /1193828scalars），含冻结36，扫描开始时mutable37及future38按exact目录排除；随后37冻结不倒填本次范围。source path69 /filename77 /SHA11 /args terms3均低于160cap。实际读了source locators、5份结构化旧源记录、5个same path+SHA对象、3个args上下文及8份额外filename上下文，未声称读完77份完整contexts。[选读反证](selected-history-contexts.json)保存：旧PLUGIN-R8-01是另一个模块丢空quoted位置参数；May30旧MCP条目是header分隔符显示问题，原说明确认其parser兼容两种分隔符；都不等于本次非空参数重开分组变化。R30同SHA仅有1092–1112 selected记录，库存和聚合hash不构成全文语义覆盖。未找到精确旧同因果，机械关键词与有限选读不证明绝对首报或历史语义穷尽。末尾3318included均未漂移，included新增 /删除0。

[本次判断](decisions.json)仅支持Root同一线索，Root拥有最终ID /formal或candidate分级；本review未读Root mutable作者报告。[验证账目](validation.json)runs为空：0产品函数 /tests /language fixture /React /MCP连接或命令 /配置操作 /网络 /native /浏览器 /Git /权限实验，旧失败方向未重开。[作者收据](author-receipt.json)仅封存本exact temp目录，与geometry的冻结收据分开。
