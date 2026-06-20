# Browser Tool 体验优化 — 痛点清单与方案

**日期**: 2026-06-20
**状态**: 待拍板（清单 + 方向，尚未实现）
**关联**: `docs/superpowers/specs/2026-06-18-browser-module-redesign-design.md`（浏览器模块重设计，已合 main）
**证据来源**: 真机 session `s-mqjl1uap-db34630c`（任务「中间收藏2个文章」，小红书 cwd `~/codeshell/rednote`）的 transcript：`~/.code-shell/sessions/s-mqjl1uap-db34630c/transcript.jsonl`

---

## 0. 背景

浏览器模块重设计合 main 后做真机冒烟，小红书任务暴露体验问题：AI 反复截图、最后**放弃浏览器改用 Bash + python 逆向小红书前端接口**完成任务。逐层查 transcript 后，**推翻了几个基于日志 chars 数的早期误判**，得到下列实据驱动的结论。

### 关键纠正（避免重蹈覆辙）

| 早期推断（错） | transcript 实据（对） |
|---|---|
| a11y snapshot 太薄，看不到页面 | snapshot 很丰富：个人页列出 e1~e16+ 笔记 link。只有"收藏/笔记/赞过"这几个 **tab** 没进列表 |
| vision 截图失败/卡死返回错误 | 截图**成功**（结果 `[screenshot loaded]` + image 块进了上下文）；是模型没从图里点对 tab |
| 日志没存工具结果 | 存了，在 `~/.code-shell/sessions/<sid>/transcript.jsonl`（早期只查了 logs.sh 的 chars 摘要，没查 transcript 全文） |

**教训**：查浏览器行为问题，先读 `transcript.jsonl` 的真实 tool_result，别只看 logs.sh 的 chars 摘要下结论。

---

## 1. 痛点清单（带证据 / 根因 / 修法 / 优先级）

### 🔴 P1-① 截图不回显到 UI 流 ★用户点名要修

- **证据**：transcript 里 `browser_observe(vision)` 结果只有一行 `"[screenshot loaded]"`；renderer `chat/` 下**没有渲染 tool-result image 块的代码**（现有 `<img>`/Lightbox 只服务用户上传的附件）。
- **根因**：vision/image 截图作为 image ContentBlock 进了**模型上下文**（模型看得到），但 renderer 没把它画进工具卡片 → 用户看不到 AI 截了什么，无法判断"截对没"，调试盲区。
- **修法**：renderer 工具卡片渲染 tool-result 的 image 块为**缩略图**，点击走已有 `Lightbox.tsx` 放大。
- **前置依据（已查实）**：通道现成——`view_image` 工具早已用 tool_result 带 image ContentBlock 回传（`types.ts:57` 注释 + `ContentBlock.type` 含 `"image"`）。**待最后确认**：vision 的 image 块是否随 `tool_result` **流事件**（StreamEvent）送达 renderer，还是只在 transcript 持久化里。若流事件没带 → 需补 core 一处回传；若带了 → 纯 renderer 渲染。
- **配套**：把 `[screenshot loaded]` 文字升级为带尺寸/URL/截了哪块区域的描述（见 P3-⑥）。

### 🔴 P1-② 个人页 tab（笔记/收藏/赞过）不进 snapshot

- **证据**：个人页 snapshot 列了 e1~e16 **全是笔记 link**，无"收藏/笔记/赞过" tab 的 ref；AI 自述：「页面里"收藏"不是链接而是前端 tab，所以提取不到独立 URL」。
- **根因（未完全实证）**：这几个 tab 是前端 JS 渲染的 `<div>`。`tab` **在** `INTERACTIVE_ROLES` 里，所以最可能是：tab 节点**无 accessible name**，被 `flattenAxTree` 的 `if (!name && !isValueRole) continue;` 筛掉；或它根本无 `role`（裸 `<div onclick>`）。**需真机 dump 原始 `Accessibility.getFullAXTree`** 看那三个 tab 节点的 role/name/properties 才能定准。
- **修法（两条路，先轻后重）**：
  - (a) **skill 知识层**：教 AI「找不到目标 tab 时 → 截图看坐标点击 / scroll / 或直接 extract 后逆向接口」。不动核心感知。
  - (b) **底层补**：放宽 flatten 过滤（无 name 的交互角色也保留，用 role 兜底显示），或补 DOM 启发式遍历（收 onclick/cursor:pointer/role=tab，照 browser-use）。**碰感知主干，重，先不做**。
