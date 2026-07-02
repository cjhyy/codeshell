# 桌面端聊天:流式 Markdown 渲染 + 自动跟随滚动 — 技术方案

> 状态:**已实现**(2026-07-02,worktree `worktree-streaming-md-autoscroll`,未 push)。
> 落地含评审修正(见 §11)。四段提交:阶段1滚动状态机 73871110 / 阶段0a抽取 20f8cb7a /
> 阶段2流式渲染 8e842daf / 阶段0b cwd 6ba23c4b。tsc+build 干净,新增47测试 + 全套715通过。
> 阶段3(活跃代码块分块高亮、桌面/移动滚动统一)未做,可选。
>
> 原方案稿(仅调研 + 设计):2026-07-02 整理。
> 背景:用户反馈桌面端聊天两处体验问题 ——
> (1) assistant/agent 流式输出时先显示 Markdown **原文**,整段 `done` 后才渲染成
> Markdown;希望能边流边渲染,但不能卡顿、不能让代码块/表格剧烈抖动。
> (2) 发送消息后列表应自动跳底、流式时自动向下跟随;只有用户主动上滑时才暂停跟随,
> 回到底部/点跳底/发新消息时恢复。参考 Codex / Claude Code 的交互模型。
>
> 本稿覆盖:现状与证据 → 问题拆解 → 目标交互模型 → 分阶段方案 →
> `StreamingMarkdown` 设计 → 自动滚动状态机设计 → 改动清单 → 测试计划 →
> 风险/性能/回滚。所有实现落地时请遵循 `packages/desktop/CLAUDE.md`
> 的 shadcn + Tailwind v4 约定,并在改后于 `packages/desktop` 跑
> `bunx tsc --noEmit` + `bun run build:renderer`。

---

## 一、当前实现现状(已核实,带出处)

### 1.1 Markdown 渲染:流式=纯文本 `<pre>`,done 后才走完整管线

这是**刻意设计的硬切换**,不是遗漏。三个视图组件用完全相同的 `done ? <Markdown/> : <pre>`
结构,共享一个 CSS class `streamingMarkdownClassName` 与一个 `<pre className="whitespace-pre-wrap font-sans">`。

- **`Markdown.tsx`**(`packages/desktop/src/renderer/Markdown.tsx`)
  - 模块 docstring(第 1–15 行)明说:*"While a message is still streaming we render
    plain text to avoid jitter from re-parsing half-formed markdown on every token."*
  - Props 仅 `{ text; cwd? }`(第 73–82 行),**没有** `done`/`streaming` prop;流式/done
    的判定完全在调用方。
  - 插件栈(第 120、128–132 行):
    ```tsx
    remarkPlugins={[remarkGfm, remarkPathLinks]}
    rehypePlugins={[
      rehypeRaw,
      [rehypeSanitize, SANITIZE_SCHEMA],
      [rehypeHighlight, { detect: true, ignoreMissing: true }],
    ]}
    ```
    顺序注释(第 121–127 行)强调 **raw → sanitize → highlight** 是安全边界:同一个
    `<Markdown>` 会渲染**不可信** LLM/网页转述内容,`rehypeRaw` 把内嵌 HTML 解析成
    hast 后 `rehypeSanitize` 立即清洗(去 `<script>`/`<iframe>`/事件处理器),
    `rehypeHighlight` 最后跑(否则它的 `hljs-*` class 会被 sanitize 剥掉)。
  - `SANITIZE_SCHEMA`(第 35–57 行):基于 rehype `defaultSchema` 最小放宽 ——
    放行 `codeshell-path:` 协议(href/src),`img` 加 `width/height/align`,
    `p/div` 加 `align`,`span/code/*` 放行 `className`(保住高亮 class)。
  - `urlTransform`(第 133–135 行):`codeshell-path:` 原样放行,其余走
    `defaultUrlTransform`。
  - 组件覆盖:`img`(本地/相对图走 `InlineImageLink`)、`a`(路径链接解码 →
    `PathLink`/`InlineImageLink`,普通链接 `codeshell:open-url` 事件)、
    `pre`(每个 fenced block 包 `<CodeBlock>`,超 `CODE_COLLAPSE_LINES=24` 折叠)。
  - `PathLink`:异步 `window.codeshell.fileExists` 校验存在性,`existsCache` Map 缓存;
    **`exists` 为 null(检查中)或 false 时渲染纯 `<span>`**,不成链接。
  - **`export const Markdown = memo(MarkdownImpl)`**(第 116、229 行)。memo 注释
    (第 109–115 行):没有 memo 的话,每个流式 `text_delta` dispatch 都会对 transcript
    里**每一条已完成** assistant 消息重跑一遍 ReactMarkdown/remark-gfm/rehype-highlight,
    是长会话的主要开销。
  - 两个 class 导出(第 84–107 行)是流式那半边的"旋钮":
    ```tsx
    export const markdownBodyClassName = "max-w-[720px] text-sm leading-relaxed ...";
    export const streamingMarkdownClassName = cn(
      markdownBodyClassName,
      "text-muted-foreground [&_pre]:m-0 [&_pre]:whitespace-pre-wrap [&_pre]:border-0 " +
      "[&_pre]:bg-transparent [&_pre]:p-0 [&_pre]:font-sans",
    );
    ```

