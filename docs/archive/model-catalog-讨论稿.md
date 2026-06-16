# 模型接入 Catalog（provider 目录）— 讨论稿 v0.1

> 状态：**讨论中**,未实现。设计锚点,不是实现承诺。
> 日期：2026-06-10 ｜ 范围:把"文本/图像/视频/语音"模型接入统一成一份声明式 catalog,自动渲染进设置连接页,用户挑一条→填 key→用。
> **本版明确不做远程更新**(git 拉取 catalog)——只做内置 catalog + 用户自定义。远程仅在 §7 留一句方向,不展开。

---

## 0. 一句话

**模型接入 = 填配置,不是写代码。** 维护一份 provider 目录(catalog),每条声明它属于哪类(text/image/video/audio)、怎么配、传什么参数;这些条目按 tag 自动出现在设置的「连接」页,用户从列表挑一个 → 填 key → 配置 → 就能用。新增同形状的模型服务 = 加一条 catalog 声明,不改 UI、不写 provider 类。

代号取自用户原话:「图片生成视频生成其实都是模型接入,完全可以手动配置」「我维护一个支持的 provider 列表,用户在连接页添加、填 key、配置」「自动给一个分类 tag,就自动到了设置的连接页面」。

---

## 1. 背景:模型接入"半配置化"的现状

codeshell 里"模型接入"目前三种待遇不一致:

| 能力类 | 接入方式 | 加一家要做什么 | tag/连接页 |
|---|---|---|---|
| **文本(LLM)** | ✅ 纯配置 `providers[]` | 填一条配置 | 有(模型设置) |
| **图像** | ❌ 写 `OpenAIImageProvider`/`GeminiImageProvider` 类 + `getImageProvider` switch + renderer 里手写 `ProviderMeta` | 改 core + 改 UI | 手写面板 |
| **视频** | ❌ 写 `FalVideoProvider` 类 + switch + 手写 `ProviderMeta` | 改 core + 改 UI | 手写面板 |
| **语音** | ❌ 不存在 | — | 无 |

痛点(用户原话):「又装 skill 又改 tool 又改 UI,太重了」。本质:**图像/视频本该像 LLM 那样配置化,却还在每家手写 provider 类 + 手写连接页卡片。**

**好消息:已经走了一半。** renderer 里手写的 `ProviderMeta[]`(openai/google/fal,见 `ImageGenConnectionsPanel.tsx`/`VideoGenConnectionsPanel.tsx`)就是内置 catalog 的雏形,`GenConnectionsPanel` 已经是声明式渲染。本设计 = 把这些散落、写死在前端的 `ProviderMeta`,收敛成**一份集中的、带 tag 的 catalog**,并补上"用户自定义"和"语音类"。

---

## 2. 目标

1. **统一四类模型接入**(text / image / video / audio)成同一种 catalog 声明范式。
2. **tag 驱动自动归类**:catalog 条目带 `tag`,连接页按 tag 自动分组渲染,加一类(如语音)= 加 tag,不写新面板。
3. **内置 catalog(A)**:随 app 发布、维护者维护的官方 provider 列表。用户从中挑。
4. **用户自定义(B)**:用户也能往 catalog 加自己的条目(本地)。
5. **连接页体验**:挑一条 → 填 key → 配置(baseUrl/model 有默认)→ 用。用户不必懂端点/参数。

### 非目标(本版不做)
- ❌ **远程更新 catalog**(从 git 拉)——本版完全不做。§7 仅留方向。
- ❌ catalog 安全/签名(因不做远程,本版无此问题)。
- ❌ 怪鉴权的纯声明化(AK/SK 签名、OAuth)——这些仍需适配器,见 §4 边界。
- ❌ 把 LLM(文本)迁进这套——文本已配置化,本版聚焦补齐 image/video/audio 的配置化 + tag 化;是否统一文本留后议。

---

## 3. 效果(用户视角)

设置 →「连接」页:

