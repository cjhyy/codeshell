# Prep89：ComposerSuggestions 普通选项数据审查

有限结论：**0 新 formal / 0 candidate / 0 new-related**。所读普通列表、选中索引、选项 ID、键盘与鼠标回调的数据映射没有建立新反例；不据此认证完整 ChatView、所有建议功能、浏览器焦点或 React 时序。[分类记录](classification.json)另存。没有修产品。

Root 提供当前 baseline `7dcd41b9a1bfd23ecc6e6563fd8fbf569cf9483b`，仅是外部上下文，自己的 Git 操作为0。[初始 pins](initial-pins.json)先于正文与行导航：实际 filename inventory 确认 `packages/desktop/src/renderer/chat/ComposerSuggestions.tsx`101行、3310 B、SHA `511aabd34ad08cb0559d0cdaa6d4ba998f7439f11f10d2af58e4b227ef13fd12`。指令同 SHA 沿用此前实际阅读，重复 hash 不算新阅读。

正文前 [fresh history](history.json)按 [方法](history-method.py)机器遍历全部 docs/bugs MD 与递归 JSON scalar values，纳冻结49、排正式数字50+，含169个精确 archive/_archive 目录成员。**4693份 = 1457 MD + 3236 JSON**，2129441 strings / 3168045 scalars / 914461 objects / 81935 arrays，0 parse error。path/SHA/filename/old-cause 总命中 **10/5/11/29**，各 cap100，均全部保留为有界 [contexts](history-contexts.json)；机器遍历量不等于人工逐字语义阅读量。

实际 gate 读了全部7个 [精确 path/SHA 对象](coverage-gate-objects.json)、全部29个有界 old-cause 窗口与全部命中定位列表。对象均是库存或派生 incidental rows，没有 canonical 同 SHA full/readScope/reviewMode/inspectionScope 阅读声明。[gate decision](gate-decision.json)明确 unknown/pin-only/no-row 不是未读证明。R43 的旧 source excerpt 有此组件结束标签，canonical 清单只把 ChatView caller 列为 selected，不构成 target 模块 full。故进入普通选段，仍不称首次阅读。

实际 filename-only consumer 查询只定位到 ChatView、MentionPopover 与本模块；[consumer pins](consumer-initial-pins.json)在其任何正文/行导航前落盘。普通链的源码依据和反证如下：

- Target11–30 的 option ID 是 listboxId 加编码 identity，selected/items/children 为显式 props。54–101 的源码用实际 `[role=option][aria-selected=true]` 元素关联 active descendant，无选项时去除该关联；清理源码有防止旧 popup 清掉替换 popup 关联的条件。这里仅描述源值流，没有运行 DOM 或证明任何浏览器绘制帧。
- MentionPopover158–193 从 filteredSkills、visibleFolders、visibleFiles、visibleRecent 按此顺序建立 flat items，并将该列表回传父层。199–370 的渲染分组以相同顺序和累加长度计算 flatIndex；aria-selected 对照同一个 selected，鼠标 mousedown preventDefault 后把所在条目的同一对象传给 onPick。items 型别与回调字段选读31–34/47–53。未展开列表 IPC 的 Host、根路径/身份权限、真实文件搜索或任何 helper 实现。
- ChatView271–278/842–872 处理 slash 查询和实际 command 项，953–985 控制 mention/slash 的互斥、关闭、query 改变时重置和列表减少时 clamp。1341–1407 的键盘映射在非空列表才做 modulo 导航，取项使用同一列表并取索引与末项的较小值。2149–2226 将 mention flat items 回传更新并 clamp，slash 子项用同一 slashItems map 和索引标记，鼠标传同一 item 到完成/执行入口。2230–2233/2253–2258 的实际 textarea value、onChange 与 onKeyDown 接线把普通输入送到这些 picker。执行/展开、submit、attachment/staging 与 applyMentionPick 的内部实现停在调用边界。
- 源码声明了普通空列表、选项减少、query 改变、popup 替换的处理分支，未由这些分支建立新的普通 counterexample。没有手构造负数/NaN 索引、畸形 Unicode、任意 children/DTO 或自定义调用者制造问题，也没有把尚未运行的 React commit/effect 间隙当成观察到的 UI 缺陷。

[源码范围](source-manifest.json)为 **3 selected / 0 full，519产品语义行，800唯一显示行**，测试正文/声明均0。Target 显示全101行，仅 ordinary scope68行；MentionPopover显示全370行，仅普通数据/选项映射219行。anchor 几何、IPC/search/timer/Host 邻接和 scroll 行即使打印过也只作 navigation/adjacency，不认证相应机制、不因全文显示称 full。ChatView语义232行、显示329行。[后捕获 excerpts](source-excerpts.json)只保存实际已显示行，明确晚于阅读，不伪称预读快照。

[旧范围重叠](prior-overlap.json)保留 canonical R43 `source-manifest.files[0]` 原对象与 SHA：ChatView 当前同为 `f9581b…`，本次与该旧 selected 精确重叠至少79行：783–784、1341–1407、2230–2233、2253–2258。必要 caller 重读不算首次覆盖；没有穷尽其他旧 consumer full 主张。R43 对 R04/D5 plugin late expansion 跨会话写草稿的已知因果排除保持原样，本次没有进入该异步展开实现或重报旧项，也没有重启任何旧失败方向、借旧 pass 充当新运行。

5个相关测试文件名仅作 filename inventory；测试内容按 target/aria/slashSelected 的 filename-only 查询无命中，没有据此断言测试不存在，也没有打开或运行测试。[validation](validation.json)记录0产品/helper/import/fixture/tests/React/DOM/UI/timer/network/native/model/Git运行；仅自有标准库 metadata/hash/search/range脚本运行。所有可观察工具调用均无 stderr/fatal error或截断；测试 filename-only 空结果不是产品失败，单条 rg 的独立退出码未捕获。[ending checks](ending-checks.json)确认5个源码/指令 pins 全同 SHA、4693份原历史集合与 bytes 0 drift；结束 hash 不增加语义阅读次数。只写 exact tmp，不动旧冻件与产品；[receipt](reviewer-receipt.json)为冻结回执。
