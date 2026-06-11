# Context: composer 输入框「窄时 pills 省略」要用 @container,但之前实现会塌陷

## 目标(你要实现的)
codeshell desktop(Electron + React + Tailwind v4.3)的聊天输入框(composer)底部有一排 pills
控件:PermissionPill(权限模式)、GoalToggle、ModelPill(模型选择)。

需求:**当 composer 自身被挤窄时(开右侧面板会挤窄 composer,但视口宽度不变),pills 收起文字标签、
只显示图标/色点。** 因为是「按 composer 自身宽度」而非「视口宽度」,所以必须用 **CSS 容器查询
`@container`**,不能用 `@media`(媒体查询按视口,开面板时视口没变不会触发)。

## 关键约束:之前用 @container 实现会导致输入框「塌陷/消失」
我们之前在 composer 卡片(`rounded-xl` 那个 div,它同时包着 textarea 和 pills)上加了 Tailwind 的
`@container` 工具类(生成 `container-type: inline-size`)。pills 里用 `@max-[480px]:hidden` /
`@max-[480px]:inline-block` 做省略。

**症状(已用祖先高度日志证实):**
- 进一个 session → 开右侧面板 → 切到新对话 → 再切回来,**整个 composer(含 textarea)高度坍缩到 0**,
  输入框消失。改 textarea 的 inline `height` 无效(被容器压制),改 `display` 能临时恢复。
- 日志证据:塌陷时,带 `@container` 的卡片那一层 `getBoundingClientRect().height` 从正常的 ~96px
  掉到 54px,再把里面的 `div.relative` 和 textarea 压成 height=0。`container-type` 计算值是
  `inline-size`(理论上 inline-size 只约束宽度不该坍缩高度,但实测在「session 切换 + 面板开着」的
  重排时序下确实坍缩了)。
- 这是**稳定可复现**的(不是 HMR 脏状态;重启 dev server 后干净实例仍复现)。

**我试过但失败/放弃的方案:**
1. 把 @container 留在卡片,改 textarea 高度计算逻辑(useLayoutEffect 依赖、min-height 下限、
   ResizeObserver、rAF 延迟测量)——全无效,因为塌的不是 textarea 自己(它一直量出正常 36px),
   是外层带 @container 的卡片容器被坍缩。
2. 把 @container 从卡片**移到 pills 所在的控件行**(那行是单行 flex,不含 textarea,
   container-type 坍缩它自己无害)——结果 pills 的 `@max-[480px]:` 行为异常:即使控件行实测
   宽度 630/898px(>480),pills 的 label 也被隐藏甚至整个 pill 消失。怀疑是容器查询基准/嵌套
   或 Tailwind v4 生成的类没正确匹配,没深究。
3. 当前已**删掉所有 @container 和 @max-[480px]**,改成 pills label 始终显示(加 truncate)。
   输入框不塌了,但失去了「窄时省略」。

## 现在的代码状态(干净基线,在此基础上加省略)

### composer 卡片(packages/desktop/src/renderer/ChatView.tsx,约 L693)
```tsx
<div
  className={
    // min-w-[300px]: 防止侧面板挤压时 composer 缩成不可用的细条
    "min-w-[300px] rounded-xl border bg-card p-2 shadow-sm" +
    (dragOver ? " ring-2 ring-primary/40" : "")
  }
>
  {/* anchors / attachments / 错误提示 ... */}
  <div className="relative">
    {/* MentionPopover ... */}
    <textarea
      ref={textareaRef}
      rows={1}
      className="max-h-[200px] min-h-[36px] w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed ..."
      style={{ height: "..." }}  // JS 自适应高度,见下
    />
  </div>
  {/* 控件行(pills 所在) */}
  <div className="mt-1 flex items-center justify-between gap-2">
    <div className="flex items-center gap-1.5">
      <button>{/* 📎 添加图片 */}</button>
      <PermissionPill .../>
      <GoalToggle .../>
    </div>
    <div className="flex items-center gap-1.5">
      <ContextRing .../>
      <ModelPill .../>
      <button>{/* 🎤 语音(disabled) */}</button>
      {/* 发送按钮等 */}
    </div>
  </div>
</div>
```

