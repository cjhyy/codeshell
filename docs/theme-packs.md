# 桌面端主题包

从 v0.9.39 起，桌面端自带「西木野真姬 · Scarlet Stage」，在设置的外观页直接选择即可，不需要导入或联网下载图片。它提供浅色和深色配色，默认外观仍由当前选择的主题决定。

主题包是一个包含 `.cs-theme.json` 和本地图片、可选音频的目录，也可以将它打包为 ZIP。从 v0.9.40 起，在设置的外观页点击「导入 ZIP」选择压缩包，或点击「从文件夹导入」选择已解压目录；确认后安装并立即启用。已安装包的资源会复制到应用主题存储中，之后不依赖原目录或 ZIP。

ZIP 内的 `.cs-theme.json` 可以直接位于压缩包根目录，也可以位于一层主题文件夹中。macOS 压缩时产生的 `__MACOSX` 等元数据不会影响识别。压缩包包含多个主题或主题嵌套过深时，会提示无法识别，请分别打包。

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

完整实例：

| 主题 | 外观 | 声音与音乐 |
| --- | --- | --- |
| [西木野真姬 · Scarlet Stage](../examples/themes/lovelive-maki/README.md) | 玫瑰白 / 深酒红、官方角色立绘 | 未附带主题音效 |
| [初音未来 · Digital Encore](../examples/themes/hatsune-miku/README.md) | 薄荷白 / 炭黑、青绿霓虹、生成的同人舞台插画 | 4 个原创电子提示音、32 秒原创器乐、3 个官方 MV 链接 |
| [Love Live! μ’s · Nine Colors](../examples/themes/lovelive-muse/README.md) | 奶油白 / 午夜梅紫、樱粉与九色应援意象、生成的九人同人舞台插画 | 4 个原创琴铃提示音、32 秒原创器乐、3 个官方 MV 链接 |

这三套主题可在外观页直接选择；示例目录保留可独立分发的版本。

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

图片支持 PNG/APNG、JPEG、WebP、GIF，单张上限 8MiB，最大边长 8192px、总像素不超过四千万。图片路径必须指向包内文件；图片不接受远程 URL，主题不接受 CSS 或脚本。所有区域图片都会参与安装确认摘要，确认期间修改图片需要重新预览。

## 界面音效与主题音乐

`sounds` 可提供四个界面事件的提示音，未声明的事件保持静音。事件音效默认关闭，可在外观页启用、试听并调整音量；音乐有独立的音量控制。

```json
{
  "sounds": {
    "send": "assets/sound-send.wav",
    "complete": "assets/sound-complete.wav",
    "approval": "assets/sound-approval.wav",
    "error": "assets/sound-error.wav"
  },
  "music": [
    {
      "title": "My original instrumental",
      "artist": "My artist name",
      "file": "assets/instrumental.wav"
    },
    {
      "title": "Official music video",
      "artist": "Artist name",
      "url": "https://www.youtube.com/watch?v=example"
    }
  ]
}
```

| 字段 | 格式与限制 | 行为 |
| --- | --- | --- |
| `sounds.send` | 包内相对 WAV 路径，单文件 ≤ 2MiB、时长 ≤ 10 秒 | 发送消息 |
| `sounds.complete` | 同上 | 任务完成 |
| `sounds.approval` | 同上 | 等待用户批准 |
| `sounds.error` | 同上 | 错误提示 |
| `music` | 最多 12 项 | 主题歌单，按声明顺序显示 |
| `music[].title` | 1–120 字符的曲名 | 显示标题 |
| `music[].artist` | 可选，1–120 字符的歌手 / 作者名称 | 显示作者 |
| `music[].file` | 包内相对 WAV 路径，单文件 ≤ 32MiB、时长 ≤ 600 秒 | 在应用内手动播放，循环开关可重复播放 |
| `music[].url` | HTTPS URL，不能包含用户名或密码 | 用户点击后在浏览器中打开 |

每个音乐条目必须且只能声明 `file`、`url` 中的一个。WAV 必须使用 16 位 PCM、单声道或双声道、8–96 kHz 采样率，不接受浮点、压缩或 extensible 编码；这两套示例提供 44.1 kHz 单声道音频。音频路径与图片一样只能指向包内文件，导入时验证文件内容并复制到主题存储；音效与本地曲目也参与预览摘要，预览后修改需要重新确认。

主题音乐不会在启动、安装或切换主题时自动播放。手动播放后，返回聊天会继续播放，可通过窗口里的紧凑播放器暂停、继续或停止；循环开关控制是否重复当前曲目。官方歌曲链接只负责打开原发布页面，不下载或转存歌曲。

外观页还可临时导入用户自己的 MP3 / WAV，在当前主题下后台播放；临时曲目在退出应用、切换主题或卸载主题后清除，不复制到主题存储。需要随主题保存的本地音乐须使用上述 `music[].file` WAV 声明。第三方歌曲的网络、登录与地区可用性由对应平台决定。旧版客户端会忽略新增音频字段，仍可使用配色与背景。

ZIP 导入限压缩文件 128MiB、10,000 个条目、解压后总计 256MiB、单个条目 64MiB；主题图片仍遵守上述 8MiB 限制。预览和安装会分别解压并校验，临时文件会自动清理；预览后修改声明的主题内容会要求重新预览。
