# 小野寺小咲 · Sweet Promise

CodeShell 桌面主题包：奶油白与淡丁香浅色模式、午夜梅紫深色模式，搭配小野寺小咲的樱花甜点店同人插画和柔紫外框。标题栏、侧栏、聊天、输入框、面板和窗口底色分别调色，让温柔的恋爱氛围保留清楚的正文对比。

## 安装与使用

在 **设置 → 外观** 选择内置「小野寺小咲 · Sweet Promise」（内置 ID：`onodera`），或使用 **导入 ZIP / 从文件夹导入** 安装这个独立版本。文件夹必须保留隐藏文件 `.cs-theme.json`。明暗模式仍由 **浅色 / 深色 / 跟随系统** 控制。

开启界面音效后，发送、完成、等待批准和错误提示会使用这套轻柔琴铃音色。主题音乐需要手动播放；安装或切换主题不会自动播放音乐。

| 内容 | 文件 / 来源 |
| --- | --- |
| 发送提示 | `assets/sound-send.wav` · 0.34 秒，轻铃上扬 |
| 完成提示 | `assets/sound-complete.wav` · 0.92 秒，柔和三音 |
| 等待批准 | `assets/sound-approval.wav` · 0.82 秒，间隔双铃 |
| 错误提示 | `assets/sound-error.wav` · 0.65 秒，低声下行 |
| 原创器乐 | `assets/encore-loop.wav` · **Sakura Sugar**，32 秒钢琴与轻铃循环 |

原创器乐可在主题音乐区域直接播放，打开循环开关即可反复收听。返回聊天后音乐继续播放，可通过窗口里的紧凑播放器暂停、继续或停止。官方歌曲按钮会在浏览器中打开原始 MV 或正版音乐平台页面；需要联网，可用性由发布平台和所在地区决定，Apple Music 完整播放可能需要订阅。

也可以在主题音乐区域临时导入自己已有的 MP3 / WAV，在当前主题下边聊边听；退出应用、切换主题或卸载主题后清除临时曲目，不会将其复制到主题包中。需要随包保存的本地音乐可用 `.cs-theme.json` 的 `music[].file` 声明 WAV 文件。

## 官方歌曲

下面只保存正版发布页面的外链，包内不含这些歌曲的音频、歌词或 MV 文件。

- [CLICK — ClariS](https://music.apple.com/us/music-video/click/1538636026)：Apple Music 正版 MV；[《伪恋》动画官网](https://www.nisekoi.jp/1st/music/)确认它是第一季前期片头曲。
- [STEP — ClariS](https://music.apple.com/us/music-video/step/1538637041)：Apple Music 正版 MV；[《伪恋》动画官网](https://www.nisekoi.jp/1st/music/)列为第一季新片头曲。
- [Rally Go Round — LiSA](https://www.youtube.com/watch?v=0Dv2swwcSSk)：LiSA 官方频道发布的完整 MV；[Sony Music 官方唱片页](https://www.sonymusic.co.jp/artist/lisa/discography/buy/SVWC-70083)确认它是《伪恋：》片头曲。

## 素材与再生成

`assets/stage.png` 是为此主题生成的同人插画，并非官方素材；生成提示记录在 [`../artwork-prompts.json`](../artwork-prompts.json)。角色及《伪恋》权利归原权利人所有。这是非官方个人主题，不代表原作者、出版社、动画制作方或相关权利人的认可或合作。

全部 WAV 均由 [`scripts/generate-theme-audio.py`](../../../scripts/generate-theme-audio.py)以基础波形、原创音符安排和包络合成：44.1 kHz、单声道、PCM16；提示音峰值约 −15 dBFS，器乐约 −13 dBFS。没有抽取官方歌曲、复刻既有旋律或模拟角色人声。可在仓库根目录运行 `python3 scripts/generate-theme-audio.py --theme nisekoi-onodera` 重建；原创音频与生成器按仓库 MIT 许可提供。

主题格式与音频限制见 [主题包说明](../../../docs/theme-packs.md)。旧版客户端仍可使用配色和背景；主题音效与音乐需要支持对应字段的桌面版本。
