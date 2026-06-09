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

