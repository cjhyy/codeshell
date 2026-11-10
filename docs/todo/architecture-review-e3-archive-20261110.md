# E3 审计证据归档记录

用户在 2026-11-10 指示直接完成并先出一个版本。本机采用先归档、逐文件校验、再删除候选工作区 evidence 的可恢复方案。主工作区和 Git 历史未改写。

- 原始证据：6676 个文件，365232645 bytes；实际分布在 64 个含 evidence 的审计目录。
- 归档包：`/Users/admin/Documents/CodeShellBuilds/architecture-review-evidence-20261110.tar.gz`
- 归档大小：80063129 bytes。
- SHA-256：`ff8c2e42e65f189c5d18c3649e39dea4fd9eae9719795dbe4e36f8b27ab9485e`
- 文件清单及每文件 SHA-256：`/Users/admin/Documents/CodeShellBuilds/architecture-review-evidence-20261110-manifest.json`
- 校验：归档成员集合、文件长度、每文件 SHA-256 全部匹配后，才删除候选工作区内对应路径。
- 删除范围：仅 `docs/audit-2026-10-16`、`docs/audit-2026-10-17`、`docs/audit-2026-10-17-round*` 的已跟踪 evidence 文件；审计报告和清单均保留。
- 实际核对：本基线 `docs/todo/release-ui-20261015.md` 未含清单提到的审计目录链接，因此无需修改该历史记录。

恢复时可先在独立目录解包检查：

```sh
mkdir -p /tmp/codeshell-evidence-restore
tar -xzf /Users/admin/Documents/CodeShellBuilds/architecture-review-evidence-20261110.tar.gz -C /tmp/codeshell-evidence-restore
```

归档属于本机交付文件，未上传，也未写入 Git 历史。
