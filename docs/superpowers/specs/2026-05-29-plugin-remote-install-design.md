# 远程插件安装(git 来源)— 设计

> 日期：2026-05-29
> 目标仓：`~/Documents/个人学习/代码学习/codeshell`
> 关联：[plugin CC+Codex compat](./2026-05-29-plugin-cc-codex-compat-design.md)(§Non-Goals 把远程 install 列为 v2,本 spec 兑现它)、[本地安装器 plan](../plans/2026-05-29-plugin-cc-codex-installer.md)、[运行时加载 plan](../plans/2026-05-29-plugin-runtime-and-commands.md)

## 0. 一句话

让 `codeshell plugin install <source>` 除本地目录外,还能直接吃 git 来源(`github:org/repo`、https、ssh、可带 `@ref` 和 `#subdir`)。实现是**一层薄桥**:用现成的 `gitClone()` 把仓库拉到临时目录 → 调现成的 `installPluginFromPath()` 转换+装 → 删临时目录。新代码只有「来源解析」+「克隆编排」两块,其余全部复用。

## 1. 背景:现状(已对照代码核实 2026-05-29)

- 我的 `plugin install <source>`(`tui/cli/commands/plugin.ts`)只把 `<source>` 当**本地目录**;喂 git 地址会报 `source is not a directory`。
- 代码库**已有完整 git 能力**(`plugins/gitOps.ts`):
  - `gitClone(url, destDir, {ref?})` — shell 出 `git clone --depth 1 [--branch ref]`,60s 超时。
  - `gitRevParseHead(repoDir)` — 取 HEAD SHA。
  - `githubRepoToCloneUrl(repo)` — `org/repo` → `https://github.com/org/repo.git`。
  - git 是 shell 出二进制(`safeSpawn("git", …)`),非库;依赖 PATH 里有 `git`。
- 我的 `installPluginFromPath(sourceDir, name, installedAt)`(`plugins/installer/install.ts`)会做 CC/Codex 检测+转换+落盘+登记,**但只吃本地路径、不克隆**。
- 另有一套 `pluginInstaller.ts` + marketplace(给 slash `/plugin install name@marketplace` 用),克隆进 `cache/<market>/<plugin>/<sha>/` 但**不做 CC/Codex 转换**。本 spec **不碰**这套,只增强我的 `plugin install`。

**结论**:两套能力各有一半(一套会下载不会转换,一套会转换不会下载)。远程安装 = 把现成的 `gitClone` 接到我现成的 `installPluginFromPath` 前面。

## 2. 语法(单个 `<source>` 参数,自动判断)

```
plugin install ./local/path                          # 本地目录(现状,不变)
plugin install github:org/repo                        # github 简写
plugin install github:org/repo@v1.2.0                 # @ref:tag 或分支
plugin install github:org/repo#plugins/github         # #subdir:monorepo 子目录
plugin install github:org/repo@main#plugins/github    # ref + subdir
plugin install https://github.com/org/repo.git        # 完整 https
plugin install git@github.com:org/repo.git            # SSH
```

ref 和 subdir 都可选。`@ref` 在前、`#subdir` 在后。

## 3. 架构

```
plugin install <source>  [--name <n>]
   │
   ├─ parseSource(source)                       ← 新:纯函数
   │     → { kind: "local",  path }                              ...或
   │     → { kind: "remote", url, ref?, subdir?, inferredName }
   │
   ├─ local  → installPluginFromPath(path, name, ts)             ← 现状,零改动
   │
   └─ remote → installPluginFromSource(parsed, name, ts)         ← 新:编排器
         1. tmp = mkdtemp()
         2. gitClone(url, tmp, { ref })                          ← 复用 gitOps
         3. sha = gitRevParseHead(tmp)                           ← 复用 gitOps(版本用)
         4. realSrc = subdir ? join(tmp, subdir) : tmp
            (subdir 不存在 → 报错)
         5. dir = installPluginFromPath(realSrc, name, ts)       ← 复用,转换+装+登记
         6. 把 .cs-meta.json.source 改写成原始 git source 串      ← 让 update 能重拉
         7. rmSync(tmp)                                          ← 清理
```

**新增代码仅两处**(都在 `plugins/installer/`):
- `parseSource.ts` — `parseSource(input: string): ParsedSource`(纯函数)。
- `installFromSource.ts` — `installPluginFromSource(...)` 编排器 + CLI 改 dispatch。

`installPluginFromPath` **不改**——克隆在它之前完成,它仍只吃本地路径,职责分离。

## 4. 类型

```typescript
export type ParsedSource =
  | { kind: "local"; path: string }
  | {
      kind: "remote";
      url: string;        // 已规整为可 git clone 的 URL
      ref?: string;       // @ 后,branch/tag
      subdir?: string;    // # 后,仓库内相对路径
      raw: string;        // 原始输入串,写进 .cs-meta.json.source
      inferredName: string; // 没传 --name 时用(subdir 末段 优先于 repo 名)
    };
```

## 5. parseSource 规则

判定顺序(先 remote 形态,否则 local):

| 输入形态 | kind | url 规整 |
|---|---|---|
| `github:org/repo` | remote | `https://github.com/org/repo.git` |
| `https://…` / `http://…` / `git://…` | remote | 原样 |
| `git@host:org/repo.git` | remote | 原样(SSH) |
| 其它(`./x`、`/abs`、`x`) | local | `resolve(path)` |

