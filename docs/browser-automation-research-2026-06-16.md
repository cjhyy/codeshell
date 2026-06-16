# 浏览器自动化能力调研 + CodeShell 落地建议

> 2026-06-16。背景:TODO P4「浏览器自动化(对标 WorkBuddy)」立项前的架构调研。
> 方法:deep-research 工作流(25 源 / 114 声明 / 对抗核验后 21 条确认,3 票制)。
> 关联:[[project_desktop_four_panels]](已有浏览器面板)、`docs/browser-cookie-export-design-2026-06-14.md`(Cookie Lease)。

---

## 0. 一句话结论

**业界(2025–2026)已明确收敛到「以 a11y/DOM 文本快照为主、视觉按需兜底」的混合观察层**,而非截图优先 —— 与团队「别走截图优先回头路」的诉求完全一致。CodeShell 的最优路径是:**直接复用现有 webview + `persist:browser` 分区,用 `executeJavaScript` 抽「带 ref 的可交互元素列表」,按 Playwright-MCP 范式暴露成工具(snapshot + 按 ref 的 click/type,视觉 click_xy 仅 opt-in 兜底),叠加「观察遮蔽」+ prompt 缓存控 token,安全交给现有确认/限权 + 隔离 profile。** 不需要另起 Playwright headless。

---

## 1. 七个问题的调研结论(均带核验)

### Q1 业界现状 + Q2 观察层(最关键)
- **收敛趋势**:浏览器 agent 主流 = a11y/DOM 文本快照为主、视觉按需兜底。硬证据:
  - SeeAct(Mind2Web, arXiv 2401.01614):HTML+视觉混合 grounding 比纯图像标注 **+30%**;纯 set-of-mark 视觉仅 **13.0%** step success vs HTML+视觉 **40.6%**;GPT-4V 在密集网页截图上严重幻觉。
  - WebVoyager:多模态 59.1% vs 纯 a11y-tree 文本 40.1%(视觉有增益,但作辅助)。
  - **token 经济**:a11y 快照约 **数百~4k token** vs 整页截图约 **5 万 token**。
  - FillApp 生产论文(arXiv 2511.19477):即便带 bounding-box 接口的 Gemini 2.5/3 Pro,在密集小元素网格上仍无法可靠定位 → 视觉点坐标在小/密集元素上不可靠。
- **边界**:这是「浏览器 agent + 小/密集元素精确定位」这一具体场景的结论。OS 级纯视觉产品(OpenAI Operator/CUA、Claude Computer Use OSWorld 72.5%)确实可用 —— 不能把「纯视觉一定不行」当普适结论。
- **Set-of-Mark(SoM)**:把分割区域用字母数字/框标注到截图、让多模态模型精确引用 —— 适合做 a11y 树覆盖不到时的**视觉兜底标注**,不宜作主路径。

