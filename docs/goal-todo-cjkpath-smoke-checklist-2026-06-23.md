# 真机冒烟 checklist — goal 回灌 / todo 重建 / 中文路径图片

**日期**: 2026-06-23
**覆盖 commit**(已合 main,未 push):
- `ef511cba` 中文路径匹配正则认中文(修 GenerateImage 回显图/路径链接打不开)
- `645e0332` 会话加载时回灌持久 goal(修「goal 还在但页面不显示、取消不了」)
- `eadb9ef8` 从磁盘重建会话时重建 todo 任务面板(修「关了就没了」)

> 自动化已全绿:core 1631 pass / desktop 941 pass、两包 tsc 0、core build 0。以下是**真机**(打 app)要手验的行为——自动化测不到的渲染/IPC/重载时序。
> 复现环境关键:用户工作区在 **中文路径** `/Users/admin/Documents/个人学习/代码学习/...`,三个 bug 都跟它相关或在它下复现。

---

## A. 中文路径下的 GenerateImage 回显图 (`ef511cba`)

前置:在中文路径项目(如 `mimi-test-videos`)里。

- [ ] **A1** 让 AI 调 GenerateImage 生成一张图 → 聊天里 **直接显示缩略图**(不是只有一个文件名链接、不是空白)。
- [ ] **A2** 点缩略图 → 弹出 Lightbox 大图,正常显示。
- [ ] **A3** 点缩略图下方文件名 → 在 Files 面板里定位到该文件(`.code-shell/generated_images/...png`);⌘/Ctrl-点 → 系统默认应用打开。
- [ ] **A4** AI 在回答正文里写一个**中文文件名**路径(如 `outputs/ep01/assets/img/ep01-char-萧炎.png`)→ 该路径渲染成**可点链接**(不是死文字),点开能定位文件。
- [ ] **A5** 回答正文里写一个**中文目录段**的路径 → 同样可点。
- [ ] **A6**(回归)纯英文路径的图/链接照常工作,没被改坏。
- [ ] **A7**(回归)正文里的 `obj.method` / `v1.2` / `example.com/x.html` 这种**不是**路径的东西,**没**被误判成链接。

## B. 持久 goal 加载回灌 (`645e0332`)

前置:开一个会话,设一个 goal(引导模式发一条带 goal 的消息,如「有授权 你直接帮我做完」),确认顶栏 StatusPopover 里出现 **Goal 块**。

- [ ] **B1** goal 跑到一半 **Stop/中断**(会话变 aborted),**刷新页面 / 切走再切回该会话** → Goal 块 + **Cancel 按钮** 仍然在(不再消失)。
- [ ] **B2** 点 Cancel → goal 真清掉(StatusPopover Goal 块消失);**再刷新**确认没复活(disk 已清)。
- [ ] **B3** **关掉 app 重开**(或清 localStorage 模拟磁盘恢复)→ 打开那个有 goal 的会话 → Goal 块从磁盘 state.json 回灌出来。
- [ ] **B4**(关键 bug 场景)对一个 **aborted 且未 push 的旧会话**(如 `s-mqqa4nio-9faac9db`,磁盘 state.json 里有 `activeGoal`)→ 打开它 → Goal 块 + Cancel 出现 → 能点 Cancel 清掉。
- [ ] **B5**(回归)一个**没有 goal** 的会话打开 → 不应凭空冒出 Goal 块(goalGet 返回 null 不画)。
- [ ] **B6**(不覆盖)localStorage 里本就存着 goal 的会话刷新 → Goal 块的 round 进度没被回灌逻辑重置(只在 activeGoal===null 时才注入)。

## C. todo 任务面板磁盘重建 (`eadb9ef8`)

前置:让 AI 用 TodoWrite 建一个多项任务列表,确认顶栏/面板显示任务列表。

- [ ] **C1** **关掉会话再重开**(同一 app 会话内,localStorage 还在)→ 任务面板还在(这一路靠 localStorage,本就该在,确认没坏)。
- [ ] **C2**(关键 bug 场景)**关 app 重开 / 清 localStorage 触发磁盘重建** → 打开该会话 → 任务面板**从磁盘 transcript 重建出来**(不再空白)。任务的内容/状态(pending/in_progress/completed)正确。
- [ ] **C3** 一个**所有项都 completed** 的 TodoWrite 会话,磁盘重建后 → 面板**清空**(「全完成⇒清空」规则,和 live 一致),不是显示一堆划掉的完成项。
- [ ] **C4** 磁盘重建后,TodoWrite 那一步的**工具卡**也照常在(live 本就同时有卡片 + 面板,重建要一致)。
- [ ] **C5**(回归)子代理(agentId)的 todo **不**显示在主面板(reducer 对带 agentId 的 task_update 直接忽略)。

---

## 备注

- 三个修复互相独立,可分别验。
- B/C 都属「从磁盘恢复会话」类:验的核心是 **localStorage 被清/app 重开** 这条路,而不是同会话内的软切换。
- 全部通过后 → 可 push main(连同本批之前积压的未 push 内容)。