拆分:先按 `#` 切出 `subdir`,再在前半按**最后一个** `@` 切出 `ref`(注意 SSH 的 `git@` 里也有 `@`——只在「非 SSH」或「`@` 在路径段之后」时当 ref;实现上:SSH 形态 `git@host:...` 先识别并剥离,剩余再找 ref)。`inferredName` = `subdir` 末段(有 subdir 时)否则 repo 名(URL 末段去 `.git`)。

## 6. CLI 改动

`tui/cli/commands/plugin.ts` 的 `install` action:
```
const parsed = parseSource(source);
const name = opts.name ?? parsed.inferredName(local 时用 basename);
const dir = parsed.kind === "local"
  ? installPluginFromPath(parsed.path, name, new Date().toISOString())
  : await installPluginFromSource(parsed, name, new Date().toISOString());
console.log(`Installed '${name}' → ${dir}`);
```
`installPluginFromSource` 是 async(克隆是 async),install action 已经是 async,兼容。

## 7. .cs-meta.json 的 source

远程装时,`installPluginFromPath` 会先把 `source` 写成 realSrc(临时目录,装完即删——无意义)。编排器在装完后**改写** `.cs-meta.json` 的 `source` 为原始 git 串(`parsed.raw`),这样:
- `plugin list` 显示的是 git 地址,不是 `/tmp/...`。
- `plugin update` 能用这个 git 串重新克隆重装(见 §9)。

## 8. 失败模式

| 失败 | 行为 |
|---|---|
| PATH 无 `git` | gitClone 返回 error → 报 "git not available / clone failed: …",删 tmp,不登记 |
| clone 失败(网络/私有库无权限/ref 不存在) | 同上,错误带 git stderr |
| `#subdir` 在仓库里不存在 | 报 "subdir not found in repo: <subdir>",删 tmp |
| 克隆成功但非合法插件 | 走 `installPluginFromPath` 现有校验报错(整装失败),删 tmp |
| 名字已装(§9.1 现状) | `installPluginFromPath` 已有「already installed」拒装 |

所有路径保证:**失败不留半装目录、不留临时目录、不写 installed_plugins.json**。

## 9. update 增强

`plugins/installer/update.ts` 现从 `.cs-meta.json.source` 重装,假设 source 是本地目录。改成:
- `parseSource(meta.source)`:
  - local → 现状逻辑(detectFormat + version/mtime 比较)。
  - remote → 重新 `installPluginFromSource` 重拉(git 源没有「本地 version 文件」,所以远程 update **总是重拉**,除非将来比 SHA;v1 远程 update 直接重装,等价于 `--force`,简单可靠)。

## 10. 安全

- `parseSource` 不执行任何东西,纯字符串解析。
- 临时目录用 `mkdtemp`(进程私有),装完即删。
- 不新增网络面:git 克隆走系统 `git`,与现有 `pluginInstaller`/`marketplaceManager` 同一信任模型(plugin = 安装即信任的用户代码,见 doc 17)。
- 插件名仍过 `assertSafePluginName`(现有)。

## 11. 测试

- **`parseSource` 单测**(纯函数,无 I/O):
  - `./x` / `/abs` / `x` → local,path 正确 resolve。
  - `github:org/repo` → remote,url=`https://github.com/org/repo.git`,inferredName=`repo`。
  - `github:org/repo@v1` → ref=`v1`。
  - `github:org/repo#plugins/foo` → subdir=`plugins/foo`,inferredName=`foo`。
  - `github:org/repo@main#plugins/foo` → ref=`main`+subdir=`plugins/foo`。
  - `https://github.com/org/repo.git` → url 原样,inferredName=`repo`。
  - `git@github.com:org/repo.git` → remote SSH,url 原样,inferredName=`repo`,**`@` 不被当 ref**。
- **`installPluginFromSource` 集成测**(不依赖外网):
  - `beforeEach`:`git init` 一个临时仓库,塞一个 fixture 插件(CC 或 Codex),`git add && commit`。
  - 用 `file://<repo>` 或本地路径作 url 真的 `gitClone` → 装。
  - 断言:`~/.code-shell/plugins/<name>/` 存在、`.cs-meta.json.source` === 原始 git 串(不是 /tmp)、临时克隆目录已删、installed_plugins.json 登记。
  - subdir 用例:仓库里放 `sub/myplugin/`,装 `<repo>#sub/myplugin`。
- **回归**:本地路径安装仍走通(现有 install.test.ts 全绿);`bun test packages/core/src` 全绿。

## 12. 不做(v1)

- marketplace.json 解析 / `install name@marketplace`(那套已由 `pluginInstaller.ts` + slash 命令覆盖,本 spec 不动)。
- 远程 update 比 SHA 增量(直接重拉,YAGNI)。
- 私有库凭证管理(靠用户的 git 凭证 helper,不自己存 token)。
- 克隆缓存复用(每次重拉;插件不大,YAGNI)。

## 13. 收益

- 「填个 git 地址就能装」真正实现:`plugin install github:org/repo` 一步到位,不用手动 clone。
- 改动小、风险低:新代码仅 `parseSource` + 编排器两块,git 克隆与 CC/Codex 转换全部复用现成件,执行层/marketplace 那套零碰。
