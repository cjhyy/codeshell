# 沙箱配置 scope 模型 — 设计稿

> 日期:2026-06-16 ｜ 状态:已拍板,待实现
> 缘起:用户排查「沙箱用没用上/改了要重启/默认到底开没」时,暴露沙箱配置的 scope 与保存语义全坏。

## 0. 一句话

沙箱配置改成「**全局默认(off)+ 项目跟随或覆盖**」的分层模型:全局有一处沙箱配置点(默认 off);项目不写 `sandbox` 字段 = 跟随全局,写了 = 覆盖全局。修掉 UI 把「显示默认 auto」误当用户选择落盘的 bug,并迁移清掉已误写的 auto。

## 1. 现状(都坏了)

- **UI 写死项目级**:`ProjectEnvEditor`(AdvancedSections.tsx:859)`targetScope = "project"`,沙箱只能项目级配,无全局点。
- **误写 auto**:load 时 `setMode(sandbox.mode || "auto")`(:882)——没配也显示 auto;`save()`(:901)**无条件**写 `sandbox: {mode, network, ...}`→ 用户为改 env 点保存,就把「显示默认 auto + network allow」落盘了。用户没主动选沙箱却被开。
- **和 env 捆绑**:env/脚本/sandbox 一个 save() 一起写,改 env 必然连带写 sandbox。
- **引擎默认 off(交互)**:`engine.ts` `defaultSandboxConfig(headless?"auto":"off")` —— 桌面默认 off,但被上面的误写盖过。

(关联已修:引擎读 settings.sandbox `01250699`、缓存 key 补全字段 `8ca8a8f7`、sandbox.resolved 日志 `bd91897e`。本设计是配置层收口。)

## 2. 数据模型

`settings.sandbox`(schema 已存在,字段全 optional)继续用,语义靠**分层 + 字段存在与否**:

```
全局 ~/.code-shell/settings.json   sandbox?: { mode, network, writableRoots, deniedReads }
   └ 不写 = off(引擎默认);写了 = 全局沙箱策略

项目 <repo>/.code-shell/settings.json   sandbox?: {...}
   └ 不写 sandbox 字段        = 跟随全局
   └ 写了(有 mode)            = 覆盖全局
```

**「跟随」用「项目不写 sandbox 字段」表达**,不引入显式 `"inherit"` 枚举——最简、settings 最干净。

## 3. 运行时 resolve(扩 resolveSandboxConfig 成三层)

现有 `resolveSandboxConfig(configSandbox, settingsSandbox, headless)` 扩成读「项目 + 全局」两层 settings:

```
优先级:
  1. config.sandbox(显式 host 传)
  2. 项目 settings.sandbox(有 mode)      ← 覆盖
  3. 全局 settings.sandbox(有 mode)      ← 跟随
  4. per-run 默认:headless→auto, 桌面→off
```

实现:engine.run 读 `getForScope("project", cwd).sandbox` 和 `getForScope("user").sandbox`(unmerged,各自判 mode 是否存在),传进扩展后的 `resolveSandboxConfig(config, projectSandbox, globalSandbox, headless)`。纯函数 TDD。

> 注意不能用 SettingsManager 合并后的值——合并会让项目继承全局,分不清「项目主动写了」还是「继承来的」。必须 unmerged 各层判断。

## 4. UI 改造

### 4.1 全局沙箱配置点
`ProjectEnvEditor` 复用现有 `ProjectPicker includeGlobal`(本地环境页已有「全局」行模式)——选「全局」时 `targetScope = "user"`,编辑全局 sandbox;选项目时编辑项目 sandbox。
- 全局视图:沙箱默认显示 off。
- 项目视图:mode 多一档「跟随全局」(选它 = 保存时不写 sandbox 字段)。

### 4.2 修误写(核心)
- load 默认显示从 `|| "auto"` 改成 `|| (项目视图 ? "inherit" : "off")`。
- `save()` 拆分:sandbox 的写入只在「用户真的设了非跟随值」时落盘;选「跟随全局」→ 保存时**删掉/不写** sandbox 字段。不再把显示默认当选择。
- env/脚本与 sandbox 可继续同一 save(),但 sandbox 部分按上面规则决定写不写。

### 4.3 即时生效
缓存 key 已修(`8ca8a8f7`),改完下次运行生效;UI 保存后派发 `codeshell:settings-changed`(已有),连接/相关页跟随刷新。沙箱无独立 UI 展示,靠 `sandbox.resolved` 日志可观测。

## 5. 迁移(清掉已误写的 auto)

一次性 migration(core migrate-config 已有框架):识别「UI 误写的默认 auto」并清掉。
- **判据(误写指纹)**:`sandbox.mode === "auto" && network === "allow" && writableRoots == [] && deniedReads == []` —— 正是 UI 默认显示值,不是用户主动配的(用户主动开会动 network/roots 或选别的 mode)。
- **动作**:命中 → 删掉整个 sandbox 字段(回归「跟随/默认 off」)。
- user + project 两层都扫。仅内容真变才写回(带 .bak)。

> 风险:误伤「真想全局 auto 且没改其它字段」的用户。可接受——auto 无 roots/reads 限制等于裸 auto,重配一下即可;且当前唯一已知数据(用户全局)正是误写。

## 6. 测试

- `resolveSandboxConfig` 三层 TDD:config>项目>全局>默认,各层「有 mode/无 mode」组合。
- migration 纯函数 TDD:误写指纹命中清除、用户主动配(动了 network/roots)不动、无 sandbox 不动。
- UI save 的「跟随→不写字段」靠类型 + 手测(无 DOM 测试基建)。

## 7. 不做

- ❌ 显式 `inherit` 枚举存进 settings(用字段缺失表达)。
- ❌ 改桌面默认 off→auto(默认策略不变,只让分层配置生效)。
- ❌ 沙箱状态的独立 UI 面板(靠 sandbox.resolved 日志,YAGNI)。
