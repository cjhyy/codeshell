# 桌面端主题包

主题包是一个包含 `.cs-theme.json` 和本地图片的目录。进入设置的外观页，点击「导入主题包」并选择目录，确认后安装并立即启用。压缩包先解压。已安装包的资源会复制到应用主题存储中，之后不依赖原目录。

主题和明暗模式独立：同一个主题可以提供浅色和深色素材，外观的「浅色 / 深色 / 跟随系统」决定实际使用哪套。切回默认主题时，所有背景和外框配置都会清除。

## 可配置区域

| `surfaces` 中的名称 | 桌面区域 |
| --- | --- |
| `window` | 整个窗口的底色和背景 |
| `titlebar` | 顶部标题栏 |
| `sidebar` | 导航侧栏，包括窄窗口中的展开侧栏 |
| `chat` | 聊天区域，包括消息区和空会话 |
| `composer` | 聊天输入框 |
| `panel` | 右侧面板容器；不改写第三方面板内部页面 |

每个区域都可以配置图片、底色、透明度、缩放和对齐。只有声明的区域才会被覆盖，默认主题保持原有界面。旧版的 `colors`、`pet` 和 `wallpaper` 字段继续支持；传统 `wallpaper` 会显示在窗口底层，聊天区不会再用不透明底色把它遮住。

## 示例

```json
{
  "schemaVersion": 1,
  "id": "my-scarlet-theme",
  "name": "Scarlet",
  "version": "1.0.0",
  "colors": {
    "light": { "--cs-primary": "349 72% 43%" },
    "dark": { "--cs-primary": "349 80% 71%" }
  },
  "surfaces": {
    "chat": {
      "light": "assets/character.png",
      "dark": "assets/character.png",
      "opacity": 0.25,
      "fit": "contain",
      "position": "right",
      "background": {
        "light": "350 42% 98%",
        "dark": "335 23% 9%"
      },
      "backgroundOpacity": 1
    }
  },
  "frame": {
    "light": "349 67% 53%",
    "dark": "349 64% 47%",
    "width": 2,
    "radius": 12
  }
}
```

完整实例见 [`examples/themes/lovelive-maki`](../examples/themes/lovelive-maki/README.md)。

## 区域字段

| 字段 | 值 | 用途 |
| --- | --- | --- |
| `light` / `dark` | 包内相对图片路径 | 浅色 / 深色图片；深色未配置时使用浅色图片 |
| `opacity` | 0–1 | 图片透明度；有图片时默认 1 |
| `fit` | `cover` / `contain` | 默认 `cover`；立绘推荐 `contain` |
| `position` | `center`、`top`、`bottom`、`left`、`right`、`top-right`、`bottom-right` | 默认居中 |
| `background.light` / `background.dark` | 不带 `hsl()` 的 HSL 三元组 | 区域底色；深色未配置时使用浅色值 |
| `backgroundOpacity` | 0–1 | 显式底色默认 1；未指定底色时沿用区域默认透明度 |

`frame` 的 `light` / `dark` 为相同格式的 HSL 颜色，`width` 为 0–8px，`radius` 为 0–24px；宽度和圆角未配置时均为 0。外框不占用布局空间，也不拦截点击。Mimi 独立悬浮窗保持透明。显式 `surfaces.window` 会替代传统 `wallpaper`，包括只声明底色、不显示图片的情况。

图片支持 PNG/APNG、JPEG、WebP、GIF，单张上限 8MiB，最大边长 8192px、总像素不超过四千万。路径必须指向包内文件；主题不接受远程 URL、CSS 或脚本。所有区域图片都会参与安装确认摘要，确认期间修改图片需要重新预览。
