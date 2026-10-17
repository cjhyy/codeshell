# CDP / Browser diagnostics 第三批补审

基线 `0f83bbfdfb8f2c6f31148250bd6544f5325c16e7`，分支 `codex/audit/broad-round3-20261017`。本轮新增 **3 个确认项（1 P2 / 2 P3）**；另有 1 个旧项仍存和 3 个候选，不计入新增。产品源码未修改。

## 范围与证据边界

读完 `CODESHELL.md` 后审阅 `packages/cdp/src/{driver,keymap,scroll-state,types,sender,index}.ts`、`packages/browser-devtools/src/{inspector,contracts,index}.ts`，相关 README/package metadata 和已有单测；重点是几何、键盘、普通滚动/阅读返回值、Console/DOM/Performance 摘要。导航权限、认证、注入/攻防及真实浏览器操作不在本轮范围。

`packages/cdp` 是 private 的 legacy compatibility SDK。`packages/desktop/src/main/browser-driver/cdp-driver.ts:3–5,45` 明确生产 Electron/Chrome 使用 Puppeteer、此兼容类为 deprecated；下述 CDP 两项只确认兼容 SDK 输出，不外推为默认 Desktop 已发生。Browser diagnostics 则由 `packages/desktop/src/browser-library/browser-inspector.ts:9–10` 供 Puppeteer/Playwright 适配器复用，Puppeteer `inspect()` 接线见 `puppeteer-browser-driver.ts:624–631`。本轮未运行这些 Desktop 适配器。

全部动态都是 guarded Bun shard、内存 fake sender/page、独立半平面几何判定，或 Node VM 中实际 inspector callback + 纯对象 DOM/Performance 替身。未创建浏览器/真实 CDP 连接、未导航站点、未使用模型/用户数据。VM 的 computed styles/geometry 由夹具提供；它不证明真实浏览器渲染或页面事件发生。

## 新增确认项

### CDP-R3-01 / P3：裁剪旋转四边形时，click/hover 点可能落在目标之外

- **位置**：`packages/cdp/src/driver.ts:157–162`；四边形先被 `rectFromQuad()`（`:861–866`）缩成轴对齐外接矩形，随后只裁矩形，取其中心；`clickNode()`/`hoverNode()` 共用该点。
- **可达触发**：兼容 SDK 的 `clickNode(id)` 或 `hoverNode(id)` 读取到经 CSS 旋转、部分超出 viewport 的细长元素 quad。例：100×100 viewport，CDP content quad 为 `[-100,110,110,-100,120,-90,-90,120]`，是一个有效凸旋转矩形，其真实中心 `(10,10)` 在 viewport 内。fixture将它作为scrollIntoViewIfNeeded之后返回的几何；未运行真实布局引擎，不从中心可见直接推断该命令实际会不会继续滚动。
- **预期**：选择同时位于实际 quad 和 viewport 内的点，例如 `(10,10)`；若不存在可用点则失败。
- **实际**：`centerOf()` 返回 `(50,50)`；click 返回 `{ok:true}` 并发送这点的 mousePressed/mouseReleased，hover 也发送这点。独立凸多边形半平面判定确认 `(50,50)` 在 quad 外，而 `(10,10)` 在内。
- **影响**：该兼容 API 能发出没有瞄准元素的输入且报告成功，调用方的点击/hover 可落空。证据止于发送 payload 和几何关系，没有证明真实页面上哪个元素最终收到输入。
- **证据**：[夹具](evidence/cdp-geometry-keymap.test.ts) 前四个测试，含轴对齐部分裁剪和全可见旋转 quad 的正常对照；[首跑 stdout](evidence/cdp-geometry-keymap.first.stdout.log)、[stderr](evidence/cdp-geometry-keymap.first.stderr.log)。官方 [DOM 协议定义](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/DOM.pdl) 将 content 定义为按顺序排列的 quad 顶点；该协议没有保证它是轴对齐矩形。
- **查重**：旧 [2026-07-08 CDP review](../archive/todo/review-tui-cdp-2026-07-08.md) 的问题是未经 viewport 裁剪的完整 quad 中心跑到屏幕外。当前已有矩形 viewport 裁剪，本例点也在屏幕内，新增原因是丢弃 quad 形状，不重复计旧问题。

