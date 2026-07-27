# 主题包(Theme Packs)设计

日期:2026-07-27
状态:待评审

## 背景与目标

用户想要"换皮肤/换 pet 样式",进一步明确为一个可整包替换的**主题包**:一个包能同时
改 app 主题色、pet 形象(多状态图)、背景图,像 codex 那样整包切换。

现状(调研结论):

- **主题色**:骨架现成。约 22 个 `--cs-*` 语义变量集中在
  `packages/desktop/src/renderer/styles/tailwind.css` 的 `:root`(亮)/`.dark`(暗)两块,
  `@theme inline` 把它们映射成 Tailwind token。运行时覆盖这批变量即可换色,无需重编译。
- **pet 形象**:一张写死的 `codeshell-dog-icon.png`,在 ~7 处静态 import,状态不换图。
- **背景图**:全 app 无任何图片背景,纯色 + CSS 渐变。
- **主题切换**:`theme.ts` 只切 `.dark` class,存 localStorage(`codeshell.theme`)。
  pet 挂件是独立 popout 窗口,与主窗口同源、共享 localStorage。
- **跨窗口**:换明暗现在靠各窗口各自 `initTheme` + system 监听,无主动同步。

## 决策

- **分层递进**,先把"主题包"框架用**主题色包**立起来(骨架现成、风险最低),
  pet 形象、背景图作为后续叠加层(本 spec 预留数据模型槽位但第一版不实现)。
- 第一版内置几套预装配色包(基于现有品牌橙),不做用户自定义上传。
- 主题包 id **存 localStorage**(不走 settings.json):`applyThemePack` 必须在渲染前同步执行
  以避免闪色,而 settings.json 读取是异步的;且 pet popout 同源共享 localStorage,
  跨窗口实时切换用浏览器原生 `storage` 事件即可,无需新增 IPC。

## 数据模型

```ts
// theme-packs.ts
type ThemeVars = Partial<Record<CssVarName, string>>; // 值为无单位 HSL,如 "19 63% 45%"

interface ThemePack {
  id: string; // 稳定 id,存 localStorage
  name: string; // i18n key
  swatch: string; // UI 缩略图用的代表色(hsl 无单位),取自 primary
  colors: {
    light: ThemeVars; // 覆盖 :root 的 --cs-* 子集(未覆盖的沿用基线)
    dark: ThemeVars; // 覆盖 .dark 的 --cs-* 子集
  };
  // 预留槽位,第一版不填:
  // pet?: { idle: string; running: string; alert: string };
  // wallpaper?: { light?: string; dark?: string; opacity?: number };
}
```

- `CssVarName` 是白名单联合类型(`--cs-primary` / `--cs-ring` / `--cs-background` / …),
  与 tailwind.css 现有变量一一对应,防止拼错变量名静默失效。
- 内置包放在 `theme-packs.ts` 里的 `THEME_PACKS: ThemePack[]`。第一版:
  - `default`(现有品牌橙,`colors` 全空 = 不覆盖,等于当前外观)
  - `ocean`(蓝)、`forest`(绿)、`grape`(紫)——各覆盖 primary/ring(以及必要的
    primary-foreground / status 协调),亮暗各一套。
- `DEFAULT_PACK_ID = "default"`。

## theme.ts 扩展

保留现有 `Theme`(light/dark/system)不变——**明暗与主题包是正交的两个维度**。
新增:

```ts
loadThemePackId(): string           // localStorage "codeshell.theme-pack",未知/缺失 → default
saveThemePackId(id): void
applyThemePack(id): void            // 把该包 light+dark 覆盖变量写进两个 <style> 规则(见下)
initTheme(): void                   // 现有:apply 明暗 + 监听 system;新增:applyThemePack(loadThemePackId())
```

**变量注入方式**:不能只 set `documentElement.style`,因为亮暗要各一套,而 `.dark`
是 class 切换。做法:维护一个受管的 `<style id="cs-theme-pack">`,内容为

```
:root { --cs-primary: <light>; ... }
.dark { --cs-primary: <dark>; ... }
```

`applyThemePack` 重写这段 style 的 textContent。因为特异性等同基线的 `:root`/`.dark`
且在其后插入,故覆盖生效;`default` 包写空规则 = 回到基线。这样明暗切换仍只靠 `.dark`
class,主题包只负责"提供哪套值",两个机制解耦。

**跨窗口同步**:`saveThemePackId` 写 localStorage 后,其他同源窗口(pet popout)收到
`window`的 `storage` 事件 → 调 `applyThemePack(newId)`。`initTheme` 注册这个监听(明暗的
`codeshell.theme` key 也顺带在此监听,实现换明暗跨窗口同步——现有缺陷的附带修复)。

## UI(AppearanceSection 扩展)

在现有"外观"(明暗三选)下方加一个"主题包"选择网格:

- 每个包一张卡片:代表色圆点(swatch)+ 名称,选中态复用现有 `border-primary ...` 高亮。
- 点击 → `saveThemePackId(id)` + `applyThemePack(id)` + 本地 state 更新。
- 全部走 shadcn `Button` + `cn()` + i18n(`settingsX.appearance.pack.*`),不写裸元素。

## 错误处理

- 未知/损坏的 pack id → 落回 `default`(`loadThemePackId` 内兜底)。
- `applyThemePack` 幂等:重复调用只重写同一个 `<style>`,无副作用。
- `<style>` 节点若不存在则惰性创建并 append 到 `<head>`。

## 测试策略

- `theme-packs.ts` 纯数据:每个包的 `colors` 变量名都在白名单内(类型层面保证 + 一个
  运行时测试遍历断言 key 合法、值是合法 HSL 三元组)。
- `theme.ts`:`loadThemePackId` 兜底未知值 → default;`applyThemePack` 写出正确的
  `:root`/`.dark` 规则文本、幂等、default 写空。用 jsdom/mini-dom 断言
  `<style id="cs-theme-pack">` 的 textContent。
- `AppearanceSection`:渲染出所有包卡片、点击触发 save+apply、选中态高亮(mini-DOM 组件测试)。

## 非目标(第一版)

- pet 多状态图集、背景图(预留数据槽位,不实现)。
- 用户自定义上传主题包。
- 主题包携带字体/圆角/间距等非颜色 token。

## 后续叠加(预留)

1. pet 形象:抽 `usePetSprite(state)` provider,7 处写死 import 改成消费它;
   `ThemePack.pet` 注入图集;状态用现有 `runningCount` 驱动。
2. 背景图:`body`/`#root` 加 `--cs-wallpaper` 槽位;`ThemePack.wallpaper` 注入。
3. 用户自定义包:文件导入 + 校验 + 存储(需 IPC/自定义协议)。
