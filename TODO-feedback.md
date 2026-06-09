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
- **根因(已定位)**:`TurnProcessGroupCard.tsx:70` 渲染工具卡时 key 用了 tool call id,但同一 turn 内出现重复 id → React 重复 key 警告 + 可能重复/丢卡。可能与 #5 的 V8 OOM 同源(重复节点累积)。
- **状态**:🟡 待修(虽标了"成功",但控制台报错应在 beta1 前清掉)
- **备注**:key 改成 `${callId}-${index}` 或去重;OOM 一并验。

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