- **三处硬切换(完全重复的形状)**:
  - `messages/AssistantMessageView.tsx:46-54`
    ```tsx
    {message.done ? (
      <Markdown text={message.text} cwd={cwd} />
    ) : (
      <div className={streamingMarkdownClassName}>
        <pre className="whitespace-pre-wrap font-sans">{message.text}</pre>
      </div>
    )}
    ```
    空文本整体 `return null`(第 37 行),覆盖流式空态与 replay 出的 tool-only turn
    (`done:true, text:""`)。copy 按钮 + 时间戳仅 `done` 时渲染。`memo` 包裹。
  - `messages/AgentMessageView.tsx:89-95`:同样 `done` 门;`bodyText = text + textBuffer`
    (第 32 行);调用 `<Markdown>` **不带 `cwd`**。注释(第 84–88 行)记了具体性能事故:
    *"re-parsing Markdown (remark + rehype-highlight) on every token was a
    ~150ms-per-frame commit that froze the UI (perf: subagent-stream-markdown-reparse)."*
  - `messages/TurnProcessGroupCard.tsx:102-117`:内联 assistant item 同款 `m.done` 门,
    也**不带 `cwd`**(尽管卡片本身收了 `cwd` prop,只转发给 ToolCard,没给内联 Markdown)。

- **没有 `StreamingMarkdown` 组件**,没有增量/半解析器,没有未闭合 code fence 处理。
  唯一的 markdown→plain 工具是 `markdown/stripMarkdown.ts`(正则、非完整解析器,仅供
  copy 按钮)。事件层的"增量"是 `streamCoalescer`(合并 `text_delta`)与
  `streamReducer`(合并工具 args),都不碰 markdown。

### 1.2 自动滚动:一个 32px 阈值的 stick hook,只有 3 处逻辑

- **`chat/stickToBottom.ts`**(全文 55 行,已通读):
  ```ts
  export function useStickToBottom<T extends HTMLElement>(
    trigger: unknown, threshold = 32, jumpKey?: unknown,
  ) {
    const ref = useRef<T>(null);
    const stickRef = useRef(true);

    // (1) 手动滚动检测:距底 ≤ threshold 则 stick,否则释放
    useEffect(() => {
      const el = ref.current; if (!el) return;
      const onScroll = () => {
        const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
        stickRef.current = distance <= threshold;
      };
      el.addEventListener("scroll", onScroll, { passive: true });
      return () => el.removeEventListener("scroll", onScroll);
    }, [threshold]);

    // (2) jumpKey 变化:无条件、瞬时贴底 + 重新 arm(session 切换,layoutEffect 避免闪)
    useLayoutEffect(() => {
      const el = ref.current; if (!el) return;
      el.scrollTop = el.scrollHeight;
      stickRef.current = true;
    }, [jumpKey]);

    // (3) 内容变化(trigger):仅当 stick 时贴底
    useEffect(() => {
      const el = ref.current; if (!el || !stickRef.current) return;
      el.scrollTop = el.scrollHeight;
    }, [trigger]);

    return ref;
  }
  ```
  - **at-bottom 阈值 = 32px**(默认参数)。上滑超过 32px → `stickRef=false`(暂停跟随);
    滚回 32px 内 → 重新 arm。**纯 scroll 事件驱动**,无 ResizeObserver / 无 interval。
  - `jumpKey`(= session id)是唯一的**无条件贴底 + re-arm**入口。

- **`MessageStream.tsx:101-106`** 唯一消费者:
  ```ts
  const ref = useStickToBottom<HTMLDivElement>(
    `${messages.length}:${trailingKey ?? ""}`, 32, engineSessionId ?? null,
  );
  ```
  容器:`<div className="flex-1 overflow-y-auto" ref={ref}>`(第 144 行)。
  **`trigger` = `"消息条数:trailingKey"`**,不编码流式 token/文本长度。

- **关键缺陷推论(与用户反馈吻合)**:
  1. **发送消息不强制贴底/不 re-arm**。`ChatView.submit()`(第 451–476 行)只调
     `onSend`,不碰滚动。新消息靠 `messages.length` 增长改变 `trigger` 才滚 ——
     **且只在 `stickRef` 仍为 true 时**。所以用户上滑后发送,视图**不会**跳到新消息。
     唯一无条件贴底是 session 切换(`jumpKey`)。
  2. **流式跟随粗粒度**。一个 turn 内 token 灌进已有 assistant 消息时 `messages.length`
     不变 → `trigger` 字符串不变 → 内容变化 effect 不重跑。只有追加新消息/卡片或
     `trailingKey` 变时才滚。50ms 批渲染更新内容但不改 `trigger`。**单条消息内部
     增长的跟随基本没接上**(靠后续别的 trigger 追)。
  3. **没有跳底按钮/下箭头**。全 renderer grep:`ChevronDown` 全是折叠/shadcn Select,
     `scrollIntoView` 全是 mention 弹窗/文件面板,`ResizeObserver` 是 composer 自适应
     和终端 FitAddon。**无任何 jump-to-bottom 亲和物**。上滑后回到跟随只能手动滚到底
     或切 session。
  4. **stickToBottom.ts 目前无测试**;`ChatView` 也无测试。

- **移动端另一套实现**(`mobile/components/MessageStream.tsx:115-127`,可对照借鉴):
  用 `endRef` sentinel + `scrollIntoView({ block:"end" })`,依赖 `[chat.items]`(每 item
  变都跟),阈值 **80px**。桌面 vs 移动的分歧(scrollTop vs scrollIntoView、32 vs 80、
  count-dep vs items-dep)统一与否可在方案里一并考虑。

### 1.3 依赖与测试基础设施(已核实)

- 依赖(`packages/desktop/package.json`,均 devDependencies):
  `react 19.2.6`、`react-markdown ^9`(解析 9.1.0)、`remark-gfm ^4`、`rehype-raw ^7`、
  `rehype-sanitize ^6`、`rehype-highlight ^7`、`highlight.js ^11`。
  **无 shiki / prism / marked / use-stick-to-bottom / streaming-markdown**。
  (`marked` 属于 `packages/tui`,与桌面无关。)
