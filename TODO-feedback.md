# TODO / 反馈记录

> 随手记录使用中发现的问题、体验吐槽、待办改进。
> 格式建议:每条带状态标记,处理完打勾并备注 commit。

状态图例:🔴 待处理 · 🟡 进行中 · 🟢 已修复 · ⚪️ 搁置/不修

---

## 反馈列表

<!-- 在下面追加。模板:
### [日期] 一句话标题
- **现象**:
- **复现**:
- **期望**:
- **状态**:🔴
- **备注**:
-->

### [2026-06-08] markdown 有序列表 1./2./3. 不显示
- **现象**:回答里的有序列表只剩缩进的子项,序号 `1./2./3.` 和圆点都没渲染出来。
- **根因**:Tailwind v4 的 Preflight 把所有 `ul/ol` 重置成 `list-style: none`;`markdown.css` 只设了 padding 和 `li::marker` 颜色,从没把 `list-style-type` 加回来。
- **状态**:🟢 已修
- **备注**:`styles/markdown.css` 给 `ul=disc / ol=decimal` + 嵌套 `circle/square`。

### [2026-06-08] 浏览器面板里访客站点字体被 CSP 拦
- **现象**:面板打开 `localhost:3000` 的 Next.js 站,控制台报 `Refused to load the font … violates … font-src 'self' data:`。
- **根因**:给 renderer 用的 CSP 通过 `defaultSession.webRequest.onHeadersReceived` 注册,把 `<webview>` 访客页面也管了;站点自托管的 `/_next/static/media/*.woff2` 对它自己是同源,却被我们的 `'self'` 拒了。
- **状态**:🟢 已修
- **备注**:`main/index.ts` 加 `isRendererRequest()`,只对 renderer 来源(dev URL / file: / devtools:)注入 CSP,访客页保留自己的响应头。

### [2026-06-08] 停止键失效(点了断不了)
- **现象**:点停止报 `TypeError: bucket.indexOf is not a function`,turn 根本停不下来。
- **根因**:`onClick={onStop}` 把 MouseEvent 当第一个参数传进 `stop`,落到后加的 `bucketOverride?: string` 上,`bucket.indexOf` 在事件对象上抛错,cancel IPC 没发出。
- **状态**:🟢 已修
- **备注**:`App.tsx` `stop()` 加 `typeof === "string"` 守卫 + 调用点改 `onStop={() => stop()}`。

### [2026-06-08] 主动停止后还叠一个红色 Error 报错
- **现象**:引导/对话里主动停止,先出回答 → 冒一个 abort 报错 → 最后又来个尾流回答;明明显示了「你在 Ns 后停止了」却还报错。
- **根因**:停止时 in-flight LLM 调用以 AbortError 拒绝,`turn-loop.ts` 两个 catch 分支没区分中止/真错,一律 `onStream({type:"error"})`,渲染成红 `Error:` 块(RPC 响应层早已正确识别为 aborted_streaming,漏的是流式事件通道)。
- **状态**:🟢 已修
- **备注**:`core/turn-loop.ts` 两处 catch 先判 `isAbortError||signal.aborted`→直接返回 `aborted_streaming` 不发 error;`renderer/types.ts` 再兜底吞掉 abort 文案的 error 事件。

---

## 🧪 beta1 Smoke 验收(2026-06-09,真机 Electron 走查)

> 来源:`docs/beta1-smoke-form.html` 表单导出。13 条 = 9 预置 + 4 自定义。**6 成功 / 6 失败 / 1 未标记**。
> 截图存 `docs/assets/beta1-smoke/stepNN.png`。下方按失败优先排序。