- **优先级**：先验证(dump AX 树) → 先走 (a) skill → 兜不住再考虑 (b)。

### 🔴 P1-③ 导航撞 404 才绕路

- **证据**：AI 先导 `https://www.xiaohongshu.com/user/profile`（不带 userId）→ snapshot 返回 `Title: 你访问的页面不见了`（404）→ 之后才找 userId 重导到 `/user/profile/5fc05bdd...`。
- **根因**：AI 不知道小红书个人页必须带 userId。
- **修法**：纯 skill（站点知识）。skill 的典型用武之地。

### 🟡 P2-④ 反复截图（根在 ②，prompt 已缓解）

- **证据**：vision 在多轮被调（snapshot→vision→extract→vision…）。
- **根因**：snapshot 看不到目标 tab（②）→ AI 升级到 vision → 看不清 → 再试。是 ② 的**派生症状**。
- **已做**：commit `ea016759` 在 `browser.md` 加了「别在同一页重复 vision，一张就够；看不清就 scroll/extract，别循环截图」。
- **根治**：靠 ②。

### 🟡 P2-⑤ vision 截图曾卡 27 秒（已修，待验证）

- **证据**：`turn 9 observe mode:vision duration_ms: 27347`。
- **根因**：`screenshot` 先 `captureScreenshot` 拿大图，再把整张 base64 塞回页面用 `Runtime.evaluate`+canvas 二次缩放——重页面上注入多 MB 字符串+解码巨慢。
- **已修**：commit `ea016759` 改用 CDP 原生 `clip.scale` 服务端缩放，零页面往返，删 `DOWNSCALE_FN` 死代码。
- **待办**：真机验证现在是否秒回。

### 🟢 P3-⑥ 工具结果文字信息量低

- **证据**：`[screenshot loaded]` / `Page ready` 这类回显太薄。
- **修法**：加尺寸 / URL / 截了哪块区域 / 元素数量等。与 P1-① 一起做。

---

## 2. 两个用户明确的方向

### 方向 A：专门写 skill 解决"真正的问题"

不靠改底层工具硬扛 SPA，而用 **skill（知识层）** 教 AI 套路。覆盖 ②③ 这类站点特定/SPA 通用知识。

**待拍板：skill 范围**（用户暂未定，本轮先列体验问题）：
- **选项 1：通用「浏览器操作」skill** —— 对付重 SPA 的通用套路：先 wait 再 observe / 找不到 tab 就截图点坐标或 scroll / 带 userId 导航别裸 `/user/profile` / 实在不行才抓接口。跨站点通用。
- **选项 2：小红书专用 skill** —— 内置个人页 URL 格式（带 userId）、收藏/笔记/赞过 tab 怎么切、推荐走哪个接口。精准但只管一个站。

> 倾向：先通用 skill（②③④ 大多是 SPA 通病），小红书专用留作后续 example。

### 方向 B：截图回显到工具结果（= P1-①）

用户已定：**UI 流里显缩略图**（点击放大）。详见 P1-①。

---

## 3. 建议推进顺序

1. **P1-① 截图回显** —— 用户明确要、价值立竿见影、通道现成。先查实 image 块是否随流事件到 renderer（决定"纯渲染" vs "渲染+补 core 一处接线"），再做。
2. **验证 P2-⑤** —— 真机确认 vision 不再卡 27 秒。
3. **②③ 写 skill**（方向 A）—— 站点/SPA 知识，不动核心感知。先 dump 一次小红书个人页原始 AX 树，确认 ② 卡哪一关，写进 skill 的"找不到 tab"兜底。
4. **②的底层补法**（flatten 放宽 / DOM 启发式）—— **暂不做**，等 skill 兜不住再评估，避免动感知主干（呼应重设计稿"主干别动，只补动作"）。

---

## 4. 未决 / 待实证

- [ ] vision image 块是否随 `tool_result` 流事件到 renderer（决定 P1-① 改动范围）。
- [ ] 真机 dump 小红书个人页 `Accessibility.getFullAXTree`，确认"收藏 tab"节点的 role/name/properties（决定 ② 卡哪关、skill 怎么写兜底）。
- [ ] skill 范围拍板：通用 vs 小红书专用。
- [ ] P2-⑤（27s→秒回）真机复验。
