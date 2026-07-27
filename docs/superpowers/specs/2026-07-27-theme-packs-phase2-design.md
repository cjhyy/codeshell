# 主题包 Phase 2:pet 形象 + 背景图 + 可外部安装

日期:2026-07-27
状态:待评审
承接:`docs/superpowers/specs/2026-07-27-theme-packs-design.md`(Phase 1 已交付:内置配色包)

## 背景

Phase 1 已经把主题包框架用**内置配色包**立起来了:`ThemePack { id, name, swatch, colors:{light,dark} }`
存 localStorage,`applyThemePack` 通过受管 `<style id="cs-theme-pack">` 覆盖 `--cs-*` 变量,
跨窗口靠 `storage` 事件同步,UI 在 `AppearanceSection` 的配色网格。Phase 1 明确把
pet 形象、背景图、用户自定义包列为"后续叠加(预留)"。

用户现在要的正是这三块,并明确:**主题包要能像 codex 那样外部安装分发**,pet 要**多状态图**,
"能动很 work,但可以先做纯静态"。

## 决策(与用户确认)

1. **独立主题包类型,复用插件安装管道**:新建 `~/.code-shell/themes/<id>/`,复用本地插件的
   `preview → review-token → 原子落盘`流程和 `csplugin://` 资源协议;不混进插件列表,
   入口在 Appearance。
2. **三部分全上**:pet 多状态图 + 主题色 + 背景图,一个完整外部包。
3. **纯静态资源,但天然能动**:包内只允许 manifest(json)+ 图片,不允许 JS/HTML/CSS。
   "能动"通过**允许动图格式**(APNG / animated WebP / GIF)实现——图片自己会动,
   不需要执行代码,安全面维持最小。CSS/骨骼动画留作更后续,不在本期。
4. 内置包与外部包**统一数据模型**:内置包资源走 Vite `import.meta.glob`,外部包资源走
   `csplugin://`(实为新注册的 `cstheme://`),`ThemePack` 增加的字段两者都能填。

## 数据模型扩展

在 Phase 1 的 `ThemePack` 上填入预留槽位(`theme-packs.ts`):

```ts
/** pet 的三种视觉状态,对应现有 runningCount / 未读提醒信号。 */
type PetSpriteState = "idle" | "running" | "alert";

interface ThemePack {
  id: string;
  name: TranslationKey | string;   // 内置用 i18n key;外部包用其 manifest 里的纯文本名
  swatch: string;
  colors: { light: ThemeVars; dark: ThemeVars };

  /** 每状态一个图片 URL(内置:glob 出的静态 URL;外部:cstheme:// URL)。缺省沿用默认狗图。 */
  pet?: Partial<Record<PetSpriteState, string>>;

  /** 背景图 URL(亮暗可分),opacity 控制与底色叠加。缺省无背景图(纯色)。 */
  wallpaper?: { light?: string; dark?: string; opacity?: number };

  /** 外部包标记:决定资源 URL 用 cstheme:// 而非静态 import,以及能否卸载。 */
  source?: "builtin" | "installed";
}
```

- `name` 放宽到 `string`:外部包名来自 manifest,不是 i18n key。UI 渲染时内置包过 `t()`,
  外部包直接显示。
- pet/wallpaper 都是**可选**:外部包可以只换配色、或只换 pet,缺哪块就沿用基线。

## 主题包分发格式(外部包)

一个主题包目录 / .zip,根部一个 manifest:

```
mypack/
  .cs-theme.json            # manifest(唯一必需的 json)
  pet-idle.webp             # 作者可任意命名,manifest 里声明
  pet-running.webp
  pet-alert.webp
  wallpaper-light.jpg
  wallpaper-dark.jpg
```

`.cs-theme.json`(仿 `PluginInterfaceMetadata`,zod 校验):