```
[文本模型]   (已有,本版可不动)
[图像生成]   ▸ OpenAI Images   ▸ Gemini Images   ▸ [+ 添加]
[视频生成]   ▸ fal.ai(Kling/Seedance)            ▸ [+ 添加]
[语音]       ▸ (catalog 里 tag=audio 的条目)       ▸ [+ 添加]
```

- 每个分组的卡片**不是手写的**,是 catalog 里 tag 匹配的条目自动渲染。
- 点 [+ 添加] → 从 catalog 列表挑一个(或填自定义)→ 出现一张配置卡 → 填 key/baseUrl/model → 保存即用。
- 加一个新 tag=audio 的条目到 catalog → 「语音」分组自动出现该卡片,无需改 UI 代码。

---

## 4. 设计草案

### 4.1 catalog 条目结构(草案)

```ts
interface CatalogEntry {
  id: string;                 // "openai-images" / "fal-video" / "minimax-tts"
  tag: "text" | "image" | "video" | "audio";   // 决定进哪个连接页分组
  displayName: string;        // "OpenAI Images (gpt-image)"
  description: string;
  // —— 连接配置(渲染成卡片字段)——
  defaultBaseUrl: string;
  fields: Array<"apiKey" | "baseUrl" | "model">;   // 这条要填哪些(默认 apiKey+baseUrl+model)
  defaultModel?: string;
  modelPresets?: Array<{ value: string; label?: string }>;  // 模型下拉(已有机制)
  signupUrl?: string;         // "获取 key" 链接
  // —— 怎么用 / 传什么参数(给 Agent / 文档)——
  paramsDoc?: string;         // 这家调用时支持/需要的参数说明
  // —— 运行时怎么接 ——
  adapterKind: string;        // 运行时用哪个 provider 适配器(见 §4.3)
  // —— 可选测试 ——
  test?: boolean;             // 连接页是否给"测试"按钮(image 有 probe;video 无)
}
```

### 4.2 三源合并(本版只有两源:内置 A + 用户 B)

```
内置 catalog (A)  —— 随 app,维护者维护,离线兜底
用户自定义 (B)    —— 用户在连接页 [+ 添加] 自定义条目,存本地
合并:同 id 时 用户 B > 内置 A(用户的覆盖/扩展不被升级冲掉)
（远程源本版不做）
```

存放(草案):
- 内置 A:代码里一份集中的 `CATALOG: CatalogEntry[]`(替代现在散在各 panel 的 ProviderMeta)。
- 用户 B:`~/.code-shell/` 下一份 `model-catalog.user.json`(或并入 settings)。

### 4.3 关键边界:纯声明 vs 需适配器

**不是所有条目"填 key 就能用"——取决于它的 HTTP 形状能否被声明描述。**

| 形状 | 能否纯声明 | 处理 |
|---|---|---|
| 同步一发一收(OpenAI 图片) | ✅ | 复用通用同步适配器 |
| 异步 submit→poll→download(fal 视频) | ✅(声明三段 URL 模式) | 复用通用 queue 适配器 |
| 怪鉴权(AK/SK 签名 / OAuth) | ❌ | catalog 条目 `adapterKind` 指向一个**专门写的适配器类** |
| 多步(本地图先上传) | ⚠️ 半 | 适配器内处理 |

所以 `adapterKind` 字段是关键:
- 大多数条目指向**通用适配器**(`generic-sync` / `fal-queue` 这类),纯声明即可。
- 少数怪的指向**专用适配器**(维护者预先写好,如 `volcengine-aksk`)。
- **用户侧体验一致**:无论哪种,都是"挑 + 填 key";区别只在维护者那边某些条目需要先写适配器。

**现状映射**:现在的 `getImageProvider`/`getVideoProvider` switch 就是 adapterKind → 适配器的雏形;`FalVideoProvider`=`fal-queue` 适配器,`OpenAIImageProvider`=`openai-sync` 适配器。

### 4.4 连接页渲染(tag 驱动)

