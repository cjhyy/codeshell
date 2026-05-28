# CC vs Codex 图片处理对比 + "上下文不会爆吗"分析

> 研究产物,2026-05-28 整理。从 TODO-week.md 草稿区归档到这里,避免再丢。
> 可执行的待办已经拆到 `TODO-week.md` 的 To Do #9(9a–9e)。

---

## 一、CC vs Codex 图片处理对照(基于源码)

### 1. 输入 & 传输格式

|            | Claude Code                                                                  | Codex CLI                                          |
| ---------- | ---------------------------------------------------------------------------- | -------------------------------------------------- |
| 输入方式   | 剪贴板图(macOS NSPasteboard / Linux xclip / Win PowerShell)+ 拖拽路径 + VSCode 文件名兜底 + Web composer | 剪贴板(arboard,统一编 PNG)+ 粘贴路径 + view_image 工具 |
| 传输格式   | base64 only,`{source: {type: "base64", media_type, data}}`                  | base64 data URL,`{image_url: "data:image/...;base64,..."}` |
| Detail 字段 | 不支持(Anthropic 没这个参数)                                                  | high / original,默认 high,**没 low**              |

### 2. 客户端预处理(差异最大的点)

**CC** —— 5 层激进压缩流水线(`imageResizer.ts:169`):
1. raw ≤ 3.75 MB 且 dims ≤ 2000×2000 → 直放
2. 仅 size 超 → PNG palette / JPEG quality 阶梯 `[80, 60, 40, 20]`
3. dims 超 → resize 到 2000×2000
4. resize 后还超 → 再走 quality 阶梯
5. 兜底:缩到 1000px + JPEG q=20
6. 仍不行就抛 `ImageResizeError`

**Codex** —— 单层 resize,没 byte cap(`utils/image/src/lib.rs`):
- `MAX_DIMENSION = 2048`,resize 走 Triangle 滤镜,JPEG q=85
- 没有 quality 阶梯,没有 byte size 检查
- 失败直接返回文本占位符 `unable to process image at...`

**为什么差这么大?** 因为 Anthropic API 有 5MB base64 硬限,OpenAI 没有(payload 上限 512MB,靠服务端 patch budget cap)。所以 CC 必须激进压,Codex 可以装傻直接传 2048px。

### 3. 硬限制速查

|                 | CC / Anthropic                                            | Codex / OpenAI                                |
| --------------- | --------------------------------------------------------- | --------------------------------------------- |
| 单图字节        | **5 MB base64 硬限**                                      | 无(payload 512 MB)                          |
| 单图尺寸        | 客户端 cap 2000×2000;服务端 ≤ 20 张时 8000×8000,> 20 张时 2000×2000 | 客户端 cap 2048×2048                         |
| 多图/请求       | 100 张(**超量静默丢最旧**:`stripExcessMediaItems`)       | 1500 张                                       |
| 官方 token 公式 | `tokens ≈ width × height / 750`                           | GPT-5: 32×32 patch × multiplier;GPT-4o: 512×512 tile |

### 4. MCP 工具返回图片(两边策略完全不同)