- 测试:**`bun test`**(仅根 `package.json` 定义 `"test": "bun test"`);desktop 包**无**
  `test` script,靠 `*.test.ts(x)` 命名被全仓发现。**无 vitest/jest、无 jsdom/happy-dom、
  无 @testing-library**。React 组件测试**全部**用 `react-dom/server` 的
  `renderToStaticMarkup` 断言输出 HTML 串(`toContain`/`not.toContain`/`toBe("")`)。
  **effect / IPC / 点击处理器在测试里都不会跑**(无 DOM 环境)。
- 现有相关测试:`Markdown.test.tsx`(11 用例:路径链接、内联图、XSS 剥离、代码折叠、
  列表标记等)、`MessageStream.test.tsx`(空态守卫)、`AssistantMessageView.test.tsx`
  (空态抑制)、`markdown/remarkPathLinks.test.ts`、`streamCoalescer.test.ts`、
  `lib/streamReducer.test.ts`。

---

## 二、问题拆解

两个独立问题,可各自分阶段落地,互不阻塞:

**问题 A — 流式 Markdown 渲染**
- 现状:流式=纯文本 `<pre>`,done 后才 Markdown。表现为"先原文后突变"。
- 根因是刻意的性能取舍(每 token 全量 re-parse 曾 ~150ms/帧冻 UI)。
- 目标:流式期间也以 Markdown 渲染,但要 (a) 不卡顿(不能每 token 全量重跑重管线);
  (b) 代码块/表格不剧烈抖动(半解析的 fence/表格会反复重排)。
