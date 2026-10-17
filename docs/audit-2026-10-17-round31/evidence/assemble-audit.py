"""Assemble already frozen static audit metadata. Never import product code."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round31"
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
manifests = ["root-source-manifest.json", "entry-source-manifest.json", "review-search-source-manifest.json", "review-aggregate-independent-checks.json"]
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

receipts = ["root-artifact-receipt.json", "entry-artifact-receipt.json", "review-search-receipt.json", "root-prep-copy-receipt.json", "entry-prep-copy-receipt.json", "review-search-copy-receipt.json"]
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

assert read("root-findings.json") == read("root-related.json") == []
candidates = read("root-candidates.json")
assert len(candidates) == 1 and candidates[0]["id"] == "SEARCH-R31-C1"
for kind, rows in [("findings", []), ("candidates", candidates), ("related", [])]:
    write(OUT / (kind + ".json"), dict(baseline=baseline, count=len(rows), **{kind: rows},
        note="Root candidate only. Original P3 helper assessment and production-entry limitation preserved separately."))
for name in ["root-validation.json", "entry-validation.json", "review-search-validation.json"]:
    assert read(name)["runs"] == []
write(OUT / "validation.json", dict(baseline=baseline, runs=[],
    totals=dict(productAttempts=0, passedTests=0, expectations=0, productReruns=0),
    mode="Static source/spec only; no installed runtime behavior observation.",
    validations=["evidence/root-validation.json", "evidence/entry-validation.json", "evidence/review-search-validation.json"]))
summary = dict(baseline=baseline, mainHead=main, formal=0, candidates=1, related=0,
               uniqueSourcePins=len(files), activeSourceChecks=len(checks), hashOnlyChecks=len(hash_only),
               receiptChecks=len(receipt_checks), verbatimCopies=28,
               history=read("root-dedup.json")["totals"], productRuns=0, goalStillActive=True)
write(OUT / "coverage.json", summary)
(OUT / "README.md").write_text(f"""# 第31批：搜索大小写候选与入口边界

本批 **0新增正式问题、1候选SEARCH-R31-C1、0新关联**。冻结父提交 `{baseline}`，整合前main `{main}`；未修产品，审查继续。

[候选报告](root-report.md)：逐cell小写与整段查询小写保留的希腊词尾上下文不同，相同字面查询可能静态推演漏匹配。原独立[source评估](evidence/review-search.md)支持P3 helper原因；[入口追踪](entry-report.md)未找到可达App/公开package消费者，Root因此不升为已确认生产UI问题。[独立聚合复核](evidence/review-aggregate-independent.md)保留这一强弱边界。

**0产品/函数/测试执行，0pass/expect**。规范只用于静态推演，不证明安装的runtime版本；无实际终端/UI观察，旧失败方向继续跳过。28份原prep副本保留旧parent19ef/time/history2851，正式化不重复语义阅读。当前history2921含冻结30、排除31，关键词不代表语义穷尽。

[分类](findings.json)、[候选](candidates.json)、[验证](validation.json)、[源码绑定](source-manifest.json)、[覆盖口径](coverage.json)、[聚合记录](evidence/review-aggregate.md)和[索引](evidence-index.json)可复核。主checkout原改动按字节保存，不push。
""")
print(json.dumps(summary, ensure_ascii=False))