### Q3 决策-执行循环 + 省 token(对成本最关键)
- **观察 token 是成本主导项**:占 SWE-agent 单轮约 **84%**(JetBrains "The Complexity Trap", arXiv 2508.21433, NeurIPS'25)。
- **最高杠杆降本 = 确定性「观察遮蔽」**:把滚动窗口外的旧观察替换成占位符,**成本砍半(-52%)、成功率不降反升(+2.6%)**,且**匹配甚至略超更贵的 LLM 摘要**。→ 含义:多步浏览器任务只留「摘要 + 最近 N 步快照」,旧快照折叠成占位符,**不必每步上大模型做摘要**。
- **prompt 缓存**:把静态前缀(tools→system)固定,缓存读取仅 **0.1x 价格(省 ~90%)**,长会话整体降本约 **89%**。**关键约束**:前缀按 `tools→system→messages` 层级,任一层变更使该层及之后全失效 —— **改工具定义会让整个缓存失效**,所以工具定义一旦定型别在循环里频繁改。

### Q4 登录态 + 2FA
- 标准做法 = 持久化会话(持久 user-data-dir / storageState)。**CodeShell 的 `persist:browser` 分区就是天然的持久 profile,MVP 直接复用即可复用用户真实登录态。**
- 2FA/验证码 **一律 human-in-the-loop**:把控制权交还用户(本地 app 直接把 webview 面板亮给用户手动登录)→ 完成后 persist 分区自然保存 → 后续自动化复用。cookie 约 30 天过期/改密失效,需重新登录兜底。

### Q5 执行引擎选型(对 CodeShell 最直接)
- 业界把浏览器能力暴露成工具的范式 = **Playwright-MCP**:默认用 accessibility tree(结构化数据)观察,视觉 opt-in(`--caps=vision`);交互工具(`browser_click`/`browser_type`)按快照里的 **exact ref** 引用元素(`browser_type{ref:'e5',text:'...'}`),**不是屏幕坐标**;官方建议「用 ref 不用 selector」。
- **对 CodeShell 的判断(现状家底佐证)**:现有 `BrowserPanel` 的 webview 已暴露 `loadURL`/`executeJavaScript(userGesture)`/`insertCSS`/`capturePage`,picker 已在用 executeJavaScript 抓稳健 selector+rect。**→ 直接驱动现有 webview 即可,无需另起 Playwright headless**:天然复用 `persist:browser` 登录态、对用户可见、零额外进程/资源。Playwright-MCP 的**工具形态**值得照搬,但**执行引擎用自家 webview**,不引入 Playwright 依赖。

### Q6 安全边界(不可妥协)
- **安全必须由确定性程序约束兜底,绝不把安全决策交给 LLM** —— 网页内容的 prompt injection 无法靠模型可靠区分合法/恶意指令(FillApp:"layering one vulnerable model on top of another provides no reliable security boundary";OWASP LLM01:2025 列第一;OpenAI/Anthropic/DeepMind 公认无法在模型层根治)。
- 护栏(由执行层代码强制):**域名白名单、敏感操作审批(支付/删除/发送/凭据字段)、凭据永不进 LLM 上下文/不外发、隔离 profile**。CodeShell 正好用现有确认/限权体系扛。

### 被否决的「捷径」(勿采纳)
- 「compile-once / 确定性蓝图重放把成本降到近零」(arXiv 2604.09718)及其配套的「DOM 净化压 85%」「Rerun Crisis O(M×N)」三条断言,**对抗核验 0-3 全否决**,不纳入决策。

---

## 2. 给 CodeShell 的分阶段落地路线

> 衔接现状:`BrowserPanel`(webview,940 行)已有 loadURL/executeJavaScript/insertCSS/capturePage + picker;`persist:browser` 分区 + hardenWebviewGuests 隔离已就位;Cookie Lease(skill→CLI cookie 桥)设计完整但未实现(TODO 7.5)。

### MVP(P1)——「看 + 点」最小闭环,纯复用现有 webview
1. **观察工具 `browser_snapshot`**:在现有 webview 里 `executeJavaScript` 跑一段脚本,遍历可交互元素(a/button/input/[role]/[onclick]…),输出**带 ref 的精简列表**(`ref` + role + 可见文本 + 必要属性,不含整页 DOM)。复用 picker 已有的稳健 selector 策略给每个元素一个 round-trip 校验过的定位。
2. **动作工具(细粒度,按 ref)**:`browser_click{ref}` / `browser_type{ref,text}` / `browser_navigate{url}` / `browser_scroll`。动作内部把 ref 解析回元素再 executeJavaScript 执行(带 userGesture)。
3. **循环 + 省 token**:engine 已每轮重建上下文 → 把旧 snapshot 折叠成占位符(观察遮蔽),只留摘要 + 最近 N 步;工具定义定型后别动(保 prompt 缓存命中)。
4. **登录态**:直接用 `persist:browser`,遇登录墙/2FA 把面板亮给用户(human handoff)。
5. **安全**:敏感动作走现有审批;域名白名单;隔离 profile 已有。

### 进阶(P2+)
6. **视觉兜底 opt-in**:a11y 树覆盖不到的元素(canvas/地图/自定义 widget)→ `capturePage` + SoM 标注 + `browser_click_xy`。默认关。
7. **Cookie Lease 落地**(TODO 7.5):让 skill 的 CLI(yt-dlp 等)也能用面板登录态。与浏览器自动化是姊妹能力,可并行。
8. **确定性脚本固化**:高频稳定流程(登录态复用、固定表单)抽成确定性脚本,不每步进模型。

### 工具形态决策
- **一组细粒度工具(snapshot / click / type / navigate)** 优于「单个 browser_act 大工具」:对 prompt 缓存友好(工具定义稳定)、对 LLM 决策清晰。
- **暂不做成 MCP server**:MVP 内置工具直连 webview 最简单;若日后要给外部 agent 复用再抽 MCP。

---

## 3. Caveats(落地前复核)
- 数字的配置依赖:观察占比 84%(SWE-bench 特定配置,76–84% 浮动)、prompt 缓存降本 89%(大静态前缀长会话场景)—— 方向性而非普适常数。
- 域适配:观察遮蔽硬证据来自**编码 agent**,迁移到浏览器原理可通但**需自测验证**。
- vendor 自述:Playwright「更省 token/更可靠」、Browserbase 各项为厂商文档,作设计依据可,缺独立第三方基准。
- **逐家对标缺口**:腾讯 WorkBuddy、OpenAI Operator/ChatGPT Agent、Skyvern、Stagehand 的逐家一手架构细节,本轮存活 claim 未直接覆盖(仅行业综述间接提及),如需逐家对标要补定向调研。

## 4. 主要出处
- FillApp 生产经验:https://arxiv.org/html/2511.19477v1
- SeeAct/Mind2Web:https://arxiv.org/pdf/2401.01614
- Set-of-Mark:https://arxiv.org/abs/2310.11441
- 观察遮蔽(The Complexity Trap):https://arxiv.org/pdf/2508.21433
- Playwright MCP:https://github.com/microsoft/playwright-mcp · https://playwright.dev/mcp/vision-mode
- Prompt caching:https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Browserbase 认证/Context:https://docs.browserbase.com/guides/authentication