```jsonc
{
  "schemaVersion": 1,
  "id": "acme-neon",          // ^[a-z0-9][a-z0-9-]{1,63}$,做目录名 → assertSafeThemeName
  "name": "Acme Neon",
  "version": "1.0.0",
  "colors": {                 // 可选;值为无单位 HSL,键必须在 THEME_VAR_NAMES 白名单
    "light": { "--cs-primary": "310 80% 50%", "--cs-ring": "310 80% 50%" },
    "dark":  { "--cs-primary": "310 85% 65%", "--cs-ring": "310 85% 65%" }
  },
  "pet": {                    // 可选;声明作者的相对路径,安装时收敛到规范命名
    "idle": "pet-idle.webp", "running": "pet-running.webp", "alert": "pet-alert.webp"
  },
  "wallpaper": {              // 可选
    "light": "wallpaper-light.jpg", "dark": "wallpaper-dark.jpg", "opacity": 0.15
  }
}
```

## 安装管道(复用插件基建,新建 theme 分支)

新增 `packages/core/src/themes/`(镜像 `plugins/installer/` 的最小子集),或在 plugins
installer 里加 theme 分支——**优先前者**,保持主题包与功能插件职责分离。

1. **preview**:`previewLocalTheme({kind:"dir"|"zip", path})` → 解压/投影到临时目录 →
   校验 manifest(zod)+ 每张声明图片(魔数/尺寸/字节上限,含 APNG/animated-WebP/GIF)→
   把图片收敛到规范目录 `.cs-theme-assets/{pet-idle,pet-running,pet-alert,wallpaper-light,
   wallpaper-dark}.<ext>`(仿 `normalizeInterfaceAssets`)→ 算 `reviewToken = digest(投影)`
   → 返回 `{id, name, version, hasColors, hasPet, hasWallpaper, swatch, reviewToken, warnings}`。
2. **用户确认**:UI 展示待安装主题概要 + 预览缩略图。
3. **install**:`installReviewedLocalTheme(token)` → 重新投影比对 token(防 TOCTOU,
   不符抛 `ThemeReviewChangedError`)→ 原子 `rename` 到 `~/.code-shell/themes/<id>/` →
   写 `.cs-theme-meta.json`(id/version/source/installedAt)。
4. **注册表**:`~/.code-shell/themes/installed.json`(版本化)记录已安装主题,供列举/卸载。
5. **卸载**:删目录 + 从注册表移除;若删的是当前 active,落回 `default`。

安全:纯静态,无 hooks/mcp/可执行内容,不需要 Phase-1 插件的 hook/mcp digest 批准层。
图片经魔数+尺寸校验;路径全程 `assertSafeThemeName` + `realpath` 包含检查防遍历(抄插件)。

## 资源加载

- **内置包**:`import.meta.glob("./assets/themes/**/*.{png,webp,gif}", { eager:true })`
  建立 `themeId/state → url` 映射,资源随 app 编译。第一版内置包仍可只有配色(pet/wallpaper 选填)。
- **外部包**:新注册 `cstheme://` 自定义协议(直接抄 `plugin-panel-protocol.ts`:
  `registerSchemesAsPrivileged` + 独立 session `protocol.handle` + 防遍历 + MIME 白名单 + CSP),
  root 指向 `~/.code-shell/themes/`。renderer 用 `cstheme://<id>/.cs-theme-assets/pet-idle.webp`
  直接 `<img src>`。**pet popout 窗口的 session 也要注册同一协议**(否则挂件里加载不到)。
- 主进程启动时把 `~/.code-shell/themes/` 下已安装包读成 `ThemePack[]`(colors 内联、
  pet/wallpaper 填 `cstheme://` URL、`source:"installed"`),通过一个 IPC(`themes:list`)
  提供给 renderer,与内置 `THEME_PACKS` 合并。

## Renderer 应用层

### pet 图集 provider(取代 7 处写死 import)

新建 `usePetSprite(state: PetSpriteState): string`(或纯函数 `petSpriteUrl(packId, state)`):
读当前 pack 的 `pet[state]`,缺省回落到内置默认狗图 `codeshell-dog-icon.png`。
把调研列出的 7 处 `import dogIcon` + `src={dogIcon}` 改成消费它。
- 状态来源:`PetWidget` 已有 `runningCount`(→`running`)、未读/提醒计数(→`alert`),
  其余为 `idle`。这套映射是**新增能力**,做一个 `petVisualState(activity)` 纯函数。
