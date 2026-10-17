"""Assemble already frozen static audit metadata. Never import product code."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round32"
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
manifests = ["selection-source-manifest.json", "taskparse-source-manifest.json", "review-selection-source-manifest.json", "review-taskparse-source-manifest.json"]
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
    for row in data.get("hashOnlyFiles", data.get("metadataHashOnlyFiles", [])):
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

receipts = ["selection-artifact-receipt.json", "taskparse-author-receipt.json", "review-taskparse-artifact-receipt.json", "selection-prep-copy-receipt.json", "taskparse-copy-receipt.json", "review-selection-copy-receipt.json"]
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

selection = read("selection-source-manifest.json")
assert all(selection[k] == 0 for k in ["formalCount", "candidateCount", "relatedCount"])
assert all(read("taskparse-decisions.json")[k] == [] for k in ["findings", "candidates", "related"])
for kind in ["findings", "candidates", "related"]:
    write(OUT / (kind + ".json"), dict(baseline=baseline, count=0, **{kind: []},
        note="Stale boundary hypothesis refuted; old IMAGE-R15-C1 remains excluded, no duplicate related entry."))
for name in ["selection-validation.json", "taskparse-validation.json", "review-taskparse-validation.json"]:
    assert read(name)["runs"] == []
write(OUT / "validation.json", dict(baseline=baseline, runs=[],
    totals=dict(productAttempts=0, passedTests=0, expectations=0, productReruns=0),
    mode="Static ordinary producer/consumer contracts only; no model, real session/fork, attachment, browser or native execution.",
    validations=["evidence/selection-validation.json", "evidence/taskparse-validation.json", "evidence/review-taskparse-validation.json", "evidence/review-selection-source-manifest.json"]))
summary = dict(baseline=baseline, mainHead=main, formal=0, candidates=0, related=0,
               uniqueSourcePins=len(files), activeSourceChecks=len(checks), hashOnlyChecks=len(hash_only),
               receiptChecks=len(receipt_checks), verbatimCopies=34,
               history=read("taskparse-history.json")["stats"], productRuns=0, goalStillActive=True)
write(OUT / "coverage.json", summary)
(OUT / "README.md").write_text(f"""# 第32批：会话范围与任务文本解析

本批 **0新增正式问题、0候选、0新关联**。冻结父提交 `{baseline}`，整合前main `{main}`，未修产品。

- [上下文与模型选择](selection-report.md)：当前producer和选择合并规则反证了初始边界顺序猜想。
- [任务图片文本解析](taskparse-report.md)：普通encoder/DTO消费者没有建立新反例，旧IMAGE-R15-C1保持排除。
- 独立复核：[selection与后端range](evidence/review-selection.md)、[task parser](evidence/review-taskparse.md)。后端额外阅读归独立review，不扩大作者覆盖。

**0产品/函数/测试执行，0pass/expect**，旧失败方向继续跳过。34份原prep副本保留parent/time/history；formalization不重复计算语义阅读。当前history2988含冻结31、排除32；selection沿用2921旧scan并仅查67差集，正则次数与taskparse不同，不互借。

[分类](findings.json)、[候选](candidates.json)、[验证](validation.json)、[源码绑定](source-manifest.json)、[覆盖口径](coverage.json)、[聚合复核](evidence/review-aggregate.md)和[索引](evidence-index.json)可复核。negative仅覆盖所列范围，整体审查继续；主checkout原改动字节保留，不push。
""")
print(json.dumps(summary, ensure_ascii=False))
