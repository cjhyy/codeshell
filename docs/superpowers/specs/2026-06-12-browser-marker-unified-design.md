# 浏览器圈选统一架构(marker → anchor 单一事实源)

日期:2026-06-12 · 状态:已批准(用户确认)

## 问题

圈选/标注现状是**两套实体 + 组件私有 state + 事件总线脆弱同步**:

- `Anchor`(App.tsx state)进 composer chip、编码进消息;`PageMarker`(BrowserPanel 组件私有 state)画圆点、注入高亮;两者靠 anchorId + 4 个 window 事件互相追赶。
- 断点:① 弹窗(popout,独立 BrowserWindow/renderer 进程)看不到面板的标注,反之亦然;② 发送清空(`codeshell:anchors-cleared`)是 window 事件,弹窗收不到 → 残留悬空标注;③ 面板 unmount 标注全丢(组件 state);④ 编辑高亮只注入一次,刷新/导航后消失;⑤ 弹窗删 anchor 不同步;⑥ 标注不跟 session,切 session 不切换集合。
- 用户实测:**编辑时 outline 压根看不见**(回归/未达预期,根因待查——候选:selector 未命中静默 no-op、webview 未就绪 executeJavaScript 同步抛错被吞、导航后不重放);**看不出标注属于哪个页面**。

## 决策(用户确认)

- 生命周期:**保持「发送即清」**(标注属于当前草稿,发送后所有表面同时清空)。
- 编辑高亮:**不做常驻全量高亮**,只修好「编辑哪个、哪个亮」——先根因诊断为什么现在看不见,再在新引擎里修复。
- 页面归属:**要做**——chip/卡片显示归属页面 + 浏览器工具栏标注总览(按页面分组、跨页跳转定位)。

## 架构

### 1. 数据模型:一个实体

删除 `PageMarker`。`Anchor` 增加可选回显负载(不进 wire 编码,`encodeAnchorsForWire` 不动):

```ts
interface Anchor {
  id: string; kind: "browser" | ...; label: string; locator: string; ...
  browser?: {
    url: string;
    pageTitle?: string;   // 圈选时抓 document.title(页面归属显示)
    selector?: string;    // 高亮重定位
    rect: Rect;           // 圆点落点(selector 失败的回退)
    comment: string;
  };
}
```

### 2. 存储:App 是 owner,按 session 归桶

- `anchors: Anchor[]` → `anchorsByBucket: Record<bucketKey, Anchor[]>`(同 `permissionOverrides` 套路)。
- composer chips、浏览器回显都读当前 bucket;切 session 切换标注集;面板重开不丢(state 在 App)。
- 草稿(`_none_`)无需迁移:发送即清,发送本身就是 draft→session 的转换点。

### 3. 同步协议:操作上行、状态下行

主窗口 BrowserPanel 与 App 同进程 → **直接 props**(删掉 window 事件总线)。仅弹窗走 IPC:

```
popout 增/删 ─IPC: browser:anchor / browser:anchor-remove→ main ─转发→ App 改 state
App anchors 变化 ─browser:anchors-sync→ main 存快照 ─broadcast: browser:anchors-state→ 全部 popout
popout 打开(did-finish-load)← main 主动推当前快照
```

全量状态下行 = 后开弹窗天然有初始快照、永不漂移;发送清空走同一管道广播全表面。

### 4. 回显引擎:共享 markerEcho

`renderer/browser/markerEcho.ts` + `useMarkerEcho(webviewRef, anchors, editingId)`,面板/弹窗共用:

- URL 过滤(`browser.url === 当前页`,语义同现状)→ 圆点覆盖层数据;
- 编辑态注入 outline + scrollIntoView(现有逻辑迁入);**监听 dom-ready/did-navigate 重放**;
- **诊断修复**:selector 未命中 → 回退 rect 滚动定位 + 圆点强调,不再静默 no-op;注入失败路径留日志。

### 5. 页面归属 + 标注总览

- chip/编辑卡片显示 `label · host/path`(来自 `browser.pageTitle`/`url`);
- 浏览器工具栏 badge「标注 N(本页 M)」,点开按页面分组列当前 session 全部标注;点其它页的标注 → webview 导航过去 + 高亮定位。面板/弹窗共用(数据同源)。

## 改动范围

`chat/anchors.ts` · `App.tsx`(归桶 + sync)· `BrowserPanel.tsx`(瘦身,marker state 全删)· 新 `markerEcho.ts` · `main/index.ts`(hub + 新 IPC)· `preload`。

## 测试

markerEcho 纯函数单测(URL 过滤/注入脚本/重放时机/回退)· anchors bucket 流转单测 · main hub 协议单测 · 真机双窗口互通走查。