- **CC**:`truncateContentBlocks()` 主动重压缩,按 `IMAGE_TOKEN_ESTIMATE * 4 = 6400` 字符估算,超 `MAX_MCP_OUTPUT_TOKENS = 25000` 预算就压缩、压不动就丢。
- **Codex**:不重压缩,原图直接发给 OpenAI。早期还有个 bug —— 把整段 base64 当文本计 token,导致 % remaining 暴跌触发 false compaction(issue #11845)。PR #12419 修复:base64 payload 不再算进估算,固定 1844 tokens(resized) / patch 估算(original)。

### 5. 已知坏 case(都是真实 issue)

**CC 侧** —— "5MB brick session" 是反复出现的痛点:
- #2104 / #5419 / #8202 / #12167 / #14107 / #23951 / #30478 / #33152
- 模式:压缩流水线在某些图上压不到 5MB → 进了 history → 每次请求都重发 → 同一错误反复 → `/clear` 是唯一退路
- #14107:实测 2025-12-14 起阈值实际降到 ~3.2 MB(server 改了,客户端常量没跟上)
- #31444:VSCode 扩展把 92 KB JPEG 转 PNG 变成 5.2 MB,56× 膨胀 —— 蠢 bug

**Codex 侧** —— 主要是估算虚高:
- #11845(已修)、#10334(MCP 多模态被丢)、#11072(过早 compaction)

### 6. 粗糙之处

- CC `IMAGE_TOKEN_ESTIMATE = 1600` 是 hardcode,跟官方公式脱节
- CC `apiLimits.ts:10` 注释自己承认 "Last verified: 2025-12-22",server 改了不知道
- CC `stripExcessMediaItems` 静默丢图,用户无感知
- Codex PR #12419 只改估算,实际请求体没变小
- 两边都没有"按目标 token 预算自动缩放" —— 这是行业空白

---

## 二、"上下文不会爆掉吗"

会爆,而且这是两家真实的失败模式。分开看:

### A. CC 这边 —— 爆在"5MB 硬限"前面

CC 的关键约束是 Anthropic 的单图 5MB base64 硬限,所以它先压再说:
- 一张图无论 token 多少,只要 ≤ 5MB 就发
- 上下文整体由 Anthropic 200k 窗口管,单图最多吃 ~4784 tokens(Opus 4.7) ≈ 2.4% 上下文
- 100 张图上限,所以单请求图片最多吃 ~478k tokens —— 这已经超过 200k 上下文,所以实际是 byte 限先触发

**爆的场景**:
1. 单图压不到 5MB(#14107、#30478) —— 请求层直接 reject,不是"上下文爆",是"请求爆"
2. **坏图进 history → 每次重发** —— 这才是真正的"会爆":session 卡死,直到 `/clear`
3. 多图 + 长对话:100 张图配上 200k 上下文窗口,文本部分被挤压,但 CC 不会主动让步

**CC 的兜底**:
- `stripExcessMediaItems` 超 100 张静默丢最旧
- `validateImagesForAPI` 5MB 闸是最后一道
- MCP 图走 `truncateContentBlocks` 25k token 预算,超了主动压/丢
- 但没有"图整体占上下文 X% 就降级"的逻辑

### B. Codex 这边 —— 爆在"估算虚高"

Codex 没 5MB 硬限,但有另外两个坑:

**坑 1:base64 被当文本算 token**(issue #11845,已修)

PR #12419 之前,MCP 返回的图整段 base64(5MB ≈ 6.7M chars ≈ 1.7M tokens 误估)被算进 context,% remaining 暴跌到 0,立刻触发 auto-compaction。明明 OpenAI 实际只吃 1844 tokens,客户端误以为爆了。

**坑 2:Original detail 一张图可以吃 10,000 patches**

- `ORIGINAL_IMAGE_MAX_PATCHES = 10_000` ≈ 40k tokens(按 4 bytes/token)
- 一张 6000×6000 original 图 = 35,156 patches → cap 到 10k
- 多张 original 大图能很快吃掉上下文

**坑 3:Codex 默认 detail=high,没 low**

- OpenAI 的 low detail 是 85 tokens/图固定,Codex 客户端没暴露这个选项
- 用户没法说"这张图我只要粗看,省 token"

**Codex 的兜底**:
- patch budget(10k cap)
- token 估算修复后不再 false compaction
- `view_image` 工具可以选 `detail: "original"` 表示要高保真,反过来意味着没选时就是 high(默认偏贵)

### C. 两边共同的"会爆"场景

| 场景                       | CC 表现                                       | Codex 表现                                       |
| -------------------------- | --------------------------------------------- | ------------------------------------------------ |
| 单张超大图                 | 5MB 闸 reject / brick session                | 服务端 resize,客户端 1844 tokens                |
| 多张大图轮流贴             | 100 张上限 + 文本被挤,逼近 200k 触发 auto-compact | 1500 张上限,patch 累加,逼近模型 ctx 触发 compact |
| MCP 长循环返图(截屏 agent) | 25k MCP 预算压制,超了压/丢图                  | 无主动压缩,靠 OpenAI patch budget,客户端原图全发 |
| 截图 + 长对话              | 图占比逐渐挤压文本,Compact 触发后会保留摘要   | 同上,但 Codex 早期还有 false compaction bug     |

### D. 真实结论

会爆,但形态不一样:

- **CC 的"爆"是请求层硬拒**(5MB / 100 张),客户端激进压缩抵御;**失败后会污染 history**
- **Codex 的"爆"是上下文估算虚高**(已修)+ 多张 original 图累加快;不污染 history 但单 session 内堆图快
- **MCP 截屏循环这种场景两家都顶不住**:CC 会压到糊掉,Codex 会原图全发吃 patch budget。这是为什么浏览器 / Playwright 类 MCP 工具实际上应该自己控制返图频率和分辨率,而不是依赖客户端
- **行业现状**:没有"按 token 预算自动缩放图"的成熟方案。CC 的 `compressImageBufferWithTokenLimit` 只在 MCP 路径用,用户输入路径只看 byte。Codex 完全没有

### E. 给 codeshell 的启示(已拆进 TODO-week.md #9)

如果要做对(超过 CC/Codex 当前水平):

1. **客户端 token-budget-aware 压缩**:不是只看 byte,要按"这张图允许吃多少 token"反推目标尺寸 → **TODO #9a**
2. **图片在 history 里的衰减**:第 N 轮之后的旧图自动降级到 low detail 或缩略图(类似 ACON 论文方向) → **TODO #9b**
3. **MCP 图返回的严格预算**:CC 做了(25k MCP token cap),Codex 没做,我们应该做 → **TODO #9c**
4. **暴露 detail 选项给用户**:Codex 漏掉了 low → **TODO #9d**
5. **session 污染保护**:CC 现在没有,坏图进 history 就完蛋 —— 应该让超限图变成可删的占位符,不要塞进历史 → **TODO #9e**
