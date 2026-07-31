# 后台浏览器运行时与截图回传

> 2026-07-31。本文记录浏览器自动化从“必须挂着 BrowserPanel”升级为“可后台运行、
> 必要时原页面接管”的实现。它是
> `2026-06-16-browser-automation-mvp.md` 第 9 节无人值守路线的落地补充。

## 目标

- 普通对话没有打开 BrowserPanel 时，浏览器工具仍可工作且不打断用户。
- 定时/无人值守 Engine 获得独立的浏览器目标，不依赖 renderer 存活。
- 浏览器观察继续以 a11y/DOM 为主，只有模型明确调用 vision 时才捕获像素。
- 截图作为工具结果在对话时间线中直接展示，可点击放大。
- 登录、2FA、密码输入和高后果操作停下来，把**同一个目标**显示给用户接管。

## 运行结构

```text
browser_* tool
      |
      +-- 有 BrowserPanel guest --> webContents.debugger --> CDP
      |
      +-- 无可见 guest ----------> BackgroundBrowserRuntime
                                      |
                                      +-- lazy hidden BrowserWindow
                                      +-- backgroundThrottling=false
                                      +-- persistent partition
                                      +-- per-owner serial queue
                                      +-- CdpBrowserDriver/ref map
```

交互会话使用原 session 的 `persist:browser:<bucket>` 分区，因此后台目标与该会话的
可见浏览器共享登录态。定时任务使用
`persist:browser:automation:<job-id>`，任务之间不共享 cookie。

## 生命周期

- `acquire()` 只创建轻量 lease；第一次浏览器调用才创建 Chromium 目标。
- 同一 owner 的重叠 lease 复用目标和 snapshot ref map，动作按队列串行。
- live target 数量有上限；只淘汰未租用、未显示的最旧目标。
- lease 归零后进入 idle TTL。已经显示给用户的目标不会被 TTL 或容量策略关闭。
- 删除交互 session、关闭最后一个非 macOS 主窗口或退出 app 时主动清理目标。

## 人工接管与安全边界

后台运行时在执行层强制以下规则，不依赖模型自觉：

- 域名白名单在导航和页面动作前校验，白名单拒绝不能人工绕过。
- snapshot 记录密码框和名称命中支付、删除、转账、确认订单等词的 ref。
- 后台对这些 ref 的 click/type/pressKey 会拒绝执行并显示原 BrowserWindow。
- 卡号形态的文本即使没有先 snapshot，也会触发同样的交互接管。
- snapshot 检测到登录墙/密码框时直接显示原目标；cookie、DOM 和 ref 状态不迁移。

这里不实现 CAPTCHA 绕过、指纹伪造或隐身补丁。面向有风控的站点应优先使用官方
API/导出功能，并采用限速、缓存、增量同步和人工登录；站点明确拒绝自动化时停止。

## 截图回传

`browser_observe({mode:"vision"})` 调用 `Page.captureScreenshot`，返回 image
`ContentBlock`。renderer 把 block 转为 `ToolMessage.images`，`BrowserToolCard`
在折叠状态外渲染预览，并复用 Lightbox 查看原图。结构化 snapshot/read/extract
仍保持纯文本，避免每一步都发送高成本截图。

## 验证

- 纯单元测试覆盖后台 fallback、ref 复用、白名单、敏感 ref、容量与可见目标保活。
- renderer 测试验证折叠工具卡仍显示截图。
- `smoke:background-browser` 启动真实 Electron，访问本地页面，完成后台导航、等待、
  a11y snapshot 和真实 CDP screenshot，并断言没有打开 BrowserPanel。

## 下一层：采集器

批量数据采集不应把所有页面都交给浏览器。推荐增加一个合规的混合采集器：

1. HTTP/API 层负责公开静态页、JSON 接口、缓存、ETag、重试和增量游标。
2. BrowserBridge 只处理需要渲染、登录或交互的少数页面。
3. 每个域配置并发、最小间隔、每日预算、允许路径和数据保留期。
4. 记录来源 URL、采集时间和失败原因；遇到登录/验证码/封禁信号转人工，不自动升级
   为代理轮换、指纹伪装或 CAPTCHA 绕过。