- 挑战:markdown 是块级语法,**流到一半天然是"非法/半成品"**(未闭合 ``` fence、
  半行表格、未闭合 raw HTML)。直接把 buffer 丢进完整管线会:抖动 + 安全/正确性风险
  (半闭合 HTML)+ 性能。

**问题 B — 自动跟随滚动**
- 现状:发送不 re-arm、流式跟随粗粒度、无跳底按钮、上滑后只能手动回底。
- 目标:一个清晰的 stick/refollow 状态机 —— 发送消息强制 re-arm 并贴底;流式时若
  stuck 则平滑跟随;用户主动上滑暂停;回底/点跳底/发新消息恢复;出现跳底按钮当且
  仅当"未 stuck 且不在底"。

---

## 三、Codex / Claude Code 目标交互模型(基于产品常识与本仓可推断原则;不确定处已标注)

> 说明:以下为对标产品的交互模型总结,基于 TUI/CLI 聊天类产品的通行做法与本仓已有
> 注释可推断的原则,**未联网核实**。落地时以我方交互一致性为准,不必逐字复刻。

**流式渲染模型(推断)**
- CC/Codex 的 TUI 是逐行/逐块把稳定内容"提交"到滚动缓冲,**已提交的行不再重排**;
  仍在流入的"活跃尾部"以轻量方式呈现(纯文本或极简着色)。等价原则:
  **"稳定前缀渲染富样式,活跃尾部低成本呈现"**。
- 代码块在 fence 闭合前不做重量级高亮;闭合后一次性高亮。→ 对应我方:**未闭合 fence
  期间当纯文本代码框,闭合后才 highlight**。
- 富交互(可点路径、图片缩略、链接跳转、复制)属于"完成态"能力,流式期间不必即时。

**自动滚动模型(推断,与本仓注释一致)**
- 默认 stick-to-bottom;用户上滑即视为"我在读历史",暂停跟随。
- 新一轮用户输入 = 明确的"带我回当前"信号 → **强制贴底 + re-arm**(这是 CC/Codex 里
  发消息后总能看到自己输入和回复的原因)。
- 提供显式"回到底部"亲和物(TUI 里是快捷键/自动;GUI 里通常是右下角下箭头按钮),
  仅在未跟随且不在底时出现。

---

## 四、推荐方案:分阶段落地(低风险优先)

> 原则:**问题 B(滚动)优先且独立**——纯行为、低风险、可先解决用户最直接的痛点
> (发送后看不到自己消息)。问题 A(流式 Markdown)后做,风险更高,需性能/抖动
> 兜底。两者都做成"可开关、可回滚"。

- **阶段 0(预备,零行为变更)**:抽出共享 `<AssistantBody>`/`<StreamingMarkdown>` 组件,
  把三处重复的 `done ? <Markdown/> : <pre>` 收敛成一处;顺手修 `TurnProcessGroupCard`/
  `AgentMessageView` 丢 `cwd` 的问题(见 §6)。此阶段行为完全不变,仅重构 + 补测试基线。

- **阶段 1(问题 B,滚动状态机)**:升级 `useStickToBottom` 为显式状态机;
  `MessageStream` 的 `trigger` 编码流式尾部长度使流内跟随生效;新增 `reArm()` 并在
  `ChatView.submit()`/`onSend` 时调用;新增右下角跳底按钮。**先上这一阶段并验收。**

- **阶段 2(问题 A,流式 Markdown,保守版)**:`StreamingMarkdown` 采"稳定前缀富渲染 +
  活跃尾部纯文本"策略,流式期间禁用重管线(highlight/raw HTML/图片/路径存在性校验),
  只保 gfm 结构 + 未闭合 fence 兜底;done 后切完整 `<Markdown>`。**默认开启,带 feature
  flag 可关。**

- **阶段 3(可选增强)**:节流/分块高亮活跃代码块;统一桌面/移动滚动实现;把
  `stripMarkdown` 的 fence 检测复用进未闭合 fence 判定。视阶段 2 实测再决定。

---

## 五、`StreamingMarkdown` 设计

### 5.1 组件接口

新增 `packages/desktop/src/renderer/messages/StreamingMarkdown.tsx`,取代三处内联
`done ? … : …`:

```tsx
interface StreamingMarkdownProps {
  text: string;
  done: boolean;
  cwd?: string | null;
  /** 关掉流式富渲染时回退到纯 <pre>(阶段 2 的 feature flag / 保守回滚位) */
  streamingRichRender?: boolean; // default: 从 settings 读,默认 true
}

// 伪代码
function StreamingMarkdown({ text, done, cwd, streamingRichRender = true }: Props) {
  if (text === "") return null;                    // 保留现有空态抑制不变量
  if (done) return <Markdown text={text} cwd={cwd} />;   // 完成态:完整管线,零改动
  if (!streamingRichRender) {                      // 回退 = 今天的行为
    return (
      <div className={streamingMarkdownClassName}>
        <pre className="whitespace-pre-wrap font-sans">{text}</pre>
      </div>
    );
  }
  return <StreamingMarkdownBody text={text} />;     // 阶段 2 的核心
}
```

- 三处调用点(`AssistantMessageView`/`AgentMessageView`/`TurnProcessGroupCard`)统一改为
  `<StreamingMarkdown text=… done=… cwd=… />`,**修掉后两处丢 `cwd`**。
- `done`/空态语义与今天**逐字等价**,阶段 0 可先只做这一层(行为不变),阶段 2 再填
  `StreamingMarkdownBody`。

### 5.2 `StreamingMarkdownBody`:稳定前缀 + 活跃尾部

核心思想:**把流式 buffer 切成"稳定前缀"和"活跃尾部",前缀走(裁剪过的)Markdown
管线,尾部走纯文本**,避免半成品块反复重排。

```
text = "……已完成的段落/闭合的代码块……" + "……正在流入的活跃尾部……"
                    ↑ stablePrefix                    ↑ activeTail
```

**切分规则(伪代码)**,一个纯函数 `splitStreamingMarkdown(text): { stablePrefix, activeTail }`:

```ts
function splitStreamingMarkdown(text: string) {
  // 1. 未闭合的 ``` fence:从最后一个未配对 fence 起,整段(含 fence 行)归入 activeTail,
  //    避免把半个代码块喂给 highlight/解析(fence 数量为奇数 → 有未闭合)。
  // 2. 未闭合的 raw HTML 标签(如 "<div" 没到 ">",或开标签无闭合):从该标签起归 activeTail。
  //    简单实现:检测尾部是否有未闭合的 "<...":用保守正则,宁可多划入尾部。
  // 3. 表格:若最后一块是仅有表头/分隔行、尚无数据行的半张表,把该表块归 activeTail
  //    (半张 gfm 表在 remark 下会反复在"段落 ↔ 表格"间跳,是抖动主因)。
  // 4. 兜底:把 text 的最后一"行"(最后一个 \n 之后)始终归 activeTail —— 正在打字的
  //    行本就不稳定,不值得进管线。
  // 找到最靠前的切点,之前 = stablePrefix,之后 = activeTail。
  return { stablePrefix, activeTail };
}
```

渲染:

```tsx
function StreamingMarkdownBody({ text }: { text: string }) {
  const { stablePrefix, activeTail } = useMemo(() => splitStreamingMarkdown(text), [text]);
  return (
    <div className={markdownBodyClassName}>
      {stablePrefix && <StreamMarkdownPrefix text={stablePrefix} />}
      {activeTail && (
        <pre className="m-0 whitespace-pre-wrap border-0 bg-transparent p-0 font-sans text-muted-foreground">
          {activeTail}
        </pre>
      )}
    </div>
  );
}
```

- `stablePrefix` 是 `useMemo`,只在切分结果变时重算;但 `stablePrefix` 频繁变(每灌一行
  就长一点)仍会 re-parse。**必须节流**(见 5.4)。
- `activeTail` 更新是纯文本 `<pre>`,极廉价,不触发管线。

### 5.3 各能力在 streaming 阶段的取舍

| 能力 | 流式阶段(stablePrefix 管线) | done 后(完整 `<Markdown>`) | 理由 |
|---|---|---|---|
| **remark-gfm**(标题/列表/引用/**表格**) | ✅ 保留(表格靠切分规则 3 兜底半张表) | ✅ | 结构渲染便宜且稳定,是"边流边渲染"的主体价值 |
| **未闭合 code fence** | 归入 activeTail 当纯文本 | 闭合后正常代码块 | 半个 fence 喂 highlight = 抖动 + 报错 |
| **代码高亮 rehype-highlight** | ❌ 流式禁用(闭合的 fence 也先不高亮,纯 `<pre>` code) | ✅ 高亮 | highlight 是最贵的一步(150ms 事故来源);流式先不高亮 |
| **raw HTML rehype-raw** | ❌ 禁用(未闭合标签当纯文本;闭合标签也先当纯文本/转义) | ✅ raw→sanitize | 半闭合 HTML 的安全 + 解析风险最高;流式期不值得 |
| **rehype-sanitize** | 流式禁用 raw 后,无 raw HTML 需清洗;若保留任何 HTML 通路必须保留 sanitize | ✅ 必须 | **安全不可退让**:任何时候放行 HTML 都必须先 sanitize |
| **remarkPathLinks / PathLink 存在性校验** | ❌ 流式当普通文本/普通链接(不发 `fileExists` IPC) | ✅ 校验+可点 | 流式期路径还在打,存在性校验既无意义又刷 IPC;done 一次性做 |
| **内联图片 InlineImageLink** | ❌ 流式不加载(不发 `readImageDataUrl`) | ✅ 缩略图+Lightbox | 图 URL 流到一半会反复触发加载失败/闪 |
| **CodeBlock 折叠/复制** | ❌ 流式不折叠不给复制按钮(纯 `<pre>`) | ✅ | 折叠阈值/复制属完成态交互 |
| **空文本抑制** | ✅ 与今天一致 | ✅ | 保 replay tool-only turn 不出空块 |

一句话:**流式只做"便宜且稳定"的结构渲染(gfm 块级),把"贵/半成品/需 IPC/需安全清洗"
的能力全部推迟到 `done`。**

### 5.4 节流(防卡顿的关键)

- `stablePrefix` 的 Markdown 解析用**时间节流**,而非每次 render 都跑。建议:
  - 用 `useDeferredValue(stablePrefix)`(React 19 已在,`react 19.2.6`)让高频尾部更新
    不阻塞前缀重渲染;**或**
  - 一个 `useThrottle(stablePrefix, ~120ms)`:前缀最多每 ~120ms re-parse 一次。
- 事件层已有 `streamCoalescer`(50ms 批)减少 dispatch;组件层再叠一层前缀节流。
- **保持 `Markdown`/`StreamMarkdownPrefix` 的 `memo`**:transcript 里已完成消息绝不因某条
  流式而 re-parse(现有 memo 注释点名的正是这个开销)。

### 5.5 安全边界(不可退让)

- 流式阶段**默认禁用 raw HTML**(不挂 `rehypeRaw`),`StreamMarkdownPrefix` 用比
  `Markdown` 更窄的管线:`remarkPlugins=[remarkGfm]`,`rehypePlugins=[]`(无 raw、无
  highlight、无 sanitize —— 因为没放行 HTML 就无需清洗;若将来给流式前缀开任何 HTML
  通路,**必须同时挂回 `rehypeSanitize`**)。
- 这样流式期天然规避半闭合 `<script>`/`<iframe>` 风险;done 后由现有
  `raw→sanitize→highlight` 管线兜住。

---

## 六、自动滚动设计:stick/refollow 状态机

### 6.1 状态模型

把当前隐式的 `stickRef: boolean` 显式化为三态(便于驱动跳底按钮 UI):

```
enum FollowState { Following, Paused }   // 是否跟随流式底部
+ 派生: showJumpButton = (state === Paused) && !isNearBottom(threshold)
```

- `Following`:内容增长时贴底(现有行为)。
- `Paused`:用户主动上滑触发;内容增长**不**贴底;显示跳底按钮。

### 6.2 升级后的 `useStickToBottom`(伪代码)

```ts
interface StickApi {
  ref: RefObject<HTMLElement>;
  atBottom: boolean;        // 供跳底按钮显隐
  following: boolean;
  scrollToBottom: () => void;   // 点跳底按钮/发消息调用:贴底 + re-arm
}

function useStickToBottom<T>({ trigger, jumpKey, threshold = 32 }): StickApi {
  const ref = useRef<T>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);   // 仅为 UI,用 state
  const [following, setFollowing] = useState(true);

  // (1) 手动滚动检测:区分"用户上滑"与"程序贴底"
  //   —— 程序 scrollTop=scrollHeight 也会触发 scroll 事件;用一个 isProgrammatic 标志
  //      或对比 distance 判定,避免把自己的贴底误判成用户操作。
  onScroll: distance = scrollHeight - (scrollTop + clientHeight);
           near = distance <= threshold;
           setAtBottom(near);
           if (!isProgrammatic) { stickRef.current = near; setFollowing(near); }

  // (2) jumpKey(session 切换):layoutEffect 无条件贴底 + re-arm(不变)
  useLayoutEffect(scrollToBottomNow + arm, [jumpKey]);

  // (3) trigger(内容变化,含流式尾部长度):仅 following 时贴底
  useEffect(() => { if (stickRef.current) scrollToBottomNow(); }, [trigger]);

  const scrollToBottom = () => { arm(); scrollToBottomNow(); };  // 显式 re-arm

  return { ref, atBottom, following, scrollToBottom };
}
```

要点:
- `stickRef`(高频、无需 render)与 `atBottom/following`(低频、驱动 UI)分离:滚动跟随
  逻辑仍走 ref 避免每帧 setState;跳底按钮显隐用 state。
- **程序性贴底不能被 scroll 监听误判为用户操作**(否则边跟随边被自己关掉)。用一个
  `isProgrammaticRef` 在 `scrollToBottomNow()` 前后置位,或改用比较目标位置的方式。

### 6.3 发送用户消息 → 强制 re-arm(问题 B 的核心修复)

- 在 `MessageStream` 把 `scrollToBottom` 通过 ref/回调暴露给 `ChatView`,或更简单:
  **给 `MessageStream` 加一个 `sendEpoch`/`forceBottomKey` prop**,`ChatView.submit()` 成功
  调 `onSend`/`onQueueInput` 时自增;`MessageStream` 内用 `useLayoutEffect([forceBottomKey])`
  无条件贴底 + re-arm(复用 `jumpKey` 那条 layoutEffect 的同款逻辑,或直接把
  `forceBottomKey` 也并进 `jumpKey`)。
- 效果:无论用户当前是否上滑,发送后**必定**跳到底看到自己的消息,并恢复跟随。
- 落点:`ChatView.tsx` 第 451–476 行 `submit()`;`MessageStream.tsx` hook 调用处。

### 6.4 streaming trigger 选择(让流内跟随生效)

- 现 `trigger = "${messages.length}:${trailingKey}"` 不含流式文本长度 → 单条消息内部
  增长不触发贴底。
- **改为把"活跃尾部长度"并进 trigger**,例如:
  ```ts
  const liveTail = liveTurnActive ? (lastAssistantText?.length ?? 0) : 0;
  const trigger = `${messages.length}:${trailingKey ?? ""}:${bucket(liveTail)}`;
  ```
  - 用 `bucket(len) = Math.floor(len / 40)`(每 ~40 字符一跳)避免每 token 一次 effect,
    与 §5.4 节流精神一致;流式已有 50ms 批,叠加桶化足够平滑。
  - 只在 `liveTurnActive` 时纳入,历史消息不影响 trigger。
- **不要**用 ResizeObserver 每像素跟(会与富渲染/图片加载互相触发抖动);trigger + 节流
  更可控。

### 6.5 用户上滑暂停 / 恢复

- **暂停**:上滑距底 > 32px → `stickRef=false`, `following=false`(6.2 的 onScroll)。
- **恢复**(三条,任一即可):
  1. 手动滚回距底 ≤ 32px → 自动 re-arm(现有);
  2. 点击**跳底按钮** → `scrollToBottom()`(新增);
  3. **发送新消息** → 强制 re-arm(§6.3)。
- 阈值维持 **32px**(桌面);是否与移动端 80px 统一留阶段 3。

### 6.6 跳底按钮(需要)

- **需要**。这是用户上滑读历史后回到当前的显式亲和物,也是流式跟随被暂停时的可见反馈。
- 位置:滚动容器右下角,`position: absolute`,右下角悬浮;用
  `@/components/ui/button`(遵守 CLAUDE.md,不手写 `<button>`),`ChevronDown` 图标
  (`./ui/icons` 已有)。
- 显隐:`showJumpButton = !atBottom`(不在底就显示,不要求同时 Paused —— 更符合直觉:
  只要没在底就给回底入口)。可带一个"有新内容"小圆点当 `following===false && 有新消息`。
- 无障碍:`aria-label` + i18n key(`chat` ns,zh+en 都加,见 `project_desktop_i18n`)。

---

## 七、需要修改的文件清单与改动要点

> 全部在 `packages/desktop`;不碰 `packages/core`。遵守 shadcn/Tailwind 约定。

**问题 B(滚动,阶段 1,先做)**
1. `src/renderer/chat/stickToBottom.ts`
   - 改造为 §6.2 的 `StickApi`(返回 `{ ref, atBottom, following, scrollToBottom }`);
     `stickRef` 高频 / `atBottom`&`following` state;加 `isProgrammaticRef` 防误判;
     保留 `jumpKey` layoutEffect。**保持向后兼容**:可先新增签名、旧签名 deprecate,
     或一次性改 + 改唯一消费者。
2. `src/renderer/MessageStream.tsx`
   - hook 调用改新签名;`trigger` 并入活跃尾部桶化长度(§6.4);渲染跳底按钮
     (`atBottom` 控制显隐,`scrollToBottom` 点击);新增 `forceBottomKey`/`sendEpoch`
     prop 并接进贴底(§6.3)。
3. `src/renderer/ChatView.tsx`
   - `submit()` 成功发送后自增 `sendEpoch`,透传给 `<MessageStream>`(第 699–707 行附近)。
4. `src/renderer/i18n/ns/chat.ts`
   - 加跳底按钮 `aria-label`/tooltip key(zh + en 同加)。

**问题 A(流式 Markdown,阶段 0 重构 + 阶段 2 富渲染)**
5. `src/renderer/messages/StreamingMarkdown.tsx`(**新增**)
   - §5.1 外层 + §5.2 `StreamingMarkdownBody` + §5.4 节流 + §5.5 窄管线
     `StreamMarkdownPrefix`。
6. `src/renderer/messages/AssistantMessageView.tsx`
   - 第 46–54 行 `done ? … : …` 换成 `<StreamingMarkdown text={message.text} done={message.done} cwd={cwd} />`;空态抑制不变。
7. `src/renderer/messages/AgentMessageView.tsx`
   - 第 89–95 行同上,**补上 `cwd`**(若该上下文能拿到 workspace;拿不到则维持无 `cwd`
     但要在组件里保持相对图降级为链接的现有语义)。
8. `src/renderer/messages/TurnProcessGroupCard.tsx`
   - 第 102–117 行内联 assistant 分支换 `<StreamingMarkdown>`,**把卡片已有的 `cwd`
     prop 转发进去**(修 §1.1 记的丢 `cwd` 不一致)。
9. `src/renderer/markdown/splitStreamingMarkdown.ts`(**新增**,纯函数)
   - §5.2 切分规则;可复用 `stripMarkdown.ts` 的 fence 正则思路(§3 阶段 3)。
10. `src/renderer/Markdown.tsx`
    - 可导出 `StreamMarkdownPrefix`(窄管线)或把窄管线放 `StreamingMarkdown.tsx`;
      `streamingMarkdownClassName`/`markdownBodyClassName` 复用,不改语义。
11. (可选)settings:若做 feature flag `streamingRichRender`,加一处开关
    (`settings/*` + `i18n/ns/settings.ts`,zh+en);默认 true。

---

## 八、测试计划(`bun test`,`renderToStaticMarkup` 断言 HTML 串)

> 约束:无 DOM/jsdom、无 testing-library,effect/点击/IPC 在测试里不跑。所以:
> **纯函数尽量抽出来单测;组件测静态输出;交互/滚动靠手动验证。**

**单元测试(纯函数,最高价值)**
- `markdown/splitStreamingMarkdown.test.ts`(新增):
  - 未闭合 ``` fence → fence 起归 activeTail;闭合后整段归 stablePrefix。
  - 半张表(仅表头/分隔行)→ 归 activeTail;补齐数据行后 → 归 stablePrefix。
  - 未闭合 `<div`/`<span` → 归 activeTail。
  - 末行(最后 `\n` 后)始终在 activeTail。
  - 空串 / 纯文本 / 多段混合的边界。
- `chat/stickToBottom` 里可抽出纯计算 `isNearBottom(scrollHeight, scrollTop, clientHeight, threshold)`
  单测(hook 本身依赖 DOM,难在 bun test 直接测)。
- trigger 计算若抽成纯函数(`buildScrollTrigger(messages, liveTurnActive, trailingKey)`)
  也单测桶化边界。

**组件测试(`renderToStaticMarkup`)**
- `messages/StreamingMarkdown.test.tsx`(新增):
  - `done:false` 且富渲染开:稳定前缀出现结构标签(如 `<h1>`/`<ul>`/`<table>`),
    活跃尾部在 `<pre>`(断言 HTML 含预期标签 / 尾部文本在 pre 内)。
  - `done:false` 且 fence 未闭合:代码内容在 `<pre>` 纯文本、**不含** `hljs-` class。
  - `done:false` 时**不含** `<script>`/`<iframe>`(即便文本里有,窄管线不放行 raw HTML)。
  - `done:true`:等价于 `<Markdown>` 完整输出(含 `hljs-`、路径链接为纯 span 等,复用
    `Markdown.test.tsx` 已有断言风格)。
  - `text===""` → `toBe("")`(保空态不变量,对齐 `AssistantMessageView.test.tsx`)。
  - `streamingRichRender:false` → 回退为今天的 `whitespace-pre-wrap` `<pre>`。
- 更新/保留 `MessageStream.test.tsx`、`AssistantMessageView.test.tsx` 现有空态断言不回归。
- 跳底按钮:静态渲染下 `atBottom` 初值决定是否输出按钮标签 —— 可断言初始不渲染
  (在底);显隐切换靠手动验证。

**手动验证用例(DevTools / 真跑)**
- 滚动:发消息后必跳底看到自己输入;流式时贴底跟随不闪;上滑 > 32px 暂停 + 跳底按钮
  出现;点按钮回底并恢复跟随;滚回底部自动恢复;切 session 瞬时贴底无闪。
- 流式 Markdown:长回答里含标题/列表/表格/代码块,观察 (a) 结构边流边现;(b) 代码块
  在 fence 闭合前不高亮、闭合后一次高亮,无反复重排;(c) 表格半张时不跳变;
  (d) done 后路径可点、图片加载、复制按钮出现;(e) 恶意 `<script>`/`<img onerror>`
  在流式与 done 两态都不执行。
- 性能:长会话(>50 轮)里流式一条新消息,DevTools Performance 看无长任务尖峰
  (对比现状);历史消息不 re-parse(可临时 log)。
- 一致性:`bunx tsc --noEmit` + `bun run build:renderer`(在 `packages/desktop`)。

---

## 九、风险、性能考虑、回滚

**性能**
- 最大风险仍是 §1.1 记的 150ms/帧事故重演。三重防线:
  (1) 活跃尾部纯文本零管线;(2) `stablePrefix` 时间节流 / `useDeferredValue`;
  (3) 组件 `memo` 保住历史消息不 re-parse;(4) 流式禁用最贵的 highlight/raw。
- trigger 桶化(每 40 字符)避免流内跟随每 token 触发 layout。

**风险**
- **抖动**:切分规则不当会让块在"稳定/活跃"间抖。缓解:切点宁可保守(多划入 activeTail),
  只在明确闭合后才进 stablePrefix;半张表整块归尾部。
- **安全**:流式窄管线**不放行 raw HTML**是关键;任何时候若给流式开 HTML 通路,必须挂回
  `rehypeSanitize`(§5.5)。code-review 时重点核这条。
- **误判用户滚动**:程序贴底触发 scroll 事件被当成用户上滑 → 需 `isProgrammaticRef`
  防护(§6.2),否则出现"跟随一下就自己停"。
- **两处丢 `cwd`** 修复后,`AgentMessageView` 若确实无 workspace 上下文,保持相对图降级
  为链接的现有语义,别硬塞错误 `cwd`。

**回滚**
- 阶段 1(滚动)与阶段 2(流式 Markdown)物理解耦,可各自回滚。
- 流式富渲染带 `streamingRichRender` feature flag(默认 true);出问题**关 flag 即回到
  今天的纯 `<pre>` 行为**,无需 revert 代码。
- `StreamingMarkdown` 的 `done`/空态语义与今天逐字等价,阶段 0 重构本身零行为变更,
  是安全的回滚锚点。
- git 层面:按记忆 `feedback_git_commit_on_main`,此为功能改动 → 走 worktree,别动 main。

---

## 十、落地顺序小结

1. 阶段 0a:抽 `StreamingMarkdown`(**逐字等价,零行为变更**)+ 补组件测试基线。
   阶段 0b:补 `cwd`(**有意行为变更,独立提交+测试**)。见 §11-S1。
2. 阶段 1:滚动状态机 + 发送 re-arm + 流内跟随 + 跳底按钮(**先交付验收**)。
3. 阶段 2:`splitStreamingMarkdown` + `StreamingMarkdownBody` + 窄管线 + 节流
   (feature flag 默认开)。
4. 阶段 3(可选):活跃代码块分块高亮、桌面/移动滚动统一。

---

## 十一、评审修正(2026-07-02,对抗性设计评审 + 代码事实核实后)

> 代码事实层面全部核实通过(行号/依赖/文件位置与现状一致)。核心方向不变
> (闭合块富渲染、未闭合当源码),但以下设计细节按原文实现会重新引入它要避免的
> 抖动/卡顿。落地以本节为准,覆盖上文冲突处。

**C4(覆盖 §5.2/§5.4)— 稳定前缀必须分块 memo,不能整段重解析。**
react-markdown 无增量解析,每 tick 全量重解析整个 `stablePrefix` = O(前缀长度),长回答
下尾部照样 jank(150ms 事故本质)。改法:`stablePrefix` 按**空行(`\n\n`)切成 chunk**,
每个 chunk 一个 `memo` 化的 `<StreamMarkdownPrefix>`,key = chunk 序号 + 内容 hash;只有
**最新一个 chunk** 会随流入重解析,已定稿 chunk 不再 re-parse。这才实现 §3 引用的
"已提交行不再重排"。`useDeferredValue` **不替代**节流(它不限频,见 N2),节流为主。

**C3+C1(覆盖 §5.2 规则 1/4)— 切点是空行边界,fence 检测按 CommonMark。**
- 基准切点 = **最后一个空行(`\n\n`)边界**,不是"最后一个 `\n`"。否则 setext 标题
  (下一行 `===`/`---` 才成标题)、段落懒延续、list loose/tight 会让已"稳定"的块回头突变。
- fence 检测**不能只数 ```` ``` ```` 奇偶**:必须行锚定(仅匹配行首 fence),含 `~~~`
  变体,按 fence 长度(4+ 反引号需 ≥ 同长度闭合)判定,**排除行内代码**里的反引号。
- 不确定 → 一律划入 `activeTail`(保守不变量)。
- 测试补:`~~~` 围栏、行内代码含反引号、4+ 长度 fence、setext 标题下划线流入。

**C2(§5.2 已知限制)— 引用式链接/脚注跨切分会短暂裂开。**
`[x]` 在前缀、`[x]: url` 在尾部时,前缀渲染成裂开文本、done 后才成链接。标为已知限制;
不额外处理(空行切分已把最后段落留在尾部,缓解大部分情况)。

**S2(覆盖 §6.2/§9)— 程序性贴底用比对目标位置,不用同步标志。**
`scrollTop=scrollHeight` 触发的 scroll 事件是**异步**的,同步置位/清除 `isProgrammaticRef`
会在事件到达前清掉 → 误判用户上滑 → "跟随一下就自己停"。**改用位置比对**:onScroll 里
若 `Math.abs(scrollTop - lastProgrammaticTop) < 2` 或刚请求过贴底且在阈值内,则忽略该事件。
删除 §9 里"标志置位"那个二选一。

**S3(覆盖 §6.4)— 用 `ResizeObserver` + `following` 门控替代字符桶化 trigger。**
字符数观察不到 `<pre>`→富渲染切换时的**高度突变**(stuck 时 scrollHeight 变了 scrollTop 没变
= 掉出底部)。正解:`ResizeObserver` 挂内容元素,**仅当 `following===true` 时** `scrollTop=
scrollHeight`。§6.4 反对 RO 的理由是反的——只在 following 时贴底不会"抖",抖来自与用户滚动
对抗,而 following 门正好挡住。RO 天然 post-layout,也顺带解决 N3 的读到陈旧 scrollHeight。
字符桶化仅作 RO 不可用时的降级兜底。

**S1(覆盖 §4 阶段 0)— 阶段 0 拆成 0a/0b。**
"零行为变更/逐字等价回滚锚点"与"顺手修 cwd"矛盾:补 cwd 就是行为变更(相对图从降级
链接变可点)。0a = 纯抽取(三处转发与今天完全一致,含**保持**不传 cwd 处);0b = cwd 修复
(独立提交+测试)。§9 的"逐字等价回滚锚点"只对 0a 成立。

**S5(覆盖 §8)— 滚动状态机抽成纯 reducer 才有自动化覆盖。**
`renderToStaticMarkup` 下 effect/点击/IPC 不跑,问题 B 全靠手动验(尤其 S2 的 async race
手动常漏)。把状态转移抽成纯函数
`nextFollowState(prev, {kind:'scroll'|'send'|'jumpClick'|'sessionSwitch', distance, threshold, lastProgrammaticTop})`,
DOM 胶水(挂监听/`scrollTop=`)留薄层手动。B 的主测试策略 = reducer 100% 单测。

**N1(§5.5 显式化)— 窄管线依赖 react-markdown 内置 `defaultUrlTransform`。**
无 rehypeRaw → HTML 被转义不解析(安全成立);默认 urlTransform 即使零插件也拦
`javascript:`/`vbscript:`/`file:`。**窄管线必须不传自定义 `urlTransform`**(完整 `Markdown.tsx`
传了白名单 `codeshell-path:` 的自定义版,流式窄管线要省掉、让默认跑)。防未来静默改坏。

**N5(§5 补一行)— abort/error 时 `done` 语义。**
终态(abort/error)一律走完整管线渲染(依赖 rehype-highlight 的 `ignoreMissing` 容忍未闭合
fence),不能让消息永远卡在 streaming 态(尾部半个代码块的 `<pre>`)。

**N4(§6.6 补)— 流式 body 无障碍。**
流式 body 用 `aria-busy` 期间,`done` 后再 announce 一次(或 debounced live region),
避免每 50ms 更新 + 前缀↔尾部 DOM swap 刷屏 SR。

**已确认无问题(非冗余,明确清掉)**:安全模型(§5.5)成立;highlight/raw/IPC/存在性校验
推迟到 done(§5.3)正确;`stickRef`(ref)与 `atBottom/following`(state)分离(§6.2)正确;
B 先于 A(§4)正确;feature flag 回滚(§9)成立(拆 0a 后)。
```