- 现有 `GenConnectionsPanel`(声明式,吃 `ProviderMeta[]` 渲染卡片)是现成地基。
- 改造:连接页**按 tag 分组**,每组喂 `catalog.filter(e => e.tag === 组)`。
- 新增 tag(audio)= 连接页加一个分组容器 + catalog 加条目;**卡片渲染零新代码**(复用 GenConnectionsPanel)。

---

## 5. 现状盘点:零件已经在了

| 设计要素 | 现状 | 缺口 |
|---|---|---|
| 声明式卡片渲染 | ✅ `GenConnectionsPanel` 吃 ProviderMeta | tag 分组、吃 catalog 而非手写数组 |
| provider 配置存储 | ✅ `imageGen/videoGen.providers[]` schema | 加 audio;catalog 与 providers[] 的关系(catalog=可选清单,providers[]=已配实例) |
| 适配器注册 | ✅ getImageProvider/getVideoProvider switch | 抽象成 adapterKind;加通用适配器(generic-sync / fal-queue) |
| 模型下拉 | ✅ modelPresets(datalist→SimpleSelect) | — |
| 测试按钮 | ✅ image 有 probe | 通用化(catalog.test 控制) |
| 用户自定义条目(B) | ❌ | 新增:用户 catalog 文件 + 合并 |
| 语音类(audio) | ❌ | 新增 tag + audio 适配器抽象(像当初加 videoGen) |
| 集中 catalog(A) | ⚠️ 散在前端 ProviderMeta | 收敛成一份 |

**结论:装配 + 收敛,不是从零造。**

---

## 6. 与"数字人 / WorkspaceProfile"的关系

两份讨论稿是配合的,分层清楚:

```
Catalog(本稿)      = 能力怎么"接进来"(填 key 即用的模型服务目录)
WorkspaceProfile    = 把接进来的能力"组装成一个角色"(数字人:能力精选集 + 工作流 + 经验)
```

- Catalog 是**更底层的地基**:能力好接了,数字人才好组装。
- 数字人激活时,它声明"我这个角色要用 catalog 里的哪些 provider"(精选集),天然解决前面聊的"MCP/工具全摊给 LLM 干扰"问题。
- 建议顺序:catalog 让 image/video/audio 配置化 → 再由 profile 组装。但两者可独立推进。

详见 `docs/workspace-profile-讨论稿.md`。

---

## 7. Future(本版明确不做)

- **远程 catalog 更新**:维护者更新一个固定地址的 catalog 文件,客户端拉取,用户免升级即见新 provider。**本版不做**。要做时需解决:三源合并(远程>内置,用户最高)、拉取失败回退内置、本地缓存、**安全/信任边界**(远程内容决定往哪发带 key 的请求 → 需锁定可信 repo 或签名校验)、schema 版本。
- **统一文本(LLM)进同一套 catalog**:文本已配置化,是否归并留后议。
- **用户自定义条目支持怪鉴权**:本版用户自定义仅限通用适配器能描述的;怪鉴权仍由维护者写适配器。

---

## 8. 决策记录 & 待拍板

**已定(v0.1):**
- ✅ 主体:内置 catalog(A) + 用户自定义(B),tag 驱动连接页,挑+填key+用。
- ✅ **本版不做远程更新**(§7 future)。
- ✅ 原型优先,安全因不做远程暂无问题。
- ✅ 边界:纯声明(通用适配器)覆盖大多数;怪鉴权由维护者写专用适配器,用户侧体验一致。
- ✅ 与数字人关系:catalog 是地基,profile 组装,可独立推进。

**待拍板:**
1. catalog 与现有 `imageGen/videoGen.providers[]` 的关系:catalog=可选清单(能配哪些),providers[]=已配实例(配了哪些)——是否就这么分?
2. 用户自定义条目(B)存哪:独立 `model-catalog.user.json` 还是并进 settings?
3. 语音(audio)第一个接谁验证?(MiniMax TTS / 火山 / fal 上的 TTS?)
4. 通用适配器粒度:`generic-sync` + `fal-queue` 两个够不够起步?
5. 是否本版就把文本也纳入 tag 体系(统一连接页),还是只动 image/video/audio?
