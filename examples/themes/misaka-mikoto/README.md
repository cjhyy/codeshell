# 御坂美琴 · Electric Promise

CodeShell 桌面主题包：奶油白与琥珀铜色浅色模式、学园都市炭黑深色模式，搭配御坂美琴的夜景电光同人插画、蓝色高光和细线外框。六个界面区域分别调色，聊天背景降低透明度，输入框保留接近不透明的底色。

## 安装与使用

在 **设置 → 外观** 选择内置「御坂美琴 · Electric Promise」（内置 ID：`misaka`），或使用 **导入 ZIP / 从文件夹导入** 安装这个独立版本。文件夹必须保留隐藏文件 `.cs-theme.json`。明暗模式仍由 **浅色 / 深色 / 跟随系统** 控制。

开启界面音效后，发送、完成、等待批准和错误提示会使用这套柔和电子脉冲音色。主题音乐需要手动播放；安装或切换主题不会自动播放音乐。

| 内容 | 文件 / 来源 |
| --- | --- |
| 发送提示 | `assets/sound-send.wav` · 0.26 秒，短促上扬 |
| 完成提示 | `assets/sound-complete.wav` · 0.68 秒，清亮三音 |
| 等待批准 | `assets/sound-approval.wav` · 0.64 秒，轻柔双脉冲 |
| 错误提示 | `assets/sound-error.wav` · 0.49 秒，温和低音 |
| 原创器乐 | `assets/encore-loop.wav` · **Amber Circuit**，32 秒合成器与柔和低音循环 |

原创器乐可在主题音乐区域直接播放，打开循环开关即可反复收听。返回聊天后音乐继续播放，可通过窗口里的紧凑播放器暂停、继续或停止。官方歌曲按钮会打开浏览器中的原始 MV；需要联网，可用性由发布平台和所在地区决定。

也可以在主题音乐区域临时导入自己已有的 MP3 / WAV，在当前主题下边聊边听；退出应用、切换主题或卸载主题后清除临时曲目，不会将其复制到主题包中。需要随包保存的本地音乐可用 `.cs-theme.json` 的 `music[].file` 声明 WAV 文件。

## 官方歌曲

三首均由 **fripSide 官方频道** 发布。包内只保存外链，不含这些歌曲的音频、歌词或 MV 文件。

- [only my railgun — fripSide](https://www.youtube.com/watch?v=cFqaN3vgxLc)：完整 MV；[NBCUniversal 官方公告](https://nbcuni-music.com/fripside/news/index08840000.html)说明为发行 15 周年公开的原版完整 MV。
- [LEVEL5 -judgelight- — fripSide](https://www.youtube.com/watch?v=a4deMm8soGA)：发行 15 周年公开的完整 MV，也收录在 [fripSide 的 NBCUniversal 官方首页](https://nbcuni-music.com/fripside/)。
- [sister's noise — fripSide](https://www.youtube.com/watch?v=Ca_-7DLQpO4)：官方**短版 MV**，视频说明注明为《某科学的超电磁炮 S》片头曲。

## 素材与再生成

`assets/stage.png` 是为此主题生成的同人插画，并非官方素材；生成提示记录在 [`../artwork-prompts.json`](../artwork-prompts.json)。角色及《某科学的超电磁炮》权利归原权利人所有。这是非官方个人主题，不代表原作者、出版社、动画制作方或相关权利人的认可或合作。

全部 WAV 均由 [`scripts/generate-theme-audio.py`](../../../scripts/generate-theme-audio.py)以基础波形、原创音符安排和包络合成：44.1 kHz、单声道、PCM16；提示音峰值约 −15 dBFS，器乐约 −12 dBFS。没有抽取官方歌曲、复刻既有旋律或模拟角色人声。可在仓库根目录运行 `python3 scripts/generate-theme-audio.py --theme misaka-mikoto` 重建；原创音频与生成器按仓库 MIT 许可提供。

主题格式与音频限制见 [主题包说明](../../../docs/theme-packs.md)。旧版客户端仍可使用配色和背景；主题音效与音乐需要支持对应字段的桌面版本。
