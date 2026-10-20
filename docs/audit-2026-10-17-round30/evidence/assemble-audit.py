"""Assemble already frozen static audit metadata. Never import product code."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round30"
EV = OUT / "evidence"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read(name):
    return json.loads((EV / name).read_text())


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


plan = read("integration-plan.json")
baseline, main = plan["baseline"], plan["refreshedMain"]
assert git("rev-parse", "HEAD").decode().strip() == main
manifests = ["root-source-manifest.json", "data-source-manifest.json",
             "review-root-source-manifest.json", "review-data-source-manifest.json"]
pins, checks, hash_only = {}, [], []
for name in manifests:
    data = read(name)
    for row in data["files"]:
        path, expected = row["path"], row["sha256"]
        raw = (ROOT / path).read_bytes()
        assert len(raw) == row["bytes"] and sha(raw) == expected
        ranges = row.get("selectedLineRanges", row.get("selectedRanges", []))
        for start, end in ranges:
            assert 1 <= start <= end <= len(raw.splitlines())
        assert path not in pins or pins[path] == expected
        pins[path] = expected
        checks.append(dict(manifest=name, path=path, sha256=expected,
                           coverage=row["coverage"], rootBoundFrozenGitBlob=True,
                           note="Same prep semantic read reused, not a second formalization read; original timing/ranges authoritative."))
    for row in data.get("hashOnlyFiles", []):
        assert row["path"] not in pins or pins[row["path"]] == row["sha256"]
        pins[row["path"]] = row["sha256"]
        hash_only.append(dict(manifest=name, path=row["path"], sha256=row["sha256"],
                              coverage="Hash only; no additional semantic reading"))
files = []
for path, expected in sorted(pins.items()):
    frozen = git("show", baseline + ":" + path)
    current = (ROOT / path).read_bytes()
    main_raw = git("show", main + ":" + path)
    assert sha(frozen) == expected and current == main_raw
    files.append(dict(path=path, bytes=len(frozen), sha256=expected,
                      currentBytes=len(current), currentSha256=sha(current),
                      mainBytes=len(main_raw), mainSha256=sha(main_raw),
                      currentWorkingTreeMatchesFrozenBlob=current == frozen,
                      mainMatchesFrozenBlob=main_raw == frozen))
write(OUT / "source-manifest.json", dict(baseline=baseline, mainHead=main, files=files,
    workerSourceChecks=checks, hashOnlyChecks=hash_only,
    changedFromFrozenPaths=[x["path"] for x in files if not x["currentWorkingTreeMatchesFrozenBlob"]],
    note="Dated prep source records appear once per author/reviewer. Original same-read and initial-null limitations remain. No entire package inventory was semantically reviewed."))

receipts = ["root-artifact-receipt.json", "data-author-receipt.json",
            "review-root-artifact-receipt.json", "root-prep-copy-receipt.json",
            "data-copy-receipt.json", "review-data-copy-receipt.json",
            "review-root-prep-copy-receipt.json"]
receipt_checks = []
for name in receipts:
    data = read(name)
    rows = data.get("files", data.get("artifacts", data.get("copies", data.get("verbatimCopies", []))))
    assert rows
    for row in rows:
        target = row.get("destination", row.get("copy", row.get("path")))
        path = ROOT / target if target.startswith("docs/") else OUT / target
        expected = row.get("sha256", row.get("copySha256", row.get("destinationSha256")))
        raw = path.read_bytes()
        assert len(raw) == row["bytes"] and sha(raw) == expected, (name, target)
        if "source" in row:
            assert Path(row["source"]).read_bytes() == raw
        receipt_checks.append(dict(receipt=name, path=target, bytes=len(raw), sha256=expected))
write(EV / "root-receipt-checks.json", dict(checks=receipt_checks, productExecution=False))

for kind in ["findings", "candidates", "related"]:
    assert read("root-" + kind + ".json") == []
    assert read("data-decisions.json")[kind] == []
    write(OUT / (kind + ".json"), dict(baseline=baseline, count=0, **{kind: []},
          note="A04 and R14 unused formatter exclusions are not new related entries."))
assert read("root-validation.json")["runs"] == read("data-validation.json")["runs"] == []
write(OUT / "validation.json", dict(baseline=baseline, runs=[],
    totals=dict(productAttempts=0, passedTests=0, expectations=0, productReruns=0),
    validations=["evidence/root-validation.json", "evidence/data-validation.json"],
    note="Metadata assembly, old successful tests and existing declarations are not current runtime validation."))
summary = dict(baseline=baseline, mainHead=main, formal=0, candidates=0, related=0,
               uniqueSourcePins=len(files), activeSourceChecks=len(checks), hashOnlyChecks=len(hash_only),
               receiptChecks=len(receipt_checks), verbatimCopies=33,
               history=read("root-dedup.json")["totals"], productRuns=0, goalStillActive=True)
write(OUT / "coverage.json", summary)
(OUT / "README.md").write_text(f"""# 第30批：普通数据与显示辅助函数

本批 **0新增正式问题、0候选、0新关联**。冻结父提交 `{baseline}`，整合前main `{main}`。旧A04管道分隔符问题及R14无实际消费者的格式参数线索均保留旧因果边界，不重复计数。

- [渠道能力与Git日志解析](data-report.md)：600产品/test及78旧报告行，同一次prep阅读。
- [Intl与显示helper](root-report.md)：338产品及40旧报告行，同一次prep阅读。
- 独立复核：[data](evidence/review-data.md)、[Root](evidence/review-root.md)。

**0产品、函数、测试执行，0pass/0expect**；旧失败方向继续跳过。原prep和独立review共33份副本原样保留parent/time/旧history，正式化未重复增加产品语义阅读。当前历史metadata含已冻结29、排除30：2851文件，归档MD及递归JSON值均包含；关键词不代表语义穷尽。

[分类](findings.json)、[候选](candidates.json)、[关联](related.json)、[验证](validation.json)、[源码绑定](source-manifest.json)、[覆盖口径](coverage.json)、[聚合复核](evidence/review-aggregate.md)及[索引](evidence-index.json)可复核。整体审查仍在继续，未修产品，未push。
""")
print(json.dumps(summary, ensure_ascii=False))