### ChatView 根布局链(从 composer card 往上,active 模式)
```
div.flex.h-full.flex-col          (ChatView 根, h-full)
  └ MessageStream (flex-1)        (消息流,占主空间)
  └ div.contents                  (active 模式是 display:contents,新对话模式是 flex flex-1 ... justify-center)
      └ div.shrink-0.p-3          (composer 外壳,shrink-0 防被 flex 挤压 —— 这是之前修塌陷加的)
          └ div.min-w-[300px].rounded-xl.border.bg-card.p-2   ← 想加省略的卡片(之前 @container 加这里会塌)
              └ div.relative
                  └ textarea.min-h-[36px].max-h-[200px]
              └ div.mt-1.flex.justify-between   ← 控件行(pills 在这)
```
新对话模式(isNewChat):composer 外壳是 `w-full max-w-2xl p-3`,外面是
`flex flex-1 flex-col items-center justify-center px-4`(居中 hero)。

### pills 组件当前代码(已去掉省略,label 常显)
PermissionPill(packages/desktop/src/renderer/chat/PermissionPill.tsx):
```tsx
<button className="cs-control inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ...">
  <span className="truncate">{cur.label}</span>
  <ChevronDown size={11} className="shrink-0 opacity-60" />
</button>
```
ModelPill(packages/desktop/src/renderer/chat/ModelPill.tsx):
```tsx
<button className="cs-control inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ...">
  <Zap size={12} className="shrink-0" />
  <span className="truncate">{label}</span>
  <ChevronDown size={11} className="shrink-0 opacity-60" />
</button>
```
GoalToggle(packages/desktop/src/renderer/chat/GoalToggle.tsx):
```tsx
<button className="composer-pill goal-toggle...">
  <Target size={12} className="shrink-0" />
  <span>Goal</span>
</button>
```

### textarea 高度自适应(供参考,别破坏它)
```tsx
const measureComposer = useCallback(() => {
  const ta = textareaRef.current;
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = Math.min(Math.max(ta.scrollHeight, MIN_TEXTAREA_PX /*36*/), MAX_TEXTAREA_PX /*200*/) + "px";
}, []);
// 两个 useLayoutEffect:一个依赖 [draft] 重测;一个挂 ResizeObserver(ta) 重测。
```

## 给 GPT 的任务
设计一个用 `@container` 实现「composer 窄时 pills 收起文字、只留图标/色点」的方案,**且绝不让
composer / textarea 高度坍缩到 0**。

必须解决的核心难题:为什么在 `container-type: inline-size` 的卡片上,session 切换 + 面板开着的
重排时序会把卡片高度坍缩到 0(连带 textarea)?给出根因分析 + 一个稳定不塌的实现。

可考虑的方向(任选/自创,要解释为什么不塌):
- 用一个**专门的、宽度跟随 composer 但高度不影响 textarea**的容器作为 `@container` 上下文
  (例如把 textarea 和控件行分开,只让控件行所在的某个「宽度撑满父级」的 wrapper 作 container,
  且保证 pills 的 `@max-[…]:` 基准正确);注意我们试过把 @container 放控件行,pills 反而异常消失
  (见上方失败方案 2),需要解释那次为什么坏、你的方案为何不会。
- 或显式控制 `container-type`(只 inline-size)+ 给受 containment 影响的子树加显式 min-height /
  `contain` 调整,使高度不被坍缩。
- 或用 `@container` 的命名容器(`container-name` / `@container/name`)精确锁定查询目标,避免嵌套
  歧义。

环境:Tailwind v4.3(`@tailwindcss/vite`),React 19,Electron renderer。Tailwind v4 的容器查询
语法:`@container`(可加 `/name`)、`@max-[480px]:hidden`、`@sm:`/`@md:` 等。

交付:改好的 ChatView.tsx 卡片/控件行结构 + 三个 pill 组件的省略类,附根因说明。要能通过
`bunx tsc --noEmit` 和 `bun run build:renderer`(在 packages/desktop 下)。
```
```