### CDP-R3-02 / P3：Shift 组合生成的逻辑 key 与实际字符含义不一致

- **位置**：`packages/cdp/src/keymap.ts:314–316,331–335,345–346`。`text` 经 `printableText()` 做 Shift 映射，`key` 仍原样采用 spec 的主 token；driver `pressKey()`（`driver.ts:263–270`）原样发送计划。
- **可达触发**：兼容 SDK 调用 `pressKey("Shift+a")` 或 `pressKey("Shift+1")`，调用者用正常组合描述希望输入大写字母/符号或触发网页按键逻辑。
- **预期**：Shift+a 的主键 keyDown/keyUp 均以逻辑 key `A` 描述按键，物理 code 保持 `KeyA`；Shift+1 的逻辑 key 为 `!`、code 为 `Digit1`。[官方 Input 协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Input.pdl) 区分物理 `code` 与体现当前 modifiers/layout 含义的 `key`。
- **实际**：Shift+a 为 `key:"a", code:"KeyA", modifiers:8, text:"A"`，主 keyUp 也为 `key:"a"`；Shift+1 为 `key:"1", text:"!"`。文本和逻辑按键含义互相矛盾。
- **影响**：依赖 `event.key` 的网页按键处理收到错误描述的风险；输入文本看似正确仍不能满足需要大写/符号 key 的消费者。这里确认的是 SDK 对 CDP 合同的错误 payload，未宣称已观察真实 Chromium 的 event.key 或快捷键结果。
- **证据**：[夹具](evidence/cdp-geometry-keymap.test.ts) 的 Shift+a、Shift+1、普通 a/Control+a 对照及上述首跑日志。旧 review 的 printable text 缺失问题已补上，不等同于本项 logical key 仍未映射；10-16、10-17 findings 与旧 review 未检出该逻辑 key 项。

### CDP-R3-03 / P2：DOM 摘要在 hidden 祖先处剪枝，遗漏显式可见的子节点

