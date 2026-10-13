# Love Live! μ’s · Nine Colors

CodeShell 桌面主题包：奶油白与樱粉浅色模式、午夜梅紫深色模式，配合九人舞台插画和粉色外框。配色细节融入橙、浅蓝、白、蓝、黄、红、紫、绿、粉的九色应援意象，保持正文、导航和状态信息易读。

## 安装与使用

在 **设置 → 外观** 选择内置「Love Live! μ’s · Nine Colors」，或使用 **导入 ZIP / 从文件夹导入** 安装这个独立版本。文件夹必须保留隐藏文件 `.cs-theme.json`。明暗模式仍由 **浅色 / 深色 / 跟随系统** 控制。

开启界面音效后，发送、完成、等待批准和错误提示会使用这套柔和琴铃音色。主题音乐需要手动播放；安装或切换主题不会自动播放音乐。

| 内容 | 文件 / 来源 |
| --- | --- |
| 发送提示 | `assets/sound-send.wav` · 0.28 秒，明亮上扬 |
| 完成提示 | `assets/sound-complete.wav` · 0.74 秒，温暖三音 |
| 等待批准 | `assets/sound-approval.wav` · 0.63 秒，轻柔双音 |
| 错误提示 | `assets/sound-error.wav` · 0.48 秒，低声下行 |
| 原创器乐 | `assets/encore-loop.wav` · **Nine Little Lights**，32 秒轻柔电钢琴循环 |

原创器乐可在主题音乐区域直接播放，打开循环开关即可反复收听。返回聊天后音乐继续播放，可通过窗口里的紧凑播放器暂停、继续或停止。官方歌曲按钮会打开浏览器中的原始 MV；需要联网，可用性由发布平台和所在地区决定。

也可以在主题音乐区域临时导入自己已有的 MP3 / WAV，在当前主题下边聊边听；退出应用、切换主题或卸载主题后清除临时曲目，不会将其复制到主题包中。需要随包保存的本地音乐可用 `.cs-theme.json` 的 `music[].file` 声明 WAV 文件。

## 官方歌曲

三首均由 **Love Live! 系列官方频道** 发布为完整动画 MV。包内只保存外链，不含这些歌曲的音频、歌词或 MV 文件。

- [Snow halation — μ’s](https://www.youtube.com/watch?v=vJ3jNTH2QL0)
- [Wonderful Rush — μ’s](https://www.youtube.com/watch?v=3WOzeKu2hjw)
- [Music S.T.A.R.T!! — μ’s](https://www.youtube.com/watch?v=NeaeJ0u3kR0)

## 素材与再生成

`assets/stage.png` 是为此主题生成的九人同人舞台插画，并非官方素材；生成提示记录在 [`../artwork-prompts.json`](../artwork-prompts.json)。角色及 Love Live! 权利归原权利人所有。这是非官方个人主题，不代表 Love Live! 项目、Bandai Namco 或相关权利人的认可或合作。

全部 WAV 均由 [`scripts/generate-theme-audio.py`](../../../scripts/generate-theme-audio.py)以基础波形、原创音符安排和包络合成：44.1 kHz、单声道、PCM16；提示音峰值约 −14 dBFS，器乐约 −12 dBFS。没有抽取官方歌曲、复刻既有旋律或模拟成员人声。可在仓库根目录运行 `python3 scripts/generate-theme-audio.py` 重建；原创音频与生成器按仓库 MIT 许可提供。

主题格式与音频限制见 [主题包说明](../../../docs/theme-packs.md)。旧版客户端仍可使用配色和背景；主题音效与音乐需要支持对应字段的桌面版本。
