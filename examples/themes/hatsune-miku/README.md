# 初音未来 · Digital Encore

CodeShell 桌面主题包：薄荷白浅色模式、炭黑深色模式，搭配青绿霓虹、双马尾舞台插画和细线外框。标题栏、侧栏、聊天、输入框、面板和窗口底色分别调色，聊天背景降低透明度以保留文字对比。

## 安装与使用

在 **设置 → 外观** 选择内置「初音未来 · Digital Encore」，或使用 **导入 ZIP / 从文件夹导入** 安装这个独立版本。文件夹必须保留隐藏文件 `.cs-theme.json`。明暗模式仍由 **浅色 / 深色 / 跟随系统** 控制。

开启界面音效后，发送、完成、等待批准和错误提示会使用这套轻柔电子音色。主题音乐需要手动播放；安装或切换主题不会自动播放音乐。

| 内容 | 文件 / 来源 |
| --- | --- |
| 发送提示 | `assets/sound-send.wav` · 0.28 秒，短促上扬 |
| 完成提示 | `assets/sound-complete.wav` · 0.74 秒，三音玻璃和弦 |
| 等待批准 | `assets/sound-approval.wav` · 0.63 秒，间隔双音 |
| 错误提示 | `assets/sound-error.wav` · 0.48 秒，温和下行 |
| 原创器乐 | `assets/encore-loop.wav` · **Turquoise Afterglow**，32 秒柔和电子循环 |

原创器乐可在主题音乐区域直接播放，打开循环开关即可反复收听。返回聊天后音乐继续播放，可通过窗口里的紧凑播放器暂停、继续或停止。官方歌曲按钮会打开浏览器中的原始 MV；需要联网，可用性由发布平台和所在地区决定。

也可以在主题音乐区域临时导入自己已有的 MP3 / WAV，在当前主题下边聊边听；退出应用、切换主题或卸载主题后清除临时曲目，不会将其复制到主题包中。需要随包保存的本地音乐可用 `.cs-theme.json` 的 `music[].file` 声明 WAV 文件。

## 官方歌曲

下面只保存发布者的外链，包内不含这些歌曲的音频、歌词或 MV 文件。

- [Tell Your World — livetune feat. 初音ミク](https://www.youtube.com/watch?v=PqJNc9KVIZE)：livetune 官方发布的完整 MV。
- [39みゅーじっく！ — みきとP feat. 初音ミク](https://www.youtube.com/watch?v=OuLZlZ18APQ)：Hatsune Miku 官方频道发布；[作者 みきとP 的 piapro 页面](https://piapro.jp/t/xS2A)也链接此原始 MV。
- [ヴァンパイア — DECO*27 feat. 初音ミク](https://www.youtube.com/watch?v=e1xCOsgWG0M)：[OTOIRO 的 DECO*27 官方介绍页](https://otoiro.co.jp/creator/deco27/)提供原始 MV 链接。

## 素材与再生成

`assets/stage.png` 是为此主题生成的同人舞台插画，并非官方素材；生成提示记录在 [`../artwork-prompts.json`](../artwork-prompts.json)。角色权利归原权利人所有。这是非官方个人主题，不代表 Crypton Future Media 的认可或合作。

全部 WAV 均由 [`scripts/generate-theme-audio.py`](../../../scripts/generate-theme-audio.py)以基础波形、原创音符安排和包络合成：44.1 kHz、单声道、PCM16；提示音峰值约 −14 dBFS，器乐约 −12 dBFS。没有抽取官方歌曲、复刻既有旋律或模拟角色人声。可在仓库根目录运行 `python3 scripts/generate-theme-audio.py` 重建；原创音频与生成器按仓库 MIT 许可提供。

主题格式与音频限制见 [主题包说明](../../../docs/theme-packs.md)。旧版客户端仍可使用配色和背景；主题音效与音乐需要支持对应字段的桌面版本。