- **位置**：`packages/browser-devtools/src/inspector.ts:137–138`；`visibility:hidden` 与 `display:none` 共用 `continue`，在后续 `children`/shadow children 入队（`:167–173`）前终止整棵子树。
- **可达触发**：正常 DOM 的祖先为 `visibility:hidden`，其中一个子节点显式为 `visibility:visible`；通过 `inspect({mode:"dom",selector:"#ancestor"})` 或默认 body 从其上方遍历。这种子节点可见性覆盖是 [W3C CSS2 visibility 规则](https://www.w3.org/TR/CSS2/visufx.html#visibility) 明确允许的。
- **预期**：祖先本身不产生可见摘要，但继续遍历能覆盖回可见的后代；与 `display:none` 整棵不生成 box 的情况分开。
- **实际**：实际 inspector callback 在祖先选择器返回 `{nodes:[],truncated:false}`；直接选同一个 visible 子节点返回其 ID、文本和 geometry。将祖先改为 visible，正常返回祖先与子节点。`display:none` 对照继续为空。
- **影响**：BrowserInspect DOM 诊断漏掉页面实际可见内容，并以非 truncated 完整结果返回；上层无法仅凭该摘要判断还有可见后代。模块有生产适配器消费者，但本轮不包含完整 Host/真实页面 E2E。
- **证据**：[DOM/Console/Performance 夹具](evidence/cdp-diagnostics-projection.test.ts)、[首跑 stdout](evidence/cdp-diagnostics-projection.first.stdout.log)、[stderr](evidence/cdp-diagnostics-projection.first.stderr.log)。Node VM 执行的是实际 callback；可见性语义依规范核对，未运行 CSS 排版引擎。查重 10-16、10-17 audit findings、10-12 review/remaining 与 07-08 review 未发现此项。

## 旧项、候选与跳过

| 分类 | 观察 | 状态/未确认原因 |
| --- | --- | --- |
| 旧项仍存 | `planKeySequence("+")` 返回空；`Control++` 丢失加号，仅产生 Control down/up | [07-08 correctness review](../archive/todo/review-uncommitted-correctness-2026-07-08.md:37) 已明确记录。首跑夹具有再现，**不计新增**。`Equal`/`Shift+Equal` 为另一路可用输入表示。 |
| 候选 C1 | `ControlLeft+a` 的 physical code 可解析，但不贡献 modifier bit，主键还带普通 `text:"a"` | 离线夹具只证实当前 payload；组合语法是否承诺接受 sided physical modifier token 尚未建立，不列确认项。 |
| 候选 C2 | read/extract 的 Runtime.evaluate 结果路径只读取 `result.value`，没有检查 `exceptionDetails` | 只读观察；尚缺本轮允许范围内明确、正常且可重复到达的页面脚本异常触发与端到端返回证据。未动态验证，不计确认。 |
| 候选 C3 | scroll-state 跨 iframe 递归只加偏移，未换算 transform 比例 | 只读观察；缩放 frame、viewport/clip 与实际 wheel 坐标关系未在 CSS 引擎验证，不计确认。 |

没有平台中止、依赖/支架失败，也没有修改支架后重跑。本轮未启动现有真实 Chromium integration 测试；未重跑含导航策略验证的整个 driver suite。未对权限、认证、注入或故障恢复的旧安全方向补做动态。

## 验证计数与覆盖缺口

每个 shard **只首跑一次**，stdout/stderr 分开原始重定向，并保存 exit receipt。测试以“断言已观察错误及正常对照”的方式通过，**pass 不等于产品没有 bug**。

| shard | 结果 | 证据 |
| --- | --- | --- |
| `cdp-geometry-keymap.test.ts` | 9 pass / 0 fail / 0 skip / 24 expect / Completed / exit 0 | [stdout](evidence/cdp-geometry-keymap.first.stdout.log)、[stderr](evidence/cdp-geometry-keymap.first.stderr.log)、[exit](evidence/cdp-geometry-keymap.first.exit.txt) |
| `cdp-diagnostics-projection.test.ts` | 6 pass / 0 fail / 0 skip / 18 expect / Completed / exit 0 | [stdout](evidence/cdp-diagnostics-projection.first.stdout.log)、[stderr](evidence/cdp-diagnostics-projection.first.stderr.log)、[exit](evidence/cdp-diagnostics-projection.first.exit.txt) |
| `cdp-scroll-read-data.test.ts` | 5 pass / 0 fail / 0 skip / 13 expect / Completed / exit 0 | [stdout](evidence/cdp-scroll-read-data.first.stdout.log)、[stderr](evidence/cdp-scroll-read-data.first.stderr.log)、[exit](evidence/cdp-scroll-read-data.first.exit.txt) |

本轮合计 **3 个唯一文件、20 个唯一测试、55 expect、0 fail/skip**，全部 Completed。分布为 5 个确认问题观察测试、13 个正常对照、1 个旧项再现、1 个候选观察。未把 10-16/10-12 的旧 baseline 计入此次执行。

正常对照覆盖：轴对齐裁剪/完整旋转 quad；普通 printable/Control key；滚动单 wheel、delta 上限、NO_PROGRESS、未知 canvas offset 的本地图片签名；普通 read normalization/分页/非法 cursor 返回；DOM limit/truncated/open shadow tree、console 最新100条/读取 limit/文本长度、performance 三类 entry 摘要与 truncated。scroll-state 表达式只做静态审阅，scroll/read 动态返回由 fake sender 提供，不能包装成真实 DOM 区域选择验证。

仍缺真实 CSS transforms/iframe/遮挡命中、浏览器事件与 OS 键盘布局、完整滚动选择器运行、navigation 与读取竞争、真实页面脚本异常、Console/Performance 浏览器库事件兼容及整个包全量回归。图像 fetch/decode、真实 screenshot 缩放及 loading 轮询没有本轮新增动态验证。审查报告是限定范围的 checkpoint，不能称两个 package 的全部后端行为已验证。
