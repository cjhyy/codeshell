# 真机冒烟 Checklist — Steer 排队/引导改造 (2026-06-23)

合并:main `4d2c9e28`(feature `3d48a9e8`)。**未 push。**

本次改动把「排队 / 引导」语义整体纠正,涉及 core→protocol→preload→renderer 五层 + 一个新
RPC(`agent/unsteer`)。单测/tsc/build 全绿,但**步间 steering 的真实时序、撤回竞态、resume
行为只能真机验**。下面逐项打勾。

> 跑法:在仓库根 `bun run dev`(desktop)。建议开 `~/.code-shell/logs/`(`scripts/logs.sh`)
> 边操作边看 `stream.event` / `stop.click` 等日志。找一个会跑多步(多次工具调用)的长任务
> 当测试床,否则没有"步间隙"可观察。

---

## A. 核心新行为:排队 = 不打断、步间插入

- [ ] **A1 排队可见**:发一条会跑多步的长任务 → busy 中在输入框打字按 **Enter** → 这条进入
      「后续变更」排队面板**并停留可见**(不是一闪就没)。
- [ ] **A2 步间插入**:等当前这一步(工具/LLM)结束、进入下一步 → 排队那条**自动消失**并变成
      对话流里的 **user 气泡**;AI 下一步的回复确实**看到了**这条内容。
- [ ] **A3 不打断**:A2 发生时当前轮**没有被 abort**(没有「你在 Ns 后停止了」标记,进行中的
      那一步没丢)。
- [ ] **A4 多条排队**:busy 中连续 Enter 两三条 → 都进面板可见 → 各自在后续步边界依次插入变气泡
      (每条只插入一次,**不重复**)。
- [ ] **A5 cachedHint 文案**:若出现「已排队 N 条,将在下一步插入当前轮」提示,文案正确(不再是
      旧的「本轮结束后发送」)。

## B. 两个「引导」按钮都 = 强行打断

- [ ] **B1 输入框「引导」**:busy 中输入框打字 → 点输入框右侧「引导」按钮 → **立刻打断当前轮**
      (abort)并把这条作为新一轮重发;出现停止标记 + 新 user 气泡。
- [ ] **B2 排队区「全部引导」**:busy 中排队 ≥1 条 → 点排队面板上的「全部引导」 → **立刻打断**
      当前轮,把排队全部条目**合并成一条**重发。
- [ ] **B3 tooltip 名实相符**:两个按钮 hover 的 tooltip 都说「打断当前轮…」且行为确实是打断
      (改造前「全部引导」tooltip 说打断却没打断 → 现已一致)。

## C. 真撤回(unsteer RPC)

- [ ] **C1 撤回未消费**:busy 中 Enter 排一条 → **趁它还在面板里(还没变气泡)**点该条的删除(垃圾桶)
      → 它从面板消失,且**之后不会**再作为 user 气泡出现(引擎队列里被真删掉了)。
- [ ] **C2 撤回来不及(静默)**:排一条后**故意慢点**删,若引擎已在某步把它消费了 → 删除点下去
      **不报错**,这条照常变成 user 气泡(removed=false 静默留着)。不应出现卡死/红错/重复气泡。
- [ ] **C3 清空全部**:排多条 → 点排队面板「清除」→ 未消费的全部撤回消失;已消费的静默变气泡。
- [ ] **C4 撤回竞态**:排 3 条,删中间那条的同时另一条正好插入 → 删对了目标(按 id 不按下标),
      没有误删别的条目。

## D. Resume / 持久化(回归,改造前修过双气泡,别打破)

- [ ] **D1 步间插入后 resume**:A2 让一条 steer 变气泡后,**刷新页面 / 重开该会话** → 这条 user
      气泡**只出现一次**(不双份)。`steer_injected` 是 live-only,resume 靠 transcript 重建。
- [ ] **D2 打断轮 resume**:B1/B2 打断后刷新 → 被打断那轮折叠/标记正常(「你在 Ns 后停止了」还在,
      没退化成普通折叠进度卡)。

## E. 边界 / 不回归

- [ ] **E1 idle 发送照常**:不 busy 时正常发消息 = 直接发,行为不变。
- [ ] **E2 空闲排队**:极端情形若在 idle 把内容排进队列(正常走 send),不卡、不丢。
- [ ] **E3 多会话并发**:两个会话同时跑,在 A 会话排队 steer 只影响 A,不串到 B(按 engineSessionId
      路由 + 按 bucket 移除队列条目)。
- [ ] **E4 子代理不受影响**:有后台子代理在跑时,主 run 的排队/插入正常(sub-agent sessionId 不暴露给
      UI,天然不被 steer)。

---

## 已知设计取舍(不是 bug,验机时心里有数)

- 撤回**已消费**的条目拿不回来(steer 无"反向消费"语义),按 C2 静默留着等气泡——这是拍板的取舍。
- 排队条目在面板停留到引擎确认才消失,中间这段「可见可删窗口」长短取决于 AI 多久到下一个步边界;
  任务步骤密则窗口短,这是正常的。

## 验机出问题时的排查锚点

- core `packages/core/src/engine/steer-queue.ts`(纯队列逻辑,可加测复现)
- core `engine.ts` `enqueueSteer/unsteer/consumeSteer` + `turn-loop.ts` 步间消费点(发 `steer_injected` 带 id)
- renderer `App.tsx`:`steeredIdsRef`(每 id 只 steer 一次)/ auto-send `useEffect`(busy steer vs !busy relay|idle)/
  `onStreamEvent` 里 `steer_injected → removeQueuedInputById` / `removeActiveQueuedInputAt`(按 id 异步删 + 读 `.result.removed`)
- renderer `queuedInput.ts`:`QueuedItem{id,text}`
- ⚠️ 坑:preload `rpc()` resolve 的是整个 `{id,result}` 信封,unsteer 的 removed 在 **`.result.removed`** 不是 `.data`
