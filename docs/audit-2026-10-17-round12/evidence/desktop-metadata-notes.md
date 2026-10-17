# Desktop 元数据导航与工具错误转录

本文件保留审查过程中已经返回的工具输出。以下是 **tool-response transcription**，不是 subprocess 原始 stdout/stderr 文件，也不是产品测试失败。产品 guarded 首次日志另存，未重跑。

## 历史参考路径猜测，未用于证据

第一次参考文档读取所在批次工具 exit=1：

```text
cat: docs/audit-2026-10-17-round11/evidence/notify-dedup.py: No such file or directory
```

该猜测路径方向跳过，没有搜索替代 notify 文件恢复它。

第二次示例组合读取工具 exit=1：attachments-dedup.py 和 attachments-validation.json 成功返回；猜测的第三个文件不存在：

```text
cat: docs/audit-2026-10-17-round9/evidence/attachments-findings.json: No such file or directory
```

该猜测文件方向跳过，没有寻找替代 findings 路径。现批次结构由本审查独立建立。

## 历史查重脚本扩展的首次 metadata 错误

desktop-dedup.py 增加 file_byte_label 正则时首次工具 exit=1；正则过度转义导致：

```text
Traceback (most recent call last):
  File "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round12/evidence/desktop-dedup.py", line 11, in <module>
    compiled={k:re.compile(v,re.I) for k,v in patterns.items()}
                ~~~~~~~~~~^^^^^^^^
  File "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/lib/python3.14/re/__init__.py", line 289, in compile
    return _compile(pattern, flags)
  File "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/lib/python3.14/re/__init__.py", line 350, in _compile
    p = _compiler.compile(pattern, flags)
  File "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/lib/python3.14/re/_compiler.py", line 762, in compile
    p = _parser.parse(p, flags)
  File "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/lib/python3.14/re/_parser.py", line 978, in parse
    raise source.error("unbalanced parenthesis")
re.PatternError: unbalanced parenthesis at position 53
Traceback (most recent call last):
  File "<stdin>", line 3, in <module>
KeyError: 'file_byte_label'
```

随后只把 metadata 正则替换为 `[.]` / `[)]` 字符类，并重新生成查重记录；这不执行产品，也没有修复或重跑任何产品 fixture。

## 普通零命中与截断

静态搜索旧 root-unified-diff.test.ts 的 new file mode / old mode / new mode / Binary files 得到 rg exit=1 无匹配，属于零命中，不是测试失败。初始历史文件库存输出和一次命中内容查看被工具截断；最终 desktop-dedup.json 来自全部 docs/bugs Markdown 与 parsed JSON 字符串叶子，文件扫描不依赖终端显示，0 parse error。