### 🔴 [2026-06-09] 受限权限下读 repo 外文件 → `Error: require is not defined`(beta1 阻塞)
- **现象**(#11/#12):默认权限读 repo 外内容→报错;给了权限申请卡片、点批准后**直接报错** `Error: require is not defined`;Glob/Read 工具也连带报 `require is not defined`,只能退而用 shell。
- **根因(已定位)**:`permission.ts:330` `require("node:path")`、`:402` `require("node:fs")`,以及 `path-policy.ts:146/196`、`permission.ts` 等共 **9 处裸 `require()`**。注释称为"浏览器 shim 做 lazy require",但 **desktop main 是 ESM bundle(`--format=esm`)**,ESM 里 `require` 未定义→审批/路径策略一走到这里就抛。与既往 RunLock ESM bug 同源(那次已用 createRequire 修,这几处漏改)。
- **期望**:受限权限触发审批、批准后工具继续执行,不报错。
- **状态**:🟢 已修(2026-06-09,**beta1 阻塞已解除**)
- **截图**:`docs/assets/beta1-smoke/step11.png`、`step12.png`
- **日志证据**:session `s-mq6e5xim-e652e9fc`,`desktop-2026-06-09.log:11605/11607/11645` —— Glob/Read 工具返回 `error:"require is not defined"`;读 `~/.code-shell`(cwd 外)触发 path-policy 工作区外检查时炸。
- **备注**:修了 core 全部 9 处裸 `require()` → `path-policy.ts`(2 处,顶部已 import fs,改静态 import)+ `permission.ts`(2 处,改静态 `import {resolve,dirname}`/fs)+ `updater.ts`(3 处)+ `provider-auth.ts`(1 处)+ `pluginInstaller.ts`(1 处)用 `createRequire(import.meta.url)`/已有静态 import。验证:core tsc 绿、tool-system 266 pass、grep 残余裸 require 为空。同源既往 [[project_runlock_esm_bug]]。

### 🔴 [2026-06-09] 后台 shell 卡片状态不更新、输出不回流
- **现象**(#7):`sleep 5 && echo done` 卡片显示 `exit 0` 却又标 `status=running` + `(无输出)`;刷新也没用。
- **根因(待查)**:卡片 exit code 已拿到(exit 0)但 `status=running` 没翻成 finished,且 stdout 未渲染。疑似增量游标/状态回写或 renderer 订阅未刷新。core 后台 shell 有完整实现(见 project_background_shell),需查 UI 回流链路。
- **状态**:🔴 待修
- **截图**:`docs/assets/beta1-smoke/step07.png`
- **备注**:与记忆 [[project_background_shell]] 「增量游标用绝对位置」相关,先查 desktop 订阅刷新。

### 🔴 [2026-06-09] 审查面板:无删除/历史轮、铺开太满、分支对比卡死无法滚动
- **现象**(#5):① 本轮改动只看到"改了什么"(绿色新增),**没有删除、没有上一轮已编辑的对比**;② diff 全部平铺,期望改成**下拉选择**切换更清爽;③ 点「分支 vs base」**卡住且无法滚动**——期望是选两个分支对比 / 按 commit 选;④ 长时间后进程 **V8 OOM**(800MB,`Mark-Compact`→`process OOM`)。
- **状态**:🔴 待修(拆成 4 个子问题;④ OOM 可能与 #1 重复 key 渲染泄漏同源)
- **截图**:`docs/assets/beta1-smoke/step05.png`
- **备注**:②③ 偏审查面板交互重做;④ OOM 单列,见下条 #1。

### 🔴 [2026-06-09] 权限档位在 session 间"粘连"被带回
- **现象**(#11):默认权限的 session 读 repo 外报错→切到一个"完全编辑权限"的 session→再切回来,原 session **变成了完全编辑权限**。
- **根因(待查)**:active 权限档疑似被当成全局态而非 per-session,切换串档。
- **状态**:🔴 待修
- **备注**:与 #11 的 require 报错是同一张截图里的两个独立问题,分开记。

### 🔴 [2026-06-09] 回答里点文件路径用了系统默认应用,而非内置文件面板
- **现象**(#13):点 assistant 回答里的文件路径,**自动用系统默认应用打开**,没走内置文件系统面板。
- **状态**:🔴 待修
- **截图**:`docs/assets/beta1-smoke/step13.png`
- **备注**:与记忆 [[project_inline_code_path_links]] 相关;期望默认走内置面板(panels),外部打开应是显式选项。

### 🟡 [2026-06-09] 启动白屏久 + 控制台重复 key 报错 + 疑似渲染泄漏
- **现象**(#1):启动时白屏太久;控制台刷 `Encountered two children with the same key, call_xxx`(`TurnProcessGroupCard.tsx:70`),多个 tool call 用了相同 key。
- **根因(已定位)**:`TurnProcessGroupCard.tsx:65-70` 渲染 group.items 时 `key={m.id}`(=tool call id),但同一 group 内出现**重复 id** → React 重复 key 警告 + 重复/丢卡。
- **状态**:🔴 待修(**从 🟡 升级**——见下条 automation session 实锤:这会导致工具卡片"一直显示"卡死,且疑似 V8 OOM 同源)
- **备注**:治标 = key 改 `${m.id}-${index}`;治本 = 查 group.items 为何有重复 id(疑似流折叠 post-pass 把同一工具塞进 group 两次,见 [[project_stream_folding_postpass]] automation 落 turn_process_group 内需递归)。OOM(#5④)一并验。

### 🔴 [2026-06-09] automation「update memory」工具卡一直显示/不收口(= #1 同根因实锤)
- **现象**:automation 美股晨报 session(`0hgSIulvUL97CKvJ`)的 `UpdateAutomationMemory`(UI 显示"update memory")卡片**一直显示、不收口**,反复打开该 session 都在。
- **根因(实锤)**:该工具 call id `call_h5XLA2zR6hB0XHku81IAeRCg` 在 desktop 日志里**从 00:37 到 08:50 横跨 5+ 小时反复报** `Encountered two children with the same key, call_h5XLA2zR6hB0XHku81IAeRCg`(`TurnProcessGroupCard.tsx:70`)。session 本身 01:23 已正常 `turn_complete`+`session_title`,核心流程完结;是**渲染层 key 冲突**让卡片无法稳定 reconcile→卡住/重复,看起来像"一直在 update memory"。
- **状态**:🔴 待修(与 #1 同一处 `TurnProcessGroupCard.tsx:70`,一起修)
- **日志证据**:`desktop-2026-06-09.log` 多行(2688/13294-13311 …);`engine-2026-06-09.log:307` UpdateAutomationMemory tool.exec.end ok=true(后端成功,纯前端渲染 bug)。
- **备注**:automation session 更易触发重复 id(每次回看 replay 重建 group);修 key 后这两条一并验。

### 🟡 [2026-06-09] 图片附件:缩略图不能放大、放大后有两个叉
- **现象**(#6):输入框里的图片缩略图没法点开放大;放大(lightbox)后出现**两个关闭叉按钮**。
- **状态**:🟡 待修(体验缺陷,非阻塞)
- **备注**:lightbox 关闭按钮重复渲染;缩略图加点击放大。

### 🟡 [2026-06-09] Undo 是文件维度整体回滚,非按对话轮
- **现象**(#8):一次 undo 成功;但分两轮改的内容,undo 第一轮时**直接回滚了文件**(文件维度),而非按那一轮的改动粒度。问:codex 怎么做的?
- **状态**:🟡 待讨论(产品决策:undo 粒度 = 文件 vs turn-diff)
- **备注**:现状单步 undo(cc25b03)是文件级。需定 undo 语义后再改。

### 🟡 [2026-06-09] 右上角图标不更新
- **现象**(#10):某操作后右上角图标没更新(状态未刷新)。
- **状态**:🟡 待查(信息较少)
- **截图**:`docs/assets/beta1-smoke/step10.png`
- **备注**:看截图定位是哪个图标 / 哪个状态没刷。

### ✅ 通过项(无须处理)
- #2 新会话对话 ✅ ｜ #3 模型切换 ✅ ｜ #4 文件编辑 ✅ ｜ #9 设置页按项目选配置 ✅

---

## 🧭 引导 / 打断当前轮插入新 message 的渲染问题(2026-06-09)

### 🔴 [2026-06-09] 打断旧轮、插入新 user message 后,缺「正在思考」态
- **现象**:引导/对话中打断当前轮(ChatView 的「打断当前轮并发送这条输入」`ChatView.tsx:875`/`:595`),插入新 user message 后,**新一轮没有显示「正在思考」**(LiveActivityLine 该出的 live 态没出)。
- **根因(待查)**:打断→立即起新轮时,旧轮 turn_end 与新轮 live 态切换的时序;疑似新轮的 `group.isLive` / LiveActivityLine 触发条件在"打断接力"路径下没点亮。涉 `App.tsx:1491 turn_end(reason:"stopped")` 后紧接新 run 的状态。
- **状态**:🔴 待修
- **备注**:对照正常发送路径(有思考态)与打断接力路径(无)的状态机差异。`LiveActivityLine.tsx` + `App.tsx` turn 状态。

### 🔴 [2026-06-09] session 标题不落盘 → 重开/replay 后标题没了(automation 尤其明显)
- **现象**:automation 触发的 session 之前有标题,现在没了(session `Rm3ROU7XiwPZcrDn`)。
- **根因(实锤)**:`engine.ts:1862-1872` 标题生成后**只 `onStream({type:"session_title"})` 发事件,从不写 `session.state.title` 也不落盘**;且 `SessionState`(`types.ts:122`)**根本没有 title 字段**。对照 12 个 session 的 state.json **全部 `title:None`**(desktop/automation/subagent 都没存)——是全局持久化缺失,非 automation 专属,只是 automation replay 回看时最明显。标题只活在事件流里 → 侧边栏当时短暂显示,重开就没。
- **次因**:标题生成在 `.then` 异步回调里,而 `:1881` 紧接着就把 `session.state` 落盘了 → 即便想写 state 也已错过这次落盘。
- **状态**:🔴 待修
- **日志证据**:`desktop-2026-06-07.log:8035` session_title 事件确实发了;但 `~/.code-shell/sessions/Rm3ROU7XiwPZcrDn/state.json` title=None。
- **备注**:修法 = ① `SessionState` 加 `title?: string`;② `buildSessionTitle().then` 里写 `session.state.title` + `saveState`(或单独 patch state.json,避免与 :1881 落盘竞争);③ 加载/replay 时回填 title 到侧边栏。关联记忆 [[project_session_title_llm]]。

### 🔴 [2026-06-09] 被打断的那一轮不该显示「已处理 Xs」折叠头,应直接平铺内容
- **现象**:被打断(stopped)的那一轮,UI 仍套了 Codex 式「已处理 X m Y s ⌄」折叠头(`TurnProcessGroupCard.tsx:48`);期望**被打断的轮不折叠耗时**,直接把已产生的内容展示出来。
- **根因(已定位)**:`TurnProcessGroupCard` 无条件给 turn_process_group 渲染耗时头(`:36-48`),没区分该轮是否被 stopped 打断。
- **状态**:🔴 待修
- **备注**:被打断轮(turn_end reason="stopped")应跳过 process-group 耗时头、直接平铺 items;或不把被打断轮包进 process group。与 `TurnEndMessageView.tsx`(stopped 行)配合,别两处都显示。

### 🟡 [2026-06-09] 输入框被面板挤压时样式崩坏,缺最小宽度 + 底部控件压缩态
- **现象**:打开侧边面板后聊天区/输入框被挤窄,输入框还继续压缩、底部那排控件(权限选择/Goal/附件/模型)挤成一团,样式很难看。
- **期望**:① 输入框(及其容器)有**最小固定宽度**,压到阈值就不再缩(宁可面板那侧让位/横向滚动,也别把输入区压烂);② 底部控件设计**压缩态(窄屏)样式**——例如 `PermissionPill` 窄屏时**只显示 tone 颜色 icon、隐藏文字**(组件里已有 `h-2 w-2 rounded-full` tone 圆点 `PermissionPill.tsx:128`,把它提到收起态、用 `@container`/断点隐藏 `:107` 的 `<span>{label}</span>` 即可);Goal/模型同理可降级为 icon-only。
- **状态**:🟡 待修(beta 体验项)
- **备注**:相关 `ChatView.tsx` 输入区容器 + `chat/PermissionPill.tsx`、`chat/GoalToggle.tsx`。优先用容器查询(`@container`)按输入区实际宽度切换,而非全局视口断点(面板开合改变的是局部宽度)。与 #2.4 面板放大/窄屏适配同源,可一起做。

### 🔴 [2026-06-09] 已删除的项目目录(resume-plugin)反复"复活"为空壳,重启又出现
- **现象**:用户删了 `resume-plugin` 目录(两处:`代码学习/resume-plugin`、`代码学习/writeflow/resume-plugin`),但侧边栏/项目列表反复出现,重启后磁盘上又冒出来。
- **根因(已定位)**:目录被**重建成空壳**(`ls` 两处都是 `total 0`,只有 `.`/`..`)。元凶 = 往 `<cwd>/.code-shell/` 写东西时用了 **`mkdirSync(..., {recursive:true})`**(`config.ts:70`、刚修的 `path-policy.ts`/`permission.ts` 持久化路径也是),当 cwd(=已删的 resume-plugin)不存在时,`recursive` 会**连父目录 cwd 一起建出来**。触发点:有 2 个 `origin=desktop status=completed` 的 session cwd 指向这两个 resume-plugin 路径(`s-mpz78z97-daa57dec`/`s-mpz77jez-2de8c61b`);加载/续跑/写 settings.local.json/权限规则时 mkdir recursive 复活目录,recents.json + trust.json 里又留着路径 → 侧边栏再显示。
- **状态**:🔴 待修
- **证据**:磁盘两空目录;`recents.json`/`trust.json` 均含 resume-plugin 路径;2 个 session state.cwd 指向它。
- **备注**:修法方向 = ① 写 `<cwd>/.code-shell/` 前先判 `existsSync(cwd)`,**cwd 本身不存在就别 mkdir/别写**(目录都没了说明项目已删,不该悄悄复活);② 加载 session / 刷 recents 时过滤掉 cwd 已不存在的条目(类似 [[project_disk_authoritative_recovery]] 的 isNoRepoCwd 过滤);③ recents/trust 提供清理。关联 [[project_draft_session_autojump_bug]]、[[project_disk_authoritative_recovery]]。

### 🟡 [2026-06-09] 图片细节(imageDetail / OpenAI detail)设置是否需要优化 — 待讨论
- **现状**:`imageDetail` 是**全局三档枚举** `low｜high｜original`(`types.ts:441`、`schema.ts:477`),仅 OpenAI 兼容路径读取(`openai.ts:731/769` → `mapImageDetailToOpenAI`),Anthropic 不读。全局默认,可被项目设置覆盖。
- **用户疑问**:这个设置是不是该优化了?
- **可能优化方向(待定,需产品决策)**:
  - **A. 默认值/智能化**:多数人不懂 low/high 取舍 → 默认 `auto`(让 provider 自己定)或按"省钱/高清"两档语义化命名,而非裸露 OpenAI 术语;`original` 含义对用户也不直观。
  - **B. 适用范围**:目前只 OpenAI 生效、Anthropic 忽略 → 设置页该**标注"仅 OpenAI 兼容 provider 生效"**(现说明已提,但选了 Anthropic 时该 disable/灰掉该控件,避免用户以为生效)。
  - **C. 粒度**:是否需要"按单张图/按对话"临时调,而非只有全局+项目两层?(大图偶尔要高清,平时省 token)
  - **D. 与 token/成本联动**:high detail 显著增 token;可在控件旁提示成本影响,或与 [[project_llm_retry_maxtokens_bugs]] 的 token 管理联动。
- **状态**:🟡 待讨论(非 bug,产品优化方向)
- **备注**:先定"目标用户要不要懂这个参数"——若不要,默认 auto + 折叠进高级设置即可;若要,补语义化 + provider 适用性提示。`engine.ts:741-743` 有旧 images.detail→llm.imageDetail 迁移路径,改时注意兼容。

### 🔴 [2026-06-09] 手机遥控:每次扫码都新建一个 browser/房间,不复用,越积越多
- **现象**:手机遥控里出现一堆 browser(房间);用户每用浏览器扫一次码就**新存一个**,不复用。
- **根因(实锤)**:`mobile-remote/room-manager.ts:85 createRoom` **每次都生成全新 id**(`room_${now}_${random}` :90)、无条件 `mkdirSync`+写新 `room.json`(:100-101),**没有任何"该设备/该 cwd 已有房间就复用"的判断**。扫码入口每次都走 createRoom → 房间无限累积。存储:`~/Library/Application Support/code-shell/mobile-remote/rooms/room_*/`。
- **状态**:🔴 待修
- **备注**:修法方向 = ① 扫码/配对时按 **deviceId(或 cwd+设备指纹)getOrCreate**,已有则复用、只刷 `lastActiveAt`,不新建;② 房间列表 UI 给**删除/清理**入口 + 闲置房间过期回收(注意记忆 [[project_background_shell]]「idle-sweep 绝不杀」是指后台 shell,不是房间,房间可回收);③ 二维码可绑定一个稳定 room/device 标识而非每次随机。关联手机遥控特性(见 TODO-week 📱 节,虽已整体降优,但这个无限累积是 bug 不是新特性)。

### 🟡 [2026-06-09] 浏览器圈选标注:面板与新窗口不互通 + 再编辑时选区样式不回显
- **现象**:UI 圈选(BrowserPanel 圈选/标注)在**浏览器面板**和**浏览器新窗口**之间**不互通**——各存各的,应该互通共享;且**再次编辑标注时,没把那一块 select 的样式回显**出来(看不到之前圈在哪)。
- **根因(已定位)**:圈选状态 `selecting/picked/markers/editingMarker` 全是 `BrowserPanel.tsx:175-182` 的**组件本地 `useState`**,纯内存、不持久化、不跨实例/跨窗口共享。新窗口(`App.tsx:1829 new-window`,各自独立 BrowserWindow/renderer)起一个全新 BrowserPanel → markers 从空开始,看不到面板里圈的;再编辑时也没有从持久层取回 marker 的选区样式重绘高亮。
- **状态**:🟡 待修(浏览器面板增强,非阻塞)
- **备注**:修法方向 = ① 把 markers/选区**提到可共享的持久层**(主进程或 session 级 store),两个 renderer 都订阅同一份(类似 outboundTaps 镜像);② 编辑某 marker 时,按其 `selector`/`rect` 重新注入高亮脚本(PICKER_SCRIPT 已能按 selector 描述元素),把选区样式回显;③ 注意 webview 访客页无 preload(:76 注释),跨窗口同步要走主进程中转。与 #2.3「四面板内文件用外部 app 打开」同属 BrowserPanel 增强。

### 🟢 [2026-06-09] 本地环境设置:隐藏「清理脚本(cleanup)」UI — 配了不生效会误导
- **现象**:设置→本地环境页有「清理脚本」输入框,但 cleanup **当前不自动收尾运行**(按决策没接),配了等于白配,UI 露出来会让用户以为生效(典型「看起来能配实际没用」半成品)。
- **状态**:🟢 已做(2026-06-09)
- **备注**:`AdvancedSections.tsx` 注释掉「清理脚本」`<LocalScriptEditor>` 卡片 + 移除 `cleanupTab` state + 顶部说明文案去掉 "cleanup"。**保留** `cleanupScripts` state 与保存逻辑(不丢已存数据),接上 cleanup 功能后恢复那段 JSX 即可。desktop tsc 绿。← 配套 §6.5「设置页 scope 收口/避免半成品」的 beta 前清理精神。

### 🟡 [2026-06-09] 钩子设置页能力太弱 + 看不到插件(superpowers)hooks — 隐藏或改造,待定
- **现象**:设置「钩子」页好像什么都干不了;按理应该能看到插件提供的 hooks 来管理,但 superpowers 等插件的 hooks 根本看不见。
- **核实(2026-06-09)**:
  - **手写 project hook 其实生效**(`ProjectHooksEditor` 读写 `<repo>/.code-shell/settings.json` 的 `hooks`,引擎加载 settings hooks)——所以不是"完全无效"。
  - **但页面能力极弱**:只能列出 event+command、删除、或**让用户手敲一段 `{event,command}` JSON 添加**(`AdvancedSections.tsx:329-366`),无事件类型提示/校验/可视化。
  - **核心缺口**:**插件 hooks 看不到、管不了**。core 的 `loadPluginHooks`(`engine.ts:641`)确实加载插件 hooks 且受 `disabledPlugins` 控制(关插件=关其 hooks),但钩子页**只读手写的 `s.hooks`,完全不展示插件 hooks**。superpowers 的 hooks 在后台默默生效,UI 里既看不见也只能靠"整个禁用插件"来关。
- **状态**:🔵 已定方案 B,待用户自己改(2026-06-09 决策:不隐藏,改造成真正的 hook 管理页)
- **改造清单(B)**:
  1. **合并展示**「手写 hooks(project settings.hooks)+ 插件提供的 hooks」。插件 hooks 来源 = core `loadPluginHooks`(`engine.ts:641`,扫每个已装插件的 `hooks/hooks.json`);需新增一条 IPC 让 renderer 拿到「已加载的插件 hooks 列表 + 各自来源插件名」(core 侧 `loadPluginHooks` 已有数据,补查询接口)。
  2. **插件 hooks 只读 + 标注来源**(「由 xxx 插件提供」),复用 6.2 MCP 页的 owner 标注模式(ownerPluginOf / 只读戳 / 不可在此编辑)。
  3. **可视化加 hook**:event 类型用下拉(枚举可选 event),command 用输入框,替掉现在让用户裸敲 `{event,command}` JSON 的 `AdvancedSections.tsx:329-366` `add()`。
  4. **插件 hook 启停**:走 `disabledPlugins`(整插件)或更细的 capabilityOverrides;至少让用户看到「这个插件的 hook 在跑」并能关。
- **相关文件**:`AdvancedSections.tsx`(HooksSection/ProjectHooksEditor)、core `plugins/loadPluginHooks.ts` + 一条新 IPC、`preload/index.ts`。
- **备注**:现状钩子页只读手写 `s.hooks`、靠裸 JSON 添加,且**完全不展示插件 hooks**(superpowers 的 hook 后台生效但 UI 看不见)。核实见上。关联 [[project_settings_hooks_memory_dream]](钩子仅项目级)、[[project_extensions_ui]](6.2 MCP owner 标注模式)。

