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

### [2026-06-14] 模型切换不应改掉旧 session 的模型
- **现象**:在一个 session 里切换模型后,之前的 session 也会显示/使用新模型;当前 session 热切换还可能不生效,因为 renderer 只发了全局 `configure({ model })`。
- **根因(已定位)**:桌面端模型状态仍是全局态:`App.tsx` 只有一个 `activeModelKey`,所有 `ChatView` 共用;`onModelChange` 同时 `setActiveModelKey(opt.key)`、写 `settings.activeKey`、并调用不带 `sessionId` 的 `window.codeshell.configure({ model: opt.key })`。后端已经支持 `configure({ sessionId, model })` → `ChatSession.requestModelSwitch()`,但前端没接到 per-session 入口。
- **期望**:模型选择分成「新 session/default 模型」和「旧 session 已绑定模型」。切换模型主要更新新 session 的默认选项;已经存在的旧 session 如果仍在用以前的模型,继续用以前的,不被全局切换带走。若用户在某个旧 session 内主动切模型,只影响该 session。
- **状态**:🔴
- **备注**:后续修复方向:renderer 保存 per-session/per-bucket model override,当前 pill 显示 `sessionModel ?? defaultActiveModelKey`;切换当前 session 时调用 `configure({ sessionId, model })`;是否写 `settings.activeKey` 应只发生在「设为默认/新 session 模型」语义下,不要把普通 session 内切换当成全局默认更新。

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