- 动图零特殊处理:APNG/WebP/GIF 作为 `<img>` 自动播放。

### 背景图(新渲染层)

- 在 `<body>`(或 `#root`)加一个可被主题包覆盖的 `--cs-wallpaper`(url 或 none)+
  `--cs-wallpaper-opacity`。`applyThemePack` 除了写颜色 `<style>`,再写背景变量。
- 背景绘制:body 的 `::before` 固定层 `background-image: var(--cs-wallpaper)`,
  `opacity: var(--cs-wallpaper-opacity)`,`z-index:-1`,`background-size:cover`。
  纯色底仍在,壁纸叠在其上,`default` 包 `--cs-wallpaper:none` = 现状不变。
- pet popout 窗口是透明挂件,**不铺背景图**(只主窗口/主页铺),避免破坏挂件透明形状。

### applyThemePack 扩展

现有只写颜色 `<style>`。扩展为同时:①颜色规则(不变)②`--cs-wallpaper*` 变量
③广播/触发 pet provider 重读(pet 图不是 CSS,靠一个轻量事件或 store 让 `usePetSprite` 重渲染)。
跨窗口仍复用 `storage` 事件(pack id 变化 → 各窗口 `applyThemePack` 重跑)。

## UI(AppearanceSection 再扩展)

现有配色网格下方增加:
- 主题包卡片改为展示**pack 预览**(swatch + 若有 pet 图显示缩略 + 若有壁纸显示角标),
  内置与已安装包同网格,已安装包带卸载入口。
- 「导入主题包…」按钮 → `dialog.showOpenDialog`(目录/zip)→ preview → 确认弹窗 → install →
  刷新列表。全程 shadcn 组件 + i18n(`settingsX.appearance.pack.*` / `.theme.*`)。

## 错误处理

- manifest 非法 / 图片校验失败 / 未知颜色变量名 → preview 阶段拒绝,warnings 回传 UI,不落盘。
- review-token 不符 → 安装中止(内容在确认后被改动)。
- active 包被卸载或资源缺失 → 落回 `default`;`getThemePack` 已有兜底。
- `cstheme://` 请求越界/文件缺失 → 404,pet 回落默认狗图,壁纸回落纯色。

## 测试策略

- core themes installer:manifest zod 校验(合法/缺字段/非法变量名/非法 id)、图片魔数校验
  (含动图格式接受、非图片拒绝)、`normalizeThemeAssets` 收敛路径、review-token 双阶段
  比对(改内容→抛错)、`assertSafeThemeName` 防遍历。纯函数/文件级,不起 Electron。
- `cstheme://` handler:防遍历(`..`/绝对路径/软链拒绝)、MIME 白名单、root 包含检查。
- renderer:`petSpriteUrl`/`petVisualState` 纯函数;`usePetSprite` 回落默认图;
  `applyThemePack` 写出 wallpaper 变量 + 幂等;AppearanceSection 渲染内置+已安装、导入按钮、
  卸载(mini-DOM)。
- 现有 Phase-1 的 theme-packs / theme 测试保持绿。

## 实施切分

1. **数据模型**:`ThemePack` 加 `pet/wallpaper/source`;`PetSpriteState`、`petVisualState` 纯函数。
2. **pet 图集 provider + 背景层**:`usePetSprite`、7 处改造、`--cs-wallpaper` 渲染层、
   `applyThemePack` 扩展(内置包即可验证,先给一套内置含 pet/壁纸的示例包)。
3. **core themes installer**:preview/install/uninstall + manifest/资源校验 + 注册表。
4. **cstheme:// 协议 + themes:list/import/uninstall IPC**(主窗口 + pet popout 两个 session 注册)。
5. **AppearanceSection**:已安装包展示 + 导入/卸载 UI。

## 非目标(本期)

- 主题包携带 CSS / 可执行动画 / 骨骼动画(只支持动图格式的"能动")。
- 字体 / 圆角 / 间距等非颜色 token。
- 主题包市场 / 远程下载(只本地导入;远程可后续复用插件 marketplace)。
- pet 挂件窗口铺背景图。