### 🟢 [2026-06-09] 受限权限下读 repo 外文件 → `Error: require is not defined`(beta1 阻塞)
- **现象**(#11/#12):默认权限读 repo 外内容→报错;给了权限申请卡片、点批准后**直接报错** `Error: require is not defined`;Glob/Read 工具也连带报 `require is not defined`,只能退而用 shell。
- **根因(已定位)**:`permission.ts:330` `require("node:path")`、`:402` `require("node:fs")`,以及 `path-policy.ts:146/196`、`permission.ts` 等共 **9 处裸 `require()`**。注释称为"浏览器 shim 做 lazy require",但 **desktop main 是 ESM bundle(`--format=esm`)**,ESM 里 `require` 未定义→审批/路径策略一走到这里就抛。与既往 RunLock ESM bug 同源(那次已用 createRequire 修,这几处漏改)。
- **期望**:受限权限触发审批、批准后工具继续执行,不报错。
- **状态**:🟢 已修(2026-06-09,**beta1 阻塞已解除**)
- **截图**:`docs/assets/beta1-smoke/step11.png`、`step12.png`
- **日志证据**:session `s-mq6e5xim-e652e9fc`,`desktop-2026-06-09.log:11605/11607/11645` —— Glob/Read 工具返回 `error:"require is not defined"`;读 `~/.code-shell`(cwd 外)触发 path-policy 工作区外检查时炸。
- **备注**:修了 core 全部 9 处裸 `require()` → `path-policy.ts`(2 处,顶部已 import fs,改静态 import)+ `permission.ts`(2 处,改静态 `import {resolve,dirname}`/fs)+ `updater.ts`(3 处)+ `provider-auth.ts`(1 处)+ `pluginInstaller.ts`(1 处)用 `createRequire(import.meta.url)`/已有静态 import。验证:core tsc 绿、tool-system 266 pass、grep 残余裸 require 为空。同源既往 [[project_runlock_esm_bug]]。

### 🟢 [2026-06-09] 后台 shell 卡片状态不更新、输出不回流
- **现象**(#7):`sleep 5 && echo done` 卡片显示 `exit 0` 却又标 `status=running` + `(无输出)`;刷新也没用。
- **根因(已定位,两处叠加)**:core 后台 shell 实现本身正确(`background-shell.ts` 单测过),但**注册表是 worker 进程内存态、退出不发事件、面板只能 poll 活 worker**。
  - **缺陷 A(深层设计)**:`background-shell.ts` 的 `this.shells` 与 `RingFile.buf` 全在 worker RAM;`child.on("exit")` **不发任何协议/流事件**,只 `notificationQueue.enqueue`(仅活跃 turn 才 drain)。worker 回收(干净退出/空闲/崩溃/重开 app 后没再 spawn)→ 整个注册表+ring 丢失。唯一恢复 `reapOrphansFromPidfiles()` 只找进程组**还活着**的、且重建为 `status:"orphaned"` + **全新空 ring**(`RingFile` 用 `"w"` 模式→`readAll()===""`→`(无输出)`),已结束的 `sleep 5 && echo done` 则连 pidfile 一起删、shell 直接消失。
  - **缺陷 B(直接症状,最高价值)**:`agent-bridge.ts:216-225` 当无活 child 时**静默丢弃** `agent/backgroundShells` RPC(且只有 `agent/run` 才 spawn worker,开/刷面板不会复活);丢弃的 RPC 无 reply → preload `rpc()` 挂满 30s 后 reject;面板 `BackgroundShellPanel.tsx:28-30` 的 catch **只 set error、从不清 `shells`/`output`** → 上次抓到的 `running` 行 + `exit 0` header 冻在屏上,再刷新还是丢→还是 stale,即「刷新也没用」。
- **状态**:🟢 已修(2026-06-09)
- **截图**:`docs/assets/beta1-smoke/step07.png`
- **备注**:已修 = ①(缺陷B)`agent-bridge` 无 worker 时对只读的 `agent/backgroundShells` **回 `{shells:[]}` reply** 不再丢弃(`attachIpcListener`)+ 面板 `refresh` catch 清 `shells`/`selected`/`output` 防 stale 行(成功路径也清掉已消失的选中项);②(缺陷A 廉价半)`reapOrphansFromPidfiles` 重建 orphan 时把 ring 指向**已存在的 `.log`**(新增 `RingFile(path,cap,readonlyExisting=true)` 只读载入不 truncate)而非开空 `.orphan`,recovered shell 现能显真实输出。**仍搁置**(缺陷A 深层):`child.on("exit")` 推流事件让卡片不靠 3s poll 即 finished(现有 poll 已够解症状)。测试:ring-file 8 pass、bg-shell 11 pass、sessions/mobile 等绿;desktop+core tsc 绿。与记忆 [[project_background_shell]]「增量游标用绝对位置」相关。

### 🟢 [2026-06-09] 审查面板:无删除/历史轮、铺开太满、分支对比卡死无法滚动(部分,新特性搁置)
- **现象**(#5):① 本轮改动只看到"改了什么"(绿色新增),**没有删除、没有上一轮已编辑的对比**;② diff 全部平铺,期望改成**下拉选择**切换更清爽;③ 点「分支 vs base」**卡住且无法滚动**——期望是选两个分支对比 / 按 commit 选;④ 长时间后进程 **V8 OOM**(800MB,`Mark-Compact`→`process OOM`)。
- **根因(已逐项定位)**(面板 = `panels/ReviewPanel.tsx` + `diff/*`,本轮快照由 `messages/fileChangeAggregator.ts` 端内合成):
  - **①(真 bug)本轮 diff 是按工具 args **合成**的、非真 git diff,且有损**:turn scope 直接渲 `turnDiff`(`ReviewPanel.tsx:128-132`),它来自 `fileChangeAggregator`。`Write` 分支(`:157-164`)`oldText` 写死 `""`、status `"added"` → **覆盖已存在文件也只出 `+` 行**(就是"全绿无删除");`Edit` 的 `syntheticSnippetDiff`(`:192-216`)是"全删行再全加行"无 LCS,改一字也重印整块;聚合只从**末条 user message 到末尾**走(`:231-237`),**无本轮起始基线**,跨轮累积看不到。
  - **②(交互)平铺**:`UnifiedDiffViewer.tsx:56-62` 把每个文件 diff 全平铺;turn scope 还**完全忽略 `selectedFile`**(`ReviewPanel.tsx:128-132` 是整 blob);左侧 `ChangedFilesList` 是窄边栏按钮列非下拉。【已修:turn scope 右上加 shadcn SimpleSelect 选单文件,`UnifiedDiffViewer` 加 `onlyPath` 过滤;>1 文件才显示下拉】
  - **③(卡死)分支 scope 把整段 `main...HEAD` 不带文件过滤渲成一张无虚拟化大表**:切 scope 时 `selectedFile` 重置 null(`:93-94`)→ `file=undefined` → `getGitRangeDiff(cwd,"main...HEAD")`(`desktop-services.ts:428-441`,上限 32MB)整段返回 → 解析成**一行一 `<tr>` + 每行 hover 评论按钮**的巨表(`UnifiedDiffViewer.tsx:78-139`,**无 react-window 虚拟化**),同步渲染阻塞主线程 = "卡死",滚动事件也处理不了 = "无法滚动"。"选两个分支/按 commit"是**新特性**(`getGitBranches` `:181` 已有可喂)。
  - **④(OOM)面板常驻不卸 + 大 diff 无界 DOM/state**:`PanelArea.tsx:254-264` 所有面板 `display` 切换**永不 unmount** → `UnifiedDiffViewer` 的 `diff: DiffFile[]`(含每行文本)+ 每可见行的 `useState` 终身存活;`turnDiff` 随会话 join 增长存进 `App.tsx` `reviewDiff` state 反复重解析;index key(`:59`/`:79`)妨碍 GC。与 #1 dup-key **非同一处**但都加剧。
- **状态**:🟢 已修(2026-06-09 + 2026-06-11 大改;①交错+删除、③④渲染上限 已修;②③ 2026-06-11 重做对齐 Codex/GitLab:去左栏全宽 diff + 长行横向滚动 + 每文件可点折叠 + 范围改下拉 + 未暂存/已暂存/全部分别真 git diff + **「按 commit」做了**(提交二级子菜单列最近 commit)+ 文件状态符号化 + 路径前面省略)。**仍留后**:真 git 基线(Write args 无旧内容)、行级虚拟化、「选两个分支对比」。
- **截图**:`docs/assets/beta1-smoke/step05.png`
- **备注(已修汇总,2026-06-09)**:① `syntheticSnippetDiff` 现裁掉公共前后缀行→增删**交错**(改一字读作 ctx·-old·+new·ctx,不再全删全加),删除行正常显示(新增单测:Edit 删行经 `parseUnifiedDiff` 出 `del`);③④ `UnifiedDiffViewer` 加 `MAX_RENDERED_LINES=2000` 渲染上限 + `capFiles` 按文件截断 + 超限提示「请选单文件」(解 hang/OOM,免去 32MB 整段巨表),file/hunk key 改稳定值;② turn scope 加 SimpleSelect 文件下拉 + `onlyPath` 过滤。**搁置**:真 git 基线(本轮起记 HEAD/blob SHA 走 `git diff <preTurnRef>` 才能精确对比 Write 覆盖的旧内容——`Write` args 无旧内容,纯渲染层修不彻底)、行级虚拟化(react-window;现用渲染上限替代足够解症状)、「选两分支/按 commit」新特性。desktop tsc 绿、diff/aggregator 测试全过。

### 🟢 [2026-06-09] 权限档位在 session 间"粘连"被带回
- **现象**(#11):默认权限的 session 读 repo 外报错→切到一个"完全编辑权限"的 session→再切回来,原 session **变成了完全编辑权限**。
- **根因(已定位,非"全局态"而是"共享草稿桶")**:档位其实是 **per-bucket** 的(`App.tsx:226` `permissionOverrides: Record<bucket, mode>`,读 `:260`,写 `:1935-1946`),Pill 是受控组件无内部全局态。真凶 = `bucketKey`(`transcripts.ts:88-90`)把所有**草稿/新对话**(`activeSessionId===null`)塌缩成 `<repoKey>::_none_` 这**一个 per-repo 共享槽**,而 `permissionOverrides` **只写只读、从不清除/迁移**。在任一草稿 tab 选「完全访问」→ 写 `_none_` 槽 → 该 repo 下**每个草稿共享**且**永久**;「新对话」又把 `activeSessionId=null` → 同 `_none_` 桶 → 陈旧 `bypass` 还在,新草稿/切回来就成了完全权限。`onGoalToggle`(`:1948-1956`)开 Goal 也写 `bypass` 进 `_none_`,雪上加霜。
- **次因(后端,顺修)**:`chat-session-manager.ts:46-61` `getOrCreate` 对**已存在** session 提前 return、**丢掉 `slice.permissionMode`** → 在已跑 session 改 Pill 再发,引擎实际档位**不更新**(停在首建时的)。
- **状态**:🟢 已修(2026-06-09)
- **备注**:已修 = ①(主,renderer)`send()` 首发把草稿 `_none_` 槽的 permission/goal override **迁到真 bucket** 再清掉 `_none_`(选择跟随该 session);`handleNewConversationForRepo` 进新草稿时清 `_none_` 槽(各草稿不再串档)。②(次,core)`getOrCreate` 对已存在 session return 前 `if (slice.permissionMode && 现≠新) engine.setPermissionMode` → 改 Pill 下一轮真生效(`setPermissionMode` 已会 reconfigure 活 backend)。core 已 rebuild。测试:protocol 22 pass。与 #11 require 报错是同截图两个独立问题,分开记。

### 🟢 [2026-06-09] 回答里点文件路径用了系统默认应用,而非内置文件面板
- **现象**(#13):点 assistant 回答里的文件路径,**自动用系统默认应用打开**,没走内置文件系统面板。
- **根因(已定位,缩小到图片路径)**:普通文本路径其实**已正确**——`Markdown.tsx` 的 `PathLink`(:225-248)平点 → dispatch `codeshell:open-file` 走内置面板,⌘/Ctrl 点才 `openPath` 走 OS。真正出错的是**被判为图片的路径**(`classifyPath()==="image"`)走 `InlineImageLink` 而非 `PathLink`,其文件名 caption 与失败 fallback 链接(`:314`/`:332-335`/`:356`)**裸调 `openPath`、无修饰键判断**,平点就进系统默认 app。
- **状态**:🟢 已修(2026-06-09)
- **截图**:`docs/assets/beta1-smoke/step13.png`
- **备注**:已修 = 抽 `openFileTarget(e, {path,cwd,line,isScheme})` 共享 helper(平点→`codeshell:open-file` 面板 / ⌘Ctrl→`openPath` OS),`PathLink` 与 `InlineImageLink` 那 3 处裸 `openPath` 全改用它(缩略图开 lightbox 不动)。Markdown 6 测试过、tsc 绿。与记忆 [[project_inline_code_path_links]] 相关。

### 🟢 [2026-06-11] 文件改动卡片(FilesChangedCard)的文件名点击仍走系统默认应用(#13 漏网处)
- **现象**:桌面端点「文件改动卡片」里的文件名,**自动用系统默认应用打开**,没进内置文件面板。
- **根因**:#13 当时只修了「回答里 Markdown 路径」,但**文件改动卡片是独立的另一处**——`FilesChangedCard.tsx:154` 文件名 `onClick` **裸调 `window.codeshell.openPath`、无修饰键判断**,平点就进 OS。同 #13 一类、不同组件。
- **状态**:🟢 已修(2026-06-11)
- **备注**:把 #13 的 `openFileTarget` 从 `Markdown.tsx` 内部**提取到共享层 `chat/openWith.ts`**(连带新增 `openInternalPanel` 动作),`Markdown.tsx` 改 import 共享版(删本地重复定义),`FilesChangedCard` 文件名改 `onClick={(e)=>openFileTarget(e,{path,cwd})}`(平点→面板 / ⌘Ctrl→OS)。desktop tsc 绿、Markdown+pathlink 33 测试过、desktop 676 全过。关联 [[project_inline_code_path_links]]。

### 🟢 [2026-06-11] 右边文件面板:AI 更新了文件,面板内容不刷新
- **现象**:右侧文件面板打开某文件后,AI 在对话里改了这个文件,**面板还显示旧内容**(不刷新);目录新增/删除文件也不反映。
- **根因**:`FilesPanel` 是**纯 pull、读一次、无变更信号**——`TextPreview`/`ImagePreview` 的 `readFileContent` 只在 `[root,path]` 变时跑,同一文件被外部改动无感知;`DirNode.readDir` 同理只在 `[root,dir]` 变时跑。与「后台 shell 不回流」同类病。
- **状态**:🟢 已修(2026-06-11,按方案:挂文件改动事件 + 手动刷新按钮)
- **备注**:已修 = ① `App.tsx` 在(agentId-less 的)`turn_complete`/`error` 处 `dispatchEvent(codeshell:files-changed)`(轮结束=文件已落盘的信号,同 `codeshell:open-file` 事件风格,纯 renderer);② `FilesPanel` 加 `reloadNonce` state,监听该事件 +1,并加**手动刷新按钮**(RefreshCw)兜底;nonce 串进 `DirNode.readDir`(目录增删反映)与 `FileViewer`→`TextPreview`/`ImagePreview` 的读取 effect deps(重读当前文件)。坑:同文件 reload 不能 blank 成「加载中…」(否则每轮闪空)→ 拆成「path 变才清空 / reload 只就地换内容」两个 effect。desktop tsc+build:renderer 绿、676 测试全过。

### 🟢 [2026-06-11] 回答里「裸文件名」点不动(对齐 Codex 的路径链接)
- **现象**:用户看 Codex 截图里正文写 `remote-host-manager.ts (line 147)`、`dev.ts (line 53)` 这种**裸文件名**就是可点蓝链接,问 codeshell 为什么没有、是不是 prompt 写的。
- **核实(非 prompt)**:链接是 `markdown/remarkPathLinks.ts`(remark 插件,已接进 `Markdown.tsx:92` 管线、assistant 回答走 `AssistantMessageView`→`Markdown`)**自动识别路径文本**生成的,与 prompt 无关。真因=codeshell 的 `BARE` 正则**强制要求路径含 `/`**(目录),正文里的裸文件名(无目录、非反引号包裹)不认;反引号包裹的裸文件名(`` `dev.ts` ``,走 `INLINE_CODE_PATH_RE`+白名单)本就认。验证:`packages/.../x.ts:147` / `x.ts (line 147)`(带目录)✅,`remote-host-manager.ts (line 147)`(裸名)❌。
- **状态**:🟢 已修(2026-06-11,用户选「放宽但限定白名单扩展名」)
- **备注**:已修 = 给 `PATH_LINE_RE` 加第三个分支 `BARE_FILENAME`(`name.ext` 无目录,支持 `:line` 与 `(line N)` 两种后缀),match 后用 `bareFilenameExtOk()` 按现成 `KNOWN_FILE_EXT` 白名单过滤——`dev.ts`/`package.json`/`vite.config.ts` 认,`v1.2`/`obj.method`/`Array.from`/`README`(无扩展)不认(与 inlineCode 同一守卫);leading 边界禁前导 `/`·`.` 避免重复捕获 `a/b.ts` 的尾巴;白名单不过的 match 回吐成纯文本不静默丢弃。新增 7 个用例(链接裸名+CJK 边界+(line N)+白名单负例),Markdown/pathlink 40 过、desktop tsc+682 全过。关联 [[project_inline_code_path_links]]。

### 🟢 [2026-06-09] 文件面板里 README 的图片不渲染(本地相对路径 + 原始 HTML)
- **现象**:在 app 内置文件面板预览 README,顶部 `<p align="center"><img src="docs/images/codeshell-dog-icon.png" …></p>` 的图**不显示**(图片文件确实在)。
- **根因(已定位,两叠加)**:① `FilesPanel` 渲染 md 时 `<Markdown text=… />` **没传 cwd** → 相对图路径无法解析(且 renderer 不能走 `file://`,CSP `img-src 'self' data:`,本地图须经 `images:readDataUrl` 转 base64,见 #13/[[project_inline_code_path_links]]);② README 用的是**原始 HTML `<img>`**,而 `Markdown` 没装 `rehype-raw` → react-markdown 默认丢弃原始 HTML,`img` 组件 handler 根本不触发。
- **状态**:🟢 已修(2026-06-09)
- **备注**:已修 = ① `Markdown` 加 `rehype-raw`(解析原始 HTML)+ `img` handler 把**普通相对/本地 src** 也路由到 `InlineImageLink`(经 cwd 解析 + readDataUrl;`data:`/`http(s)`/`blob` 仍走普通 `<img>`);② `FilesPanel.TextPreview` 传 `cwd=该文件所在目录`(新 `mdBaseDir` helper)。**安全加固(关键)**:同一个 `<Markdown>` 也渲染**不可信的 LLM/assistant 输出**,放开原始 HTML = XSS 面 → 加 `rehype-sanitize`(order: raw→sanitize→highlight),schema 从 rehype 安全默认扩展:放行 README 用的 `img width/height/align`、`p/div/span align`、highlight.js 的 className,以及**自有 `codeshell-path:` 协议**(否则 path-link 被 sanitize 掉)。新增单测:README 原始 HTML 相对图经 InlineImageLink 渲染、远程图保持普通 `<img>`、`<script>`/`onerror`/`<iframe>` 被剥离(XSS guard)。Markdown 10 测试过、desktop 550 过、tsc+build 绿。新依赖 rehype-raw@^7 / rehype-sanitize@^6。

### 🟢 [2026-06-09] 启动白屏久 + 控制台重复 key 报错 + 疑似渲染泄漏
- **现象**(#1):启动时白屏太久;控制台刷 `Encountered two children with the same key, call_xxx`(`TurnProcessGroupCard.tsx:70`),多个 tool call 用了相同 key。
- **状态**:🟢 已修(2026-06-09)。治本=`mergeTranscripts` 拼好后**按稳定 id 去重**(新单测:同 id args 漂移不再双发);治标=`TurnProcessGroupCard` map 前 `dedupeById`。mergeTranscripts 15 测试过、tsc 绿。下面是根因记录↓
- **根因(已纠正——不是流折叠 post-pass)**:折叠管线(`buildStreamItems`/`foldAdjacentTools`/`foldTurnProcess`/`foldAgentGroups`)与 live reducer(`types.ts:377-413` `tool_use_start` **已有按 id 幂等守卫**)都干净,**不会**塞两次。重复 id 来自**更前面的 session-hydrate 合并**:`App.tsx:510-514` 把 disk 折叠与 local live tail 拼成 `[...disk.messages, ...liveTail]`(`mergeTranscripts.ts:95`),**去重用内容签名 `tool|${toolName}|${args}` 而非 id**(`:30-31`)。但工具 **id 跨 disk/live 稳定**(都是 `call_xxx`),`args` 快照却会漂(live `tool_use_start` 带部分/空 args 后续靠 `argsLive` 补、JSON key 序/空白差异)→ 签名不匹配 → live 副本当未覆盖留在 `liveTail`、disk 副本也在 `disk.messages` → 同一 `call_xxx` 进 `messages` 两次 → 落进一个 `turn_process_group.items` → `TurnProcessGroupCard:70` 重复 key。正解释了"automation session 反复重开、同一 `call_h5XLA...` 横跨 5+ 小时报、卡片卡死"。
- **备注**:治本 = `mergeTranscripts` 拼好后按**稳定 id 去重**(`const seen=new Set(); messages=messages.filter(m=>!seen.has(m.id)&&(seen.add(m.id),true))`——只有 user/files_changed/goal 等用 fresh id 的本就内容键控、不会撞 id,安全);或把 tool 签名改成有 id 时用 id。治标(防御)= `TurnProcessGroupCard`(连带 MessageStream/ToolGroupCard)map 前按 id 去重 / key 改 `${m.kind}-${idx}-${m.id}`——挡住 React 崩白屏但不消重卡,需**与治本一起**。OOM(#5④)另见审查面板,非同一处。

### 🟢 [2026-06-09] automation「update memory」工具卡一直显示/不收口(= #1 同根因实锤)
- **现象**:automation 美股晨报 session(`0hgSIulvUL97CKvJ`)的 `UpdateAutomationMemory`(UI 显示"update memory")卡片**一直显示、不收口**,反复打开该 session 都在。
- **根因(实锤)**:该工具 call id `call_h5XLA2zR6hB0XHku81IAeRCg` 在 desktop 日志里**从 00:37 到 08:50 横跨 5+ 小时反复报** `Encountered two children with the same key, call_h5XLA2zR6hB0XHku81IAeRCg`(`TurnProcessGroupCard.tsx:70`)。session 本身 01:23 已正常 `turn_complete`+`session_title`,核心流程完结;是**渲染层 key 冲突**让卡片无法稳定 reconcile→卡住/重复,看起来像"一直在 update memory"。
- **状态**:🟢 已修(2026-06-09,与 #1 同根因一起修:mergeTranscripts id 去重 + TurnProcessGroupCard `dedupeById`)
- **日志证据**:`desktop-2026-06-09.log` 多行(2688/13294-13311 …);`engine-2026-06-09.log:307` UpdateAutomationMemory tool.exec.end ok=true(后端成功,纯前端渲染 bug)。
- **备注**:automation session 更易触发重复 id(每次回看 replay 重建 group);修 key 后这两条一并验。

### 🟢 [2026-06-09] 图片附件:缩略图不能放大、放大后有两个叉
- **现象**(#6):输入框里的图片缩略图没法点开放大;放大(lightbox)后出现**两个关闭叉按钮**。
- **状态**:🟢 已修(2026-06-09)
- **备注**:已修 = ① 两个叉真因 = `Lightbox` 自身渲染了两个关闭按钮(工具栏内 `:182` + 浮动 fixed `:219`)→ 删掉浮动那个 + 清理死 CSS(`.lightbox-close` 全删,含 <720px media query);② ChatView 附件缩略图加 `onClick` → 打开 `Lightbox`(gallery 走全部 attachments,与 MessageStream 一致)。narrow-layout 测试改为断言「无 .lightbox-close 残留」,desktop 551 过、tsc+build 绿。

### 🟢 [2026-06-09→06-11] Undo 是文件维度整体回滚,非按对话轮 → 已改轮级
- **现象**(#8):一次 undo 成功;但分两轮改的内容,undo 第一轮时**直接回滚了文件**(文件维度),而非按那一轮的改动粒度。问:codex 怎么做的?
- **调研(2026-06-11)**:**codex CLI 根本没有 undo** —— 它曾有实验性 `/undo`,因"用得少、设计给很多用户造成问题"被官方移除,`/rewind`/rollback 请求也被 closed as not planned,现在纯靠 git + 让模型自己撤。所以 codex **不是参考对象**。真正该对齐的是 **Claude Code / Cursor 的「按 prompt/轮」语义**(自有文件快照、不依赖 git)——而我们的 `FileHistory` 架构跟 Claude Code 同构,只差给快照打"轮"标签。
- **状态**:🟢 已修(2026-06-11;**CLI 单步轮级 + desktop 轮级 undo/redo** 都已做。连撤多轮 UI / CC 的「仅代码|仅对话|都恢复」三档仍留后)
- **desktop 轮级 undo + redo(2026-06-11 续做)**:文件改动卡片(FilesChangedCard)原走 `git restore HEAD`(整份回 HEAD、不分轮、依赖 git)——这才是用户当初觉得"文件级"的真根源。改走 core FileHistory 轮级快照(方案 A,与 CLI 同源)。调研确认 codex/CC/Cursor 撤销都是「剥洋葱式只能从最新往旧」,无人能撤中间轮(快照固有限制),所以只最新一轮卡片可撤、旧卡片置灰提示。**core 改 undo 语义**:`undoLatestTurn` 从「删该轮快照」改「标 `undone:true` + 存 redo 素材」(删了 redo 没素材;CLI 剥洋葱靠 `latestTurnUndoTargets`/`earliestSnapshotsPerFile` **跳过 undone** 保住);新增 `latestRedoTargets`/`redoLatestTurn`/`recordCreated`(engine hook 在 saveSnapshot 返 null=本轮新建时记,**撤销删该文件、redo 重建**——用户决策);on-disk index 升 v2 `{snapshots,redoRecords,created}`、兼容 legacy 裸数组。**四层接线**:新 IPC `files:{turnUndoState,undoTurn,redoTurn}`(按 sessionId 非 cwd,内部恒操作最新轮→卡片无需传 turnSeq,绕开 renderer turnEpoch≠core turnSeq 失配)→ preload → MessageStream 算 `lastFilesChangedId` 判 `isLatest` + 喂 `engineSessionId`(App→ChatView→MessageStream→card)→ 卡片 undo↔重新应用切换,on-mount 查 turnUndoState 恢复刷新后状态。redo 有效期=撤销后一直可点直到发新消息(新 live 轮使 latestRedoTargets 返 [])。测试:core session 52 + 1134 全过、desktop 685 全过(card 新 5 例)、四层 tsc+build:renderer 绿。关联 [[project_undo_turn_level]]。
- **备注**:已修 = ① `SessionState.turnSeq`(一次 user 发送 = 一轮,区别于 `turnCount` 的 turn-loop 迭代数),`engine.run` 入口两路径汇合处 +1;② `FileSnapshot.turnSeq` + `saveSnapshot(path, turnSeq?)`,`file_history_backup` hook 读 `session.state.turnSeq` 打标(dedup 改 per-turn:同内容跨轮要记新基线);③ 纯函数 `latestTurnUndoTargets`(取最大 turnSeq 那轮、每文件**轮内最早**快照→轮内重复改也回到轮始基线;`turnSeq ?? -Infinity` 让 legacy 无标快照退化成整会话不崩);④ `FileHistory.undoLatestTurn(targets)` restore 后**按 turnSeq 删掉该轮全部快照**(否则快照永不消费=连撤同一轮;**坑**:restore 会先无标 saveSnapshot 备份当前内容,所以靠删标签而非时间戳消费),下次 `/undo` 自动剥上一轮;⑤ `/undo` 默认从单文件改「撤最近一轮所有文件 + 多文件 diff 预览」,`/undo all` 不动。测试:undo-target 13 + undo-integration 5(含两轮剥离 e2e)、core 1116 全过、tui tsc 绿、core 已 rebuild。关联 [[project_undo_turn_level]]。

### 🟢 [2026-06-09] 右上角图标不更新
- **现象**(#10):某操作后右上角图标没更新(状态未刷新)。
- **核实(2026-06-09,未能复现)**:右上角只有 2 个东西——StatusBadge busy/idle 点 + 面板开关按钮。逐一查证:① busy 点的清除路径**健壮**(`App.tsx:1140` `turn_complete`/`error` 且 `!agentId` → `setBusyForKey(target,false)`,且 route-table miss 有 `runningBucketRef` 兜底 :1066-1071;子 agent 的 turn_complete 带 agentId 被正确排除,不会误清/误标),没找到 mis-key;② 面板按钮 active 态 = 直接读 `panelRequest.open`,与开关同一布尔,截图里显示正确(高亮)。截图 step10 本身是**已完成/idle**态(SKILL 轮"已处理 6m29s"已收口),看不到卡住的帧。**结论:现有证据无法确认根因,不臆测修。**
- **附带修(确有的潜在 desync)**:dock 内部用 tab-X 关面板时 `onClose` 只 set `open:false`、**漏 bump nonce + 漏清 kind**,与 `togglePanel` 契约不一致(`App.tsx:2263`)→ 已改成与 togglePanel 一致(bump nonce + kind:null)。这条不直接对应"图标不更新"(按钮读 .open 仍正确),但是真实潜伏 desync,顺手修掉。
- **状态**:🟢 已结(2026-06-11 用户确认不用管了;潜在 desync 此前已修,主症状未复现亦不再追)
- **截图**:`docs/assets/beta1-smoke/step10.png`
- **备注**:潜在 desync(dock tab-X 关面板漏 bump nonce/清 kind)已修。主症状无法复现,用户已确认无需继续。

### ✅ 通过项(无须处理)
- #2 新会话对话 ✅ ｜ #3 模型切换 ✅ ｜ #4 文件编辑 ✅ ｜ #9 设置页按项目选配置 ✅

---

## 🧭 引导 / 打断当前轮插入新 message 的渲染问题(2026-06-09)

### 🟢 [2026-06-09] 打断旧轮、插入新 user message 后,缺「正在思考」态
- **现象**:引导/对话中打断当前轮(ChatView 的「打断当前轮并发送这条输入」`ChatView.tsx:875`/`:595`),插入新 user message 后,**新一轮没有显示「正在思考」**(LiveActivityLine 该出的 live 态没出)。
- **根因(已定位)**:thinking 行 `LiveActivityLine` 只在 `liveTurnActive = busy && state.streamingAssistantId !== null`(`App.tsx:2144`)时渲染。`streamingAssistantId` 只由 `stream_request_start` 置(`types.ts:315-324`),由 `turn_complete`/`error` 清(`:740`/`:761`),**`appendUserMessage` 不碰它**。打断接力路径(`forceSend`/`guideActiveQueuedInputAt`,`App.tsx:1444-1460`)= 入队 + `stop()`;`stop()`(`:1462-1493`)`setBusyForKey(false)` + dispatch `turn_end(stopped)`,但 **`turn_end` 不清 `streamingAssistantId`**(仍是旧轮的非空 id)。随后 drain effect(`:1431-1438`)`send()` 起新轮。被取消轮的尾部 abort `turn_complete`/`error` 此时才到、把 `streamingAssistantId` 清成 null,而新轮自己的 `stream_request_start` 可能还没来 → `busy && id!==null` 为 false → 不亮思考态(且存在清/置交错的竞态)。正常发送无此问题:上一轮已干净 `turn_complete` 清了 id,无迟到事件来踩。
- **状态**:🟢 已修(2026-06-09)
- **备注**:已修(方案 A)= ① `appendTurnEndMessage`(types.ts,turn_end reducer 路径)清掉 `streamingAssistantId`/`streamingThinkingId`(消灭陈旧非空 id);② `App.tsx` 抽 `liveTurnActive = busy && (streamingAssistantId!==null || 末条是 user)` 传给 ChatView——接力轮一 busy 就出"正在思考…"。types/streamGroups/mergeTranscripts/MessageStream/LiveActivityLine 78 测试过、tsc 绿。`LiveActivityLine.tsx` 未动。

### 🟢 [2026-06-09] session 标题不落盘 → 重开/replay 后标题没了(automation 尤其明显)
- **现象**:automation 触发的 session 之前有标题,现在没了(session `Rm3ROU7XiwPZcrDn`)。
- **根因(已纠正——LLM 标题其实活在 localStorage,只是不落盘)**:`engine.ts:1847-1874` 标题生成后**只 `onStream({type:"session_title"})`**、从不写 state、不落盘;`SessionState`(`types.ts:122-148`)**无 `title` 字段**(但有 `summary?: string`,:145,承载侧边栏标签)。**纠正"全部 title:None"的误判**:冷启时 `engine.ts:1246-1253` **会**写 `state.summary = 首条 user message(截 80 字)` 并 `saveState`(实测 state.json 有 `summary`)——只是没存 **LLM 生成的标题**。LLM 标题经 `App.tsx:1096-1110` 的 `session_title` handler → `renameSessionLocal` → `saveSessionIndex` 写进**渲染端 localStorage**,所以普通刷新它**在**;但 localStorage 被清(="disk作权威源恢复"路径)或走磁盘 rebuild(`sessions-service.ts:147-151` `title: state.summary || id`)时,LLM 标题没了——因为它从没写进磁盘。`session-titles-store.ts` 只接 `sessions:rename` 给调试用的 SessionsView,**不参与**自动标题流,别在它上面修。
- **次因**:标题生成在 `.then` 异步回调里,而 `engine.ts:1892` 紧接着就把 `session.state` 落盘了 → 即便想写 state 也已错过这次落盘,`.then` 里需**自己再 `saveState`**。
- **状态**:🟢 已修(2026-06-09)
- **日志证据**:`desktop-2026-06-07.log:8035` session_title 事件确实发了;state.json 有 `summary`(首条消息)但无 LLM 标题。
- **备注**:已修 = ① `SessionState` 加 `title?: string`;② `engine.ts` 的 `buildSessionTitle().then` 里 `session.state.title = title` + **自己 `saveState`**(因 .then 在 :1892 落盘之后才 resolve);③ `sessions-service.ts` 回填改 `title: state.title || state.summary || id`(`rebuildFromDisk` 读 `s.title` 自动跟随)→ 磁盘 rebuild 也能出 LLM 标题;`App.tsx:1096` localStorage 快路径不动。core 已 rebuild;sessions/rebuild 16 测试过、core+desktop tsc 绿。关联记忆 [[project_session_title_llm]]。

### 🟢 [2026-06-09] 被打断的那一轮不该显示「已处理 Xs」折叠头,应直接平铺内容
- **现象**:被打断(stopped)的那一轮,UI 仍套了 Codex 式「已处理 X m Y s ⌄」折叠头(`TurnProcessGroupCard.tsx:48`);期望**被打断的轮不折叠耗时**,直接把已产生的内容展示出来。
- **根因(已定位+证实)**:`TurnProcessGroupCard.tsx:50-62` 无条件给 turn_process_group 渲染耗时头(`label` 由 `:48` `processGroupLabel(elapsedMs)`)。被打断时 `stop()` 先 `setBusyForKey(false)` → `liveTurnActive` 转 false → 该轮走**闭合轮折叠路径** `foldTurnProcess` 折成普通耗时组,而 `turn_end(stopped)` 作为**平级兄弟消息**落在组**外**(由 `TurnEndMessageView.tsx:18-28` 渲成"你在 Ns 后停止了")。组的数据结构(`streamGroups.ts:49-80` `TurnProcessGroup`)**没有 stopped/reason 标志**,所以它不知道该轮被打断,照样套耗时头。
- **状态**:🟢 已修(2026-06-09)
- **备注**:已修 = ① `streamGroups.ts` 给 `TurnProcessGroup`/`Rendered…` 加 `stopped?: boolean`;`foldTurnProcess` 用新 `turnWasStopped()` 扫该轮 slice 尾部 `reason==="stopped"` 的 `turn_end` 置 `stopped:true`,并加进 `groupSignature` 防 reconcile 复用;② `TurnProcessGroupCard` `group.stopped` 时 `showHeader=false`、直接平铺 items;③ 停止标记仍由 `TurnEndMessageView`(组外)单独出,卡片内不重复。streamGroups 19 测试过(含 2 个新 stopped 用例)、tsc 绿。

### 🟢 [2026-06-09] 输入框被面板挤压时样式崩坏,缺最小宽度 + 底部控件压缩态
- **现象**:打开侧边面板后聊天区/输入框被挤窄,输入框还继续压缩、底部那排控件(权限选择/Goal/附件/模型)挤成一团,样式很难看。
- **期望**:① 输入框(及其容器)有**最小固定宽度**,压到阈值就不再缩(宁可面板那侧让位/横向滚动,也别把输入区压烂);② 底部控件设计**压缩态(窄屏)样式**——例如 `PermissionPill` 窄屏时**只显示 tone 颜色 icon、隐藏文字**(组件里已有 `h-2 w-2 rounded-full` tone 圆点 `PermissionPill.tsx:128`,把它提到收起态、用 `@container`/断点隐藏 `:107` 的 `<span>{label}</span>` 即可);Goal/模型同理可降级为 icon-only。
- **状态**:🟢 已修(2026-06-09)
- **备注**:已修 = composer 卡片(`ChatView.tsx`)加 `@container min-w-[300px]`(容器查询基准 + 最小宽度,`<main>` overflow-hidden 让面板侧让位);`PermissionPill` 窄屏(`@max-[480px]`)收起 label、露 tone 圆点,`GoalToggle`/`ModelPill` 窄屏 icon-only。用 **Tailwind v4 容器查询**(`@max-[480px]:` → 编译成 `@container not (min-width:480px)`,已验证进 CSS),按 composer 实际宽度切而非视口。desktop 551 过、tsc+build 绿。

### 🟢 [2026-06-09] 已删除的项目目录(resume-plugin)反复"复活"为空壳,重启又出现
- **现象**:用户删了 `resume-plugin` 目录(两处:`代码学习/resume-plugin`、`代码学习/writeflow/resume-plugin`),但侧边栏/项目列表反复出现,重启后磁盘上又冒出来。
- **根因(已定位+补全,两套独立机制)**:目录被**重建成空壳**。**机制 A(磁盘复活)**:往 `<cwd>/.code-shell/` 写时 `mkdirSync(..., {recursive:true})`,cwd(=已删 resume-plugin)不存在时 recursive **连父目录 cwd 一起建**。两处现有 `existsSync(dir)` 守卫**无效**——它判的是 `.code-shell` 而非 cwd,cwd 没了守卫为假照样 mkdir。**全部 4 个 cwd 下 mkdir 站点**:`config.ts:70`(裸,无守卫)、`path-policy.ts:201`(recordPathApproval 项目级)、`permission.ts:405`(persistProjectRule)、`settings/manager.ts:288`(saveProjectSetting via projectSettingsPath)。**机制 B(侧边栏复活,即便没磁盘写也会)**:`sessions-service.ts:105-157` 列 session **不按 `existsSync(cwd)` 过滤** → 2 个指向 resume-plugin 的 completed session 总被返回 → `rebuildFromDisk.ts:38-40` 对"删了的真目录" `isNoRepoCwd` 为假、匹配不到 repo → `createRepoForCwd`(`repos.ts:164-173`,**只查 localStorage removed 名单、无 existsSync**)塞回侧边栏。`recents.json`/`trust.json`(`recents-store.ts`/`trust-store.ts`)读时也**无 existsSync 过滤**。
- **状态**:🟢 已修(2026-06-09)
- **证据**:磁盘两空目录;`recents.json`/`trust.json` 均含 resume-plugin 路径;2 个 session state.cwd 指向它。
- **备注**:已修 = ①(磁盘,core)4 个站点 mkdir 前判**父 `existsSync(cwd)`**:`config.ts`(返回 "does not exist" 错误)、`path-policy.ts`/`permission.ts`(best-effort `return`)、`settings/manager.ts saveProjectSetting`(`return`,空 cwd 仍按原 boundary throw)。区分合法新项目(cwd 在→照写)与复活已删项目(cwd 没→跳过)。②(加载,desktop)`listDiskSessions` 跳过 `state.cwd` 非空且不 `existsSync` 的(main 有 fs)→ 不再喂给 `createRepoForCwd`;`loadRecents` 读时过滤不存在路径自愈。core 已 rebuild。测试:config 2 新 pass、settings 13 pass、sessions disk 含新「删 cwd 过滤」用例全过(顺修旧 fixture 用真 cwd)、core+desktop tsc 绿。**未做**:trust.json 清理(二级,getTrust 按精确路径查,悬空项无害);boot 一次性 prune(加载侧过滤已足够自愈)。关联 [[project_draft_session_autojump_bug]]、[[project_disk_authoritative_recovery]]。

### 🟢 [2026-06-09] 图片细节(imageDetail / OpenAI detail)设置是否需要优化 — 待讨论
- **现状**:`imageDetail` 是**全局三档枚举** `low｜high｜original`(`types.ts:441`、`schema.ts:477`),仅 OpenAI 兼容路径读取(`openai.ts:731/769` → `mapImageDetailToOpenAI`),Anthropic 不读。全局默认,可被项目设置覆盖。
- **用户疑问**:这个设置是不是该优化了?
- **可能优化方向(待定,需产品决策)**:
  - **A. 默认值/智能化**:多数人不懂 low/high 取舍 → 默认 `auto`(让 provider 自己定)或按"省钱/高清"两档语义化命名,而非裸露 OpenAI 术语;`original` 含义对用户也不直观。
  - **B. 适用范围**:目前只 OpenAI 生效、Anthropic 忽略 → 设置页该**标注"仅 OpenAI 兼容 provider 生效"**(现说明已提,但选了 Anthropic 时该 disable/灰掉该控件,避免用户以为生效)。
  - **C. 粒度**:是否需要"按单张图/按对话"临时调,而非只有全局+项目两层?(大图偶尔要高清,平时省 token)
  - **D. 与 token/成本联动**:high detail 显著增 token;可在控件旁提示成本影响,或与 [[project_llm_retry_maxtokens_bugs]] 的 token 管理联动。
- **状态**:🟢 已修(2026-06-11,升级成 provider 无关「清晰度」+ renderer 降采样)
- **调研(2026-06-11)**:查 Anthropic vision 文档——**Claude 没有 OpenAI 那种 detail 开关**,但按图块计 token(每 28×28px = 1 token,`⌈w/28⌉×⌈h/28⌉`),所以**发送前降分辨率能实打实省 token**(Opus 4.7/4.8 一张图最多 ~4784 token,是老模型 1568 的约 3 倍;官方明说"不需要清晰度就降采样控成本")。
- **备注**:已修 = ① `compress.ts` 加 `ImageDetail`(low|standard|high)+ `capForDetail`(省钱 1024 / 标准 1568 / 高清 2576)+ `alwaysDownsample`(low/standard 连小图也缩,才真省 token);`compressIfNeeded/compressBatch` 收 detail。renderer 发送前 canvas 降采样——**对两家 provider 都生效**(OpenAI 仍额外传 low/high)。② 设置 UI 枚举 low/high/original → low/standard/high,语义化中文(省钱/标准/高清),删「仅 OpenAI 生效」提示。③ core 枚举迁移(types/schema/engine/openai),**四处兜底容旧 `original`→`high`**(schema z.preprocess + engine + App + openai 映射),旧 settings 不报错。Anthropic adapter 不用改(省 token 全靠 renderer 降采样)。测试:compress 11 + core provider/settings 68 + desktop 691 全过;core build + desktop tsc 绿。关联 [[project_llm_retry_maxtokens_bugs]]。

### 🟢 [2026-06-09] 手机遥控:每次扫码都新建一个 browser/(设备),不复用,越积越多
- **现象**:手机遥控里出现一堆 browser;用户每用浏览器扫一次码就**新存一个**,不复用。
- **根因(已纠正——是"受信设备"累积,不是"房间")**:原假设"扫码走 createRoom"**有误**。**扫码/配对从不创建房间**——`createRoom`(`room-manager.ts:85`)只由 mobile UI 里手动点项目(`mobile-ui.ts:666` 发 `room.create`)/桌面 IPC 触发,且**房间本就有 listing + 14 天 idle 回收**(`pruneStaleRooms` `:241-252`,启动时 `index.ts:195-201` 接上),不会无限累积。**真凶在设备层**:扫码 token 一次性(`pairing.ts` consume 即删),每次扫码 client 发 `pair.complete` → `remote-host-manager.ts:147-155` 调 `devices.addDevice`,而 `trusted-device-store.ts:9-20` `addDevice` **每次都 push 全新 `randomUUID()` 设备、不按 `secretHash`/name 去重** → 每次新扫 = 多一个受信设备,无限累积在 trusted-devices JSON。正常回访 client 用 localStorage 存的 `cs.deviceId`/`cs.deviceSecret` 发 `auth.device` 复用,但**重扫二维码时**(URL 带 `?pairing=`,`mobile-ui.ts:547` 无条件优先 pairing token)、或清了 localStorage/换浏览器,就又 mint 新设备且不与旧的对账。
- **状态**:🟢 已修(2026-06-09)
- **备注**:已修(主)= `trusted-device-store.ts` `addDevice` 改按 `secretHash` **getOrCreate**:已有非吊销同 `secretHash` 设备就复用(刷 name/lastSeenAt)而非新 UUID,重扫即复用同行,从根上止住累积。测试:device-store 加 3 个新用例(重加复用 / 不同 hash 分立 / 吊销后重配新行)全过、tsc 绿。**未做(可选优化,非阻塞)**:client(`mobile-ui.ts:547`)优先用存的 `cs.deviceId` 再 auth;设备 prune/批量清理 UI(`revoke` 已有)。**房间无需新增 GC**(已自动回收;记忆 [[project_background_shell]]「idle-sweep 绝不杀」指后台 shell,与房间无关)。

### 🟢 [2026-06-09] 浏览器圈选标注:面板与新窗口不互通 + 再编辑时选区样式不回显
- **现象**:UI 圈选(BrowserPanel 圈选/标注)在**浏览器面板**和**浏览器新窗口**之间**不互通**——各存各的,应该互通共享;且**再次编辑标注时,没把那一块 select 的样式回显**出来(看不到之前圈在哪)。
- **根因(已定位)**:圈选状态 `selecting/picked/markers/editingMarker` 全是 `BrowserPanel.tsx:175-182` 的**组件本地 `useState`**,纯内存、不持久化、不跨实例/跨窗口共享。新窗口(`App.tsx:1829 new-window`,各自独立 BrowserWindow/renderer)起一个全新 BrowserPanel → markers 从空开始,看不到面板里圈的;再编辑时也没有从持久层取回 marker 的选区样式重绘高亮。
- **状态**:🟢 已修(2026-06-09);"跨窗口共享" 经用户澄清**不需要**(见下)
- **用户澄清(2026-06-09)**:归属规则 = **同 url 回显 / 不同 url 各是各的 / 每次聊天发送后又是新的**。这正是现有行为:`visibleMarkers` 按 `m.url===active.url` 过滤(同 url 回显、不同 url 分开 ✓),`codeshell:anchors-cleared`(send 时 `clearAnchors` 派发,`ChatView` send 路径 `onClearAnchors()`)→ `setMarkers([])`(发送即清 ✓)。所以**无需主进程跨窗口大 store**——markers 是 per-轮 + per-url 的临时态,本就该各窗口/各轮独立。
- **备注**:真正缺的只是**编辑回显**(看不到之前圈在哪),已修:`PageMarker` 加 `selector` 字段、圈选提交时一并存;编辑某 marker 时新增 effect 向 guest 页 `executeJavaScript` 按 selector `querySelector` 注入 outline 高亮 + `scrollIntoView`,关闭/切换时清除(selector 不中就 no-op 容错)。tsc+build+551 测试绿。原"跨窗口共享主进程 store"方案**作废**(与用户 per-轮语义冲突)。

### 🟢 [2026-06-09] 本地环境设置:隐藏「清理脚本(cleanup)」UI — 配了不生效会误导
- **现象**:设置→本地环境页有「清理脚本」输入框,但 cleanup **当前不自动收尾运行**(按决策没接),配了等于白配,UI 露出来会让用户以为生效(典型「看起来能配实际没用」半成品)。
- **状态**:🟢 已做(2026-06-09)
- **备注**:`AdvancedSections.tsx` 注释掉「清理脚本」`<LocalScriptEditor>` 卡片 + 移除 `cleanupTab` state + 顶部说明文案去掉 "cleanup"。**保留** `cleanupScripts` state 与保存逻辑(不丢已存数据),接上 cleanup 功能后恢复那段 JSX 即可。desktop tsc 绿。← 配套 §6.5「设置页 scope 收口/避免半成品」的 beta 前清理精神。

### 🟢 [2026-06-09] 钩子设置页能力太弱 + 看不到插件(superpowers)hooks — 已按方案 B 改造
- **现象**:设置「钩子」页好像什么都干不了;按理应该能看到插件提供的 hooks 来管理,但 superpowers 等插件的 hooks 根本看不见。
- **核实(2026-06-09)**:
  - **手写 project hook 其实生效**(`ProjectHooksEditor` 读写 `<repo>/.code-shell/settings.json` 的 `hooks`,引擎加载 settings hooks)——所以不是"完全无效"。
  - **但页面能力极弱**:只能列出 event+command、删除、或**让用户手敲一段 `{event,command}` JSON 添加**(`AdvancedSections.tsx:329-366`),无事件类型提示/校验/可视化。
  - **核心缺口**:**插件 hooks 看不到、管不了**。core 的 `loadPluginHooks`(`engine.ts:641`)确实加载插件 hooks 且受 `disabledPlugins` 控制(关插件=关其 hooks),但钩子页**只读手写的 `s.hooks`,完全不展示插件 hooks**。superpowers 的 hooks 在后台默默生效,UI 里既看不见也只能靠"整个禁用插件"来关。
- **状态**:🟢 已改(2026-06-09,方案 B 落地)
- **已修汇总**:① core 新增 `listPluginHooks(disabledPlugins)` 只读函数(复用 loadPluginHooks 的扫描,返回 {plugin,event,rawEvent,command,matcher,disabled})+ index.ts export + 3 单测(返回/disabled 标记/不 register);② 新 IPC `hooks:listPlugin`(main 直接 import core,仿 mcp:listMerged)+ preload `listPluginHooks` + types `PluginHookEntry`;③ `ProjectHooksEditor` 重做:合并展示「项目钩子(手写)+ 插件钩子(只读,标"由 xxx 插件提供[/已禁用]")」,**加 hook 改 event 下拉(7 个枚举)+ command 输入框**替掉裸 JSON textarea,插件钩子只读 + 提示「在插件页禁用整插件来关」。core rebuild;core 1026 过、desktop 551 过、tsc+build 绿。**未做(可选)**:单条插件 hook 细粒度启停(需扩 core `capabilityOverrides.hooks`,本轮只做整插件级 disabledPlugins)。
- **(原)决策**:不隐藏,改造成真正的 hook 管理页(方案 B)
- **改造清单(B)**:
  1. **合并展示**「手写 hooks(project settings.hooks)+ 插件提供的 hooks」。插件 hooks 来源 = core `loadPluginHooks`(`engine.ts:641`,扫每个已装插件的 `hooks/hooks.json`);需新增一条 IPC 让 renderer 拿到「已加载的插件 hooks 列表 + 各自来源插件名」(core 侧 `loadPluginHooks` 已有数据,补查询接口)。
  2. **插件 hooks 只读 + 标注来源**(「由 xxx 插件提供」),复用 6.2 MCP 页的 owner 标注模式(ownerPluginOf / 只读戳 / 不可在此编辑)。
  3. **可视化加 hook**:event 类型用下拉(枚举可选 event),command 用输入框,替掉现在让用户裸敲 `{event,command}` JSON 的 `AdvancedSections.tsx:329-366` `add()`。
  4. **插件 hook 启停**:走 `disabledPlugins`(整插件)或更细的 capabilityOverrides;至少让用户看到「这个插件的 hook 在跑」并能关。
- **相关文件**:`AdvancedSections.tsx`(HooksSection/ProjectHooksEditor)、core `plugins/loadPluginHooks.ts` + 一条新 IPC、`preload/index.ts`。
- **备注**:现状钩子页只读手写 `s.hooks`、靠裸 JSON 添加,且**完全不展示插件 hooks**(superpowers 的 hook 后台生效但 UI 看不见)。核实见上。关联 [[project_settings_hooks_memory_dream]](钩子仅项目级)、[[project_extensions_ui]](6.2 MCP owner 标注模式)。

### 🟢 [2026-06-09] 本地环境页(隐藏 cleanup 后)UI 再优化一下
- **现象**:隐藏「清理脚本」后,本地环境设置页(`ProjectEnvEditor`)的布局/层次需要重新优化,且仍有不合 desktop UI 约定的旧写法。
- **可优化点(已核实)**:
  1. **裸 `<textarea>` 违约**:沙箱区 writableRoots(`AdvancedSections.tsx:654`)、deniedReads(`:659`)仍是原生 `<textarea>` → 按 desktop CLAUDE.md「禁止手写 textarea,用 `@/components/ui` 的 Textarea」应替换(变量框 :611 已用 Textarea,这两处漏了)。
  2. **旧手写 CSS class**:`settings-field`/`conn-field-hint`/`local-env-name`/`local-env-vars`/`local-env-advanced`/`env-settings-actions` 等是 legacy `styles/` 手写 class → 按约定应迁 Tailwind 工具类 + 语义 token(CLAUDE.md「不新增 styles/、用 Tailwind」)。
  3. **层次/间距**:隐藏 cleanup 后只剩「名称 / 设置脚本 / 变量 / 沙箱(高级 details)/ 保存」,几块之间间距与分组重新平衡;「设置脚本」可考虑也收进高级或加更清晰的「仅 worktree 生效」标注(与变量/沙箱的「全项目生效」区分,见上面那条关于作用域的澄清)。
- **状态**:🟢 已修(2026-06-09)
- **备注**:已修 = ① writableRoots/deniedReads 两处裸 `<textarea>` → `@/components/ui` `Textarea`(与变量框统一 `font-mono text-sm resize-y`);② `ProjectEnvEditor` + `LocalScriptEditor` 全部 legacy class(`env-settings-*`/`local-env-*`)→ Tailwind 工具类 + 语义 token,外层 `flex flex-col gap-4` 统一节奏,沙箱区 `grid grid-cols-2 gap-4`,tab 按钮换 shadcn `Button variant=ghost`;③「设置脚本」加 **「仅 worktree 生效」** badge、变量区标「全项目生效」区分作用域;④ 删掉 connections.css 里 0-consumer 的 `env-settings-*`/`local-env-*` 死规则(符合 [[project_desktop_shadcn]] Phase D)。**共享的 `settings-field`/`settings-form-grid` 保留**(其他设置页还在用)。desktop 551 过、tsc+build 绿。坑:删 css 时留的注释里 `*/` 误闭合注释炸了 build,已改文案。


### 🟢 [2026-06-12] 设置/配置页每次进入闪一下(loading)
- **现象**:每次进设置配置页都会闪一下,看起来是先渲染了 loading 占位态、数据到位后再替换造成的视觉跳动。
- **根因**:SettingsPage 切 tab 是条件渲染 → 子页 unmount/remount,每次重新 IPC 拉数据,期间渲染「加载中…」占位(或空列表)。
- **状态**:🟢 已修(2026-06-12,6bab871)
- **备注**:新增 `settings/settingsCache.ts`(module 级快照缓存):子页把最近一次成功加载的快照按 key 存入,remount 时 useState 初始化器同步 seed(不出占位)+ 后台静默刷新(stale-while-revalidate)。接入 7 个子页(GenConnections×2/SearchConnections/PluginsAndSkills/CapabilitiesOverview/ConversationSettings/Memory/Model)。每个 app 运行周期只有第一次进某页会 loading。与已修的「切模型闪『保存中』」(saving 闪,78fe9c2)是**不同症状**。关联记忆 [[project_settings_page_loading_flash]]、[[project_model_switch_saving_flash]]。

### 🟢 [2026-06-12] 浏览器圈选体验:统一架构重做(回显互通 + 编辑高亮 + 页面归属)
- **现象**:(1) session 里已存的圈选在浏览器里没回显;(2) 编辑时元素不显边框(看不到 outline);(3) 面板与弹窗不互通;(4) 不知道标注属于哪个页面。
- **用户决策**:统一逻辑——「一个 session 里圈选的值回显给所有浏览器表面」;生命周期保持**发送即清**;不做常驻全量高亮(只修好编辑高亮)。
- **状态**:🟢 已修(2026-06-12,69774cb;spec `docs/superpowers/specs/2026-06-12-browser-marker-unified-design.md`)
- **备注(架构级重做)**:① **Anchor 单一事实源**——删 PageMarker 平行实体,Anchor 带 browser 回显负载(url/pageTitle/selector/rect),wire 编码不动;App anchors 按 session 归桶(`anchorBuckets.ts`),切 session 切换标注集、面板重开不丢、发送清 active+draft 两桶;② **同步协议**——main 加 anchor hub(操作上行 IPC、全量状态下行广播),弹窗回显主窗口标注、新开弹窗推初始快照、发送清空全表面;删 4 个 window 事件总线改 props 直传;③ **markerEcho 共享回显引擎**——「看不到 outline」两个根因都修:dom-ready 重放(刷新/导航后高亮不再消失)+ selector 未命中不再静默 no-op(回报 miss → 回退圈选时 rect 画框 + 「页面已变化」提示);④ **页面归属**——chip 显 `@ host/path`、编辑卡片显归属页、工具栏标注总览(按页分组、点其它页标注自动导航+定位)。测试:新 10 例、desktop 706 全过、tsc+build 绿。**真机双窗口互通走查待用户验**。关联 [[project_browser_selection_echo_session]]、[[project_desktop_four_panels]]。

### 🟢 [2026-06-12] 插件自带 MCP 在 UI 里显示得很奇怪
- **现象**:当插件自身捆绑了 MCP server 时,当前 UI 把它显示出来看着很奇怪(与用户单独配置的 MCP 混在一起 / 归属不清)。
- **复现**:装一个自带 MCP 的插件,看 MCP / 扩展页。
- **期望**:明确「这是某插件带的」语义——和独立 MCP 视觉区分,或归到插件项下分组,而非平铺混排。
- **状态**:🔴
- **状态补**:🟢 已修(2026-06-12,dab58a0)。① MCP 页插件 server 按插件**归组**(「🧩 xxx 插件提供」小节)与用户配置视觉区分;② **装了就展示**(用户追加要求):listMerged 不再按 disabledPlugins 隐藏插件 MCP,禁用插件的 server 照列、标 pluginDisabled「插件已禁用 — 启用后生效」,probe 跳过(引擎连接路径自有过滤,UI-only 安全);③ 插件详情页里 MCP 也归到插件名下。关联 [[project_mcp_name_key_contract]]、[[project_plugin_bundled_mcp_display]]。

### 🟢 [2026-06-12] 看不到插件里到底有什么 — 需要插件详情页
- **现象**:插件列表里一个插件只显示 `来源 · N skills`(`PluginsTab.tsx:139`),**看不到它到底包含什么**——hooks / MCP / commands / agents 都没露出,也**没有点进去看详情的入口**。
- **复现**:扩展→插件页,看任意插件。
- **期望**:点进插件能看到详情——列出它提供的 skills、hooks、MCP server、commands、agents 等各类内容(名称 + 数量),让用户清楚这个插件装了啥。
- **状态**:🔴
- **状态补**:🟢 已修(2026-06-12,dab58a0)。core 新增 `describePluginContent`(枚举 skills 名+描述/commands/agents/hooks/MCP,hooks·MCP 复用运行时 loader 同款扫描保证不漂移)→ IPC `plugins:detail` → `PluginDetailView`(插件行可点进,仿 MarketList→MarketDetail 模式,五类内容分区列出)。关联 [[project_plugin_detail_view]]、[[project_extensions_ui]]。

### 🟢 [2026-06-12] hooks 缺全局(user)级配置入口 + 缺单条启停开关
- **现象/疑问**:用户问 hooks 有没有全局配置、能不能开关 hooks。
- **核实(2026-06-12)**:
  - **core 支持全局**:`SettingsManager` 分层合并(`manager.ts:42`,`flag>local>project>user>managed`),`user` 层 = `~/.code-shell/settings.json`,`hooks` 写全局完全能加载合并(`manager.ts:91`)。
  - **但 desktop UI 故意只做项目级**:`HooksSection`(`AdvancedSections.tsx:270`)注释明写 "Hooks are PROJECT-scoped only … a global/user hook makes no sense",只编辑 `<repo>/.code-shell/settings.json`。与记忆 [[project_settings_hooks_memory_dream]]「钩子仅项目级」一致(当初有意决策)。
  - **开关现状**:手写项目 hook 只能**增/删,无单条 toggle**;插件 hook 只读、只能靠**禁用整个插件**来关(`listPluginHooks` 已返回 `disabled` 字段,但单条细粒度启停未接,见钩子页改造「未做」项)。
- **期望(待产品决策)**:① 是否给 hooks 加全局(user)级编辑入口——注释说「全局 hook 没意义」但 hook 有 `cwd`/`matcher` 字段,全局日志类 hook 讲得通,且 CC 本身支持 user 级 hooks(可重新评估这条决策);② 手写 hook 加「启用/禁用」开关(不删也能临时关);③ 插件 hook 单条启停(需扩 core `capabilityOverrides.hooks`)。
- **状态**:🟢 已修(2026-06-13,①②③ 全做;core 51f1e1f + desktop b7fc195)
- **备注(已修汇总)**:**「整体覆盖」坑就是正解入口**——core `SettingsManager.deepMerge` 给顶层 `hooks` 数组单开拼接语义(跨层 CONCAT,user 先 project 后、两层都跑,对齐 CC;显式 `"hooks": null` 仍可整体重置),其余数组照旧整体覆盖。① 钩子页 ProjectPicker 加 `includeGlobal`「全局」行(复用记忆页模式),编辑 `~/.code-shell/settings.json`;项目视图加「全局钩子(也在本项目运行)」只读区。② hooks schema 加 `disabled` 软开关 + `registerSettingsHooks` 跳过(reloadHooks 热生效),UI 行加 Switch、停用置灰。③ `capabilityOverrides.pluginHooks`(key=`pluginHookKey`=`plugin:RawEvent:command`,内容键控防重装漂移)+ `loadPluginHooks` 第三参单条跳过 + `listPluginHooks` 返回 `key`;UI 项目视图插件 hook 行加 Switch(仅本项目、新会话生效),插件整体禁用时置灰;折叠走 `computeEffectiveDisabledLists`(913a680 抽出的共享模块)。测试:manager 拼接 5 例 + loadPluginHooks 单条禁用 2 例;core 1213/desktop 718 全过。关联记忆 [[project_hooks_global_and_toggle]]、[[project_settings_hooks_memory_dream]]。

### 🟡 [2026-06-12] 记忆/Dream 机制疏理 + 记忆杂乱过期 — 待讨论方向
- **疑问**:目前记忆到底怎么用的?Dream 有什么用?CC/Codex 怎么做?而且有些记忆过期了、好杂乱。
- **核实(2026-06-12,本仓库现状)**:
  - **存储**:全局 `~/.code-shell/memory/{user,dream}/` + 项目级 `~/.code-shell/projects/<hash>/memory/{user,dream}/`;每条一个 md(frontmatter+正文)+ `MEMORY.md` 索引。证据 `packages/core/src/session/memory.ts:73-147,225-230`。
  - **注入**:每轮对话开头作为 `<system-reminder>` 注入(user+dream 两 scope 合并,标不同标签);可选 `settings.memories.maxAge` 按天过滤**注入**(不删文件)。证据 `prompt/composer.ts:76-94,243-250`、`session/memory.ts:44-62,239-274`。
  - **写入**:① Desktop UI 手动增删改(MemorySave/Delete 需确认);② 每次对话结束自动 LLM 提取(≤2 条/会话,直存 user scope 不确认,legacy)。证据 `services/extract-memories.ts:14-101`、`services/memory-orchestrator.ts:77-125`。
  - **Dream**:LLM 工具循环(8 轮/10 写预算)整理 **dream scope**(去重/合并/清理),user scope 对它**只读**;自动触发=每 5 会话且隔 ≥24h,手动=设置页「整理 Dream」按钮。证据 `services/dream-consolidation.ts:34-195`、`services/auto-dream.ts:12-89`、`desktop/.../MemorySection.tsx:266-277`。
  - **过期/清理**:**只有注入期 age 过滤 + soft-delete 到 memory-trash**;❌无自动硬删除、❌无自动去重(仅 Dream LLM 做)、❌无后台清理。证据 `session/memory.ts:44-62,199-222`、`settings/schema.ts:418-424`。
- **CC/Codex 对比(2026-06 核实,纠正旧认知)**:两家**都已是「静态指令文件 + 动态自动记忆」双层**,不再是纯静态靠人维护。CC = CLAUDE.md(静态,全量注入)+ Auto memory(默认开/会话内实时写/MEMORY.md 限 200 行 25KB recall/topic 按需读/**无过期无去重靠人**);Codex = AGENTS.md(静态)+ Memories(默认关/**后台异步**写/**有专门 consolidation 模型 + age/idle/数量过期参数**/redact secrets)。**本项目的 Dream(后台 LLM 整合)思路更接近 Codex 的 Memories,而非 CC**。来源 code.claude.com/docs/en/memory、developers.openai.com/codex/memories + config-reference。
- **「杂乱过期」实测**:`~/.claude/...codeshell/memory/` 当前 **75 个文件,其中 42 个(56%)标「已修/已做/已完成」**——一多半是办完的旧事仍占索引,这是杂乱主因。(注:这是 **Claude Code 自己的** auto memory 目录,非本项目 code-shell 的记忆;但暴露的问题对两套都成立=完成态记忆只增不减。)
- **状态**:🟡 第一批已修(2026-06-13,96c5a3e),**未完——用户拍板后续开记忆专项**(整体设计一轮,别零敲碎打)
- **已修(第一批)**:①可关 = `settings.memories.autoExtract`(false 跳过提取,总结/Dream 照跑;记忆页全局视图加 Switch);存量淹没 = 记忆页「清理自动提取(N)」批量按钮(soft-delete 全部 origin:auto 未固定,confirm 带数量);③部分 = 提取 prompt 加 secret redact 规则;② = Dream prompt 加完成态归档规则(纯「已修」无教训的删/并 changelog,有教训先折进主题条目)。
- **🔜 记忆专项(待做,先出整体设计再动手)**:第一批只是止血,记忆系统该作为一个整体重新审一遍。专项至少覆盖——
  1. **生命周期**:记忆从写入→使用→过期→归档/删除的完整状态机;age/数量上限自动归档(现 maxAge 只滤注入不动文件)、trash 的恢复/清空 UI(现只能手动 mv)。
  2. **完成态语义**:给记忆加状态字段(active/done/archived?),Dream/清理流程能按状态归档,不再靠 prompt 软约束。
  3. **质量闭环**:自动提取要不要确认流(现仅可关);提取质量评估(噪音率);Dream 效果可观测(整理前后对比)。
  4. **规模化**:MEMORY.md 索引截断 + 详情按需读(学 CC 200 行 25KB recall);注入 token 预算管理。
  5. **对齐参照**:CC auto-memory(会话内实时写/无过期) vs Codex Memories(后台异步/consolidation 模型/age 参数),见 [[reference_cc_codex_memory]],codeshell 的 Dream 介于两者,定位要明确。
- **可能方向(原记录)**:① 给「自动提取」的记忆也走确认/或可关(现 legacy 不确认);② 给记忆加「状态/完成」语义,Dream 或清理流程能归档/删掉「已修完」的;③ 借鉴 Codex:加 age/数量上限自动归档、secret redact;④ 借鉴 CC:MEMORY.md 索引截断 + 详情按需读,避免索引膨胀。关联记忆 [[project_memory_and_dream_overview]]、[[project_settings_hooks_memory_dream]]、[[reference_cc_codex_memory]]。

### 🟢 [2026-06-12] 记忆需要「固定/置顶」层 — user scope 被自动提取淹没,有用的留不住
- **现象/诉求**:有些记忆觉得有用,想把它**升级成固定的**;但现在 `user` scope 里**全是自动提取的**,手动写的有用记忆和自动噪音混在一起。
- **核实(2026-06-12)**:
  - 目前**只有 2 个 scope**:`user`(手动写 + 对话结束自动提取,**混在一起**)和 `dream`(LLM 工作区,会被自动改删)。`MemoryScope = "user" | "dream"`(`packages/core/src/session/memory.ts:35`)。
  - **自动提取和手动写用同一个 `save()`,完全无来源标记**——frontmatter 只有 `name/description/type`(`memory.ts:126-147`),没有 origin/auto/pinned 字段。所以 user scope 里**没法区分**哪条是自动提取的噪音、哪条是你想留的。
  - 自动提取 = 每会话结束 LLM 抽 ≤2 条直存 user scope 不确认(`services/extract-memories.ts`)。**没有「固定/pinned」这一层**。
- **期望**:能把一条记忆「升级为固定」,使其 ① 不被自动流程/Dream 改删 ② 视觉上和自动提取的区分开 ③ 优先注入/不受 age 过滤。
- **状态**:🔴
- **状态补**:🟢 已修(2026-06-12,0b1dfe4,按推荐 A+C)。core `MemoryEntry` 加 `pinned`/`origin` frontmatter(仅有值才写,legacy 文件不变);固定的免 maxAge 注入过滤 + 注入排最前标 [pinned];自动提取写入打 `origin:"auto"`;UI 列表固定优先 + Pin/PinOff 按钮 + 「自动」badge,编辑保存不丢标记。Dream 无需改(user scope 本就只读)。
- **备注**:几种实现路子——**A. 加 `pinned` frontmatter 字段**(最轻:save 支持 pinned;UI 加「固定」按钮 + 列表分组「固定/自动」;注入时固定的优先且不受 maxAge);**B. 新增第三个 scope `pinned/`**(`MemoryScope` 加一项,自动提取只写 user、pinned 纯手动、Dream 对 pinned 只读,与现 user/dream 隔离一致,改动较大);**C. 给自动提取打 `origin:"auto"` 标记**(治本:让 user scope 内部能分自动 vs 手动,配合按来源过滤/批量清理)。推荐 A 或 A+C 组合(轻、直接解决「淹没」)。配合 feedback#17「记忆杂乱过期」一起设计。关联记忆 [[project_memory_pinned_layer]]、[[project_memory_and_dream_overview]]。

### 🟢 [2026-06-12] 连接(connections)整块 UI 需要系统性优化 — 视觉/信息架构/交互三方面
- **现象/诉求**:连接这一块的 UI 需要优化。用户确认三方面都要:**视觉/样式粗糙 + 信息架构混乱 + 交互体验**。
- **核实(2026-06-12,已定位抓手)**:
  - **结构**:连接分散在 4 个独立面板——`ModelSection.tsx`(模型)、`ImageGenConnectionsPanel.tsx`、`SearchConnectionsPanel.tsx`、`VideoGenConnectionsPanel.tsx`,公共部分在 `GenConnectionsPanel.tsx` + `CollapsibleGroup.tsx`。
  - **视觉(shadcn 迁移漏网)**:仍在用手写 `styles/connections.css`(**299 行、52 条 `.conn-*`/`.connections-*` 规则**)+ 裸 `<button>`/`<label>`/`<input>`(`GenConnectionsPanel.tsx:256,308-379` 大量 `conn-card`/`conn-pill`/`conn-secret-toggle`/`settings-field` 等 legacy class)。违反 desktop CLAUDE.md「禁手写 textarea/CSS、用 @/components/ui + Tailwind」。是 [[project_desktop_shadcn]] Phase D 没扫到的大块。
  - **信息架构**:4 面板卡片网格(`connections-card-grid`)、分组(`connections-group` + chevron/count)、默认项 pill(`conn-default-pill`)、key 复用(`conn-key-mode`/apiKeyRef)、探测状态(`conn-probe-*`)层次需重排。
  - **交互**:添加/测试连接(`conn-card-add`/probing/ok/err pill)、填 key、设默认、连通性探测的流程与反馈需打磨。
- **期望**:① 全面迁 shadcn/ui + Tailwind 语义 token,与其它已迁设置页观感统一,删 connections.css;② 重排卡片/分组/默认/key复用/探测的信息层次;③ 优化添加/测试/设默认/探测的交互与反馈。
- **状态**:🟢 已修(2026-06-13,42ff471;①②③ 主体完成,ModelSection 深度重排留后)
- **备注(已修汇总)**:① **connections.css 整文件删除**(300 行 52 条规则,3 个消费者 Gen/Search/CollapsibleGroup 全迁完后核实 0 残余);新增 `settings/connUi.tsx` 共享底座(ConnCard/ConnField/SecretKeyInput/ConnProbeError/ConnCardFooter),两面板卡片同源不重复。② IA:卡片层次重排 = header(名称+#id+默认/状态 Badge,「获取 key」收右上 link)→描述→字段栈→probe 块→footer(测试/保存左、设默认/删除右下 ghost);默认卡 accent 边框 ring;1px 缝隙网格改真 gap;状态 pill 换 Badge 语义变体去 hard-coded rgba。③ 交互:保存成功/失败 toast(原静默)、删除/清除加 useConfirm(对齐弹窗统一)、key 显隐 Eye 图标钮、折叠组 chevron 换 lucide。顺手:ModelSection checkbox→Switch + settings-toggle-inline 死规则删除。**留后**:ModelSection 整页深度重排(列表式 IA、绑 Catalog v1,不在 connections.css 范围)。原备注:范围大,建议先 brainstorm 定方向(视觉统一优先级最高、最确定)再分面板推进。模型接入是 Catalog v1(内置+user.json/多实例复用key apiKeyRef/设默认),见 [[project_model_catalog]];迁移参照 [[project_desktop_shadcn]](HSL token + simple-select)。关联记忆 [[project_connections_ui_overhaul]]。
- **追加具体痛点(2026-06-12)→ 🟢 已修(6e3b338)**:[+ 添加模型] 菜单按模板二级展开 modelPresets(标默认),点模型即建好完整卡片;无 presets 模板单击直建。原文:**「添加」的两段式流程别扭**——点 `[+ 添加]` 弹 catalog 模板菜单(`templates` 按 catalogTag 过滤,`GenConnectionsPanel.tsx:84`)先选一个 provider(如 fal),创建 instance 后**再进卡片里选 model**(`inst.model`,`:108`)。用户觉得「先选 fal、再进去选模型」这种 provider→model 分两步选很奇怪。期望:合并成一步(如添加菜单直接二级展开到具体模型,或一个搜索框同时选 provider+model),减少「选了个空壳再配置」的割裂感。这是上面「交互体验」一项的最具体落点。
- **追加 BUG(2026-06-13)→ 🟢 已修(b4359bc)**:① **复用 key 跨 provider 乱推荐**——新建 Gemini 图片实例,「复用已有」给出 OpenAI 实例(key 属于单一 provider 账号,跨 kind 根本不通)。真因=复用候选只滤 `o.id!==inst.id && !!o.apiKey`、没按 kind 过滤。修=候选加 `o.kind===inst.kind`;历史跨 kind ref 解析不到候选→显「未配置」引导重填;复用下拉标签带模型名区分多实例(core `effectiveApiKey` 不动,UI 创建路径堵死即可)。② **Radix a11y 报错** `DialogContent requires a DialogTitle`——DialogProvider ModalHead 无 title 不渲染 DialogTitle(useConfirm/useAlert 多数只传 message,老问题,#19 加 confirm 后暴露)。修=恒渲染 DialogTitle,无显式 title 用 message 充当并 `sr-only` 隐藏,视觉不变。
- **追加 BUG(2026-06-12,真因已定位)→ 🟢 已修(2026-06-12,b020eb1)**:**老数据(Catalog v1 之前的 provider)选不了模型**。根因:旧 provider 存的没有 `catalogId`,加载时虽有 kind+tag 回退匹配(`GenConnectionsPanel.tsx:100`),但 GenCard 按 `entry=entryById(inst.catalogId)` 解析模板,catalogId 为 undefined → `entry.modelPresets` 拿不到 → 模型下拉**退化成空文本框**;且 `writeBack` 只在 catalogId 存在时才写(`:149`)→ 永不回填。**已修三处**:① core `migrate-config.ts` 注册首个真实 migration(v0→v1):imageGen/videoGen.providers[] 无 catalogId 按 `adapterKind===kind && tag` 匹配 BUILTIN_CATALOG 回填;`SettingsManager.load()` 接线 migrateConfig(框架此前 0 消费者),user+project 两层各自迁移,仅内容真变才写回(带 .bak),纯 stamp 差异不动文件;② renderer load() 采纳 fallback 匹配进 `catalogId`(下次保存即持久化);③ 未匹配模板时模型框 placeholder 提示「未匹配到模板,手动填写模型 ID」。坑:迁移生效后 generate-image 测试的精确断言要带 catalogId(367bc32)。

### 🟡 [2026-06-12] codeshell 没有「创建/编写 skill」的辅助(skill-creator 类) — 待评估要不要做
- **疑问**:现在有 skill creator 吗?CC/Codex 怎么帮写 skill?
- **核实(2026-06-12)**:
  - **codeshell 现状**:**能消费 skill 但不能辅助创建**。`packages/core/src/skills/frontmatter.ts:2` 明写「byte-compatible with Claude Code's frontmatterParser,so community skill repositories can be reused」+ `scanner.ts` 扫 `<base>/<name>/SKILL.md`(项目+用户级)。**没有任何「新建/脚手架/引导写 skill」的产品功能**(grep createSkill/scaffoldSkill 无)。本机层面用户用的是装在 ~/.claude 的 `document-skills:skill-creator`(Anthropic 官方,33KB SKILL.md + scripts/agents/eval-viewer)和 `superpowers:writing-skills`——那是 Claude Code 的 skill,不是 codeshell 产品自带。
  - **CC 做法**:`skill-creator` 是**一个「用来创建 skill 的 skill」(meta-skill)**,交互式引导走 Create→Eval→Improve→Benchmark 全生命周期(问意图→访谈→draft SKILL.md→跑测试 prompt→量化 eval→迭代→优化 description 触发)。无 `/create-skill` CLI,走 meta-skill。superpowers `writing-skills` 侧重不同=TDD-for-skills「没失败测试不写 skill」+ 抗合理化加固。
  - **Codex 做法**(纠错:Codex 现在**也有 skill**了,2025-12 起,**和 CC 共享 agentskills.io 开放标准、同 SKILL.md 格式**):内置 `$skill-creator`(6 步脚手架:理解→规划→`init_skill.py` 脚手架→编辑→`quick_validate.py` 校验→迭代)+ `$skill-installer`(从 openai/skills 目录装)。Codex 偏「脚本脚手架+校验器」,CC 偏「交互访谈+eval 循环」。
- **状态**:🟢 初版上线(2026-06-13,随 #22 官方市场落地)
- **已做**:skill-creator v0.1 作为官方市场 **mimi-plugins** 首个插件上线(github cjhyy/mimi-plugins,commit 6d0985f)——五步引导 meta-skill(访谈意图→选位置→按模板起草→校验→触发测试),走 CC 风格交互访谈而非 Codex 脚手架;随首启软预装自动到位(见 #22)。**留后**:eval/benchmark 循环(CC skill-creator 的 Evaluate/Improve 阶段)、Codex 式 init/validate 脚本。
- **可能方向(原记录)**:codeshell 既然已 byte-compatible 复用社区 skill,可考虑加一个**自带 skill-creator 类能力**(作为内置 skill 或 UI 引导),帮用户在 codeshell 里直接写 skill;格式天然兼容 CC/Codex/agentskills.io。关联记忆 [[reference_cc_codex_skill_creator]]、[[project_extensions_ui]]、[[project_settings_projectpicker_done]](skill 系统已实现部分)。

### 🟢 [2026-06-12→06-14] 安装 plugin/skill 的本地化适配(兼容 CC + Codex)— 主路径 + 真缺口(Codex 命令)已补
- **诉求**:安装 plugin 或 skill 时怎么本地化、适配到 codeshell,如果 CC/Codex 都想兼容的话。
- **核实(2026-06-12,已大量实现,这是「扩展」非「从零」)**:
  - **格式识别**:`detectPluginFormat`(`installer/detectFormat.ts:5`)二元判定——有 `.codex-plugin/plugin.json` = Codex,否则 = CC。
  - **CC 格式**:整目录原样复制(skills/agents/commands/hooks 等 CC 原生布局是 codeshell「母语」)。`install.ts:44`。
  - **Codex 格式→已做三类转换**:① **skills 原样拷**(CC/Codex SKILL.md 同构,见 `convertSkills.ts` 注释 "isomorphic",仅校验 frontmatter);② **agents:TOML→MD**(`convertAgents.ts`/`convertCodexAgentToml`);③ **mcp→`mcp-servers.json`** 按 `<plugin>:<server>` keying(`convertMcp.ts`/`resolveCodexMcpServers`)。`install.ts:51-68`。
  - 装后统一走 `scanInstalledPlugins`/`loadPluginHooks`/`loadPluginAgents` 等现有 loader(`install.ts:73`)。
- **状态**:🟢 已修(2026-06-14;真缺口①Codex 命令转换已补 + ③单 skill 仓库经核实本就通;②④主动判定非缺口/低价值不做)
- **已修(2026-06-14)**:**①Codex commands/prompts 转换(真缺口)** = 新增 `installer/codex/convertCommands.ts`(`copyCodexCommands`),Codex 安装时把 `prompts/*.md`(+ 显式 `commands/*.md`)平铺进 `dest/commands/`——Codex 的 prompt 与 CC 的 slash command **同构**(都是 frontmatter+markdown、文件名=命令名),而 `pluginCommandsLoader` 本就扫 `commands/*.md`,装完即可 `/<plugin>:<name>` 调用。占位符语法差异(`$1`/`$FILE` vs CC)按 v1-inert 原样拷(对齐 `codex_` agent 字段策略);非 `.md` 忽略(Codex 同行为);文件名冲突时显式 `commands/` 胜 `prompts/`。接进 `install.ts` Codex 分支(CC 分支整目录拷已含 commands,不动)。测试:convertCommands 5 例 + install Codex 集成断言 prompt→command;installer 全 84 pass。**注:OpenAI 已弃用 custom prompts 转推 skills,此缺口真但低值,故仅做无损直拷不做占位符翻译。**
- **核实非缺口/不做**:③**单 skill 仓库独立安装**=已通——只含 `skills/` 无 `.codex-plugin` 的 repo 走 `detectFormat`→`cc`→整目录原样拷,装后插件 loader(scanInstalledPlugins/skills 扫描)正常暴露,无需新入口;②**Codex `AGENTS.md`**=codeshell 已有 AGENTS 层级注入(见 [[project_plugin_skill_localization]]),插件内的 AGENTS.md 不是「安装时转换」问题、不做;④**`.agents/skills` 跨工具目录扫描**=低价值(agentskills.io 标准下 skills 已同构、装进插件即被扫),不主动新增扫描路径。关联记忆 [[project_plugin_skill_localization]]、[[reference_cc_codex_skill_creator]]、[[project_extensions_ui]]、[[project_mcp_name_key_contract]]。

### 🟢 [2026-06-12] 建官方 marketplace 源 + 预置自带 skill — 引擎已齐,只缺「官方源」
- **诉求**:是不是需要一个官方 marketplace,用来装自带 skill,用户下载就自带?
- **核实(2026-06-12,关键=引擎齐全只缺内容源)**:
  - **marketplace 引擎已完整**:`marketplaceManager.ts` 能 clone github/git 仓库、读 manifest、装/删/列;**同时兼容 CC manifest(`.claude-plugin/marketplace.json`)和 Codex(`.agents/plugins/marketplace.json`)**(`resolveManifestPath` `:44-58`);市场 UI 齐(DiscoverHome/MarketList/MarketDetail/SkillsTab)。`known_marketplaces.json` 与 CC byte-compatible。
  - **空缺**:`knownMarketplaces.ts` **无任何内置/默认官方源**——`readKnownMarketplaces` 文件不存在返回 `{}`。即引擎能用但 codeshell 自己没预置官方源,用户得手动 add marketplace。
  - **skill 复用**:codeshell 能 byte-compatible 消费 CC skill(`skills/frontmatter.ts`),官方 skill-creator 等可直接复用(见 [[reference_cc_codex_skill_creator]])。
- **结论**:**不需要造机制,只需 ① 建一个官方 marketplace 仓库(GitHub repo + `.claude-plugin/marketplace.json` + 自带 skill 目录,如 codeshell-official)② 在 `knownMarketplaces.ts` 加内置 seed,首启自动写进 known_marketplaces.json(类比 CC 默认带 anthropic 源)。** 用户装好即在市场看到官方 skill、一键下载。
- **决策已定(2026-06-12)**:选 **A. 默认源 + 首启自动下载(软预装)**——不打进安装包,首次启动时后台自动拉取并安装,体验接近开箱即用但保持轻/可独立更新。三个细节决策:
  - **范围**:首启**只自动装指定的几个核心 skill**(非全部、非只加源)。需要列一份「默认必装」清单(如 skill-creator)。
  - **失败处理**:**静默重试、不阻塞启动**——后台拉,拉不到不报错不弹窗,下次启动再试。
  - **更新策略**:**只首装一次,之后不动**——靠首装标记(如 first-run-installed.json / 已装即跳过)防重复;升级靠用户手动,**不自动覆盖用户改过的 skill**。
- **实现要点**:① 建官方 marketplace 仓库(`.claude-plugin/marketplace.json` + 核心 skill 目录);② `knownMarketplaces.ts` 加内置 seed(首启写入 known_marketplaces.json);③ 首启 bootstrap:加完源后对「核心清单」逐个 install(走现有 installer,async fs 防冻 main 进程,见 178abc8);④ 持久化「首启已装」标记,幂等防重装;⑤ 静默失败 + 下次重试。注意全程在 main 进程用 async fs(参考记忆 [[project_main_sync_fs_freeze]])。
- **状态**:🟢 已修(2026-06-13,54afbdf;官方 repo = github cjhyy/mimi-plugins)
- **已修汇总**:① 官方 repo 已建并推送(`.claude-plugin/marketplace.json` CC 兼容 + `plugins/skill-creator/`,见 #20);② `known-marketplaces-seed.json` 加 `mimi-plugins` 源(复用 seedDefaults 现有幂等注册,老用户下次启动补注册);③ 新增 `bootstrap-core-plugins.ts` 首启软预装(三契约全落实:只装核心清单/失败无标记静默下次重试不阻塞/装成写标记 `core_plugins_installed.json` 永不自动重装,已手动装的记 pre-existing);④ whenReady 链 seedDefaults→bootstrapCorePlugins。验证:纯函数 5 例 + 隔离 HOME 真 GitHub 端到端冒烟(clone→manifest→install→scanSkills 出 `skill-creator:skill-creator`)。
- **备注(原)**:可作为「让 codeshell 有自带 skill 生态」的落地路径,把 skill-creator 复用 + plugin 本地化兼容串起来。关联记忆 [[project_official_marketplace_seed]]、[[reference_cc_codex_skill_creator]]、[[project_plugin_skill_localization]]、[[project_extensions_ui]]。

### 🟢 [2026-06-12] marketplace 下载的插件不显示版本号
- **现象**:在 marketplace 里下载/浏览插件时,**看不到版本号**。
- **根因(两层)**:① `PluginMarketplaceEntry` 无 `version` 字段(manifest 写了也没解析);② 市场 UI 完全没渲染版本。
- **状态**:🟢 已修(2026-06-12,5ed658c)
- **备注**:① core `PluginMarketplaceEntry` 加 `version?` + `validatePluginEntry` 解析(**CC 的 marketplace.json 本无 version 惯例**,manifest 写了才有,缺省不显示);② marketplace-service DTO + preload 透传,`MarketDetail` 名称旁渲染 `vX.Y.Z`;③ 已装插件另显「已装 <版本>」(installed Set→Map,值=`PluginInstallEntry.version` git 短 SHA 或 local)——即便 manifest 没写版本也能看到装的是哪个 commit。**留后**:「可更新」提示(checkUpdate 走 git ls-remote 逐个网络请求,放列表会卡)。关联记忆 [[project_marketplace_version_display]]、[[project_plugin_detail_view]]、[[project_extensions_ui]]。

### 🟢 [2026-06-12] MCP 鉴权失败报错不友好 + 缺配置引导
- **现象**:远程 HTTP MCP(如 n8n 的 `synta-mcp`)鉴权失败时,只甩「鉴权失败(检查 API key / headers)」+ 一坨 stack trace(`Streamable HTTP error … -32001 Unauthorized … StreamableHTTPClientTransport.send … index.mjs:40341`)。**没告诉用户:这个 server 需要鉴权、该配哪个字段、怎么配**——不熟的人无从下手。
- **复现**:加一个需要鉴权的 HTTP MCP,不配/配错凭证,连接 → 报这串。
- **核实(2026-06-12,机制已查清)**:codeshell 对 HTTP MCP 有三种带凭证方式(`buildHttpHeaders`,`mcp-manager.ts:62-81`;字段见 `types.ts:537-553`):① `headers`(静态明文)② `bearerTokenEnvVar`(填**环境变量名**→ `Authorization: Bearer <env值>`)③ `envHeaders`(header名→环境变量名映射)。secret 连接时才从 `process.env` 现取(不存明文)。`-32001 Unauthorized` = 握手 `initialize`(id:0)就被服务端拒。常见真因:没配任何鉴权 / 配了 envVar 但 Electron 进程取不到该环境变量 / n8n 要的是自定义 header(如 X-N8N-API-KEY)却用了 bearerTokenEnvVar。
- **期望**:① 鉴权失败的报错**人话化**——明说「该 server 需要鉴权,请在 MCP 配置里填 Authorization/headers」,并区分「没配凭证」vs「配了但环境变量取不到值」vs「凭证被服务端拒(401)」;② MCP 配置 UI 给**鉴权字段的引导**(bearer token / 自定义 header 怎么填、env 变量名 vs 值的区别),降低 HTTP MCP 接入门槛;③ 折叠原始 stack trace 到「详情」里,默认只显友好摘要。
- **状态**:🟢 已修(2026-06-12,7ecde29)
- **备注(修了三处,比预想多一处真 bug)**:① **probe 补 env 鉴权**——`mcp-probe-service` 此前只用静态 headers、完全忽略 `bearerTokenEnvVar`/`envHeaders`,配了 env 鉴权的人点「测试」必失败且报误导 401;现复用 core `buildHttpHeaders`/`buildStdioEnv`(core index 新导出),与真实连接同语义;② `humanizeError` 报错分三类:env var 未设置(带变量名+字段名+「填的是名,值连接时读」)/ 401·-32001 鉴权失败(引导去填 Headers 或 Bearer Token 环境变量)/ 403 权限不足,401|403 用 `\b` 词边界防数字误伤;③ McpEditor(HTTP)新增「Bearer Token 环境变量」+「环境变量 Headers」字段(McpServer/ProbeInput 补三字段,序列化 spread 透传),带「环境变量名 vs 值」说明,明文 Headers 加敏感提示。③(stack trace 折叠)早已有「查看详情」模态,未动。关联记忆 [[project_mcp_auth_error_ux]]、[[project_mcp_name_key_contract]]。
